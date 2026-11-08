const {Logger, utils} = require('jj.js');
const {getConfig} = require('./config.js');
const MessageStore = require('./message_store.js');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {import('aedes').Aedes} Aedes
 * @typedef {import('aedes').Client} AedesClient
 * @typedef {import('http').Server} HttpServer
 * @typedef {import('net').Server} TcpServer
 * @typedef {import('net').Socket} TcpSocket
 * @typedef {import('tls').Server} TlsServer
 * @typedef {import('ws').WebSocketServer} WsServer
 */

/**
 * 客户端心跳超时（秒）
 * @description aedes 以 keepalive * 1.5 判定失联，300 秒即 7.5 分钟判死。
 * 原实现强制 3600，等于手机断网后 90 分钟内仍被当作在线，
 * 这期间推送会被判 success 且不进退避队列，是"掉线丢消息"的隐藏成因。
 */
const KEEPALIVE_SECONDS = 300;

/**
 * PUBACK 等待窗口（毫秒）
 * @description 报文写出后超过这个时间还没收到客户端确认，就认为对方没收到，
 * 退回"未送达"等下次上线补投。宁可重复投一次，也不能让消息静默停在"已下发"。
 */
const PUBACK_TIMEOUT = 30000;

/**
 * 扫描"已下发未确认"的间隔（毫秒）
 */
const PUBACK_SWEEP_INTERVAL = 10000;

/**
 * PushMe消息推送服务
 * @description 支持MQTT/WebSocket/TCP多协议，集成Aedes MQTT Broker，
 * 消息统一落地 SQLite 台账，送达只认客户端 PUBACK
 */
class PushMe {
    /**
     * 构造函数
     */
    constructor() {
        /** @type {number} 服务启动时间戳 */
        this._ontime = 0;
        /** @type {number} 当前连接数 */
        this._connectionCount = 0;
        /** @type {string} 证书目录 */
        this._certsDir = path.join(__dirname, '..', 'config', 'certs');
        /** @type {string} 私钥文件路径 */
        this._keyPath = path.join(this._certsDir, 'private.key');
        /** @type {string} 证书文件路径 */
        this._certPath = path.join(this._certsDir, 'cert.crt');
        /** @type {import('./config.js').ConfigManager} 配置管理器 */
        this._config = getConfig();
        /** @type {MessageStore} 消息台账（队列 + 送达记录） */
        this._store = new MessageStore({
            file: path.join(this._config.dir, 'messages.db'),
            retainDays: this._config.messages.retain_days,
            maxPerKey: this._config.messages.max_per_key,
            importFile: path.join(this._config.dir, 'offline.json')
        });
        /** @type {Map<string, {id: number, topic: string}>} clientId:messageId -> 消息，用于 PUBACK 反查 */
        this._inflight = new Map();
        /**
         * @type {Map<string, number[]>} clientId -> 待确认的 messageId 队列
         * @description clean session 的客户端不会进 aedes 的 outgoing 存储，
         * PUBACK 回调里拿不到原始报文（packet 为 undefined），只能按投递顺序弹队首。
         * QoS1 在单条 TCP 连接上保序，客户端也是收一条 ACK 一条，队首即它刚确认的那条。
         */
        this._ackQueue = new Map();
        /** @type {Array<{topic: string, payload: string, id: number}>} 正在 fan-out 的发布，供 authorizeForward 认领 */
        this._publishing = [];
        /** @type {NodeJS.Timeout|null} PUBACK 超时回收定时器 */
        this._sweepTimer = null;
        /** @type {Set<string>} 正在补投的 key，避免并发重复补投 */
        this._replaying = new Set();
        /**
         * @type {Set<string>} clientId:topic -> 本连接内已补投过
         * @description App 连上后会对同一个 key 发两次 SUBSCRIBE（连接时一次、回前台再补一次），
         * 只按 topic 加锁会在两次订阅之间失效，同一条消息被补投两遍，手机上就出现两条通知。
         * 补投记账改成"连接 + key"，断线时清掉。
         */
        this._replayedBy = new Set();
        // 保留策略热更新：设置页保存后立即生效并补一次清理，无需重启服务
        this._config.onChange(/** @param {string} key */ (key) => {
            if(key !== 'messages') return;
            const messages = this._config.messages;
            this.applyRetention({retainDays: messages.retain_days, maxPerKey: messages.max_per_key});
        });
        /** @type {Aedes|null} MQTT Broker实例 */
        this.aedes = null;
        /** @type {HttpServer|null} HTTP服务器（用于证书下载和WebSocket） */
        this.httpServer = null;
        /** @type {WsServer|null} WebSocket服务器 */
        this.wsServer = null;
        /** @type {TcpServer|TlsServer|null} TCP/TLS服务器 */
        this.tcpServer = null;

        if(this._config.status === 'start') {
            this.start();
        } else {
            Logger.system('PushMe server not started');
        }
    }

