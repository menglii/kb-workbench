/**
 * services/migrate.ts —— 属性迁移（P2 起；**v2 大改，P7.12**）：**声明式映射表 → 只读预演 → 执行**
 *
 * 为什么要有这个文件（`开发计划.md` §7）：属性编辑只会"选属性 + 设值"，补全硬约束"只加不删"，
 * 而迁移要**删键**、**把值从一个域折算到另一个域**。映射表就是 `属性规范.md` 的代码化
 * ——**唯一真源**，别在别处再抄一份。
 *
 * ## v2（P7.12 · 2026-10-06 拍定）的迁移面（**合成同一批计划**）
 *   · `类型` 10 → 7（`TYPE_MAP_V2`）；`状态` 5 → 3（`待整理`/`持续更新` **删键**）
 *   · **删「领域」键**（连值）—— "目录即领域"，不存算得出来的
 *   · **删专属字段**（发布进度/平台/形式/目标发布日/封面/简介/截止日期/阶段）—— **连值删除**，
 *     预览里逐条列出将被删的键与值（`MigrateOp.from` 就是那个值）
 *   · **📌 页脚行清理**（全变体）+ **尾链存量重排**（相关笔记 → 所属中心 → 返回大地图）
 *     —— 这两件是**正文修整**（`templates.fixTailLines` / `stripPinLines`），
 *     与属性分开写但**同一条链、同一个快照**（`MigratePlanItem.bodyOps`）
 *
 * 本文件是**纯逻辑**（不 import obsidian、不碰 DOM、不写盘）：
 *   · `planMigration()` 只读：算每篇要删什么、改什么、哪些要你逐篇定
 *   · 执行在 `ui/migrate-panel.ts`（快照 → processFrontMatter / vault.process → 报告）
 * 这样"预演"可反复跑、可在离线用例里钉住（完成定义就是"重跑预演 0 篇"）。
 *
 * ⚠️ 两条口径：
 *   ① **幂等**：计划跑完之后再跑一次，必须是 0 篇。这是完成定义的可断言形式。
 *   ② **模板不一样**：模板自身的 YAML 在正文里（靠 Templater 求值），
 *      所以它们走"按行改正文"（`applyTemplateEdits`），不走 `processFrontMatter`。
 */
import type { TFile } from 'obsidian';
import type { NoteEntry } from '../core/vault-index';
import { collectTexts, pendingPatches } from './doc-patches';
import { normPath, relativeTo } from '../core/paths';
import { fragileKeys } from './schema';
import { fencesOf, fixTailLines, stripPinLines, topKeyOf } from './templates';
import {
  LEGACY_KEYS,
  NOTE_TYPES,
  SPECS,
  STATUSES,
  asList,
  asString,
  defaultsForDir,
} from './schema';

// ────────────────────────────────────────────────────────────────
// 映射表
// ────────────────────────────────────────────────────────────────

/** `类型` 的 v0 旧值 → v1 名（P2 的"现库里对应"那一列；再叠 `TYPE_MAP_V2`） */
export const TYPE_RENAME: Record<string, string> = {
  区域中心: '中心页',
  学习笔记: '资料',
  参考资料: '资料',
  MOC索引: 'MOC',
  操作日志: '日志',
};

/**
 * **`类型` v1 → v2 的正式映射**（P7.12 · 2026-10-06 拍定，21.1）：
 * 内容作品·项目笔记·想法·资料 → 笔记；任务清单 → 任务；中心页·MOC → 索引；
 * `T_*` 模板文件 → 模板（由 `planTemplate` 按"文件是模板"判，不走这张表）。
 */
export const TYPE_MAP_V2: Record<string, string> = {
  内容作品: '笔记',
  项目笔记: '笔记',
  想法: '笔记',
  资料: '笔记',
  任务清单: '任务',
  日志: '日志',
  中心页: '索引',
  MOC: '索引',
  指南: '指南',
  规范: '规范',
  模板: '模板',
};

/** 内容流水线值（v1 混在 `状态` 里）→ v2 的通用状态（**不再拆 `发布进度`**） */
export const PIPELINE_SPLIT: Record<string, string> = {
  '1-灵感': '进行中',
  '2-选题': '进行中',
  '3-撰写中': '进行中',
  '4-待发布': '进行中',
  '5-已发布': '已完成',
};

/** `状态` 的 v0 旧值 → 新值（`已整理`/流水线值另有处理，见 `planNote`） */
export const STATUS_RENAME: Record<string, string> = {
  归档: '已归档',
};

/**
 * **v2 直接删掉的状态值**（整个键删掉，不折算）：
 * 「待整理」（≈"还在 Inbox" —— 位置已承载）与「持续更新」（结构页不写状态）。
 */
export const STATUS_DROP = ['待整理', '持续更新'];

/**
 * 直接删掉的键（P2 起：`主题`/`仅显示于`/`聚焦`；中文键 `标签` 先并入 `tags` 再删）。
 * ⚠️ `来源` **不在这张表里**：v0 曾把它列进来，P7.2c 做剪藏时拍板加回、P7.12 拍定 ⑥
 * "控制字段保留"—— 别再删它。
 */
export const DELETE_KEYS = ['主题', '仅显示于', '聚焦'];
/** 与 `tags` 合并后删除（§8 决策 8） */
export const MERGE_KEY = '标签';

/**
 * **v2 删掉的专属字段**（连值删；预览逐条列出键与值）。8 个。
 * ⚠️ 这张表也是"表外模板带旧键"判据的一部分（见 `legacyKeysIn` 的用法）。
 */
export const EXCLUSIVE_KEYS = ['发布进度', '平台', '形式', '目标发布日', '封面', '简介', '截止日期', '阶段'];

/** 「领域」——退役键（连值删）；单独列出来是因为好几处要按名字引它 */
export const AREA_KEY = '领域';

/**
 * ✅ **已拍板的值**（强制表：**不看旧值合不合法，一律改成它**）。键=相对库根的路径，
 * 值=属性 → 新值。
 *
 * ⚠️ v2（P7.12）：原表里那几条 `领域:` 拍板值（P2 时代逐篇定的："9.16 → 每日任务" 之类）
 * **全部作废** —— 「领域」这一整列退役、连值删除（拍定的映射是全域的，不需要逐篇定）。
 * 唯一的类型拍板（`04_Archives/旧资料/项目笔记模板.md: 资料`）也已由 `TYPE_MAP_V2`
 * 自然覆盖（资料 → 笔记，路径不用单列）。机制**保留**：将来真要拍板某个值，还往这儿写。
 */
