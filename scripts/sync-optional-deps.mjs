#!/usr/bin/env node
// 版本对齐器：主包 mn-ws 与四个平台子包必须**同版本同发**。
//
// 版本号只改一处也行 —— 跑这个脚本，把 client/package.json 的 version
// 同步写进 4 个平台子包。升版本的动作序列：
//
//   1. 改 client/package.json 的 version
//   2. node scripts/sync-optional-deps.mjs   # 子包版本跟上
//   3. pnpm install                          # 刷新 lockfile（如有变化）
//   4. commit + 打 tag v<version>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '..', 'client');

const KEYS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'];

const version = JSON.parse(
  fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8'),
).version;

for (const key of KEYS) {
  const p = path.join(clientDir, 'platform', key, 'package.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw.version === version) continue;
  raw.version = version;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
  console.log(`[sync-optional-deps] ${raw.name}: ${version}`);
}
console.log(`[sync-optional-deps] 全部对齐到 ${version}`);
