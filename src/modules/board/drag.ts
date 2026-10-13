/**
 * modules/board/drag.ts —— **看板内拖拽**（交互规格 §4.4）
 *
 * | 场景 | 发生什么 |
 * |---|---|
 * | 同板块内 | 排序（落在目标左半边 = 插到前面，右半边 = 插到后面） |
 * | 跨板块 | **改什么取决于目标板块按什么分组** —— 文件夹源搬文件 / 属性值源改属性 / 标签源加删标签 |
 * | 按住 `Alt` | **强制只排序，不搬文件**（写顺序表，不动库） |
 * | 拖动后改名 | 顺序表存的是**路径** → 移动/改名时**先把旧路径捕获下来**再迁移 |
 *
 * ⚠️ 三条来自真机与平台的老账：
 *   ① 触屏走长按 400ms、鼠标走 4px 阈值 —— 判定在 `ui/dnd.ts` 里，这里不重写
 *   ② `pointercancel` 必须干净中止（触屏滚动接管手势时必然发生）
 *   ③ `renameFile` **就地改** `file.path` → 迁移顺序表必须**在搬之前**拿到旧路径
 *      （P1 踩过；这条写进了 `开发计划.md` §9 的交付清单）
 */
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { dragGhost, startPointerDrag, TOUCH_TOLERANCE, type DragCtx, type GhostHandle } from '../../ui/dnd';
import { NOTIFY_MS, notify } from '../../ui/notify';
import { restoreOrNotify, showUndo } from '../../ui/undo-bar';
import { joinPath, relativeTo } from '../../core/paths';
import { asList } from '../../services/schema';
import type { BoardConfig, BoardConfigStore, BoardSection } from './config';
import type { BoardGroup } from './sources';
import { NotesOps } from '../notes/ops';

/**
 * 拖拽与「移到…」共用的那一半：**放下之后改什么**只认这些。
 * 分成两个接口是为了让 §4.2 的菜单能走**同一条路**（WCAG 的等价操作要是同一条实现，
 * 不然两边迟早改出两套语义）——菜单没有指针事件，给不出 `down`。
 */
export interface CardMoveDeps {
  ctx: WorkbenchContext;
  store: BoardConfigStore;
  entry: NoteEntry;
  /**
   * 这一次要搬的**一整组**（c 期 §3.5 的整组拖动）。
   *
   * `entry` = **用户按住的那一张**；`entries` = 按**显示顺序**排好的整组
   *（顺序由 `select.ts` 的 `dragSet` 决定）—— ⚠️ **两者只有在"组里只有一张"时才必然相同**：
   * 先 `Ctrl+点 C` 再 `Ctrl+点 A`、然后按住 C 拖，`entries` 是 `[A, C]`（显示顺序），
   * `entries[0]` 是 A 而**不是**按住的那张（c 期独立审查 🟢13 抓到这条注释原先写反了）。
   *
   * 分成两个字段就是因为有几处要的确实是"起手那张"（ghost 文案、快照理由、报错里的名字），
   * 而落库/插入要的是**整组**。缺省（不传）= 只搬 `entry` 一张。
   */
  entries?: NoteEntry[];
  /** 起手时所在的板块 key（卡片在哪个 `.kbw-cards` 里） */
  fromKey: string;
  groups: () => BoardGroup[];
  /** 顺序表变了（模块负责落盘） */
  /**
   * 顺序表变了（模块负责落盘）。
   * 返回 `false` = **顺序跟现状一模一样**（拖回原位那种）—— 模块什么都没写，
   * 调用方据此别再报"已排序"（见 a.5-1 的"拖回原位 = 什么都不发生"）。
   */
  onOrderChanged: (key: string, order: string[]) => boolean | void;
  onError: (msg: string) => void;
  refresh: () => void;
  /**
   * 「按 key 找**活着的**卡片区」（独立审查 🟡10）：模块自己有一份作用域正确的实现
   * （`dropHolder`，只在 bodyHost 里找）。默认回退到全文档查询只是给离线用例兜底 ——
   * b 期要做列形态/分屏，多实例时全文档查会取到**别的实例**的卡片区、落点按别人的几何算。
   */
  findHolder?: (key: string) => HTMLElement | null;
}

