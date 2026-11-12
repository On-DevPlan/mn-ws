// 文本/二进制路径判定（skill 标准模块自包含，不依赖项目里的生成器）。
import { basename } from 'node:path';

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt',
  '.css', '.html', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh',
  '.gitignore', '.npmrc', '.env', '.editorconfig', '',
]);

export function isTextPath(rel: string): boolean {
  const name = basename(rel);
  const dot = name.lastIndexOf('.');
  const ext = dot <= 0 ? '' : name.slice(dot).toLowerCase();
  return TEXT_EXT.has(ext) || /\.(gitignore|npmrc|editorconfig)$/.test(name);
}
