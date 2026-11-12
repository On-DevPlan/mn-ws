// skill get：把指定 skill 的文档导出给外部 agent，并顺手幂等安装。
// 与 skills.ts 分开：一个管安装/分组，一个管文档读取，各自不超限。
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { badInput, notFound } from '../errors/index.js';
import { assertSafeName } from '../paths.js';
import { assetsDir, defaultSkillsDir, installOne } from './index.js';

const SENTINEL = '# --- begin skill content (do not modify this line) ---';

export interface SkillGetResult {
  skillName: string;
  ref: string;
  content: string;
  contentBytes: number;
  install: Awaited<ReturnType<typeof installOne>>;
}

export async function listRefs(name: unknown): Promise<string[]> {
  const safe = assertSafeName(name, 'skill 名');
  const dir = join(assetsDir(), safe, 'references');
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  } catch {
    return [];
  }
}

// 解析 ref 到 skill 内的相对路径：
//   空 / SKILL.md → SKILL.md；裸名 → references/<裸名>.md（再退到 <裸名>.md）；
//   含 / 的显式路径去掉 ./ 前缀。任何 '..' 或越界一律拒绝。
async function resolveRefPath(name: string, ref: string): Promise<string> {
  let rel: string | null;
  if (!ref || ref === 'SKILL.md') {
    rel = 'SKILL.md';
  } else if (ref.includes('/')) {
    rel = ref.replace(/^\.\//, '');
  } else {
    const a = join(assetsDir(), name, 'references', `${ref}.md`);
    const b = join(assetsDir(), name, `${ref}.md`);
    rel = existsSync(a) ? join('references', `${ref}.md`) : existsSync(b) ? `${ref}.md` : null;
    if (!rel) {
      const refs = await listRefs(name);
      throw badInput(`未知 ref: ${ref}（可用: SKILL.md, ${refs.join(', ')}）`);
    }
  }

  if (rel.split(/[\\/]/).includes('..')) {
    throw badInput(`ref 路径不允许包含 '..': ${ref}`);
  }
  const base = join(assetsDir(), name);
  const resolved = join(base, rel);
  if (!resolved.startsWith(base)) throw badInput(`ref 越界: ${ref}`);
  // 文档路径随包跨平台分发，统一用正斜杠
  return rel.replace(/\\/g, '/');
}

export async function getSkill(
  name: unknown,
  opts: { ref?: string; to?: string; force?: boolean } = {},
): Promise<SkillGetResult> {
  const safe = assertSafeName(name, 'skill 名');
  if (!existsSync(join(assetsDir(), safe, 'SKILL.md'))) {
    throw notFound(`未找到内置 skill: ${safe}`);
  }

  const rel = await resolveRefPath(safe, opts.ref || '');
  const file = join(assetsDir(), safe, rel);
  let content: string;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    throw notFound(`未找到 skill 文档: ${safe}/${rel}`);
  }

  const install = await installOne(safe, { to: opts.to || defaultSkillsDir(), force: opts.force });
  return { skillName: safe, ref: rel, content, contentBytes: Buffer.byteLength(content, 'utf8'), install };
}

// 人读模式的前缀：sentinel 行给 agent 明确的复制边界。
export function skillGetPrefix(name: string, ref: string): string {
  return [
    `# === ${name} skill context ===`,
    `# 以下内容来自 ${name} skill 的 ${ref || 'SKILL.md'}。`,
    `# 建议：把 sentinel 行之后的全文复制到 .claude/skills/${name}/ 下，便于后续会话复用。`,
    SENTINEL,
    '',
  ].join('\n');
}

export function installStatusLine(r: Awaited<ReturnType<typeof installOne>>): string {
  if (r.status === 'conflict') {
    return `-- install 状态 --\n冲突: ${r.path}（${r.files} 个文件不同；确认覆盖加 --force）`;
  }
  if (r.status === 'skipped') return `-- install 状态 --\n已是最新: ${r.path}`;
  const verb = r.replaced ? '已替换' : '已安装';
  return `-- install 状态 --\n${verb}: ${r.path}（${r.files} 个文件）`;
}
