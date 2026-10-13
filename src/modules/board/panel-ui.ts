/**
 * modules/board/panel-ui.ts —— 小窗（面板）里那三个**控件**（f 期第 2 / 4 / 5 条）
 *
 * 为什么单独一个文件：`editor.ts` 是面板的**状态机**（tab 增删、叶的生死、停靠、
 * 配置重建），f 期多悬浮窗那一改已经把它推到 1700 行；这一期的三个新控件
 * （可拖分隔条 / 字号缩放 / 尾链折叠）都是"给一个元素、做一件事"的独立活儿，
 * 混进状态机里只会让"多窗"那份 diff 更难读。
 *
 * ⚠️ 依赖方向：本文件**不 import `editor.ts`**（那边 import 这边，单向）——
 * 参数一律是 DOM 元素与回调，所以这三个控件离线可单独测。
 *
 * 三条真机取证的结论都写在各自函数顶上（`看板优化方案.md` §6.18 有汇总）：
 *   · 字号：给**面板自己**的那一层设 `--font-text-size`，真通（实测 16 → 20px，行高跟着走）
 *   · 折叠：平台的折叠指示器是**标题行里的 `.cm-fold-indicator`**（不是 CM 的 gutter），
 *     派一发 `click` 就能折（实测 17 → 14 行、指示器带 `is-collapsed`）
 *   · 分隔条：形状照卡片那根（`cards.ts` 的 `cardSplit`），只是方向对调成"面板里属性在上"
 */
import { div, span } from '../../ui/primitives';
import { tailHeadingLine } from '../../services/templates';
import { PROPS_RATIO_MAX, PROPS_RATIO_MIN } from './config';
import { markDragEnded } from '../../ui/dnd';

// ────────────────────────────────────────────────────────────────
// ① 属性 / 正文之间那根可拖的分隔条（第 5 条）
// ────────────────────────────────────────────────────────────────
/**
 * 面板里那根分隔条。**形状与卡片那根一致**（`cards.ts` 的 `cardSplit`），四条要点照搬：
 *  ① 拖动过程只改 CSS 变量，松手才落盘（一次拖动几十个事件，每个都写 JSON 不行）
 *  ② `pointercancel` 与 `pointerup` 走**同一个** `finish`（触屏滚动接管手势时必然 cancel）
 *  ③ `touch-action: none` 写在 CSS 里
 *  ④ 比例按**页的内容盒**算（不是 border box）
 * 另加一条（卡片那边踩过）：**自己实现的拖动要自己 `markDragEnded()`** ——
 * 否则松手后浏览器补的那发 `click` 会被别的处理器当成单击收下。
 *
 * 💡 键盘可达（WCAG 2.2 Dragging Movements 要的**非拖动等价物**）：聚焦后 `↑/↓` 微调、
 * `Home`/`End` 到两端、**双击 = 恢复自动**（与卡片同一套手感）。
 *
 * @param pageOf 取"这一页"（比例的分母）—— 拖的是哪一页由调用方说了算
 * @param onRatio `commit=false` = 拖动途中（只改视觉）；`commit=true` = 落盘。
 *                `ratio=null` = 恢复自动；`global=true` = 写"所有窗的默认"（Alt/双击+Alt）
 */
