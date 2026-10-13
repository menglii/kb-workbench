/**
 * modules/notes/tree.ts —— 目录树（交互规格 §3.1）
 *
 * 三件事：
 *   · **层级简览 + 数字**：节点上的数字是该目录下的笔记数（**含子目录**）
 *   · **展开/折叠记忆**：展开状态由调用方存进配置（切走回来不变）
 *   · **拖拽放置目标**：每个节点带 `data-drop="<目录>"`，拖动时高亮 + 右上角
 *     「4 → 7」预告（预告文案由调用方算好递进来，树只管显示）
 *
 * **画哪些目录**（P7.15 · #2）：`realDirs` 那一份 = 库里真实的目录（含 0 篇的空目录），
 * 常驻入口 `buildTreeFromVault` 从 `kbDirsOf` 现算 —— 与网格文件夹格、批量迁移菜单同源。
 * **数字**仍只认笔记（含子目录）。空目录照画、显 `0`，折叠沿用现口径（不额外展开）。
 *
 * `99_Meta` 默认折叠：默认展开集合是空的，只有用户点过的目录才记住。
 * 数字与层级都从**索引**来（不扫磁盘），所以它是纯函数式的：状态变就整块重画。
 */
import type { App } from 'obsidian';
import { kbDirsOf, type NoteEntry } from '../../core/vault-index';
import { div, icon, span } from '../../ui/primitives';
import {
  dragGhost,
  startPointerDrag,
  wasDraggingRecently,
  type GhostHandle,
} from '../../ui/dnd';

export interface TreeNode {
  /** 相对库根的目录路径（'' = 库根） */
  dir: string;
  name: string;
  /** 笔记数（含子目录） */
  count: number;
  children: TreeNode[];
  /**
   * **本层直接包含的笔记**（P7.23「完全展开（含文件）」用）。
   * 与 children（子目录）分工：文件行排在子目录**之后**、按名字排序。
   * 只有 `showFiles` 里点了名的目录才会画出来（默认不画 —— 树照旧是"层级简览"）。
   * `isTemplate` 带着走：**模板行可打开、不可拖**（与网格 v2·#5「模板格子不可拖」同口径，
   * 独立审 🟡2——第一版漏了这道守卫，模板能被拖走）。
   */
  files: { name: string; path: string; isTemplate: boolean }[];
}

/**
 * 从索引条目搭出目录树。
 *
 * `realDirs`（P7.15 · #2 加的第二个参数）= **库里真实的目录**（相对库根，含空目录）——
 * 常驻的那份从 `kbDirs(ctx)` 来（与「新建笔记」落点下拉、看板文件夹源**同一份口径**）。
 *
 * 🔴 **为什么要这一步**：原先只认"**有笔记的**目录"，于是用户新建的**空文件夹在树里
 * 根本看不见**（"我建了它，出不来"——P6b ② 在网格里修过一次同款，P7.15 · #2 用户
 * 又在目录树上撞到：网格画着 `2`（0 篇），侧边栏没有）。现在两侧同源：
 * **画不画**看真实目录，**数字**看笔记数。
 *
 * 计数口径不变（含子目录的篇数）——空目录自然显 `0`。
 */
export function buildTree(entries: NoteEntry[], realDirs: readonly string[] = []): TreeNode {
  const root: TreeNode = { dir: '', name: '整个知识库', count: 0, children: [], files: [] };
  const byDir = new Map<string, TreeNode>([['', root]]);

  const ensure = (dir: string): TreeNode => {
    const hit = byDir.get(dir);
    if (hit) return hit;
    const parent = ensure(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
    const node: TreeNode = {
      dir,
      name: dir.split('/').pop() ?? dir,
      count: 0,
      children: [],
      files: [],
    };
    parent.children.push(node);
    byDir.set(dir, node);
    return node;
  };

  /**
   * ⚠️ **先画目录、后数笔记**：真实目录（含 0 篇的）先把节点建出来。
   * 顺序反了也不会错（ensure 是幂等的）—— 但先画的那一批会把**祖先目录**一并建出，
   * 于是"库里有个空的三层目录"也能整条链画出来（与网格一致）。
   */
  for (const dir of realDirs) if (dir) ensure(dir);

  for (const e of entries) {
    const dir = e.effectivePosition;
    if (dir) ensure(dir);
    // 逐层累加（自己 + 所有祖先），数字口径 = "这个目录下（含子目录）有多少篇"
    let cur = dir;
    for (;;) {
      const node = ensure(cur);
      node.count += 1;
      if (!cur) break;
      cur = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
    }
    /**
     * **顺手收本层文件**（P7.23）：entries 已经按 `effectivePosition` 走到这儿了，
     * 零新扫描。名称用 `basename`（与列表/网格同一份，不含扩展名）。
     */
    ensure(dir).files.push({ name: e.basename, path: e.path, isTemplate: e.isTemplate });
  }
  root.count = entries.length;
  sortTree(root);
  return root;
}

/**
 * **调用方最常用的那一份**：从 `app` + `kbRoot` 现算真实目录，再搭树
 * （三处入口 —— 目录树 / `nodeOf` / 批量迁移菜单 —— 都走它，免得各拼一遍参数）。
 *
 * ⚠️ **不许缓存**（与「新建笔记」落点下拉同一条纪律）：用户新建/改名/删除目录之后
 * 下一次重画就要看得见 —— 现算的代价是一次 `getAllLoadedFiles()` 遍历（平台缓存树，
 * 不扫盘）。
 */
export function buildTreeFromVault(app: App, kbRoot: string, entries: NoteEntry[]): TreeNode {
  return buildTree(entries, Array.from(kbDirsOf(app, kbRoot)));
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  // 文件行也按名字排（与目录同一个 localeCompare 口径）
  node.files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const c of node.children) sortTree(c);
}

