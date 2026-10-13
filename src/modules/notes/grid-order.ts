/**
 * modules/notes/grid-order.ts —— 网格档「自由摆放」的**纯运算**（交互规格 §3.5）
 *
 * 为什么单拎一个文件：§3.5 表下那条注释定的口径是
 * **「只记顺序，不记绝对坐标」**——因为台式机和手机屏幕尺寸不同，坐标会错位。
 * 于是"摆放"这件事被压成了三件纯函数：**插入点怎么算**、**新顺序怎么拼**、
 * **顺序表怎么用**。三件都能离线断言（不碰 DOM、不碰 store、不看配置）。
 *
 * 与看板那边的关系：看板的 `manualOrder` 是**每个板块一份**，网格这边是**全库一份**
 *（网格的列表是"当前目录 + 筛选"切出来的子集，而"手动排序"是整份列表的属性）。
 * 选择集那三个算子（`rangeSelected` / `toggleSelected` / `dragSet` / `marqueeHit`）
 * **直接用 `modules/board/select.ts` 那一份**，这里不再写第二遍。
 */

/** 与 `getBoundingClientRect()` 同形（只取用得到的四个字段，好直接喂） */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * **落点 → 插入到第几格**（在"去掉被拖动的那几格"之后的序列里）。
 *
 * 口径（与桌面文件管理器一致）：
 *  · 指针在某一行**上方** → 插在这一行的最前面（`y < r.top`）；
 *  · 指针落在某一行里、且在该格**中心线左侧** → 插在这一格前面；
 *  · 都不满足 → 插到末尾。
 *
 * ⚠️ 只按"中心线"判左右，不按"面积占比"：格子宽度不一样时（窄档回流），
 * 占比口径会让"明明拖到它左边却没插到前面"，那种手感很糟。
 */
export function insertionIndexAt(boxes: readonly Box[], x: number, y: number): number {
  for (let i = 0; i < boxes.length; i += 1) {
    const r = boxes[i];
    if (y < r.top) return i;
    if (y <= r.top + r.height && x < r.left + r.width / 2) return i;
  }
  return boxes.length;
}

/**
 * **把新看到的顺序并回全库顺序表**（拖动落点时调）。
 *
 * 为什么不能直接把 `visNew` 整个当新表写下去：网格的列表是**筛出来的子集**
 *（当前目录 / 搜索 / 筛选），而顺序表是**全库**的。直接覆盖 = 把筛掉的那些
 * 全丢了顺序（下次清掉筛选，它们会莫名其妙跑到末尾）。
 *
 * 算法：从全库里摘掉被拖的那几篇，再把它们作为一个**整块**插回去 ——
 * 插在"落点后面那一篇"之前（没有就插在"落点前面那一篇"之后）。
 * 这样被筛掉的那些**相对位置一个都不动**。
 *
 * @param global  当前的全库顺序表（含被拖的那几篇）
 * @param visNew  拖动之后**屏幕上的**顺序（含被拖的那几篇，已在新位置）
 * @param moving  被拖的那几篇
 */
