/**
 * services/backfill.ts —— 存量笔记**一键补全**（`交互规格.md` §13）
 *
 * 入口两处（P7.17 · 用户第 1 条：把能力接到手边）：
 *   · **主入口 = 向导屏 2**：勾开「笔记自动化」→ 滑出询问卡（N = "会改到的"篇数，
 *     `planTodoCount` 现算）→ 「去补全」开面板（`ui/wizard.ts`）；
 *   · **次入口 = 设置 → 自动化 → 「一键补全存量笔记」**（命令面板固定 4 条，不加第 5 条），
 *     旁边有动态提示「当前 N 篇可补」。
 *
 * 两步：**扫描（只读，可反复点）→ 补全（确认流 → 快照 → 逐篇写）**。
 *
 * 硬约束（§13 原文 + P7.17 口径）：
 *   · **两分支**：剥掉前言后正文为空 → 套**整套模板**；
 *     有正文 → **只在开头补 YAML、结尾补双链，原有正文一个字符不动**
 *   · **只加不删**：已有属性不动、已有正文不动 → 所以补过之后再扫是 **0 篇**（幂等）；
 *     🔴 **P7.17 · #1 修洞**：有前言的那条路也**补缺键**（按行合并，六件缺哪补哪、
 *     已有键一个字节不动）—— 旧写法"有前言就一个字都不碰"已废（0-② 的主洞）
 *   · 🔴 **D1（P7.17 · 用户 2026-10-08 拍板）**：存量补齐**也写「文件位置」= 实际落点**
 *     （库根写 `.`）**+ `收藏: false`** —— 存量写齐六件，与新建路完全一致
 *     （旧口径"存量不写"已反转；两侧（扫描 `planBackfill` / 写盘面板 `fillFile`）必须同步，
 *     不一致会被"补完再扫 = 0"的幂等判据当场抓住）
 *
 * 与「新建补全」共用同一套判据（`templates.buildFillPlan`）—— 两处各写一份一定会漂。
 * **分档**（P7.17 合并矩阵 `YAML优化方案.md` §2）：可补 / 已合规 / 旧值待迁（指向迁移面板）/
 * 值认不出（覆盖候选）/ 坏前言跳过（逐篇列 + 去「修前言」）/ `文件位置` 异常（只报告 + 去首页待处理）。
 * 「旧值 / 认不出 / 建议值」的判定**只有一处出处**：`services/migrate.ts` 的
 * `legacyValueFix` / `isStatusDropValue` / `suggestValueFor`（映射表一个真源，别在这抄）。
 *
 * ⚠️ **范围**：库根之下，但**排除 `99_Meta`（含模板库）**——
 *   · `99_Meta/03_AI指令集/AI操作规范.md` 是红线文件（只有用户能改）
 *   · 操作日志、仪表盘、README 都是结构文件，不是"待补的知识笔记"
 *   （与 `CompletionService.inScope` 同一口径，改一处必须改另一处）
 */
import type { NoteEntry } from '../core/vault-index';
import { isInside, joinPath, relativeTo } from '../core/paths';
import {
  buildFillPlan,
  noteContext,
  pickTemplate,
  readTemplater,
  templateFiles,
  type FillPlan,
  type NoteContext,
} from './templates';
import { NOTE_TYPES, STATUSES, asString, declaredPositions, fragileKeys } from './schema';
import { isStatusDropValue, legacyValueFix, suggestValueFor } from './migrate';
/**
 * ⚠️ 唯一的 `services/ → core/context` 依赖，而且是 **type-only**（编译后整段消失，不会成环）。
 * 代价换来的是"向导与补全面板报同一个数"（见 `planBackfillOf` 的注释）。
 */
import type { WorkbenchContext } from '../core/context';

export interface BackfillItem {
  path: string;
  basename: string;
  /** 相对库根 */
  rel: string;
  /** 相对库根的所在目录 */
  folderRel: string;
  /** 套整套模板 / 只在两头补 */
  kind: 'template' | 'patch';
  /** patch 分支补什么（给人看的预览） */
  yaml: boolean;
  /**
   * 有前言那条路的**按行合并补了哪几个键**（P7.17 · #1；报告/预览说"补了：类型、…"用它）。
   * 空数组/undefined = 不是合并补键（或没有缺键）。
   */
  yamlAdded?: string[];
  /** 只补正文骨架（"有前言但正文是空的"那一种） */
  body: boolean;
  tail: boolean;
  /** 用的模板（库内绝对路径） */
  templatePath: string;
  /** 命中哪条规则（「文件夹规则：…」/「当前模板」） */
  rule: string;
  /** 求不到的占位符（原样留着，但要说出来） */
  unresolved: string[];
}

