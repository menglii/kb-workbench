/**
 * ui/suggest-panel.ts —— **整理建议面板**（P7.6 · 11.1；P7.11 · #12 选择题重构）
 *
 * ## 形态（P7.11 · #12 批注定稿；效果稿 = `用户反馈批3-整改方案-2026-10-05.html` F 节）
 *
 * 顶部（范围 seg 之下）**四选一**：A 搬笔记 / B YAML 头 / C 结尾双链 / D 我全都要；
 * 选完 → 下方出**该类待办清单**（□ 行、默认全勾）；底部两个动作：
 *   · **自己去整理** —— 打开对应的现成工作面（**不动库**）；
 *   · **AI 自动去做** —— 为该类跑 AI 分支 → 勾选 → **确认流** → 照旧写盘链
 *     （A 搬 / B 补领域 / C 挂链·补尾链；A/C 执行完可一键撤销；**不新写盘路径**）。
 *
 * 类 → 来源/动作（Q9/Q10 拍板 + P7.12 · v2 改口径）：
 *   · **A 搬笔记**：现「要搬的」那套（规则 / 学过往 / AI 分类）；自己 = 跳「全部笔记」；
 *     AI = 现 `classify`（给搬不动的补落点）。
 *   · **B YAML 头**：**没写「文件位置」声明的笔记**（v2：领域退役后，"缺领域"换成
 *     "缺落点声明"—— 与 `proposeLocus` 候选同一份判据）＋「旧规范」
 *     （`previewMigration().changes`）；自己 = 补全 / 属性迁移面板；AI = **AI 补声明**
 *     （`proposeLocus` → 确认流 → `fm.set` 写「文件位置」；**不搬** —— 归位是既有链的事）。
 *     ⚠️ 「旧规范」行**没有复选框**（它的写入链在属性迁移面板里，这条链不动它）——
 *     行尾写明去处，别让它"勾了却没执行"。
 *     ⚠️ #10 口径（2026-10-06 拍定）：AI 没给出值的行**置灰 + 行尾「AI 未出值」**，
 *     界面不再"邀请你勾一件做不了的事"；红字横幅上挂「一键清空此类…」（全库扫无正文
 *     → 预览 → 回收站）。
 *   · **C 结尾双链**：「挂《知识地图》」＋「补『## 关联笔记』尾链段」**合一**（Q10）；
 *     自己 = 打开《知识地图》/ 补全面板；AI = 现 `classifyMoc`（选节）＋尾链走
 *     `CompletionService.fillFile`（与「一键补全存量」同一条只加不删链）。
 *   · **D 我全都要**：三类全列；两个动作按**当前勾选**分派。
 *
 * P7.10 的两段段头（「要搬的 · N 篇 / 要挂链的 · N 篇」）被选择题取代（清单内不再画段头）。
 *
 * ## 纪律（沿用）
 *
 *  · **形状与预检全在 `services/suggest.ts`**（这一层只画 + 勾 + 调执行）；
 *    B/C 两个新来源**只现算、不另立判据**（缺声明走 `declaredPositions`、旧规范走
 *    `previewMigration`、尾链走 `planBackfillOf` 的现成判定）。
 *  · **一次确认 → 多条链按序跑**：搬 / 挂 / 补声明 / 补尾链各是既有写盘链；
 *    撤销条同一时刻只有一条 —— 多链同跑时**留最后一条**（move 排最后），
 *    各链的快照都在，可从快照面板还原（旧口径"搬与挂分开跑"的扩写）。
 *  · **看不见的行不许被执行**：执行只认当前视图里的行 + 各类显示上限画出来的行。
 *  · 未配 AI 点「AI 自动去做」→ **轻提示 + 不执行**（2026-10-06 用户拍板；
 *    与行内 ✦ 的降级同一条：`AI_NOT_CONFIGURED` 一句话，按钮照画不 disabled）。
 *  · **安全例外**：出错 / 未配置出一行红字（`.is-bad`）—— 不许静默（§11 口径）。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { joinPath, parentDir, relativeTo } from '../core/paths';
import { markSelfWrite } from '../core/writes';
import { declaredPositions } from '../services/schema';
import { previewMigration } from '../services/migrate';
import { planBackfillOf } from '../services/backfill';
import {
  aiPlanRaw,
  finalize,
  generateLocal,
  insertMocBullet,
  INBOX_DIR,
  linkPairs,
  mocAiRaw,
  mocBulletOf,
  type DroppedItem,
  type LinkPair,
  type LocalSuggestions,
  type RawSuggestion,
  type SuggestDeps,
  type SuggestItem,
  type SuggestSource,
} from '../services/suggest';
import { writeDeclaredForMoved } from '../services/rebuild';
import { AiError, isAiProtected, usageLineFor } from '../services/ai';
import { btn, div, el, icon, iconBtn, span } from './primitives';
import { openModal, type PanelHandle } from './panel';
import { confirm, type PipeSettle, type PlanRow } from './confirm';
import { runClearEmpty as runClearEmptyFlow } from './clear-empty';
import { showMenu } from './menu';
import { topUpTails } from './organize';
import { restoreOrNotify, showUndo } from './undo-bar';
import { openBackfillPanel } from './backfill-panel';
import { openMigratePanel } from './migrate-panel';
import { NOTIFY_MS, notify, notifyError, notifyLight } from './notify';

const MOC_ROW_CAP = 20;
/** B/C 三个新清单的显示上限（看不见的行不进执行集 —— 与 MOC 同一条护栏） */
const TODO_ROW_CAP = 20;

/**
 * 「还没配 AI」那句话 —— **唯一出处**：面板内的闸（`aiCfg`）、首页待处理行的
 * ✦ 降级（`blocks/todo.ts`）、「AI 起标题」面板都引这一份，别各写各的。
 */
export const AI_NOT_CONFIGURED = '还没配置 AI（设置 → AI 助手 里填 key）';

/** 四个类 */
type Cls = 'A' | 'B' | 'C' | 'D';
/** 清单行的种类（move/moc 走既有 SuggestItem；其余三种是本轮的现算来源） */
type PRowKind = 'move' | 'moc' | 'locus' | 'tail' | 'migrate';

/** 面板自己的一行（move/moc 由 SuggestItem 扩展而来；locus/tail/migrate 现算） */
interface PRow {
  id: string;
  kind: PRowKind;
  /** 建议来源（规 / 学 / AI）；现算类（locus/tail/migrate）为 null、不画徽标 */
  source: SuggestSource | null;
  /** 相关笔记（**相对库根**） */
  path: string;
  /** move=落点目录 · moc=节名 · locus=提议的落点目录（'' = 还没有值）· tail/migrate='' */
  to: string;
  why: string;
  evidence?: string;
  locked?: boolean;
  /** 仅 moc：目标页（相对库根） */
  page?: string;
}

/**
 * @param opts.scope   初始范围（'' = 全库）
 * @param opts.autoAi  开面板后**自动落 A 类（搬笔记）的 AI 那一跳**（P7.8：首页待处理的
 *                     ✦ 点进来；只跑**第一次**本地算完之后那一次 —— 切范围不重跑）
 * @param opts.autoRun **P7.24 · L2（服务族升级）**：再进一步 —— 连**跑到确认卡**停住。
 *                     走的就是面板自己的 `runAuto`（"AI 自动去做"那颗按钮的同一份实现），
 *                     用户点执行/取消后经 `onSettled` 把结算回传（`PipeSettle`）。
 *                     `offstage` = **幕后模式**：面板只挂不显示（用户只看见确认卡），
 *                     结算后自关 —— agent 把"出提案"整条跑完、确认权留在人手里。
 */
