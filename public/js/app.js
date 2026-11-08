/**
 * PushMe 面板前端工具库
 * 零依赖：原生 DOM + fetch，无框架、无构建
 */
(function (global) {
    'use strict';

    /** @param {string} sel @param {Element|Document} [root] */
    const $ = (sel, root) => (root || document).querySelector(sel);
    /** @param {string} sel @param {Element|Document} [root] */
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    /** 转义 HTML */
    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * 统一请求：表单编码 POST，自动解析 JSON，纯文本按 jj.js 的 $show 语义当作成功消息
     * @param {string} url
     * @param {Record<string, any>} [data]
     * @returns {Promise<{state: number, msg: string, data: any}>}
     */
    async function api(url, data) {
        /** @type {URLSearchParams} */
        const body = new URLSearchParams();
        Object.keys(data || {}).forEach(key => {
            const value = data[key];
            if (value === undefined || value === null) return;
            body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        });
        const res = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body
        });
        const text = await res.text();
        try {
            const json = JSON.parse(text);
            if (json && typeof json === 'object') {
                return {state: json.state ? 1 : 0, msg: json.msg || '', data: json.data};
            }
        } catch (e) { /* 非 JSON：走纯文本分支 */ }
        return {state: 1, msg: text.trim(), data: null};
    }

    /** 提示条 */
    function toast(msg, type) {
        let box = $('.toasts');
        if (!box) {
            box = document.createElement('div');
            box.className = 'toasts';
            document.body.appendChild(box);
        }
        const el = document.createElement('div');
        el.className = 'toast' + (type ? ' ' + type : '');
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity .18s ease';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 200);
        }, 2600);
    }

    /**
     * 弹窗
     * @param {{title?: string, body?: string|Node, okText?: string, cancelText?: string, danger?: boolean, wide?: boolean}} opts
     * @returns {Promise<boolean>}
     */
    function dialog(opts) {
        return new Promise(resolve => {
            const mask = document.createElement('div');
            mask.className = 'mask';
            const modal = document.createElement('div');
            modal.className = 'modal';
            if (opts.wide) modal.style.maxWidth = '760px';
            modal.innerHTML =
                '<div class="modal-hd"><h3>' + escapeHtml(opts.title || '提示') + '</h3>' +
                '<button class="modal-close" type="button" aria-label="关闭">×</button></div>' +
                '<div class="modal-bd"></div>' +
                '<div class="modal-ft">' +
                (opts.cancelText === null ? '' : '<button class="btn" data-act="cancel" type="button">' + escapeHtml(opts.cancelText || '取消') + '</button>') +
                '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok" type="button">' + escapeHtml(opts.okText || '确定') + '</button>' +
                '</div>';
            const bd = $('.modal-bd', modal);
            if (opts.body instanceof Node) bd.appendChild(opts.body);
            else bd.innerHTML = opts.body || '';

            const close = value => {
                mask.remove();
                resolve(value);
            };
            $('.modal-close', modal).onclick = () => close(false);
            $('[data-act="cancel"]', modal) && ($('[data-act="cancel"]', modal).onclick = () => close(false));
            $('[data-act="ok"]', modal).onclick = () => close(true);
            mask.onclick = e => { if (e.target === mask) close(false); };
            mask.appendChild(modal);
            document.body.appendChild(mask);
            setTimeout(() => {
                const input = $('input, textarea', modal);
                input && input.focus();
            }, 30);
        });
    }

    /** 确认框 */
    const confirmBox = (msg, opts) => dialog(Object.assign({body: escapeHtml(msg).replace(/\n/g, '<br>')}, opts || {}));

    /**
     * 输入框
     * @param {{title?: string, value?: string, multiline?: boolean, placeholder?: string}} opts
     * @returns {Promise<string|null>}
     */
    function promptBox(opts) {
        return new Promise(resolve => {
            const mask = document.createElement('div');
            mask.className = 'mask';
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.style.maxWidth = '480px';
            modal.innerHTML =
                '<div class="modal-hd"><h3>' + escapeHtml(opts.title || '请输入') + '</h3>' +
                '<button class="modal-close" type="button">×</button></div>' +
                '<div class="modal-bd">' +
                (opts.multiline
                    ? '<textarea class="textarea" rows="4"></textarea>'
                    : '<input class="input" type="text">') +
                '</div>' +
                '<div class="modal-ft"><button class="btn" data-act="cancel" type="button">取消</button>' +
                '<button class="btn btn-primary" data-act="ok" type="button">确定</button></div>';
            const input = $('input, textarea', modal);
            input.value = opts.value || '';
            input.placeholder = opts.placeholder || '';
            const close = value => { mask.remove(); resolve(value); };
            $('.modal-close', modal).onclick = () => close(null);
            $('[data-act="cancel"]', modal).onclick = () => close(null);
            $('[data-act="ok"]', modal).onclick = () => close(input.value);
            mask.onclick = e => { if (e.target === mask) close(null); };
            modal.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !opts.multiline) close(input.value);
                if (e.key === 'Escape') close(null);
            });
            mask.appendChild(modal);
            document.body.appendChild(mask);
            setTimeout(() => input.focus(), 30);
        });
    }

    /** 时间格式化 */
    function fmtTime(ts) {
        if (!ts) return '';
        const d = new Date(Number(ts));
        const pad = n => (n < 10 ? '0' + n : '' + n);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /** 时长格式化 */
    function fmtDuration(seconds) {
        const total = Math.floor(Number(seconds) || 0);
        if (total <= 0) return '0 秒';
        const d = Math.floor(total / 86400);
        const h = Math.floor((total % 86400) / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const parts = [];
        if (d) parts.push(d + ' 天');
        if (h) parts.push(h + ' 小时');
        if (m) parts.push(m + ' 分');
        if (!d && !h && s) parts.push(s + ' 秒');
        return parts.join(' ') || '0 秒';
    }

    /** 复制到剪贴板 */
    async function copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            toast('已复制');
        } catch (e) {
            const input = document.createElement('textarea');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            input.remove();
            toast('已复制');
        }
    }

    /** 防抖 */
    function debounce(fn, wait) {
        let timer = null;
        return function () {
            const args = arguments;
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait || 250);
        };
    }

    /** 状态徽标样式 */
    function statusClass(status) {
        switch (Number(status)) {
            case 2: return 'badge-ok';
            case 1: return 'badge-info';
            case 0: return 'badge-warn';
            default: return 'badge-err';
        }
    }

    global.App = {
        $, $$, api, toast, dialog, confirm: confirmBox, prompt: promptBox,
        fmtTime, fmtDuration, copy, debounce, escapeHtml, statusClass
    };
    global.$ = $;
    global.$$ = $$;
})(window);
