/**
 * modules/board/sources.ts —— **四种数据源取数**（纯函数，喂 entries + 配置出板块树）
 *
 * 为什么不放在渲染里：这是这一期最容易出错的一环（排除、允许重复、收容所三件事
 * 互相咬），纯函数才能在离线用例里逐条钉住；真机只负责把结果画出来。
 *
 * 四种源（交互规格 §4.1）：
 *   · **文件夹**：该目录下的笔记（**递归** —— 不递归的话，归到子目录里的笔记会
 *     在看板上凭空消失）；有子目录时自动生成**子板块**（默认收起）
 *   · **标签**：`tags` 前言 + 正文 `#tag`（聚合口径与索引的 `tags()` 同源）
 *   · **属性值**：某属性的取值 —— **子板块 = 每个取值**，自动增删
 *   · **收容所**：查得到、但**没有被任何板块命中**的笔记；固定排最后
 *
 * 三条口径（都能在用例里断言）：
 *   ① **「排除」在数据源的命中结果上做减法**（§4.1）——判据复用
 *      `services/reconcile.ts` 的 `isExcluded`，路径前缀 / 任意一段前缀 / `.开头` 特例
 *   ② **`隐藏: true` 的笔记默认不进板块**，但要**计数**（板块头显示「已隐藏 N」徽标）；
 *      `view.showHidden` 打开后带 `is-hidden` 淡出回来（§8.1）
 *   ③ **「允许重复」关** = 一条笔记只进**第一个**命中的板块（收容所不算命中）
 */
import type { NoteEntry } from '../../core/vault-index';
import { isExcluded } from '../../services/reconcile';
import { asBool, asString, CORE_PROPS, PROP_ORDER } from '../../services/schema';
import { joinPath, relativeTo } from '../../core/paths';
import {
  effectiveSort,
  groupKey,
  type BoardConfig,
  type BoardSection,
  type SortSpec,
} from './config';

export interface BoardGroup {
  /** 折叠状态与手动顺序的键（`<板块id>` 或 `<板块id>::<子键>`） */
  key: string;
  sectionId: string;
  /** 子板块的父板块 id（顶级为 null） */
  parentId: string | null;
  title: string;
  sub: boolean;
  kind: BoardSection['kind'];
  /** 本组要画的卡片（已排序、已应用上限） */
  notes: NoteEntry[];
  /** **命中本组的全部路径**（未过「隐藏」与上限）——「允许重复」关时的登记用它 */
  matched: string[];
  /** 上限截断前的条数（板块头显示「N / M 条」） */
  total: number;
  /** 被上限截掉的条数 */
  limited: number;
  /** 被 `隐藏: true` 挡掉的条数（板块头徽标） */
  hidden: number;
  /** 本板块排除掉的条数（面板里给人看的一句） */
  excluded: number;
}

export interface PlanOptions {
  kbRoot: string;
  /** 取一篇笔记的标签（前言 + 正文）——由调用方注入，索引之外的来源也能用 */
  tagsOf?: (e: NoteEntry) => string[];
}

export function planBoard(
  entries: NoteEntry[],
  cfg: BoardConfig,
  opts: PlanOptions,
): BoardGroup[] {
  const notes = entries.filter((e) => !e.isTemplate);
  const out: BoardGroup[] = [];
  /** 已经被前一个板块拿走的路径（「允许重复」关时用） */
  const claimed = new Set<string>();
  let shelterSec: BoardSection | null = null;

  for (const sec of cfg.sections) {
    if (sec.kind === 'shelter') {
      shelterSec = sec; // 收容所固定排最后，先记下
      continue;
    }
    const groups = groupsFor(sec, notes, cfg, opts, claimed);
    for (const g of groups) {
      out.push(g);
      // ⚠️ 用 `matched` 而不是 `notes`：`notes` 已经被上限与「隐藏」筛过，
      // 拿它登记会让被截断/被隐藏的笔记**又能进下一个板块**（"允许重复"关就漏了）
      if (!cfg.view.allowDuplicate) for (const p of g.matched) claimed.add(p);
    }
  }

  if (cfg.view.shelter && shelterSec) {
    const rest = notes.filter((e) => !claimed.has(e.path) && !matchedAny(e, cfg, opts));
    const g = makeGroup(shelterSec, '', rest, cfg);
    out.push(g);
  }
  return out;
}

/** 收容所用：这条笔记有没有被任何一个非收容所板块命中（命中过就不算"没人要的"） */
function matchedAny(e: NoteEntry, cfg: BoardConfig, opts: PlanOptions): boolean {
  for (const sec of cfg.sections) {
    if (sec.kind === 'shelter') continue;
    if (hit(sec, e, opts)) return true;
  }
  return false;
}

