/**
 * ui/review-create.ts —— 「生成回顾卡」那条链（P8 期 2）
 *
 * **一处实现**：笔记右键菜单与「回顾」栏的入口都走这里 ——
 * 各拼一遍必然漂成"有的走确认流、有的不走"（本项目记过这类账）。
 *
 * 链：建卡对话框（填两面）→ `ui/confirm.ts` 的确认流（**硬规矩 #3**：动库前确认）→ 写库内 `复习.json`。
 * ⚠️ 卡片是**派生数据**：动的是库内那张表，**不碰来源笔记**（红线断言钉着这条）。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { noteLabel, type ReviewCard } from '../services/review';
import { confirm } from './confirm';
import { openReviewCardDialog } from './review-card';
import { notifyError, notifyInfo } from './notify';
import { div, span } from './primitives';

export interface CreateReviewCardInput {
  front: string;
  back: string;
}

/**
 * 走完确认流的那一半：**一次确认、一次落盘**，返回真写进去几张。
 *
 * 手动建卡（N=1）与期 4 的 AI 生成（N 张）**共用这一份** —— 各写一遍必然漂成
 * "有的过确认流、有的不过"（本项目记过这类账）。
 * ⚠️ 落库走 `addCards`（一次写盘）：N 张逐张 `addCard` 会写 N 次整文件。
 */
export async function commitReviewCards(
  ctx: WorkbenchContext,
  notePath: string,
  inputs: CreateReviewCardInput[],
): Promise<number> {
  /** 两个面都非空的才收（AI 那边解析已经拦过一道，这儿是最后一道） */
  const cards = inputs
    .map((i) => ({ front: i.front.trim(), back: i.back.trim() }))
    .filter((i) => i.front !== '' && i.back !== '');
  if (cards.length === 0) return 0;
  /**
   * ⚠️ **确认之前重查一次来源笔记还在不在**（独立审 2026-10-10 🟢）：面板/对话框开着的时候，
   * 那一篇可能被删掉或被搬走（真库同步就在同一进程里跑）—— 不查的话卡片会落到一个空路径上，
   * 面板只能画"来源已不在"，而 `pruneNote` 早就跑过了、不会再来一次。
   */
  if (!(ctx.app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
    notifyError('这一篇不在库里了（没写）', '可能刚被删掉或搬走 —— 刷新一下再看');
    return 0;
  }
  const one = cards.length === 1;
  const res = await confirm({
    title: one ? '即将新建回顾卡' : `即将新建 ${cards.length} 张回顾卡`,
    /** 预览行留空：这不是"搬/改/删哪几篇"，是卡片 —— 正反面走下面的 `attach` 只读展示 */
    preview: [],
    warnings: [],
    notes: [
      `正反面写进库内「复习」那张表（${ctx.review.displayPath()}）。这篇笔记一个字节都不动。`,
      '之后改笔记名/搬目录时，卡片会自动跟着走。',
    ],
    /** ⚠️ 不动任何笔记 → 那句"执行前会自动快照"在这儿是**假话**，必须换掉 */
    snapshot: '（只改库内那张表，不碰笔记，不拍快照）',
    primary: { label: one ? '新建这张卡' : `新建这 ${cards.length} 张` },
    /**
     * 只读展示这些卡的两个面 —— 确认流允许调用方自己画的**唯一**一处
     *（`ConfirmSpec.attach` 的口径：只放展示物，行为仍归确认流独家说了算）。
     */
    attach: (host) => {
      const box = div({ cls: 'kbw-review-preview' });
      const line = (label: string, text: string) => {
        const row = div({ cls: 'kbw-review-preview-row' });
        row.appendChild(span({ cls: 'kbw-review-preview-tag', text: label }));
        row.appendChild(div({ cls: 'kbw-review-preview-txt', text }));
        box.appendChild(row);
      };
      line('挂在', noteLabel(notePath));
      for (const c of cards) {
        line('正面', c.front);
        line('背面', c.back);
      }
      host.appendChild(box);
    },
  });
  if (res.action !== 'primary') return 0;
  /**
   * ⚠️ **写失败要说出来**：`复习.json` 坏了（手改坏 / 同步写一半）时 store 会**拒绝写**
   *（`ReviewRefusedError`）—— 那是**故意**的：宁可这次不写，也不能拿"空表"把用户所有卡片覆盖掉。
   * 所以这里必须把它报成一等错误，别吞。
   */
  let made: ReviewCard[] = [];
  try {
    made = await ctx.review.addCards(
      cards.map((c) => ({ note: notePath, front: c.front, back: c.back })),
    );
  } catch (e) {
    notifyError('这次没写进去', e instanceof Error ? e.message : String(e));
    return 0;
  }
  notifyInfo(
    one ? '已新建回顾卡' : `已新建 ${made.length} 张回顾卡`,
    `挂在「${noteLabel(notePath)}」上；改笔记名/搬目录时它跟着走`,
  );
  return made.length;
}

/** 单张的老口子（期 2 的用例与调用方还按它写）：N=1 的特例 */
export async function commitReviewCard(
  ctx: WorkbenchContext,
  notePath: string,
  input: CreateReviewCardInput,
): Promise<boolean> {
  return (await commitReviewCards(ctx, notePath, [input])) > 0;
}

/** 菜单入口：对话框 → 确认流 → 落库。返回是否真的建了 */
export async function createReviewCardFlow(
  ctx: WorkbenchContext,
  notePath: string,
): Promise<boolean> {
  if (!(ctx.app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
    notifyError('这篇笔记不在库里了', '刷新一下再看');
    return false;
  }
  const input = await openReviewCardDialog({ noteLabel: noteLabel(notePath) });
  if (!input) return false;
  return commitReviewCard(ctx, notePath, input);
}
