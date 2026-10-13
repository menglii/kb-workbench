/**
 * ui/rebuild-panel.ts —— **库体检**面板（P5 起叫「重排库结构」；**P7.12 · R6/R7 改名 + 三块式重设计**）
 *
 * 一句话（R6 的口径）：你的库"应该长什么样"记在 `库结构.json`（图纸）里 ——
 * 这个面板就是拿图纸对照实际、**把笔记搬回该去的位置**的那台机器。
 *
 * 四个操作（§6）：**重新检查（只读，可反复点）· 开始纠偏（走确认流）· 还原（快照面板）· 关闭**。
 * 形状照 `ui/migrate-panel.ts`（真机验过的那一套）：只读预演 → 确认流 → 快照 → 执行 → 报告 → 可还原。
 *
 * 界面（R7 三块式，照演示稿 §R7；**逻辑零改，版面 + 文案**）：
 *   ① **体检范围与标准** —— 范围（全库 / 某目录 = `planRebuild` 的 `scopeDir`）·
 *      标准（基础 / 完整 / 自定义预设）· 「看目录结构示意」（点标准即展开：画骨架的树）·
 *      「重新检查」（原来的「生成预览」）；
 *   ② **问题清单** —— 一句总述（查完了：N 篇该搬 · M 个目录要建 · K 处要你拿主意，其余 W 篇不动）
 *      ＋ 三组可折叠：**会做的 / 要你拿主意 / 不动的**（每行"哪篇 → 去哪"；要你拿主意的每行一个「打开」出口）；
 *   ③ **执行方式** —— **常规纠偏 ◉ / 归拢重整 ○**（单选，原「收拢旧笔记」开关）＋
 *      **顺手补建**：☐ 索引页 ☐ 示例笔记（原两个开关）＋ 只读承诺一行。
 *
 * 左边仍是**真树 + 每节点状态徽标（新建 / 搬入 N / 撞名 N）**（树头改叫「目标结构」）。
 * 骨架来自**库内** `99_Meta/06_工作台/库结构.json`（不是硬编码）——面板只读它；
 * 要改骨架就改那个文件（面板里给了一条「打开库结构.json」的捷径）。
 *
 * ── P7.2b（库框架轮）：预设下拉；P7.11 · #14：开关搬进右栏「这次怎么算」带 ──
 * · 标准（原「预设」）显示按 `presetOfSkeleton()` **对表算**（手改过清单 → 自动显示「自定义」）；
 *   **切到另一档 = 确认流 → 覆写清单 → 预览重算**（覆写走 `withPreset()`）。
 *
 * ⚠️ **本面板一行文件都不自己动**：
 *   · 目录 / 文件 → `services/rebuild.ts` 的 `executeRebuild` → **一次 `mover.move()`**
 *   · 动库前的确认 → `ui/confirm.ts`
 *   · 落盘 → `ctx.configs` / `ctx.report`（既有链路）
 *
 * 🔴 预览**不动任何文件**，但会写一条「重排预览」的操作日志（§6 的「落点」那一栏）——
 * 只在"这一份计划还没记过、且真的有事要做"时写（反复点同一份预览不刷屏）。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { baseName, joinPath, parentDir, relativeTo } from '../core/paths';
import { seedContentOf, skeletonPresets, type SkeletonPreset } from '../core/config-files';
import { debounce, sleep, stamp } from '../core/util';
import { fallbackDir, readRouteTable } from '../services/routes';
import {
  buildTree,
  collectDirOf,
  detectCollisions,
  executeRebuild,
  listBrief,
  normalizeSkeleton,
  planCollect,
  planCounts,
  planRebuild,
  planSummary,
  presetOfSkeleton,
  rebuildNotesOf,
  vaultShapeOf,
  withPreset,
  type PlanCounts,
  type RebuildCollision,
  type RebuildMove,
  type RebuildNode,
  type RebuildNote,
  type RebuildPlan,
} from '../services/rebuild';
import { btn, clear, div, el, span } from './primitives';
import { confirm, type PlanRow } from './confirm';
import { openModal, type PanelHandle } from './panel';
import { notifyError, notifyInfo, notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';
import {
  SAMPLE_PREFIX,
  SAMPLE_SECTION_ID,
  sampleBoardSection,
  sampleNotes,
} from '../services/library-samples';

/** 一行里最多列几条（再长就折成"…还有 N 条"，面板不是日志） */
const LIST_CAP = 12;