    /**
     * TLS配置选项
     * @type {import('node:tls').TlsOptions}
     */
    get tlsOptions() {
        return {
            key: fs.readFileSync(this._keyPath),
            cert: fs.readFileSync(this._certPath),
            requestCert: false,
            rejectUnauthorized: false,
        };
    }

    /** 初始化所有服务器（Aedes、HTTP、WebSocket、TCP） */
    async _setupServers() {
        // PushMe aedes
        this.aedes = await createAedes();

        // 客户端订阅成功后补投离线消息（此时订阅已在 broker 生效）
        this.aedes.on('subscribe', (/** @type {Array<{topic: string}>} */ subs, /** @type {AedesClient} */ client) => {
            const cid = client && client.id ? client.id : '';
            for(const sub of subs) {
                if(!sub || !sub.topic) continue;
                this._flushOffline(sub.topic, cid).catch(/** @param {Error} err */ err => {
                    Logger.error('[offline] replay failed:', err.message);
                });
            }
        });

        // 投递登记：aedes 给每个订阅者单独分配报文标识，在 fan-out 的那一刻把
        // "即将使用的 messageId" 和落库的消息对应起来，PUBACK 到达时才能反查。
        // authorizeForward 是 aedes 官方的转发钩子，调用点就在 QoSPacket 构造之前，
        // 此时 client._nextId 就是这条消息将要占用的报文标识。
        this.aedes.authorizeForward = (/** @type {AedesClient} */ client, /** @type {any} */ packet) => {
            try {
                this._pinInflight(client, packet);
            } catch(/** @type {any} */ err) {
                Logger.debug('[puback] pin failed:', err.message);
            }
            return packet;
        };

        // 送达判定：只有 PUBACK 到达才算送达（aedes 1.x 的 'ack' 事件）
        // clean session 的客户端拿不到原始报文（packet 为 undefined），按投递顺序弹队首；
        // 持久会话的客户端能拿到报文，用 topic + payload 精确反查。
        this.aedes.on('ack', (/** @type {any} */ packet, /** @type {AedesClient} */ client) => {
            this._handleAck(packet, client);
        });

        // 断开即清理：同一 clientId 下次连上来时不会误配上一轮的报文标识
        this.aedes.on('clientDisconnect', (/** @type {AedesClient} */ client) => {
            this._dropClient(client.id);
        });

        // PUBACK 超时回收：客户端在确认前一刻掉线，消息不能永久停在"已下发"
        if(this._sweepTimer) clearInterval(this._sweepTimer);
        this._sweepTimer = setInterval(() => this._sweepInflight(), PUBACK_SWEEP_INTERVAL);
        // @ts-ignore Node 定时器
        this._sweepTimer.unref && this._sweepTimer.unref();

        // PushMe Certs Server
        this.httpServer = require('http').createServer((req, res) => {
            let status = 404;
            /** @type {Record<string, string>} */
            let headers = {'Content-Type': 'text/plain'};
            /** @type {string|Buffer} */
            let body = 'Not Found';
            const url = req.url || '';
            if(~url.indexOf('/certs/cert.crt')) {
                status = 200;
                body = fs.existsSync(this._certPath) ? fs.readFileSync(this._certPath) : '请先在服务端生成自签名证书';
            } else if(~url.indexOf('/certs/download')) {
                status = 200;
                body = fs.existsSync(this._certPath) ? fs.readFileSync(this._certPath) : '';
                headers = {
                    'Content-Type': 'application/x-x509-ca-cert',
                    'Content-Disposition': 'attachment; filename="cert.crt"',
                    'Content-Length': String(body.length),
                    'Cache-Control': 'no-cache'
                };
            }
            res.writeHead(status, headers);
            res.end(body);
            Logger.debug(url, body);
        });

        // PushMe WebSocket Server (ws)
        const WebSocket = require('ws');
        this.wsServer = new WebSocket.WebSocketServer({ server: this.httpServer });
        this.wsServer.on('connection', (websocket, req) => {
            const stream = WebSocket.createWebSocketStream(websocket);
            this.aedes && this.aedes.handle(stream, /** @type {any} */(req));
        });

        // PushMe Server
        if(this._config.tls && this._config.tls != 'none' && fs.existsSync(this._keyPath) && fs.existsSync(this._certPath)) {
            this.tcpServer = /** @type {TcpServer|TlsServer} */ (require('node:tls').createServer(this.tlsOptions, /** @type {any} */ (this._handleConnection.bind(this))));
        } else {
            this.tcpServer = require('net').createServer(this._handleConnection.bind(this));
        }
    }

