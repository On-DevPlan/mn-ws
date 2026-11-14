// 回归测试：**鉴权失败不许无限重连**。
//
// 背景：设备令牌是 90 天有效期、起桥时取一次的静态值。令牌过期 / 被吊销后，
// 服务端回 4403 关闭连接 —— 而客户端的重连用的是**同一枚令牌**，
// 再连一百次也是同样的 4403。
// 改造前：那会让面板一直显示「重连中」、日志刷屏，而真正要用户做的事
// （重新 auth login）一句提示都不会有。
//
// 与 mn-rt 的 client/lib/ws-client.js 同款处置：4403 → 停止重连 + 明确提示。
//
// 用注入的假 WebSocket 驱动 close 事件，不连真服务器、不依赖网络时序。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WsBridgeClient } from '../../src/core/bridge.ts';

/** 假的 WebSocket：能被外部触发 open / close。 */
class FakeWs {
  static last = null;
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.handlers = {};
    FakeWs.last = this;
  }
  send(x) { this.sent.push(x); }
  ping() {}
  terminate() {}
  close() {}
  on(ev, fn) { this.handlers[ev] = fn; }
  emit(ev, ...args) {
    const fn = this.handlers[ev];
    if (fn) fn(...args);
  }
}

function makeClient(onStatus, extra = {}) {
  return new WsBridgeClient({
    url: 'ws://x/ws',
    bridgeId: 'pc-1',
    apps: {},
    onStatus,
    WebSocketImpl: FakeWs,
    ...extra,
  });
}

test('注册被拒（4403）时停止重连，并给出可行动的提示', async () => {
  const statuses = [];
  const c = makeClient((s) => statuses.push(s), { token: 'bad-token' });
  c.start();
  const ws = FakeWs.last;
  assert.ok(ws, '应当建出连接');

  // 触发服务端拒绝后的 close
  ws.emit('close', 4403, Buffer.from('invalid token'));

  const last = statuses[statuses.length - 1];
  assert.equal(last.state, 'error', '鉴权失败应进 error 态，而不是 reconnecting');
  assert.equal(last.error, 'invalid_token');
  assert.match(last.reason || '', /auth login/, '提示要说清用户该做什么');

  // 关键：不能排重连
  assert.ok(
    !statuses.some((s) => s.state === 'reconnecting'),
    '鉴权失败是确定性失败，不该排重连',
  );
});

test('普通断连（非 4403）仍然重连', async () => {
  const statuses = [];
  const c = makeClient((s) => statuses.push(s), { token: 'good-token' });
  c.start();
  const ws = FakeWs.last;
  ws.emit('close', 1006, Buffer.from(''));

  assert.ok(
    statuses.some((s) => s.state === 'reconnecting'),
    '网络抖动仍要退避重连 —— 只有鉴权失败才停',
  );
});
