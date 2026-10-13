/**
 * services/suggest-learned.ts —— **建议源②「学你过往的修正」**（P7.6 · 11.1）
 *
 * 记录"用户手动把 X 类笔记（按标签 / 按来源目录）搬到了 Y"，攒够频次后
 * 对同类笔记出**建议**（不是自动动作 —— 建议一律走 `services/suggest.ts` 的流水线）。
 *
 * 三条口径（设计对表 §2-②）：
 *   · **学谁的**：只学**手动**来源（`menu` / `drag` / `batch` / `board`）。
 *     `reconcile`（自动）不学 —— 那是机器自己动的；`ai` 不学 —— 把 AI 的判断喂回来
 *     等于放大它自己的偏见；`rebuild` 不学 —— 那是钝工具（收拢/兜底），不代表用户偏好；
 *     `template` 不学 —— 那是模板库的删除流。
 *   · **存哪**：插件 `data.json` 的 `moveStats`（G6-Q5 拍板；与 `reconcileSeen` 同族 ——
 *     "这台机器看见过什么习惯"，不进库、不随同步）。**写盘由 main.ts 装配**（这里只出数据）。
 *   · **阈值**：同方向的落点见过 **≥2 次**才算"习惯"（一次是偶然，两次是倾向）。
 *     上限（每类 ≤50 键、每键 ≤8 落点、计数封顶 99）在**记录侧**截，读侧不悄悄丢。
 *
 * 🔴 它**不认识 mover**：记录的那一下由 `mover.move` 的 `onMoved` 可选回调带出来
 * （main.ts 装配）。本文件的函数全是纯的，离线可断言。
 */
import type { MoveStats } from '../core/settings';
import { parentDir, relativeTo } from '../core/paths';

/** 会学习的 mover 来源（见文件头的三条口径） */
export const LEARN_SOURCES = ['menu', 'drag', 'batch', 'board'] as const;

/** 建议阈值：同方向见过几次才算"习惯"（设计对表定的 2） */
export const LEARN_MIN = 2;
/** 每类（tag / dir）的键上限 —— 超了**不再进新键**（老键照常计数） */
export const LEARN_MAX_KEYS = 50;
/** 每个键的落点上限 —— 超了挤掉次数最少的那个 */
export const LEARN_MAX_DIRS = 8;
/** 计数封顶（防 data.json 无限增长） */
export const LEARN_COUNT_CAP = 99;

/** 一次搬动的三样（`tags` 是**搬之前**的标签 —— 搬动只动位置、不动标签） */
export interface MovedInfo {
  /** 库内绝对路径（旧位置） */
  from: string;
  /** 库内绝对路径（新位置） */
  to: string;
  tags: string[];
}

/** 候选笔记（相对库根口径 —— 本模块内部一律"相对库根"，与 suggest.ts 同一纪律） */
export interface LearnedNote {
  pathRel: string;
  dirRel: string;
  tags: string[];
}

export interface LearnedHit {
  pathRel: string;
  /** 落点目录（相对库根）—— 合法性由 suggest.ts 的 precheck 统一管，这里不判 */
  to: string;
  why: string;
  evidence: string;
}

/**
 * 纯函数：把这批搬动并进表里（**返回新表，不改入参**）。
 * 不改变位置的（`fromDir === toDir`）和空键自动跳过；上限在这里截。
 */
export function recordMoves(stats: MoveStats, moves: MovedInfo[], kbRoot: string): MoveStats {
  const next: MoveStats = { tag: cloneSection(stats.tag), dir: cloneSection(stats.dir) };
  for (const m of moves) {
    const fromDir = relativeTo(parentDir(m.from), kbRoot);
    const toDir = relativeTo(parentDir(m.to), kbRoot);
    if (fromDir === toDir) continue; // 原地不学
    /**
     * ⚠️ **空串键（库根）跳过**（独立审查 🟢9）：`settings.ts` 的读盘收敛会把空键
     * 静默丢掉 —— 学到了也存不住，还会让"内存那份"与"盘上那份"不一致。宁可不学。
     */
    if (toDir === '' || fromDir === '') continue;
    for (const raw of m.tags) {
      const tag = String(raw ?? '').trim();
      if (tag) bump(next.tag, tag, toDir);
    }
    bump(next.dir, fromDir, toDir);
  }
  return next;
}

