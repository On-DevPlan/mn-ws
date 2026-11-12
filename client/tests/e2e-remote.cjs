'use strict';

/**
 * 远端验收：站在「远端 HTTP 客户端」的角度，走**已部署**的 mn-ws server
 * 打本机被桥接的应用。
 *
 * 与单测的区别：单测在进程内把 server 和 client 都拉起来；
 * 这里打的是**公网上那台 server 半**（真实网络、真实容器、真实 WS 握手），
 * 验的是「部署完了到底能不能用」。
 *
 * 用法：
 *   set MN_WS_E2E_URL=http://1.94.101.189:7777
 *   set MN_WS_E2E_TOKEN=<门禁 token>
 *   set MN_WS_E2E_APP=my-api            # 被桥的应用，默认 my-api
 *   node tests/e2e-remote.cjs
 *
 * 令牌从环境变量读，**不进命令行** —— 命令行会进 shell 历史。
 *
 * ⚠️ 必须是 .cjs：client 包的 package.json 写着 "type": "module"，
 *    .js 会被当 ESM 加载，而这个脚本是 CommonJS（require）。
 *    （写成 .js 时 `pnpm test:e2e` 直接报 "require is not defined"——
 *      这个错一直藏着，因为没人真跑过它。）
 */

const http = require('node:http');

const BASE = (process.env.MN_WS_E2E_URL || 'http://1.94.101.189:7777').replace(/\/+$/, '');
const TOKEN = process.env.MN_WS_E2E_TOKEN || '';
const APP = process.env.MN_WS_E2E_APP || 'my-api';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}${extra ? '  ' + extra : ''}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}${extra ? '  ' + extra : ''}\n`);
  }
}

function req(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const r = http.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'X-Mn-Ws-Token': TOKEN, ...headers },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('timeout', () => r.destroy(new Error('超时')));
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  if (!TOKEN) {
    process.stderr.write('缺少 MN_WS_E2E_TOKEN（门禁 token）\n');
    process.exit(2);
  }
  process.stdout.write(`远端验收  ${BASE}  app=${APP}\n\n`);

  const health = await req('/health');
  check('/health 可达', health.status === 200, `status=${health.status}`);

  const cat = await req('/api/catalog');
  check('元信息目录可拉取', cat.status === 200, `status=${cat.status}`);
  let catJson = null;
  try { catJson = JSON.parse(cat.body); } catch { /* ignore */ }
  const apps = (catJson && catJson.apps) || [];
  check(`目录里有 ${APP}`, apps.some((a) => a.app === APP),
    JSON.stringify(apps.map((a) => a.app)));

  // ① 路径前缀路由
  const viaPrefix = await req(`/${APP}/api/ping`);
  check('路径前缀路由到应用', viaPrefix.status === 200,
    `status=${viaPrefix.status} body=${viaPrefix.body.slice(0, 120)}`);

  // ② 请求头路由（路径原样）
  const viaHeader = await req('/api/ping', { 'X-Mn-Ws-App': APP });
  check('请求头路由到应用', viaHeader.status === 200,
    `status=${viaHeader.status} body=${viaHeader.body.slice(0, 120)}`);

  // 两条路径结果一致 —— /api/ping 带 ts，去掉时间戳再比
  const stripTs = (b) => b.replace(/"ts":\d+/g, '"ts":0');
  check('两条路由路径结果一致', stripTs(viaPrefix.body) === stripTs(viaHeader.body),
    `${stripTs(viaPrefix.body)} vs ${stripTs(viaHeader.body)}`);

  // ③ 无凭据 → 401
  const noAuth = await new Promise((resolve) => {
    const u = new URL(`${BASE}/${APP}/api/ping`);
    const r = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.end();
  });
  check('无 L1 凭据 → 401', noAuth.status === 401, `status=${noAuth.status}`);

  // ④ 未知应用 → 404
  const unknown = await req('/no-such-app/api/x');
  check('未知应用 → 404 unknown_app', unknown.status === 404 && /unknown_app/.test(unknown.body),
    `status=${unknown.status} body=${unknown.body.slice(0, 80)}`);

  // ⑤ L3 透传：带 Authorization 头，业务接口应由**应用自己**的鉴权处理，
  //    而不是被桥拦下 —— 说明桥没改写也没吞掉凭据
  const withAuth = await req(`/${APP}/api/file`, { Authorization: 'Bearer e2e-probe-token' });
  check('Authorization 原样透传给应用（不占 L1 的头）',
    withAuth.status === 400 && /未登录|登录已过期|unauthorized/i.test(withAuth.body || ''),
    `status=${withAuth.status} body=${(withAuth.body || '').slice(0, 120)}`);

  process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stderr.write(`崩溃：${e && e.message}\n`);
  process.exit(1);
});
