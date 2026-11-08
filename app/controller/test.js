const Base = require('./base.js');

/**
 * 在线测试控制器
 * @description 把推送测试面板从首页拆出来的独立页面。
 * 表单仍然 POST 到 `/`（公开推送接口），这里只负责渲染页面和展示客户端在线情况。
 * @extends Base
 */
class Test extends Base
{
    /** 初始化，设置当前导航 */
    _init() {
        super._init();
        this.$assign('cur_nav', 'test');
    }

    /**
     * 在线测试页面
     * @returns {Promise<import('jj.js/types').EXIT|void>}
     */
    async index() {
        if(!this._isInstall()) {
            return this.$redirect('login/install');
        }

        // 在线状态属于管理端信息，未登录只渲染表单
        const logged = this._isLogin();
        const pushme = this.ctx.pushme;
        this.$assign('server_port', pushme.serverPort);
        this.$assign('status_ready', logged);
        if(logged) {
            this.$assign('service_status', pushme.status);
            this.$assign('client_count', pushme.clientCount);
            this.$assign('connection_count', pushme.connectionCount);
            this.$assign('offline_count', pushme.offlineCount);
        }

        return await this.$fetch();
    }
}

module.exports = Test;