/** 一个板块（含自动生成的子板块）→ 一组或多组 */
function groupsFor(
  sec: BoardSection,
  notes: NoteEntry[],
  cfg: BoardConfig,
  opts: PlanOptions,
  claimed: Set<string>,
): BoardGroup[] {
  const pool = notes.filter((e) => !claimed.has(e.path));
  const excludedCount = countExcluded(sec, pool, opts);
  if (sec.kind === 'prop') {
    /**
     * ⚠️ 属性值源的子板块是**顶级板块**（不是挂在某一行下面的子行）——
     * §4.1 的原话是"板块名 = 属性值，自动增删"：这个源**没有"父板块"那个东西**。
     * 早先按"子板块"发出去，`paintBoard` 的 `filter(g => !g.sub)` 会把它们整批丢掉
     * （界面上一片空白，用例才抓到）。
     */
    const values = new Map<string, NoteEntry[]>();
    /** 每个取值各被排除掉几条（同一个总数发给所有取值板块是个假数字，10b） */
    const excludedByValue = new Map<string, number>();
    for (const e of pool) {
      const v = asString(e.props[sec.value]);
      if (!v) continue; // 没有这个属性 = 不是这个属性的取值
      if (sec.exclude.length > 0 && isExcluded(relativeTo(e.path, opts.kbRoot), sec.exclude)) {
        excludedByValue.set(v, (excludedByValue.get(v) ?? 0) + 1);
        continue;
      }
      const list = values.get(v) ?? [];
      list.push(e);
      values.set(v, list);
    }
    const keys = Array.from(values.keys()).sort((a, b) => a.localeCompare(b, 'zh'));
    return keys.map((v) =>
      makeGroup(sec, v, values.get(v) ?? [], cfg, excludedByValue.get(v) ?? 0, true),
    );
  }

  const hitNotes = pool.filter((e) => hit(sec, e, opts));
  if (sec.kind === 'folder') {
    const subs = subDirsOf(sec.value, hitNotes, opts.kbRoot);
    const groups = [makeGroup(sec, '', hitNotes, cfg, excludedCount)];
    for (const sub of subs) {
      const subNotes = hitNotes.filter((e) =>
        inDir(e, joinPath(stripRoot(sec.value, opts.kbRoot), sub), opts.kbRoot),
      );
      groups.push(makeGroup(sec, sub, subNotes, cfg, excludedCount, false, true));
    }
    return groups;
  }
  return [makeGroup(sec, '', hitNotes, cfg, excludedCount)];
}

/** 单条命中判定（「排除」在**命中结果上做减法**，§4.1） */
function hit(sec: BoardSection, e: NoteEntry, opts: PlanOptions): boolean {
  if (!matches(sec, e, opts)) return false;
  return !isExcluded(relativeTo(e.path, opts.kbRoot), sec.exclude);
}

/** 「命中」的判据**不含排除** —— 「排除 N」那个计数要在它之上做减法（见 `countExcluded`） */
function matches(sec: BoardSection, e: NoteEntry, opts: PlanOptions): boolean {
  if (sec.kind === 'folder') return inDir(e, sec.value, opts.kbRoot);
  if (sec.kind === 'tag') return (opts.tagsOf ?? defaultTagsOf)(e).includes(sec.value);
  if (sec.kind === 'prop') return asString(e.props[sec.value]) !== '';
  return false;
}

