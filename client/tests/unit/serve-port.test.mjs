// serve-port 的端口协商 + 浏览器开关测试。
//
// 钉住三件事：
//   1. NX_SERVE_NO_OPEN 是**所有 nx-xx 项目共享**的开关（名字不带项目前缀），
//      与 --no-open 是「或」关系：任一为真就不开浏览器。
//   2. 端口冲突时先问「上面跑的是不是我」——跑的是本项目的面板才复用，
//      别人的（或探测不出来的）才顺延到下一个空闲端口。
//   3. 复用判定用的是本项目**真实**的 APP_NAME（从 core/paths 取），
//      不是写死的字符串——写死就测不到 reuse 分支了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  NO_OPEN_ENV,
  isEnvTruthy,
  autoOpenEnabled,
  probePanel,
  findFreePort,
  resolvePortConflict,
  describeOccupant,
} from '../../src/core/serve-port.ts';
import { APP_NAME } from '../../src/core/paths.ts';

// 起一个假的 /api/bootstrap：返回 {ok:true,data:{app:{name}}}。
// app.name 就是跨项目唯一的认领签名——别的服务不会恰好返回它。
function startFakePanel(appName) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/bootstrap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { app: { name: appName } } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not a panel');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 占一个端口但不响应 HTTP：连上就掐断，探测必然拿不到 bootstrap。
function startSilentPort() {
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

// ---- 开关 ----

test('NO_OPEN_ENV: 变量名不带项目前缀（所有 nx-xx 项目共用同一个）', () => {
  assert.equal(NO_OPEN_ENV, 'NX_SERVE_NO_OPEN');
});

test('isEnvTruthy: 只认 1 / true / yes / on（大小写不敏感）', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On', ' yes ']) {
    assert.equal(isEnvTruthy(v), true, `${v} 应当算真值`);
  }
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', undefined, null]) {
    assert.equal(isEnvTruthy(v), false, `${v} 不应当算真值`);
  }
});

test('autoOpenEnabled: 环境变量未设 + 无 flag → 允许开浏览器', () => {
  delete process.env[NO_OPEN_ENV];
  assert.equal(autoOpenEnabled(false), true);
  assert.equal(autoOpenEnabled(undefined), true);
});

test('autoOpenEnabled: NX_SERVE_NO_OPEN=1/true/yes/on → 不开浏览器', () => {
  for (const v of ['1', 'true', 'yes', 'on']) {
    process.env[NO_OPEN_ENV] = v;
    assert.equal(autoOpenEnabled(false), false, `NX_SERVE_NO_OPEN=${v} 应当禁用自动开浏览器`);
  }
  delete process.env[NO_OPEN_ENV];
});

test('autoOpenEnabled: NX_SERVE_NO_OPEN=0 不是真值 → 仍允许开浏览器', () => {
  process.env[NO_OPEN_ENV] = '0';
  assert.equal(autoOpenEnabled(false), true);
  delete process.env[NO_OPEN_ENV];
});

test('autoOpenEnabled: --no-open 单独就能关掉（与环境变量无关）', () => {
  delete process.env[NO_OPEN_ENV];
  assert.equal(autoOpenEnabled(true), false);
  process.env[NO_OPEN_ENV] = '1';
  assert.equal(autoOpenEnabled(true), false);
  delete process.env[NO_OPEN_ENV];
});

// ---- 探测与端口 ----

test('probePanel: 端口上不是面板 → null', async () => {
  const { server, port } = await startSilentPort();
  try {
    assert.equal(await probePanel(port, '127.0.0.1', 200), null);
  } finally {
    await close(server);
  }
});

test('probePanel: 探到面板时带回 bootstrap 负载（含 app 段）', async () => {
  const { server, port } = await startFakePanel('someone-else');
  try {
    const probe = await probePanel(port, '127.0.0.1', 500);
    assert.ok(probe, '能探到 bootstrap 负载');
    assert.equal(probe.app.name, 'someone-else');
  } finally {
    await close(server);
  }
});

test('findFreePort: 返回的端口确实能监听', async () => {
  const port = await findFreePort(45000);
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await close(server);
});

test('findFreePort: 起始端口被占 → 顺延到后面的空闲端口', async () => {
  const { server, port } = await startSilentPort();
  try {
    const next = await findFreePort(port, '127.0.0.1');
    assert.ok(next > port, `应当顺延：${port} → ${next}`);
  } finally {
    await close(server);
  }
});

// ---- 冲突决策 ----

test('resolvePortConflict: 端口上是本项目的面板 → reuse（不重复启动）', async () => {
  const { server, port } = await startFakePanel(APP_NAME);
  try {
    const d = await resolvePortConflict(port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'reuse');
    assert.equal(d.port, port);
    assert.equal(d.occupant, APP_NAME);
    assert.ok(d.existing, '探测到的 bootstrap 负载要带回来');
  } finally {
    await close(server);
  }
});

test('resolvePortConflict: 端口上是别的服务 → shift（顺延到下一个空闲端口）', async () => {
  const { server, port } = await startFakePanel('someone-else');
  try {
    const d = await resolvePortConflict(port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'shift');
    assert.ok(d.port > port, `应当顺延：${port} → ${d.port}`);
    assert.equal(d.occupant, 'someone-else');
  } finally {
    await close(server);
  }
});

test('resolvePortConflict: 探测不出占用者 → shift，占用者记为未知服务', async () => {
  const { server, port } = await startSilentPort();
  try {
    const d = await resolvePortConflict(port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'shift');
    assert.ok(d.port > port);
    assert.equal(d.occupant, null);
    assert.equal(describeOccupant(d.occupant), '未知服务');
  } finally {
    await close(server);
  }
});

test('describeOccupant: 探测得到就是它的 app 名', () => {
  assert.equal(describeOccupant('nx-kv'), 'nx-kv');
  assert.equal(describeOccupant(null), '未知服务');
});
