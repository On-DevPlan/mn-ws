// JSON 存储：用户目录下的单一数据文件，Web 表单与 agent CLI 共同读写。
//
// 设计要点：
// - 原子写（临时文件 + rename），进程中断不会损坏数据
// - 进程内缓存 + mtime 失效检测：外部进程（如 CLI）改写后，Web 服务侧能立刻看到
// - 自己写入后主动刷新缓存 mtime，避免「自己触发自己重读」
//
// 这是**通用**存储：结构由 initialState() 决定。项目要加字段就改它，
// normalize 会自动给老数据补默认值——不需要写迁移脚本。
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePathFromEnv } from './paths.js';

// 项目自己的存储结构。改这里即可扩展，老数据由 normalize 自动补齐。
export interface NavGroup {
  title: string;
  /** 组内页面 id（数组顺序 = 头部展开列表里的顺序） */
  views: string[];
}

export interface Settings {
  /** 头部导航分组：数组顺序 = 显示顺序；一个页面最多属于一个组 */
  navGroups: NavGroup[];
  /** 被隐藏的页面 id：头部不显示入口，`#/id` 直达仍可用 */
  navHidden: string[];
  /** 平铺区的显示顺序（页面 id 数组；没列进去的按页面自身顺序跟在后面） */
  navOrder: string[];
  /** 色彩主题：light（浅色）/ dark（深色）/ auto（跟随系统） */
  theme: string;
  [k: string]: unknown;
}

export interface StoreState {
  version: number;
  settings: Settings;
  [k: string]: unknown;
}

export function initialState(): StoreState {
  return {
    version: 1,
    settings: { navGroups: [], navHidden: [], navOrder: [], theme: 'light' },
  };
}

let cache: StoreState | null = null;
let cacheMtime = -1;

export function newId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function loadStore(explicitPath?: string): Promise<StoreState> {
  const p = explicitPath || storePathFromEnv();
  try {
    const st = await fsp.stat(p);
    if (cache && cacheMtime === st.mtimeMs) return cache;
    const raw = await fsp.readFile(p, 'utf8');
    cache = normalize(JSON.parse(raw));
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    // 文件不存在或损坏：返回空结构（首次运行 / 允许外部修复后恢复）
    cache = normalize(null);
    cacheMtime = -1;
    return cache;
  }
}

export async function saveStore(next: StoreState, explicitPath?: string): Promise<StoreState> {
  const p = explicitPath || storePathFromEnv();
  const data = normalize(next);
  await fsp.mkdir(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  cache = data;
  try {
    cacheMtime = (await fsp.stat(p)).mtimeMs;
  } catch {
    cacheMtime = -1;
  }
  return data;
}

// 读-改-写事务：fn 直接修改传入的深拷贝 store；fn 抛错则不落盘。
// 这条语义很重要——半个事务写进磁盘比不写更糟。
export async function mutateStore<T>(
  fn: (s: StoreState) => T,
  explicitPath?: string,
): Promise<T | StoreState> {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = fn(cur);
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}

// 归一化：以 initialState() 为底，把已有数据合并上去。
// 新增字段自动获得默认值，因此**不需要迁移脚本**——
// 老 store.json 缺的键会在这里补齐，多出来的键也原样保留。
export function normalize(data: unknown): StoreState {
  const base = initialState();
  if (!data || typeof data !== 'object') return base;
  const d = data as Record<string, unknown>;

  base.version = typeof d.version === 'number' ? d.version : base.version;
  if (base.settings && typeof base.settings === 'object') {
    base.settings = { ...base.settings, ...((d.settings as Record<string, unknown>) || {}) };
  }

  // 其余顶层键：base 里声明过的按 base 的形状兜底，没声明过的原样带过来
  for (const [k, v] of Object.entries(d)) {
    if (k === 'version' || k === 'settings') continue;
    if (Array.isArray(v)) {
      base[k] = v;
    } else if (v && typeof v === 'object') {
      const existing = base[k];
      base[k] = { ...((existing as object) || {}), ...(v as object) };
    } else {
      base[k] = v;
    }
  }
  return base;
}

// 测试与调试用：清掉进程内缓存，强制下次重读
export function clearCache(): void {
  cache = null;
  cacheMtime = -1;
}
