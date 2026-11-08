const Base = require('./base.js');
const {getConfig} = require('../../lib/config.js');
const {STATUS_TEXT} = require('../../lib/message_store.js');

/**
 * 首页控制器
 * @description 处理消息推送请求和WEB首页展示
 * @extends Base
 */
class Index extends Base
{
    /**
     * 消息推送入口
     * @description 支持单key/多key推送，兼容飞书/企微/钉钉消息格式
     * @returns {Promise<import('jj.js/types').EXIT|void>}
     */
    async index() {
        // 跨域支持
        this.ctx.set('Access-Control-Allow-Origin', '*');
        this.ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        this.ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
        this.ctx.set('Access-Control-Max-Age', '86400'); // 预检请求缓存24小时

        // OPTIONS 预检请求直接返回
        if(this.$request.method() === 'OPTIONS') {
            return this.$show('');
        }

        let push_key = this.$request.query('push_key');
        let temp_key = this.$request.query('temp_key');
        let title = this.$request.query('title');
        let content = this.$request.query('content');
        let type = this.$request.query('type');

        // 如果没有 push_key，尝试通过 temp_key 查找
        if(!push_key && temp_key) {
            const config = getConfig();
            const foundKey = config.findKeyByTempKey(temp_key);
            if(foundKey) {
                push_key = foundKey;
            }
        }

        // 兼容企微、钉钉、飞书
        const third_data = this.$libs.third.data();
        if(third_data.title) {
            title = third_data.title;
        }
        if(third_data.content) {
            content = third_data.content;
        }
        if(third_data.type == 'markdown') {
            type = 'markdown';
        }

        // WEB首页或安装
        if(!push_key && !title && !content) {
            if(!this._isInstall()) {
                return this.$redirect('login/install');
            } else {
                this.$assign('cur_nav', '/');
                this._assignDashboard();
                return await this.$fetch();
            }
        }

        // push_key验证
        const error = this._check_keys(push_key);
        if(error) {
            return this.$show(error);
        }
        // title、content至少填写一项
        if(title === '' && content === '') {
            return this.$show('Push failed, empty title and content!');
        }
        if(typeof push_key == 'object' || typeof title == 'object' || typeof content == 'object') {
            return this.$show('Push failed, the parameter format is incorrect!');
        }

        /** @type {string|undefined} 自定义日期 */
        const date = this.$request.query('date', undefined);

        /** @type {{title: string, content: string, date: string|undefined, type: string}} */
        const msg = {title, content, date, type};

        let result = 'success';
        if(!~push_key.indexOf(',')) {
            result = await this.ctx.pushme.publish(push_key, msg);
        } else {
            // 多key：等待全部结果，避免"假成功"（原实现未 await，恒返回 success）
            const push_keys = push_key.split(',').filter(item => item);
            const results = await Promise.all(push_keys.map(item => this.ctx.pushme.publish(item, msg)));
            const failed = results.find(item => item != 'success' && item != 'queued');
            if(failed) {
                result = failed;
            } else {
                result = results.includes('queued') ? 'queued' : 'success';
            }
        }

        // 返回第三方格式
        if(third_data.title || third_data.content) {
            // success/queued 均表示已受理（queued 表示等客户端上线后补投）
            const state = result == 'success' || result == 'queued' ? 0 : 1;
            return this.$show({errcode: state, errmsg: result, code: state, msg: result});
        }

        this.$show(result);
    }

    /**
     * 首页仪表盘数据
     * @description 只有登录后才下发统计数据，未登录时首页只做落地页
     * @private
     */
    _assignDashboard() {
        const pushme = this.ctx.pushme;
        const logged = this._isLogin();
        this.$assign('dashboard_ready', logged);
        if(!logged) return;

        const stats = pushme.messageStats;
        this.$assign('stats', stats);
        this.$assign('today_rate', stats.today_total
            ? `${stats.today_delivered}/${stats.today_total}`
            : '0');
        this.$assign('today_rate_pct', stats.today_total
            ? Math.round(stats.today_delivered / stats.today_total * 100)
            : 0);
        this.$assign('service_status', pushme.status);
        this.$assign('client_count', pushme.clientCount);
        this.$assign('connection_count', pushme.connectionCount);
        this.$assign('offline_count', pushme.offlineCount);
        this.$assign('offline_key_count', pushme.offlineKeyCount);
        this.$assign('server_port', pushme.serverPort);
        this.$assign('panel_uptime', pushme.panelUptime);
        this.$assign('pushme_uptime', pushme.uptime);
        this.$assign('retain_days', getConfig().messages.retain_days);
        this.$assign('max_per_key', getConfig().messages.max_per_key);
        this.$assign('retain_text', getConfig().messages.retain_days
            ? `${getConfig().messages.retain_days} 天`
            : '不按时间清理');
        this.$assign('quota_text', getConfig().messages.max_per_key
            ? `每 key ${getConfig().messages.max_per_key} 条`
            : '不限条数');

        const recent = pushme.store.list({page: 1, size: 6});
        this.$assign('recent_rows', recent.rows.map(row => ({
            id: row.id,
            push_key: row.push_key,
            title: row.title || '(无标题)',
            status: row.status,
            status_text: STATUS_TEXT[row.status] || '未知',
            created_at: this._fmtTime(row.created_at)
        })));
    }

    /**
     * 时间格式化
     * @private
     * @param {number|null} ts
     * @returns {string}
     */
    _fmtTime(ts) {
        if(!ts) return '-';
        const d = new Date(Number(ts));
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /**
     * 批量校验push_key列表
     * @param {string} [push_key=""] - 逗号分隔的push_key字符串
     * @returns {string} 错误信息，空字符串表示通过
     */
    _check_keys(push_key = "") {
        if(!push_key) {
            return "Push failed, empty push_key!";
        }

        if(typeof push_key != 'string') {
            return "Push failed, push_key type must be string!";
        }
        
        if(!~push_key.indexOf(',')) {
            return this._check_key(push_key);
        }

        const push_keys = push_key.split(',');
        if(push_keys.length > 100) {
            return "Push failed, push_key numbers must be less than 100!";
        }
        let error = "";
        for(let i = 0; i < push_keys.length; i++) {
            error = this._check_key(push_keys[i]);
            if(error) {
                break;
            }
        }
        return error;
    }

    /**
     * 校验单个push_key是否合法
     * @param {string} [push_key=''] - 待校验的push_key
     * @returns {string} 错误信息，空字符串或undefined表示通过
     */
    _check_key(push_key = '') {
        if(!push_key) {
            return '';
        }

        const config = getConfig();
        if(!config.pushKeys.includes(push_key)) {
            this.$logger.error(`非法push_key ${push_key}`);
            return '非法push_key!';
        }
        return '';
    }
}

module.exports = Index;
