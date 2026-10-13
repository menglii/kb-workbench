/**
 * services/suggest.ts —— 整理建议的**唯一形状 + 唯一流水线**（P7.6 · 11.1）
 *
 * 所有建议源（① 规则 / ② 学过往 / ③ AI / MOC 挂链）产出的都是这**一个形状**，
 * 过**同一份预检**、走**同一条确认流**、落**同一条既有写盘链**（mover / snapshot+vault.process）。
 *
 * ```
 * 建议源 → RawSuggestion → precheckItems() → finalize()（按优先级合并，每篇一条）
 *        → ui/suggest-panel.ts（逐条可勾）→ ui/confirm.ts → mover.move / vault.process
 * ```
 *
 * 三条纪律（设计对表 §1；完成定义③：形状的定义文件只有这一个，三个源都 import 它）：
 *   · **目录口径**：建议内部**一律"相对库根"**（`00_Inbox/x.md`、`02_Areas/内容创作`）——
 *     喂 `mover` 之前才在消费侧 `joinPath(kbRoot, …)`（坑/动库.md 那条栽过两次的红线）。
 *   · **只有「兜底」会被启发层盖掉**：`声明` 是 planRebuild 的既有判定（一个字不改），
 *     兜底是"没有任何信号"的最后一档，标签 / 学过往 / 文件名·内容 / AI 都比它强。
 *     （P7.10 · #10 起**「自动索引」挂链行也归兜底档** —— "有意识地改公共语义"，
 *      理由写在 `mocRuleRaw` 的 prio 注释里。）
 *   · **planRebuild 跑两遍**取"兜底档"的差（一遍带兜底、一遍 `fallbackDir:null`）——
 *     不抄第二份"声明优先 / 兜底"的判据（P3/P5 都栽在"两处各写一份、慢慢漂"）。
 *
 * ⚠️ v2（P7.12「领域退役」）：权威档从"声明 / 领域"缩成"声明"；关键词表从
 * "领域名 ∪ 目录末段名"变成"**别名段（路由表 `领域` 键）+ 目录末段名**"
 * —— 没有信号的 Inbox 笔记由 planRebuild 的兜底档统一去「兜底目录」。
 *
 * 🔴 **`reconcile.ts` 一个字不动**（自动归位的触发条件不许扩）：本文件只**import 它**的
 * `isExcluded`（纯谓词，同一份排除表口径），不反向被它依赖（redline 有静态断言钉着）。
 */
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { SettingsStore } from '../core/settings';
import { joinPath, relativeTo, stripExt } from '../core/paths';
import type { NoteEntry, VaultIndex } from '../core/vault-index';
import { isExcluded } from './reconcile';
import {
  planRebuild,
  rebuildNotesOf,
  shapeAsSkeleton,
  vaultShapeOf,
  type RebuildNote,
} from './rebuild';
import { aliasDirs as aliasDirsOf, fallbackDir as fallbackDirOf, readRouteTable, tagDirs as tagDirsOf } from './routes';
import type { MoveStats } from '../core/settings';
import { suggestLearned } from './suggest-learned';
import type { AiPlan } from './ai/plan';

/** 收件箱（相对库根）——与 `modules/home/tidy.ts` 的 `INBOX` 同值（那边是 home 层口径，服务层不反向依赖） */
export const INBOX_DIR = '00_Inbox';

// ────────────────────────────────────────────────────────────────
// §1 形状（**唯一出处**）
// ────────────────────────────────────────────────────────────────
export type SuggestKind = 'move' | 'moc';
export type SuggestSource = 'rule' | 'learned' | 'ai';

export interface SuggestItem {
  /** 稳定 id（勾选态 / 去重 / 判据都用它）：`<kind>:<path>` */
  id: string;
  kind: SuggestKind;
  source: SuggestSource;
  /** 要处理的笔记（**相对库根**） */
  path: string;
  /** move：落点目录；moc：节名（页面里 H2 的原文） */
  to: string;
  why: string;
  /** 佐证行（如「标签『内容创作』」『搬过 3 次』『AI：…』） */
  evidence?: string;
  /** 设了「位置锁定」（只显示；锁只挡后台自动动作 —— 与 tidy 同口径） */
  locked?: boolean;
  /** 仅 moc：目标页（相对库根） */
  page?: string;
}

/** 源与优先级（小者赢；**只有兜底会被盖** —— 见文件头） */
export const SUGGEST_PRIO = {
  declared: 20, // 声明（planRebuild 的权威判定）
  tag: 30, // 标签 → 路由表「标签」段
  learned: 40, // 学你过往的修正
  file: 50, // 文件名关键词
  content: 55, // 内容特征（首个 H1 行）
  ai: 60, // AI 分类 / AI 选节
  /**
   * 兜底档（最后一道；被上面任何一条盖掉）。两个用户：
   * · 兜底目录（没有信号的 Inbox 笔记的落点，`moveRaw`）；
   * · **「自动索引」挂链行**（`mocRuleRaw`）—— P7.10 · #10 拍板从 `tag` 档降到这里：
   *   「自动索引」本来就该是**兜底堆放**，之前它压着 AI 选节（30 < 60）出不了行，
   *   与"不硬塞自动索引"的承诺相反（详见 `mocRuleRaw` 的注释）。
   */
  fallback: 90,
} as const;

