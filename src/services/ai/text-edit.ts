/**
 * services/ai/text-edit.ts —— **正文编辑的纯逻辑**（P7.22a · #1）
 *
 * `patch_text`（find → replace）与 `append`（文末追加）的判定都收在这里：
 * **只收/只回正文那一半**（前言由调用方 `splitFrontmatter` 切开、原样拼回 ——
 * 与 `ui/beautify.ts` 的"只换正文"同一条口径）；本件不碰 IO，纯字符串进字符串出。
 *
 * ## 三态幂等（对齐 `services/doc-patches.ts`，但**先看谁**不一样，理由写在这）
 *
 * `doc-patches` 的幂等是"**先看 `replace`**"——因为它的补丁里有"追加型"（打完 find 仍在，
 * 先看 find 会永远算待打）。而 `patch_text` 是**替换型**：find 打完就没了，
 * 所以判序反过来：
 *   · `find` 恰好 1 处 → **待打**（执行）；
 *   · `find` 0 处：
 *       - `replace` 非空且在正文里 → **已打**（上次已经改过，跳过并如实说）；
 *       - 否则 → **miss**（原文抄错 / 有人手改过）→ 不写、报出来。
 *   · `find` 不止 1 处 → **不写**（"改哪一处"没法确定 —— 引导模型多抄几个字让它唯一）。
 *
 * `append` 是追加型，没有"已打"态 —— 自证口径 = **尾部包含检查**：
 * 正文 trim 尾部之后以 content（trim 后）结尾 → 认作"已经有这段了"，不重复追加。
 *
 * ⚠️ 这两个函数在**两处**跑：工具预检（dry-run —— 命中不了的**不摆到待确认卡上**）
 * 与写盘回调里（`vault.process` 当刻正文重算一遍 —— 确认期间正文被改过时，
 * 幂等/命中判定以**当刻**为准）。两处同一份实现，这是抽出来的理由。
 */
import { countOccurrences } from '../doc-patches';

/** 判定结果：`{body}` = 写这个新正文；`{why}` = 不写（原因给模型与用户看） */
export type TextEditPlan = { body: string } | { why: string };

/**
 * `patch_text`：在**正文**里把 `find` 换成 `replace`（replace 给空串 = 删掉这一段）。
 * 判序与三态见文件头。`find` 原文照抄（含标点/空白 —— **不做 trim 后比对**，
 * 但"空"的检查用 trim —— 全是空白等于没找）。
 */
export function planPatchText(body: string, find: string, replace: string): TextEditPlan {
  if (find.trim() === '') return { why: 'find 是空的 —— 要说清替换哪一段' };
  /** 一字不差的 no-op（独立审 🟢9）：真写下去 = 一次"假动作"（日志/撤销条都记一遍、内容没变） */
  if (find === replace) return { why: '找的和换的一模一样 —— 没有可改的' };
  const n = countOccurrences(body, find);
  if (n === 1) {
    return { body: body.replace(find, replace) };
  }
  if (n === 0) {
    if (replace.trim() !== '' && body.includes(replace)) {
      /** 已打态：正文里已经是替换后的样子（find 不在、replace 在） */
      return { why: '正文里已经是替换后的样子了（这处看起来已经改过，没有重复改）' };
    }
    return {
      why:
        '正文里没找到这段原文（find 要一字不差地抄，含标点；' +
        '如果它在前言里，改属性请用 set_prop）',
    };
  }
  return {
    why: `这段原文在正文里出现了 ${n} 处 —— 没法确定改哪一处；多抄几个字让它唯一（恰好 1 处才改）`,
  };
}

/**
 * `append`：把 `content` 追加到**正文末尾**。追加的分隔照"最保守"来：
 * 正文已以 `\n\n` 结尾就直接接、以 `\n` 结尾补一个、否则补 `\n\n`；
 * 正文为空时直接落 content。**既有字符一个不动**（只在必要处补分隔）。
 */
export function planAppend(body: string, content: string): TextEditPlan {
  if (content.trim() === '') return { why: 'content 是空的 —— 没有要追加的内容' };
  /** 尾部包含检查（幂等的自证口径；trim 后比对 —— 末尾换行的差异不算"新内容"） */
  if (body.trimEnd().endsWith(content.trimEnd())) {
    return { why: '文末已经有这段内容了，没有重复追加' };
  }
  if (body === '') return { body: content };
  const sep = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
  return { body: body + sep + content };
}
