/**
 * modules/home/todo-actions.ts —— **首页「待处理」的动作层**（P7.13b · 域 D #6b + E1/E2/E3）
 *
 * 拍定（方案 5「拍定汇总」Q21–Q25 + 22b）在这里落地成三个出口：
 *   · `rowDisabledReason` —— ① 的**置灰原因**（外改 / 一次性标签 / 未配 AI 的修链）；
 *   · `runRowAction` —— **①「自动处理本条」**：逐类映射到既有出口
 *     （收件箱→一键自动整理；位置不一致→搬回声明处；旧规范→迁移面板；未命名→起标题面板；
 *     空壳→清空确认流；失效双链→AI 修链面板；重复文件→保最新一份；孤儿附件→挪待清理）。
 *     ⚠️ **面板型动作会 await 面板关闭**（`PanelHandle.closed`）——① 的调用方 void 掉它、
 *     无感；② 靠这一份 await 实现"逐条串行、等面板关再继续"（Q23 拍定）。
 *   · `runFullProcess` —— **②「一键完全处理」**：按清单序逐条串行跑 `runRowAction`，
 *     取消 / 没弄掉的一律"跳过继续"，跑完汇总「完成 X 行 / 跳过 Y 行」。
 *
 * 两条共用纪律：
 *   · **"撤行"判据钉"跑完行消失"**（Q24）：每行动作跑完**重算清单**（`computeTodoItems`，
 *     与渲染/判据同一份）—— 行没了 = 完成，还在 = 跳过。**不猜"取消没取消"**：
 *     重算出来还剩几篇就照实说（`没弄掉：<当下的行文案>`）。
 *   · **动库全走既有出口**：mover（快照/日志/撤销条在链上）、`ui/confirm.ts`（动库前
 *     确认的唯一出口）、面板（迁移/起标题/修链各自的确认流）——本文件不新开写盘路径。
 *
 * ⚠️ `computeTodoItems` 从 `blocks/todo.ts` 的 `paintTodo` 里**原样抽出**（同一份输入组装：
 * 预演 + 维护三件 + `buildTodos` + 忽略过滤）——渲染与动作从此读同一份口径。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import { baseName, joinPath, stripExt } from '../../core/paths';
import { sleep } from '../../core/util';
import { computeMaintenance, type MaintenanceFindings } from '../../services/maintenance';
import { previewMigration } from '../../services/migrate';
import {
  planMoveBackToDeclared,
  type ReconcileMove,
  type ReconcileSkip,
} from '../../services/reconcile';
import { vaultShapeOf } from '../../services/rebuild';
import type { PlanRow } from '../../ui/confirm';
import { confirm } from '../../ui/confirm';
import { AI_NOT_CONFIGURED } from '../../ui/suggest-panel';
import { runClearEmpty } from '../../ui/clear-empty';
import { openFmRepairPanel } from '../../ui/fm-repair-panel';
import { openLinkPanel } from '../../ui/link-panel';
import { openMigratePanel } from '../../ui/migrate-panel';
import { openTitlePanel } from '../../ui/title-panel';
import { openSnapshotPanel } from '../../ui/snapshot-panel';
import { NOTIFY_MS, notify, notifyError, notifyLight } from '../../ui/notify';
import { restoreOrNotify, showUndo } from '../../ui/undo-bar';
import { showMoveUndo, type UndoMoveDeps } from '../../ui/undo-move';
import { buildTodos, filterDismissed, type TodoItem } from './todo';
import { INBOX, runInboxTidy } from './tidy';

/** 现算一份维护三件（`computeMaintenance` 带缓存 —— 同一索引修订号下是现成的） */
export async function latestMaintenance(ctx: WorkbenchContext): Promise<MaintenanceFindings> {
  return computeMaintenance({
    app: ctx.app,
    settings: ctx.settings,
    index: ctx.index,
    exclude: (await ctx.automation.get()).reconcile.exclude,
    revision: ctx.store.get().indexRevision,
  });
}

/** 撤销/回执的共用依赖（`ui/undo-move.ts` 的口） */
function undoDeps(ctx: WorkbenchContext): UndoMoveDeps {
  return {
    restore: (id) => ctx.snapshot.restore(id),
    openLatest: () => ctx.report.openLatest(),
    openSnapshotPanel: () => openSnapshotPanel(ctx),
  };
}

