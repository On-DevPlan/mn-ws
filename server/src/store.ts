import fs from 'node:fs';
import path from 'node:path';

/**
 * 审计落盘：每次经桥的请求记一行 JSONL。
 *
 * 为什么必须落盘：mn-ws server 是**新的公网暴露面**，它能代理到本机的
 * 十几个服务。出事时「谁在什么时候调了哪个 app 的哪个路径」必须查得到，
 * 否则就是一笔糊涂账。
 *
 * 与 mn-rt 的 client/lib/store.js 同款：JSONL 追加，尾部读。
 */

/** 一条审计记录。 */
export interface AuditRecord {
  ts?: number;
  app?: string;
  method?: string;
  path?: string;
  status?: number;
  userId?: string;
  [k: string]: unknown;
}

export class Store {
  readonly dir: string | null;
  readonly file: string | null;
  readonly maxTail: number;
  private _tail: AuditRecord[] = [];

  constructor({ dir = null, name = 'requests.jsonl', maxTail = 200 }: { dir?: string | null; name?: string; maxTail?: number } = {}) {
    this.dir = dir;
    this.file = dir ? path.join(dir, name) : null;
    this.maxTail = maxTail;
    if (this.file && this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        this._tail = readTail(this.file, this.maxTail);
      } catch { /* ignore */ }
    }
  }

  /** 追加一条记录。 */
  append(record: AuditRecord): AuditRecord {
    const row = { ts: Date.now(), ...record };
    this._tail.push(row);
    if (this._tail.length > this.maxTail) this._tail.shift();
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
      } catch { /* 落盘失败不阻断主流程 */ }
    }
    return row;
  }

  /** 最近若干条（内存里已有一份，进程起来就能读）。 */
  tail(n = 50): AuditRecord[] {
    const k = Math.max(0, this._tail.length - n);
    return this._tail.slice(k);
  }

  stats(): { count: number; file: string | null } {
    return { count: this._tail.length, file: this.file };
  }
}

function readTail(file: string, max: number): AuditRecord[] {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-max).map((l) => {
      try { return JSON.parse(l) as AuditRecord; } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}
