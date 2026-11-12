'use strict';

/**
 * 本地 Web 面板：`npx mn-ws client web`。
 *
 * 只绑 127.0.0.1 —— 这是本机诊断面，不是对外服务。面板里能看的：
 *   · 桥接连接状态（连没连、注册了哪些 app、被谁顶替过）
 *   · **哪些可以桥接**：逐个 app 探测本地端口存活，并标出是否在白名单里
 *   · 最近请求日志（app / 方法 / 路径 / 状态码 / 耗时）
 *   · 一个最小 API 试验台：选 app + 填路径 → 直接打过去看响应
 */

const http = require('node:http');
const { URL } = require('url');

const { scanApps } = require('../lib/apps');

/**
 * 面板默认端口 —— 与 server 半的默认端口一致（7777）。
 *
 * 单独提出来导出，是为了能在单测里钉死这个值：
 * 端口散在多个文件里时，「改了一处忘了另一处」是这类项目最常见的低级坑
 * （见 design.md 坑位清单 K21）。
 */
const DEFAULT_WEB_PORT = 7777;

/**
 * 启动本地面板。
 *
 * @param {object} opts
 * @param {number} [opts.port]        面板端口（默认 7777）
 * @param {string} [opts.host]        绑定地址（默认 127.0.0.1）
 * @param {object} opts.apps          { app -> base } 白名单（可桥接的）
 * @param {object} [opts.appOverrides]
 * @param {object} [opts.client]      WsBridgeClient（可空）
 * @param {object} [opts.logger]
 * @returns {Promise<{port:number, close: () => Promise<void>}>}
 */