export interface CardDragSpec extends CardMoveDeps {
  down: PointerEvent;
  /**
   * **触屏长按双模式**（段⑤ 收的欠账，§4.2「单篇设置」那一行）。
   *
   * 触屏上"按住不动"（→ 选择模式）与"按住再拖"（→ 拖动）在**前 400ms 一模一样**，
   * 所以要有一个中间态：长按成立时先问模块一句，拿到了才决定这次手势是什么。
   * 三个钩子的语义与 `modules/notes/grid.ts` 里那三段**一一对应**（同一组常数、同一条容差）：
   *
   * ```
   *   onHoldStart  长按 400ms 成立        → 返回 true = "先按选择处理"（drag.ts 不画药丸/不报落点）
   *   onHoldToDrag 长按之后移动 > 10px    → 改判成拖动（模块在这里撤掉选择模式的视觉）
   *   onHoldEnd    长按之后没动就松手     → 就是"进选择模式"那一下，什么都不搬
   * ```
   * 不提供 `onHoldStart` 的调用方（桌面、以及不需要这套的）行为与从前逐字节相同。
   */
  onHoldStart?: (c: DragCtx<NoteEntry>) => boolean;
  /**
   * 长按之后真的移动了（> `TOUCH_TOLERANCE`）→ 从"选择"改判成"拖动"。
   *
   * ⚠️ **返回 `false` = 放弃这次手势**（不建药丸、不报落点、松手也不落任何东西）——
   * 给"只读模式"那类"能进选择模式但不能拖"的场景用（P6⑤ 独立审查 A3：
   * 原先只读把整条长按双模式一起挡了，于是触屏拿不到单篇菜单）。
   */
  onHoldToDrag?: (c: DragCtx<NoteEntry>) => void | boolean;
  /** 长按之后**没移动**就松手 —— 这一下不搬任何东西 */
  onHoldEnd?: (c: DragCtx<NoteEntry>) => void;
  /**
   * 拖动中：掠过哪个板块（null = 不在任何板块上）、带着几张、**会插到第几个**。
   * 第三个参数是 P4.5 §1.1 加的：界面上要画"插入位指示线"，必须知道落点序号
   * （只报 key 的话，同板块内挪动时指示线无从画起）。
   */
  onDragState: (key: string | null, count: number, index: number) => void;
}

