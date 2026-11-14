// 验证 Dockerfile 的「占位源文件」这一步能过。
//
// 为什么单独验：Docker 构建时 cargo 会先拿假 src 预编译依赖层 ——
// 少一个目标文件就报「couldn't read xxx/src/lib.rs」，整���镜像构建失败
//（之前 CI 上就踩过：mn-ws-client 变成 lib+bin 双目标后，旧的占位缺 lib.rs）。
//
// 跑法：node scripts/verify-dockerfile-placeholders.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const rustRoot = path.join(repoRoot, 'rust');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('Dockerfile 占位源文件验证');

// 每个 crate 声明的目标（与 Cargo.toml 的 [lib] / [[bin]] 对应）
const TARGETS = {
  'mn-ws-core': ['lib'],
  'mn-ws-client': ['lib', 'bin'],
  'mn-ws-server': ['lib', 'bin'],
};

// 1) 检查 Dockerfile 里真的写了这些占位
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
for (const [crate, targets] of Object.entries(TARGETS)) {
  for (const t of targets) {
    const file = t === 'lib' ? 'lib.rs' : 'main.rs';
    const pattern = new RegExp(`> rust/${crate}/src/${file.replace('.', '\\.')}`);
    check(
      `Dockerfile 为 ${crate} 占位 ${file}`,
      pattern.test(dockerfile),
      `找不到 ${crate}/src/${file} 的占位`,
    );
  }
}

// 2) 真的跑一遍「占位 → cargo build --bin mn-ws-server」
//    （用真的 Cargo.toml + 假的 src，验证 cargo 认这个 workspace）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-dockersim-'));
try {
  for (const [crate, targets] of Object.entries(TARGETS)) {
    const srcDir = path.join(tmp, 'rust', crate, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.copyFileSync(
      path.join(rustRoot, 'Cargo.toml'),
      path.join(tmp, 'rust', 'Cargo.toml'),
    );
    fs.copyFileSync(
      path.join(rustRoot, 'Cargo.lock'),
      path.join(tmp, 'rust', 'Cargo.lock'),
    );
    fs.copyFileSync(
      path.join(rustRoot, crate, 'Cargo.toml'),
      path.join(tmp, 'rust', crate, 'Cargo.toml'),
    );
    for (const t of targets) {
      fs.writeFileSync(
        path.join(srcDir, t === 'lib' ? 'lib.rs' : 'main.rs'),
        t === 'lib' ? '' : 'fn main() {}\n',
      );
    }
  }

  // 依赖清单要指对（workspace 内的 path 依赖）
  const clientToml = fs.readFileSync(
    path.join(tmp, 'rust', 'mn-ws-client', 'Cargo.toml'),
    'utf8',
  );
  if (!clientToml.includes('mn-ws-core = { path = "../mn-ws-core" }')) {
    check('mn-ws-client 指向 mn-ws-core 的 path 依赖', false, 'Cargo.toml 里没有 path 依赖');
  } else {
    check('mn-ws-client 指向 mn-ws-core 的 path 依赖', true);
  }

  console.log('  … cargo build --release --bin mn-ws-server（占位 src）');
  try {
    execFileSync('cargo', ['build', '--release', '--bin', 'mn-ws-server'], {
      cwd: path.join(tmp, 'rust'),
      stdio: 'pipe',
      timeout: 600_000,
    });
    check('占位 src 能通过 cargo build', true);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    check('占位 src 能通过 cargo build', false, out.split('\n').slice(-6).join(' | '));
  }
} finally {
  // 临时目录交给系统清理
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
