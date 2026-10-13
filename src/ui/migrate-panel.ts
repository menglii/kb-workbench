/**
 * ui/migrate-panel.ts —— 迁移面板（`开发计划.md` §7 step 0/2/3/4）
 *
 * 三步合一，缺一不可：
 *   · **只读预演**：列出每一篇要删什么、改什么、哪些要你逐篇定（`services/migrate.ts` 算）
 *   · **逐篇确认**：值域换不出来的（`类型: 待整理`、`领域: 未分类`）给下拉，默认填推荐值
 *   · **走确认流执行**：快照 → 逐篇 `processFrontMatter`（模板走 `vault.process`）→ 报告
 *
 * 它**不自己写盘**：属性一律过 `ctx.fm`（唯一出口），模板的正文改动也要先 `markSelfWrite`
 * —— 否则索引会把我们自己的写当成"外部改动"，首页立刻多出一条紫标。
 *
 * 执行完之后面板**跟着索引自动重画**：完成定义就是"重跑预演 0 篇"，
 * 让它在界面上自己变成 0，比事后拿脚本核对更有说服力。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import type { NoteEntry } from '../core/vault-index';
import { markSelfWrite } from '../core/writes';
import { debounce, sleep } from '../core/util';
import {
  MIGRATE_VALUES,
  applyBodyFixes,
  applyTemplateEdits,
  planMigration,
  planSummary,
  previewMigration,
  recommendedChoices,
  verifyTemplateText,
  type MigratePlan,
  type MigratePlanItem,
} from '../services/migrate';
import { applyPatches, patchState, patchesOf } from '../services/doc-patches';
import { btn, div, el, span } from './primitives';
import { confirm, type PlanRow } from './confirm';
import { openModal, type PanelHandle } from './panel';
import { NOTIFY_MS, notify, notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';

/** 迁移的「来源」标记（写进操作日志；`report.ts` 的 SOURCE_LABEL 里有 manual） */
const REASON = '属性迁移';