/** 带上优先级与来源的原始建议（进 precheck / finalize 的形态） */
export interface RawSuggestion extends SuggestItem {
  prio: number;
}

export type DropCode =
  | 'protected' // 03_AI指令集（硬拦，全源适用）
  | 'excluded' // 源或目标在排除表里
  | 'missing' // 笔记不在库里 / 是模板
  | 'no-dir' // 落点目录库里没有（不新建）
  | 'same-place' // 已经在那儿了
  | 'dup' // 同一篇有更高优先的建议（被盖掉）
  | 'out-of-scope' // 不在当前范围（收件箱范围时的库内他处）
  | 'moc-missing' // MOC 页/节不存在
  | 'moc-already'; // 已经在 MOC 里被链接过

export interface DroppedItem {
  path: string;
  to: string;
  code: DropCode;
  why: string;
}

// ────────────────────────────────────────────────────────────────
// §2 预检（共用一份）
// ────────────────────────────────────────────────────────────────
export interface PrecheckCtx {
  metaDir: string;
  exclude: string[];
  /** 当前范围（'' = 全库；`00_Inbox` = 收件箱） */
  scope: string;
  /** 库里真有的目录（相对库根，含 ''） */
  dirs: Set<string>;
  /** 笔记（相对库根）→ 索引条目（不在/是模板要拦） */
  noteOf: (rel: string) => Pick<NoteEntry, 'isTemplate'> & { dirRel: string } | undefined;
  /** `03_AI指令集`（相对库根；'' = 元数据目录没配出来 → 这道防线不存在的情形不合规，调用方一律传） */
  aiDirRel: string;
  /** MOC：页面里真实存在的 H2 节名 */
  mocSections?: Set<string>;
  /** MOC：这篇已被页面链接过吗 */
  mocLinked?: (rel: string) => boolean;
}

/** rel 在 dir 之下（含相等） */
function under(rel: string, dir: string): boolean {
  if (!dir) return true;
  return rel === dir || rel.startsWith(`${dir}/`);
}

export function precheckItems(
  raws: RawSuggestion[],
  ctx: PrecheckCtx,
): { items: RawSuggestion[]; dropped: DroppedItem[] } {
  const items: RawSuggestion[] = [];
  const dropped: DroppedItem[] = [];
  const drop = (r: RawSuggestion, code: DropCode, why: string): void => {
    dropped.push({ path: r.path, to: r.to, code, why });
  };

  for (const r of raws) {
    // ① 硬拦：源或目标碰 03_AI指令集（对**所有源**适用 —— 建议是机器产出的，不享"用户手拖"的豁免）
    if (ctx.aiDirRel && (under(r.path, ctx.aiDirRel) || (r.kind === 'move' && under(r.to, ctx.aiDirRel)))) {
      drop(r, 'protected', 'AI 指令集里的东西只能读、不能改（含搬进搬出）');
      continue;
    }
    // ② 源笔记必须在库里、且不是模板
    const note = ctx.noteOf(r.path);
    if (!note || note.isTemplate) {
      drop(r, 'missing', note ? '模板不参与整理' : '库里找不到这一篇');
      continue;
    }
    // ③ 排除表：源与目标都过（与自动归位同一口径；tidy 的注释："只过滤来源不过滤目标是栽过的坑"）
    if (isExcluded(r.path, ctx.exclude)) {
      drop(r, 'excluded', '这一篇在排除范围里（自动化设置的「排除」）');
      continue;
    }

    if (r.kind === 'move') {
      // ④ 落点必须是**库里真有的目录**（不新建 —— 一个错字会在库里长出没人要的目录）
      if (!ctx.dirs.has(r.to)) {
        drop(r, 'no-dir', `库里没有「${r.to || '库根'}」这个目录`);
        continue;
      }
      if (isExcluded(r.to, ctx.exclude)) {
        drop(r, 'excluded', `落点在排除范围里：${r.to}`);
        continue;
      }
      // ⑤ 已经在那儿了 = 假建议
      if (note.dirRel === r.to) {
        drop(r, 'same-place', '它已经在这个目录里了');
        continue;
      }
      // ⑥ 范围（收件箱范围时，AI 可能提了库内他处的笔记）
      if (ctx.scope && !under(note.dirRel, ctx.scope)) {
        drop(r, 'out-of-scope', `不在「${ctx.scope}」范围里`);
        continue;
      }
    } else {
      // moc：节必须真实存在；这篇不能已经挂过
      if (!ctx.mocSections || !ctx.mocSections.has(r.to)) {
        drop(r, 'moc-missing', `《知识地图》里没有「${r.to}」这一节`);
        continue;
      }
      if (ctx.mocLinked?.(r.path)) {
        drop(r, 'moc-already', '它已经被《知识地图》链接过了');
        continue;
      }
    }
    items.push(r);
  }
  return { items, dropped };
}