export function mergeReorder(
  global: readonly string[],
  visNew: readonly string[],
  moving: readonly string[],
): string[] {
  const movingSet = new Set(moving);
  const block = visNew.filter((p) => movingSet.has(p));
  if (block.length === 0) return [...global];
  const rest = global.filter((p) => !movingSet.has(p));

  const firstIdx = visNew.findIndex((p) => movingSet.has(p));
  /**
   * 落点**后面**的第一篇（非被拖项）→ 插在它前面。
   * 用它当锚而不是"落点前面那一篇"：列表开头那个位置（插入点 0）**没有前一篇**，
   * 只有"后一篇"这条路能表达"插到最前面"。
   */
  const next = visNew.slice(firstIdx + block.length).find((p) => !movingSet.has(p));
  if (next != null) {
    const at = rest.indexOf(next);
    if (at >= 0) return [...rest.slice(0, at), ...block, ...rest.slice(at)];
  }
  const prev = [...visNew.slice(0, firstIdx)].reverse().find((p) => !movingSet.has(p));
  if (prev != null) {
    const at = rest.indexOf(prev);
    if (at >= 0) return [...rest.slice(0, at + 1), ...block, ...rest.slice(at + 1)];
  }
  /**
   * 兜底：当前视图里**除了被拖的这几篇没有别人**（全选之后整片拖走）。
   * 这时候没有任何可见邻居可当锚 → 按它**原来**在全库表里的位置放回去
   *（等于"这次拖动不改变它和看不见的那些之间的先后"，是唯一说得通的口径）。
   */
  const origAt = global.findIndex((p) => movingSet.has(p));
  const at = origAt < 0 ? rest.length : Math.min(origAt, rest.length);
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * **把"当前看得见的这些"补进顺序表**（拖动落点前先跑一遍）。
 *
 * 🔴 为什么非有它不可：`mergeReorder` 靠"落点前后那一篇"当锚在全库表里定位，
 * 而**第一次拖动时表是空的**（用户还没摆过）—— 锚一个都找不到 → 走进兜底分支 →
 * 表里只剩被拖的那几篇，**其余几十篇的顺序当场全丢**。
 * 症状极隐蔽：拖一下之后顺序看着"也对"（因为只剩几篇在表里、其余按排序规则补在末尾），
 * 但一旦排序规则变了 / 筛选换一下，整片顺序就散架。
 *
 * 补进来的顺序用**当前显示顺序**（`vis`）：非被拖项之间的相对先后和拖动前一致
 *（拖动只挪动了被拖的那几篇）。
 */
export function seedOrder(global: readonly string[], vis: readonly string[]): string[] {
  const known = new Set(global);
  const add = vis.filter((p) => !known.has(p));
  return add.length === 0 ? [...global] : [...global, ...add];
}

/**
 * **按"屏幕上现在的顺序"给可见项重新落座**（拖动落点前必须跑一遍）。
 *
 * 🔴 **为什么非有它不可**（P6 独立审查逮到的真缺陷，逐帧推演过）：
 *
 * `mergeReorder` 的锚点是**表里的邻居**，它默认"表里可见项的先后 == 屏幕上可见项的先后"。
 * 而**自动排列开着**时这条不成立 —— 屏幕是按排序规则排的，表里那份是**上一次自由摆放**留下的
 *（§12 决策 7 明确要求它留着）。于是：
 *
 * ```
 * 表=[c,a,b]（旧手排）  屏幕=[a,b,c]（按名字排）  把 b 拖到最前
 *   seedOrder  → 三个都在表里 → 原样 [c,a,b]（它只补新来的）
 *   mergeReorder → 锚点取表里的 a → 得到 [c,b,a]
 *   → 屏幕上除了被拖的 b，**整片跳回旧手排顺序**
 * ```
 *
 * 这就是"拖动以旧表为基准"而不是"以屏幕为基准"。修法：先把可见项按 `vis` 的顺序
 * **填回它们在表里占的那几个槽位**（被筛掉的那些**一格都不动**），再交给 `mergeReorder`。
 *
 * 例：表 `[c,a,b]`、屏幕 `[b,a,c]` → 槽位 0/1/2 依次填 `b,a,c` → `[b,a,c]`。
 */
export function reseatOrder(global: readonly string[], vis: readonly string[]): string[] {
  const inVis = new Set(vis);
  const queue = vis.slice();
  return global.map((p) => (inVis.has(p) ? (queue.shift() ?? p) : p));
}

/**
 * **按手动顺序排**（自动排列关掉时的那条路）。
 *
 * 表里没有的路径（新笔记 / 刚搬进来的）**排在后面**，彼此保持传进来的顺序
 *（调用方已经按排序规则排过了 → "没摆过的新笔记按名称排，摆在老的后面"）。
 *
 * ⚠️ 表里同一路径出现两次时**取第一次**：迁移/手改配置都可能留下重复，
 * 按最后一次算的话，"我明明摆到最前面、它却在后面"是查不出来的那种 bug。
 */
export function applyManualOrder<T extends { path: string }>(
  entries: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i += 1) {
    if (!rank.has(order[i])) rank.set(order[i], i);
  }
  const known: T[] = [];
  const unknown: T[] = [];
  for (const e of entries) (rank.has(e.path) ? known : unknown).push(e);
  known.sort((a, b) => (rank.get(a.path) ?? 0) - (rank.get(b.path) ?? 0));
  return [...known, ...unknown];
}

/**
 * 顺序表的**剪枝**：只留当前库里还活着的路径（搬走/删掉的会一直留在表里）。
 *
 * 为什么要有它：表只增不减的话，几十次改名搬移之后会攒一堆死键 ——
 * 它们不影响显示（`applyManualOrder` 找不到就跳过），但会让表越来越难读，
 * 而且**下次那次真正的插入**会以一堆死键为邻，看着像"插歪了"。
 *
 * ⚠️ 只在"已经确认这些路径确实不在库里"时调（搬移/删除事件里），
 * 别在渲染路径上顺手剪 —— 索引重扫期间会短暂"什么都不知道"，
 * 那时候剪等于把用户的顺序**整批清空**。
 */
export function pruneOrder(order: readonly string[], alive: ReadonlySet<string>): string[] {
  const out = order.filter((p) => alive.has(p));
  return out.length === order.length ? [...order] : out;
}

/**
 * 改名/搬移之后把顺序表里的键迁过去（**表里存的是路径，就得跟着 rename 走**）。
 *
 * 与看板 `migrateOrder` 同一条纪律，也是同一个坑的第三次：漏迁一次的后果是
 * 那一篇从手动顺序里**失联、掉到末尾**，而且查不出原因。
 */
export function remapOrder(order: readonly string[], oldPath: string, newPath: string): string[] {
  if (!oldPath || !newPath || oldPath === newPath) return [...order];
  let hit = false;
  const out = order.map((p) => {
    if (p !== oldPath) return p;
    hit = true;
    return newPath;
  });
  return hit ? out : [...order];
}
