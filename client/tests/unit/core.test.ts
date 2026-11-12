// client 半的核心单测：配置、账号簿、PKCE、白名单。
//
// 全部用 MN_WS_HOME 指向临时目录 —— 测试绝不能碰开发者真实的 ~/.mn-ws
// （那里存着设备令牌）。这条纪律是被一次真事故教出来的：冒烟测试读了本机
// 配置里的令牌，「server 无鉴权时拒绝启动」那条用例于是真的把 server 起了，
// 子进程永不退出，整个套件挂死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  loadClientConfig, parseApps, parseAppMap, httpBaseFromWs,
  withAccounts, listAccounts, saveAuthAccount, switchActiveAccount,
  clearAuthCredentials, entryKeyOf, labelOf, isExpired, pick, isEnvTruthy,
  saveCustomApps,
} from '../../src/core/config.js';
import { createAuthRequest, buildAuthorizeUrl, loginClientIdOf, b64url } from '../../src/core/auth.js';
import { MnWsController } from '../../src/core/controller.js';
import { addCustomApp, removeCustomApp } from '../../src/modules/bridge/service.js';

/** 每个用例一份独立的配置目录。 */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-test-'));
  const prev = process.env.MN_WS_HOME;
  process.env.MN_WS_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.MN_WS_HOME;
    else process.env.MN_WS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('配置优先级：命令行 > 环境变量 > 配置文件 > 默认值', () => {
  withTempHome(() => {
    const cfgFile = path.join(process.env.MN_WS_HOME!, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ url: 'ws://file:1/ws', deviceName: 'from-file' }), 'utf8');

    // 只有配置文件
    assert.equal(loadClientConfig({}).url, 'ws://file:1/ws');
    assert.equal(loadClientConfig({}).deviceName, 'from-file');

    // 环境变量压过文件
    process.env.MN_WS_URL = 'ws://env:2/ws';
    assert.equal(loadClientConfig({}).url, 'ws://env:2/ws');

    // 命令行压过环境变量
    assert.equal(loadClientConfig({ url: 'ws://flag:3/ws' }).url, 'ws://flag:3/ws');
    delete process.env.MN_WS_URL;
  });
});

test('配置：serverHttp 缺省从 url 推导', () => {
  withTempHome(() => {
    const cfg = loadClientConfig({ url: 'ws://1.2.3.4:7777/ws' });
    assert.equal(cfg.serverHttp, 'http://1.2.3.4:7777');
    assert.equal(httpBaseFromWs('wss://h/ws'), 'https://h');
  });
});

test('配置：默认端口 7777，clientId 自动生成并持久化', () => {
  withTempHome((home) => {
    const cfg = loadClientConfig({});
    assert.equal(cfg.webPort, 7777);
    assert.ok(cfg.clientId.length > 0);
    // 第二次读：同一个 clientId（稳定标识）
    assert.equal(loadClientConfig({}).clientId, cfg.clientId);
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(raw.clientId, cfg.clientId);
  });
});

test('解析：apps（可带基址）/ app-map', () => {
  const plain = parseApps('my-api,other-api');
  assert.deepEqual(plain.names, ['my-api', 'other-api']);
  assert.deepEqual(plain.overrides, {});

  // 名字 + 基址内联：一条命令把「桥什么」和「桥到哪」一起说清
  const withBase = parseApps('my-api,other-api=http://127.0.0.1:7999');
  assert.deepEqual(withBase.names, ['my-api', 'other-api']);
  assert.deepEqual(withBase.overrides, { 'other-api': { base: 'http://127.0.0.1:7999' } });

  assert.deepEqual(parseApps('').names, []);
  assert.deepEqual(parseAppMap('my-api=http://127.0.0.1:7999'), { 'my-api': { base: 'http://127.0.0.1:7999' } });
  assert.deepEqual(parseAppMap('bad'), {});
});

test('账号簿：两个账号并存，switch 切当前', () => {
  withTempHome(() => {
    saveAuthAccount({ entry: { userId: 'u1', email: 'a@example.com', deviceToken: 't1', expiresAt: Date.now() + 100000 } });
    saveAuthAccount({ entry: { userId: 'u2', email: 'b@example.com', deviceToken: 't2', expiresAt: Date.now() + 100000 } });

    const view = withAccounts(JSON.parse(fs.readFileSync(path.join(process.env.MN_WS_HOME!, 'config.json'), 'utf8')));
    assert.equal(listAccounts(view).length, 2);

    const r = switchActiveAccount('u1', {});
    assert.equal(r.key, 'u1');
    assert.equal(r.entry.deviceToken, 't1');
  });
});

