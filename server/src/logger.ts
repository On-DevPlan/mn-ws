import fs from 'node:fs';
import path from 'node:path';

/**
 * 极简分级日志器。
 *
 * 与 mn-rt 的 client/lib/logger.js 同款：写文件 + 控制台，
 * 不引第三方依赖（这个包要能被 npx 一把跑起来，依赖越少越好）。
 */

export const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  level: number;
  levelName: string;
  dir: string | null;
  name: string;
  private stream: fs.WriteStream | null;

  constructor({ level = 'info', dir = null, name = 'mn-ws' }: { level?: string; dir?: string | null; name?: string } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info ?? 20;
    this.levelName = level;
    this.dir = dir;
    this.name = name;
    this.stream = null;

    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${name}.log`);
        this.stream = fs.createWriteStream(file, { flags: 'a' });
      } catch {
        this.stream = null; // 写不了日志不是致命错误，降级成只打控制台
      }
    }
  }

  private _log(level: LogLevel, msg: string, extra?: unknown): void {
    if ((LEVELS[level] || 0) < this.level) return;
    const ts = new Date().toISOString();
    const line = extra
      ? `${ts} [${level.toUpperCase()}] ${msg} ${safeJson(extra)}`
      : `${ts} [${level.toUpperCase()}] ${msg}`;
    try { process.stdout.write(`${line}\n`); } catch { /* ignore */ }
    if (this.stream) {
      try { this.stream.write(`${line}\n`); } catch { /* ignore */ }
    }
  }

  debug(msg: string, extra?: unknown): void { this._log('debug', msg, extra); }
  info(msg: string, extra?: unknown): void { this._log('info', msg, extra); }
  warn(msg: string, extra?: unknown): void { this._log('warn', msg, extra); }
  error(msg: string, extra?: unknown): void { this._log('error', msg, extra); }

  close(): void {
    if (this.stream) {
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }
  }
}

function safeJson(obj: unknown): string {
  try { return JSON.stringify(obj); } catch { return '[unserializable]'; }
}
