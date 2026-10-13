/**
 * modules/home/blocks —— **首页区块的注册表与显隐/顺序解析**（P7.2a §1.2）
 *
 * 数据流（单一真源一条线）：
 *
 * ```
 * settings.homeBlocks（null | { order, hidden }）
 *      ↓ resolveHomeBlocks()          ← 纯函数，判据钉它
 * { order: string[], hidden: Set, touched }   ← 渲染循环只见这个
 *      ↓ HomeModule 的渲染循环
 * 每块 paint(ctx, host) → false = "我没内容" → 不画（D3：渲染后自报，不提前猜数据）
 * ```
 *
 * 🔴 **显隐/顺序只有这一个解析口**（与 `resolveNotesView()` 同一条纪律）——
 * 首页渲染循环和设置面板的「首页」栏都从这里取，两处各写一份必漂。
 *
 * 块内部状态（随机漫步的种子这类**瞬时**的东西）归块文件自己（模块级变量），
 * 这里只认"注册表 + 落盘形状"。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { HomeBlocks } from '../../../core/settings';
import { heroBlock } from './hero';
import { quickBlock } from './quick';
import { todoBlock } from './todo';
import { recentBlock } from './recent';
import { footBlock } from './foot';
import { favBlock } from './fav';
import { walkBlock } from './walk';
import { tutorialBlock } from './tutorial';
import { graphLinkBlock } from './graphlink';
import { homeCardsBlock } from './homecards';

export interface HomeBlock {
  /** 稳定 id（落进 `homeBlocks.order` / `hidden` —— **改名 = 迁移**，别随手改） */
  id: string;
  /** 设置面板「首页」栏里的块名 */
  title: string;
  /** 一句话说明（设置栏那一行的 hint；悬停可见） */
  hint: string;
  /** 没动过时默认开不开（resolve 与"新块默认关"都靠它） */
  defaultOn: boolean;
  /**
   * 容器宽度档（`styles/home.css` 的 `.kbw-hblock[data-w]`）：
   * `narrow` = 640（上半部 Google 式那档）· 缺省 = `wide` 720（工作台式）。
   * 拆块前这两档分别在 `.kbw-hero` 与 `.kbw-home-body` 上，拆后落到容器。
   */
  width?: 'wide' | 'narrow';
  /**
   * 画进 `host`（HomeModule 建的块容器）。
   * 返回 `false` = 这块现在没内容 → 容器不画（D3）。
   * ⚠️ **判定必须同步可得**（异步内容回来之前就先答"有没有"）——
   * 像待处理那种"永远有内容"（空时显示「库是干净的」）就恒 true。
   */
  paint(ctx: WorkbenchContext, host: HTMLElement): boolean;
  /**
   * 收干净这块的**瞬时状态**（Esc 层 / 挂起的异步世代号 / 模块级引用 / **挂进宿主的叶**）。
   * HomeModule 在「重建整块」与「卸载」时调；必须**幂等**（可以连着调两次）。
   * ⚠️ 少了它 = 卸载后 Esc 层还压着（hero 的搜索框就是这么栽的形态）。
   *
   * **`host` = 这一轮的块内容容器**（`.kbw-hblock-body`，P7.2d 加）：图谱卡 / 钉住的笔记
   * 都在宿主里挂了"叶"或"窗"，收尾要**认准自己那一份**——模块级单例在分屏双首页时
   * 会被乙屏的 cleanup 把甲屏的东西收掉。老块们不看这个参数（它们的状态本就在模块级）。
   */
  cleanup?(host?: HTMLElement): void;
  /**
   * **重载这一块**（P7.11 · #8「重载此板块」）：不实现 = 渲染循环**强制重画**该块；
   * 想"顺带做点什么"的块覆写它 —— 随机漫步 = `seed = nextSeed(seed)`（重画自然换新三篇，
   * 与「换一批」同源；Q5 拍板，**不上菜单文案**）。
   * 钩子在**重画之前**跑（渲染循环负责重画，这里不管 DOM）。
   */
  reload?(ctx: WorkbenchContext): void;
}

/**
 * **注册表**（顺序 = 默认顺序；五老块在前、新模块在后）。
 * id 是落盘键，**加块 = 往这里加一项**；默认关的块在 `homeBlocks === null`
 * 的世界里自然不显示（`defaultOn: false`）。
 */
export const HOME_BLOCKS: HomeBlock[] = [
  heroBlock,
  quickBlock,
  todoBlock,
  recentBlock,
  footBlock,
  favBlock,
  walkBlock,
  tutorialBlock,
  graphLinkBlock,
  homeCardsBlock,
];

export const BLOCK_BY_ID: Record<string, HomeBlock> = Object.fromEntries(
  HOME_BLOCKS.map((b) => [b.id, b]),
);

export interface ResolvedBlocks {
  /** **完整顺序**（含隐藏块 —— 藏起来的块也留在序列里，恢复时回原位） */
  order: string[];
  /** 隐藏的块 id（不在表里 = 显示） */
  hidden: Set<string>;
  /** 用户动过没有（`homeBlocks === null` 时 false） */
  touched: boolean;
}