export function panelSplit(
  pageOf: () => HTMLElement | null,
  onRatio: (ratio: number | null, commit: boolean, global: boolean) => void,
): HTMLElement {
  const bar = div({
    cls: 'kbw-cw-split',
    attr: {
      role: 'separator',
      tabindex: '0',
      'aria-label': '拖动调整属性与正文的高度；双击恢复自动',
      title: '拖动调整「属性 / 正文」各占多高（只影响这一篇；Alt+拖 = 所有小窗的默认；双击恢复自动）',
    },
  });
  bar.appendChild(span({ cls: 'kbw-cw-split-grip' }));

  /** 指针的 y → 属性块该占的比例（按页的内容盒算） */
  const ratioFrom = (clientY: number): number | null => {
    const page = pageOf();
    if (!page) return null;
    const cs = getComputedStyle(page);
    const rect = page.getBoundingClientRect();
    const top = rect.top + parseFloat(cs.paddingTop || '0');
    const h = rect.height - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
    if (!(h > 40)) return null;
    const want = (clientY - top) / h;
    return Math.min(PROPS_RATIO_MAX, Math.max(PROPS_RATIO_MIN, want));
  };

  let dragging = false;
  const unhook = (): void => {
    document.removeEventListener('pointermove', onDocMove);
    document.removeEventListener('pointerup', onDocUp);
    document.removeEventListener('pointercancel', onDocUp);
  };
  const finish = (commit: boolean, clientY?: number, global = false): void => {
    if (!dragging) return;
    dragging = false;
    unhook();
    markDragEnded();
    const ratio = commit && clientY != null ? ratioFrom(clientY) : null;
    onRatio(ratio, true, global);
  };
  const onDocMove = (evt: PointerEvent): void => {
    if (!dragging) return;
    const ratio = ratioFrom(evt.clientY);
    if (ratio != null) onRatio(ratio, false, false);
  };
  const onDocUp = (evt: PointerEvent): void => finish(true, evt.clientY, evt.altKey === true);

  bar.addEventListener('pointerdown', (evt) => {
    evt.preventDefault();
    // 面板头上还有拖动与"单击开窗"那套 —— 这里必须拦住，否则拖分隔条会变成拖窗口
    evt.stopPropagation();
    dragging = true;
    try {
      bar.setPointerCapture(evt.pointerId);
    } catch {
      /* 捕获尽力而为，document 上那套才是兜底 */
    }
    document.addEventListener('pointermove', onDocMove);
    document.addEventListener('pointerup', onDocUp);
    document.addEventListener('pointercancel', onDocUp);
  });

  bar.addEventListener('dblclick', (evt) => {
    evt.stopPropagation();
    onRatio(null, true, evt.altKey === true); // 恢复「自动」（Alt = 连全局那份一起清）
  });

  bar.addEventListener('keydown', (evt) => {
    const page = pageOf();
    const cur = page ? parseFloat(page.style.getPropertyValue('--kbw-cw-props-pct')) / 100 : NaN;
    const base = Number.isFinite(cur) ? cur : 0.4;
    const next =
      evt.key === 'ArrowUp'
        ? base - 0.04
        : evt.key === 'ArrowDown'
          ? base + 0.04
          : evt.key === 'Home'
            ? PROPS_RATIO_MIN
            : evt.key === 'End'
              ? PROPS_RATIO_MAX
              : null;
    if (next == null) return;
    evt.preventDefault();
    evt.stopPropagation();
    onRatio(Math.min(PROPS_RATIO_MAX, Math.max(PROPS_RATIO_MIN, next)), true, evt.altKey === true);
  });

  return bar;
}

/**
 * 比例落到这一页上（**唯一落点**：画页时、拖动途中、配置变了都走它）。
 *
 * `ratio == null` = 自动 → 摘掉 `is-split` 与那个自定义属性，
 * 布局回到"正文拿到足够高度、属性块限高且中段可滚"（CSS 里那两条默认规则）。
 */
export function applyPanelRatio(page: HTMLElement, ratio: number | null): void {
  if (ratio == null) {
    page.classList.remove('is-split');
    page.style.removeProperty('--kbw-cw-props-pct');
    return;
  }
  page.style.setProperty('--kbw-cw-props-pct', `${Math.round(ratio * 100)}%`);
  page.classList.add('is-split');
}

// ────────────────────────────────────────────────────────────────
// ② 字号缩放（第 2 条）
// ────────────────────────────────────────────────────────────────
/**
 * 默认字号比平台基准小多少 px。
 *
 * · C1（2026-09-27）：拍板"平台 −2px"；
 * · **P6b ⑤（同日第二轮反馈）：再降一档 → −2px**（真机 16 → **14px**）。原话是
 *   "悬浮窗口笔记正文默认大小**还是大了**"。
 * ⚠️ **只有这一处能改这个数** —— 菜单上那句"默认（平台 −2px）"也是按它算的。
 * ⚠️ 这是"**改常数**"不是"改语义"：`panelFont: 0` 仍然是"没设过"，
 *   所以**不需要迁移**（存量没单独设过的自动跟着变；单独设过的那几篇由
 *   `panelByPath[].font` 优先，不受影响）。
 */
export const PANEL_FONT_DELTA = -2;

/**
 * **平台的正文基准字号**（`--font-text-size`，真机 16px）。
 * 我们的字号档是"没设过"（`0` → 默认 = 平台 −2px）或一个具体 px —— 面板自己那几行的缩放比例
 * 要拿它当分母（`--kbw-cw-scale`），否则"15px 在 16px 基准上"算不出倍数。
 * ⚠️ 离线桩里读不到（返回空串）→ 兜底 16。
 */
export function platformBaseFont(): number {
  try {
    const raw = getComputedStyle(document.body).getPropertyValue('--font-text-size');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n >= 8 && n <= 40 ? n : 16;
  } catch {
    return 16;
  }
}

/**
 * **默认字号 = 平台基准 − 1**（C1，用户 2026-09-27 拍板："笔记悬浮小窗默认字体大了点"）。
 *
 * 为什么是"−1"而不是写死 15px：平台的字体大小是**用户自己的设置**，
 * 跟着它走、永远小一档，才不会出现"用户把平台调大之后小窗显得格外小"。
 */