/** 起手一次卡片拖动；返回"取消"函数（模块在重画/卸载时调） */
export function startCardDrag(spec: CardDragSpec): () => void {
  let ghost: GhostHandle | null = null;
  let alt = spec.down.altKey === true;
  let lastKey: string | null = null;
  let lastIndex = -1;
  /** `ui/dnd` 解出来的放置目标（最近的那个 `[data-drop]`）—— 命中测试的兜底输入 */
  let holderHint: HTMLElement | null = null;
  /**
   * 这一次拖的**一组**（c 期 §3.5）。拖动途中拿它做两件事：
   * ① 落点序号要把整组都排除掉（`hitTest` 的 `dragPaths`）；
   * ② 报"带着几张"（`onDragState` 的 count —— 板块头那句「N → M」预告要用）。
   */
  const group = spec.entries && spec.entries.length > 0 ? spec.entries : [spec.entry];
  const paths = group.map((x) => x.path);
  /** 药丸上的文案：单张报名字；一组只报张数（十来篇的名字塞不下，也没人看） */
  const ghostLabel = group.length > 1 ? `${group.length} 张卡片` : spec.entry.basename;
  const ghostText = (): string => (alt ? `${ghostLabel} · 只排序` : ghostLabel);

  const onKey = (evt: KeyboardEvent): void => {
    if (evt.key !== 'Alt') return;
    alt = evt.type === 'keydown';
    if (ghost) ghost.el.textContent = ghostText();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  /**
   * 触屏"长按已成立、还没决定是选择还是拖动"的中间态（见 `CardDragSpec` 那三个钩子）。
   * 这期间**一个拖动视觉都不许出现**（没有药丸、没有落点预告）——
   * 用户只是按住了一秒，还没做任何事。
   */
  let holding = false;
  /** 这一次手势已经**放弃**了（`onHoldToDrag` 说了 false）—— 之后一路都不许再动 */
  let abandoned = false;

  const stop = startPointerDrag(spec.down, spec.entry, {
    onStart: (c) => {
      /**
       * 触屏长按成立 → 先问模块。它说要（返回 true），这次手势就先按"选择模式"处理：
       * 药丸与落点都先不画，等 `onOver` 里真的移动了再补上（`onHoldToDrag`）。
       */
      if (c.touch && spec.onHoldStart?.(c) === true) {
        holding = true;
        return;
      }
      ghost = dragGhost(ghostText());
      ghost.move(c.x, c.y);
    },
    onOver: (t, c) => {
      if (abandoned) return;
      if (holding) {
        /**
         * ⚠️ 容差用的是**基元算好的那个数**（`TOUCH_TOLERANCE`，与网格档同一个常数），
         * 别在这儿自己写 10 —— 两处不一致的话，"按住不动"会在某一档里被误判成拖动。
         */
        const dist = Math.hypot(c.x - spec.down.clientX, c.y - spec.down.clientY);
        if (dist <= TOUCH_TOLERANCE) return;
        holding = false;
        if (spec.onHoldToDrag?.(c) === false) {
          // 模块说"这一下不要拖"（只读）→ 整条手势就此作废，连药丸都不建
          abandoned = true;
          return;
        }
        // 现在真的开始拖了：药丸从这一刻才出现
        ghost = dragGhost(ghostText());
        ghost.move(c.x, c.y);
      }
      ghost?.move(c.x, c.y);
      if (t) holderHint = t;
      const at = hitTest(c.x, c.y, holderHint, lastIndex, paths, spec.findHolder);
      // ⚠️ 落点序号也要报（§1.1 的插入位指示线靠它）—— 判据是"key 或 index 动了"
      if (at.key !== lastKey || at.index !== lastIndex) {
        lastKey = at.key;
        spec.onDragState(at.key, group.length, at.index);
      }
      lastIndex = at.index;
    },
    onDrop: (t, c) => {
      if (abandoned) {
        // 已经作废的手势：松手什么都不做
        endDrag();
        return;
      }
      if (holding) {
        // 长按之后原地松手 = 进选择模式那一下，**什么都不搬**（别走 drop()）
        holding = false;
        spec.onHoldEnd?.(c);
        endDrag();
        return;
      }
      if (t) holderHint = t;
      const at = hitTest(c.x, c.y, holderHint, lastIndex, paths, spec.findHolder);
      endDrag();
      void drop(spec, at.key ?? spec.fromKey, at.index, alt);
    },
    onCancel: () => {
      holding = false;
      abandoned = false;
      endDrag();
    },
  });

  function endDrag(): void {
    ghost?.dispose();
    ghost = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    if (lastKey != null) spec.onDragState(null, 0, -1);
    lastKey = null;
  }

  return () => {
    stop();
    endDrag();
  };
}

// ────────────────────────────────────────────────────────────────
// 命中：拖到哪个板块、插在第几个
// ────────────────────────────────────────────────────────────────
/** 一条测出来的几何（`getBoundingClientRect` 的那几个字段，**纯**：好离线验） */
export interface SlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 指针落在卡片流的**第几个缝隙**（0 = 最前，`rects.length` = 末尾）。
 *
 * 判据：找到**第一个"中心在指针之后"的卡片**，插到它前面。
 * 同一行（纵向差不超 `rowTol`）就比较横向中心，换行了就按行比 —— 也就是说，
 * "换行处的右侧空白"会插到下一行第一张之前，而不是当前行末尾。
 *
 * ⚠️ **rect 全是 0**（jsdom 没有布局）→ 一律返回末尾：
 * 宁可排到后面，也不要静默插到别人前面（老规矩，见 `hitTest`）。
 */
export function slotFromRects(
  rects: SlotRect[],
  x: number,
  y: number,
  rowTol = 4,
  axis: 'x' | 'y' = 'x',
): number {
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (r.width <= 0 && r.height <= 0) continue; // 还没布局/被隐藏 → 不当判据
    /**
     * **纵向堆**（列形态）：每张卡各占一行，不存在"同一行里比左右"那回事 ——
     * 判据就是"指针在这张卡的中心线之上 → 插到它前面"。
     * 横向排那条"同一行再看左右"的分支在这里不能套用：它会在"卡片中心 ±rowTol"
     * 那条窄带里让结果**取决于指针的 x**（同一条纵向缝隙，鼠标往右挪 1px 就换个落点）。
     */
    if (axis === 'y') {
      if (r.top + r.height / 2 > y + rowTol) return i;
      continue;
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cy > y + rowTol || (Math.abs(cy - y) <= rowTol && cx > x)) return i;
  }
  return rects.length;
}

interface Hit {
  key: string | null;
  /** 落在该板块的第几号位置（-1 = 目标组算不出来 → 追加到末尾） */
  index: number;
}