export interface BackfillSkip {
  path: string;
  why: string;
}

/** 覆盖区的一行（P7.17 · D2）：**一篇的一个键**，逐行勾选（默认全不勾） */
export interface BackfillCover {
  path: string;
  rel: string;
  basename: string;
  key: '类型' | '状态';
  from: string;
  to: string;
  /** 建议值来自哪：`map` = 迁移映射表（旧值档）· `guess` = 认不出 → 目录默认/惯例兜底 */
  via: 'map' | 'guess';
}

/** 「旧值待迁」一行（只报告：**不抢迁移面板的活**） */
export interface BackfillLegacy {
  path: string;
  rel: string;
  basename: string;
  key: '类型' | '状态';
  from: string;
  /** `''` = 迁移面板会**连键删**（待整理/持续更新）—— 覆盖模式不碰它 */
  to: string;
  why: string;
}

export interface BackfillPlan {
  /** 要动的那几篇（可补：无前言 / 缺键）—— "会改到的"的主体 */
  items: BackfillItem[];
  /** 看过了、但不用动的（已合规等）——原因都在 `why` 里 */
  skipped: BackfillSkip[];
  /**
   * **分档**（P7.17 合并矩阵 · §2 全表；报告与面板都按它说话）：
   *  · `fragile` 坏前言**整篇跳过**（逐篇列名 + 去「修前言」）；
   *  · `posIssues` `文件位置` 异常（指向不存在目录 / 与实际不一致）——只报告 + 去首页待处理；
   *  · `legacy` 旧值待迁（迁移映射认得出的，含"删键"档）—— 单列 "N 篇 → 去迁移面板"；
   *  · `coverage` 覆盖候选（**值认不出** + 旧值可换算的 value→value；D2 逐篇勾选）。
   */
  fragile: BackfillSkip[];
  posIssues: BackfillSkip[];
  legacy: BackfillLegacy[];
  coverage: BackfillCover[];
  scanned: number;
}

export interface BackfillInput {
  entries: NoteEntry[];
  kbRoot: string;
  metaRoot: string;
  templateDir: string;
  /** 模板正文（按库内绝对路径查；读不到就是 null） */
  templateTexts: Record<string, string | null>;
  /** 这个目录该用哪个模板（`templates.pickTemplate` 的结果，调用方已算好） */
  templateFor: (folderRel: string) => { path: string; rule: string };
  /** 组装占位符上下文（标题 / 目录 / 中心页 / MOC） */
  contextOf: (rel: string, basename: string) => NoteContext;
  /** 文件正文（库内绝对路径 → 文本；读不到给 null） */
  textOf: (path: string) => string | null;
  /** 文件创建时间（毫秒） */
  ctimeOf: (path: string) => number;
  /**
   * 某个**相对库根**的目录存在吗（「文件位置异常」分档用；不给就只报不一致那半。
   * 纯函数用例可不传 —— 那是"查不了"不是"不存在"）。
   */
  dirExists?: (rel: string) => boolean;
}

/** 「旧值待迁」的**篇数**（unique 路径 —— 报告里"N 篇有旧值待迁"用它） */
export function legacyNoteCount(plan: BackfillPlan): number {
  return new Set(plan.legacy.map((x) => x.path)).size;
}

/**
 * 「**会改到的**」篇数（P7.17 · §1.1 拍定口径：补 + 覆盖，**纯跳过的不计**、同一篇去重）——
 * 向导询问卡与设置里那条动态提示**共用这一个数**（"向导说 7 篇、点进去说 3 篇"的老账）。
 */
export function planTodoCount(plan: BackfillPlan): number {
  const s = new Set<string>();
  for (const it of plan.items) s.add(it.path);
  for (const c of plan.coverage) s.add(c.path);
  return s.size;
}

