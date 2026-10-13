/**
 * services/rebuild.ts —— **库结构重排**（P5 · `开发计划.md` §10 / `交互规格.md` §6）
 *
 * 一句话：按库内 `99_Meta/06_工作台/库结构.json`（**目标骨架**）把库的目录骨架
 * **幂等原地重排**一遍，把散着的笔记分送到骨架目录里。
 *
 * 本文件只做**计划与判定**（纯函数，可离线钉住）；真正动文件的是 `services/mover.ts`
 * （三条硬规矩之一：动文件只能过它）。分工：
 *   · 这里算出：要新建哪些目录 / 哪几篇要搬去哪 / 哪些**不搬**（待定）/ 哪个节点会撞名
 *   · 执行时：一次 `mover.move()`（**一轮一个快照**）—— 撞名分「已搬过 / 真冲突」由它判
 *
 * ────────────────────────────────────────────────────────────────
 * 判据（2026-09-26 用户拍板，别再自己发明第二条；v2 改口径处已标注）
 * ────────────────────────────────────────────────────────────────
 * ① **声明优先**：一篇笔记的「文件位置」声明就是它该在哪；声明里有一个就是它现在的位置 → 不动。
 * ② **兜底，且只在 `00_Inbox` 里兜底**：Inbox 是唯一暂存区 —— 里面**没有声明**的笔记
 *    送进**兜底目录**（路由表的「领域兜底」）。
 *    ⚠️ v2（P7.12「领域退役」）：原先这里查"笔记的「领域」值 → 目录"的别名路由；
 *    领域属性没了之后，**没有信号**（无标签命中 / 无关键词 / 未声明）的 Inbox 笔记
 *    统一去兜底目录；带信号的由 `services/suggest.ts` 的启发层（标签 / 关键词 / AI）
 *    先接走（prio 都高于兜底档）。⚠️ 为什么必须划 Inbox 这个范围：
 *    "Inbox 之外的位置"本身就是一种声明：你把它放在那儿，工具不该替你改主意。
 * ③ **`99_Meta`（工具区）里的文件一律不动**：模板 / 日志 / 配置的位置由各自的功能定，
 *    重排只负责"缺目录就补目录"。⚠️ 但**目标是 `99_Meta` 的照搬**（路由表配一条
 *    `Meta → 99_Meta` 的别名就是它，用户拍过这条）—— 不动的是**来源**，不是目标。
 * ④ 目标目录**必须在骨架里、或已经存在**：否则不搬（列进「待定」）。理由与 `reconcile.ts`
 *    那条临场判断同源 —— 声明打错一个字就会在库里长出一个没人要的目录，而这里没有确认流兜着
 *    （Inbox 兜底是按路由表算的，用户看不见那个字符串）。
 *
 * ────────────────────────────────────────────────────────────────
 * 幂等的三条机制（§6）
 * ────────────────────────────────────────────────────────────────
 *  1. **状态判定短路**：目录已存在就不建；笔记已经在该在的位置就不排进计划
 *  2. **条目级识别「已搬过」**：目标同名同内容 → 跳过（`mover` 的 `already`）
 *  3. **撞名不同内容一律 blocked**：绝不覆盖（`mover` 的 `blocked`）
 *  ⇒ **再点一次执行 = 原地重排一遍，结果相同**（不会产生第二个库根；旧实现那段"取库根名1"
 *    已明确否掉，见 `排查报告.md` #8）
 */
import { TFile, type App } from 'obsidian';
import { isInside, joinPath, parentDir, relativeTo } from '../core/paths';
import type { NoteEntry } from '../core/vault-index';
import { skeletonPresets, type SkeletonPreset } from '../core/config-files';
import { isExcluded } from './reconcile';
import { ROOT_POS, asString, declaredPositions, isPositionLocked } from './schema';
import type { FrontmatterService } from './frontmatter';
import type { Mover, MoveResult, MoveTarget } from './mover';
import type { NoticeAction } from '../ui/notify';

// ────────────────────────────────────────────────────────────────
// 骨架（`库结构.json`）
// ────────────────────────────────────────────────────────────────
export interface Skeleton {
  version: number;
  /**
   * 骨架**写入时的**预设标记（P7.2b）：`basic` / `full` / `custom`。
   * ⚠️ 它只是"上次选的那一档"的记号 —— **显示用 `presetOfSkeleton()` 对表算**
   * （手改过清单的文件即使标着 `full`，对表也会得出 `custom`）。
   */
  preset: SkeletonPreset;
  /** 骨架说的库根名（与实际库根不符时面板会提示） */
  rootName: string;
  /** 目录（**相对库根**，如 `02_Areas/内容创作`），浅 → 深 */
  dirs: string[];
  /** 种子文件（**相对库根**）—— 骨架的中心页，重排不创建它们，只报"在不在" */
  seedFiles: string[];
  /** 顶层排除项（整条不参与；`.开头` 是特例 token，见 `isExcluded`） */
  excludedTop: string[];
  /** 顶层保留项（在库里但不在骨架里，**只显示为「保留」**，不参与重排） */
  keepTop: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === 'string' && v ? [str(v)] : [];

/** 去掉首尾斜杠、反斜杠归一、去掉 `./` 前缀与骨架自己带的库根前缀 */
function cleanRel(raw: string, rootName: string): string {
  let p = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  p = p.replace(/^\/+|\/+$/g, '');
  const root = rootName.replace(/^\/+|\/+$/g, '');
  if (root && isInside(p, root)) p = p.slice(root.length).replace(/^\/+/, '');
  return p;
}

function ancestorsOf(rel: string): string[] {
  const segs = rel.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < segs.length; i += 1) out.push(segs.slice(0, i).join('/'));
  return out;
}

/**
 * 把任意来源的对象收敛成合法骨架（**配置层规范**：手改过 / 旧版本 / 别的机器同步过来的
 * 脏值都在**这一处**收口）。
 *
 * ⚠️ **只加不删**：用户自己往 JSON 里加的目录一条都不许丢（骨架是库内数据，不是我们的默认值）；
 * 这里只做形状收敛 —— 类型、去重、剥库根前缀、补上隐含的父目录、排序。
 * 排除项之下的目录**不收**（它们在树里根本不出现）。
 */
