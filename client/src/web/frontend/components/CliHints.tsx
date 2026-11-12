// CLI 等价提示：列出当前模块的全部同构命令。
//
// 为什么由数据派生而不是手写：这行提示是用户核对「面板上这个按钮到底有没有 CLI 等价」
// 的唯一依据。改造前它是每个视图各自维护的字符串，命令一改就悄悄过期——
// 提示说「有」，实际没有，比没有提示更糟。
// 现在它来自 bootstrap 下发的命令表，与 CLI 实际注册的命令同源。
import { Fragment } from 'react';
import { useStore } from '../store.js';
import { Copyable } from './ui.jsx';

export function CliHints({ module: moduleId }: { module: string }) {
  const { boot } = useStore();
  const cmds = (boot?.commands || []).filter((c) => c.module === moduleId);
  if (!cmds.length) return null;

  return (
    <div className="cli-hint">
      <span className="cli-hint-label">这个页面上的每个按钮都有一条同构的 CLI 命令</span>
      {cmds.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <span className="cli-hint-sep"> · </span>}
          <Copyable className="cli-cmd" text={c.command} title={`点击复制：${c.usage}`}>
            {c.command}
          </Copyable>
        </Fragment>
      ))}
      <span className="cli-hint-tail">。加 <code className="cli-hint-flag">--json</code> 得机器可读输出。</span>
    </div>
  );
}
