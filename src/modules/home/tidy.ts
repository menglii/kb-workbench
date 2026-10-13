/**
 * modules/home/tidy.ts —— 首页「整理收件箱」的**二级选择**（A2，用户 2026-09-27 提）
 *
 * 以前点它直接跳走（`goNotes({dir, selectAll})`）；现在先弹一个二级菜单：
 *   ① **去全部笔记自己整理** —— **原来那条路一个字都没改**（跳过去 + 筛选 + 全选）
 *   ② **一键自动整理** —— 把 Inbox 里那些就地归位（搬文件，并给兜底搬的补上「文件位置」）
 *
 * 四条口径：
 *   · **只管 `00_Inbox` 里那些**（`scopeDir`）—— "顺手把全库都归位"是另一个动作
 *     （重排库结构面板的活），这里做就成了"我没让你动别的目录，你动了"。
 *   · **一个目录都不新建**（`shapeAsSkeleton`）：自动动作不替用户建目录，
 *     落点算不出来或目录不存在的，进 `pending` 并在确认流里写明原因。
 *   · **计划与重排共用一份判据**（`planRebuild`：声明优先 → 兜底只在 Inbox → 撞名两篇都不搬）。
 *   · **动库走确认流 + mover**（三条硬规矩里的两条）：确认流逐条列出"哪篇 → 去哪"、可取消；
 *     搬走 `mover` → 快照 / 撤销条 / 操作日志全在那条链上，这里一行都不用自己写。
 *   · **结构性笔记（中心页 / MOC / 指南 / 规范）不参与**（P7.9 · ⑤ 拍板）：输入整批滤掉 ——
 *     它们的陈旧声明不再变成每次必现的"算不出落点"噪音。⚠️ 过滤只在这一层：
 *     `planRebuild` 是共享件，重排面板那边报出一切待定是它的职责。
 *   · **0 可搬不说谜语**（P7.9 · ⑤）：每条待定的 why 是"原因 → 出路"；一篇都搬不动时
 *     给"一句为什么 + 出口按钮"（补全 / 重排库结构），不再只丢一句"算不出落点"。
 *
 * ⚠️ **"同步改前言与尾链"的真相**：前言里那个「文件位置」由 `executeRebuild` 给**兜底搬**的
 * 补上（`mover` 自己的属性跟随也会改它）；**尾链是平台随改名自动改的**（S2 实测：
 * `renameFile` 返回那一刻三种写法都已改完）—— 所以我们**不写修复逻辑**，只负责确认它真的发生了。
 *
 * ## P7.10 · #9（确认流：信息分栏 + 文案简化）
 *
 * 预览从"按目录聚合"改**逐篇**（《名》→ 落点；折叠 12 行统一在 `ui/confirm.ts`）；
 * 蓝栏缩成三句极短句（结构性 / 双链 / 重名，文案对表见方案 §9）；warnings 一个字不动。
 * **`ui/confirm.ts` 契约不动**—— 黄 / 蓝两栏本就存在，只是重新分配内容 + 缩短。
 *
 * ## P7.13a · #4（作用范围可选）
 *
 * `openInboxChoices` 的作用域行可点：选一级目录 → 菜单 `refresh` 就地更新 →
 * 三项动作全部跟随范围。首页快捷按钮与**首页右键菜单里的同名项**共用这一份实现
 *（`ui/menu.ts` 的 `MenuScope.submenu` 是那条"可选能力"）。
 */
import type { WorkbenchContext } from '../../core/context';
import { baseName, joinPath, parentDir, relativeTo, stripExt } from '../../core/paths';
import { AiError } from '../../services/ai';
import { fallbackDir, readRouteTable } from '../../services/routes';
import {
  executeRebuild,
  listBrief,
  pendingLineOf,
  planRebuild,
  rebuildNotesOf,
  shapeAsSkeleton,
  STRUCTURAL_TYPES,
  vaultShapeOf,
  writeDeclaredForMoved,
  type RebuildMove,
  type RebuildPendingCode,
} from '../../services/rebuild';
import { confirm, type PlanRow } from '../../ui/confirm';
import { showMenu, type MenuSpec } from '../../ui/menu';
import { NOTIFY_MS, notify, notifyError, notifyInfo, notifyLight, type NoticeAction } from '../../ui/notify';
import { topUpTails } from '../../ui/organize';
import { openRebuildPanel } from '../../ui/rebuild-panel';
import { AI_NOT_CONFIGURED, openSuggestPanel } from '../../ui/suggest-panel';
import { restoreOrNotify, showUndo } from '../../ui/undo-bar';