// ────────────────────────────────────────────────────────────────
// §3 合并（每篇每个 kind 只留一条：优先级高者先占）
// ────────────────────────────────────────────────────────────────
export function finalize(
  raws: RawSuggestion[],
  ctx: PrecheckCtx,
): { items: SuggestItem[]; dropped: DroppedItem[] } {
  const { items: legal, dropped } = precheckItems(raws, ctx);
  // 稳定排序：prio 小者在前；同 prio 按 source 名保证确定性
  const sorted = legal
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.prio - b.r.prio || (a.r.source < b.r.source ? -1 : a.r.source > b.r.source ? 1 : a.i - b.i))
    .map((x) => x.r);
  const byKey = new Map<string, SuggestItem>();
  for (const r of sorted) {
    const key = `${r.kind}:${r.path}`;
    if (byKey.has(key)) {
      dropped.push({ path: r.path, to: r.to, code: 'dup', why: '同一篇有更高优先的建议，这条被盖过' });
      continue;
    }
    byKey.set(key, {
      id: key,
      kind: r.kind,
      source: r.source,
      path: r.path,
      to: r.to,
      why: r.why,
      evidence: r.evidence,
      locked: r.locked,
      page: r.page,
    });
  }
  return { items: Array.from(byKey.values()), dropped };
}

// ────────────────────────────────────────────────────────────────
// §4 建议源 ①·规则（本地）
// ────────────────────────────────────────────────────────────────
/** 规则源要的全部输入（gather 出来之后，`ruleSuggestions` 是**纯函数**） */
export interface RuleInputs {
  kbRoot: string;
  metaDir: string;
  exclude: string[];
  scope: string;
  /** 库里真有的目录（相对库根，含 ''） */
  dirs: Set<string>;
  /** 库里真有的文件（相对库根） */
  files: Set<string>;
  notes: RebuildNote[];
  /** 路由表「别名段」的成品（关键词 → 落点目录） */
  aliasDirs: Record<string, string>;
  fallbackDir: string | null;
  tagDirs: Record<string, string>;
  /** 笔记（相对库根）→ 标签 */
  tagsOf: (rel: string) => string[];
  /** 笔记（相对库根）→ 正文开头几百字符（剥掉前言；内容特征层用）—— 读不到给 '' */
  headOf: (rel: string) => Promise<string>;
}

/**
 * **关键词表**（文件名 / 内容特征两层共用）：路由表「别名段」 ∪ 库内目录末段名
 * （去前导编号，如 `01_执行中 → 执行中`；长度 ≥2、非纯数字；排除表下的目录不进）。
 * 命中取**最长**关键词（"内容创作" 优先于 "内容"）。
 */
export function buildKeywordTable(inp: Pick<RuleInputs, 'aliasDirs' | 'dirs' | 'exclude'>): { kw: string; dir: string }[] {
  const byKw = new Map<string, string>();
  const put = (kw: string, dir: string): void => {
    const k = kw.trim();
    if (k.length < 2 || /^\d+$/.test(k)) return;
    if (!dir || isExcluded(dir, inp.exclude)) return; // 排除表下的落点不进词表（如 Meta → 99_Meta）
    if (!byKw.has(k)) byKw.set(k, dir);
  };
  for (const [kw, dir] of Object.entries(inp.aliasDirs)) put(kw, dir);
  for (const d of inp.dirs) {
    if (!d || isExcluded(d, inp.exclude)) continue;
    const leaf = d.split('/').pop() ?? '';
    put(leaf.replace(/^\d+[_-]?/, ''), d);
  }
  return Array.from(byKw, ([kw, dir]) => ({ kw, dir }));
}

/** 在文本里找最长的命中关键词（ASCII 部分大小写不敏感；中文原样） */
function bestKeyword(text: string, table: { kw: string; dir: string }[]): { kw: string; dir: string } | null {
  const lower = text.toLowerCase();
  let best: { kw: string; dir: string } | null = null;
  for (const t of table) {
    const needle = t.kw.toLowerCase();
    if (!lower.includes(needle)) continue;
    if (!best || t.kw.length > best.kw.length) best = t;
  }
  return best;
}

/**
 * 规则源（**纯函数**；唯一一处"planRebuild 跑两遍"）。
 * 产出顺序无所谓 —— `finalize` 按优先级合并；这里只管把候选都摆出来。
 */
