// 随包 skill 的发现、分组、安装与导出。
//
// 与 templates/ 的关系：templates 是「生成器要物化的项目模板」；
// assets/ 是「随 nx-nx 包分发给 agent 的 skill 文档」。两者都是包内资产，互不依赖。
//
// 多 skill 约定（见脚手架 B04）：
//   - 主 skill 名 = package.json.name（nx-nx），默认 install 装它
//   - groups.json 是便捷聚合而非第二事实源；缺失/损坏时降级为目录扫描
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { badInput, blocked, notFound, specError } from '../errors/index.js';
import { assertSafeName } from '../paths.js';
import { asAbsolutePath, type AbsolutePath } from '../brand.js';
import {
  hasInstallHooks,
  runPreInstall,
  runPostInstall,
  diffRendered,
  copyRendered,
} from './install.js';
import { emit, loadHookConfig } from './bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function assetsDir(): AbsolutePath {
  // MN_WS_ASSETS 为测试/隔离入口（调用时读取）：指向临时资产树以验证降级路径
  const override = process.env.MN_WS_ASSETS;
  const candidates = [
    ...(override ? [override] : []),
    join(HERE, '..', '..', '..', 'assets'),
    join(process.cwd(), 'assets'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return asAbsolutePath(dir);
  }
  throw specError('找不到 assets/ 目录（尝试过: ' + candidates.join(', ') + ')');
}

export const defaultSkillsDir = (): AbsolutePath =>
  asAbsolutePath(join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills'));

export interface GroupSpec {
  skills: string[];
  summary?: string;
}

export interface GroupsManifest {
  groups: Record<string, GroupSpec>;
  defaultGroup: string | null;
  source: 'manifest' | 'assets-dirs';
  warning?: string;
}

// 读 groups.json；文件缺失或 JSON 损坏 → 降级为目录扫描（每个含 SKILL.md 的
// 目录自成一个 group）。schema 错误不降级——那是作者打包事故，必须显眼。
export async function loadGroups(): Promise<GroupsManifest> {
  const root = assetsDir();
  const file = join(root, 'groups.json');

  if (!existsSync(file)) {
    return { groups: await scanGroups(root), defaultGroup: null, source: 'assets-dirs' };
  }

  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return { groups: await scanGroups(root), defaultGroup: null, source: 'assets-dirs' };
  }

  let parsed: { groups?: Record<string, GroupSpec> };
  try {
    parsed = JSON.parse(raw) as { groups?: Record<string, GroupSpec> };
  } catch {
    return {
      groups: await scanGroups(root),
      defaultGroup: null,
      source: 'assets-dirs',
      warning: 'groups.json 不是合法 JSON，已降级为目录扫描',
    };
  }

  const groups = parsed.groups;
  if (!groups || typeof groups !== 'object') {
    throw specError('groups.json schema 错误：缺少 groups 对象');
  }
  for (const [key, g] of Object.entries(groups)) {
    if (!g || !Array.isArray(g.skills) || !g.skills.length) {
      throw specError(`groups.json 的 group "${key}" 缺少非空 skills 数组`);
    }
    for (const s of g.skills) {
      if (typeof s !== 'string' || !/^[\w.-]+$/.test(s)) {
        throw specError(`groups.json 的 group "${key}" 含非法 skill 名: ${String(s)}`);
      }
    }
  }

  return { groups, defaultGroup: 'mn-ws' in groups ? 'mn-ws' : null, source: 'manifest' };
}

async function scanGroups(root: AbsolutePath): Promise<Record<string, GroupSpec>> {
  const out: Record<string, GroupSpec> = {};
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md'))) {
      out[e.name] = { skills: [e.name] };
    }
  }
  return out;
}

