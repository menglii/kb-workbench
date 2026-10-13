/**
 * ui/cleanup-panel.ts —— **退出清理**面板（`交互规格.md` §15 · P7.18 · D3 完整版）
 *
 * 入口：设置 → 「数据」栏 → 行「退出插件前的清理…」（命令面板固定 4 条，不加第 5 条）。
 *
 * 两类清单，**逐项勾选、默认全不勾**（删除是危险动作，一律显式勾）：
 *   ① **笔记键类**（逐键勾）：六件套 + 控制字段（`CLEANUP_KEYS`）—— 删除走 `ctx.fm.remove`
 *      批量（一次一篇的原子写；**坏前言篇整篇跳过并报告 + 引导去「修前言」** —— 守卫不拆）；
 *   ② **足迹类**（逐项勾）：配置 / 日志 / 映射表 / 样例模板（**样例默认不勾** —— 用户资产）。
 *
 * 链路（红线：删除链三条）：**预览（逐项计数 + 样例）→ 确认流 → 快照 → 再执行**
 * → 结果（通知 + 面板「上次执行」块）→ 撤销 = 快照还原（与危险态删除同一条先例）。
 * 🔴 **本面板不写库内操作日志**（与其它面板有意不同）：日志目录本身就在被清名单里 ——
 * 写一条进去，"清干净日志"就永远差一条（详见 `run()` 里那段说明）。
 * 幂等：清完再扫 = 0（面板自己变 0，与 §13 同款完成定义）。
 *
 * ⚠️ **口径限制写进面板**：「插件写过的键」**没法可靠归因**（没做溯源标记）→ 只能**按键名**
 * 勾选，预览里逐键写清"会从 N 篇里删掉这个键"。
 * ⚠️ 删**足迹文件/目录**不是 `mover` 的"动文件"语义 —— 是**回收站语义**：走
 * `fileManager.trashFile`（照 `mover.trash` 的纪律：**先快照 + 删完复查** —— `trashOption: none`
 * 时平台静默什么都不做），目录壳走 `adapter.rmdir(d, true)`（P7.14c 先例）。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { formatBytes, sleep } from '../core/util';
import { planCleanupOf, planKeyWrites, type CleanupPlan } from '../services/cleanup';
import { btn, div, el, span } from './primitives';
import { confirm, type PipeSettle, type PlanRow } from './confirm';
import { openModal, type PanelHandle } from './panel';
import { NOTIFY_MS, notify, notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';
import { openFmRepairPanel } from './fm-repair-panel';

/**
 * @param opts.run **P7.24 · L2（服务族升级）**：agent 驱动的"跑到位"——
 *   扫完 → 按 `preKeys`/`preFeet` 预勾 → 直接进 `run()`（"清理所选"那颗按钮的同一份实现，
 *   危险二段确认照旧）→ 用户点执行/取消后经 `onSettled` 回传结算（`PipeSettle`）。
 *   `offstage` = **幕后模式**：面板只挂不显示（用户只看见确认卡），结算后自关。
 *   ⚠️ 预勾口径：`preKeys` 默认 `'all'`（键类全预勾 —— 只删键的**永远有快照可逐字节还原**，
 *   面板自己的口径）；`preFeet` 默认 false（足迹有不可逆面，留人手勾）；**样例永远不预勾**
 *   （用户资产，照面板口径）。
 */
