// dsh-notify —— 宿主半
//
// 职责分工：
//   · 本文件 = 事件 → 语义的翻译层。订阅 DSH 事件，翻成 offer()/settle*() 调用。
//   · lib/notify.js = 决策与卡片生命周期（前台抑制、去重、收起、点击归属）。
//   · lib/classify.js = 分类规则与第三行文案抽取。
//   · lib/wpf.js = 置顶卡片助手的进程与协议。
//
// 几条来自实测的硬约束：
//   · **不要用对象级 inject** —— 它会把整个 apply() 推迟到服务就绪之后
//     （whale widget issue #152/#153 的教训）。服务依赖放进 root.inject 局部等待。
//   · `approval/request` / `user-questions/request` 都是 waterfall，**只观察、绝不裁决**：
//     返回一个 outcome 会「认领」请求，页面就再也收不到审批面板了。
//   · 所有回调一律 try/catch —— 通知插件绝不允许拖垮宿主。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log, shape, preview, errText, LOG_PATH } from './log.js'
import { createToastHost, PLUGIN_ROOT } from './wpf.js'
import { describe, pickReasonText } from './classify.js'
import { createNotifier } from './notify.js'
import { Config, resolveSettings, schemaError } from './config.js'

const NAME = 'dsh-notify'
/** 构建标记：用来判断 HMR 是否真的重新导入了模块（ESM 缓存会让改动静默失效）。 */
const BUILD = 'p1-35'

/** 用户可以自己改的设置文件（在工作区内，我能改、你也能改）。 */
const SETTINGS_PATH = join(PLUGIN_ROOT, 'settings.json')

/** 读设置文件；不存在或不是 JSON 都返回 null（走默认值），绝不因此让插件加载失败。 */
function readSettingsFile() {
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    // ENOENT 是正常的（没建文件 = 用默认值）；语法错要显式记出来，否则你会
    // 改了文件却不知道为什么没生效。
    if (err && err.code !== 'ENOENT') log('settings-file-invalid', { path: SETTINGS_PATH, error: errText(err) })
    return null
  }
}

/**
 * 开发用：多会话队列的现场演示开关（只从 settings.json 读，**不进 Config schema**
 * —— 免得污染正式的设置界面）。
 *
 * 为什么需要它：DSH 会把**阻塞式工具调用串行化**（实测两次 `ask_user_question`
 * 之间隔了 21 秒，后一个要等前一个的卡片 settle 之后才发生），所以一个回合里
 * 造不出"两张同时待处理"的真实卡片，"两张同时在队"这条路径没法用真实事件验。
 * 这个开关合成 N 张卡片，走**完整**的 offer → 抑制/挂起 → 释放 → 上屏 →
 * settle → 队列前进 链路。
 */
function normalizeDemo(raw) {
  const d = raw !== null && typeof raw === 'object' && raw.demo !== null && typeof raw.demo === 'object'
    ? raw.demo
    : {}
  const clamp = (v, hi) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.max(0, Math.min(n, hi)) : 0
  }
  return {
    cards: clamp(d.cards, 5),
    settleAfterMs: clamp(d.settleAfterMs, 600000),
    showcase: d.showcase === true,
    stepSeconds: clamp(d.stepSeconds === undefined ? 5 : d.stepSeconds, 60),
  }
}

/**
 * 展示模式用的七张样例卡片 —— **每种分类各一张**，覆盖全部七种标题。
 *
 * 每张的 `reason` 都是刻意构造的，好让 `classify.js` 落到对应分类：
 * 沙箱模板 → 权限；批量/不可逆措辞 → 不可逆；删除措辞 → 高危；
 * 前缀超 24 字或为空 → 人工介入兜底。
 */
const SHOWCASE_STEPS = [
  { label: '权限授予确认', kind: 'approval', session: 'MyProject', toolName: 'Bash', reason: '允许本次操作使用 danger-full-access 权限：要在工作区外写入' },
  { label: '方案抉择', kind: 'question', session: 'dsh 提示框插件', planReview: true },
  { label: '不可逆变更确认', kind: 'approval', session: 'MyProject', toolName: 'Bash', reason: '批量删除 3200 个日志文件: x' },
  { label: '高危操作复核', kind: 'approval', session: 'MyProject', toolName: 'Bash', reason: '删除 dist 与 node_modules: x' },
  { label: '人工介入请求', kind: 'approval', session: 'MyProject', toolName: 'Bash', reason: '' },
  { label: '任务完成', kind: 'completed', session: 'dsh 提示框插件' },
  { label: '任务中断', kind: 'interrupted', session: 'dsh 提示框插件' },
]

