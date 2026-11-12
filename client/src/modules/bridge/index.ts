// bridge 模块：**client 半的管理面**。
//
// 这一域回答的是「这台桥现在什么状态、能桥什么、桥给谁了」：
//   - status    连没连、注册了哪些 app、重连到第几次
//   - apps      本机有哪些 nx 服务在跑（探测端口存活）+ 白名单是哪些
//   - whitelist 改白名单（**白名单说了算**：探测到端口在监听 ≠ 可以桥）
//   - catalog   拉远端 server 半的元信息目录（哪些能路由）
//   - start/stop 启停桥
//
// 每一项都同时暴露为 CLI 与 HTTP —— 面板上的按钮与命令行是同一份声明。
import { scanApps, KNOWN_APPS } from 'mn-ws-server/apps';

import { defineAction } from '../../runtime/types/action.js';
import { defineModule } from '../../runtime/types/module.js';
import { getController } from '../../core/controller.js';
import { parseApps } from '../../core/config.js';
import {
  bridgeStatus, bridgeApps, setWhitelist, remoteCatalog, addCustomApp, removeCustomApp,
  renderStatus, renderApps, renderWhitelist,
  type BridgeStatusView, type BridgeAppsView, type CatalogView,
} from './service.js';

export default defineModule({
  id: 'bridge',
  title: '桥接',
  order: 2,
  actions: [
    defineAction({
      id: 'bridge.status',
      cli: ['status'],
      http: ['GET', '/api/bridge/status'],
      summary: '桥接状态：连没连、注册了哪些 app、当前凭据是谁',
    })(
      (): BridgeStatusView => bridgeStatus(getController()),
      (r) => renderStatus(r),
    ),

    defineAction({
      id: 'bridge.apps',
      cli: ['apps'],
      http: ['GET', '/api/bridge/apps'],
      summary: '列出可桥接的应用：白名单 + 本地端口存活探测',
    })(
      (): Promise<BridgeAppsView> => bridgeApps(getController()),
      (r) => renderApps(r),
    ),

    defineAction({
      id: 'bridge.whitelist.set',
      cli: ['apps', 'set'],
      http: ['POST', '/api/bridge/whitelist'],
      summary: '设置白名单（只有列出的应用会被桥；不给就一个都不桥）',
      flags: {
        apps: { type: 'string', hint: '逗号分隔的应用名，如 nx-kv,nx-rh' },
        ports: { type: 'string', hint: '逗号分隔的本地端口（从已知表反查应用名）' },
        'app-map': { type: 'string', hint: '显式基址，如 nx-kv=http://127.0.0.1:7999' },
      },
    })(
      async (ctx) => {
        const apps = parseApps(ctx.apps);
        const ports = String(ctx.ports || '')
          .split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
        const appMap = String(ctx['app-map'] || '')
          .split(',').map((x) => x.trim()).filter(Boolean)
          .map((pair) => {
            const eq = pair.indexOf('=');
            return eq <= 0 ? null : [pair.slice(0, eq).trim(), { base: pair.slice(eq + 1).trim() }] as const;
          }).filter((x): x is readonly [string, { base: string }] => x !== null);
        return setWhitelist(getController(), { apps, ports, appMap: Object.fromEntries(appMap) });
      },
      (r) => renderWhitelist(r),
    ),

    defineAction({
      id: 'bridge.apps.add',
      cli: ['apps', 'add'],
      http: ['POST', '/api/bridge/apps/add'],
      summary: '动态注册一个自定义应用（不在已知表里的本机服务）：名字 + 端口',
      args: [{ name: 'name', required: true }],
      flags: {
        port: { type: 'number', hint: '本机端口（默认 127.0.0.1）' },
        base: { type: 'string', hint: '完整基址（给了就优先用它）' },
        title: { type: 'string', hint: '显示名（远端目录里给人看）' },
      },
    })(
      (ctx) => addCustomApp(getController(), {
        name: String(ctx.name || ''),
        port: typeof ctx.port === 'number' ? ctx.port : undefined,
        base: ctx.base ? String(ctx.base) : undefined,
        title: ctx.title ? String(ctx.title) : undefined,
      }),
      (r) => (r.ok ? `已注册 ${r.app}（${r.base}）· 现在可桥：${r.apps.join(', ')}` : `注册失败：${r.error}`),
    ),

    defineAction({
      id: 'bridge.apps.remove',
      cli: ['apps', 'remove'],
      http: ['POST', '/api/bridge/apps/remove'],
      summary: '移除一个自定义应用',
      args: [{ name: 'name', required: true }],
    })(
      (ctx) => removeCustomApp(getController(), String(ctx.name || '')),
      (r) => (r.ok ? `已移除 ${r.removed} · 现在可桥：${r.apps.join(', ') || '（空）'}` : `移除失败：${r.error}`),
    ),

    defineAction({
      id: 'bridge.catalog',
      cli: ['catalog'],
      http: ['GET', '/api/bridge/catalog'],
      summary: '拉远端 server 半的元信息目录（哪些能路由）',
    })(
      async (): Promise<CatalogView> => remoteCatalog(getController()),
      (r) => {
        if (!r.ok) return `拉目录失败：${r.error}`;
        const lines = [`元信息目录（${r.apps.length} 个可路由）`];
        for (const a of r.apps) lines.push(`  ${a.app.padEnd(10)} ${String(a.port ?? '—').padEnd(7)} ${a.title}`);
        return lines.join('\n');
      },
    ),

    defineAction({
      id: 'bridge.start',
      cli: ['bridge', 'start'],
      http: ['POST', '/api/bridge/start'],
      summary: '起桥（连 server 半并注册白名单里的应用）',
    })(
      () => getController().start(),
      (r) => (r.started ? `已起桥：${r.apps.join(', ')}` : `未起桥：${r.reason || ''}`),
    ),

    defineAction({
      id: 'bridge.stop',
      cli: ['bridge', 'stop'],
      http: ['POST', '/api/bridge/stop'],
      summary: '停桥（断开 server 半，本机 nx 服务不受影响）',
    })(
      () => getController().stop(),
      (r) => (r.stopped ? '已停桥' : `未停：${r.reason || ''}`),
    ),

    defineAction({
      id: 'bridge.known',
      cli: ['apps', 'known'],
      http: ['GET', '/api/bridge/known'],
      summary: '列出已知的 nx 服务与它们的默认端口',
    })(
      () => Object.entries(KNOWN_APPS).map(([app, info]) => ({ app, port: info.port, title: info.title })),
      (rows) => rows.map((r) => `  ${r.app.padEnd(10)} ${String(r.port).padEnd(7)} ${r.title}`).join('\n'),
    ),
  ],
});
