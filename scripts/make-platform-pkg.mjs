#!/usr/bin/env node
// 往**平台子包**里装当前平台的二进制 —— 子包 package.json 已入库
// （client/platform/<key>/package.json），本脚本只填 bin/。
//
// ## 它在分发模型里的位置
//
// 主包 `mn-ws` 的 bin 是启动器（client/bin/mn-ws.js），按当前平台
// require.resolve `mn-ws-<key>/bin/<exe>`。二进制本体住在平台子包里，
// 子包声明 `os` / `cpu`（Linux 另加 `libc: glibc`），npm 装主包时**只装
// 匹配平台的那一个**（optionalDependencies 的标准行为，esbuild 同款）。
//
// 本脚本在**目标平台自己**上跑（CI 的 release.yml 平台矩阵，或本地开发机）：
//   node scripts/make-platform-pkg.mjs
// 产出 client/platform/<key>/bin/<exe>，之后在该目录 `npm publish`。
//
// 用法：
//   node scripts/make-platform-pkg.mjs          # 当前平台
//   node scripts/make-platform-pkg.mjs --list   # 只打印当前平台标识

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformKey } from './platform-bin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const clientDir = path.join(repoRoot, 'client');

const key = platformKey();
const isWin = process.platform === 'win32';
const exe = isWin ? 'mn-ws.exe' : 'mn-ws';

if (process.argv.includes('--list')) {
  console.log(key);
  process.exit(0);
}

const pkgDir = path.join(clientDir, 'platform', key);
const pkgJsonPath = path.join(pkgDir, 'package.json');
if (!fs.existsSync(pkgJsonPath)) {
  console.error(`平台子包不存在：${pkgJsonPath}`);
  console.error(`支持的平台目录：${fs
    .readdirSync(path.join(clientDir, 'platform'))
    .join(', ')}`);
  process.exit(1);
}

const srcBin = path.join(repoRoot, 'rust', 'target', 'release', exe);
if (!fs.existsSync(srcBin)) {
  console.error(`Rust 产物不存在：${srcBin}`);
  console.error('先构建：cd rust && cargo build --release');
  process.exit(1);
}

const binDir = path.join(pkgDir, 'bin');
fs.rmSync(binDir, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(srcBin, path.join(binDir, exe));
// Unix 上要可执行位 —— npm 包解出来时不会保留它。
if (!isWin) fs.chmodSync(path.join(binDir, exe), 0o755);

const { name, version } = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
console.log(`[make-platform-pkg] ${name}@${version} → ${path.join(binDir, exe)}`);
console.log(`[make-platform-pkg] 发布：npm publish ${pkgDir}`);
