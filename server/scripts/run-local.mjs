#!/usr/bin/env node
// 本地启动入口：**优先跑原生二进制**，没有才回退到 TS 实现。
//
// ## 为什么要有这个
//
// server 半的发布物是 **Docker 镜像**（见仓库根的 Dockerfile），
// npm 包不发（`private: true`）。但本地开发与自测时 Rust 产物可能还没构建，
// 所以这里回退到 TS 实现 —— 那是**交叉兼容测试的对照物**（验证旧版 client
// 能连新版 server）。
//
// **它只在开发期用** —— 所以放在 `scripts/` 而不是 `bin/`：
// `bin/` 会被打进 npm 包，而这个脚本对安装方没有意义。
//
// 与 client/scripts/run-local.mjs 同款。理由见那边。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const isWin = process.platform === 'win32';
const binary = path.join(pkgRoot, 'bin', isWin ? 'mn-ws-server.exe' : 'mn-ws-server');

if (fs.existsSync(binary)) {
  const r = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

// 回退到 TS 实现
const { runServerCli } = await import(
  pathToFileURL(path.join(pkgRoot, 'dist', 'cli.js')).href
);
runServerCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
