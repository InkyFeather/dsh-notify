// dsh-notify —— 客户端半（在场上报 + 点击跳转的落点）
//
// 两件事：
//   1. 上报窗口焦点/可见性 —— 宿主自己不知道，而这是抑制规则的唯一输入。
//   2. 消费宿主捎回的「待打开会话」并导航。
//
// 为什么导航必须放在这里：卡片是原生窗口，没有能力驱动 SPA。所以流程是
//   点卡片 → 助手把 DSH 窗口拉到前台 → 页面拿到焦点 → 本文件上报 presence
//   → 宿主在响应里捎回待打开的 sessionId → openSession()。
// 触发源是**焦点事件**而不是轮询，绕开了隐藏窗口里定时器被节流的问题。
//
// 形态说明：这是 DSH 客户端 bundle 的原生格式（react 等由宿主模块表解析，
// 所以不需要构建工具链）。本文件刻意不依赖任何 @deepseek-ai/* 导出 ——
// runtime API 漂移风险几乎归零，所有调用都做特性检测。

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    const ROUTE = '/dsh-notify/presence'
    /**
     * 兜底轮询间隔。只在页面**可见且有焦点**时真正发请求 ——
     * 这正是定时器不会被节流的场景，所以它是可靠的（隐藏窗口才会被节流，而那时
     * 也看不见导航结果）。2 秒是为了覆盖「页面本来就已获得焦点，点卡片不产生
     * focus 事件」这条路径；本地回环请求，代价可忽略。
     */
    const SAFETY_POLL_MS = 2000
    /** focus/blur/visibilitychange 常成串触发，做一点合并；但绝不做状态去重，
        否则会漏掉「取回待打开会话」的机会。 */
    const COALESCE_MS = 300

    let pluginCtx = null
    let safetyTimer = null
    let lastReport = 0

    /**
     * 把一条诊断捎回宿主日志。
     *
     * 为什么需要它：浏览器控制台我看不到，而点击跳转是跨进程链路
     * （助手 → 宿主 → 页面），失败点可能在任一环。让每一环都留痕，
     * 出问题时看日志就能定位，不用猜。
     */
    function note(text) {
      try {
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            focused: document.hasFocus(),
            visible: document.visibilityState !== 'hidden',
            source: 'client',
            note: String(text).slice(0, 300),
          }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 静默 */
      }
    }

    /** uiWorkspace.openSession(target)，target 就是 sessionId 字符串。 */
    function openSession(sessionId) {
      try {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (pluginCtx === null || typeof pluginCtx.get !== 'function') {
          note('openSession 失败：插件上下文还没就绪')
          return
        }
        const ui = pluginCtx.get('uiWorkspace')
        if (!ui || typeof ui.openSession !== 'function') {
          note('openSession 失败：uiWorkspace.openSession 不可用')
          return
        }
        ui.openSession(sessionId)
        note(`openSession 已调用：${sessionId}`)
      } catch (err) {
        note(`openSession 抛错：${String((err && err.message) || err)}`)
      }
    }

    function report(force) {
      try {
        const now = Date.now()
        if (force !== true && now - lastReport < COALESCE_MS) return
        lastReport = now

        const payload = {
          focused: document.hasFocus(),
          visible: document.visibilityState !== 'hidden',
          source: 'client',
        }
        // keepalive：切走页面的瞬间也能把状态发出去
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((out) => {
            if (out && typeof out.open === 'string' && out.open !== '') {
              note(`收到待打开会话：${out.open}`)
              openSession(out.open)
            }
          })
          .catch(() => {
            /* 上报失败不该影响页面；下一次事件会再报 */
          })
      } catch {
        /* 静默：绝不允许拖垮页面 */
      }
    }

    function startSafetyPoll() {
      if (safetyTimer !== null) return
      safetyTimer = setInterval(() => {
        // ⚠️ 判据是**只要求可见，不要求焦点** —— 这一点很关键。
        //
        // 宿主靠"上报是否还在继续"来区分两件长得一样的事：
        //   · 你在看 DSH 但没点它（focused:false, visible:true）→ 上报照常 ⇒ 不打扰
        //   · 窗口被最小化/遮挡，Chromium 冻结渲染进程 → 上报停止 ⇒ 判定你离开了
        // 如果这里要求 hasFocus()，第一种情形也会停止上报，两者就无法区分了
        // （实测两次误判都是这么来的）。
        if (document.visibilityState === 'visible') report(true)
      }, SAFETY_POLL_MS)
    }

    function apply(ctx) {
      try {
        pluginCtx = ctx
        report(true)
        addEventListener('focus', () => report(false))
        addEventListener('blur', () => report(false))
        addEventListener('visibilitychange', () => report(false))
        addEventListener('pageshow', () => report(true))
        startSafetyPoll()

        const teardown = () => {
          try {
            if (safetyTimer !== null) {
              clearInterval(safetyTimer)
              safetyTimer = null
            }
          } catch {
            /* ignore */
          }
        }
        if (ctx && typeof ctx.effect === 'function') ctx.effect(() => teardown)
      } catch {
        /* 静默 */
      }
    }

    const exports_ = {}
    exports_.name = 'dsh-notify'
    exports_.apply = apply
    return exports_
  },
})
