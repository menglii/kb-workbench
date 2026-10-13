/**
 * modules/review —— 回顾（P8）
 *
 * **期 4**（本文件现在的样子 = P8 完整形态）：期 2 的数据与手动建卡 + 期 3 的复习流程
 *（今日筛选 · 开始复习 · 浮层在 `ui/review-session.ts` · 本轮小结）+ 期 4 的
 * **从笔记生成**（`ui/review-gen.ts`：AI 出稿 → 可改可删 → 确认流 → 入库）。
 *
 * 数据：库内 `99_Meta/06_工作台/复习.json`（`config-files` 第 4 个条目）。
 * 两条硬约束（计划 §3）：**只写库内 JSON，不写笔记属性**；**改笔记名/搬笔记要迁键**
 *（迁键挂在 `main.ts` 的 `vault.on('rename')`，与顺序表/比例表同一处 —— 不挂模块里，理由同那两处）。
 *
 * 重绘靠 `ctx.configs.watch('review')`：文件变了（包括**用户手改**、以及别的入口写）就重画这一块。
 */
import { TFile } from 'obsidian';
import type { ModuleRender, WorkbenchContext } from '../../core/context';
import { formatDueTime } from '../../core/util';
import type { NoteEntry } from '../../core/vault-index';
import { dueCards, noteLabel, startOfDay, type ReviewCard, type ReviewFile } from '../../services/review';
import { confirm } from '../../ui/confirm';
import { pickOne } from '../../ui/prompt';
import { runReviewGen } from '../../ui/review-gen';
import { openReviewSession, tallyText, type ReviewSessionHandle } from '../../ui/review-session';
import { notifyError, notifyInfo, notifyLight } from '../../ui/notify';
import { emptyState } from '../../ui/empty';
import { btn, div, span } from '../../ui/primitives';

/** 「今日」/「全部」两档（期 3 的今日筛选） */
type ReviewScope = 'due' | 'all';

export const renderReview: ModuleRender = (host, ctx) => {
  const m = new ReviewModule(ctx);
  m.mount(host);
  return () => m.dispose();
};

class ReviewModule {
  private ctx: WorkbenchContext;
  private headHost!: HTMLElement;
  private listHost!: HTMLElement;
  /** `configs.watch('review')` 的退订 —— 模块被换掉/视图关掉时要收干净 */
  private off: (() => void) | null = null;
  /** 列表档位（**默认「今日」**：打开这一栏就是想看"现在该做什么"） */
  private scope: ReviewScope = 'due';
  /** 开着的复习浮层（防连点；**也是"浮层开着时跳过重画"的判据** —— 见 mount 里 watch 那段） */
  private session: ReviewSessionHandle | null = null;

  constructor(ctx: WorkbenchContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    const shell = div({ cls: 'kbw-review' });
    host.appendChild(shell);
    this.headHost = div({ cls: 'kbw-review-head' });
    this.listHost = div({ cls: 'kbw-review-list' });
    shell.appendChild(this.headHost);
    shell.appendChild(this.listHost);

    /**
     * 文件变了（自己写的 / 用户手改的 / 别处入口写的）都重画。
     * ⚠️ **复习浮层开着时跳过**（独立审 2026-10-10 指出的注释与实现不符）：每评一张卡就会写一次盘
     * → watch 每张都触发一次重画，而那一屏被浮层盖着、重画纯属浪费（浮层关掉时 `startSession`
     * 自己会收尾重画一次）。这也让 `session` 字段那句注释成真。
     */
    this.off = this.ctx.configs.watch('review', () => {
      if (!this.session) void this.render();
    });
    void this.render();
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    /** 模块被换掉 / 视图关掉时，浮层不该留在屏上（它挂在 body 上，不会跟着模块一起消失） */
    this.session?.close();
    this.session = null;
  }

  private async render(): Promise<void> {
    const res = await this.ctx.review.loadDetailed();
    const { file } = res;
    const missing = this.ctx.review.missingNotes(file);
    this.paintHead(file);
    /**
     * **文件读不动时不画空态**（独立审 2026-10-10 🟡 → 见 `ReviewRefusedError`）：
     * 那种时候"没有卡片"是假的（真实情况是**读不出来**），照空态画会让人以为卡丢了、
     * 甚至去建新卡（而写是被拒的）。明写原因 + 一行"怎么办"。
     */
    if (res.broken) {
      this.paintBroken(res.broken);
      return;
    }
    this.paintList(file, missing);
  }

