/**
 * ui/empty.ts —— 空态五套 + 骨架屏（决策 26）
 *
 * 两条规则：
 *  · **每种空态给一个动作**，不给"暂无数据"
 *  · 图形复用「经纬」笔画语言（同一支标记，缩小、降透明度）
 *
 * 骨架屏用于「库索引未就绪」（交互规格 §1.5）：不空白、也不转圈。
 */
import { btn, brandMark, div, el, span } from './primitives';

export type EmptyKind = 'home' | 'folder' | 'board' | 'search' | 'review';

export interface EmptyAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface EmptySpec {
  kind: EmptyKind;
  /** 覆盖默认标题 */
  title?: string;
  /** 覆盖默认说明 */
  desc?: string;
  action?: EmptyAction;
  compact?: boolean;
}

interface EmptyCopy {
  title: string;
  desc: string;
}

const COPY: Record<EmptyKind, EmptyCopy> = {
  home: { title: '库是干净的', desc: '没有待处理的事。想写点什么就新建一篇。' },
  folder: { title: '这个目录还没有笔记', desc: '新建一篇，它会落在当前目录。' },
  board: { title: '还没有板块', desc: '板块就是一个筛选结果：按文件夹、标签或属性值。' },
  search: { title: '没有匹配的笔记', desc: '换个词，或者把筛选条件清掉。' },
  review: { title: '还没有回顾卡', desc: '卡片从笔记派生：把一篇笔记里要记住的问答写下来，之后按间隔复习。' },
};

export function emptyState(spec: EmptySpec): HTMLElement {
  const copy = COPY[spec.kind] ?? COPY.home;
  const root = div({ cls: ['kbw-empty', spec.compact ? 'is-compact' : null] });
  root.appendChild(brandMark(spec.compact ? 26 : 34, 'kbw-empty-mark'));
  root.appendChild(div({ cls: 'kbw-empty-title', text: spec.title ?? copy.title }));
  const desc = spec.desc ?? copy.desc;
  if (desc) root.appendChild(div({ cls: 'kbw-empty-desc', text: desc }));
  if (spec.action) {
    const b = btn({
      cls: spec.action.primary === false ? 'kbw-btn' : 'kbw-btn is-primary',
      text: spec.action.label,
      on: { click: () => spec.action?.run() },
    });
    root.appendChild(div({ cls: 'kbw-empty-act' }, b));
  }
  return root;
}

// ────────────────────────────────────────────────────────────────
// 骨架屏
// ────────────────────────────────────────────────────────────────
export type SkeletonKind = 'table' | 'cards' | 'home';

function bar(widthCls?: 'short' | 'mid'): HTMLElement {
  const b = span({ cls: 'kbw-skel-bar' });
  if (widthCls === 'short') b.style.flex = '0 0 12%';
  return b;
}

export function skeleton(kind: SkeletonKind, rows = 8): HTMLElement {
  const root = div({ cls: 'kbw-skel', attr: { 'aria-hidden': 'true', 'aria-busy': 'true' } });
  if (kind === 'cards') {
    const grid = div({ cls: 'kbw-skel-grid' });
    for (let i = 0; i < rows; i += 1) grid.appendChild(div({ cls: 'kbw-skel-card' }));
    root.appendChild(grid);
    return root;
  }
  if (kind === 'home') {
    const head = div({ cls: 'kbw-skel-head' });
    root.appendChild(head);
    for (let i = 0; i < 3; i += 1) {
      const row = div({ cls: 'kbw-skel-row' });
      row.appendChild(bar());
      row.appendChild(bar('short'));
      row.appendChild(bar('short'));
      root.appendChild(row);
    }
    return root;
  }
  for (let i = 0; i < rows; i += 1) {
    const row = div({ cls: 'kbw-skel-row' });
    row.appendChild(bar());
    row.appendChild(bar('short'));
    row.appendChild(bar('short'));
    root.appendChild(row);
  }
  return root;
}

/** 一个通用的"这块还没到那一期"占位 —— P0 的工作台用，P1 之后应当全部消失 */
export function roundPlaceholder(round: string, what: string, hint?: string): HTMLElement {
  const root = div({ cls: 'kbw-empty is-compact' });
  root.appendChild(brandMark(26, 'kbw-empty-mark'));
  root.appendChild(div({ cls: 'kbw-empty-title', text: `${what} · ${round}` }));
  if (hint) root.appendChild(div({ cls: 'kbw-empty-desc', text: hint }));
  const row = div({ cls: 'kbw-empty-act' });
  row.appendChild(el('span', { cls: 'kbw-chip', text: 'P0 骨架已就位' }));
  root.appendChild(row);
  return root;
}