/**
 * 同一个板块里的卡片是**横向排**（流式换行）还是**纵向堆**（列形态）？
 *
 * 拖拽的"前半张 / 后半张"要靠它选轴：横向排看**左右**、纵向堆看**上下**。
 *
 * ⚠️ **为什么不照配置判**：窄档（<640px）是 **CSS 强制回流式**的 ——
 * 配置里写着"列"，窄窗里渲染出来却是流式。照配置判就与界面相反了（拖哪儿都不对）。
 * 所以这里问的是**几何**（界面实际长什么样），不是配置。
 *
 * ⚠️ **量不出来就回落到横向**：jsdom 把所有 rect 桩成同一个（`test.mjs`），
 * dx 与 dy 都是 0 → 走 `dy > dx` 为假的默认分支 = 老口径。
 * 于是离线用例的行为一个字节没变（不必为没有布局的世界发明一套语义）。
 */
export function cardsAxis(rects: SlotRect[], holderW = 0): 'x' | 'y' {
  if (rects.length >= 2) {
    const dx = Math.abs(rects[1].left - rects[0].left);
    const dy = Math.abs(rects[1].top - rects[0].top);
    return dy > dx ? 'y' : 'x';
  }
  /**
   * **只剩一张卡**（b 期独立审查 🟡4）—— 列形态下有两条常见路径会走到这儿：
   *  ① 目标列只有一张卡；② 同板块内两张卡互拖（`dropCards` 把拖动源摘掉后只剩一张）。
   * 这两处如果回落横向，就又把"落点跟着鼠标左右走"放回来了。
   *
   * 判据还是**几何**：卡片宽度 ≈ 卡片区内容宽 → 它填满了一整行 → 这是**纵向堆**。
   * 反过来，流式下卡片比容器窄得多（一行放得下好几张），一眼就能分辨。
   * ⚠️ `holderW = 0`（jsdom 没有布局 / 容器还没量）时**回落横向** —— 与老口径一致，
   * 离线用例因此一个字节都不用改。
   */
  if (rects.length === 1 && holderW > 0) {
    return rects[0].width >= holderW - 2 ? 'y' : 'x';
  }
  return 'x';
}

/**
 * 一个放置区里的卡片，**排除正在拖的那张**。
 *
 * 🔴 **序号口径的唯一来源**（P4.5 独立审查抓到的真 bug）：`withInserted` 会先把拖动源从表里摘掉
 * 再 splice，所以"第几号位置"说的始终是**不含拖动源**那份列表里的序号。
 * 之前只有 `hitTest` 这么算，界面上的插入位指示线却按**含拖动源**的 DOM 顺序画 ——
 * 同板块内往前拖就**差一格**（线画在 C 前、落点在 C 后，线当场说谎）。
 * 现在两边都走这个函数：口径只有一个，想不一致都难。
 */
export function dropCards(holder: HTMLElement, dragPaths: readonly string[] = []): HTMLElement[] {
  const all = Array.from(holder.querySelectorAll<HTMLElement>('[data-card]'));
  /**
   * ⚠️ 参数是**一组路径**（c 期起支持整组拖动）：拖 3 张时那 3 张**都要**排除。
   * 只排一张的话，落点序号会把另外两张也数进去 —— 指示线画的位置和实际落点差一格。
   */
  if (dragPaths.length === 0) return all;
  const skip = new Set(dragPaths);
  return all.filter((c) => !skip.has(c.dataset.path ?? ''));
}

/**
 * 命中：指针在哪张卡上、该插到第几个。
 *
 * ⚠️ **不取"几何中心"**：卡片/板块可能比视口宽（列多了要横向滚），中心点在视口外时
 * `elementFromPoint` 会返回 null（探针踩过）。这里只用**指针所在的元素**，
 * 左右半边按**那张卡自己的 rect** 判 —— 卡片最宽 480px，永远在视口里。
 *
 * ⚠️ **序号是"不含拖动源那份列表"里的序号**：`withInserted` 会先把拖动源从表里摘掉再 splice，
 * 所以同板块内往前挪时按 DOM 序号会多算自己那一格（"放在 C 左边、结果落在 C 右边"）。
 * 这里与界面上的插入位指示线**共用 `dropCards`** —— 口径只有一个。
 *
 * 三级兜底（真机与离线都要能走）：
 *  ① `elementFromPoint` 拿到卡片（真机的主要路径）
 *  ② 拿不到就用 `ui/dnd` 解出来的 `holderHint`（jsdom 没有命中测试 —— 它就是那条路）
 *  ③ 还是没有 → 用 rect 逐个比"指针在不在它前面"；**rect 全是 0 时**（jsdom）
 *     一律追加到末尾（宁可排到后面，也不要静默插到别人前面）
 */