export function openRebuildPanel(ctx: WorkbenchContext): PanelHandle {
  const h = openModal({
    title: '库体检',
    // R7（13:18 拍定）：**标题下的小字直接去掉** —— "它是什么"由三块结构与设置入口说明承担
    width: 'wide',
  });

  const kbRoot = ctx.settings.kbRoot();
  const metaDir = ctx.settings.get().metaDir;
  const cfgPath = ctx.configs.pathOf('rebuild');

  let plan: RebuildPlan | null = null;
  let collisions: RebuildCollision[] = [];
  /** 预览是否已经算出来过（没算出来之前别把界面画成"没有要做的"） */
  let painted = false;
  let busy = false;
  let lastRun: string | null = null;
  /** 上一份写进日志的预览（同一份不重复写） */
  let lastLogged = '';
  /**
   * P7.2b 的两个选项（**面板会话内状态**，不落盘 —— 它们是一次性动作的选项，
   * 不是"这个库该怎么待着"的偏好）。种子页默认开（初始化档的默认形态）。
   */
  let collectOn = false;
  let seedsOn = true;
  /** 「放示例数据」（16.2）：默认关 —— 演示数据是可选件，别往正经库里塞 */
  let samplesOn = false;
  /** 库根下 `.md` 数 == 0（G3-⑤ 拍板）→ **初始化档**（空库进来时的默认形态） */
  let initMode = false;
  /**
   * R7 · ①「体检范围」：`''` = 全库，否则是**相对库根**的目录（喂 `planRebuild` 的 `scopeDir`）。
   * ⚠️ 归拢重整（`collectOn`）是**全库大动作**，范围对它无效 —— 那时选择器置灰写原因。
   */
  let rangeDir = '';
  /** 上一次预览拿到的"库里已存在目录"（① 的范围下拉用它出选项） */
  let allDirs: string[] = [];
  /** 上一次预览喂进 `planRebuild` 的笔记（"其余 N 篇不动"要按它现算） */
  let notesAll: RebuildNote[] = [];
  /** ①「看目录结构示意」展开态（点标准也会展开） */
  let showSkeleton = false;
  /** ②三组的折叠态（面板会话内记忆 —— 重画不把它忘了） */
  const openGrp = { do: true, decide: true, keep: false };
  /** ① 的「重新检查」按钮（每次重画重建 —— 忙态要现刷到新那枚上） */
  let recheckBtn: HTMLButtonElement | null = null;

  /** 今天（归集夹名与种子页日期共用一处）—— `stamp()` 是 `YYYYMMDD-HHmmss`，取前 8 位即日期 */
  const todayStamp = (): string => stamp().slice(0, 8);
  const todayISO = (): string => {
    const d = todayStamp();
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  };

  const layout = div({ cls: 'kbw-rb' });
  const treeBox = div({ cls: 'kbw-rb-tree' });
  const sideBox = div({ cls: 'kbw-rb-side' });
  layout.appendChild(treeBox);
  layout.appendChild(sideBox);
  h.body.appendChild(layout);

  // ── 脚：三个操作（§6；「重新检查」按 R7 移进 ① 那一带）─────────
  const runBtn = btn({ cls: 'kbw-btn is-primary', text: '开始纠偏', on: { click: () => void run() } });
  const restoreBtn = btn({
    cls: 'kbw-btn',
    text: '还原…',
    attr: { title: '打开快照面板 —— 重排过的都能从操作前的快照还原' },
    on: {
      click: () => {
        /**
         * 🔴 **执行期间不许开还原**（独立审查 🟡3）：`busy` 原先只挡 run/preview ——
         * 一次重排还在搬文件时点这里会开快照面板、进而**启一次 `snapshot.restore()`**，
         * 两个动库流程并发动同一批文件（不丢数据，但会停在"搬了一半又被搬回去一半"的混合态）。
         * ⚠️ 光靠 `disabled` 拦不住：**离线用例与探针都走 `dispatchEvent`，而它不吃 `disabled`**
         *（`ui/migrate-panel.ts` 那一段记过这条），所以这里必须显式判。
         */
        if (busy) {
          notifyLight('正在执行', '等这一轮做完再还原');
          return;
        }
        // 先关自己再开快照面板：两个模态叠着的话，"点外面关掉"会先关到上面那层
        h.close('restore');
        ctx.openSnapshotPanel();
      },
    },
  });
  h.foot.appendChild(restoreBtn);
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '关闭', on: { click: () => h.close('close') } }));
  h.foot.appendChild(runBtn);

  /** 忙态要刷到的一枚按钮（统一处置；`重新检查` 每次重画重建，所以现取引用） */
  function applyBusy(el: HTMLElement | null, b: boolean): void {
    if (!el) return;
    el.classList.toggle('is-disabled', b);
    el.toggleAttribute('disabled', b);
    if (b) el.setAttribute('title', '正在执行，等它做完');
    else el.removeAttribute('title');
  }

  /**
   * 执行期间的护栏（🟡3）：把**四个操作**统一处置 ——「重新检查」「还原…」「开始纠偏」置灰 + 写出原因，
   * 「关闭」留着（用户任何时候都该能关掉界面）。不可用要说清为什么，不玩"点了没反应"。
   */
  function setBusy(b: boolean): void {
    busy = b;
    applyBusy(recheckBtn, b);
    applyBusy(restoreBtn, b);
    applyBusy(runBtn, b);
    // 恢复时按计划重写执行按钮的文案与可用态（paintSide 里那一份是唯一出处）
    if (!b && painted && plan) paintSide();
  }

  // ── 算一份计划（**只读**）─────────────────────────────────────
  async function previewState(): Promise<{ plan: RebuildPlan; collisions: RebuildCollision[] }> {
    // 谁的期谁负责第一次落盘：库结构.json 是 P5 的文件
    const raw = await ctx.configs.ensure('rebuild');
    const skeleton = normalizeSkeleton(raw);
    const shape = await vaultShapeOf(ctx.app, kbRoot);
    // G3-⑤（拍板）：库根下 `.md` 数 == 0 才算空库（附件不算）—— 空库进来 = 初始化档
    const mdCount = [...shape.files].filter((f) => /\.md$/i.test(f)).length;
    initMode = mdCount === 0;
    if (initMode) collectOn = false; // 空库没有可收拢的（开关也不画）
    const routes = await readRouteTable(ctx.app, ctx.settings);
    const notes = notesOf(ctx, kbRoot);
    /** ① 的两个缓存：「范围」下拉的候选 / "其余 N 篇不动"的分母（都吃**这一次**的库现状） */
    notesAll = notes;
    allDirs = Array.from(shape.dirs)
      .filter((d) => d !== '')
      .sort((a, b) => a.localeCompare(b, 'zh'));
    let p = planRebuild({
      skeleton,
      kbRoot,
      metaDir,
      existingDirs: shape.dirs,
      exists: shape.exists,
      notes,
      /**
       * R7 · ①「范围 = 空间的哪一片」：喂给规划器现成的 `scopeDir`（一键整理同款 ——
       * 候选收窄到"现在住在这片区域里"的笔记）。**归拢重整不受范围约束**（全库大动作）。
       */
      scopeDir: collectOn ? null : rangeDir || null,
      fallbackDir: fallbackDir(routes.table, kbRoot),
    });
    // 收拢模式：计划换成「收拢全部文件 + 照预设补骨架」（声明路由这一趟不跑）
    if (collectOn) p = composeCollect(p, shape.files, notes);
    /**
     * 初始化 / 收拢补骨架：按开关把缺的种子页填成 `newFiles`（**预览只是填进计划对象**，
     * 不碰盘）；**重排模式维持 P5 的"只报不建"**（`newFiles` 恒空）。
     */
    if ((initMode || collectOn) && seedsOn) fillSeeds(p);
    // 示例数据（16.2）：同样的"进计划、不碰盘"——执行时才由 mover 创建（进快照）
    if ((initMode || collectOn) && samplesOn) fillSamples(p);
    // 撞名自查也是**只读**（`cachedRead`）—— 判据与 mover 同源：内容相同 = 已搬过
    const cl = await detectCollisions(p.moves, {
      exists: (path) => ctx.app.vault.getAbstractFileByPath(path) != null,
      read: async (path) => {
        const f = ctx.app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? await ctx.app.vault.cachedRead(f) : null;
      },
    });
    return { plan: p, collisions: cl };
  }

  /**
   * 收拢模式下的合成计划：`moves` 全部换成收拢搬动（全部文件 → 归集夹，按原相对路径）、
   * `newDirs` 并入归集夹要建的目录、声明路由的产物（pending / undeclared）清空。
   *
   * ⚠️ 种子页的"缺没缺"按**收拢后**重算：被收拢走的种子（如 `00_Inbox/_收件箱.md`）
   * 在补骨架时算"缺"（按开关重建到原位）；`99_Meta` 里的种子没被收拢 → 维持原判。
   */
  function composeCollect(rb: RebuildPlan, files: Set<string>, notes: RebuildNote[]): RebuildPlan {
    const cp = planCollect({
      kbRoot,
      files,
      metaDir,
      excludedTop: rb.skeleton.excludedTop,
      collectDir: collectDirOf(todayStamp()),
    });
    /**
     * ⚠️ `planCollect` 只认文件系统、看不见前言 —— **「位置锁定」在这里补回来**
     * （P7.2b 独立审查 🟡5）：收拢是全库搬动，恰恰最该在确认流里说
     * 「N 篇设了「位置锁定」，将一并移动」（§6.1/§6.2 的承诺，锁只挡自动、不挡显式）。
     */
    const lockedByPath = new Map(notes.map((n) => [n.path, n.locked]));
    const moves = cp.moves.map((mv) => ({ ...mv, locked: lockedByPath.get(mv.path) ?? false }));
    const movedRels = new Set(cp.moves.map((m) => relativeTo(m.from, kbRoot)));
    const seedMissing = rb.skeleton.seedFiles.filter(
      (s) => rb.seedMissing.includes(s) || movedRels.has(s),
    );
    const seedPresent = rb.skeleton.seedFiles.filter((s) => !seedMissing.includes(s));
    const newDirs = [...new Set([...rb.newDirs, ...cp.newDirs])].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    );
    return {
      ...rb,
      moves,
      pending: [],
      undeclared: [],
      newDirs,
      seedMissing,
      seedPresent,
      collectSkipped: cp.skipped,
    };
  }

  /**
   * 种子页开关 → `plan.newFiles`：把 `seedMissing` 里**有收录内容**的填成待建文件
   * （内容来自 `core/config-files.ts` 的 `seedContentOf`，与预设清单同一个家）。
   * ⚠️ 没收录内容的种子**不创建**（骨架被人手加过 seedFiles 的边角）—— 只填能填的。
   */
  function fillSeeds(p: RebuildPlan): void {
    const files = [...(p.newFiles ?? [])];
    for (const rel of p.seedMissing) {
      const content = seedContentOf(rel, todayISO());
      if (!content) continue;
      files.push({ path: joinPath(kbRoot, rel), content });
    }
    p.newFiles = files;
  }

  /**
   * 示例数据开关 → `plan.newFiles`（同上：只填计划、不碰盘）。
   * 已在库里的示例**跳过**（幂等：放过一次不会再叠；要重来先「清掉示例数据」）。
   */
  function fillSamples(p: RebuildPlan): void {
    const files = [...(p.newFiles ?? [])];
    for (const s of sampleNotes(kbRoot, todayISO())) {
      if (ctx.app.vault.getAbstractFileByPath(s.path)) continue;
      if (files.some((f) => f.path === s.path)) continue;
      files.push(s);
    }
    p.newFiles = files;
  }

  async function preview(writeLog: boolean): Promise<void> {
    if (busy) {
      if (writeLog) notifyLight('重排正在执行', '等这一轮做完再生成预览');
      return;
    }
    busy = true;
    try {
      const st = await previewState();
      plan = st.plan;
      collisions = st.collisions;
      painted = true;
      paintTree();
      paintSide();
      if (writeLog) await logPreview();
    } catch (e) {
      // 防御：真抛出来时别让面板永远停在「正在读…」
      console.error('[经纬] 重排预览失败', e);
      painted = true;
      const msg = e instanceof Error ? e.message : String(e);
      // 左树也要认这个错 —— 只置 painted 的话它会一直停在"正在读库结构.json…"（假装还在加载）
      paintTree(msg);
      paintSide(msg);
    } finally {
      busy = false;
    }
  }

  /** 预览报告（§6 的落点：`99_Meta/05_操作日志/`）。同一份计划只写一次，且无事可做时不写。 */
  async function logPreview(): Promise<void> {
    if (!plan) return;
    const c = planCounts(plan, collisions);
    // 同 paintSide 的 nothing：**只建文件**也是"有事要做"，漏了它这类计划不落预览日志
    if (c.newDirs + c.moved + c.pending + c.blocked + (plan.newFiles?.length ?? 0) === 0) return;
    const key = planKey(plan, collisions);
    if (key === lastLogged) return;
    lastLogged = key;
    const logged = await ctx.report.log({
      action: '重排预览',
      result: c.blocked + c.pending > 0 ? 'partial' : 'ok',
      source: 'rebuild',
      summary: `预览（只读，没动任何文件）：${planSummary(plan, collisions)}`,
      moves: plan.moves.map((m) => ({ from: m.from, to: m.to })),
      rows: previewRows(plan),
      blocked: collisions
        .filter((x) => x.kind === 'blocked')
        .map((x) => ({ path: x.path, why: x.note })),
      already: collisions.filter((x) => x.kind === 'already').map((x) => x.path),
      extra: `骨架：\`${cfgPath}\``,
    });
    if (!logged) notifyLight('预览报告没写进库', '（面板里的预览照常，见控制台）');
  }

  // ── 左边的树（决策 17；P7.11 · #14 徽标减噪）─────────────────
  function paintTree(err?: string): void {
    clear(treeBox);
    if (err) {
      treeBox.appendChild(div({ cls: 'kbw-rb-warn', text: `预览失败：${err}` }));
      return;
    }
    if (!painted || !plan) {
      treeBox.appendChild(div({ cls: 'kbw-rb-empty', text: '正在读库结构.json…' }));
      return;
    }
    const root = buildTree(plan, collisions);
    const head = div({ cls: 'kbw-rb-treehead' });
    head.appendChild(span({ cls: 'kbw-rb-treetitle', text: '目标结构' }));
    head.appendChild(
      span({
        cls: 'kbw-rb-treeroot',
        text: root.name,
        title: `库根：${kbRoot || '整个库'}${plan.rootMismatch ? `（骨架里写的是「${plan.rootMismatch.declared}」）` : ''}`,
      }),
    );
    // ⚠️ 骨架档下拉**上移到右栏「这次怎么算」带**（P7.11 · #14：输入在结果上面）——
    // 别再加回树头。
    head.appendChild(
      span({
        cls: 'kbw-rb-count',
        text: `${plan.skeleton.dirs.length} 个目录 · ${plan.skeleton.seedFiles.length} 个种子文件`,
      }),
    );
    treeBox.appendChild(head);
    if (plan.rootMismatch) {
      treeBox.appendChild(
        div({
          cls: 'kbw-rb-warn',
          text: `⚠️ 骨架里的库根名是「${plan.rootMismatch.declared}」，当前库根是「${plan.rootMismatch.actual || '整个库'}」—— 面板仍按当前库根算，但对不上通常是配置没跟着库一起搬过`,
        }),
      );
    }
    const nodes = div({ cls: 'kbw-rb-nodes' });
    for (const child of root.children) nodes.appendChild(nodeRow(child, 1));
    treeBox.appendChild(nodes);
    // 树底图例（P7.11 · #14 起有一行说清"灰行是什么"；R7 文案对表：改成"图纸里没有的"口径）
    treeBox.appendChild(div({ cls: 'kbw-rb-legend', text: '灰色 = 图纸里没有的目录（保留不动）' }));
    // 库根自己收到东西（声明成了 ''）—— 计划里几乎不会出现（空串在 `asList` 就被滤掉了），
    // 但树上别装作没看见：画出来，总比"徽标说不清它去了哪"好
    for (const m of root.incoming) {
      treeBox.appendChild(
        div({ cls: 'kbw-rb-leaf', css: { '--kbw-depth': '1' }, attr: { title: `${m.from} → ${m.to}` } },
          span({ cls: 'kbw-rb-leafname', text: baseName(m.from) }),
          span({ cls: 'kbw-rb-leafwhy', text: m.note })),
      );
    }
  }

  /**
   * **预设下拉**（P7.2b；P7.11 · #14 从树头上移到「这次怎么算」带）：
   * 值 = `presetOfSkeleton()` 对表算出的当前档（不看文件里的标记 ——
   * 手改过清单的文件会正确显示「自定义」）。选另一档 = 确认流 → `withPreset` 覆写 →
   * `configs.write`（面板上面接了 `configs.watch('rebuild')` → 预览自动重算）。
   */
  function presetSelect(p: RebuildPlan): HTMLElement {
    const cur = presetOfSkeleton(p.skeleton);
    const sel = el('select', {
      cls: ['kbw-select', 'kbw-rb-preset'],
      attr: {
        title: '标准：切换 = 把目录 / 种子页清单覆写成该档（先确认；执行前照旧先预览）',
        'aria-label': '体检标准',
      },
    });
    for (const [val, label] of [
      ['basic', '基础'],
      ['full', '完整'],
      ['custom', '自定义'],
    ] as const) {
      sel.appendChild(el('option', { attr: { value: val }, text: label }));
    }
    sel.value = cur;
    sel.addEventListener('change', () => {
      // R7（13:18）：点标准即展开目录结构示意（先把示意打开，再走原有的覆写确认）
      showSkeleton = true;
      void applyPreset(sel, cur).then(() => paintSide());
    });
    return sel;
  }

  async function applyPreset(sel: HTMLSelectElement, cur: SkeletonPreset): Promise<void> {
    const want = sel.value;
    if (want === cur) return;
    if (busy) {
      sel.value = cur;
      return;
    }
    if (want !== 'basic' && want !== 'full') {
      // 「自定义」没有清单可覆写 —— 它只是"手改过"的对表结果。拨回 + 说一句，别留迷惑。
      sel.value = cur;
      notifyLight('「自定义」= 手改过的清单', '想回某一档：直接选「基础版」/「完整版」');
      return;
    }
    const P = skeletonPresets()[want];
    const label = want === 'basic' ? '基础版' : '完整版';
    const res = await confirm({
      title: `把骨架清单覆写成「${label}」？`,
      preview: [],
      warnings: [],
      notes: [
        `覆写后：${P.dirs.length} 个目录、${P.seedFiles.length} 个种子页`,
        '只换清单、不删库里任何目录 —— 执行时按清单「只加不删」地补',
        '改完立即重算预览；真正执行照旧先预览再确认',
      ],
      primary: { label: `覆写成「${label}」` },
    });
    if (res.action !== 'primary' || !plan) {
      sel.value = cur;
      return;
    }
    await ctx.configs.write('rebuild', withPreset(plan.skeleton, want));
    // `configs.watch('rebuild')` 的防抖重算会跟上；这里再显式跑一遍，反馈更快
    await preview(false);
  }

  // ── 右栏三块（R7 · 照 §R7 稿；**逻辑零改 —— 版面 + 文案**）────────
  /**
   * ① **体检范围与标准**：范围（全库 / 某目录）· 标准（原「骨架档」）·
   * 「看目录结构示意」（点标准也会展开）·「重新检查」（原「生成预览」）。
   */
  function block1(p: RebuildPlan): HTMLElement {
    const box = div({ cls: 'kbw-rb-plan' });
    box.appendChild(div({ cls: 'kbw-rb-planhead', text: '① 体检范围与标准' }));
    const row = div({ cls: 'kbw-rb-band' });
    const rangeWrap = span({ cls: 'kbw-rb-pick' });
    rangeWrap.appendChild(span({ cls: 'kbw-rb-pickname', text: '范围：' }));
    rangeWrap.appendChild(rangeSelect());
    row.appendChild(rangeWrap);
    const presetWrap = span({ cls: 'kbw-rb-pick' });
    presetWrap.appendChild(span({ cls: 'kbw-rb-pickname', text: '标准：' }));
    presetWrap.appendChild(presetSelect(p));
    row.appendChild(presetWrap);
    const skelToggle = span({
      cls: ['kbw-rb-skelpick', showSkeleton ? 'is-on' : null],
      text: showSkeleton ? '▾ 收起目录结构示意' : '▾ 看目录结构示意',
      attr: { role: 'button', tabindex: '0' },
      on: {
        click: () => {
          showSkeleton = !showSkeleton;
          paintSide();
        },
        keydown: (evt) => {
          const k = (evt as KeyboardEvent).key;
          if (k === 'Enter' || k === ' ') {
            evt.preventDefault();
            showSkeleton = !showSkeleton;
            paintSide();
          }
        },
      },
    });
    row.appendChild(skelToggle);
    row.appendChild(div({ cls: 'kbw-spacer' }));
    recheckBtn = btn({
      cls: ['kbw-btn', 'is-small', 'kbw-rb-recheck'],
      text: '重新检查',
      attr: { title: '只读：照现在的库重新算一遍（可反复点）' },
      on: { click: () => void preview(true) },
    });
    applyBusy(recheckBtn, busy);
    row.appendChild(recheckBtn);
    box.appendChild(row);
    if (showSkeleton) box.appendChild(skelTree(p));
    if (initMode) {
      box.appendChild(
        div({ cls: 'kbw-rb-acthint', text: '空库（库根下 0 篇 .md）→ 初始化档：只建骨架，搬入恒 0' }),
      );
    } else if (collectOn && p.moves.length === 0) {
      box.appendChild(div({ cls: 'kbw-rb-acthint', text: '没有可收拢的文件' }));
    }
    return box;
  }

  /** ① 的范围下拉：全库 / 库里各个目录（相对库根口径，与树同源） */
  function rangeSelect(): HTMLElement {
    const sel = el('select', {
      cls: ['kbw-select', 'kbw-rb-range'],
      attr: { title: '查哪儿：全库 / 某个目录', 'aria-label': '体检范围' },
    });
    sel.appendChild(el('option', { attr: { value: '' }, text: '全库' }));
    for (const d of allDirs) sel.appendChild(el('option', { attr: { value: d }, text: d }));
    sel.value = rangeDir;
    if (collectOn) {
      sel.toggleAttribute('disabled', true);
      sel.setAttribute('title', '归拢重整是全库大动作 —— 范围固定全库');
    }
    sel.addEventListener('change', () => {
      if (busy) {
        sel.value = rangeDir;
        return;
      }
      rangeDir = sel.value;
      void preview(false);
    });
    return sel;
  }

  /** ① 的示意树：这份**标准**（图纸）包含哪些目录（浅→深、按层缩进）+ 索引页一句 */
  function skelTree(p: RebuildPlan): HTMLElement {
    const box = div({ cls: 'kbw-rb-skel' });
    const head = div({ cls: 'kbw-rb-skelhead' });
    const label = { basic: '基础版', full: '完整版', custom: '自定义' }[presetOfSkeleton(p.skeleton)];
    head.appendChild(span({ cls: 'kbw-rb-skelname', text: `${label}的结构` }));
    head.appendChild(span({ cls: 'kbw-rb-skelhint', text: '（点标准即展开，直接画成树；示意）' }));
    box.appendChild(head);
    for (const d of p.skeleton.dirs) {
      const depth = d.split('/').length;
      box.appendChild(
        div({
          cls: 'kbw-rb-skelrow',
          css: { '--kbw-depth': String(depth) },
          text: d.split('/').pop() ?? d,
          attr: { title: d },
        }),
      );
    }
    if (p.skeleton.seedFiles.length > 0) {
      box.appendChild(
        div({
          cls: 'kbw-rb-skelseed',
          text: `+ ${p.skeleton.seedFiles.length} 个索引页（各目录的中心页）`,
        }),
      );
    }
    return box;
  }

  /** ② **问题清单**：一句总述 + 三组可折叠（会做的 / 要你拿主意 / 不动的） */
  function block2(p: RebuildPlan, c: PlanCounts, blocked: RebuildCollision[]): HTMLElement {
    const box = div({ cls: 'kbw-rb-block' });
    box.appendChild(div({ cls: 'kbw-rb-blockhead', text: '② 问题清单' }));
    const decideN = p.pending.length + blocked.length;
    const untouched = untouchedCount(p);
    const sent = div({ cls: 'kbw-rb-sumsent' });
    sent.appendChild(
      el('b', { text: `查完了：${c.moved} 篇该搬 · ${c.newDirs} 个目录要建 · ${decideN} 处要你拿主意` }),
    );
    sent.appendChild(span({ cls: 'kbw-rb-sumrest', text: `，其余 ${untouched} 篇不动` }));
    box.appendChild(sent);
    if (lastRun) box.appendChild(div({ cls: 'kbw-rb-last', text: lastRun }));

    // ── 会做的（执行时真动的）——总是画，空段给一句结论 ──
    const newFilesN = p.newFiles?.length ?? 0;
    const nothing = c.newDirs + c.moved + c.pending + c.blocked + c.already + newFilesN === 0;
    const willCreateSeeds = (initMode || collectOn) && seedsOn;
    const madeSeeds = new Set((p.newFiles ?? []).map((f) => relativeTo(f.path, kbRoot)));
    collapsibleGroup(
      box,
      'is-do',
      'do',
      `会做的（${c.moved} 篇 + ${c.newDirs} 个目录${newFilesN > 0 ? ` + ${newFilesN} 个文件` : ''}）`,
      '按声明搬 · 每行「哪篇 → 去哪」',
      (body) => {
        let n = 0;
        const put = (row: HTMLElement): void => {
          body.appendChild(row);
          n += 1;
        };
        for (const d of p.newDirs.slice(0, LIST_CAP)) put(grpRow('新建目录', d, `将新建目录 ${d}`));
        if (p.newDirs.length > LIST_CAP) put(div({ cls: 'kbw-rb-row is-more', text: `…还有 ${p.newDirs.length - LIST_CAP} 条` }));
        for (const f of (p.newFiles ?? []).slice(0, LIST_CAP)) {
          put(grpRow(relativeTo(f.path, kbRoot), '执行时创建', '执行时创建（进快照 newFiles，还原删得掉）'));
        }
        if (willCreateSeeds) {
          for (const s of p.seedMissing.slice(0, LIST_CAP)) {
            put(grpRow(s, madeSeeds.has(s) ? '执行时创建' : '只报不建'));
          }
        }
        for (const m of p.moves.slice(0, LIST_CAP)) {
          put(grpRow(baseName(m.from), `→ ${m.dirRel}`, `${m.from} → ${m.to}\n${m.note}`));
        }
        if (p.moves.length > LIST_CAP) {
          put(div({ cls: 'kbw-rb-row is-more', text: `…还有 ${p.moves.length - LIST_CAP} 条` }));
        }
        if (n === 0) {
          body.appendChild(
            grpEmpty(
              nothing
                ? lastRun
                  ? '重跑预览：0 篇要搬 ✅（幂等）'
                  : '没有要做的事：目录齐、笔记也都在该在的地方 ✅'
                : '这次没有要新建 / 搬入的',
            ),
          );
        }
      },
    );

    // ── 要你拿主意（待定 / 真冲突）——每行一句话 + 一个出口 ──
    collapsibleGroup(
      box,
      'is-warn',
      'decide',
      `要你拿主意（${decideN} 处）`,
      '每行一句话 + 一个出口',
      (body) => {
        let n = 0;
        for (const pd of p.pending.slice(0, LIST_CAP)) {
          body.appendChild(rowWithOpen(baseName(pd.path), pd.why, pd.path, `${pd.rel}\n${pd.why}`));
          n += 1;
        }
        if (p.pending.length > LIST_CAP) {
          body.appendChild(div({ cls: 'kbw-rb-row is-more', text: `…还有 ${p.pending.length - LIST_CAP} 条` }));
        }
        for (const x of blocked.slice(0, LIST_CAP)) {
          body.appendChild(rowWithOpen(baseName(x.path), `→ ${x.to}`, x.path, x.note));
          n += 1;
        }
        if (blocked.length > LIST_CAP) {
          body.appendChild(div({ cls: 'kbw-rb-row is-more', text: `…还有 ${blocked.length - LIST_CAP} 条` }));
        }
        if (n === 0) body.appendChild(grpEmpty('没有要你定的'));
      },
    );

    // ── 不动的（点开看名单）──
    collapsibleGroup(
      box,
      'is-keep',
      'keep',
      `不动的（${untouched} 篇）`,
      '对得上 · 排除区 · 没声明且不在范围内',
      (body) => {
        let n = 0;
        const already = collisions.filter((x) => x.kind === 'already');
        if (already.length > 0) {
          body.appendChild(
            keeperRow(
              `已搬过 ${already.length} 篇（同名同内容，跳过）`,
              already.map((x) => ({ text: `${baseName(x.path)} → ${x.to}`, title: x.note })),
            ),
          );
          n += 1;
        }
        if (c.extraDirs > 0) {
          body.appendChild(
            keeperRow(
              `保留 ${c.extraDirs} 个目录（图纸里没有的）`,
              p.extraDirs.map((d) => ({ text: d, title: '只加不删：重排不会删掉任何目录' })),
            ),
          );
          n += 1;
        }
        if (!willCreateSeeds && p.seedMissing.length > 0) {
          body.appendChild(
            keeperRow(
              `骨架里少了 ${p.seedMissing.length} 个种子文件（只报不建）`,
              p.seedMissing.map((s) => ({ text: s, title: '重排不创建文件（只报不建）' })),
            ),
          );
          n += 1;
        }
        if (p.undeclared.length > 0) {
          body.appendChild(
            keeperRow(
              `另有 ${p.undeclared.length} 篇没有「文件位置」声明、也不在 Inbox —— 留在原位`,
              p.undeclared.map((r) => ({ text: r, title: '按判据留在原位不动' })),
            ),
          );
          n += 1;
        }
        if (p.collectSkipped && p.collectSkipped.length > 0) {
          body.appendChild(
            keeperRow(
              `另有 ${p.collectSkipped.length} 项在排除名单，不参与收拢`,
              p.collectSkipped.map((r) => ({ text: r, title: '99_Meta / 排除目录 / 已归集的旧笔记' })),
            ),
          );
          n += 1;
        }
        if (n === 0) body.appendChild(grpEmpty('没有只是告知的'));
      },
    );
    return box;
  }

  /** ③ **执行方式**：常规纠偏 / 归拢重整（单选）+ 顺手补建 + 只读承诺 */
  function block3(): HTMLElement {
    const box = div({ cls: 'kbw-rb-block' });
    box.appendChild(div({ cls: 'kbw-rb-blockhead', text: '③ 执行方式' }));
    radioRow(
      box,
      '常规纠偏',
      '只搬"对不上"的（默认）',
      !collectOn,
      true,
      () => {
        collectOn = false;
        void preview(false);
      },
    );
    radioRow(
      box,
      '归拢重整',
      `全部笔记与附件按原路径归到 ${collectDirOf(todayStamp())}/（全库大动作）`,
      collectOn,
      !initMode,
      () => {
        collectOn = true;
        void preview(false);
      },
    );
    if (initMode) box.appendChild(div({ cls: 'kbw-rb-acthint', text: '空库没有可归拢的 —— 只走常规纠偏' }));
    const buildRow = div({ cls: 'kbw-rb-buildrow' });
    buildRow.appendChild(span({ cls: 'kbw-rb-buildname', text: '顺手补建：' }));
    const buildEnabled = initMode || collectOn;
    const buildWhy = '只在初始化 / 归拢重整时有这一档（日常纠偏维持「只报不建」）';
    buildRow.appendChild(
      checkRow(
        '索引页（各目录的中心页）',
        seedsOn,
        (v) => {
          seedsOn = v;
          void preview(false);
        },
        buildEnabled,
        buildWhy,
      ),
    );
    buildRow.appendChild(
      checkRow(
        '放几篇示例笔记（试手用，可一键清）',
        samplesOn,
        (v) => {
          samplesOn = v;
          void preview(false);
        },
        buildEnabled,
        buildWhy,
      ),
    );
    box.appendChild(buildRow);
    box.appendChild(
      div({ cls: 'kbw-rb-footnote', text: '检查与预览全程只读；执行走确认流 + 快照，可还原。' }),
    );
    return box;
  }

  /** ② 的"要你拿主意"一行：一句话 + 一个「打开」出口（开那篇笔记，去改声明/改名） */
  function rowWithOpen(text: string, why: string, absPath: string, title: string): HTMLElement {
    const row = grpRow(text, why, title);
    const open = btn({
      cls: ['kbw-btn', 'is-small', 'is-ghost', 'kbw-rb-rowopen'],
      text: '打开',
      attr: { title: '打开这一篇（去改它的「文件位置」/ 改名）' },
      on: {
        click: () => {
          if (ctx.openNoteWindow?.(absPath)) return;
          const f = ctx.app.vault.getAbstractFileByPath(absPath);
          if (f instanceof TFile) void ctx.app.workspace.getLeaf('tab').openFile(f);
          else notifyLight('这一篇不在了', absPath);
        },
      },
    });
    row.appendChild(open);
    return row;
  }

  /** ③ 的单选行（◉/○；键盘与点击同一条路） */
  function radioRow(
    host: HTMLElement,
    label: string,
    hint: string,
    on: boolean,
    enabled: boolean,
    pick: () => void,
  ): void {
    const row = div({
      cls: ['kbw-rb-radio', on ? 'is-on' : null, enabled ? 'kbw-hover-1' : 'is-disabled'],
      attr: enabled
        ? { role: 'radio', tabindex: '0', 'aria-checked': on ? 'true' : 'false' }
        : { 'aria-disabled': 'true', title: '空库没有可归拢的' },
    });
    row.appendChild(span({ cls: 'kbw-rb-radio-dot', text: on ? '◉' : '○' }));
    row.appendChild(span({ cls: 'kbw-rb-radio-label', text: label }));
    row.appendChild(span({ cls: 'kbw-rb-radio-hint', text: ` —— ${hint}` }));
    if (!enabled) {
      host.appendChild(row);
      return;
    }
    const go = (): void => {
      if (busy || on) return;
      pick();
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (evt) => {
      const k = (evt as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        evt.preventDefault();
        go();
      }
    });
    host.appendChild(row);
  }

  /** ③ 的勾选行（☐；不可用时**置灰 + 写明原因**，不玩"点了没反应"） */
  function checkRow(
    label: string,
    on: boolean,
    onChange: (v: boolean) => void,
    enabled: boolean,
    disabledWhy: string,
  ): HTMLElement {
    const wrap = el('label', { cls: ['kbw-rb-check', enabled ? null : 'is-disabled'] });
    const input = el('input', {
      cls: 'kbw-check',
      attr: { type: 'checkbox', ...(on ? { checked: true } : {}) },
    }) as HTMLInputElement;
    if (!enabled) {
      input.toggleAttribute('disabled', true);
      wrap.setAttribute('title', disabledWhy);
    }
    input.addEventListener('change', () => {
      if (busy) {
        input.checked = on;
        return;
      }
      onChange(input.checked);
    });
    wrap.appendChild(input);
    wrap.appendChild(span({ text: label }));
    return wrap;
  }

  /** "其余 N 篇不动"的分母：这次范围内、去掉工具区与模板之后，没进 moves/pending 的那些 */
  function untouchedCount(p: RebuildPlan): number {
    const metaPrefix = `${metaDir.replace(/^\/+|\/+$/g, '')}/`;
    const scope = collectOn ? '' : rangeDir;
    let considered = 0;
    for (const n of notesAll) {
      const rel = relativeTo(n.path, kbRoot);
      if (rel.startsWith(metaPrefix)) continue;
      if (scope && !(n.dir === scope || n.dir.startsWith(`${scope}/`))) continue;
      considered += 1;
    }
    return Math.max(0, considered - p.moves.length - p.pending.length);
  }

  /** 「清掉示例数据」那一行（库里有 `__示例` 才画） */
  function samplesRow(list: { path: string; basename: string }[]): HTMLElement {
    const box = div({ cls: 'kbw-rb-act' });
    const row = div({ cls: 'kbw-rb-actrow' });
    row.appendChild(span({ cls: 'kbw-rb-actname', text: `清掉示例数据（${list.length} 篇）` }));
    row.appendChild(
      btn({
        cls: 'kbw-btn is-small',
        text: '清掉…',
        attr: { title: '按 __示例 前缀找齐 → 逐个走回收站；示例看板板块一并移除' },
        on: { click: () => void clearSamples(list) },
      }),
    );
    box.appendChild(row);
    box.appendChild(div({ cls: 'kbw-rb-acthint', text: '删除走回收站、逐个报告；「示例」看板板块一并移除' }));
    return box;
  }

  /**
   * 清掉示例数据（16.2）：**按前缀认领**（`__示例`）+ `mover.trash`（回收站 + 报告）+
   * 移除示例板块（按 id 精确认领）。坏日子也要说清楚：删失败的由 `mover.trash` 自己报
   * （partial 通知），板块没找到/没删成在这里补一句。
   */
  async function clearSamples(list: { path: string; basename: string }[]): Promise<void> {
    if (busy) {
      notifyLight('重排正在执行', '等这一轮做完再清');
      return;
    }
    const board = await ctx.configs.ensure('board');
    const sections = Array.isArray((board as { sections?: unknown }).sections)
      ? ((board as { sections: unknown[] }).sections as { id?: string }[])
      : [];
    const hasSection = sections.some((s) => s && s.id === SAMPLE_SECTION_ID);
    const res = await confirm({
      title: `清掉示例数据：${list.length} 篇笔记${hasSection ? ' + 1 个示例板块' : ''}`,
      preview: [],
      warnings: [],
      notes: [
        '删除走回收站（可恢复）；板块只是从看板配置里移除，不做其他改动',
        '只认「__示例」前缀与示例板块的 id —— 你自己改过名的示例笔记不在清理范围',
      ],
      primary: { label: `清掉这 ${list.length} 篇` },
    });
    if (res.action !== 'primary') return;
    const files = list
      .map((n) => ctx.app.vault.getAbstractFileByPath(n.path))
      .filter((f): f is TFile => f instanceof TFile);
    await ctx.mover.trash({ files, source: 'rebuild', reason: '清掉示例数据' });
    if (hasSection) {
      const next = sections.filter((s) => !(s && s.id === SAMPLE_SECTION_ID));
      await ctx.configs.write('board', { ...(board as object), sections: next });
      notifyLight('示例板块移除了', '看板配置已更新（示例板块不再显示）');
    }
    await sleep(300);
    await preview(false); // 刷新「清掉示例数据」这一行的可见性
  }

  /**
   * 示例看板板块追加（16.2）：**执行成功之后**才写（预览/确认都不是写盘时机）。
   * 幂等：已有同 id 板块就不重复追加。写在 `看板配置.json`（走 `configs`，库内可见可手改）。
   */
  async function appendSampleSection(): Promise<void> {
    const cur = await ctx.configs.ensure('board');
    const sections = Array.isArray((cur as { sections?: unknown }).sections)
      ? ((cur as { sections: unknown[] }).sections as { id?: string }[])
      : [];
    if (sections.some((s) => s && s.id === SAMPLE_SECTION_ID)) return;
    await ctx.configs.write('board', {
      ...(cur as object),
      sections: [...sections, sampleBoardSection()],
    });
  }

  function nodeRow(node: RebuildNode, depth: number): HTMLElement {
    const wrap = div({ cls: 'kbw-rb-kidwrap' });
    const row = div({
      cls: ['kbw-rb-node', node.status === 'new' ? 'is-new' : null, node.status === 'extra' ? 'is-extra' : null],
      data: { rel: node.rel, status: node.status },
      css: { '--kbw-depth': String(depth) },
      attr: { title: node.rel },
    });
    const hasKids = node.children.length > 0;
    row.appendChild(
      span({ cls: ['kbw-rb-twisty', hasKids ? '' : 'is-leaf'], text: hasKids ? '▾' : '·' }),
    );
    row.appendChild(span({ cls: 'kbw-rb-name', text: node.name }));
    /**
     * **徽标减噪**（P7.11 · #14，批注定稿）：**只标偏离** ——
     * 新建（accent）/ 搬入 N / 撞名（红）；「保留」是常态，**默认不标**
     *（骨架外目录靠 `is-extra` 的弱色 + 树底图例说）。
     */
    if (node.status === 'new') {
      row.appendChild(span({ cls: ['kbw-chip', 'is-small', 'is-new'], text: '新建' }));
    }
    if (node.incoming.length > 0) {
      row.appendChild(
        span({ cls: ['kbw-chip', 'is-small', 'is-in'], text: `搬入 ${node.incoming.length}` }),
      );
    }
    if (node.blocked > 0) {
      row.appendChild(span({ cls: ['kbw-chip', 'is-small', 'is-blocked'], text: `撞名 ${node.blocked}` }));
    }
    wrap.appendChild(row);

    const kids = div({ cls: 'kbw-rb-kids' });
    for (const child of node.children) kids.appendChild(nodeRow(child, depth + 1));
    wrap.appendChild(kids);
    // 点节点行 = 收起 / 展开（树自己的一份折叠状态，不进配置）
    row.addEventListener('click', (evt) => {
      const t = evt.target as HTMLElement | null;
      if (t && (t.classList.contains('kbw-chip') || t.classList.contains('kbw-rb-twisty'))) return;
      /**
       * ⚠️ 类必须贴在 **`kids`** 上（CSS 认的是 `.kbw-rb-kidwrap.is-collapsed > .kbw-rb-kids`）——
       * 贴到外层 `wrap` 上曾经是"点了没反应"（箭头变了、子节点不动）：**两份判定必漂**，
       * 收起这一处只有一个出处（就是这一行）。
       */
      const collapsed = kids.classList.toggle('is-collapsed');
      const tw = row.querySelector('.kbw-rb-twisty');
      if (tw) tw.textContent = collapsed ? '▸' : '▾';
    });
    if (node.incoming.length > 0 && node.status !== 'new') {
      // 搬进这个目录的笔记：贴着节点列出（新建的目录不用列——里面本来什么都没有）
      for (const m of node.incoming) {
        kids.appendChild(
          div({
            cls: 'kbw-rb-leaf',
            css: { '--kbw-depth': String(depth + 1) },
            attr: { title: `${m.from} → ${m.to}` },
          }, span({ cls: 'kbw-rb-leafname', text: baseName(m.from) }), span({ cls: 'kbw-rb-leafwhy', text: m.note })),
        );
      }
    }
    return wrap;
  }

  // ── 右边的「会发生什么」（P7.11 · #14 重排：先"怎么算"，再结果三档色带）──
  /** 三档里的一行（文字 + 行尾 why 小字；悬停给全文） */
  function grpRow(text: string, why = '', title?: string): HTMLElement {
    const row = div({ cls: 'kbw-rb-row', attr: title ? { title } : {} });
    row.appendChild(span({ cls: 'kbw-rb-rowtext', text }));
    if (why !== '') row.appendChild(span({ cls: 'kbw-rb-why', text: why }));
    return row;
  }

  /** 空段一句结论（P7.11 · #14："空段给一句结论"） */
  function grpEmpty(text: string): HTMLElement {
    return div({ cls: 'kbw-rb-empty', text });
  }

  /**
   * ② 的一个**可折叠分组**（会做的 / 要你拿主意 / 不动的）：组头带计数 + 一行小字提示 + ▾/▸。
   * 折叠态记在 `openGrp`（面板会话内）——重画（预览重算）不把它忘了。
   */
  function collapsibleGroup(
    host: HTMLElement,
    cls: string,
    key: 'do' | 'decide' | 'keep',
    head: string,
    hint: string,
    fill: (body: HTMLElement) => void,
  ): void {
    const box = div({ cls: ['kbw-rb-grp', cls, openGrp[key] ? 'is-open' : null] });
    const headRow = div({
      cls: ['kbw-rb-grphead', 'kbw-hover-1'],
      attr: { role: 'button', tabindex: '0' },
    });
    headRow.appendChild(span({ cls: 'kbw-rb-grpname', text: head }));
    if (hint !== '') headRow.appendChild(span({ cls: 'kbw-rb-grphint', text: hint }));
    const arrow = span({ cls: 'kbw-rb-grparrow', text: openGrp[key] ? '▾' : '▸' });
    headRow.appendChild(arrow);
    const body = div({ cls: 'kbw-rb-grpbody' });
    const toggle = (): void => {
      openGrp[key] = !openGrp[key];
      box.classList.toggle('is-open', openGrp[key]);
      arrow.textContent = openGrp[key] ? '▾' : '▸';
    };
    headRow.addEventListener('click', toggle);
    headRow.addEventListener('keydown', (evt) => {
      const k = (evt as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        evt.preventDefault();
        toggle();
      }
    });
    fill(body);
    box.appendChild(headRow);
    box.appendChild(body);
    host.appendChild(box);
  }

  /** 「不变」组里的可折叠摘要行（默认收起 —— 判据②；点开看名单） */
  function keeperRow(label: string, items: { text: string; title?: string }[]): HTMLElement {
    const box = div({ cls: 'kbw-rb-keeper' });
    const row = div({
      cls: ['kbw-rb-row', 'kbw-hover-1', 'is-toggle'],
      attr: { role: 'button', tabindex: '0' },
    });
    row.appendChild(span({ cls: 'kbw-rb-rowtext', text: label }));
    const arrow = span({ cls: 'kbw-rb-why kbw-rb-keeper-arrow', text: '▸' });
    row.appendChild(arrow);
    const list = div({ cls: 'kbw-rb-keep-list' });
    for (const it of items.slice(0, LIST_CAP)) {
      list.appendChild(div({ cls: 'kbw-rb-keepline', text: it.text, attr: it.title ? { title: it.title } : {} }));
    }
    if (items.length > LIST_CAP) {
      list.appendChild(div({ cls: 'kbw-rb-keepline', text: `…还有 ${items.length - LIST_CAP} 条` }));
    }
    const toggle = (): void => {
      const on = box.classList.toggle('is-open');
      arrow.textContent = on ? '▾' : '▸';
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (evt) => {
      const k = (evt as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        evt.preventDefault();
        toggle();
      }
    });
    box.appendChild(row);
    box.appendChild(list);
    return box;
  }

  function paintSide(err?: string): void {
    clear(sideBox);
    if (err) {
      sideBox.appendChild(div({ cls: 'kbw-rb-warn', text: `预览失败：${err}` }));
      return;
    }
    if (!painted || !plan) {
      sideBox.appendChild(div({ cls: 'kbw-rb-empty', text: '正在算…' }));
      return;
    }
    const c = planCounts(plan, collisions);
    const blocked = collisions.filter((x) => x.kind === 'blocked');
    const newFilesN = plan.newFiles?.length ?? 0;
    // ①②③（R7 三块式；①在顶 —— 输入在结果上面）
    sideBox.appendChild(block1(plan));
    sideBox.appendChild(block2(plan, c, blocked));
    sideBox.appendChild(block3());
    // 「清掉示例数据」（16.2）：库里有 `__示例` 才画（认前缀，不认"跟开工前 diff"）
    const sampleList = ctx.index.notes().filter((n) => n.basename.startsWith(SAMPLE_PREFIX));
    if (sampleList.length > 0) sideBox.appendChild(samplesRow(sampleList));
    sideBox.appendChild(noteLine());
    // 执行按钮的文案跟着计划走（R7 动词：开始纠偏 / 开始归拢 / 开始初始化）
    const nothingToDo = plan.moves.length === 0 && c.newDirs === 0 && newFilesN === 0;
    runBtn.textContent = nothingToDo
      ? '没有要做的'
      : collectOn
        ? `开始归拢 —— 收拢这 ${plan.moves.length} 篇${c.newDirs > 0 ? ` · 建 ${c.newDirs} 个目录` : ''}`
        : initMode
          ? `开始初始化 —— 建 ${c.newDirs} 个目录${newFilesN > 0 ? ` + ${newFilesN} 个文件` : ''}`
          : plan.moves.length > 0
            ? `开始纠偏 —— 搬这 ${plan.moves.length} 篇`
            : c.newDirs > 0
              ? `开始纠偏 —— 建这 ${c.newDirs} 个目录`
              : `开始纠偏 —— 建这 ${newFilesN} 个文件`;
    runBtn.classList.toggle('is-disabled', nothingToDo);
  }

  function noteLine(): HTMLElement {
    const box = div({ cls: 'kbw-rb-foot' });
    box.appendChild(
      span({
        cls: 'kbw-rb-src',
        text: '骨架：库结构.json',
        attr: { title: cfgPath },
        on: {
          click: () => {
            const f = ctx.app.vault.getAbstractFileByPath(cfgPath);
            // ⚠️ 用 `'tab'` 不用 `false`：`false` 会替换当前叶子（工作台就没了）
            if (f instanceof TFile) void ctx.app.workspace.getLeaf('tab').openFile(f);
            else notifyInfo('库结构.json 还没落盘', cfgPath);
          },
        },
      }),
    );
    box.appendChild(span({ cls: 'kbw-rb-src', text: '只加不删：不删目录、不删文件' }));
    return box;
  }

  // ── 执行（走确认流；快照与撞名判定都在 mover 里）──────────────
  async function run(): Promise<void> {
    if (busy) {
      // 「点了没反应」是最差的一种反馈（本项目的手感规矩：不可用要说清原因）
      notifyLight('重排正在执行', '等这一轮做完再操作');
      return;
    }
    if (!plan) return;
    /**
     * 🔴 **把"确认流里给你看的那份计划"冻住**（独立审查 🟡1）。
     * `plan` 是一个会被防抖重画随时替换的模块级变量 —— 确认流开着的时候库真的变了
     * （同步拉进来一笔 / 别处写了一篇 / 索引滞后那一拍落定），用户点的就是"另一份计划"了：
     * 文件多搬了（确认流上没见过），而日志里的 `reason`（旧数）与 `extraRows`（新数）**自相矛盾**。
     * 规矩：确认流 → 执行**都用 `frozen`**；回来发现内容变了就重画、让用户再看一眼。
     */
    const frozen = plan;
    const frozenKey = planKey(frozen, collisions);
    const c = planCounts(frozen, collisions);
    const newFilesN = frozen.newFiles?.length ?? 0;
    if (frozen.moves.length === 0 && c.newDirs === 0 && newFilesN === 0) {
      notifyInfo('没有要做的事', '目录齐、笔记也都在该在的地方');
      return;
    }
    const lockedN = frozen.moves.filter((m) => m.locked).length;
    const blocked = collisions.filter((x) => x.kind === 'blocked');
    const collectN = frozen.moves.filter((m) => m.why === 'collect').length;
    /** 这一趟是否带示例数据（执行成功后要把示例板块追加进看板配置） */
    const withSamples = samplesOn;
    const res = await confirm({
      title:
        collectN > 0
          ? `即将收拢旧笔记 + 补骨架：收拢 ${collectN} 篇 / 建 ${c.newDirs} 个目录 / 撞名 ${blocked.length}`
          : initMode
            ? `即将初始化库框架：新建 ${c.newDirs} 个目录${newFilesN > 0 ? ` / 建 ${newFilesN} 个文件` : ''}`
            : `即将重排库结构：新建 ${c.newDirs} 个目录 / 搬入 ${c.moved} 篇` +
              (blocked.length > 0 ? ` / 撞名 ${blocked.length}` : ''),
      preview: confirmRows(frozen),
      warnings: blocked
        .slice(0, 3)
        .map((x) => `${baseName(x.path)} → ${x.to}：${x.note}`),
      notes: [
        collectN > 0
          ? `收拢去哪：${collectDirOf(todayStamp())}/（按原相对路径 —— 双链与嵌入不丢）`
          : '',
        collectN > 0 && frozen.collectSkipped && frozen.collectSkipped.length > 0
          ? `另有 ${frozen.collectSkipped.length} 项在排除名单（99_Meta / 排除目录 / 已归集的旧笔记），不参与收拢`
          : '',
        c.newDirs > 0 ? `将新建 ${c.newDirs} 个目录：${listBrief(frozen.newDirs)}` : '',
        newFilesN > 0 ? `将新建 ${newFilesN} 个文件（种子页 / 示例数据；进快照，可还原）` : '',
        withSamples ? '并追加一个「示例」板块到看板（「清掉示例数据」里一并移除）' : '',
        c.already > 0 ? `其中 ${c.already} 篇是「已搬过」（目标同名同内容），会跳过` : '',
        c.pending > 0 ? `${c.pending} 篇列在「待定」里，这次不搬（预览里逐条写着原因）` : '',
        lockedN > 0 ? `${lockedN} 篇设了「位置锁定」，将一并移动` : '',
        '撞名一律不覆盖：目标同名同内容 = 已搬过（跳过）；内容不同 = 真冲突（留着不动）',
      ].filter(Boolean),
      primary: {
        label:
          collectN > 0
            ? `收拢这 ${collectN} 篇`
            : c.moved > 0
              ? `搬这 ${c.moved} 篇`
              : newFilesN > 0 && c.newDirs > 0
                ? `建这 ${c.newDirs} 个目录 + ${newFilesN} 个文件`
                : c.newDirs > 0
                  ? `建这 ${c.newDirs} 个目录`
                  : `建这 ${newFilesN} 个文件`,
      },
    });
    if (res.action !== 'primary') return;

    // 确认期间库变了 → **不执行用户没看过的那份**，重画让他再看一眼新的数
    if (plan && planKey(plan, collisions) !== frozenKey) {
      notifyLight('库刚变了，预览已重算', '数字与刚才不同了 —— 再看一眼，确认后执行');
      await preview(false);
      return;
    }

    setBusy(true);
    try {
      const runRes = await executeRebuild(
        // ⚠️ `kbRoot` 必须给：计划里那些目录是**相对库根**的，mover 要的是**库内绝对路径**
        { app: ctx.app, kbRoot, mover: ctx.mover, fm: ctx.fm },
        frozen,
        collectN > 0
          ? `收拢旧笔记：收拢 ${collectN} 篇 / 建 ${c.newDirs} 个目录`
          : initMode
            ? `初始化库框架：新建 ${c.newDirs} 个目录${newFilesN > 0 ? ` / ${newFilesN} 个文件` : ''}`
            : `库结构重排：新建 ${c.newDirs} 个目录 / 搬入 ${c.moved} 篇`,
      );
      const r = runRes.result;
      if (r.error) {
        notifyError('重排已中止（一个文件都没动）', r.error);
      } else {
        const movedN = r.moved.length;
        lastRun =
          `上次执行：搬了 ${movedN} 篇` +
          // ⚠️ 写真建出来的个数（`r.newDirs` / `r.newFiles`），不是计划里的 ——
          // mkdir / create 失败时不能宣称"建好了"
          `${r.newDirs.length > 0 ? `、新建 ${r.newDirs.length} 个目录` : ''}` +
          `${r.newFiles.length > 0 ? `、新建 ${r.newFiles.length} 个文件` : ''}` +
          `${r.blocked.length > 0 ? `，${r.blocked.length} 篇真冲突没搬` : ''}` +
          `${r.already.length > 0 ? `，${r.already.length} 篇已搬过` : ''}`;
        // 收拢是一次性动作：执行完（哪怕部分完成）就把开关收旗 ——
        // 再点一次会去收拢"刚建出来的种子页"，那不是用户想要的下一次
        if (collectN > 0) collectOn = false;
        // 示例板块追加（16.2）：执行成功才写；幂等（已有同 id 板块就跳过）
        if (withSamples && newFilesN > 0) await appendSampleSection();
        // ⚠️ 纯成功的汇总**不再由 mover 另发一条**（`executeRebuild` 的请求传了 `quiet`，
        // P7.0a 批 1⑦）：用户看到的回执就是下面这条撤销条；
        // partial（撞名/跳过）仍由 mover 弹 —— 那才说得出"为什么没搬"。
        // **重排这种大动作最需要一键回滚**，而 mover 的快照 id 只有我们知道
        if (r.snapshotId) {
          /**
           * 文案三档（P7.2b 独立审查 🟡3）：收拢 →「已收拢：搬了 N 篇」；重排 →「已重排：…」；
           * **初始化档 `movedN === 0`**（只有建目录/建文件）—— 原来说"搬了 0 篇"是句错话，
           * 改成报真建出来的产物。幂等/全撞名时两类都是 0 → 兜底"完成"。
           */
          const undoText =
            collectN > 0
              ? `已收拢：搬了 ${movedN} 篇`
              : movedN > 0
                ? `已重排：搬了 ${movedN} 篇`
                : `已初始化：${
                    [
                      r.newDirs.length > 0 ? `建 ${r.newDirs.length} 个目录` : '',
                      r.newFiles.length > 0 ? `建 ${r.newFiles.length} 个文件` : '',
                    ]
                      .filter(Boolean)
                      .join(' / ') || '完成'
                  }`;
          showUndo({
            text: undoText,
            detail: '撤销 = 从操作前的快照还原（含逆 rename、删掉本次新建的目录与文件）',
            onUndo: () => void restore(r.snapshotId),
            onView: () => void ctx.report.openLatest(),
            onExpire: () => {
              notifyLight('撤销条已过期', '仍可在快照面板里还原');
            },
          });
        }
        if (runRes.warnings.length > 0) {
          notifyLight('有几篇的属性没跟上', listBrief(runRes.warnings, 2));
        }
      }
    } finally {
      setBusy(false);
    }
    // 索引与 metadataCache 要一拍（~300ms）—— 别在重画时还看见旧位置
    await sleep(400);
    await preview(false);
  }

  async function restore(snapshotId: string): Promise<void> {
    if (!snapshotId) return;
    const r = await restoreOrNotify(ctx.snapshot, snapshotId);
    // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：直接收工，别接着播"已还原"
    if (!r) return;
    if (r.blocked.length > 0) {
      notifyError(
        `已还原 ${r.contentsRestored} 项，${r.blocked.length} 项没动`,
        r.blocked.slice(0, 3).map((b) => `${b.path}：${b.why}`).join('；'),
      );
    } else {
      notifyLight('已还原这次重排', `搬回 ${r.movedBack} 篇${r.filesRemoved > 0 ? `、删掉 ${r.filesRemoved} 个新建文件` : ''}${r.dirsRemoved > 0 ? `、删掉 ${r.dirsRemoved} 个新建目录` : ''}`);
    }
    await sleep(400);
    await preview(false);
  }

  // 索引一变（我们自己搬完、或别处改了库）就重算预览；骨架被手改也要跟着重算
  const repaintSoon = debounce(() => void preview(false), 300);
  h.disposer.add(ctx.index.onChange(() => repaintSoon()));
  h.disposer.add(ctx.configs.watch('rebuild', () => repaintSoon()));

  void preview(false);
  return h;
}