export function normalizeSkeleton(raw: unknown): Skeleton {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rootName = cleanRel(str(src.rootName), '');
  const excludedTop = strList(src.excludedTop).map((p) => cleanRel(p, ''));

  const seen = new Set<string>();
  const dirs: string[] = [];
  const addDir = (d: string): void => {
    if (!d || seen.has(d)) return;
    if (isExcluded(d, excludedTop)) return;
    seen.add(d);
    dirs.push(d);
  };
  for (const raw0 of strList(src.dirs)) {
    const d = cleanRel(raw0, rootName);
    if (!d) continue;
    for (const a of ancestorsOf(d)) addDir(a); // 隐含的父目录（手加子目录时不用连着写父目录）
    addDir(d);
  }

  const seedFiles: string[] = [];
  const seedSeen = new Set<string>();
  for (const raw0 of strList(src.seedFiles)) {
    const f = cleanRel(raw0, rootName);
    if (!f || seedSeen.has(f) || isExcluded(f, excludedTop)) continue;
    seedSeen.add(f);
    seedFiles.push(f);
    for (const a of ancestorsOf(f)) addDir(a); // 种子文件的父目录也要在骨架里
  }

  // 浅 → 深，同层按字典序（面板的树与"先建父目录"都靠这个顺序）
  const byDepth = (a: string, b: string): number =>
    a.split('/').length - b.split('/').length || a.localeCompare(b);
  dirs.sort(byDepth);
  seedFiles.sort();

  return {
    version: typeof src.version === 'number' ? src.version : 1,
    // 只认三个值；没写 / 写了别的 → `custom`（对表显示在 `presetOfSkeleton`）
    preset: src.preset === 'basic' || src.preset === 'full' ? src.preset : 'custom',
    /**
     * P7.14：显式写 `"rootName": ""` = 声明"根就是 vault 根"（整个库模式）——
     * 别把 '' 顶回默认（**没写这个键**才是默认 `01_新知识库`；否则整个库用户没法表这个态，
     * 面板里的「库根名对不上」警告永远消不掉）。
     */
    rootName: 'rootName' in src ? rootName : '01_新知识库',
    dirs,
    seedFiles,
    excludedTop,
    keepTop: strList(src.keepTop).map((p) => cleanRel(p, '')),
  };
}

/**
 * 骨架**当前**属于哪一档预设（P7.2b 的显示口径）——**对表算，不看 `preset` 标记**：
 * dirs 与 seedFiles 与某一档清单**完全一致**（顺序无关）才认那一档，否则「自定义」。
 * 手改过 `库结构.json` 的目录（加一条 / 删一条）就自然落进 `custom` —— 这正是 G3-①
 * 「手改过目录就视为 custom」的实现，不需要另存一份"是否手改过"的状态。
 */
export function presetOfSkeleton(sk: Skeleton): SkeletonPreset {
  const P = skeletonPresets();
  const same = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
  };
  if (same(sk.dirs, P.basic.dirs) && same(sk.seedFiles, P.basic.seedFiles)) return 'basic';
  if (same(sk.dirs, P.full.dirs) && same(sk.seedFiles, P.full.seedFiles)) return 'full';
  return 'custom';
}

/**
 * 预设覆写（P7.2b）：切换预设 = **把 dirs/seedFiles 覆写成该预设的清单**，并把
 * `preset` 标记写进去 —— 清单唯一真源在 `core/config-files.ts` 的 `skeletonPresets()`。
 *
 * ⚠️ 它不是 `normalizeSkeleton` 的"只加不删"：那条是**收敛脏值**用的（手加的一条不许丢）；
 * 预设覆写是用户**显式改主意**（面板里先弹确认流再调这里）。覆写只换清单本身，
 * `rootName` / `excludedTop` / `keepTop` / `version` 原样保留（它们是这台库的环境事实）。
 */
export function withPreset(sk: Skeleton, preset: 'basic' | 'full'): Skeleton {
  const list = skeletonPresets()[preset];
  return normalizeSkeleton({
    ...sk,
    preset,
    dirs: [...list.dirs],
    seedFiles: [...list.seedFiles],
  });
}

// ────────────────────────────────────────────────────────────────
// 计划
// ────────────────────────────────────────────────────────────────
/** 参与重排的笔记（调用方按"库根之内"过滤后再喂进来） */
export interface RebuildNote {
  /** 库内绝对路径 */
  path: string;
  basename: string;
  /** 实际目录（**相对库根**；直接躺在库根下时为 ''） */
  dir: string;
  /** 「文件位置」声明（**相对库根**） */
  declared: string[];
  /** `类型` 的值（兜底时用来跳过结构性笔记） */
  type: string;
  /**
   * 模板（basename 以 `T_` 开头，或在模板目录之下）。
   * **重排不碰模板** —— 与姊妹逻辑 `planReconcile` 的第一句（`if (e.isTemplate) continue`）同一条口径：
   * 模板的落点由模板库/功能定，不该被"兜底"当普通笔记搬走（`T_*.md` 落进 Inbox 是常见状态）。
   */
  isTemplate: boolean;
  locked: boolean;
}

export type MoveWhy = 'declared' | 'fallback' | 'collect';

export interface RebuildMove {
  /** 库内绝对路径（源） */
  path: string;
  from: string;
  to: string;
  /** 目标目录（相对库根）—— 树上那个「搬入 N」徽标按它归位 */
  dirRel: string;
  why: MoveWhy;
  /** 给人看的理由（确认流与报告里逐条列出） */
  note: string;
  /**
   * 这篇设了「位置锁定」。**重排照样搬它**（属性规范 §3.2：锁只挡后台自动行为，
   * 不挡你自己发起的动作 —— 重排是你在面板里点了确认的），但确认流要**说出来**
   *（`mover` 的 `lockNotice` 就是干这个的）。
   */
  locked: boolean;
}

/**
 * 「待定」的**机器可读分类**（P7.9 · ⑤）—— 给人看的那句 `why` 带具体路径，
 * 没法拿来分组；A2 的"0 可搬"播报要按类归并（`pendingLineOf`），所以留这个码。
 */
export type RebuildPendingCode =
  | 'excluded-declared'
  | 'missing-dir'
  | 'no-fallback'
  | 'fallback-excluded'
  | 'fallback-missing'
  | 'root-lying'
  | 'dup-name';

/**
 * 「原因 → 出路」两半（**唯一出处**）：判据 `why` 与 A2 的分组播报共用同一份措辞 ——
 * 两处各写一份会漂（P3/P5 栽过的形状）。
 * ⚠️ v2：「领域」相关的四条（no-area / no-route / route-excluded / route-missing）
 * 随领域退役合并删除；没有信号的 Inbox 笔记现在只差"兜底目录配没配/在不在"这几件事。
 */