export function hitTest(
  x: number,
  y: number,
  holderHint: HTMLElement | null,
  fallbackIndex = -1,
  /** 正在拖的卡（**一组**：同板块内要把它们都排除在序号之外） */
  dragPaths: readonly string[] = [],
  /** 按 key 找活着的卡片区（模块注入；不传就退回全文档查） */
  findHolder?: (key: string) => HTMLElement | null,
): Hit {
  let el: HTMLElement | null = null;
  try {
    el = (document.elementFromPoint?.(x, y) as HTMLElement | null) ?? null;
  } catch {
    el = null;
  }
  const cardEl = el?.closest?.('[data-card]') as HTMLElement | null;
  let holder =
    ((cardEl ?? el)?.closest?.('[data-drop]') as HTMLElement | null) ?? holderHint ?? null;
  if (!holder) return { key: null, index: fallbackIndex };
  let key = holder.dataset.drop ?? null;
  /**
   * 🔴 **手里的容器可能是"拖动起点那一版"的、或者干脆是板块头**（a.5-1 实测，两个坑叠在一起）：
   *  ① 拖动途中看板重绘过一次（索引变了/别的入口改了配置）→ 旧容器**脱离文档**，里面一张卡都没有；
   *  ② `data-drop` **同时挂在板块头和卡片区上**，`querySelector` 按文档顺序拿到的是**板块头**
   *     （它没有卡片）—— 于是 `slotFromRects` 拿到空数组、返回 0 → **卡片被静默插到队首**
   *     （用户报的"拖回原位却有概率跳走"的一种表现）。
   * 所以"这个容器里一张卡都没有"时，按 key 回当前文档里找**卡片区**（`.kbw-cards[data-drop]`）。
   */
  if (dropCards(holder, dragPaths).length === 0 && key) {
    // ⚠️ 只在模块注入的查找器里找（独立审查 🟡10）：全文档查会跨实例取到**别的看板**的卡片区
    const live = findHolder ? findHolder(key) : null;
    if (live && live !== holder) holder = live;
    key = holder.dataset.drop ?? key;
  }
  const cards = dropCards(holder, dragPaths); // 口径唯一来源，别在这儿自己过滤
  /**
   * ⚠️ **一张卡都量不到 → 说"不知道"（-1）**，让调用方追加到末尾。
   * 返回 0 会被当成"插到最前面"——那正是上面那个"静默跳到队首"的根因。
   * （`slotFromRects` 对"有卡但量不到"返回 `length` = 追加，语义一致；空列表只能返回 0，所以在这里拦住。）
   */
  if (cards.length === 0) return { key, index: -1 };

  /**
   * ⚠️ 指针压着的可能正是**被拖的那张卡自己**（还没拖出原位）——
   * 它不在 `cards` 里，于是自然落到下面的"按邻居比位置"那段，
   * 算出来就是它现在那一格（= 不动）。别在这里特判成"追加到末尾"（那会让指示线跳到队尾）。
   */
  if (cardEl && cards.includes(cardEl)) {
    const i = cards.indexOf(cardEl);
    const r = cardEl.getBoundingClientRect();
    /**
     * 前半张 / 后半张：插到前面还是后面（§4.4）。
     * **轴跟着界面走**（`cardsAxis`）：横向排看左右，列形态（纵向堆）看上下 ——
     * 照配置判会在窄档（CSS 强制流式）下与界面相反，所以这里只认几何。
     * 量不到（jsdom 的桩 rect）一律算"前面"，与老口径一致。
     */
    const axis = cardsAxis(cards.map((c) => c.getBoundingClientRect()), holder.clientWidth);
    const after =
      axis === 'y'
        ? r.height > 0 && y > r.top + r.height / 2
        : r.width > 0 && x > r.left + r.width / 2;
    return { key, index: after ? i + 1 : i };
  }

  // 落在板块的空白处（不是某张卡）→ 按位置插，量不到就追加到末尾
  const rects = cards.map((c) => c.getBoundingClientRect());
  return { key, index: slotFromRects(rects, x, y, 4, cardsAxis(rects, holder.clientWidth)) };
}

