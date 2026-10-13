/**
 * ui/title-panel.ts —— 「AI 起标题」面板（P7.8 · 1.5 的「未命名」行）
 *
 * 流程（Q3 拍板 = 候选 + 允许手改）：AI 出 1–3 个候选 → **每篇一张卡选一项**
 * （A/B = 候选 · C = 我来取名 · D = 看看笔记）→ 确认流（逐条「旧名 → 新名」）
 * → **一次 `mover` 改名**（多目标 = 一条快照 = 一条撤销句柄）。
 *
 * ## P7.11 · #3 改版（批注定稿；效果稿 = `用户反馈批3-整改方案-2026-10-05.html` D 节）
 *
 * 删掉四层小字里的三层（副标题 / 提示行 / 按钮旁说明）；token 用量只留一段，
 * 落**底栏右端**（faint、最小字号，不与按钮抢焦）。每篇从"芯片行 + 独立输入行"
 * 收成**一张带 A/B/C/D 单选题的卡**：
 *   · A/B = AI 两个候选（给不足两项时**相应缺位、字母不重排**）；
 *   · C · 我来取名 —— 点它，**就在该项处变成输入框**就地敲（原来那行独立输入框退役）；
 *   · D · 看看笔记 —— 走既有桥 `ctx.openNoteWindow`（看板关着 → 退开标签页，
 *     与「最近改动」同一条退化口径，`blocks/recent.ts`）。
 * 面板头标题左侧一枚 ✦（accent，与「✦ AI 分类 / 选节」同族标识）。
 * 成功后的计数（提了几篇 / 丢弃几条）与 P7.9 ⑥ 的同一口径：**收进悬停**
 * （「改这 N 篇」按钮的 title）；**出错红字 / 未配置提示照旧可见**（§11 安全例外）。
 *
 * 纪律：
 *  · **只走既有出口**：写盘 = `ui/confirm.ts` + `mover`（`source:'ai'` —— 日志留痕
 *    「AI 建议」+ `ai:true`，§11.1 边界④）。本文件不碰 `vault.process` / `adapter`。
 *  · **落地名的清洗只有一处**（`mover` 的 `cleanNewName`）：确认流的预览直接调它，
 *    预览与执行同源（P6 的 `9.16.md` 教训钉着）。
 *  · **动库前复核存在性**（面板开着的窗口里可能被别处改了 —— 与 suggest-panel 同款）。
 *  · 「AI 指令集」里的笔记**整行禁用**：§11.1 边界③ 拦的是 AI 的写 —— 这条流水线
 *    全程 `source:'ai'`，所以它虽然只是"改名"，也归那道闸管（用户自己 F2 / 菜单改名不受影响）。
 *  · AI 出错**不影响手写**：候选没了，C 项照能敲（这是"允许手改"档的实际价值）。
 *  · **选择与手敲都进 `rows` 数据**（不读渲染闭包）——"就地改的状态不能在渲染闭包里读"
 *    （坑/界面与样式.md 的老账）：重画（AI 回话 / 改完一批）之后选中项与敲进去的字都在。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { joinPath, relativeTo } from '../core/paths';
import { cleanNewName } from '../services/mover';
import { AiError, AI_PROTECTED_WHY, isAiProtected, placeholderTitleNotes, usageLineFor } from '../services/ai';
import { btn, div, el, span } from './primitives';
import { openModal, type PanelHandle } from './panel';
import { confirm, type PlanRow } from './confirm';
import { restoreOrNotify, showUndo } from './undo-bar';
import { AI_NOT_CONFIGURED } from './suggest-panel';
import { NOTIFY_MS, notify, notifyError, notifyLight } from './notify';

/** 卡里选中的是哪一项（null = 还没选；D 是动作不是选项，不进这里） */
type Sel = 'A' | 'B' | 'C' | null;