/** 在不在存量补全的范围内（**与 `CompletionService.inScope` 同一口径**） */
export function inBackfillScope(e: NoteEntry, input: Pick<BackfillInput, 'kbRoot' | 'metaRoot' | 'templateDir'>): boolean {
  if (e.isTemplate) return false;
  const p = e.path;
  /**
   * 🔴 **前缀判断走 `isInside`**（P7.14 的唯一谓词；P7.18 独立审 🔴2 修的）：
   * 手拼 `` `${dir}/` `` 在 `dir === ''`（「整个库」模式的 `kbRoot`）下**恒 false** ——
   * 整片扫描静默空掉（面板还报"没有可补/可清 ✅"的假绿）。上一版就是这么写的。
   */
  const inside = (dir: string): boolean => isInside(p, dir);
  if (!inside(input.kbRoot)) return false;
  if (input.metaRoot && inside(input.metaRoot)) return false;
  if (input.templateDir && inside(input.templateDir)) return false;
  if (p.split('/').some((seg) => seg.startsWith('.'))) return false;
  return true;
}

/**
 * 只读扫描 → 计划。**不改任何东西**（可以反复点）。
 * 幂等：补完再扫，`items` 就是空的 —— 完成定义就靠这一条。
 */
export function planBackfill(input: BackfillInput): BackfillPlan {
  const items: BackfillItem[] = [];
  const skipped: BackfillSkip[] = [];
  const fragile: BackfillSkip[] = [];
  const posIssues: BackfillSkip[] = [];
  const legacy: BackfillLegacy[] = [];
  const coverage: BackfillCover[] = [];
  let scanned = 0;

  for (const e of input.entries) {
    if (!inBackfillScope(e, input)) continue;
    scanned += 1;
    const rel = relativeTo(e.path, input.kbRoot);
    const folderRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const text = input.textOf(e.path);
    if (text == null) {
      skipped.push({ path: e.path, why: '读不到内容' });
      continue;
    }
    /**
     * ── 分档（P7.17 合并矩阵）：值档与位置档跟"补什么"无关，先各自算清 ──
     * 坏前言篇（`fragileKeys` 命中）**只进坏前言档**（值档/位置档都不掺和 ——
     * 它的去处是「修前言」，不是补/迁/覆盖）。
     */
    const badFm = fragileKeys(e.props);
    if (badFm.length > 0) {
      fragile.push({ path: e.path, why: `前言里有嵌套值（${badFm.join('、')}）` });
      continue;
    }
    collectValueBuckets(e, rel, folderRel, legacy, coverage);
    collectPosIssues(e, input, posIssues);

    const choice = input.templateFor(folderRel);
    const templateText = input.templateTexts[choice.path] ?? null;
    const ctx = input.contextOf(rel, e.basename);
    const plan = buildFillPlan(text, {
      ctx,
      templateText,
      templatePath: choice.path,
      /**
       * 🔴 **D1（P7.17 · 用户 2026-10-08 拍板）**：存量补齐也写「文件位置」= **实际落点**
       * （库根 `.`）+ **`收藏: false`** —— 存量写齐六件，与新建路完全一致。
       * ⚠️ **写盘那一侧（backfill-panel 的 `fillFile(file, {withPosition:true})`）必须与这里一致**；
       * 不一致会让"补完再扫 = 0"的幂等当场红（判据钉着）。
       */
      withPosition: true,
      fragile: badFm,
      ctime: input.ctimeOf(e.path),
    });
    const summary = describe(plan);
    if (summary.kind === 'none') {
      skipped.push({ path: e.path, why: summary.why });
      continue;
    }
    if (summary.kind === 'skip') {
      // 坏前言在 buildFillPlan 里也会 skip（双保险）；分档归它自己的桶
      if (summary.code === 'fragile') fragile.push({ path: e.path, why: summary.why });
      else skipped.push({ path: e.path, why: summary.why });
      continue;
    }
    items.push({
      path: e.path,
      basename: e.basename,
      rel,
      folderRel,
      kind: summary.kind,
      yaml: summary.yaml,
      yamlAdded: summary.yamlAdded.length > 0 ? summary.yamlAdded : undefined,
      body: summary.body,
      tail: summary.tail,
      templatePath: choice.path,
      rule: choice.rule,
      unresolved: summary.unresolved,
    });
  }

  items.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  return { items, skipped, fragile, posIssues, legacy, coverage, scanned };
}

/**
 * **值档**（P7.17 合并矩阵）：`类型`/`状态` 的值不在 v2 值域里时，往哪一档走 ——
 *   · 迁移映射认得出（`migrate.legacyValueFix`）→ **旧值待迁** + **覆盖候选**（via 'map'，
 *     建议值就来自映射表）—— §1.1 拍定"覆盖区含旧值档"；
 *   · `状态` 的「删键」档（待整理/持续更新）→ 只进**旧值待迁**（那是"删"不是"换"，
 *     覆盖模式没有值可写）；
 *   · 都认不出 → **覆盖候选**（via 'guess'，建议值走 `suggestValueFor`，与迁移面板推荐同源）。
 * 缺键（空值）不进值档 —— 那是"补"的活（items）。
 */
