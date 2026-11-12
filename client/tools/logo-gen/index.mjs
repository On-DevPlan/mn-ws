// logo 生成：纯 JS 的 SVG + PNG 双产出，零依赖。
//
// 为什么放模板自己的 tools/ 而不是生成器核心：logo 是**这个模板的偏好**，
// 不是通用生成能力。别的模板（比如一个纯 CLI 项目）不需要它。
// 生成器核心只认识「文件」，不认识「图片」。
//
// 承袭自 nx-rp 的 Python 版（.tool/logo-gen），撞色方案表一致；
// 这里改成零依赖 JS，好处是新项目 `pnpm install` 之前就能出图，
// 且不必为生成 8 个小图标拉进 pillow 这种重依赖。
//
// ⚠️ **已知局限（选型时请知情）**：
//   SVG 用真实字体（font-family 交给浏览器选），质量好、任意尺寸清晰，
//   大图与面板 header 一律用它。
//   PNG 走内置 5x7 点阵字模，**只适合 1~3 个字母**——
//   字母再多，点阵放大后的块状感会明显（像低分辨率像素字）。
//   家族里 nx-xx 的两位字母正是这个工具的甜区。
//   若将来需要 4~5 字母的好字形，正解是给 PNG 引入字体光栅化，
//   而不是继续往点阵表里堆字符——那只会让「大图偏小、小图偏糊」两头不讨好。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---- 撞色方案（背景 + 字母）----
// 经典撞色短名单：一冷一暖 / 一深一浅，保证小尺寸下字母仍然跳得出来。
export const SCHEMES = {
  klein: { name: '克莱因蓝', bg: '#002EA6', fg: '#FFE76F' },
  mars: { name: '马尔斯绿', bg: '#01847F', fg: '#F9D2E4' },
  hermes: { name: '爱马仕橙', bg: '#FF770F', fg: '#000026' },
  tiffany: { name: '蒂芙尼蓝', bg: '#80D1C8', fg: '#F8F5D6' },
  red: { name: '中国红', bg: '#FF0000', fg: '#FAEAD3' },
  vandyke: { name: '凡戴克棕', bg: '#492D22', fg: '#D8C7B5' },
  prussian: { name: '普鲁士蓝', bg: '#003153', fg: '#E5DDD7' },
};

export const DEFAULT_SCHEME = 'mars';

// ---- 几何 ----
// 圆角卡片比例与字号占比。0.22 是 iOS 图标感的圆角，0.72 让字母在 16px
// favicon 下仍可辨认（再大就顶到圆角边缘，再小就糊成一团）。
const RADIUS_RATIO = 0.22;
const GLYPH_RATIO = 0.72;

// 字体回退链：宽厚粗体在小尺寸下辨识度最好。
// SVG 里用 font-family 列表，由渲染方（浏览器）选；PNG 用同一套声明。
const FONT_STACK =
  "Verdana, 'DejaVu Sans', 'Segoe UI', Arial, 'Helvetica Neue', 'Microsoft YaHei', sans-serif";

