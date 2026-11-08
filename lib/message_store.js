const fs = require('fs');
const path = require('path');
const {Logger} = require('jj.js');

/**
 * @typedef {Object} MessageRow
 * @property {number} id - 自增主键
 * @property {string} push_key - 推送key（MQTT topic）
 * @property {string|null} title - 消息标题
 * @property {string|null} content - 消息内容
 * @property {string|null} type - 消息类型
 * @property {string} raw - 原始 payload（补投时原样重发）
 * @property {number} qos - QoS级别
 * @property {number} status - 状态：0 queued / 1 sent / 2 delivered / 3 expired / 4 dropped
 * @property {number} created_at - 受理时间（毫秒）
 * @property {number|null} sent_at - 最近一次下发给客户端的时间（毫秒），PUBACK 超时判定的依据
 * @property {number|null} delivered_at - 送达时间（毫秒），只写一次，重复 PUBACK 不刷新
 * @property {string|null} delivered_to - 确认收到的 clientId 列表（逗号分隔，仅审计用，不参与送达判定）
 * @property {number} attempts - 投递尝试次数
 * @property {string|null} error - 最后一次失败原因
 */

/**
 * 消息状态
 * @readonly
 * @enum {number}
 */
const STATUS = {
    /** 未送达（无人在线，等待补投） */
    QUEUED: 0,
    /** 已下发，未收到 PUBACK 确认 */
    SENT: 1,
    /** 已送达（收到客户端 PUBACK） */
    DELIVERED: 2,
    /** 已过期（超出保留天数被清理） */
    EXPIRED: 3,
    /** 已丢弃（补投次数超限 / 主动放弃） */
    DROPPED: 4
};

/** 状态中文名 */
const STATUS_TEXT = {
    [STATUS.QUEUED]: '未送达',
    [STATUS.SENT]: '已下发',
    [STATUS.DELIVERED]: '已送达',
    [STATUS.EXPIRED]: '已过期',
    [STATUS.DROPPED]: '已丢弃'
};

/** 单条消息最多补投次数，超过判定丢弃，避免坏客户端把队列卡死 */
const MAX_ATTEMPTS = 20;

/**
 * 消息台账
 * @description 基于 Node 内置 node:sqlite（Node >= 22.13），零外部依赖。
 * 承担两件事：① 离线补投的持久化队列；② 管理端的消息台账（谁、什么时候、送到没送到）。
 * 送达判定只认客户端 PUBACK，不认"broker 处理完了"。
 */
class MessageStore {
    /**
     * @param {{file?: string, retainDays?: number, maxPerKey?: number, importFile?: string}} [options={}]
     */
    constructor(options = {}) {
        /** @type {string} 数据库文件路径 */
        this.file = options.file || path.join(__dirname, '..', 'config', 'messages.db');
        /** @type {number} 消息保留天数，0 表示不按时间清理 */
        this.retainDays = this._normalize(options.retainDays, 7);
        /** @type {number} 每个 push_key 最多保留条数，0 表示不按条数清理 */
        this.maxPerKey = this._normalize(options.maxPerKey, 500);
        /** @type {import('node:sqlite').DatabaseSync|null} */
        this._db = null;
        /** @type {Map<string, import('node:sqlite').StatementSync>} */
        this._stmts = new Map();
        /** @type {NodeJS.Timeout|null} */
        this._timer = null;
        /** @type {boolean} */
        this.available = false;

        this._open();
        if(options.importFile) {
            this._importLegacy(options.importFile);
        }
        this.prune();
        this._startPruneTimer();
    }

    /**
     * 归一化保留参数
     * @description 只接受 >= 0 的整数，0 表示不限制；非法值回落到默认值
     * @private
     * @param {any} value
     * @param {number} fallback
     * @returns {number}
     */
    _normalize(value, fallback) {
        if(value === undefined || value === null || value === '') return fallback;
        const n = parseInt(String(value), 10);
        if(isNaN(n) || n < 0) return fallback;
        return n;
    }

