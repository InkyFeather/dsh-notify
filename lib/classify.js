// dsh-notify —— 分类规则与文案抽取
//
// 分类体系（六个标题 + 一个扩展）措辞与取向继承参考工程 src/main/wire.ts，
// 判定依据升级为**权威字段**（P0 实测）：
//   · `displayReason` 是本地化映射 {en, zh, …}，只存在于 waterfall 事件上
//   · `reason`（落库那份）是英文合成串 `<英文前缀>: <模型自由文本>`
//
// 三条继承的设计哲学：
//   1. 标题写死为分类名，卡片只回答「现在是什么情况」
//   2. 措辞不明确时一律落到兜底 —— 宁可少喊也不乱喊
//   3. `修改` / `写入` 故意不算高危 —— 几乎每个写操作都命中，要加得先接受噪声

/** 分类 → 固定标题。措辞沿用参考工程，只有 `interrupted` 是本项目新增。 */
export const SITUATION_TITLE = {
  permission: '权限授予确认',
  decision: '方案抉择',
  irreversible: '不可逆变更确认',
  risky: '高危操作复核',
  generic: '人工介入请求',
  completed: '任务完成',
  interrupted: '任务中断',
}

/** 无自由文本可抽取时的第三行兜底。措辞统一为**书面语**：不用"要用""等你""这一轮"这类口语。 */
const SITUATION_DEFAULT_DETAIL = {
  decision: '计划已就绪，待你确认',
  completed: '本轮已完成',
  interrupted: '执行出错，无法自动恢复',
}

/**
 * Host 的沙箱升级模板（本地化）。注意权限名是**嵌在中文里的英文小写**：
 *   `允许本次操作使用 danger-full-access 权限：<自由文本>`
 * 正则来自参考工程 wire.ts（它是从客户端转发帧里看到的本地化文本）。
 */
const ESCALATION_ZH = /^允许本次操作使用\s*([a-z-]+)\s*权限/

/**
 * 同一模板的英文形态。P0 实测落库的 `reason` 长这样：
 *   `escalate sandbox to danger-full-access: <自由文本>`
 * 参考工程注释里记的是 `allow this operation with <mode> permissions: …` —— 两种都兜。
 */
const ESCALATION_EN = /^(?:allow this operation with|escalate sandbox to)\s*([a-z-]+)/i

/** 措辞标记：批量 / 不可恢复。 */
const IRREVERSIBLE_WORDING = /批量|不可逆|不可恢复|永久|清空|格式化|覆盖|rm\s+-rf|remove-item\s+-recurse|truncate|wipe/i

/** 措辞标记：破坏性操作。 */
const RISKY_WORDING = /删除|移除|清除|重命名|delete|remove|drop|unlink|\brm\b/i

/** 沙箱模式的显示名。键是 Host 文案里的英文小写模式名。 */
export const MODE_LABEL = {
  'read-only': '只读',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全访问',
}

/** 超过这个长度的"前缀"其实也是散文，退回通用短语更易读。 */
const MAX_REASON_CHARS = 24
/** 兜底第三行。与「计划已就绪，待你确认」用词统一（"待"而非"需"）。 */
const GENERIC_REASON = '待你确认后继续'

/**
 * 取用于展示的文案。优先本地化映射，退回落库的英文合成串。
 */
export function pickReasonText(req, locale = 'zh') {
  const dr = req && req.displayReason
  if (dr !== null && typeof dr === 'object') {
    if (typeof dr[locale] === 'string' && dr[locale]) return dr[locale]
    if (typeof dr.zh === 'string' && dr.zh) return dr.zh
    if (typeof dr.en === 'string' && dr.en) return dr.en
  }
  if (req && typeof req.reason === 'string' && req.reason) return req.reason
  return ''
}

function escalationPhrase(mode) {
  // 原来写作"要用「X」权限" —— "要用"是口语，且没说清这是"请求授权"这件事。
  return `请求「${MODE_LABEL[mode] || mode}」权限`
}

/**
 * 卡片的第三行：从 Host 文案里抽出可读的短句。
 *
 * Host 的文案是「短固定前缀 + 自由文本尾巴」，尾巴经常几百字符（实测 230 字符），
 * 必须丢掉。前缀超过 MAX_REASON_CHARS 就说明它也不是固定模板，退回通用短语。
 */
export function shortenReason(reason) {
  const text = String(reason || '').trim()
  if (text === '') return GENERIC_REASON

  const zh = ESCALATION_ZH.exec(text)
  if (zh !== null) return escalationPhrase(zh[1])
  const en = ESCALATION_EN.exec(text)
  if (en !== null) return escalationPhrase(en[1])

  // 其余情况：第一个冒号之前就是 Host 的固定部分
  const cut = text.search(/[：:]/)
  const head = (cut > 0 ? text.slice(0, cut) : text).trim()
  if (head === '' || head.length > MAX_REASON_CHARS) return GENERIC_REASON
  return head
}

/**
 * 把一个审批细化到措辞能支撑的最具体分类。
 * 沙箱模板是精确匹配、先查；其余都是关键词证据，不认识的措辞一律落到兜底 ——
 * 不声称自己证明不了的严重性。
 */
export function classifyApproval(reason, toolName) {
  const text = String(reason || '')
  if (ESCALATION_ZH.test(text) || ESCALATION_EN.test(text)) return 'permission'
  const joined = `${text} ${String(toolName || '')}`
  if (IRREVERSIBLE_WORDING.test(joined)) return 'irreversible'
  if (RISKY_WORDING.test(joined)) return 'risky'
  return 'generic'
}

/**
 * 组装卡片的标题与第三行。
 *
 * @param {object} input
 * @param {'approval'|'question'|'completed'|'interrupted'} input.kind
 * @param {string} [input.reason]    Host 合成的文案（或本地化后的文案）
 * @param {string} [input.toolName]
 * @param {boolean} [input.planReview]  提问是否带 `intent.kind === 'plan-review'`
 * @returns {{situation: string, title: string, detail: string}}
 */
export function describe(input) {
  const { kind, reason, toolName, planReview } = input || {}
  if (kind === 'question') {
    if (planReview) {
      // 方案待审：问题文案往往是整段散文，抽不出好短句，用固定短语更清楚
      return {
        situation: 'decision',
        title: SITUATION_TITLE.decision,
        detail: SITUATION_DEFAULT_DETAIL.decision,
      }
    }
    return {
      situation: 'generic',
      title: SITUATION_TITLE.generic,
      detail: shortenReason(reason),
    }
  }
  if (kind === 'completed') {
    // completed / interrupted 的 reason **不是** Host 的「模板 + 散文」结构，
    // 而是回合结束原因，所以不走 shortenReason —— 否则会退回「有一步需要你确认」
    // 那句带决策含义的通用短语，用在这里是错的。
    return {
      situation: 'completed',
      title: SITUATION_TITLE.completed,
      detail: SITUATION_DEFAULT_DETAIL.completed,
    }
  }
  if (kind === 'interrupted') {
    return {
      situation: 'interrupted',
      title: SITUATION_TITLE.interrupted,
      detail: SITUATION_DEFAULT_DETAIL.interrupted,
    }
  }
  const situation = classifyApproval(reason, toolName)
  return {
    situation,
    title: SITUATION_TITLE[situation],
    detail: shortenReason(reason),
  }
}