const ROUTE_PRESENCE = '/dsh-notify/presence'
/** 开发用触发端点：不经过事件，直接把一张卡片推给助手。留作回归手段。 */
const ROUTE_TOAST = '/dsh-notify/toast'
/**
 * 开发用触发端点：**走完整的决策层**（抑制/去重/点击归属），
 * 但事件源是 HTTP 而不是 DSH 事件。用来在没有真实审批的情况下验证
 * 抑制规则与点击跳转。
 */
const ROUTE_TEST_NOTIFY = '/dsh-notify/test-notify'

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 客户端半上报的在场状态。
 *
 * **挂在 globalThis 上，而不是模块作用域** —— 因为 HMR 会重新导入模块，
 * 模块级变量会被重置成"未知"，于是重载后头几秒内到达的卡片会因为"未知"
 * 而绕过抑制直接弹出（实测踩过：你在看页面，卡片还是弹了）。
 * globalThis 在同一个宿主进程里跨重载存活。
 */
const PRESENCE_KEY = '__dshNotifyPresence'
const presence = (() => {
  const kept = globalThis[PRESENCE_KEY]
  if (kept !== undefined && kept !== null && typeof kept === 'object' && 'source' in kept) return kept
  const fresh = { focused: null, visible: null, at: 0, source: 'none' }
  globalThis[PRESENCE_KEY] = fresh
  return fresh
})()

/** sessionId → 会话标题（来自 session/title 事件）。卡片第二行要用。 */
const titles = new Map()

/** 每个会话上一次的 agent 状态，用于诊断（完成信号以 turn/end 为准）。 */
const lastStatus = new Map()

/** 已经见过的事件类型：首次出现时记完整外形，之后只记类型，避免刷屏。 */
const seenTypes = new Set()

/**
 * 这类事件每次都值得记内容。
 * `turn/` 必须在列：`turn/end` 是「任务完成」的信号，只记首次就看不到反复发生的证据。
 * `step/` 有意不在列 —— 它每步都发，只会淹没日志。
 */
const ALWAYS_DETAIL = /approval|question|error|^turn\//i

/** 卡片助手（懒启动，可能为 null）。 */
let toastHost = null
/** 决策层。 */
let notifier = null

/**
 * 用户点了卡片、但页面还没来取走的会话。
 * 页面恢复焦点时会在 presence 响应里取走它并调用 openSession()。
 */
let pendingOpen = null

/** 插件上下文，用于读 sessionTitle 等服务（在 apply 里赋值）。 */
let rootCtx = null

function titleOf(sessionId) {
  return titles.get(String(sessionId || '')) || ''
}

/** 已经从 sessionTitle 服务尝试读过的会话，避免每个事件都问一次。 */
const titleProbed = new Set()

/**
 * 从 `sessionTitle` 服务读折叠后的标题。
 *
 * 为什么需要它：`session/title` 事件只能拿到**插件加载之后**写入的标题，
 * 而服务读的是折叠日志 —— 对加载之前就已存在的标题同样有效。
 * 实测踩过：一个已跑到第 9 轮的会话，卡片第二行只显示了工具名（缺会话名）。
 */
function probeTitle(root, session, sessionId) {
  const sid = String(sessionId || '')
  if (!sid || titleProbed.has(sid)) return
  titleProbed.add(sid)
  try {
    const svc = typeof root.get === 'function' ? root.get('sessionTitle') : null
    if (svc === null || typeof svc.get !== 'function' || session === undefined) return
    const snap = svc.get(session)
    const ti = snap === undefined || snap === null ? '' : String(snap.title || '').trim()
    if (ti !== '') titles.set(sid, ti.slice(0, 120))
    // 只记一次（titleProbed 已保证），用来验证"历史标题"这条路真的通了
    log('title-probe', { session: sid, found: ti !== '', title: preview(ti, 60) })
  } catch {
    /* 服务不可用时静默回落 —— 标题缺失不该影响通知 */
  }
}

// ---------------------------------------------------------------------------
// 从事件里抠出需要的字段（字段位置随 DSH 版本略有差异，全都兜一遍）
// ---------------------------------------------------------------------------

