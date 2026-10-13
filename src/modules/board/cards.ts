/**
 * modules/board/cards.ts —— **一张卡片**（交互规格 §4.2 / §4.3）
 *
 * 三档（看板级一层、板块级可覆盖一层）：
 *   · 只内容（默认）：正文摘要 3 行截断 + 「展开」；属性收成底部一行小字
 *   · 只属性：元数据 kv 表格式
 *   · 两者：属性在上、正文在下
 *
 * 卡片的五种交互**互不打架**，靠"按下后有没有位移 / 按了哪个键 / 点在哪个元素上"区分：
 *   单击（位移 < 4px）→ 悬浮小窗 · 右键 → 笔记菜单 · 悬停滚轮 → 滚正文
 *   勾选框 → 直接写回（`stopPropagation`）· 拖动（位移 ≥ 4px）→ 排序/跨板块
 * 所以这一层**只负责画与转发**，判定与状态都在模块里（`index.ts`）。
 *
 * ⚠️ 两处平台坑：
 *   ① `MarkdownRenderer.render` 第 5 参**必须**是 Component（否则核心从插件栈帧报内存泄漏）
 *   ② 渲染出来的任务勾选框是 `disabled` 的 → **自己摘**；框数与任务行数对不上就**不绑**
 */
import { MarkdownRenderer, type Component } from 'obsidian';
import type { NoteEntry } from '../../core/vault-index';
import type { WorkbenchContext } from '../../core/context';
import { asBool, asList, asString, dotClass } from '../../services/schema';
import { formatRelativeTime } from '../../core/util';
import { div, el, icon, iconBtn, span } from '../../ui/primitives';
import { cardBody, taskItems } from './summary';
import { SCROLL_ATTR } from '../../core/view-memory';
import { markDragEnded, wasDraggingRecently } from '../../ui/dnd';
import { PROPS_RATIO_MAX, PROPS_RATIO_MIN, type BoardView, type CardMode } from './config';

export interface CardOptions {
  ctx: WorkbenchContext;
  view: BoardView;
  entry: NoteEntry;
  /** 文件正文（模块预先读好交进来 —— 卡片自己不碰 IO） */
  text: string;
  cardMode: CardMode;
  /** 卡面显示哪几个属性 */
  props: string[];
  /** 正文是否已展开（模块记着） */
  expanded: boolean;
  /** 这一块设了**固定卡片高度**吗（正文填满 + 内部滚动 → 不画「展开」） */
  fixedHeight?: boolean;
  /** 这张卡的标题正在就地改名吗（菜单「重命名」/ 悬浮小窗之外的那条路） */
  renaming?: boolean;
  /** MarkdownRenderer 要的那第 5 个参数（**必须**有，见文件头） */
  component: Component;
  /**
   * **卡面正文那个滚动容器的 `data-scroll` 键**（重绘保滚动 + 视图记忆用）。
   * 由调用方给（`card:<板块 key>:<路径>`）——为什么带上板块：⚠️ 看板**默认允许重复**
   *（同一篇同时命中两个板块就有两张卡），光用路径会**两张卡共用一个键**（独立审查 🟡3）。
   */
  scrollKey?: string;
  /** 正文还在读（a.6：这一档先把**名字/属性/时间**画出来，正文写"读正文中…"） */
  loading?: boolean;
}

