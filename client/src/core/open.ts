// 交给操作系统的两个动作：打开浏览器、在文件管理器里打开目录。
// 零业务语义，且刻意不抛错——打不开就算了，调用方已经打印了地址。
import { spawn } from 'node:child_process';

function open(target: string): void {
  try {
    const plat = process.platform;
    if (plat === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 静默降级：调用方已经把 URL / 路径打印到终端
  }
}

export function openBrowser(url: string): void {
  open(url);
}

export function openPath(dir: string): void {
  open(dir);
}
