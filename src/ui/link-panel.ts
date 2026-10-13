/**
 * ui/link-panel.ts —— 「AI 修链」面板（P7.13b · E1，拍定 22b）
 *
 * 流程（照「AI 起标题」面板式 —— 逐篇卡片、AI 只出值、你确认才写）：
 * 失效链 ＋ 全库标题 → AI 猜目标 → **每张卡一个单选**（A/B = 候选 · C = 我来写 ·
 * D = 看看笔记）→ 确认流（逐条「旧链 → 新链」）→ **一次快照 → `vault.process` 按行改**。
 *
 * 口径（拍定 22b ＋ 本库既有纪律）：
 *  · **改的是本来就断的链**（目标已不在库里）—— 平台 `renameFile` 那套自动改链与这里无关；
 *  · 写链**只改认得出的那条**（`services/link-fix.ts` 的 `replaceLinkTarget`：
 *    目标逐一比对，`#小节` 与 `|别名` 原样保留；认不出的一处都不动）——
 *    与 `doc-patches` / `migrate` 的按行改同一手法；
 *  · **只走既有出口**：确认流 → 快照 → `vault.process` + `markSelfWrite`
 *    （与「美化笔记」同一条链）；日志 `source:'ai'`（§11 留痕）。
 *  · **AI 出错 / 未配不影响手写**：候选没了，C 项照能敲（"允许手改"档的实际价值）。
 *  · **选择与手敲都进 `rows` 数据**（不读渲染闭包）——重画（AI 回话 / 改完一批）之后
 *    选中项与敲进去的字都在（坑/界面与样式.md 的老账）。
 *
 * ⚠️ 卡片视觉**有意复用 `.kbw-title-*` 那组类**（styles/suggest.css）：两面板同属
 * "逐卡片单选题"族、样式要求一致 —— 各写一份 CSS 必漂（"两处各写一份"的老教训）。
 * 要分家时先想清楚是不是两边真的要长得不一样。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { joinPath, relativeTo } from '../core/paths';
import { markSelfWrite } from '../core/writes';
import { brokenLinkTexts } from '../core/vault-index';
import { replaceLinkTarget } from '../services/link-fix';
import { AiError, AI_PROTECTED_WHY, isAiProtected, usageLineFor } from '../services/ai';
import { btn, div, el, span } from './primitives';
import { openModal, type PanelHandle } from './panel';
import { confirm, type PlanRow } from './confirm';
import { restoreOrNotify, showUndo } from './undo-bar';
import { AI_NOT_CONFIGURED } from './suggest-panel';
import { NOTIFY_MS, notify, notifyError, notifyLight } from './notify';

/** 卡里选中的是哪一项（null = 还没选；D 是动作不是选项，不进这里） */
type Sel = 'A' | 'B' | 'C' | null;

interface LinkRow {
  /** 源笔记（相对库根） */
  rel: string;
  /** 笔记显示名（不带扩展名） */
  title: string;
  /** 归一化后的旧目标（`brokenLinkTexts` 的口径） */
  from: string;
  /** AI 给的候选（清洗过；空 = 还没回来 / 没给） */
  options: string[];
  /** 硬拦原因（非空 = 整卡禁用） */
  blockedWhy: string;
  sel: Sel;
  /** C 项就地输入框里敲的内容（**进数据**：重画后不丢） */
  custom: string;
  /** 这一张卡的选项区宿主（就地重画的落点） */
  optsHost: HTMLElement | null;
  /** 就地输入框（C 被点开 / 有内容时才有） */
  input: HTMLInputElement | null;
}

const rowKey = (r: LinkRow): string => `${r.rel}\u0000${r.from}`;

/**
 * @param opts.only **只服务这几篇**（库内绝对路径；P7.23 批量栏「AI 处理 › → 修链」——
 *   与「AI 起标题」的 `only` 同一条通道）。不给 = 老路一个字不变（全库按旗标收篇）。
 * ⚠️ 名单只当**收窄**用：这 N 篇里没带 `broken-link` 旗标的照旧不进（旗标是唯一判据）。
 *   全库标题→落点那份索引**不随之收窄**（候选池本来就是全库口径，收窄会给出假候选）。
 */
