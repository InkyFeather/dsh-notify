// dsh-notify —— WPF 卡片助手的生命周期与协议
//
// 为什么不用 `stdio.control` 的 Duplex 双工通道：那是额外的 fd（3/4），
// 只有能按编号取 fd 的子进程（比如 Node 子进程）用得了。PowerShell 拿不到，
// 只能用 stdin/stdout。实测可行，所以协议就走这两个流，诊断走 stderr。
//
// 助手是**常驻**进程：窗口创建后一直 mapped，只切换内容不透明度。
// （Windows 上 Hide()+Show() 会永久破坏鼠标投递，见 assets/helper.ps1 文件头。）

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = dirname(HERE)

const MAX_LINE = 64 * 1024
const RESTART_DELAY_MS = 2000
const MAX_RESTARTS = 5

const BOM = [0xef, 0xbb, 0xbf]

/**
 * 每次拉起助手之前，确保 helper.ps1 带 UTF-8 BOM。
 *
 * 为什么必须做：**PowerShell 5.1 对没有 BOM 的 UTF-8 脚本按 ANSI（本机 GBK）读**。
 * 于是顶部的中文注释被解错，解析器被带进字符串，`@'` 不再被识别为 here-string，
 * 后面的 C# 全部漏成代码 —— 脚本直接语法错误退出。
 *
 * 实测就崩过：helper 连续 5 次启动失败后放弃，卡片永远不出现，日志里只有
 * `缺少 using 指令` 这类看着毫不相关的报错。（任何用编辑器重写这个 .ps1 的工具
 * 都可能把 BOM 丢掉，所以这件事必须由插件自己保证，而不是靠人记得。）
 *
 * 幂等：只读一次、只在需要时写。
 */
function ensureBom(path, log) {
  try {
    const buf = readFileSync(path)
    const has = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]
    if (has) return
    writeFileSync(path, Buffer.concat([Buffer.from(BOM), buf]))
    log('helper-bom-restored', { path, bytes: buf.length })
  } catch (err) {
    log('helper-bom-failed', { path, error: String((err && err.message) || err) })
  }
}

/**
 * @param {object} o
 * @param {object} o.ctx          Cordis context（已注入 subprocess）
 * @param {(tag: string, data?: unknown) => void} o.log
 * @param {(id: string) => void} [o.onActivate]  用户点了卡片
 * @param {(id: string) => void} [o.onClose]     用户点了关闭
 */
