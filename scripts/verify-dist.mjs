// 分发实测：打包 → 装到临时目录 → **把 node 从 PATH 移除** → 跑。
//
// ## 为什么必须「把 node 从 PATH 移除」
//
// 这是整套重构的**核心承诺**：运行时零 Node 依赖。
//
// 只测「`mn-ws --version` 能跑」是不够的 —— 那可能只是碰巧 PATH 里有 node。
// 真正的证明是：**把 node 从 PATH 里彻底拿掉，它照样能跑**。
// 上一轮已用三个候选包验过这个（POSIX sh / .cmd / 原生 exe），
// 结论是「原生 exe 作为 npm bin」可行 —— 这条脚本把那个证明固化成可复跑的检查。
//
// 跑法：node scripts/verify-dist.mjs
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

/** 找一个「有 node 的目录」，用来把它从 PATH 里挖掉。 */
function nodeDir() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
    encoding: 'utf8',
  });
  const first = (which.stdout || '').split(/\r?\n/).find(Boolean);
  return first ? path.dirname(first) : null;
}

/**
 * 在「没有 node 的 PATH」下跑一个命令。
 *
 * Windows 上不能直接 spawn `.cmd`（EINVAL）—— 要经 cmd.exe。
 * cmd.exe 在 System32 里，而 node 通常**不在** System32，
 * 所以把 System32 加回去不违背「移除 node」的前提。
 */
function runWithoutNode(cmd, args) {
  const without = nodeDir();
  const kept = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => p && path.resolve(p) !== path.resolve(without || ''));
  const newPath = kept.join(path.delimiter);

  if (process.platform === 'win32') {
    const system32 = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
    );
    // ⚠️ cmd 的引号规则很绕（外层引号会被剥掉），绕开它：
    //   用 `cmd /c call <shim>`，让 cmd 自己去解析 shim 的路径。
    //   这也更贴近用户真实形态 —— 用户敲 `mn-ws`，靠 PATH 找 shim。
    const r = spawnSync('cmd.exe', ['/d', '/c', 'call', cmd, ...args], {
      encoding: 'utf8',
      cwd: path.dirname(cmd),
      env: {
        ...process.env,
        PATH: [system32, newPath].filter(Boolean).join(path.delimiter),
        NODE: '',
      },
    });
    return r;
  }
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: newPath, NODE: '' },
  });
}

console.log('分发实测：npm 包里的原生二进制，零 Node 依赖');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-dist-'));
console.log(`  临时目录：${tmp}`);

for (const pkg of ['client', 'server']) {
  const pkgDir = path.join(repoRoot, pkg);
  const name = pkg === 'client' ? 'mn-ws' : 'mn-ws-server';

  // ── 打包 ──
  //
  // 用 `pnpm pack` 而不是 `npm pack`：client 包的依赖里有 `workspace:*`，
  // pnpm pack 会把它重写成具体版本（npm pack 不会 —— 装的时候直接报
  // `Unsupported URL Type "workspace:"`）。
  console.log(`\n[${name}] 打包`);
  const pack = spawnSync('pnpm', ['pack', '--pack-destination', tmp], {
    cwd: pkgDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (pack.status !== 0) {
    check(`${name} 打包成功`, false, (pack.stderr || pack.stdout || '').slice(0, 300));
    continue;
  }
  const tgz = fs
    .readdirSync(tmp)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.tgz'))
    .map((f) => path.join(tmp, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  check(`${name} 打包成功`, !!tgz, tgz);
  if (!tgz) continue;
  const sizeKb = Math.round(fs.statSync(tgz).size / 1024);
  console.log(`    tarball: ${path.basename(tgz)}（${sizeKb} KB）`);

  // ── 安装到隔离目录 ──
  const installDir = path.join(tmp, `install-${name}`);
  fs.mkdirSync(installDir, { recursive: true });
  const inst = spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--omit=dev', '--prefix', installDir, tgz],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  check(`${name} 安装成功`, inst.status === 0, (inst.stderr || '').slice(0, 300));
  if (inst.status !== 0) continue;

  const binDir = path.join(installDir, 'node_modules', '.bin');
  const shim = path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  check(`${name} 生成了 shim`, fs.existsSync(shim), shim);

  // ── shim 里有没有 "node" ──
  // Windows 的 .cmd shim 通常是 `node "%~dp0\..\lib\..."`；
  // 原生 exe 的 shim 应该是直接调 exe。
  if (fs.existsSync(shim)) {
    const content = fs.readFileSync(shim, 'utf8');
    const callsNode = /(^|[\s"'=])node(\.exe)?[\s"]/i.test(content);
    check(`${name} 的 shim 不经过 node`, !callsNode, content.slice(0, 160).replace(/\n/g, ' '));
  }

  // ── **把 node 从 PATH 移除**，然后跑 ──
  const r = runWithoutNode(shim, ['--version']);
  const out = (r.stdout || '') + (r.stderr || '');
  check(
    `${name} 在没有 node 的 PATH 下仍能跑`,
    r.status === 0 && out.trim().length > 0,
    `status=${r.status} err=${(r.error && r.error.message) || ''} out=${out.slice(0, 200)}`,
  );
  if (r.status === 0) {
    console.log(`    --version → ${out.trim()}`);
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
