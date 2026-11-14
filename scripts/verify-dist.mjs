// 分发实测：新模型（平台子包）的端到端验证。
//
// ## 验什么
//
//   1. 主包能 pack（pnpm pack 把 optionalDependencies 的 workspace:*
//      重写成具体版本 —— npm publish 不认 workspace 协议）
//   2. 平台子包能生成并 pack（make-platform-pkg.mjs + npm pack）
//   3. 两个 tarball 装进隔离目录 → npm 生成 shim → 敲 `mn-ws` 真能跑
//      （启动器 → 平台子包里的二进制 → 退出码/输出透传）
//   4. **把 node 从 PATH 移除后，平台子包里的二进制本体照样能跑** ——
//      「二进制运行时零 Node 依赖」这条承诺的证明（启动器本来就要
//      Node，但二进制不；分两步各自证明）
//
// 跑法：node scripts/verify-dist.mjs
// 前置：cd rust && cargo build --release && pnpm --filter mn-ws build
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'mn-ws.exe' : 'mn-ws';

/** 找一个「有 node 的目录」，用来把它从 PATH 里挖掉。 */
function nodeDir() {
  const which = spawnSync(IS_WIN ? 'where' : 'which', ['node'], { encoding: 'utf8' });
  const first = (which.stdout || '').split(/\r?\n/).find(Boolean);
  return first ? path.dirname(first) : null;
}

/** 在「没有 node 的 PATH」下跑一个命令。 */
function runWithoutNode(cmd, args) {
  const without = nodeDir();
  const kept = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => p && path.resolve(p) !== path.resolve(without || ''));
  const newPath = kept.join(path.delimiter);

  if (IS_WIN) {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    // cmd 的引号规则很绕（外层引号会被剥掉）—— 用 `cmd /c call <shim>` 绕开
    const r = spawnSync('cmd.exe', ['/d', '/c', 'call', cmd, ...args], {
      encoding: 'utf8',
      cwd: path.dirname(cmd),
      env: { ...process.env, PATH: [system32, newPath].filter(Boolean).join(path.delimiter) },
    });
    return r;
  }
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: newPath },
  });
}

console.log('分发实测：平台子包模型（主包 + 启动器 + 平台二进制）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-dist-'));
console.log(`  临时目录：${tmp}`);
fs.mkdirSync(path.join(tmp, 'tgz'), { recursive: true });
const tgzDir = path.join(tmp, 'tgz');

// ── ① 平台子包：生成 + 打包 ──
console.log('\n[平台子包]');
const mk = spawnSync('node', [path.join(repoRoot, 'scripts', 'make-platform-pkg.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: IS_WIN,
});
check('make-platform-pkg 成功', mk.status === 0, (mk.stderr || '').slice(0, 200));
if (mk.status !== 0) process.exit(1);

const key = execFileSync('node', [path.join(repoRoot, 'scripts', 'make-platform-pkg.mjs'), '--list'], {
  cwd: repoRoot, encoding: 'utf8',
}).trim();
const platDir = path.join(repoRoot, 'client', 'platform', key);
const platPkg = JSON.parse(fs.readFileSync(path.join(platDir, 'package.json'), 'utf8'));

const platPack2 = spawnSync('npm', ['pack', '--pack-destination', tgzDir], {
  cwd: platDir, encoding: 'utf8', shell: IS_WIN,
});
check(`mn-ws-${key} 打包成功`, platPack2.status === 0, (platPack2.stderr || '').slice(0, 200));
const platTgz = path.join(tgzDir, `${platPkg.name}-${platPkg.version}.tgz`);
check('平台子包 tarball 存在', fs.existsSync(platTgz), platTgz);

// ── ② 主包：打包（workspace:* 必须被重写）──
console.log('\n[主包]');
const mainPack = spawnSync('pnpm', ['pack', '--pack-destination', tgzDir], {
  cwd: path.join(repoRoot, 'client'), encoding: 'utf8', shell: IS_WIN,
});
check('mn-ws 打包成功', mainPack.status === 0, (mainPack.stderr || '').slice(0, 200));
const mainVer = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'client', 'package.json'), 'utf8'),
).version;
const mainTgz = path.join(tgzDir, `mn-ws-${mainVer}.tgz`);
check('主包 tarball 存在', fs.existsSync(mainTgz), mainTgz);

// tarball 里的 optionalDependencies 必须已是具体版本
const tar = spawnSync('tar', ['-xzOf', mainTgz, 'package/package.json'], { encoding: 'utf8', shell: IS_WIN });
const packedJson = tar.status === 0 ? JSON.parse(tar.stdout) : null;
check('tarball 可读', !!packedJson, (tar.stderr || '').slice(0, 200));
if (packedJson) {
  const opt = packedJson.optionalDependencies || {};
  const rewritten = Object.values(opt).every((v) => /^\d+\.\d+\.\d+/.test(v));
  check('optionalDependencies 已重写成具体版本（不再是 workspace:*）', rewritten, JSON.stringify(opt));
}

// ── ③ 安装 + 启动器跑通 ──
console.log('\n[安装]');
const installDir = path.join(tmp, 'install');
fs.mkdirSync(installDir, { recursive: true });
// ⚠️ 必须先有 package.json —— 没有的话 npm 会向上找项目根，
//    找到用户主目录就把包装进 HOME（实测）。
fs.writeFileSync(
  path.join(installDir, 'package.json'),
  JSON.stringify({ name: 'mn-ws-dist-check', private: true, version: '0.0.0' }, null, 2) + '\n',
);
const inst = spawnSync(
  'npm',
  ['install', '--no-audit', '--no-fund', mainTgz, platTgz],
  { cwd: installDir, encoding: 'utf8', shell: IS_WIN },
);
check('主包 + 平台子包安装成功', inst.status === 0, (inst.stderr || '').slice(0, 300));

const shim = path.join(installDir, 'node_modules', '.bin', IS_WIN ? 'mn-ws.cmd' : 'mn-ws');
check('npm 生成了 mn-ws shim', fs.existsSync(shim), shim);

// ── ④ 带 node 跑 shim：启动器 → 二进制 ──
const withNode = spawnSync(shim, ['--version'], { encoding: 'utf8', shell: IS_WIN });
const withNodeOut = ((withNode.stdout || '') + (withNode.stderr || '')).trim();
check('mn-ws --version 能跑（启动器 → 平台二进制）', withNode.status === 0 && withNodeOut.length > 0,
  `status=${withNode.status} out=${withNodeOut.slice(0, 120)}`);
if (withNode.status === 0) console.log(`    --version → ${withNodeOut}`);
check('启动器报告的版本与主包一致', withNodeOut === mainVer, `期望 ${mainVer}`);

// ── ⑤ 无 node 跑二进制本体：零 Node 依赖的证明 ──
console.log('\n[零 Node 依赖证明（二进制本体）]');
const platBin = path.join(installDir, 'node_modules', platPkg.name, 'bin', EXE);
check('平台二进制随包装上', fs.existsSync(platBin), platBin);
const r = runWithoutNode(platBin, ['--version']);
const out = ((r.stdout || '') + (r.stderr || '')).trim();
check('二进制在没有 node 的 PATH 下仍能跑', r.status === 0 && out.length > 0,
  `status=${r.status} out=${out.slice(0, 200)}`);
if (r.status === 0) console.log(`    --version → ${out}`);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
