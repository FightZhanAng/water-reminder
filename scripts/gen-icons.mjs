/**
 * 图标生成器 —— 纯 Node 实现，零依赖。
 *
 * 产出：
 *   resources/icon.png            256x256 应用图标（快捷方式、任务栏、窗口）
 *   resources/icon.ico            多尺寸 Windows 图标（16/24/32/48/64/128/256）
 *   resources/icon.icns           macOS 图标（16..1024 全档，electron-builder 的 mac 目标用）
 *   resources/tray/tray-<n>.png   32x32 托盘水滴，n = 0,10,...,100 即水位刻度
 *
 * ── 应用图标：一颗装了水的玻璃水滴，全幅，不带底板 ──
 *
 * 为什么不留底板（深色圆角方块那一层）：16px 一共才 256 个像素，套一层底板等于
 * 再切掉三成给留白；而快捷方式图标的左下角还要被系统叠一个箭头角标。全幅水滴
 * 把主体做满，角标压上来仍然认得出。代价是它不再像「一块 App」，而就是那颗水滴 ——
 * 这反而和托盘图标、和界面里那颗水滴合成了一套。
 *
 * ── 轮廓用「两圆外公切线」，不是 r*sqrt(...) ──
 *
 * 之前用的是 halfW = r*sqrt((y-apex)/(cy-apex))：在顶点斜率无穷大，会拉成一根细刺。
 * 细刺 + 一圈亮描边 + 一道平直液面，三样凑一起会被读成「手提包 / 挂锁」—— 实测
 * 16px 下尤其明显。现在把顶端换成一个小圆、底端一个大圆、外侧用外公切线连起来，
 * 尖是圆润的，弧线是连续的。
 *
 * 液面那道亮线不是装饰：应用里水位尺、量筒、近 7 天水位条反复出现的就是它。
 * 而且它要微微中间低、贴壁高 —— 弯月面本来就贴壁往上爬，画成平直一条会立刻
 * 变回「包口」。
 *
 * ── 托盘：同一颗水滴，但颜色刻意不跟着上面走 ──
 *
 * 托盘只有 16px，还要落在深浅两种任务栏上。所以轮廓走中性冷灰、水色用青，
 * 达标才转荧光青绿。跟着深色板走的话，深色水滴落到深色任务栏上等于把图标删了。
 *
 * ── 为什么 ICO / ICNS 也自己写 ──
 *
 * electron-builder 默认用它的 WASM 图标工具做 png→ico / png→icns 转换，那东西在
 * 内存受限的环境里会直接 `WebAssembly.Memory(): could not allocate memory`
 * 把打包流程搞挂。自己生成既绕开这个坑，也少一层依赖。另外自己画而不引入
 * sharp/canvas：那两个都是原生模块，一旦带上就得处理 electron-rebuild，
 * 为一个图标不值得。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4 + 1
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------- 光栅化工具 */

/**
 * @param {number} size 画布边长
 * @param {(px:number, py:number) => {rgb:number[], a:number}|null} sampler
 *        入参为 0..1 归一化坐标，返回颜色与非预乘 alpha
 * @param {number} [ss] 每像素超采样倍数（ss x ss）。小尺寸要更高，
 *        否则 16px 的图标总共只有 64x64 个采样点，液面这种细结构会碎掉
 */
function rasterize(size, sampler, ss = size <= 32 ? 8 : 4) {
  const out = Buffer.alloc(size * size * 4)
  const total = ss * ss
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) / size
          const py = (y + (sy + 0.5) / ss) / size
          const hit = sampler(px, py)
          if (hit) {
            r += hit.rgb[0] * hit.a
            g += hit.rgb[1] * hit.a
            b += hit.rgb[2] * hit.a
            a += hit.a
          }
        }
      }
      const i = (y * size + x) * 4
      if (a > 0) {
        out[i] = Math.round(r / a)
        out[i + 1] = Math.round(g / a)
        out[i + 2] = Math.round(b / a)
        out[i + 3] = Math.round((a / total) * 255)
      }
    }
  }
  return out
}

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v)

/** 多停渐变：stops = [[位置, 颜色], ...]，位置递增 */
function ramp(stops, t) {
  const x = clamp(t)
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]
    if (x <= p1 || i === stops.length - 1) {
      const [p0, c0] = stops[i - 1]
      const span = p1 - p0 || 1
      return lerp(c0, c1, clamp((x - p0) / span))
    }
  }
  return stops[0][1]
}

