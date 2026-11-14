// 通用 CLI 运行器：解析 argv → 匹配 action → 校验 → 执行 → 渲染。
//
// 改造前这里是一个 400 行的 switch，每条命令要在 BOOL_FLAGS / helpText / case /
// renderXxx 四处重复登记。现在命令表、help 文本、参数校验全部由 action 声明派生，
// 新增命令只需在所属模块的 actions 里加一条。
import { readFileSync } from 'node:fs';
import {
  APP_NAME,
  DEFAULT_PORT,
  STORE_ENV,
  storePathFromEnv,
} from '../core/paths.js';
import { toErrorPayload, exitCodeOf, badInput } from '../core/errors/index.js';
import { ACTIONS } from './registry.js';
import {
  cliPathsOf,
  argSpecsOf,
  flagSpecsOf,
  booleanFlagNames,
  applySpec,
} from './spec.js';
import {
  commandEntry,
  helpEntries,
  renderHelp,
  printCommandHelp,
  type CommandEntry,
} from './help.js';
import type { ActionShape, ArgEntry, FlagSpec, TransportMeta } from './types/action.js';

const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

// 命令的统一结构（BUILTINS 与模块 action 的公共形状；字段按需可选）
interface AnyCommand {
  id: string;
  module?: string;
  cli?: ActionShape['cli'];
  http?: readonly [string, string] | null;
  summary?: string;
  args?: readonly ArgEntry[];
  flags?: Record<string, FlagSpec>;
  openFlags?: boolean;
  run?: (ctx: Record<string, unknown>, meta?: TransportMeta) => unknown;
  render?: (result: unknown, ctx?: Record<string, unknown>) => unknown;
}

// ---- 平台命令：不属于任何功能域，不参与 action 表 ----
// 用与 action 相同的形状声明，好让参数解析与 help 生成保持同一套逻辑。
const BUILTINS: AnyCommand[] = [
  {
    id: 'serve',
    cli: ['serve'],
    summary: '启动桥接与 Web 面板（默认 :7777；--port N 改面板端口；--no-open 不开浏览器；--apps 指定白名单）',
    flags: {
      port: { type: 'number', default: DEFAULT_PORT },
      url: { type: 'string', hint: 'server 半的 ws:// 地址' },
      token: { type: 'string', hint: '注册门禁（静态门禁或设备令牌）' },
      apps: { type: 'string', hint: '白名单：逗号分隔的应用名，可带基址，如 my-api=http://127.0.0.1:9999' },
      'app-map': { type: 'string', hint: '显式基址，如 my-api=http://127.0.0.1:9999' },
      'device-name': { type: 'string', hint: '桥的显示名' },
      'log-level': { type: 'string', hint: 'debug | info | warn | error' },
      'no-open': { type: 'boolean' },
    },
    run: (ctx) => cmdServe(ctx as Record<string, unknown>),
  },
  {
    id: 'doctor',
    cli: ['doctor'],
    summary: '环境自检：端口占用 / 鉴权 / 应用可达性 / server 连通性',
    flags: {
      url: { type: 'string', hint: 'server 半的 ws:// 地址' },
      token: { type: 'string', hint: '注册门禁' },
      'no-open': { type: 'boolean' },
    },
    run: (ctx) => cmdDoctor(ctx as Record<string, unknown>),
  },
  {
    id: 'help',
    cli: ['help'],
    summary: '显示帮助（可跟模块名或命令组，如 mn-ws help home）',
    args: [{ name: 'topic', required: false }],
    // 走标准 action 形态：--json 时 emit 会序列化返回的条目，
    // 于是 `help --json` 输出的是可解析的命令表而非帮助文本
    run: (ctx) => helpEntries(ctx.topic, ALL_COMMANDS.map(commandEntry)),
    render: (entries, ctx) => renderHelp(entries as CommandEntry[], ctx?.topic),
  },
  // render 让 `nx-nx version` 输出裸版本号（脚本里可 `V=$(nx-nx version)`），
  // 而 `--json` 仍走序列化，保持机器可读
  {
    id: 'version',
    cli: ['version'],
    summary: '显示版本',
    run: () => VERSION,
    render: (v) => v,
  },
];

export const ALL_COMMANDS: AnyCommand[] = [
  ...BUILTINS,
  ...(ACTIONS as unknown as AnyCommand[]),
];

// ---- 参数解析 ----

interface SplitGlobals {
  rest: string[];
  json: boolean;
  store?: string;
}