export interface CardCallbacks {
  /**
   * 单击（位移 < 4px）——开悬浮小窗。
   * 第三个参数是 a.5-5 加的：**点在哪一行**（源文件绝对行号，算不出来就是 null）——
   * 悬浮小窗据此把编辑器滚到同一行、光标落在那儿（"起始输入位置 = 单击位置"）。
   */
  onClick: (entry: NoteEntry, evt: MouseEvent, absLine: number | null) => void;
  /** 右键 —— 笔记菜单 */
  onContextMenu: (entry: NoteEntry, evt: MouseEvent) => void;
  /** `Ctrl/Cmd+Enter` 新标签打开 */
  onOpenTab: (entry: NoteEntry) => void;
  /**
   * **双击 = 升格成标签页**（P6 段⑥ ⑤，2026-09-28 拍板；推翻 §12 决策 4 的"不做双击"）。
   *
   * ⚠️ **故意是必填的**（与 `onMore?` / `onRenameCommit?` 那两个可选项不同）：
   * 双击是**核心手势**，漏接线不是"少了棵按钮"，是"点了没反应还不报错"
   *（本项目最忌的那类）。必填 = 建卡片的人必须当场决定它做什么。
   */
  onDoubleClick: (entry: NoteEntry, evt: MouseEvent) => void;
  /** 拖动起手（阈值判定在 `ui/dnd.ts` 里，这里只把 pointerdown 交出去） */
  onPointerDown: (entry: NoteEntry, evt: PointerEvent) => void;
  /**
   * 选择模式下那颗 **⋯**（触屏没有右键 —— §4.2 表里「单篇设置」那一行：
   * 「触屏：选择模式下点该项的 ⋯」）。**必须是桌面右键菜单的同一份实现**
   * （`modules/notes/menus.ts` 的 `showNoteMenu`），别在这儿另写一份。
   * 不传就不画那颗按钮。
   */
  onMore?: (entry: NoteEntry, evt: MouseEvent) => void;
  /** 勾选框：正文里第 `index` 条任务行改成 `checked`（**绝对行号**由模块换算） */
  onToggleTask: (entry: NoteEntry, index: number, checked: boolean, absLine: number) => void;
  /** 「展开 / 收起」 */
  onExpand: (entry: NoteEntry, expanded: boolean) => void;
  /** 就地改名的提交（`commit=false` = 取消）。**不传就不渲染输入框** */
  onRenameCommit?: (entry: NoteEntry, commit: boolean, value: string) => void;
  /**
   * 「两者」档里拖了属性/正文之间的分隔条：`commit=false` = 拖的过程中（只改界面），
   * `commit=true` = 松手（落盘）；`ratio=null` = 双击恢复"自动"。
   */
  /** 拖了分隔条：`global` = 写看板全局默认（Alt+拖）；否则只改这一条笔记 */
  onSplit?: (path: string, ratio: number | null, commit: boolean, global: boolean) => void;
}

/** 卡片里要显示成"彩色点 + 文字"的属性（语义色，方案设计 §5.5） */
const DOT_PROPS = new Set(['状态']);