const PENDING_TEXT: Record<RebuildPendingCode, { what: string; advice: string }> = {
  'excluded-declared': { what: '「文件位置」指向排除范围里的目录', advice: '改声明' },
  'missing-dir': { what: '「文件位置」指向不存在的目录', advice: '改声明，或先建那个目录' },
  'no-fallback': { what: '没有任何信号，又没配「兜底目录」', advice: '去「目录映射」里配一条兜底，或给它补个声明' },
  'fallback-excluded': { what: '「兜底目录」在排除范围里', advice: '改路由表，或给它补个声明' },
  'fallback-missing': { what: '「兜底目录」还不存在', advice: '先建那个目录，或改路由表' },
  'root-lying': { what: '直接躺在库根下、又没有「文件位置」声明', advice: '先给它选个目录' },
  'dup-name': { what: '几篇同名笔记抢同一个落点', advice: '不猜谁先谁后，先改个名' },
};

/** 单篇的 `why`（原因 → 出路；`specifics` 可以带具体路径/目录） */
function whyOf(code: RebuildPendingCode, specifics = ''): string {
  const t = PENDING_TEXT[code];
  return `${t.what}${specifics ? `：${specifics}` : ''} —— ${t.advice}`;
}

/** 分组播报的一行：`N 篇<原因> —— <出路>`（A2 的"N 篇还没搬"逐类列它） */
export function pendingLineOf(code: RebuildPendingCode, count: number): string {
  const t = PENDING_TEXT[code];
  return `${count} 篇${t.what} —— ${t.advice}`;
}

export interface RebuildPending {
  path: string;
  /** 相对库根的现状 */
  rel: string;
  why: string;
  /** 机器可读分类（分组播报用；`why` 照旧带具体路径） */
  code: RebuildPendingCode;
}

export interface RebuildPlanInput {
  skeleton: Skeleton;
  /**
   * **只处理这个目录下的笔记**（相对库根，如 `00_Inbox`；不传 = 全库）。
   *
   * 给「整理收件箱 → 一键自动整理」用（A2）：那件事**只管 Inbox 里那些**，
   * 顺手把全库都归位是另一种动作（那是重排面板的活，界面上说清范围与条数）。
   * ⚠️ 判据是"笔记现在**在哪**"，不是"它声明要去哪" —— 所以声明优先照搬，只是候选变窄。
   */
  scopeDir?: string | null;
  /** 库根（**库内绝对路径**，如 `01_新知识库`） */
  kbRoot: string;
  /** 元数据目录（相对库根，来自设置；默认 `99_Meta`） */
  metaDir: string;
  /** 库根下**已存在**的目录（相对库根；含 ''）—— 树上「新建 / 保留」徽标按它算 */
  existingDirs: Set<string>;
  /** 某个库内路径（**相对库根**）存在吗 —— 只用来判种子文件在不在 */
  exists: (rel: string) => boolean;
  notes: RebuildNote[];
  /** 兜底目录（路由表的「领域兜底」；没配就 null）—— 没有信号的 Inbox 笔记的唯一去处 */
  fallbackDir: string | null;
}

export interface RebuildPlan {
  skeleton: Skeleton;
  /** 新建目录（相对库根，**浅 → 深**） */
  newDirs: string[];
  /** 骨架里已有、保留的目录 */
  keptDirs: string[];
  /** 库里在、骨架没有的目录（**只加不删**：留着不动，树里标「保留」） */
  extraDirs: string[];
  moves: RebuildMove[];
  pending: RebuildPending[];
  /** 骨架声明了、库里没有的种子文件（**重排模式只报不建**；初始化/收拢补骨架时按开关填进 `newFiles`） */
  seedMissing: string[];
  seedPresent: string[];
  /**
   * **本次要新建的文件**（库内绝对路径 + 内容；P7.2b）—— 初始化模式 / 收拢补骨架时
   * 由面板按「创建种子页」「放示例数据」开关填（种子内容来自 `seedContentOf`）；
   * **重排模式恒为空**（维持 P5 的"只报不建"）。
   * 执行时原样喂给 `mover.extraFiles`（进快照 `newFiles` → 还原删得掉）。
   */
  newFiles?: { path: string; content: string }[];
  /**
   * **收拢时不参与的文件**（相对库根；P7.2b）：`99_Meta` / `excludedTop` / 既有的
   * `04_Archives/旧笔记-*` —— 只报数不吵人（§6.2「被跳过的要说出来」）。
   * 只有收拢档会填；纯重排档与初始化档恒为 `undefined`。
   */
  collectSkipped?: string[];
  /** 没有声明、又不在 Inbox（按判据②不动）——只报数，不当「待定」吵人 */
  undeclared: string[];
  /** 骨架说的库根名与实际不符（配置没跟着库搬过） */
  rootMismatch: { declared: string; actual: string } | null;
}

/**
 * 结构性笔记：它们的功能位置就是所在目录（`_收件箱.md` 就住 Inbox）——
 * 兜底分支一直跳它们；**P7.9 起「一键自动整理」整条链也不让它们参与**
 *（过滤在 `modules/home/tidy.ts`：既不进计划、也不进 pending）。
 * ⚠️ v2：值域收拢后「中心页 / MOC」→ `索引`（P7.12）。
 */
export const STRUCTURAL_TYPES = new Set(['索引', '指南', '规范']);

/**
 * 索引里的笔记 → 规划器的输入（**唯一一份**：重排面板与首页「一键自动整理」共用）。
 * ⚠️ `dir` 用 `effectivePosition`（"实际在哪"），`declared` 用 `文件位置`（"声明要去哪"）——
 * 这两个口径混了就会把"已经有声明"的笔记当成"没声明"再兜底搬一次。
 */
export function rebuildNotesOf(entries: NoteEntry[], kbRoot: string): RebuildNote[] {
  const out: RebuildNote[] = [];
  for (const e of entries) {
    // 不在库根之下的（理论上不该有）不参与
    // ⚠️ P7.14：走 isInside + relativeTo —— kbRoot=''（整个库）下手拼前缀会恒 false，
    // 会让重排/收拢/建议的输入集**整片空掉**。
    if (!isInside(e.path, kbRoot) || e.path === kbRoot) continue;
    const rel = relativeTo(e.path, kbRoot);
    if (!rel) continue;
    out.push({
      path: e.path,
      basename: e.basename,
      dir: e.effectivePosition,
      declared: declaredPositions(e.props),
      type: asString(e.props['类型']),
      isTemplate: e.isTemplate,
      locked: isPositionLocked(e.props),
    });
  }
  return out;
}