export function createToastHost(o) {
  const log = o.log
  const helperPath = join(PLUGIN_ROOT, 'assets', 'helper.ps1')
  const artPath = join(PLUGIN_ROOT, 'assets', 'deepseek-keyed.png')
  const avatarPath = join(PLUGIN_ROOT, 'assets', 'avatar.png')

  // 插件一加载就自愈脚本编码，而不是等到第一次要弹卡片时 ——
  // 这样文件在任何编辑工具把它改坏之后，都会被立刻修回来。
  ensureBom(helperPath, log)

  let handle = null
  let ready = false
  let starting = false
  let disposed = false
  let restarts = 0
  let buffer = ''
  let restartTimer = null
  /** ready 之前发出的指令排队，避免竞态丢卡片。 */
  const queue = []
  let lastPayload = null

  function state() {
    return { running: handle !== null, ready, starting, restarts, queued: queue.length }
  }

  function write(op) {
    if (handle === null || handle.stdin === undefined || handle.stdin === null) return false
    try {
      handle.stdin.write(`${JSON.stringify(op)}\n`)
      return true
    } catch (err) {
      log('helper-write-failed', { error: String((err && err.message) || err) })
      return false
    }
  }

  function dispatch(op) {
    if (op === null || typeof op !== 'object') return
    const ev = String(op.ev || '')
    if (ev === 'ready') {
      ready = true
      starting = false
      restarts = 0
      log('helper-ready', { pid: op.pid })
      while (queue.length > 0) {
        const next = queue.shift()
        write(next)
      }
      return
    }
    if (ev === 'activate') {
      log('helper-activate', { id: op.id })
      if (typeof o.onActivate === 'function') {
        try { o.onActivate(String(op.id || '')) } catch { /* ignore */ }
      }
      return
    }
    if (ev === 'close') {
      log('helper-close', { id: op.id })
      if (typeof o.onClose === 'function') {
        try { o.onClose(String(op.id || '')) } catch { /* ignore */ }
      }
      return
    }
    if (ev === 'bye') {
      log('helper-bye', {})
      return
    }
    if (ev === 'error') {
      log('helper-error', { message: op.message })
      return
    }
    log('helper-event', { ev })
  }

  function onStdout(chunk) {
    try {
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_LINE) {
        log('helper-line-too-long', { length: buffer.length })
        buffer = ''
        return
      }
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) {
          let parsed = null
          try { parsed = JSON.parse(line) } catch {
            log('helper-bad-json', { line: line.slice(0, 300) })
          }
          if (parsed !== null) dispatch(parsed)
        }
        idx = buffer.indexOf('\n')
      }
    } catch (err) {
      log('helper-stdout-failed', { error: String((err && err.message) || err) })
    }
  }

  function scheduleRestart(reason) {
    handle = null
    ready = false
    starting = false
    if (disposed) return
    if (restarts >= MAX_RESTARTS) {
      log('helper-give-up', { restarts, reason })
      return
    }
    restarts += 1
    log('helper-restart-scheduled', { inMs: RESTART_DELAY_MS, attempt: restarts, reason })
    restartTimer = setTimeout(() => {
      restartTimer = null
      void start()
    }, RESTART_DELAY_MS)
  }

  async function start() {
    if (disposed || starting || handle !== null) return
    starting = true

    // 先把脚本的编码自愈掉，再谈启动（见 ensureBom 的说明）
    ensureBom(helperPath, log)

    let exe = 'powershell.exe'
    try {
      const resolved = await o.ctx.subprocess.resolveExecutable('powershell.exe')
      if (typeof resolved === 'string' && resolved) exe = resolved
    } catch (err) {
      log('helper-resolve-fallback', { error: String((err && err.message) || err) })
    }
    if (disposed) { starting = false; return }

    const argv = [
      exe, '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', helperPath, '-Art', artPath, '-Avatar', avatarPath,
      // 点击卡片后要拉到前台的进程。桌面端的宿主是 Electron 主进程的子进程，
      // 所以 process.ppid 就是窗口持有进程（P0 实测 ppid=22056 即主进程）。
      // 不是这种拓扑时（例如纯终端跑 dsh web）传进去也无害：找不到窗口就跳过。
      '-TargetPid', String(process.ppid || 0),
    ]

    let spawned = null
    try {
      // argv 是数组、不经 shell，所以含空格的路径不需要引号处理
      spawned = o.ctx.subprocess.spawn({
        argv,
        cwd: PLUGIN_ROOT,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
      })
    } catch (err) {
      starting = false
      log('helper-spawn-failed', { error: String((err && err.message) || err) })
      scheduleRestart('spawn-failed')
      return
    }

    handle = spawned
    buffer = ''
    ready = false
    log('helper-spawned', { exe })
    // 注意：SubprocessHandle **没有 pid 属性**（实测 undefined）。
    // 权威 PID 来自助手 ready 事件里的 $PID，见 dispatch() 的 helper-ready。

    try {
      if (spawned.stdout) {
        spawned.stdout.on('data', onStdout)
        spawned.stdout.on('error', (err) => log('helper-stdout-error', { error: String(err && err.message || err) }))
      }
      if (spawned.stderr) {
        spawned.stderr.on('data', (chunk) => log('helper-stderr', { text: chunk.toString('utf8').trim().slice(0, 500) }))
      }
      if (spawned.stdin) {
        spawned.stdin.on('error', () => { /* 助手退出时的 EPIPE 属正常 */ })
      }
      if (spawned.done && typeof spawned.done.then === 'function') {
        spawned.done.then(
          (outcome) => scheduleRestart(`exit:${outcome && outcome.exitCode}`),
          (err) => scheduleRestart(`done-rejected:${String((err && err.message) || err)}`),
        )
      }
    } catch (err) {
      log('helper-wire-failed', { error: String((err && err.message) || err) })
    }
  }

  /** 显示卡片。payload: { id, title, session, detail } */
  function show(payload) {
    lastPayload = payload
    const op = {
      op: 'show',
      id: String(payload.id || ''),
      title: String(payload.title || ''),
      session: String(payload.session || ''),
      detail: String(payload.detail || ''),
    }
    if (ready && write(op)) return true
    // 还没就绪：排队（并确保进程已启动）。
    // 若之前已 give-up（重启次数用尽），新的一次展示请求重新给机会 ——
    // 否则一次瞬时故障会让通知永久失效，必须靠重载插件才能恢复。
    if (handle === null && !starting) restarts = 0
    if (queue.length < 8) queue.push(op)
    void start()
    return false
  }

  function hide() {
    queue.length = 0
    if (ready) write({ op: 'hide' })
  }

  function stop() {
    disposed = true
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (handle !== null) {
      try { write({ op: 'quit' }) } catch { /* ignore */ }
      try { handle.terminate() } catch { /* ignore */ }
    }
    handle = null
    ready = false
    starting = false
    log('helper-stopped', {})
  }

  return { start, show, hide, stop, state, get lastPayload() { return lastPayload } }
}