/**
 * **显隐/顺序的唯一解析口**。
 *
 * ```
 * stored === null（还没动过） → order = 注册表序 · hidden = defaultOn 为假的块
 * stored 是对象（动过）        → order = 表里有的按表排 + 表里没有的接末尾（按注册表序）
 *                              hidden = 表里认识的块；**不在 hidden = 显示**
 * ```
 *
 * ⚠️ **不认识的 id 一律丢弃**（块被删/改名的残留）—— 渲染层绝不能拿到画不出来的 id。
 * ⚠️ 顺序表里重复的 id 也只留第一个（手改 `data.json` 的容错）。
 */
export function resolveHomeBlocks(stored: HomeBlocks | null): ResolvedBlocks {
  const known = HOME_BLOCKS.map((b) => b.id);
  if (!stored) {
    return {
      order: known,
      hidden: new Set(HOME_BLOCKS.filter((b) => !b.defaultOn).map((b) => b.id)),
      touched: false,
    };
  }
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of stored.order) {
    if (!BLOCK_BY_ID[id] || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of known) if (!seen.has(id)) order.push(id);
  const hidden = new Set(stored.hidden.filter((id) => Boolean(BLOCK_BY_ID[id])));
  return { order, hidden, touched: true };
}

/**
 * **「钉住的笔记」这个 Region 的 key**（P7.2d）。
 *
 * 为什么它单独一条（不跟 `REPAINT_IDS` 的 `${rev}|${dismissed}` 一眼）：
 *  · **行卡档吃 `rev`**（笔记改名 / 状态变了行要跟着新 —— 与收藏夹同一条）；
 *  · **窗档不吃 `rev`** —— 窗里是**真编辑器**，index 一变就重画会把块清掉再拼回来，
 *    焦点当场从编辑器里掉出去（每保存一次打字就断一段）。窗档只吃 `cards`
 *    （钉选变了才对齐一次）。
 *
 * 档位**从 `gate` 现读**：看板开关一翻 key 就换（`win|…` ↔ `rows|…`）→ 正好重画一次，
 * 把窗建立 / 收掉（HomeModule 里挂了 `gate.onChange` → `repaintBlocks`）。
 */
export function homeCardsRegionKey(
  ctx: WorkbenchContext,
  s: { rev: number; cards: string },
): string {
  return ctx.gate.isOn('board') ? `win|${s.cards}` : `rows|${s.cards}|${s.rev}`;
}

/**
 * 在 `order` 里把 `id` 与**相邻的可换项**对调（上移 / 下移按钮与「⋯」菜单共用）。
 *
 * `neighbors` = "能当邻居的 id 集合"：
 * · 首页的「⋯」= **只算可见块**（用户看不到隐藏块，越过它等于"点了没反应"）；
 * · 设置面板 = 全部块（那里它们都画着）。
 *
 * 到边了原样返回（不越界、**不循环**——"上移一位"在第一位上就该什么都不做）。
 */
export function swapNeighbor(order: string[], id: string, dir: -1 | 1, neighbors: string[]): string[] {
  const inSet = new Set(neighbors);
  const spots = order.map((x, i) => (inSet.has(x) ? i : -1)).filter((i) => i >= 0);
  const at = spots.findIndex((i) => order[i] === id);
  if (at < 0) return order;
  const other = spots[at + dir];
  if (other === undefined) return order;
  const next = [...order];
  const a = spots[at];
  next[a] = order[other];
  next[other] = order[a];
  return next;
}

/**
 * **首页拖序的插入位**（单列纵向）：指针 y 落在哪两块的"中线"之间。
 * 返回 0..rows.length（= 插到最前 / 最后）。
 *
 * ⚠️ **与 `modules/notes/grid-order.ts` 的 `insertionIndexAt` 是同族不同物**：
 * 那个是网格的**二维**判定（y/r.top + x/r.左侧中线），这个是一维 —— 故用
 * `RowAt` 这个名字区分，别把两套法则挪错地方。
 *
 * 收成纯函数是为了判据 —— 拖动本身在 jsdom 里不好派（真机探针钉它），
 * 但"y 落在哪"这条口径离线就能钉死。
 */
export function insertionRowAt(rows: { top: number; height: number }[], y: number): number {
  for (let i = 0; i < rows.length; i += 1) {
    if (y < rows[i].top + rows[i].height / 2) return i;
  }
  return rows.length;
}

/**
 * 线性同余**走一步**（「换一批」的种子推进 —— 与 `pickRandom` 内部同一套常数，
 * 两处同源，别各写一份）。
 */
export function nextSeed(seed: number): number {
  return (Math.imul(seed >>> 0, 1103515245) + 12345) >>> 0;
}

/**
 * 用种子做**稳定的**伪随机抽样（线性同余）——「随机漫步」用。
 *
 * 为什么不是 `Math.random()`：判据要能钉"同一个种子 = 同一批结果"（离线上
 * `Math.random` 的断言只能写"变了"这种弱判据）。**不放回**抽取，`n` 超过池子时给全部。
 */
export function pickRandom<T>(pool: T[], seed: number, n: number): T[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = nextSeed(s);
    return s / 4294967296;
  };
  const bag = pool.map((_, i) => i);
  const out: T[] = [];
  for (let k = 0; k < n && bag.length > 0; k += 1) {
    const j = Math.floor(rnd() * bag.length);
    out.push(pool[bag[j]]);
    bag.splice(j, 1);
  }
  return out;
}
