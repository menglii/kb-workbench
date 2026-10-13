/**
 * ui/folder-tree.ts —— **轻量只读目录树**（P7.10 新增 · 本批三处共用）
 *
 * 三处用同一份（`redline.ts` 有一条静态断言钉着"别处不许另写一份"）：
 *   · 向导第 1 步「用现成的」（#2）：baseAbs = ''（库根），点节点 = 填写工作文件夹；
 *   · AI `@` 引用选择器（#12）：baseAbs = 当前库根，点节点 = 下钻那个目录的笔记列表；
 *   · AI「工作目录」（#12）：baseAbs = 当前库根，点节点 = 设定这次对话的工作目录。
 *
 * 造型三条（拍板口径）：
 *   · **只列目录**、可展开（懒建子层）；
 *   · **点节点即选中**（回调交出去；三角单独管展开 —— 不给一个点击塞两种行为）；
 *   · **刻意不复用**「全部笔记」那棵状态机树（`modules/notes/`）：那棵挂着选中 / 拖动 /
 *     键盘 / 落盘一整套会话状态，这里只要"列出来 + 点一下"。
 *
 * 数据源 = `kbDirsOf()`（纯读、一次取全、跳过 `.` 开头的目录）——不订阅索引变化：
 * 三处都是"打开那一刻的库长什么样"，弹着的时候库在变属于极边缘的情形（重开一次即可）。
 */
import type { App } from 'obsidian';
import { kbDirsOf } from '../core/vault-index';
import { div, span } from './primitives';

export interface FolderTreeOptions {
  /**
   * 点节点时回调。`rel` **相对 `baseAbs`**（与库根口径一致，直接能喂设置/索引）；
   * 开了 `rootRow` 时，点"根那一行"给 `''`（= baseAbs 自己）。
   */
  onPick?: (rel: string) => void;
  /** 初始选中（rel）—— 高亮它并把祖先链展开到可见 */
  selected?: string;
  /**
   * 画不画"根"那一行（代表 `baseAbs` 自己）。默认**不画**。
   * 给字符串 = 那一行的标签（向导不画 —— 它选的就是"库根之下哪一坨"，库根自己没有意义）。
   */
  rootRow?: string | false;
}

interface TreeNode {
  item: HTMLElement;
  box: HTMLElement;
  tri: HTMLElement;
  open: boolean;
  hasKids: boolean;
}

/**
 * 造一棵只读目录树（返回挂载好的元素；调用方自己决定放哪儿）。
 *
 * 结构：`div.kbw-ftree` → 每层 `div.kbw-ftree-node`（行 `div.kbw-ftree-item` +
 * 子容器 `div.kbw-ftree-kids`，懒建、默认收起）。
 */
export function folderTree(app: App, baseAbs: string, opts: FolderTreeOptions = {}): HTMLElement {
  const dirs = kbDirsOf(app, baseAbs);
  /** 父 rel → 子 rel[]（rel 都相对 baseAbs；'' = baseAbs 自己） */
  const kids = new Map<string, string[]>();
  for (const d of dirs) {
    if (d === '') continue;
    const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    const arr = kids.get(parent) ?? [];
    arr.push(d);
    kids.set(parent, arr);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.localeCompare(b, 'zh'));

  const root = div({ cls: 'kbw-ftree' });
  /** rel → 节点件（展开到选中 / 高亮时要用） */
  const nodes = new Map<string, TreeNode>();

  function makeNode(rel: string, label?: string): HTMLElement {
    const node = div({ cls: 'kbw-ftree-node' });
    const item = div({
      cls: ['kbw-ftree-item', 'kbw-hover-1'],
      attr: { role: 'treeitem', tabindex: '0', title: rel || '（根）' },
    });
    const hasKids = (kids.get(rel) ?? []).length > 0;
    const tri = span({ cls: ['kbw-ftree-tri', hasKids ? null : 'is-leaf'], text: hasKids ? '▸' : '' });
    const name = span({ cls: 'kbw-ftree-name', text: label ?? rel.slice(rel.lastIndexOf('/') + 1) });
    item.appendChild(tri);
    item.appendChild(name);
    const box = div({ cls: 'kbw-ftree-kids' });
    box.style.display = 'none';
    node.appendChild(item);
    node.appendChild(box);
    const rec: TreeNode = { item, box, tri, open: false, hasKids };
    nodes.set(rel, rec);

    const toggle = (on: boolean): void => {
      if (!hasKids) return;
      if (on && !box.firstChild) buildLevel(rel, box);
      rec.open = on;
      box.style.display = on ? '' : 'none';
      tri.textContent = on ? '▾' : '▸';
      item.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    const pick = (): void => {
      for (const n of nodes.values()) n.item.classList.remove('is-sel');
      item.classList.add('is-sel');
      opts.onPick?.(rel);
    };
    // 三角：只展开/收起（不选中）；行体：选中
    tri.addEventListener('click', (evt) => {
      evt.stopPropagation();
      toggle(!rec.open);
    });
    item.addEventListener('click', pick);
    item.addEventListener('keydown', (evt) => {
      const k = (evt as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        evt.preventDefault();
        pick();
      } else if (k === 'ArrowRight') {
        toggle(true);
      } else if (k === 'ArrowLeft') {
        toggle(false);
      }
    });
    return node;
  }

  function buildLevel(parentRel: string, host: HTMLElement): void {
    const list = kids.get(parentRel) ?? [];
    if (list.length === 0) return;
    /**
     * ⚠️ `host` 本身可能就是某个节点的 `.kbw-ftree-kids`（懒展开那条路）——
     * 那就**直接往里放**，别再包一层（独立审 🟢5：两层 padding 会让每级缩进翻倍，
     * 引用面板的树列只有 190px，深两三层就把名字挤没了）。
     */
    const boxEl = host.classList.contains('kbw-ftree-kids') ? host : div({ cls: 'kbw-ftree-kids' });
    for (const rel of list) boxEl.appendChild(makeNode(rel));
    if (boxEl !== host) host.appendChild(boxEl);
  }

  if (typeof opts.rootRow === 'string') {
    root.appendChild(makeNode('', opts.rootRow));
    /**
     * **根行默认展开**：第一层立即可见（选择器一打开就有东西可点）；
     * 收起整个树藏在一个三角后面是"看起来空的"那一类体验（P7.10 · #12 实测栽过）。
     */
    const rootRec = nodes.get('');
    if (rootRec?.hasKids) (rootRec.tri as HTMLElement).click();
  } else {
    buildLevel('', root);
  }
  /** 空树说一声：向导那边有"手动输入"兜底，别让人对着白框猜 */
  if (!root.querySelector('.kbw-ftree-item')) {
    root.appendChild(div({ cls: 'kbw-ftree-none', text: '这个文件夹下还没有子目录' }));
  }

  // 展开到选中 + 高亮（selected 可能是深层的，祖先链要先建出来）
  const sel = opts.selected ?? '';
  if (sel !== '') {
    const segs = sel.split('/');
    let acc = '';
    for (let i = 0; i < segs.length; i += 1) {
      acc = acc === '' ? segs[i] : `${acc}/${segs[i]}`;
      const node = nodes.get(acc);
      if (!node) break;
      if (i < segs.length - 1) {
        // 沿链展开：**已经开着的不许再点**（toggle 语义 —— 再点一下是收起）
        if (node.hasKids && !node.open) (node.tri as HTMLElement).click();
      } else {
        node.item.classList.add('is-sel');
      }
    }
  }
  return root;
}
