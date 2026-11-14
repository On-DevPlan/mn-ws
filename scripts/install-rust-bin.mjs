#!/usr/bin/env node
// 把 Rust 产物与 React 产物装进**本地开发布局**。
//
// ## 它在分发模型里的位置（0.7.2 起）
//
// npm 分发走**平台子包**模式：主包 mn-ws 的 bin 是启动器
// （client/bin/mn-ws.js，已入库），平台二进制由
// scripts/make-platform-pkg.mjs 生成的 mn-ws-<key> 子包携带。
// 所以**发布链路不再用本脚本改写 bin 字段** —— 那是 0.6/0.7.1 时代
// 「单包内带当前平台二进制」的老模型。
//
// 本脚本现在是**本地开发**助手：
//   · 把当前平台的 Rust 产物拷到 client/bin/（run-local.mjs 优先跑它）
//   · 把 React 产物拷到 client/web/public（主包 pack 的 files 之一）
//
// 用法：
//   node scripts/install-rust-bin.mjs client    # 二进制 + web 产物
//   node scripts/install-rust-bin.mjs web       # 只装 web 产物（发布主包前）
//   node scripts/install-rust-bin.mjs server    # server 包（不发 npm，仅本地）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryName } from './platform-bin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export { platformKey, rustTarget, binaryName } from './platform-bin.mjs';

/**
 * 把 Rust 产物拷进包的 bin/ 目录（本地开发布局；不改写 bin 字段 ——
 * 主包的 bin 固定指向已入库的启动器）。
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
  return { dest };
}

/** 把 React 产物拷进包（主包发布要带；落 `web/public`，files 之一）。 */
export function installWebAssets({ srcDir, destDir }) {
  if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
    throw new Error(
      `React 产物不存在：${srcDir}\n` +
      `先构建前端：pnpm --filter mn-ws build`,
    );
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  return destDir;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.argv[2] || 'client';

  if (mode === 'web') {
    const web = installWebAssets({
      srcDir: path.join(repoRoot, 'client', 'dist', 'web', 'public'),
      destDir: path.join(repoRoot, 'client', 'web', 'public'),
    });
    console.log(`[install-rust-bin] web 产物 → ${web}`);
    process.exit(0);
  }

  const targets = mode === 'all' ? ['client', 'server'] : [mode];
  for (const t of targets) {
    const isClient = t === 'client';
    const stem = isClient ? 'mn-ws' : 'mn-ws-server';
    const pkgDir = path.join(repoRoot, isClient ? 'client' : 'server');
    const { dest } = installBinary({
      rustBinary: path.join(repoRoot, 'rust', 'target', 'release', binaryName(stem)),
      pkgDir,
      stem,
    });
    console.log(`[install-rust-bin] ${t} → ${dest}`);

    // client 半还要带上 React 产物（面板的静态资源，由二进制伺服）。
    if (isClient) {
      const web = installWebAssets({
        srcDir: path.join(pkgDir, 'dist', 'web', 'public'),
        destDir: path.join(pkgDir, 'web', 'public'),
      });
      console.log(`[install-rust-bin] client 产物 → ${web}`);
    }
  }
}