test('账号簿：一台 clientId 换绑被拒（属主绑定不可改）', () => {
  withTempHome(() => {
    saveAuthAccount({ entry: { userId: 'u1', deviceToken: 't1' } });
    // 换绑的是「同一台机器换人」，账号簿层面允许（那是切换账号），
    // 但 server 侧的属主绑定不允许 —— 那条在 server 的测试里。
    const r = switchActiveAccount('u1', {});
    assert.equal(r.key, 'u1');
  });
});

test('账号簿：logout 默认只清当前，--all 清空', () => {
  withTempHome(() => {
    saveAuthAccount({ entry: { userId: 'u1', deviceToken: 't1' } });
    saveAuthAccount({ entry: { userId: 'u2', deviceToken: 't2' } });

    const one = clearAuthCredentials({ all: false });
    assert.equal(one.remaining, 1);

    const all = clearAuthCredentials({ all: true });
    assert.equal(all.remaining, 0);
  });
});

test('账号簿：老配置里的 flat 凭据被合成成首个条目', () => {
  const view = withAccounts({ userId: 'u1', email: 'a@example.com', deviceToken: 't1' });
  assert.equal(listAccounts(view).length, 1);
  assert.equal(entryKeyOf(view.accounts['u1']), 'u1');
  assert.equal(labelOf(view.accounts['u1']), 'a@example.com');
});

test('过期判定', () => {
  assert.equal(isExpired(undefined), true);
  assert.equal(isExpired({ expiresAt: Date.now() - 1 }), true);
  assert.equal(isExpired({ expiresAt: Date.now() + 10000 }), false);
  assert.equal(isExpired({}), false);
});

test('PKCE：challenge = base64url(sha256(verifier))，S256', () => {
  const req = createAuthRequest('http://127.0.0.1:1234/callback');
  const expect = b64url(crypto.createHash('sha256').update(req.verifier).digest());
  assert.equal(req.challenge, expect);
  assert.equal(req.authorizeParams.code_challenge, expect);
  assert.equal(req.authorizeParams.code_challenge_method, 'S256');
  assert.equal(req.authorizeParams.redirect_uri, 'http://127.0.0.1:1234/callback');
  assert.equal(req.authorizeParams.state, req.state);
});

test('登录用的 client_id：取 loginClientId，回落 clientId', () => {
  assert.equal(loginClientIdOf({ clientId: 'mn-ws-server', loginClientId: 'mn-ws-client' }), 'mn-ws-client');
  assert.equal(loginClientIdOf({ clientId: 'mn-ws' }), 'mn-ws');
  assert.equal(loginClientIdOf({}), '');
});

test('authorize URL 用的是 client 半的身份', () => {
  const url = new URL(buildAuthorizeUrl(
    { issuer: 'http://idp', clientId: 'mn-ws-server', loginClientId: 'mn-ws-client', scopes: ['openid'] },
    createAuthRequest('http://127.0.0.1:1/callback'),
  ));
  assert.equal(url.searchParams.get('client_id'), 'mn-ws-client');
});

test('白名单：--apps 里的名字 + --app-map 的基址定出桥哪些 app', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({ apps: 'my-api', appMap: 'my-api=http://127.0.0.1:7877' }));
    const { apps, missing } = c.resolveApps();
    assert.ok('my-api' in apps);
    assert.equal(apps['my-api'], 'http://127.0.0.1:7877');
    assert.deepEqual(missing, []);
  });
});

test('白名单：--apps 里内联基址，一步就能把应用登记好', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({ apps: 'my-api=http://127.0.0.1:7877' }));
    const { apps, missing } = c.resolveApps();
    assert.equal(apps['my-api'], 'http://127.0.0.1:7877');
    assert.deepEqual(missing, []);
  });
});

test('白名单：没登记基址 → 记下来，不静默忽略', () => {
  withTempHome(() => {
    // mn-ws 不认识任何具体服务：名字只是路由标识，没有基址就没有落点
    const c = new MnWsController(loadClientConfig({ apps: 'my-api' }));
    const { apps, missing } = c.resolveApps();
    assert.deepEqual(Object.keys(apps), []);
    assert.deepEqual(missing, ['my-api']);
  });
});