// ── 数据：把索引里的笔记折成计划要的形状 ───────────────────────
function notesOf(ctx: WorkbenchContext, kbRoot: string): RebuildNote[] {
  // 映射只有一份（`services/rebuild.ts` 的 `rebuildNotesOf`）—— 首页「一键自动整理」也走它
  return rebuildNotesOf(ctx.index.getAll(), kbRoot);
}

/**
 * 一份计划的**内容指纹**（🟡1 的计划漂移守卫 + 预览日志的去重用同一份）。
 *
 * ⚠️ 必须按**内容**算，不能比对象：点一次「生成预览」就会写一条日志 → 日志进索引 →
 * 300ms 后防抖重画 → `plan` 换成**内容相同的新对象** —— 比对象的话每次预览完再执行都会被拦一下。
 * 撞名的种类（已搬过 / 真冲突）也要进键：执行前用户最该看到的正是这个数会变。
 */
function planKey(plan: RebuildPlan, collisions: RebuildCollision[]): string {
  return JSON.stringify([
    plan.newDirs,
    plan.moves.map((m) => [m.from, m.to]),
    plan.pending.map((p) => p.path),
    collisions.map((c) => [c.path, c.kind]),
    // 「本次新建的文件」也进指纹：种子页开关翻一下 = 另一份计划（确认流漂移守卫要吃它）
    (plan.newFiles ?? []).map((f) => f.path),
  ]);
}