export function openLinkPanel(
  ctx: WorkbenchContext,
  opts: { only?: string[] } = {},
): PanelHandle {
  const h = openModal({
    title: 'AI 修链',
    width: 'wide',
    // 面板头标题左侧的 ✦（accent）——与「✦ AI 起标题」同族标识
    headLeading: [span({ cls: 'kbw-title-star', text: '✦', attr: { 'aria-hidden': 'true' } })],
  });

  const kbRoot = ctx.settings.kbRoot();
  const protectedAbs = ctx.ai.protectedDir();
  const onlySet = opts.only ? new Set(opts.only) : null;
  /** 全库标题 → 落点（C 手写提示与候选 dim 用；与 proposeLinks 的池同口径：非模板） */
  const relsOfTitle = new Map<string, string[]>();
  for (const e of ctx.index.notes()) {
    const rel = relativeTo(e.path, kbRoot);
    if (!rel || rel === e.path) continue;
    const list = relsOfTitle.get(e.basename) ?? [];
    list.push(rel);
    relsOfTitle.set(e.basename, list);
  }

  /**
   * 建卡：遍历**当下**带 `broken-link` 旗标的非模板笔记 × 它每一处失效链
   *（`brokenLinkTexts` 与旗标同一份实现）——一条链一张卡。
   */
  const rows: LinkRow[] = [];
  for (const e of ctx.index
    .notes()
    .filter((x) => x.flags.includes('broken-link') && (!onlySet || onlySet.has(x.path)))
    .sort((a, b) => b.mtime - a.mtime)) {
    const rel = relativeTo(e.path, kbRoot);
    if (!rel || rel === e.path) continue;
    const blocked = isAiProtected(e.path, protectedAbs) ? AI_PROTECTED_WHY : '';
    const links = brokenLinkTexts(ctx.app, e.file, ctx.app.metadataCache.getFileCache(e.file));
    for (const from of links) {
      rows.push({
        rel,
        title: e.basename,
        from,
        options: [],
        blockedWhy: blocked,
        sel: null,
        custom: '',
        optsHost: null,
        input: null,
      });
    }
  }

  let busy: '' | 'ai' | 'run' = '';
  /** 出错 / 未配置（**必须可见**的一句，红字 —— §11 安全例外） */
  let errNote = '';
  /** 成功后的计数（AI 给了几条候选 / 丢弃几条）——收进「改这 N 条链」的悬停 */
  let aiStats = '';
  /** 用量小字（底栏右端；faint、最小字号） */
  let usageText = '';
  /** AI 这一轮真看过哪些篇（从结果来；出错时 `fedKnown` 为假，只看措辞、不影响禁用） */
  let fed = new Set<string>();
  let fedKnown = false;

  const body = h.body;
  body.classList.add('kbw-title');
  const noteEl = div({ cls: 'kbw-title-note' });
  body.appendChild(noteEl);
  const listHost = div({ cls: 'kbw-title-list' });
  body.appendChild(listHost);
  const bar = div({ cls: 'kbw-title-bar' });
  body.appendChild(bar);
  const usageEl = span({ cls: 'kbw-title-usage' });
  /** 底栏右端的用量小字（唯一产出点；空串 = 不占位） */
  function paintUsage(): void {
    usageEl.textContent = usageText;
    usageEl.classList.toggle('is-hidden', usageText === '');
  }

  if (rows.length === 0) {
    listHost.appendChild(div({ cls: 'kbw-suggest-empty', text: '没有失效双链了（可能刚被别处改过）' }));
  }

  // ── 状态渲染 ─────────────────────────────────────────────────
  function renderStatus(): void {
    noteEl.textContent = errNote;
    noteEl.classList.toggle('is-hidden', errNote === '');
    noteEl.classList.toggle('is-bad', errNote !== '');
  }

  /** 这一张卡现在敲定的目标（空 = 不进执行名单） */
  function targetOf(row: LinkRow): string {
    if (row.blockedWhy !== '') return '';
    if (row.sel === 'A') return row.options[0] ?? '';
    if (row.sel === 'B') return row.options[1] ?? '';
    if (row.sel === 'C') return row.custom.trim();
    return '';
  }

  /** 选项行的选中态**就地**刷（不重建 —— 输入框正被敲字时不能被换掉） */
  function paintSel(row: LinkRow): void {
    for (const opt of Array.from(row.optsHost?.querySelectorAll<HTMLElement>('.kbw-title-opt[data-key]') ?? [])) {
      const on = opt.dataset.key === row.sel;
      opt.classList.toggle('is-on', on);
      if (opt.getAttribute('role') === 'radio') opt.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /** 候选的右侧小字：这个标题落在库里哪（多个同名时说清）。找不到 = ''（C 手写的一档） */
  function dimOf(title: string): string {
    const rels = relsOfTitle.get(title);
    if (!rels || rels.length === 0) return '';
    return rels.length === 1 ? rels[0] : `${rels[0]} 等 ${rels.length} 篇`;
  }

  /**
   * 重画**一张卡**的选项区（AI 回话 / 点开 C 项时用）。
   * ⚠️ 正在里面敲字（焦点在 C 的输入框）时**跳过** —— 换掉节点 = 当场丢焦点（P7.2c 的教训）。
   */
  function renderOpts(row: LinkRow, force = false): void {
    const host = row.optsHost;
    if (!host) return;
    if (!force && host.contains(document.activeElement)) return;
    host.textContent = '';
    row.input = null;
    if (row.blockedWhy !== '') {
      host.appendChild(span({ cls: 'kbw-title-blocked', text: row.blockedWhy }));
      return;
    }
    if (busy === 'ai') {
      host.appendChild(span({ cls: 'kbw-title-muted', text: '猜目标中…' }));
    } else if (row.options.length === 0) {
      /**
       * 措辞**不许与事实错位**（照 title-panel 的口径）：模型没给候选 / 压根没让模型看它
       * 是两件事 —— 后者是 `AI_LIMITS.linkNotes` 上限截出来的。
       */
      const text = !ctx.ai.isConfigured()
        ? '没配 AI —— 用「我来写」自己写目标才能改'
        : fedKnown && !fed.has(row.rel)
          ? '这一轮没让 AI 看它（一次只看最新的一批）—— 自己写目标也行'
          : 'AI 没给候选 —— 自己写目标也行';
      host.appendChild(span({ cls: 'kbw-title-muted', text }));
    }
    // A/B：候选两项（给不足时**相应缺位、字母不重排**）
    ['A', 'B'].forEach((key, i) => {
      const opt = row.options[i];
      if (opt === undefined) return;
      host.appendChild(optionRow(row, key as 'A' | 'B', opt, dimOf(opt)));
    });
    // C：我来写（点开就地变输入框）
    if (row.sel === 'C' || row.custom !== '') {
      const wrap = div({ cls: ['kbw-title-opt', row.sel === 'C' ? 'is-on' : null, 'is-input'], data: { key: 'C' } });
      wrap.appendChild(span({ cls: 'kbw-title-key', text: 'C' }));
      const input = el('input', {
        cls: 'kbw-title-input',
        attr: {
          type: 'text',
          placeholder: '敲一个目标名（回车不算数，点下面按钮才改）',
          spellcheck: 'false',
        },
      }) as HTMLInputElement;
      input.value = row.custom;
      /**
       * 手写目标**不拦**（用户知道自己要什么）—— 只是目标不在库里时**明说一句**，
       * 免得"改完还是断链"看起来像修失败了（这一档的出口就是"允许手改"）。
       */
      const hint = span({ cls: 'kbw-title-optdim' });
      const paintHint = (): void => {
        const t = row.custom.trim();
        hint.textContent = t !== '' && !relsOfTitle.has(t) ? '（库里没这个标题，链接可能还是断的）' : '';
      };
      input.addEventListener('input', () => {
        row.custom = input.value;
        row.sel = 'C';
        paintHint();
        paintSel(row);
        updateBar();
      });
      input.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') evt.stopPropagation();
      });
      row.input = input;
      wrap.appendChild(input);
      paintHint();
      host.appendChild(wrap);
      host.appendChild(hint);
    } else {
      const c = optionRow(row, 'C', '我来写', '点它就地输入');
      const open = (): void => {
        row.sel = 'C';
        renderOpts(row, true);
        row.input?.focus();
      };
      c.addEventListener('click', open);
      c.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          evt.preventDefault();
          open();
        }
      });
      host.appendChild(c);
    }
    // D：看看笔记（动作，不算选中）
    const d = optionRow(row, null, '看看笔记', '开小窗预览（看板关着时开标签页）');
    d.dataset.key = 'D';
    d.setAttribute('role', 'button');
    host.appendChild(d);
    d.addEventListener('click', () => openNote(row));
    d.addEventListener('keydown', (evt) => {
      const k = (evt as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        evt.preventDefault();
        openNote(row);
      }
    });
  }

  /** 一枚选项行（role=radio；`letter` 给 null 表示动作行，D 用） */
  function optionRow(row: LinkRow, letter: 'A' | 'B' | 'C' | null, label: string, dim = ''): HTMLElement {
    const on = letter !== null && row.sel === letter;
    const opt = div({
      cls: ['kbw-title-opt', 'kbw-hover-1', on ? 'is-on' : null],
      data: letter ? { key: letter } : {},
      attr: letter ? { role: 'radio', tabindex: '0', 'aria-checked': on ? 'true' : 'false' } : { tabindex: '0' },
    });
    if (letter !== null) opt.appendChild(span({ cls: 'kbw-title-key', text: letter }));
    const lab = span({ cls: 'kbw-title-optlabel', text: label });
    opt.appendChild(lab);
    if (dim !== '') opt.appendChild(span({ cls: 'kbw-title-optdim', text: `（${dim}）` }));
    if (letter !== null && letter !== 'C') {
      const pick = (): void => {
        row.sel = letter;
        paintSel(row);
        updateBar();
      };
      opt.addEventListener('click', pick);
      opt.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          evt.preventDefault();
          pick();
        }
      });
    }
    return opt;
  }

  /** D · 看看笔记：先问桥（与「AI 起标题」同一份退化口径），桥没接上退"开标签页" */
  function openNote(row: LinkRow): void {
    const abs = joinPath(kbRoot, row.rel);
    if (ctx.openNoteWindow?.(abs)) return;
    const f = ctx.app.vault.getAbstractFileByPath(abs);
    if (f instanceof TFile) void ctx.app.workspace.getLeaf('tab').openFile(f);
    else notifyLight('这一篇不在了', row.rel);
  }

  /** 按钮文字 = 现在有几条链敲定了目标（空的不进计划；点了提交时还会再过滤一遍） */
  function updateBar(): void {
    if (rows.length === 0) {
      bar.textContent = ''; // 一条都没有 → 执行条整个收起
      return;
    }
    const n = rows.filter((r) => targetOf(r) !== '').length;
    bar.textContent = '';
    const run = btn({
      cls: ['kbw-btn', 'is-primary', n === 0 ? 'is-disabled' : null],
      attr: aiStats !== '' ? { title: aiStats } : {},
      text: busy === 'run' ? '改链中…' : `改这 ${n} 条链`,
      on: { click: () => void runFix() },
    });
    if (n === 0 || busy !== '') run.setAttribute('disabled', 'true');
    bar.appendChild(run);
    paintUsage();
    bar.appendChild(usageEl);
  }

  function renderList(): void {
    listHost.textContent = '';
    for (const row of rows) {
      const rowEl = div({ cls: ['kbw-title-row', row.blockedWhy !== '' ? 'is-blocked' : null] });
      const head = div({ cls: 'kbw-title-rowhead' });
      head.appendChild(span({ cls: 'kbw-title-cur', text: `《${row.title}》` }));
      head.appendChild(span({ cls: 'kbw-title-rel', text: `[[${row.from}]]`, attr: { title: row.rel } }));
      rowEl.appendChild(head);
      row.optsHost = div({ cls: 'kbw-title-opts' });
      rowEl.appendChild(row.optsHost);
      listHost.appendChild(rowEl);
    }
    for (const row of rows) renderOpts(row, true);
  }

  // ── AI 那一跳（开面板就调 —— ① 是显式的 AI 请求，与起标题"点了就出计划"同口径）──
  async function runAi(): Promise<void> {
    if (busy !== '' || rows.length === 0) return;
    if (!ctx.ai.isConfigured()) {
      errNote = AI_NOT_CONFIGURED;
      renderStatus();
      return;
    }
    busy = 'ai';
    errNote = '';
    renderStatus();
    for (const row of rows) renderOpts(row, true);
    updateBar();
    try {
      const res = await ctx.ai.proposeLinks({});
      const byKey = new Map(res.items.map((it) => [`${it.rel}\u0000${it.from}`, it]));
      for (const row of rows) {
        row.options = byKey.get(rowKey(row))?.options ?? [];
        // 选中项引用的候选没了（给不足两项）→ 退回"没选"，别拿旧字母去对空位
        if ((row.sel === 'A' && row.options[0] === undefined) || (row.sel === 'B' && row.options[1] === undefined)) {
          row.sel = null;
        }
      }
      fed = new Set(res.fed);
      fedKnown = true;
      const cfg = ctx.settings.get().ai;
      const bits: string[] = [];
      const got = res.items.length;
      if (got > 0) bits.push(`AI 给了 ${got} 条候选`);
      if (res.dropped > 0) bits.push(`丢弃 ${res.dropped} 条（没照格式 / 目标对不上）`);
      if (bits.length === 0) {
        bits.push(res.reply.trim() !== '' ? `AI：${res.reply.trim()}（没给候选）` : 'AI 没给候选 —— 自己写目标也行');
      }
      aiStats = bits.join(' · ');
      usageText = res.usage ? usageLineFor(cfg, 'links', res.usage) : '';
    } catch (e) {
      aiStats = '';
      errNote =
        (e instanceof AiError ? `AI 出错：${e.hint}` : `AI 出错：${e instanceof Error ? e.message : String(e)}`) +
        '（候选没了，目标照样可以自己写）';
    }
    busy = '';
    renderStatus();
    for (const row of rows) renderOpts(row);
    updateBar();
  }

  // ── 执行：确认流 → 快照 → vault.process 按行改（一次调用 = 一张快照 = 一条撤销句柄）──
  async function runFix(): Promise<void> {
    if (busy !== '') return;
    /**
     * 外层兜底（独立审 🟢4）：与 `beautify.ts` 的 A3 护栏同款 —— 任一步真抛出
     * （最现实的一发：确认期间那篇被别处删了）都不许"点了没反应"。
     * 内层能吞的都吞了（快照 / 单篇写盘各自 catch），这是最后一道。
     */
    try {
      await runFixInner();
    } catch (e) {
      notifyError('修链没走完', `${e instanceof Error ? e.message : String(e)}（已写入的部分可在快照面板还原）`);
      busy = '';
      updateBar();
    }
  }

  async function runFixInner(): Promise<void> {
    const missing: string[] = [];
    /** 捺进计划的（每篇一组；文本在 process 回调里**拿当刻文本**重算 —— 幂等） */
    const planned: { file: TFile; rel: string; rows: { row: LinkRow; to: string }[] }[] = [];
    const byRel = new Map<string, { file: TFile; rel: string; rows: { row: LinkRow; to: string }[] }>();
    for (const row of rows) {
      if (row.blockedWhy !== '') continue;
      const to = targetOf(row);
      if (to === '' || to === row.from) continue;
      const abs = joinPath(kbRoot, row.rel);
      const f = ctx.app.vault.getAbstractFileByPath(abs);
      if (!(f instanceof TFile)) {
        missing.push(row.rel);
        continue;
      }
      const g = byRel.get(row.rel) ?? { file: f, rel: row.rel, rows: [] };
      g.rows.push({ row, to });
      byRel.set(row.rel, g);
    }
    planned.push(...byRel.values());
    if (missing.length > 0) notifyLight(`${missing.length} 篇执行时已经不在原位（跳过了）`, missing[0]);
    if (planned.length === 0) {
      notify({ kind: 'info', text: '没有要改的链', detail: '挑一个候选，或自己写一个目标', ms: NOTIFY_MS.info });
      return;
    }
    const total = planned.reduce((n, g) => n + g.rows.length, 0);
    const preview: PlanRow[] = [];
    for (const g of planned) {
      for (const it of g.rows) {
        preview.push({
          kind: 'link' as const,
          from: `《${it.row.title}》里的 [[${it.row.from}]]`,
          to: `[[${it.to}]]`,
          count: 1,
        });
      }
    }
    const res = await confirm({
      title: `即将改 ${total} 条失效链`,
      preview,
      warnings: [],
      notes: [
        '只换链的目标；「#小节」与「|别名」原样保留',
        '只动认得出的那条链，正文其余部分一字不改',
        '一次确认写完整批；执行前自动快照，可一键还原',
      ],
      primary: { label: `改这 ${total} 条` },
    });
    if (res.action !== 'primary') return;

    // ── 快照 → 写 → 日志 → 撤销条（与「美化笔记」同一条链的顺序）──
    let snapId = '';
    try {
      const snaps = await ctx.snapshot.capture({
        reason: `AI 修链：改 ${total} 条`,
        files: planned.map((g) => g.file),
      });
      snapId = snaps.id;
    } catch (e) {
      notifyError('快照失败，已中止（一个字节都没写）', e instanceof Error ? e.message : String(e));
      return;
    }

    busy = 'run';
    updateBar();
    /** 每条链真改掉几处（process 回调里现算；0 = 这段时间里已经断了/已被改过 → 跳过） */
    const applied = new Map<string, number>();
    for (const g of planned) {
      markSelfWrite(g.file.path);
      try {
        await ctx.app.vault.process(g.file, (cur) => {
          let text = cur;
          for (const it of g.rows) {
            const r = replaceLinkTarget(text, it.row.from, it.to);
            applied.set(rowKey(it.row), r.count);
            text = r.text;
          }
          return text;
        });
      } catch (e) {
        /**
         * 单篇写失败（最现实的一发：确认期间那篇被别处删了/移进回收站）——
         * 记 0、继续其余篇（与 mover"逐篇跳过、不中断整批"同口径）。
         */
        for (const it of g.rows) applied.set(rowKey(it.row), 0);
        console.error('[经纬] 修链写盘失败（这一篇跳过，其余继续）', g.rel, e);
      }
    }

    const doneRows = rows.filter((r) => (applied.get(rowKey(r)) ?? 0) > 0);
    const goneRows = rows.filter((r) => targetOf(r) !== '' && (applied.get(rowKey(r)) ?? 0) === 0);
    const doneFiles = new Set(doneRows.map((r) => r.rel)).size;
    if (goneRows.length > 0) {
      notifyLight(
        `${goneRows.length} 条链执行时已经不在（可能刚被别处改过）`,
        goneRows[0] ? `《${goneRows[0].title}》里的 [[${goneRows[0].from}]]` : '',
      );
    }

    if (doneRows.length > 0) {
      const logged = await ctx.report.log({
        action: '修链',
        result: goneRows.length > 0 ? 'partial' : 'ok',
        source: 'ai',
        /**
         * ⚠️ `ai: true` 要**自己传**：`report.log` 不像 `mover` 那样从 `source` 推
         * ——漏了的话日志里少一行「**这条是 AI 建议的**」（§11.1 边界④的留痕）。
         */
        ai: true,
        summary: `修失效双链 ${doneRows.length} 条（${doneFiles} 篇）`,
        snapshotId: snapId,
        extra: 'AI 出目标、确认后按行改链（只改认得出的那条）',
      });
      if (!logged) notifyLight('这次的修链日志没写进库', '（操作本身已完成，见控制台）');
      showUndo({
        text: `已修 ${doneRows.length} 条失效链`,
        detail: '撤销 = 从操作前的快照还原（链改回原样）',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, snapId).then((r) => {
            if (r) notifyLight('已还原这次修链');
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
    }
    busy = '';

    // 已改完的卡撤下去（剩下的还能接着选）。
    // ⚠️ 选中项与敲进去的字都在 `rows` 数据里 —— 重画自动保住
    const doneKeys = new Set(doneRows.map((r) => rowKey(r)));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (doneKeys.has(rowKey(rows[i]))) rows.splice(i, 1);
    }
    if (rows.length === 0) {
      listHost.textContent = '';
      listHost.appendChild(div({ cls: 'kbw-suggest-empty', text: '这一批都改完了' }));
    } else {
      renderList();
    }
    updateBar();
  }

  // 首屏
  renderList();
  updateBar();
  renderStatus();
  void runAi();
  return h;
}
