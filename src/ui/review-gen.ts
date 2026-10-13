/**
 * ui/review-gen.ts —— **「从笔记生成回顾卡」**（P8 期 4）
 *
 * 一条链：AI 出稿（`ctx.ai.reviewCards`）→ **面板（可改可删）** → 确认流 → 写库内 `复习.json`。
 *
 * 与「美化笔记」（`ui/beautify.ts`）同一条骨架，逐条对齐：
 *   · **只出稿、不动库** —— 写不写由确认流说了算；本文件自己不碰盘；
 *   · 写链复用 `ui/review-create.ts` 的 `commitReviewCards`（**一处实现**：
 *     手动建卡与 AI 生成都走它 —— 各写一遍必然漂成"有的过确认流、有的不过"）；
 *   · `03_AI指令集`（保护目录）与"没配 AI"**在发起前就拦**（与起标题/美化同一道闸）；
 *   · **解析失败要报出来，不去猜**：`AiParseError` 带着模型的原文，照实摊给用户看。
 *
 * 🔴 **不给 AI 加新工具**（`AI接口冻结-P7.3c.md` 的工具表已冻结）：
 * "从笔记生成卡片"是**插件侧的动作** —— 模型只说，插件才做。
 *
 * 出稿**不做截断**（服务层超长直接拒绝）：卡片是从正文里提炼的，没看全的正文会漏掉该出的卡，
 * 那是**静默的质量损失**，比报错难查。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { inKbScope, relativeTo } from '../core/paths';
import { AiError, AI_PROTECTED_WHY, isAiProtected } from '../services/ai';
import { AiParseError, REVIEW_CARDS_MAX } from '../services/ai/prompt';
import { AI_NOT_CONFIGURED } from './suggest-panel';
import { notifyError, notifyLight } from './notify';
import { openModal } from './panel';
import { btn, div, el, span } from './primitives';
import { commitReviewCards, type CreateReviewCardInput } from './review-create';

/** 同一时刻只跑一轮（出稿要一会儿，连点两次会让模型跑两遍） */
let running = false;

export interface ReviewGenCard {
  front: string;
  back: string;
}

export async function runReviewGen(ctx: WorkbenchContext, file: TFile): Promise<number> {
  if (running) {
    notifyLight('上一轮生成还没走完', '等面板出来再说');
    return 0;
  }
  if (!ctx.ai.isConfigured()) {
    notifyLight(AI_NOT_CONFIGURED);
    return 0;
  }
  /** 保护目录硬拦：拦的是**发起**（AI 读它再出稿），用户自己动那篇不受影响 */
  if (isAiProtected(file.path, ctx.ai.protectedDir())) {
    notifyLight(AI_PROTECTED_WHY);
    return 0;
  }
  const kbRoot = ctx.settings.kbRoot();
  /**
   * ⚠️ 闸用 `inKbScope`（P7.14 收编的**唯一**范围谓词），**不是** `relativeTo` 那条：
   * `kbRoot === ''` 是**合法配置**（"整个库"档，见 `settings.ts` 的注释）—— 那时
   * `relativeTo` 原样返回路径，`rel === file.path` 恒真 → 这一档下功能 100% 不可用，
   * 还会报"这一篇不在库根之下"（用户根本没设库根）。**独立审 2026-10-10 抓的**：
   * 这是从 `ui/beautify.ts` 逐字抄来的旧账（那边同款），本批不该再抄一份。
   */
  if (!inKbScope(file.path, kbRoot)) {
    notifyLight('这一篇不在工作文件夹里', '生成回顾卡只服务库里的笔记');
    return 0;
  }
  const rel = relativeTo(file.path, kbRoot);

  running = true;
  try {
    notifyLight('AI 出稿中…', `《${file.basename}》· 要一会儿`);
    let out: Awaited<ReturnType<WorkbenchContext['ai']['reviewCards']>>;
    try {
      out = await ctx.ai.reviewCards({ rel });
    } catch (e) {
      /**
       * **解析失败要报出来，不去猜**：`AiParseError` 带着模型的原话，
       * 摊一句原文片段给用户看（他可能一眼就知道"模型又在说废话"）。
       */
      if (e instanceof AiParseError) {
        notifyError('没看懂模型回的话（笔记没动）', `${e.message}｜原文：${e.raw.slice(0, 80)}`);
        return 0;
      }
      notifyError(
        '没生成出来（笔记没动）',
        e instanceof AiError ? e.hint : e instanceof Error ? e.message : String(e),
      );
      return 0;
    }

    if (out.cards.length === 0) {
      notifyLight('这篇没什么可问的', 'AI 没给出卡片（原样没动）—— 换一篇，或者手工建一张');
      return 0;
    }

    const drafts = await openReviewGenPanel(file.basename, out.cards, out.truncated);
    if (!drafts) return 0;
    return await commitReviewCards(ctx, file.path, drafts);
  } catch (e) {
    /**
     * 🔴 **必须有 catch**（独立审 2026-10-10 🟠 抓的）：三个入口全都 `void runReviewGen(...)`
     *（右键菜单 / 头部按钮 / 空态动作）—— 只有 `try/finally` 的话，面板或确认流里任何一步抛出
     * 都变成**未捕获拒绝**：不弹错、无提示，用户看到"点了什么都没发生"。
     * `ui/beautify.ts` 的注释里记过这一条（A3 那笔账），本文件头又写着"逐条对齐" ——
     * 那就要真的对齐。
     */
    notifyError('生成没走完（笔记没动）', e instanceof Error ? e.message : String(e));
    return 0;
  } finally {
    running = false;
  }
}