export async function bundledSkillNames(): Promise<string[]> {
  const root = assetsDir();
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface InstallResult {
  status: 'ok' | 'conflict' | 'skipped';
  name: string;
  path: string;
  files: number;
  installed?: boolean;
  replaced?: boolean;
}

// 无副作用地查看某个 skill 的安装状态：目标是否存在、有哪些差异文件。
// installOne 与 installGroup 的预检共用它——预检绝不能边查边装。
export async function inspectInstall(
  name: unknown,
  toRoot?: string,
): Promise<{ name: string; path: string; changed: string[]; dstExisted: boolean }> {
  const safe = assertSafeName(name, 'skill 名');
  const src = join(assetsDir(), safe);
  if (!existsSync(join(src, 'SKILL.md'))) {
    const available = await bundledSkillNames();
    throw notFound(`未找到内置 skill: ${safe}（可用: ${available || '(无)'}）`);
  }
  const dst = join(toRoot || defaultSkillsDir(), safe);
  const changed = await diffTrees(src, dst);
  return { name: safe, path: dst, changed, dstExisted: existsSync(dst) };
}

// 安装单个 skill。
//   无安装钩子：字节级 diff → skipped / conflict / 整树复制（旧路径）
//   有安装钩子：preInstall（抛错 = 拒绝安装；返回 vars = 动态字符串）→
//     渲染后 diff → skipped / conflict → 渲染复制 → postInstall
// 无差异时即使给了 force 也返回 skipped（没有要做的事）。
export async function installOne(
  name: unknown,
  opts: { to?: string; force?: boolean } = {},
): Promise<InstallResult> {
  const safe = assertSafeName(name, 'skill 名');
  const src = join(assetsDir(), safe);
  if (!existsSync(join(src, 'SKILL.md'))) {
    const available = await bundledSkillNames();
    throw notFound(`未找到内置 skill: ${safe}（可用: ${available || '(无)'}）`);
  }
  const skillsRoot = opts.to || defaultSkillsDir();
  const dst = join(skillsRoot, safe);

  if (!hasInstallHooks(safe)) {
    const changed = await diffTrees(src, dst);
    if (!changed.length) return { status: 'skipped', name: safe, path: dst, files: 0 };
    const dstExisted = existsSync(dst);
    if (dstExisted && !opts.force) {
      return { status: 'conflict', name: safe, path: dst, files: changed.length };
    }
    if (dstExisted) await fsp.rm(dst, { recursive: true, force: true });
    await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });
    return {
      status: 'ok',
      name: safe,
      path: dst,
      files: changed.length,
      installed: !dstExisted,
      replaced: dstExisted,
    };
  }

  const { config, vars } = await runPreInstall(safe, {
    skillsRoot,
    dst,
    force: !!opts.force,
  });

  const changed = await diffRendered(src, dst, vars);
  if (!changed.length) return { status: 'skipped', name: safe, path: dst, files: 0 };
  const dstExisted = existsSync(dst);
  if (dstExisted && !opts.force) {
    return { status: 'conflict', name: safe, path: dst, files: changed.length };
  }
  if (dstExisted) await fsp.rm(dst, { recursive: true, force: true });
  const files = await copyRendered(src, dst, vars);
  await runPostInstall(
    safe,
    { skillsRoot, dst, force: !!opts.force },
    config,
    vars,
  );
  return {
    status: 'ok',
    name: safe,
    path: dst,
    files,
    installed: !dstExisted,
    replaced: dstExisted,
  };
}

export interface GroupInstallResult {
  status: 'ok' | 'conflict';
  group: string;
  skills: InstallResult[];
}

// 一键装一组。任一冲突 → 整体 conflict 且不落任何文件（让用户决策后 --force 整组重来）。
export async function installGroup(
  group: unknown,
  opts: { to?: string; force?: boolean } = {},
): Promise<GroupInstallResult> {
  const key = String(group || '').trim();
  const manifest = await loadGroups();
  const spec = manifest.groups[key];
  if (!spec) {
    throw badInput(`未知 group: ${key}（可用: ${Object.keys(manifest.groups).join(', ')}）`);
  }
  return installNames([...new Set(spec.skills)], key, opts);
}

// 一键装全部内置 skill（--all）。事实源是 assets/ 目录扫描，与 groups.json 无关——
// 即使清单漏登记某个 skill，--all 也不会漏掉它。
export async function installAll(
  opts: { to?: string; force?: boolean } = {},
): Promise<GroupInstallResult> {
  const names = await bundledSkillNames();
  if (!names.length) throw specError('assets/ 内没有可安装的 skill（找不到任何 SKILL.md）');
  return installNames(names, '*', opts);
}

// 批量安装共用实现：无副作用预检 → 任一冲突整体不落文件 → 逐项安装。
// label 为 group key；'*' 表示 --all（渲染时据此换措辞）。
async function installNames(
  names: string[],
  label: string,
  opts: { to?: string; force?: boolean },
): Promise<GroupInstallResult> {
  // 无副作用预检：任一项「已存在且有差异」→ 整体 conflict，不落任何文件。
  // 有安装钩子的 skill：先跑 preInstall 取 vars（pre 抛错 = 整批拒绝），
  // 再按渲染结果比较；无钩子走字节 diff。
  if (!opts.force) {
    const conflicts: InstallResult[] = [];
    for (const n of names) {
      const targetDir = join(opts.to || defaultSkillsDir(), n);
      let changed: string[];
      if (hasInstallHooks(n)) {
        const srcN = join(assetsDir(), n);
        const cfg = await loadHookConfig(srcN);
        const pre = await emit('skill:pre-install', n, cfg, {
          cwd: process.cwd(),
          skillsDir: opts.to || defaultSkillsDir(),
          sourceDir: srcN,
          targetDir,
          force: false,
          vars: {},
        });
        if (pre.blocked) throw blocked(pre.reason || '安装被 hook 阻断');
        changed = await diffRendered(srcN, targetDir, pre.vars);
      } else {
        changed = (await inspectInstall(n, opts.to)).changed;
      }
      if (existsSync(targetDir) && changed.length) {
        conflicts.push({ status: 'conflict', name: n, path: targetDir, files: changed.length });
      }
    }
    if (conflicts.length) return { status: 'conflict', group: label, skills: conflicts };
  }

  const skills = [];
  for (const n of names) skills.push(await installOne(n, { to: opts.to, force: opts.force }));
  return { status: 'ok', group: label, skills };
}

// 对比两棵树，返回内容不同的相对路径（安装器据此判断跳过 / 冲突 / 覆盖）。
async function diffTrees(src: string, dst: string, rel = ''): Promise<string[]> {
  const changed: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return changed;
  }
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      changed.push(...(await diffTrees(s, d, rel ? rel + '/' + e.name : e.name)));
    } else if (e.isFile()) {
      let same = false;
      try {
        const [a, b] = await Promise.all([fsp.readFile(s), fsp.readFile(d)]);
        same = a.equals(b);
      } catch {
        same = false;
      }
      if (!same) changed.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return changed;
}