// 全局 flag 先摘掉：它们可以出现在 argv 任意位置，不属于任何 action 的声明。
function splitGlobals(argv: string[]): SplitGlobals {
  const rest: string[] = [];
  let json = false;
  let store: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--store') {
      store = argv[++i];
      continue;
    }
    if (a.startsWith('--store=')) {
      store = a.slice('--store='.length);
      continue;
    }
    rest.push(a);
  }
  return { rest, json, store };
}

interface CommandHit {
  cmd: AnyCommand;
  path: string[];
  rest: string[];
}

// 匹配命令：把声明路径与 argv 前缀逐 token 比较，选最长匹配。
//
// 逐 token 比较（而非只取「开头连续的非 flag token」）是必需的——有些命令路径
// 本身就含 flag，例如 `apps set --list` 是「列出白名单」而非「设置」。
// 最长优先则让 ['apps','set','add'] 压过 ['apps','set']，子命令与别名因此共存。
export function resolveCommand(argv: string[]): CommandHit | null {
  let best: { cmd: AnyCommand; path: string[] } | null = null;
  let bestLen = -1;
  for (const cmd of ALL_COMMANDS) {
    for (const path of cliPathsOf(cmd as { cli: ActionShape['cli'] })) {
      if (path.length > argv.length || path.length <= bestLen) continue;
      if (path.every((seg, i) => seg === argv[i])) {
        best = { cmd, path };
        bestLen = path.length;
      }
    }
  }
  return best ? { ...best, rest: argv.slice(bestLen) } : null;
}

interface ParsedRest {
  positionals: string[];
  flags: Record<string, unknown>;
}