function defaultTagsOf(e: NoteEntry): string[] {
  const v = e.props['tags'];
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return list.map((t) => String(t).replace(/^#/, ''));
}

/** 库内相对目录 → 该目录下的笔记（**递归**：归到子目录里的笔记不该在看板上消失） */
export function inDir(e: NoteEntry, dirRel: string, kbRoot: string): boolean {
  const dir = dirRel.replace(/^\/+|\/+$/g, '');
  const rel = relativeTo(e.path, kbRoot);
  if (!dir) return true; // 空目录 = 库根 = 全库
  return rel === dir || rel.startsWith(`${dir}/`);
}

function stripRoot(dirRel: string, kbRoot: string): string {
  void kbRoot;
  return dirRel.replace(/^\/+|\/+$/g, '');
}

/** 直接子目录里**真含笔记**的那些（空的子目录不生成子板块） */
function subDirsOf(dirRel: string, hitNotes: NoteEntry[], kbRoot: string): string[] {
  const base = stripRoot(dirRel, kbRoot);
  const prefix = base ? `${base}/` : '';
  const set = new Set<string>();
  for (const e of hitNotes) {
    const rel = relativeTo(e.path, kbRoot);
    const rest = prefix ? rel.slice(prefix.length) : rel;
    if (!rest.includes('/')) continue; // 直接在父目录里
    const sub = rest.split('/')[0];
    if (!sub) continue;
    set.add(sub);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
}

function makeGroup(
  sec: BoardSection,
  sub: string,
  notes: NoteEntry[],
  cfg: BoardConfig,
  excludedCount = 0,
  /** 属性值源：每个取值都是**顶级板块**（§4.1"板块名 = 属性值"） */
  topLevel = false,
  /** 文件夹源的子板块（缩进 + 竖参考线） */
  asSub = false,
): BoardGroup {
  const key = groupKey(sec.id, sub);
  const sort = effectiveSort(cfg, sec);
  const manual = cfg.view.manualOrder[key];
  const sorted = sortNotes(notes, sort, manual);
  // 「隐藏」的笔记：默认不进板块，但要计数（§8.3 的「已隐藏 N」徽标）
  const shown = cfg.view.showHidden ? sorted : sorted.filter((e) => !asBool(e.props['隐藏']));
  const hidden = sorted.length - shown.length;
  const total = shown.length;
  const limit = sec.limit;
  const limited = limit != null && total > limit ? total - limit : 0;
  const finalNotes = limit != null ? shown.slice(0, limit) : shown;
  return {
    key,
    sectionId: sec.id,
    parentId: asSub ? sec.id : null,
    title: sub || sec.name,
    sub: asSub && !topLevel,
    kind: sec.kind,
    notes: finalNotes,
    matched: sorted.map((e) => e.path),
    total,
    limited,
    hidden,
    excluded: excludedCount,
  };
}

/**
 * 本板块被「排除」挡掉几条（板块头徽标 + 面板的实时计数要用）。
 * ⚠️ 口径是"**本来该命中、被排除挡下**"的条数，不是"全库被排除的条数"——
 * 后者在 43 篇的小库上看着还行，一旦库里有一块大目录被排除，
 * 每个板块头都会挂一个与自己无关的大数字（独立审查 10b）。
 */
function countExcluded(sec: BoardSection, notes: NoteEntry[], opts: PlanOptions): number {
  if (sec.exclude.length === 0) return 0;
  let n = 0;
  for (const e of notes) {
    if (!matches(sec, e, opts)) continue;
    if (isExcluded(relativeTo(e.path, opts.kbRoot), sec.exclude)) n += 1;
  }
  return n;
}

// ────────────────────────────────────────────────────────────────
// 排序
// ────────────────────────────────────────────────────────────────
/**
 * 排序：`手动` → 顺序表；`名称` / `修改日期` / `大小` 是内建档；其余当属性名。
 * 顺序表里没有的条目**接在后面按名称排**（新拖进来的、后加的笔记不会消失）。
 */
export function sortNotes(
  notes: NoteEntry[],
  sort: SortSpec | null,
  manual: string[] | undefined,
): NoteEntry[] {
  const list = [...notes];
  const key = sort?.key ?? '名称';
  const dir = sort?.dir ?? 'asc';
  const sign = dir === 'desc' ? -1 : 1;
  if (key === '手动') {
    const order = manual ?? [];
    const at = new Map(order.map((p, i) => [p, i]));
    list.sort((a, b) => {
      const ia = at.has(a.path) ? (at.get(a.path) as number) : Number.MAX_SAFE_INTEGER;
      const ib = at.has(b.path) ? (at.get(b.path) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a.basename.localeCompare(b.basename, 'zh');
    });
    return list;
  }
  if (key === '名称') {
    list.sort((a, b) => sign * a.basename.localeCompare(b.basename, 'zh'));
    return list;
  }
  if (key === '修改日期') {
    list.sort((a, b) => sign * (a.mtime - b.mtime));
    return list;
  }
  if (key === '大小') {
    list.sort((a, b) => sign * (a.size - b.size));
    return list;
  }
  list.sort((a, b) => {
    const va = asString(a.props[key]);
    const vb = asString(b.props[key]);
    if (!va && !vb) return a.basename.localeCompare(b.basename, 'zh');
    if (!va) return 1; // 空值排最后（不随方向翻）
    if (!vb) return -1;
    return sign * va.localeCompare(vb, 'zh');
  });
  return list;
}

// ────────────────────────────────────────────────────────────────
// 显示属性（「显示属性多选」的默认值）
// ────────────────────────────────────────────────────────────────
/**
 * 还没选过时用哪几个属性：**库里真有的**属性里取前 5 个。
 * 顺序按 `PROP_ORDER`（与表格列同一套），核心五项与两个"元属性"不进默认档
 * （它们在看板上要么没意义、要么另有位置：状态/日期在卡片底部那行小字里）。
 * ⚠️ 这是对 §8.1「默认取前言前 5 个用户属性」的**落地口径**：按前言顺序取，
 * 换个文件就会变（同一个看板每次打开属性都不一样），所以按规范顺序取。
 */
export function defaultPropsFor(entries: NoteEntry[]): string[] {
  const present = new Set<string>();
  for (const e of entries) {
    if (e.isTemplate) continue;
    for (const k of Object.keys(e.props)) present.add(k);
  }
  const skip = new Set([...CORE_PROPS, '隐藏', '位置锁定', '文件位置']);
  const known = PROP_ORDER.filter((p) => present.has(p) && !skip.has(p));
  const custom = Array.from(present)
    .filter((p) => !PROP_ORDER.includes(p) && !skip.has(p))
    .sort((a, b) => a.localeCompare(b, 'zh'));
  return [...known, ...custom].slice(0, 5);
}

/** 数据源的候选值（面板里的下拉） */
export function sourceCandidates(
  kind: BoardSection['kind'],
  entries: NoteEntry[],
  opts: { dirs: string[]; tags: string[]; valuesOf: (prop: string) => string[]; props: string[] },
): string[] {
  if (kind === 'folder') return opts.dirs;
  if (kind === 'tag') return opts.tags;
  if (kind === 'prop') return opts.props;
  void entries;
  return [];
}