export const DECIDED: Record<string, Record<string, string>> = {};

/** `DECIDED` 表支持的键（别的键写了也无效 —— 要报出来，别静默忽略） */
export const DECISION_KEYS = ['类型', '状态'] as const;

/**
 * 拍板值能不能用？返回问题描述，没问题返回 null。
 * 表是**手维护**的，写错一个字不能让它静默落库 —— 落进去之后没有任何一处会报。
 */
export function checkDecision(key: string, want: string): string | null {
  const domain: Record<string, readonly string[]> = { 类型: NOTE_TYPES, 状态: STATUSES };
  if (!(key in domain)) {
    return `DECIDED 表里的「${key}」不是这张表支持的键（只支持 ${DECISION_KEYS.join('/')}）→ 没写`;
  }
  if (!domain[key].includes(want)) {
    return `DECIDED 表给「${key}」写的是「${want}」，不在值域里 → 没写（先改表）`;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 单值会话（P7.17 起给存量补齐的分档与覆盖模式复用 —— **旧值判定/建议值回口**）
// ────────────────────────────────────────────────────────────────

/** 值映射的一个"认得出"结果（`to` = 折算到的新值；`why` = 一句话，给报告看） */
export interface ValueFix {
  to: string;
  why: string;
}

/**
 * **一个 `类型`/`状态` 值能被迁移表认出来吗**（认得出 → 给折算结果；认不出 → `null`）。
 *
 * 🔴 **P7.17 起这是「旧值」判定的唯一出处**：`services/backfill.ts` 的「旧值待迁」档与
 * 覆盖候选的建议值都调它（或 `suggestValueFor`）—— 映射表 = 本文件的
 * `TYPE_RENAME` → `TYPE_MAP_V2` / `STATUS_RENAME` / `PIPELINE_SPLIT`，**一个真源**，
 * 别在 backfill 里另抄一份；两处一致由判据 + 突变钉（关掉这张表要能红）。
 *
 * 两条边界：
 *  · `状态` 的「**删键**」档（`待整理`/`持续更新`）**不算**认得出 —— 它是"删"不是"换"
 *    （`isStatusDropValue` 单独判；那是迁移面板的活，覆盖模式不碰它）；
 *  · 折算结果 == 原值（身份映射）也当认不出 —— 那种值本来就在值域里、无事可做。
 */
export function legacyValueFix(key: '类型' | '状态', raw: string): ValueFix | null {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  if (key === '类型') {
    const renamed = TYPE_RENAME[v] ?? v;
    const mapped = TYPE_MAP_V2[renamed] ?? '';
    if (mapped === '' || mapped === v) return null;
    if (!(NOTE_TYPES as readonly string[]).includes(mapped)) return null;
    return { to: mapped, why: TYPE_MAP_V2[renamed] != null ? '类型收拢到 v2 七值' : '旧类型名收拢' };
  }
  if (STATUS_RENAME[v]) return { to: STATUS_RENAME[v], why: '旧状态名收拢' };
  if (PIPELINE_SPLIT[v]) return { to: PIPELINE_SPLIT[v], why: '流水线值收拢到进行中/已完成' };
  return null;
}

/** `状态` 的「删键」档（`待整理` / `持续更新`）—— 迁移面板连键删；覆盖模式不碰它 */
export function isStatusDropValue(raw: string): boolean {
  return STATUS_DROP.includes(String(raw ?? '').trim());
}

/**
 * 「值认不出」时给覆盖区的**建议值**（与迁移面板 `decide` 的推荐口径同源，
 * P7.17 · §1.1 拍定"建议值复用映射表"）：
 *  · `类型` → 目录默认（`defaultsForDir`）?? `笔记`；
 *  · `状态` → `已整理` + 「类型是日志」→ `已完成`，其余 → `进行中`。
 */
export function suggestValueFor(
  key: '类型' | '状态',
  raw: string,
  ctx: { dirRel: string; typeValue: string },
): string {
  if (key === '类型') return defaultsForDir(ctx.dirRel).类型 ?? '笔记';
  return String(raw ?? '').trim() === '已整理' && ctx.typeValue === '日志' ? '已完成' : '进行中';
}

// ────────────────────────────────────────────────────────────────
// 计划（预演的产物）
// ────────────────────────────────────────────────────────────────

export type OpKind = 'set' | 'del';

export interface MigrateOp {
  kind: OpKind;
  key: string;
  /** 显示用的旧值（`（空）` 表示没有） */
  from: string;
  /** 显示用的新值（del 时为空） */
  to: string;
  /** 执行用的真值（set 时） */
  value?: unknown;
  /** 为什么（预演里显示，让人不用猜） */
  why: string;
}

/** 需要人定的项（预演里给出选项 + 推荐，逐篇确认） */
export interface MigrateChoice {
  /** 稳定 id：`<相对路径>::<属性>` —— 面板的选择存这个 */
  id: string;
  path: string;
  key: string;
  /** 现在是什么（显示用） */
  from: string;
  options: string[];
  recommend: string;
  why: string;
}

export interface MigratePlanItem {
  path: string;
  /** 相对库根（显示用；预演表里一行一篇） */
  rel: string;
  basename: string;
  isTemplate: boolean;
  ops: MigrateOp[];
  choices: MigrateChoice[];
  /** 看了一眼但**不动**的自定义属性（只报告，别让东西悄悄消失） */
  keep: { key: string; value: string }[];
  /**
   * ⚠️ **整篇跳过**的原因（有值会被 `processFrontMatter` 的往返写坏）。
   * 这种篇**不出任何 op**（连删键都不做）—— 半个写盘也会把那个值改形。
   */
  blocked?: string[];
  /** 看一眼就该说出来的问题（**不拦改动**，但也不能一声不响） */
  warnings?: string[];
  /** 这篇要打的**正文补丁**处数（说明文字里的旧口径；走 `vault.process`，与属性分开写） */
  docPatches?: number;
  /**
   * **正文修整**（v2 新增）：📌 页脚行清理 / 尾链存量重排 —— 行级文本手术，
   * 走 `vault.process`（**不解析 YAML**，与属性分开写、同一条快照）。
   * 空数组/undefined = 没得修。
   */
  bodyOps?: BodyEdit[];
  /** 一句话汇总（面板每行右侧） */
  summary: string;
}

/** 正文修整的一处（给预演列表与执行日志看） */
export interface BodyEdit {
  kind: 'pin' | 'tail';
  /** 一句话（"删 📌 页脚行 ×1" / "尾链重排为新序"） */
  detail: string;
}

export interface MigratePlan {
  /** 全部条目（含不需要动的） */
  items: MigratePlanItem[];
  /** 需要动的（有 ops / choices / 正文修整）——完成定义看它的长度 */
  changes: MigratePlanItem[];
  /** 整篇跳过的（值会被写坏，得人工看一眼）——**不算"要改"**，否则预演永远回不到 0 */
  blocked: MigratePlanItem[];
  /** 需要动的篇数（= changes.length） */
  count: number;
  opCount: number;
  choiceCount: number;
  /** 正文补丁合计处数（说明文字里的旧口径） */
  patchCount: number;
  /** 正文修整合计处数（📌 页脚行 / 尾链重排） */
  bodyCount: number;
  /** 涉及的文件路径（拍快照用） */
  paths: string[];
}

export interface PlanOptions {
  /** 库根（相对库根算 rel；不给就按路径尾段匹配） */
  kbRoot?: string;
  /** 面板里已经逐篇定下来的值（`<相对路径>::<属性>` → 值） */
  choices?: Record<string, string>;
  /**
   * 正文（路径 → 文本）：**模板**（自身没有前言）+ **正文补丁覆盖的那几篇**。
   * **给不给差别很大**：
   *   · 给了 → 模板拿 `verifyTemplateText` 判"改没改"、补丁拿三态判"打没打过"
   *     → 改过的**不再出现在计划里**（预演能回到 0）
   *   · 没给 → 保守地永远列出来（面板/首页都该给；纯函数用例可以不给）
   * 由 `collectTexts()` 异步读好再传进来（属性问 metadataCache，正文只能读文件）。
   */
  texts?: Record<string, string>;
}

// ────────────────────────────────────────────────────────────────
// 预演
// ────────────────────────────────────────────────────────────────

export function planMigration(entries: NoteEntry[], opts: PlanOptions = {}): MigratePlan {
  const kbRoot = (opts.kbRoot ?? '').replace(/^\/+|\/+$/g, '');
  const chosen = opts.choices ?? {};
  const items: MigratePlanItem[] = [];

  for (const e of entries) {
    const rel = relOf(e.path, kbRoot);
    const item = e.isTemplate
      ? planTemplate(e, rel, opts.texts)
      : planNote(e, rel, chosen, opts.texts);
    items.push(item);
  }

  const changes = items.filter(
    (i) =>
      i.ops.length > 0 ||
      i.choices.length > 0 ||
      (i.docPatches ?? 0) > 0 ||
      (i.bodyOps?.length ?? 0) > 0 ||
      (i.warnings?.length ?? 0) > 0,
  );
  return {
    items,
    changes,
    blocked: items.filter((i) => (i.blocked?.length ?? 0) > 0),
    count: changes.length,
    opCount: changes.reduce((n, i) => n + i.ops.length, 0),
    choiceCount: changes.reduce((n, i) => n + i.choices.length, 0),
    patchCount: changes.reduce((n, i) => n + (i.docPatches ?? 0), 0),
    bodyCount: changes.reduce((n, i) => n + (i.bodyOps?.length ?? 0), 0),
    paths: changes.map((i) => i.path),
  };
}

/**
 * **正文修整的动作**（📌 页脚行 + 尾链新序）——给 `ui/migrate-panel.ts` 的执行用。
 * 与 `applyTemplateEdits` 里的尾巴同一份实现（`stripPinLines` / `fixTailLines`），
 * 只做行级文本手术、**不解析 YAML**（所以对属性侧 fragile 的篇也安全 —— 但那种篇
 * 目前整篇跳过，等有人明确要再放开）。
 */
export function applyBodyFixes(text: string): string {
  return fixTailLines(stripPinLines(text).text).text;
}

/** 相对库根（拿不到库根就退回整条路径——匹配照样按尾段来） */
function relOf(path: string, kbRoot: string): string {
  // P7.14：走 relativeTo（'' 根 = 整个库 → 原样返回，语义正是"相对 vault 根"；
  // 库根本身 → ''；不在库内 → 原样，与旧行为逐支一致）
  return relativeTo(normPath(path), kbRoot);
}

/** 表里的键按"相对库根"写；库根名字可配，所以匹配时也允许尾段 */
function lookup<T>(table: Record<string, T>, rel: string): T | undefined {
  if (table[rel] != null) return table[rel];
  for (const [k, v] of Object.entries(table)) {
    if (rel === k || rel.endsWith('/' + k)) return v;
  }
  return undefined;
}

function planNote(
  e: NoteEntry,
  rel: string,
  chosen: Record<string, string>,
  texts?: Record<string, string>,
): MigratePlanItem {
  const props = e.props;
  const ops: MigrateOp[] = [];
  const choices: MigrateChoice[] = [];
  const keep: { key: string; value: string }[] = [];
  const warnings: string[] = [];

  /**
   * ⚠️ **先看有没有"写盘会改形"的值**：`processFrontMatter` 是把整份前言
   * 解析再序列化的 —— 值若是**嵌套映射**（典型来源是 `创建日期: {{date}}` 这种
   * 占位符：YAML 把它当流式映射），往返一次就变成
   * `创建日期:
  "{ date }":`，**原文本再也回不去**（真机实测到 4 篇）。
   * 这类篇**整篇跳过**：出 op 就会触发写盘，半个改动也会把那个值改形。
   *
   * ⚠️ 判据是 **`fragileKeys()`**（`services/schema.ts`，17.2 起是全仓唯一定义处、
   * P7.16 从 frontmatter.ts 挪到 schema.ts，函数一字未改）——
   * `ui/migrate-panel.ts` 的执行那一步走 `ctx.fm.update`，**写前言的路径全都过同一个守卫**。
   */
  const fragile = fragileKeys(props);
  if (fragile.length > 0) {
    return {
      path: e.path,
      rel,
      basename: e.basename,
      isTemplate: false,
      ops: [],
      choices: [],
      keep: [],
      blocked: fragile.map(
        (k) => `「${k}」是个嵌套映射（原文本多半是 {{…}} 这类占位符）—— 写盘会把它改形`,
      ),
      summary: '跳过（值会被写坏，得人工改）',
    };
  }

  /**
   * 定值：**面板里选过的不再问**（否则"全部用推荐值"点完还挂着 14 处待你定），
   * 没选过的按 传入的推荐（v2：目录默认）排，并生成一条待你定的项。
   */
  const decide = (key: string, options: string[], fallback: string, why: string): string => {
    const id = `${rel}::${key}`;
    const picked = chosen[id];
    if (picked != null && options.includes(picked)) return picked;
    const recommend = options.includes(fallback) ? fallback : options[0];
    choices.push({
      id,
      path: e.path,
      key,
      from: asString(props[key]) || '（空）',
      options,
      recommend,
      why,
    });
    return recommend;
  };

  /**
   * ⑀ **拍板值优先**：`DECIDED` 里的键一律直改（**不管旧值合不合法**）。
   * 这一条是独立审查抓回来的：早先只在"旧值换不出来"时才查表，于是
   * `领域: 生活健康 → 每日任务` 一条都没生效（`生活健康` 是合法值，压根没进 decide）。
   */
  const forcedSet: Record<string, string> = {};
  for (const [key, want] of Object.entries(lookup(DECIDED, rel) ?? {})) {
    const problem = checkDecision(key, want);
    if (problem != null) {
      // 键不在支持范围时，值本来就一样的话不必报（免得噪音）
      if (asString(props[key]) !== want) warnings.push(problem);
      continue;
    }
    const cur = asString(props[key]);
    forcedSet[key] = want;
    if (want === cur) continue;
    ops.push({ kind: 'set', key, from: cur || '（空）', to: want, value: want, why: '逐篇确认时定的值（旧值合不合法都照改）' });
  }

  // ── ① 删旧键（§6.1）────────────────────────────────────────
  for (const key of DELETE_KEYS) {
    if (!(key in props)) continue;
    ops.push({ kind: 'del', key, from: asString(props[key]) || '（空）', to: '', why: '旧规范里的字段，已废' });
  }

  // ── ② 中文键 `标签` 并入 `tags`，再删 ──────────────────────
  const tagKey = MERGE_KEY;
  let tags = asList(props['tags']).map(String);
  if (tagKey in props) {
    const incoming = asList(props[tagKey]).map(String);
    const merged = Array.from(new Set([...tags, ...incoming]));
    ops.push({
      kind: 'set',
      key: 'tags',
      from: tagKey === '标签' ? `（来自中文键「标签」）` : '',
      to: merged.join('、') || '（空）',
      value: merged,
      why: '中文键「标签」与 tags 重复 → 合并',
    });
    ops.push({ kind: 'del', key: tagKey, from: incoming.join('、'), to: '', why: '合并进 tags 后删除' });
    tags = merged;
  }

  // ── ③ `类型` 归一（v0 名 → v1 名 → **v2 七值**，两段映射链）──
  let type = forcedSet['类型'] ?? asString(props['类型']);
  const rawType = type;
  if (forcedSet['类型'] != null) {
    // 拍板值已在 forcedSet 里出过 op，这里只更新局部变量（后面的规则按新类型判）
  } else if (type !== '' && TYPE_RENAME[type]) {
    type = TYPE_RENAME[type];
  }
  if (forcedSet['类型'] == null && type !== '' && TYPE_MAP_V2[type] != null) {
    type = TYPE_MAP_V2[type];
  }
  if (forcedSet['类型'] == null) {
    if (type === '') {
      // v2 **无必填**：空类型不补（"新建即配置"管新篇；旧篇留空也合法）
    } else if (!(NOTE_TYPES as readonly string[]).includes(type)) {
      const rec = defaultsForDir(dirOfRel(rel)).类型 ?? '笔记';
      type = decide('类型', [...NOTE_TYPES], rec, `「${rawType}」不在 v2 值域里（逐篇看语境）`);
    }
    if (type !== rawType && type !== '') {
      ops.push({
        kind: 'set',
        key: '类型',
        from: rawType || '（空）',
        to: type,
        value: type,
        why: TYPE_MAP_V2[rawType] != null ? '类型收拢到 v2 七值' : '旧类型名收拢',
      });
    }
  }

  // ── ④ 「领域」**删键**（连值；v2「领域退役」——目录即领域，不存算得出来的）──
  if (AREA_KEY in props) {
    ops.push({
      kind: 'del',
      key: AREA_KEY,
      from: asString(props[AREA_KEY]) || '（空）',
      to: '',
      why: '「领域」退役（目录即领域）—— 连值删除',
    });
  }

  // ── ⑤ `状态` 归一（v2 三值：待整理/持续更新 **删键**、流水线值折算、不再拆 `发布进度`）──
  let status = forcedSet['状态'] ?? asString(props['状态']);
  if (forcedSet['状态'] != null) {
    // 拍板值已出 op
  } else if (STATUS_DROP.includes(status)) {
    ops.push({
      kind: 'del',
      key: '状态',
      from: status,
      to: '',
      why:
        status === '待整理'
          ? '「待整理」退役（"还在 Inbox"由位置承载）'
          : '「持续更新」退役（结构页可不写状态）',
    });
    status = '';
  } else if (PIPELINE_SPLIT[status]) {
    const to = PIPELINE_SPLIT[status];
    ops.push({
      kind: 'set',
      key: '状态',
      from: status,
      to,
      value: to,
      why: '内容流水线值收拢到「进行中 / 已完成」（发布进度已退役）',
    });
    status = to;
  } else if (STATUS_RENAME[status]) {
    const to = STATUS_RENAME[status];
    ops.push({ kind: 'set', key: '状态', from: status, to, value: to, why: '旧状态名收拢' });
    status = to;
  } else if (status !== '' && !(STATUSES as readonly string[]).includes(status)) {
    const rec = status === '已整理' && type === '日志' ? '已完成' : '进行中';
    const to = decide('状态', [...STATUSES], rec, `「${status}」不在 v2 值域里（逐篇看语境）`);
    ops.push({ kind: 'set', key: '状态', from: status, to, value: to, why: '状态收拢到 v2 三值' });
    status = to;
  }

  // ── ⑥ 专属字段删键（**连值删除**，8 个；预览里逐条列出键与值）──
  for (const key of EXCLUSIVE_KEYS) {
    if (!(key in props)) continue;
    ops.push({
      kind: 'del',
      key,
      from: asString(props[key]) || '（空）',
      to: '',
      why: 'v2 专属字段退役（连值删除）',
    });
  }

  // ── ⑦ `tags` 只做"缺键补空"（v2：tags 用户自管 —— 不再做"删与领域重复"那类精简）──
  if (!('tags' in props) && !(tagKey in props)) {
    ops.push({ kind: 'set', key: 'tags', from: '（缺）', to: '（空数组）', value: [], why: 'tags 是五件套之一（空数组合法）' });
  }

  // ── ⑦点八 正文修整（📌 页脚行清理 + 尾链存量重排；走 vault.process、
  //    与属性分开写，但**同一条链、同一个快照**）──
  const bodyOps: BodyEdit[] = [];
  const rawText = texts?.[e.path];
  if (rawText != null) {
    const pin = stripPinLines(rawText);
    if (pin.removed > 0) bodyOps.push({ kind: 'pin', detail: `删 📌 页脚行 ×${pin.removed}` });
    const tail = fixTailLines(pin.text);
    if (tail.changed) bodyOps.push({ kind: 'tail', detail: '尾链重排为新序（相关笔记 → 所属中心 → 返回大地图）' });
  }

  // ── ⑦点九 正文补丁（说明文字里的旧口径；见 `doc-patches.ts`）──
  // 它**不算 op**（改的是正文、不走 processFrontMatter）→ 单独一个计数
  const docPatches = pendingPatches(rel, rawText).length;

  // ── ⑧ 自定义属性只报告（别让东西悄悄消失）─────────────────
  for (const [k, v] of Object.entries(props)) {
    if (k === tagKey || k === 'position') continue;
    if (isKnownKey(k)) continue;
    if (ops.some((o) => o.kind === 'del' && o.key === k)) continue;
    keep.push({ key: k, value: asString(v) || '（空）' });
  }

  return {
    path: e.path,
    rel,
    basename: e.basename,
    isTemplate: false,
    ops,
    choices,
    keep,
    warnings,
    docPatches,
    bodyOps: bodyOps.length > 0 ? bodyOps : undefined,
    summary: summarize(ops, choices, warnings, docPatches, bodyOps.length),
  };
}

/** rel 的所在目录（相对库根口径；`defaultsForDir` / 目录推荐用） */
function dirOfRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** 规范里认得的键（= `schema.ts` 的属性表 + 迁移要删的旧键/专属键） */
function isKnownKey(k: string): boolean {
  return KNOWN_KEYS.has(k);
}

const KNOWN_KEYS = new Set<string>([
  ...SPECS.map((s) => s.name),
  ...LEGACY_KEYS,
  AREA_KEY,
  ...EXCLUSIVE_KEYS,
]);

function summarize(
  ops: MigrateOp[],
  choices: MigrateChoice[],
  warnings: string[] = [],
  docPatches = 0,
  bodyEdits = 0,
): string {
  const parts: string[] = [];
  const del = ops.filter((o) => o.kind === 'del').map((o) => o.key);
  if (del.length > 0) parts.push(`删 ${del.join('/')}`);
  const set = ops.filter((o) => o.kind === 'set');
  if (set.length > 0) parts.push(set.map((o) => `${o.key}→${o.to}`).join(' · '));
  if (choices.length > 0) parts.push(`${choices.length} 处待你定`);
  if (docPatches > 0) parts.push(`正文补丁 ${docPatches} 处`);
  if (bodyEdits > 0) parts.push(`正文修整 ${bodyEdits} 处`);
  if (warnings.length > 0) parts.push(`${warnings.length} 处要看一眼`);
  return parts.join('，') || '不用动';
}

// ────────────────────────────────────────────────────────────────
// 模板（YAML 在正文里 → 按行改）
// ────────────────────────────────────────────────────────────────

export interface TemplateOp {
  kind: 'del' | 'set' | 'add';
  key: string;
  /** 整行文本（可以带 `\n` 塞多行；不给就保留原行） */
  line?: string;
  /** `add` 插在哪个键后面 */
  after?: string;
  /**
   * 删**正文里的整行**（不在前言块里）——给那一行的原文（trim 后比）。
   * 用途：删 `主题` 之后，模板 JS 里算 `topic` 的那行成了死代码（P2 收尾一并清）。
   */
  delLine?: string;
  /** 替换时把紧挨在上面的注释行一起删掉（模板里的注释也讲到了旧值域） */
  dropCommentsAbove?: boolean;
  why: string;
}

/**
 * 模板的**表驱动清理**（v0 历史账 —— 只留"逐行点名"能做的事）。
 * 键 = 模板文件名（**带 .md**）——查表一律走 `editsFor()`，它两种写法都认。
 *
 * ⚠️ v2（P7.12）起，**v2 口径的修整全部走通用修整**（`genericTemplateIssues` /
 * `applyGenericTemplateFixes`）：类型→模板、删「领域」/专属字段、占位符引号存法、
 * 📌 页脚行、尾链新序 —— 所以任何模板（哪怕用户手搓的、表里没有的）都能被
 * "一键修复"到 v2，这里只剩 P2 时代的历史清理（`主题` 死代码等）。
 *
 * ⚠️ 踩过一次：索引给的 `NoteEntry.basename` **不带扩展名**（`T_内容作品`），
 * 而这里的键是带扩展名的（`T_内容作品.md`）→ `表的[basename]` 永远是 undefined
 * → **7 个模板一个都没进计划，还一声不响**（预演里少 6 行、执行时什么也不做）。
 * 所以查表收敛成一个函数，别再各处直接下标。
 */
export const TEMPLATE_EDITS: Record<string, TemplateOp[]> = {
  'T_内容作品.md': [
    { kind: 'del', key: '主题', why: '标题的副本，改名后会变旧' },
    {
      kind: 'set',
      key: '状态',
      line: '状态: 进行中',
      dropCommentsAbove: true,
      why: '「状态」只留通用生命周期（原注释讲的是流水线值）',
    },
    { kind: 'set', key: 'tags', line: 'tags: []', why: '「内容创作」与领域重复（§6.4）' },
    { kind: 'del', key: '<正文>topic', delLine: 'const topic = title.includes("_") ? title.split("_")[0] : title;', why: '删「主题」后这行成了死代码' },
  ],
  'T_每日任务.md': [
    { kind: 'del', key: '主题', why: '标题的副本' },
    { kind: 'del', key: '<正文>topic', delLine: 'const topic = title.includes("_") ? title.split("_")[0] : title;', why: '删「主题」后这行成了死代码' },
    { kind: 'del', key: '<正文>title', delLine: 'const title = tp.file.title;', why: '这个模板正文不再用 title' },
  ],
  'T_项目笔记.md': [
    { kind: 'del', key: '主题', why: '标题的副本' },
    { kind: 'set', key: 'tags', line: 'tags: []', why: '「项目」与领域重复；stage 也已经是「阶段」属性（2026-09-24 收尾一并清掉）' },
    { kind: 'del', key: '<正文>topic', delLine: 'const topic = title.includes("_") ? title.split("_")[0] : title;', why: '删「主题」后这行成了死代码' },
  ],
  'T_领域笔记.md': [
    { kind: 'del', key: '主题', why: '标题的副本' },
    { kind: 'set', key: 'tags', line: 'tags: []', why: '标签与领域重复（模板里是同一个 <% area %>）' },
    { kind: 'del', key: '<正文>topic', delLine: 'const topic = title.includes("_") ? title.split("_")[0] : title;', why: '删「主题」后这行成了死代码' },
  ],
  'T_参考资料.md': [
    { kind: 'del', key: '主题', why: '标题的副本' },
    { kind: 'set', key: '状态', line: '状态: 进行中', why: '「已整理」不是终态（§4.3 注）' },
    { kind: 'set', key: 'tags', line: 'tags: [<% cat %>]', why: '「资源」与领域重复' },
    { kind: 'del', key: '<正文>topic', delLine: 'const topic = title.includes("_") ? title.split("_")[0] : title;', why: '删「主题」后这行成了死代码' },
  ],
  'T_收件箱速记.md': [
    { kind: 'del', key: '主题', why: '标题的副本' },
    { kind: 'set', key: 'tags', line: 'tags: []', why: '「待整理」是状态值，不是横切标签' },
  ],
  // T_智能新建 是脚本（自身没有前言），不在表里
};

/** 查模板表：`T_内容作品` 与 `T_内容作品.md` 两种写法都认（见上面那段 ⚠️） */
export function editsFor(name: string): TemplateOp[] {
  const bare = name.replace(/\.md$/i, '');
  return TEMPLATE_EDITS[name] ?? TEMPLATE_EDITS[bare] ?? TEMPLATE_BY_BARE[bare] ?? [];
}

/** 去掉扩展名的索引（索引给的是 `T_内容作品`，表里写的是 `T_内容作品.md`） */
const TEMPLATE_BY_BARE: Record<string, TemplateOp[]> = Object.fromEntries(
  Object.entries(TEMPLATE_EDITS).map(([k, v]) => [k.replace(/\.md$/i, ''), v]),
);

function planTemplate(e: NoteEntry, rel: string, texts?: Record<string, string>): MigratePlanItem {
  const edits = editsFor(e.basename);
  const text = texts?.[e.path];
  // 读不到正文 → 保守地列出来（下次预演再看）；读得到 → 精确判"改没改"
  if (text == null) {
    return {
      path: e.path,
      rel,
      basename: e.basename,
      isTemplate: true,
      ops: [],
      choices: [],
      keep: [],
      warnings: ['读不到正文，没法核对这篇模板（下次预演再看）'],
      summary: '没核对',
    };
  }
  /**
   * ⚠️ **表里没有它 ≠ 它没问题**（在 Obsidian 里复制一个模板会得到 `T_内容作品 1.md`，
   * 用户也会手搓 `T_muban`）—— v2 起**通用修整**（genericTemplateIssues）覆盖所有模板：
   * 类型→模板 / 删「领域」与专属字段 / 占位符引号 / 📌 页脚 / 尾链新序。
   * 所以这里不再有"表外模板 → 跳过"那条路：能修的就列出来（#6③ 的"一键修复"）。
   */
  const tableNext = applyTableEdits(text, e.basename);
  const tableChanged = tableNext !== text;
  // 通用问题在"表 ops 之后"的文本上判（避免同一条被两类同时报）
  const gen = genericTemplateIssues(tableNext);
  // 自检通过 = 这篇已经改好了（**否则模板会永远挂在"要改"上、预演回不到 0 篇**）
  const done = verifyTemplateText(text, e.basename).length === 0;
  const ops: MigrateOp[] = done
    ? []
    : [
        ...(tableChanged
          ? edits.map((t) => ({
              kind: (t.kind === 'del' ? 'del' : 'set') as MigrateOp['kind'],
              key: t.key,
              from: t.kind === 'add' ? '（缺）' : '（模板）',
              to: t.kind === 'del' ? '' : (t.line ?? ''),
              why: t.why,
            }))
          : []),
        ...gen,
      ];
  return {
    path: e.path,
    rel,
    basename: e.basename,
    isTemplate: true,
    ops,
    choices: [],
    keep: [],
    summary: ops.length === 0 ? '不用动' : ops.map((o) => (o.kind === 'del' ? `删 ${o.key}` : `${o.key}→${o.to.replace(/^[^:]*:\s*/, '') || o.why}`)).join(' · '),
  };
}

/**
 * **v2 通用修整的问题清单**（任意模板通用 —— 表外的、用户手搓的都吃它）：
 *   ① 类型 该是 `模板`（缺或不是 → 一条 set）
 *   ② 删「领域」/专属字段（`EXCLUSIVE_KEYS`）/ v2 已退役的状态值（`STATUS_DROP`）
 *   ③ `创建日期: {{date}}` 裸占位符 → 该带引号存（`"{{date}}"`，不被 YAML 当流式映射）
 *   ④ 📌 页脚行（全变体）
 *   ⑤ 尾链新序（相关笔记 → 所属中心 → 返回大地图）
 * `verifyTemplateText` 用它自检；`planTemplate` 用它出预演行。
 * 没有前言块的（脚本类模板）跳过 ①②③（`fencesOf` 判）。
 */
export function genericTemplateIssues(text: string): MigrateOp[] {
  const out: MigrateOp[] = [];
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  if (start >= 0 && end >= 0) {
    const block = lines.slice(start + 1, end);
    const valOf = (k: string): string | undefined => {
      for (const l of block) if (topKeyOf(l) === k) return l.slice(l.indexOf(':') + 1).trim();
      return undefined;
    };
    const typeVal = valOf('类型');
    if (typeVal !== '模板') {
      out.push({
        kind: 'set',
        key: '类型',
        from: typeVal === undefined ? '（缺）' : typeVal || '（空）',
        to: '模板',
        why: '模板文件的类型（套用时的真类型由补全按目录换算）',
      });
    }
    if (valOf(AREA_KEY) !== undefined) {
      out.push({ kind: 'del', key: AREA_KEY, from: valOf(AREA_KEY) || '（空）', to: '', why: '「领域」退役（连值删除）' });
    }
    for (const k of DELETE_KEYS) {
      if (valOf(k) === undefined) continue;
      out.push({ kind: 'del', key: k, from: valOf(k) || '（空）', to: '', why: 'v0 旧键（表外模板也一并清）' });
    }
    for (const k of EXCLUSIVE_KEYS) {
      if (valOf(k) === undefined) continue;
      out.push({ kind: 'del', key: k, from: valOf(k) || '（空）', to: '', why: 'v2 专属字段退役（连值删除）' });
    }
    const st = valOf('状态');
    if (st !== undefined && STATUS_DROP.includes(st)) {
      out.push({ kind: 'del', key: '状态', from: st, to: '', why: 'v2 已退役的状态值' });
    }
    if (/^\s*创建日期\s*:\s*\{\{date\}\}\s*$/m.test(text)) {
      out.push({
        kind: 'set',
        key: '创建日期',
        from: '{{date}}（裸占位符）',
        to: '"{{date}}"',
        why: '裸占位符是 YAML 流式映射，属性往返会被写坏 —— 加引号存',
      });
    }
  }
  const pin = stripPinLines(text);
  if (pin.removed > 0) {
    out.push({ kind: 'del', key: '📌 页脚行', from: `×${pin.removed}`, to: '', why: 'v2：新建不附带、存量删行' });
  }
  if (fixTailLines(text).changed) {
    out.push({
      kind: 'set',
      key: '尾链',
      from: '旧序 / 旧标签',
      to: '相关笔记 → 所属中心 → 返回大地图',
      why: 'v2 尾链新序（与 tailSection 同一份口径）',
    });
  }
  return out;
}

/**
 * **通用修整的动作部分**（`genericTemplateIssues` 的可写版本）：逐条落实 ①②③。
 * 📌/尾链在 `applyTemplateEdits` 里用 `stripPinLines` / `fixTailLines`（与笔记同一份）。
 */
export function applyGenericTemplateFixes(text: string): string {
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  if (start < 0 || end < 0) return text; // 没有前言块 → 不动
  const block = lines.slice(start + 1, end);
  const delKeys = new Set<string>([AREA_KEY, ...DELETE_KEYS, ...EXCLUSIVE_KEYS]);
  const out: string[] = [];
  let sawType = false;
  for (const line of block) {
    const key = topKeyOf(line);
    if (key === '类型') {
      sawType = true;
      out.push('类型: 模板');
      continue;
    }
    if (key === '状态') {
      const v = line.slice(line.indexOf(':') + 1).trim();
      if (STATUS_DROP.includes(v)) continue; // 退役状态值 → 删行
      out.push(line);
      continue;
    }
    if (key != null && delKeys.has(key)) {
      // 紧挨在其上的注释也一起带走（模板里的注释往往就是在讲这个字段）
      while (out.length > 0 && /^\s*#/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(line);
  }
  if (!sawType) out.unshift('类型: 模板');
  let next = [...lines.slice(0, start + 1), ...out, ...lines.slice(end)].join('\n');
  // 占位符引号存法（只认"整行就是那个裸占位符"的形状）
  next = next.replace(/^(\s*创建日期\s*:\s*)\{\{date\}\}[ \t]*$/m, '$1"{{date}}"');
  return next;
}

/**
 * **表驱动**的那一半（v0 历史清理；按行改、**不解析 YAML**）。
 * 幂等：改两遍 == 改一遍（del 的行删掉、set 的行换成目标行）。
 */
export function applyTableEdits(text: string, basename: string): string {
  const edits = editsFor(basename);
  if (edits.length === 0) return text;
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  if (start < 0 || end < 0) return text;

  const block = lines.slice(start + 1, end);
  const existing = new Set(block.map(topKeyOf).filter(Boolean) as string[]);
  const out: string[] = [];
  const consumed = new Set<string>();
  /** 插在 `after` 后面的新行 —— 键已经在了就跳过（**幂等**：改两遍 == 改一遍） */
  const pushAdds = (after: string): void => {
    for (const add of edits.filter((x) => x.kind === 'add' && x.after === after)) {
      consumed.add(add.key);
      if (existing.has(add.key)) continue;
      out.push(add.line ?? `${add.key}:`);
      existing.add(add.key);
    }
  };

  for (const line of block) {
    const key = topKeyOf(line);
    if (key == null) {
      out.push(line); // 注释 / 缩进行：原样留着
      continue;
    }
    const edit = edits.find((e) => e.key === key && e.kind !== 'add');
    if (!edit) {
      out.push(line);
      pushAdds(key); // 这一行的键正好是某个新增项的落点（add 的 key 与它无关）
      continue;
    }
    consumed.add(key);
    if (edit.kind === 'del') continue; // 删掉这一行
    // 紧挨在上面的注释（`# 状态合法值…`）讲的也是旧值域 → 一起换掉
    if (edit.dropCommentsAbove) {
      while (out.length > 0 && topKeyOf(out[out.length - 1]) == null && /^\s*#/.test(out[out.length - 1])) {
        out.pop();
      }
    }
    out.push(edit.line ?? line);
    pushAdds(key);
  }
  // `after` 指向的键不存在时，别把新增项丢了（插在块尾）
  for (const edit of edits) {
    if (edit.kind !== 'add' || consumed.has(edit.key) || existing.has(edit.key)) continue;
    out.push(edit.line ?? `${edit.key}:`);
  }

  let next = [...lines.slice(0, start + 1), ...out, ...lines.slice(end)].join('\n');
  // 正文里的整行删除（**前言块之外**：模板 JS 里删 `主题` 之后剩下的死代码）
  for (const edit of edits) {
    if (edit.delLine == null) continue;
    const want = edit.delLine.trim();
    next = next
      .split('\n')
      .filter((l) => l.trim() !== want)
      .join('\n');
  }
  return next;
}

/**
 * **把一个模板修整到 v2**（幂等）：表 ops（`applyTableEdits`）→ 通用前言修整
 * （`applyGenericTemplateFixes`）→ 📌 页脚行清理 → 尾链新序（与笔记同一份实现）。
 * `verifyTemplateText` 在写盘前自检；两类都过写回，否则原样退回（不写坏）。
 */
export function applyTemplateEdits(text: string, basename: string): string {
  let next = applyTableEdits(text, basename);
  next = applyGenericTemplateFixes(next);
  next = stripPinLines(next).text;
  next = fixTailLines(next).text;
  return next;
}

/**
 * 一段文本的**前言块**里有没有旧键（v0 键 + v2 退役键全都算）。
 * 只认顶格键，不会误伤正文里的说明文字。
 */
export function legacyKeysIn(text: string): string[] {
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  if (start < 0 || end < 0) return [];
  const keys = new Set(lines.slice(start + 1, end).map(topKeyOf).filter(Boolean) as string[]);
  return [...DELETE_KEYS, MERGE_KEY, AREA_KEY, ...EXCLUSIVE_KEYS].filter((k) => keys.has(k));
}

/**
 * 顶格 `键:` 的键名 —— **实现已上移到 `services/templates.ts`**（P7.13a：
 * 套用模板的 YAML 合并与迁移修模板要用**同一份**判据，`fencesOf` 的先例）。
 * 这里只转发，别再写第二份。
 */
export { topKeyOf } from './templates';

/**
 * 前言块的上下边界。
 * ⚠️ **模板的起始 `---` 跟在 `<%* … %>` 后面**（一行是 `%>---`，不是 `---`）——
 * 只认 `trimEnd() === '---'` 的话，会把块的**结束**那行当成开始，于是整段改不到
 * （离线用例抓到的：模板一个字节没变，还全绿到"自检"那一步才炸）。
 */
/**
 * ⚠️ 实现已上移到 `services/templates.ts`（P3 的模板渲染也要用同一套判据）
 * —— 这里只是转发，**别再写第二份**。它认的形状是"起始 `---` 可能跟在 `%>` 后面"。
 */
export { fencesOf } from './templates';

/**
 * 改完自检：表 ops 的要求 + **v2 通用要求**（`genericTemplateIssues` 为空）。
 * 没有前言块的（脚本类模板，如 `T_智能新建`）只查正文两类。
 * 自检不过 → 面板原样写回（不写坏）。
 */
export function verifyTemplateText(text: string, basename: string): string[] {
  const edits = editsFor(basename);
  const bad: string[] = [];
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  const hasBlock = start >= 0 && end >= 0;
  if (edits.length > 0 && !hasBlock) return [`${basename}：改完找不到前言块`];
  if (hasBlock) {
    const block = lines.slice(start + 1, end);
    const keys = new Set(block.map(topKeyOf).filter(Boolean) as string[]);
    for (const e of edits) {
      // `delLine` 的 op 删的是正文行（不在前言块里），键的存在性与它无关
      if (e.kind === 'del' && e.delLine == null && keys.has(e.key)) bad.push(`「${e.key}」该删还在`);
      if (e.kind !== 'del' && !keys.has(e.key)) bad.push(`「${e.key}」该在还没有`);
      if (e.delLine != null && lines.some((l) => l.trim() === e.delLine?.trim())) {
        bad.push(`正文里那行死代码该删还在：${e.delLine.slice(0, 28)}…`);
      }
    }
    /**
     * **值也要在值域里**（独立审查实测：只查"键在不在"的话，`状态: 进行中2` 这种错字
     * 离线全绿 → 得靠这条拦）。空值与 `<% … %>` 占位符跳过（那是 Templater 的事）。
     * v2 域只剩 类型（含「模板」）/ 状态。
     */
    const domainOf: Record<string, readonly string[]> = {
      类型: NOTE_TYPES,
      状态: STATUSES,
    };
    for (const line of block) {
      const key = topKeyOf(line);
      const domain = key != null ? domainOf[key] : undefined;
      if (domain == null) continue;
      const raw = line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
      if (raw === '' || raw.includes('<%')) continue;
      if (!domain.includes(raw)) bad.push(`「${key}」的值「${raw}」不在值域里`);
    }
  }
  // v2 通用修整（类型→模板 / 删退役键 / 占位符引号 / 📌 / 尾链）；有前言块才查 ①②③
  for (const op of genericTemplateIssues(text)) {
    bad.push(`v2 修整还没到位：${op.key}（${op.why}）`);
  }
  return bad;
}

// ────────────────────────────────────────────────────────────────
// 执行用的补丁（面板 → processFrontMatter）
// ────────────────────────────────────────────────────────────────

/** 把一篇的 ops 折成一次原子写：`set` 的键值 + 要删的键 */
export function patchOf(item: MigratePlanItem): { set: Record<string, unknown>; del: string[] } {
  if (item.isTemplate) {
    // 模板的 op 没有 `value`（是"整行文本"），折成 set/del 会得到 undefined —— 直接拦住
    throw new Error('patchOf 只用于笔记条目；模板走 applyTemplateEdits');
  }
  const set: Record<string, unknown> = {};
  const del: string[] = [];
  for (const op of item.ops) {
    if (op.kind === 'del') del.push(op.key);
    else set[op.key] = op.value;
  }
  return { set, del };
}

/** 面板用的汇总（预演标题那行） */
export function planSummary(plan: MigratePlan): string {
  const skip = plan.blocked.length > 0 ? `${plan.blocked.length} 篇跳过` : '';
  if (plan.count === 0) {
    return skip ? `全部符合规范（${skip}：值会被写坏，得人工改）` : '全部符合规范';
  }
  const parts = [`${plan.count} 篇要改`, `${plan.opCount} 处改动`];
  if (plan.choiceCount > 0) parts.push(`${plan.choiceCount} 处待你定`);
  if (plan.patchCount > 0) parts.push(`正文补丁 ${plan.patchCount} 处`);
  if (plan.bodyCount > 0) parts.push(`正文修整 ${plan.bodyCount} 处`);
  if (skip) parts.push(skip);
  return parts.join(' · ');
}

/**
 * 预演的**异步入口**：先把模板正文读好，再交给纯函数。
 * 面板 / 首页 / 离线用例**都走它** —— 各写一遍迟早会漂（少传 `templateTexts`
 * 的那一处会永远把 6 个模板列成"要改"）。
 */
export async function previewMigration(
  vault: { cachedRead(file: TFile): Promise<string> },
  entries: NoteEntry[],
  opts: PlanOptions = {},
): Promise<MigratePlan> {
  const texts = await collectTexts(vault, entries);
  return planMigration(entries, { ...opts, texts });
}

/** 首选项（面板「全部用推荐值」按钮） */
export function recommendedChoices(plan: MigratePlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of plan.items) for (const c of item.choices) out[c.id] = c.recommend;
  return out;
}

/** 值域导出（面板的下拉候选，别在 UI 里另抄一份）；v2 只剩这两个域 */
export const MIGRATE_VALUES = {
  NOTE_TYPES: [...NOTE_TYPES],
  STATUSES: [...STATUSES],
};

