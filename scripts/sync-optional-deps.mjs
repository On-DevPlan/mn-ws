#!/usr/bin/env node
// 版本对齐器：npm 主包、四个平台子包、Rust workspace 必须**同版本同发**。
//
// 版本号只改一处也行 —— 跑这个脚本，把 client/package.json 的 version
// 同步写进 4 个平台子包 + rust/Cargo.toml + rust/Cargo.lock。升版本的动作序列：
//
//   1. 改 client/package.json 的 version
//   2. node scripts/sync-optional-deps.mjs   # 子包与 Rust 版本跟上
//   3. pnpm install                          # 刷新 lockfile（如有变化）
//   4. commit + 打 tag v<version>
//
// 为什么 Rust 版本必须一起动：二进制用 env!("CARGO_PKG_VERSION") 自报版本，
// 只改 npm 版本会造成「装的是 0.7.4，--version 说 0.7.2」——0.7.3 发版时
// 正是这么翻的车，用户据此判断「修复没生效」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const clientDir = path.join(root, 'client');

const KEYS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'];
const CRATES = ['mn-ws-core', 'mn-ws-client', 'mn-ws-server'];

const version = JSON.parse(
  fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8'),
).version;

// 只替换首个 "version" 字段，保留原文件排版。
// （JSON.stringify 会把 os/cpu/files 数组重排成多行，制造一堆无意义 diff）
function bumpJsonVersion(file, label) {
  const raw = fs.readFileSync(file, 'utf8');
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === raw) return;
  fs.writeFileSync(file, next);
  console.log(`[sync-optional-deps] ${label}: ${version}`);
}

for (const key of KEYS) {
  bumpJsonVersion(path.join(clientDir, 'platform', key, 'package.json'), key);
}

// Rust workspace 版本（[workspace.package] 段内那一行）
const cargoToml = path.join(root, 'rust', 'Cargo.toml');
const tomlRaw = fs.readFileSync(cargoToml, 'utf8');
const tomlNext = tomlRaw.replace(
  /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/,
  `$1${version}$2`,
);
if (tomlNext !== tomlRaw) {
  fs.writeFileSync(cargoToml, tomlNext);
  console.log(`[sync-optional-deps] rust/Cargo.toml: ${version}`);
}

// Cargo.lock 里三个 workspace 成员的版本记录
const lockFile = path.join(root, 'rust', 'Cargo.lock');
const lockRaw = fs.readFileSync(lockFile, 'utf8');
let lockNext = lockRaw;
for (const crate of CRATES) {
  lockNext = lockNext.replace(
    new RegExp(`(name = "${crate}"\\r?\\nversion = ")[^"]*(")`),
    `$1${version}$2`,
  );
}
if (lockNext !== lockRaw) {
  fs.writeFileSync(lockFile, lockNext);
  console.log(`[sync-optional-deps] rust/Cargo.lock: ${version}`);
}

console.log(`[sync-optional-deps] 全部对齐到 ${version}`);
