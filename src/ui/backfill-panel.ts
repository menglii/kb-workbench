/**
 * ui/backfill-panel.ts —— **存量笔记一键补全**（交互规格 §13）
 *
 * 入口两处（P7.17 · 用户第 1 条）：**向导屏 2 的询问卡**（主）+ **设置 → 自动化**（次，
 * 旁边有「当前 N 篇可补」的动态提示）。命令面板固定 4 条，不加第 5 条。
 * 两步，缺一不可：
 *   · **扫描（只读）**：列出要动的笔记和要补什么，**可反复点，不改任何东西**
 *   · **补全**：确认流 → 快照 → 逐篇写 → 报告落 `99_Meta/05_操作日志/`
 *
 * 三条硬约束（§13 原文）：**两分支**（空白套整套模板 / 有正文只补两头）、
 * **只加不删**、**幂等**（补过再扫是 0 篇 —— 面板跑完自己就变 0，比事后核对有说服力）。
 * P7.17 起扫描结果**分档显示**（合并矩阵 `YAML优化方案.md` §2）：可补 / 已合规 /
 * 旧值待迁（→ 迁移面板）/ 值认不出（**覆盖区**，D2 逐篇勾选）/ 坏前言跳过（→ 修前言）/
 * `文件位置` 异常（→ 首页待处理）。
 *
 * 写盘**不在这里**：走 `CompletionService.fillFile()`（与「新建补全」同一份实现；
 * ⚠️ D1 起带 `withPosition: true` —— 存量也写「文件位置」= 实际落点 + `收藏: false`）。
 * 计划只用来给人看 —— 真写之前会按当下的内容再判一次，免得"看了预览、写的是别的"。
 * 覆盖区（D2）的写盘走 `ctx.fm.set`（**只碰勾中的那一个键**，不做整篇重写）。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { sleep } from '../core/util';
import {
  countPlan,
  describeItem,
  legacyNoteCount,
  planBackfillOf,
  planSummary,
  type BackfillCover,
  type BackfillPlan,
} from '../services/backfill';
import { btn, div, el, span } from './primitives';
import { confirm, type PlanRow } from './confirm';
import { openModal, type PanelHandle } from './panel';
import { NOTIFY_MS, notify, notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';
import { openMigratePanel } from './migrate-panel';
import { openFmRepairPanel } from './fm-repair-panel';

export function openBackfillPanel(ctx: WorkbenchContext): PanelHandle {
  const h = openModal({
    title: '一键补全存量笔记',
    sub: '只读扫描 → 确认 → 快照 → 逐篇补（只加不删）',
    width: 'wide',
  });

  const head = div({ cls: 'kbw-mig-head' });
  const list = div({ cls: 'kbw-mig-list' });
  h.body.appendChild(head);
  h.body.appendChild(list);
  const sumBox = div({ cls: 'kbw-mig-sum' });
  const subLine = div({ cls: 'kbw-mig-sub' });
  const lastLine = div({ cls: 'kbw-mig-last' });
  head.appendChild(sumBox);
  head.appendChild(subLine);
  head.appendChild(lastLine);

  let plan: BackfillPlan | null = null;
  let scanning = false;
  let lastRun: string | null = null;
  /** 覆盖区的勾选（`<path>::<key>` —— 同一篇的两个键是两行）；跨重扫保留（行由计划重建） */
  const picked = new Set<string>();
  const cidOf = (c: BackfillCover): string => `${c.path}::${c.key}`;

  const rescanBtn = btn({
    cls: 'kbw-btn is-small is-ghost',
    text: '重新扫描',
    on: { click: () => void scan() },
  });
  h.foot.appendChild(rescanBtn);
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '关闭', on: { click: () => h.close('close') } }));
  const runBtn = btn({ cls: 'kbw-btn is-primary', text: '补全', on: { click: () => void run() } });
  h.foot.appendChild(runBtn);

  /** 关掉自己再去开另一个面板（与 suggest-panel 的 voidBye 同一条"去处"口径） */
  function goTo(open: () => void): void {
    h.close('goto');
    open();
  }

  /**
   * ⚠️ **实现搬去了 `services/backfill.ts` 的 `planBackfillOf()`**（P6 段④）：
   * 首次使用向导的询问卡与设置里那条动态提示都报**同一个数**（`planTodoCount`），
   * 两处各拼一份 `BackfillInput` 的话，差异不会当场爆出来 —— 只会在用户眼里变成
   * "向导说 7 篇、点进来是 3 篇"。
   */
  async function buildPlan(): Promise<BackfillPlan> {
    return planBackfillOf(ctx);
  }

  async function scan(): Promise<void> {
    if (scanning) return;
    scanning = true;
    sumBox.textContent = '正在扫描…';
    subLine.textContent = '';
    list.replaceChildren(div({ cls: 'kbw-mig-empty', text: '正在扫描…' }));
    try {
      plan = await buildPlan();
    } catch (e) {
      scanning = false;
      plan = null;
      list.replaceChildren(
        div({ cls: 'kbw-mig-empty', text: `扫描失败：${e instanceof Error ? e.message : String(e)}` }),
      );
      return;
    }
    scanning = false;
    paint();
  }

  function paint(): void {
    const p = plan;
    while (list.firstChild) list.removeChild(list.firstChild);
    sumBox.textContent = p ? planSummary(p) : '还没扫描';
    lastLine.textContent = lastRun ?? '';
    lastLine.classList.toggle('is-hidden', lastRun == null);
    const n = p?.items.length ?? 0;
    runBtn.toggleAttribute('disabled', n === 0);
    runBtn.classList.toggle('is-disabled', n === 0);
    runBtn.textContent = n === 0 ? '没有要补的' : `补全 ${n} 篇`;
    if (!p) return;
    const c = countPlan(p);
    const legacyN = legacyNoteCount(p);
    subLine.textContent = [
      c.template > 0 ? `空白套整套模板 ${c.template} 篇` : '',
      c.patch > 0 ? `补前言 / 缺键 / 尾链 ${c.patch} 篇` : '',
      legacyN > 0 ? `旧值待迁 ${legacyN} 篇` : '',
      p.coverage.length > 0 ? `覆盖候选 ${p.coverage.length} 处` : '',
      p.fragile.length > 0 ? `坏前言 ${p.fragile.length} 篇` : '',
      p.posIssues.length > 0 ? `文件位置异常 ${p.posIssues.length} 篇` : '',
      p.skipped.length > 0 ? `另有 ${p.skipped.length} 篇不动（已合规）` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const nothing =
      p.items.length === 0 &&
      p.coverage.length === 0 &&
      p.fragile.length === 0 &&
      p.legacy.length === 0 &&
      p.posIssues.length === 0;
    if (nothing) {
      list.appendChild(
        div({
          cls: 'kbw-mig-empty',
          text: lastRun ? '补全完成，重扫是 0 篇 ✅' : '没有要补的（全部都有完整前言与尾部双链）',
        }),
      );
      return;
    }
    for (const item of p.items) list.appendChild(itemRow(item));
    paintCoverage(p);
    paintFragile(p);
    paintLegacy(p);
    paintPosIssues(p);
  }

  function itemRow(item: BackfillPlan['items'][number]): HTMLElement {
    const row = div({ cls: ['kbw-mig-row', item.kind === 'template' ? 'is-tpl' : null] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: item.basename, title: item.rel }));
    nameRow.appendChild(span({ cls: 'kbw-mig-path', text: item.folderRel || '（库根）', title: item.rel }));
    nameRow.appendChild(
      span({ cls: ['kbw-chip', 'is-small'], text: item.kind === 'template' ? '整套模板' : '只补两头' }),
    );
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    ops.appendChild(div({ cls: ['kbw-mig-op', 'is-set'], title: item.templatePath, text: describeItem(item) }));
    ops.appendChild(div({ cls: ['kbw-mig-op'], title: item.rule, text: `模板：${basenameOf(item.templatePath)}（${item.rule}）` }));
    if (item.unresolved.length > 0) {
      ops.appendChild(
        div({
          cls: ['kbw-mig-op', 'is-none'],
          text: `${item.unresolved.join(' ')} 求不到值，会原样留着`,
        }),
      );
    }
    row.appendChild(ops);
    return row;
  }

  // ── 分档区（P7.17 合并矩阵）──────────────────────────────────
  /** 覆盖区（D2）：**逐篇勾选（默认全不勾）** → 确认流 → 快照 → 逐篇 `fm.set`（只碰那个键） */
  function paintCoverage(p: BackfillPlan): void {
    if (p.coverage.length === 0) return;
    const row = div({ cls: ['kbw-mig-row', 'is-cover'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: '覆盖区（值不在规范里）' }));
    nameRow.appendChild(
      span({ cls: 'kbw-mig-path', text: '逐篇勾选 · 默认全不勾 · 只碰 类型 / 状态 这一个键' }),
    );
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    const covBtn = btn({ cls: 'kbw-btn is-small', text: '覆盖所选 0 处', on: { click: () => void runCoverage() } });
    const refreshBtn = (): void => {
      const nSel = p.coverage.filter((cv) => picked.has(cidOf(cv))).length;
      covBtn.textContent = nSel === 0 ? '覆盖所选 0 处' : `覆盖所选 ${nSel} 处`;
      covBtn.toggleAttribute('disabled', nSel === 0);
      covBtn.classList.toggle('is-disabled', nSel === 0);
    };
    for (const cv of p.coverage) {
      const id = cidOf(cv);
      const lab = el('label', { cls: 'kbw-mig-cover' }) as HTMLLabelElement;
      const cb = el('input', { cls: 'kbw-mig-check', attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = picked.has(id);
      cb.addEventListener('change', () => {
        if (cb.checked) picked.add(id);
        else picked.delete(id);
        refreshBtn();
      });
      lab.appendChild(cb);
      lab.appendChild(
        span({ text: `${cv.basename} · ${cv.key}：${cv.from} → ${cv.to}`, title: cv.rel }),
      );
      lab.appendChild(
        span({
          cls: ['kbw-chip', 'is-small'],
          text: cv.via === 'map' ? '迁移映射' : '认不出',
          title: cv.via === 'map' ? '建议值来自迁移映射表（与迁移面板同一份）' : '映射表也认不出 —— 建议值按目录默认/惯例',
        }),
      );
      ops.appendChild(lab);
    }
    refreshBtn();
    const bar = div({ cls: 'kbw-mig-op' });
    bar.appendChild(covBtn);
    ops.appendChild(bar);
    row.appendChild(ops);
    list.appendChild(row);
  }

  /** 坏前言跳过（逐篇列名 + 引导去「修前言」——红线：这类篇整篇跳过，不去拆守卫） */
  function paintFragile(p: BackfillPlan): void {
    if (p.fragile.length === 0) return;
    const row = div({ cls: ['kbw-mig-row', 'is-skip'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: `坏前言跳过 ${p.fragile.length} 篇` }));
    nameRow.appendChild(span({ cls: 'kbw-mig-path', text: '写口守卫会整篇拦下（嵌套值的原文形状改了就回不去）' }));
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const s of p.fragile) {
      ops.appendChild(div({ cls: ['kbw-mig-op', 'is-none'], text: basenameOf(s.path), title: s.why }));
    }
    const bar = div({ cls: 'kbw-mig-op' });
    bar.appendChild(
      btn({
        cls: 'kbw-btn is-small',
        text: '去修前言',
        on: { click: () => goTo(() => openFmRepairPanel(ctx)) },
      }),
    );
    ops.appendChild(bar);
    row.appendChild(ops);
    list.appendChild(row);
  }

  /** 旧值待迁（只报告 —— **不抢迁移面板的活**；映射表与迁移面板同一份） */
  function paintLegacy(p: BackfillPlan): void {
    const n = legacyNoteCount(p);
    if (n === 0) return;
    const row = div({ cls: ['kbw-mig-row', 'is-skip'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: `${n} 篇有旧值待迁` }));
    nameRow.appendChild(span({ cls: 'kbw-mig-path', text: '完整 v1→v2（含专属键删除 / 尾链重排）在迁移面板' }));
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const l of p.legacy.slice(0, 8)) {
      ops.appendChild(
        div({
          cls: 'kbw-mig-op',
          text: `${l.basename} · ${l.key}：${l.from}${l.to ? ` → ${l.to}` : '（删键）'}`,
          title: `${l.why}（${l.rel}）`,
        }),
      );
    }
    if (p.legacy.length > 8) ops.appendChild(div({ cls: 'kbw-mig-op', text: `…等 ${p.legacy.length} 处` }));
    const bar = div({ cls: 'kbw-mig-op' });
    bar.appendChild(
      btn({ cls: 'kbw-btn is-small', text: '去迁移面板', on: { click: () => goTo(() => openMigratePanel(ctx)) } }),
    );
    ops.appendChild(bar);
    row.appendChild(ops);
    list.appendChild(row);
  }

  /** `文件位置` 异常（只报告 + 给"去首页待处理"入口 —— 不动） */
  function paintPosIssues(p: BackfillPlan): void {
    if (p.posIssues.length === 0) return;
    const row = div({ cls: ['kbw-mig-row', 'is-skip'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: `文件位置异常 ${p.posIssues.length} 篇` }));
    nameRow.appendChild(span({ cls: 'kbw-mig-path', text: '只报告、不自动改（搬回声明处 / 改声明都是你的决定）' }));
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const s of p.posIssues.slice(0, 8)) {
      ops.appendChild(div({ cls: 'kbw-mig-op', text: `${basenameOf(s.path)}：${s.why}`, title: s.path }));
    }
    if (p.posIssues.length > 8) ops.appendChild(div({ cls: 'kbw-mig-op', text: `…等 ${p.posIssues.length} 篇` }));
    const bar = div({ cls: 'kbw-mig-op' });
    bar.appendChild(
      btn({
        cls: 'kbw-btn is-small',
        text: '去首页待处理',
        on: {
          click: () => {
            h.close('goto');
            ctx.goHome();
          },
        },
      }),
    );
    ops.appendChild(bar);
    row.appendChild(ops);
    list.appendChild(row);
  }

  async function run(): Promise<void> {
    const p = plan;
    if (!p || p.items.length === 0) return;
    const paths = p.items.map((i) => i.path);
    const res = await confirm({
      title: `即将补全 ${p.items.length} 篇笔记`,
      preview: previewRows(p),
      warnings: [],
      notes: [
        '只加不删：已有属性和正文一个字符都不动（有前言的只补缺的键）',
        '空白笔记套整套模板；有正文的只在开头补前言、结尾补双链',
        '补全前会按当下内容再判一次；执行前会自动快照，可一键还原',
      ],
      primary: { label: `补全 ${p.items.length} 篇` },
    });
    if (res.action !== 'primary') return;

    let snapId = '';
    try {
      const snap = await ctx.snapshot.capture({
        reason: `一键补全存量笔记：${p.items.length} 篇`,
        files: paths.map((x) => ctx.index.get(x)?.file).filter((f): f is TFile => Boolean(f)),
      });
      snapId = snap.id;
    } catch (e) {
      notify({
        kind: 'error',
        text: '快照失败，已中止',
        detail: e instanceof Error ? e.message : String(e),
        ms: NOTIFY_MS.long,
      });
      return;
    }

    const failed: string[] = [];
    let filled = 0;
    let skipped = 0;
    const rows: { label: string; detail?: string }[] = [];
    for (const item of p.items) {
      const entry = ctx.index.get(item.path);
      const file = entry?.file ?? (ctx.app.vault.getAbstractFileByPath(item.path) as TFile | null);
      if (!file) {
        failed.push(`${item.basename}：文件不在了`);
        continue;
      }
      try {
        // 真写之前按**当下内容**再判一次（看了预览之后库可能又变了）
        // ⚠️ D1（P7.17）：存量也写「文件位置」= 实际落点 + 收藏: false ——
        //    与 planBackfill 的 withPosition 必须一致（否则幂等判据当场红）
        const outcome = await ctx.completion.fillFile(file, { withPosition: true });
        if (outcome.kind === 'filled') filled += 1;
        else if (outcome.kind === 'failed') failed.push(`${item.basename}：${outcome.detail}`);
        else skipped += 1;
        rows.push({ label: item.rel, detail: outcome.detail || describeItem(item) });
      } catch (e) {
        failed.push(`${item.basename}：${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(30);
    }

    // ── 分档也说进报告（§2 表「报告里怎么说」列）──
    if (p.fragile.length > 0) {
      rows.push({
        label: `跳过：前言里有嵌套值 ${p.fragile.length} 篇（去「修前言」）`,
        detail: p.fragile.map((x) => basenameOf(x.path)).join('、'),
      });
    }
    const legacyN = legacyNoteCount(p);
    if (legacyN > 0) rows.push({ label: `${legacyN} 篇有旧值待迁 → 去迁移面板` });
    if (p.posIssues.length > 0) {
      rows.push({
        label: `${p.posIssues.length} 篇文件位置异常 → 去首页待处理`,
        detail: p.posIssues.map((x) => `${basenameOf(x.path)}：${x.why}`).slice(0, 6).join('；'),
      });
    }

    const logged = await ctx.report.log({
      action: '一键补全',
      result: failed.length === 0 ? 'ok' : 'partial',
      source: 'manual',
      summary: `已补全 ${filled} 篇（跳过 ${skipped} 篇，失败 ${failed.length} 篇）`,
      rows,
      snapshotId: snapId,
      extra: `扫过 ${p.scanned} 篇；只加不删`,
    });
    if (!logged) notifyLight('这次的补全日志没写进库', '（操作本身已完成，见控制台）');

    lastRun = `上次执行：补了 ${filled} 篇${failed.length > 0 ? `，${failed.length} 篇失败` : ''}`;
    if (failed.length > 0) {
      notify({
        kind: 'partial',
        text: `${filled} 篇已补，${failed.length} 篇失败`,
        detail: failed.slice(0, 3).join('；'),
        ms: NOTIFY_MS.long,
        actions: [
          { label: '撤销这次补全', run: () => void restore(snapId) },
          { label: '查看报告', run: () => void ctx.report.openLatest() },
        ],
      });
    } else {
      notifyLight(`已补全 ${filled} 篇`, skipped > 0 ? `另有 ${skipped} 篇不用补` : undefined);
      showUndo({
        text: `已补全 ${filled} 篇笔记`,
        detail: '撤销 = 从操作前的快照还原',
        onUndo: () => void restore(snapId),
        onView: () => void ctx.report.openLatest(),
        onExpire: () => {
          notify({
            kind: 'info',
            text: '撤销条已过期',
            detail: '仍可在快照面板里还原',
            ms: NOTIFY_MS.long,
            actions: [{ label: '打开快照面板', run: () => ctx.openSnapshotPanel() }],
          });
        },
      });
    }
    // metadataCache 慢 ~300ms → 等一下再重扫，免得显示成"还没补"
    await sleep(400);
    await scan();
  }

  /**
   * **覆盖区（D2）的执行**：确认流 → 快照 → 逐篇 `fm.set`（**只碰勾中的那一个键**，
   * 不做整篇重写）→ 撤销条 + 报告 → 重扫。
   * 「只加不删」的唯一例外 —— 且只发生在**显式勾选**的篇上（默认全不勾）。
   */
  async function runCoverage(): Promise<void> {
    const p = plan;
    if (!p) return;
    const rows = p.coverage.filter((cv) => picked.has(cidOf(cv)));
    if (rows.length === 0) return;
    const groups = new Map<string, { key: string; from: string; to: string; count: number }>();
    for (const cv of rows) {
      const gid = `${cv.key}\u0000${cv.from}\u0000${cv.to}`;
      const g = groups.get(gid) ?? { key: cv.key, from: cv.from, to: cv.to, count: 0 };
      g.count += 1;
      groups.set(gid, g);
    }
    const res = await confirm({
      title: `即将覆盖 ${rows.length} 处属性值`,
      preview: [...groups.values()].map(
        (g): PlanRow => ({ kind: 'set', prop: g.key, from: g.from, to: g.to, count: g.count }),
      ),
      warnings: [],
      notes: [
        '只碰勾中的那一个键，其余属性与正文一个字节不动',
        '覆盖是「只加不删」的唯一例外 —— 只发生在你显式勾选的篇上',
        '执行前会自动快照，可一键还原',
      ],
      primary: { label: `覆盖 ${rows.length} 处` },
    });
    if (res.action !== 'primary') return;

    const filePaths = [...new Set(rows.map((r) => r.path))];
    let snapId = '';
    try {
      const snap = await ctx.snapshot.capture({
        reason: `覆盖属性值：${rows.length} 处`,
        files: filePaths
          .map((x) => ctx.index.get(x)?.file ?? (ctx.app.vault.getAbstractFileByPath(x) as TFile | null))
          .filter((f): f is TFile => Boolean(f)),
      });
      snapId = snap.id;
    } catch (e) {
      notify({
        kind: 'error',
        text: '快照失败，已中止',
        detail: e instanceof Error ? e.message : String(e),
        ms: NOTIFY_MS.long,
      });
      return;
    }

    const failed: string[] = [];
    const reportRows: { label: string; detail?: string }[] = [];
    let done = 0;
    for (const cv of rows) {
      const entry = ctx.index.get(cv.path);
      const file = entry?.file ?? (ctx.app.vault.getAbstractFileByPath(cv.path) as TFile | null);
      if (!file) {
        failed.push(`${cv.basename}：文件不在了`);
        continue;
      }
      try {
        const r = await ctx.fm.set(file, cv.key, cv.to);
        if (r.skipped.length > 0) {
          failed.push(`${cv.basename}：${cv.key} 被守卫拦下（前言里有嵌套值）`);
        } else {
          done += 1;
          reportRows.push({ label: cv.rel, detail: `${cv.key}：${cv.from} → ${cv.to}` });
        }
      } catch (e) {
        failed.push(`${cv.basename}：${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(30);
    }

    const logged = await ctx.report.log({
      action: '覆盖属性值',
      result: failed.length === 0 ? 'ok' : 'partial',
      source: 'manual',
      summary: `已覆盖 ${done} 处（失败 ${failed.length} 处）`,
      rows: reportRows,
      snapshotId: snapId,
      extra: '只碰勾中的那一个键（类型/状态），其余一个字节不动',
    });
    if (!logged) notifyLight('这次的覆盖日志没写进库', '（操作本身已完成，见控制台）');

    if (failed.length > 0) {
      notify({
        kind: 'partial',
        text: `${done} 处已覆盖，${failed.length} 处失败`,
        detail: failed.slice(0, 3).join('；'),
        ms: NOTIFY_MS.long,
        actions: [{ label: '撤销这次覆盖', run: () => void restore(snapId) }],
      });
    } else {
      notifyLight(`已覆盖 ${done} 处属性值`);
      showUndo({
        text: `已覆盖 ${done} 处属性值`,
        detail: '撤销 = 从操作前的快照还原',
        onUndo: () => void restore(snapId),
        onView: () => void ctx.report.openLatest(),
        onExpire: () => {
          notify({
            kind: 'info',
            text: '撤销条已过期',
            detail: '仍可在快照面板里还原',
            ms: NOTIFY_MS.long,
            actions: [{ label: '打开快照面板', run: () => ctx.openSnapshotPanel() }],
          });
        },
      });
    }
    for (const cv of rows) picked.delete(cidOf(cv));
    await sleep(400);
    await scan();
  }

  async function restore(snapshotId: string): Promise<void> {
    if (!snapshotId) return;
    const r = await restoreOrNotify(ctx.snapshot, snapshotId);
    // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：直接收工，别接着播"已还原"
    if (!r) return;
    if (r.blocked.length > 0) {
      notify({
        kind: 'partial',
        text: `已还原 ${r.contentsRestored} 项，${r.blocked.length} 项没动`,
        detail: r.blocked.map((b) => `${b.path}：${b.why}`).slice(0, 3).join('；'),
        ms: NOTIFY_MS.long,
      });
    } else {
      notifyLight('已还原这次操作');
    }
    await sleep(400);
    await scan();
  }

  void scan();
  return h;
}

function previewRows(p: BackfillPlan): PlanRow[] {
  const c = countPlan(p);
  const rows: PlanRow[] = [];
  if (c.template > 0) {
    rows.push({ kind: 'set', prop: '空白笔记套模板', from: '空', to: '前言 + 正文骨架 + 尾链', count: c.template });
  }
  if (c.yaml > 0) {
    rows.push({ kind: 'set', prop: '补前言 / 缺键 / 正文骨架', from: '（缺）', to: 'YAML（类型/状态按目录默认）', count: c.yaml });
  }
  if (c.tail > 0) rows.push({ kind: 'set', prop: '补尾部双链', from: '（缺）', to: '「## 关联笔记」段', count: c.tail });
  return rows;
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