export function renderCard(o: CardOptions, cb: CardCallbacks): HTMLElement {
  const e = o.entry;
  const hidden = asBool(e.props['隐藏']);
  const card = div({
    cls: ['kbw-card', 'kbw-hover-2', hidden ? 'is-hidden' : null],
    attr: {
      // 拖拽/勾选都靠它认人（卡片自己是拖动**源**，`data-drop` 是放置**目标**）
      'data-path': e.path,
      'data-card': '1',
      tabindex: '-1',
      title: e.path,
    },
  });

  // 标题（就地改名时就地换成输入框）
  if (o.renaming && cb.onRenameCommit) {
    card.appendChild(renameInput(e, cb));
  } else {
    // 悬停给**全名**（长标题会横向滚动，但扫一眼全名更快）；路径在卡片外层的 title 上
    const title = div({ cls: 'kbw-card-t', text: e.basename, attr: { title: e.basename } });
    card.appendChild(title);
    titlePeek(title);
  }
  card.appendChild(div({ cls: 'kbw-card-hr' }));

  const showProps = o.cardMode === 'props' || o.cardMode === 'both';
  const showBody = o.cardMode === 'content' || o.cardMode === 'both';
  if (showProps) card.appendChild(propsTable(e, o.props));

  /**
   * 「两者」档：属性块与正文之间给一根**可拖的分隔条**（用户 2026-09-25 要的）。
   * 比例是**看板级**的（`view.propsRatio`），拖动时改所有卡片（同一块看板里高度一致才好比较）。
   */
  const splittable = showProps && showBody && cb.onSplit;
  if (splittable) {
    /**
     * 比例取三层（用户 2026-09-25 第二版：「我需要的是对**单条笔记**的设置」）：
     * **这一条自己的**（`propsRatioByPath[path]`）→ **看板全局默认**（`propsRatio`）→ 都没有就按内容撑。
     */
    const ratio = o.view.propsRatioByPath?.[e.path] ?? o.view.propsRatio;
    if (ratio != null) {
      card.style.setProperty('--kbw-props-pct', `${Math.round(ratio * 100)}%`);
      card.classList.add('is-split');
    }
    card.appendChild(cardSplit((r, commit, global) => cb.onSplit?.(e.path, r, commit, global)));
  }

  /** 单击位置 → **源文件绝对行号**（a.5-5）；渲染时装配，装不上就返回 null */
  let locate: ((target: HTMLElement | null) => number | null) | null = null;

  if (showBody && o.view.summaryLines > 0) {
    /**
     * `data-scroll` = 视图记忆 / 重绘保持认这个容器的锚（a.6）——键按**路径**，
     * 卡片挪板块、换顺序都不影响。真机实测的 bug：在看板上勾一下勾选框（或同步写进一笔），
     * 看板重绘一次，**卡面正文与各列的滚动位置全部归零**（"勾完它就跳回顶上"）。
     */
    /**
     * **预览换行**（P6b ⑥）：类挂在卡面正文上，样式由 CSS 认
     *（`is-nowrap` = 用户把"预览换行"关掉了 → 文本按原样、容器横向滚）。
     * ⚠️ 边界：`white-space` 只管**文本** —— 表格/代码块仍按内容宽度排（那是 Markdown 的语义）。
     */
    const body = div({
      cls: ['kbw-card-body', o.expanded ? 'is-open' : null, o.view.previewWrap ? null : 'is-nowrap'],
      attr: o.scrollKey ? { [SCROLL_ATTR]: o.scrollKey } : {},
    });
    body.style.setProperty('--kbw-summary-lines', String(o.view.summaryLines));
    card.appendChild(body);
    const src = cardBody(o.text, {
      stripFrontmatter: o.view.stripFrontmatter,
      stripTail: o.view.stripTail,
      markers: o.view.stripMarkers,
      title: e.basename,
    });
    renderBody(o, src.text, src.lineOffset, body, card, cb);
    locate = makeLocator(body, src.text, src.lineOffset);
    // 固定高度时正文已经填满并可滚（`--kbw-card-h`），「展开」没有可展开的东西
    if (!o.fixedHeight) card.appendChild(expandBar(e, cb));
  }

  // 底部一行小字：状态点 + 平台 + 相对时间（「只内容」档的属性就收在这）
  if (o.cardMode === 'content') card.appendChild(metaLine(e));

  /**
   * **⋯：只在选择模式出现**（触屏的单篇菜单入口，§4.2）。
   * 与网格档那颗 `.kbw-gmore` 同一口径：同一个位置（左上角）、同样"渲染时就在 DOM 里、
   * 靠 `.is-selectmode` 才显形"——不这么写就得在选择模式进出时重画整块看板（会丢滚动位置）。
   */
  if (cb.onMore) {
    card.appendChild(
      iconBtn(
        'more-horizontal',
        `「${e.basename}」的更多操作`,
        (evt) => {
          evt.stopPropagation();
          cb.onMore?.(e, evt);
        },
        { size: 14, cls: 'kbw-card-morebtn' },
      ),
    );
  }

  card.addEventListener('pointerdown', (evt) => {
    const t = evt.target as HTMLElement | null;
    // 勾选框/展开条/分隔条/链接/⋯ 自己处理，别起拖
    if (t?.closest?.('input, .kbw-card-more, .kbw-card-morebtn, .kbw-card-split, a, code')) return;
    cb.onPointerDown(e, evt as PointerEvent);
  });
  card.addEventListener('click', (evt) => {
    const t = evt.target as HTMLElement | null;
    if (t?.closest?.('input, .kbw-card-more, .kbw-card-morebtn, a')) return;
    /**
     * ⚠️ **刚拖过就把这一发 click 吞掉**（a.5-1）：`pointerup` 上的 preventDefault 拦不住 click，
     * "拖出去再拖回原处松手"会补一发 click → 弹出悬浮小窗（用户报的"有概率触发单击效果"）。
     */
    if (wasDraggingRecently()) return;
    cb.onClick(e, evt, locate ? locate(t) : null);
  });
  /**
   * **双击 = 升格成标签页**（P6 段⑥ ⑤）。
   *
   * 两条与本文件其它手势**同源**的口径，一条都不能省：
   *  · 与 `click` 同一份排除名单（勾选框 / ⋯ / 链接由它们自己处理）；
   *  · `wasDraggingRecently()` —— 拖完浏览器补的那一发不只有 `click`，**双击也一样会补**
   *   （拖出去再拖回原处双击 = 不该升格）。
   *
   * ⚠️ **不要 `preventDefault()`**：默认行为只是选中文字，而卡片上的文字选中
   * 由 `user-select` 管（`styles/notes.css` 那一套），在这里拦一道只会多一个说不清的行为。
   */
  card.addEventListener('dblclick', (evt) => {
    const t = evt.target as HTMLElement | null;
    if (t?.closest?.('input, .kbw-card-more, .kbw-card-morebtn, .kbw-card-split, a, code')) return;
    if (wasDraggingRecently()) return;
    cb.onDoubleClick(e, evt);
  });

  card.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    cb.onContextMenu(e, evt);
  });
  card.addEventListener('keydown', (evt) => {
    const k = evt as KeyboardEvent;
    if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) {
      k.preventDefault();
      k.stopPropagation();
      cb.onOpenTab(e);
    }
  });
  card.addEventListener('wheel', (evt) => onWheel(evt as WheelEvent, card), { passive: false });

  return card;
}