/**
 * 确认流里的预览行：**按目标目录分组**（一份 40 条路径的清单没人看得下去）。
 * 「从」那一列是这次的**来源目录**（可能就是 Inbox 一个），与"批量移动"那条口径一致。
 */
function confirmRows(plan: RebuildPlan): PlanRow[] {
  const rows: PlanRow[] = [];
  const byDir = new Map<string, RebuildMove[]>();
  for (const m of plan.moves) {
    const list = byDir.get(m.dirRel) ?? [];
    list.push(m);
    byDir.set(m.dirRel, list);
  }
  for (const [dir, list] of byDir) {
    const froms: string[] = [];
    for (const m of list) {
      const src = parentDir(m.from) === '' ? '库根' : parentDir(m.from);
      if (!froms.includes(src)) froms.push(src);
    }
    rows.push({ kind: 'move', from: froms.join(' / '), to: dir, count: list.length });
  }
  return rows;
}

/** 预览日志里的明细（`ReportSpec.rows`） */
function previewRows(plan: RebuildPlan): { label: string; detail?: string }[] {
  const rows: { label: string; detail?: string }[] = [];
  if (plan.newDirs.length > 0) {
    rows.push({ label: `新建目录 ${plan.newDirs.length} 个`, detail: listBrief(plan.newDirs) });
  }
  for (const f of plan.newFiles ?? []) rows.push({ label: `将新建 ${f.path}` });
  for (const m of plan.moves) rows.push({ label: m.from, detail: `→ ${m.to}（${m.note}）` });
  for (const p of plan.pending) rows.push({ label: `待定 ${p.rel}`, detail: p.why });
  return rows;
}