async function startWebPanel(opts = {}) {
  // 用 ?? 而不是 ||：port=0 是「让系统随机给一个端口」的正经用法，
  // 被 || 吃掉会变成 7777 —— 测试里想用随机端口就会莫名其妙去抢 7777。
  const port = opts.port === undefined || opts.port === null ? DEFAULT_WEB_PORT : Number(opts.port);
  const host = opts.host || '127.0.0.1';
  const apps = opts.apps || {};
  const overrides = opts.appOverrides || {};
  const client = opts.client || null;
  const logger = opts.logger || null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (code, obj, type = 'application/json; charset=utf-8') => {
      const payload = type.startsWith('application/json') ? JSON.stringify(obj) : obj;
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(payload);
    };

    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderHtml());
        return;
      }

      // 可桥接清单：白名单 + 端口存活探测
      if (url.pathname === '/api/apps') {
        const names = Object.keys(apps);
        const list = await scanApps({ host: '127.0.0.1', apps: names, overrides });
        send(200, { ok: true, apps: list, configured: names });
        return;
      }

      // 桥接状态
      if (url.pathname === '/api/status') {
        send(200, {
          ok: true,
          state: client ? client.state : 'idle',
          bridgeId: client ? client.bridgeId : '',
          url: client ? client.url : '',
          attempts: client ? client.attempts : 0,
          configured: Object.keys(apps),
        });
        return;
      }

      // 最小 API 试验台：直打本地端口，不经过 server 半
      if (url.pathname === '/api/probe' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = raw.length ? JSON.parse(raw) : {};
        const app = String(body.app || '');
        const base = apps[app];
        if (!base) { send(400, { ok: false, error: 'app_not_configured' }); return; }
        const target = new URL(String(body.path || '/'), base);
        const out = await probeHttp(target, body.method || 'GET', body.raw || '');
        send(200, { ok: true, ...out });
        return;
      }

      send(404, { ok: false, error: 'not_found' });
    } catch (e) {
      send(500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  await new Promise((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve_());
  });

  if (logger) logger.info('本地面板已启动', { url: `http://${host}:${port}/` });

  return {
    port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function probeHttp(target, method, raw) {
  return new Promise((resolve) => {
    const mod = target.protocol === 'https:' ? require('node:https') : require('node:http');
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method,
      path: target.pathname + target.search,
      headers: raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {},
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString('utf8'); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: body.slice(0, 8000),
        truncated: body.length > 8000,
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (raw) req.write(raw);
    req.end();
  });
}

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mn-ws 桥接面板</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;margin:0;padding:20px;background:#f6f6f7;color:#1c1c1e}
 @media(prefers-color-scheme:dark){body{background:#161618;color:#f2f2f7}}
 h1{font-size:18px;margin:0 0 4px} .sub{opacity:.6;font-size:12px;margin-bottom:16px}
 .card{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 @media(prefers-color-scheme:dark){.card{background:#1f1f22;box-shadow:none}}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.25)}
 th{font-weight:600;opacity:.7;font-size:12px}
 .ok{color:#1a9e46;font-weight:600} .bad{color:#d13438;font-weight:600}
 input,select,textarea,button{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}
 textarea{width:100%;min-height:60px;font-family:ui-monospace,monospace;font-size:12px}
 button{background:#0a84ff;color:#fff;border:0;cursor:pointer;font-weight:600}
 pre{background:rgba(128,128,128,.12);padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:300px}
 .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
 code{font-family:ui-monospace,monospace}
</style></head><body>
<h1>mn-ws 桥接面板</h1>
<div class="sub">本机诊断面 · 只监听 127.0.0.1 · 不会把任何服务暴露到公网</div>

<div class="card">
  <div class="row"><b>桥接状态</b><span id="st"></span></div>
  <div class="sub" id="stDetail"></div>
</div>

<div class="card">
  <b>哪些可以桥接</b>
  <div class="sub">白名单里的 app 逐个探测本地端口；端口在监听 = 可桥。</div>
  <table id="apps"><thead><tr><th>应用</th><th>本地端口</th><th>存活</th></tr></thead><tbody></tbody></table>
</div>

<div class="card">
  <b>API 试验台</b>
  <div class="sub">直打本地端口，不经过公网 server 半。</div>
  <div class="row">
    <select id="sel"></select>
    <input id="path" value="/api/ping" size="28">
    <button id="go">发送</button>
  </div>
  <div class="row"><input id="body" placeholder='请求体（JSON，可空）' style="flex:1"></div>
  <pre id="out">—</pre>
</div>

<script>
const $ = (id) => document.getElementById(id);
async function tick(){
  try{
    const st = await (await fetch('/api/status')).json();
    $('st').textContent = st.state;
    $('st').className = (st.state==='registered'||st.state==='connected')?'ok':'bad';
    $('stDetail').textContent = 'server: '+(st.url||'—')+' · 白名单: '+(st.configured||[]).join(', ')+' · 重连次数: '+st.attempts;
    const a = await (await fetch('/api/apps')).json();
    const tb = $('apps').querySelector('tbody'); tb.innerHTML='';
    (a.apps||[]).forEach(x=>{
      const tr=document.createElement('tr');
      tr.innerHTML='<td><code>'+x.app+'</code> '+x.title+'</td><td>'+(x.port||'—')+'</td><td class="'+(x.alive?'ok':'bad')+'">'+(x.alive?'在监听':'未运行')+'</td>';
      tb.appendChild(tr);
    });
    const sel=$('sel'), cur=sel.value; sel.innerHTML='';
    (a.apps||[]).forEach(x=>{ const o=document.createElement('option'); o.value=x.app; o.textContent=x.app; sel.appendChild(o); });
    if(cur) sel.value=cur;
  }catch(e){ $('st').textContent='面板取数失败: '+e.message; }
}
$('go').onclick = async ()=>{
  const body=$('body').value;
  $('out').textContent='请求中…';
  const r = await (await fetch('/api/probe',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({app:$('sel').value,path:$('path').value,raw:body})})).json();
  $('out').textContent = r.ok ? ('HTTP '+r.status+'\n\n'+JSON.stringify(r.headers||{},null,2)+'\n\n'+r.body) : (r.error||'失败');
};
tick(); setInterval(tick, 3000);
</script></body></html>`;
}

module.exports = { startWebPanel, DEFAULT_WEB_PORT };
