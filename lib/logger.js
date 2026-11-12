'use strict';

/**
 * 极简分级日志器。
 *
 * 与 mn-rt 的 client/lib/logger.js 同款：写文件 + 控制台，
 * 不引第三方依赖（这个包要能被 npx 一把跑起来，依赖越少越好）。
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor({ level = 'info', dir = null, name = 'mn-ws' } = {}) {
    this.level = LEVELS[level] || LEVELS.info;
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

  _log(level, msg, extra) {
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

  debug(msg, extra) { this._log('debug', msg, extra); }
  info(msg, extra) { this._log('info', msg, extra); }
  warn(msg, extra) { this._log('warn', msg, extra); }
  error(msg, extra) { this._log('error', msg, extra); }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }
  }
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return '[unserializable]'; }
}

module.exports = { Logger, LEVELS };
