#!/usr/bin/env node
// mn-ws 启动器 —— npm 主包的 bin 入口。
//
// ## 分发模型（esbuild / rollup 同款）
//
// 一个包名一个版本在 npm 上只能有一份 tarball，而原生二进制按平台不同
// —— 所以二进制住进**平台子包**（mn-ws-win32-x64 / mn-ws-darwin-x64 /
// mn-ws-darwin-arm64 / mn-ws-linux-x64），主包通过 optionalDependencies
// 引用它们：npm 按 os/cpu 字段**只装匹配当前平台的那一个**。
//
// 用户敲 `mn-ws` → npm 生成的 shim 调本启动器 → 按当前平台解析出
// 子包里的二进制 → spawn 转发（stdio 直通、退出码透传）。
//
// ## 关于「零 Node 依赖」
//
// 装 mn-ws 必然经过 npm（即必然有 Node），所以启动器走 Node 不损失什么；
// 真正干活的原生二进制本身运行时零依赖 —— 启动器只是把参数原样递过去。
//
// 面板产物（React 构建）是平台无关的，只有一份，住在主包 `web/public`。
// Rust 侧 `web_dir()` 优先读 `MN_WS_WEB_DIR` —— 启动器在用户没自己设的
// 情况下把它指到主包这份。
//
// 本文件是 ESM（主包 "type": "module"）；resolve 子包里的二进制要借
// createRequire —— ESM 没有裸的 require.resolve。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const KEY = `${process.platform}-${process.arch}`; // win32-x64 / darwin-arm64 / …
const EXE = process.platform === 'win32' ? 'mn-ws.exe' : 'mn-ws';

let binPath;
try {
  binPath = require.resolve(`mn-ws-${KEY}/bin/${EXE}`);
} catch {
  console.error(`mn-ws：当前平台 ${KEY} 没有可用的二进制（子包 mn-ws-${KEY} 未随包装上）。`);
  console.error('支持的平台：win32-x64 / darwin-x64 / darwin-arm64 / linux-x64。');
  process.exit(1);
}

const env = { ...process.env };
if (!env.MN_WS_WEB_DIR) {
  env.MN_WS_WEB_DIR = path.join(here, '..', 'web', 'public');
}

const child = spawn(binPath, process.argv.slice(2), { stdio: 'inherit', env });
child.on('error', (e) => {
  console.error(`mn-ws 启动失败（${binPath}）：${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