export function openSuggestPanel(
  ctx: WorkbenchContext,
  opts: {
    scope?: string;
    autoAi?: boolean;
    autoRun?: { cls?: Cls; offstage?: boolean; onSettled?: (r: PipeSettle) => void };
  } = {},
): PanelHandle {
  const h = openModal({
    title: '整理建议',
    // P7.9 · ⑥ 有意识收紧：**副标题整句删除**（面板内零说明文字）
    width: 'wide',
    // P7.24 · L2 幕后（见 opts.autoRun）：只挂不显示 + 不压 Esc 层 —— 统一走 openModal 的选项
    hidden: opts.autoRun?.offstage === true,
  });

  // ── 状态 ──────────────────────────────────────────────────────
  let scope = opts.scope ?? INBOX_DIR;
  /** ✦ 进来的一次性自动 AI 跳（见 opts.autoAi 注释） */
  let autoAiPending = opts.autoAi === true;
  /** P7.24 · L2：一次性的"连跑到确认卡"（tool 入口传的；跑过就消） */
  const pendingRun = opts.autoRun ?? null;
  let autoRunPending = pendingRun != null;
  /** 当前选中的类（P7.11 · #12：默认 A —— 搬笔记是主路径，✦ 自动跳的也是它） */
  let clsSel: Cls = 'A';
  const sources = { rule: true, learned: true };
  let local: LocalSuggestions | null = null;
  let aiMove: { items: RawSuggestion[]; dropped: DroppedItem[] } | null = null;
  let aiMoc: { items: RawSuggestion[]; dropped: DroppedItem[] } | null = null;
  let pairs: LinkPair[] = [];
  /** 「AI 补声明」这一轮跑过了吗（#10：跑过之后没值的行画「AI 未出值」） */
  let locusAsked = false;
  /** 这一轮 AI 连一篇都没给出值（横幅上的「一键清空此类…」按钮据此改文案） */
  let locusNoValue = 0;
  /**
   * AI 的**结果计数与用量**（P7.9 · ⑥）：不占行，进「AI 自动去做」的悬停 title
   *（"上次：提 N / 拦 M · 用量 …"）。
   */
  let aiStats = '';
  /** AI 的**出错 / 未配置**（安全例外：这行必须可见 —— §11 不静默） */
  let aiErr = '';
  let busy: '' | 'local' | 'ai' | 'moc-ai' | 'area-ai' | 'run' | 'clear' = '';
  let failed = '';
  /** 「关联提示 · N 对」折叠行开着吗（它是开关，不是说明） */
  let pairsOpen = false;
  const checked = new Set<string>();
  /**
   * **见过面的 id**：只对**从没见过**的 id 默认勾选 —— 否则用户刚取消的那几条会被
   * 静默重新勾上，一次确认把排除掉的也执行了（独立审查 🟡1 的老口径，本轮扩到五种行）。
   */
  const everSeen = new Set<string>();
  let composed: { items: SuggestItem[]; dropped: DroppedItem[] } = { items: [], dropped: [] };
  /** MOC 段**画出来的**那些 id（🟡2：超出显示上限的行不进执行集 —— 看不见的不许被执行） */
  let mocVisible = new Set<string>();
  /**
   * B/C 三个现算来源（**懒算**：选中那一类才算；`null` = 还没算过）。
   * `locusRowsAll` 的行对象是**活的**（AI 补声明回来后就地填 `to`），别整批替换。
   */
  let locusRowsAll: PRow[] | null = null;
  let migrateRowsAll: PRow[] | null = null;
  let tailRowsAll: PRow[] | null = null;
  /** 「旧规范」里整篇跳过（值会被写坏、得人工看）的篇数 —— 只报数（写明去处） */
  let migrateBlockedN = 0;
  /** AI 补声明回来后：rel → 提议的落点目录 */
  let aiLocus: Map<string, string> | null = null;

  const body = h.body;
  body.classList.add('kbw-suggest');
  const head = div({ cls: 'kbw-suggest-head' });
  const listHost = div({ cls: 'kbw-suggest-list' });
  body.appendChild(head);
  body.appendChild(listHost);

  const deps: SuggestDeps = { app: ctx.app, settings: ctx.settings, index: ctx.index };
  const kbRootOf = (): string => ctx.settings.kbRoot();
  const aiCfg = (): { ok: boolean; why: string } => {
    if (!ctx.ai.isConfigured()) return { ok: false, why: AI_NOT_CONFIGURED };
    return { ok: true, why: '' };
  };

  // ── 合成（勾选/开关一变就重跑 —— 预检永远是同一份）────────────
  function compose(): void {
    if (!local) {
      composed = { items: [], dropped: [] };
      return;
    }
    const raws: RawSuggestion[] = [
      ...(sources.rule ? local.moveItems : []),
      ...(sources.learned ? local.learnedItems : []),
      ...(sources.rule ? local.mocItems : []),
      ...(aiMove?.items ?? []),
      ...(aiMoc?.items ?? []),
    ];
    composed = finalize(raws, local.pctx);
    /**
     * 勾选态跟着会话走（切范围再切回来，用户取消过的仍然是取消）——
     * "没见过才默认勾"的落点在 `markSeen()`（渲染那一刻，五种行统一）。
     */
  }

  /** 渲染前把这一批行的"没见过 → 默认勾"记账（唯一的自动勾选点） */
  function markSeen(rows: PRow[]): void {
    for (const r of rows) {
      if (everSeen.has(r.id)) continue;
      everSeen.add(r.id);
      checked.add(r.id);
    }
  }

  async function refreshLocal(): Promise<void> {
    busy = 'local';
    failed = '';
    render();
    try {
      const exclude = (await ctx.automation.get()).reconcile.exclude;
      local = await generateLocal(deps, { scope, exclude, stats: ctx.settings.get().moveStats });
      pairs = linkPairs(deps, exclude);
      compose();
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    busy = '';
    render();
    /**
     * 刷新之后：当前类若在看 B/C（现算清单），把懒算数据补上再画一遍
     *（刷新按钮已把三个缓存清了 —— 不补的话清单会空着，像"没活了"）。
     */
    if (clsSel !== 'A') {
      void ensureClassData(clsSel).then(() => render());
    }
    /**
     * ✦ 进来的一次性自动 AI 跳：**第一次**本地算完才跑（算不出来就不跑 ——
     * `runAiClassify` 自己对 `local` 有闸）。只消一次，切范围/刷新都不再自动调模型。
     */
    if (autoAiPending && local) {
      autoAiPending = false;
      // P7.24 · L2：AI 跳跑完（无论成败）再接着连跑到确认卡 —— 顺序不能反（triage 语义）；
      // ⚠️ 传 skipClassify（独立审 🔴1）：classify 刚跑过，runAuto 里别再跑第二遍
      void runAiClassify().finally(() => void maybeAutoRun(true));
    } else {
      void maybeAutoRun();
    }
  }

  /**
   * **P7.24 · L2**：连跑到确认卡（见 `opts.autoRun`）—— 跑的就是 `runAuto`
   *（"AI 自动去做"那颗按钮的同一份实现）；结束后**先关幕后面板、再回传结算**
   *（结算要把"库已动完/没动"如实带回去）。
   */
  async function maybeAutoRun(skipClassify = false): Promise<void> {
    if (!autoRunPending || !pendingRun) return;
    autoRunPending = false;
    let r: PipeSettle;
    try {
      r = await runAuto((pendingRun.cls ?? 'A') as Cls, { skipClassify });
    } catch (e) {
      /**
       * 🟡4（独立审）：链上任何一处意外抛出 —— 第一版**没人接**，settle 永不来、
       * tool 永挂（AI 面板停在"在飞"、幕后面板留在 DOM）。兜成如实结算，别悬着。
       */
      r = { action: 'blocked', summary: `没跑成（意外错误）：${e instanceof Error ? e.message : String(e)}` };
    }
    if (pendingRun.offstage) h.close('autorun');
    pendingRun.onSettled?.(r);
  }

  // ── B/C 两个现算来源（懒算）──────────────────────────────────
  async function ensureClassData(cls: Cls): Promise<void> {
    const kinds = kindsOf(cls);
    if (kinds.includes('locus') && locusRowsAll === null) {
      const kbRoot = kbRootOf();
      const protectedAbs = ctx.ai.protectedDir();
      const metaPrefix = `${ctx.settings.get().metaDir.replace(/^\/+|\/+$/g, '')}/`;
      const rels = ctx.index
        .notes()
        .filter((e) => {
          if (e.isTemplate) return false;
          if (isAiProtected(e.path, protectedAbs)) return false;
          const rel = relativeTo(e.path, kbRoot);
          if (!rel || rel === e.path) return false;
          if (rel.startsWith(metaPrefix)) return false;
          return declaredPositions(e.props).length === 0;
        })
        .sort((a, b) => b.mtime - a.mtime);
      locusRowsAll = rels.map((e) => {
        const rel = relativeTo(e.path, kbRoot);
        return {
          id: `locus:${rel}`,
          kind: 'locus' as const,
          source: null, // 值还没提出来；AI 回来后填
          path: rel,
          to: '',
          why: '缺「文件位置」',
        };
      });
      // 旧规范（与「缺声明」同一趟算 —— 它俩都是 B 类的来源）
      try {
        const plan = await previewMigration(ctx.app.vault, ctx.index.getAll(), {
          kbRoot,
        });
        migrateBlockedN = plan.blocked.length;
        migrateRowsAll = plan.changes.map((item) => ({
          id: `migrate:${item.rel}`,
          kind: 'migrate' as const,
          source: null,
          path: item.rel,
          to: '',
          why: item.summary,
        }));
      } catch (e) {
        migrateRowsAll = [];
        failed = e instanceof Error ? e.message : String(e);
      }
    }
    if (kinds.includes('tail') && tailRowsAll === null) {
      try {
        const plan = await planBackfillOf(ctx);
        tailRowsAll = plan.items
          .filter((it) => it.tail)
          .map((it) => ({
            id: `tail:${it.rel}`,
            kind: 'tail' as const,
            source: null,
            path: it.rel,
            to: '',
            why: it.kind === 'template' ? '空白笔记：套整套模板（含尾链）' : '缺「## 关联笔记」段',
          }));
      } catch (e) {
        tailRowsAll = [];
        failed = e instanceof Error ? e.message : String(e);
      }
    }
  }

  // ── AI 三跳（各自被「AI 自动去做」按类拉起；用量与计数进按钮悬停 title）──
  async function runAiClassify(): Promise<void> {
    if (!local || busy !== '') return;
    const gate = aiCfg();
    if (!gate.ok) {
      aiErr = gate.why;
      render();
      return;
    }
    busy = 'ai';
    aiErr = '';
    render();
    try {
      /**
       * ⚠️ **问与换算用同一个范围**（独立审 🟡1）：`scope` 是活的（分段按钮随时能切），
       * 而 classify 在飞的时候用户可能已经切了范围 —— 换算口径要跟"当初问的那个"走。
       */
      const reqScope = scope;
      const res = await ctx.ai.classify({
        scopeRel: reqScope,
        exclude: local.pctx.exclude,
      });
      const converted = aiPlanRaw(res.plan, {
        scope: reqScope,
        dirRelOf: (rel) => ctx.index.get(joinPath(kbRootOf(), rel))?.effectivePosition,
      });
      aiMove = converted;
      const cfg = ctx.settings.get().ai;
      const bits: string[] = [`提了 ${res.proposed} 条`];
      if (res.plan.blocked.length > 0) bits.push(`拦下 ${res.plan.blocked.length} 条`);
      if (res.dropped > 0) bits.push(`丢弃 ${res.dropped} 条（形状不对）`);
      if (res.usage) bits.push(usageLineFor(cfg, 'classify', res.usage));
      aiStats = bits.join(' · ');
      if (res.kind === 'chat' && res.reply.trim() !== '') aiErr = `AI：${res.reply.trim()}（没有给建议）`;
      compose();
    } catch (e) {
      aiErr = e instanceof AiError ? `AI 出错：${e.hint}` : `AI 出错：${e instanceof Error ? e.message : String(e)}`;
    }
    busy = '';
    render();
  }

  async function runAiMoc(): Promise<void> {
    if (!local?.moc || busy !== '') return;
    const gate = aiCfg();
    if (!gate.ok) {
      aiErr = gate.why;
      render();
      return;
    }
    busy = 'moc-ai';
    aiErr = '';
    render();
    try {
      const res = await ctx.ai.classifyMoc({
        sections: local.moc.sections,
        candidates: local.moc.candidates.map((c) => ({ path: c.abs, basename: c.basename })),
      });
      aiMoc = { items: mocAiRaw(res.ideas, local.moc.page), dropped: [] };
      const cfg = ctx.settings.get().ai;
      const bits: string[] = [`挑了 ${res.ideas.length} 条`];
      if (res.dropped > 0) bits.push(`丢弃 ${res.dropped} 条`);
      if (res.usage) bits.push(usageLineFor(cfg, 'moc', res.usage));
      aiStats = bits.join(' · ');
      if (res.ideas.length === 0 && res.reply.trim() !== '') aiErr = `AI：${res.reply.trim()}`;
      compose();
    } catch (e) {
      aiErr = e instanceof AiError ? `AI 出错：${e.hint}` : `AI 出错：${e instanceof Error ? e.message : String(e)}`;
    }
    busy = '';
    render();
  }

  /** AI 补声明（v2：给缺「文件位置」的笔记提落点）—— 产物只填进清单行的 `to`，写盘在确认流之后 */
  async function runAiLocus(): Promise<void> {
    if (busy !== '' || locusRowsAll === null) return;
    /**
     * 新一轮起算（P7.13a · #5b）：**放在闸前** —— 没配 AI（闸没过）时这一轮根本没跑，
     * 不该把上一轮的数带进 `runAuto` 的"跑完自动弹"（独立审 🟢7）。
     */
    locusNoValue = 0;
    const gate = aiCfg();
    if (!gate.ok) {
      aiErr = gate.why;
      render();
      return;
    }
    busy = 'area-ai';
    aiErr = '';
    render();
    try {
      const res = await ctx.ai.proposeLocus({});
      aiLocus = new Map(res.items.map((it) => [it.rel, it.to]));
      for (const row of locusRowsAll) {
        const v = aiLocus.get(row.path);
        if (v !== undefined) {
          row.to = v;
          row.source = 'ai'; // 值来自 AI —— 徽标跟着值走
        }
      }
      locusAsked = true;
      locusNoValue = Math.max(0, res.fed.length - res.items.length);
      const cfg = ctx.settings.get().ai;
      const bits: string[] = [`补了 ${res.items.length} 篇`];
      if (res.fed.length > res.items.length) {
        bits.push(`${res.fed.length - res.items.length} 篇没把握（没给）`);
      }
      if (res.dropped > 0) bits.push(`丢弃 ${res.dropped} 条（目录清单外 / 形状不对）`);
      if (res.usage) bits.push(usageLineFor(cfg, 'locus', res.usage));
      aiStats = bits.join(' · ');
      /**
       * #10 拍定：AI 没给出值的行 → 横幅（红字）说清 + 挂「一键清空此类…」。
       * 用 AI 自己那句话（"读不到有效正文…"）优先，没有就写一句通用的。
       */
      if (locusNoValue > 0) {
        aiErr = `AI：${res.reply.trim() !== '' ? res.reply.trim() : `${locusNoValue} 篇没给出落点`}`;
      }
    } catch (e) {
      aiErr = e instanceof AiError ? `AI 出错：${e.hint}` : `AI 出错：${e instanceof Error ? e.message : String(e)}`;
    }
    busy = '';
    render();
  }

  /**
   * **「一键清空此类…」**（#10 ②，2026-10-06 拍定）：**全库**扫「剥掉前言与尾链后没有正文」
   * 的笔记（不限本批、不限收件箱）→ 二次确认（预览 + 篇数）→ 回收站（`mover.trash`，
   * 走快照 + 日志的既有链）。
   *
   * P7.13b：流本身抽去了 `ui/clear-empty.ts`（首页待处理的 ① 空文件行动作同用一份，
   * `source` 各传各的）；这里只剩**面板自己的 busy 簿记** —— 行为一字未改。
   */
  async function runClearEmpty(): Promise<void> {
    if (busy !== '') return;
    busy = 'clear';
    render();
    try {
      await runClearEmptyFlow(ctx);
    } finally {
      busy = '';
      render();
    }
  }

  // ── 行的组装 ─────────────────────────────────────────────────
  /** 这一个类看清单里的哪几种行（D = 全部） */
  function kindsOf(cls: Cls): PRowKind[] {
    if (cls === 'A') return ['move'];
    if (cls === 'B') return ['locus', 'migrate'];
    if (cls === 'C') return ['moc', 'tail'];
    return ['move', 'locus', 'migrate', 'moc', 'tail'];
  }

  /**
   * 当前视图的行（按类序 A→B→C）。⚠️ 执行/勾选只认它 ——
   * **只出当前类**（"选 A 只出 A 类行、D 三类齐"），**看不见的行不许被执行**
   * （所以上限在**这里**做，渲染与执行共用同一份截断）。
   * 溢出提示放 `overflowNote`（渲染时一行小字说出来）。
   */
  let overflowNote = '';
  function rowsOf(cls: Cls): PRow[] {
    const kinds = kindsOf(cls);
    const out: PRow[] = [];
    const over: string[] = [];
    if (kinds.includes('move')) {
      const moves = composed.items
        .filter((i) => i.kind === 'move')
        .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.path < b.path ? -1 : 1));
      for (const it of moves) out.push({ ...it, kind: 'move', source: it.source });
    }
    if (kinds.includes('locus')) {
      const all = locusRowsAll ?? [];
      out.push(...all.slice(0, TODO_ROW_CAP));
      if (all.length > TODO_ROW_CAP) over.push(`另有 ${all.length - TODO_ROW_CAP} 篇缺「文件位置」`);
    }
    if (kinds.includes('migrate')) {
      const all = migrateRowsAll ?? [];
      out.push(...all.slice(0, TODO_ROW_CAP));
      if (all.length > TODO_ROW_CAP) over.push(`另有 ${all.length - TODO_ROW_CAP} 篇旧规范`);
    }
    if (kinds.includes('moc')) {
      const mocAll = composed.items.filter((i) => i.kind === 'moc');
      const shown = mocAll.slice(0, MOC_ROW_CAP);
      mocVisible = new Set(shown.map((i) => i.id));
      out.push(...shown.map((it) => ({ ...it, kind: 'moc' as const, source: it.source })));
      if (mocAll.length > MOC_ROW_CAP) over.push(`另有 ${mocAll.length - MOC_ROW_CAP} 篇要挂链`);
    }
    if (kinds.includes('tail')) {
      const all = tailRowsAll ?? [];
      out.push(...all.slice(0, TODO_ROW_CAP));
      if (all.length > TODO_ROW_CAP) over.push(`另有 ${all.length - TODO_ROW_CAP} 篇缺尾链`);
    }
    overflowNote = over.length > 0 ? `${over.join('；')}（做完这批刷新就能看到）` : '';
    return out;
  }

  /** 这一行能不能被执行（migrate 行没有复选框；locus 行要有值 —— #10：没值置灰） */
  function executable(row: PRow): boolean {
    if (row.kind === 'migrate') return false;
    if (row.kind === 'locus') return row.to !== '';
    if (row.kind === 'moc') return mocVisible.has(row.id);
    return true;
  }

  // ── 两个动作 ─────────────────────────────────────────────────
  /**
   * 「AI 自动去做」：为本类（D = 有勾选的那些类）跑 AI 分支 →
   * 勾选项 → 一次确认 → 按链执行（**不新写盘路径**）。
   * 未配 AI：轻提示 + 不执行（2026-10-06 用户拍板）。
   */
  async function runAuto(cls: Cls, runOpts: { skipClassify?: boolean } = {}): Promise<PipeSettle> {
    if (busy !== '') return { action: 'blocked', summary: '上一轮还没跑完/正忙' };
    const gate = aiCfg();
    if (!gate.ok) {
      notifyLight(gate.why);
      return { action: 'blocked', summary: gate.why };
    }
    await ensureClassData(cls);
    // ① AI 分支（按当前视图分派给替身：A→classify / C→classifyMoc / B→proposeLocus）
    const kinds = kindsOf(cls);
    /**
     * 🔴 **P7.13a · #5b（Q16 拍定）**：AI 动作跑完出现"没给出值"（`locusNoValue > 0`）
     * → **自动弹**清空确认流（`runClearEmpty` 的既有序：预览 → 回收站 + 撤销条），
     * 用户不用自己去找横幅上那枚「一键清空此类…」。放 `finally`：无论这轮是执行完、
     * 用户取消了确认、还是"一项都没勾"，问的都是**剩下**的空笔记。
     * 未配 AI 的门在更上面（没跑过 AI 就不会弹 —— `locusNoValue` 起手为 0、
     * `runAiLocus` 每轮开头也归零）。
     */
    const ranLocus = kinds.includes('locus');
    try {
      /**
       * 🔴 独立审 🔴1 修：triage 的 `autoAi` 跳（打开即跑的那一次 classify）之后，
       * `maybeAutoRun` 会再进这里 —— 第一版**没有守卫**，classify 被跑**两遍**
       * （费用翻倍；第二遍回复覆盖第一遍的 `aiMove`，聊天式回话甚至把提案洗空）。
       * 约定：**autoAi 已跑过 classify 的入口传 `skipClassify`**（跳过它、其余分支照跑）。
       */
      if (kinds.includes('move') && !runOpts.skipClassify) await runAiClassify();
      if (kinds.includes('moc')) await runAiMoc();
      if (ranLocus) await runAiLocus();
      render();
      // ② 收集勾选（只认当前视图里的行）
      const rows = rowsOf(cls);
      const picked = rows.filter((r) => checked.has(r.id) && executable(r));
      if (picked.length === 0) {
        notify({ kind: 'info', text: '一项都没勾', detail: '勾上要整理的，或先点刷新（头部那枚小图标）', ms: NOTIFY_MS.info });
        // 🟡8（独立审）：扫描失败过的话，"没得做"是假信息 —— 如实说原因
        if (failed !== '') return { action: 'blocked', summary: `本地扫描失败（${failed}）—— 没得做的原因在这儿，不是"没有可整理的"` };
        return { action: 'empty', summary: '这一类眼下没有可执行的（一项都没勾上）' };
      }
      const moveRows = picked.filter((r) => r.kind === 'move');
      const mocRows = picked.filter((r) => r.kind === 'moc');
      const locusRows = picked.filter((r) => r.kind === 'locus');
      const tailRows = picked.filter((r) => r.kind === 'tail');
      // ③ 一次确认（逐条列「哪篇 → 做什么」）
      const parts: string[] = [];
      if (moveRows.length > 0) parts.push(`搬 ${moveRows.length} 篇`);
      if (locusRows.length > 0) parts.push(`补「文件位置」${locusRows.length} 篇`);
      if (tailRows.length > 0) parts.push(`补尾链 ${tailRows.length} 篇`);
      if (mocRows.length > 0) parts.push(`挂链 ${mocRows.length} 篇`);
      const res = await confirm({
        title: `即将整理：${parts.join(' / ')}`,
        preview: picked.map((r) => planRowOf(r)),
        warnings: [],
        notes: [
          '照旧写盘链：搬走 mover、补属性与挂链只加不删；执行前各自快照',
          '撞名一律不覆盖：目标同名同内容 = 已做过（跳过）；内容不同 = 真冲突（留着不动）',
          moveRows.length + mocRows.length + locusRows.length + tailRows.length > 1
            ? '多类一起跑时撤销条留最后一条；各步的快照都在（快照面板里可还原）'
            : '',
        ].filter(Boolean),
        primary: { label: `执行这 ${picked.length} 项` },
      });
      if (res.action !== 'primary') return { action: 'cancelled', summary: '用户取消了（一个字节都没动）' };
      busy = 'run';
      render();
      // ④ 按链执行（顺序有讲究：补声明 / 补尾链 / 挂链都用"相对库根"的路径找文件 ——
      //    搬动会改路径 → **mover 排最后**）
      if (locusRows.length > 0) await chainLocus(locusRows);
      if (tailRows.length > 0) await chainTail(tailRows);
      if (mocRows.length > 0) await chainMoc(mocRows);
      if (moveRows.length > 0) await chainMove(moveRows);
      busy = '';
      await refreshLocal();
      // B/C 的现算清单跑完要重算（刚补过的那些不该还在单子上）
      locusRowsAll = null;
      migrateRowsAll = null;
      tailRowsAll = null;
      await ensureClassData(clsSel);
      render();
      return { action: 'executed', summary: parts.join(' / ') }; // 🟡5：不带前缀（可见前缀由 ai-tools 统一加）
    } finally {
      // #5b：AI 跑完"没给出值" → 自动弹（"剩下的是空笔记，要不要一键删"）
      if (ranLocus && locusNoValue > 0) void runClearEmpty();
    }
  }

  /** 「自己去整理」：打开对应的现成工作面（**不动库**）；D 按 A→B→C 的第一类有勾选的分派 */
  function runManual(cls: Cls): void {
    const rows = rowsOf(cls).filter((r) => checked.has(r.id));
    const has = (k: PRowKind): boolean => rows.some((r) => r.kind === k);
    if (cls !== 'D') {
      if (cls === 'A') return manualNotes(rows);
      if (cls === 'B') return has('locus') ? manualNotes(rows) : voidBye(() => openMigratePanel(ctx));
      return has('moc') ? manualMoc() : voidBye(() => openBackfillPanel(ctx));
    }
    if (has('move') || has('locus')) return manualNotes(rows);
    if (has('migrate')) return voidBye(() => openMigratePanel(ctx));
    if (has('moc')) return manualMoc();
    if (has('tail')) return voidBye(() => openBackfillPanel(ctx));
    notifyLight('这一类眼下没有要整理的');
  }

  /** 关面板再开工作面（两个模态叠着的话"点外面关掉"会先关上面那层） */
  function voidBye(open: () => void): void {
    h.close('manual');
    open();
  }

  function manualNotes(rows: PRow[]): void {
    const kbRoot = kbRootOf();
    // v2：B 类的「缺声明」行也走这条路（去全部笔记里自己补声明）—— 与搬动行同一种"去处"
    const paths = rows.filter((r) => r.kind === 'move' || r.kind === 'locus').map((r) => joinPath(kbRoot, r.path));
    h.close('manual');
    if (paths.length > 0) ctx.goNotes({ dir: scope || undefined, paths, selectPaths: paths });
    else ctx.goNotes({ dir: scope || undefined });
  }

  function manualMoc(): void {
    const page = local?.moc?.page;
    h.close('manual');
    if (page) {
      const f = ctx.app.vault.getAbstractFileByPath(joinPath(kbRootOf(), page));
      if (f instanceof TFile) {
        void ctx.app.workspace.getLeaf('tab').openFile(f);
        return;
      }
    }
    openBackfillPanel(ctx);
  }

  // ── 执行链（全部是既有链 —— 这一层只挑行、不新写盘）────────────
  /** A · 搬（一次 mover 调用 = 一个快照 = 一个撤销句柄） */
  async function chainMove(items: PRow[]): Promise<void> {
    const byDir = new Map<string, string[]>();
    for (const it of items) byDir.set(it.to, [...(byDir.get(it.to) ?? []), it.path]);
    const lockedN = items.filter((i) => i.locked).length;
    // 复核存在性（面板开着的窗口里文件可能被别处动了）+ 记下"没声明"的名单（搬完补声明用）
    const kbRoot = kbRootOf();
    const targets: { dir: string; files: TFile[] }[] = [];
    const undeclared = new Set<string>();
    const missing: string[] = [];
    for (const [dirRel, rels] of byDir) {
      const files: TFile[] = [];
      for (const rel of rels) {
        const f = ctx.app.vault.getAbstractFileByPath(joinPath(kbRoot, rel));
        if (!(f instanceof TFile)) {
          missing.push(rel);
          continue;
        }
        files.push(f);
        const e = ctx.index.get(f.path);
        if (!e || declaredPositions(e.props).length === 0) undeclared.add(f.path);
      }
      if (files.length > 0) targets.push({ dir: joinPath(kbRoot, dirRel), files });
    }
    if (missing.length > 0) {
      notifyLight(`${missing.length} 篇执行时已经不在原位（跳过了）`, missing[0]);
    }
    if (targets.length === 0) return;
    const r = await ctx.mover.move({
      targets,
      source: 'suggest',
      reason: `整理建议：搬走 ${items.length} 篇`,
      quiet: true, // 撤销条在（下面 showUndo）→ 不弹重复通知
    });
    if (r.error) {
      notifyError('整理已中止（一个文件都没动）', r.error);
      return;
    }
    // 补声明：**没声明的**被搬笔记（有声明的由 mover 第 7 步跟过去了）
    const warnings: string[] = [];
    const declaredWritten = await writeDeclaredForMoved(
      { app: ctx.app, fm: ctx.fm },
      r.moved.filter((m) => undeclared.has(m.from)),
      (m) => relativeTo(parentDir(m.to), kbRoot),
      warnings,
    );
    if (r.snapshotId) {
      showUndo({
        text: `已整理：搬走 ${r.moved.length} 篇${lockedN > 0 ? `（含 ${lockedN} 篇位置锁定）` : ''}`,
        detail: declaredWritten > 0 ? `另有 ${declaredWritten} 篇补写了「文件位置」` : '撤销 = 从操作前的快照还原',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, r.snapshotId).then((back) => {
            // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：只判空，不播成功文案
            if (!back) return;
            notifyLight(
              `已还原这次整理：搬回 ${back.movedBack} 篇`,
              back.blocked.length > 0 ? `${back.blocked.length} 项没动：${back.blocked[0].why}` : '',
            );
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
    }
    if (r.blocked.length > 0) notifyLight(`${r.blocked.length} 篇真冲突没搬（目标同名内容不同）`);
    if (warnings.length > 0) notifyLight('有几篇没跟上', warnings[0]);
  }

  /**
   * C 的一半 · 补「## 关联笔记」尾链段 —— 走共用链 `ui/organize.ts` 的 `topUpTails`
   *（P7.12 · #9/#11 拆出：「一键整理」的 AI 流程也要同一条；语义与文案一字不动）
   */
  async function chainTail(items: PRow[]): Promise<void> {
    const kbRoot = kbRootOf();
    await topUpTails(
      ctx,
      items.map((r) => joinPath(kbRoot, r.path)),
      { action: '整理建议：补尾链', source: 'suggest' },
    );
  }

  /** C 的另一半 · MOC 挂链（快照 + vault.process，只加不删） */
  async function chainMoc(items: PRow[]): Promise<void> {
    const page = items[0].page ?? '';
    const kbRoot = kbRootOf();
    const pageAbs = joinPath(kbRoot, page);
    const file = ctx.app.vault.getAbstractFileByPath(pageAbs);
    if (!(file instanceof TFile)) {
      notifyError('找不到《知识地图》', page);
      return;
    }
    let r: Awaited<ReturnType<typeof appendMocItems>>;
    try {
      r = await appendMocItems(ctx, page, items.map((it) => ({ path: it.path, to: it.to })));
    } catch (e) {
      notifyError('挂链已中止（页面一个字节都没动）', e instanceof Error ? e.message : String(e));
      return;
    }
    if (r.added > 0 && r.snapshotId) {
      showUndo({
        text: `已挂进《知识地图》：${r.added} 篇`,
        detail: '撤销 = 还原挂链前的页面',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, r.snapshotId).then((back) => {
            // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：只判空，不播成功文案
            if (!back) return;
            notifyLight(`已还原《知识地图》：写回 ${back.contentsRestored} 个文件`);
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
    }
    const bits: string[] = [];
    if (r.already > 0) bits.push(`${r.already} 篇已经挂过（跳过）`);
    if (r.missed > 0) bits.push(`${r.missed} 篇的节不见了（页面改过了？）`);
    if (bits.length > 0) notifyLight(`挂链结果：${r.added} 篇新增`, bits.join(' · '));
  }

  /** B · 补「文件位置」声明（v2 的 AI 补属性写盘链：快照 → fm.set —— 与起标题同构；只写声明、不搬） */
  async function chainLocus(items: PRow[]): Promise<void> {
    const kbRoot = kbRootOf();
    const rows: { row: PRow; file: TFile }[] = [];
    const missing: string[] = [];
    const stale: string[] = [];
    const noDir: string[] = [];
    for (const r of items) {
      const abs = joinPath(kbRoot, r.path);
      const f = ctx.app.vault.getAbstractFileByPath(abs);
      if (!(f instanceof TFile)) {
        missing.push(r.path);
        continue;
      }
      // 动库前复核（与搬那一条同款）：这期间别处已经写过声明了 → 不覆盖用户的决定
      const e = ctx.index.get(abs);
      if (e && declaredPositions(e.props).length > 0) {
        stale.push(r.path);
        continue;
      }
      // 落点目录要还在（声明指向不存在的目录 = 立刻制造一条"位置不一致"账）
      if (r.to !== '' && ctx.app.vault.getAbstractFileByPath(joinPath(kbRoot, r.to)) == null) {
        noDir.push(r.path);
        continue;
      }
      rows.push({ row: r, file: f });
    }
    if (missing.length > 0) notifyLight(`${missing.length} 篇执行时已经不在原位（跳过了）`, missing[0]);
    if (stale.length > 0) notifyLight(`${stale.length} 篇已经写过「文件位置」（跳过，不覆盖）`, stale[0]);
    if (noDir.length > 0) notifyLight(`${noDir.length} 篇的落点目录已经不在库里（跳过了）`, noDir[0]);
    if (rows.length === 0) return;
    let snapId = '';
    try {
      const snap = await ctx.snapshot.capture({
        reason: `AI 补声明：${rows.length} 篇`,
        files: rows.map((x) => x.file),
      });
      snapId = snap.id;
    } catch (e) {
      notifyError('快照失败，已中止', e instanceof Error ? e.message : String(e));
      return;
    }
    let written = 0;
    const failedRows: string[] = [];
    for (const { row, file } of rows) {
      try {
        const res = await ctx.fm.set(file, '文件位置', [row.to]);
        // `skipped` 非空 = 整篇跳过（一个字节都没写）—— 如实计入"没写成"
        if (res.skipped.length === 0) {
          written += 1;
          /**
           * 🔴 **登记成"上次看见的声明"**（P7.12 · #12 的口径：自动归位只搬
           * *用户*显式改的）—— 不登记的话，下一轮 tick 会把我们刚写的这笔
           * 当成"用户改了声明"，又把它搬一次（双份副作用 + 双撤销条）。
           */
          ctx.reconcile.noteSelfDeclared(file.path, [row.to]);
        } else {
          failedRows.push(`${file.basename}：${res.skipped.join('；')}`);
        }
      } catch (e) {
        failedRows.push(`${file.basename}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const logged = await ctx.report.log({
      action: '整理建议：补文件位置',
      result: failedRows.length === 0 ? 'ok' : 'partial',
      source: 'suggest',
      summary: `补了 ${written} 篇的「文件位置」（失败 ${failedRows.length} 篇）`,
      rows: [
        { label: '改动', detail: rows.map((x) => `${x.row.path} → ${x.row.to}`).slice(0, 10).join('；') },
        ...failedRows.slice(0, 5).map((f) => ({ label: '失败', detail: f })),
      ],
      snapshotId: snapId,
      extra: 'AI 补声明（v2：只写「文件位置」，不搬——归位由既有链负责）',
    });
    if (!logged) notifyLight('这次的补声明日志没写进库', '（操作本身已完成，见控制台）');
    if (snapId) {
      showUndo({
        text: `已补「文件位置」：${written} 篇`,
        detail: '撤销 = 从操作前的快照还原',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, snapId).then((r) => {
            if (r) notifyLight('已还原这次补声明');
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
    }
    if (failedRows.length > 0) notifyLight(`${failedRows.length} 篇没写成`, failedRows[0]);
  }

  /** 一行 → 确认流的预览行 */
  function planRowOf(r: PRow): PlanRow {
    if (r.kind === 'move') return { kind: 'move', from: `《${baseOf(r.path)}》`, to: r.to || '库根', count: 1 };
    if (r.kind === 'moc') return { kind: 'link', from: `《${baseOf(r.path)}》`, to: `「${r.to}」`, count: 1 };
    if (r.kind === 'locus') return { kind: 'set', prop: '文件位置', from: '（缺）', to: r.to, count: 1 };
    return { kind: 'set', prop: '补尾部双链', from: '（缺）', to: '「## 关联笔记」段', count: 1 };
  }

  // ── 渲染 ──────────────────────────────────────────────────────
  function render(): void {
    renderHead();
    renderList();
  }

  function renderHead(): void {
    head.textContent = '';
    const segWrap = div({ cls: 'kbw-seg' });
    for (const [label, val] of [
      ['收件箱', INBOX_DIR],
      ['全库', ''],
    ] as const) {
      segWrap.appendChild(
        el('button', {
          cls: ['kbw-segbtn', scope === val ? 'is-on' : null],
          attr: { type: 'button' },
          text: label,
          on: {
            click: () => {
              if (scope === val) return;
              scope = val;
              aiMove = null;
              aiMoc = null;
              aiStats = '';
              void refreshLocal();
            },
          },
        }),
      );
    }
    head.appendChild(segWrap);
    /**
     * 右侧两枚（P7.9 · ⑥）：刷新**缩成小图标**；两枚来源开关**压成一扇「来源」菜单**。
     */
    const refresh = iconBtn('refresh-cw', busy === 'local' ? '刷新中…' : '刷新', () => {
      // B/C 现算清单跟着重算（刚补过的那些不该还在单子上）
      locusRowsAll = null;
      migrateRowsAll = null;
      tailRowsAll = null;
      locusAsked = false;
      locusNoValue = 0;
      void refreshLocal();
    });
    if (busy === 'local') refresh.setAttribute('disabled', 'true');
    head.appendChild(refresh);
    head.appendChild(srcBtn());
    /**
     * **安全例外**（P7 拍板）：出错 / 未配置必须出一行红字 —— 不许静默（§11 口径）。
     * v2（#10 拍定）：AI 有没给出值的行时，这行红字上**挂「一键清空此类…」** ——
     * "只有模板架子/没正文"的那批笔记从这里一次清掉（全库扫 → 预览 → 回收站）。
     */
    if (aiErr) {
      const bad = div({ cls: 'kbw-suggest-note is-bad' });
      bad.appendChild(span({ text: aiErr }));
      if (locusNoValue > 0) {
        bad.appendChild(
          btn({
            cls: 'kbw-btn is-small is-danger kbw-suggest-clearbtn',
            text: '一键清空此类…',
            attr: { type: 'button', title: '全库扫「剥掉前言与尾链后没有正文」的笔记 → 预览 → 回收站' },
            on: { click: () => void runClearEmpty() },
          }),
        );
      }
      head.appendChild(bad);
    }
    if (failed) head.appendChild(div({ cls: 'kbw-suggest-note is-bad', text: `算不出来：${failed}` }));
  }

  /**
   * ⚙ 来源（P7.9 · ⑥ 一扇菜单；**P7.12 · R2**：入口带当前状态 + 弹层顶部一句人话）
   *
   * 批注原话：「这里设置项"来源"我没看懂是干嘛的」——它控制"哪些来源参与算建议"。
   * 照演示稿 §R2：按钮直接亮出勾了谁（`来源：规则 · 学过往`），弹层第一行一句话说清，
   * 两条说明小字换大白话；「作用范围」行照旧（三条硬规矩）。
   */
  function srcBtn(): HTMLElement {
    const names = [sources.rule ? '规则' : '', sources.learned ? '学过往' : ''].filter(Boolean);
    const b = el('button', {
      cls: ['kbw-btn', 'is-small', 'is-ghost', 'kbw-suggest-srcbtn'],
      attr: { type: 'button', title: '选哪些来源出建议（管 A 类）' },
      on: {
        click: (evt) => {
          const el0 = evt.currentTarget as HTMLElement;
          const r = el0.getBoundingClientRect();
          showMenu(
            { x: r.left, y: r.bottom },
            {
              scope: { kind: 'global', label: '建议来源', icon: 'settings' },
              items: [
                { kind: 'hint', label: '这些建议从哪来？勾谁算谁' },
                {
                  kind: 'item',
                  label: '规则',
                  hint: '按「文件位置/属性/标签」算',
                  control: { type: 'multi', checked: sources.rule },
                  stay: true,
                  run: (c) => {
                    sources.rule = c.value === true;
                    compose();
                    render();
                  },
                },
                {
                  kind: 'item',
                  label: '学过往',
                  hint: '按你以前搬过的同类学',
                  control: { type: 'multi', checked: sources.learned },
                  stay: true,
                  run: (c) => {
                    sources.learned = c.value === true;
                    compose();
                    render();
                  },
                },
              ],
            },
          );
        },
      },
    });
    b.appendChild(icon('settings', 13));
    b.appendChild(span({ text: `来源：${names.length > 0 ? names.join(' · ') : '无'} ›` }));
    return b;
  }

  /** 四选一（A 搬笔记 / B YAML 头 / C 结尾双链 / D 我全都要） */
  function renderChoices(): HTMLElement {
    const wrap = div({ cls: 'kbw-suggest-choice' });
    const opts: { id: Cls; label: string }[] = [
      { id: 'A', label: '搬笔记建议' },
      { id: 'B', label: 'YAML 头建议' },
      { id: 'C', label: '结尾双链建议' },
      { id: 'D', label: '我全都要' },
    ];
    for (const o of opts) {
      const row = div({
        cls: ['kbw-suggest-opt', clsSel === o.id ? 'is-on' : null, 'kbw-hover-1'],
        data: { cls: o.id },
        attr: { role: 'radio', tabindex: '0', 'aria-checked': clsSel === o.id ? 'true' : 'false' },
      });
      /**
       * R1（P7.12）：**去圆点**（照 §R1 稿：与向导第 1 步的新样式一致）——
       * 选中只靠 `.is-on` 的描边 + 淡底，不靠颜色也能看出（键徽标 + 描边双信号）。
       */
      row.appendChild(span({ cls: 'kbw-suggest-optkey', text: `${o.id} ·` }));
      row.appendChild(span({ cls: 'kbw-suggest-optlabel', text: o.label }));
      const pick = (): void => {
        if (clsSel === o.id) return;
        clsSel = o.id;
        render();
        // B/C 的现算清单第一次选中时才跑（懒算）
        void ensureClassData(o.id).then(() => {
          if (clsSel === o.id) render();
        });
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          evt.preventDefault();
          pick();
        }
      });
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderList(): void {
    listHost.textContent = '';
    if (busy === 'local' && !local) {
      listHost.appendChild(div({ cls: 'kbw-suggest-empty', text: '算着…' }));
      return;
    }
    if (!local) {
      // 失败原因在头部那行红字里（P7.9 · ⑥：空态句全去；出错必留一行 —— P7 安全例外）
      return;
    }
    // ── 四选一（批注定稿：范围 seg 之下的第一个东西）──
    listHost.appendChild(renderChoices());
    // ── 该类待办清单（上限在 rowsOf 里做 —— 渲染与执行共用同一份截断）──
    const rows = rowsOf(clsSel);
    markSeen(rows);
    if (overflowNote !== '') {
      // 截断是安全告知（看不见的行不许被执行），不是说明 —— 留着
      listHost.appendChild(div({ cls: 'kbw-suggest-dropped', text: overflowNote }));
    }
    for (const r of rows) listHost.appendChild(suggestRow(r));
    // 「旧规范」整篇跳过（值会被写坏）：只报数 + 去处
    if (kindsOf(clsSel).includes('migrate') && migrateBlockedN > 0) {
      listHost.appendChild(
        div({
          cls: 'kbw-suggest-dropped',
          text: `另有 ${migrateBlockedN} 篇旧规范跳过（值会被写坏、得人工看）—— 去「属性迁移」里过目`,
        }),
      );
    }
    const checkedNow = rows.filter((r) => checked.has(r.id) && executable(r)).length;
    const empty = rows.length === 0 && !(busy === 'local');
    if (empty) {
      /** R1（P7.12）：空态给一句"下一步"（照 §R1 稿）—— 原来只有一句孤零零的灰字 */
      const box = div({ cls: 'kbw-suggest-empty' });
      box.appendChild(div({ text: '这一类眼下没有要整理的' }));
      box.appendChild(div({ cls: 'kbw-suggest-emptynote', text: '换上面别的类，或切「全库」看看' }));
      listHost.appendChild(box);
    }
    // ── 两个动作 ──
    const manual = el('button', {
      cls: ['kbw-btn', 'kbw-suggest-manual'],
      attr: { type: 'button', title: '打开对应的现成工作面（不动库）' },
      text: '自己去整理',
      on: { click: () => runManual(clsSel) },
    });
    const aiBtn = el('button', {
      cls: ['kbw-btn', 'kbw-suggest-aibtn', 'is-primary'],
      text:
        busy === 'ai' || busy === 'moc-ai' || busy === 'area-ai'
          ? 'AI 分析中…'
          : busy === 'run'
            ? '整理中…'
            : 'AI 自动去做',
      attr: {
        type: 'button',
        title: aiCfg().ok
          ? `让 AI 接手这一类（先出建议，再走确认流执行）${aiStats ? `（上次：${aiStats}）` : ''}`
          : aiCfg().why,
      },
      on: { click: () => void runAuto(clsSel) },
    });
    if (busy !== '') aiBtn.setAttribute('disabled', 'true');
    /**
     * R1（P7.12）：底栏排出主次（照 §R1 稿）—— 「自己去整理」靠左、AI 是主角收右；
     * 「已勾 N 项」是数据，挨在主角左边（原来是 AI 挨着左、计数甩最右）。
     */
    const bar = div({ cls: 'kbw-suggest-bar' });
    bar.appendChild(manual);
    bar.appendChild(span({ cls: 'kbw-suggest-spacer' }));
    bar.appendChild(span({ cls: 'kbw-suggest-count', text: checkedNow > 0 ? `已勾 ${checkedNow} 项` : '' }));
    bar.appendChild(aiBtn);
    listHost.appendChild(bar);

    // ── 关联提示（只读）：**折叠行是开关**（P7.9 · ⑥ 保留）──
    if (pairs.length === 0) return;
    const fold = el('button', {
      cls: ['kbw-suggest-fold', 'kbw-hover-1'],
      attr: { type: 'button' },
      on: {
        click: () => {
          pairsOpen = !pairsOpen;
          render();
        },
      },
    });
    fold.appendChild(span({ text: `关联提示 · ${pairs.length} 对` }));
    fold.appendChild(span({ cls: 'kbw-suggest-fold-arrow', text: pairsOpen ? '▾' : '▸' }));
    listHost.appendChild(fold);
    if (!pairsOpen) return;
    for (const p of pairs) {
      const row = div({ cls: ['kbw-suggest-pair', 'kbw-hover-1'] });
      row.setAttribute('title', `${p.a} ↔ ${p.b} · ${p.why}`);
      row.appendChild(span({ cls: 'kbw-suggest-title', text: `《${baseOf(p.a)}》` }));
      row.appendChild(span({ cls: 'kbw-suggest-arrow', text: '↔' }));
      row.appendChild(span({ cls: 'kbw-suggest-title', text: `《${baseOf(p.b)}》` }));
      listHost.appendChild(row);
    }
  }

  /** 清单里的一行（五种行共一个形状：□ + 《名》 + 说明 + 徽标） */
  function suggestRow(it: PRow): HTMLElement {
    const row = div({ cls: ['kbw-suggest-row', 'kbw-hover-1'] });
    /** 全路径与理由**收进悬停**（P7.9 · ⑥：行上只留控制与数据） */
    row.setAttribute('title', `${it.path}${it.why ? ` · ${it.why}` : ''}`);
    if (it.kind === 'migrate') {
      // 旧规范：**没有复选框** —— 它的写入链在属性迁移面板里（这条链不动它），
      // 点一下就去那儿（与「自己去整理」同一个出口）
      row.appendChild(span({ cls: 'kbw-suggest-bullet', text: '·' }));
    } else {
      const cb = el('input', { cls: 'kbw-suggest-check', attr: { type: 'checkbox' } }) as HTMLInputElement;
      /**
       * #10 拍定：**没值的行置灰**（点不动）—— 界面不再"邀请你勾一件做不了的事"，
       * 也就不会再有"勾了却说没勾"（勾选态仍记在 `checked` 里，但执行集只认 executable）。
       */
      const disabled = !executable(it);
      cb.checked = !disabled && checked.has(it.id);
      if (disabled) {
        cb.setAttribute('disabled', 'true');
        cb.classList.add('is-disabled');
      }
      cb.addEventListener('change', () => {
        if (cb.checked) checked.add(it.id);
        else checked.delete(it.id);
        render();
      });
      row.appendChild(cb);
    }
    row.appendChild(span({ cls: 'kbw-suggest-title', text: `《${baseOf(it.path)}》` }));
    // 说明格：move/moc 用「→ 落点」（加粗）；area/tail 用短句；migrate 给去处
    if (it.kind === 'move') {
      row.appendChild(span({ cls: 'kbw-suggest-arrow', text: '→' }));
      row.appendChild(span({ cls: 'kbw-suggest-to', text: it.to || '库根' }));
    } else if (it.kind === 'moc') {
      row.appendChild(span({ cls: 'kbw-suggest-arrow', text: '→' }));
      row.appendChild(span({ cls: 'kbw-suggest-to', text: `「${it.to}」` }));
    } else if (it.kind === 'locus') {
      if (it.to !== '') {
        row.appendChild(span({ cls: 'kbw-suggest-arrow', text: '→' }));
        row.appendChild(span({ cls: 'kbw-suggest-to', text: it.to }));
      } else if (locusAsked) {
        // #10 拍定：AI 跑过、没给出值的行 → 行尾「AI 未出值」（复选框已置灰，见上）
        row.appendChild(span({ cls: 'kbw-suggest-muted', text: '缺「文件位置」' }));
        row.appendChild(span({ cls: 'kbw-suggest-dim', text: 'AI 未出值' }));
      } else {
        row.appendChild(span({ cls: 'kbw-suggest-muted', text: '缺「文件位置」（点「AI 自动去做」出值）' }));
      }
    } else if (it.kind === 'tail') {
      row.appendChild(span({ cls: 'kbw-suggest-muted', text: it.why }));
    } else {
      row.appendChild(span({ cls: 'kbw-suggest-muted', text: `旧规范（${it.why}）· 去「属性迁移」处理` }));
    }
    // 来源字（P7.9 · ⑥）：一个字（规 / 学 / AI）；现算类没有徽标
    if (it.source !== null) {
      const srcBadge = div({
        cls: ['kbw-suggest-src', `is-${it.source}`],
        text: { rule: '规', learned: '学', ai: 'AI' }[it.source],
        attr: { title: { rule: '规则源', learned: '学过往', ai: 'AI 建议' }[it.source] },
      });
      row.appendChild(srcBadge);
    }
    // 锁标记走 lucide（P7.7c 图标纪律）
    if (it.locked) {
      const lock = icon('lock', 14, 'kbw-ico kbw-suggest-lock');
      lock.removeAttribute('aria-hidden');
      lock.setAttribute('role', 'img');
      lock.setAttribute('aria-label', '位置锁定（只挡后台自动动作）');
      lock.setAttribute('title', '设了「位置锁定」（只挡后台自动动作）');
      row.appendChild(lock);
    }
    row.addEventListener('click', (evt) => {
      if (it.kind === 'migrate') {
        /**
         * ⚠️ 独立审 🟡2：这一行**直奔属性迁移面板** —— 别走 `runManual(clsSel)`
         *（B 类里 `.has('locus')` 会先命中、D 类里 `.has('move')` 会先命中 → 开到别的地方去，
         * 与行尾自己写的「去『属性迁移』处理」矛盾）。旧规范行的唯一去处就是那儿。
         */
        voidBye(() => openMigratePanel(ctx));
        return;
      }
      const t = evt.target as HTMLElement | null;
      if (t?.classList.contains('kbw-suggest-check')) return;
      const cb = row.querySelector<HTMLInputElement>('.kbw-suggest-check');
      if (!cb || cb.disabled) return;
      cb.checked = !cb.checked;
      if (cb.checked) checked.add(it.id);
      else checked.delete(it.id);
      render();
    });
    return row;
  }

  // 首屏
  void refreshLocal();
  return h;
}

function baseOf(rel: string): string {
  const name = rel.split('/').pop() ?? rel;
  return name.replace(/\.[^.]+$/, '');
}

/** 逐条把 bullet 插进对应节的末尾（纯函数；返回新文本与计数） */
function applyMocBullets(
  text: string,
  items: { path: string; to: string }[],
  bulletOf: (path: string) => string,
): { text: string; added: number; already: number; missed: number } {
  let cur = text;
  let added = 0;
  let already = 0;
  let missed = 0;
  for (const it of items) {
    const r = insertMocBullet(cur, it.to, bulletOf(it.path));
    if (!r) {
      missed += 1;
      continue;
    }
    if (r.already) {
      already += 1;
      continue;
    }
    cur = r.text;
    added += 1;
  }
  return { text: cur, added, already, missed };
}

/**
 * MOC 挂链的**写盘链**（导出只为用例/探针；真机上只从面板进来）：
 * 试算（**有得加才拍快照**）→ 逐条在目标节末尾插一行（**只加不删**；已有同链接 = 幂等跳过）
 * → 一次 `vault.process`（回调里**对当刻文本**重算一遍 —— 读→写之间若被别处改过，
 * 那次改动不会被我方整段回退；独立审查 🟢5/🟢6）。
 * 返回计数与快照 id（撤销条由调用方弹 —— 与 mover 同一条纪律："服务层不弹条"）。
 */
export async function appendMocItems(
  ctx: WorkbenchContext,
  page: string,
  items: { path: string; to: string }[],
): Promise<{ added: number; already: number; missed: number; snapshotId: string }> {
  const kbRoot = ctx.settings.kbRoot();
  const pageAbs = joinPath(kbRoot, page);
  const file = ctx.app.vault.getAbstractFileByPath(pageAbs);
  if (!(file instanceof TFile)) throw new Error(`找不到《知识地图》：${page}`);
  const bulletOf = (p: string): string => mocBulletOf(joinPath(kbRoot, p));
  const pre = applyMocBullets(await ctx.app.vault.cachedRead(file), items, bulletOf);
  if (pre.added === 0) {
    // 一条都加不了（都挂过了 / 节没了）→ 不拍无意义的快照（🟢5）
    return { added: 0, already: pre.already, missed: pre.missed, snapshotId: '' };
  }
  const snap = await ctx.snapshot.capture({ reason: `挂进《知识地图》：${items.length} 篇`, files: [file] });
  markSelfWrite(pageAbs); // 我们自己的写（否则索引判"外部改动"、还原会被守卫挡住）
  let done = pre;
  await ctx.app.vault.process(file, (cur) => {
    done = applyMocBullets(cur, items, bulletOf); // 对**当刻**文本重算（🟢6）
    return done.text;
  });
  return { added: done.added, already: done.already, missed: done.missed, snapshotId: snap.id };
}