/**
 * **任务列表按「条数」截**（a.5-4）。
 *
 * 为什么不能只靠 CSS 的 `-webkit-line-clamp`：它数的是**视觉行**，
 * 而任务列表的第一条往往带着嵌套子项（真机实测 `9.16.md`：25 条任务，
 * 第一条"明日方舟"连子项就占满 3 行 → **只看得见 1 条**）。
 * 所以改成：每条清单连着数，超额的 `li` 打 `.kbw-li-over`，折叠态由 CSS 藏起来。
 *
 * ⚠️ **只在 DOM 上打标记，不动正文** —— 「展开」是就地切 class，
 * 源码层截断的话展开也就不回来了（那是"任务越点越少"的 bug）。
 * ⚠️ 嵌套子项**跟着父项一起算一条**（它们本来就住在父 `li` 里，父被藏 = 一起藏）。
 * ⚠️ 只数**顶级清单**（`closest('li')` 落在 host 里的说明它是嵌套的，跳过），否则同一个 li 会被数两遍。
 *
 * 返回被藏起来的条数（用例断言用）。
 */
export function applyListBudget(host: HTMLElement, maxItems: number): number {
  if (maxItems <= 0) return 0;
  const lists = Array.from(host.querySelectorAll<HTMLElement>('ul, ol')).filter((l) => {
    const owner = l.closest('li');
    return !owner || !host.contains(owner);
  });
  if (lists.length === 0) return 0;
  let seen = 0;
  let marked = 0;
  for (const list of lists) {
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      seen += 1;
      const over = seen > maxItems;
      li.classList.toggle('kbw-li-over', over);
      if (over) marked += 1;
    }
  }
  /**
   * ⚠️ `is-list-body` **只在"正文第一个块级子元素就是清单"时才打**（独立审查 🟡8）：
   * 它会让折叠态**放开整篇的行数截断** —— 一篇"段落 + 一条 bullet"的笔记被误判成清单卡的话，
   * 整篇会摊开、卡片高度失控（跟"摘要行数"的初衷相反）。
   */
  const firstBlock = Array.from(host.children).find(
    (el) => !/^H[1-6]$/.test((el as HTMLElement).tagName),
  ) as HTMLElement | undefined;
  if (firstBlock && /^(UL|OL)$/.test(firstBlock.tagName)) host.classList.add('is-list-body');
  return marked;
}

/**
 * **单击位置 → 源文件绝对行号**（a.5-5）。
 *
 * 两档，都是"算不准就不跳"：
 *  ① **任务行**：点到哪条任务上 → 它就是第几个勾选框 → 用 `taskItems()` 的行号（精确）。
 *     这条路能成立，是因为勾选框直写（§4.2）早就把"第 n 个框 ↔ 第 n 条任务行"钉住了。
 *  ② **普通段落**：拿点到的这块文字去源文里找**唯一**匹配；匹配到 0 条或 ≥2 条就返回 null
 *     （宁可不动，也别把光标甩到不相干的一行 —— 渲染层拿不到源行号，这是唯一诚实的近似）。
 */
