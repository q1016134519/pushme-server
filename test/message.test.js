/**
 * 消息台账测试
 * 覆盖：状态机（未送达 → 已下发 → 已送达）、PUBACK 严格判定、过滤分页、配额与过期清理、旧版队列导入、面板渲染
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MessageStore = require('../lib/message_store.js');
const { STATUS } = MessageStore;
const { startServer, MqttClient } = require('./helpers.js');

/** 临时目录 */
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pushme-store-'));
}

/**
 * 面板登录（走安装流程创建管理员，拿到 cookie）
 * @param {{panelPort: number}} srv
 */
async function panelLogin(srv) {
    const res = await fetch(`http://127.0.0.1:${srv.panelPort}/login/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user: 'admin', password: 'admin123' }).toString()
    });
    await res.text();
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')];
    const cookie = (raw || []).filter(Boolean).map(c => c.split(';')[0]).join('; ');
    assert.ok(cookie, '登录后应拿到 cookie');
    return cookie;
}

/** 面板接口调用 */
async function panel(srv, cookie, url, data) {
    const res = await fetch(`http://127.0.0.1:${srv.panelPort}${url}`, {
        method: 'POST',
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookie
        },
        body: new URLSearchParams(data || {}).toString()
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        return { state: 0, msg: text, raw: text, status: res.status };
    }
}

/** 轮询台账直到满足条件 */
async function waitLedger(srv, cookie, query, check, timeout = 6000) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await panel(srv, cookie, '/message/list', query);
        const rows = (last.data && last.data.rows) || [];
        const hit = rows.find(check);
        if (hit) return hit;
        await new Promise(r => setTimeout(r, 120));
    }
    assert.fail('台账未在超时内到达预期状态，最后结果：' + JSON.stringify(last && last.data && last.data.rows));
}

/* ============================ 台账单元测试 ============================ */

