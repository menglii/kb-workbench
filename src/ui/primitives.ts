/**
 * ui/primitives.ts —— 元素工厂与界面基元
 *
 * 三条自我约束：
 *  ① **不使用 Obsidian 的 DOM 原型扩展**（addClass/empty/setText…）—— 只用原生 DOM。
 *     这样离线 jsdom 不需要给 HTMLElement 打补丁，真机与测试跑的是同一条代码路径。
 *  ② 只有 `setIcon` 来自 obsidian 模块（图标用平台自带的 lucide 集，不自己画）
 *  ③ **零硬编码颜色**——所有色走 CSS 变量（方案设计.md §5.1）
 *
 * 路径/时间/事件/平台判定在 `core/paths.ts` 与 `core/util.ts`（core 不依赖 ui）。
 */
import { setIcon } from 'obsidian';
import { pushEscapeLayer } from '../core/keymap';

// ────────────────────────────────────────────────────────────────
// 元素工厂
// ────────────────────────────────────────────────────────────────
export type Child = Node | string | number | null | undefined | false;

export interface ElOptions {
  cls?: string | (string | false | null | undefined)[];
  text?: string;
  title?: string;
  /** data-* 属性：null/false 跳过，其余 String() 化 */
  data?: Record<string, string | number | boolean | null | undefined>;
  attr?: Record<string, string | number | boolean | null | undefined>;
  /** 直接写 style（运行时算出来的值，比如 --kbw-origin） */
  css?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
  parent?: HTMLElement;
  /** 传 false 则不自动 append */
  attach?: boolean;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyOptions(node, opts);
  append(node, children);
  return node;
}

export function div(opts: ElOptions = {}, ...children: Child[]): HTMLDivElement {
  return el('div', opts, ...children);
}

export function span(opts: ElOptions = {}, ...children: Child[]): HTMLSpanElement {
  return el('span', opts, ...children);
}

export function btn(opts: ElOptions = {}, ...children: Child[]): HTMLButtonElement {
  const b = el('button', { cls: 'kbw-btn kbw-hover-1', ...opts }, ...children);
  b.setAttribute('type', 'button');
  return b;
}