/** 收件箱（相对库根）—— §2.2/§2.3 一律用这个口径 */
export const INBOX = '00_Inbox';

/**
 * 「整理收件箱」被点击：弹二级选择。`anchor` 是那个按钮 / 菜单行 —— 菜单从它的
 * 下沿展开（与「列」菜单同一做法）。
 *
 * ## P7.13a · #4（Q11–Q13 拍定）：**作用范围可选**
 *
 * · 点顶部「作用范围：xx · N 篇」那行 → 展开**一级目录**列表（有笔记的 + N 篇现算；
 *   `00_Inbox` 与当前范围恒在列表里 —— 前者是默认落点，后者的 ✓ 得看得见）；
 * · 选完**就地更新**（`MenuHandle.refresh`，不闪不关）——三项动作全部跟随当前范围：
 *   去自己整理 → `goNotes({dir: scope, …})`；一键自动整理 → `runInboxTidy({scope})`；
 *   整理建议… → `openSuggestPanel({scope})`。
 *
 * **一份实现两个入口共用**：首页快捷按钮（`blocks/quick.ts`）与**首页右键菜单里的
 * 同名项**（`index.ts` 的 showMenu）都走这一支 —— 两处各点开的是同一个菜单。
 */
export function openInboxChoices(ctx: WorkbenchContext, anchor: HTMLElement): void {
  let scope = INBOX;
  /** 现算的「一级目录 → 含子目录篇数」（跳过模板与 99_Meta —— 与 `blocks/todo.ts` 的 AI 子菜单同一口径，那是用户认过的样子） */
  const countsOf = (): Map<string, number> => {
    const metaTop = (ctx.settings.get().metaDir || '').replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
    const counts = new Map<string, number>();
    for (const e of ctx.index.notes()) {
      if (e.isTemplate) continue;
      const pos = e.effectivePosition;
      if (!pos) continue;
      const top = pos.split('/')[0];
      if (!top || top === metaTop) continue;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return counts;
  };
  /** 播报/置灰用的说法（收件箱那一档保持逐字文案 —— 用例与用户都认它） */
  const word = (): string => (scope === INBOX ? '收件箱' : `「${scope}」`);
  const buildSpec = (): MenuSpec => {
    const counts = countsOf();
    const n = counts.get(scope) ?? 0;
    const dirs = [...new Set([...counts.keys(), INBOX, scope])].sort((a, b) => a.localeCompare(b, 'zh'));
    return {
      scope: {
        kind: 'global',
        label: `${scope} · ${n} 篇`,
        icon: 'inbox',
        // 作用域行可点（P7.13a · #4 · Q13）：展开一级目录列表
        submenu: dirs.map((d) => ({
          kind: 'item' as const,
          label: `${d} · ${counts.get(d) ?? 0} 篇`,
          checked: d === scope,
          /**
           * ⚠️ `stay: true` 必需：run 里 `refresh` 会先关掉这份子菜单再就地重画父菜单，
           * 但 `fire` 尾随的 `closeAllMenus`（非 stay 时）会把**整条链**收掉 ——
           * 那就成了"选完就关"，与拍定的"不闪不关"相反。
           */
          stay: true,
          run: (c) => {
            void c;
            if (d === scope) return;
            scope = d;
            handle.refresh(buildSpec());
          },
        })),
      },
      items: [
        {
          kind: 'item',
          label: '去全部笔记自己整理',
          icon: 'list',
          run: () => ctx.goNotes({ dir: scope, selectAll: true }),
        },
        {
          kind: 'item',
          label: '一键自动整理',
          icon: 'wand-2',
          disabled: n === 0 ? `${word()}里没有笔记` : undefined,
          run: () => {
            void runInboxTidy(ctx, { scope });
          },
        },
        {
          /**
           * P7.6：整理建议面板（三源合一 · 逐条可勾 · 可切全库）。
           * 与 ② 的关系：② 是"零审阅"的快捷路径（原样保留）；③ 是多想一步的审阅路径。
           */
          kind: 'item',
          label: '整理建议…',
          icon: 'sparkles',
          run: () => {
            openSuggestPanel(ctx, { scope });
          },
        },
      ],
    };
  };
  const r = anchor.getBoundingClientRect();
  // 闭包先引用后赋值：`buildSpec` 里的 run 只在点击时跑，那时 handle 早已就位
  const handle = showMenu({ x: r.left, y: r.bottom }, buildSpec());
}

/**
 * 算一份计划 → 确认 → 执行。**导出只为用例/菜单**（真机上从「整理收件箱」或
 * 待处理右键的「AI 自动处理 ›」进来）。
 * 返回值给断言用：`null` = 没走到执行（计划为空 / 用户取消）。
 *
 * `opts.scope`（P7.11 · #4）：**同一台机器、范围换成该目录**（Q1 拍板）——
 * 默认 `00_Inbox`；待处理右键子菜单里点某个目录 = 传它的路径。
 * 其余一字不动（确认流 → 快照 → mover 原链）。
 *
 * `opts.only`（P7.12 · R8「自动整理」——编辑器右键那条）：**收窄到名单里这几篇**
 *（库内绝对路径；实测只服务一篇）。语义一字不动，只是"候选变窄" —— 与 `scopeDir`
 * 同一条轴的两个粗细档。`opts.label` 管播报里那个名字（默认按 scope 推）。
 */
export async function runInboxTidy(
  ctx: WorkbenchContext,
  opts: { scope?: string; only?: string[]; label?: string } = {},
): Promise<{ moves: string[] } | null> {
  const scope = (opts.scope ?? INBOX).replace(/^\/+|\/+$/g, '');
  const only = opts.only !== undefined ? new Set(opts.only) : null;
  /** 播报用的说法（收件箱那一档保持全部既有逐字文案 —— 用例与用户都认它） */
  const label = opts.label ?? (scope === INBOX ? '收件箱' : `「${scope}」`);
  const kbRoot = ctx.settings.kbRoot();
  const shape = await vaultShapeOf(ctx.app, kbRoot);
  const routes = await readRouteTable(ctx.app, ctx.settings);
  /**
   * 排除项用**自动归位那一份**（`自动化.json` 的 `reconcile.exclude`）：
   * 它才是"哪些地方不该被自动搬进去"的正解（含 `99_Meta` / `还原保留`）。
   * 只过滤来源不过滤目标是栽过的坑 —— 有人把「文件位置」写成 `99_Meta/03_AI指令集`
   * 时，那条笔记不该被"一键整理"搬进配置区。
   */
  const exclude = (await ctx.automation.get()).reconcile.exclude;

  /**
   * **结构性笔记（中心页 / MOC / 指南 / 规范）不参与「一键整理」**（P7.9 · ⑤ 拍板）：
   * 既不进计划、也不进 pending —— 它们的陈旧声明（如 `_收件箱.md` 指向一个早被收拢走的
   * 目录）曾经每次都被算进"算不出落点"，成了纯噪音（用户现场）。
   * ⚠️ **过滤只放在这一层**：`planRebuild` 是共享件（重排面板也调）—— 那边是"全量审计口"，
   * 把一切待定报出来是它的职责，别把过滤下推成公共语义。
   */
  const allNotes = rebuildNotesOf(ctx.index.getAll(), kbRoot).filter(
    (n) => only === null || only.has(n.path),
  );
  const inScope = (dir: string): boolean => dir === scope || dir.startsWith(`${scope}/`);
  /** 旧逻辑下**本来会被算进 pending / 计划**的那些（播报那一句只在这种时候说）；
   *  #17 起留**名单**（跑完的通知里点名），不再只有个数 */
  const structuralSkippedList = allNotes.filter(
    (n) => STRUCTURAL_TYPES.has(n.type) && inScope(n.dir) && n.declared.length > 0 && !n.declared.includes(n.dir),
  );
  const structuralSkipped = structuralSkippedList.length;
  /** 模板：重排/归位一律不碰（设计内）—— #17 起也在通知里点名（原来静默跳过） */
  const tplSkippedList = allNotes.filter((n) => n.isTemplate && inScope(n.dir));

  const plan = planRebuild({
    // 骨架 = 库现在的样子：不新建目录，落点只能是**已经存在**的目录
    skeleton: shapeAsSkeleton(shape.dirs, exclude),
    kbRoot,
    metaDir: ctx.settings.get().metaDir,
    existingDirs: shape.dirs,
    exists: shape.exists,
    notes: allNotes.filter((n) => !STRUCTURAL_TYPES.has(n.type)),
    fallbackDir: fallbackDir(routes.table, kbRoot),
    scopeDir: scope,
  });

  /**
   * ── AI 预整理（P7.12 · #9/#11；拍定：**并入一次确认**、不逐篇；未配 AI 照旧）──
   *
   * 两类候选，同一趟 AI 调用（`proposeLocus` 给了 `notes` 名单就收窄到本范围）：
   *   · **补「文件位置」** = 本范围里还没有声明的（含会被兜底搬的那些 —— 给它们挑个像样的家，
   *     而不是一股脑倒进兜底目录）；
   *   · **改声明** = 声明指向不存在 / 排除区目录的两类 pending（挑个已有目录覆盖）。
   *
   * 产物**只进确认单**（chips 明写每篇 AI 动了什么）——「AI 只出值、不静默改」：
   * 值写不写、怎么写，全部发生在你确认之后的搬动链里（未声明的由 `writeDeclaredForMoved`
   * 落盘、改声明的由 mover 第 7 步跟随更新）。
   * 叠加层 = 把 AI 值当"声明"喂回 **同一份 `planRebuild`** 重算 —— 落点合法性不另立第二套
   *（AI 挑的目录撞了名，会照旧判 pending 进 warnings，不会硬搬）。
   */
  let planFinal = plan;
  const aiChips = new Map<string, { text: string; warn?: boolean }>();
  let aiNote = '';
  if (ctx.ai.isConfigured()) {
    const scopeNotes = allNotes.filter((n) => inScope(n.dir) && !STRUCTURAL_TYPES.has(n.type) && !n.isTemplate);
    const needDeclare = scopeNotes.filter((n) => n.declared.length === 0);
    const needFix = plan.pending.filter((p) => p.code === 'missing-dir' || p.code === 'excluded-declared');
    const rels = [...needDeclare.map((n) => relativeTo(n.path, kbRoot)), ...needFix.map((p) => p.rel)];
    if (rels.length > 0) {
      notifyLight('AI 预整理中…', `给 ${rels.length} 篇挑落点`);
      try {
        const res = await ctx.ai.proposeLocus({ notes: rels });
        const fixRels = new Set(needFix.map((p) => p.rel));
        const aiDecls = new Map<string, string>(); // 库内绝对路径 → 目录（相对库根）
        for (const it of res.items) {
          const abs = joinPath(kbRoot, it.rel);
          aiDecls.set(abs, it.to);
          aiChips.set(
            abs,
            fixRels.has(it.rel)
              ? { text: `AI 改声明 → ${it.to}`, warn: true }
              : { text: `AI 补「文件位置」：${it.to}` },
          );
        }
        if (aiDecls.size > 0) {
          const overlay = allNotes
            .filter((n) => !STRUCTURAL_TYPES.has(n.type))
            .map((n) => (aiDecls.has(n.path) ? { ...n, declared: [aiDecls.get(n.path) ?? ''] } : n));
          planFinal = planRebuild({
            skeleton: shapeAsSkeleton(shape.dirs, exclude),
            kbRoot,
            metaDir: ctx.settings.get().metaDir,
            existingDirs: shape.dirs,
            exists: shape.exists,
            notes: overlay,
            fallbackDir: fallbackDir(routes.table, kbRoot),
            scopeDir: scope,
          });
        }
        /**
         * ⚠️ 独立审 C2（P7.12 收尾）：这几个数原先按"AI 给出值的篇数"报（`aiDecls.size`）——
         * 但真正落盘的只有**真搬成了的**那批（下方 `needDecl` 的口径：没搬成 / "它就住这儿"
         * 的不写声明）。确认单不许高报，这里按 `planFinal.moves` 现算交集。
         */
        const movedFrom = new Set(planFinal.moves.map((m) => m.from));
        const fixed = [...aiDecls.keys()].filter(
          (abs) => movedFrom.has(abs) && aiChips.get(abs)?.warn,
        ).length;
        const willDecl = [...aiDecls.keys()].filter(
          (abs) => movedFrom.has(abs) && !aiChips.get(abs)?.warn,
        ).length;
        const bits: string[] = [];
        if (willDecl > 0) bits.push(`补「文件位置」${willDecl} 篇`);
        if (fixed > 0) bits.push(`改声明 ${fixed} 篇`);
        const noValue = Math.max(0, res.fed.length - res.items.length);
        if (noValue > 0) bits.push(`${noValue} 篇没把握（没给）`);
        aiNote = bits.join(' · ');
      } catch (e) {
        notifyLight(
          'AI 预整理没跑成（照原件继续）',
          e instanceof AiError ? e.hint : e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  const moves = planFinal.moves;
  if (moves.length === 0) {
    /**
     * **0 可搬**（P7.9 · ⑤-④ 拍板）：一句为什么 + 出口按钮 —— 不再只丢一句
     * "N 篇算不出落点"（用户现场："一键搬完没有发生，也看不出下一步"）。
     * 分组行走 `pendingLineOf`（"N 篇<原因> —— <出路>"，与判据 `why` 同一份措辞）。
     */
    /**
     * ⚠️ 独立审 C1（P7.12 收尾）：这一支原先读的是 **AI 之前的** `plan.pending`，
     * 而 `moves` 与确认单 warnings（`planFinal.pending`）都已经是 AI 叠加后的 ——
     * 叠加层解决掉几篇时，"没有要整理的"判断与下面分组计数会和实际待定对不上。
     * 全部改读 `planFinal.pending`（本单动作的唯一真源）。
     */
    if (planFinal.pending.length === 0) {
      notifyInfo(
        /**
         * `label` 是个名词短语（"收件箱 / 「02_Areas」/《9.16》"）——只有单篇档
         * （`only`）读"这一篇"最顺；其余照旧 `${label}里`。
         */
        only !== null ? '这一篇没有要整理的' : `${label}里没有要整理的`,
        structuralSkipped > 0 ? '结构性笔记不参与整理' : '该有落点的都已经在了',
      );
      return null;
    }
    const counts = new Map<RebuildPendingCode, number>();
    for (const p of planFinal.pending) counts.set(p.code, (counts.get(p.code) ?? 0) + 1);
    const ORDER: RebuildPendingCode[] = [
      'no-fallback',
      'fallback-excluded',
      'fallback-missing',
      'missing-dir',
      'excluded-declared',
      'root-lying',
      'dup-name',
    ];
    const lines = ORDER.filter((c) => counts.has(c)).map((c) => `· ${pendingLineOf(c, counts.get(c) ?? 0)}`);
    if (structuralSkipped > 0) lines.push('· 结构性笔记不参与整理');
    if (tplSkippedList.length > 0) lines.push(`· 模板 ${tplSkippedList.length} 篇不参与归位（设计内）`);
    const codes = new Set(counts.keys());
    const actions: NoticeAction[] = [];
    if (
      codes.has('missing-dir') ||
      codes.has('excluded-declared') ||
      codes.has('no-fallback') ||
      codes.has('fallback-excluded') ||
      codes.has('fallback-missing') ||
      codes.has('root-lying')
    ) {
      actions.push({ label: '打开重排库结构', run: () => openRebuildPanel(ctx) });
    }
    /**
     * **✦ AI 建议**（P7.11 · #13，2026-10-06 批注）：搬不动的 → 开整理建议面板
     * （收件箱 · 自动跑 AI 分类），让 AI 为它们出落点。未配 AI 轻提示、不开面板
     *（与行内 ✦ 的降级同一条；按钮照画不 disabled）。
     */
    actions.push({
      label: '✦ AI 建议',
      run: () => {
        if (!ctx.ai.isConfigured()) {
          notifyLight(AI_NOT_CONFIGURED);
          return;
        }
        openSuggestPanel(ctx, { scope: INBOX, autoAi: true });
      },
    });
    notify({
      kind: 'partial',
      text: `${plan.pending.length} 篇还没搬，原因与去处：`,
      detail: lines.join('\n'),
      actions,
      ms: NOTIFY_MS.long,
    });
    return null;
  }

  const lockedN = moves.filter((m) => m.locked).length;
  const res = await confirm({
    title: `即将整理${label}：搬走 ${moves.length} 篇`,
    preview: targetRows(moves, aiChips),
    // 预览是**逐篇**的：折行量词用「篇」（别的调用方是分组行，默认「组」）—— P7.10 · 独立审 🟡2
    foldUnit: '篇',
    /**
     * 待定**逐条列全**（P7.9 · ⑤-③：不再截前 3 条）—— 每条的 `why` 都是"原因 → 出路"。
     */
    warnings: planFinal.pending.map((p) => `${baseName(p.path)}：${p.why}`),
    /**
     * 蓝栏 = **说明**，三条极短句（P7.10 · #9 + 二拍①，文案逐字对表见方案 §9）。
     * 逐篇清单从这一栏**挪进了上面的预览**（原 `perNoteList` 退役）——
     * "一栏只干一件事"：预览管"搬什么去哪"，这栏管"与用户有关的注意事项"。
     */
    notes: [
      ...(structuralSkipped > 0 ? ['结构性笔记不参与整理'] : []),
      ...(tplSkippedList.length > 0 ? [`模板 ${tplSkippedList.length} 篇不参与归位（设计内）`] : []),
      ...(aiNote !== '' ? [`AI 预整理：${aiNote} —— 值随这次搬动一起落盘（本单就是它的全部动作）`] : []),
      lockedN > 0 ? `${lockedN} 篇设了「位置锁定」，会一起搬（锁定只挡自动归位）` : '',
      '双链会自动跟着改；搬走的会补上「文件位置」',
      '重名不覆盖：内容相同自动跳过，不同就留着让你看',
    ].filter(Boolean),
    primary: { label: `搬这 ${moves.length} 篇` },
  });
  if (res.action !== 'primary') return null;

  const runRes = await executeRebuild(
    { app: ctx.app, kbRoot, mover: ctx.mover, fm: ctx.fm },
    planFinal,
    `整理${label}：搬走 ${moves.length} 篇`,
    /**
     * **部分搬成**（撞名 / 跳过）那条 partial 通知由 mover 弹 —— 把那枚「✦ AI 建议」
     * 一并带过去（P7.11 · #13：两条通知都给出口；不这么传的话 mover 那层根本不知道
     * 整理建议面板是什么）。
     */
    [
      {
        label: '✦ AI 建议',
        run: () => {
          if (!ctx.ai.isConfigured()) {
            notifyLight(AI_NOT_CONFIGURED);
            return;
          }
          openSuggestPanel(ctx, { scope: INBOX, autoAi: true });
        },
      },
    ],
  );
  const r = runRes.result;
  if (r.error) {
    notifyError('整理已中止（一个文件都没动）', r.error);
    return { moves: [] };
  }
  /**
   * 「补「文件位置」」档的落盘（P7.12 · #9/#11 的补的一课，判据抓出来的）：
   * AI 给**没声明的**笔记挑的值在叠加层里只是本轮"拟声明" ——
   * `executeRebuild` 的补声明只盖 `fallback/collect` 档、mover 第 7 步又只跟
   * "本来就有的声明"，两条都盖不到这条路 → 这里用**同一份** `writeDeclaredForMoved` 补写。
   * 改声明档不用管：它们本来就有声明，mover 第 7 步会跟着更新。
   */
  const needDecl = r.moved.filter((m) => aiChips.has(m.from) && !aiChips.get(m.from)?.warn);
  if (needDecl.length > 0) {
    const w: string[] = [];
    await writeDeclaredForMoved(
      { app: ctx.app, fm: ctx.fm },
      needDecl,
      (m) => relativeTo(parentDir(m.to), kbRoot),
      w,
    );
    runRes.warnings.push(...w);
    /**
     * ⚠️ 独立审 C3（P7.12 收尾）：与 `ui/suggest-panel.ts` 的补声明路**同一口径** ——
     * 自己写的声明要登记成"上次看见的"，免得下一轮 tick 把自写当"用户显式改"再搬一次。
     * （当下推演无可见副作用：写的是"新位置 = 实际位置"，下一轮本就会跳过；登记是为了
     * 两条补声明路口径一致，别让下一处改动的差异藏在这里。）
     */
    for (const m of needDecl) {
      ctx.reconcile.noteSelfDeclared(m.to, [relativeTo(parentDir(m.to), kbRoot)]);
    }
  }
  // ⚠️ 纯成功的汇总**不再由 mover 另发一条**（整理走 `executeRebuild`，请求传了 `quiet`，
  // P7.0a 批 1⑦）：用户看到的回执就是下面这条撤销条；partial 仍由 mover 弹（它才说得出原因）。
  // 批量搬动最需要一键回滚，而快照 id 只有这条链上的人知道
  /**
   * 「补尾链」（P7.12 · #9/#11 流程的收尾段）：**搬后**按新位置补 —— 尾链里的
   * 「所属中心 / 返回大地图」取决于它现在住哪，搬前补必然指错。只补 AI 预整理动过、
   * 且真搬成了的那批；只加不删（`ui/organize.ts` 共用链）。
   * 自己的快照照拍（`quiet` 不弹条）—— 撤销条仍是搬动那条：快照**还原内容**，
   * 一次还原把这轮尾链与「文件位置」一起带回去。
   */
  const aiMoved = r.moved.filter((m) => aiChips.has(m.from));
  let tailFilled = 0;
  if (aiMoved.length > 0) {
    const tp = await topUpTails(ctx, aiMoved.map((m) => m.to), {
      action: '一键整理：补尾链',
      source: 'rebuild',
      quiet: true,
      reasonLabel: '一键整理：补尾链',
    });
    tailFilled = tp.filled;
  }
  if (r.snapshotId) {
    showUndo({
      text: `已整理${label}：搬走 ${r.moved.length} 篇${tailFilled > 0 ? `（含补尾链 ${tailFilled} 篇）` : ''}`,
      detail: '撤销 = 从操作前的快照还原（含逆 rename 与属性）',
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
      onExpire: () => {
        notifyLight('撤销条已过期', '仍可在快照面板里还原');
      },
    });
  }
  if (runRes.warnings.length > 0) {
    notifyLight('有几篇没跟上', listBrief(runRes.warnings, 2));
  }
  /**
   * #17 验收口径（2026-10-06 拍定）：设计内排除的（模板 / 结构性笔记不参与归位）
   * **在通知里点名** —— 原来只有确认单与「0 可搬」那里一句泛话，跑完就看不见了。
   */
  const excludedNames = [...structuralSkippedList, ...tplSkippedList].map((n) => n.basename);
  if (excludedNames.length > 0) {
    const bits: string[] = [];
    if (structuralSkippedList.length > 0) bits.push(`结构性笔记 ${structuralSkippedList.length} 篇`);
    if (tplSkippedList.length > 0) bits.push(`模板 ${tplSkippedList.length} 篇`);
    notifyLight(`${bits.join(' · ')}不参与归位（设计内）`, listBrief(excludedNames, 2));
  }
  return { moves: r.moved.map((m) => m.to) };
}

/**
 * 预览行（P7.10 · #9：**逐篇** —— 《名》→ 落点）。
 *
 * 原先按目录聚合（"00_Inbox 里 12 篇 → 02_Areas"）—— 用户看不出"具体哪篇去哪"
 * （FB2-现状-7：预览只说"里 N 篇"，真正逐条的清单挤在下面那个蓝块里）。
 * 折叠统一交给 `ui/confirm.ts` 的预览上限（12 行 + "…还有 N 篇"）——
 * 这里不再自己切一刀（原 `LIST_CAP` 那套退役；"确认流里不摊 40 行"的口径移到了那边）。
 */
function targetRows(moves: RebuildMove[], chips?: Map<string, { text: string; warn?: boolean }>): PlanRow[] {
  return moves.map((m) => ({
    kind: 'move' as const,
    from: `《${stripExt(baseName(m.from))}》`,
    to: m.dirRel,
    count: 1,
    // 「AI 预整理」行尾徽标（#9/#11）：这篇的「文件位置」是 AI 出/改的，明写在这张单上
    chip: chips?.get(m.path),
  }));
}
