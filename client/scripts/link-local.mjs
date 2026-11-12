// 本地开发 shim：把全局 `mn-ws` 命令的启动器**原地覆盖**成转发到本仓库，
// 改完代码立刻生效，不用发版。只有开发者才会跑这个脚本，所以它只做一件事——
// 把「用户敲 `mn-ws` 实际命中的那个启动器」覆盖成转发器，其余一律不碰。
//
// 为什么不用 npm link：Windows 上 npm link 建的 cmd shim 不一定在用户真实 PATH 上，
// link 完自己的终端里仍可能 command not found。这里直接覆盖 PATH 上现成的落点，
// PATH 一字不动，已开着的终端立即生效；volta / npm / pnpm 装的全局启动器一视同仁。
//
// 稳健性（项目复用 / 换机器）：
//   - ROOT 由 import.meta.url 运行时推导，脚本里没有任何写死的本机路径；
//     项目搬到新目录、换台机器，重跑一次就把启动器覆盖成新路径。
//   - 覆盖是幂等的：重复跑只是再覆盖一次；已有的转发器不会被当成「原件」备份。
//   - 被覆盖的原件统一备份到 ~/.mn-ws/dev/backups.json（按启动器路径持久化），
//     `--unlink` 时原样写回；找不到备份的（本脚本新建的）直接删除。
//
// 用法：
//   pnpm run link:local                 覆盖全局启动器（默认直接动手）
//   pnpm run link:local -- --dry-run    只预览，不写文件
//   pnpm run link:local -- --auto       只覆盖 PATH 上现成的启动器，绝不新建目录（build 链路用）
//   pnpm run unlink:local               按备份还原原件
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = dirname(import.meta.url).replace(/[\\/]scripts$/, '');
const IS_WIN = process.platform === 'win32';
const CMD = 'mn-ws';
const BIN_REL = join('bin', 'ws.mjs');

const argv = process.argv.slice(2);
const unlink = argv.includes('--unlink');
const auto = argv.includes('--auto');
const dryRun = argv.includes('--dry-run') || argv.includes('-n');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SHIM_TAG = 'mn-ws-local-shim';

function dirname(url) {
  return new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return { code: r.status, out: (r.stdout || '').trim(), error: r.error };
}

// 路径等同性比较：分隔符归一 + Windows 大小写不敏感。
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/[/\\]+$/, '').replace(/[/\\]/g, '/');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

// 备份目录：机器级、不随项目走（~/.mn-ws/dev）。
function devDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.mn-ws', 'dev');
}
function backupPath() {
  return join(devDir(), 'backups.json');
}
function readBackups() {
  try {
    const b = JSON.parse(readFileSync(backupPath(), 'utf8'));
    return b && b.items && typeof b.items === 'object' ? b.items : {};
  } catch { return {}; }
}
function writeBackups(items) {
  mkdirSync(devDir(), { recursive: true });
  writeFileSync(backupPath(), JSON.stringify({ version: 1, items }, null, 2) + '\n', 'utf8');
}

// ─── 定位全局启动器 ─────────────────────────────────────────────────

const pathDirs = () =>
  (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);

// PATH 上各目录里命令的启动器变体（文本可覆盖的）。
const TEXT_VARIANTS = IS_WIN ? ['', '.cmd', '.ps1', '.bat'] : [''];

// 找到用户敲 `mn-ws` 实际命中的第一个目录（PATH 顺序），返回该目录下已有的启动器。
// 跳过 %VAR% 无法解析的目录和商店 reparse 点。
function findExistingLauncher() {
  for (const d of pathDirs()) {
    if (/%[^%]+%/.test(d) || /WindowsApps/i.test(d)) continue;
    const files = TEXT_VARIANTS.map((e) => join(d, CMD + e)).filter(existsSync);
    if (files.length) return { dir: d, files };
    if (IS_WIN && existsSync(join(d, CMD + '.exe'))) return { dir: d, exe: true };
  }
  return null;
}

// 包管理器的全局 bin 目录（PATH 上没有现成启动器时，往这些已在 PATH 的目录里写）。
// 这些目录本来就归包管理器管、且已在 PATH 上，不需要改 PATH。
function globalBinCandidates() {
  const out = [];
  const voltaHome = process.env.VOLTA_HOME
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Volta') : null);
  if (voltaHome) out.push(join(voltaHome, 'bin'));
  const npm = run(IS_WIN ? 'npm.cmd' : 'npm', ['config', 'get', 'prefix']);
  if (npm.code === 0 && npm.out) {
    out.push(IS_WIN ? npm.out : join(npm.out, 'bin'));
  }
  if (process.env.PNPM_HOME) out.push(process.env.PNPM_HOME);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  out.push(IS_WIN ? join(home, '.local', 'bin') : join(home, '.local', 'bin'));
  // 去重（路径等同），只保留真实存在的目录。
  const seen = [];
  return out.filter((d) => {
    if (!existsSync(d) || seen.some((s) => samePath(s, d))) return false;
    seen.push(d);
    return true;
  });
}

// 选定要写入的目标目录：现成启动器目录优先，否则第一个全局 bin 目录。
function chooseTarget() {
  const found = findExistingLauncher();
  if (found) {
    if (found.exe) return { exe: true, dir: found.dir };
    return { dir: found.dir, files: found.files };
  }
  if (auto) return null;
  const cands = globalBinCandidates();
  return cands.length ? { dir: cands[0], files: [] } : null;
}

// ─── 启动器内容 ─────────────────────────────────────────────────────

