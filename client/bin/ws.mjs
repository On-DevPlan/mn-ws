#!/usr/bin/env node
// mn-ws 唯一入口。
//
// 设计约定：Web 面板上每个按钮，都对应这里的一条 CLI 命令——二者由同一份 action
// 声明派生（见 src/modules/*/index.ts），不是靠人维护两份清单。
//
// 运行的是构建产物 dist/（Node 侧 tsc 输出）。发布前必须先 pnpm build。
import { runCli } from '../dist/runtime/cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
