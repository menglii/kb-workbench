/**
 * modules/board/tabs.ts —— **多篇分页的列表运算**（纯函数，d 期 §3.1）
 *
 * 为什么单独一个文件：面板里那个 tab 列表是有 DOM 与真编辑器叶挂在上面的，
 * 但"**加一篇 / 关一篇 / 改名之后怎么重映射**"这三件事的规则是**纯的** ——
 * 抽出来才能在没有真库、没有编辑器的地方钉住（c 期的 `select.ts` 同一条路数）。
 *
 * 🔴 **去重是全期最要紧的一条**（见 `editor.ts` 文件头）：同一篇笔记出现两个 tab，
 * 就是两个 CodeMirror 各持一份 buffer、各自 `save()` 整份写回 —— 后写的把先写的
 * **整段冲掉**。所以 `insertTab` 的语义是"**已经在就什么都不做**"，
 * 而不是"总是追加"。
 */

/** 能当 tab 的东西只要有路径就够 —— 面板传进来的是带 DOM/叶的完整对象，直接用 */
export interface HasPath {
  path: string;
}

/**
 * 判断"这两条是同一篇吗"。
 *
 * ⚠️ **光比 path 不够**（独立审查 🟡3，实测复现）：改名之后有一小段窗口 ——
 * `vault.on('rename')` 已经把 tab 的路径换成新名，而**索引还没刷新**，
 * 卡片上仍是渲染期闭包的**旧 entry（旧路径）**。这时点那张卡片：
 * 只按 path 去重认不出来 → 同一篇开出第二个 tab，而新 tab 的路径指向**已经不存在的旧路径**
 *（真机上就是一个**空壳编辑器**；若旧路径恰好被别的文件占用，属性/标题会写到错的文件上）。
 *
 * 所以判据是"**路径相同 或 是同一个文件对象**"：
 * `TFile` 在改名时是**同一个对象**（平台就地改 `path`），所以身份这一条正好补上那个窗口。
 */
export function sameTab<T extends HasPath>(
  a: T,
  b: T,
  fileOf?: (t: T) => unknown,
): boolean {
  if (a.path === b.path) return true;
  if (!fileOf) return false;
  const fa = fileOf(a);
  const fb = fileOf(b);
  return fa != null && fa === fb;
}

/**
 * 打开一篇：**已经在里面就原样返回**（`added: false`），否则追加到末尾。
 *
 * ⚠️ 返回的是**新数组**（`readonly T[]` 进、`T[]` 出）—— 免得调用方持有的旧引用
 * 悄悄跟着变。元素本身是同一个对象（面板要靠这个身份去找它的 DOM 与叶）。
 *
 * @param fileOf 取"这一条对应的文件对象"（判"是不是同一篇"的第二条判据，见 `sameTab`）
 */
export function insertTab<T extends HasPath>(
  tabs: readonly T[],
  tab: T,
  fileOf?: (t: T) => unknown,
): { tabs: T[]; added: boolean } {
  if (tabs.some((t) => sameTab(t, tab, fileOf))) return { tabs: [...tabs], added: false };
  return { tabs: [...tabs, tab], added: true };
}

/**
 * 关掉一篇之后**该切到哪一篇**。
 *
 * 规则：取**右邻居**（原来排在关掉那张后面的那一张），没有右邻居就取左邻居 ——
 * 与浏览器 / IDE 关标签页的手感一致（"关掉中间那个，右边那个顶上来"）。
 * 空了就返回 `null`（= 该关整扇面板了）。
 *
 * @param remaining **已经移除之后**的列表
 * @param closedIndex 被移除的那一张**原来**的下标（把 `remaining` 和它一起看就知道该落到谁）
 */
export function nextActiveAfterClose<T extends HasPath>(
  remaining: readonly T[],
  closedIndex: number,
): string | null {
  if (remaining.length === 0) return null;
  const i = Math.max(0, Math.min(remaining.length - 1, closedIndex));
  return remaining[i].path;
}

/**
 * 改名 / 搬移之后**重映射每一篇的路径**。
 *
 * ⚠️ 为什么不是"按事件里的 oldPath 改那一个"：改名有四个入口，而**目录改名**会把
 * 底下一批文件一起挪 —— 逐个比路径迟早漏一个，漏掉的后果是那一篇从 tab 里
 * **以旧路径挂着一个已经不存在的文件**（再点它 = 又开一个编辑器，去重也失效）。
 *
 * 所以判据换成更硬的一条：`TFile.path` 是**平台就地改**的，让每一篇自己去读它。
 * `livePath` 返回 `null` 表示这一篇已经不在了（被删 / 被搬出库）→ 收进 `dropped`。
 *
 * ⚠️ **就地改 `t.path`**（这是它的本职，不是副作用）：调用方拿到的每个 tab 对象
 * 就是这个列表里的那一个，改完它的 path 与叶子里的文件才对得上。
 *
 * @returns `changed` 有没有任何一篇的路径动了（决定要不要重画 tab 条）；
 *          `dropped` 哪些已经不在库里（调用方负责把它们关掉 —— 它们各自的那个叶还挂着）
 */
export function remapPaths<T extends HasPath>(
  tabs: readonly T[],
  livePath: (t: T) => string | null,
): { changed: boolean; dropped: T[] } {
  const dropped: T[] = [];
  let changed = false;
  for (const t of tabs) {
    const live = livePath(t);
    if (live == null) {
      dropped.push(t);
      changed = true;
      continue;
    }
    if (live !== t.path) {
      t.path = live;
      changed = true;
    }
  }
  return { changed, dropped };
}

/**
 * 面板现在该显示哪一篇：**保持当前这篇**；它已经不在列表里了（被关掉 / 被删掉）
 * 就退回最后一篇。返回 `null` = 一篇都没有。
 */
export function resolveActive<T extends HasPath>(tabs: readonly T[], active: string): string | null {
  if (tabs.length === 0) return null;
  if (tabs.some((t) => t.path === active)) return active;
  return tabs[tabs.length - 1].path;
}

/** tab 条上那一排的名字（写用例与探针断言时用；真源仍是各自的 `path`） */
export function tabLabels<T extends HasPath>(tabs: readonly T[], nameOf: (t: T) => string): string[] {
  return tabs.map(nameOf);
}