test('状态机：create → markSent → markDelivered，delivered_to 去重', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db') });
    try {
        assert.ok(store.available, 'SQLite 应可用');

        const id = store.create({ key: 'k1', raw: '{"title":"t1"}', title: 't1', content: 'c1', type: 'text' });
        assert.ok(id > 0);

        let row = store.get(id);
        assert.strictEqual(row.status, STATUS.QUEUED);
        assert.strictEqual(row.push_key, 'k1');
        assert.strictEqual(row.delivered_at, null);

        store.markSent(id);
        row = store.get(id);
        assert.strictEqual(row.status, STATUS.SENT);
        assert.strictEqual(row.attempts, 1);

        store.markDelivered(id, 'phone-1');
        row = store.get(id);
        assert.strictEqual(row.status, STATUS.DELIVERED);
        assert.ok(row.delivered_at > 0);
        assert.strictEqual(row.delivered_to, 'phone-1');

        // 同一客户端重复确认不应重复追加
        store.markDelivered(id, 'phone-1');
        assert.strictEqual(store.get(id).delivered_to, 'phone-1');

        // 第二个客户端确认 → 追加
        store.markDelivered(id, 'phone-2');
        assert.strictEqual(store.get(id).delivered_to, 'phone-1,phone-2');

        // 已送达的记录不再回到待投递
        store.requeue(id, 'x');
        assert.strictEqual(store.get(id).status, STATUS.DELIVERED);
        assert.deepStrictEqual(store.pending('k1'), []);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('兜底送达：持久会话下用 topic + raw 反查', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db') });
    try {
        const id = store.create({ key: 'k1', raw: 'RAW-A' });
        assert.strictEqual(store.markDeliveredByRaw('k1', 'RAW-A', 'persist-1'), true);
        assert.strictEqual(store.get(id).status, STATUS.DELIVERED);
        assert.strictEqual(store.get(id).delivered_to, 'persist-1');

        // 已经送达的不会再被反查命中
        assert.strictEqual(store.markDeliveredByRaw('k1', 'RAW-A', 'other'), false);
        // 不存在的报文
        assert.strictEqual(store.markDeliveredByRaw('k1', 'RAW-NONE', 'x'), false);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('送达幂等：重复 PUBACK 不刷新 delivered_at，只做去重追加', async () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db') });
    try {
        const id = store.create({ key: 'k1', raw: 'RAW-DUP' });
        store.markSent(id);

        const first = store.markDelivered(id, 'phone-1');
        assert.strictEqual(first.changed, true);
        assert.strictEqual(first.before, STATUS.SENT);
        assert.strictEqual(first.after, STATUS.DELIVERED);
        const stamp = store.get(id).delivered_at;
        assert.ok(stamp > 0);

        // QoS1 允许重复投递，第二次 PUBACK 必须是幂等的
        await new Promise(r => setTimeout(r, 15));
        const again = store.markDelivered(id, 'phone-1');
        assert.strictEqual(again.changed, false, '重复确认不应再次跃迁');
        assert.strictEqual(store.get(id).delivered_at, stamp, '送达时间不能被重复确认往后推');
        assert.strictEqual(store.get(id).delivered_to, 'phone-1', '同一客户端不重复记录');

        // 另一个客户端也确认了：状态不变，但审计字段要能看出是两个客户端
        const other = store.markDelivered(id, 'phone-2');
        assert.strictEqual(other.changed, false);
        assert.strictEqual(store.get(id).delivered_to, 'phone-1,phone-2');

        // 已丢弃的记录不接受"复活"
        const dropped = store.create({ key: 'k1', raw: 'RAW-DROP' });
        store.drop(dropped, 'give up');
        assert.strictEqual(store.markDelivered(dropped, 'phone-1').changed, false);
        assert.strictEqual(store.get(dropped).status, STATUS.DROPPED);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('PUBACK 超时回收：已下发超窗口退回未送达，仍在窗口内不动', async () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db') });
    try {
        const stale = store.create({ key: 'k1', raw: 'RAW-STALE' });
        const fresh = store.create({ key: 'k1', raw: 'RAW-FRESH' });
        const done = store.create({ key: 'k1', raw: 'RAW-DONE' });

        store.markSent(stale);
        store.markSent(fresh);
        store.markSent(done);
        store.markDelivered(done, 'c1');

        // 把 stale 的下发时间往前拨 60 秒，模拟"写出去了但确认没回来"
        store._p('UPDATE messages SET sent_at = ? WHERE id = ?').run(Date.now() - 60000, stale);

        const res = store.revertStale(30000);
        assert.strictEqual(res.count, 1);
        assert.deepStrictEqual(res.ids, [stale]);

        assert.strictEqual(store.get(stale).status, STATUS.QUEUED);
        assert.strictEqual(store.get(stale).error, 'puback timeout');
        assert.strictEqual(store.get(fresh).status, STATUS.SENT, '窗口内的不能被回收');
        assert.strictEqual(store.get(done).status, STATUS.DELIVERED, '已送达的不受影响');

        // 回收后应重新出现在待补投队列里
        const ids = store.pending('k1').map(r => r.id);
        assert.ok(ids.includes(stale));
        assert.ok(ids.includes(fresh));
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('投递失败回队，超过最大尝试次数判定丢弃', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db') });
    try {
        const id = store.create({ key: 'k1', raw: 'RAW' });
        for (let i = 0; i < 5; i++) {
            store.markSent(id);
            store.requeue(id, 'timeout');
        }
        let row = store.get(id);
        assert.strictEqual(row.status, STATUS.QUEUED);
        assert.strictEqual(row.attempts, 5);
        assert.strictEqual(row.error, 'timeout');

        store.drop(id, 'give up');
        row = store.get(id);
        assert.strictEqual(row.status, STATUS.DROPPED);
        assert.strictEqual(row.error, 'give up');
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('查询：按 key / 状态 / 关键字过滤，分页与统计', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db') });
    try {
        for (let i = 1; i <= 12; i++) {
            const key = i % 2 ? 'k1' : 'k2';
            store.create({ key, raw: `RAW-${i}`, title: i === 3 ? '找得到我' : `标题${i}`, content: `正文${i}` });
        }
        const ids = store.list({ key: 'k1', size: 100 }).rows.map(r => r.id);
        store.markDelivered(ids[0], 'c1');
        store.markSent(ids[1]);

        assert.strictEqual(store.list({}).total, 12);
        assert.strictEqual(store.list({ key: 'k1' }).total, 6);
        assert.strictEqual(store.list({ key: 'k2' }).total, 6);
        assert.strictEqual(store.list({ status: STATUS.DELIVERED }).total, 1);
        assert.strictEqual(store.list({ status: String(STATUS.SENT) }).total, 1);
        assert.strictEqual(store.list({ keyword: '找得到' }).total, 1);
        assert.strictEqual(store.list({ keyword: '正文1' }).total, 4); // 正文1 / 正文10 / 正文11 / 正文12

        const page1 = store.list({ page: 1, size: 5 });
        const page2 = store.list({ page: 2, size: 5 });
        assert.strictEqual(page1.rows.length, 5);
        assert.strictEqual(page2.rows.length, 5);
        assert.notStrictEqual(page1.rows[0].id, page2.rows[0].id);
        assert.ok(page1.rows[0].id > page1.rows[4].id, '应新→旧排序');

        const stats = store.stats();
        assert.strictEqual(stats.total, 12);
        assert.strictEqual(stats.delivered, 1);
        assert.strictEqual(stats.sent, 1);
        assert.strictEqual(stats.queued, 10);
        assert.strictEqual(stats.today_total, 12);
        assert.strictEqual(stats.today_delivered, 1);
        assert.strictEqual(store.pendingCount(), 11);
        assert.strictEqual(store.pendingKeyCount, 2);

        // 删除与按条件清空
        assert.strictEqual(store.remove(page1.rows[0].id), true);
        assert.strictEqual(store.get(page1.rows[0].id), null);
        assert.strictEqual(store.clear({ status: STATUS.QUEUED }), 9);
        assert.strictEqual(store.stats().total, 2, '剩下 1 条已送达 + 1 条已下发');
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('配额：每个 key 只保留最新 max_per_key 条', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db'), maxPerKey: 3 });
    try {
        for (let i = 1; i <= 6; i++) {
            store.create({ key: 'k1', raw: `RAW-${i}`, title: `m${i}` });
        }
        store.create({ key: 'k2', raw: 'OTHER', title: 'k2-1' });

        const rows = store.list({ key: 'k1', size: 50 }).rows;
        assert.deepStrictEqual(rows.map(r => r.title), ['m6', 'm5', 'm4']);
        assert.strictEqual(store.list({ key: 'k2' }).total, 1, '其它 key 不受影响');
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('过期清理：超过保留天数的记录被删除', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db'), retainDays: 7, maxPerKey: 100 });
    try {
        const oldTs = Date.now() - 8 * 24 * 3600 * 1000;
        store.create({ key: 'k1', raw: 'OLD', title: '旧消息', ts: oldTs });
        store.create({ key: 'k1', raw: 'NEW', title: '新消息' });

        const res = store.prune();
        assert.strictEqual(res.expired, 1);
        assert.strictEqual(store.stats().total, 1);
        assert.strictEqual(store.list({}).rows[0].title, '新消息');
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('保留策略热更新：setRetention 立即清理，0 表示不限制', () => {
    const dir = tmpDir();
    const store = new MessageStore({ file: path.join(dir, 'm.db'), retainDays: 30, maxPerKey: 100 });
    try {
        const oldTs = Date.now() - 10 * 24 * 3600 * 1000;
        store.create({ key: 'k1', raw: 'OLD', title: '10天前', ts: oldTs });
        for (let i = 1; i <= 5; i++) {
            store.create({ key: 'k1', raw: `RAW-${i}`, title: `m${i}` });
        }

        // 收紧到 7 天：只清掉那条旧消息
        const tightened = store.setRetention({ retainDays: 7, maxPerKey: 100 });
        assert.strictEqual(tightened.retainDays, 7);
        assert.strictEqual(tightened.expired, 1);
        assert.strictEqual(store.stats().total, 5);

        // 收紧到每 key 2 条：淘汰最旧的，保留最新 2 条
        const trimmed = store.setRetention({ retainDays: 7, maxPerKey: 2 });
        assert.strictEqual(trimmed.trimmed, 3);
        assert.deepStrictEqual(store.list({ key: 'k1', size: 10 }).rows.map(r => r.title), ['m5', 'm4']);

        // 0 = 不限制：旧消息与配额都不再清理
        store.create({ key: 'k2', raw: 'X', title: 'x1', ts: oldTs });
        store.setRetention({ retainDays: 0, maxPerKey: 0 });
        assert.strictEqual(store.retainDays, 0);
        assert.strictEqual(store.maxPerKey, 0);
        assert.strictEqual(store.stats().total, 3, '0 不应删除任何记录');

        // 非法值回落到当前值
        store.setRetention({ retainDays: -5, maxPerKey: 'abc' });
        assert.strictEqual(store.retainDays, 0);
        assert.strictEqual(store.maxPerKey, 0);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('旧版 offline.json 导入后改名备份', () => {
    const dir = tmpDir();
    const legacy = path.join(dir, 'offline.json');
    fs.writeFileSync(legacy, JSON.stringify({
        queues: {
            k1: [{ payload: 'LEGACY-1', qos: 1, ts: Date.now() }, { payload: 'LEGACY-2', qos: 1, ts: Date.now() }],
            k2: [{ payload: 'LEGACY-3', qos: 1, ts: Date.now() }]
        }
    }));

    const store = new MessageStore({ file: path.join(dir, 'm.db'), importFile: legacy });
    try {
        assert.strictEqual(store.stats().total, 3);
        assert.strictEqual(store.pending('k1').length, 2);
        assert.strictEqual(store.pending('k2').length, 1);
        assert.strictEqual(fs.existsSync(legacy), false, '原文件应被改名');
        assert.strictEqual(fs.existsSync(legacy + '.bak'), true);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ============================ 端到端测试 ============================ */

test('端到端：收到 PUBACK 才算已送达', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    const client = new MqttClient({ port: srv.serverPort, clientId: 'ack-1' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '严格送达', content: 'body' }), 'success');
    await client.waitFor(1);

    const row = await waitLedger(srv, cookie, { page: 1, size: 20 }, r => r.status === STATUS.DELIVERED);
    assert.strictEqual(row.status, STATUS.DELIVERED);
    assert.strictEqual(row.status_text, '已送达');
    assert.match(row.delivered_to, /ack-1/);
    assert.ok(row.delivered_text, '应有送达时间');
    assert.strictEqual(row.title, '严格送达');
});

test('端到端：离线推送保持未送达，上线补投后转为已送达', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '离线待补', content: 'x' }), 'queued');

    const queued = await waitLedger(srv, cookie, { page: 1, size: 20 }, r => r.title === '离线待补');
    assert.strictEqual(queued.status, STATUS.QUEUED);
    assert.strictEqual(queued.status_text, '未送达');
    assert.strictEqual(queued.delivered_text, '');

    const client = new MqttClient({ port: srv.serverPort, clientId: 'late-1' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());
    const msgs = await client.waitFor(1);
    assert.match(msgs[0], /离线待补/);

    const delivered = await waitLedger(srv, cookie, { page: 1, size: 20 }, r => r.title === '离线待补' && r.status === STATUS.DELIVERED);
    assert.strictEqual(delivered.status_text, '已送达');
    assert.match(delivered.delivered_to, /late-1/);

    const stats = (await panel(srv, cookie, '/message/list', { page: 1, size: 1 })).data.stats;
    assert.strictEqual(stats.total, 1);
    assert.strictEqual(stats.delivered, 1);
    assert.strictEqual(stats.queued, 0);
});

test('端到端：同 key 多客户端，任一 PUBACK 即送达，并留下可对账日志', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    // 一个"收下但不确认"的客户端：模拟 Android 在 Doze 下只收不回 ACK
    const silent = new MqttClient({ port: srv.serverPort, clientId: 'silent-1', autoAck: false });
    await silent.connect();
    await silent.subscribe('k1');
    t.after(() => silent.close());

    const talker = new MqttClient({ port: srv.serverPort, clientId: 'talker-1' });
    await talker.connect();
    await talker.subscribe('k1');
    t.after(() => talker.close());

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '任一确认', content: 'x' }), 'success');
    await silent.waitFor(1);
    await talker.waitFor(1);

    const row = await waitLedger(srv, cookie, { page: 1, size: 20 },
        r => r.title === '任一确认' && r.status === STATUS.DELIVERED);
    assert.strictEqual(row.status_text, '已送达');
    assert.match(row.delivered_to, /talker-1/, '应由真正回 PUBACK 的客户端确认');
    assert.doesNotMatch(row.delivered_to, /silent-1/, '只是收到不算送达');
    assert.strictEqual(row.confirmed_by, 'talker-1', '列表要能直接看出是谁确认的');
    assert.strictEqual(row.confirmed_script, false, '真机/普通客户端不应被判成脚本');

    // 真机验收唯一不能伪造的证据：clientId / msg / 状态跃迁都在一行里
    const line = srv.log.split('\n').find(l => l.includes('[puback] clientId=talker-1'));
    assert.ok(line, '应输出 [puback] 对账日志，实际日志片段：' + srv.log.slice(-800));
    assert.match(line, /topic=k1/);
    assert.match(line, new RegExp('msg=#' + row.id));
    assert.match(line, /status 1->2/);
});

test('确认方：probe- 前缀的验收脚本在台账里被标成脚本', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    const probe = new MqttClient({ port: srv.serverPort, clientId: 'probe-999' });
    await probe.connect();
    await probe.subscribe('k1');
    t.after(() => probe.close());

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '脚本确认', content: 'x' }), 'success');
    await probe.waitFor(1);

    const row = await waitLedger(srv, cookie, { page: 1, size: 20 },
        r => r.title === '脚本确认' && r.status === STATUS.DELIVERED);
    assert.strictEqual(row.confirmed_by, 'probe-999');
    assert.strictEqual(row.confirmed_count, 1);
    assert.strictEqual(row.confirmed_script, true, 'probe- 前缀必须被标成脚本，避免误当真机送达');
});

test('端到端：连续多条按投递顺序逐条对应，不会串号', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    const client = new MqttClient({ port: srv.serverPort, clientId: 'seq-1' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    for (let i = 1; i <= 3; i++) {
        assert.strictEqual(await srv.push({ push_key: 'k1', title: '连发' + i, content: 'c' + i }), 'success');
    }
    await client.waitFor(3);

    const rows = [];
    for (let i = 1; i <= 3; i++) {
        rows.push(await waitLedger(srv, cookie, { page: 1, size: 20 },
            r => r.title === '连发' + i && r.status === STATUS.DELIVERED));
    }
    const ids = rows.map(r => r.id).sort((a, b) => a - b);

    // clean session 下 PUBACK 不带报文，反向映射靠"投递顺序"对齐；
    // 串号的表现就是日志里的 msg=# 顺序与落库顺序不一致
    const logged = srv.log.split('\n')
        .filter(l => l.includes('[puback] clientId=seq-1'))
        .map(l => Number((/msg=#(\d+)/.exec(l) || [])[1]))
        .filter(Boolean);
    assert.deepStrictEqual(logged, ids, '三条消息应按落库顺序逐条确认，实际：' + JSON.stringify(logged));
});

test('端到端：面板页面正常渲染，无模板残留、无 layui', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);
    await srv.push({ push_key: 'k1', title: '渲染检查', content: 'x' });

    for (const url of ['/', '/test/index', '/message/index', '/setting/index']) {
        const res = await fetch(`http://127.0.0.1:${srv.panelPort}${url}`, { headers: { Cookie: cookie } });
        const html = await res.text();
        assert.strictEqual(res.status, 200, url + ' 应返回 200');
        assert.ok(!html.includes('{{'), url + ' 不应残留模板标记');
        assert.ok(!/layui/i.test(html), url + ' 不应再引用 layui');
        assert.ok(html.includes('/css/app.css'), url + ' 应引用新样式表');
        assert.ok(html.includes('/js/app.js'), url + ' 应引用新脚本');
    }

    // 首页仪表盘：统计卡 + 最近消息 + 文档入口，且不再包含在线测试表单
    const home = await (await fetch(`http://127.0.0.1:${srv.panelPort}/`, { headers: { Cookie: cookie } })).text();
    assert.ok(home.includes('在线客户端'), '首页应显示在线客户端数');
    assert.ok(home.includes('data-field="client_count"'), '首页应带客户端数占位');
    assert.ok(home.includes('最近消息'), '首页应显示最近消息');
    assert.ok(home.includes('渲染检查'), '首页应渲染最近一条消息标题');
    assert.ok(home.includes('相关文档'), '首页应显示文档入口');
    assert.ok(!home.includes('id="test-form"'), '首页不应再包含在线测试表单');

    // 在线测试页：表单与客户端数都在
    const testPage = await (await fetch(`http://127.0.0.1:${srv.panelPort}/test/index`, { headers: { Cookie: cookie } })).text();
    assert.ok(testPage.includes('id="test-form"'), '测试页应包含发送表单');
    assert.ok(testPage.includes('data-field="client_count"'), '测试页应显示在线客户端数');

    // 设置页存储面板：保留天数 / 条数可配置
    const setting = await (await fetch(`http://127.0.0.1:${srv.panelPort}/setting/index`, { headers: { Cookie: cookie } })).text();
    assert.ok(setting.includes('data-form="messages"'), '存储面板应有保留策略表单');
    assert.ok(setting.includes('name="retain_days"'), '应可设置保留天数');
    assert.ok(setting.includes('name="max_per_key"'), '应可设置每 key 条数');

    const ledger = await fetch(`http://127.0.0.1:${srv.panelPort}/message/index`, { headers: { Cookie: cookie } });
    const html = await ledger.text();
    assert.ok(html.includes('消息台账'), '应渲染台账标题');
    assert.ok(html.includes('k1'), '应把 push_key 注入页面');
    assert.ok(html.includes('message/list'), '台账应通过接口拉数据');
    assert.ok(html.includes('data-stat="delivered"'), '应渲染送达统计卡');
});

test('端到端：详情 / 重发 / 删除 / 导出', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '待重发', content: 'x' }), 'queued');
    const row = await waitLedger(srv, cookie, { page: 1, size: 5 }, r => r.title === '待重发');

    const detail = await panel(srv, cookie, '/message/detail', { id: row.id });
    assert.strictEqual(detail.state, 1);
    assert.strictEqual(detail.data.title, '待重发');
    assert.ok(detail.data.raw.includes('待重发'), '详情应带原始报文');

    // 重发：无在线客户端 → 入队等待，生成新记录
    const again = await panel(srv, cookie, '/message/resend', { id: row.id });
    assert.strictEqual(again.state, 1, again.msg);
    const afterResend = await panel(srv, cookie, '/message/list', { page: 1, size: 20, keyword: '待重发' });
    assert.strictEqual(afterResend.data.total, 2, '重发应生成新的台账记录');

    // 导出 CSV
    const csvRes = await fetch(`http://127.0.0.1:${srv.panelPort}/message/export`, { headers: { Cookie: cookie } });
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    const csv = csvBuf.toString('utf8');
    assert.strictEqual(csvRes.status, 200);
    assert.ok(csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, '应带 UTF-8 BOM');
    assert.match(csv, /"时间","push_key","标题"/);
    assert.match(csv, /待重发/);
    assert.match(csvRes.headers.get('content-disposition') || '', /attachment; filename="pushme-messages-\d{4}-\d{2}-\d{2}\.csv"/);

    // 删除
    const del = await panel(srv, cookie, '/message/remove', { id: row.id });
    assert.strictEqual(del.state, 1, del.msg);
    assert.strictEqual((await panel(srv, cookie, '/message/detail', { id: row.id })).state, 0);

    // 按状态清空
    const cleared = await panel(srv, cookie, '/message/clear', { status: STATUS.QUEUED });
    assert.strictEqual(cleared.state, 1);
    assert.strictEqual((await panel(srv, cookie, '/message/list', { page: 1, size: 20 })).data.total, 0);
});

test('端到端：服务状态接口返回台账统计', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    const client = new MqttClient({ port: srv.serverPort, clientId: 'stat-1' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    await srv.push({ push_key: 'k1', title: '统计', content: 'x' });
    await client.waitFor(1);

    const deadline = Date.now() + 5000;
    let data = null;
    while (Date.now() < deadline) {
        const res = await panel(srv, cookie, '/server/status');
        data = res.data;
        if (data && data.delivered_count === 1) break;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.strictEqual(data.message_count, 1);
    assert.strictEqual(data.delivered_count, 1);
    assert.strictEqual(data.today_total, 1);
    assert.strictEqual(data.today_delivered, 1);
    assert.strictEqual(data.offline_count, 0);
});

test('端到端：设置页保存保留策略后立即生效', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const cookie = await panelLogin(srv);

    // 造 4 条排队消息（无客户端在线 → queued）
    for (let i = 1; i <= 4; i++) {
        assert.strictEqual(await srv.push({ push_key: 'k1', title: `ret-${i}`, content: 'x' }), 'queued');
    }
    await waitLedger(srv, cookie, { page: 1, size: 10 }, r => r.title === 'ret-4');

    // 每 key 只留 2 条，天数不限
    const saved = await panel(srv, cookie, '/setting/index', {
        form: 'messages', retain_days: '0', max_per_key: '2'
    });
    assert.strictEqual(saved.state, 1, saved.msg);
    assert.strictEqual(saved.data.retain_days, 0);
    assert.strictEqual(saved.data.max_per_key, 2);
    assert.strictEqual(saved.data.removed, 2, '应立即淘汰超配额的 2 条');

    const list = await panel(srv, cookie, '/message/list', { page: 1, size: 10 });
    assert.strictEqual(list.data.total, 2);
    assert.deepStrictEqual(list.data.rows.map(r => r.title), ['ret-4', 'ret-3']);

    // 页面回填新值
    const html = await (await fetch(`http://127.0.0.1:${srv.panelPort}/setting/index`, { headers: { Cookie: cookie } })).text();
    assert.ok(/id="retain_days"[^>]*value="0"/.test(html), '天数应回填为 0');
    assert.ok(/id="max_per_key"[^>]*value="2"/.test(html), '条数应回填为 2');

    // 越界值被拒绝
    const bad = await panel(srv, cookie, '/setting/index', {
        form: 'messages', retain_days: '-1', max_per_key: '2'
    });
    assert.strictEqual(bad.state, 0);

    // 配置落盘：data.json 中 messages 已更新
    const raw = JSON.parse(fs.readFileSync(path.join(srv.configDir, 'data.json'), 'utf8'));
    assert.deepStrictEqual(raw.messages, { retain_days: 0, max_per_key: 2 });
});
