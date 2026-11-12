// 编程入口：供其他工具 / agent 以库方式调用。
// 导出的是各模块的 service（业务真相源），不是 CLI/HTTP 壳——库用方自己组织 I/O。
export * as errors from './core/errors/index.js';

export * as homeService from './modules/home/service.js';

export { ACTIONS, MODULES } from './runtime/registry.js';
export { startServer } from './runtime/server.js';
export { runCli } from './runtime/cli.js';
