/**
 * services/reconcile.ts —— **自动归位**（`开发计划.md` §8 / `交互规格.md` §7.1）
 *
 * 这是全项目**风险最高**的功能（旧实现里就是它最不可预测：你在编辑一篇笔记，
 * 它可能因为标签变了就自己跑走）。所以 P3 把它削到只剩一条触发路径：
 *
 *   🔴 **只有"显式改 `文件位置` 属性"才搬**（改标签不算、什么都不算）
 *   🔴 **v2（P7.12 · #12 拍定）："自动归位开关"退役** —— 显式改 = 显式意图 = **直接搬**
 *      （不看开关；mover + 快照 + 撤销条兜底）。模块开关（`automation`）仍然总闸整体功能。
 *      ⚠️ `位置锁定` **不拦这条路**（"显式=手动语义"，#12 拍定原文）—— 于是 v2 里
 *      这个字段先保留、但没有纯后台的自动路径会碰它（真机行为变了要有意识）。
 *   🔴 排除：`99_Meta` / `02_旧知识库` / `还原保留` / `.开头`（可编辑，见 §7.1）
 *      —— **来源与目标都过滤**（只过滤来源的话，把「文件位置」写成 99_Meta/… 就会把笔记搬进去）
 *
 * 怎么知道"显式改了"：索引每次变更时，把每篇的 `文件位置` 与**上次看见的**那份比。
 * 上次那份存在插件 `data.json`（`reconcileSeen`）—— 它是"这台机器看见过什么"的会话状态，
 * 不是知识库配置（唯一真源原则：库内配置才是真源，见 `core/settings.ts` 的头注释）。
 *
 * ⚠️ **第一次见到一篇笔记时只登记、不搬**。否则"打开插件"本身就会把库里所有
 * "声明与实际不符"的笔记扫一遍搬走 —— 那不是"显式改"，是惊喜。
 *
 * ⚠️ **我们自己写的声明不算"显式改"**：补声明类流程（`chainLocus`）写完之后调
 * `noteSelfDeclared()` 把它登记成"上次看见的" —— 免得下一轮 tick 把我们的写
 * 当成用户意图又搬一次（口径：只有**用户**改的才触发）。
 *
 * 一条临场判断（P3 记进交接）：**目标目录不存在时不自动建**
 * （不自动 mkdir、不搬，只报一条说明）。理由：`文件位置` 打错一个字就会在库里
 * 悄悄长出一个没人要的目录，而自动动作没有"确认流"这道闸。
 * 手动搬（拖拽/批量）仍会建目录 —— 那是 mover 的既有行为。
 */
import type { NoteEntry } from '../core/vault-index';
import { relativeTo } from '../core/paths';
import { asList, asString, declaredPositions } from './schema';

export interface ReconcileMove {
  path: string;
  /** 库内绝对路径 */
  from: string;
  /**
   * ⚠️ **`to` 是"相对库根"的路径**（`02_Areas/内容创作/x.md`），**不是**库内绝对路径
   *（独立审查 A🟡5 订正的：这里原先的注释写着"库内绝对路径"，是错的）。
   *
   * **唯一该信的是 `declared`**：消费方（`main.ts` 的 `runReconcile` / 菜单那条）
   * 都是拿 `declared` 再 `joinPath(kbRoot, declared)` 算出真正的落点 ——
   * 本项目在"两种目录口径混用"上栽过两次（P3 把文件搬到 vault 根、P5 在库根外建目录），
   * 所以这一行注释不是措辞问题，是**下一次有人直接拿 `to` 去喂 mover 时的唯一提醒**。
   */
  to: string;
  /** 声明的位置（相对库根） */
  declared: string;
}

export interface ReconcileSkip {
  path: string;
  why: string;
}

export interface ReconcilePlan {
  moves: ReconcileMove[];
  skips: ReconcileSkip[];
}