function callIdOf(event) {
  try {
    const d = (event && event.data) || {}
    const msg = d.message || {}
    if (msg.callId) return String(msg.callId)
    if (msg.toolCallId) return String(msg.toolCallId)
    const list = Array.isArray(msg.content) ? msg.content : []
    for (const c of list) {
      if (c && (c.toolCallId || c.tool_call_id)) return String(c.toolCallId || c.tool_call_id)
    }
    if (d.callId) return String(d.callId)
    if (d.toolCallId) return String(d.toolCallId)
    return ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 事件钩子
// ---------------------------------------------------------------------------

function onSessionEvent(session, event) {
  try {
    const type = String((event && event.type) || '')
    if (!type) return
    const sid = (session && session.id) || 'unknown'
    const data = (event && event.data) || {}

    const first = !seenTypes.has(type)
    if (first) {
      seenTypes.add(type)
      log('event-type-first-seen', { type, session: sid, dataShape: shape(data, 2) })
    }
    if (first || ALWAYS_DETAIL.test(type)) {
      log('session/event', {
        type,
        session: sid,
        shape: shape(data, 2),
        preview: preview(data, 240),
      })
    }

    // 会话标题有两个来源，缺一不可：
    //   ① `session/title` 事件 —— 只能拿到插件加载**之后**写入的标题
    //   ② `sessionTitle` 服务读折叠日志 —— 对加载之前就存在的标题同样有效
    // 实测踩过：一个已跑到第 9 轮的会话，卡片第二行只显示了工具名。
    probeTitle(rootCtx, session, sid)

    // 会话标题：卡片第二行要用
    if (type === 'session/title') {
      const ti = String(data.title || '').trim()
      if (ti) titles.set(sid, ti.slice(0, 120))
      return
    }

    // 审批：落库事件补齐 id ↔ callId 的对应关系（waterfall 事件没有 id）
    if (type === 'approval/asked') {
      const callId = String(data.callId || callIdOf(event))
      const approvalId = String(data.id || '')
      if (notifier !== null) {
        notifier.noteApprovalId(callId, approvalId)
        // 兜底：万一 waterfall 事件没到（或订阅晚了），用落库内容也弹一张。
        // 去重键与 waterfall 那条相同，所以不会重复。
        notifier.offer({
          kind: 'approval',
          cardId: `approval:${callId || approvalId}`,
          sessionId: sid,
          session: titleOf(sid),
          toolName: String(data.toolName || ''),
          reason: String(data.reason || ''),
          callId,
          approvalId,
        })
      }
      return
    }
    if (type === 'approval/decided') {
      if (notifier !== null) notifier.settleByApprovalId(String(data.id || ''), 'approval/decided')
      return
    }

    // 工具调用。**每次都记名字** —— 曾经只在"首次出现"时记录，结果我完全看不到
    // `ask_user_question` 有没有发生过，把一个真问题误判成"事件没触发"。
    // 这类盲区比日志噪音贵得多。
    if (type === 'tool/call') {
      const name = String(data.name || '')
      const callId = String(data.callId || '')
      log('tool-call', { session: sid, name, callId, turn: data.turn, step: data.step })

      // `ask_user_question` 是**挂起**的工具调用：模型发出后等你点，
      // 期间不会来 `turn/end`。它是"需要你回答"的可靠信号。
      // 为什么不用 `user-questions/request`：那个 waterfall 事件实测根本没有
      // 到达本插件的钩子（`approval/request` 却能到达），而落库的 `tool/call`
      // 一定会有 —— 参考工程也正是用这个信号。
      if (name === 'ask_user_question' && notifier !== null) {
        let planReview = false
        let label = ''
        try {
          const args = JSON.parse(String(data.arguments || '{}'))
          const qs = Array.isArray(args.questions) ? args.questions : []
          planReview = qs.some((q) => q && q.intent && q.intent.kind === 'plan-review')
          if (qs.length > 0) {
            // 优先用 header：它是短标签，比整段问题文本更适合上卡片
            label = String(qs[0].header || qs[0].question || '')
          }
        } catch {
          /* arguments 不是 JSON 就算了，走兜底文案 */
        }
        notifier.offer({
          kind: 'question',
          cardId: callId ? `question:${callId}` : undefined,
          sessionId: sid,
          session: titleOf(sid),
          planReview,
          reason: label,
          callId,
        })
      }
      return
    }

    // 工具结果到达 ⇒ 对应的提问（或审批）已经有结果了
    if (type === 'tool/result') {
      const callId = callIdOf(event)
      if (callId && notifier !== null) notifier.settleByCallId(callId, 'tool/result')
      return
    }

    // 一轮结束 —— 「任务完成」的信号（reason.kind 能区分正常完成与其它原因）
    if (type === 'turn/end') {
      const turn = data.turn
      const reason = (data && data.reason) || {}
      const reasonKind = String(reason.kind || '')
      // TurnEndReasonMap 的完整取值（取自类型转储）：
      //   completed | aborted{reason} | blocked | error{error: LlmFailure}
      //   | max-tokens | interrupted | forked
      // 只对两种弹卡 —— 其余（aborted/interrupted 多是用户或父会话主动中止、
      // blocked/max-tokens 属可恢复）按「宁可少喊也不乱喊」只记日志。
      if (reasonKind === 'completed' && notifier !== null) {
        notifier.offer({
          kind: 'completed',
          cardId: `completed:${sid}:${turn}`,
          sessionId: sid,
          session: titleOf(sid),
        })
      } else if (reasonKind === 'error' && notifier !== null) {
        // 这是「无法自愈的报错」的准确信号，比 agent/error 可靠
        const failure = reason.error || {}
        log('turn-error', {
          session: sid,
          turn,
          message: preview(failure.message, 200),
          code: failure.code,
          status: failure.status,
        })
        notifier.offer({
          kind: 'interrupted',
          cardId: `interrupted:${sid}:${turn}`,
          sessionId: sid,
          session: titleOf(sid),
        })
      } else if (reasonKind !== '') {
        log('turn-end-other', { session: sid, turn, reason: reasonKind })
      }
      return
    }
  } catch (err) {
    log('hook-error', { hook: 'session/event', error: errText(err) })
  }
}

function onAgentStatus(payload) {
  try {
    const agent = payload && payload.agent
    const status = String((payload && payload.status) || '')
    const sid = (agent && agent.id) || 'unknown'
    const prev = lastStatus.get(sid)
    lastStatus.set(sid, status)
    log('agent/status', { session: sid, from: prev === undefined ? null : prev, to: status })
  } catch (err) {
    log('hook-error', { hook: 'agent/status', error: errText(err) })
  }
}

function onAgentError(payload) {
  try {
    const agent = payload && payload.agent
    const sid = (agent && agent.id) || 'unknown'
    const turn = payload && payload.turn
    const step = payload && payload.step
    log('agent/error', {
      session: sid,
      turn,
      step,
      error: errText(payload && payload.error),
    })
    if (notifier !== null) {
      notifier.offer({
        kind: 'interrupted',
        cardId: `interrupted:${sid}:${turn}:${step}`,
        sessionId: sid,
        session: titleOf(sid),
        reason: errText(payload && payload.error),
      })
    }
  } catch (err) {
    log('hook-error', { hook: 'agent/error', error: errText(err) })
  }
}

function onApprovalRequest(req, next) {
  try {
    const sid = (req && req.agent && req.agent.id) || 'unknown'
    const callId = String((req && req.callId) || '')
    // displayReason 是本地化的映射（只在 waterfall 事件上有）；
    // 落库那份只有英文合成串。优先用本地化的。
    const reason = pickReasonText(req, 'zh')
    log('approval/request', {
      session: sid,
      toolName: req && req.toolName,
      callId,
      hasReason: !!(req && req.reason),
      reasonLen: req && req.reason ? String(req.reason).length : 0,
      displayReasonShape: shape(req && req.displayReason, 2),
      pickedReason: preview(reason, 200),
    })
    if (notifier !== null) {
      notifier.offer({
        kind: 'approval',
        // 同 onUserQuestionsRequest：callId 为空时不要拼出 'approval:' 这种退化 id
        cardId: callId ? `approval:${callId}` : undefined,
        sessionId: sid,
        session: titleOf(sid),
        toolName: String((req && req.toolName) || ''),
        reason,
        callId,
      })
    }
  } catch (err) {
    log('hook-error', { hook: 'approval/request', error: errText(err) })
  }
  // 只观察，绝不裁决：返回 next() 把请求交给真正的答案者（页面 UI）。
  return typeof next === 'function' ? next() : undefined
}

function onUserQuestionsRequest(request, next) {
  try {
    const sid = (request && request.agent && request.agent.id) || 'unknown'
    const qs = Array.isArray(request && request.questions) ? request.questions : []
    const callId = String((request && request.wait && request.wait.callId) || '')
    // plan-review 是「方案抉择」的可靠信号（参考工程因为拿不到转发事件而做不到）
    const planReview = qs.some((q) => q && q.intent && q.intent.kind === 'plan-review')
    log('user-questions/request', {
      session: sid,
      count: qs.length,
      callId,
      planReview,
      intents: qs.map((q) => (q && q.intent && q.intent.kind) || null),
      headers: qs.map((q) => (q && q.header) || null),
      preview: preview(request, 240),
    })
    if (notifier !== null) {
      notifier.offer({
        kind: 'question',
        // callId 若为空则**不要**拼 cardId —— 否则会退化成 'question:'，
        // 于是所有没有 callId 的提问被去重成同一张卡。留给 deriveCardId 兜底。
        cardId: callId ? `question:${callId}` : undefined,
        sessionId: sid,
        session: titleOf(sid),
        planReview,
        // 与 `tool/call` 那条主路径保持一致：**header 优先**。
        // header 是短标签，适合上卡片；问题正文往往是整段散文，会被
        // shortenReason 的 24 字上限打回兜底短语，信息量反而更差。
        reason: qs.length > 0 ? String(qs[0].header || qs[0].question || '') : '',
        callId,
      })
    }
  } catch (err) {
    log('hook-error', { hook: 'user-questions/request', error: errText(err) })
  }
  return typeof next === 'function' ? next() : undefined
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 轻量信任栅栏：只接受回环权威且非跨站来源的请求。 */
function selfReject(req) {
  try {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403
    const host = String(req.headers.host || '')
    const hn = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    if (!hn) return 403
    const isLoopback = hn === 'localhost' || hn === '::1'
      || /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hn)
    if (isLoopback) return null
    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(String(origin)).hostname.toLowerCase() === hn) return null
      } catch {
        /* 解析失败按拒绝处理 */
      }
    }
    return 403
  } catch {
    return 403
  }
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let buf = ''
    try {
      req.setEncoding('utf8')
    } catch {
      resolve('')
      return
    }
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > limit) {
        buf = buf.slice(0, limit)
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
      }
    })
    req.on('end', () => resolve(buf))
    req.on('error', () => resolve(buf))
  })
}