// ────────────────────────────────────────────────────────────────
// 放下
// ────────────────────────────────────────────────────────────────
/**
 * 「移到别的板块」那一项走的就是这里 —— **和拖拽同一条实现**。
 * `index = -1` = 追加到末尾（`withInserted` 对负数就是这个语义）。
 */
export async function moveCardToGroup(
  spec: CardMoveDeps,
  toKey: string,
  opts: { sortOnly?: boolean } = {},
): Promise<void> {
  await drop(spec, toKey, -1, opts.sortOnly === true);
}

/**
 * 这次要搬的**一整组**（c 期）。
 * `entry` / `entries` 分成两处写、口径容易漂 —— 凡是"要落库的那些"一律走这里取。
 */
function moveGroup(spec: CardMoveDeps): NoteEntry[] {
  return spec.entries && spec.entries.length > 0 ? spec.entries : [spec.entry];
}

async function drop(
  spec: CardMoveDeps,
  toKey: string | null,
  index: number,
  alt: boolean,
): Promise<void> {
  if (!toKey) return;
  const group = moveGroup(spec);
  const groups = spec.groups();
  const target = groups.find((g) => g.key === toKey);
  const from = groups.find((g) => g.key === spec.fromKey);
  if (!target) return;
  const cfg = spec.store.get();
  const sec = cfg.sections.find((s) => s.id === target.sectionId) ?? null;

  if (toKey === spec.fromKey) {
    /**
     * 同板块：排序（拖过就该停在我放的地方）。
     * ⚠️ **「切到手动档」不在这里做** —— 那是 `onOrderChanged`（看板的 `applyOrder`）的活：
     * 同一件事两处实现就是漂移的温床（独立审查的建议），而且现在两条路都汇到 `applyOrder`，
     * 它会把 `sections[].sort` 与 `view.manualOrder` **一次写完**（分两次写会多一帧"手动档 + 旧顺序"）。
     * 跨板块那句「并把这个板块的排序切到手动」（§4.4）同理，也由 `applyOrder` 兜住。
     */
    /**
     * ⚠️ **只留属于这一块的卡片**（c 期独立审查 🟡4）：多选是**跨板块**的，
     * 用户完全可能同时选着 A 块和 B 块的卡片，然后按住其中一张在本块里挪一格 ——
     * 不过滤的话，A 块的顺序表里会被塞进 **B 块那几张的路径**，
     * 而且 `orderUnchanged` 拿 `g.notes` 逐项比 → 一定不相等 → **一定写盘**，
     * 顺手把 A 块的排序档从「名称」切成**「手动」**（此后新增/改名不再自动排）。
     * 症状只有"排序档悄悄变了"，极难归因；a.5-1 承诺的「拖回原位 = 什么都不发生」在这种选择下也不成立。
     *
     * （**跨板块搬文件那条路不过滤** —— 整组一起搬正是 c 期要的语义；
     *   `Alt` 的"只排序"也不过滤，那是它本来的用途：把一篇**排**进某一块的顺序表而不动库。）
     */
    const mine = group.filter((e) => (from?.notes ?? []).some((n) => n.path === e.path));
    if (mine.length === 0) return; // 一组全是别块的卡 → 这一下什么都不该发生
    spec.onOrderChanged(toKey, withInsertedMany(from?.notes ?? [], mine, index));
    return;
  }

  // 跨板块
  if (alt) {
    // 强制只排序：把这（几）篇写进目标板块的顺序表，**不动库**
    const changed = spec.onOrderChanged(toKey, withInsertedMany(target.notes, group, index));
    notify(
      changed === false
        ? {
            kind: 'info',
            text: '位置没变，什么都没写',
            detail: '松手时按住 Alt 是「只排序」',
            ms: NOTIFY_MS.info,
          }
        : {
            kind: 'info',
            text:
              group.length > 1
                ? `只在看板上排了 ${group.length} 张的序（没动文件）`
                : '只在看板上排了序（没动文件）',
            detail: '松手时按住 Alt 就是「只排序」',
            ms: NOTIFY_MS.info,
          },
    );
    return;
  }
  await applyCross(spec, target, sec, cfg);
}

/**
 * 把**一组**笔记按次序插进某个顺序表的第 index 位（c 期：整组拖动）。
 * 相对次序**保持传入的顺序**（`select.ts` 的 `dragSet` 给的就是按显示顺序排好的，
 * 所以搬完一组之后它们之间的先后还是原来的样子）。
 */
