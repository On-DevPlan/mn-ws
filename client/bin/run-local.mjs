#!/usr/bin/env node
// 本地启动入口：**优先跑原生二进制**，没有才回退到 TS 实现。
//
// 与 server/bin/run-local.mjs 同款。理由见那边。
//
// npm 包里的 `bin` 指向原生二进制（运行时零 Node 依赖）；本地开发时
// Rust 产物可能还没构建，所以回退到 TS。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const isWin = process.platform === 'win32';
const binary = path.join(here, isWin ? 'mn-ws.exe' : 'mn-ws');

if (fs.existsSync(binary)) {
  const r = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

// 回退到 TS 实现
const { runCli } = await import(
  pathToFileURL(path.join(pkgRoot, 'dist', 'runtime', 'cli.js')).href
);
runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
