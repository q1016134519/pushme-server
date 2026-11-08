/**
 * 测试辅助：起一个独立配置目录的 PushMe 服务 + 最小 MQTT 客户端
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 生成一个空闲端口 */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** 等待端口可连接 */
function waitPort(port, timeout = 15000) {
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
        const tick = () => {
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(); });
            sock.once('error', () => {
                sock.destroy();
                if (Date.now() > deadline) return reject(new Error('port ' + port + ' not ready'));
                setTimeout(tick, 120);
            });
        };
        tick();
    });
}

/**
 * 启动被测服务
 * @param {{offline?: object, keys?: string[], status?: string, configDir?: string, panelPort?: number, serverPort?: number}} [opts]
 */
async function startServer(opts = {}) {
    const keys = opts.keys || ['k1'];
    const configDir = opts.configDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pushme-test-'));
    const panelPort = opts.panelPort || await freePort();
    let serverPort = opts.serverPort || await freePort();
    // 两次 freePort() 之间端口已释放，操作系统可能复用同一个端口，这里强制区分
    while (serverPort === panelPort) serverPort = await freePort();

    /** @type {any} */
    const data = {
        config_version: 1,
        server_port: serverPort,
        panel_port: panelPort,
        push_keys: keys.map(k => ({ key: k, temp_key: '', note: '' })),
        status: opts.status || 'start'
    };
    if (opts.offline) data.offline = opts.offline;
    fs.writeFileSync(path.join(configDir, 'data.json'), JSON.stringify(data, null, 2));

    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PUSHME_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    /** @type {string[]} */
    const logs = [];
    child.stdout.on('data', d => logs.push(String(d)));
    child.stderr.on('data', d => logs.push(String(d)));

    await waitPort(panelPort);
    // PushMeServer 构造函数里的 start() 不会被 await，且 _setupServers() 内要先生成自签证书，
    // 因此面板端口就绪时 MQTT 端口可能还没监听，必须单独等待，否则首连会 ECONNREFUSED。
    if (data.status === 'start') await waitPort(serverPort);

    return {
        panelPort,
        serverPort,
        configDir,
        logs,
        get log() { return logs.join(''); },
        async push(params) {
            const body = new URLSearchParams(params).toString();
            const res = await fetch(`http://127.0.0.1:${panelPort}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            });
            return (await res.text()).trim();
        },
        async status() {
            const res = await fetch(`http://127.0.0.1:${panelPort}/server/status`, {
                method: 'POST',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            return res.json();
        },
        /** 只杀进程，保留配置目录（用于重启测试） */
        async kill() {
            // exitCode 为 null 但 signalCode 非空，说明已被信号终止
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill('SIGKILL');
            await new Promise(resolve => child.once('exit', resolve));
        },
        /** 杀进程并清理临时目录 */
        async stop() {
            await this.kill();
            try {
                fs.rmSync(configDir, { recursive: true, force: true });
            } catch(/** @type {any} */ err) {
                // Windows 下刚被杀掉的进程可能还短暂持有 messages.db 句柄，
                // 清理失败不该让测试失败（目录在系统临时区，会被自动回收）
            }
        }
    };
}

/** MQTT 3.1.1 最小客户端 */
class MqttClient {
    constructor({ port, clientId, clean = true, autoAck = true }) {
        this.port = port;
        this.clientId = clientId;
        this.clean = clean;
        /** 收到 QoS1 报文是否回 PUBACK；false 用于模拟"收下了但不确认"的客户端 */
        this.autoAck = autoAck;
        this.messages = [];
        this.waiters = [];
        this.buf = Buffer.alloc(0);
        this.sock = null;
    }

    static utf8(s) {
        const b = Buffer.from(s);
        const l = Buffer.alloc(2);
        l.writeUInt16BE(b.length);
        return Buffer.concat([l, b]);
    }

    static varint(n) {
        const out = [];
        do {
            let d = n % 128;
            n = Math.floor(n / 128);
            if (n > 0) d |= 0x80;
            out.push(d);
        } while (n > 0);
        return Buffer.from(out);
    }

    static packet(type, flags, payload) {
        return Buffer.concat([Buffer.from([(type << 4) | flags]), MqttClient.varint(payload.length), payload]);
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.sock = net.connect(this.port, '127.0.0.1', () => {
                const flags = this.clean ? 0x02 : 0x00;
                const vh = Buffer.concat([MqttClient.utf8('MQTT'), Buffer.from([4, flags, 0x00, 0x3c])]);
                this.sock.write(MqttClient.packet(1, 0, Buffer.concat([vh, MqttClient.utf8(this.clientId)])));
            });
            this.sock.on('error', reject);
            this.sock.on('data', chunk => this._onData(chunk));
            this._onConnAck = resolve;
        });
    }

    _onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (this.buf.length > 1) {
            let mult = 1, len = 0, p = 1, complete = true;
            while (true) {
                if (p >= this.buf.length) { complete = false; break; }
                const b = this.buf[p++];
                len += (b & 0x7f) * mult;
                mult *= 128;
                if (!(b & 0x80)) break;
            }
            if (!complete || this.buf.length < p + len) break;
            const type = this.buf[0] >> 4;
            const body = this.buf.slice(p, p + len);
            this.buf = this.buf.slice(p + len);

            if (type === 2) {
                this._onConnAck && this._onConnAck({ sessionPresent: body[0] & 1 });
            } else if (type === 9) {
                this._onSubAck && this._onSubAck();
            } else if (type === 3) {
                const topicLen = body.readUInt16BE(0);
                const qos = 1; // 服务端以 qos1 发布
                const pid = body.readUInt16BE(2 + topicLen);
                const payload = body.slice(4 + topicLen).toString();
                this.messages.push(payload);
                if(this.autoAck) this.sock.write(MqttClient.packet(4, 0, Buffer.from([pid >> 8, pid & 0xff])));
                this._drain();
            }
        }
    }

    _drain() {
        for (const w of [...this.waiters]) {
            if (this.messages.length >= w.count) {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(this.messages.slice());
            }
        }
    }

    subscribe(topic) {
        return new Promise(resolve => {
            this._onSubAck = resolve;
            const payload = Buffer.concat([Buffer.from([0x00, 0x01]), MqttClient.utf8(topic), Buffer.from([0x01])]);
            this.sock.write(MqttClient.packet(8, 0x02, payload));
        });
    }

    /** 等够 count 条消息 */
    waitFor(count, timeout = 5000) {
        if (this.messages.length >= count) return Promise.resolve(this.messages.slice());
        return new Promise((resolve, reject) => {
            const waiter = {
                count, resolve, timer: setTimeout(() => {
                    this.waiters.splice(this.waiters.indexOf(waiter), 1);
                    reject(new Error(`expect ${count} message(s), got ${this.messages.length}`));
                }, timeout)
            };
            this.waiters.push(waiter);
        });
    }

    /** 等一小段时间，确认没有新消息 */
    async settle(ms = 600) {
        await new Promise(r => setTimeout(r, ms));
        return this.messages.slice();
    }

    close() {
        if (!this.sock) return;
        try { this.sock.write(MqttClient.packet(14, 0, Buffer.alloc(0))); } catch (e) { /* ignore */ }
        this.sock.destroy();
        this.sock = null;
    }
}

module.exports = { startServer, MqttClient, freePort, waitPort };