/* ------------------------------------------------------------ 水滴几何 */

/**
 * 圆头锥形水滴：顶端一个小圆、底端一个大圆，两者圆心同在竖轴上，
 * 外侧用外公切线连起来。
 *
 * 为什么不用「半宽 = r*sqrt(...)」那套：那种剖面在顶点处斜率无穷大，
 * 会拉出一根细刺；细刺配上亮描边和一道平直液面，整体就被读成手提包。
 * 外公切线版的顶端是个小圆，尖得圆润，弧线连续。
 *
 * 返回的对象里：
 *   top / bottom  水滴的上下边界
 *   halfWAt(y)    某个高度处的半宽（算弯月面要用）
 *   depth(px,py)  形状内返回「到轮廓的垂直距离」，形状外返回 null
 */
function makeTeardrop({ cx, y1, r1, y2, r2 }) {
  const D = y2 - y1
  const de = r2 - r1
  if (D <= de || D <= 0) throw new Error('水滴参数退化：需要 y2-y1 > r2-r1 > 0')

  // 外公切线的法线 x 分量与斜率；切线在竖直方向上的倾斜角由 (r2-r1)/(y2-y1) 决定
  const nx = Math.sqrt(1 - (de * de) / (D * D))
  const slope = de / Math.sqrt(D * D - de * de)
  const norm = Math.sqrt(1 + slope * slope)

  // 两个切点：顶端小圆上的、底端大圆上的
  const t1y = y1 - (r1 * de) / D
  const t2y = y2 - (r2 * de) / D
  const t1half = r1 * nx

  return {
    cx,
    top: y1 - r1,
    bottom: y2 + r2,
    halfWAt(y) {
      if (y <= t1y) return Math.sqrt(Math.max(0, r1 * r1 - (y - y1) ** 2))
      if (y >= t2y) return Math.sqrt(Math.max(0, r2 * r2 - (y - y2) ** 2))
      return t1half + (y - t1y) * slope
    },
    depth(px, py) {
      const dx = Math.abs(px - cx)
      if (py <= t1y) {
        const d = Math.hypot(dx, py - y1)
        return d > r1 ? null : r1 - d
      }
      if (py >= t2y) {
        const d = Math.hypot(dx, py - y2)
        return d > r2 ? null : r2 - d
      }
      const halfW = t1half + (py - t1y) * slope
      if (dx > halfW) return null
      return (halfW - dx) / norm
    }
  }
}

/* ------------------------------------------------------- 应用图标（水滴）*/

/*
 * 留白是有意留的：上下各约 7% 给快捷方式角标和视觉呼吸，
 * 主体高度约 86% —— 16px 下换算出约 13.7px，是这个尺寸能给的极限。
 */
const DROP = makeTeardrop({ cx: 0.5, y1: 0.115, r1: 0.048, y2: 0.6, r2: 0.325 })

/** 水滴外壳（描边）：上亮下暗，像一圈玻璃口沿 */
const RIM_TOP = [178, 244, 255]
const RIM_BOTTOM = [46, 140, 172]
const STROKE = 0.03

/** 水滴空腔（液面以上）：玻璃内壁，比外壳暗、比深水亮 */
const GLASS_TOP = [11, 46, 60]
const GLASS_BOTTOM = [20, 78, 100]
/** 沿内缘的菲涅尔亮边：越贴近轮廓越亮 */
const FRESNEL_COLOR = [216, 250, 255]
const FRESNEL = 0.45
/** 宽幅顶光：整块玻璃被上方照亮，从上往下渐暗 */
const SHEEN_COLOR = [150, 226, 244]
const SHEEN = 0.14

/** 液面：一道发光的水线，中间低贴壁高（弯月面）；水线以下是发光水体，越深越沉 */
const LEVEL = 0.5
const LINE_H = 0.022
const ARC = 0.016
const MENISCUS = [232, 253, 255]
const WATER_RAMP = [
  [0, [152, 250, 255]],
  [0.3, [56, 206, 236]],
  [0.7, [10, 106, 136]],
  [1, [4, 56, 76]]
]

