const {getConfig} = require('./config.js');

/**
 * @typedef {Object} PushmeProxyInstance
 * @property {function(import('./pushme_panel.js')): void} setPanel - 设置面板引用
 * @property {function} start - 启动服务
 * @property {function} stop - 停止服务
 * @property {function} restart - 重启服务
 * @property {function} publish - 发布消息
 * @property {function} publishRaw - 原样重发（不重新序列化）
 * @property {number} messageCount - 消息计数
 * @property {function} messageCountSave - 保存消息计数
 * @property {number} uptime - 运行时长（秒）
 * @property {number} panelUptime - 面板运行时长（秒）
 * @property {string} status - 服务状态
 * @property {number} clientCount - 客户端数量
 * @property {number} connectionCount - 连接数量
 * @property {number} serverPort - 服务端口
 * @property {number} panelPort - 面板端口
 * @property {number} offlineCount - 待补投的离线消息数
 * @property {number} offlineKeyCount - 有离线消息待补投的push_key数
 * @property {import('./message_store.js')} store - 消息台账
 * @property {{total: number, queued: number, sent: number, delivered: number, expired: number, dropped: number, today_total: number, today_delivered: number}} messageStats - 台账统计
 * @property {function({retainDays?: number, maxPerKey?: number}): {expired: number, trimmed: number}} applyRetention - 应用保留策略
 */

/**
 * 创建PushMe代理对象
 * @param {import('./pushme_server.js')} pushme - PushMe实例
 * @returns {PushmeProxyInstance} PushMe代理对象
 */
function PushmeProxy(pushme) {
    const config = getConfig();
    let message_count = config.messageCount;
    /** @type {import('./pushme_panel.js')|null} */
    let panel = null;

    return {
        /**
         * 设置面板引用（由server.js调用）
         * @param {import('./pushme_panel.js')} panelRef - 面板实例
         */
        setPanel: (panelRef) => {
            panel = panelRef;
        },
        /** 启动服务 */
        start: () => {
            pushme.start();
        },
        /** 停止服务 */
        stop: async() => {
            await pushme.stop();
        },
        /** 重启服务 */
        restart: async() => {
            return await pushme.restart();
        },
        /**
         * 发布消息
         * @param {string} topic - 主题
         * @param {string|Object} msg - 消息内容
         * @param {number} [qos] - QoS级别
         * @returns {Promise<string>} 发布结果
         */
        publish: async(topic, msg, qos) => {
            const res = await pushme.publish(topic, msg, qos);
            res == 'success' && message_count++;
            return res;
        },
        /**
         * 原样重发一条已落库的消息
         * @description 直接复用台账里的 raw 报文，不重新序列化，避免时间戳/字段被改写
         * @param {string} topic - 主题（push_key）
         * @param {string} payload - 原始报文
         * @param {number} [qos] - QoS级别
         * @param {{title?: string, content?: string, type?: string}} [meta] - 台账展示字段
         * @returns {Promise<string>} 发布结果
         */
        publishRaw: async(topic, payload, qos, meta) => {
            const res = await pushme.publishRaw(topic, payload, qos, meta || {});
            res == 'success' && message_count++;
            return res;
        },
        /** 消息计数（以台账为准，避免内存计数与落库不一致） */
        get messageCount() {
            return pushme.messageStats.total;
        },
        /** 保存消息计数到文件 */
        messageCountSave: () => {
            config.messageCount = message_count;
        },
        /** 服务运行时长（秒） */
        get uptime() {
            return pushme.uptime;
        },
        /** 面板运行时长（秒） */
        get panelUptime() {
            return panel ? panel.uptime : 0;
        },
        /** 服务状态 */
        get status() {
            return pushme.status;
        },
        /** 客户端数量 */
        get clientCount() {
            return pushme.clientCount;
        },
        /** 连接数量 */
        get connectionCount() {
            return pushme.connectionCount;
        },
        /** 服务端口 */
        get serverPort() {
            return config.serverPort;
        },
        /** 面板端口 */
        get panelPort() {
            return config.panelPort;
        },
        /** 待补投的离线消息数 */
        get offlineCount() {
            return pushme.offlineCount;
        },
        /** 有离线消息待补投的push_key数 */
        get offlineKeyCount() {
            return pushme.offlineKeyCount;
        },
        /** 消息台账 */
        get store() {
            return pushme.store;
        },
        /** 台账统计 */
        get messageStats() {
            return pushme.messageStats;
        },
        /**
         * 应用新的消息保留策略（立即清理一次）
         * @param {{retainDays?: number, maxPerKey?: number}} [options]
         * @returns {ReturnType<import('./message_store.js')['setRetention']>}
         */
        applyRetention: (options) => pushme.applyRetention(options || {})
    }
}

module.exports = PushmeProxy;
