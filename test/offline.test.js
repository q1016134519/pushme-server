/**
 * 离线消息补投回归测试
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, MqttClient } = require('./helpers.js');

test('在线客户端：直接投递，返回 success', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());

    const client = new MqttClient({ port: srv.serverPort, clientId: 'online-1' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    const result = await srv.push({ push_key: 'k1', title: 'hello', content: 'world' });
    assert.strictEqual(result, 'success');

    const msgs = await client.waitFor(1);
    assert.match(msgs[0], /hello/);
});

test('离线期间推送：返回 queued，换 clientId 上线后补投', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // 先上线订阅，然后掉线（clean session，模拟 App 默认行为）
    const first = new MqttClient({ port: srv.serverPort, clientId: 'phone-1', clean: true });
    await first.connect();
    await first.subscribe('k1');
    first.close();
    await new Promise(r => setTimeout(r, 300));

    const r1 = await srv.push({ push_key: 'k1', title: '离线1', content: 'a' });
    const r2 = await srv.push({ push_key: 'k1', title: '离线2', content: 'b' });
    assert.strictEqual(r1, 'queued', '离线推送应返回 queued');
    assert.strictEqual(r2, 'queued');

    // 用【另一个 clientId】上线，验证补投不依赖 clientId
    const second = new MqttClient({ port: srv.serverPort, clientId: 'phone-2', clean: true });
    await second.connect();
    await second.subscribe('k1');
    t.after(() => second.close());

    const msgs = await second.waitFor(2);
    assert.match(msgs[0], /离线1/);
    assert.match(msgs[1], /离线2/);

    // 再推一条应是 success（已有人在线），且没有重复补投
    const r3 = await srv.push({ push_key: 'k1', title: '在线', content: 'c' });
    assert.strictEqual(r3, 'success');
    const all = await second.settle(800);
    assert.strictEqual(all.length, 3, '不应重复补投历史消息');
});

test('同一连接重复订阅同一个 key：只补投一次，不重复通知', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '单条离线', content: 'a' }), 'queued');

    const phone = new MqttClient({ port: srv.serverPort, clientId: 'dup-sub-1', clean: true });
    await phone.connect();
    await phone.subscribe('k1');
    await phone.waitFor(1);
    // App 连上后会对同一个 key 再发一次 SUBSCRIBE（回前台补订阅），这里复现这个行为
    await phone.subscribe('k1');

    const all = await phone.settle(900);
    assert.strictEqual(all.length, 1, '重复订阅不应把同一条消息投两遍，实际收到：' + JSON.stringify(all));
    t.after(() => phone.close());
});

test('设备从未上线：上线后能收到历史消息', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '首条', content: 'x' }), 'queued');
    assert.strictEqual(await srv.push({ push_key: 'k1', title: '第二条', content: 'y' }), 'queued');

    const client = new MqttClient({ port: srv.serverPort, clientId: 'brand-new' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    const msgs = await client.waitFor(2);
    assert.match(msgs[0], /首条/);
    assert.match(msgs[1], /第二条/);
});

test('broker 重启后离线队列不丢', async t => {
    const srv = await startServer();
    const { configDir, serverPort, panelPort } = srv;

    assert.strictEqual(await srv.push({ push_key: 'k1', title: '重启前', content: 'z' }), 'queued');

    // 直接杀掉进程（模拟 docker restart / 崩溃），保留配置目录
    await srv.kill();

    const restarted = await startServer({ configDir, serverPort, panelPort });
    t.after(() => restarted.stop());

    const client = new MqttClient({ port: serverPort, clientId: 'after-restart' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    const msgs = await client.waitFor(1);
    assert.match(msgs[0], /重启前/);
});

test('队列上限：超出 max_per_key 丢最旧的', async t => {
    const srv = await startServer({ offline: { enabled: true, max_per_key: 3, ttl_hours: 72 } });
    t.after(() => srv.stop());

    for (let i = 1; i <= 5; i++) {
        await srv.push({ push_key: 'k1', title: `m${i}`, content: 'x' });
    }

    const client = new MqttClient({ port: srv.serverPort, clientId: 'cap-1' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    const msgs = await client.waitFor(3);
    const all = await client.settle(700);
    assert.strictEqual(all.length, 3, '应只保留最后 3 条');
    assert.match(msgs[0], /m3/);
    assert.match(msgs[2], /m5/);
});

test('关闭离线暂存时：无订阅者返回 no_subscriber 而非假成功', async t => {
    const srv = await startServer({ offline: { enabled: false } });
    t.after(() => srv.stop());

    const result = await srv.push({ push_key: 'k1', title: 'x', content: 'y' });
    assert.strictEqual(result, 'no_subscriber');
});

test('多个 push_key：任一 queued 则整体 queued', async t => {
    const srv = await startServer({ keys: ['k1', 'k2'] });
    t.after(() => srv.stop());

    const result = await srv.push({ push_key: 'k1,k2', title: 'multi', content: 'x' });
    assert.strictEqual(result, 'queued');

    const client = new MqttClient({ port: srv.serverPort, clientId: 'multi-1' });
    await client.connect();
    await client.subscribe('k2');
    t.after(() => client.close());

    const msgs = await client.waitFor(1);
    assert.match(msgs[0], /multi/);
});

test('持持久会话的客户端离线时：交给 broker 排队，不重复补投', async t => {
    const srv = await startServer();
    t.after(() => srv.stop());

    // clean=false：订阅会写入持久化，broker 自己会为离线会话排队
    const first = new MqttClient({ port: srv.serverPort, clientId: 'persist-1', clean: false });
    await first.connect();
    await first.subscribe('k1');
    first.close();
    await new Promise(r => setTimeout(r, 300));

    const result = await srv.push({ push_key: 'k1', title: '持久会话', content: 'p' });
    assert.strictEqual(result, 'success', '有持久会话时不应再进离线队列');

    const again = new MqttClient({ port: srv.serverPort, clientId: 'persist-1', clean: false });
    await again.connect();
    t.after(() => again.close());

    const msgs = await again.waitFor(1);
    const all = await again.settle(800);
    assert.strictEqual(all.length, 1, '不应重复投递');
    assert.match(msgs[0], /持久会话/);
});

test('消息服务处于关闭状态时：推送返回 queued 而不是挂起', async t => {
    // status=stop：broker 不启动，等价于面板上点了"关闭服务"
    const srv = await startServer({ status: 'stop' });
    t.after(() => srv.stop());

    const started = Date.now();
    const result = await srv.push({ push_key: 'k1', title: '停服推送', content: 'x' });
    const cost = Date.now() - started;

    assert.strictEqual(result, 'queued', '停服时应入队而非报错/挂起');
    assert.ok(cost < 3000, `不应挂起，实际耗时 ${cost}ms`);

    // 释放端口后重新拉起（等价于面板上点"启动服务"）
    await srv.kill();
    const restarted = await startServer({ configDir: srv.configDir, panelPort: srv.panelPort, serverPort: srv.serverPort });
    t.after(() => restarted.stop());

    const client = new MqttClient({ port: srv.serverPort, clientId: 'after-start' });
    await client.connect();
    await client.subscribe('k1');
    t.after(() => client.close());

    const msgs = await client.waitFor(1);
    assert.match(msgs[0], /停服推送/);
});