export function openCleanupPanel(
  ctx: WorkbenchContext,
  opts: {
    run?: {
      preKeys?: 'all' | string[];
      preFeet?: boolean;
      offstage?: boolean;
      onSettled?: (r: PipeSettle) => void;
    };
  } = {},
): PanelHandle {
  const h = openModal({
    title: '退出插件前的清理',
    sub: '只读预览 → 逐项勾选（默认全不勾）→ 确认 → 快照 → 清理（可撤销）',
    width: 'wide',
    // P7.24 · L2 幕后（见 opts.run）：只挂不显示 + 不压 Esc 层 —— 统一走 openModal 的选项
    hidden: opts.run?.offstage === true,
  });
  /** P7.24 · L2：一次性的"扫完→预勾→跑到确认卡"（跑过就消） */
  const pendingRun = opts.run ?? null;
  let autoRunPending = pendingRun != null;

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

  let plan: CleanupPlan | null = null;
  let scanning = false;
  let lastRun: string | null = null;
  /** 上次执行"没做到"的那些（逐条列在面板里 —— 这就是本面板的报告口径，见 run() 的说明） */
  let lastFailed: string[] = [];
  /** 勾选（跨重扫保留 —— 行由计划重建；清掉的项从计划里消失，残留只在 Set 里无害） */
  const pickedKeys = new Set<string>();
  const pickedFeet = new Set<string>();

  const rescanBtn = btn({
    cls: 'kbw-btn is-small is-ghost',
    text: '重新扫描',
    on: { click: () => void scan() },
  });
  h.foot.appendChild(rescanBtn);
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '关闭', on: { click: () => h.close('close') } }));
  const runBtn = btn({ cls: 'kbw-btn is-danger', text: '清理所选', on: { click: () => void run() } });
  h.foot.appendChild(runBtn);

  /** 关掉自己再去开另一个面板（与 backfill-panel 的 goTo 同一条"去处"口径） */
  function goTo(open: () => void): void {
    h.close('goto');
    open();
  }

  async function scan(): Promise<void> {
    if (scanning) return;
    scanning = true;
    sumBox.textContent = '正在扫描…';
    subLine.textContent = '';
    list.replaceChildren(div({ cls: 'kbw-mig-empty', text: '正在扫描…' }));
    try {
      plan = await planCleanupOf(ctx);
    } catch (e) {
      scanning = false;
      plan = null;
      list.replaceChildren(
        div({ cls: 'kbw-mig-empty', text: `扫描失败：${e instanceof Error ? e.message : String(e)}` }),
      );
      maybeAutoRun(); // L2 兜底：扫失败也要有结算（run() 会如实回"还没扫描"），别让 tool 悬着
      return;
    }
    scanning = false;
    paint();
    maybeAutoRun(); // P7.24 · L2：扫完了就接上（一次性；人肉路径无感）
  }

  /**
   * **P7.24 · L2**：预勾 → 直接跑 `run()`（同一份实现）→ 回传结算（见 `opts.run`）。
   * 预勾口径见 `openCleanupPanel` 的 JSDoc（键类默认全勾、足迹默认不勾、样例永不勾）。
   */
  function maybeAutoRun(): void {
    if (!autoRunPending || !pendingRun) return;
    autoRunPending = false;
    const p = plan;
    if (p) {
      const keys = pendingRun.preKeys ?? 'all';
      for (const k of p.keys) {
        if (keys === 'all' || keys.includes(k.key)) pickedKeys.add(k.key);
      }
      if (pendingRun.preFeet) {
        for (const f of p.footprints) {
          if (f.id !== 'samples') pickedFeet.add(f.id);
        }
      }
      paint();
    }
    /**
     * 🟢9（独立审）：**显式 keys 一个都没命中**时别落到 run() 的"一项都没勾"（在 agent
     * 语境下说反了）—— 在门口如实点名：哪些键不在可清清单里。
     */
    const asked = pendingRun.preKeys ?? 'all';
    if (Array.isArray(asked) && pickedKeys.size === 0 && !pendingRun.preFeet) {
      const known = p ? new Set(p.keys.map((k) => k.key)) : new Set<string>();
      const miss = asked.filter((k) => !known.has(k));
      if (pendingRun.offstage) h.close('autorun');
      pendingRun.onSettled?.({
        action: 'blocked',
        summary:
          miss.length > 0
            ? `keys 没命中任何可清的属性键（不在清单里的：${miss.slice(0, 3).join('、')}${miss.length > 3 ? '…' : ''}）`
            : 'keys 没命中任何可清的属性键',
      });
      return;
    }
    // 🟡4（独立审）：catch 兜底 —— 链上意外抛出也必须有结算，否则 tool 永挂
    void run().then(
      (r) => {
        if (pendingRun?.offstage) h.close('autorun');
        pendingRun?.onSettled?.(r);
      },
      (e) => {
        if (pendingRun?.offstage) h.close('autorun');
        pendingRun?.onSettled?.({
          action: 'blocked',
          summary: `没跑成（意外错误）：${e instanceof Error ? e.message : String(e)}`,
        });
      },
    );
  }

  function paint(): void {
    const p = plan;
    while (list.firstChild) list.removeChild(list.firstChild);
    lastLine.textContent = lastRun ?? '';
    lastLine.classList.toggle('is-hidden', lastRun == null);
    const nothing = !p || (p.keys.length === 0 && p.footprints.length === 0);
    if (!p) {
      sumBox.textContent = '还没扫描';
      return;
    }
    sumBox.textContent = nothing
      ? `扫过 ${p.scanned} 篇，没有可清的 ✅`
      : `扫过 ${p.scanned} 篇 · 可清 ${p.keys.length} 个属性键 · 足迹 ${p.footprints.length} 项`;
    subLine.textContent = [
      p.fragile.length > 0 ? `坏前言跳过 ${p.fragile.length} 篇` : '',
      '删除是危险动作：一律先勾选、看过预览再按（默认全不勾）',
    ]
      .filter(Boolean)
      .join(' · ');
    paintFootBtn();
    if (lastFailed.length > 0) paintLastFailed();
    if (nothing) {
      list.appendChild(
        div({
          cls: 'kbw-mig-empty',
          text: lastRun
            ? '清理完成，重扫没有可清的了 ✅'
            : '看起来没什么可清的（插件没往这些笔记写过属性键，工具区也没有留下的文件）',
        }),
      );
      if (p.fragile.length > 0) paintFragile(p);
      return;
    }
    if (p.keys.length > 0) paintKeys(p);
    if (p.footprints.length > 0) paintFeet(p);
    paintFragile(p);
  }

  /** 上次执行"没做到"的逐条（面板即报告 —— 见 run() 里"不写库内日志"的说明） */
  function paintLastFailed(): void {
    const row = div({ cls: ['kbw-mig-row', 'is-skip'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: `上次执行有 ${lastFailed.length} 条没做到` }));
    nameRow.appendChild(
      span({ cls: 'kbw-mig-path', text: '逐条列在这里；要还原就去快照面板（最上面那份 = 这次操作前的）' }),
    );
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const f of lastFailed) ops.appendChild(div({ cls: ['kbw-mig-op', 'is-none'], text: f }));
    row.appendChild(ops);
    list.appendChild(row);
  }

  /** 主按钮的计数与置灰（勾几个、写几个） */
  function paintFootBtn(): void {
    const n = pickedKeys.size + pickedFeet.size;
    runBtn.textContent = n === 0 ? '清理所选' : `清理所选（${n} 项）`;
    runBtn.toggleAttribute('disabled', n === 0);
    runBtn.classList.toggle('is-disabled', n === 0);
  }

  // ── 区一：笔记属性键（逐键勾）────────────────────────────────
  function paintKeys(p: CleanupPlan): void {
    const row = div({ cls: 'kbw-mig-row' });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: '笔记属性键' }));
    nameRow.appendChild(
      span({ cls: 'kbw-mig-path', text: '删除 = 从这个键所在的笔记里，把这个键整行删掉' }),
    );
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const k of p.keys) {
      const lab = el('label', { cls: ['kbw-mig-cover', 'kbw-clean-pick'] }) as HTMLLabelElement;
      const cb = el('input', { cls: 'kbw-mig-check', attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = pickedKeys.has(k.key);
      cb.addEventListener('change', () => {
        if (cb.checked) pickedKeys.add(k.key);
        else pickedKeys.delete(k.key);
        paintFootBtn();
      });
      lab.appendChild(cb);
      lab.appendChild(span({ cls: 'kbw-clean-label', text: `「${k.key}」` }));
      lab.appendChild(
        span({
          cls: 'kbw-mig-why',
          text: `会从 ${k.count} 篇里删掉${k.samples.length > 0 ? ` · 如：${k.samples.join('、')}` : ''}`,
        }),
      );
      ops.appendChild(lab);
    }
    row.appendChild(ops);
    /**
     * 两处会让用户困惑的形状（D3 拍板点名；**面板与文档都要说**）：
     * 原生属性面板里 `文件位置: ['.']` 显示成 `.`；空值键 `状态:` 显示为空行。
     */
    row.appendChild(
      div({
        cls: ['kbw-mig-op', 'is-none'],
        text:
          '两点说明：文件位置为 . 的（库根标记，在原生属性面板里显示成一个小点）会一并删；' +
          '空值键（键名后面空着的）也会删 —— 删它们本身是安全的。',
      }),
    );
    list.appendChild(row);
  }

  // ── 区二：足迹（逐项勾）────────────────────────────────────
  function paintFeet(p: CleanupPlan): void {
    const row = div({ cls: 'kbw-mig-row' });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: '工具区足迹' }));
    nameRow.appendChild(
      span({ cls: 'kbw-mig-path', text: '插件往库里写过的文件 —— 删进回收站（认不出的东西一律不碰）' }),
    );
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const f of p.footprints) {
      const lab = el('label', { cls: ['kbw-mig-cover', 'kbw-clean-pick'] }) as HTMLLabelElement;
      const cb = el('input', { cls: 'kbw-mig-check', attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = pickedFeet.has(f.id);
      cb.addEventListener('change', () => {
        if (cb.checked) pickedFeet.add(f.id);
        else pickedFeet.delete(f.id);
        paintFootBtn();
      });
      lab.appendChild(cb);
      lab.appendChild(span({ cls: 'kbw-clean-label', text: f.label }));
      lab.appendChild(
        span({ cls: 'kbw-mig-why', text: `${f.rel}/ · ${f.files.length} 个文件 · ${formatBytes(f.totalBytes)}` }),
      );
      ops.appendChild(lab);
      if (f.note) ops.appendChild(div({ cls: ['kbw-mig-op', 'is-none'], text: f.note }));
      if (f.others.length > 0) {
        ops.appendChild(
          div({
            cls: ['kbw-mig-op', 'is-none'],
            text: `这个目录里还住着 ${f.others.length} 项别的东西（${f.others.slice(0, 3).join('、')}${f.others.length > 3 ? '…' : ''}）—— 不是插件写的，不动`,
          }),
        );
      }
    }
    row.appendChild(ops);
    list.appendChild(row);
  }

  /** 坏前言跳过（逐篇列名 + 引导去「修前言」—— 红线：这类篇整篇跳过，不去拆守卫） */
  function paintFragile(p: CleanupPlan): void {
    if (p.fragile.length === 0) return;
    const row = div({ cls: ['kbw-mig-row', 'is-skip'] });
    const nameRow = div({ cls: 'kbw-mig-name' });
    nameRow.appendChild(span({ cls: 'kbw-mig-name-t', text: `坏前言跳过 ${p.fragile.length} 篇` }));
    nameRow.appendChild(
      span({ cls: 'kbw-mig-path', text: '删键也过写口守卫（嵌套值的原文形状改了就回不去）—— 整篇跳过' }),
    );
    row.appendChild(nameRow);
    const ops = div({ cls: 'kbw-mig-ops' });
    for (const s of p.fragile) {
      ops.appendChild(div({ cls: ['kbw-mig-op', 'is-none'], text: s.basename, title: s.why }));
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

  // ── 执行（确认流 → 快照 → 删键 → 删足迹 → 报告 → 撤销条）────
  async function run(): Promise<PipeSettle> {
    const p = plan;
    if (!p) return { action: 'blocked', summary: '还没扫描完成' };
    const keyRows = p.keys.filter((k) => pickedKeys.has(k.key));
    const footRows = p.footprints.filter((f) => pickedFeet.has(f.id));
    if (keyRows.length === 0 && footRows.length === 0) {
      // 🟢9（独立审）：文案别写"默认全不勾"（agent 语境里它是**我们**预勾的）—— 如实
      return { action: 'empty', summary: '没有匹配到可清理的项' };
    }
    const total = keyRows.length + footRows.length;

    const res = await confirm({
      title: `即将清理 ${total} 项`,
      preview: [
        ...keyRows.map(
          (k): PlanRow => ({
            kind: 'purge',
            target: `属性键「${k.key}」（从这些笔记里删掉）`,
            count: k.count,
            unit: '篇',
          }),
        ),
        ...footRows.map(
          (f): PlanRow => ({
            kind: 'purge',
            target: `${f.rel}/（${f.files.length} 个文件）`,
            count: f.files.length,
            unit: '个',
          }),
        ),
      ],
      warnings: [],
      notes: [
        '只有你勾的这些会被动 —— 每一样，前面预览都写清了它从哪儿删掉什么',
        '足迹文件删进回收站（走你 Obsidian 的「删除文件」设置）；笔记上的键从属性里删掉。两边都能一键还原',
      ],
      danger: {
        confirmLabel: '再点一次确认',
        // 只有勾了足迹（真走回收站）才谈得上"不可逆"；只删笔记键的靠我们自己的快照，总能还原
        irreversible: footRows.length > 0 && ctx.mover.trashOption() !== 'local',
      },
      primary: { label: `清理 ${total} 项` },
    });
    if (res.action !== 'primary') return { action: 'cancelled', summary: '用户取消了（一个字节都没动）' };

    // ── 现算要动的东西（"看了预览、写的是别的"防护）──
    const scope = {
      kbRoot: ctx.settings.kbRoot(),
      metaRoot: ctx.settings.metaRoot(),
      templateDir: ctx.settings.templateDir(),
    };
    const writes = planKeyWrites(
      ctx.index.getAll(),
      scope,
      keyRows.map((k) => k.key),
    );
    /** 快照收 `(TFile | string)[]` —— 键篇走索引现取、足迹直接用刚扫到的路径（capture 自己读内容） */
    const keyFiles = [...writes.keys()]
      .map((path) => ctx.index.get(path)?.file ?? (ctx.app.vault.getAbstractFileByPath(path) as TFile | null))
      .filter((f): f is TFile => Boolean(f));
    const feetPaths = footRows.flatMap((f) => f.files.map((x) => x.path));

    // ── 快照（一次执行 = 一份快照 = 一个撤销句柄）──
    let snapId = '';
    try {
      const snap = await ctx.snapshot.capture({
        reason: `退出清理：${total} 项`,
        files: [...keyFiles, ...feetPaths],
        deletions: feetPaths.map((path) => ({
          path,
          trashed: ctx.mover.trashOption() === 'local',
        })),
      });
      snapId = snap.id;
    } catch (e) {
      notify({
        kind: 'error',
        text: '快照失败，已中止',
        detail: e instanceof Error ? e.message : String(e),
        ms: NOTIFY_MS.long,
      });
      return { action: 'blocked', summary: '快照失败，已中止（一个字节没动）' };
    }

    const failed: string[] = [];
    /** **真删到的**键集合（独立审 🟡6：汇总计数用实际写入集合，不用勾选数 ——
     *  勾了 3 个键、现算后一篇都没有时不许报"删了 3 个键"） */
    const doneKeys = new Set<string>();

    // ── ① 删键（逐篇一次原子写；坏前言被守卫拦下 → 逐条报）──
    let keyedNotes = 0;
    for (const [path, keys] of writes) {
      const file =
        ctx.index.get(path)?.file ?? (ctx.app.vault.getAbstractFileByPath(path) as TFile | null);
      const name = path.split('/').pop() ?? path;
      if (!file) {
        failed.push(`${name}：文件不在了`);
        continue;
      }
      try {
        const r = await ctx.fm.remove(file as TFile, keys);
        if (r.skipped.length > 0) {
          failed.push(`${name}：被守卫拦下（前言里有嵌套值，去「修前言」）`);
        } else {
          keyedNotes += 1;
          for (const k of keys) doneKeys.add(k);
        }
      } catch (e) {
        failed.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(30);
    }

    // ── ② 删足迹（回收站语义：逐文件 trashFile + 复查；目录空了才摘壳）──
    let feetFilesDone = 0;
    let shells = 0;
    let shellKept = 0;
    for (const f of footRows) {
      for (const x of f.files) {
        const node = ctx.app.vault.getAbstractFileByPath(x.path);
        if (!node) {
          // 扫描后、执行前被别处动了（同步/手删）——**逐条报出来**（本面板的承诺），别静默少删
          failed.push(`${x.name}：文件不在了（可能被别处删了）`);
          continue;
        }
        try {
          await ctx.app.fileManager.trashFile(node);
        } catch (e) {
          failed.push(`${x.name}：${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        // ⚠️ `trashOption: none` 时平台**静默什么都不做**（S2 实测）—— 不复查就是报假账
        if (ctx.app.vault.getAbstractFileByPath(x.path)) {
          failed.push(`${x.name}：还没删掉（Obsidian 的「删除文件」设置可能是「不删除」）`);
          continue;
        }
        feetFilesDone += 1;
      }
      if (f.kind !== 'dir') continue;
      // 目录壳：**空了才摘**（认不出的东西在里面就留着 —— 勾选行里已经说过它们不动）
      try {
        if (!(await ctx.app.vault.adapter.exists(f.path))) continue;
        const listing = await ctx.app.vault.adapter.list(f.path);
        if ((listing.files ?? []).length > 0 || (listing.folders ?? []).length > 0) {
          shellKept += 1;
          continue;
        }
        await ctx.app.vault.adapter.rmdir(f.path, true);
        if (await ctx.app.vault.adapter.exists(f.path)) failed.push(`${f.rel}/：目录壳没删掉`);
        else shells += 1;
      } catch (e) {
        failed.push(`${f.rel}/：目录壳删除出错（${e instanceof Error ? e.message : String(e)}）`);
      }
    }

    /**
     * 🔴 **不写库内操作日志**（与其它面板有意不同的一条）：这份清理的**对象之一就是操作日志
     * 目录本身** —— 写一条进去，用户"清干净日志"就永远差一条，再清一次又写一条（循环）。
     * 所以本面板的「报告」= 通知（前几条）+ **面板里的「上次执行」块**（failed 逐条列全）
     * + **快照**（`reason` 记着这次清了什么，快照面板里可查、可还原）。判据与文档同此口径。
     */
    lastRun =
      `上次执行：删了 ${doneKeys.size} 个键（${keyedNotes} 篇）/ ${feetFilesDone} 个足迹文件` +
      (shells > 0 ? `，摘掉 ${shells} 个空目录` : '') +
      (shellKept > 0 ? `；${shellKept} 个目录里还有别的东西，壳留着` : '') +
      (failed.length > 0 ? `；${failed.length} 条没做到` : '');
    lastFailed = failed;
    if (failed.length > 0) {
      notify({
        kind: 'partial',
        text: `清理完成，但有 ${failed.length} 条没做到`,
        detail: failed.slice(0, 3).join('；'),
        ms: NOTIFY_MS.long,
        actions: [{ label: '撤销这次清理', run: () => void restore(snapId) }],
      });
    } else {
      notifyLight(
        `已清理 ${doneKeys.size} 个属性键 / ${feetFilesDone} 个足迹文件` +
          (shells > 0 ? `，摘掉 ${shells} 个空目录` : ''),
      );
      showUndo({
        text: `已清理 ${total} 项`,
        detail: '撤销 = 从操作前的快照还原',
        onUndo: () => void restore(snapId),
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
    for (const k of keyRows) pickedKeys.delete(k.key);
    for (const f of footRows) pickedFeet.delete(f.id);
    // metadataCache 慢 ~300ms → 等一下再重扫，免得显示成"还没清"
    await sleep(400);
    void scan();
    return {
      action: 'executed',
      summary:
        `删了 ${doneKeys.size} 个键（${keyedNotes} 篇）/ ${feetFilesDone} 个足迹文件` +
        (shells > 0 ? `，摘掉 ${shells} 个空目录` : '') +
        (failed.length > 0 ? `；${failed.length} 条没做到（面板「上次执行」里有明细）` : ''),
    };
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
      notifyLight('已还原这次清理');
    }
    await sleep(400);
    await scan();
  }

  void scan();
  return h;
}