    /**
     * 动态调整保留策略并立即清理一次（无需重启）
     * @param {{retainDays?: number, maxPerKey?: number}} [options={}]
     * @returns {{expired: number, trimmed: number, retainDays: number, maxPerKey: number}}
     */
    setRetention(options = {}) {
        if(options.retainDays !== undefined) {
            this.retainDays = this._normalize(options.retainDays, this.retainDays);
        }
        if(options.maxPerKey !== undefined) {
            this.maxPerKey = this._normalize(options.maxPerKey, this.maxPerKey);
        }
        const res = this.prune();
        Logger.system(`[store] retention: ${this.retainDays || '∞'} 天 / ${this.maxPerKey || '∞'} 条每 key`);
        return {expired: res.expired, trimmed: res.trimmed, retainDays: this.retainDays, maxPerKey: this.maxPerKey};
    }

    /**
     * 打开数据库并建表
     * @private
     */
    _open() {
        let DatabaseSync;
        try {
            ({DatabaseSync} = require('node:sqlite'));
        } catch(/** @type {any} */ err) {
            Logger.error('[store] node:sqlite unavailable, need Node >= 22.13:', err.message);
            return;
        }

        try {
            fs.mkdirSync(path.dirname(this.file), {recursive: true});
            this._db = new DatabaseSync(this.file);
            this._db.exec(`
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA busy_timeout = 3000;
                PRAGMA foreign_keys = ON;
            `);
            this._db.exec(`
                CREATE TABLE IF NOT EXISTS messages (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    push_key     TEXT    NOT NULL,
                    title        TEXT,
                    content      TEXT,
                    type         TEXT,
                    raw          TEXT    NOT NULL,
                    qos          INTEGER NOT NULL DEFAULT 1,
                    status       INTEGER NOT NULL DEFAULT 0,
                    created_at   INTEGER NOT NULL,
                    sent_at      INTEGER,
                    delivered_at INTEGER,
                    delivered_to TEXT,
                    attempts     INTEGER NOT NULL DEFAULT 0,
                    error        TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, id);
                CREATE INDEX IF NOT EXISTS idx_messages_key    ON messages(push_key, id DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_time   ON messages(created_at);
            `);
            this._migrate();
            this.available = true;
            Logger.system(`[store] message store ready: ${this.file}`);
        } catch(/** @type {any} */ err) {
            Logger.error('[store] open failed:', err.message);
            this._db = null;
        }
    }

    /**
     * 老库补列（v3.3 之前没有 sent_at）
     * @description CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
     * 而"已下发多久没确认"必须有个时间基准，否则 PUBACK 超时回收无从判断。
     * @private
     */
    _migrate() {
        try {
            const cols = /** @type {any[]} */ (this._db.prepare('PRAGMA table_info(messages)').all())
                .map(r => String(r.name));
            if(!cols.includes('sent_at')) {
                this._db.exec('ALTER TABLE messages ADD COLUMN sent_at INTEGER');
                Logger.system('[store] migrated: messages.sent_at added');
            }
        } catch(/** @type {any} */ err) {
            Logger.error('[store] migrate failed:', err.message);
        }
    }

    /**
     * 预编译语句缓存
     * @private
     * @param {string} sql
     * @returns {import('node:sqlite').StatementSync}
     */
    _p(sql) {
        let stmt = this._stmts.get(sql);
        if(!stmt) {
            if(!this._db) throw new Error('message store not available');
            stmt = this._db.prepare(sql);
            this._stmts.set(sql, stmt);
        }
        return stmt;
    }

    /**
     * 定时清理（10 分钟一次）
     * @private
     */
    _startPruneTimer() {
        this._timer = setInterval(() => this.prune(), 10 * 60 * 1000);
        // @ts-ignore Node 定时器
        this._timer.unref && this._timer.unref();
    }