    /**
     * 处理新TCP连接，自动检测协议并分发
     * @param {TcpSocket} socket - TCP连接套接字
     */
    _handleConnection(socket) {
        this._connectionCount++;
        Logger.debug('New connection. Total:', this._connectionCount);

        socket.setTimeout(1000);
        let isProtocolDetected = false;
        let initialBuffer = Buffer.alloc(0);

        /** @param {Buffer} chunk */
        const onData = chunk => {
            if (isProtocolDetected) return;

            initialBuffer = Buffer.concat(/** @type {any} */ ([initialBuffer, chunk]));
            if(initialBuffer.length < 8) return;

            isProtocolDetected = true
            socket.setTimeout(0); // 清除超时
            socket.removeListener('data', onData);
            socket.removeListener('timeout', onTimeout);
            socket.removeListener('error', onError);

            // 快速协议检测
            const protocol = this._detectProtocol(initialBuffer);
            socket.unshift(initialBuffer);
            if (protocol === 'mqtt') {
                Logger.debug('MQTT connection detected');
                this.aedes && this.aedes.handle(socket);
            } else if(protocol === 'websocket' || protocol === 'http') {
                Logger.debug(`${protocol.toUpperCase()} connection detected`);
                this.httpServer && this.httpServer.emit('connection', socket);
            } else {
                Logger.debug('Unknown protocol, connection destroyed');
                socket.destroy();
            }
        };

        const onTimeout = () => {
            if (!isProtocolDetected) {
                Logger.debug('Protocol detection timeout');
                socket.destroy();
            }
        };

        /** @param {Error} err */
        const onError = err => {
            Logger.error('Socket error:', err.message);
            socket.destroy();
        };

        socket.on('data', onData);
        socket.on('timeout', onTimeout);
        socket.on('error', onError);
        socket.once('close', () => {
            this._connectionCount--;
            Logger.debug('Connection closed. Total:', this._connectionCount);
        });
    }