  private paintBroken(reason: string): void {
    this.listHost.replaceChildren();
    this.listHost.appendChild(
      div({
        cls: 'kbw-review-broken',
        text: `读不出来：${reason}。这次不动它（怕把你的卡片覆盖掉）—— 先看看那个文件是不是手改坏了、或同步写了一半；修好后切走再切回来即可。`,
      }),
    );
  }

  private paintHead(file: ReviewFile): void {
    this.headHost.replaceChildren();
    const due = dueCards(file.cards, Date.now()).length;
    this.headHost.appendChild(
      div({
        cls: 'kbw-review-title',
        text: file.cards.length === 0 ? '回顾' : `全部卡片 ${file.cards.length} 张`,
      }),
    );
    if (file.cards.length > 0) {
      this.headHost.appendChild(
        div({
          cls: ['kbw-review-due', due > 0 ? 'is-due' : null],
          text: due > 0 ? `今日待复习 ${due} 张` : '今天没有到期的卡',
        }),
      );
      /**
       * **开始复习**（P8 期 3）：没到期就**置灰 + 写明原因**（仓里口径：别画一个点了没反应的按钮）。
       */
      const startBtn = btn({
        cls: 'kbw-btn is-primary is-small kbw-review-start',
        text: due > 0 ? `开始复习 ${due} 张` : '开始复习',
        attr: { title: due > 0 ? '今天到期的都在这一轮里（空格翻面）' : '今天没有到期的卡' },
        on: { click: () => void this.startSession() },
      });
      if (due === 0) {
        startBtn.toggleAttribute('disabled', true);
        startBtn.setAttribute('aria-disabled', 'true');
      }
      this.headHost.appendChild(startBtn);
      /**
       * **从笔记生成**（P8 期 4，面板三块的第三块）：挑一篇 → AI 出稿 → 可改可删 → 确认流 → 入库。
       * 挑选用 `ui/prompt.ts` 的 `pickOne`（自带搜索，全库笔记也能挑）；
       * 未配 AI / 保护目录在 `runReviewGen` 里拦并说明原因（与起标题、美化同一道闸）。
       */
      this.headHost.appendChild(
        btn({
          cls: 'kbw-btn is-small kbw-review-gen',
          text: '从笔记生成',
          attr: { title: '挑一篇笔记，让 AI 出几张回顾卡（出稿后可改可删，入库前还会再确认一次）' },
          on: { click: () => void this.pickAndGenerate() },
        }),
      );
      /** 今日 / 全部两档（期 3 的今日筛选）—— 有卡才给开关 */
      this.paintScope(file.cards);
    }
    /** 卡片存哪儿：明写在屏上（它是库内文件，用户能自己打开看/备份/改） */
    this.headHost.appendChild(
      div({ cls: 'kbw-review-path', text: `库内文件：${this.ctx.review.displayPath()}` }),
    );
  }

  /**
   * **今日筛选**（P8 期 3）：今日到期 / 全部卡片。
   * 「今日」是这一栏的默认档 —— 打开它就是想知道"现在该做什么"；「全部」是回头看与整理。
   */
  private paintScope(cards: ReviewCard[]): void {
    const seg = div({ cls: 'kbw-seg kbw-review-scope' });
    const due = dueCards(cards, Date.now()).length;
    const opts: { value: ReviewScope; label: string }[] = [
      { value: 'due', label: `今日 ${due}` },
      { value: 'all', label: `全部 ${cards.length}` },
    ];
    for (const o of opts) {
      seg.appendChild(
        btn({
          cls: ['kbw-segbtn', this.scope === o.value ? 'is-on' : null],
          text: o.label,
          on: {
            click: () => {
              this.scope = o.value;
              void this.render();
            },
          },
        }),
      );
    }
    this.headHost.appendChild(seg);
  }