    /**
     * 受理一条消息并落库
     * @param {{key: string, raw: string, title?: string, content?: string, type?: string, qos?: number, ts?: number}} msg
     * @returns {number} 消息id，落库失败返回 0
     */
    create(msg) {
        if(!this.available) return 0;
        try {
            const res = this._p(`
                INSERT INTO messages (push_key, title, content, type, raw, qos, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                msg.key,
                msg.title == null ? null : String(msg.title),
                msg.content == null ? null : String(msg.content),
                msg.type == null ? null : String(msg.type),
                msg.raw,
                Number(msg.qos) || 1,
                STATUS.QUEUED,
                Number(msg.ts) || Date.now()
            );
            if(res.changes && this.maxPerKey > 0) this._trimKey(msg.key);
            return Number(res.lastInsertRowid) || 0;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] create failed:', err.message);
            return 0;
        }
    }

    /**
     * 标记已下发（broker 已写出，尚未收到 PUBACK）
     * @description 同时写 sent_at，作为"多久没等到 PUBACK 就回收到队列"的计时起点。
     * 已送达的记录不回退，重复下发只累加次数。
     * @param {number} id
     * @returns {number} 实际更新的行数
     */
    markSent(id) {
        if(!this.available || !id) return 0;
        try {
            const res = this._p(`
                UPDATE messages
                   SET status = ?, attempts = attempts + 1, sent_at = ?
                 WHERE id = ? AND status < ?
            `).run(STATUS.SENT, Date.now(), id, STATUS.DELIVERED);
            return Number(res.changes) || 0;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] markSent failed:', err.message);
            return 0;
        }
    }

    /**
     * 标记已送达（只在收到客户端 PUBACK 时调用）
     * @description 幂等：只有 queued/sent 才会跃迁到 delivered，delivered_at 只写一次。
     * QoS1 的重复 PUBACK（DUP 重传）不会把送达时间往后推，否则台账里的延迟是假的。
     * delivered_to 仅作审计，记录所有确认过的客户端；"任一确认即送达"的判定只看 status。
     * @param {number} id
     * @param {string} [clientId]
     * @returns {{changed: boolean, before: number|null, after: number|null}} changed 表示本次是否发生状态跃迁
     */
    markDelivered(id, clientId = '') {
        if(!this.available || !id) return {changed: false, before: null, after: null};
        try {
            const row = /** @type {any} */ (this._p('SELECT status FROM messages WHERE id = ?').get(Number(id)));
            if(!row) return {changed: false, before: null, after: null};

            const before = Number(row.status);
            const canTransit = before === STATUS.QUEUED || before === STATUS.SENT;
            if(canTransit) {
                const now = Date.now();
                this._p(`
                    UPDATE messages
                       SET status = ?, delivered_at = ?, sent_at = COALESCE(sent_at, ?)
                     WHERE id = ?
                `).run(STATUS.DELIVERED, now, now, Number(id));
            }

            // delivered_to 去重追加：重复 PUBACK 不重复记，多客户端确认要能看出来
            if(clientId) {
                this._p(`
                    UPDATE messages
                       SET delivered_to = CASE
                           WHEN delivered_to IS NULL OR delivered_to = '' THEN ?
                           WHEN instr(',' || delivered_to || ',', ',' || ? || ',') > 0 THEN delivered_to
                           ELSE delivered_to || ',' || ?
                       END
                     WHERE id = ?
                `).run(clientId, clientId, clientId, Number(id));
            }

            return {changed: canTransit, before, after: canTransit ? STATUS.DELIVERED : before};
        } catch(/** @type {any} */ err) {
            Logger.error('[store] markDelivered failed:', err.message);
            return {changed: false, before: null, after: null};
        }
    }

    /**
     * 按 topic + 原始报文反查尚未送达的消息
     * @description 用于持久会话（clean session = false）场景：PUBACK 回调里能拿到原始报文，
     * 但发布时无法预测 broker 分配的报文标识。按投递顺序（id 升序）取最早那条，
     * 与补投的 FIFO 顺序一致。报文完全相同的多条消息无法区分，但内容等价。
     * @param {string} key - push_key
     * @param {string} raw - 原始 payload
     * @returns {number} 消息id，未命中返回 0
     */
    findPendingByRaw(key, raw) {
        if(!this.available || !key || !raw) return 0;
        try {
            const row = /** @type {any} */ (this._p(`
                SELECT id FROM messages
                 WHERE push_key = ? AND raw = ? AND status IN (?, ?)
                 ORDER BY id ASC LIMIT 1
            `).get(key, raw, STATUS.QUEUED, STATUS.SENT));
            return row ? Number(row.id) : 0;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] findPendingByRaw failed:', err.message);
            return 0;
        }
    }

    /**
     * 兜底标记送达
     * @description 用于"离线持久会话"场景：broker 会在客户端重连时才分配报文标识，
     * 发布前无法预测，只能拿 PUBACK 回调里带回的原始报文（topic + payload）反查。
     * @param {string} key - push_key
     * @param {string} raw - 原始 payload
     * @param {string} clientId - 确认的客户端
     * @returns {boolean} 是否命中
     */
    markDeliveredByRaw(key, raw, clientId) {
        const id = this.findPendingByRaw(key, raw);
        if(!id) return false;
        return this.markDelivered(id, clientId).changed;
    }

    /**
     * 回收"已下发但等不到 PUBACK"的消息
     * @description 客户端在 ACK 前一刻掉线时，消息会永久停在 sent。
     * 超过窗口没收到确认就退回 queued，等下次上线补投——宁可重复一次，也不能静默丢失。
     * @param {number} [maxAgeMs=30000] - 等待窗口（毫秒）
     * @returns {{count: number, ids: number[]}} 回收条数与消息id
     */
    revertStale(maxAgeMs = 30000) {
        if(!this.available) return {count: 0, ids: []};
        try {
            const cutoff = Date.now() - Math.max(1000, Number(maxAgeMs) || 30000);
            const rows = /** @type {any[]} */ (this._p(`
                SELECT id FROM messages
                 WHERE status = ?
                   AND ((sent_at IS NOT NULL AND sent_at < ?)
                     OR (sent_at IS NULL     AND created_at < ?))
            `).all(STATUS.SENT, cutoff, cutoff));
            if(!rows.length) return {count: 0, ids: []};

            const ids = rows.map(r => Number(r.id));
            this._p(`
                UPDATE messages
                   SET status = ?, error = ?
                 WHERE status = ? AND id IN (${ids.map(() => '?').join(',')})
            `).run(STATUS.QUEUED, 'puback timeout', STATUS.SENT, ...ids);
            return {count: ids.length, ids};
        } catch(/** @type {any} */ err) {
            Logger.error('[store] revertStale failed:', err.message);
            return {count: 0, ids: []};
        }
    }

    /**
     * 放回待投递（补投中断 / 投递失败）
     * @param {number} id
     * @param {string} [error]
     */
    requeue(id, error) {
        if(!this.available || !id) return;
        try {
            const row = /** @type {any} */ (this._p('SELECT attempts FROM messages WHERE id = ?').get(id));
            const attempts = row ? Number(row.attempts) : 0;
            if(attempts >= MAX_ATTEMPTS) {
                this._p('UPDATE messages SET status = ?, error = ?, attempts = ? WHERE id = ?')
                    .run(STATUS.DROPPED, String(error || 'too many attempts').slice(0, 200), attempts, id);
                return;
            }
            this._p('UPDATE messages SET status = ?, error = ? WHERE id = ? AND status < ?')
                .run(STATUS.QUEUED, error ? String(error).slice(0, 200) : null, id, STATUS.DELIVERED);
        } catch(/** @type {any} */ err) {
            Logger.error('[store] requeue failed:', err.message);
        }
    }

    /**
     * 丢弃一条消息
     * @param {number} id
     * @param {string} [reason]
     */
    drop(id, reason) {
        if(!this.available || !id) return;
        try {
            this._p('UPDATE messages SET status = ?, error = ? WHERE id = ? AND status < ?')
                .run(STATUS.DROPPED, String(reason || '').slice(0, 200), id, STATUS.DELIVERED);
        } catch(/** @type {any} */ err) {
            Logger.error('[store] drop failed:', err.message);
        }
    }

    /**
     * 取出某个 key 待补投的消息（未送达 + 已下发未确认）
     * @param {string} key
     * @param {number} [limit=200]
     * @returns {MessageRow[]}
     */
    pending(key, limit = 200) {
        if(!this.available) return [];
        try {
            return /** @type {MessageRow[]} */ (this._p(`
                SELECT * FROM messages
                 WHERE push_key = ? AND status IN (?, ?) AND attempts < ?
                 ORDER BY id ASC
                 LIMIT ?
            `).all(key, STATUS.QUEUED, STATUS.SENT, MAX_ATTEMPTS, limit));
        } catch(/** @type {any} */ err) {
            Logger.error('[store] pending failed:', err.message);
            return [];
        }
    }

    /**
     * 待送达条数
     * @param {string} [key]
     * @returns {number}
     */
    pendingCount(key) {
        if(!this.available) return 0;
        try {
            const row = key
                ? /** @type {any} */ (this._p('SELECT COUNT(*) AS c FROM messages WHERE push_key = ? AND status IN (?, ?)').get(key, STATUS.QUEUED, STATUS.SENT))
                : /** @type {any} */ (this._p('SELECT COUNT(*) AS c FROM messages WHERE status IN (?, ?)').get(STATUS.QUEUED, STATUS.SENT));
            return row ? Number(row.c) : 0;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] pendingCount failed:', err.message);
            return 0;
        }
    }

    /**
     * 有未送达消息的 key 数量
     * @returns {number}
     */
    get pendingKeyCount() {
        if(!this.available) return 0;
        try {
            const row = /** @type {any} */ (this._p('SELECT COUNT(DISTINCT push_key) AS c FROM messages WHERE status IN (?, ?)').get(STATUS.QUEUED, STATUS.SENT));
            return row ? Number(row.c) : 0;
        } catch(/** @type {any} */ err) {
            return 0;
        }
    }

    /**
     * 分页查询
     * @param {{key?: string, status?: number|string, keyword?: string, page?: number, size?: number}} [query={}]
     * @returns {{total: number, rows: MessageRow[], page: number, size: number}}
     */
    list(query = {}) {
        const page = Math.max(1, parseInt(String(query.page), 10) || 1);
        const size = Math.min(200, Math.max(1, parseInt(String(query.size), 10) || 20));
        if(!this.available) return {total: 0, rows: [], page, size};

        /** @type {string[]} */
        const where = [];
        /** @type {any[]} */
        const args = [];
        if(query.key) {
            where.push('push_key = ?');
            args.push(String(query.key));
        }
        if(query.status !== '' && query.status !== undefined && query.status !== null) {
            where.push('status = ?');
            args.push(Number(query.status));
        }
        if(query.keyword) {
            where.push('(title LIKE ? OR content LIKE ?)');
            const like = '%' + String(query.keyword).slice(0, 50) + '%';
            args.push(like, like);
        }
        const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';

        try {
            const totalRow = /** @type {any} */ (this._p(`SELECT COUNT(*) AS c FROM messages${clause}`).get(...args));
            const total = totalRow ? Number(totalRow.c) : 0;
            const rows = /** @type {MessageRow[]} */ (this._p(
                `SELECT * FROM messages${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
            ).all(...args, size, (page - 1) * size));
            return {total, rows, page, size};
        } catch(/** @type {any} */ err) {
            Logger.error('[store] list failed:', err.message);
            return {total: 0, rows: [], page, size};
        }
    }

