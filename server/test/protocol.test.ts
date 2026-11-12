// server 包的协议层与路由层单测。
//
// 这两组是**跨端契约**：client 半以 workspace 依赖引入同一份实现，
// 所以这里钉住的行为两端都成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  encodeFrame, decodeFrame, normalizeHeaders, headerValue,
  stripRequestHeaders, stripResponseHeaders, flattenHeaders,
  nextRequestId, MAX_BODY_BYTES, DEFAULT_REQUEST_TIMEOUT_MS, FRAME,
} from '../src/protocol.js';
import {
  resolveApp, isValidAppName, baseOf, describeApp, KNOWN_APPS,
  RESERVED_PATH_SEGMENTS, APP_HEADER, isPortFree, scanApps,
} from '../src/apps.js';

test('帧编码解码：往返一致', () => {
  const obj = { type: FRAME.REQUEST, id: 'r1', app: 'nx-kv', body: 'aGk=' };
  const decoded = decodeFrame(encodeFrame(obj));
  assert.deepEqual(decoded, obj);
});

test('帧解码：非法输入返回 null（不是抛异常）', () => {
  assert.equal(decodeFrame('not json'), null);
  assert.equal(decodeFrame('{"no":"type"}'), null);
  assert.equal(decodeFrame('[1,2,3]'), null);
  assert.equal(decodeFrame(null), null);
  assert.equal(decodeFrame(undefined), null);
  assert.equal(decodeFrame(123), null);
});

test('帧解码：Buffer 与数组也吃', () => {
  const raw = Buffer.from(JSON.stringify({ type: FRAME.PING }), 'utf8');
  assert.equal(decodeFrame(raw)?.type, FRAME.PING);
  assert.equal(decodeFrame([raw])?.type, FRAME.PING);
});

test('请求 id 全局唯一（pending 表是全局的）', () => {
  const ids = new Set(Array.from({ length: 500 }, () => nextRequestId()));
  assert.equal(ids.size, 500);
});

test('头规范化：键小写、值成数组', () => {
  const h = normalizeHeaders({ 'X-Foo': 'a', 'Set-Cookie': ['x', 'y'], Skip: undefined });
  assert.deepEqual(h['x-foo'], ['a']);
  assert.deepEqual(h['set-cookie'], ['x', 'y']);
  assert.equal('skip' in h, false);
});

test('头取值：大小写不敏感；数组取第一个', () => {
  const h = normalizeHeaders({ 'X-Mn-Ws-Token': 'tok' });
  assert.equal(headerValue(h, 'x-mn-ws-token'), 'tok');
  assert.equal(headerValue(h, 'X-MN-WS-TOKEN'), 'tok');
  assert.equal(headerValue(h, 'missing'), undefined);
});

test('请求头剥离：hop-by-hop + Origin + L1 门禁头都要走', () => {
  const out = stripRequestHeaders({
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    origin: 'http://evil.example',
    'x-mn-ws-token': 'secret',
    'content-type': 'application/json',
  });
  assert.deepEqual(out, { 'content-type': 'application/json' });
});

test('响应头剥离：content-length 由本地重算', () => {
  const out = stripResponseHeaders({ 'content-length': '10', 'x-fake': 'yes' });
  assert.deepEqual(out, { 'x-fake': 'yes' });
});

test('头压平：数组默认取首值，set-cookie 保留数组', () => {
  const flat = flattenHeaders({ 'x-a': ['1', '2'], 'set-cookie': ['a=1', 'b=2'] }, ['set-cookie']);
  assert.equal(flat['x-a'], '1');
  assert.deepEqual(flat['set-cookie'], ['a=1', 'b=2']);
});

test('头压平：空数组的键直接不出现', () => {
  const flat = flattenHeaders({ 'x-a': [] });
  assert.equal('x-a' in flat, false);
});

test('应用标识：路径前缀优先', () => {
  const r = resolveApp('/nx-kv/api/todo/list', normalizeHeaders({}));
  assert.deepEqual(r, { app: 'nx-kv', path: '/api/todo/list' });
});

test('应用标识：请求头也认', () => {
  const r = resolveApp('/api/todo/list', normalizeHeaders({ 'X-Nx-App': 'nx-kv' }));
  assert.deepEqual(r, { app: 'nx-kv', path: '/api/todo/list' });
});

test('应用标识：两者冲突 → app_conflict（不猜）', () => {
  const r = resolveApp('/nx-kv/api/x', normalizeHeaders({ 'X-Nx-App': 'nx-rh' }));
  assert.deepEqual(r, { error: 'app_conflict' });
});

test('应用标识：都没有 → app_required', () => {
  const r = resolveApp('/api/todo/list', normalizeHeaders({}));
  assert.deepEqual(r, { error: 'app_required' });
});

test('应用标识：保留段不会被当成 app（K20 的坑）', () => {
  for (const seg of RESERVED_PATH_SEGMENTS) {
    const r = resolveApp(`/${seg}/x`, normalizeHeaders({}));
    assert.equal('error' in r && r.error === 'app_required', true, `${seg} 不该被当成 app`);
  }
});

test('应用标识：非法名字 → invalid_app_name', () => {
  const r = resolveApp('/api/x', normalizeHeaders({ 'X-Nx-App': 'Bad Name' }));
  assert.deepEqual(r, { error: 'invalid_app_name' });
});

test('应用标识：尾部斜杠被规范化', () => {
  const r = resolveApp('/nx-kv/api/x/', normalizeHeaders({}));
  assert.deepEqual(r, { app: 'nx-kv', path: '/api/x' });
});

test('app 名合法性', () => {
  assert.equal(isValidAppName('nx-kv'), true);
  assert.equal(isValidAppName('Nx-kv'), false);
  assert.equal(isValidAppName('-nx'), false);
  assert.equal(isValidAppName('nx_kv'), false);
  assert.equal(isValidAppName(''), false);
});

test('基址解析：覆盖优先，其次已知端口', () => {
  assert.equal(baseOf('nx-kv', { 'nx-kv': { base: 'http://127.0.0.1:9999' } }), 'http://127.0.0.1:9999');
  assert.equal(baseOf('nx-kv', null), `http://127.0.0.1:${KNOWN_APPS['nx-kv']!.port}`);
  assert.equal(baseOf('no-such-app', null), null);
});

test('应用描述：端口与标题', () => {
  const d = describeApp('nx-kv', 'http://127.0.0.1:7877');
  assert.equal(d.port, 7877);
  assert.equal(d.title, KNOWN_APPS['nx-kv']!.title);
  assert.equal(d.known, true);
});

test('端口预检：被占的端口识别得出来', async () => {
  const held = net.createServer();
  await new Promise((r) => held.listen(0, '127.0.0.1', r));
  const port = (held.address() as net.AddressInfo).port;
  const res = await isPortFree(port, '127.0.0.1');
  assert.equal(res.free, false);
  await new Promise((r) => held.close(r));
});

test('端口预检：空闲端口识别得出来', async () => {
  const res = await isPortFree(0, '127.0.0.1');
  assert.equal(res.free, true);
});

test('扫描只给事实，不替用户决定能不能桥', async () => {
  const list = await scanApps({ host: '127.0.0.1', apps: ['nx-kv'] });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.app, 'nx-kv');
  assert.equal(typeof list[0]!.alive, 'boolean');
});

test('协议常量：上限与超时', () => {
  assert.equal(MAX_BODY_BYTES, 24 * 1024 * 1024);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(APP_HEADER, 'x-nx-app');
});