export interface ReconcileOptions {
  kbRoot: string;
  /** 排除项（§7.1 默认 `99_Meta` `02_旧知识库` `还原保留` `.开头`） */
  exclude: string[];
  /** 库根下已存在的目录（相对库根）——目标不在这张表里就不搬 */
  dirs: Set<string>;
}

/**
 * 排除项：**前缀语义**（整条路径的前缀，或任意一段的前缀），另有 `.开头` 这个特例。
 *
 * 为什么按"段的前缀"而不是"整段相等"：快照还原建的目录是 `还原保留-<时间戳>/`，
 * 用户不可能把每个时间戳都写进排除表 —— 写 `还原保留` 就该拦住它们全部
 * （`交互规格.md` §7.1 的默认值原来写的是旧术语「回滚保留」，一个都拦不住，P3 已回改）。
 */
export function isExcluded(relToKb: string, exclude: string[]): boolean {
  const rel = String(relToKb ?? '').replace(/^\/+|\/+$/g, '');
  const segs = rel.split('/');
  for (const raw of exclude) {
    const token = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!token) continue;
    if (token === '.开头' || token === '.') {
      if (segs.some((s) => s.startsWith('.'))) return true;
      continue;
    }
    if (rel === token || rel.startsWith(`${token}/`)) return true;
    if (segs.some((s) => s === token || s.startsWith(token))) return true;
  }
  return false;
}

/**
 * ⚠️ 这两个字面量与 `rebuild.ts` 的 `COLLECT_PARENT / COLLECT_PREFIX` **同源约定**——
 * 不在两文件之间互相 import：`rebuild.ts` 反向 import 本文件的 `isExcluded`，直接
 * import 会成环。`redline.ts` 有静态断言钉着两处**逐字一致**（改一处必须两处一起改）。
 */
const COLLECT_PARENT = '04_Archives';
const COLLECT_PREFIX = '旧笔记-';

/** 目标是不是"收拢的归集夹"（`04_Archives/旧笔记-*`，任意深度都算） */
export function isCollectDir(rel: string): boolean {
  const segs = String(rel ?? '').replace(/^\/+|\/+$/g, '').split('/');
  return segs[0] === COLLECT_PARENT && (segs[1] ?? '').startsWith(COLLECT_PREFIX);
}

/**
 * 上次看见的 `文件位置` 与现在不一样 → 说明**有人显式改了它** → 该搬。
 * 纯函数：喂 entries + seen，出计划（离线可断言）。
 */
export function planReconcile(
  entries: NoteEntry[],
  seen: Record<string, string[]>,
  opts: ReconcileOptions,
): ReconcilePlan {
  const moves: ReconcileMove[] = [];
  const skips: ReconcileSkip[] = [];
  for (const e of entries) {
    if (e.isTemplate) continue;
    const relToKb = relativeTo(e.path, opts.kbRoot);
    if (isExcluded(relToKb, opts.exclude)) continue;

    const prev = seen[e.path];
    if (prev === undefined) continue; // 第一次见：只登记（见文件头）
    const cur = declaredPositions(e.props);
    if (sameList(prev, cur)) continue;
    if (cur.length === 0) continue; // 改成留空 = 取消声明，不是"搬到库根"
    const want = cur[0];
    const actual = e.effectivePosition;
    if (cur.includes(actual)) {
      // 声明的多个位置里有一个就是现在这里 → 不用动
      continue;
    }
    /**
     * ⚠️ **目标不许是归集夹**（P7.17 · 真机探针实测的残留）：`04_Archives/旧笔记-*`
     * 是收拢时的临时归宿 —— 收拢进行中有一小段"文件已在归集夹、声明也刚写成归集夹"
     * 的窗口，此刻**任何别的触发源**动了其中一篇，还原时会被"快照之后出现过新文件"
     * 那类守卫挡下 → **残留在归集夹里**（原位空缺、归集夹删不掉；探针"归集夹没收回"
     * 就是这么红的）。对**自动**归位来说，声明指向归集夹一律是**在途/中断的收拢痕迹**，
     * 不搬、只报（要真搬，用户自己说）。
     */
    if (isCollectDir(want)) {
      skips.push({ path: e.path, why: `目标在收拢的归集夹里（在途痕迹，不自动搬）：${want}` });
      continue;
    }
    // ⚠️ **目标也要过排除**：只过滤来源的话，把 `文件位置` 写成 `99_Meta/03_AI指令集`
    // 就会让自动归位把笔记**搬进** 99_Meta（那是配置区，排除项的本意包含它）
    if (isExcluded(want, opts.exclude)) {
      skips.push({ path: e.path, why: `目标在排除范围内，自动归位不搬：${want}` });
      continue;
    }
    if (!opts.dirs.has(want)) {
      skips.push({
        path: e.path,
        why: `目标目录不存在（自动归位不建目录）：${want} —— 手动搬过去，或先建那个目录`,
      });
      continue;
    }
    moves.push({
      path: e.path,
      from: e.path,
      to: `${want}/${e.basename}.md`,
      declared: want,
    });
  }
  return { moves, skips };
}