/**
 * 当下的待处理清单（**渲染与动作的唯一数据源**）——`paintTodo` 与 ①/② 都读这一份。
 * 输入组装与 `paintTodo` 原样一致：预演（含"跳过"的也算没迁完）+ 维护三件 + 忽略过滤。
 */
export async function computeTodoItems(ctx: WorkbenchContext): Promise<TodoItem[]> {
  const entries = ctx.index.getAll();
  // 预演（读模板正文）与维护三件（全库枚举 + 哈希，带缓存）互不依赖 —— 并行省一拍
  const [plan, findings] = await Promise.all([
    previewMigration(ctx.app.vault, entries, { kbRoot: ctx.settings.kbRoot() }),
    latestMaintenance(ctx),
  ]);
  const all = buildTodos(ctx.index.notes(), INBOX, {
    // ⚠️ **跳过的篇也算"还没迁完"**：它们连着旧值（工具碰不了）→ 那行不该消失，
    // 否则面板再也进不去、用户根本看不到"跳过"这件事（独立审查指出；随 P7.13b 搬来）
    migrateCount: plan.count + plan.blocked.length,
    migrateMeta: [
      `${plan.opCount} 处改动`,
      plan.choiceCount > 0 ? `${plan.choiceCount} 处要你逐篇定` : '',
      plan.blocked.length > 0 ? `${plan.blocked.length} 篇跳过（值会被写坏）` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    maintenance: findings,
    // P7.14：「还没写内容」的新口径（空壳也算）—— 维护那份是「相对库根」，这里换成
    // 与 `entries` 同口径的 vault 绝对路径（buildTodos 纯函数，不碰 kbRoot）
    emptyNotes: findings.emptyNotes.map((rel) => joinPath(ctx.settings.kbRoot(), rel)),
  });
  return filterDismissed(all, ctx.settings.get().homeDismissed);
}

/**
 * ① 的置灰原因（空串 = 可跑）。**只有这四档**：
 *   · 失效双链 + 没配 AI（修链要 AI 猜目标；手改出口在别处 —— 全部笔记里直接编辑）；
 *   · 外部改动 / 一次性标签（Q24 拍定：本来就撤不掉、保持现状，① 置灰写明原因）；
 *   · 其余任何认不出的 id（防御，正常到不了）。
 */
export function rowDisabledReason(ctx: WorkbenchContext, item: TodoItem): string {
  if (item.id === 'broken-link' && !ctx.ai.isConfigured()) return AI_NOT_CONFIGURED;
  if (item.id === 'external-change') return '外部改动要你亲自过目：合并还是保留，插件替你选不了';
  if (item.id === 'unused-tags') return '一次性标签只是提示 —— 删不删由你定，没有自动动作';
  if (!RUNNABLE_IDS.has(item.id)) return '这一项没有自动动作';
  return '';
}

/** 有 ① 动作的行（`buildTodos` 的 id 全集减去两档置灰的） */
const RUNNABLE_IDS = new Set([
  'inbox',
  'position-mismatch',
  'migrate',
  'placeholder-title',
  'empty-file',
  'broken-link',
  'dup-files',
  'orphan-files',
  /** P7.16 · #3：① = 修前言流程（确定性 + AI 辅助；面板型动作，`closed` 等它关） */
  'fragile-fm',
]);

/**
 * **①「自动处理本条」**（② 也复用这一份 —— 一拍不两写）。
 *
 * ⚠️ 面板型（迁移 / 起标题 / 修链）**会 await 面板关闭**：① 的调用方 `void` 掉这个 Promise，
 * 无感；② 顺序 `await` 它，就得到"逐条串行、等面板关再继续"的语义（Q23）。
 */
export async function runRowAction(ctx: WorkbenchContext, item: TodoItem): Promise<void> {
  switch (item.id) {
    case 'inbox':
      // 收件箱 → 一键自动整理（含 AI 预整理、确认流；范围就是收件箱一项）
      await runInboxTidy(ctx, { scope: INBOX });
      return;
    case 'position-mismatch':
      await runMoveBack(ctx);
      return;
    case 'migrate':
      await openMigratePanel(ctx).closed;
      return;
    case 'placeholder-title':
      await openTitlePanel(ctx).closed;
      return;
    case 'empty-file':
      // 空壳 → 「清空此类」确认流（全库扫 · 预览 · 回收站；#10 既有序）
      await runClearEmpty(ctx, { source: 'todo' });
      return;
    case 'broken-link':
      await openLinkPanel(ctx).closed;
      return;
    case 'fragile-fm':
      // 坏前言 → 修前言面板（确定性批量 + 逐篇 AI；面板型动作，② 靠这一份 await 串行）
      await openFmRepairPanel(ctx).closed;
      return;
    case 'dup-files':
      await runDupKeepNewest(ctx);
      return;
    case 'orphan-files':
      await runOrphansPark(ctx);
      return;
    default:
      // 置灰档走不到这里（调用方先过 rowDisabledReason）；防御性收尾
      notifyLight('这一项没有自动动作', item.text);
  }
}

/** 展示名：《名》（不带 .md）——与 tidy 的预览行同一个口径 */
function noteLabel(absOrRel: string): string {
  return `《${stripExt(baseName(absOrRel))}》`;
}

// ────────────────────────────────────────────────────────────────
// 位置不一致 → 搬回声明处（拍定：目录不存在时"建前单独问一次"）
// ────────────────────────────────────────────────────────────────
async function runMoveBack(ctx: WorkbenchContext): Promise<void> {
  const kbRoot = ctx.settings.kbRoot();
  const shape = await vaultShapeOf(ctx.app, kbRoot);
  const exclude = (await ctx.automation.get()).reconcile.exclude;
  const plan = planMoveBackToDeclared(ctx.index.getAll(), { kbRoot, exclude, dirs: shape.dirs });

  /** 目标目录不存在的：**先单独问一次**（拍定）——建则并进主确认单，不建则转成跳过 */
  let mkMoves: ReconcileMove[] = [];
  const notBuilt: ReconcileSkip[] = [];
  if (plan.missing.length > 0) {
    const dirs = Array.from(new Set(plan.missing.map((m) => m.declared)));
    const nOf = (d: string): number => plan.missing.filter((m) => m.declared === d).length;
    const res = await confirm({
      title: `有 ${dirs.length} 个目标目录还不存在 —— 要顺手建出来吗？`,
      preview: dirs.map(
        (d): PlanRow => ({
          kind: 'create',
          title: d,
          to: `${nOf(d)} 篇要搬进去`,
          count: nOf(d),
        }),
      ),
      warnings: [],
      notes: [
        '上面每一行都是某篇笔记「文件位置」里写的目标 —— 请核对是不是拼写错了',
        '建出来的目录会记进这次快照：撤销 = 连目录一起收回',
      ],
      primary: { label: '建出来并继续' },
      secondary: [{ label: '不建，这批跳过', value: 'skip' }],
    });
    if (res.action === 'primary') {
      mkMoves = plan.missing.map((m) => {
        const e = ctx.index.get(m.path);
        const base = e ? e.basename : stripExt(baseName(m.path));
        return { path: m.path, from: m.path, to: `${m.declared}/${base}.md`, declared: m.declared };
      });
    } else {
      for (const m of plan.missing) {
        notBuilt.push({ path: m.path, why: `目标目录不存在（你选了不建）：${m.declared}` });
      }
    }
  }

  const moves = [...plan.moves, ...mkMoves];
  const skipped: { path: string; why: string }[] = [...plan.skips, ...notBuilt];
  if (moves.length === 0) {
    if (skipped.length === 0) {
      notifyLight('没有要搬的', '位置不一致的笔记都恰好在声明处了');
      return;
    }
    notify({
      kind: 'partial',
      text: `${skipped.length} 篇没能搬回声明处：`,
      detail: skipped.map((s) => `· ${noteLabel(s.path)}：${s.why}`).join('\n'),
      ms: NOTIFY_MS.long,
    });
    return;
  }

  const res = await confirm({
    title: `即将搬回声明处：搬走 ${moves.length} 篇`,
    preview: moves.map(
      (m): PlanRow => ({
        kind: 'move',
        from: noteLabel(m.from),
        to: m.declared,
        count: 1,
      }),
    ),
    foldUnit: '篇',
    warnings: skipped.map((s) => `${noteLabel(s.path)}：${s.why}`),
    notes: [
      '搬到「文件位置」声明的地方 —— 声明就是这篇笔记说的"我该住哪"',
      '双链会自动跟着改；重名不覆盖：内容相同自动跳过，不同就留着让你看',
    ],
    primary: { label: `搬这 ${moves.length} 篇` },
  });
  if (res.action !== 'primary') return;

  // ⚠️ 目录口径：给 mover 的 dir 必须是**库内绝对路径**（P3/P5 都栽在相对/绝对混用）
  const targets: { dir: string; files: TFile[] }[] = [];
  for (const m of moves) {
    const f = ctx.app.vault.getAbstractFileByPath(m.path);
    if (!(f instanceof TFile)) continue; // 竞态：清单算完到确认之间被搬走了
    targets.push({ dir: joinPath(kbRoot, m.declared), files: [f] });
  }
  if (targets.length === 0) {
    notifyLight('这几篇都刚被别处搬走/改名了', '重看一眼清单再试');
    return;
  }
  const r = await ctx.mover.move({
    targets,
    // ⚠️ `source:'reconcile'` = 「自动归位」这一族的留痕（按声明搬）；显式动作不受位置锁定拦（v2 口径）
    source: 'reconcile',
    reason: `搬回声明处：搬走 ${targets.length} 篇`,
    quiet: true, // 撤销条在（showMoveUndo）—— 不弹重复回执；partial 仍由 mover 弹
  });
  if (r.error) {
    notifyError('搬回已中止（一个文件都没动）', r.error);
    return;
  }
  showMoveUndo(undoDeps(ctx), r);
}

// ────────────────────────────────────────────────────────────────
// E2 · 重复文件 → 保最新一份（其余进回收站；拍定：按修改时间最新）
// ────────────────────────────────────────────────────────────────
async function runDupKeepNewest(ctx: WorkbenchContext): Promise<void> {
  const f = await latestMaintenance(ctx);
  if (f.dups.groups.length === 0) {
    notifyLight('没有重复文件了', '可能刚被别处清理过');
    return;
  }
  const kbRoot = ctx.settings.kbRoot();
  /** 逐组现算 mtime：保最新的一份（同 mtime 取路径序靠前的，确定性） */
  const plan: { keep: string; drop: string[] }[] = [];
  let gone = 0;
  for (const g of f.dups.groups) {
    const items: { rel: string; mtime: number }[] = [];
    for (const rel of g) {
      try {
        const st = await ctx.app.vault.adapter.stat(joinPath(kbRoot, rel));
        if (st && st.type === 'file') items.push({ rel, mtime: st.mtime });
      } catch {
        // 竞态：读不到的就不参与
      }
    }
    if (items.length < 2) {
      gone += 1;
      continue;
    }
    let keeper = items[0];
    for (const it of items) {
      if (it.mtime > keeper.mtime || (it.mtime === keeper.mtime && it.rel < keeper.rel)) keeper = it;
    }
    plan.push({ keep: keeper.rel, drop: items.filter((it) => it.rel !== keeper.rel).map((it) => it.rel) });
  }
  const dropRels = plan.flatMap((p) => p.drop);
  if (dropRels.length === 0) {
    notifyLight('没有可清的重复文件', gone > 0 ? `${gone} 组里的文件已经不全了` : '');
    return;
  }
  const files = dropRels
    .map((rel) => ctx.app.vault.getAbstractFileByPath(joinPath(kbRoot, rel)))
    .filter((x): x is TFile => x instanceof TFile);
  const res = await confirm({
    title: `重复文件只留最新的一份：把其余 ${files.length} 件放进回收站？`,
    preview: plan.flatMap((p) =>
      p.drop.map(
        (rel): PlanRow => ({
          kind: 'set',
          prop: `《${baseName(rel)}》`,
          from: `与《${baseName(p.keep)}》内容相同（那份修改更晚，留着）`,
          to: '回收站',
          count: 1,
        }),
      ),
    ),
    foldUnit: '篇',
    warnings: [],
    notes: [
      '「最新」按修改时间算 —— 上面每行都写清了替哪一份让路，先过目再动手',
      '进回收站（随时可还原）；执行前自动快照，可一键撤回',
    ],
    primary: { label: `清这 ${files.length} 件` },
  });
  if (res.action !== 'primary') return;
  const t = await ctx.mover.trash({
    files,
    source: 'todo',
    reason: `重复文件保一份：清 ${files.length} 件`,
  });
  if (t.error) {
    notifyError('清理已中止（一个文件都没删）', t.error);
    return;
  }
  if (t.skipped.length > 0) {
    notifyLight(`${t.skipped.length} 件没清掉`, t.skipped[0]?.note ?? '');
  }
  /**
   * 🔴 **删完主动重扫一次索引**（P7.13b 补的真机缺口）：重复组里**非 `.md`** 的
   * （附件居多）删掉时索引根本不发事件（它只跟 `.md`）→ 维护三件的缓存键
   * （索引修订号）不变 → "N 组文件内容重复"那行**不消失**、复核也会误判。
   * `rebuild()` 会 +1 修订号 + 发一次变更通知（首页顺势重画）。
   */
  if (t.trashed.length > 0) ctx.index.rebuild();
  if (t.trashed.length > 0 && t.snapshotId) {
    showUndo({
      text: `已清 ${t.trashed.length} 件重复文件（进回收站）`,
      detail: t.reversible ? '撤销 = 从操作前的快照还原' : '这些文件进了系统回收站，可从系统回收站找回',
      onUndo: () => {
        void restoreOrNotify(ctx.snapshot, t.snapshotId).then((back) => {
          // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：只判空，不播成功文案
          if (!back) return;
          notifyLight(`已还原这次清理：写回 ${back.contentsRestored} 件`);
        });
      },
      onView: () => void ctx.report.openLatest(),
      onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
    });
  }
}

// ────────────────────────────────────────────────────────────────
// E3 · 孤儿附件 → 挪「待清理」（**不删**；目标目录不存在经 mover 建）
// ────────────────────────────────────────────────────────────────
async function runOrphansPark(ctx: WorkbenchContext): Promise<void> {
  const f = await latestMaintenance(ctx);
  if (f.orphans.rels.length === 0) {
    notifyLight('没有孤儿附件了', '可能刚被别处清理过');
    return;
  }
  const kbRoot = ctx.settings.kbRoot();
  const metaDir = ctx.settings.get().metaDir.replace(/^\/+|\/+$/g, '');
  /** 落点（相对库根）——跟着元数据目录设置走（默认 99_Meta/05_待清理） */
  const targetRel = metaDir ? `${metaDir}/05_待清理` : '05_待清理';
  const targetAbs = joinPath(kbRoot, targetRel);
  const files = f.orphans.rels
    .map((rel) => ctx.app.vault.getAbstractFileByPath(joinPath(kbRoot, rel)))
    .filter((x): x is TFile => x instanceof TFile);
  if (files.length === 0) {
    notifyLight('这些附件已经不在原位了', '重看一眼清单再试');
    return;
  }
  const res = await confirm({
    title: `把这 ${files.length} 件没人引用的附件挪到「${targetRel}」？`,
    preview: files.map(
      (x): PlanRow => ({
        kind: 'move',
        // 附件名字**整体保留**（别过 stripExt —— 那会把 .png 当扩展名切掉）
        from: `《${x.name}》`,
        to: targetRel,
        count: 1,
      }),
    ),
    foldUnit: '篇',
    warnings: [],
    notes: [
      '只挪不删 —— 挪过去让你自己过目，再决定留不留',
      '目标目录不存在会自动建出来（记进这次快照：撤销 = 连目录一起收回）',
    ],
    primary: { label: `挪这 ${files.length} 件` },
  });
  if (res.action !== 'primary') return;
  const r = await ctx.mover.move({
    targets: [{ dir: targetAbs, files }],
    extraDirs: [targetAbs],
    // source 'todo'：**不在 LEARN_SOURCES 里**（见 MoveSource 注释——别教出"→ 05_待清理"的假习惯）
    source: 'todo',
    reason: `孤儿附件挪待清理：${files.length} 件`,
    quiet: true, // 撤销条在（showMoveUndo）
  });
  if (r.error) {
    notifyError('挪动已中止（一个文件都没动）', r.error);
    return;
  }
  /**
   * 🔴 **挪完主动重扫一次索引**（与 E2 同一条理由）：附件是**非 `.md`**，索引不跟它
   * —— 不重扫的话"N 件附件没人引用"那行不消失（维护三件的缓存键 = 索引修订号，没变）。
   */
  if (r.moved.length > 0) ctx.index.rebuild();
  showMoveUndo(undoDeps(ctx), r);
}

// ────────────────────────────────────────────────────────────────
// ② · 一键完全处理（逐条串行；取消/没弄掉 = 跳过继续；跑完汇总）
// ────────────────────────────────────────────────────────────────

/**
 * 跑完一行的复核：等索引追上（写盘事件有 ~120ms 防抖 + metadataCache 第二拍），
 * 再重算清单看这一行还在不在。返回"还在的那一份"（null = 行的底层已经修好）。
 *
 * ⚠️ 快路：动作什么都没写盘（用户取消）时 `revision` 不会动 —— 等到点还是没变
 * 就**直接复用第一次读到的结果**，不再白等第二拍。
 */
async function recheckRow(ctx: WorkbenchContext, id: string, rev0: number): Promise<TodoItem | null> {
  const find = (items: TodoItem[]): TodoItem | null => items.find((x) => x.id === id) ?? null;
  let still = find(await computeTodoItems(ctx));
  if (still && ctx.index.revision === rev0) {
    for (let i = 0; i < 15 && ctx.index.revision === rev0; i += 1) await sleep(100);
    if (ctx.index.revision !== rev0) {
      await sleep(250); // metadataCache 的第二拍（属性/正文刷新）——P7.2b 轮记过这条滞后
      still = find(await computeTodoItems(ctx));
    }
  }
  return still;
}

/** 防重入：同一条清单上只跑一趟（按钮点两下不该并行两趟动库） */
let running = false;

/**
 * **②「一键完全处理」**（Q23/Q24 拍定）：按清单序（严重度降序，就是 `buildTodos` 的序）
 * 逐条串行跑 `runRowAction`；每行跑完**重算判"行消失了吗"**——
 * 没了 = 完成；还在 = 跳过（明细照实写"还剩几"）；置灰档（外改 / 一次性标签 / 未配 AI 的修链）
 * 不进动作、直接进跳过明细。跑完弹汇总「完成 X 行 / 跳过 Y 行」。
 */
export async function runFullProcess(ctx: WorkbenchContext): Promise<void> {
  if (running) {
    notifyLight('已经在一键完全处理中', '等这一趟跑完再试');
    return;
  }
  running = true;
  try {
    const items = await computeTodoItems(ctx);
    if (items.length === 0) {
      notify({ kind: 'info', text: '眼下没有待处理的事', ms: NOTIFY_MS.info });
      return;
    }
    let done = 0;
    const skippedLines: string[] = [];
    for (const item of items) {
      const reason = rowDisabledReason(ctx, item);
      if (reason !== '') {
        skippedLines.push(`· ${item.text}：${reason}`);
        continue;
      }
      // 先重算一次：前面几行的动作可能顺手把它也带好了（比如清重复时顺带清掉孤儿）
      const cur = (await computeTodoItems(ctx)).find((x) => x.id === item.id);
      if (!cur) {
        done += 1;
        continue;
      }
      const rev0 = ctx.index.revision;
      try {
        await runRowAction(ctx, cur);
      } catch (e) {
        skippedLines.push(`· ${cur.text}：动作出错（${e instanceof Error ? e.message : String(e)}）`);
        continue;
      }
      const still = await recheckRow(ctx, cur.id, rev0);
      if (still) skippedLines.push(`· 没弄掉：${still.text}`);
      else done += 1;
    }
    notify({
      kind: skippedLines.length === 0 ? 'success' : 'info',
      text: `一键完全处理：完成 ${done} 行 / 跳过 ${skippedLines.length} 行`,
      detail: skippedLines.length > 0 ? skippedLines.join('\n') : undefined,
      ms: NOTIFY_MS.long,
    });
  } catch (e) {
    // 顶层兜底（独立审 🟢9）：每一行的动作各自吞错，但"算清单 / 重算"这类若出事不许静默
    notifyError('一键完全处理没走完', e instanceof Error ? e.message : String(e));
  } finally {
    running = false;
  }
}
