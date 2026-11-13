import { WsBridgeClient, type BridgeStatus } from './bridge.js';
import { SessionManager } from './session.js';
import { loadClientConfig, type ClientConfig } from './config.js';

/**
 * client 半的**运行时**：桥连接 + 登录态的**唯一归属**。
 *
 * 为什么要有这么一个中心：桥是**长驻**的东西，而模板的 action 模型是
 * 「每个命令是一次调用」。面板上的「启停桥」「改白名单」要操作的是
 * **同一个正在跑的连接**，所以必须有一个进程内的单例来持有它 ——
 * 否则每个 action 各建各的连接，面板上点「断开」断的也不是那条真的在跑的。
 *
 * CLI 与面板共用这一个实例：命令行起的桥，面板里看得到状态、改得了白名单。
 */

/** 白名单解析的结果。 */
export interface ResolvedApps {
  /** app -> base */
  apps: Record<string, string>;
  /** app -> 标题（登记时给了才有；没给就用名字兜底） */
  titles: Record<string, string>;
  /** 在白名单里、但**没有登记基址**的应用名 —— 它们被跳过了 */
  missing: string[];
}

export class MnWsController {
  cfg: ClientConfig;
  session: SessionManager;
  client: WsBridgeClient | null = null;
  lastStatus: BridgeStatus = { state: 'idle' };
  /** 面板实际监听的端口（运行时才知道，回调地址要用它） */
  panelPort = 0;

  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
    this.session = new SessionManager(cfg);
  }

  /**
   * 解析白名单 → { app -> base }。
   *
   * **白名单说了算**：只有被登记（--apps / 配置文件 / 面板动态注册）且
   * 在白名单里的应用才会被桥。端口探测只用来显示状态，
   * **绝不因为「扫到端口在监听」就自动开桥** —— 扫到就开桥等于把
   * 整台机器暴露出去。
   *
   * 两类登记合成一份：
   *   ① 显式基址（--apps name=base / --app-map / 配置文件 appOverrides）
   *   ② 面板上动态登记的条目（customApps）—— 登记即进白名单
   *
   * mn-ws **不认识任何具体服务**：这里没有内置应用表，名字只是路由标识。
   * 白名单里有、但没登记基址的应用会被跳过，并在 `missing` 里报出来 ——
   * 静默跳过会让人以为「桥了但不通」。
   */
  resolveApps(): ResolvedApps {
    const wanted = new Set(this.cfg.apps || []);

    // 登记表：名字 -> {base, title}
    const registry = new Map<string, { base: string; title?: string }>();

    for (const [name, o] of Object.entries(this.cfg.appOverrides || {})) {
      if (o && o.base) registry.set(name, { base: o.base, title: o.title });
    }
    // 面板上动态登记的条目：登记即进白名单。
    // ⚠️ 「是不是自定义」与「标题是什么」是两件事，不能共用一个 Map ——
    //    没有标题的自定义应用曾因此被当成「不在表里」而整个丢掉。
    for (const a of this.cfg.customApps || []) {
      wanted.add(a.name);
      registry.set(a.name, { base: a.base, title: a.title });
    }

    const apps: Record<string, string> = {};
    const titles: Record<string, string> = {};
    const missing: string[] = [];
    for (const app of wanted) {
      const hit = registry.get(app);
      if (!hit || !hit.base) {
        missing.push(app);
        continue;
      }
      apps[app] = hit.base;
      if (hit.title) titles[app] = hit.title;
    }
    return { apps, titles, missing };
  }

  /** 起桥。已连着就不重复起。 */
  start(): { started: boolean; apps: string[]; reason?: string } {
    const { apps, titles, missing } = this.resolveApps();
    const names = Object.keys(apps);
    if (!names.length) {
      return { started: false, apps: [], reason: '白名单为空 —— 一个都不桥（用 --apps 指定）' };
    }
    if (this.client) {
      return { started: false, apps: names, reason: '桥已在运行' };
    }
    this.client = new WsBridgeClient({
      url: this.cfg.url,
      token: this.session.credential() || this.cfg.token,
      bridgeId: this.cfg.clientId,
      // 电脑名：多台 PC 同时接入时，远端目录按它分组。
      // deviceName 缺省就是本机主机名（os.hostname()）。
      pcName: this.cfg.deviceName,
      // 标题一起带上：远端目录里，标题是认出「这个端口上跑的是什么」的唯一线索，
      // 而只有 client 半知道它叫什么。
      apps: Object.fromEntries(
        Object.entries(apps).map(([name, base]) => [name, { base, title: titles[name] }]),
      ),
      onStatus: (s) => { this.lastStatus = s; },
    });
    this.client.start();
    return {
      started: true,
      apps: names,
      reason: missing.length
        ? `这些应用没有登记基址、已跳过：${missing.join(', ')}`
        : undefined,
    };
  }

  /** 停桥。 */
  stop(): { stopped: boolean; reason?: string } {
    if (!this.client) return { stopped: false, reason: '桥没在跑' };
    this.client.stop();
    this.client = null;
    this.lastStatus = { state: 'stopped' };
    return { stopped: true };
  }

  /** 当前状态快照（面板与 CLI 共用同一份）。 */
  status(): BridgeStatus & { url: string; apps: string[]; clientId: string } {
    return {
      ...this.lastStatus,
      url: this.cfg.url,
      apps: Object.keys(this.resolveApps().apps),
      clientId: this.cfg.clientId,
    };
  }
}

let singleton: MnWsController | null = null;

/**
 * 取进程内的控制器单例。
 *
 * 第一次调用时按当前配置创建；之后一直复用 ——
 * 面板上的操作要作用在**正在跑的那条桥**上，不能各建各的。
 */
export function getController(overrides: Record<string, unknown> = {}): MnWsController {
  if (!singleton) {
    singleton = new MnWsController(loadClientConfig(overrides));
  }
  return singleton;
}

/** 重新读配置并替换单例（改了配置之后用）。 */
export function resetController(overrides: Record<string, unknown> = {}): MnWsController {
  singleton = new MnWsController(loadClientConfig(overrides));
  return singleton;
}