// 解析剩余 token。布尔 flag 不吞下一个 token —— 否则 `apps add --force demo`
// 会把 force 解析成字符串 'demo'，而 demo 本该是位置参数。
function parseRest(rest: string[], cmd: AnyCommand): ParsedRest {
  const bools = booleanFlagNames(cmd);
  const positionals: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 2) {
      setFlag(flags, a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (!bools.has(key) && next !== undefined && !next.startsWith('--')) {
      setFlag(flags, key, next);
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

// 同名 flag 出现多次 → 收成数组（`--set a=1 --set b=2`）。
// 不这么做的话后者会静默覆盖前者——`--set` / `--hidden` 这类可重复 flag 全靠它。
function setFlag(flags: Record<string, unknown>, key: string, value: unknown): void {
  const prev = flags[key];
  if (prev === undefined) flags[key] = value;
  else if (Array.isArray(prev)) prev.push(value);
  else flags[key] = [prev, value];
}

// 位置参数按声明顺序映射成具名输入；末尾声明 { rest: true } 的收集剩余全部
function mapPositionals(positionals: string[], cmd: AnyCommand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const spec of argSpecsOf(cmd)) {
    if (spec.rest) {
      out[spec.name] = positionals.slice(i);
      i = positionals.length;
      break;
    }
    if (positionals[i] !== undefined) out[spec.name] = positionals[i];
    i++;
  }
  if (i < positionals.length) {
    throw badInput(`多余的参数: ${positionals.slice(i).join(' ')}（用法见 ${APP_NAME} help）`);
  }
  return out;
}

// 未知 flag 直接报错——`--fiile` 这类拼写错误应该立刻被指出来，而不是被静默忽略。
//
// 例外：声明了 openFlags 的 action 表示「可选项由数据驱动」（模板的 option
// schema），声明期无法枚举。这类 action 放行未知 flag，由 action 自己在 run 里
// 按 schema 取白名单——否则用户永远传不进模板选项。
function assertKnownFlags(flags: Record<string, unknown>, cmd: AnyCommand): void {
  if (cmd.openFlags) return;
  const known = new Set(flagSpecsOf(cmd).map((f) => f.name));
  for (const k of Object.keys(flags)) {
    if (!known.has(k)) throw badInput(`未知参数 --${k}（用法见 ${APP_NAME} help）`);
  }
}

// ---- 输出 ----

// render 拿到 (data, ctx)，可以是 async——有些渲染需要补一点上下文才能标注
// （例如候选清单要标出哪一项是「当前」），而 `--json` 必须保持纯数据的旧形状。
async function emit(cmd: AnyCommand, data: unknown, json: boolean, ctx: unknown): Promise<void> {
  // 无返回值的命令（help / serve 这类）不该打印任何东西：落进 JSON.stringify(undefined)
  // 会打出字面量 "undefined"，让 `help --json` 的 stdout 不再是合法 JSON。
  if (data === undefined && !cmd.render) return;

  if (json) {
    if (data === undefined) return;
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd.render) {
    const text = await cmd.render(data, ctx as Record<string, unknown> | undefined);
    if (text !== undefined && text !== null && text !== '') console.log(text);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

// 失败一律 exit 1；--json 下输出可解析的错误对象。
// 注意 error 保持字符串（历史契约），code 是新增字段——agent 可据此分支，
// 老消费方按字符串匹配「用法:」「未设置」「不存在」仍然可用。
function fail(err: unknown, json: boolean): void {
  const p = toErrorPayload(err);
  if (json) {
    const payload: Record<string, unknown> = { ok: false, error: p.message, code: p.code };
    if (p.details !== undefined) payload.details = p.details;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error('错误: ' + p.message);
  }
  process.exitCode = exitCodeOf(p.code);
}

/**
 * 起桥 + 起面板。
 *
 * 这是 mn-ws client 半的**常态运行形态**：一条命令既把本机的 HTTP 服务桥出去，
 * 又把管理面板开在本机。两者在同一个进程里 —— 面板上的「启停桥 / 改白名单」
 * 操作的就是这条正在跑的桥。
 *
 * 面板端口**运行时可选**（--port），且与 server 半的 7777 是两回事：
 * 面板只在本机监听，server 半在公网机上，两边不冲突。
 */
async function cmdServe(ctx: Record<string, unknown>): Promise<void> {
  const { startServer } = await import('./server.js');
  const { openBrowser } = await import('../core/open.js');
  const { autoOpenEnabled, resolvePortConflict, describeOccupant } = await import('../core/serve-port.js');
  const { getController } = await import('../core/controller.js');
  const host = '127.0.0.1';
  const desiredPort = Number(ctx.port || DEFAULT_PORT);
  // --no-open 与 NX_SERVE_NO_OPEN 都看这里：后者是所有 nx-xx 项目共享的开关
  const canOpen = autoOpenEnabled(ctx['no-open'] === true);

  // ── 桥 ──
  const controller = getController(ctx);
  // 复用 CLI 已存的登录态：有有效设备令牌就直接进入登录态（面板不用再登一遍）
  const adopted = controller.session.adoptFromAccountStore();
  const started = controller.start();
  if (started.started) {
    console.log(`桥: 已连接 ${controller.cfg.url}（白名单: ${started.apps.join(', ') || '空'}）`);
  } else {
    console.log(`桥: 未启动 —— ${started.reason || '未知原因'}`);
  }
  if (adopted) {
    const who = controller.session.snapshot();
    console.log(`登录: 复用 CLI 登录态（${who.nickname || who.email || who.userId || '已登录'}）`);
  } else {
    console.log('登录: 尚未登录 —— 面板会显示登录页（也可先跑 mn-ws auth login）');
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ port: desiredPort, host, controller });
  } catch (err) {
    if (!err || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;

    // 端口被占：先问一句「上面跑的是不是我」。
    const decision = await resolvePortConflict(desiredPort, APP_NAME, host);

    if (decision.action === 'reuse') {
      // 自己的面板已经在跑：不重复启动，直接把浏览器指过去。
      const addr = `http://${host}:${desiredPort}`;
      console.log(APP_NAME + ' 已在运行：' + addr);
      console.log('直接打开浏览器（不重复启动）；如需重启请先停掉旧实例');
      if (canOpen) openBrowser(addr);
      return;
    }

    // 别人占的：顺延到下一个空闲端口，再起自己的面板。
    console.log(
      `端口 ${desiredPort} 已被占用（占用者: ${describeOccupant(decision.occupant)}），改用 ${decision.port}`
    );
    server = await startServer({ port: decision.port, host, controller });
  }

  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound ? bound.port : desiredPort;
  const addr = `http://${host}:${actualPort}`;
  // 面板端口要告诉会话管理器：OIDC 回调落在面板自己的 /callback 上
  controller.panelPort = actualPort;

  console.log(APP_NAME + ' v' + VERSION);
  console.log(`面板:   ${addr}`);
  console.log(`存储:   ${storePathFromEnv()}`);
  console.log('CLI:    ' + APP_NAME + ' help（每个按钮都有对应命令，agent 可加 --json）');
  console.log('按 Ctrl+C 停止');

  if (canOpen) openBrowser(addr);

  const shutdown = () => {
    console.log('\n正在停止...');
    controller.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 环境自检：端口 / 鉴权 / 应用可达性 / server 连通性。 */
async function cmdDoctor(ctx: Record<string, unknown>): Promise<void> {
  const { getController } = await import('../core/controller.js');
  const { loadClientConfig } = await import('../core/config.js');
  const { isPortFree, scanApps } = await import('mn-ws-server/apps');

  const cfg = loadClientConfig(ctx);
  const controller = getController(ctx);

  console.log(`mn-ws doctor  v${VERSION}`);
  console.log('');

  console.log('端口');
  const port = Number(ctx.port || cfg.webPort);
  const free = await isPortFree(port, '127.0.0.1');
  console.log(free.free ? `  面板 :${port}  空闲` : `  面板 :${port}  已被占用`);

  console.log('');
  console.log('鉴权');
  const sess = controller.session.snapshot();
  if (sess.loggedIn) {
    console.log(`  ✓ 统一登录（${sess.via === 'cli' ? '复用 CLI 登录态' : '面板登录'}）：${sess.nickname || sess.email || sess.userId}`);
  } else if (cfg.token) {
    console.log('  ✓ 静态门禁 token（共享密钥，等价全量访问）');
  } else {
    console.log('  ! 未登录：无注册令牌，桥会连不上');
  }

  console.log('');
  console.log('可桥接的应用');
  const { apps, titles, missing } = controller.resolveApps();
  if (!Object.keys(apps).length) {
    console.log('  ! 白名单为空 —— 一个都不桥（用 --apps 指定）');
  } else {
    const list = await scanApps({
      host: '127.0.0.1',
      entries: Object.entries(apps).map(([app, base]) => ({ app, base, title: titles[app] })),
    });
    for (const a of list) {
      console.log(`  ${a.app.padEnd(10)} ${String(a.port ?? '—').padEnd(7)} ${a.alive ? '✓ 在监听' : '✗ 未运行'}  ${a.base || ''}`);
    }
  }
  if (missing.length) {
    // 静默跳过会让人以为「桥了但不通」—— 要说出来，并说清怎么登记
    console.log(`  ! 这些应用没有登记基址、已跳过：${missing.join(', ')}`);
    console.log('    登记方式：--apps 名字=http://127.0.0.1:端口，或在面板上「动态注册」');
  }

  console.log('');
  console.log('server 连通性');
  try {
    const res = await fetch(`${cfg.serverHttp.replace(/\/+$/, '')}/health`);
    const j = (await res.json()) as { ok?: boolean; service?: string; bridges?: number };
    console.log(`  ✓ ${cfg.serverHttp}/health → ${j.service || 'ok'} · 桥接数 ${j.bridges ?? 0}`);
  } catch (e) {
    console.log(`  ✗ ${cfg.serverHttp}/health → ${(e as Error).message}`);
  }
}

// ---- 主入口 ----

export async function runCli(argv: string[]): Promise<void> {
  const { rest, json, store } = splitGlobals(argv);
  if (store) process.env[STORE_ENV] = store;

  const hit = resolveCommand(rest);

  // 无参数、无全局 flag → **启动**（起桥 + 起面板）。
  //
  // 为什么不是「显示帮助」：`mn-ws` 这个命令存在的意义就是「把它跑起来」。
  // 想看帮助就 `mn-ws help` —— 显式一点，别让「敲个名字」有两种意思。
  if (!hit) {
    if (!rest.length) {
      await cmdServe({});
      return;
    }
    // 裸命令 + flag（`mn-ws --apps my-api`）→ 等同 `mn-ws serve --apps my-api`。
    //
    // 为什么单独认这一种：serve 的 flag 全是**运行时选择**（端口、白名单、
    // server 地址），用户不想先敲一遍 `serve` 再摆 flag。
    if (rest[0]!.startsWith('--')) {
      const serve = ALL_COMMANDS.find((c) => c.id === 'serve');
      if (serve) {
        const { positionals, flags } = parseRest(rest, serve);
        const input = { ...mapPositionals(positionals, serve), ...flags };
        const ctx = applySpec(serve as unknown as ActionShape, input);
        await serve.run?.(ctx as Record<string, unknown>, { transport: 'cli' });
        return;
      }
    }
    console.error(`未知命令: ${rest.join(' ')}`);
    console.error('运行 ' + APP_NAME + ' help 查看用法');
    process.exitCode = 1;
    return;
  }

  const { cmd, rest: tail } = hit;

  try {
    if (tail.includes('--help')) {
      printCommandHelp(cmd);
      return;
    }

    const { positionals, flags } = parseRest(tail, cmd);
    assertKnownFlags(flags, cmd);
    const input = { ...mapPositionals(positionals, cmd), ...flags };
    const ctx = applySpec(cmd as unknown as ActionShape, input);
    const data = await cmd.run?.(ctx as Record<string, unknown>, { transport: 'cli' });
    await emit(cmd, data, json, ctx as Record<string, unknown>);
  } catch (err) {
    fail(err, json);
  }
}

// ---- 直接运行本文件时进入 CLI ----
// dev：`node --import tsx src/runtime/cli.ts ...`（改码即跑，无需构建）；
// prod：bin 调用 runCli，argv[1] 是 bin → 此处不重复执行；被 import 时不触发。
import { pathToFileURL } from 'node:url';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