export async function ruleSuggestions(inp: RuleInputs): Promise<RawSuggestion[]> {
  const skeleton = shapeAsSkeleton(inp.dirs, inp.exclude);
  const baseInput = {
    skeleton,
    kbRoot: inp.kbRoot,
    metaDir: inp.metaDir,
    existingDirs: inp.dirs,
    exists: (rel: string) => inp.files.has(rel) || inp.dirs.has(rel),
    notes: inp.notes,
    scopeDir: inp.scope || undefined,
  };
  // 第一遍：带兜底（= 今天「一键自动整理」的完整判定）
  const base = planRebuild({ ...baseInput, fallbackDir: inp.fallbackDir });
  // 第二遍：不带兜底 —— 两遍的差 = "兜底档"（哪几篇是没有任何信号、被兜底接住的）
  const noFallback = planRebuild({ ...baseInput, fallbackDir: null });
  const noFbPaths = new Set(noFallback.moves.map((m) => m.path));

  const out: RawSuggestion[] = [];
  const metaPrefix = `${inp.metaDir.replace(/^\/+|\/+$/g, '')}/`;

  // ── 权威档：声明（原样进建议）──
  for (const m of noFallback.moves) {
    out.push(moveRaw(m, SUGGEST_PRIO.declared, 'rule', inp.kbRoot));
  }

  // ── 启发层：给"权威档没接管、又不在排除表"的笔记做落点推测 ──
  //   候选 = scope 内、无声明、非模板、非工具区、非排除表、权威档没接管的笔记。
  //   ⚠️ 有声明的笔记不给启发（声明是用户意图；它的不匹配自有权威档/待定去说）。
  const heuristics = new Map<string, RawSuggestion>();
  const keywordTable = buildKeywordTable(inp);
  for (const n of inp.notes) {
    const rel = relativeTo(n.path, inp.kbRoot);
    if (n.isTemplate || n.declared.length > 0) continue;
    if (rel.startsWith(metaPrefix)) continue;
    if (isExcluded(rel, inp.exclude)) continue;
    if (noFbPaths.has(n.path)) continue;
    if (inp.scope && !under(n.dir, inp.scope)) continue;

    // 标签 → 路由表「标签」段（最强）
    let hit: RawSuggestion | null = null;
    for (const tag of inp.tagsOf(rel)) {
      const dir = inp.tagDirs[tag];
      if (!dir || dir === INBOX_DIR) continue;
      hit = {
        id: `move:${rel}`,
        kind: 'move',
        source: 'rule',
        path: rel,
        to: dir,
        why: `按标签「${tag}」归位`,
        evidence: `标签「${tag}」`,
        locked: n.locked,
        prio: SUGGEST_PRIO.tag,
      };
      break;
    }
    // 文件名关键词
    if (!hit) {
      const baseName = n.basename.replace(/\.[^.]+$/, '');
      const k = bestKeyword(baseName, keywordTable);
      if (k && k.dir !== INBOX_DIR) {
        hit = {
          id: `move:${rel}`,
          kind: 'move',
          source: 'rule',
          path: rel,
          to: k.dir,
          why: `文件名里提到「${k.kw}」`,
          evidence: `文件名含「${k.kw}」`,
          locked: n.locked,
          prio: SUGGEST_PRIO.file,
        };
      }
    }
    // 内容特征（首个 H1 行；读不到就跳过）
    if (!hit) {
      const head = await inp.headOf(rel);
      const h1 = head.split('\n').find((l) => l.trim().startsWith('# ')) ?? '';
      if (h1) {
        const k = bestKeyword(h1.replace(/^#\s*/, ''), keywordTable);
        if (k && k.dir !== INBOX_DIR) {
          hit = {
            id: `move:${rel}`,
            kind: 'move',
            source: 'rule',
            path: rel,
            to: k.dir,
            why: `正文标题里提到「${k.kw}」`,
            evidence: `标题含「${k.kw}」`,
            locked: n.locked,
            prio: SUGGEST_PRIO.content,
          };
        }
      }
    }
    if (hit) heuristics.set(n.path, hit);
  }

  // ── 兜底档：只给"权威档没管"的（被启发层盖掉的交给 finalize 去重，这里先都摆出来）──
  for (const m of base.moves) {
    if (noFbPaths.has(m.path)) continue;
    out.push(moveRaw(m, SUGGEST_PRIO.fallback, 'rule', inp.kbRoot, '（兜底）'));
  }
  out.push(...heuristics.values());
  return out;
}

function moveRaw(
  m: { path: string; dirRel: string; note: string; locked: boolean },
  prio: number,
  source: SuggestSource,
  kbRoot: string,
  suffix = '',
): RawSuggestion {
  const rel = relativeTo(m.path, kbRoot);
  return {
    id: `move:${rel}`,
    kind: 'move',
    source,
    path: rel,
    to: m.dirRel,
    why: m.note + suffix,
    evidence: suffix ? '没有任何信号 → 兜底目录' : undefined,
    locked: m.locked,
    prio,
  };
}

// ────────────────────────────────────────────────────────────────
// §4b 规则源的 gather（异步 → 纯输入）
// ────────────────────────────────────────────────────────────────
export interface SuggestDeps {
  app: App;
  settings: SettingsStore;
  index: VaultIndex;
}

/** 剥掉前言 + 取前 ~500 字符（内容特征层用） */
export function headOfText(text: string): string {
  const t = String(text ?? '');
  if (!t.startsWith('---')) return t.slice(0, 500);
  const end = t.indexOf('\n---', 3);
  if (end < 0) return t.slice(0, 500);
  const rest = t.slice(end + 4);
  const nl = rest.indexOf('\n');
  return (nl >= 0 ? rest.slice(nl + 1) : '').slice(0, 500);
}

/** 把库现状 / 路由表 / 笔记读成 `RuleInputs`（唯一的异步收集点） */
export async function gatherRuleInputs(
  deps: SuggestDeps,
  opts: { scope: string; exclude: string[] },
): Promise<RuleInputs> {
  const kbRoot = deps.settings.kbRoot();
  const metaDir = deps.settings.get().metaDir;
  const shape = await vaultShapeOf(deps.app, kbRoot);
  const routes = await readRouteTable(deps.app, deps.settings);
  const notes = rebuildNotesOf(deps.index.getAll(), kbRoot);
  const headCache = new Map<string, Promise<string>>();
  return {
    kbRoot,
    metaDir,
    exclude: opts.exclude,
    scope: opts.scope,
    dirs: shape.dirs,
    files: shape.files,
    notes,
    aliasDirs: aliasDirsOf(routes.table, kbRoot),
    fallbackDir: fallbackDirOf(routes.table, kbRoot),
    tagDirs: tagDirsOf(routes.table, kbRoot),
    tagsOf: (rel) => {
      const e = deps.index.get(joinPath(kbRoot, rel));
      const v = e?.props?.['tags'];
      if (v == null) return [];
      const list = Array.isArray(v) ? v : [v];
      return list.map((x) => String(x).trim()).filter((x) => x !== '');
    },
    headOf: (rel) => {
      const key = rel;
      let p = headCache.get(key);
      if (!p) {
        p = (async () => {
          const f = deps.app.vault.getAbstractFileByPath(joinPath(kbRoot, rel));
          if (!(f instanceof TFile)) return '';
          try {
            return headOfText(await deps.app.vault.cachedRead(f));
          } catch {
            return '';
          }
        })();
        headCache.set(key, p);
      }
      return p;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// §5 MOC 挂链（规则源 + AI 挑节的共用上下文）
// ────────────────────────────────────────────────────────────────
export const MOC_DIR = '04_索引与地图';
export const MOC_FILE = 'MOC_知识地图.md';
/** P7.2b 种子页约定的"自动索引"节（规则源的默认落点） */
export const MOC_AUTO_SECTION_HINT = '自动索引';

export interface MocCandidate {
  /** 相对库根 */
  pathRel: string;
  /** 库内绝对路径 */
  abs: string;
  basename: string;
  mtime: number;
}

export interface MocContext {
  /** 相对库根 */
  page: string;
  pageAbs: string;
  /** 页面里真实存在的 H2（原文，含 emoji 前缀） */
  sections: string[];
  /** 含「自动索引」的那一节（没有 → null，规则源不出 MOC 行） */
  autoSection: string | null;
  /** 还没被页面链接过的笔记（按 mtime 倒序） */
  candidates: MocCandidate[];
}

/** 解析页面里的 H2 节名（`## xxx`）——纯函数，可离线断言 */
export function parseSections(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * 在页面文本里把一行 bullet 插到目标节**末尾**（下一个 H2 之前 / 文末之前）。
 * **只加不删**：不动任何既有行；已有同一行（或同链接）→ `already` 幂等。
 * 返回 null = 这一节不在页里（执行期复核用）。
 */
export function insertMocBullet(
  text: string,
  section: string,
  bullet: string,
): { text: string; already: boolean } | null {
  const lines = String(text ?? '').split('\n');
  const target = `## ${section}`;
  const start = lines.findIndex((l) => l.trimEnd() === target);
  if (start < 0) return null;
  const linkPart = bullet.replace(/^-\s*/, '');
  if (lines.some((l) => l.includes(linkPart))) return { text, already: true };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // 插在"节内最后一个非空行"之后
  let anchor = start;
  for (let i = end - 1; i > start; i -= 1) {
    if (lines[i].trim() !== '') {
      anchor = i;
      break;
    }
  }
  const insertAt = anchor + 1;
  if (insertAt === end) {
    // 节是空的（标题下面直接就是下一个 H2 / 文末）：补一行空行再插
    lines.splice(anchor + 1, 0, '', bullet);
  } else {
    lines.splice(insertAt, 0, bullet);
  }
  // 紧跟标题的那些空行不动（既有排版）；只保证插入的这一行自成一段
  return { text: lines.join('\n'), already: false };
}

/**
 * MOC 追加的那一行（**唯一格式出处**）：`- [[库内绝对路径去扩展名]]` ——
 * 与页面既有的双链同格式（`templates.ts` 生成中心页双链也是这个切法；
 * `stripExt` 对"我们自己拼的已知路径"是正确的用法 —— 它不能碰用户手打的名字，见坑/动库.md）。
 */
export function mocBulletOf(absPath: string): string {
  return `- [[${stripExt(absPath)}]]`;
}

/** MOC 的收集（异步）：读页面、解析节、筛"未挂过"的候选 */
export async function gatherMoc(deps: SuggestDeps, exclude: string[]): Promise<MocContext | null> {
  const kbRoot = deps.settings.kbRoot();
  const metaDir = deps.settings.get().metaDir.replace(/^\/+|\/+$/g, '');
  const page = `${metaDir}/${MOC_DIR}/${MOC_FILE}`;
  const pageAbs = joinPath(kbRoot, page);
  const f = deps.app.vault.getAbstractFileByPath(pageAbs);
  if (!(f instanceof TFile)) return null;
  let text = '';
  try {
    text = await deps.app.vault.cachedRead(f);
  } catch {
    return null;
  }
  const sections = parseSections(text);
  const autoSection = sections.find((s) => s.includes(MOC_AUTO_SECTION_HINT)) ?? null;
  const resolved = deps.app.metadataCache.resolvedLinks ?? {};
  const linked = new Set(Object.keys(resolved[pageAbs] ?? {}));
  const metaPrefix = `${metaDir}/`;
  const notes = deps.index
    .notes()
    .filter((e) => {
      const rel = relativeTo(e.path, kbRoot);
      if (!rel || rel === e.path) return false;
      if (e.isTemplate) return false;
      if (rel.startsWith(metaPrefix)) return false;
      if (isExcluded(rel, exclude)) return false;
      if (linked.has(e.path)) return false;
      return true;
    })
    .sort((a, b) => b.mtime - a.mtime);
  return {
    page,
    pageAbs,
    sections,
    autoSection,
    candidates: notes.map((e) => ({
      pathRel: relativeTo(e.path, kbRoot),
      abs: e.path,
      basename: e.basename,
      mtime: e.mtime,
    })),
  };
}

/** 规则源的 MOC 行：候选 →「自动索引」节（没有那一节就一条都不出） */
export function mocRuleRaw(ctx: MocContext): RawSuggestion[] {
  if (!ctx.autoSection) return [];
  return ctx.candidates.map((c) => ({
    id: `moc:${c.pathRel}`,
    kind: 'moc' as const,
    source: 'rule' as const,
    path: c.pathRel,
    to: ctx.autoSection as string,
    why: `还没挂进《知识地图》`,
    evidence: `挂到「${ctx.autoSection}」节`,
    page: ctx.page,
    /**
     * 🔴 **`tag` 档 → `fallback` 档**（P7.10 · #10 拍板 —— 有意识的公共语义修改）。
     * 理由：「自动索引」是**兜底堆放**，不是"比 AI 更懂"的判定。原档位（30）压着
     * AI 选节（60）出不了行 —— 用户在《知识地图》里维护了自己的节时，
     * "让 AI 挑节"对同一篇**永远给不出建议**，与悬停承诺的
     * "从现有节里挑、不硬塞「自动索引」"直接相反（P7.9 真机回归的同族形状）。
     * 降档后：同篇有 AI 选节行 → AI 胜出；没有 → 这行照出（行为只在"两者都在"时分叉）。
     * ⚠️ 与它同档的兜底目录是 **move** 行，kind 不同不打架（`finalize` 按 `kind:path` 去重）。
     */
    prio: SUGGEST_PRIO.fallback,
  }));
}

// ────────────────────────────────────────────────────────────────
// §6 源②·学过往 与 源③·AI 的适配（把各自的产物收敛成 RawSuggestion）
// ────────────────────────────────────────────────────────────────
/** ②：纯适配（数据都从外面来 —— 便于离线断言） */
export function learnedRaw(
  stats: MoveStats,
  notes: { pathRel: string; dirRel: string; tags: string[]; locked?: boolean }[],
): RawSuggestion[] {
  const hits = suggestLearned(stats, notes);
  const infoOf = new Map(notes.map((n) => [n.pathRel, n]));
  const out: RawSuggestion[] = [];
  for (const h of hits) {
    if (h.to === INBOX_DIR) continue; // 往收件箱搬不是"整理"（三个启发源的统一口径）
    out.push({
      id: `move:${h.pathRel}`,
      kind: 'move',
      source: 'learned',
      path: h.pathRel,
      to: h.to,
      why: h.why,
      evidence: h.evidence,
      locked: infoOf.get(h.pathRel)?.locked,
      prio: SUGGEST_PRIO.learned,
    });
  }
  return out;
}

/**
 * ③：`buildAiPlan` 的产物（过了闸的）→ RawSuggestion；拦下的 → DroppedItem。
 * ⚠️ AI 已经过 `buildAiPlan` 那一道闸（protected / missing / no-dir / same-place / duplicate），
 * 这里只做**形状换算 + 面板口径的两条补充**（scope / 不进收件箱）——不重跑那套判据。
 */
export function aiPlanRaw(plan: AiPlan, opts: { scope: string; dirRelOf: (rel: string) => string | undefined }): {
  items: RawSuggestion[];
  dropped: DroppedItem[];
} {
  const items: RawSuggestion[] = [];
  const dropped: DroppedItem[] = [];
  for (const row of plan.rows) {
    if (row.dirRel === INBOX_DIR) {
      dropped.push({ path: row.rel, to: row.dirRel, code: 'same-place', why: '建议搬进收件箱 —— 那不是"整理"' });
      continue;
    }
    if (opts.scope) {
      const cur = opts.dirRelOf(row.rel);
      if (cur === undefined || !(cur === opts.scope || cur.startsWith(`${opts.scope}/`))) {
        dropped.push({ path: row.rel, to: row.dirRel, code: 'out-of-scope', why: `不在「${opts.scope}」范围里` });
        continue;
      }
    }
    items.push({
      id: `move:${row.rel}`,
      kind: 'move',
      source: 'ai',
      path: row.rel,
      to: row.dirRel,
      why: row.why.trim() !== '' ? row.why : 'AI 建议',
      evidence: 'AI 分类',
      prio: SUGGEST_PRIO.ai,
    });
  }
  for (const b of plan.blocked) {
    const code: DropCode =
      b.code === 'protected'
        ? 'protected'
        : b.code === 'duplicate'
          ? 'dup'
          : b.code === 'no-dir'
            ? 'no-dir'
            : b.code === 'same-place'
              ? 'same-place'
              : 'missing';
    dropped.push({ path: b.path, to: b.to, code, why: b.why });
  }
  return { items, dropped };
}

/** ③的 MOC 变体：AI 挑节（`{path, to=节名}` 的 ideas）——合法性仍由 precheck 复核 */
export function mocAiRaw(
  ideas: { path: string; to: string; why?: string }[],
  page: string,
): RawSuggestion[] {
  const out: RawSuggestion[] = [];
  for (const idea of ideas) {
    const path = String(idea?.path ?? '').trim();
    const to = String(idea?.to ?? '').trim();
    if (!path || !to) continue;
    out.push({
      id: `moc:${path}`,
      kind: 'moc',
      source: 'ai',
      path,
      to,
      why: String(idea?.why ?? '').trim() || 'AI 挑的节',
      evidence: 'AI 挑节',
      page,
      prio: SUGGEST_PRIO.ai,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// §6b 双链推荐（**只读**：不出确认流、没有任何写动作）
// ────────────────────────────────────────────────────────────────
export interface LinkPair {
  /** 相对库根 */
  a: string;
  b: string;
  /** 一行理由（「共同标签 2 · 共链 1」） */
  why: string;
  score: number;
}

/** 标题 bigram 相似度（CJK 友好；0–1） */
export function titleSimilarity(x: string, y: string): number {
  const bigrams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '');
    const out = new Set<string>();
    if (t.length < 2) {
      if (t) out.add(t);
      return out;
    }
    for (let i = 0; i + 2 <= t.length; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = bigrams(x);
  const B = bigrams(y);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 双链推荐（只读建议；设计对表 §2 并族 A）：
 * 得分 = 共链×3 + 共同标签×2 + 标题相似（×2 取整）；**已互链的不推**；
 * 两端都非模板、非 `中心页`（结构页连接一切，进来全是噪音）、不在工具区/排除表。
 * 按得分倒序取前 5 对。`n²/2` 的上限靠候选集截断（200 篇）护住。
 */
export function linkPairs(
  deps: SuggestDeps,
  exclude: string[],
  opts: { max?: number; minScore?: number; maxNotes?: number } = {},
): LinkPair[] {
  const max = opts.max ?? 5;
  const minScore = opts.minScore ?? 4;
  const kbRoot = deps.settings.kbRoot();
  const metaPrefix = `${deps.settings.get().metaDir.replace(/^\/+|\/+$/g, '')}/`;
  const cands = deps.index
    .notes()
    .filter((e) => {
      const rel = relativeTo(e.path, kbRoot);
      if (!rel || rel === e.path) return false;
      if (e.isTemplate || rel.startsWith(metaPrefix)) return false;
      if (isExcluded(rel, exclude)) return false;
      if (String(e.props?.['类型'] ?? '') === '中心页') return false;
      return true;
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, opts.maxNotes ?? 200);
  const resolved = deps.app.metadataCache.resolvedLinks ?? {};

  /** 邻接（出 + 入，都算"连着"） */
  const neighbors = new Map<string, Set<string>>();
  const addEdge = (x: string, y: string): void => {
    const s = neighbors.get(x) ?? new Set<string>();
    s.add(y);
    neighbors.set(x, s);
  };
  for (const [src, dests] of Object.entries(resolved)) {
    for (const dest of Object.keys(dests ?? {})) {
      addEdge(src, dest);
      addEdge(dest, src);
    }
  }
  const tagsOf = (abs: string): Set<string> => {
    const v = deps.index.get(abs)?.props?.['tags'];
    const list = v == null ? [] : Array.isArray(v) ? v : [v];
    return new Set(list.map((t) => String(t).trim()).filter((t) => t !== ''));
  };

  const pairs: LinkPair[] = [];
  for (let i = 0; i < cands.length; i += 1) {
    for (let j = i + 1; j < cands.length; j += 1) {
      const A = cands[i];
      const B = cands[j];
      // 已互链的不推（出边任一方向）
      if ((resolved[A.path]?.[B.path] ?? 0) > 0 || (resolved[B.path]?.[A.path] ?? 0) > 0) continue;
      const na = neighbors.get(A.path) ?? new Set<string>();
      const nb = neighbors.get(B.path) ?? new Set<string>();
      let shared = 0;
      for (const n of na) if (nb.has(n)) shared += 1;
      const ta = tagsOf(A.path);
      const tb = tagsOf(B.path);
      let sharedTags = 0;
      for (const t of ta) if (tb.has(t)) sharedTags += 1;
      const sim = titleSimilarity(
        A.basename.replace(/\.[^.]+$/, ''),
        B.basename.replace(/\.[^.]+$/, ''),
      );
      const score = shared * 3 + sharedTags * 2 + Math.round(sim * 2);
      if (score < minScore) continue;
      const whyBits: string[] = [];
      if (sharedTags > 0) whyBits.push(`共同标签 ${sharedTags}`);
      if (shared > 0) whyBits.push(`共链 ${shared}`);
      if (sim >= 0.5) whyBits.push('标题相近');
      pairs.push({
        a: relativeTo(A.path, kbRoot),
        b: relativeTo(B.path, kbRoot),
        why: whyBits.join(' · '),
        score,
      });
    }
  }
  pairs.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  return pairs.slice(0, max);
}

// ────────────────────────────────────────────────────────────────
// §7 装配（面板用的总入口：本地两源 + MOC 规则）
// ────────────────────────────────────────────────────────────────
export interface LocalSuggestions {
  moveItems: RawSuggestion[];
  mocItems: RawSuggestion[];
  learnedItems: RawSuggestion[];
  moc: MocContext | null;
  /** 预检 + 合并之后（本地部分） */
  finalized: { items: SuggestItem[]; dropped: DroppedItem[] };
  /** AI 那一路的 `buildAiPlan` 要的落点白名单（库内绝对路径，含库根） */
  dirsAbs: Set<string>;
  /** 预检上下文 —— 面板**接 AI 结果后重跑同一份预检**要靠它（口径只此一处） */
  pctx: PrecheckCtx;
}

/** 本地三件（规则 / 学过往 / MOC 规则）一次跑完 + 合并（**不含 AI** —— 它由面板按需触发） */
export async function generateLocal(
  deps: SuggestDeps,
  opts: { scope: string; exclude: string[]; stats: MoveStats },
): Promise<LocalSuggestions> {
  const inputs = await gatherRuleInputs(deps, { scope: opts.scope, exclude: opts.exclude });
  const moveItems = await ruleSuggestions(inputs);
  const moc = await gatherMoc(deps, opts.exclude);

  // 学过往：候选 = scope 内的笔记（跳过模板 / 工具区 / 排除表 / **有声明的**）
  const metaPrefix = `${inputs.metaDir.replace(/^\/+|\/+$/g, '')}/`;
  const learnedNotes = inputs.notes
    .filter((n) => {
      const rel = relativeTo(n.path, inputs.kbRoot);
      if (n.isTemplate || rel.startsWith(metaPrefix)) return false;
      if (isExcluded(rel, inputs.exclude)) return false;
      /**
       * 🔴 **有声明的笔记不猜**（独立审查 🟡3）：声明是用户明写的意图，
       * "学过往"不许在界面上直接推翻它（与规则层启发同一个守卫；声明真正不匹配的，
       * 由权威档/待定的既有口径来说）。注释原先就写着这条、代码漏了 —— 本次补上。
       */
      if (n.declared.length > 0) return false;
      if (inputs.scope && !under(n.dir, inputs.scope)) return false;
      return true;
    })
    .map((n) => ({
      pathRel: relativeTo(n.path, inputs.kbRoot),
      dirRel: n.dir,
      tags: inputs.tagsOf(relativeTo(n.path, inputs.kbRoot)),
      locked: n.locked,
    }));
  const learnedItems = learnedRaw(opts.stats, learnedNotes);

  const mocItems = moc ? mocRuleRaw(moc) : [];
  const aiDirRel = inputs.metaDir ? `${inputs.metaDir.replace(/^\/+|\/+$/g, '')}/03_AI指令集` : '';
  const pctx: PrecheckCtx = {
    metaDir: inputs.metaDir,
    exclude: inputs.exclude,
    scope: opts.scope,
    dirs: inputs.dirs,
    noteOf: (rel) => {
      const e = deps.index.get(joinPath(inputs.kbRoot, rel));
      if (!e) return undefined;
      return { isTemplate: e.isTemplate, dirRel: e.effectivePosition };
    },
    aiDirRel,
    mocSections: moc ? new Set(moc.sections) : undefined,
    mocLinked: moc
      ? (rel) => {
          const resolved = deps.app.metadataCache.resolvedLinks ?? {};
          return joinPath(inputs.kbRoot, rel) in (resolved[moc.pageAbs] ?? {});
        }
      : undefined,
  };
  const finalized = finalize([...moveItems, ...learnedItems, ...mocItems], pctx);

  const dirsAbs = new Set<string>();
  for (const d of inputs.dirs) dirsAbs.add(joinPath(inputs.kbRoot, d));

  return { moveItems, mocItems, learnedItems, moc, finalized, dirsAbs, pctx };
}