// ⚠️ **`planOneReconcile` 已退役**（P7.12 · R8，2026-10-06）：它只服务编辑器菜单那条
// 「按规则归位这一篇」；R8 把那一项**并入「自动整理」**（`modules/home/tidy.ts` 的
// `runInboxTidy` 收窄档），判据换成与一键整理同一条 `planRebuild` 链 ——
// "规则只有一份"的原则不变，只是那份规则搬了家。别再把它请回来：
// 单篇归位现在走「经纬AI › 自动整理」（声明优先照搬 + 未声明由 AI 补声明）。

// ────────────────────────────────────────────────────────────────
// P7.13b · ①「位置不一致 → 搬回声明处」的计划（纯函数）
// ────────────────────────────────────────────────────────────────
/**
 * 与 `planReconcile` **同一族**（按声明搬），差别只在**触发与集合**：
 *   · 触发 = 用户在首页待处理清单上按的 ①（显式动作 + 确认流兜底），
 *     不是"看见声明变了" —— 所以**不看 `seen`**（那份簿记只管自动路）；
 *   · 集合 = 当下每一篇 `声明 ≠ 实际` 的（与 `position-mismatch` 旗标同源、口径同一条：
 *     `declared.length > 0 && !declared.includes(actual)`），**含没改过声明的存量**。
 *
 * 三类去向（P7.13b 拍定：目录不存在时"建前单独问一次"）：
 *   · `moves` —— 目标目录**已存在**的（进主确认单）；
 *   · `missing` —— 目标目录**不存在**的（调用方先问一次"要顺手建出来吗"；
 *     建 → 并进 moves 走 mover（它负责建目录，快照 `newDirs` 记着、可还原）；
 *     不建 → 调用方自行列成"跳过 + 原因"）；
 *   · `skips` —— 目标在排除范围内（与 `planReconcile` 同一条守卫：只报不搬）。
 *     ⚠️ 来源在排除区（`99_Meta` / `还原保留`）的**也进 skips、不静默** ——
 *     这是用户点出来的动作，行数对不上要比"少搬一篇"更值得说清（与自动路的
 *     静默来源过滤**有意不同**）。
 */
export interface MoveBackMissing {
  path: string;
  /** 声明的目标（相对库根） */
  declared: string;
}

export interface MoveBackPlan {
  moves: ReconcileMove[];
  missing: MoveBackMissing[];
  skips: ReconcileSkip[];
}

