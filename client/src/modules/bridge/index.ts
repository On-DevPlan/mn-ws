// bridge 模块：**client 半的管理面**。
//
// 这一域回答的是「这台桥现在什么状态、能桥什么、桥给谁了」：
//   - status    连没连、注册了哪些 app、重连到第几次
//   - apps      本机登记了哪些应用（探测端口存活）+ 白名单是哪些
//   - whitelist 改白名单（**白名单说了算**：探测到端口在监听 ≠ 可以桥）
//   - catalog   拉远端 server 半的元信息目录（哪些能路由）
//   - start/stop 启停桥
//
// 每一项都同时暴露为 CLI 与 HTTP —— 面板上的按钮与命令行是同一份声明。
import { defineAction } from '../../runtime/types/action.js';
import { defineModule } from '../../runtime/types/module.js';
import { getController } from '../../core/controller.js';
import { parseApps, parseAppMap } from '../../core/config.js';
import {
  bridgeStatus, bridgeApps, setWhitelist, remoteCatalog, addCustomApp, removeCustomApp, reopenFavorite,
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
        apps: { type: 'string', hint: '逗号分隔的应用名（可带基址），如 my-api,other=http://127.0.0.1:7999' },
        'app-map': { type: 'string', hint: '显式基址，如 my-api=http://127.0.0.1:7999' },
      },
    })(
      async (ctx) => {
        const parsed = parseApps(ctx.apps);
        const appMap = {
          ...parsed.overrides,
          ...parseAppMap(String(ctx['app-map'] || '')),
        };
        return setWhitelist(getController(), { apps: parsed.names, appMap });
      },
      (r) => renderWhitelist(r),
    ),

    defineAction({
      id: 'bridge.apps.add',
      cli: ['apps', 'add'],
      http: ['POST', '/api/bridge/apps/add'],
      summary: '动态登记一个应用（本机的任意 HTTP 服务）：名字 + 端口',
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
      id: 'bridge.apps.reopen',
      cli: ['apps', 'reopen'],
      http: ['POST', '/api/bridge/apps/reopen'],
      summary: '重新暴露一个用过的应用（按名字；名字与端口从常用记录里取）',
      args: [{ name: 'name', required: true }],
    })(
      (ctx) => reopenFavorite(getController(), String(ctx.name || '')),
      (r) => (r.ok ? `已重新暴露 ${r.app}（${r.base}）· 现在可桥：${r.apps.join(', ')}` : `重开失败：${r.error}`),
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
        // 按 PC 分组：多台机器同时接入时，先看「哪台电脑」，再看它上面的应用
        if (r.pcs && r.pcs.length) {
          const lines = [`元信息目录（${r.pcs.length} 台 PC）`];
          for (const pc of r.pcs) {
            lines.push(`  ${pc.name}  (${pc.bridgeId})`);
            if (!pc.apps.length) {
              lines.push('    （这台电脑没有登记应用）');
              continue;
            }
            for (const a of pc.apps) {
              const mark = a.active ? '' : '   ← 路由在别的 PC 上';
              lines.push(`    ${a.app.padEnd(12)} ${String(a.port ?? '—').padEnd(7)} ${a.title}${mark}`);
            }
          }
          return lines.join('\n');
        }
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
      summary: '停桥（断开 server 半，本机的 HTTP 服务不受影响）',
    })(
      () => getController().stop(),
      (r) => (r.stopped ? '已停桥' : `未停：${r.reason || ''}`),
    ),

    defineAction({
      id: 'bridge.known',
      cli: ['apps', 'known'],
      http: ['GET', '/api/bridge/known'],
      summary: '列出**已登记**的应用（名字 / 基址 / 标题）',
    })(
      () => {
        const c = getController();
        const seen = new Map<string, { app: string; base: string; title: string }>();
        for (const [name, o] of Object.entries(c.cfg.appOverrides || {})) {
          if (o && o.base) seen.set(name, { app: name, base: o.base, title: o.title || name });
        }
        for (const a of c.cfg.customApps || []) {
          seen.set(a.name, { app: a.name, base: a.base, title: a.title || a.name });
        }
        return [...seen.values()];
      },
      (rows) => rows.map((r) => `  ${r.app.padEnd(12)} ${r.base.padEnd(24)} ${r.title}`).join('\n'),
    ),
  ],
});
