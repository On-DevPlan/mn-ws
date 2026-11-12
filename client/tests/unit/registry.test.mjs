// 一致性断言：把「页面清单 ↔ 组件 ↔ 模块目录 ↔ 注册表 ↔ lint 清单」钉在一起。
//
// 这几处不同步的后果各不相同，但都不会当场报错：
//   清单里有、组件没有 → 头部点进去空白
//   组件有、清单没有   → 那个页面永远进不了头部（等于白写）
//   模块目录有、注册表没有 → CLI/HTTP 全都没有，面板也拿不到
//   lint 清单漏了模块   → 模块之间可以随便互相 import，分层静默失效
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const moduleDirs = (await readdir(join(ROOT, 'src/modules'), { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

test('core/views 的页面清单 ↔ 前端 COMPONENTS ↔ 模块目录 三方对账', async () => {
  const { VIEWS_META } = await import('../../src/core/views.ts');
  const { COMPONENT_IDS } = await import('../../src/web/frontend/registry.ts');

  const viewIds = VIEWS_META.map((v) => v.id).sort();
  assert.deepEqual([...COMPONENT_IDS].sort(), viewIds, '页面清单与组件表必须一一对应');

  for (const v of VIEWS_META) {
    assert.ok(v.title && typeof v.title === 'string', `页面 ${v.id} 缺 title`);
    assert.equal(typeof v.order, 'number', `页面 ${v.id} 的 order 必须是数字`);
  }

  // 页面 id 与模块目录同名（本骨架的约定：一个模块提供一页）
  for (const id of viewIds) {
    assert.ok(moduleDirs.includes(id), `页面 ${id} 没有对应的模块目录 src/modules/${id}/`);
    assert.ok(
      existsSync(join(ROOT, 'src/modules', id, 'view.tsx')),
      `模块 ${id} 缺 view.tsx——页面清单里登记了它，就得有组件`,
    );
  }
});

test('模块目录 ↔ 后端 MODULES 双向对账；有 view 的模块必须在页面清单里', async () => {
  const { MODULES } = await import('../../src/runtime/registry.ts');
  const { VIEWS_META } = await import('../../src/core/views.ts');

  const registered = MODULES.map((m) => m.id).sort();
  assert.deepEqual(registered, moduleDirs, 'src/modules 下的每个目录都必须登记进运行时注册表（且不能多登记）');

  const viewIds = new Set(VIEWS_META.map((v) => v.id));
  for (const id of moduleDirs) {
    const hasView = existsSync(join(ROOT, 'src/modules', id, 'view.tsx'));
    if (hasView) assert.ok(viewIds.has(id), `模块 ${id} 有 view.tsx，但没登记进 core/views.ts——它永远进不了头部`);
  }
});

test('eslint 的模块清单覆盖全部模块（新增模块必须补两处枚举）', async () => {
  const cfg = await readFile(join(ROOT, 'eslint.config.js'), 'utf8');

  // 1) 模块互依禁列（逐模块枚举，漏补 → 该模块可以随便 import 别人）
  const siblingBlock = /业务模块：模块之间禁止互相值依赖[\s\S]*?\n  \},/.exec(cfg);
  assert.ok(siblingBlock, '找不到业务模块禁列块');
  for (const id of moduleDirs) {
    assert.match(siblingBlock[0], new RegExp(`'../${id}/\\*'`), `禁列里缺 ../${id}/*`);
  }

  // 2) 前端规则的文件清单（视图 tsx 必须被覆盖，否则「前端别导入 node:」那条形同虚设）
  const frontBlock = /前端（含[\s\S]*?\n  \},/.exec(cfg);
  assert.ok(frontBlock, '找不到前端规则块');
  for (const id of moduleDirs) {
    if (!existsSync(join(ROOT, 'src/modules', id, 'view.tsx'))) continue;
    assert.match(frontBlock[0], new RegExp(`src/modules/${id}/\\*\\*/\\*\\.tsx`), `前端规则的文件清单里缺 src/modules/${id}/**/*.tsx`);
  }
});

// ---- 操作成对：CLI ↔ Web 不漏声明 ----

test('action 声明成对：http 必须是路由，或 null + 豁免前缀 / web: false', async () => {
  const { ACTIONS, CLI_ONLY_PREFIXES } = await import('../../src/runtime/registry.ts');
  const { cliPathsOf } = await import('../../src/runtime/spec.ts');

  const exempt = new Set(CLI_ONLY_PREFIXES);
  for (const a of ACTIONS) {
    const paths = cliPathsOf(a);
    assert.ok(paths.length, `action ${a.id} 缺 CLI 命令（Web 操作必须有 CLI 等价）`);

    if (a.http) {
      assert.ok(Array.isArray(a.http) && a.http.length === 2, `action ${a.id} 的 http 必须是 [method, path]`);
      assert.notEqual(a.web, false, `action ${a.id} 同时有 http 与 web: false，语义冲突`);
      continue;
    }

    assert.equal(a.http, null, `action ${a.id} 的 http 必须是路由数组或显式 null`);
    const segment = paths[0][0];
    assert.ok(
      a.web === false || exempt.has(segment),
      `action ${a.id} 是纯 CLI，但没有显式 web: false，也不在豁免前缀（${CLI_ONLY_PREFIXES.join(' / ')}）内`
    );
  }
});

test('eslint 与 runtime 的 CLI-only 豁免前缀一致', async () => {
  const { CLI_ONLY_PREFIXES } = await import('../../src/runtime/registry.ts');
  const cfg = await readFile(join(ROOT, 'eslint.config.js'), 'utf8');
  const block = /cliOnlyPrefixes:\s*\[([^\]]*)\]/.exec(cfg);
  assert.ok(block, 'eslint.config.js 里找不到 local/action-parity 的 cliOnlyPrefixes');
  const lintPrefixes = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(lintPrefixes, CLI_ONLY_PREFIXES, '两处豁免前缀必须一致');
});

test('非 GET 操作必须有面板入口（前端引用了 action id 或路由路径）', async () => {
  const { ACTIONS, CLI_ONLY_PREFIXES } = await import('../../src/runtime/registry.ts');
  const { cliPathsOf } = await import('../../src/runtime/spec.ts');

  // 只扫前端侧代码：模块的 index.ts 里有声明本身，扫进去会让这条测试永远通过
  const roots = [join(ROOT, 'src/web/frontend'), join(ROOT, 'src/modules')];
  const chunks = [];
  for (const dir of roots) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(js|jsx|mjs|ts|tsx)$/.test(e.name)) continue;
      // modules 下只认 view.*——index/service 是声明与 Node 侧逻辑
      if (dir.endsWith('modules') && !/^view\.(js|jsx|ts|tsx)$/.test(e.name)) continue;
      chunks.push(await readFile(join(e.parentPath || e.path || dir, e.name), 'utf8'));
    }
  }
  const frontend = chunks.join('\n');
  const exempt = new Set(CLI_ONLY_PREFIXES);

  for (const a of ACTIONS) {
    if (!a.http) continue;
    const [method, pattern] = a.http;
    if (method === 'GET' || method === 'HEAD') continue;
    if (exempt.has(cliPathsOf(a)[0][0])) continue;

    // 前端可能按 action id（typed client）或按路由路径（api()）调用
    const routePrefix = pattern.replace(/\/:[\w-]+/g, '');
    const refs = [a.id, routePrefix];
    assert.ok(
      refs.some((r) => frontend.includes(r)),
      `写操作 ${a.id}（${method} ${pattern}）在面板前端找不到入口——补 UI，或显式声明 web: false`
    );
  }
});