function applyOptions(node: HTMLElement, opts: ElOptions): void {
  if (opts.cls) {
    const list = Array.isArray(opts.cls) ? opts.cls : [opts.cls];
    for (const c of list) {
      if (!c) continue;
      for (const piece of String(c).split(/\s+/)) if (piece) node.classList.add(piece);
    }
  }
  if (opts.text != null) node.textContent = opts.text;
  if (opts.title != null) node.setAttribute('title', opts.title);
  if (opts.data) {
    for (const [k, v] of Object.entries(opts.data)) {
      if (v == null || v === false) continue;
      node.dataset[k] = String(v);
    }
  }
  if (opts.attr) {
    for (const [k, v] of Object.entries(opts.attr)) {
      if (v == null || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (opts.css) for (const [k, v] of Object.entries(opts.css)) node.style.setProperty(k, v);
  if (opts.on) {
    for (const [type, handler] of Object.entries(opts.on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  if (opts.parent && opts.attach !== false) opts.parent.appendChild(node);
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** 清空一个元素的所有子节点 */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ────────────────────────────────────────────────────────────────
// 图标（统一 15px 线性图标 —— 交互规格 §8.4 的 Windows 手感）
// ────────────────────────────────────────────────────────────────
export function icon(name: string, size = 16, cls = 'kbw-ico'): HTMLSpanElement {
  const s = el('span', { cls, attr: { 'aria-hidden': 'true' } });
  setIcon(s, name);
  const svg = s.querySelector('svg');
  if (svg) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  return s;
}

export function iconBtn(
  name: string,
  label: string,
  onClick: (ev: MouseEvent) => void,
  opts: { size?: number; cls?: string | string[] } = {},
): HTMLButtonElement {
  const extra = Array.isArray(opts.cls) ? opts.cls : opts.cls ? [opts.cls] : [];
  const b = el('button', {
    cls: ['kbw-iconbtn', 'kbw-hover-2', ...extra],
    /**
     * 🔴 #7（P7.12）：**只挂 `aria-label`，不挂 `title`** —— 两者都挂会让悬停出
     * **两个提示框**（平台气泡 + 原生 title；用户实拍 FB4-现状-8 + 二批 12:49 扩面）。
     * "保留黑色那枚" = 平台气泡（aria-label 驱动、圆角换行）；全项目图标按钮统一走这条。
     */
    attr: { type: 'button', 'aria-label': label },
    on: { click: onClick },
  });
  b.appendChild(icon(name, opts.size ?? 16));
  return b;
}

/**
 * 「经纬」简笔标记 —— 一纵两横 + 两个交点圆点（决策 20）
 * 不另定品牌色：用 `currentColor`，由使用处给 `--interactive-accent`
 */
export function brandMark(size = 22, cls = 'kbw-brand-mark'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('class', cls);
  const path = (d: string) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  };
  path('M12 3 V21'); // 一纵
  path('M3.2 8.6 H20.8'); // 上横
  path('M3.2 15.4 H20.8'); // 下横
  for (const cy of [8.6, 15.4]) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '12');
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', '1.5');
    c.setAttribute('fill', 'currentColor');
    c.setAttribute('stroke', 'none');
    svg.appendChild(c);
  }
  return svg;
}

// ────────────────────────────────────────────────────────────────
// 自研多选控件
//
// **平台没有多选控件**（`registerBasesView` 的 property 也只是单选，
// platform-pitfalls #8），而 `文件位置` / `平台` / `tags` 都是列表型
// （属性规范 §3）→ 多选必须自研。
// ────────────────────────────────────────────────────────────────
export interface MultiSelectOptions {
  value: string[];
  /** 候选值每次打开时实时取（全库聚合会变） */
  candidates: () => string[];
  placeholder?: string;
  /** 允许输入候选之外的新值 */
  allowCustom?: boolean;
  /** 候选为空时的提示 */
  emptyHint?: string;
  onChange: (next: string[]) => void;
}

export interface MultiSelectHandle {
  el: HTMLElement;
  getValue(): string[];
  setValue(next: string[]): void;
}

export function multiSelect(opts: MultiSelectOptions): MultiSelectHandle {
  let value = [...opts.value];
  const root = div({ cls: 'kbw-multiselect' });
  const input = el('input', { attr: { type: 'text', placeholder: opts.placeholder ?? '' } });
  let drop: HTMLElement | null = null;

  const closeDrop = () => {
    if (popDropLayer) {
      popDropLayer();
      popDropLayer = null;
    }
    if (drop) {
      drop.remove();
      drop = null;
    }
  };

  const commit = () => {
    opts.onChange([...value]);
    paint();
  };

  function paint(): void {
    for (const child of Array.from(root.children)) {
      /**
       * ⚠️ **别把开着的下拉也删了**：删掉 DOM 而模块变量 `drop` 仍非空 →
       * `openDrop()` 开头的 `if (drop) return` 会拦住重建 → 候选列表**消失且再也打不开**
       * （真机上的复现路径：输入框空着按 Backspace 删胶囊 → `commit()` → `paint()`）。
       */
      if (child === input || child === drop) continue;
      child.remove();
    }
    /**
     * ⚠️ **先把 input 挂进 root，再往它前面插胶囊**。
     * `insertBefore(chip, input)` 要求 `input` 已经是 `root` 的孩子 —— 第一版没做这步，
     * 于是"初始值非空"时会抛 `NotFoundError: The child can not be found in the parent`
     * （P1 的三处调用传的都是 `value: []`，正好绕过了；P3 的「排除项」传的是已有配置，
     * 一进来就炸 —— 而且炸在 `void (async …)()` 里，症状只是"面板空白 + 一条没栈的拒绝"）。
     */
    if (input.parentNode !== root) root.appendChild(input);
    for (const v of value) {
      const chip = span({ cls: 'kbw-multiselect-item' }, v);
      chip.appendChild(
        span({
          cls: 'kbw-x',
          text: '×',
          attr: { role: 'button', 'aria-label': `移除 ${v}` },
          on: {
            click: (ev) => {
              ev.stopPropagation();
              value = value.filter((x) => x !== v);
              closeDrop();
              commit();
            },
          },
        }),
      );
      root.insertBefore(chip, input);
    }
    // 兜底：input 必须在最后（上面那步已经保证它在 root 里了）
    if (root.lastChild !== input) root.appendChild(input);
  }

  let popDropLayer: (() => void) | null = null;

  function openDrop(): void {
    if (drop) return;
    const all = opts.candidates().filter((c) => !value.includes(c));
    drop = div({ cls: 'kbw-dropdown' });
    // ⚠️ 下拉开着时压一层 Esc 到**分层栈顶**：否则全局捕获监听（keymap）先命中，
    // 一路把关掉整个面板/菜单 —— 用户只是想把候选收起来（独立审查指出）
    popDropLayer = pushEscapeLayer(() => {
      closeDrop();
      input.focus();
      return true;
    }, 'multiselect-dropdown');
    if (all.length === 0) {
      drop.appendChild(div({ cls: 'kbw-dropdown-item is-hint', text: opts.emptyHint ?? '没有更多候选' }));
    }
    for (const c of all) {
      drop.appendChild(
        div(
          {
            cls: ['kbw-dropdown-item', 'kbw-hover-1'],
            attr: { role: 'option', tabindex: '0' },
            on: {
              click: () => {
                value = [...value, c];
                closeDrop();
                commit();
                input.focus();
              },
            },
          },
          span({ cls: 'kbw-check' }),
          c,
        ),
      );
    }
    root.appendChild(drop);
  }

  input.addEventListener('focus', openDrop);
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!drop) openDrop();
    if (!drop) return;
    for (const item of Array.from(drop.children) as HTMLElement[]) {
      const txt = (item.textContent ?? '').toLowerCase();
      item.style.display = !q || txt.includes(q) ? '' : 'none';
    }
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Backspace' && input.value === '' && value.length > 0) {
      value = value.slice(0, -1);
      // ⚠️ **不要在这里 closeDrop()**：删胶囊多半是想换一个 → 候选列表留着更好用；
      // 而且 `paint()` 现在会跳过 drop（见那里的注释），保留态是自洽的
      // （第一版反过来：paint 把 drop 删掉、变量仍非空 → 列表消失且再也开不回来）。
      commit();
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const typed = input.value.trim();
      if (!typed) {
        closeDrop();
        input.blur();
        return;
      }
      if ((opts.allowCustom ?? true) && !value.includes(typed)) {
        value = [...value, typed];
        input.value = '';
        closeDrop();
        commit();
        return;
      }
      // ⚠️ 要的是"**当前可见**的第一个候选"：输入过滤后第一个候选多半已被
      // `display: none` 藏起来，取它等于类型搜索在键盘路径上失效（Enter 什么都不选）
      const items = Array.from(
        drop?.querySelectorAll<HTMLElement>('.kbw-dropdown-item:not(.is-hint)') ?? [],
      );
      const firstVisible = items.find((i) => i.style.display !== 'none');
      if (firstVisible) firstVisible.click();
    } else if (ev.key === 'Escape') {
      if (drop) {
        ev.stopPropagation(); // Esc 先收候选，不要一路退到关面板
        closeDrop();
      }
    }
  });
  input.addEventListener('blur', () => {
    // 点候选时先 blur 再 click → 延后一点再收，否则会吞掉这一下点击
    setTimeout(() => {
      if (document.activeElement !== input) closeDrop();
    }, 140);
  });

  paint();
  return {
    el: root,
    getValue: () => [...value],
    setValue: (next: string[]) => {
      value = [...next];
      paint();
    },
  };
}
