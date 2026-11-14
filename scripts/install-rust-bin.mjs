#!/usr/bin/env node
// 把 Rust 产物装进 npm 包，并把 `bin` 字段改写成当前平台的真实文件名。
//
// ## 为什么 npm 包里带的是**原生二进制**而不是 JS
//
// 这个包要「运行时零 Node 依赖」—— 用户装完直接跑 `mn-ws serve`，
// 机器上**没有 Node 也能用**。
//
// npm 的 `bin` 字段指向一个文件，npm 会为它生成 shim。已实测：
// 当目标是原生 exe 时，shim **直接调 exe**（Windows 上是
// `"%dp0%\..\<pkg>\bin\<name>.exe" %*`），**不经过 node**。
//
// ## 为什么要在打包时改写 bin 字段
//
// npm 不做扩展名补全：bin 指向 `./bin/mn-ws` 而文件是 `./bin/mn-ws.exe` 时，
// npm 找不到目标、**不生成 shim**，还会把那个路径从包里移走（实测）。
// Windows 要 `.exe`、Unix 不要 —— 同一份 package.json 满足不了，
// 所以按平台改写。CI 在每个平台各自 pack，各平台的自洽。
//
// 用法：
//   node scripts/install-rust-bin.mjs client    # client 包
//   node scripts/install-rust-bin.mjs server    # server 包
//   node scripts/install-rust-bin.mjs all       # 两个都装

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export { platformKey, rustTarget, binaryName, patchBinField } from './platform-bin.mjs';
import { binaryName, patchBinField } from './platform-bin.mjs';

/**
 * 把 Rust 产物拷进 npm 包，并改写 bin 字段。
 *
 * @param {object} opts
 * @param {string} opts.rustBinary  Rust 产物的路径
 * @param {string} opts.pkgDir      包目录
 * @param {string} opts.stem        二进制的名字（mn-ws / mn-ws-server）
 */
export function installBinary({ rustBinary, pkgDir, stem }) {
  if (!fs.existsSync(rustBinary)) {
    throw new Error(
      `Rust 产物不存在：${rustBinary}\n` +
      `先构建：cd rust && cargo build --release`,
    );
  }
  const destDir = path.join(pkgDir, 'bin');
  fs.mkdirSync(destDir, { recursive: true });
  const fileName = binaryName(stem);
  const dest = path.join(destDir, fileName);
  fs.copyFileSync(rustBinary, dest);
  // Unix 上要可执行位 —— npm 包解出来时不会保留它。
  if (process.platform !== 'win32') {
    fs.chmodSync(dest, 0o755);
  }
  const binTarget = patchBinField(pkgDir, stem);
  return { dest, binTarget };
}

/** 把 React 产物拷进包（client 半需要）。 */
export function installWebAssets({ srcDir, destDir }) {
  if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
    throw new Error(
      `React 产物不存在：${srcDir}\n` +
      `先构建前端：pnpm --filter mn-ws build`,
    );
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  return destDir;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.argv[2] || 'client';
  const targets =
    mode === 'all' ? ['client', 'server'] : [mode];

  for (const t of targets) {
    const isClient = t === 'client';
    const stem = isClient ? 'mn-ws' : 'mn-ws-server';
    const pkgDir = path.join(repoRoot, isClient ? 'client' : 'server');
    const { dest, binTarget } = installBinary({
      rustBinary: path.join(repoRoot, 'rust', 'target', 'release', binaryName(stem)),
      pkgDir,
      stem,
    });
    console.log(`[install-rust-bin] ${t} → ${dest}（bin: ${binTarget}）`);
  }
}
