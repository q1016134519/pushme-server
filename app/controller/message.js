const Admin = require('./admin.js');
const {getConfig} = require('../../lib/config.js');
const {STATUS_TEXT} = require('../../lib/message_store.js');

/**
 * 时间格式化
 * @param {number|null} ts
 * @returns {string}
 */
function fmtTime(ts) {
    if(!ts) return '';
    const d = new Date(Number(ts));
    const pad = (/** @type {number} */ n) => (n < 10 ? '0' + n : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * CSV 字段转义
 * @param {any} value
 * @returns {string}
 */
function csvCell(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return '"' + str.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}

/**
 * 判断确认方是不是脚本客户端
 * @description 部署验收脚本（remote_check.js）用的连接 id 以 probe- 开头，
 * 它同样会回 PUBACK，台账会如实记成"已送达"。界面上必须能和真机区分开，
 * 否则"面板全绿、手机没响"看起来就像 bug。
 * @param {string} clientId
 * @returns {boolean}
 */
function isScriptClient(clientId) {
    return /^(probe|cdp|test)-/i.test(String(clientId || ''));
}

/**
 * 解析送达确认方
 * @param {string|null} raw - delivered_to（逗号分隔的 clientId）
 * @returns {{by: string, count: number, script: boolean}} by 首个确认方（就是它把状态推到已送达的）
 */
function parseConfirmers(raw) {
    const list = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
        by: list.length ? list[0] : '',
        count: list.length,
        script: list.length > 0 && isScriptClient(list[0])
    };
}

/**
 * 消息管理控制器
 * @description 消息台账的查询、详情、重发、删除、导出
 * @extends Admin
 */
class Message extends Admin
{
    /** 初始化，设置当前导航 */
    async _init() {
        const res = await super._init();
        if(res === '__EXIT__') {
            return '__EXIT__';
        }
        this.$assign('cur_nav', 'message');
    }

    /**
     * 消息台账页面
     * @returns {Promise<void>}
     */
    async index() {
        const config = getConfig();
        this.$assign('push_keys_json', JSON.stringify(config.pushKeysWithNotes));
        this.$assign('retain_days', config.messages.retain_days);
        this.$assign('max_per_key', config.messages.max_per_key);
        this.$assign('stats', JSON.stringify(this.ctx.pushme.messageStats));
        return await this.$fetch();
    }

    /**
     * 列表查询
     * @returns {Promise<void>}
     */
    async list() {
        const query = {
            key: this.$request.query('key', ''),
            status: this.$request.query('status', ''),
            keyword: this.$request.query('keyword', ''),
            page: this.$request.query('page', 1),
            size: this.$request.query('size', 20)
        };
        const result = this.ctx.pushme.store.list(query);
        this.$success({
            total: result.total,
            page: result.page,
            size: result.size,
            rows: result.rows.map(row => {
                const confirmer = parseConfirmers(row.delivered_to);
                return {
                    id: row.id,
                    push_key: row.push_key,
                    title: row.title || '',
                    content: row.content || '',
                    type: row.type || '',
                    status: row.status,
                    status_text: STATUS_TEXT[row.status] || '未知',
                    created_at: row.created_at,
                    created_text: fmtTime(row.created_at),
                    delivered_at: row.delivered_at,
                    delivered_text: fmtTime(row.delivered_at),
                    delivered_to: row.delivered_to || '',
                    confirmed_by: confirmer.by,
                    confirmed_count: confirmer.count,
                    confirmed_script: confirmer.script,
                    attempts: row.attempts,
                    error: row.error || ''
                };
            }),
            stats: this.ctx.pushme.messageStats
        });
    }

    /**
     * 消息详情
     * @returns {Promise<void>}
     */
    async detail() {
        const id = parseInt(String(this.$request.query('id', 0)), 10);
        const row = this.ctx.pushme.store.get(id);
        if(!row) {
            return this.$error('消息不存在或已清理');
        }
        const confirmer = parseConfirmers(row.delivered_to);
        this.$success({
            ...row,
            status_text: STATUS_TEXT[row.status] || '未知',
            created_text: fmtTime(row.created_at),
            delivered_text: fmtTime(row.delivered_at),
            confirmed_by: confirmer.by,
            confirmed_count: confirmer.count,
            confirmed_script: confirmer.script
        });
    }

    /**
     * 重发一条消息
     * @description 原样重发（不重新序列化），并生成新的台账记录
     * @returns {Promise<void>}
     */
    async resend() {
        const id = parseInt(String(this.$request.query('id', 0)), 10);
        const row = this.ctx.pushme.store.get(id);
        if(!row) {
            return this.$error('消息不存在或已清理');
        }
        const result = await this.ctx.pushme.publishRaw(row.push_key, row.raw, row.qos, {
            title: row.title || undefined,
            content: row.content || undefined,
            type: row.type || undefined
        });
        if(result === 'success') {
            return this.$success('已重新投递');
        }
        if(result === 'queued') {
            return this.$success('当前无在线客户端，已入队等待补投');
        }
        return this.$error('重发失败：' + result);
    }

    /**
     * 删除一条消息
     * @returns {Promise<void>}
     */
    async remove() {
        const id = parseInt(String(this.$request.query('id', 0)), 10);
        if(!this.ctx.pushme.store.remove(id)) {
            return this.$error('删除失败，记录可能已不存在');
        }
        this.$success('已删除');
    }

    /**
     * 批量清空（按 key / 状态）
     * @returns {Promise<void>}
     */
    async clear() {
        const count = this.ctx.pushme.store.clear({
            key: this.$request.query('key', ''),
            status: this.$request.query('status', '')
        });
        this.$success(`已清理 ${count} 条`);
    }

    /**
     * 统计
     * @returns {Promise<void>}
     */
    async stats() {
        this.$success(this.ctx.pushme.messageStats);
    }

    /**
     * 导出 CSV
     * @returns {Promise<void>}
     */
    async export() {
        const result = this.ctx.pushme.store.list({
            key: this.$request.query('key', ''),
            status: this.$request.query('status', ''),
            keyword: this.$request.query('keyword', ''),
            page: 1,
            size: 200
        });
        // 超过单页上限时循环补齐，最多 5000 行
        let rows = result.rows;
        const total = Math.min(result.total, 5000);
        let page = 1;
        while(rows.length < total) {
            page++;
            const next = this.ctx.pushme.store.list({
                key: this.$request.query('key', ''),
                status: this.$request.query('status', ''),
                keyword: this.$request.query('keyword', ''),
                page,
                size: 200
            }).rows;
            if(!next.length) break;
            rows = rows.concat(next);
        }

        const header = ['时间', 'push_key', '标题', '内容', '类型', '状态', '送达时间', '送达客户端', '尝试次数', '错误'];
        const lines = [header.map(csvCell).join(',')];
        for(const row of rows) {
            lines.push([
                fmtTime(row.created_at),
                row.push_key,
                row.title,
                row.content,
                row.type,
                STATUS_TEXT[row.status] || row.status,
                fmtTime(row.delivered_at),
                row.delivered_to,
                row.attempts,
                row.error
            ].map(csvCell).join(','));
        }

        const filename = `pushme-messages-${new Date().toISOString().slice(0, 10)}.csv`;
        this.ctx.set({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-cache'
        });
        // BOM 让 Excel 正确识别 UTF-8
        this.$show('\ufeff' + lines.join('\r\n'));
    }
}

module.exports = Message;