/**
 * 出稿面板：**每张一行、两个面都能改、能删**。
 * 返回要入库的那些（取消 → `null`，**一个字节都不写**）。
 *
 * ⚠️ 收的是**来源笔记的短名**（不是 `TFile`）—— 这样 `FOOT_CASES` 那张遍历表
 *（`tests/specs/panels.ts`：每个 `openModal` 模态一行）能直接把它打开，
 * 不必先造一篇笔记。
 */
export function openReviewGenPanel(
  sourceLabel: string,
  cards: ReviewGenCard[],
  truncated = 0,
): Promise<CreateReviewCardInput[] | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: CreateReviewCardInput[] | null): void => {
      if (done) return;
      done = true;
      h.close(v == null ? 'cancel' : 'ok');
      resolve(v);
    };
    const h = openModal({
      title: `AI 出的回顾卡 · ${cards.length} 张`,
      sub: `来源：${sourceLabel} —— 改完再入库；删掉的不会写进去`,
      width: 'wide',
      onClose: () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      },
    });

    const rows: { row: HTMLElement; front: HTMLTextAreaElement; back: HTMLTextAreaElement }[] = [];
    const list = div({ cls: 'kbw-gen-list' });
    h.body.appendChild(list);
    if (truncated > 0) {
      list.appendChild(
        div({ cls: 'kbw-gen-trunc', text: `（模型多给了 ${truncated} 张，这一轮只收前 ${REVIEW_CARDS_MAX} 张）` }),
      );
    }

    const footBtn = btn({ cls: 'kbw-btn is-primary', text: '入库' });

    /** 主按钮文案跟着"还剩几张"走（删到 0 就置灰：不给点了没反应的按钮） */
    function refreshFoot(): void {
      const n = rows.length;
      footBtn.textContent = n === 0 ? '没有可入库的' : `入库 ${n} 张`;
      footBtn.toggleAttribute('disabled', n === 0);
      footBtn.setAttribute('aria-disabled', n === 0 ? 'true' : 'false');
    }

    for (const c of cards) {
      const row = div({ cls: 'kbw-gen-row' });
      const field = (label: string, value: string, rowsCount: number) => {
        const box = div({ cls: 'kbw-gen-field' });
        box.appendChild(span({ cls: 'kbw-gen-tag', text: label }));
        const ta = el('textarea', {
          cls: 'kbw-input kbw-review-input',
          attr: { rows: String(rowsCount) },
        }) as HTMLTextAreaElement;
        ta.value = value;
        box.appendChild(ta);
        row.appendChild(box);
        return ta;
      };
      const front = field('正面', c.front, 2);
      const back = field('背面', c.back, 2);
      const del = btn({
        cls: 'kbw-btn is-small kbw-gen-del',
        text: '删掉这张',
        attr: { title: '这一张不入库' },
      });
      row.appendChild(del);
      del.addEventListener('click', () => {
        const i = rows.findIndex((r) => r.row === row);
        if (i >= 0) rows.splice(i, 1);
        row.remove();
        refreshFoot();
      });
      list.appendChild(row);
      rows.push({ row, front, back });
    }

    h.foot.style.display = '';
    h.foot.appendChild(div({ cls: 'kbw-spacer' }));
    h.foot.appendChild(btn({ cls: 'kbw-btn', text: '不动它', on: { click: () => finish(null) } }));
    footBtn.addEventListener('click', () => {
      const out = rows
        .map((r) => ({ front: r.front.value.trim(), back: r.back.value.trim() }))
        .filter((r) => r.front !== '' && r.back !== '');
      /**
       * 有整行空着的 → 不放行：说清是第几行（"留空即不入库"这条要用户自己删掉那一行才成立，
       * 免得他以为空着就是丢掉）。
       */
      if (out.length !== rows.length) {
        /**
         * ⚠️ **点名第几张**（独立审 2026-10-10 🟡）：只写"有卡片只填了一半"的话，
         * 8 张稿里用户得自己一行行找。按仓里的口径，被跳过的那个要说出来。
         */
        const half = rows.findIndex((r) => r.front.value.trim() === '' || r.back.value.trim() === '');
        notifyLight(`第 ${half + 1} 张只填了一半`, '请点它的「删掉这张」，或在两个面都写上');
        return;
      }
      finish(out);
    });
    h.foot.appendChild(footBtn);
    refreshFoot();
  });
}