  private paintList(file: ReviewFile, missing: Set<string>): void {
    this.listHost.replaceChildren();

    if (file.cards.length === 0) {
      /**
       * 空态给**能用的**动作，不给死按钮。
       * ⚠️ 这儿**必须是「从笔记生成」**（P8 期 4 起）：一张卡都没有时，头部那两枚
       *（开始复习 / 从笔记生成）**都不画**（它们挂在"有卡"那一支里）—— 空态是**唯一**入口，
       * 指向「全部笔记」等于让用户自己去猜右键菜单里有什么。
       * 手动那条路（右键 → 生成回顾卡）写在说明里，够得着但不占主位。
       */
      this.listHost.appendChild(
        emptyState({
          kind: 'review',
          desc: '卡片从笔记派生：点「从笔记生成」让 AI 出几张初稿（可改可删）；也可以在「全部笔记」里右键一篇 → 「生成回顾卡」手写。',
          action: { label: '从笔记生成', run: () => void this.pickAndGenerate() },
        }),
      );
      return;
    }

    const now = Date.now();
    if (this.scope === 'due') {
      const due = dueCards(file.cards, now);
      if (due.length === 0) {
        /**
         * 「今日」档但今天没到期 —— 别画"空态"（那会让人以为卡丢了）。
         * 明写"今天没有到期的卡" + **下一次什么时候**，并且给个"看全部"的出口。
         */
        const next = file.cards.reduce((min, c) => Math.min(min, c.nextReview), Number.POSITIVE_INFINITY);
        this.listHost.appendChild(
          div({
            cls: 'kbw-review-today-empty',
            /**
             * ⚠️ 这里**必须**用 `formatDueTime`（未来向）—— 用 `formatRelativeTime`（过去向）
             * 会恒显示「刚刚」（它算 `now - ts`，负数恒小于 45 秒阈值）：独立审抓的真 bug。
             */
            text: `今天没有到期的卡。下一次到期：${Number.isFinite(next) ? formatDueTime(next) : '—'}`,
          }),
        );
        this.listHost.appendChild(
          div(
            { cls: 'kbw-review-today-act' },
            btn({
              cls: 'kbw-btn is-small',
              text: '看全部卡片',
              on: {
                click: () => {
                  this.scope = 'all';
                  void this.render();
                },
              },
            }),
          ),
        );
        return;
      }
      // 「今日」档全是到期的 —— 标"下次什么时候"是废话，不标
      for (const card of due) this.listHost.appendChild(this.cardRow(card, missing.has(card.note), false));
      return;
    }

    for (const card of file.cards) {
      // 「全部」档要标下次什么时候（回头看与整理时最想知道的就是这一件）
      this.listHost.appendChild(this.cardRow(card, missing.has(card.note), true));
    }
  }

  /**
   * **挑一篇笔记 → 生成**（P8 期 4，面板第三块「从笔记生成」）。
   * 挑选用 `ui/prompt.ts` 的 `pickOne`（自带搜索）；挑完交给 `runReviewGen`：
   * 出稿 → 面板（可改可删）→ 确认流 → 入库。
   * "不在库里 / 保护目录 / 没配 AI"三种都由那条链自己报原因 —— 这里不做第二份判断。
   */
  private async pickAndGenerate(): Promise<void> {
    const notes = this.ctx.index.notes();
    if (notes.length === 0) {
      notifyLight('库里还没有笔记', '先写一篇再来生成');
      return;
    }
    const picked = await pickOne<NoteEntry>({
      title: '从哪一篇生成回顾卡？',
      sub: 'AI 会读那一篇的正文，出几张问答卡给你过目',
      items: notes,
      label: (e) => e.basename,
      detail: (e) => e.effectivePosition || '（库根）',
      searchOf: (e) => `${e.basename} ${e.path}`,
      placeholder: '搜标题或路径…',
      empty: '没匹配的笔记',
    });
    if (!picked) return;
    const f = this.ctx.app.vault.getAbstractFileByPath(picked.path);
    if (!(f instanceof TFile)) {
      notifyError('这篇不在库里了', '刷新一下再看');
      return;
    }
    await runReviewGen(this.ctx, f);
    await this.render();
  }

  /** 开一轮复习：队列 = **今日到期**（与当前筛选档无关 —— "开始复习"说的就是今天那些） */  private async startSession(): Promise<void> {
    if (this.session) return; // 浮层已经开着（按钮在浮层底下，防连点）
    const file = await this.ctx.review.load();
    const queue = dueCards(file.cards, Date.now());
    if (queue.length === 0) return;
    const h = openReviewSession(this.ctx, queue);
    this.session = h;
    const tally = await h.closed;
    this.session = null;
    if (tally.total > 0) notifyLight(`本轮复习结束（${tally.total} 张）`, tallyText(tally));
    await this.render();
  }