export interface TreeDropInfo {
  /** 掠过中的目标目录 */
  dir: string;
  /** 预告文案（「4 → 7」） */
  text: string;
}

export interface TreeOptions {
  root: TreeNode;
  /** 展开的目录 */
  open: string[];
  /**
   * **「含文件展示」的目录**（P7.23 · `settings.treeShowFiles`）：展开了 + 在这一份里，
   * 才在子目录之后列文件行。默认空 = 树照旧只画目录。
   */
  showFiles: string[];
  /** 选中的目录（'' = 整个知识库） */
  selected: string;
  /** 拖动掠过信息（null = 没在拖） */
  drop: TreeDropInfo | null;
  onToggle: (dir: string) => void;
  onSelect: (dir: string) => void;
  onContextMenu: (dir: string, evt: MouseEvent) => void;
  /**
   * **行尾「收起」按钮**（P7.24 · T1，用户真机点名"展开后加个收起按钮"）——
   * 与右键菜单「收起此文件夹」**同一份实现**（模块的 `collapseDir`：
   * open 只收本节点 + 子树清 `treeShowFiles`），不是第二套收起语义。
   */
  onCollapse: (dir: string) => void;
  /** 文件行单击 = 打开这一篇（Q2：树里的文件是快捷方式，不引入第二套选中态） */
  onFileOpen: (path: string) => void;
  /**
   * **文件行右键**（P7.24 · A22 拍板"给笔记菜单"）—— 与列表/网格行**同一份**
   * `showNoteMenu`（打开 / 问 AI / 重命名 / 删除…）。在此之前文件行右键"什么都不弹"
   *（没挂监听、又被空白菜单的排除名单 `.kbw-tree-item` 吞掉），是"点了没反应"那类体验。
   */
  onFileMenu: (path: string, evt: MouseEvent) => void;
  /** 文件行拖到目录节点上松手 = 搬（Q6；`dir` 一律非 null —— 树这边已判过落点） */
  onFileDrop: (path: string, dir: string) => void;
  /** 文件行拖动掠过的落点（null = 没在目标上）—— 模块拿它高亮**面包屑段**（P7.23） */
  onFileDragHint?: (dir: string | null) => void;
}

export function renderTree(opts: TreeOptions): HTMLElement {
  const wrap = div({ cls: 'kbw-tree' });

  const head = div({ cls: 'kbw-tree-head' });
  head.appendChild(span({ cls: 'kbw-tree-title', text: '目录' }));
  if (opts.drop) {
    // 预告只在拖动时出现，位置固定在右上角（不跟着指针跑，免得挡视线）
    head.appendChild(span({ cls: 'kbw-tree-preview', text: opts.drop.text, title: '放下之后这个目录会有几篇' }));
  }
  wrap.appendChild(head);

  const body = div({ cls: 'kbw-tree-body' });
  /**
   * 递归渲染：**展开了才渲染子节点**（折叠的子树不进 DOM，树才有"简览"的意思）。
   *
   * ⚠️ **P7.24 · T2**：这里原来是 `isRoot || open.includes(…)` —— 根恒开、caret 点了
   * 没反应（死按钮）。反转后**根也是普通节点**：展开态一律看 `open`（`''` = 库根，
   * 默认开由设置默认/迁移保证）。
   */
  const walk = (node: TreeNode, depth: number, isRoot: boolean): void => {
    body.appendChild(nodeRow(opts, node, depth, isRoot));
    if (opts.open.includes(node.dir)) {
      for (const child of node.children) walk(child, depth + 1, false);
      /**
       * **文件行排在子目录之后**（P7.23）：只有 `showFiles` 点了名的目录才画；
       * 空目录无文件行 ✓（`files` 空就什么都不加）。
       */
      if (opts.showFiles.includes(node.dir)) {
        for (const f of node.files) body.appendChild(fileRow(opts, body, f, depth + 1));
      }
    }
  };
  walk(opts.root, 0, true);
  wrap.appendChild(body);
  return wrap;
}