export function makeLocator(
  body: HTMLElement,
  srcText: string,
  lineOffset: number,
): (target: HTMLElement | null) => number | null {
  return (target) => {
    if (!target || !body.contains(target)) return null;
    const li = target.closest('li');
    if (li && li.querySelector('input[type="checkbox"]')) {
      const taskLis = Array.from(body.querySelectorAll('li')).filter((x) =>
        x.querySelector('input[type="checkbox"]'),
      );
      const tasks = taskItems(srcText);
      /**
       * ⚠️ **框数对不上就不走这条路**（独立审查 🟡11）：渲染器与 `taskItems` 口径不一致时，
       * 勾选框绑定那条路已经明确"宁可不绑"（`bindTaskBoxes`）—— 这里也必须一致，
       * 否则"勾不动但单击会把光标甩到另一行"，方向正好跟红线相反。
       */
      if (taskLis.length === tasks.length) {
        const i = taskLis.indexOf(li);
        if (i >= 0 && tasks[i]) return tasks[i].line + lineOffset;
      }
    }
    const txt = (target.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (txt.length < 6) return null;
    const hits = srcText
      .split('\n')
      .map((line, i) => ({ i, t: line.trim().replace(/\s+/g, ' ') }))
      .filter((x) => x.t.includes(txt));
    return hits.length === 1 ? hits[0].i + lineOffset : null;
  };
}

/**
 * 卡片标题的就地输入框（§8.3「重命名」在看板这一屏的落点）。
 * ⚠️ 它必须存在：`showNoteMenu` 的「重命名」会调到看板的 `onRename`，
 * 而早先那条路只改了个 state、**没人渲染输入框** —— 点了没反应（独立审查 R4）。
 */
function renameInput(e: NoteEntry, cb: CardCallbacks): HTMLElement {
  const input = el('input', {
    cls: 'kbw-inline-input',
    attr: { type: 'text', value: e.basename, 'aria-label': '新名字' },
  });
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    cb.onRenameCommit?.(e, commit, input.value.trim());
  };
  input.addEventListener('keydown', (evt) => {
    const k = evt as KeyboardEvent;
    if (k.key === 'Enter') {
      k.preventDefault();
      k.stopPropagation();
      finish(true);
    } else if (k.key === 'Escape') {
      k.preventDefault();
      k.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  // 起手选中原名：改名多半是"改一小段"，不是重打
  window.setTimeout(() => {
    input.focus();
    input.select?.();
  }, 0);
  return input;
}

/**
 * 展开条。⚠️ 点击时读**当前**的 class，**不能读渲染时那个 `expanded` 闭包值** ——
 * 展开是就地改 class（不重画卡片），闭包里那个值永远是渲染那一刻的 `false`，
 * 于是"展开 → 再点"会第二次送出 `true`（永远收不起来）。paint 重画后才纠正，
 * 症状看起来像"点两下才有反应"。
 */
function expandBar(e: NoteEntry, cb: CardCallbacks): HTMLElement {
  const bar = div({
    cls: 'kbw-card-more',
    attr: { role: 'button', tabindex: '0' },
    on: {
      click: (evt) => {
        evt.stopPropagation();
        cb.onExpand(e, !bar.classList.contains('is-open'));
      },
    },
  });
  bar.appendChild(span({ text: '展开' }));
  bar.appendChild(icon('chevron-down', 13));
  return bar;
}

/**
 * 悬停滚轮：**滚指针底下那一块**，到顶/底后接力滚动看板（决策 1）。
 *
 * ⚠️ 用户 2026-09-25 补的那半句："对于未显示全的内容，悬停在对应板块上下滑动滚轮时，
 * 即滚动对应的属性/内容的文字" —— 所以**先看指针在属性块上还是正文块上**
 *（以前只会滚正文：指针在属性那块上滚，会把正文滚走，看着像滚错了地方）。
 * ⚠️ 必须 `{ passive: false }` —— 否则 `preventDefault` 无效、页面会跟着一起滚。
 */
function onWheel(evt: WheelEvent, card: HTMLElement): void {
  const t = evt.target as HTMLElement | null;
  const hovered = t?.closest?.('.kbw-card-kv') as HTMLElement | null;
  const body = hovered ?? card.querySelector<HTMLElement>('.kbw-card-body');
  if (!body || body.scrollHeight <= body.clientHeight + 1) return; // 没溢出 → 交给看板滚
  const atTop = body.scrollTop <= 0;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
  const down = evt.deltaY > 0;
  if ((down && atBottom) || (!down && atTop)) return; // 到边了 → 接力给看板
  evt.preventDefault();
  evt.stopPropagation();
  body.scrollTop += evt.deltaY;
}

/**
 * **长标题的悬停预览**（用户 2026-09-25 要的："假如标题过长，建议增加左右拖动预览功能"）。
 *
 * 悬停时若标题溢出，就让它自己慢慢滑到尾巴、再滑回头（一趟来回，回到头就停）。
 *
 * ⚠️ **为什么不做成"左右拖动"**：标题正是**卡片的拖动把手**（a.5 那条"拖动后吞掉那一发 click"
 * 的判据就挂在 `.kbw-card-t` 上，用户也一直用它拖卡片）—— 把拖动绑给"预览"就等于拖不动卡片了。
 * 悬停滑出是同一个诉求（看全名字）且不抢手势。触屏没有 hover，但标题本来就能横向扫（`overflow-x`）。
 */
function titlePeek(t: HTMLElement): void {
  let timer = 0;
  const stop = (): void => {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  };
  t.addEventListener('pointerenter', () => {
    if (t.scrollWidth - t.clientWidth <= 8) return; // 没溢出就别动它
    stop();
    let dir = 1;
    timer = window.setInterval(() => {
      const max = t.scrollWidth - t.clientWidth;
      if (max <= 0) {
        stop();
        return;
      }
      t.scrollLeft += dir * 2; // 16ms × 2px ≈ 125px/s：够慢，看得清
      if (dir > 0 && t.scrollLeft >= max - 0.5) dir = -1;
      else if (dir < 0 && t.scrollLeft <= 0.5) stop();
    }, 16);
  });
  t.addEventListener('pointerleave', () => {
    stop();
    t.scrollLeft = 0; // 离开就归位，下次悬停从头开始
  });
}

/**
 * 「两者」档里，属性块与正文块之间的**分隔条**（用户 2026-09-25 要的）。
 *
 * 四条要点（都是本项目踩过的类）：
 *  ① **拖动过程只改 CSS 变量**，松手才落盘 —— 一次拖动几十个事件，每个都写 JSON 是不行的
 *     （与 `Ctrl+滚轮` 缩放同一套做法）。
 *  ② `pointercancel` 与 `pointerup` 走**同一个 `finish`**：触屏滚动接管手势时 cancel 必然发生，
 *     不处理就会卡在"拖动中"（老账）。
 *  ③ `touch-action: none` 写在 CSS 里，否则触屏上浏览器会把它当滚动接管掉。
 *  ④ 比例按**卡片的 padding box** 算（不是 border box）—— 否则上下各差一个内边距，
 *     拖到两端时会差几像素对不上。
 */
function cardSplit(
  onSplit: (ratio: number | null, commit: boolean, global: boolean) => void,
): HTMLElement {
  const bar = div({
    cls: 'kbw-card-split',
    attr: {
      role: 'separator',
      tabindex: '0',
      'aria-label': '拖动调整属性与正文的高度；双击恢复自动',
      title: '拖动调整「属性 / 正文」各占多高（只影响这一条；Alt+拖 = 全部笔记的默认；双击恢复自动）',
    },
  });
  bar.appendChild(span({ cls: 'kbw-card-split-grip' }));

  /** 指针的 y → 属性块该占的比例（按卡片内容盒算） */
  const ratioFrom = (clientY: number): number | null => {
    const card = bar.closest<HTMLElement>('.kbw-card');
    if (!card) return null;
    const cs = getComputedStyle(card);
    const rect = card.getBoundingClientRect();
    const top = rect.top + parseFloat(cs.paddingTop);
    const h = rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(h > 40)) return null;
    const want = (clientY - top) / h;
    return Math.min(PROPS_RATIO_MAX, Math.max(PROPS_RATIO_MIN, want));
  };

  let dragging = false;
  const finish = (commit: boolean, clientY?: number, global = false): void => {
    if (!dragging) return;
    dragging = false;
    unhook(); // 别把 document 上那三个监听留成"每次拖一根、攒一堆"（它们靠 dragging 兜着，但没必要留着）
    /**
     * ⚠️ **自己实现的拖动要自己记这一笔**（用户 2026-09-25："拖动调整占比后会识别成普通左键单击、
     * 打开小窗"）：分隔条没走 `startPointerDrag` 基元，所以浏览器补的那发 `click`
     * 会被卡片的单击处理器收下。跟基元同一口径（同一个 `dragEndedAt` → 150ms 窗口）。
     */
    markDragEnded();
    const ratio = commit && clientY != null ? ratioFrom(clientY) : null;
    onSplit(ratio, true, global);
  };

  bar.addEventListener('pointerdown', (evt) => {
    evt.preventDefault();
    // 卡片与看板的拖动都挂在 pointerdown 上 —— 这里必须拦住，否则拖分隔条会变成拖卡片
    evt.stopPropagation();
    dragging = true;
    try {
      bar.setPointerCapture(evt.pointerId);
    } catch {
      /* 捕获是尽力而为的，下面 document 上那套才是兜底 */
    }
    document.addEventListener('pointermove', onDocMove);
    document.addEventListener('pointerup', onDocUp);
    document.addEventListener('pointercancel', onDocUp);
  });
  const onDocMove = (evt: PointerEvent): void => {
    if (!dragging) return;
    const ratio = ratioFrom(evt.clientY);
    if (ratio != null) onSplit(ratio, false, false);
  };
  /** Alt + 拖 = 写「全部笔记的默认」；不按 Alt 就只改这一条（两条路都留着，用户要的） */
  const onDocUp = (evt: PointerEvent): void => finish(true, evt.clientY, evt.altKey === true);
  const unhook = (): void => {
    document.removeEventListener('pointermove', onDocMove);
    document.removeEventListener('pointerup', onDocUp);
    document.removeEventListener('pointercancel', onDocUp);
  };
  bar.addEventListener('dblclick', (evt) => {
    evt.stopPropagation();
    onSplit(null, true, evt.altKey === true); // 恢复「自动」（Alt = 清掉全局那份）
  });
  /** 键盘：聚焦在分隔条上时用上下键微调（可达性 —— 拖拽动作要有非拖拽等价物） */
  bar.addEventListener('keydown', (evt) => {
    const step = evt.key === 'ArrowUp' ? -0.04 : evt.key === 'ArrowDown' ? 0.04 : 0;
    if (step === 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    const card = bar.closest<HTMLElement>('.kbw-card');
    const cur = card ? parseFloat(card.style.getPropertyValue('--kbw-props-pct')) : NaN;
    const base = Number.isFinite(cur) ? cur / 100 : 0.4;
    onSplit(Math.min(PROPS_RATIO_MAX, Math.max(PROPS_RATIO_MIN, base + step)), true, evt.altKey === true);
  });
  return bar;
}

/** 属性表格式（只属性 / 两者） */
function propsTable(e: NoteEntry, props: string[]): HTMLElement {
  const wrap = div({ cls: 'kbw-card-kv' });
  let shown = 0;
  for (const p of props) {
    const raw = e.props[p];
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;
    // ⚠️ 标签与值是**同一层**的两个网格项（不是一行的两个 flex 子元素）——
    // 两层结构的话，"值那一列对齐"要靠每一行自己算宽度，做不到（用户反馈的"没对齐"）
    wrap.appendChild(span({ cls: 'kbw-kv-k', text: p }));
    const v = div({ cls: 'kbw-kv-v', attr: { title: asList(raw).join(' · ') || asString(raw) } });
    if (DOT_PROPS.has(p)) {
      const value = asString(raw);
      v.appendChild(span({ cls: ['kbw-dot-txt', dotClass(value)] }, span({ cls: 'kbw-dot' }), value));
    } else {
      v.textContent = asList(raw).join(' · ') || asString(raw);
    }
    wrap.appendChild(v);
    shown += 1;
  }
  if (shown === 0) wrap.appendChild(div({ cls: 'kbw-kv-empty', text: '（这篇没有这几个属性）' }));
  return wrap;
}

/** 底部一行小字 */
function metaLine(e: NoteEntry): HTMLElement {
  const line = div({ cls: 'kbw-card-meta' });
  const status = asString(e.props['状态']);
  if (status) {
    line.appendChild(span({ cls: ['kbw-dot-txt', dotClass(status)] }, span({ cls: 'kbw-dot' }), status));
  }
  const tail: string[] = [];
  if (e.mtime) tail.push(formatRelativeTime(e.mtime));
  if (tail.length > 0) line.appendChild(span({ cls: 'kbw-card-meta-x', text: tail.join(' · ') }));
  return line;
}

/**
 * 渲染正文（**真 Markdown**）。为什么用平台渲染器而不是自己拼文本：
 * 正文里的任务勾选框要能直接勾（§4.2）—— 那是渲染出来的 DOM，不是字符串。
 */
function renderBody(
  o: CardOptions,
  text: string,
  lineOffset: number,
  host: HTMLElement,
  card: HTMLElement,
  cb: CardCallbacks,
): void {
  if (text.trim() === '') {
    /**
     * ⚠️ 两种"没正文"要分开说（用户 2026-09-25 反馈："加载时至少保留下名字"）：
     *  · 正文还在读（`loading`）→ 「读正文中…」（骨架期只灰条、连名字都没有 = 看不出是哪篇）
     *  · 真的没正文 → 「（还没有正文）」
     */
    host.appendChild(
      div({
        /**
         * `is-loading` 不只是给样式用的：**模块靠它判断"要不要补画"**
         *（`paintBoard` 那段两段式绘制 —— 读正文的过程中若插进来一次别的重绘，
         * 屏幕上就停在这个占位上，见那边的注释）。所以这个类**不能省**。
         */
        cls: ['kbw-card-empty', o.loading ? 'is-loading' : null],
        text: o.loading ? '读正文中…' : '（还没有正文）',
      }),
    );
    return;
  }
  const done = (): void => {
    /**
     * 🔴 **固定高度档不做"按条数截"**（独立审查抓到，会真丢内容）：那一档**不画「展开」条**
     * （正文已经填满、内部可滚，见 `if (!o.fixedHeight)`），而 `.kbw-li-over` 是 `display:none` ——
     * 于是被藏起来的那几条**没有任何办法回来**（`overflow:auto` 滚不出 `display:none`）。
     * 传 0 = 不截（`applyListBudget` 对 `maxItems <= 0` 直接返回），让那一档靠"填满 + 内部滚"。
     */
    applyListBudget(host, o.fixedHeight ? 0 : o.view.summaryLines);
    bindTaskBoxes(o, text, lineOffset, host, card, cb);
  };
  try {
    const p = MarkdownRenderer.render(o.ctx.app, text, host, o.entry.path, o.component);
    void Promise.resolve(p).then(done, (err: unknown) => {
      console.error('[经纬] 卡片正文渲染失败', err);
      host.textContent = text;
    });
  } catch (err) {
    console.error('[经纬] 卡片正文渲染失败', err);
    host.textContent = text;
  }
}

/**
 * 勾选框直写（§4.2）：
 *   · 渲染出来的框是 `disabled` → **自己摘**
 *   · 第 n 个框 ↔ 第 n 条任务行（**框数对不上宁可不绑** —— 绑错比不绑更糟）
 *   · `stopPropagation` —— 勾一下不该顺手弹出悬浮小窗
 */
function bindTaskBoxes(
  o: CardOptions,
  text: string,
  lineOffset: number,
  host: HTMLElement,
  card: HTMLElement,
  cb: CardCallbacks,
): void {
  const boxes = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  if (boxes.length === 0) return;
  const tasks = taskItems(text);
  if (boxes.length !== tasks.length) {
    /**
     * 对不上就**不绑**——静默绑错会让"勾一下改了别处一行"。
     * 走到这里通常意味着正文里有渲染器认得出、而 `taskItems` 认不出的东西（或反之），
     * 该修的是判据，不是放宽这里（a.6 就修了一条：缩进深太多的任务行渲染成普通文字，
     * 见 `summary.taskItems` 的头注释 —— 那是真机上真出现过的形状）。
     *
     * 🔴 **必须自己把它按成只读**（a.6 真机实测的修正）：原先这里只 `return`，
     * 注释里写着"框仍是只读的灰框" —— **那是错的**：平台这个渲染位置给出的框
     * **没有 disabled**（实测 `disabled` 全为 false），不绑 = 点一下框**照常翻**、
     * 文件却一个字节都不动 → 用户看到的是"勾了没保存"（比"点不动"更难查）。
     */
    card.dataset.taskMismatch = `${boxes.length}/${tasks.length}`;
    for (const box of boxes) {
      box.disabled = true;
      box.setAttribute('disabled', '');
      box.setAttribute('title', '这一篇的任务行数与渲染出来的框数对不上，勾选已停用（详见控制台）');
    }
    console.warn(
      `[经纬] 勾选框未绑定：${o.entry.path} 渲染出 ${boxes.length} 个框、源文件里认得出 ${tasks.length} 条任务行`,
    );
    return;
  }
  delete card.dataset.taskMismatch;
  boxes.forEach((box, i) => {
    box.disabled = false;
    box.removeAttribute('disabled');
    const stop = (evt: Event): void => evt.stopPropagation();
    box.addEventListener('pointerdown', stop);
    box.addEventListener('click', (evt) => {
      evt.stopPropagation();
      // 绝对行号 = 卡面行号 + 剥前言去掉的行数（剥尾链只从末尾切，不影响前面的行号）
      cb.onToggleTask(o.entry, i, box.checked, tasks[i].line + lineOffset);
    });
  });
}

/** 空板块的引导（§4.1 空态） */
export function emptySection(text: string, hint?: string): HTMLElement {
  const wrap = div({ cls: 'kbw-sect-empty' });
  wrap.appendChild(div({ cls: 'kbw-sect-empty-t', text }));
  if (hint) wrap.appendChild(div({ cls: 'kbw-sect-empty-s', text: hint }));
  return wrap;
}
