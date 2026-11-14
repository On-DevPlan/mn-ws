#!/usr/bin/env node
// 本地启动入口：**优先跑原生二进制**，没有才回退到 TS 实现。
//
// ## 为什么要有这个
//
// npm 包里的 `bin` 指向原生二进制（运行时零 Node 依赖）。但**开发时**，
// 二进制可能还没构建（Rust 改动没编译）——这时直接跑二进制会报「文件不存在」。
//
// 所以本地开发走这个脚本：它先看二进制在不在，在就跑它，不在就回退到 TS。
// CI 与发布永远走原生二进制（那条路是硬的）。
//
// 用法：node bin/run-local.mjs [子命令...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const isWin = process.platform === 'win32';
const binary = path.join(here, isWin ? 'mn-ws-server.exe' : 'mn-ws-server');

if (fs.existsSync(binary)) {
  const r = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

// 回退到 TS 实现（开发时 Rust 产物还没构建的场景）
const { runServerCli } = await import(
  pathToFileURL(path.join(pkgRoot, 'dist', 'cli.js')).href
);
runServerCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
