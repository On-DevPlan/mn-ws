// 按平台派生 npm 分发相关的标识与文件名。
//
// ## 分发模型（0.7.2 起，esbuild / rollup 同款）
//
// 原生二进制住进**平台子包** mn-ws-<platform>-<arch>（由
// scripts/make-platform-pkg.mjs 生成），主包 mn-ws 的 bin 是启动器
// （client/bin/mn-ws.js），按当前平台解析子包里的二进制并转发。
// npm 按 os / cpu 字段只装匹配平台的那一个子包。
//
// 本文件提供：当前平台的 key（子包名后缀）、Rust target 三元组、
// 二进制文件名（Windows 要 .exe）。
//
// （0.6/0.7.1 时代「打包时改写 bin 字段」的 patchBinField 已随旧模型移除 ——
// 现在主包的 bin 固定指向启动器，不再按平台变。）

/** 平台标识。 */
export function platformKey() {
  const os = process.platform;
  const arch = process.arch;
  if (os === 'win32' && arch === 'x64') return 'win32-x64';
  if (os === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (os === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (os === 'linux' && arch === 'x64') return 'linux-x64';
  if (os === 'linux' && arch === 'arm64') return 'linux-arm64';
  return `${os}-${arch}`;
}

/** Rust target 三元组。 */
export function rustTarget() {
  const os = process.platform;
  const arch = process.arch;
  if (os === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (os === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (os === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (os === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (os === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  throw new Error(`不支持的平台: ${os}/${arch}`);
}

/** 二进制文件名（Windows 要 .exe）。 */
export function binaryName(stem) {
  return process.platform === 'win32' ? `${stem}.exe` : stem;
}