/**
 * **把库现在的样子当作骨架**（A2「一键自动整理」用）。
 *
 * 效果是一条：**一个目录都不新建** —— `skeleton.dirs` 与 `existingDirs` 同源，
 * 于是 `newDirs` 恒为空、`dirOk()` 退化成"这个目录库里已经有了"。
 * 这正是那条老口径：自动动作**不替用户建目录**（一个错字就在库里长出没人要的目录），
 * 落点不存在的笔记会进 `pending` 并写明原因。
 *
 * 为什么复用 `planRebuild` 而不另写一个规划器：**声明优先 / 兜底只在 `00_Inbox` /
 * 两篇撞名都不搬**这三条判据只能有一份（P3 与 P5 都栽在"两处各写一份、慢慢漂"）。
 */
export function shapeAsSkeleton(dirs: Set<string>, excludedTop: string[] = []): Skeleton {
  return {
    version: 0,
    // 现状即骨架：与两档预设清单对不上 → custom（它本来就不是"某一档"）
    preset: 'custom',
    rootName: '',
    dirs: Array.from(dirs)
      .filter((d) => d !== '' && !isExcluded(d, excludedTop))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
    seedFiles: [],
    excludedTop,
    keepTop: [],
  };
}

/**
 * 算出这次重排"会发生什么"（**只读**：不碰文件、不建目录）。
 * 反复调用结果一致 —— 这就是「生成预览（只读，可反复点）」的实现。
 */
export function planRebuild(input: RebuildPlanInput): RebuildPlan {
  const { skeleton, kbRoot, metaDir, existingDirs, fallbackDir } = input;
  const skeletonDirs = new Set(skeleton.dirs);

  // ── 目录：新建 / 保留 / 骨架外的 ──────────────────────────────
  const newDirs = skeleton.dirs.filter((d) => !existingDirs.has(d));
  const keptDirs = skeleton.dirs.filter((d) => existingDirs.has(d));
  const extraDirs = Array.from(existingDirs)
    .filter((d) => d !== '' && !skeletonDirs.has(d) && !isExcluded(d, skeleton.excludedTop))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  // ── 种子文件 ─────────────────────────────────────────────────
  const seedPresent: string[] = [];
  const seedMissing: string[] = [];
  for (const s of skeleton.seedFiles) (input.exists(s) ? seedPresent : seedMissing).push(s);

  const seedSet = new Set(skeleton.seedFiles);
  const metaPrefix = `${metaDir.replace(/^\/+|\/+$/g, '')}/`;

  const candidates: RebuildMove[] = [];
  const pending: RebuildPending[] = [];
  const undeclared: string[] = [];

  /** 目标目录能不能落：骨架里有、或库里已经有（判据④） */
  const dirOk = (rel: string): boolean =>
    rel === '' || skeletonDirs.has(rel) || existingDirs.has(rel);

  const pushMove = (note: RebuildNote, dirRel: string, why: MoveWhy, noteWhy: string): void => {
    candidates.push({
      path: note.path,
      from: note.path,
      to: joinPath(kbRoot, joinPath(dirRel, `${note.basename}.md`)),
      dirRel,
      why,
      note: noteWhy,
      locked: note.locked,
    });
  };

  const scope = (input.scopeDir ?? '').replace(/^\/+|\/+$/g, '');
  const inScope = (dir: string): boolean =>
    !scope || dir === scope || dir.startsWith(`${scope}/`);

  for (const note of input.notes) {
    const rel = relativeTo(note.path, kbRoot);
    if (rel.startsWith(metaPrefix)) continue; // 判据③：工具区里的文件一律不动
    if (!inScope(note.dir)) continue; // ⓿ 限定了范围就只看范围内的（A2）

    if (note.isTemplate) continue; // 模板不动（与 reconcile 同口径）

    // ① 声明优先
    if (note.declared.length > 0) {
      if (note.declared.includes(note.dir)) continue; // 声明里有一个就是它现在的位置 → 不动
      const want = note.declared[0];
      if (isExcluded(want, skeleton.excludedTop)) {
        pending.push({ path: note.path, rel, code: 'excluded-declared', why: whyOf('excluded-declared', want) });
        continue;
      }
      if (!dirOk(want)) {
        pending.push({
          path: note.path,
          rel,
          code: 'missing-dir',
          why: whyOf('missing-dir', want),
        });
        continue;
      }
      pushMove(note, want, 'declared', `声明：${want}`);
      continue;
    }

    // ② 兜底 —— **只在 00_Inbox**（v2：没有信号的 Inbox 笔记去「兜底目录」；
    //    带信号的由 suggest.ts 的启发层先接走，它们 prio 高于兜底档）
    if (note.dir !== '00_Inbox') {
      if (note.dir === '') {
        // 直接躺在库根下：不是任何目录的成员 —— 这本来就该有人看一眼，别混进"没声明"的计数里
        pending.push({
          path: note.path,
          rel,
          code: 'root-lying',
          why: whyOf('root-lying'),
        });
      } else {
        undeclared.push(rel);
      }
      continue;
    }
    if (seedSet.has(rel) || STRUCTURAL_TYPES.has(note.type)) continue; // 结构性笔记不兜底
    const want = fallbackDir;
    if (!want) {
      pending.push({ path: note.path, rel, code: 'no-fallback', why: whyOf('no-fallback') });
      continue;
    }
    if (want === note.dir) continue; // 兜底就指向 Inbox → 本来就在
    if (isExcluded(want, skeleton.excludedTop)) {
      pending.push({ path: note.path, rel, code: 'fallback-excluded', why: whyOf('fallback-excluded', want) });
      continue;
    }
    if (!dirOk(want)) {
      pending.push({ path: note.path, rel, code: 'fallback-missing', why: whyOf('fallback-missing', want) });
      continue;
    }
    pushMove(note, want, 'fallback', `没有信号 → 兜底目录 ${want}`);
  }

  const rootMismatch =
    skeleton.rootName &&
    skeleton.rootName !== kbRoot &&
    /**
     * P7.14：整个库模式（kbRoot=''）下，**默认名「01_新知识库」不算声明** ——
     * 它只是没写 rootName 时的兜底标签；真想让面板安静，把 库结构.json 的 rootName
     * 显式写成 `""`（= 根就是 vault 根，见 normalizeSkeleton 的那条注释）。
     */
    !(skeleton.rootName === '01_新知识库' && kbRoot === '')
      ? { declared: skeleton.rootName, actual: kbRoot }
      : null;

  // ── 同一批里两篇同名笔记抢同一个落点：**两篇都不搬**，列「待定」 ──
  // 不猜谁先谁后（猜错了就是把 A 覆盖成 B 的那种事故的温床）；
  // 它们执行时本来也会被 `mover` 判成 collision —— 这里提前说清楚，别让它变成一行"跳过"。
  const moves: RebuildMove[] = [];
  const byTo = new Map<string, RebuildMove[]>();
  for (const m of candidates) byTo.set(m.to, [...(byTo.get(m.to) ?? []), m]);
  for (const [to, list] of byTo) {
    if (list.length === 1) {
      moves.push(list[0]);
      continue;
    }
    for (const m of list) {
      pending.push({
        path: m.path,
        rel: relativeTo(m.path, kbRoot),
        code: 'dup-name',
        why:
          `有 ${list.length} 篇同名笔记都要搬到 ${relativeTo(to, kbRoot)}` +
          `（${list.map((x) => relativeTo(x.from, kbRoot)).join(' / ')}）—— 不猜谁先谁后，先改个名`,
      });
    }
  }

  return {
    skeleton,
    newDirs,
    keptDirs,
    extraDirs,
    moves,
    pending,
    seedMissing,
    seedPresent,
    undeclared,
    rootMismatch,
  };
}

