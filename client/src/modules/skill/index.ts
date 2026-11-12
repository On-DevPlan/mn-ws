// skill 域：管理随包分发的多 skill（主 skill 与可选配套 skill）。
// 平台级能力，action 只做 I/O 编排；发现/分组/安装/导出的真相在 core/skills*.ts。
import { defineAction } from '../../runtime/types/action.js';
import { defineModule } from '../../runtime/types/module.js';
import * as skills from '../../core/skills/index.js';
import * as skillsGet from '../../core/skills/get.js';
import { badInput } from '../../core/errors/index.js';

export default defineModule({
  id: 'skill',
  title: 'Skill',
  order: 20,
  actions: [
    defineAction({
      id: 'skill.list',
      cli: ['skill', 'list'],
      http: ['GET', '/api/skills'],
      summary: '列出可装的 skill 与 group',
    })(
      async () => {
        const [names, manifest] = await Promise.all([
          skills.bundledSkillNames(),
          skills.loadGroups(),
        ]);
        return {
          skills: names,
          groups: Object.keys(manifest.groups),
          defaultGroup: manifest.defaultGroup,
          source: manifest.source,
        };
      },
      (r) => {
        const lines = ['可装的 skill:'];
        for (const n of r.skills) lines.push('  ' + n + (n === r.defaultGroup ? '  （默认 install）' : ''));
        lines.push('可装的 group:');
        for (const g of r.groups) lines.push('  ' + g + (g === r.defaultGroup ? '  （默认）' : ''));
        return lines.join('\n');
      },
    ),

    defineAction({
      id: 'skill.groups',
      cli: ['skill', 'groups'],
      http: ['GET', '/api/skill-groups'],
      summary: '列出每个 group 含哪些 skill',
    })(
      async () => {
        const manifest = await skills.loadGroups();
        return { source: manifest.source, groups: manifest.groups, warning: manifest.warning };
      },
      (r) => {
        const lines = [];
        for (const [key, g] of Object.entries(r.groups)) {
          lines.push(`  ${key.padEnd(12)} [${g.skills.join(', ')}]${g.summary ? '  ' + g.summary : ''}`);
        }
        if (r.warning) lines.push('', '⚠ ' + r.warning);
        return `group 清单（来源: ${r.source}）\n` + lines.join('\n');
      },
    ),

    defineAction({
      id: 'skill.get',
      cli: ['skill', 'get'],
      http: ['GET', '/api/skill-content'],
      summary: '导出 skill 文档（并幂等安装）',
      args: [
        { name: 'name', required: false },
        { name: 'ref', required: false },
      ],
      flags: {
        to: { type: 'string' },
        force: { type: 'boolean' },
      },
    })(
      async (ctx) => {
        const result = await skillsGet.getSkill(ctx.name || 'mn-ws', {
          ref: ctx.ref,
          to: ctx.to,
          force: ctx.force,
        });
        return {
          skillName: result.skillName,
          ref: result.ref,
          contentBytes: result.contentBytes,
          prefix: skillsGet.skillGetPrefix(result.skillName, result.ref),
          content: result.content,
          installStatus: skillsGet.installStatusLine(result.install),
        };
      },
      // 人读模式：前缀 → 全文 → 安装状态，三段拼接。
      (r) => [r.prefix, r.content, '', r.installStatus].join('\n'),
    ),

    defineAction({
      id: 'skill.install',
      cli: ['skill', 'install'],
      http: ['POST', '/api/skill-install'],
      summary: '安装 skill、整组 skill 或全部 skill',
      args: [{ name: 'name', required: false }],
      flags: {
        all: { type: 'boolean' },
        group: { type: 'string' },
        to: { type: 'string' },
        force: { type: 'boolean' },
      },
    })(
      async (ctx) => {
        const opts = { to: ctx.to, force: ctx.force };
        if (ctx.name && ctx.group) {
          throw badInput('位置参数 name 与 --group 互斥，只能给一个');
        }
        if (ctx.all && (ctx.name || ctx.group)) {
          throw badInput('--all 与 name / --group 互斥，它会安装全部 skill');
        }
        if (ctx.all) return skills.installAll(opts);
        if (ctx.group) return skills.installGroup(ctx.group, opts);
        return skills.installOne(ctx.name || 'mn-ws', opts);
      },
      (r) => {
        if ('group' in r && Array.isArray((r as skills.GroupInstallResult).skills)) {
          const g = r as skills.GroupInstallResult;
          const label = g.group === '*' ? '全部 skill' : `group ${g.group}`;
          if (g.status === 'conflict') {
            return `${label} 有冲突（未安装任何文件）:\n` +
              g.skills.map((x) => `  冲突: ${x.path}（${x.files} 个文件不同）`).join('\n') +
              '\n确认覆盖: 加 --force';
          }
          return `${label} 已安装:\n` +
            g.skills.map((x) => `  ${x.status === 'skipped' ? '已是最新' : '已安装'}: ${x.path}`).join('\n');
        }
        const x = r as skills.InstallResult;
        if (x.status === 'conflict') {
          return `冲突: ${x.path}（${x.files} 个文件不同）；确认覆盖加 --force`;
        }
        if (x.status === 'skipped') return `已是最新: ${x.path}`;
        return `${x.replaced ? '已替换' : '已安装'}: ${x.path}（${x.files} 个文件）`;
      },
    ),
  ],
});