export function toRGB(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * 生成 SVG 源码。矢量、无依赖、任意尺寸都清晰——**首选产物**。
 */
export function logoSvg(letters, scheme = DEFAULT_SCHEME, { size = 512, rounded = true } = {}) {
  const s = SCHEMES[scheme] || SCHEMES[DEFAULT_SCHEME];
  const r = rounded ? Math.round(size * RADIUS_RATIO) : 0;
  const text = escapeXml(letters);

  // 字号按字母数收敛：字越多越小，保证包围盒落在 GLYPH_RATIO 之内
  const fontSize = Math.round((size * GLYPH_RATIO) / Math.max(1, letters.length) / 0.62);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${text}">
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${s.bg}"/>
  <text x="50%" y="50%" fill="${s.fg}" font-family="${FONT_STACK}"
        font-size="${fontSize}" font-weight="bold" text-anchor="middle"
        dominant-baseline="central">${text}</text>
</svg>
`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

// ---- PNG 编码 ----
//
// 零依赖手写 PNG：zlib 用 node 内置的 deflateSync，CRC32 自己算。
// 为什么不用 canvas / sharp：生成 6 个小图标不值得为此拉进原生依赖，
// 而 favicon 必须是真的 PNG（ico 容器要求，浏览器也不吃 SVG 的 ico）。

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// 把 RGBA 像素数组编成 PNG
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 光栅化 ----
//
// 不引入字体库的前提下画字母：用**内置的 5x7 点阵字模**放大成块。
// 这是有意的取舍——真实字体要解析 TTF，代价远超收益；
// 而 logo 字母只有 1~5 个 ASCII 字符，点阵放大后加圆角即可，
// 在 16px favicon 上反而比细字体更清楚。
//
// 若将来要更精致的字形，正解是**只出 SVG**（矢量、字体由浏览器选），
// PNG 作为 favicon 的兜底保持点阵即可。

// 5x7 点阵字模。**大写与数字占满 7 行，小写只占 x-height（第 3~7 行）**——
// 这条区分是必需的：早期版本把小写 a 也画成 7 行满高，渲染出来跟 A 一模一样。
// 基线统一在第 7 行；p/q/g/y 的下伸部（descender）在 7 行格里放不下，
// 一律贴基线处理——这是点阵小字的通行简化，16px favicon 下看不出来。
const GLYPHS = {
  // ---- 小写（x-height = 5 行，第 3 行起）----
  // 注意 a 的第 3 行必须是 10001（碗左侧要闭）——写成 00001 会渲染成「3」。
  a: ['00000', '00000', '01110', '10001', '11111', '10001', '01111'],
  b: ['10000', '10000', '11110', '10001', '10001', '10001', '11110'],
  c: ['00000', '00000', '01110', '10001', '10000', '10001', '01110'],
  d: ['00001', '00001', '01111', '10001', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  g: ['00000', '01111', '10001', '10001', '01111', '00001', '01110'],
  h: ['10000', '10000', '11110', '10001', '10001', '10001', '10001'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  j: ['00010', '00000', '00110', '00010', '00010', '10010', '01100'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  m: ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  n: ['00000', '00000', '11110', '10001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  p: ['00000', '11110', '10001', '10001', '11110', '10000', '10000'],
  q: ['00000', '01111', '10001', '10001', '01111', '00001', '00001'],
  r: ['00000', '00000', '10110', '11001', '10000', '10000', '10000'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  t: ['01000', '01000', '11100', '01000', '01000', '01001', '00110'],
  u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
  v: ['00000', '00000', '10001', '10001', '10001', '01010', '00100'],
  w: ['00000', '00000', '10001', '10001', '10101', '10101', '01010'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  y: ['00000', '10001', '10001', '10001', '01111', '00001', '01110'],
  z: ['00000', '00000', '11111', '00010', '00100', '01000', '11111'],

  // ---- 大写（满 7 行）----
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],

  // ---- 数字 ----
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],

  // ---- 符号 ----
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
};

const GW = 5;
const GH = 7;

// 在画布上以给定前景色填充一个点阵字符（每个点展开成 px×px 的方块）
function blitGlyph(px, width, height, glyph, ox, oy, scale, color) {
  const rows = GLYPHS[glyph] || GLYPHS.o;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (rows[gy][gx] !== '1') continue;
      const x0 = ox + gx * scale;
      const y0 = oy + gy * scale;
      for (let y = y0; y < y0 + scale; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = x0; x < x0 + scale; x++) {
          if (x < 0 || x >= width) continue;
          // 圆角卡片外要留透明：这里只做矩形裁剪，圆角由 svg 负责；
          // PNG 用于 favicon，方角在 16px 下不可辨，不值得多写一套抗锯齿。
          const i = (y * width + x) * 4;
          px[i] = color[0];
          px[i + 1] = color[1];
          px[i + 2] = color[2];
          px[i + 3] = 255;
        }
      }
    }
  }
}

/**
 * 生成圆角/方形卡片的 RGBA 缓冲并编成 PNG。
 */
export function logoPng(letters, scheme = DEFAULT_SCHEME, { size = 512, bg = true } = {}) {
  const s = SCHEMES[scheme] || SCHEMES[DEFAULT_SCHEME];
  const px = new Uint8Array(size * size * 4);

  if (bg) {
    const c = toRGB(s.bg);
    for (let i = 0; i < size * size * 4; i += 4) {
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }

  const fg = toRGB(s.fg);
  const chars = [...String(letters)].slice(0, 5);
  if (!chars.length) return encodePng(size, size, px);

  // 字号按**墨迹宽度**算，不是按「字母数 × 字模宽」。
  // 字模是 5 列定宽，但字母实际只占其中几列（如 'i' 占 1 列、'm' 占 5 列），
  // 按定宽算会让窄字母组成的词明显偏小、四周留白过多。
  const GAP_COLS = 1; // 字距，单位 = 字模列
  let inkCols = 0;
  const cols = chars.map((ch) => {
    const c = inkColsOf(ch);
    inkCols += c.width;
    return c;
  });
  inkCols += GAP_COLS * Math.max(0, chars.length - 1);

  const scale = Math.max(1, Math.floor((size * GLYPH_RATIO) / inkCols));
  const wordW = inkCols * scale;

  // 垂直居中按**墨迹包围盒**算，不是按 7 行的 em 框：
  // 小写字母只占 x-height，按 em 框居中会让整词明显偏下。
  const bounds = inkBounds(chars);
  const inkRows = bounds.maxRow - bounds.minRow + 1;

  const ox = Math.round((size - wordW) / 2);
  const oy = Math.round((size - inkRows * scale) / 2) - bounds.minRow * scale;

  let x = ox;
  chars.forEach((ch, i) => {
    // 从墨迹左缘起画，把字模左侧的空白列去掉，否则每个字母左边都多一段空
    blitGlyph(px, size, size, ch, x - cols[i].left * scale, oy, scale, fg);
    x += (cols[i].width + GAP_COLS) * scale;
  });

  return encodePng(size, size, px);
}

// 字符的墨迹列范围（left/right 为字模列号，width = right - left + 1）
function inkColsOf(ch) {
  const rows = GLYPHS[ch] || GLYPHS.o;
  let left = GW;
  let right = -1;
  for (let c = 0; c < GW; c++) {
    for (let r = 0; r < GH; r++) {
      if (rows[r][c] === '1') {
        if (c < left) left = c;
        if (c > right) right = c;
        break;
      }
    }
  }
  if (right < left) return { left: 0, width: GW }; // 全空（空格）按定宽
  return { left, width: right - left + 1 };
}

// 整词的实际墨迹行范围（用于按视觉中心对齐）
function inkBounds(chars) {
  let minRow = GH;
  let maxRow = 0;
  for (const ch of chars) {
    const rows = GLYPHS[ch] || GLYPHS.o;
    for (let r = 0; r < GH; r++) {
      if (rows[r].includes('1')) {
        if (r < minRow) minRow = r;
        if (r > maxRow) maxRow = r;
      }
    }
  }
  if (minRow > maxRow) return { minRow: 0, maxRow: GH - 1 };
  return { minRow, maxRow };
}

/**
 * 一次产出全套 6 件，供模板钩子调用。
 *
 * @param {string} outDir   目标项目的 public 目录
 * @param {string} letters  项目字母
 * @param {string} scheme   撞色方案
 * @returns {{note: string, files: string[]}}
 */
export function generateAll(outDir, letters, scheme = DEFAULT_SCHEME) {
  mkdirSync(outDir, { recursive: true });
  const files = [];

  // 矢量主 logo：任意尺寸清晰，面板 header 用它
  writeFileSync(join(outDir, 'logo.svg'), logoSvg(letters, scheme, { size: 512, rounded: false }), 'utf8');
  writeFileSync(join(outDir, 'logo-rounded.svg'), logoSvg(letters, scheme, { size: 512, rounded: true }), 'utf8');
  files.push('logo.svg', 'logo-rounded.svg');

  // 位图：apple-touch-icon 与不支持 SVG favicon 的老浏览器
  writeFileSync(join(outDir, 'logo.png'), logoPng(letters, scheme, { size: 512, bg: false }));
  writeFileSync(join(outDir, 'logo-rounded.png'), logoPng(letters, scheme, { size: 512 }));
  files.push('logo.png', 'logo-rounded.png');

  for (const px of [16, 32, 48]) {
    writeFileSync(join(outDir, `favicon-${px}.png`), logoPng(letters, scheme, { size: px }));
    files.push(`favicon-${px}.png`);
  }

  // .ico：把 16/32/48 三个 PNG 塞进 ICO 容器（ICO 允许直接嵌 PNG，Vista 起支持）
  writeFileSync(join(outDir, 'favicon.ico'), buildIco([
    { size: 16, png: logoPng(letters, scheme, { size: 16 }) },
    { size: 32, png: logoPng(letters, scheme, { size: 32 }) },
    { size: 48, png: logoPng(letters, scheme, { size: 48 }) },
  ]));
  files.push('favicon.ico');

  const s = SCHEMES[scheme] || SCHEMES[DEFAULT_SCHEME];
  return {
    note: `logo 已生成（${letters} · ${s.name} ${s.bg}/${s.fg}）`,
    files,
  };
}

// ICO 容器：6 字节头 + 每张图 16 字节目录项 + 数据
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dirs = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const d = Buffer.alloc(16);
    d[0] = img.size >= 256 ? 0 : img.size; // 宽（256 记 0）
    d[1] = img.size >= 256 ? 0 : img.size; // 高
    d[2] = 0; // 调色板数
    d[3] = 0; // reserved
    d.writeUInt16LE(1, 4); // 色彩平面
    d.writeUInt16LE(32, 6); // 位深
    d.writeUInt32LE(img.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += img.png.length;
    dirs.push(d);
  }

  return Buffer.concat([header, ...dirs, ...images.map((i) => i.png)]);
}