export function defaultPanelFont(): number {
  return Math.max(8, Math.round(platformBaseFont()) + PANEL_FONT_DELTA);
}

/**
 * 把字号落到这一页上。`fs <= 0` = **没设过** → 用默认（平台 −2px，见上）。
 *
 * 两个机制（**同一个值**算出来，别各写一份）：
 *  · `--font-text-size` ＋ `--font-preferred-size` → 正文本体（**两个都要设**，见下）
 *  · `--kbw-cw-scale`    → 面板自己那几行（属性名 / 提示 / tab / 标题），由 CSS 乘上去
 *
 * 🔴 **为什么两个变量都设**（P7.12 收尾真机抓到）：当前平台（Obsidian 1.13.7）的
 * 正文规则是 `.markdown-source-view { font-size: var(--font-preferred-size) }`，
 * 而 `--font-preferred-size` 在 **body 层**就以 `var(--font-text-size)` **代入定死**（计算值 16px）——
 * 作用域里只设 `--font-text-size`，**`.cm-content` 收不到**（真机实测：16 → 16；补设
 * `--font-preferred-size` 当场 16 → 14 ✓）。老记录"只设 --font-text-size 真通"是更早的量，
 * 两个都设对两种平台都对：设到没人读的那个变量本来就是 no-op。
 *
 * 🔴 作用域挂在**页**上而不是整扇面板：字号是"每一篇可以单独设"的
 * （`view.panelByPath[path].font`），多篇分页时切 tab 就该跟着换。
 * ⚠️ **"没设过"与"设成某个值"必须分开**：用户单独调过的那几篇不许被新默认顶掉
 *（`panelFontFor` 的 `?? cfg.view.panelFont` 就是这条口径）。
 */
export function applyPanelFont(page: HTMLElement, fs: number): void {
  const value = fs > 0 ? fs : defaultPanelFont();
  page.style.setProperty('--font-text-size', `${value}px`);
  page.style.setProperty('--font-preferred-size', `${value}px`);
  applyPanelScale(page, value);
}

/**
 * **只写"面板自己那几行"的比例**（`--kbw-cw-scale`）—— 给**面板根**用。
 *
 * 🔴 为什么需要它（f 期独立审查 🟡2）：`applyPanelFont` 是写在**页**上的，
 * 而 tab 条（`h.root.insertBefore(strip, h.body)`）、面板标题、底部按钮都挂在**页的外面** ——
 * 页上那个变量它们**读不到**（只能读到 `.kbw-cw-panel` 上的默认 1）→
 * 注释里承诺的"面板自己那几行（属性名 / 提示 / tab / 标题）一起缩"只有页内那几处成立。
 * 由 `activate` / `rebuildAll` 把**当前这一篇**的值写到根上，外层那几处才跟着缩。
 */
export function applyPanelScale(el: HTMLElement, fs: number): void {
  const value = fs > 0 ? fs : defaultPanelFont();
  el.style.setProperty('--kbw-cw-scale', String(value / platformBaseFont()));
}

/** 这一档字号的下一个值（`Ctrl+滚轮`：向上 = 变大）；"没设过"从**默认那一档**起步 */
export function nextFontSize(current: number, up: boolean, min: number, max: number): number {
  const base = current > 0 ? current : defaultPanelFont();
  const next = up ? base + 1 : base - 1;
  return Math.max(min, Math.min(max, next));
}

// ────────────────────────────────────────────────────────────────
// ③ 尾链折叠（第 4 条）
// ────────────────────────────────────────────────────────────────
/**
 * **把"关联笔记"那一段折起来**（用户 2026-09-26 拍板：自动折叠，还能点开）。
 *
 * 🔴 为什么是"折"而不是"藏"：面板里挂的是**真编辑器**，内容一个字都不能改
 *（改内容 = 写到用户的文件里）。所以只能用**平台自己的折叠** ——
 * 折了之后那一行变成「关联笔记…」、内容收起，点一下还能展开（平台原生的交互）。
 *
 * 真机取证（2026-09-26，1.13.7，写在 `看板优化方案.md` §6.18）：
 *  · 折叠指示器是**标题行元素里的** `.cm-fold-indicator > .collapse-indicator`，
 *    不是 CM 的 `.cm-foldGutter`（那东西在 LP 下压根不渲染，`.cm-gutters` 数量为 0）；
 *  · 对它派**一发 `click`**（带 clientX/clientY、bubbles）就能折：实测 17 → 14 行、
 *    指示器加上 `is-collapsed`；再点一下展开（所以"可点开"是平台白送的）；
 *  · 折过的行 `textContent` 会变成「关联笔记…」→ 判"已经折了"要看指示器的类名，
 *    不能拿文本比。
 *
 * ⚠️ **虚拟滚动**：CM 只渲染视口附近的行，尾链标题在文末、多半不在 DOM 里 ——
 * 所以先 `scrollIntoView` 把它带进视口、折完再把滚动位置放回去
 *（折只影响折叠点**之后**的行，所以恢复 scrollTop 是安全的、不会跳）。
 *
 * @param isAlive 每次重试前问一句"这一页还在吗"（页面可能已经被关掉/换了档）
 * @returns 折上了返回 true；没尾链段 / 找不到指示器返回 false
 */
