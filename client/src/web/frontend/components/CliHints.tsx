// CLI 等价提示：列出当前模块的全部同构命令。
//
// 为什么由数据派生而不是手写：这行提示是用户核对「面板上这个按钮到底有没有 CLI 等价」
// 的唯一依据。改造前它是每个视图各自维护的字符串，命令一改就悄悄过期——
// 提示说「有」，实际没有，比没有提示更糟。
// 现在它来自 bootstrap 下发的命令表，与 CLI 实际注册的命令同源。
//
// ── 为什么收进「高级」里，默认折叠 ──────────────────────────────────────
//
// 用户反馈：「具有开发性质的放到一个高级按钮里面即可，用户没必要认识 ws 认识 cli」。
// 这条命令表是给**开发者**核对用的：它回答「面板这个按钮对应哪条命令」。
// 对只想把端口暴露出去的用户，它是一屏噪音 —— 而且是**整页最长的**一段。
// 所以默认收起，只留一个「高级」入口；需要核对的人点开即可。
import { useState } from 'react';
import { Fragment } from 'react';
import { useStore } from '../store.js';
import { Copyable } from './ui.jsx';

export function CliHints({ module: moduleId }: { module: string }) {
  const { boot } = useStore();
  const cmds = (boot?.commands || []).filter((c) => c.module === moduleId);
  const [open, setOpen] = useState(false);
  if (!cmds.length) return null;

  return (
    <details className="cli-hint" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cli-hint-summary">
        <span className="cli-hint-label">高级：这些按钮对应的命令行</span>
        <span className="cli-hint-count">{cmds.length}</span>
      </summary>
      <div className="cli-hint-body">
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
    </details>
  );
}