// 用本脚本进程自己的真实 node.exe（shim 是先解析再 exec，这里拿到的是真实路径），
// 绕开 PATH 上的 volta 之类转发 shim——那一跳会把多行参数截断成首行且不报错。
// 节点升级会换版本目录，所以保留「不存在就退回 PATH 上的 node」的回退。
function realNode() {
  return process.execPath.replace(/\\/g, '/');
}

function shimBody(file) {
  const bin = join(ROOT, BIN_REL).replace(/\\/g, '/');
  const node = realNode();
  if (file.endsWith('.ps1')) {
    return `# ${SHIM_TAG} -> ${ROOT}\n& "${node}" "${bin}" @args\n`;
  }
  // .cmd / .bat：走 PATH 上的 node。瓶颈是 cmd.exe 对 .cmd 内容的解析（%* 展开），
  // 换真实 node 解决不了，与 .ps1 / 无扩展名那条路不同。
  if (file.endsWith('.cmd') || file.endsWith('.bat')) {
    return `@REM ${SHIM_TAG} -> ${ROOT}\r\n@node "${bin}" %*\r\n`;
  }
  return `#!/bin/sh\n# ${SHIM_TAG} -> ${ROOT}\n`
    + `NODE="${node}"\n[ -x "$NODE" ] || NODE=node\n`
    + `exec "$NODE" "${bin}" "$@"\n`;
}

const isExtensionless = (f) => !basename(f).includes('.');

// 目标目录下要写的启动器变体（无现成启动器时，覆盖全部常用变体）。
function targetFiles(dir, existing) {
  if (existing && existing.length) return existing;
  return TEXT_VARIANTS.map((e) => join(dir, CMD + e));
}

// ─── 覆盖 ───────────────────────────────────────────────────────────

function apply() {
  const target = chooseTarget();
  if (!target) {
    console.log('[link:local] --auto：PATH 上没有现成的 mn-ws，跳过（不新建、不动 PATH）。');
    return true;
  }
  if (target.exe) {
    console.error(`[link:local] ${join(target.dir, CMD + '.exe')} 是二进制启动器，无法文本覆盖。`);
    console.error('  请先卸载该全局版本（volta uninstall / npm uninstall -g），或改用其它全局目录。');
    return false;
  }

  const { dir } = target;
  const files = targetFiles(dir, target.files);
  const backups = readBackups();

  // 备份决策：已是本脚本转发器的，原件以既有备份为准（重装不把转发器当原件）；
  // 非转发器才更新备份；本脚本新建的（原本不存在）记 null。
  const plan = files.map((f) => {
    let cur = null;
    try { cur = readFileSync(f, 'utf8'); } catch { /* 读不动按不存在 */ }
    if (cur !== null && cur.includes(SHIM_TAG)) {
      if (backups[f] !== undefined) return { file: f, original: backups[f] };
      return { file: f, original: cur };
    }
    return { file: f, original: cur };
  });

  console.log('[link:local] 覆盖全局启动器（PATH 不动，已开终端立即生效）');
  console.log(`  目录: ${dir}`);
  for (const p of plan) {
    console.log(`  ${p.file}  ${p.original === null ? '（原本不存在，unlink 时删除）' : '（原件已备份，unlink 时写回）'}`);
  }
  if (dryRun) {
    console.log('\n[link:local] --dry-run：未写任何文件。');
    return true;
  }

  for (const p of plan) {
    writeFileSync(p.file, shimBody(p.file), 'utf8');
    if (isExtensionless(p.file)) chmodSync(p.file, 0o755);
    backups[p.file] = p.original;
  }
  writeBackups(backups);

  console.log(`\n[link:local] 验证: mn-ws version   # 应显示 v${pkg.version}（无需重开终端）`);
  console.log('[link:local] 还原: pnpm run unlink:local');
  return true;
}

// ─── 还原 ───────────────────────────────────────────────────────────

function remove() {
  const backups = readBackups();
  const found = findExistingLauncher();
  // 备份里记录的、以及当前 PATH 上的启动器合并去重。
  const files = new Set(Object.keys(backups));
  if (found && !found.exe) found.files.forEach((f) => files.add(f));

  if (!files.size) {
    console.log('[link:local] 没有本脚本写入的启动器（未 link 过，或已还原）。');
    return true;
  }

  let changed = 0;
  for (const f of files) {
    let cur = '';
    try { cur = readFileSync(f, 'utf8'); } catch { /* 不存在/读不动 */ }
    const isOurs = cur.includes(SHIM_TAG);
    const original = backups[f];
    if (!isOurs && original === undefined) continue; // 不是我们的，也没备份
    if (dryRun) {
      console.log(`[link:local] 将还原 ${f}`);
      continue;
    }
    if (original === null || original === undefined) {
      if (existsSync(f)) { rmSync(f, { force: true }); changed++; console.log(`[link:local] 已删除（原本不存在）: ${f}`); }
    } else {
      writeFileSync(f, original, 'utf8');
      if (isExtensionless(f)) chmodSync(f, 0o755);
      changed++;
      console.log(`[link:local] 已还原原件: ${f}`);
    }
    delete backups[f];
  }

  if (dryRun) return true;
  if (changed) writeBackups(backups);
  // 备份空了就清掉备份文件本身。
  if (!Object.keys(backups).length) rmSync(backupPath(), { force: true });
  console.log('[link:local] 还原完成，mn-ws 回到覆盖前的原件（PATH 从未动过）。');
  return true;
}

// ─── 入口 ───────────────────────────────────────────────────────────

console.log(`仓库: ${ROOT}  (v${pkg.version})`);
if (dryRun) console.log('预览模式（--dry-run）——不会改动任何文件。\n');
const ok = unlink ? remove() : apply();
process.exit(ok ? 0 : 1);
