'use strict';

/**
 * 审计落盘：每次经桥的请求记一行 JSONL。
 *
 * 为什么必须落盘：mn-ws server 是**新的公网暴露面**，它能代理到本机的
 * 十几个服务。出事时「谁在什么时候调了哪个 app 的哪个路径」必须查得到，
 * 否则就是一笔糊涂账。
 *
 * 与 mn-rt 的 client/lib/store.js 同款：JSONL 追加，尾部读。
 */

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor({ dir = null, name = 'requests.jsonl', maxTail = 200 } = {}) {
    this.dir = dir;
    this.file = dir ? path.join(dir, name) : null;
    this.maxTail = maxTail;
    this._tail = [];
    if (this.file) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this._tail = readTail(this.file, this.maxTail);
      } catch { /* ignore */ }
    }
  }

  /** 追加一条记录。 */
  append(record) {
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
  tail(n = 50) {
    const k = Math.max(0, this._tail.length - n);
    return this._tail.slice(k);
  }

  stats() {
    return { count: this._tail.length, file: this.file };
  }
}

function readTail(file, max) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-max).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}

module.exports = { Store };