function nodeRow(opts: TreeOptions, node: TreeNode, depth: number, isRoot: boolean): HTMLElement {
  // P7.24 · T2：`isRoot` 不再参与展开判定（根也是普通节点；`''` 在 open 里 = 根开）
  const isOpen = opts.open.includes(node.dir);
  const hasChildren = node.children.length > 0;
  const isSelected = opts.selected === node.dir;
  const isDrop = opts.drop != null && opts.drop.dir === node.dir;

  const row = div({
    cls: ['kbw-tree-item', 'kbw-hover-1', isSelected ? 'is-on' : null, isDrop ? 'is-drop' : null],
    attr: {
      role: 'treeitem',
      'aria-selected': isSelected ? 'true' : 'false',
      'aria-expanded': hasChildren ? String(isOpen) : undefined,
      title: isRoot ? '整个知识库' : node.dir,
    },
    data: { drop: node.dir, dir: node.dir },
  });
  /**
   * 缩进 = **稿子那两个数换算出来的**（⑩ 对表，2026-09-28）：
   * `界面设计.html` 的 `.tnode{padding:5px 7px}` + `.tnode.lv2{padding-left:21px}` +
   * `.tnode.lv3{padding-left:35px}` ⇒ 第 1 层 7、第 2 层 21、第 3 层 35 = `7 + 层号 × 14`。
   * 原先写的是 `4 + depth × 12`（稿子上没有那两个数）→ 层级越深、与稿子差得越多（第 3 层差 7px）。
   */
  row.style.paddingLeft = `${7 + depth * 14}px`;

  const caret = span({
    cls: ['kbw-tree-caret', isOpen ? 'is-open' : null, hasChildren ? null : 'is-leaf'],
    text: hasChildren ? '▸' : '',
    attr: { role: 'button', 'aria-label': isOpen ? '折叠' : '展开' },
  });
  caret.addEventListener('click', (evt) => {
    evt.stopPropagation();
    if (hasChildren) opts.onToggle(node.dir);
  });
  row.appendChild(caret);

  row.appendChild(span({ cls: 'kbw-tree-name', text: node.name }));
  /**
   * 数字 = **含子目录**的篇数（导航汇总）。P6b ② 起网格与面包屑改用"本层"口径，
   * 两个数字从此**必然不同** —— 所以这里必须把口径写出来（`title` + `aria-label`），
   * 否则用户会以为其中一个算错了。
   */
  row.appendChild(
    span({
      cls: 'kbw-tree-count',
      text: String(node.count),
      // #7（P7.12）：只挂 aria-label（双挂 = 双提示框；口径仍写进 aria-label）
      attr: { 'aria-label': `含子目录 ${node.count} 篇` },
    }),
  );

  /**
   * **行尾「收起」小按钮**（P7.24 · T1）—— 用户原话："展开具体文件后，加个收起按钮"。
   *
   * 三条口径：
   *   · **只在展开态出现**：`open` 或 `treeShowFiles` 点了名（完全展开态）、且有子节点
   *     —— 未展开的目录不画它（判据就这么钉的）。`treeShowFiles` 单独在（caret 收过、
   *     文件行记录还在）也算"该收"：点它走 `collapseDir` 顺手把那份记录清干净；
   *   · **点它 = 与右键菜单「收起此文件夹」同一份实现**（`onCollapse` = 模块的 `collapseDir`）
   *     —— 子树行与文件行一起收、后代 open 记录保留，不发明第二套语义；
   *   · **不选中该目录**（`stopPropagation`，照 caret 同款）；命中区 ≥24px 由 CSS 给
   *     （`styles/notes.css` 的 `.kbw-tree-collapse`，pad+负 margin 规矩）。
   */
  if (hasChildren && (isOpen || opts.showFiles.includes(node.dir))) {
    const btn = span({
      cls: 'kbw-tree-collapse',
      attr: { role: 'button', 'aria-label': '收起', title: '收起' },
    });
    // 图标与节点菜单「收起此文件夹」同款（chevron-right）—— 同一动作同一图标
    btn.appendChild(icon('chevron-right', 13));
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation(); // 点按钮 ≠ 选中该目录
      opts.onCollapse(node.dir);
    });
    row.appendChild(btn);
  }

  row.addEventListener('click', () => opts.onSelect(node.dir));
  row.addEventListener('contextmenu', (evt) => opts.onContextMenu(node.dir, evt));
  return row;
}