// ────────────────────────────────────────────────────────────────
// 收拢（P7.2b · 16.1）：非空库 → 旧笔记按原相对路径归进归集夹
// ────────────────────────────────────────────────────────────────

/** 归集夹的父目录（G3-② 拍板：不打扰顶层、天然被归档语义收容） */
export const COLLECT_PARENT = '04_Archives';
/** 归集夹名前缀（日期接在后头：`旧笔记-20261004`） */
export const COLLECT_PREFIX = '旧笔记-';

/** 归集夹（**相对库根**）——面板 / 探针 / 用例共用这一处拼法，别各自抄 */
export function collectDirOf(date: string): string {
  return `${COLLECT_PARENT}/${COLLECT_PREFIX}${date}`;
}

export interface CollectPlanInput {
  kbRoot: string;
  /** 库根下**全部文件**（相对库根）—— `vaultShapeOf().files`（整库枚举，不是索引里的笔记） */
  files: Set<string>;
  /** 元数据目录（**相对库根**）—— 工具区整棵不动（`库结构.json` / 操作日志都在里头） */
  metaDir: string;
  excludedTop: string[];
  /** 归集夹（**相对库根**，`collectDirOf(日期)`） */
  collectDir: string;
}

export interface CollectPlan {
  /** 归集夹（相对库根） */
  dirRel: string;
  moves: RebuildMove[];
  /** 归集夹下要建的目录（相对库根，浅 → 深）—— 归入计划的 `newDirs` */
  newDirs: string[];
  /** 排除范围内没搬的（99_Meta / excludedTop / 既有的旧笔记-*）—— 只报数，不吵 */
  skipped: string[];
}

/**
 * 收拢计划：**库根下全部文件（`.md` 与附件都搬）按原相对路径**搬进
 * `<collectDir>/<原相对路径>` —— 保留原目录关系，双链 / 嵌入由平台跟着改、不丢。
 *
 * 不收集的（跳过并报数）：
 *  · `metaDir`（工具区：模板 / 日志 / 配置 —— 搬它等于把 `库结构.json` 自己搬走）；
 *  · `excludedTop`（历史副本等，本来就不属于这个库的活跃内容）；
 *  · **既有的 `04_Archives/旧笔记-*`**（幂等：收拢过的档案不再次套娃 —— 隔天再跑
 *    不会把前一天的归集夹再套进今天的）。
 *
 * 一次 `mover` 调用 = 一个快照 = 一个撤销句柄（调用方负责）；**不删任何目录 / 文件**。
 * 撞名判定交给 `detectCollisions`（与重排同源：同名同内容「已搬过」、不同「真冲突」）。
 */
export function planCollect(input: CollectPlanInput): CollectPlan {
  const dirRel = input.collectDir.replace(/^\/+|\/+$/g, '');
  const metaDir = input.metaDir.replace(/^\/+|\/+$/g, '');
  const metaPrefix = `${metaDir}/`;
  const moves: RebuildMove[] = [];
  const skipped: string[] = [];
  const newDirs = new Set<string>([dirRel]);

  const rels = Array.from(input.files).sort(); // 确定性：同一份库 → 同一份计划（预览可反复点）
  for (const rel of rels) {
    if (!rel) continue;
    if (metaDir && (rel === metaDir || rel.startsWith(metaPrefix))) {
      skipped.push(rel);
      continue;
    }
    if (isExcluded(rel, input.excludedTop)) {
      skipped.push(rel);
      continue;
    }
    const segs = rel.split('/');
    if (segs[0] === COLLECT_PARENT && (segs[1] ?? '').startsWith(COLLECT_PREFIX)) {
      skipped.push(rel);
      continue;
    }
    const target = `${dirRel}/${rel}`;
    const targetDir = parentDir(target);
    // 归集夹自身的层级也进"要建"清单（树徽标 / 快照 newDirs / 还原删空目录都靠它）
    let d = targetDir;
    while (d && (d === dirRel || d.startsWith(`${dirRel}/`))) {
      newDirs.add(d);
      const up = parentDir(d);
      if (!up || up === d) break;
      d = up;
    }
    moves.push({
      path: joinPath(input.kbRoot, rel),
      from: joinPath(input.kbRoot, rel),
      to: joinPath(input.kbRoot, target),
      dirRel: targetDir,
      why: 'collect',
      note: `收拢：${rel} → ${target}`,
      locked: false,
    });
  }
  const sorted = Array.from(newDirs).sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
  return { dirRel, moves, newDirs: sorted, skipped };
}

// ────────────────────────────────────────────────────────────────
// 撞名自查（预览用；**只读**）
// ────────────────────────────────────────────────────────────────
export interface RebuildCollision {
  /** 源（库内绝对） */
  path: string;
  to: string;
  /** already = 目标同名同内容（重复执行的正常情况）· blocked = 内容不同（真冲突） */
  kind: 'already' | 'blocked';
  note: string;
}

/**
 * 预览阶段的撞名自查（执行时 `mover` 还会各自再判一次 —— 那是权威）。
 *
 * 为什么预览也要算：完成定义第 2/4 条要树上挂「撞名 N」徽标、报告里「已搬过」与
 * 「真冲突」分组 —— 这两个数**执行前**就得让人看见（否则确认流上写的"撞名 N"是空话）。
 * 判据与 `mover` 同源：**内容相同 = 已搬过，不同 = 真冲突**（不是按时间、不是按大小）。
 */