export function planMoveBackToDeclared(entries: NoteEntry[], opts: ReconcileOptions): MoveBackPlan {
  const moves: ReconcileMove[] = [];
  const missing: MoveBackMissing[] = [];
  const skips: ReconcileSkip[] = [];
  for (const e of entries) {
    if (e.isTemplate) continue;
    const declared = declaredPositions(e.props);
    if (declared.length === 0) continue;
    if (declared.includes(e.effectivePosition)) continue; // 声明里有一个就是现在这里 → 不用动
    const want = declared[0];
    const relToKb = relativeTo(e.path, opts.kbRoot);
    if (isExcluded(relToKb, opts.exclude)) {
      skips.push({ path: e.path, why: '它在配置区（排除范围）里，不自动搬' });
      continue;
    }
    if (isExcluded(want, opts.exclude)) {
      skips.push({ path: e.path, why: `目标在排除范围内，不搬回：${want}` });
      continue;
    }
    if (!opts.dirs.has(want)) {
      missing.push({ path: e.path, declared: want });
      continue;
    }
    moves.push({ path: e.path, from: e.path, to: `${want}/${e.basename}.md`, declared: want });
  }
  return { moves, missing, skips };
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 现在这一轮该记下来的"上次看见的声明"（每次索引变更后覆盖） */
export function snapshotDeclared(entries: NoteEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of entries) {
    out[e.path] = declaredPositions(e.props);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// store：`data.json` 里那份"上次看见的声明"（纯数据，好断言）
// ────────────────────────────────────────────────────────────────
export type SeenMap = Record<string, string[]>;

/**
 * 把新的一轮合并进 seen。
 * 返回**有没有变化**（没变就不用写盘 —— 否则每次索引动一下都要写 data.json）。
 * ⚠️ 忘了某篇（文件被删/改名）就从表里去掉，免得 data.json 越滚越大。
 */
export function mergeSeen(seen: SeenMap, entries: NoteEntry[]): { next: SeenMap; changed: boolean } {
  const next: SeenMap = {};
  let changed = false;
  const alive = new Set<string>();
  for (const e of entries) {
    alive.add(e.path);
    next[e.path] = declaredPositions(e.props);
  }
  for (const [path, list] of Object.entries(seen)) {
    if (alive.has(path)) continue;
    changed = true;
    void list;
  }
  if (!changed) {
    // 逐条比：路径集合相同也可能有值变了
    const oldPaths = Object.keys(seen);
    if (oldPaths.length !== Object.keys(next).length) changed = true;
    else {
      for (const [path, list] of Object.entries(next)) {
        const old = seen[path];
        if (!old || !sameList(old, list)) {
          changed = true;
          break;
        }
      }
    }
  }
  return { next, changed };
}

/** 声明的位置（第一条）—— 面板里显示"它说它该在哪"用 */
export function declaredOf(props: Record<string, unknown>): string {
  return asString(asList(props['文件位置'])[0] ?? '');
}

// ────────────────────────────────────────────────────────────────
// 运行时：跟着索引走（谁都不许旁路 —— 搬文件只能过 mover）
// ────────────────────────────────────────────────────────────────
export interface ReconcileDeps {
  /** 库根下**已存在**的目录（相对库根）——目标不在里面就不搬（见文件头那条临场判断） */
  dirs: () => Set<string>;
  kbRoot: () => string;
  /**
   * 总闸：模块开关（`automation`）。
   * ⚠️ v2（#12）：`自动化.json` 的 `reconcile.enabled` 已退役 —— 开不开都搬
   * （显式改 = 直接搬）；这个回调只剩模块开关这一层。
   */
  enabled: () => Promise<boolean>;
  exclude: () => Promise<string[]>;
  entries: () => NoteEntry[];
  /** "上次看见的声明"（存在插件 data.json 里） */
  seen: () => SeenMap;
  saveSeen: (next: SeenMap) => void;
  move: (moves: ReconcileMove[]) => Promise<void>;
  /** 跳过项的说明（每次变更最多报一次） */
  onSkip: (skips: ReconcileSkip[]) => void;
  /** 订阅索引变更，返回退订函数 */
  watch: (cb: () => void) => () => void;
}

export class ReconcileRunner {
  private deps: ReconcileDeps;
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * "上次看见的声明"的**内存版**（`deps.seen()` 是落盘的那一份，可能落后）。
   * 为什么要分两份：落盘是**防抖 800ms** 的（批量搬一次别写十遍 data.json），
   * 而这一轮算完的下一轮必须立刻看到新值 —— 否则在一个防抖窗口内连着发生两次改动时，
   * 第二次会被当成"没改过"（P3 离线用例实测：`tick()` 之后紧接着再 `tick()` 就漏了）。
   */
  private seen: SeenMap | null = null;
  /** 测试用：跑了几轮、最近一轮的计划 */
  public runs = 0;
  public lastPlan: ReconcilePlan | null = null;
  /**
   * 最近几轮的流水（**排查"它为什么没动"用**）：每轮记"开关开着吗、排出几篇、登记了几条变化"。
   * 这东西不在界面上，但真机上出问题时（"我改了文件位置它没搬"）能一眼看出卡在哪一环：
   * 是没 tick、还是 tick 了但开关关着、还是"上次看见的"已经记成新值了。
   */
  public recent: { at: number; on: boolean; moves: number; skips: number; registered: number }[] = [];

  constructor(deps: ReconcileDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.off) return;
    this.off = this.deps.watch(() => this.schedule());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  /** 索引动一下会触发好几次（写盘 + metadataCache 两拍）→ 攒一攒再算 */
  private schedule(delay = 450): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  /** 现在这份"上次看见的"（内存优先；第一轮从盘上取一次） */
  private currentSeen(): SeenMap {
    if (!this.seen) this.seen = this.deps.seen();
    return this.seen;
  }

  /**
   * **我们自己写了某篇的「文件位置」**（补声明等流程）→ 把它登记成"上次看见的"，
   * 免得下一轮 tick 把这笔自写当成"用户显式改"又搬一次（v2 口径：只有用户改的才触发）。
   * ⚠️ 同步更新内存与落盘两份（`currentSeen` 优先内存 —— 只写盘的会被内存盖掉）。
   */
  noteSelfDeclared(path: string, declared: string[]): void {
    const cur = this.currentSeen();
    this.seen = { ...cur, [path]: [...declared] };
    this.deps.saveSeen(this.seen);
  }

  /** 手动跑一轮（设置面板的「立即检查一次」用；也方便离线用例直接调） */
  async tick(): Promise<ReconcilePlan> {
    if (this.running) return { moves: [], skips: [] };
    this.running = true;
    try {
      const entries = this.deps.entries();
      const prev = this.currentSeen();
      // ① 先按"上次看见的"算计划（要用旧值才能看出"谁改了"）
      const enabled = await this.deps.enabled();
      let plan: ReconcilePlan = { moves: [], skips: [] };
      if (enabled) {
        plan = planReconcile(entries, prev, {
          kbRoot: this.deps.kbRoot(),
          exclude: await this.deps.exclude(),
          dirs: this.deps.dirs(),
        });
      }
      // ② 再登记这一轮（**无论开不开都登记**：关着的时候改的，不该在开的一瞬间补搬）
      const merged = mergeSeen(prev, entries);
      if (merged.changed) {
        this.seen = merged.next; // 内存立刻生效
        this.deps.saveSeen(merged.next); // 落盘防抖（由调用方决定多长）
      }
      this.runs += 1;
      this.lastPlan = plan;
      this.recent.push({
        at: Date.now(),
        on: enabled,
        moves: plan.moves.length,
        skips: plan.skips.length,
        registered: merged.changed ? Object.keys(merged.next).length : 0,
      });
      if (this.recent.length > 20) this.recent.shift();
      if (plan.moves.length > 0) await this.deps.move(plan.moves);
      if (plan.skips.length > 0) this.deps.onSkip(plan.skips);
      return plan;
    } finally {
      this.running = false;
    }
  }
}