async function handlePresence(req, res) {
  try {
    const rejection = selfReject(req)
    if (rejection !== null) {
      log('presence-rejected', { status: rejection, host: req.headers && req.headers.host })
      res.statusCode = rejection
      res.end('rejected')
      return
    }

    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        ok: true,
        presence,
        pendingOpen,
        notifier: notifier === null ? null : notifier.state(),
        logPath: LOG_PATH,
      }))
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }

    const raw = await readBody(req)
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      body = {}
    }
    presence.focused = typeof body.focused === 'boolean' ? body.focused : null
    presence.visible = typeof body.visible === 'boolean' ? body.visible : null
    presence.at = Date.now()
    presence.source = typeof body.source === 'string' ? body.source : 'unknown'
    log('presence', { ...presence })

    // 客户端半把诊断捎回来 —— 浏览器控制台看不到，只能这样取证。
    if (typeof body.note === 'string' && body.note !== '') {
      log('client-note', { note: preview(body.note, 300) })
    }

    // 挂起释放**不在这里**做了：窗口被冻结时可能根本收不到 visible:false 上报，
    // 所以改由宿主的定时器定期判定（见下面的 deferredTimer），两种情况都能覆盖。

    // 顺带把「待打开的会话」交给页面。
    // **不再要求 focused===true** —— 那会引入一个竞态：点卡片时页面同时拿到焦点，
    // 它的 focus 上报可能早于宿主的 activate 处理，于是第一次拿不到 open。
    // 浏览器本来就会节流隐藏窗口的定时器，所以"隐藏时的轮询"不是一个真实风险；
    // 而可见时的轮询每 2 秒一次，去掉这个限制后最坏 2 秒内一定送达。
    let open = null
    if (pendingOpen !== null) {
      open = pendingOpen
      pendingOpen = null
      log('pending-open-delivered', { sessionId: open, focused: presence.focused })
    }

    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, open }))
  } catch (err) {
    log('presence-error', { error: errText(err) })
    try {
      res.statusCode = 500
      res.end('error')
    } catch {
      /* ignore */
    }
  }
}