/**
 * **文件行**（P7.23 · Q1/Q2/Q6）—— 只出现在 `showFiles` 点了名的目录下。
 *
 * · 缩进 = 对应目录 **+1 层**（walk 已传 `depth + 1`）；`file-text` 图标占 caret 那一格
 *  （14px，名称列才与目录行对齐）；**无三角、无计数**、排在子目录之后；
 * · **单击 = 打开这一篇**（Q2：树里的文件是快捷方式，不引入第二套选中态）；
 * · **可拖**（Q6 拍板反转）：拖到任意目录节点（含「整个知识库」根）上松手 = 搬 ——
 *   走 `data-drop` 协议，与"列表/网格拖到树"**同一条 mover 链**（落到面包屑段上也认，
 *   那段也是 `data-drop`）。与"单击=打开"的**分流走 `ui/dnd.ts` 基元**：鼠标 4px 阈值 /
 *   触屏长按 400ms —— 拖过阈值之后浏览器补发的那一发 click 由 `wasDraggingRecently` 吞掉。
 *
 * ⚠️ 拖动期间**不走 store**（本地贴 class）：一走 store 树就整个重绘、本行当场换人
 *（`is-dragging` 观感就没了）；**面包屑段的落点高亮**在别的 Region，由模块的
 * `onFileDragHint` 管 —— 这也是本行不做"掠过 500ms 自动展开"的原因（那会动 `open` →
 * 重绘 → 拖到一半行没了）。本轮如实不做，见验收记录。
 */
function fileRow(
  opts: TreeOptions,
  body: HTMLElement,
  f: { name: string; path: string; isTemplate: boolean },
  depth: number,
): HTMLElement {
  const row = div({
    cls: ['kbw-tree-item', 'kbw-tree-file', 'kbw-hover-1'],
    attr: { role: 'treeitem', title: f.path },
    data: { path: f.path },
  });
  row.style.paddingLeft = `${7 + depth * 14}px`;
  const iconWrap = span({ cls: 'kbw-tree-fileicon' });
  iconWrap.appendChild(icon('file-text', 13));
  row.appendChild(iconWrap);
  row.appendChild(span({ cls: 'kbw-tree-name', text: f.name }));

  row.addEventListener('click', () => {
    if (wasDraggingRecently()) return; // 拖完补的那一发 click 不算（§3.5 纪律 ④）
    opts.onFileOpen(f.path);
  });

  /**
   * **文件行右键 = 笔记菜单**（P7.24 · A22 拍板"给"）：模块把 `onFileMenu` 接去
   * `showNoteMenu` —— 与列表/网格行同一份（打开 / 问 AI / 重命名 / 删除…）。
   * 模板行也照给（它就是一篇笔记；模板守卫管的是"不可拖"，别混）。
   */
  row.addEventListener('contextmenu', (evt) => opts.onFileMenu(f.path, evt));

  /**
   * **模板行：可打开、不可拖**（独立审 🟡2 补的守卫；与网格 v2 · #5「模板格子不可拖」
   * 同口径 —— 第一版漏了，模板能从树里被拖走）。挂在最外层：这一行**连拖动基元都不起**
   * （阈值/长按都进不去，也就不存在"拖到一半发现是模板"的半截状态）。
   */
  if (f.isTemplate) return row;

  let stopDrag: (() => void) | null = null;
  let ghost: GhostHandle | null = null;
  const clearHints = (): void => {
    for (const el of Array.from(body.querySelectorAll<HTMLElement>('.kbw-tree-item.is-drop'))) {
      el.classList.remove('is-drop');
    }
    opts.onFileDragHint?.(null);
  };
  const endDrag = (): void => {
    row.classList.remove('is-dragging');
    ghost?.dispose();
    ghost = null;
    clearHints();
  };
  row.addEventListener('pointerdown', (down) => {
    if ((down as PointerEvent).button !== 0) return;
    stopDrag?.();
    stopDrag = startPointerDrag(down as PointerEvent, f, {
      onStart: (c) => {
        row.classList.add('is-dragging');
        ghost = dragGhost(f.name);
        ghost.move(c.x, c.y);
      },
      onOver: (t) => {
        const dir = t?.dataset?.drop ?? null;
        for (const el of Array.from(body.querySelectorAll<HTMLElement>('.kbw-tree-item[data-drop]'))) {
          el.classList.toggle('is-drop', dir != null && el.dataset.drop === dir);
        }
        opts.onFileDragHint?.(dir);
      },
      onDrop: (t) => {
        const dir = t?.dataset?.drop;
        endDrag();
        if (dir != null) opts.onFileDrop(f.path, dir);
      },
      onCancel: () => endDrag(),
    });
  });
  return row;
}

/** 展开/折叠的全部子目录（右键菜单「完全展开」/「收起此文件夹」用） */
export function allDirs(node: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    for (const c of n.children) {
      out.push(c.dir);
      walk(c);
    }
  };
  walk(node);
  return out;
}
