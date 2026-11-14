#!/usr/bin/env node
// 本地启动入口：**优先跑原生二进制**，没有才回退到 TS 实现。
//
// ## 为什么要有这个
//
// npm 包里的 `bin` 指向原生二进制（运行时零 Node 依赖）；本地开发时
// Rust 产物可能还没构建，所以回退到 TS 实现。
//
// **它只在开发期用** —— 所以放在 `scripts/` 而不是 `bin/`：
// `bin/` 会被打进 npm 包，而这个脚本对安装方没有意义（装到的包里有二进制）。
//
// 与 server/scripts/run-local.mjs 同款。理由见那边。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const isWin = process.platform === 'win32';
const binary = path.join(pkgRoot, 'bin', isWin ? 'mn-ws.exe' : 'mn-ws');

if (fs.existsSync(binary)) {
  const r = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

// 回退到 TS 实现（开发期 Rust 产物还没构建的场景）
const { runCli } = await import(
  pathToFileURL(path.join(pkgRoot, 'dist', 'runtime', 'cli.js')).href
);
runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
