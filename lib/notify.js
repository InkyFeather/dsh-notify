// dsh-notify —— 通知决策与卡片生命周期
//
// 这一层回答三个问题：
//   1. 这条事件该不该弹？（前台抑制 + 去重）
//   2. 该弹成什么样？（交给 classify.describe）
//   3. 弹完之后什么时候收？（approval/decided、tool/result 到达时）
//
// 单一事实源：判定只在这里做；宿主半只负责把事件翻译成 offer() / settle*()。

import { describe } from './classify.js'

export function createNotifier(o) {
  const log = o.log
  /** 返回当前的卡片助手（可能还没就绪 —— 助手是懒启动的）。 */
  const getToast = o.getToast
  /** 返回当前在场状态 {focused, visible}。 */
  const getPresence = o.getPresence
  /** 注入的设置读取器（**可能缺省** —— 见 settingsNow 的兜底）。 */
  const readSettings = o.getSettings

  /**
   * 读取设置，**永不抛、永不返回 undefined**。
   *
   * 为什么必须兜底：`offer()` 开头就调它。一旦它不是函数或抛错，**每一张卡片**
   * 都会走进 offer 的 catch 变成 `shown:false` —— 表现出来是"提示功能整个没了"，
   * 而真正的出错点只是一处依赖没接上。
   *
   * 实测就发生过：测试脚手架没传 `getSettings`，32 个用例里 20 个失败，
   * 看起来像核心逻辑崩了，其实只是缺一个注入。这类"一处小缺口放大成全面失效"
   * 的形状，必须在最靠近缺口的地方挡住。
   */
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mute: Object.freeze({}),
    quietOnFocusOnly: false,
    ignoreSubagents: true,
    autoDismissSeconds: 0,
  })

  function settingsNow() {
    if (typeof readSettings !== 'function') return DEFAULT_SETTINGS
    try {
      const s = readSettings()
      return s !== null && typeof s === 'object' ? s : DEFAULT_SETTINGS
    } catch (err) {
      log('settings-read-failed', { error: String((err && err.message) || err) })
      return DEFAULT_SETTINGS
    }
  }

  /** 其余代码统一通过它取设置。 */
  const getSettings = settingsNow
  /** 判断某个会话是否子代理会话（读 `Session.header.origin`，见 index.js 的实现）。 */
  const isSubagentFn = o.isSubagent

  /** 包一层：判定失败绝不冒泡成"卡片不弹"，失败时按"不是子代理"处理。 */
  function isSubagentSession(sid) {
    if (typeof isSubagentFn !== 'function' || !sid) return false
    try {
      return isSubagentFn(sid) === true
    } catch (err) {
      log('subagent-check-failed', { error: String((err && err.message) || err) })
      return false
    }
  }

  /** cardId → 记录，用于点击跳转与会话归属。 */
  const cards = new Map()
  /** 已弹过的去重键。 */
  const seen = new Set()
  /** 审批的 callId → 落库的审批 id。
   *  waterfall 事件（ApprovalRequestEvent）**没有 id**，只有 callId；
   *  而 approval/decided 只带 id。所以要靠落库的 approval/asked 把两者接起来。 */
  const approvalIdByCallId = new Map()
  /** 当前在屏幕上的 cardId。 */
  let showingId = null

  /**
   * 被前台抑制的**待处理请求**，等你离开页面时再提醒一次。
   *
   * 为什么需要它：只做「前台就丢」会漏掉一个真实场景 —— 审批在你看的时候到达，
   * 你随即走开去查资料，请求还挂着，而卡片永远不会出现。那正好违反插件的本职。
   * 只挂 **待处理类**（approval / question）：它们是"有人等你答复"；
   * completed / interrupted 是"刚发生过一件事"，回头再提醒只会变噪音。
   */
  const deferred = new Map()
  const MAX_DEFERRED = 8

  /**
   * 未处理卡片的展示顺序，**新的在前**。屏幕上一次只显示 `order[0]`。
   *
   * 为什么需要它：原来后到的卡片直接覆盖先到的 —— 于是"另一个会话在等你"
   * 这条信息会**永久丢失**（那条请求在 `cards` 里，但永远不会再上屏）。
   * 有了队列，最坏情况也只是暂时看不到，不会丢；每处理掉一条，下一条自动顶上来。
   */
  const order = []

  /**
   * 判定「你不在 DSH 页面上」。
   *
   * ⚠️ 依据是 **`visible`，不是 `focused`**。实测踩过这个坑：你在看 DSH，
   * 但窗口没有键盘焦点（读了半天没点、或焦点被别的东西拿走）时，
   * `document.hasFocus()` 是 false —— 于是卡片弹到你眼前，而这正是设计里
   * 最想避免的「你在看就别打扰」。
   *
   * `visible === false`（最小化 / 被完全遮挡）才是"肯定不在看"的可靠信号。
   * 反过来，窗口可见时无论有没有焦点都不打扰。
   *
   * presence 未知（宿主刚重启）也按"在看"处理：待处理请求会进入挂起队列，
   * 等你真正离开时再提醒一次，不会丢。
   */
  /**
   * 客户端每 2 秒上报一次（只要页面可见）。超过这个时长没更新，
   * 就认为渲染进程被冻结了 —— 见 awayReason 的推理。
   */
  const PRESENCE_STALE_MS = 6000

  /**
   * 判定「你不在 DSH 页面上」。返回 null 表示**在**（抑制），否则返回离开的依据。
   *
   * 判据的演进（两次投诉后定下来）：
   *   · 只用 `focused`：你看 DSH 但半天没点它 → 失焦 → 误弹
   *   · 只用 `visible`：你把窗口留在屏幕上但人去了桌面 → 仍 visible → 漏弹
   *   两者单独都不行，因为这两种情形的 `{focused:false, visible:true}` **完全一样**。
   *
   * 真正的判别信号是**上报是否还在继续**：
   *   · 你在看但没点它 → 上报照常（每 2 秒），只是 focused 为 false
   *   · 窗口最小化/被完全遮挡 → Chromium **冻结渲染进程**，上报直接停
   * 所以"上报停了"本身就等于"窗口不在屏幕上了"。
   * （这依赖客户端半**不再要求焦点**才上报 —— 见 client.js 的说明。）
   */
  function awayReason(presence, quietOnFocusOnly) {
    if (presence === null) return null // 未知：按"在看"处理，宁可安静
    if (quietOnFocusOnly === true) return presence.focused !== true ? 'window unfocused (legacy rule)' : null
    // 只有拿到**有效时间戳**才敢推断"上报停了"。
    // 缺失/非法时按"仍在上报"处理 —— 保守方向必须是"别多打扰"，
    // 而不是"当作你离开了"（后者会把一处数据缺口放大成当着你的面弹卡）。
    const at = Number(presence.at)
    if (Number.isFinite(at) && at > 0) {
      const age = Date.now() - at
      if (age > PRESENCE_STALE_MS) return `no presence for ${Math.round(age / 1000)}s (renderer frozen)`
    }
    if (presence.visible === false) return 'page hidden'
    return null
  }

  /** 自动消失计时器（0 = 关闭）。 */
  let dismissTimer = null

  function clearDismiss() {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  /**
   * 按设置给当前卡片上闹钟。
   * 卡片只是**提示** —— 真正的操作面在 DSH 自己的审批/提问面板里，
   * 所以自动消失不会让你答不了，只是不占着屏幕。
   */
  function armDismiss() {
    clearDismiss()
    const secs = getSettings().autoDismissSeconds
    if (secs <= 0 || showingId === null) return
    dismissTimer = setTimeout(() => {
      dismissTimer = null
      log('card-auto-dismiss', { afterSeconds: secs, cardId: showingId })
      const toast = getToast()
      if (toast !== null) toast.hide()
      showingId = null
    }, secs * 1000)
  }

  /** 第二行：会话名 · 工具名。 */
  function sessionLine(session, toolName) {
    const s = String(session || '').trim()
    const t = String(toolName || '').trim()
    if (s && t) return `${s} · ${t}`
    return s || t || ''
  }

  /**
   * 把队列里剩下的卡片搁置起来 —— 因为**你已经回到页面**了。
   *
   * 待处理类（审批 / 提问）放回挂起队列，等你下次离开时再提醒一次，不会丢；
   * 「刚发生过的事」（任务完成 / 中断）搁置就过期了，直接丢 —— 回头再报只是噪音。
   *
   * 必须同时清掉 `seen`：那张卡之前**已经显示过**，不放行的话释放时会被去重挡住。
   */
  function deferQueued(ids) {
    let held = 0
    let dropped = 0
    for (const id of ids) {
      const rec = cards.get(id)
      if (rec === undefined) continue
      const at = order.indexOf(id)
      if (at >= 0) order.splice(at, 1)
      cards.delete(id)
      if (rec.kind === 'approval' || rec.kind === 'question') {
        if (deferred.size >= MAX_DEFERRED) {
          const oldest = deferred.keys().next()
          if (!oldest.done) deferred.delete(oldest.value)
        }
        deferred.set(id, rec.input)
        seen.delete(id)
        held += 1
      } else {
        dropped += 1
      }
    }
    return { held, dropped }
  }

  /** 屏幕上应该显示哪个（`more` 只用来提示还有几条在排队）。@returns 是否真的显示了 */
  function showTop() {
    const toast = getToast()
    const live = order.filter((id) => cards.has(id))
    if (live.length === 0) {
      showingId = null
      clearDismiss()
      if (toast !== null) toast.hide()
      return false
    }

    // 屏幕**只在"你不在看"的时候**才显示卡片。
    // 队列前进（某条被处理掉）时你多半刚回到页面 —— 这时弹下一张，
    // 正是"你在看就别打扰"要避免的。改为搁置，等你再离开时提醒。
    //
    // `forced` 的卡片（只可能来自开发用的展示模式）要跳过这道判定：
    // 否则会出现"offer 放行了、showTop 又拦下"的矛盾状态 ——
    // 实测就是展示第一张被搁置、delivered=false。
    if (awayReason(getPresence(), getSettings().quietOnFocusOnly) === null && live[0] !== undefined
      && cards.get(live[0]).forced !== true) {
      const { held, dropped } = deferQueued(live)
      showingId = null
      clearDismiss()
      if (toast !== null) toast.hide()
      log('card-hold', { because: 'watching again', held, dropped })
      return false
    }

    const top = cards.get(live[0])
    showingId = top.cardId
    const payload = { ...top.payload }
    if (live.length > 1) {
      // 第三行直接说明**一共有多少项在等你确认**。
      //
      // 措辞规范：不用口语的"还有 N 条"（"条"也不适合"请求"这个量），
      // 改为"共 N 项待确认"。用**总数**而不是"另有 N 项" —— 你问的是"有多少个"。
      payload.detail = `${payload.detail}（共 ${live.length} 项待确认）`
    }
    if (toast !== null) toast.show(payload)
    log('card-shown', { cardId: top.cardId, pending: live.length })
    armDismiss()

    // 「刚发生过的事」（任务完成 / 中断）是**一次性通知**，没有生命周期可言 ——
    // 上屏之后就从队列里摘掉。
    //
    // 不摘的后果是实测到的：它会**永远**留在队列里（既没有 tool/result 也没有
    // approval/decided 来 settle 它），于是第三行的「还有 N 条」被过期通知虚高
    // ——05:48:53 那条 `pending:2` 就是两条过期的完成通知，而不是两条真的待处理请求。
    // 仍留在 cards 里，所以点击跳转（要靠它反查 sessionId）照常可用。
    if (top.kind !== 'approval' && top.kind !== 'question') {
      const at = order.indexOf(top.cardId)
      if (at >= 0) order.splice(at, 1)
    }
    return true
  }

  /**
   * 推导去重用的卡片标识。
   *
   * ⚠️ 这里**绝不能拿 Date.now() 当默认值** —— 那样每次都是新 id，
   * 去重会被静默架空（实测踩过：同一个 callId 连发两次弹了两张卡）。
   * 优先用调用方给的 cardId，其次 callId / approvalId 这些天然稳定的标识；
   * 实在没有稳定标识时按时间区分，但**必须留一条日志**，否则这种失效是隐形的。
   */
  function deriveCardId(input, kind) {
    if (typeof input.cardId === 'string' && input.cardId !== '') return input.cardId
    if (input.callId) return `${kind}:${input.callId}`
    if (input.approvalId) return `${kind}:${input.approvalId}`
    const sid = String(input.sessionId || 'unknown')
    const fallback = `${kind}:${sid}:${Date.now()}`
    log('card-id-fallback', { cardId: fallback, warning: 'no stable identity — dedup disabled for this offer' })
    return fallback
  }

  /**
   * 尝试弹一张卡片。
   * @returns {{shown:boolean, reason?:string, cardId?:string, situation?:string}}
   */
  function offer(input) {
    try {
      const kind = String(input.kind || 'approval')
      const cardId = deriveCardId(input, kind)
      const settings = getSettings()

      // ⓪ 设置：总开关 + 分类静音。
      //    放在最前面 —— 静音了就什么都不做，连挂起队列都不进。
      if (!settings.enabled) {
        log('suppressed', { cardId, because: 'plugin disabled', kind })
        return { shown: false, reason: 'disabled' }
      }

      const decided = describe({
        kind,
        reason: input.reason,
        toolName: input.toolName,
        planReview: input.planReview === true,
      })
      if (settings.mute[decided.situation] === true) {
        log('suppressed', { cardId, because: `muted:${decided.situation}`, kind })
        return { shown: false, reason: 'muted' }
      }

      // 子代理会话的一次性通知默认静音：workflow 一次可能起几十个子代理，
      // 每个都弹「任务完成」就是纯噪音。
      //
      // ⚠️ **只过滤一次性通知**。审批与提问必须照常 —— 子代理同样可能触发
      // 需要你介入的审批，静音它等于让你永远收不到。
      if (settings.ignoreSubagents
        && (decided.situation === 'completed' || decided.situation === 'interrupted')
        && isSubagentSession(String(input.sessionId || ''))) {
        log('suppressed', {
          cardId, because: 'subagent session', kind, situation: decided.situation,
          sessionId: String(input.sessionId || ''),
        })
        return { shown: false, reason: 'subagent' }
      }

      // ① 抑制：你还在页面上，请求本来就在你眼前，再弹一张只是噪音。
      //    判据见 awayReason —— 核心是「上报是否还在继续」，不是 focused/visible 单独哪一个。
      const presence = getPresence()
      // `force` 只给开发用的展示模式：绕过"你在看就不打扰"，
      // 好让你坐在页面前也能把七种卡片一次看全。正式路径绝不传它。
      const away = input.force === true ? 'forced (dev showcase)' : awayReason(presence, settings.quietOnFocusOnly)
      if (away === null) {
        log('suppressed', {
          cardId,
          because: presence === null ? 'presence unknown (assumed watching)' : 'still watching (presence fresh)',
          kind,
          focused: presence === null ? null : presence.focused,
          visible: presence === null ? null : presence.visible,
          presenceAgeMs: presence === null ? null : Date.now() - (Number(presence.at) || 0),
        })
        // 待处理类挂起：等你真正离开页面时再提醒（见 deferred 的说明）
        if ((kind === 'approval' || kind === 'question') && !seen.has(cardId)) {
          if (deferred.size >= MAX_DEFERRED) {
            const oldest = deferred.keys().next()
            if (!oldest.done) deferred.delete(oldest.value)
          }
          deferred.set(cardId, input)
          log('deferred', { cardId, kind, pending: deferred.size })
        }
        return { shown: false, reason: 'away-check' }
      }

      // ② 去重：同一个请求只弹一次
      if (seen.has(cardId)) {
        log('suppressed', { cardId, because: 'duplicate', kind })
        return { shown: false, reason: 'duplicate' }
      }

      const toast = getToast()
      if (toast === null) {
        log('notify-skipped', { cardId, because: 'toast host unavailable' })
        return { shown: false, reason: 'no-host' }
      }

      const payload = {
        id: cardId,
        title: decided.title,
        session: sessionLine(input.session, input.toolName),
        detail: decided.detail,
      }

      seen.add(cardId)
      deferred.delete(cardId)
      const rec = {
        cardId,
        kind,
        situation: decided.situation,
        sessionId: String(input.sessionId || ''),
        callId: String(input.callId || ''),
        approvalId: String(input.approvalId || ''),
        payload,
        // 留一份原始入参：队列前进时若你已回到页面，卡片要能被重新放进挂起队列
        input,
        // 开发用展示模式的卡片：showTop 的"在看就搁置"判定要放行它们
        forced: input.force === true,
      }
      cards.set(cardId, rec)
      if (rec.callId && rec.approvalId) approvalIdByCallId.set(rec.callId, rec.approvalId)
      order.unshift(cardId)
      // 只由 showTop 统一显示 —— 这里若再 show 一次，同一张卡会弹两遍
      const delivered = showTop()

      log('notified', {
        cardId,
        situation: decided.situation,
        delivered,
        session: payload.session,
        detail: payload.detail,
        sessionId: rec.sessionId,
        pending: order.length,
      })
      return { shown: true, cardId, situation: decided.situation }
    } catch (err) {
      log('offer-failed', { error: String((err && err.message) || err) })
      return { shown: false, reason: 'error' }
    }
  }

  /** 卡片已不再需要（在界面里处理掉了），收起来并让下一条顶上。 */
  function settleByCardId(cardId, because) {
    const id = String(cardId || '')
    const rec = cards.get(id)
    if (rec === undefined) return false
    cards.delete(id)
    const at = order.indexOf(id)
    if (at >= 0) order.splice(at, 1)

    if (showingId !== id) {
      log('card-settled-stale', { cardId: id, because, pending: order.length })
      return false
    }
    log('card-settled', { cardId: id, because, pending: order.length })
    // 队列里还有就顶上，没有才真正隐藏
    showTop()
    return true
  }

  /** 落库的 approval/asked 带来 callId ↔ 审批 id 的对应关系。 */
  function noteApprovalId(callId, approvalId) {
    const cid = String(callId || '')
    const aid = String(approvalId || '')
    if (!cid || !aid) return
    approvalIdByCallId.set(cid, aid)
    // 卡片可能先于落库事件建好，补上归属关系
    for (const rec of cards.values()) {
      if (rec.callId === cid && rec.approvalId === '') rec.approvalId = aid
    }
  }

  /** approval/decided 只带 id —— 靠上面的对应关系反查是哪张卡片。 */
  function settleByApprovalId(approvalId, because) {
    const aid = String(approvalId || '')
    if (!aid) return false
    // 先清掉还在挂起队列里的（请求在你看的时候就处理掉了，不该再提醒）
    for (const [cardId, input] of deferred.entries()) {
      if (String(input.approvalId || '') === aid) {
        deferred.delete(cardId)
        log('deferred-dropped', { cardId, because })
      }
    }
    for (const [callId, mapped] of approvalIdByCallId.entries()) {
      if (mapped !== aid) continue
      for (const rec of cards.values()) {
        if (rec.callId === callId) return settleByCardId(rec.cardId, because)
      }
    }
    for (const rec of cards.values()) {
      if (rec.approvalId !== '' && rec.approvalId === aid) return settleByCardId(rec.cardId, because)
    }
    return false
  }

  /** tool/result 到达 ⇒ 对应的提问/审批已经有结果了。 */
  function settleByCallId(callId, because) {
    const cid = String(callId || '')
    if (!cid) return false
    for (const [cardId, input] of deferred.entries()) {
      if (String(input.callId || '') === cid) {
        deferred.delete(cardId)
        log('deferred-dropped', { cardId, because })
      }
    }
    for (const rec of cards.values()) {
      if (rec.callId === cid) return settleByCardId(rec.cardId, because)
    }
    return false
  }

  /** 由宿主定期调用：一旦判定你离开了，就把挂起中的待处理请求提醒一次。 */
  function releaseIfAway() {
    if (deferred.size === 0) return 0
    const away = awayReason(getPresence(), getSettings().quietOnFocusOnly)
    if (away === null) return 0
    log('deferred-release', { trigger: away, count: deferred.size })
    return releaseDeferred()
  }

  /**
   * 你离开页面了 —— 把挂起中的待处理请求提醒一次。
   */
  function releaseDeferred() {
    if (deferred.size === 0) return 0
    const pending = [...deferred.entries()]
    log('deferred-release', { count: pending.length })
    let shown = 0
    for (const [cardId, input] of pending) {
      deferred.delete(cardId)
      // 走正常的 offer：去重、分类、抑制规则全都照旧
      const r = offer({ ...input, cardId })
      if (r.shown) shown += 1
    }
    return shown
  }

  /**
   * 用户点了卡片：返回它归属的会话，交给上层去导航。
   *
   * **有意不动 `order`/`showingId`**：点一下只是"去看看"，请求本身还没被答复，
   * 所以它还留在队列里；屏幕由助手自己隐藏。等你把那条请求处理掉（`approval/decided`
   * / `tool/result`）才会 settle，届时队首换成下一条 —— 这才是"不打扰"的顺序。
   *
   * 已知的小缺口：若点了 A 却始终不处理它，而队列里 B 又被 settle，
   * 屏幕会保持空白（B 不是当前显示项）。要彻底解决需要视觉并排堆叠，
   * 那属于渲染改动，等 pwsh 恢复、能离屏出图验证时再做。
   */
  function activate(cardId) {
    const rec = cards.get(String(cardId || ''))
    if (rec === undefined) {
      log('activate-unknown', { cardId })
      return null
    }
    log('activate', { cardId, sessionId: rec.sessionId, situation: rec.situation })
    return rec
  }

  function state() {
    return {
      showing: showingId,
      live: cards.size,
      deduped: seen.size,
      deferred: deferred.size,
      cards: [...cards.values()].map((r) => ({
        cardId: r.cardId,
        sessionId: r.sessionId,
        situation: r.situation,
      })),
      deferredCards: [...deferred.values()].map((i) => ({
        cardId: i.cardId,
        kind: i.kind,
        sessionId: i.sessionId,
      })),
      queue: order.slice(),
    }
  }

  /** 插件卸载时清掉自动消失计时器（否则它会在助手已停后还尝试 hide）。 */
  function dispose() {
    clearDismiss()
  }

  return {
    offer,
    settleByCardId,
    settleByApprovalId,
    settleByCallId,
    noteApprovalId,
    releaseDeferred,
    releaseIfAway,
    activate,
    state,
    dispose,
  }
}
