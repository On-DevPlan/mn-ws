// 本地启动入口：直接跑 Rust 二进制。
//
// Rust 化后没有 TS 实现可回退 —— 二进制就是唯一的运行时。
// 没有构建产物时给出明确指引，而不是静默失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const isWin = process.platform === 'win32';
const binary = path.join(pkgRoot, 'bin', isWin ? 'mn-ws.exe' : 'mn-ws');

if (!fs.existsSync(binary)) {
  console.error('Rust 产物不存在：' + binary);
  console.error('先构建：pnpm build:rust && pnpm build:dist');
  process.exit(1);
}

const r = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 0);