function collectValueBuckets(
  e: NoteEntry,
  rel: string,
  folderRel: string,
  legacy: BackfillLegacy[],
  coverage: BackfillCover[],
): void {
  for (const key of ['类型', '状态'] as const) {
    const raw = asString(e.props[key]).trim();
    if (raw === '') continue;
    if (key === '类型' && (NOTE_TYPES as readonly string[]).includes(raw)) continue;
    if (key === '状态' && (STATUSES as readonly string[]).includes(raw)) continue;
    const fix = legacyValueFix(key, raw);
    if (fix) {
      legacy.push({ path: e.path, rel, basename: e.basename, key, from: raw, to: fix.to, why: fix.why });
      coverage.push({ path: e.path, rel, basename: e.basename, key, from: raw, to: fix.to, via: 'map' });
      continue;
    }
    if (key === '状态' && isStatusDropValue(raw)) {
      legacy.push({
        path: e.path,
        rel,
        basename: e.basename,
        key,
        from: raw,
        to: '',
        why: '「待整理/持续更新」退役 —— 迁移面板连键删',
      });
      continue;
    }
    const to = suggestValueFor(key, raw, {
      dirRel: folderRel,
      typeValue: asString(e.props['类型']).trim(),
    });
    coverage.push({ path: e.path, rel, basename: e.basename, key, from: raw, to, via: 'guess' });
  }
}

/**
 * **文件位置异常档**（只报告 + 给"去首页待处理"入口，**不动**）：
 *   · 声明指向的目录不存在（更具体的一条，先判 —— 多半是声明写了个不存在的路径）；
 *   · 声明与实际不一致（`position-mismatch` 旗标 —— 体检同一份判据）。
 * `dirExists` 由调用方给；不给就只报"不一致"那半（那是旗标给的，纯函数也算得出）。
 */
function collectPosIssues(e: NoteEntry, input: Pick<BackfillInput, 'dirExists'>, out: BackfillSkip[]): void {
  const declared = declaredPositions(e.props)[0] ?? '';
  if (declared !== '' && input.dirExists && !input.dirExists(declared)) {
    out.push({ path: e.path, why: `声明指向的目录不存在：${declared}` });
    return;
  }
  if (e.flags.includes('position-mismatch')) {
    out.push({ path: e.path, why: '声明与实际不一致（搬回声明处 / 改声明）' });
  }
}

function describe(plan: FillPlan): {
  kind: 'none' | 'skip' | 'template' | 'patch';
  why: string;
  code?: 'fragile';
  yaml: boolean;
  yamlAdded: string[];
  body: boolean;
  tail: boolean;
  unresolved: string[];
} {
  if (plan.kind === 'none') {
    return { kind: 'none', why: plan.why, yaml: false, yamlAdded: [], body: false, tail: false, unresolved: [] };
  }
  if (plan.kind === 'skip') {
    return {
      kind: 'skip',
      why: plan.why,
      code: plan.code,
      yaml: false,
      yamlAdded: [],
      body: false,
      tail: false,
      unresolved: [],
    };
  }
  if (plan.kind === 'template') {
    return { kind: 'template', why: '', yaml: true, yamlAdded: [], body: true, tail: true, unresolved: plan.unresolved };
  }
  return {
    kind: 'patch',
    why: '',
    yaml: plan.yaml != null,
    yamlAdded: plan.yamlAdded ?? [],
    body: plan.body != null,
    tail: plan.tail != null,
    unresolved: plan.unresolved,
  };
}

/** 一句话说清这一篇补什么（面板与报告共用，别各写一份） */
export function describeItem(item: BackfillItem): string {
  if (item.kind === 'template') return '套整套模板（前言 + 正文骨架 + 尾部双链）';
  const yamlPart = item.yaml
    ? item.yamlAdded && item.yamlAdded.length > 0
      ? `补了：${item.yamlAdded.join('、')}`
      : '补前言'
    : '';
  const parts = [
    yamlPart,
    item.body ? '补正文骨架（前言已有，不动）' : '',
    item.tail ? '补尾部双链' : '',
  ].filter(Boolean);
  return parts.join(' + ') || '（无变化）';
}

