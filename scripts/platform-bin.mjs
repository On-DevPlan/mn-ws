// 按平台生成 npm 包的 `bin` 字段。
//
// ## 为什么要在打包时改写 package.json
//
// npm 的 `bin` 字段指向**一个确切的文件名**（npm 不做扩展名补全 ——
// 实测：指向 `./bin/mn-ws` 而文件是 `./bin/mn-ws.exe` 时，
// npm 找不到目标，**不生成 shim**，还会把那个路径从包里移走）。
//
// Windows 要 `.exe`、Unix 不要 —— 同一份 package.json 满足不了。
//
// ## 解法
//
// 打包时按当前平台改写 `bin` 字段，让它指向**真实存在的那个文件名**。
// CI 在每个平台各自 build + pack，于是每个平台发布的包都自洽。
//
// ## 为什么这是安全的
//
// 已实测：npm 为原生 exe 生成的 shim **直接调 exe，不经过 node**
//   （Windows .cmd：`"%dp0%\..\<pkg>\bin\<name>.exe" %*`）
// 所以「运行时零 Node 依赖」在装完之后真的成立。

import fs from 'node:fs';
import path from 'node:path';

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

/**
 * 改写 package.json 的 `bin` 字段，让它指向当前平台的真实文件名。
 *
 * 只改 `bin` —— 其它字段（版本、依赖、files）原样保留，
 * 免得「为了改 bin 而动了发版元数据」。
 *
 * @param {string} pkgDir  包目录
 * @param {string} stem    二进制的名字（mn-ws / mn-ws-server）
 * @returns {string} 改写后的 bin 目标路径
 */
export function patchBinField(pkgDir, stem) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const fileName = binaryName(stem);
  const target = `./bin/${fileName}`;

  // 先确认目标文件真的在 —— 不在就当场报错，别让 npm 静默地不生成 shim。
  const abs = path.join(pkgDir, 'bin', fileName);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `二进制不存在：${abs}\n` +
      `先构建：cd rust && cargo build --release\n` +
      `然后：node scripts/install-rust-bin.mjs ${stem === 'mn-ws' ? 'client' : 'server'}`,
    );
  }

  raw.bin = { [stem]: target };
  fs.writeFileSync(pkgJsonPath, JSON.stringify(raw, null, 2) + '\n');
  return target;
}