    /**
     * 单条详情
     * @param {number} id
     * @returns {MessageRow|null}
     */
    get(id) {
        if(!this.available) return null;
        try {
            return /** @type {MessageRow|null} */ (this._p('SELECT * FROM messages WHERE id = ?').get(Number(id)) || null);
        } catch(/** @type {any} */ err) {
            return null;
        }
    }

    /**
     * 删除单条
     * @param {number} id
     * @returns {boolean}
     */
    remove(id) {
        if(!this.available) return false;
        try {
            const res = this._p('DELETE FROM messages WHERE id = ?').run(Number(id));
            return !!res.changes;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] remove failed:', err.message);
            return false;
        }
    }

    /**
     * 按条件清空
     * @param {{key?: string, status?: number|string}} [filter={}]
     * @returns {number} 删除条数
     */
    clear(filter = {}) {
        if(!this.available) return 0;
        /** @type {string[]} */
        const where = [];
        /** @type {any[]} */
        const args = [];
        if(filter.key) {
            where.push('push_key = ?');
            args.push(String(filter.key));
        }
        if(filter.status !== '' && filter.status !== undefined && filter.status !== null) {
            where.push('status = ?');
            args.push(Number(filter.status));
        }
        try {
            const res = this._p(`DELETE FROM messages${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).run(...args);
            return Number(res.changes) || 0;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] clear failed:', err.message);
            return 0;
        }
    }

    /**
     * 状态统计
     * @returns {{total: number, queued: number, sent: number, delivered: number, expired: number, dropped: number, today_total: number, today_delivered: number}}
     */
    stats() {
        /** @type {any} */
        const empty = {total: 0, queued: 0, sent: 0, delivered: 0, expired: 0, dropped: 0, today_total: 0, today_delivered: 0};
        if(!this.available) return empty;
        try {
            /** @type {Record<string, number>} */
            const by = {};
            let total = 0;
            for(const row of /** @type {any[]} */ (this._p('SELECT status, COUNT(*) AS c FROM messages GROUP BY status').all())) {
                by[String(row.status)] = Number(row.c);
                total += Number(row.c);
            }
            const dayStart = new Date().setHours(0, 0, 0, 0);
            const todayTotal = /** @type {any} */ (this._p('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?').get(dayStart));
            const todayDelivered = /** @type {any} */ (this._p('SELECT COUNT(*) AS c FROM messages WHERE status = ? AND delivered_at >= ?').get(STATUS.DELIVERED, dayStart));
            return {
                total,
                queued: by[STATUS.QUEUED] || 0,
                sent: by[STATUS.SENT] || 0,
                delivered: by[STATUS.DELIVERED] || 0,
                expired: by[STATUS.EXPIRED] || 0,
                dropped: by[STATUS.DROPPED] || 0,
                today_total: todayTotal ? Number(todayTotal.c) : 0,
                today_delivered: todayDelivered ? Number(todayDelivered.c) : 0
            };
        } catch(/** @type {any} */ err) {
            Logger.error('[store] stats failed:', err.message);
            return empty;
        }
    }

    /**
     * 清理过期数据 + 单 key 条数上限
     * @returns {{expired: number, trimmed: number}}
     */
    prune() {
        if(!this.available) return {expired: 0, trimmed: 0};
        try {
            let expired = 0;
            let trimmed = 0;
            // 保留天数为 0 表示不按时间清理
            if(this.retainDays > 0) {
                const cutoff = Date.now() - this.retainDays * 24 * 3600 * 1000;
                expired = Number(this._p('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes) || 0;
            }
            // 每 key 条数为 0 表示不按条数清理
            if(this.maxPerKey > 0) {
                for(const row of /** @type {any[]} */ (this._p('SELECT DISTINCT push_key FROM messages').all())) {
                    trimmed += this._trimKey(String(row.push_key));
                }
            }
            if(expired || trimmed) {
                Logger.system(`[store] pruned ${expired} expired, ${trimmed} over-quota`);
            }
            return {expired, trimmed};
        } catch(/** @type {any} */ err) {
            Logger.error('[store] prune failed:', err.message);
            return {expired: 0, trimmed: 0};
        }
    }

    /**
     * 单个 key 超上限时删最旧的
     * @private
     * @param {string} key
     * @returns {number} 删除条数
     */
    _trimKey(key) {
        try {
            const res = this._p(`
                DELETE FROM messages
                 WHERE push_key = ?
                   AND id IN (
                       SELECT id FROM messages WHERE push_key = ? ORDER BY id DESC LIMIT -1 OFFSET ?
                   )
            `).run(key, key, this.maxPerKey);
            return Number(res.changes) || 0;
        } catch(/** @type {any} */ err) {
            Logger.error('[store] trim failed:', err.message);
            return 0;
        }
    }

    /**
     * 导入旧版 offline.json（v1 遗留队列）
     * @private
     * @param {string} file
     */
    _importLegacy(file) {
        try {
            if(!fs.existsSync(file) || !this.available) return;
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const queues = (data && data.queues) || {};
            let count = 0;
            for(const key of Object.keys(queues)) {
                for(const item of queues[key] || []) {
                    if(!item || typeof item.payload !== 'string') continue;
                    this.create({key, raw: item.payload, qos: item.qos || 1, ts: item.ts || Date.now()});
                    count++;
                }
            }
            if(count) {
                Logger.system(`[store] imported ${count} message(s) from ${path.basename(file)}`);
                fs.renameSync(file, file + '.bak');
            }
        } catch(/** @type {any} */ err) {
            Logger.error('[store] import legacy failed:', err.message);
        }
    }

    /** 关闭数据库 */
    close() {
        if(this._timer) clearInterval(this._timer);
        this._timer = null;
        this._stmts.clear();
        if(this._db) {
            try { this._db.close(); } catch(e) { /* ignore */ }
        }
        this._db = null;
        this.available = false;
    }
}

module.exports = MessageStore;
module.exports.STATUS = STATUS;
module.exports.STATUS_TEXT = STATUS_TEXT;