  private cardRow(card: ReviewCard, sourceMissing: boolean, showWhen: boolean): HTMLElement {
    const row = div({ cls: 'kbw-review-row' });
    const main = div({ cls: 'kbw-review-row-main' });
    main.appendChild(div({ cls: 'kbw-review-q', text: card.front }));
    main.appendChild(div({ cls: 'kbw-review-a', text: card.back }));
    row.appendChild(main);

    const side = div({ cls: 'kbw-review-row-side' });
    /**
     * 「全部」档里每张卡都标一下**下次什么时候来**（「今日」档里全是到期的，标了是废话）。
     * ⚠️ 两个坑（独立审 2026-10-10 抓的）：① 文案要用**未来向**的 `formatDueTime`
     *（`formatRelativeTime` 对未来时间戳恒返回「刚刚」）② "算不算今天到期"要**按天比**
     *（与 `dueCards` 同一粒度 —— 拿时间戳比会把"今天 08:00 到期、现在 07:00"判成不是今天）。
     */
    if (showWhen) {
      const dueToday = startOfDay(card.nextReview) <= startOfDay(Date.now());
      side.appendChild(
        span({
          cls: ['kbw-review-when', dueToday ? 'is-due' : null],
          text: dueToday ? '今日到期' : formatDueTime(card.nextReview),
        }),
      );
    }
    if (sourceMissing) {
      // 来源没了（迁键漏了？用户手删了？）—— 明写出来，别画一张点不开就当没事
      side.appendChild(span({ cls: 'kbw-review-src is-missing', text: '来源已不在' }));
    } else {
      const src = btn({
        cls: 'kbw-review-src kbw-hover-1',
        text: noteLabel(card.note),
        attr: { title: `${card.note}\n点击：打开这篇（看板模块开着时开小窗，否则新标签页）` },
      });
      src.addEventListener('click', () => this.openNote(card.note));
      side.appendChild(src);
    }
    side.appendChild(
      btn({
        cls: 'kbw-btn is-small kbw-review-del',
        text: '删除',
        attr: { title: '删掉这张卡（来源笔记不动）' },
        on: { click: () => void this.remove(card) },
      }),
    );
    row.appendChild(side);
    return row;
  }

  /** 打开来源笔记：与首页「最近改动」同一套退路（小窗是看板域的能力，关着就退标签页） */
  private openNote(path: string): void {
    if (this.ctx.openNoteWindow?.(path)) return;
    const f = this.ctx.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.ctx.app.workspace.getLeaf('tab').openFile(f);
  }

  private async remove(card: ReviewCard): Promise<void> {
    const res = await confirm({
      title: `即将删除「${noteLabel(card.note)}」上的一张回顾卡`,
      preview: [{ kind: 'delete', where: '库内「复习」那张表', count: 1 }],
      warnings: [],
      notes: ['只改库内那张表；来源笔记一个字节都不动。'],
      /** 不动笔记 → 那句默认的"执行前会自动快照"在这儿是假话，换掉 */
      snapshot: '（只改库内那张表，不碰笔记，不拍快照）',
      danger: { confirmLabel: '再点一次删除' },
      primary: { label: '删除这张卡' },
      attach: (host) => {
        const box = div({ cls: 'kbw-review-preview' });
        const line = (label: string, text: string) => {
          const r = div({ cls: 'kbw-review-preview-row' });
          r.appendChild(span({ cls: 'kbw-review-preview-tag', text: label }));
          r.appendChild(div({ cls: 'kbw-review-preview-txt', text }));
          box.appendChild(r);
        };
        line('正面', card.front);
        line('背面', card.back);
        host.appendChild(box);
      },
    });
    if (res.action !== 'primary') return;
    try {
      const ok = await this.ctx.review.removeCard(card.id);
      if (ok) notifyInfo('已删除 1 张回顾卡', noteLabel(card.note));
      else notifyError('没删掉', '这张卡可能已经在别处被删了');
    } catch (e) {
      // 与建卡同一条账：文件读不动时 store 拒绝写，把原因照实报出来
      notifyError('没删掉', e instanceof Error ? e.message : String(e));
    }
  }
}