export interface BackfillCounts {
  total: number;
  template: number;
  patch: number;
  yaml: number;
  tail: number;
}

export function countPlan(plan: BackfillPlan): BackfillCounts {
  const out: BackfillCounts = { total: plan.items.length, template: 0, patch: 0, yaml: 0, tail: 0 };
  for (const it of plan.items) {
    if (it.kind === 'template') out.template += 1;
    else out.patch += 1;
    // 补正文骨架的算进"补前言"那栏的口径里？不 —— 单独记才说得清（模板那一支才是"整套"）
    if (it.yaml || it.body) out.yaml += 1;
    if (it.tail) out.tail += 1;
  }
  return out;
}

/** 扫描结果的一句话（面板顶部与通知共用） */
export function planSummary(plan: BackfillPlan): string {
  const c = countPlan(plan);
  if (c.total === 0) return `扫过 ${plan.scanned} 篇，没有要补的 ✅`;
  return (
    `扫过 ${plan.scanned} 篇，要补 ${c.total} 篇` +
    `（空白套模板 ${c.template} · 补前言 ${c.yaml} · 补尾链 ${c.tail}）`
  );
}

/**
 * **按当前库拼输入 + 扫描**（P6 段④ 从 `ui/backfill-panel.ts` 抽出来的）。
 *
 * 为什么要抽：首次使用向导的第 3 步要报「有多少篇待补属性」，而**它必须与
 * 「一键补全」面板报的是同一个数**。两处各拼一份 `BackfillInput` 的话，
 * 差异不会当场爆出来 —— 只会在用户眼里变成"向导说 7 篇、点进去说 3 篇"，
 * 然后没人知道该信哪个。本项目在「两处各写一份」上栽过很多次
 *（`AREA_DIRS` 与库内路由表、看板默认值两份活代码…），这条从一开始就避开。
 *
 * ⚠️ **只读**：读正文、读模板、读路由表，一个字节都不写。
 * 全文扫一遍正文是它的成本（`cachedRead` 有缓存，实验库 40+ 篇约几十毫秒）。
 */
export async function planBackfillOf(ctx: WorkbenchContext): Promise<BackfillPlan> {
  const entries = ctx.index.getAll();
  const tp = readTemplater(ctx.app);
  const tpls = templateFiles(ctx.app, ctx.settings);
  const templateTexts: Record<string, string | null> = {};
  for (const f of tpls) {
    try {
      templateTexts[f.path] = await ctx.app.vault.cachedRead(f);
    } catch {
      templateTexts[f.path] = null;
    }
  }
  // 笔记正文：先全读进来（planner 是纯函数，同步算）
  const texts: Record<string, string | null> = {};
  for (const e of entries) {
    if (
      !inBackfillScope(e, {
        kbRoot: ctx.settings.kbRoot(),
        metaRoot: ctx.settings.metaRoot(),
        templateDir: ctx.settings.templateDir(),
      })
    ) {
      continue;
    }
    try {
      texts[e.path] = await ctx.app.vault.cachedRead(e.file);
    } catch {
      texts[e.path] = null;
    }
  }
  const auto = await ctx.automation.get();
  return planBackfill({
    entries,
    kbRoot: ctx.settings.kbRoot(),
    metaRoot: ctx.settings.metaRoot(),
    templateDir: ctx.settings.templateDir(),
    templateTexts,
    templateFor: (folderRel) => {
      const folderAbs = joinPath(ctx.settings.kbRoot(), folderRel);
      const choice = pickTemplate(ctx.app, ctx.settings, tp, {
        folderPath: folderAbs,
        defaultTemplate: auto.completion.defaultTemplate,
      });
      return { path: choice.path, rule: choice.rule };
    },
    contextOf: (rel, basename) =>
      noteContext(ctx.app, ctx.settings, {
        title: basename,
        folderRel: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      }),
    textOf: (path) => texts[path] ?? null,
    ctimeOf: (path) => ctx.index.get(path)?.file.stat?.ctime ?? Date.now(),
    /** 「文件位置」异常档那半（指向不存在的目录）；查不了就别说它不存在 */
    dirExists: (rel) => {
      try {
        return ctx.app.vault.getFolderByPath(joinPath(ctx.settings.kbRoot(), rel)) != null;
      } catch {
        return true;
      }
    },
  });
}
