/**
 * tests/shards.ts —— **离线套件分片**（P7.20-1）
 *
 * 要解决的问题：全量离线套件（24 个块 · ~1200 条）**单进程 14 分钟**，而它一轮要跑好几遍。
 * 32 核的机器上这是纯浪费 —— 拆成 N 片并行，墙钟时间接近 1/N。
 *
 * 切在**块**粒度，不切用例 —— 这是**取证**结论，不是图省事：
 *   `tests/specs/p710.ts:88` 明写「**接上一条**：浮层还开着」、
 *   `tests/specs/e.ts:505` 明写「先确保编辑面板正占着窗格（**上一条留下的状态**）」……
 *   块**内**的用例是有顺序依赖的；块**之间**才是独立的（各自建库 / resetDom / shutdown）。
 *   ⇒ 只有块粒度分片是**构造上安全**的。想切更细，得先把那些依赖改成自足（另一件事）。
 *
 * 分配方式：**按声明顺序轮转**（`seq % N === K`）——
 *   不依赖任何"块表"常量（`want()` 的调用顺序**就是**块顺序），因此不会出现
 *   "表和代码漂了、某块谁也不跑 / 两块都跑"这种分片特有的假绿；
 *   各片拿到的块数最多差 1。
 *
 * 🔴 **分片模式下一律退出码 2**（不是 0）：只跑了一部分，**按本项目一贯口径"不算通过"**。
 *    （`tests/index.ts` 的退出码分支里强制。）否则"某片把块全跳过了"会以 0 退出 → 假绿。
 *
 * 隔离：分片模式下 `tests/.tmp/<tag>` 与 `tests/.fixture/<tag>` 各自一份（见 `helpers.ts`）——
 *   `ensureFixtures()` 会先 `rmrf` 再重建，四个进程同时干这事必然互删。
 */
import path from 'node:path';

/** 片数（`KBW_SHARDS`）。≤1 或没设 → **不分片**，行为与从前完全一致。 */
const SHARDS = Math.max(0, Math.floor(Number(process.env.KBW_SHARDS ?? 0)));
/** 本片序号（`KBW_SHARD`，0 起）。 */
const SHARD = Math.max(0, Math.floor(Number(process.env.KBW_SHARD ?? 0)));
/** 本片标签（`KBW_SHARD_TAG`）—— 只用来给隔离目录命名（`s0` / `s1` …）。 */
export const SHARD_TAG = process.env.KBW_SHARD_TAG ?? '';
export const SHARD_ON = SHARDS > 1;
export const SHARD_N = SHARD_ON ? SHARDS : 1;
export const SHARD_K = SHARD_ON ? SHARD : 0;

/** 隔离目录名（相对 `tests/.tmp` 与 `tests/.fixture` 的那一层）。空串 = 不分片（保持原样）。 */
export function shardDirName(): string {
  return SHARD_ON && SHARD_TAG ? SHARD_TAG : '';
}

/** 带片号的路径：不分片时原样返回（**不许**给不分片的路径加一层 —— 会改变既有目录布局） */
export function shardize(base: string): string {
  const d = shardDirName();
  return d ? path.join(base, d) : base;
}

/**
 * 造一个闸门。**每个块调一次 `want(名字)`**，调用顺序即块顺序。
 * ⚠️ 不许跳过调用（`if (G.want('x'))` 里那句必须写在块的最外层）—— 少调一次，
 *    后面所有块的分片号就整体错位（症状：某块被两片都跑 / 都不跑）。
 */
export function makeGate() {
  let seq = -1;
  const mine: string[] = [];
  const all: string[] = [];
  return {
    on: SHARD_ON,
    /** 这个块归本片吗？ */
    want(id: string): boolean {
      seq += 1;
      all.push(id);
      const ok = !SHARD_ON || seq % SHARD_N === SHARD_K;
      if (ok) mine.push(id);
      return ok;
    },
    /** 收尾自报：本片负责哪些块（给日志用） */
    report(): { mine: string[]; all: string[] } {
      return { mine, all };
    },
  };
}