function appIconSampler(px, py) {
  const depth = DROP.depth(px, py)
  if (depth === null) return null // 全幅：轮廓外直接透明

  const span = DROP.bottom - DROP.top

  // 1) 外壳
  if (depth <= STROKE) {
    return { rgb: lerp(RIM_TOP, RIM_BOTTOM, clamp((py - DROP.top) / span)), a: 1 }
  }

  // 2) 弯月面
  const waterY = DROP.top + span * LEVEL
  const halfW = Math.max(DROP.halfWAt(waterY), 1e-4)
  const dxN = clamp(Math.abs(px - DROP.cx) / halfW)
  const line = waterY + ARC * (1 - dxN * dxN)

  // 3) 液面以上：玻璃内壁
  if (py < line) {
    let glass = lerp(GLASS_TOP, GLASS_BOTTOM, clamp((py - DROP.top) / Math.max(line - DROP.top, 1e-4)))
    glass = lerp(glass, SHEEN_COLOR, clamp(1 - (py - DROP.top) / Math.max(line - DROP.top, 1e-4)) * SHEEN)
    glass = lerp(glass, FRESNEL_COLOR, Math.pow(clamp(1 - depth / 0.075), 1.5) * FRESNEL)
    return { rgb: glass, a: 1 }
  }

  // 4) 水线本身
  if (py < line + LINE_H) return { rgb: MENISCUS, a: 1 }

  // 5) 水体
  return {
    rgb: ramp(WATER_RAMP, (py - line - LINE_H) / Math.max(DROP.bottom - line - LINE_H, 1e-4)),
    a: 1
  }
}

/* ------------------------------------------- 水滴水位（托盘图标）*/

/*
 * 托盘只有 16px，而且要在深浅两种任务栏上都读得出来：
 * 轮廓用中性冷灰、水色用青，达标才转荧光青绿。别跟着应用的深色板走 ——
 * 深色水滴落到深色任务栏上等于把图标删了。
 */
const TRAY_EMPTY = [126, 138, 144]
const TRAY_EMPTY_ALPHA = 0.26
const TRAY_STROKE_ALPHA = 0.86
const TRAY_WATER_TOP = [142, 238, 250]
const TRAY_WATER_BOTTOM = [9, 106, 138]
const TRAY_DONE_TOP = [96, 236, 206]
const TRAY_DONE_BOTTOM = [14, 140, 112]

// 和 DROP 同一套剖面、同样的瘦长比，只是整体缩到 32x32 里留一点呼吸位
const TRAY_DROP = makeTeardrop({ cx: 0.5, y1: 0.12, r1: 0.046, y2: 0.585, r2: 0.31 })
const TRAY_SPAN = TRAY_DROP.bottom - TRAY_DROP.top
const TRAY_STROKE = 0.032

/** 水滴轮廓固定，水面随进度上升；装满时整颗转绿 */
function dropLevelSampler(progress) {
  const level = TRAY_DROP.bottom - TRAY_SPAN * Math.min(1, progress)
  const done = progress >= 1
  const top = done ? TRAY_DONE_TOP : TRAY_WATER_TOP
  const bottom = done ? TRAY_DONE_BOTTOM : TRAY_WATER_BOTTOM

  return (px, py) => {
    const depth = TRAY_DROP.depth(px, py)
    if (depth === null) return null
    if (depth <= TRAY_STROKE) return { rgb: TRAY_EMPTY, a: TRAY_STROKE_ALPHA }
    if (py < level) return { rgb: TRAY_EMPTY, a: TRAY_EMPTY_ALPHA }
    return { rgb: lerp(top, bottom, (py - level) / Math.max(TRAY_DROP.bottom - level, 1e-4)), a: 1 }
  }
}

/* ---------------------------------------------------------------- ICO 编码 */

/**
 * 单帧编码成 ICO 内嵌的 BMP 形式。
 * ICO 里的 BMP 没有文件头，直接是 BITMAPINFOHEADER；
 * 且高度要写成实际高度的两倍 —— 上半是 XOR 像素，下半是 1bpp 的 AND 掩码。
 */
