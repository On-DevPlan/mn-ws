// skill:pre-install 的 module handler（经本 skill 的 hooks.json 注册）。
//
//   cwd 不是本项目根（package.json name 不匹配）→ { block }，拒绝安装；
//   是 → { vars: { PROJECT_ROOT } }，把项目根全路径渲染进 SKILL.md。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function injectRoot(payload) {
  const root = payload.cwd;
  let pkgName = null;
  try {
    pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
  } catch {
    pkgName = null;
  }
  if (pkgName !== 'mn-ws') {
    return {
      block: [
        `mn-ws skill 只能在 mn-ws 项目根目录内安装，当前目录不是：${root}`,
        '判定条件：package.json 的 name 为 "mn-ws"。',
        `请先 cd 到 mn-ws 项目根目录，再重新执行 skill install mn-ws。`,
      ].join('\n'),
    };
  }
  return { vars: { PROJECT_ROOT: root.replace(/\\/g, '/') } };
}
