// dsh-notify —— 插件配置（DSH 的 Config schema）
//
// 为什么要声明它：**当前 DSH 从插件的 Config schema 派生设置界面**
// （dshmarket 的注释原话：「dsh 0.1.7 derives settings from a plugin Config schema」——
// 旧的 `settings.register()` 模型已经移除）。声明之后你在 DSH 的设置里就能改这些项，
// 不需要手改 profile 的 cordis.patch.yml。
//
// 验证方式（不需要 pwsh）：`cordis_inspect_query` 的 Config provider 会把这个条目的
// status 从 `absent` 变成可用，并能读出投影后的 JSON Schema。

// 为什么用**动态 import + try/catch**而不是静态 import：
// 静态 import 解析失败会让**整个插件模块加载不了** —— 实测就是这样：日志里
// 一直没出现新的 `build`，而 `fiberPhase` 仍是 active（旧实例在跑），
// 排查时完全看不出原因。
// 动态导入让插件永远能加载；解析成功与否由 apply 日志里的 `hasConfig` 直接体现，
// 万一解析不到，退化成"没有设置界面"，其余功能照常。
let Config
let schemaError = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  const z = mod.default ?? mod
  Config = z.object({
    enabled: z.boolean().default(true),

    mute: z.object({
      permission: z.boolean().default(false),
      decision: z.boolean().default(false),
      irreversible: z.boolean().default(false),
      risky: z.boolean().default(false),
      generic: z.boolean().default(false),
      completed: z.boolean().default(false),
      interrupted: z.boolean().default(false),
    }),

    /**
     * 抑制判据。
     *
     * `false`（默认）：**窗口可见就不打扰**，无论有没有键盘焦点
     *   —— `document.hasFocus()` 是键盘焦点，不是"你在不在看"。
     * `true`：沿用以键盘焦点为准的旧规则（参考工程的做法）。
     */
    quietOnFocusOnly: z.boolean().default(false),

    /**
     * 忽略子代理会话。
     *
     * ⚠️ **只影响一次性通知**（任务完成 / 任务中断），**绝不影响审批与提问** ——
     * 子代理同样可能触发需要你介入的审批，静音它会导致你**永远收不到**。
     * 判据是 `Session.header.origin === 'subagent'`（权威字段，不是拿 id 前缀猜的）。
     */
    ignoreSubagents: z.boolean().default(true),

    /**
     * 卡片自动消失秒数。`0` = 不自动消失（只能点掉，或被事件收起）。
     *
     * 卡片只是**提示**，真正的操作面在 DSH 自己的审批/提问面板里，
     * 所以自动消失不会让你答不了 —— 只是不占着屏幕。
     */
    autoDismissSeconds: z.number().step(1).min(0).max(600).default(0),
  })
} catch (err) {
  Config = undefined
  schemaError = String((err && err.message) || err)
}

export { Config, schemaError }

/** 分类静音的键集合（与 config schema 里 mute 的字段一一对应）。 */
export const MUTE_KEYS = [
  'permission', 'decision', 'irreversible', 'risky', 'generic', 'completed', 'interrupted',
]

/**
 * 把 Cordis 传进来的 config 归一化，并补齐缺省值。
 *
 * 不直接相信传进来的对象：patch 层可能只给了一部分字段（例如只写了
 * `mute: { completed: true }`），甚至完全没给。逐字段兜住，绝不让 undefined
 * 渗透到判定逻辑里变成"看起来像 false"的隐式行为。
 */
export function normalizeConfig(raw) {
  const c = raw !== null && typeof raw === 'object' ? raw : {}
  const muteRaw = c.mute !== null && typeof c.mute === 'object' ? c.mute : {}
  const mute = {}
  for (const key of MUTE_KEYS) mute[key] = muteRaw[key] === true

  let dismiss = Number(c.autoDismissSeconds)
  if (!Number.isFinite(dismiss) || dismiss < 0) dismiss = 0

  return {
    enabled: c.enabled !== false,
    mute,
    quietOnFocusOnly: c.quietOnFocusOnly === true,
    ignoreSubagents: c.ignoreSubagents !== false,
    autoDismissSeconds: Math.min(Math.floor(dismiss), 600),
  }
}

/**
 * 合并两个来源并归一化，同时告诉调用方**最后是谁说了算**。
 *
 * 优先级：
 *   1. `settings.json`（插件目录里，你自己能直接改）
 *   2. Cordis 传进来的 config（profile patch 层 / Config schema 派生）
 *   3. 内置默认值
 *
 * 为什么以文件为先：当前 Schemastery 解析不到 ⇒ 拿不到 DSH 的设置界面，
 * 而 profile 的 patch 文件又在工作区外（我改不了）。文件是**唯一**你我都能改、
 * 且不需要任何依赖的入口。等设置界面可用时，把这里的两行顺序调过来即可。
 *
 * 逐字段合并（而不是整对象覆盖）：文件里只写 `mute.completed` 时，
 * 其余字段仍应沿用 config 的值，不能被文件的默认值悄悄盖掉。
 */
export function resolveSettings(configRaw, fileRaw) {
  const useFile = fileRaw !== null && typeof fileRaw === 'object'
  const base = configRaw !== null && typeof configRaw === 'object' ? configRaw : {}
  let merged = base
  if (useFile) {
    const baseMute = base.mute !== null && typeof base.mute === 'object' ? base.mute : {}
    const fileMute = fileRaw.mute !== null && typeof fileRaw.mute === 'object' ? fileRaw.mute : {}
    merged = { ...base, ...fileRaw, mute: { ...baseMute, ...fileMute } }
  }
  const source = useFile ? 'settings.json' : (configRaw !== null && configRaw !== undefined ? 'config' : 'defaults')
  return { settings: normalizeConfig(merged), source }
}