/** 开发用：把一张卡片直接推给助手，绕过事件。 */
async function handleToast(req, res, host) {
  try {
    const rejection = selfReject(req)
    if (rejection !== null) {
      log('toast-rejected', { status: rejection, host: req.headers && req.headers.host })
      res.statusCode = rejection
      res.end('rejected')
      return
    }

    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        ok: true,
        helper: host.state(),
        presence,
        pendingOpen,
        notifier: notifier === null ? null : notifier.state(),
      }))
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }

    const raw = await readBody(req)
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      body = {}
    }

    // 收起：POST {"op":"hide"}
    if (String(body.op || '') === 'hide') {
      host.hide()
      log('toast-hidden', {})
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, helper: host.state() }))
      return
    }

    // 走规则：给了 reason / kind / toolName 就按分类算出标题与第三行；
    // 否则允许直接指定 title/detail（纯样式调试用）。
    const hasRuleInput = typeof body.reason === 'string'
      || typeof body.kind === 'string'
      || typeof body.toolName === 'string'
    let computed = null
    if (hasRuleInput) {
      computed = describe({
        kind: typeof body.kind === 'string' && body.kind ? body.kind : 'approval',
        reason: typeof body.reason === 'string' ? body.reason : '',
        toolName: typeof body.toolName === 'string' ? body.toolName : '',
        planReview: body.planReview === true,
      })
    }

    const payload = {
      id: typeof body.id === 'string' && body.id ? body.id : `manual-${Date.now()}`,
      title: computed !== null
        ? computed.title
        : (typeof body.title === 'string' && body.title ? body.title : '权限授予确认'),
      session: typeof body.session === 'string' ? body.session : 'MyProject · Bash',
      detail: computed !== null
        ? computed.detail
        : (typeof body.detail === 'string' && body.detail ? body.detail : '要用「完全访问」权限'),
    }

    if (body.dryRun === true) {
      log('toast-dry-run', { computed, payload })
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, dryRun: true, computed, payload }))
      return
    }

    const delivered = host.show(payload)
    log('toast-requested', { ...payload, situation: computed && computed.situation, delivered })
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, delivered, computed, helper: host.state() }))
  } catch (err) {
    log('toast-route-error', { error: errText(err) })
    try {
      res.statusCode = 500
      res.end('error')
    } catch {
      /* ignore */
    }
  }
}