export async function foldTailHeading(
  editor: {
    getValue?: () => string;
    scrollIntoView?: (pos: { line: number; ch: number }, center?: boolean) => void;
  } | null,
  containerEl: HTMLElement | null,
  markers: string[],
  isAlive: () => boolean,
): Promise<boolean> {
  /**
   * 🔴 **要重试**（真机实测抓的）：这个函数是在"叶刚挂上"那一刻被调的，
   * 而那时文档**还没进编辑器**（`getValue()` 是空串）→ 算不出尾链那一行 → 一次就放弃的话
   * 永远折不上（真机症状：面板里尾链段照样整段显示，而所有离线判据都是绿的）。
   * 与 `gotoLineIn` 那条"等文档就绪"同一套做法：**每 150ms 再试，最多 ~3s**；
   * 一旦找到指示器就点、点完收手。
   */
  for (let tries = 0; tries < 20; tries += 1) {
    if (!editor || !containerEl || !isAlive()) return false;
    const text = editor.getValue?.() ?? '';
    // 文档还没进来（空文档 = 只有一行）→ 再等等
    if (text.split('\n').length > 1) {
      const headingLine = tailHeadingLine(text, markers);
      if (headingLine >= 0) {
        const scroller = containerEl.querySelector<HTMLElement>('.cm-scroller');
        const keep = scroller?.scrollTop ?? 0;
        try {
          // 把那一行带进视口（CM 只给视口附近的行建 DOM）
          editor.scrollIntoView?.({ line: headingLine, ch: 0 }, true);
        } catch {
          /* 滚不动就按"已经在视口里"试一把 */
        }
        // 等一拍：CM 建行是同步的，但布局/量尺寸可能还没跑完
        await new Promise((r) => setTimeout(r, 60));
        if (!isAlive()) return false;
        const ind = findFoldIndicator(containerEl, text, headingLine);
        if (ind) {
          if (!ind.classList.contains('is-collapsed')) {
            try {
              const r = ind.getBoundingClientRect();
              ind.dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: Math.round(r.left + 2),
                  clientY: Math.round(r.top + r.height / 2),
                }),
              );
            } catch (e) {
              console.error('[经纬] 折叠尾链失败（不影响编辑）', e);
              return false;
            }
          }
          // 把视口放回去（折叠只裁掉折叠点之后的行，前半段的位置没变）
          if (scroller && scroller.scrollTop !== keep) scroller.scrollTop = keep;
          return true;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * 找**那一行**的折叠指示器。
 *
 * 为什么不能"按 `.cm-line` 的序号取第 n 个"：虚拟滚动下 DOM 里只有视口附近的行，
 * 序号与文档行号对不上。所以按**文本**认 —— 但两边的文本**形态不一样**：
 *
 * 🔴 **Live Preview 里标题行的 `##` 是不显示的**（真机实测抓的，2026-09-26）：
 * 源文那一行是 `## 关联笔记`，而 `.cm-line` 的 `textContent` 是 `关联笔记`
 *（`##` 被 LP 画成了装饰）。早先拿两边原文直接比 → **一个都对不上** →
 * 永远不会折（而所有离线判据都是绿的：它们在假 DOM 里灌的正是带 `##` 的文本）。
 * 所以比较前**两边都归一化**：去掉开头的 `#{1,6}` 与空白，再去掉尾部的折叠省略号 `…`。
 */
export function findFoldIndicator(
  containerEl: HTMLElement,
  body: string,
  headingLine: number,
): HTMLElement | null {
  const norm = (s: string): string => s.replace(/^\s*#{1,6}\s*/, '').replace(/…+$/, '').trim();
  const want = norm(body.split('\n')[headingLine] ?? '');
  if (!want) return null;
  const lines = Array.from(containerEl.querySelectorAll<HTMLElement>('.cm-line'));
  for (const line of lines) {
    if (!/HyperMD-header|cm-header/.test(line.className)) continue;
    if (norm(line.textContent ?? '') !== want) continue;
    const ind = line.querySelector<HTMLElement>('.cm-fold-indicator');
    if (ind) return ind;
  }
  return null;
}
