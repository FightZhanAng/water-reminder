import type { DrinkLog, DrinkSource } from './types'

/** 一杯的毫升数范围。写入路径（`sanitizeMl`）和读盘清理共用这一对常量 */
export const MIN_ML = 10
export const MAX_ML = 2000

const SOURCES: readonly DrinkSource[] = ['manual', 'tray', 'shortcut', 'float', 'notification']

export function isDrinkSource(value: unknown): value is DrinkSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

/**
 * 读盘时清理一条记录；结构上不可用就返回 null（丢掉这一条）。
 *
 * 记录和设置是同一类东西 —— 躺在磁盘上、可能被手改 —— 但坏掉的后果更外露：
 *
 * - **source 不是字符串时必须兜住。** 渲染层那句 `SOURCE_LABEL[log.source] ?? log.source`
 *   在 source 是对象时会把**对象本身**交给 React 当子节点，直接白屏；
 *   这不是「显示成乱码」，是整个界面没了。
 * - **ml 是 0/负数/非有限值直接丢掉。** 那不是「喝了一杯」，是坏数据；
 *   留着它会让今日合计、连续达标、近 7 天全跟着错，而且从界面上看不出来。
 * - **ml 超范围但合理（比如手写成 5000）夹到区间内**，和 IPC 那条路一个口径：
 *   宁可记成 2000，也别把用户写下的记录整条扔掉。
 * - **id 缺失就补一个**（`mintId` 由调用方注入，shared 不碰 node:crypto）。
 */
export function sanitizeLog(value: unknown, mintId: () => string): DrinkLog | null {
  if (!value || typeof value !== 'object') return null
  const l = value as Partial<DrinkLog>
  if (typeof l.ts !== 'number' || !Number.isFinite(l.ts) || l.ts <= 0) return null
  if (typeof l.ml !== 'number' || !Number.isFinite(l.ml) || l.ml <= 0) return null

  const id = typeof l.id === 'string' && l.id.length > 0 ? l.id : mintId()
  return {
    id,
    ml: Math.min(MAX_ML, Math.max(MIN_ML, Math.round(l.ml))),
    ts: l.ts,
    source: isDrinkSource(l.source) ? l.source : 'manual'
  }
}

/**
 * 清理整个记录数组：逐条过 `sanitizeLog`，id 撞车的重新发一个，最后按时间排序。
 *
 * id 撞车（复制粘贴出来的记录）会让渲染层的 key 重复；排序是为了让
 * `undoLast` 的「上一次」真的等于时间上最后一次 —— 手改过的文件不保证是排好的，
 * 而 `undoLast` 取的是数组末尾那一条。
 */
export function sanitizeLogs(raw: unknown, mintId: () => string): DrinkLog[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: DrinkLog[] = []
  for (const item of raw) {
    const log = sanitizeLog(item, mintId)
    if (!log) continue
    if (seen.has(log.id)) log.id = mintId()
    seen.add(log.id)
    out.push(log)
  }
  return out.sort((a, b) => a.ts - b.ts)
}