interface TitleRow {
  /** 相对库根 */
  rel: string;
  /** 当前名（**不带扩展名** —— `NoteEntry.basename` 的口径） */
  current: string;
  /** AI 给的候选（清洗过；空 = 还没回来 / 没给） */
  options: string[];
  /** 硬拦原因（非空 = 整行禁用） */
  blockedWhy: string;
  /** 选中项（A=options[0] · B=options[1] · C=custom） */
  sel: Sel;
  /** C 项就地输入框里敲的内容（**进数据**：重画后不丢） */
  custom: string;
  /** 这一张卡的选项区宿主（就地重画的落点） */
  optsHost: HTMLElement | null;
  /** 就地输入框（C 被点开 / 有内容时才有） */
  input: HTMLInputElement | null;
}

/**
 * @param opts.only **只服务这几篇**（库内绝对路径；P7.12 · R8「自动命名」——编辑器右键
 *   进来时只带当前这一篇，且**它不需要是「未命名」**：用户就是想给这篇起个名）。
 *   不给 = 老路一个字不变（全库的占位标题笔记）。
 */
export function openTitlePanel(
  ctx: WorkbenchContext,
  opts: { only?: string[] } = {},
): PanelHandle {
  const h = openModal({
    title: 'AI 起标题',
    // P7.11 · #3 有意识收紧：**副标题整句删除**（层次靠卡头/选项行立，不靠小字）
    width: 'wide',
    // 面板头标题左侧的 ✦（accent）——与「✦ AI 分类 / 选节」同族标识
    headLeading: [span({ cls: 'kbw-title-star', text: '✦', attr: { 'aria-hidden': 'true' } })],
  });

  const kbRoot = ctx.settings.kbRoot();
  /** 单篇档的名单（相对库根；喂给 `proposeTitles` 的收窄名单） */
  const onlyRels = new Set<string>();
  const picked: { rel: string; entry: ReturnType<typeof ctx.index.get> }[] = [];
  if (opts.only !== undefined) {
    for (const p of opts.only) {
      const entry = ctx.index.get(p);
      if (!entry) continue;
      const rel = relativeTo(entry.path, kbRoot);
      if (!rel || rel === entry.path) continue;
      onlyRels.add(rel);
      picked.push({ rel, entry });
    }
  } else {
    for (const { rel, entry } of placeholderTitleNotes(ctx.index.notes(), kbRoot)) {
      picked.push({ rel, entry });
    }
  }
  const rows: TitleRow[] = [];
  for (const { rel, entry } of picked) {
    /**
     * 🔴 指令集硬拦在**建行时就本地判**（独立审 🔴1）：不许等 AI 回话才有 ——
     * AI 一报错（断网 / key 失效）或占位笔记超过 `titleNotes` 上限时，
     * 原来那些行会带着可用的输入框漏到 `mover`（source:'ai'）跟前。
     * ⚠️ `entry` 理论上有值（上面筛过），但类型是可能为 null —— 拿不到就跳过
     *（执行前 `runRename` 还会按当下重判一遍）。
     */
    if (!entry) continue;
    const blocked = isAiProtected(entry.path, ctx.ai.protectedDir()) ? AI_PROTECTED_WHY : '';
    rows.push({
      rel,
      current: entry.basename,
      options: [],
      blockedWhy: blocked,
      sel: null,
      custom: '',
      optsHost: null,
      input: null,
    });
  }

  let busy: '' | 'ai' | 'run' = '';
  /** 出错 / 未配置（**必须可见**的一句，红字 —— §11 安全例外） */
  let errNote = '';
  /** 成功后的计数（提了几篇 / 丢弃几条）—— P7.9 ⑥ 口径：收进「改这 N 篇」的悬停 */
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
    listHost.appendChild(
      div({
        cls: 'kbw-suggest-empty',
        text:
          opts.only !== undefined
            ? '这一篇不在库里了（可能刚被搬走或改名）'
            : '没有「未命名」的笔记了（可能刚被别处改过）',
      }),
    );
  }

  // ── 状态渲染 ─────────────────────────────────────────────────
  function renderStatus(): void {
    noteEl.textContent = errNote;
    noteEl.classList.toggle('is-hidden', errNote === '');
    noteEl.classList.toggle('is-bad', errNote !== '');
  }

  /** 这一张卡现在敲定的名字（空 = 不进执行名单） */
  function nameOf(row: TitleRow): string {
    if (row.blockedWhy !== '') return '';
    if (row.sel === 'A') return row.options[0] ?? '';
    if (row.sel === 'B') return row.options[1] ?? '';
    if (row.sel === 'C') return row.custom.trim();
    return '';
  }

  /** 选项行的选中态**就地**刷（不重建 —— 输入框正被敲字时不能被换掉） */
  function paintSel(row: TitleRow): void {
    for (const opt of Array.from(row.optsHost?.querySelectorAll<HTMLElement>('.kbw-title-opt[data-key]') ?? [])) {
      const on = opt.dataset.key === row.sel;
      opt.classList.toggle('is-on', on);
      if (opt.getAttribute('role') === 'radio') opt.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /**
   * 重画**一张卡**的选项区（AI 回话 / 点开 C 项时用）。
   * ⚠️ 正在里面敲字（焦点在 C 的输入框）时**跳过** —— 换掉节点 = 当场丢焦点（P7.2c 的教训）。
   */
  function renderOpts(row: TitleRow, force = false): void {
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
      host.appendChild(span({ cls: 'kbw-title-muted', text: '起名中…' }));
    } else if (row.options.length === 0) {
      /**
       * 措辞**不许与事实错位**（独立审 🟡2）：模型没给候选 / 压根没让模型看它
       * 是两件事 —— 后者是 `AI_LIMITS.titleNotes` 上限截出来的，说成"AI 没给"会把人引错方向。
       * ⚠️ AI 出错时 `fedKnown` 为假（我们不知道它看了几篇）→ 回落到通用措辞。
       */
      const text = !ctx.ai.isConfigured()
        ? '没配 AI —— 用「我来取名」自己写一个才能改'
        : fedKnown && !fed.has(row.rel)
          ? '这一轮没让 AI 看它（一次只看最新的一批）—— 自己取名也行'
          : 'AI 没给候选 —— 自己取名也行';
      host.appendChild(span({ cls: 'kbw-title-muted', text }));
    }
    // A/B：候选两项（给不足时**相应缺位、字母不重排**）
    ['A', 'B'].forEach((key, i) => {
      const opt = row.options[i];
      if (opt === undefined) return;
      host.appendChild(optionRow(row, key as 'A' | 'B', opt));
    });
    // C：我来取名（点开就地变输入框）
    if (row.sel === 'C' || row.custom !== '') {
      const wrap = div({ cls: ['kbw-title-opt', row.sel === 'C' ? 'is-on' : null, 'is-input'], data: { key: 'C' } });
      wrap.appendChild(span({ cls: 'kbw-title-key', text: 'C' }));
      const input = el('input', {
        cls: 'kbw-title-input',
        attr: { type: 'text', placeholder: '敲一个名字，回车不算数（点下面按钮才改）', spellcheck: 'false' },
      }) as HTMLInputElement;
      input.value = row.custom;
      input.addEventListener('input', () => {
        row.custom = input.value;
        row.sel = 'C';
        paintSel(row);
        updateBar();
      });
      input.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') evt.stopPropagation();
      });
      row.input = input;
      wrap.appendChild(input);
      host.appendChild(wrap);
    } else {
      const c = optionRow(row, 'C', '我来取名', '点它就地输入');
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
  function optionRow(row: TitleRow, letter: 'A' | 'B' | 'C' | null, label: string, dim = ''): HTMLElement {
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

  /**
   * D · 看看笔记：**先问桥**（P7.2d 的 `ctx.openNoteWindow`）。
   * `true` = 小窗那条路处理了（含"已经开着 → 抬到最前"）；桥没接上（看板模块关着 /
   * 路径不在索引里）才退"开标签页"—— 与「最近改动」同一条退化口径（`blocks/recent.ts`）。
   */
  function openNote(row: TitleRow): void {
    const abs = joinPath(kbRoot, row.rel);
    if (ctx.openNoteWindow?.(abs)) return;
    const f = ctx.app.vault.getAbstractFileByPath(abs);
    if (f instanceof TFile) void ctx.app.workspace.getLeaf('tab').openFile(f);
    else notifyLight('这一篇不在了', row.rel);
  }

  /** 按钮文字 = 现在有几行敲定了名字（空行不进计划；点了提交时还会再过滤一遍） */
  function updateBar(): void {
    if (rows.length === 0) {
      bar.textContent = ''; // 一篇都没有 → 执行条整个收起（别摆「改成这 0 篇的名字」）
      return;
    }
    const n = rows.filter((r) => nameOf(r) !== '').length;
    bar.textContent = '';
    const run = btn({
      cls: ['kbw-btn', 'is-primary', n === 0 ? 'is-disabled' : null],
      // 成功计数（提了几篇 / 丢弃几条）走**悬停** —— P7.9 ⑥ 口径："悬停也算说出来"
      attr: aiStats !== '' ? { title: aiStats } : {},
      text: busy === 'run' ? '改名中…' : `改成这 ${n} 篇的名字`,
      on: { click: () => void runRename() },
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
      head.appendChild(span({ cls: 'kbw-title-cur', text: `《${row.current}》` }));
      head.appendChild(span({ cls: 'kbw-title-rel', text: row.rel, attr: { title: row.rel } }));
      rowEl.appendChild(head);
      row.optsHost = div({ cls: 'kbw-title-opts' });
      rowEl.appendChild(row.optsHost);
      listHost.appendChild(rowEl);
    }
    for (const row of rows) renderOpts(row, true);
  }

  // ── AI 那一跳（开面板就调 —— 行上的 ✦ 是显式的 AI 请求，Q2 拍板"点了就出计划"）──
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
      /**
       * 单篇档（R8「自动命名」）：把名单交下去 —— 服务层据此认这一篇（不必是「未命名」）
       * 并且**整篇为材料**（`titleCharsFull`）；不给名单 = 老路（全库占位标题）一字不变。
       */
      const res = await ctx.ai.proposeTitles(
        opts.only !== undefined ? { notes: Array.from(onlyRels) } : {},
      );
      const blockedOf = new Map(res.blocked.map((b) => [b.rel, b.why]));
      const byRel = new Map(res.items.map((it) => [it.rel, it]));
      for (const row of rows) {
        // 建行时已本地判过一遍了（独立审 🔴1）—— 这里只**跟进不覆盖**：
        // 服务层若报了新命中的（理论上同源），照样禁掉
        if (blockedOf.has(row.rel)) row.blockedWhy = blockedOf.get(row.rel) ?? '';
        row.options = byRel.get(row.rel)?.options ?? [];
        // 选中项引用的候选没了（给不足两项）→ 退回"没选"，别拿旧字母去对空位
        if ((row.sel === 'A' && row.options[0] === undefined) || (row.sel === 'B' && row.options[1] === undefined)) {
          row.sel = null;
        }
      }
      fed = new Set(res.fed);
      fedKnown = true;
      const cfg = ctx.settings.get().ai;
      /** 成功计数 → 进「改这 N 篇」的悬停（P7.9 ⑥ 口径：悬停也算说出来）；用量 → 底栏右端 */
      const bits: string[] = [];
      const got = rows.filter((r) => r.options.length > 0).length;
      if (got > 0) bits.push(`AI 给了 ${got} 篇候选`);
      if (res.blocked.length > 0) bits.push(`拦下 ${res.blocked.length} 篇（AI 指令集只能读）`);
      if (res.dropped > 0) bits.push(`丢弃 ${res.dropped} 条（没照格式 / 路径对不上）`);
      if (bits.length === 0) {
        bits.push(res.reply.trim() !== '' ? `AI：${res.reply.trim()}（没给候选）` : 'AI 没给候选 —— 自己取名也行');
      }
      aiStats = bits.join(' · ');
      usageText = res.usage ? usageLineFor(cfg, 'titles', res.usage) : '';
    } catch (e) {
      aiStats = '';
      errNote =
        (e instanceof AiError ? `AI 出错：${e.hint}` : `AI 出错：${e instanceof Error ? e.message : String(e)}`) +
        '（候选没了，名字照样可以自己写）';
    }
    busy = '';
    renderStatus();
    for (const row of rows) renderOpts(row);
    updateBar();
  }

  // ── 执行：确认流 → mover（一次调用 = 一条快照 = 一条撤销句柄）────
  async function runRename(): Promise<void> {
    if (busy !== '') return;
    const planned: { fromBase: string; finalBase: string; typed: string; file: TFile }[] = [];
    const missing: string[] = [];
    for (const row of rows) {
      if (row.blockedWhy !== '') continue;
      const typed = nameOf(row);
      if (typed === '') continue;
      const abs = joinPath(kbRoot, row.rel);
      // 纵深一道（独立审 🔴1 的修法之一）：建行到执行之间库可能变过（指令集目录新配出来），
      // 执行前按**当下**的 protectedDir 再判一次 —— 这道闸不依赖任何一个上游环节记得判过
      if (isAiProtected(abs, ctx.ai.protectedDir())) continue;
      const f = ctx.app.vault.getAbstractFileByPath(abs);
      if (!(f instanceof TFile)) {
        missing.push(row.rel);
        continue;
      }
      const finalBase = cleanNewName(abs, typed);
      if (finalBase === f.name) continue; // 名字没变 → 不进计划（确认流里不许有"改了个寂寞"的行）
      planned.push({ fromBase: f.name, finalBase, typed, file: f });
    }
    if (missing.length > 0) notifyLight(`${missing.length} 篇执行时已经不在原位（跳过了）`, missing[0]);
    if (planned.length === 0) {
      notify({ kind: 'info', text: '没有要改的名字', detail: '挑一个候选，或自己取一个', ms: NOTIFY_MS.info });
      return;
    }
    const preview: PlanRow[] = planned.map((p) => ({
      kind: 'rename' as const,
      from: p.fromBase,
      to: p.finalBase,
      count: 1,
    }));
    const res = await confirm({
      title: `即将改 ${planned.length} 篇的名字`,
      preview,
      warnings: [],
      notes: [
        '改名不动内容、不换目录；尾链由 Obsidian 在改名那一刻自动跟着改',
        '撞名一律不覆盖：目标同名同内容 = 已改过（跳过）；内容不同 = 真冲突（留着不动）',
        '整批一条撤销：快照还原改回原名',
      ],
      primary: { label: `改这 ${planned.length} 篇` },
    });
    if (res.action !== 'primary') return;

    busy = 'run';
    updateBar();
    const r = await ctx.mover.move({
      targets: planned.map((p) => ({ newName: p.typed, files: [p.file] })),
      source: 'ai',
      reason: `AI 起标题：重命名 ${planned.length} 篇`,
      quiet: true, // 撤销条在（下面 showUndo）→ 不弹重复通知
    });
    if (r.error) {
      busy = '';
      notifyError('改名已中止（一个文件都没动）', r.error);
      updateBar();
      return;
    }
    if (r.moved.length > 0 && r.snapshotId) {
      showUndo({
        text: `已改 ${r.moved.length} 篇的名字`,
        detail: '撤销 = 还原改名前的名字',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, r.snapshotId).then((back) => {
            // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：只判空，不播成功文案
            if (!back) return;
            notifyLight(
              `已还原：改回 ${back.movedBack} 篇`,
              back.blocked.length > 0 ? `${back.blocked.length} 项没动：${back.blocked[0].why}` : '',
            );
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
    }
    if (r.blocked.length > 0) notifyLight(`${r.blocked.length} 篇真冲突没改（目标同名内容不同）`);
    busy = '';
    // 已改完的行撤下去（剩下的还能接着改）。
    // ⚠️ 选中项与敲进去的字都在 `rows` 数据里 —— 重画自动保住（P7.11 · #3 起不再手抄）
    const done = new Set(r.moved.map((m) => relativeTo(m.from, kbRoot)));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (done.has(rows[i].rel)) rows.splice(i, 1);
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
