// skill 安装与 hook 总线的桥接，以及带动态字符串的渲染复制。
//
// 安装生命周期映射为总线上的两个开放事件：
//   skill:pre-install   复制前；handler 可 block（拒绝安装）或返回 vars（动态字符串）
//   skill:post-install  复制后；做额外动作
// 配置来自被安装 skill 源目录的 hooks.json；配置文件与 install/ 脚本目录
// 属于安装期机制，不复制进目标。
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assetsDir } from './index.js';
import { isTextPath } from './text-util.js';
import { blocked } from '../errors/index.js';
import {
  emit,
  loadHookConfig,
  HOOK_CONFIG_FILE,
  type HookConfig,
} from './bus.js';

export function skillSourceDir(name: string): string {
  return join(assetsDir(), name);
}

// 有安装钩子 = 源目录含 hooks.json
export function hasInstallHooks(name: string): boolean {
  return existsSync(join(skillSourceDir(name), HOOK_CONFIG_FILE));
}

interface InstallAddress {
  skillsRoot: string;
  dst: string;
  force: boolean;
}

function baseFields(name: string, a: InstallAddress, vars: Record<string, string>) {
  const src = skillSourceDir(name);
  return {
    cwd: process.cwd(),
    skillsDir: a.skillsRoot,
    sourceDir: src,
    targetDir: a.dst,
    force: a.force,
    vars,
  };
}

// pre-install：返回配置与聚合后的 vars；被 block 则抛 blocked（拒绝安装）。
export async function runPreInstall(
  name: string,
  addr: InstallAddress,
): Promise<{ config: HookConfig | null; vars: Record<string, string> }> {
  const src = skillSourceDir(name);
  const config = await loadHookConfig(src);
  const out = await emit('skill:pre-install', name, config, baseFields(name, addr, {}));
  if (out.blocked) throw blocked(out.reason || '安装被 hook 阻断');
  return { config, vars: out.vars };
}

// post-install：复制完成后触发（block 语义不适用，忽略）。
export async function runPostInstall(
  name: string,
  addr: InstallAddress,
  config: HookConfig | null,
  vars: Record<string, string>,
): Promise<void> {
  await emit('skill:post-install', name, config, baseFields(name, addr, vars));
}

// 安装期资产不进目标：hooks.json 与 install/ 目录。
const SKIP_FILES = new Set<string>([HOOK_CONFIG_FILE]);
const SKIP_DIRS = new Set<string>(['install']);

// 动态字符串渲染：只替换 vars 中存在的占位符，其余原样（宽松——
// skill 文档可能含示例花括号，不该被动态机制误伤）。
export function renderVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([\w-]+)\}\}/g, (m, key: string) =>
    key in vars ? vars[key] ?? m : m
  );
}

// 遍历源树（跳过安装期资产），逐文件比较「渲染后的源」与目标，返回差异清单。
export async function diffRendered(
  src: string,
  dst: string,
  vars: Record<string, string>,
  rel = '',
): Promise<string[]> {
  const changed: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return changed;
  }

  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    if (e.isFile() && SKIP_FILES.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      changed.push(...(await diffRendered(s, d, vars, childRel)));
    } else if (e.isFile()) {
      let same = false;
      try {
        const raw = await fsp.readFile(s);
        const target = await fsp.readFile(d);
        same = isTextPath(childRel)
          ? renderVars(raw.toString('utf8'), vars) === target.toString('utf8')
          : raw.equals(target);
      } catch {
        same = false;
      }
      if (!same) changed.push(childRel);
    }
  }
  return changed;
}

// 复制源树到目标：文本文件渲染 vars，二进制原样；安装期资产不复制。
// 返回写入的文件数。
export async function copyRendered(
  src: string,
  dst: string,
  vars: Record<string, string>,
  rel = '',
): Promise<number> {
  let count = 0;
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    if (e.isFile() && SKIP_FILES.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      count += await copyRendered(s, d, vars, childRel);
    } else if (e.isFile()) {
      await fsp.mkdir(dirname(d), { recursive: true });
      if (isTextPath(childRel)) {
        const text = await fsp.readFile(s, 'utf8');
        await fsp.writeFile(d, renderVars(text, vars), 'utf8');
      } else {
        await fsp.copyFile(s, d);
      }
      count++;
    }
  }
  return count;
}
