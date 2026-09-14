/**
 * 图标生成器 —— 纯 Node 实现，零依赖。
 *
 * 产出：
 *   resources/icon.png            256x256 应用图标（水滴）
 *   resources/icon.ico            多尺寸 Windows 图标（16/24/32/48/64/128/256）
 *   resources/tray/tray-<n>.png   32x32 托盘进度环，n = 0,10,...,100
 *
 * 为什么 ICO 也自己写：electron-builder 默认用它的 WASM 图标工具做 png→ico 转换，
 * 那东西在内存受限的环境里会直接 `WebAssembly.Memory(): could not allocate memory`
 * 把整个打包流程搞挂。自己生成 ICO 既绕开这个坑，也少一层依赖。
 * 另外自己画而不引入 sharp/canvas：那两个都是原生模块，
 * 一旦带上就得处理 electron-rebuild，为一个图标不值得。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

const SS = 4 // 每像素 4x4 超采样，足够消除锯齿

/**
 * @param {number} size 画布边长
 * @param {(px:number, py:number) => {rgb:number[], a:number}|null} sampler
 *        入参为 0..1 归一化坐标，返回颜色与非预乘 alpha
 */
function rasterize(size, sampler) {
  const out = Buffer.alloc(size * size * 4)
  const total = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
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

  // AND 掩码每行按 4 字节对齐。32 位色下交给我们自己的 alpha 通道，全 0 即可
  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)

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

/* ------------------------------------------------------------ 水滴（图标）*/

const DROP_TOP = [94, 176, 245]
const DROP_BOTTOM = [24, 95, 165]

function dropSampler(px, py) {
  const cx = 0.5
  const apex = 0.09
  const cy = 0.605
  const r = 0.335

  if (py < apex) return null
  let halfW
  if (py <= cy) halfW = r * Math.sqrt((py - apex) / (cy - apex))
  else if (py <= cy + r) halfW = Math.sqrt(Math.max(0, r * r - (py - cy) * (py - cy)))
  else return null
  if (Math.abs(px - cx) > halfW) return null

  // 高光：左上角两枚柔和椭圆
  const hx = (px - 0.375) / 0.055
  const hy = (py - 0.495) / 0.075
  if (hx * hx + hy * hy <= 1) return { rgb: [255, 255, 255], a: 0.34 }
  const sx = (px - 0.335) / 0.028
  const sy = (py - 0.615) / 0.038
  if (sx * sx + sy * sy <= 1) return { rgb: [255, 255, 255], a: 0.26 }

  return { rgb: lerp(DROP_TOP, DROP_BOTTOM, (py - apex) / (1 - apex)), a: 1 }
}

/* --------------------------------------------------- 进度环（托盘图标）  */

const RING_TRACK = [136, 135, 128]
const RING_TRACK_ALPHA = 0.5
const RING_PROGRESS = [30, 136, 229]
const RING_DONE = [47, 168, 79]

function ringSampler(progress) {
  const cx = 0.5
  const cy = 0.5
  const outer = 0.4375
  const inner = 0.28125
  const mid = (outer + inner) / 2
  const arc = progress * Math.PI * 2
  const accent = progress >= 1 ? RING_DONE : RING_PROGRESS

  return (px, py) => {
    const dx = px - cx
    const dy = py - cy
    const d = Math.hypot(dx, dy)
    if (d < inner || d > outer) return null
    if (progress <= 0) return { rgb: RING_TRACK, a: RING_TRACK_ALPHA }
    let ang = Math.atan2(dx, -dy)
    if (ang < 0) ang += Math.PI * 2
    return ang <= arc ? { rgb: accent, a: 1 } : { rgb: RING_TRACK, a: RING_TRACK_ALPHA }
  }
}

/* ------------------------------------------------------------------ 主流程 */

const iconDir = join(ROOT, 'resources')
const trayDir = join(iconDir, 'tray')
mkdirSync(trayDir, { recursive: true })

const iconPath = join(iconDir, 'icon.png')
const iconRgba256 = rasterize(256, dropSampler)
writeFileSync(iconPath, encodePng(256, 256, iconRgba256))

// 大尺寸用 PNG 内嵌（体积小），小尺寸用 BMP（兼容性最好）
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoFrames = icoSizes.map((size) => {
  const rgba = size === 256 ? iconRgba256 : rasterize(size, dropSampler)
  return { size, data: size >= 128 ? encodePng(size, size, rgba) : encodeBmpFrame(rgba, size) }
})
const icoPath = join(iconDir, 'icon.ico')
writeFileSync(icoPath, encodeIco(icoFrames))

for (let percent = 0; percent <= 100; percent += 10) {
  const png = encodePng(32, 32, rasterize(32, ringSampler(percent / 100)))
  writeFileSync(join(trayDir, `tray-${percent}.png`), png)
}

console.log(`icon  -> ${iconPath}`)
console.log(`ico   -> ${icoPath} (${icoSizes.join('/')}, ${icoFrames.length} 帧)`)
console.log(`tray  -> ${trayDir}/tray-0..100.png (11 帧)`)
