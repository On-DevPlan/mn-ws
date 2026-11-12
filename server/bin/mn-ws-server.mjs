#!/usr/bin/env node
// mn-ws-server 唯一入口。
//
// 运行的是构建产物 dist/（node 由 tsc 输出）。发布前必须先 pnpm build。
import { runServerCli } from '../dist/cli.js';

runServerCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