export async function detectCollisions(
  moves: RebuildMove[],
  io: { exists: (p: string) => boolean; read: (p: string) => Promise<string | null> },
): Promise<RebuildCollision[]> {
  const out: RebuildCollision[] = [];
  for (const m of moves) {
    if (!io.exists(m.to)) continue;
    let same = false;
    try {
      const [a, b] = await Promise.all([io.read(m.from), io.read(m.to)]);
      same = b != null && a === b;
    } catch {
      same = false;
    }
    out.push({
      path: m.path,
      to: m.to,
      kind: same ? 'already' : 'blocked',
      note: same ? '目标已有同名同内容的文件（上次搬过了）' : '目标已有同名文件，内容不同（未覆盖）',
    });
  }
  return out;
}

/**
 * 撞名按**目标目录（相对库根）**计数 —— 树上「撞名 N」徽标用；`already` 不算撞名（它是正常情况）。
 *
 * ⚠️ 目录要从 `moves[].dirRel` 取，**不能拿 `collision.to` 去 `parentDir`**：
 * `to` 是**库内绝对路径**（`01_新知识库/02_Areas/灵感杂记/x.md`），而树上的节点 rel 是
 * **相对库根**的 —— 直接比会一个徽标都不亮（P5 收尾离线用例抓到的，两边口径混了）。
 */