export function withInsertedMany(
  notes: NoteEntry[],
  entries: readonly NoteEntry[],
  index: number,
): string[] {
  const drop = new Set(entries.map((e) => e.path));
  const paths = notes.map((n) => n.path).filter((p) => !drop.has(p));
  const at = index < 0 ? paths.length : Math.min(Math.max(index, 0), paths.length);
  paths.splice(at, 0, ...entries.map((e) => e.path));
  return paths;
}

/**
 * 单张的**薄壳**（「上移/下移一位」那些老调用走这里）。
 * ⚠️ 别再写第二套插入逻辑：单张与整组必须是同一个口径 ——
 * P4 已经栽过一次"同一契约两处实现"（`withInserted` 本来就是为这个抽出来的）。
 */
export function withInserted(notes: NoteEntry[], entry: NoteEntry, index: number): string[] {
  return withInsertedMany(notes, [entry], index);
}

/**
 * **跨板块改什么，取决于目标板块按什么分组**（§4.4 / 决策 8）。
 * ⚠️ 这里**不写死字段清单** —— 以后加数据源，拖动自动跟着对。
 */
async function applyCross(
  spec: CardMoveDeps,
  target: BoardGroup,
  sec: BoardSection | null,
  cfg: BoardConfig,
): Promise<void> {
  if (!sec) return;
  const { ctx } = spec;
  const e = spec.entry;
  const group = moveGroup(spec);
  /** 撤销条 / 快照理由里说清"这是一组"；单张时就是那一篇的名字 */
  const what = group.length > 1 ? `${group.length} 篇` : e.basename;

  // ① 文件夹源 → 搬文件（走 mover：快照 + 撞名自查 + 双链同步 + 撤销条）
  if (sec.kind === 'folder' || target.kind === 'folder') {
    const rel = folderDirOf(target, sec, ctx);
    if (rel == null) {
      spec.onError('这个板块的落点目录算不出来（数据源是空的？）');
      return;
    }
    const ops = new NotesOps(ctx, () => spec.refresh());
    // 顺序表的迁移不在这里做：模块听着 vault 的 rename 事件统一迁移
    // （改名有四个入口，挂按钮必漏一个；见 `index.ts` 的 migrateOrder）
    //
    // ⚠️ **整组一次交给 mover**（`moveNow` 的 `entries` 本来就是数组，内部一个 `targets` 里塞多个 files）——
    // 别在外面 for 一遍：那样是 N 次快照 + N 条撤销条，"搬一组"会变成"撤销要按 N 次"。
    await ops.moveNow(group, rel, 'board', `拖拽到「${target.title}」`);
    return;
  }

  /**
   * ② 属性值源 → 改那个属性。
   * ⚠️ 判据**不能写 `target.sub`**：属性值源的每一组都是**顶级**板块（§4.1"板块名 = 属性值"），
   * `sub` 恒为 false → 那条守卫永远不成立、整支掉进最后的兜底，用户拖到属性值板块上
   * 会被告知"收容所不能拖"。组名（`target.title`）就是取值。
   */
  if (sec.kind === 'prop') {
    /** 被 17.2 守卫跳过的篇（写完之后撤销条上要如实说）——独立审查 🟡1 */
    const skippedProps: string[] = [];
    await snapshotThen(
      spec,
      `拖拽改属性：${what} → ${sec.value} = ${target.title}`,
      async () => {
        // 逐篇写：`fm.setMany` 是"给**一个**文件设多个字段"，没有多文件重载
        //（快照那一步已经是一次覆盖整组的 —— 撤销仍然只有一条）
        for (const it of group) {
          const r = await ctx.fm.setMany(it.file, { [sec.value]: target.title });
          if (r.skipped.length > 0) skippedProps.push(it.file.basename);
        }
      },
      () => {
        const done = group.length - skippedProps.length;
        const skipNote = skippedProps.length > 0 ? `；${skippedProps.length} 篇跳过（前言里有嵌套映射）` : '';
        return group.length > 1
          ? `已把 ${done} 篇的「${sec.value}」改成「${target.title}」${skipNote}`
          : `已把「${sec.value}」改成「${target.title}」${skipNote}`;
      },
    );
    return;
  }

  // ③ 标签源 → 加目标标签（来源也是标签源时，把来源那个标签删掉）
  if (sec.kind === 'tag') {
    /** 被 17.2 守卫跳过的篇（同属性那条） */
    const skippedTags: string[] = [];
    const add = [sec.value];
    const remove: string[] = [];
    const from = spec.groups().find((g) => g.key === spec.fromKey);
    /**
     * ⚠️ 要比的是**标签值**（`sec.value`），不是板块的显示名（`group.title`）——
     * 板块可以改名（`name ≠ value`），拿显示名去 `remove` 删不掉真正的旧标签
     * （静默失败：那篇笔记同时留在两个标签板块里），运气不好还会删错标签。
     */
    const fromSec = from ? cfg.sections.find((x) => x.id === from.sectionId) : undefined;
    if (fromSec && fromSec.kind === 'tag' && fromSec.value !== sec.value) remove.push(fromSec.value);
    await snapshotThen(
      spec,
      `拖拽改标签：${what} → ${sec.value}`,
      async () => {
        // 逐篇写（同属性那条：`fm.setMany` 只管一个文件），但**快照是一次拍整组的**
        for (const it of group) {
          const cur = asList(it.props['tags']).map((t) => t.replace(/^#/, ''));
          const next = Array.from(new Set([...cur.filter((t) => !remove.includes(t)), ...add]));
          const r = await ctx.fm.setMany(it.file, { tags: next });
          if (r.skipped.length > 0) skippedTags.push(it.file.basename);
        }
      },
      () => {
        const done = group.length - skippedTags.length;
        const skipNote = skippedTags.length > 0 ? `；${skippedTags.length} 篇跳过（前言里有嵌套映射）` : '';
        return group.length > 1
          ? `已给 ${done} 篇加上「${sec.value}」标签${skipNote}`
          : `已加上「${sec.value}」标签${skipNote}`;
      },
    );
    return;
  }

  /**
   * ④ 剩下的只有收容所（**文案按实际种类说**，别一句话套所有情况 ——
   * R2 那次的症状就是"拖到属性值板块，被告知收容所不能拖"）
   */
  spec.onError(
    sec.kind === 'shelter'
      ? '「收容所」不是能拖进去的板块 —— 它显示的是哪条规则都没命中的笔记'
      : `「${target.title}」这块暂时不接受拖动改属性（数据源：${sec.kind}）`,
  );
}

/** 目标文件夹板块 → 相对库根的目录（子板块要带上自己那一段） */
function folderDirOf(target: BoardGroup, sec: BoardSection, ctx: WorkbenchContext): string | null {
  if (sec.kind !== 'folder') return null;
  const kbRoot = ctx.settings.kbRoot();
  const base = relativeTo(joinPath(kbRoot, sec.value), kbRoot);
  return target.sub ? `${base}/${target.title}` : base;
}

/**
 * 动库前先拍快照 → 写 → 弹撤销条。
 * **快照失败即停**（与 mover 同一条纪律：安全论证建立在"操作前一定有完整快照"上）。
 */
async function snapshotThen(
  spec: CardMoveDeps,
  reason: string,
  write: () => Promise<void>,
  /**
   * 撤销条上的话。**允许传函数**：属性/标签那两条要在写完之后才知道
   * 有几篇被守卫跳过了（前言里有嵌套映射）——话得说准（独立审查 🟡1）。
   */
  okText: string | (() => string),
): Promise<void> {
  const { ctx } = spec;
  let id = '';
  /** 整组一起拍（c 期）：一条快照 = 一条撤销 —— 这是"一次操作 = 一个撤销句柄"的落点 */
  const files = moveGroup(spec).map((x) => x.file);
  try {
    const m = await ctx.snapshot.capture({ reason, files });
    id = m.id;
  } catch (err) {
    spec.onError(`操作已中止：快照没能写成（${err instanceof Error ? err.message : String(err)}）`);
    return;
  }
  try {
    await write();
  } catch (err) {
    notify({
      kind: 'error',
      text: '改的时候出错了',
      detail: err instanceof Error ? err.message : String(err),
      ms: NOTIFY_MS.long,
    });
    return;
  }
  showUndo({
    text: typeof okText === 'function' ? okText() : okText,
    // 一组时别只报起手那一篇的名字（用户会以为"怎么只改了一张"）
    detail: files.length > 1 ? `${files.length} 篇一起` : spec.entry.basename,
    onUndo: () => void restoreOrNotify(ctx.snapshot, id),
    onView: () => void ctx.report.openLatest(),
  });
  spec.refresh();
}