/**
 * 纯函数：对候选笔记出**原始建议**（落点合法性不在这一层 —— 统一过 precheck）。
 * 标签类优先于目录类（标签是"这篇是什么"，目录是"它碰巧在哪"）；
 * 每篇最多出一条，方向取**次数最多**的（并列取字典序小的，保证确定性）。
 */
export function suggestLearned(
  stats: MoveStats,
  notes: LearnedNote[],
  opts: { min?: number } = {},
): LearnedHit[] {
  const min = opts.min ?? LEARN_MIN;
  const out: LearnedHit[] = [];
  for (const n of notes) {
    const best = bestTagHit(stats, n, min) ?? bestDirHit(stats, n, min);
    if (!best) continue;
    out.push({
      pathRel: n.pathRel,
      to: best.to,
      why: `你以前把${best.via}的笔记搬到过这里`,
      evidence: `${best.via} · 搬过 ${best.n} 次`,
    });
  }
  return out;
}

function bestTagHit(
  stats: MoveStats,
  n: LearnedNote,
  min: number,
): { to: string; n: number; via: string } | null {
  let best: { to: string; n: number; via: string } | null = null;
  for (const tag of n.tags) {
    const dirs = stats.tag[tag];
    if (!dirs) continue;
    const top = topOf(dirs);
    if (!top || top.n < min || top.to === n.dirRel) continue;
    if (!best || top.n > best.n) best = { to: top.to, n: top.n, via: `带标签「${tag}」` };
  }
  return best;
}

function bestDirHit(
  stats: MoveStats,
  n: LearnedNote,
  min: number,
): { to: string; n: number; via: string } | null {
  const dirs = stats.dir[n.dirRel];
  if (!dirs) return null;
  const top = topOf(dirs);
  if (!top || top.n < min || top.to === n.dirRel) return null;
  return { to: top.to, n: top.n, via: `「${n.dirRel || '库根'}」` };
}

/** 表里次数最多的落点（并列取字典序小的 —— 确定性优先） */
function topOf(dirs: Record<string, number>): { to: string; n: number } | null {
  let best: { to: string; n: number } | null = null;
  for (const [to, n] of Object.entries(dirs)) {
    if (!best || n > best.n || (n === best.n && to < best.to)) best = { to, n };
  }
  return best;
}

function bump(section: Record<string, Record<string, number>>, key: string, dir: string): void {
  let dirs = section[key];
  if (!dirs) {
    if (Object.keys(section).length >= LEARN_MAX_KEYS) return; // 满了：不再进新键（老键照常计数）
    dirs = {};
    section[key] = dirs;
  }
  dirs[dir] = Math.min((dirs[dir] ?? 0) + 1, LEARN_COUNT_CAP);
  const entries = Object.entries(dirs);
  if (entries.length > LEARN_MAX_DIRS) {
    entries.sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
    while (Object.keys(dirs).length > LEARN_MAX_DIRS) {
      const victim = entries.shift();
      if (!victim || victim[0] === dir) continue;
      delete dirs[victim[0]];
    }
  }
}

function cloneSection(section: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, dirs] of Object.entries(section ?? {})) out[k] = { ...dirs };
  return out;
}

/**
 * 记录器（**唯一的状态持有处**）：内存里那份跟着写盘走。
 *
 * 为什么要内存副本：`settings.get()` 是落盘那次 `save()` 的产物，而 `save` 里
 * 两次紧邻的写是**串行**的（`settings.ts` 的口径）—— 一次会话里连搬两次时，
 * 第二次必须基于第一次的结果（照 `ReconcileRunner.seen` 的同一教训）。
 */
export class MoveLearner {
  private stats: MoveStats | null = null;

  constructor(
    private deps: {
      read: () => MoveStats;
      save: (next: MoveStats) => void;
    },
  ) {}

  current(): MoveStats {
    if (!this.stats) this.stats = this.deps.read();
    return this.stats;
  }

  /** 学一批（来源过滤在装配处做 —— 见 `LEARN_SOURCES`） */
  learn(moves: MovedInfo[], kbRoot: string): void {
    if (moves.length === 0) return;
    const next = recordMoves(this.current(), moves, kbRoot);
    this.stats = next;
    this.deps.save(next);
  }
}