export function openMigratePanel(ctx: WorkbenchContext): PanelHandle {
  const h = openModal({
    title: '属性迁移',
    sub: '只读预演 → 逐篇确认 → 走确认流执行',
    width: 'wide',
  });

  /** 面板里已经定下来的选择（`<相对路径>::<属性>` → 值） */
  let picks: Record<string, string> = {};
  /** 空计划占位：真正的第一次预演在末尾 `void repaint()` 里（异步读模板） */
  let plan: MigratePlan = planMigration([], {});
  /** 第一帧还没算出来（模板要读正文）→ 先说「正在预演」，别装成"没有要改的" */
  let painted = false;
  /** 上一次执行的结果（跑完在头上留一行） */
  let lastRun: string | null = null;

  const head = div({ cls: 'kbw-mig-head' });
  const list = div({ cls: 'kbw-mig-list' });
  h.body.appendChild(head);
  h.body.appendChild(list);
  /** 每次重画都重建的三行（`PanelHandle` 没暴露副标题，自己放） */
  const sumBox = div({ cls: 'kbw-mig-sum' });
  const subLine = div({ cls: 'kbw-mig-sub' });
  const lastLine = div({ cls: 'kbw-mig-last' });
  head.appendChild(sumBox);
  head.appendChild(subLine);
  head.appendChild(lastLine);

  const allRecBtn = btn({
    cls: 'kbw-btn is-small is-ghost',
    text: '全部用推荐值',
    on: {
      click: () => {
        picks = { ...picks, ...recommendedChoices(plan) };
        void repaint();
      },
    },
  });
  const replanBtn = btn({
    cls: 'kbw-btn is-small is-ghost',
    text: '重新预演',
    on: {
      click: () => {
        picks = {};
        void repaint();
      },
    },
  });
  h.foot.appendChild(replanBtn);
  h.foot.appendChild(allRecBtn);
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '关闭', on: { click: () => h.close('close') } }));
  const runBtn = btn({ cls: 'kbw-btn is-primary', text: '执行', on: { click: () => void run() } });
  h.foot.appendChild(runBtn);

  /**
   * 预演（**异步**：模板要读正文才知道改没改，模板自身没有前言）。
   * 读正文这一步很便宜（`cachedRead` 有缓存），一次 6 个小文件。
   */
  async function replan(): Promise<MigratePlan> {
    return previewMigration(ctx.app.vault, ctx.index.getAll(), {
      kbRoot: ctx.settings.kbRoot(),
      choices: picks,
    });
  }

  // 索引一变就重画（迁移写完 → metadataCache 刷新 → 预演自己变成 0）
  const repaintSoon = debounce(() => void repaint(), 250);
  const off = ctx.index.onChange(() => repaintSoon());
  h.disposer.add(off);

  async function repaint(): Promise<void> {
    let next: MigratePlan;
    try {
      next = await replan();
    } catch (e) {
      // 防御：预演真抛出来时别让面板永远停在「正在预演…」
      console.error('[经纬] 预演失败', e);
      painted = true;
      list.replaceChildren(
        div({ cls: 'kbw-mig-empty', text: `预演失败：${e instanceof Error ? e.message : String(e)}` }),
      );
      return;
    }
    plan = next;
    painted = true;
    paintHead();
    paintList();
  }

  function paintHead(): void {
    while (sumBox.firstChild) sumBox.removeChild(sumBox.firstChild);
    sumBox.appendChild(span({ cls: 'kbw-mig-count', text: planSummary(plan) }));
    lastLine.textContent = lastRun ?? '';
    lastLine.classList.toggle('is-hidden', lastRun == null);
    // ⚠️ 有"跳过"的篇时**不能**说"全部符合规范"：它们连类型/状态都没迁（真机实测过 4 篇）
    const noChanges = plan.count === 0;
    const clean = painted && noChanges && plan.blocked.length === 0;
    runBtn.classList.toggle('is-disabled', clean || plan.count === 0);
    /**
     * ⚠️ **不要写 `setAttribute('disabled', clean ? 'true' : 'false')`** ——
     * `disabled` 是**布尔属性**：属性在即为禁用，值写 `'false'` 也照样禁用。
     * 真机症状：按钮看着是亮的、鼠标也是手型，**点下去毫无反应**（不弹确认流、不报错）。
     * 更阴的是两层验证都抓不到：离线用例与探针都走 `dispatchEvent`，而它**不吃 `disabled`**。
     * 正确写法是 `toggleAttribute`（或干脆只在真禁用时给属性，见 `ui/confirm.ts`）。
     */
    runBtn.toggleAttribute('disabled', noChanges);
    runBtn.textContent = noChanges ? '没有要改的' : `执行（${plan.count} 篇）`;
    allRecBtn.classList.toggle('is-hidden', plan.choiceCount === 0);
    const skip = plan.blocked.length > 0 ? `${plan.blocked.length} 篇跳过（值会被写坏，得人工改）` : '';
    subLine.textContent = !painted
      ? '正在预演…'
      : clean
        ? '重跑预演：0 篇 ✅'
        : [
            noChanges ? '0 篇要改' : `${plan.count} 篇要改`,
            `${plan.opCount} 处改动`,
            plan.choiceCount > 0 ? `${plan.choiceCount} 处待你定` : '',
            plan.patchCount > 0 ? `正文补丁 ${plan.patchCount} 处` : '',
            plan.bodyCount > 0 ? `正文修整 ${plan.bodyCount} 处` : '',
            skip,
          ]
            .filter(Boolean)
            .join(' · ');
  }

  function paintList(): void {
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!painted) {
      list.appendChild(div({ cls: 'kbw-mig-empty', text: '正在预演…' }));
      return;
    }
    if (plan.count === 0 && plan.blocked.length === 0) {
      list.appendChild(
        div({ cls: 'kbw-mig-empty', text: lastRun ? '迁移完成，重跑预演是 0 篇 ✅' : '没有需要迁移的（全部符合新规范）' }),
      );
      return;
    }
    for (const item of plan.changes) list.appendChild(itemRow(item));
    for (const item of plan.blocked) list.appendChild(blockedRow(item));
    const untouched = plan.items.length - plan.changes.length - plan.blocked.length;
    if (untouched > 0) {
      list.appendChild(div({ cls: 'kbw-mig-rest', text: `另有 ${untouched} 篇已经符合规范（没列出来）` }));
    }
  }

  function itemRow(item: MigratePlanItem): HTMLElement {
    const row = div({ cls: ['kbw-mig-row', item.isTemplate ? 'is-tpl' : null] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: item.basename, title: item.rel }));
    nameRow.appendChild(span({ cls: 'kbw-mig-path', text: dirOf(item.rel), title: item.rel }));
    if (item.isTemplate) nameRow.appendChild(span({ cls: ['kbw-chip', 'is-small'], text: '模板' }));
    row.appendChild(nameRow);

    const ops = div({ cls: 'kbw-mig-ops' });
    for (const op of item.ops) {
      ops.appendChild(
        div({
          cls: ['kbw-mig-op', op.kind === 'del' ? 'is-del' : 'is-set'],
          title: op.why,
          text:
            op.kind === 'del'
              ? // v2 拍定「连值删除 + 预览逐条列出将被删的键与值」→ 删行带上值
                `删 ${op.key}${op.from && op.from !== '（空）' ? `（${op.from}）` : ''}`
              : `${op.key}：${op.from} → ${op.to}`,
        }),
      );
    }
    for (const b of item.bodyOps ?? []) {
      ops.appendChild(
        div({
          cls: ['kbw-mig-op', 'is-set'],
          title: '正文修整（行级文本手术，走 vault.process，不解析 YAML）',
          text: `正文：${b.detail}`,
        }),
      );
    }
    if ((item.docPatches ?? 0) > 0) {
      ops.appendChild(
        div({
          cls: ['kbw-mig-op', 'is-set'],
          title: '说明文字里的旧口径（正文，走 vault.process）',
          text: `正文补丁 ${item.docPatches} 处`,
        }),
      );
    }
    if (item.ops.length === 0 && (item.docPatches ?? 0) === 0 && (item.bodyOps?.length ?? 0) === 0) {
      ops.appendChild(div({ cls: 'kbw-mig-op is-none', text: '只等下面这几项' }));
    }
    row.appendChild(ops);

    for (const c of item.choices) {
      const field = div({ cls: 'kbw-mig-field' });
      field.appendChild(span({ cls: 'kbw-mig-label', text: c.key }));
      const sel = el('select', { cls: 'kbw-select' });
      for (const opt of valuesFor(c)) {
        sel.appendChild(el('option', { attr: { value: opt }, text: opt }));
      }
      sel.value = picks[c.id] ?? c.recommend;
      sel.addEventListener('change', () => {
        picks = { ...picks, [c.id]: sel.value };
        void repaint();
      });
      field.appendChild(sel);
      field.appendChild(span({ cls: 'kbw-mig-why', text: c.why }));
      if (sel.value !== c.recommend) {
        field.appendChild(span({ cls: 'kbw-mig-diff', text: `推荐：${c.recommend}` }));
      }
      row.appendChild(field);
    }
    for (const k of item.keep) {
      row.appendChild(
        div({ cls: 'kbw-mig-keep', text: `自定义属性不动：${k.key}（${k.value}）`, title: '不在新规范里，但迁移不碰它' }),
      );
    }
    for (const w of item.warnings ?? []) {
      row.appendChild(div({ cls: ['kbw-mig-keep', 'is-warn'], text: `⚠️ ${w}` }));
    }
    return row;
  }

  /**
   * 被跳过的篇（值会被 `processFrontMatter` 的往返写坏）——**只展示，不给按钮**：
   * 这些得人工把那个键改成标量再重跑，工具碰它一次就改形一次。
   */
  function blockedRow(item: MigratePlanItem): HTMLElement {
    const row = div({ cls: ['kbw-mig-row', 'is-blocked'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: item.basename, title: item.rel }));
    nameRow.appendChild(span({ cls: 'kbw-mig-path', text: dirOf(item.rel), title: item.rel }));
    nameRow.appendChild(span({ cls: ['kbw-chip', 'is-small'], text: '跳过' }));
    row.appendChild(nameRow);
    for (const why of item.blocked ?? []) {
      row.appendChild(div({ cls: 'kbw-mig-keep', text: why }));
    }
    row.appendChild(
      div({ cls: 'kbw-mig-why', text: '把那个键改成普通值（标量）再重新预演；那之前工具不碰这篇' }),
    );
    return row;
  }

  /** 候选：按属性名挑值域（别在 UI 里另抄一份值域）；v2 只剩 类型/状态 两个域 */
  function valuesFor(c: { key: string; options: string[] }): string[] {
    const map: Record<string, string[]> = {
      类型: MIGRATE_VALUES.NOTE_TYPES,
      状态: MIGRATE_VALUES.STATUSES,
    };
    return map[c.key] ?? c.options;
  }

  // ── 执行 ──────────────────────────────────────────────────────
  async function run(): Promise<void> {
    if (plan.count === 0) return;
    const res = await confirm({
      title: `即将改动 ${plan.count} 篇的属性`,
      preview: previewRows(plan),
      warnings: [],
      notes: [
        '逐篇原子写（processFrontMatter）；模板改的是正文里的 YAML 段',
        '执行前会自动快照，可一键还原（快照面板里也在）',
      ],
      primary: { label: `改这 ${plan.count} 篇` },
    });
    if (res.action !== 'primary') return;

    let snapId = '';
    try {
      const snap = await ctx.snapshot.capture({
        reason: `属性迁移：统一 ${plan.count} 篇的属性规范`,
        files: plan.paths,
      });
      snapId = snap.id;
    } catch (e) {
      // 全案的安全论证建立在"操作前一定有一份完整快照"上 → 拍不出来就不动手
      notify({
        kind: 'error',
        text: '快照失败，迁移已中止',
        detail: e instanceof Error ? e.message : String(e),
        ms: NOTIFY_MS.long,
      });
      return;
    }

    const failed: string[] = [];
    let changed = 0;
    /** **实际落盘**的 op 数（不是计划量）—— 部分失败时日志要说真话 */
    let applied = 0;
    /** 实际打掉的正文补丁处数 */
    let appliedPatches = 0;
    for (const item of plan.changes) {
      const file = fileOf(ctx, item.path);
      if (!file) {
        failed.push(`${item.basename}：文件不在了`);
        continue;
      }
      try {
        if (item.isTemplate) {
          await applyTemplate(ctx, file, item.basename);
        } else {
          if (item.ops.length > 0) await applyNote(ctx, file, item);
          // 正文修整（📌 页脚 / 尾链重排）：行级手术，与属性**分开写**、同一个快照
          if ((item.bodyOps?.length ?? 0) > 0) await applyBody(ctx, file);
        }
        // 正文补丁（说明文字里的旧口径）：与属性**分开写**，也走 vault.process
        appliedPatches += await applyDocPatches(ctx, file, item.rel);
        changed += 1;
        applied += item.ops.length;
      } catch (e) {
        failed.push(`${item.basename}：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 日志（动库必留痕：§10.2 / report.ts）
    // ⚠️ `report.log` 自己吞错（返回 null）：留不上痕时界面得说一句，别当没事
    const logged = await ctx.report.log({
      action: REASON,
      result: failed.length === 0 ? 'ok' : 'partial',
      source: 'manual',
      summary:
        `已迁移 ${changed} 篇（实际落盘 ${applied} 处 / 计划 ${plan.opCount} 处` +
        `${appliedPatches > 0 ? `；正文补丁 ${appliedPatches} 处` : ''}）`,
      rows: [
        { label: '改动', detail: `实际 ${applied} 处 / 计划 ${plan.opCount} 处，${plan.count} 篇` },
        { label: '选择', detail: `${plan.choiceCount} 处逐篇确认` },
        ...failed.slice(0, 5).map((f) => ({ label: '失败', detail: f })),
      ],
      snapshotId: snapId,
      extra: `范围：${ctx.settings.kbRoot() || '整个库'}`,
    });
    if (!logged) {
      notifyLight('这次的迁移日志没写进库', '（操作本身已完成，见控制台）');
    }

    lastRun = `上次执行：刚改了 ${changed} 篇${failed.length > 0 ? `，${failed.length} 篇失败` : ''}`;
    if (failed.length > 0) {
      // ⚠️ 部分失败**也要给撤销**：这正是最需要一键回滚的时候（快照 id 在手上）
      notify({
        kind: 'partial',
        text: `${changed} 篇已改，${failed.length} 篇失败`,
        detail: failed.slice(0, 3).join('；'),
        ms: NOTIFY_MS.long,
        actions: [
          { label: '撤销这次迁移', run: () => void restore(snapId) },
          { label: '查看报告', run: () => void ctx.report.openLatest() },
        ],
      });
    } else {
      notifyLight(
        `已迁移 ${changed} 篇（${applied} 处改动${appliedPatches > 0 ? ` · 正文补丁 ${appliedPatches} 处` : ''}）`,
      );
      showUndo({
        text: `已迁移 ${changed} 篇的属性`,
        detail: '撤销 = 从操作前的快照还原',
        onUndo: () => {
          void restore(snapId);
        },
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
    // 索引刷到新属性需要 ~300ms（metadataCache）→ 稍等一下再重画，别显示成"还没改"
    await sleep(400);
    await repaint();
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
      notifyLight('已还原这次迁移');
    }
    await sleep(400);
    await repaint();
  }

  void repaint();
  return h;
}

// ── 写盘（唯一出口：属性走 fm，模板走 vault.process + markSelfWrite）────
async function applyNote(ctx: WorkbenchContext, file: TFile, item: MigratePlanItem): Promise<void> {
  await ctx.fm.update(file, (fm) => {
    for (const op of item.ops) {
      if (op.kind === 'del') delete fm[op.key];
      else fm[op.key] = op.value;
    }
  });
}

/**
 * **正文修整**（📌 页脚行 / 尾链重排）：`vault.process` 里对当刻文本重算（幂等，
 * 没事就不写）。与属性分开写但**同一个快照**（拍快照的是整批 `plan.paths`）。
 */
async function applyBody(ctx: WorkbenchContext, file: TFile): Promise<void> {
  markSelfWrite(file.path);
  await ctx.app.vault.process(file, (text) => applyBodyFixes(text));
}

async function applyTemplate(ctx: WorkbenchContext, file: TFile, basename: string): Promise<void> {
  // ⚠️ 我们自己改的：不登记的话索引会判成「外部改动」（首页多一条紫标）
  markSelfWrite(file.path);
  let bad: string[] = [];
  await ctx.app.vault.process(file, (text) => {
    const next = applyTemplateEdits(text, basename);
    bad = verifyTemplateText(next, basename);
    return bad.length > 0 ? text : next; // 自检不过就原样写回（不改坏）
  });
  if (bad.length > 0) throw new Error(`模板自检没过：${bad.join('、')}`);
}

/**
 * 打这一篇的**正文补丁**（说明文字里的旧口径）。
 * 幂等：已经打过的（`replace` 在、`find` 不在）不重打；读到 0 处待打就**不写盘**（免得空写）。
 */
async function applyDocPatches(ctx: WorkbenchContext, file: TFile, rel: string): Promise<number> {
  const all = patchesOf(rel);
  if (all.length === 0) return 0;
  let text: string;
  try {
    text = await ctx.app.vault.cachedRead(file);
  } catch {
    return 0;
  }
  const pending = all.filter((p) => patchState(text, p) === 'pending');
  if (pending.length === 0) return 0;
  markSelfWrite(file.path);
  let applied = 0;
  await ctx.app.vault.process(file, (cur) => {
    const r = applyPatches(cur, pending);
    applied = r.applied;
    for (const m of r.missed) console.warn('[经纬] 正文补丁没命中（不动）', m);
    return r.text;
  });
  return applied;
}

function fileOf(ctx: WorkbenchContext, path: string): TFile | null {
  const e: NoteEntry | undefined = ctx.index.get(path);
  if (e) return e.file;
  const f = ctx.app.vault.getAbstractFileByPath(path);
  return f && 'stat' in f ? (f as TFile) : null;
}

// ── 确认流的预览行（有多少说多少）────────────────────────────────
function previewRows(plan: MigratePlan): PlanRow[] {
  const rows: PlanRow[] = [];
  const byKey = new Map<string, { n: number; to: Set<string> }>();
  let delN = 0;
  const delKeys = new Set<string>();
  for (const item of plan.changes) {
    // ⚠️ 「删键 N 篇」只数**真有 del op** 的篇（早先写成"见过任何 op 就算"→
    // 一篇都不需要删键时也会显示 N=改动篇数）
    if (item.ops.some((o) => o.kind === 'del')) delN += 1;
    for (const op of item.ops) {
      if (op.kind === 'del') {
        delKeys.add(op.key);
        continue;
      }
      const cur = byKey.get(op.key) ?? { n: 0, to: new Set<string>() };
      cur.n += 1;
      cur.to.add(op.to);
      byKey.set(op.key, cur);
    }
  }
  for (const [key, v] of byKey) {
    const to = Array.from(v.to);
    rows.push({
      kind: 'set',
      prop: key,
      from: '旧规范里的值',
      to: to.length <= 3 ? to.join(' / ') : `${to.slice(0, 2).join(' / ')} 等 ${to.length} 种`,
      count: v.n,
    });
  }
  if (delKeys.size > 0) {
    rows.push({ kind: 'set', prop: '删键', from: Array.from(delKeys).join(' / '), to: '删掉', count: delN });
  }
  const patched = plan.changes.filter((i) => (i.docPatches ?? 0) > 0);
  if (patched.length > 0) {
    const n = patched.reduce((s2, i) => s2 + (i.docPatches ?? 0), 0);
    rows.push({
      kind: 'set',
      prop: '正文补丁',
      from: '说明文字里的旧口径',
      to: `${n} 处`,
      count: patched.length,
    });
  }
  const bodied = plan.changes.filter((i) => (i.bodyOps?.length ?? 0) > 0);
  if (bodied.length > 0) {
    const n = bodied.reduce((s2, i) => s2 + (i.bodyOps?.length ?? 0), 0);
    rows.push({
      kind: 'set',
      prop: '正文修整',
      from: '📌 页脚行 / 尾链旧序',
      to: `${n} 处`,
      count: bodied.length,
    });
  }
  return rows;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}