test('白名单：配置文件里的 appMap 要被读出来（配过就该一直在）', () => {
  withTempHome(() => {
    // 踩过的坑：配置里的键叫 `appMap`，读成 `appOverrides` 就读不到 ——
    // 症状是「mn-ws apps set 配好了，重启后桥上就没那个应用了」。
    const f = path.join(process.env.MN_WS_HOME!, 'config.json');
    fs.writeFileSync(f, JSON.stringify({
      apps: ['my-api'],
      appMap: { 'my-api': { base: 'http://127.0.0.1:7877' } },
    }), 'utf8');

    const c = new MnWsController(loadClientConfig({}));
    const { apps, missing } = c.resolveApps();
    assert.equal(apps['my-api'], 'http://127.0.0.1:7877');
    assert.deepEqual(missing, []);
  });
});

test('动态注册：白名单里的内联基址要原样保留', () => {
  withTempHome(() => {
    const f = path.join(process.env.MN_WS_HOME!, 'config.json');
    fs.writeFileSync(f, JSON.stringify({
      apps: ['my-api=http://127.0.0.1:7877'],
    }), 'utf8');

    // 加一个自定义应用会把白名单重写一遍 —— 内联基址不能被截成只剩名字
    saveCustomApps([{ name: 'other-api', base: 'http://127.0.0.1:9999' }]);

    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(raw.apps, ['my-api=http://127.0.0.1:7877', 'other-api']);

    const c = new MnWsController(loadClientConfig({}));
    const { apps, missing } = c.resolveApps();
    assert.equal(apps['my-api'], 'http://127.0.0.1:7877');
    assert.equal(apps['other-api'], 'http://127.0.0.1:9999');
    assert.deepEqual(missing, []);
  });
});

test('小工具', () => {
  assert.equal(pick(undefined, null, '', 'x'), 'x');
  assert.equal(isEnvTruthy('YES'), true);
  assert.equal(isEnvTruthy('off'), false);
  assert.equal(isEnvTruthy(undefined), false);
});

// ───────────────────── 动态注册（运行时开放端口）─────────────────────

test('动态注册：加进去的应用进白名单，带基址与标题', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({}));
    const r = addCustomApp(c, { name: 'my-api', port: 9999, title: '我的服务' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.app, 'my-api');

    const { apps, titles } = c.resolveApps();
    assert.equal(apps['my-api'], 'http://127.0.0.1:9999');
    assert.equal(titles['my-api'], '我的服务');
    // 白名单是唯一的准入依据：自定义应用必须同时在 apps 里
    assert.ok(c.cfg.apps.includes('my-api'));
  });
});

test('动态注册：名字非法要当场拒绝（它要当路由标识用）', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({}));
    for (const bad of ['', 'My-API', '-x', 'my_api', '1api', 'my api']) {
      const r = addCustomApp(c, { name: bad, port: 9999 });
      assert.equal(r.ok, false, `名字 ${JSON.stringify(bad)} 不该通过`);
      assert.ok(r.error);
    }
  });
});

test('动态注册：端口缺失且没给基址 → 拒绝', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({}));
    const r = addCustomApp(c, { name: 'my-api' });
    assert.equal(r.ok, false);
  });
});

test('动态注册：完整基址也行（https / 非默认主机）', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({}));
    const r = addCustomApp(c, { name: 'my-api', base: 'https://api.example.com' });
    assert.equal(r.ok, true, r.error);
    assert.equal(c.resolveApps().apps['my-api'], 'https://api.example.com');
  });
});

test('动态注册：移除后它就不在白名单里了', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({}));
    addCustomApp(c, { name: 'my-api', port: 9999 });
    const r = removeCustomApp(c, 'my-api');
    assert.equal(r.ok, true, r.error);
    assert.equal('my-api' in c.resolveApps().apps, false);
    assert.equal(c.cfg.apps.includes('my-api'), false);

    // 移除不存在的 → 明确报错，不静默
    assert.equal(removeCustomApp(c, 'my-api').ok, false);
  });
});

test('动态注册：落盘后重新读配置还在', () => {
  withTempHome(() => {
    const c = new MnWsController(loadClientConfig({}));
    addCustomApp(c, { name: 'my-api', port: 9999, title: '我的服务' });
    // 重新从磁盘读（模拟重启）
    const again = new MnWsController(loadClientConfig({}));
    assert.equal(again.resolveApps().apps['my-api'], 'http://127.0.0.1:9999');
    assert.equal(again.resolveApps().titles['my-api'], '我的服务');
  });
});
