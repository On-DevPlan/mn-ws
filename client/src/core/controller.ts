import { KNOWN_APPS } from 'mn-ws-server/apps';

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
  /** 端口反查不到应用名时的提示 */
  unknownPorts: number[];
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
   * **白名单说了算**：只有 --apps / --ports / --app-map 列出的应用才会被桥。
   * 端口探测只用来显示状态，**绝不因为「扫到端口在监听」就自动开桥** ——
   * 扫到就开桥等于把整台机器暴露出去。
   */
  resolveApps(): ResolvedApps {
    const wanted = new Set(this.cfg.apps || []);
    const unknownPorts: number[] = [];

    // 按端口反查应用名
    for (const port of this.cfg.ports || []) {
      const hit = Object.entries(KNOWN_APPS).find(([, info]) => info.port === port);
      if (hit) wanted.add(hit[0]);
      else unknownPorts.push(port);
    }

    const apps: Record<string, string> = {};
    for (const app of wanted) {
      const base =
        (this.cfg.appOverrides[app] && this.cfg.appOverrides[app].base) ||
        (KNOWN_APPS[app] ? `http://127.0.0.1:${KNOWN_APPS[app].port}` : '');
      if (base) apps[app] = base;
    }
    return { apps, unknownPorts };
  }

  /** 起桥。已连着就不重复起。 */
  start(): { started: boolean; apps: string[]; reason?: string } {
    const { apps, unknownPorts } = this.resolveApps();
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
      apps,
      onStatus: (s) => { this.lastStatus = s; },
    });
    this.client.start();
    return { started: true, apps: names, reason: unknownPorts.length ? `端口未在已知服务表：${unknownPorts.join(', ')}` : undefined };
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