/**
 * 开发用：走完整决策层地弹一张卡片。
 * 与 ROUTE_TOAST 的区别是它经过 notify.offer()，所以会**照常受前台抑制与去重约束**，
 * 并且会登记会话归属 —— 因此能用来验证点击跳转。
 */
async function handleTestNotify(req, res) {
  try {
    const rejection = selfReject(req)
    if (rejection !== null) {
      res.statusCode = rejection
      res.end('rejected')
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }
    if (notifier === null) {
      res.statusCode = 503
      res.end('notifier unavailable')
      return
    }

    const raw = await readBody(req)
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      body = {}
    }

    const sessionId = String(body.sessionId || '')
    const callId = String(body.callId || `manual-${Date.now()}`)

    // 开发用 force：把在场状态临时视为「不在前台」。否则你正在看 DSH 时
    // 卡片会被前台抑制，没法演示点击跳转。同步执行后立刻还原，不留副作用。
    const saved = { ...presence }
    if (body.force === true) presence.focused = false
    let result
    try {
      result = notifier.offer({
        kind: typeof body.kind === 'string' && body.kind ? body.kind : 'approval',
        cardId: typeof body.cardId === 'string' && body.cardId ? body.cardId : undefined,
        sessionId,
        session: typeof body.session === 'string' && body.session ? body.session : titleOf(sessionId),
        toolName: typeof body.toolName === 'string' ? body.toolName : '',
        reason: typeof body.reason === 'string' ? body.reason : '',
        planReview: body.planReview === true,
        callId,
      })
    } finally {
      if (body.force === true) {
        presence.focused = saved.focused
        presence.visible = saved.visible
        presence.at = saved.at
        presence.source = saved.source
      }
    }

    log('test-notify', { result, sessionId, callId, force: body.force === true })
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, result, notifier: notifier.state() }))
  } catch (err) {
    log('test-notify-error', { error: errText(err) })
    try {
      res.statusCode = 500
      res.end('error')
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export default {
  name: NAME,

  /**
   * 声明 Config schema ⇒ **DSH 会据此派生出设置界面**（当前版本的设置模型，
   * 旧的 `settings.register()` 已移除）。改配置不需要手改 profile 的 patch 文件。
   * 可用 `cordis_inspect_query` 的 Config provider 验证它被识别。
   */
  Config,

  // 注意：**没有对象级 inject**。apply() 必须立刻执行，服务依赖放进 root.inject 局部等待。
  apply(root, config) {
    rootCtx = root
    // 设置：settings.json > Cordis config > 内置默认值（见 resolveSettings）
    const rawFile = readSettingsFile()
    const resolved = resolveSettings(config, rawFile)
    const settings = resolved.settings
    try {
      log('apply', {
        build: BUILD,
        settings,
        settingsSource: resolved.source,
        settingsPath: SETTINGS_PATH,
        // 设置界面这块能不能用，只看这个 —— schema 解析失败时插件仍照常工作
        hasConfig: Config !== undefined,
        schemaError,
        pid: process.pid,
        // 桌面端的宿主是 Electron 主进程的子进程 ⇒ ppid 就是窗口持有进程。
        // 点击跳转要靠它把 DSH 窗口拉到前台。
        ppid: process.ppid,
        node: process.version,
        cwd: process.cwd(),
        dshHome: process.env.DSH_HOME || null,
        profile: process.env.DSH_PROFILE || null,
        logPath: LOG_PATH,
      })
    } catch (err) {
      void err
    }

    // ① 决策层 —— 不依赖任何服务，立刻建（助手与在场状态都用 getter 惰性取）
    try {
      notifier = createNotifier({
        log,
        getToast: () => toastHost,
        getPresence: () => (presence.source === 'none' ? null : presence),
        getSettings: () => settings,
        // 子代理判据取自 `Session.header`（`origin` / `parentSession` 是权威字段，
        // 不是拿 id 前缀猜的 —— 实测主会话是 `session-<uuid>`、子代理是裸 uuid，
        // 但那种格式差异不该被当成契约）。
        // 会话已销毁时 `get()` 返回 undefined ⇒ 按"不是子代理"处理（宁可多弹）。
        isSubagent: (sid) => {
          const sessions = rootCtx === null ? undefined : rootCtx.get('sessions')
          if (sessions === undefined || sessions === null) return false
          const session = sessions.get(sid)
          const header = session === undefined || session === null ? undefined : session.header
          if (header === undefined || header === null) return false
          return header.origin === 'subagent' || typeof header.parentSession === 'string'
        },
      })
      root.effect(() => () => {
        try {
          if (notifier !== null) notifier.dispose()
        } finally {
          notifier = null
        }
      })

      // 定期判定「你是否已离开」并释放挂起中的待处理请求。
      // 为什么要定时器而不是事件：窗口被最小化/完全遮挡时 Chromium 会冻结渲染进程，
      // `visibilitychange` 的上报可能根本发不出来（实测两次投诉的最后一条 presence
      // 都是 `focused:false, visible:true`，之后再无任何上报）。
      // 所以只能靠"上报停了"来推断 —— 而那正需要宿主这边的时钟。
      const deferredTimer = setInterval(() => {
        try {
          if (notifier !== null) notifier.releaseIfAway()
        } catch (err) {
          log('deferred-timer-failed', { error: errText(err) })
        }
      }, 2000)
      root.effect(() => () => clearInterval(deferredTimer))

      // 开发用：多会话队列的现场演示（见 normalizeDemo 的说明）。默认关闭。
      const demo = normalizeDemo(rawFile)
      const demoTimers = []
      const at = (ms, fn) => demoTimers.push(setTimeout(() => {
        try {
          fn()
        } catch (err) {
          log('demo-failed', { error: errText(err) })
        }
      }, ms))

      if (demo.showcase) {
        // 展示模式：七种分类依次各放一张，每张停留 `stepSeconds` 秒。
        // 上一步先 settle 再上新的 —— 保证队列里始终只有一张，
        // 否则第三行会冒出"共 N 项待确认"的计数提示，把展示搞乱。
        const stepMs = demo.stepSeconds * 1000
        log('showcase-scheduled', { steps: SHOWCASE_STEPS.length, stepSeconds: demo.stepSeconds })
        SHOWCASE_STEPS.forEach((step, i) => {
          at(i * stepMs, () => {
            if (i > 0) notifier?.settleByCardId(`showcase-${i - 1}`, 'showcase-step')
            notifier?.offer({
              kind: step.kind,
              cardId: `showcase-${i}`,
              callId: `showcase-${i}`,
              sessionId: '',
              session: step.session,
              toolName: step.toolName,
              reason: step.reason,
              planReview: step.planReview === true,
              force: true,
            })
          })
        })
        // 最后一张也按时收掉，免得永远留在屏幕上
        at(SHOWCASE_STEPS.length * stepMs, () => {
          notifier?.settleByCardId(`showcase-${SHOWCASE_STEPS.length - 1}`, 'showcase-end')
        })
        root.effect(() => () => {
          for (const t of demoTimers) clearTimeout(t)
        })
      } else if (demo.cards > 0) {
        log('demo-scheduled', demo)
        for (let i = 1; i <= demo.cards; i += 1) {
          at(500 * i, () => notifier?.offer({
            kind: 'question',
            cardId: `demo-${i}`,
            callId: `demo-${i}`,
            session: `演示会话 ${i}`,
            reason: `第 ${i} 张（合成卡片）`,
          }))
        }
        if (demo.settleAfterMs > 0) {
          // 错开 settle：队首（编号最大的那张）先被处理掉，这样能看到**队列前进**。
          for (let i = 1; i <= demo.cards; i += 1) {
            const delay = demo.settleAfterMs + (demo.cards - i) * 8000
            at(delay, () => notifier?.settleByCallId(`demo-${i}`, 'demo-timer'))
          }
        }
        root.effect(() => () => {
          for (const t of demoTimers) clearTimeout(t)
        })
      }
    } catch (err) {
      log('notifier-failed', { error: errText(err) })
    }

    // ② 事件钩子 —— 同样不依赖任何服务
    try {
      root.effect(() => root.on('session/event', onSessionEvent))
      root.effect(() => root.on('agent/status', onAgentStatus))
      root.effect(() => root.on('agent/error', onAgentError))
      root.effect(() => root.on('approval/request', onApprovalRequest))
      root.effect(() => root.on('user-questions/request', onUserQuestionsRequest))
      log('hooks-registered', { events: [
        'session/event', 'agent/status', 'agent/error', 'approval/request', 'user-questions/request',
      ] })
    } catch (err) {
      log('hooks-register-failed', { error: errText(err) })
    }

    // ③ 卡片助手与路由 —— 等 subprocess + webServer 就绪。
    //    这是 root.inject(...)，不是对象级 inject：apply() 已经立刻跑完了，
    //    这里只是把依赖服务的部分局部延后。
    try {
      root.inject(['subprocess', 'webServer'], (ctx) => {
        // 卡片助手：**懒启动** —— 第一次 show() 时才拉起 PowerShell。
        try {
          toastHost = createToastHost({
            ctx,
            log,
            onActivate: (id) => {
              // 用户点了卡片：记下要打开的会话。页面拿到焦点后会在 presence
              // 响应里取走它并调用 uiWorkspace.openSession()。
              const rec = notifier === null ? null : notifier.activate(id)
              if (rec !== null && rec.sessionId) {
                pendingOpen = rec.sessionId
                log('pending-open-queued', { sessionId: rec.sessionId, cardId: id })
              } else {
                log('activate-without-session', { cardId: id })
              }
            },
            onClose: (id) => log('toast-closed', { id }),
          })
          root.effect(() => () => {
            try {
              if (toastHost !== null) toastHost.stop()
            } finally {
              toastHost = null
            }
          })
        } catch (err) {
          log('toast-host-failed', { error: errText(err) })
        }

        const routes = [
          { kind: 'exact', path: ROUTE_PRESENCE, handler: handlePresence },
          { kind: 'exact', path: ROUTE_TEST_NOTIFY, handler: handleTestNotify },
          {
            kind: 'exact',
            path: ROUTE_TOAST,
            handler: (req, res) => {
              if (toastHost === null) {
                res.statusCode = 503
                res.end('toast host unavailable')
                return undefined
              }
              return handleToast(req, res, toastHost)
            },
          },
        ]
        for (const route of routes) {
          try {
            const dispose = ctx.webServer.register(route)
            if (typeof dispose === 'function') root.effect(() => dispose)
            log('route-registered', { path: route.path })
          } catch (err) {
            log('route-register-failed', { path: route.path, error: errText(err) })
          }
        }
      })
    } catch (err) {
      log('route-inject-failed', { error: errText(err) })
    }
  },
}
