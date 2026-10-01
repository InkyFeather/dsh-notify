// dsh-notify —— 诊断日志
//
// P0 的唯一目的就是「看清真实事件长什么样」，所以这里刻意不接任何日志服务，
// 直接落文件：宿主进程的 console 在桌面端不保证有去处，而文件一定看得到。
//
// 文件：$DSH_HOME/dsh-notify.log（超过 MAX_BYTES 时轮转一次为 .1）

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

function resolveLogPath() {
  const home = process.env.DSH_HOME
    || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'dsh-notify.log')
}

export const LOG_PATH = resolveLogPath()

let ready = false

function ensureReady() {
  if (ready) return
  ready = true
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
  } catch {
    /* 目录已存在或不可建：下面 append 会再失败一次，由调用方兜住 */
  }
}

function rotateIfNeeded() {
  try {
    if (!existsSync(LOG_PATH)) return
    if (statSync(LOG_PATH).size < MAX_BYTES) return
    renameSync(LOG_PATH, `${LOG_PATH}.1`)
  } catch {
    /* 轮转失败不该影响写日志 */
  }
}

/**
 * 描述一个值的外形：键名 + 类型 + **字符串真实长度**。
 *
 * 这是 P0 的核心工具：我们要知道 `displayReason` 到底有哪些 locale 键、
 * `reason` 有多长、`toolName` 是什么，而不是只看到 "[object Object]"。
 */
export function shape(value, depth = 2) {
  try {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    const t = typeof value
    if (t === 'string') return `string(${value.length})`
    if (t === 'number' || t === 'boolean') return `${t}(${String(value)})`
    if (t === 'bigint') return 'bigint'
    if (t === 'function') return 'function'
    if (t === 'symbol') return 'symbol'
    if (Array.isArray(value)) {
      const inner = value.length > 0 && depth > 0 ? ` [0]=${shape(value[0], depth - 1)}` : ''
      return `Array(${value.length})${inner}`
    }
    if (t === 'object') {
      const keys = Object.keys(value)
      if (depth <= 0) return `object{${keys.length}}`
      if (keys.length === 0) return 'object{}'
      return `{ ${keys.map((k) => `${k}: ${shape(value[k], depth - 1)}`).join(', ')} }`
    }
    return t
  } catch (err) {
    return `shape-error(${String((err && err.message) || err)})`
  }
}

/** 取字符串前 n 个字符，用于把真实文案记进日志。 */
export function preview(value, n = 300) {
  try {
    if (value === null || value === undefined) return ''
    const s = typeof value === 'string' ? value : JSON.stringify(value)
    if (typeof s !== 'string') return ''
    return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s
  } catch {
    return ''
  }
}

function errText(err) {
  try {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    return String(err)
  } catch {
    return 'unprintable'
  }
}

export { errText }

/** 追加一行日志。永不抛异常 —— 诊断设施绝不允许拖垮宿主。 */
export function log(tag, data) {
  try {
    ensureReady()
    rotateIfNeeded()
    const ts = new Date().toISOString()
    let tail = ''
    if (data !== undefined) {
      try {
        tail = ` ${JSON.stringify(data, replacer)}`
      } catch {
        tail = ` ${shape(data)}`
      }
    }
    appendFileSync(LOG_PATH, `${ts} [${tag}]${tail}\n`, 'utf8')
  } catch {
    /* 静默：写日志失败不是业务失败 */
  }
}

/** 把 Error / 函数 / BigInt / 循环引用变成可读 JSON。 */
function replacer(_key, value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'bigint') return String(value)
  return value
}
