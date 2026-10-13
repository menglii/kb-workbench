/**
 * ui/session-actions.ts —— AI **会话**的两个动作（P7.10 · #11）：导出为笔记 / 删除对话
 *
 * 抽屉行（`ui/ai-panel.ts`）用它们；设置 → AI 助手那一栏的会话列表是同一链路的另一入口
 *（那份在原地、形态更重：危险两段确认 —— 两边都动的是**插件目录**里的同一个 JSON）。
 *
 * ## 为什么单独一个文件，而不是写在面板里
 *
 * `ui/ai-panel.ts` 有一条红线：「一个字都不许出现 `confirm(`」（AI 驱动的**动库**确认流
 * 只能在 `ui/ai-tools.ts`）。那条红线的 why 是**动库**——而"删一段对话记录"动的只是
 * 插件目录、还必须要一道轻确认。把它留在面板里会与红线相撞；于是这两个动作搬到这里，
 * **并在 `redline.ts` 里给本文件配一条自己的禁令**：会话动作只许走
 * `ctx.ai.sessions.remove()`（插件目录 IO），不许碰任何库内写盘 API。
 */
import type { WorkbenchContext } from '../core/context';
import { formatSessionMd } from '../services/ai';
import { confirm } from './confirm';
import { openNewNoteDialog } from './new-note';
import { notifyError, notifyLight } from './notify';

/**
 * 「导出为笔记」：读**那一段** → 与面板头部那枚同一个出口（`openNewNoteDialog` 预填 ——
 * 名字 / 笔记位置由用户当场选，不在这里直接写盘）。
 */
export async function exportSessionById(ctx: WorkbenchContext, id: string): Promise<void> {
  const s = await ctx.ai.sessions.load(id);
  if (!s) {
    notifyError('这段对话读不出来', '文件可能在，但格式认不出');
    return;
  }
  openNewNoteDialog(ctx, { presetTitle: `AI 对话 ${s.title}`, bodyText: formatSessionMd(s) });
}

/**
 * 「删除对话」：**轻确认小框**（"删了不能撤"）→ 删插件目录里那一个 JSON → 轻提示。
 * **只动插件目录、不碰库** —— 所以确认流本体照走（`ui/confirm.ts`，与设置栏那份同一道门），
 * 但不欠快照：对话记录本来就不进快照（传了自定义 `snapshot` 文案把这句说白，
 * 别让默认那句"执行前会自动快照"撒谎）。
 *
 * `opts.active` = 删的正是**面板里当前载入的那一段**。独立审 🟡1 抓的真缺陷：
 * 光删文件不够 —— 面板的 `session` 还指着那个 id，下一轮（或任一「重试」）的
 * `persist()` 会把整段**原样写回来**（"说好删了不能撤，结果又回来了"）。
 * 所以给确认框加一行如实说明，调用方拿到 `true` 后负责把当前段**真的收掉**
 *（抽屉那条路 = `newChat()`：清屏 + 清 turns，语义"这段没了"）。
 *
 * 返回 `true` = 真删了（调用方据此刷新自己的列表）；取消 / 没删 → `false`。
 */
export async function removeSessionById(
  ctx: WorkbenchContext,
  id: string,
  title: string,
  opts: { active?: boolean } = {},
): Promise<boolean> {
  const res = await confirm(
    {
      title: '删除这段对话？',
      preview: [],
      warnings: [],
      notes: [
        `「${title}」删了不能撤 —— 删的是插件目录里的记录，不碰库里的笔记`,
        ...(opts.active ? ['删的正是当前这段：面板会一起清空，就像没聊过它'] : []),
      ],
      snapshot: '对话记录不进快照（快照只管库内文件）',
      primary: { label: '删除' },
    },
    { width: 'narrow' },
  );
  if (res.action !== 'primary') return false;
  await ctx.ai.sessions.remove(id);
  notifyLight('已删除这段对话', title);
  return true;
}