    /**
     * 检测连接协议类型
     * @param {Buffer} buffer - 初始数据缓冲
     * @returns {'mqtt'|'websocket'|'http'|'unknown'|'need_more_data'} 检测到的协议
     */
    _detectProtocol(buffer) {
        if (buffer.length < 8) {
            return 'need_more_data'; // 数据不足，等待更多
        }

        // 检查 MQTT: 前6字节包含 "MQTT" 字符串
        if (buffer[0] === 0x10 && buffer.length >= 8) {
            const protocolName = buffer.toString('utf8', 4, 8);
            if (protocolName === 'MQTT') {
                return 'mqtt';
            }
        }

        // 检查 WebSocket: 包含完整的握手特征
        const dataStr = buffer.toString('utf8');
        if (dataStr.startsWith('GET') && dataStr.includes('Upgrade: websocket')) {
            return 'websocket';
        }

        // 检查普通 HTTP (不是 WebSocket)
        const methods = ['GET ', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'];
        if (methods.some(method => dataStr.startsWith(method))) {
            return 'http';
        }

        return 'unknown';
    }

    /** 启动服务 */
    async start() {
        await this._setupServers();
        this.tcpServer && this.tcpServer.listen(this._config.serverPort, /** @param {Error} [err] */ (err) => {
            if(!err) {
                this._ontime = Date.now();
                Logger.system(`PushMe server started, listening on port ${this._config.serverPort}`);
            } else {
                Logger.error('PushMe server failed to start:', err);
            }
        });
    }

    /**
     * 停止服务
     * @returns {Promise<string>} 操作结果
     */
    async stop() {
        if(!this.tcpServer) {
            return '服务未启动';
        }

        try {
            await new Promise((resolve, reject) => {
                this.tcpServer && this.tcpServer.close(err => {
                    if(!err) {
                        Logger.system('PushMe tcp server stopped');
                        resolve(undefined);
                    } else {
                        Logger.error('PushMe tcp server failed to stop:', err);
                        reject(err);
                    }
                });
                !this.tcpServer && resolve(undefined);
            });

            this.wsServer && this.wsServer.close();

            await new Promise((resolve, reject) => {
                this.httpServer && this.httpServer.listening && this.httpServer.close(err => {
                    if(!err) {
                        Logger.system('PushMe http server stopped');
                        resolve(undefined);
                    } else {
                        Logger.error('PushMe http server failed to stop:', err);
                        reject(err);
                    }
                });
                (!this.httpServer || !this.httpServer.listening) && resolve(undefined);
            });

            this.aedes && await closeAedes(this.aedes);

            this.tcpServer = null;
            this.wsServer = null;
            this.httpServer = null;
            this.aedes = null;
            if(this._sweepTimer) clearInterval(this._sweepTimer);
            this._sweepTimer = null;
            this._inflight.clear();
            this._ackQueue.clear();
            this._replayedBy.clear();
            this._publishing.length = 0;
            this._connectionCount = 0;

            Logger.system('PushMe server stopped');
            return '关闭成功';
        } catch(/** @type {any} */ err) {
            Logger.error('PushMe server failed to stop:', err);
            return err.message;
        }
    }

    /**
     * 优雅重启服务（不中断进程）
     * @returns {Promise<string>} 操作结果
     */
    async restart() {
        Logger.system('PushMe server restarting...');
        const stopResult = await this.stop();
        if(stopResult !== '关闭成功' && stopResult !== '服务未启动') {
            return '重启失败: ' + stopResult;
        }
        await this.start();
        return '重启成功';
    }

    /**
     * 服务运行时长
     * @type {number} 运行秒数
     */
    get uptime() {
        return this.status == 'start' ? (Date.now() - this._ontime) / 1000 : 0;
    }

    /**
     * 服务状态
     * @type {'start'|'stop'}
     */
    get status() {
        return this.tcpServer ? 'start' : 'stop';
    }

    /**
     * 当前连接数
     * @type {number}
     */
    get connectionCount() {
        return this._connectionCount;
    }

    /**
     * 已连接的MQTT客户端数
     * @type {number}
     */
    get clientCount() {
        return this.aedes ? this.aedes.connectedClients : 0;
    }

    /**
     * 消息台账
     * @type {MessageStore}
     */
    get store() {
        return this._store;
    }

    /**
     * 应用新的保留策略并立即清理一次
     * @param {{retainDays?: number, maxPerKey?: number}} [options={}]
     * @returns {ReturnType<MessageStore['setRetention']>}
     */
    applyRetention(options = {}) {
        return this._store.setRetention(options);
    }

    /**
     * 台账统计
     * @returns {ReturnType<MessageStore['stats']>}
     */
    get messageStats() {
        return this._store.stats();
    }

    /**
     * 发布消息到MQTT Broker
     * @description 发布结果三态：success-已投递给在线/持有持久会话的订阅者；
     * queued-当前无任何订阅者，已入库等待客户端上线补投；
     * 其他字符串-发布失败原因。
     * 无论哪种结果，消息都会先落库，管理端可查、可重发。
     * @param {string} topic - 消息主题
     * @param {string|Object} msg - 消息内容，对象会自动序列化
     * @param {number} [qos=1] - QoS级别（0|1|2）
     * @returns {Promise<string>} 发布结果
     */
    async publish(topic, msg, qos = 1) {
        /** @type {string} */
        let payload;
        /** @type {{title?: string, content?: string, type?: string}} */
        let meta = {};
        if(typeof msg == 'object') {
            /** @type {Record<string, any>} */
            const obj = msg;
            if(!obj.date) {
                obj.date = utils.date.format('YYYY-mm-dd HH:ii:ss');
            }
            payload = JSON.stringify(obj);
            meta = {title: obj.title, content: obj.content, type: obj.type};
        } else {
            payload = msg;
            meta = {content: payload};
        }

        /** @type {number} 落库的消息id */
        const id = this._store.create({key: topic, raw: payload, title: meta.title, content: meta.content, type: meta.type, qos});
        return this._deliver(topic, payload, qos, id);
    }

    /**
     * 原样重发一条已存在的报文（管理端"重发"用）
     * @description 不重新序列化、不补 date 字段，保证与首次投递完全一致；会新建一条台账记录
     * @param {string} topic - 消息主题
     * @param {string} payload - 原始报文
     * @param {number} [qos=1] - QoS级别
     * @param {{title?: string, content?: string, type?: string}} [meta={}] - 台账展示字段
     * @returns {Promise<string>} 发布结果
     */
    async publishRaw(topic, payload, qos = 1, meta = {}) {
        const id = this._store.create({key: topic, raw: payload, title: meta.title, content: meta.content, type: meta.type, qos});
        return this._deliver(topic, payload, qos, id);
    }

    /**
     * 按当前在线情况投递（落库之后的状态机）
     * @private
     * @param {string} topic
     * @param {string} payload
     * @param {number} qos
     * @param {number} id - 台账记录id
     * @returns {Promise<string>}
     */
    async _deliver(topic, payload, qos, id) {
        // 服务未运行：不丢弃，留在队列等上线补投
        if(!this.aedes) {
            if(!this._config.offline.enabled) {
                this._store.drop(id, 'broker not running');
                Logger.system('[publish]', topic, 'broker not running, offline store disabled');
                return 'no_subscriber';
            }
            Logger.system('[publish:queued]', topic, 'broker not running', `msg=${id}`);
            return 'queued';
        }

        // 有接收方（在线，或离线但持有持久会话、由 broker 自行排队）→ 直接投递
        if(await this._hasSubscriber(topic)) {
            const result = await this._rawPublish(topic, payload, qos, id);
            if(result === 'success') {
                this._store.markSent(id);
                return 'success';
            }
            // 投递失败：留在队列等下次上线，重试次数由台账记录
            this._store.requeue(id, result);
            Logger.error('[publish]', topic, result, `msg=${id}`);
            return result === 'publish timeout' ? 'queued' : result;
        }

        // 无人接收（设备从未上线 / 客户端使用 clean session 掉线）→ 暂存
        if(!this._config.offline.enabled) {
            this._store.drop(id, 'no subscriber');
            Logger.system('[publish]', topic, 'no subscriber, offline store disabled');
            return 'no_subscriber';
        }
        Logger.system('[publish:queued]', topic, `pending=${this._store.pendingCount(topic)}`, `msg=${id}`);
        return 'queued';
    }

    /**
     * 是否已有接收方
     * @description 同时检查"当前在线订阅者"与"持久化会话中的离线订阅者"，
     * 避免与 broker 自身的离线队列重复补投
     * @private
     * @param {string} topic - 消息主题
     * @returns {Promise<boolean>}
     */
    async _hasSubscriber(topic) {
        if(!this.aedes) return false;
        // 在线客户端（clean session 的订阅不会进持久化，必须查内存）
        for(const client of Object.values(this.aedes.clients)) {
            const subscriptions = /** @type {any} */ (client).subscriptions;
            if(subscriptions && subscriptions[topic]) return true;
        }
        // 持持久会话的离线客户端
        try {
            const subs = await this.aedes.persistence.subscriptionsByTopic(topic);
            return Array.isArray(subs) && subs.length > 0;
        } catch(/** @type {any} */ err) {
            Logger.error('Check subscriber failed:', err.message);
            return false;
        }
    }

    /**
     * 从"正在 fan-out 的发布"里认领当前报文对应的消息
     * @description 自定义字段会被 aedes 的 Packet 构造器丢掉，只能按 topic + payload 对齐。
     * aedes.publish 的 fan-out 是同步的，所以此刻正在投递的一定在列表里。
     * @private
     * @param {any} packet - 待转发的报文
     * @returns {{topic: string, payload: string, id: number}|null}
     */
    _claim(packet) {
        if(!packet || !packet.topic) return null;
        const payload = packet.payload ? String(packet.payload) : '';
        for(let i = this._publishing.length - 1; i >= 0; i--) {
            const item = this._publishing[i];
            if(item.topic === packet.topic && item.payload === payload) return item;
        }
        return null;
    }

    /**
     * 登记"某客户端接下来会收到的 messageId"，用于 PUBACK 反查消息
     * @description QoSPacket 取 client._nextId 后自增，构造点就在 authorizeForward 之后，
     * 所以这里读到的就是这条消息的报文标识。取不到时静默跳过，状态会停在"已下发"，不会谎报送达。
     * @private
     * @param {AedesClient} client
     * @param {any} packet
     */
    _pinInflight(client, packet) {
        if(!packet || Number(packet.qos) < 1) return;
        const claim = this._claim(packet);
        if(!claim || !claim.id) return;
        const mid = Number(/** @type {any} */ (client)._nextId) || 0;
        if(!mid) return;

        this._inflight.set(client.id + ':' + mid, {id: claim.id, topic: packet.topic});
        const queue = this._ackQueue.get(client.id) || [];
        queue.push(mid);
        // 队列上限：正常客户端不会积压这么多未确认报文，超了说明对端压根不 ACK
        if(queue.length > 512) queue.splice(0, queue.length - 512);
        this._ackQueue.set(client.id, queue);
        Logger.debug('[puback] pin', client.id, `mid=${mid}`, `msg=#${claim.id}`);
    }

    /**
     * 处理 PUBACK
     * @description "任一客户端确认即送达"：同一个 key 有多个订阅者时，
     * broker 会给每个订阅者各发一份、各占一个报文标识，任一份确认就把消息置为已送达。
     * 重复确认（DUP 重传）由 markDelivered 保证幂等，不会刷新送达时间。
     * @private
     * @param {any} packet - 原始报文（clean session 下为 undefined）
     * @param {AedesClient} client
     */
    _handleAck(packet, client) {
        if(!client || !client.id) return;
        const cid = client.id;
        try {
            let mid = packet && packet.messageId ? Number(packet.messageId) : 0;
            if(mid) {
                this._unqueue(cid, mid);
            } else {
                // clean session：PUBACK 只有报文标识，且这里拿不到，按投递顺序弹队首
                const queue = this._ackQueue.get(cid);
                mid = queue && queue.length ? /** @type {number} */ (queue.shift()) : 0;
                if(queue && !queue.length) this._ackQueue.delete(cid);
            }
            if(!mid) {
                Logger.debug('[puback]', cid, 'no inflight id');
                return;
            }

            const mapKey = cid + ':' + mid;
            const hit = this._inflight.get(mapKey);
            this._inflight.delete(mapKey);

            let target = hit ? hit.id : 0;
            let topic = hit ? hit.topic : '';
            // 持久会话兜底：重连后 broker 会重发存储的报文，报文标识不在本轮映射里
            if(!target && packet && packet.topic && packet.payload) {
                target = this._store.findPendingByRaw(packet.topic, String(packet.payload));
                topic = packet.topic || '';
            }
            if(!target) {
                Logger.debug('[puback]', cid, `mid=${mid}`, 'unmatched');
                return;
            }

            const res = this._store.markDelivered(target, cid);
            if(res.changed) {
                const at = utils.date.format('YYYY-mm-dd HH:ii:ss');
                Logger.system(`[puback] clientId=${cid} mid=${mid} topic=${topic || '-'} msg=#${target} status ${res.before}->${res.after} at ${at}`);
            } else {
                Logger.debug('[puback] duplicate', cid, `msg=#${target}`, `status=${res.after}`);
            }
        } catch(/** @type {any} */ err) {
            Logger.error('[puback] handle failed:', err.message);
        }
    }

    /**
     * 从待确认队列里移除某个报文标识
     * @private
     * @param {string} cid
     * @param {number} mid
     */
    _unqueue(cid, mid) {
        const queue = this._ackQueue.get(cid);
        if(!queue || !queue.length) return;
        const i = queue.indexOf(mid);
        if(i >= 0) queue.splice(i, 1);
        if(!queue.length) this._ackQueue.delete(cid);
    }

    /**
     * 客户端断开时清掉它的待确认状态
     * @private
     * @param {string} cid
     */
    _dropClient(cid) {
        if(!cid) return;
        this._ackQueue.delete(cid);
        for(const key of Array.from(this._inflight.keys())) {
            // clientId 里可能出现冒号，按最后一个冒号切，避免前缀相同的 id 互相误删
            if(key.slice(0, key.lastIndexOf(':')) === cid) this._inflight.delete(key);
        }
        // 连接断了，下次上线应当重新补投，所以清掉本连接的补投记账
        const prefix = cid + ':';
        for(const key of Array.from(this._replayedBy)) {
            if(key.startsWith(prefix)) this._replayedBy.delete(key);
        }
    }

    /**
     * 回收等不到 PUBACK 的消息
     * @private
     */
    _sweepInflight() {
        try {
            const res = this._store.revertStale(PUBACK_TIMEOUT);
            if(!res.count) return;
            const dead = new Set(res.ids);
            for(const [mapKey, item] of this._inflight) {
                if(dead.has(item.id)) this._inflight.delete(mapKey);
            }
            Logger.system('[puback] timeout, requeued', `count=${res.count}`, `ids=${res.ids.join(',')}`);
        } catch(/** @type {any} */ err) {
            Logger.error('[puback] sweep failed:', err.message);
        }
    }

    /**
     * 实际发布（带超时保护）
     * @private
     * @param {string} topic - 消息主题
     * @param {string} payload - 消息正文
     * @param {number} qos - QoS级别
     * @param {number} [messageId] - 落库的消息id，用于登记送达确认
     * @returns {Promise<string>} 发布结果
     */
    _rawPublish(topic, payload, qos, messageId) {
        return new Promise(resolve => {
            if(!this.aedes) return resolve('publish timeout');
            /** @type {any} */
            const packet = {
                cmd: 'publish',
                topic,
                payload: Buffer.from(payload),
                qos,
                dup: false,
                retain: false
            };
            // 登记本次发布，authorizeForward 靠它认出"这个报文对应哪条台账记录"
            const claim = messageId ? {topic, payload, id: messageId} : null;
            if(claim) this._publishing.push(claim);
            /** @type {boolean} */
            let released = false;
            const release = () => {
                if(released) return;
                released = true;
                if(!claim) return;
                const i = this._publishing.indexOf(claim);
                if(i >= 0) this._publishing.splice(i, 1);
            };

            let done = false;
            const timer = setTimeout(() => {
                if(done) return;
                done = true;
                release();
                Logger.error('[publish]', topic, 'timeout');
                resolve('publish timeout');
            }, 5000);
            timer.unref && timer.unref();
            this.aedes.publish(packet, error => {
                if(done) return;
                done = true;
                clearTimeout(timer);
                release();
                const result = error ? error.message : 'success';
                resolve(result);
            });
        });
    }

    /**
     * 客户端订阅后补投离线消息
     * @private
     * @param {string} topic - 消息主题
     * @param {string} [clientId] - 订阅方，用于按连接去重（App 会对同一个 key 重复 SUBSCRIBE）
     * @returns {Promise<number>} 补投条数
     */
    async _flushOffline(topic, clientId = '') {
        if(!this.aedes || this._replaying.has(topic)) return 0;
        const onceKey = clientId ? clientId + ':' + topic : '';
        if(onceKey && this._replayedBy.has(onceKey)) {
            Logger.debug('[offline] skip duplicate subscribe', clientId, topic);
            return 0;
        }
        this._replaying.add(topic);
        try {
            const items = this._store.pending(topic);
            if(!items.length) return 0;
            if(onceKey) this._replayedBy.add(onceKey);

            Logger.system('[offline] replay', topic, clientId ? `client=${clientId}` : '', `count=${items.length}`);
            let sent = 0;
            for(const item of items) {
                const result = await this._rawPublish(topic, item.raw, item.qos || 1, item.id);
                if(result !== 'success') {
                    // 投递中断：剩余消息留在队列，下次上线继续（不丢，最多重复）
                    this._store.requeue(item.id, result);
                    Logger.error('[offline] replay interrupted:', result);
                    break;
                }
                this._store.markSent(item.id);
                sent++;
            }
            return sent;
        } finally {
            this._replaying.delete(topic);
        }
    }

    /**
     * 待补投的离线消息总数
     * @type {number}
     */
    get offlineCount() {
        return this._store.pendingCount();
    }

    /**
     * 有离线消息待补投的push_key数量
     * @type {number}
     */
    get offlineKeyCount() {
        return this._store.pendingKeyCount;
    }
}

/**
 * 创建并配置Aedes MQTT Broker
 * @returns {Promise<Aedes>} 配置好的Aedes实例
 */
async function createAedes() {
    const { Aedes } = require('aedes');
    /** @type {Aedes} */
    const aedes = await Aedes.createBroker();

    /**
     * 连接前拦截，限制心跳窗口
     * @param {AedesClient} client
     * @param {any} packet - 连接报文
     * @param {Function} callback
     */
    aedes.preConnect = function(client, packet, callback) {
        Logger.debug('[preConnect]', {clientId: packet.clientId, keepalive: packet.keepalive});
        // 客户端心跳间隔过大时收紧，保证掉线能被及时发现（aedes 判定窗口 = keepalive * 1.5）
        if(packet.keepalive > KEEPALIVE_SECONDS) {
            packet.keepalive = KEEPALIVE_SECONDS;
        }
        callback(null, true);
    }

    /**
     * 订阅授权，只允许已配置的push_key主题
     * @param {AedesClient} client
     * @param {Object} sub - 订阅对象
     * @param {string} sub.topic - 订阅主题
     * @param {Function} callback
     */
    aedes.authorizeSubscribe = function(client, sub, callback) {
        Logger.debug('[authorizeSubscribe]', {clientId: client.id, topic: sub.topic, qos: sub.qos});
        const config = getConfig();
        if(!sub.topic || !config.pushKeys.includes(sub.topic)) {
            return callback(new Error('Unauthorized subscribe topic: ' + sub.topic));
        }
        callback(null, sub);
    }

    /**
     * 发布授权，只允许向已配置的push_key主题发布
     * @param {AedesClient|null} client - 发布客户端（系统内部发布时为null）
     * @param {Object} packet - 发布报文
     * @param {string} packet.topic - 发布主题
     * @param {Function} callback
     */
    aedes.authorizePublish = function(client, packet, callback) {
        Logger.debug('[authorizePublish]', {clientId: client?.id, topic: packet.topic});
        // 系统内部发布（client为null）允许通过
        if(!client) {
            return callback(null);
        }
        const config = getConfig();
        if(!packet.topic || !config.pushKeys.includes(packet.topic)) {
            return callback(new Error('Unauthorized publish topic: ' + packet.topic));
        }
        callback(null);
    }

    aedes.on('client', function(client) {
        Logger.system('[client]', client.id)
    })
    aedes.on('clientReady', function(client) {
        Logger.system('[clientReady]', client.id);
    });
    aedes.on('clientDisconnect', function(client) {
        Logger.system('[clientDisconnect]', client.id);
    });
    /**
     * @param {AedesClient} client
     * @param {Error} err
     */
    aedes.on('clientError', function (client, err) {
        Logger.system('[clientError]', client.id, err.message);
    });

    return aedes;
}

/**
 * 关闭Aedes MQTT Broker
 * @param {Aedes} aedes - Aedes实例
 * @returns {Promise<void>}
 */
function closeAedes(aedes) {
    return new Promise((resolve, reject) => {
        aedes.close(/** @param {Error} [err] */ (err) => {
            if (err) {
                Logger.error('PushMe aedes server failed to stop:', err);
                reject(err)
            } else {
                Logger.system('PushMe aedes server stopped');
                resolve()
            }
        });
    })
}

module.exports = PushMe;