function encodeBmpFrame(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight：XOR + AND
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const sourceY = size - 1 - y // BMP 自下而上
    for (let x = 0; x < size; x++) {
      const s = (sourceY * size + x) * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }

  // AND 掩码每行按 4 字节对齐，自下而上，位序高位在前。1 = 透明、0 = 不透明。
  // 现代 Windows 走 32bpp 的 alpha 通道、根本不看这块，但忽略 alpha 的旧路径
  // （某些老控件、老看图器、部分缩略图生成器）会退回到它 —— 写成全 0 的话，
  // 那些地方会把轮廓外的透明区域画成一个黑方块。花几行写对，省一类难查的怪毛病
  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)
  for (let y = 0; y < size; y++) {
    const sourceY = size - 1 - y // 和 XOR 一样自下而上
    for (let x = 0; x < size; x++) {
      if (rgba[(sourceY * size + x) * 4 + 3] >= 128) continue
      mask[y * maskRowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }

  return Buffer.concat([header, xor, mask])
}

function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)

  const directory = Buffer.alloc(frames.length * 16)
  let offset = 6 + frames.length * 16

  frames.forEach((frame, index) => {
    const base = index * 16
    // 256 在这个字段里用 0 表示
    directory[base] = frame.size >= 256 ? 0 : frame.size
    directory[base + 1] = frame.size >= 256 ? 0 : frame.size
    directory[base + 2] = 0 // 调色板色数
    directory[base + 3] = 0 // reserved
    directory.writeUInt16LE(1, base + 4) // planes
    directory.writeUInt16LE(32, base + 6) // bitCount
    directory.writeUInt32LE(frame.data.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += frame.data.length
  })

  return Buffer.concat([header, directory, ...frames.map((frame) => frame.data)])
}

/* ---------------------------------------------------------------- ICNS 编码 */

/**
 * macOS 应用图标。结构和 ICO 同级地简单：8 字节文件头（magic + 总长），
 * 后面每块是「4 字节类型 + 4 字节块长（含这 8 字节头）+ 数据」。
 * 现代 macOS 对所有类型都接受内嵌 PNG，不用像 ICO 那样手写 BMP 帧。
 *
 * 类型按 Apple 的 Icon Family 约定（ic11~ic14 是 1x 小尺寸的 @2x 版）：
 *   ic04/ic05 = 16/32、ic07 = 128、ic08 = 256、ic09 = 512、ic10 = 1024（512@2x）
 *   ic11/ic12 = 32/64（16/32 的 2x）、ic13/ic14 = 256/512（128/256 的 2x）
 *
 * electron-builder 对 mac.icon 的要求是「至少 512px」，ic09/ic10 两档满足它；
 * 小档不齐的话系统会放大凑数，全档出齐是为了 Dock / 访达 / 预览的观感。
 */
const icnsTypes = [
  ['ic04', 16],
  ['ic05', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512]
]

function encodeIcns(entries) {
  const chunks = entries.map(([type, size]) => {
    const png = encodePng(size, size, rasterize(size, appIconSampler))
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

/* ------------------------------------------------------------------ 主流程 */

// 大尺寸用 PNG 内嵌（体积小），小尺寸用 BMP（兼容性最好）
const icoSizes = [16, 24, 32, 48, 64, 128, 256]

/*
 * 只在「直接执行」时写盘。被 import 时（验证脚本要复用采样器）保持只读 ——
 * 免得一次「看图」的动作顺手改写了 resources/。
 */
const isDirectRun =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  const iconDir = join(ROOT, 'resources')
  const trayDir = join(iconDir, 'tray')
  mkdirSync(trayDir, { recursive: true })

  const iconPath = join(iconDir, 'icon.png')
  const iconRgba256 = rasterize(256, appIconSampler)
  writeFileSync(iconPath, encodePng(256, 256, iconRgba256))

  const icoFrames = icoSizes.map((size) => {
    const rgba = size === 256 ? iconRgba256 : rasterize(size, appIconSampler)
    return { size, data: size >= 128 ? encodePng(size, size, rgba) : encodeBmpFrame(rgba, size) }
  })
  const icoPath = join(iconDir, 'icon.ico')
  writeFileSync(icoPath, encodeIco(icoFrames))

  const icnsPath = join(iconDir, 'icon.icns')
  writeFileSync(icnsPath, encodeIcns(icnsTypes))

  for (let percent = 0; percent <= 100; percent += 10) {
    const png = encodePng(32, 32, rasterize(32, dropLevelSampler(percent / 100)))
    writeFileSync(join(trayDir, `tray-${percent}.png`), png)
  }

  console.log(`icon  -> ${iconPath}`)
  console.log(`ico   -> ${icoPath} (${icoSizes.join('/')}, ${icoFrames.length} 帧)`)
  console.log(`icns  -> ${icnsPath} (${icnsTypes.map(([t, s]) => `${t}:${s}`).join(' ')})`)
  console.log(`tray  -> ${trayDir}/tray-0..100.png (11 帧水位)`)
}

// 给验证脚本用：导入本文件即可复用同一套采样器，保证「看到的」和「产出的」是同一份
export { rasterize, encodePng, appIconSampler, dropLevelSampler, icoSizes }