export function blockedByDir(
  collisions: RebuildCollision[],
  moves: RebuildMove[],
): Record<string, number> {
  const dirOf = new Map(moves.map((m) => [m.path, m.dirRel]));
  const out: Record<string, number> = {};
  for (const c of collisions) {
    if (c.kind !== 'blocked') continue;
    const dir = dirOf.get(c.path);
    if (dir === undefined) continue;
    out[dir] = (out[dir] ?? 0) + 1;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 树（面板左侧那棵真树，决策 17）
// ────────────────────────────────────────────────────────────────
export type NodeStatus = 'new' | 'keep' | 'extra';

export interface RebuildNode {
  /** 相对库根（根节点为 ''） */
  rel: string;
  name: string;
  status: NodeStatus;
  /** 搬进这个目录的（**不含**子目录的） */
  incoming: RebuildMove[];
  /** 这个目录里会撞名的篇数 */
  blocked: number;
  children: RebuildNode[];
}

/**
 * 由骨架 + 现状建树。**骨架里的目录与库里多出来的目录都在树上**
 * （多出来的标 `extra` = 「保留（不在骨架里）」）—— 只加不删必须看得见，
 * 否则用户会以为"重排会删掉这些目录"。
 */
export function buildTree(plan: RebuildPlan, collisions: RebuildCollision[] = []): RebuildNode {
  const blocked = blockedByDir(collisions, plan.moves);
  const incomingOf = new Map<string, RebuildMove[]>();
  for (const m of plan.moves) {
    const list = incomingOf.get(m.dirRel) ?? [];
    list.push(m);
    incomingOf.set(m.dirRel, list);
  }

  const root: RebuildNode = {
    rel: '',
    name: plan.skeleton.rootName || '',
    status: 'keep',
    incoming: incomingOf.get('') ?? [],
    blocked: blocked[''] ?? 0,
    children: [],
  };
  const byRel = new Map<string, RebuildNode>([['', root]]);
  const ensure = (rel: string): RebuildNode => {
    const found = byRel.get(rel);
    if (found) return found;
    const node: RebuildNode = {
      rel,
      name: rel.split('/').pop() ?? rel,
      status: plan.newDirs.includes(rel) ? 'new' : plan.extraDirs.includes(rel) ? 'extra' : 'keep',
      incoming: incomingOf.get(rel) ?? [],
      blocked: blocked[rel] ?? 0,
      children: [],
    };
    byRel.set(rel, node);
    const parent = ensure(parentDir(rel));
    parent.children.push(node);
    return node;
  };
  for (const d of plan.newDirs) ensure(d);
  for (const d of plan.keptDirs) ensure(d);
  for (const d of plan.extraDirs) ensure(d);
  // 搬进"骨架外但已存在"的目录（声明指向它）也要有节点
  for (const [rel] of incomingOf) ensure(rel);
  for (const node of byRel.values()) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
  }
  return root;
}

// ────────────────────────────────────────────────────────────────
// 摘要（面板与确认流共用一份文案来源）
// ────────────────────────────────────────────────────────────────
export interface PlanCounts {
  newDirs: number;
  moved: number;
  blocked: number;
  already: number;
  pending: number;
  extraDirs: number;
}

export function planCounts(plan: RebuildPlan, collisions: RebuildCollision[] = []): PlanCounts {
  return {
    newDirs: plan.newDirs.length,
    moved: plan.moves.length,
    blocked: collisions.filter((c) => c.kind === 'blocked').length,
    already: collisions.filter((c) => c.kind === 'already').length,
    pending: plan.pending.length,
    extraDirs: plan.extraDirs.length,
  };
}

/** 「新建 2 目录 · 搬入 4 篇 · 撞名 0 · 待定 1」（确认流标题与面板副标题共用） */
export function planSummary(plan: RebuildPlan, collisions: RebuildCollision[] = []): string {
  const c = planCounts(plan, collisions);
  const parts = [`新建 ${c.newDirs} 目录`, `搬入 ${c.moved} 篇`];
  if (c.blocked > 0) parts.push(`真冲突 ${c.blocked}`);
  if (c.already > 0) parts.push(`已搬过 ${c.already}`);
  if (c.pending > 0) parts.push(`待定 ${c.pending}`);
  if (c.extraDirs > 0) parts.push(`保留 ${c.extraDirs} 目录`);
  return parts.join(' · ');
}

// ────────────────────────────────────────────────────────────────
// 执行（**唯一动文件的地方**：一次 mover 调用 = 一轮一个快照）
// ────────────────────────────────────────────────────────────────
export interface RebuildDeps {
  app: App;
  /** 库根（**库内绝对路径**，如 `01_新知识库`）—— 见下面那条口径转换 */
  kbRoot: string;
  mover: Mover;
  fm: FrontmatterService;
}

export interface RebuildRun {
  /** `mover` 的原样结果（moved / already / blocked / skipped / touched / snapshotId） */
  result: MoveResult;
  /** 兜底搬的笔记里，顺带把「文件位置」写成新目录的篇数 */
  declaredWritten: number;
  /**
   * 执行时的提醒（不阻断已完成的搬动）：**计划里有、进 mover 之前就没了**的文件 ·
   * 属性跟随失败。⚠️ 它们必须说出来：日志里"计划搬 N 篇"与"已移动 M 篇"的差额
   * 得有人解释（§6.2：对不上的数字是这一类最危险的错）。
   */
  warnings: string[];
}

/**
 * 执行一次重排：**一次 `mover.move()`**（多目标）。
 *
 * 🔴 为什么是"一次调用"而不是"逐篇调用"：
 *   · `mover` **一次调用 = 一个快照 = 一个撤销句柄** —— 逐篇调会攒下 N 份快照，
 *     而"撤销这次重排"只能一份份来（撤销条只认最后一份）
 *   · 撞名分「已搬过 / 真冲突」的判定与快照在同一条链上（`mover` 内部），
 *     面板另算一遍就成了第二份实现
 *   · 用户拍的口径：**撞名逐篇跳过不中断，硬错误继续做完剩下的**（报告里分组列出），
 *     **快照失败则整批中止**（一个文件都不动）—— 正是 `mover` 既有语义
 *
 * 搬完之后：给**兜底搬**的笔记补一条「文件位置」声明（见下）。
 */
export async function executeRebuild(
  deps: RebuildDeps,
  plan: RebuildPlan,
  reason: string,
  /**
   * **调用方给那条 partial 通知再挂的动作**（P7.11 · #13：一键整理的
   * 「✦ AI 建议」要挂在 mover 弹的"部分搬成"通知上）—— 转手递给 `mover`，
   * 这一层不认识它是什么（`MoveRequest.extraActions`）。
   */
  extraActions?: NoticeAction[],
): Promise<RebuildRun> {
  const warnings: string[] = [];
  const { targets, dropped } = targetsOf(deps.app, plan.moves);
  if (dropped.length > 0) {
    warnings.push(
      `${dropped.length} 篇已不在原位，没搬：${listBrief(dropped.map((d) => d.from), 3)}`,
    );
  }
  const result = await deps.mover.move({
    targets,
    source: 'rebuild',
    reason,
    /**
     * 🔴 骨架里缺的目录**也由 mover 建**（`extraDirs`），不是面板自己 `mkdir`：
     * 它们要进这次快照的 `newDirs`，还原时才删得掉（否则库里留一副空骨架）。
     * 顺带一个结果：**一篇都不用搬、只是补目录**的那一版也是同一条链（一次快照、一份日志）。
     *
     * 🔴 **口径转换就在这一行**：`plan.newDirs` 是**相对库根**的（`02_Areas/生活健康`，
     * 与树/筛选/`文件位置` 同一口径），而 `mover` 要**库内绝对路径**
     *（`01_新知识库/02_Areas/生活健康`）——P3 就是在这儿栽过一次，把文件搬到了库根之外。
     * 忘了转的症状：mover 的 `missingAncestors` 以为整条链都不存在 →
     * **在 vault 根下建出一个 `02_Areas/`**（不在库根里、索引看不见），
     * 而"骨架补全了"这条判据照样红。
     */
    extraDirs: plan.newDirs.map((d) => joinPath(deps.kbRoot, d)),
    /**
     * **本次要新建的文件**（P7.2b：种子页 / 示例数据）—— 与目录同一条先例：
     * 不进 mover 就不进快照的 `newFiles`、还原时删不掉。空数组也无害（mover 会短路）。
     */
    extraFiles: plan.newFiles ?? [],
    /**
     * 重排特有的几行：目录/文件是这次的真产物（日志里不写就没人知道），
     * 「计划搬 N 篇」则是事后对账的基准 —— `mover` 的摘要是"实际搬了几篇"，
     * 两者并排才看得出"报告说 4 篇、实际搬了 30 篇"这类最危险的错。
     */
    extraRows: [
      plan.newDirs.length > 0
        ? { label: `新建目录 ${plan.newDirs.length} 个`, detail: listBrief(plan.newDirs) }
        : { label: '没有要新建的目录' },
      plan.newFiles && plan.newFiles.length > 0
        ? {
            label: `新建文件 ${plan.newFiles.length} 个`,
            detail: listBrief(plan.newFiles.map((f) => f.path)),
          }
        : null,
      { label: `计划搬 ${plan.moves.length} 篇`, detail: `本轮实际搬了几篇看上面的摘要` },
      plan.pending.length > 0
        ? { label: `待定 ${plan.pending.length} 篇（没搬）`, detail: listBrief(plan.pending.map((p) => p.rel)) }
        : null,
    ].filter((r): r is { label: string; detail?: string } => r != null),
    /**
     * **两条下游（重排面板 / 首页一键整理收件箱）都自己弹撤销条** → 纯成功的汇总
     * 不再由 mover 重复播（P7.0a 批 1⑦ 的第五处接线；独立审查 🔴1 抓的漏项）。
     * ⚠️ mover 的 `quietCovered` 只压"成功"支：partial（撞名/跳过）、"只建目录"
     *（`movedN === 0`，撤销条不出现）照旧弹——那两条正是需要有人说话的时候。
     */
    quiet: true,
    // 调用方给的附加动作（P7.11 · #13：一键整理的「✦ AI 建议」挂在 partial 那条上）
    extraActions,
  });

  /**
   * 搬完之后把「文件位置」写成新目录。**两类各有口径**：
   *  · `fallback`（兜底搬）：**一律写**（P5 原口径，当时叫 `area`）—— 它本来**没有声明**
   *    （是"没有信号 → 兜底目录"替它做的决定），不写下来这次决定就没留痕。
   *    ⚠️ **这里不许加"没声明就跳过"的守卫**（P7.2b 真栽过一次：给兜底档加了 declared
   *    判空跳过 → A2「一键整理」那篇没声明的 Inbox 笔记声明没留痕、全量套件当场红）——
   *    兜底档的语义就是"不留空"，mover 第 7 步那层"只跟已有声明"是**另一条路**
   *    （所有移动的通用属性跟随），别把两层的口径互相套用；
   *  · `collect`（收拢，P7.2b）：**每篇 `.md` 都写**（声明 == 收拢后实际位置）——
   *    这是「收拢后复跑重排应 0 搬动」的前提（旧声明指向骨架目录的笔记，不重写就会被
   *    "声明优先"再搬出去）；附件没有前言，天然跳过。
   * ⚠️ 只写**真搬成功**的那些；写的是**相对库根**的目录（属性规范的口径）。
   * ⚠️ 属性写失败绝不能反过来影响已完成的搬动（记 warning，不回滚）。
   *
   * 🔴 P7.6 把这段抽成 `writeDeclaredForMoved`（**唯一一份**）：整理建议面板的执行
   * 要"给没声明的被搬笔记补声明"，与这里同一条纪律 —— 不留第二份实现。
   */
  const byFrom = new Map(plan.moves.map((m) => [m.from, m]));
  const declaredWritten = await writeDeclaredForMoved(
    deps,
    result.moved,
    (done) => {
      const move = byFrom.get(done.from);
      if (!move || (move.why !== 'fallback' && move.why !== 'collect')) return null;
      if (move.why === 'collect' && !done.to.toLowerCase().endsWith('.md')) return null; // 附件没有前言
      return move.dirRel;
    },
    warnings,
  );

  return { result, declaredWritten, warnings };
}

/**
 * 搬完之后给「这次替它做的决定」补上「文件位置」= 新目录（**两类调用方共用**：
 * `executeRebuild` 的 area/collect 档 + P7.6 整理建议面板的"没声明被搬"档）。
 *
 * `dirRelOf` 决定每篇写什么（**相对库根**；`null` = 这篇不写 —— 口径在调用方）。
 * 写失败 / 守卫跳过**只进 warnings**，绝不反过来影响已完成的搬动（不回滚）。
 */
export async function writeDeclaredForMoved(
  deps: { app: App; fm: FrontmatterService },
  moved: { from: string; to: string }[],
  dirRelOf: (m: { from: string; to: string }) => string | null,
  warnings: string[] = [],
): Promise<number> {
  let written = 0;
  for (const done of moved) {
    const dirRel = dirRelOf(done);
    if (dirRel === null) continue;
    const file = deps.app.vault.getAbstractFileByPath(done.to);
    if (!file || !('stat' in file)) continue;
    try {
      /**
       * ⚠️ 落在**库根**时写 `.`（`ROOT_POS`）—— 独立审 🟢7 顺手扫到的 P7.15 同形漏网：
       * 旧写法写空数组，读侧 `declaredPositions` 得到空 → 被当成"从没声明过"，
       * 又落回「缺文件位置」候选（P7.15 独立审 🔴1 修的是 mover 那条，这条漏了）。
       */
      const wrote = await deps.fm.setMany(file as TFile, { 文件位置: [dirRel || ROOT_POS] });
      // 守卫跳过（前言里有嵌套映射）：不算写成功，如实进警告（独立审查 🟡1）
      if (wrote.skipped.length > 0) {
        warnings.push(`${done.to}：前言里有嵌套映射（${wrote.skipped.join('、')}），「文件位置」没写`);
      } else {
        written += 1;
      }
    } catch (e) {
      warnings.push(`${done.to}：写「文件位置」失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return written;
}

/**
 * 库根下的**现状**：有哪些目录、哪些路径。
 *
 * 🔴 走 `adapter.list` 递归，**不走 `getAllLoadedFiles()`**：
 * 后者是平台的**缓存树** —— 我们自己刚 `adapter.mkdir` 出来的目录不在里面
 *（真机要等目录监听那一拍，离线桩干脆永远不更新）。而"重排完再点一次预览"
 * 恰恰要看到"目录已经有了、不用再建"（幂等的一半），拿缓存树算就会一直说"新建 N 个目录"。
 * 顺带这条也让用例与真机走同一条路（桩的 `adapter.list` 是真的文件系统）。
 *
 * `.开头` 的目录整条不进（与 `main.ts` 的 `kbDirs()` 同一口径）。
 */
export async function vaultShapeOf(
  app: App,
  kbRoot: string,
): Promise<{ dirs: Set<string>; files: Set<string>; exists: (rel: string) => boolean }> {
  const dirs = new Set<string>(['']);
  const files = new Set<string>();
  const queue: string[] = [kbRoot];
  const seen = new Set<string>([kbRoot]);
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let listing: { files?: string[]; folders?: string[] };
    try {
      listing = await app.vault.adapter.list(dir);
    } catch {
      continue; // 目录不在/读不到：当它不存在，别把预览整个带崩
    }
    for (const f of listing.files ?? []) {
      const rel = relativeTo(f, kbRoot);
      if (rel && rel !== f) files.add(rel);
    }
    for (const sub of listing.folders ?? []) {
      const rel = relativeTo(sub, kbRoot);
      if (!rel || rel === sub) continue;
      if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
      dirs.add(rel);
      if (!seen.has(sub)) {
        seen.add(sub);
        queue.push(sub);
      }
    }
  }
  return { dirs, files, exists: (rel: string) => dirs.has(rel) || files.has(rel) };
}

/** 「a、b、c …（共 N 项）」—— 日志里别把 21 个目录全摊开 */
export function listBrief(items: string[], max = 5): string {
  if (items.length === 0) return '';
  const head = items.slice(0, max).join('、');
  return items.length > max ? `${head} …（共 ${items.length} 项）` : head;
}

/**
 * 按目标目录分组（`MoveTarget` 的形状就是这样：一个目录 + 一批文件）。
 *
 * ⚠️ 只认**真在库里**的那些（`getAbstractFileByPath`）—— 计划算出来到执行之间
 * 隔着一整个人工确认的时间窗口，文件可能已经被删/改名。少一篇不报错，
 * 它会在 `mover` 的 skipped（`notfound`）里出现 —— 别在这儿静默丢掉却不记。
 */
function targetsOf(
  app: App,
  moves: RebuildMove[],
): { targets: MoveTarget[]; dropped: RebuildMove[] } {
  const byDir = new Map<string, TFile[]>();
  const dropped: RebuildMove[] = [];
  for (const m of moves) {
    const f = app.vault.getAbstractFileByPath(m.from);
    if (!(f instanceof TFile)) {
      // 🔴 这里**必须记下来**：从"算计划"到"点确认"隔着一个人工窗口，文件可能被删/改名。
      // 只 `continue` 的话，日志里"计划搬 4 篇 / 已移动 3 篇"的差额**一行字都没有**，
      // 而这正是 §6.2 点名"最危险的错"的那类现象（原先的注释还宣称"它会在 mover 的 skipped 里出现"
      // —— 不会，这条筛选发生在 mover 之前）。
      dropped.push(m);
      continue;
    }
    const dir = parentDir(m.to);
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }
  return { targets: Array.from(byDir, ([dir, files]) => ({ dir, files })), dropped };
}
