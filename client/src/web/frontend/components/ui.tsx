// 通用 UI 件：toast、对话框、弹窗、错误边界、diff 渲染。
// 约定延续自 vanilla 版：无 emoji、不用浏览器原生弹窗（alert/confirm/prompt 一律页内实现）。
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// ---- toast：页内轻提示（自动消失） ----

type ToastFn = (msg: ReactNode) => void;
const ToastCtx = createContext<ToastFn | null>(null);

interface ToastItem {
  id: number;
  msg: ReactNode;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msgs, setMsgs] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback<ToastFn>((msg) => {
    const id = ++idRef.current;
    setMsgs((m) => [...m, { id, msg }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 2800);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-stack">
        {msgs.map((m) => <div key={m.id} className="toast show">{m.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastCtx) || ((m) => console.log(m));
}

// 操作守卫：包一层，失败自动 toast 错误信息（对应 vanilla 版的 guard()）
export function useGuard() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        toast(String((e as { message?: string })?.message || e));
        return undefined;
      }
    },
    [toast],
  );
}

// ---- 点击即复制：所有路径/长标识的展示标准 ----
// 点一下复制全文；hover 显示「点击复制」提示；复制成功 toast 确认。
interface CopyableProps {
  text: unknown;
  className?: string;
  title?: string;
  children?: ReactNode;
}

export function Copyable({ text, className = '', title, children }: CopyableProps) {
  const toast = useToast();
  const confirm = (v: string) => toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
  const copy = async () => {
    const v = String(text ?? '');
    try {
      await navigator.clipboard.writeText(v);
      confirm(v);
    } catch {
      // 剪贴板 API 不可用（非安全上下文等）：退回 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = v;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        confirm(v);
      } catch {
        toast('复制失败（剪贴板不可用）');
      }
    }
  };
  return (
    <span
      className={'copyable' + (className ? ' ' + className : '')}
      title={title || '点击复制'}
      onClick={copy}
    >{children !== undefined ? children : String(text)}</span>
  );
}

// ---- 对话框：确认 / 输入（Promise 风格，对应 vanilla 版 dialog()） ----

interface DialogOptions {
  title?: ReactNode;
  message?: ReactNode;
  input?: boolean;
  placeholder?: string;
  value?: string;
  okText?: string;
  danger?: boolean;
}

export function useDialog() {
  interface DialogState extends DialogOptions {
    resolve: (v: string | boolean | null) => void;
  }
  const [state, setState] = useState<DialogState | null>(null);
  // 用 ref 读输入框，而不是 document.querySelector('.dlg-input')——
  // 后者绕开 React 直接摸 DOM，页面上有第二个同名类名时就会读错。
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback((val: string | boolean | null) => {
    setState((s) => {
      if (s) s.resolve(val);
      return null;
    });
  }, []);

  const dialog = useCallback(
    (opts: DialogOptions = {}) =>
      new Promise<string | boolean | null>((resolve) => {
        setState({ ...opts, resolve });
      }),
    [],
  );

  const node = state ? (
    <div className="dlg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="dlg-box">
        {state.title ? <div className="dlg-title">{state.title}</div> : null}
        {state.message ? <div className="dlg-msg">{state.message}</div> : null}
        {state.input ? (
          <input
            ref={inputRef}
            className="dlg-input"
            autoFocus
            spellCheck="false"
            placeholder={state.placeholder || ''}
            defaultValue={state.value || ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') close(e.currentTarget.value.trim());
              if (e.key === 'Escape') close(null);
            }}
          />
        ) : null}
        <div className="dlg-acts">
          <button className="btn ghost" onClick={() => close(null)}>取消</button>
          <button
            className={'btn' + (state.danger ? ' danger' : '')}
            onClick={() => close(state.input ? (inputRef.current?.value.trim() ?? null) : true)}
          >
            {state.okText || '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { dialog, node };
}

// ---- 错误边界：把崩溃限制在单个视图内 ----
// 视图都是 lazy() 加载的，没有这层兜底时，任何一个视图抛错（或 chunk 加载失败）
// 都会让整个面板白屏，用户连切到别的 tab 自救都做不到。

interface BoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: unknown) {
    console.error('[mn-ws] 视图渲染失败:', error, info);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="colhead"><h3>这个面板出错了</h3></div>
        <div className="dlg-msg">{String(this.state.error?.message || this.state.error)}</div>
        <div className="muted" style={{ marginBottom: 10 }}>
          其他面板不受影响，可以切到别的 tab 继续操作；控制台有完整堆栈。
        </div>
        <button className="btn" onClick={() => this.setState({ error: null })}>重试</button>
      </div>
    );
  }
}

// ---- 弹窗：大块内容（diff / 冲突详情 / 命令输出） ----

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-title">
          <span>{title}</span>
          <button className="btn small ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---- diff 文本渲染（+/- 行着色） ----

export function DiffPre({ text }: { text: unknown }) {
  const lines = String(text ?? '').split('\n');
  return (
    <pre>
      {lines.map((line, i) => (
        <span key={i} className={
          line.startsWith('+') && !line.startsWith('+++') ? 'd-add'
            : line.startsWith('-') && !line.startsWith('---') ? 'd-del' : ''
        }>
          {line}{i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}
