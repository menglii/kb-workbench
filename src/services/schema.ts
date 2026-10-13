/**
 * services/schema.ts —— 属性规范 v2（`属性规范.md` 的代码化）
 *
 * ## v2（P7.12 · 2026-10-06 拍定）
 *
 * · **五件套 = 类型 / 状态 / 文件位置 / 创建日期 / tags**；**「领域」退役**（目录即领域，
 *   不存算得出来的）—— 值域、判定函数、按目录反查全数删除；
 * · **专属字段直接去掉**（发布进度 / 平台 / 形式 / 目标发布日 / 封面 / 简介 / 截止日期 / 阶段）
 *   —— 存量迁移连值删除（`services/migrate.ts`）；
 * · 控制字段保留：位置锁定 / 隐藏 / 收藏 / 来源（来源是剪藏的原网页地址，"删它"是 v0 的旧账，
 *   P7.2c 已拍板加回 —— 别再删第三次）；
 * · **无"必填"概念**：`missing-required` 体检退休。`required` 字段只剩一个用途 ——
 *   把 类型/状态/tags 钉进小窗属性候选（`board/editor.ts` 的 `propsFor`），不参与任何体检。
 *
 * 它不只是"值域"：还要能表达**行为语义**（开发计划 §5.2）：
 *   · `readOnly` → `创建日期` 不允许手改，属性编辑器要禁掉
 *   · `multi`    → 列表型 → **要自研多选控件**（平台没有多选控件）
 *   · `values`   → 封闭枚举 → 编辑器给候选
 *
 * ⚠️ 这里是**唯一真源**：值域改了只改这一处，别在别处再抄一份。
 */

// ────────────────────────────────────────────────────────────────
// 值域（属性规范 §4）
// ────────────────────────────────────────────────────────────────
/**
 * v2 · **7 值**（2026-10-06 拍定；旧值映射 = `services/migrate.ts` 的 `TYPE_MAP_V2`）：
 * 内容作品·项目笔记·想法·资料 → 笔记；任务清单 → 任务；中心页·MOC → 索引；
 * `T_*` 模板文件 → 模板（新增值）。
 */
export const NOTE_TYPES = ['笔记', '任务', '日志', '模板', '索引', '指南', '规范'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/**
 * v2 · **3 值**（2026-10-06 三拍）：
 * 砍「待整理」（≈"还在 00_Inbox" —— 位置已承载）与「持续更新」（结构页不写状态）。
 * 存量迁移：这两个值**删键**（不折算），见 `migrate.ts`。
 */
export const STATUSES = ['进行中', '已完成', '已归档'] as const;
export type Status = (typeof STATUSES)[number];

// ────────────────────────────────────────────────────────────────
// 属性定义
// ────────────────────────────────────────────────────────────────
export type PropKind = 'single' | 'list' | 'date' | 'bool' | 'text';

export interface PropSpec {
  name: string;
  kind: PropKind;
  /** 封闭枚举（`来源` 没有值域，就是自由文本） */
  values?: readonly string[];
  /**
   * ⚠️ **v2 起不表示"必填"**（体检已退休）—— 唯一用途：`requiredFor()` → 小窗属性候选
   * 里"即使空着也显示"的那几个（类型/状态/tags 是每篇笔记的身份）。
   */
  required?: readonly NoteType[];
  /** 不允许手改 */
  readOnly?: boolean;
  /** 列表型 → 要自研多选控件 */
  multi?: boolean;
  hint?: string;
}

const ALL_TYPES = NOTE_TYPES;

export const SPECS: PropSpec[] = [
  { name: '类型', kind: 'single', values: NOTE_TYPES, required: ALL_TYPES, hint: '这篇是什么（笔记/任务/日志/模板/索引/指南/规范）' },
  { name: '状态', kind: 'single', values: STATUSES, required: ALL_TYPES, hint: '进行中 / 已完成 / 已归档' },
  {
    name: '文件位置',
    kind: 'list',
    multi: true,
    hint: '「这篇该在哪」的声明（相对库根）。留空 = 没声明过；填了 = 与它不符就报位置不一致',
  },
  {
    name: '创建日期',
    kind: 'date',
    readOnly: true,
    hint: '首次创建时间，不允许手改',
  },
  {
    name: 'tags',
    kind: 'list',
    multi: true,
    required: ALL_TYPES,
    hint: '只放横切标签（用户自己管，AI 不自动写）；**空数组是合法的**',
  },
  { name: '位置锁定', kind: 'bool', hint: 'true = 任何自动归位都不碰（但**不拦你显式发起的操作**）' },
  {
    name: '隐藏',
    kind: 'bool',
    hint: 'true = 主要列表/看板里淡出（看板「查看隐藏的文件」打开才回来）。**不是删除、也不是归档**',
  },
  /**
   * `收藏`（P7.2a §1.2 · M1，2026-10-03 用户拍板"新增 bool 属性"）：
   * 首页「收藏夹」的取数依据。选填 bool。右键笔记菜单里可切换（`modules/notes/menus.ts`）。
   */
  { name: '收藏', kind: 'bool', hint: 'true = 出现在首页「收藏夹」（右键笔记即可切换）' },
  /**
   * `来源`（P7.2c · 剪藏，2026-10-04 用户拍板"加回属性表"）：
   * 剪藏笔记的原网页地址（值 = URL）。选填。
   *
   * ⚠️ 历史：v0 曾把它列进"要删的旧键"（2026-09-24），P7.2c 做剪藏时**重新拍板加回**；
   * P7.12 拍定 ⑥「控制字段保留」再确认一次。别把它当"捡回一个被拍掉的键"再删第二次。
   */
  { name: '来源', kind: 'text', hint: '剪藏留下的原网页地址（选填）—— 普通笔记用不到它' },
];

export const SPEC_BY_NAME: Record<string, PropSpec> = Object.fromEntries(
  SPECS.map((s) => [s.name, s]),
);

/** 属性编辑器/表格列用的展示顺序 */
export const PROP_ORDER: string[] = SPECS.map((s) => s.name);

/** 解析失败或多余的键（P2 迁移删掉的四个，属性规范 §6.1） */
export const LEGACY_KEYS = ['主题', '标签', '仅显示于', '聚焦'];

/**
 * **五件套**（v2 定稿）——列排序时排在前面；board 的 META 跳过集合也以它为底。
 * 顺序即列顺序建议：类型 → 状态 → 文件位置 → 创建日期 → tags。
 */
export const CORE_PROPS = ['类型', '状态', '文件位置', '创建日期', 'tags'];

// ────────────────────────────────────────────────────────────────
// 按目录的默认值（P7.12 · #4「新建即配置」的唯一判据表）
// ────────────────────────────────────────────────────────────────
/**
 * 「新建在哪 → 预填什么」（用户 2026-10-06 拍定；`属性规范.md` §4.3 的表）。
 * 新建补全（`templates.ts` 的 `buildYaml`）按它给 类型/状态 兜底；
 * ⚠️ **00_Inbox 不写状态** —— "还在 Inbox"本身就是待整理。
 * 别的地方（含 04_Archives）只写 创建日期 + tags（类型拿不准就留空，AI 或你补）。
 */
export function defaultsForDir(dirRel: string): { 类型?: NoteType; 状态?: Status } {
  const d = String(dirRel ?? '').replace(/^\/+|\/+$/g, '');
  const under = (p: string): boolean => d === p || d.startsWith(`${p}/`);
  /**
   * P7.14：**库根顶层**（含「整个库」模式的顶层）—— 类型默认「笔记」（它是全值域的
   * 兜底值），**状态不写**（与 00_Inbox 同理：顶层散笔记还没归类）。
   * `文件位置`：P7.15 · #1 起顶层**也写**，值 = `.`（`ROOT_POS` 根标记）——
   * 原先"顶层无从表达 → 不写"的口径已被用户否掉，见 `ROOT_POS` 的注释。
   */
  if (d === '') return { 类型: '笔记' };
  if (d === '00_Inbox') return { 类型: '笔记' }; // 状态不写
  if (under('01_Projects')) return { 类型: '笔记', 状态: '进行中' };
  if (under('02_Areas/每日任务')) return { 类型: '任务', 状态: '进行中' };
  if (under('02_Areas')) return { 类型: '笔记', 状态: '进行中' };
  if (under('03_Resources')) return { 类型: '笔记', 状态: '进行中' };
  return {};
}

// ────────────────────────────────────────────────────────────────
// 语义色（方案设计.md §5.5 —— 一条色阶）
// 用**色点 + 常规色文字**，不单靠颜色（色盲可达）
// ────────────────────────────────────────────────────────────────
export const SEMANTIC_DOT: Record<string, string> = {
  进行中: 'c-yellow',
  已完成: 'c-green',
  已归档: 'c-faint',
};

export function dotClass(value: unknown): string {
  return SEMANTIC_DOT[String(value)] ?? 'c-faint';
}

// ────────────────────────────────────────────────────────────────
// 取值与判定
// ────────────────────────────────────────────────────────────────
export function asString(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : '';
  return String(v);
}

export function asList(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').map((x) => String(x));
  return [String(v)];
}

export function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

/** 值是否算「没填」（键在但值为空，等同没填；`tags` 例外：空数组合法） */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 该类型下"即使空着也显示"的属性清单（v2：不再是"必填"——见 `PropSpec.required`）。
 * 现在全类型同一份（类型/状态/tags），参数保留是为了调用点签名稳定。
 */
export function requiredFor(type: unknown): PropSpec[] {
  const t = asString(type) as NoteType;
  return SPECS.filter((s) => s.required?.includes(t));
}

/** 标题是不是占位名（`未命名` / `未命名 2` / `Untitled`）*/
export function isPlaceholderTitle(basename: string): boolean {
  return /^(未命名|未命名\s*\d+|Untitled(\s+\d+)?)$/i.test(basename.trim());
}

/** `位置锁定: true` —— 只拦自动归位，不拦显式操作 */
export function isPositionLocked(props: Record<string, unknown>): boolean {
  return asBool(props['位置锁定']);
}

/** `文件位置` 声明的第一条路径（相对库根；没声明则返回空串） */
export function declaredPosition(props: Record<string, unknown>): string {
  const list = asList(props['文件位置']).map((p) => p.replace(/^\/+|\/+$/g, ''));
  return list[0] ?? '';
}

/** 声明的全部路径（列表型，可能声明了多个可接受位置） */
export function declaredPositions(props: Record<string, unknown>): string[] {
  return asList(props['文件位置']).map((p) => normalizeDeclaredPos(p));
}

/**
 * **「库根」的声明标记 = `.`**（P7.15 · #1 用户拍定）。
 *
 * 为什么需要它：`文件位置` 的库内口径是"**相对库根**的目录"，而库根是空串 ——
 * 空串在 YAML 里没法当列表项写（`- ''` 在 Obsidian 原生属性面板里是个空 chip），
 * 顶层笔记因此**无从声明**（P7.14 记为"顶层不写"）。用户 2026-10-08 否了那条口径：
 * "要求保留此条属性，文件位置就写他目前的文件路径"。
 *
 * 表示法 = `.`（用户在手写 YAML 时也认这个）：**读**的时候在这个函数里统一映射成
 * 实际位置那一侧的空串口径（`vault-index` 的 `effectivePosition` 在库根 = `''`），
 * 所以「位置不一致」体检、AI 候选、mismatch 判定**都不需要各自认一遍点号**。
 * ⚠️ **写**的那一侧才落 `.`（`templates.buildYaml` / `mergeTemplateYaml`）。
 */
export const ROOT_POS = '.';

/**
 * 声明值归一：`. `（库根标记）→ `''`（实际位置口径）；两侧斜杠剥掉。
 * **唯一入口** —— `declaredPositions` 是全部读取方的门（体检 / AI / 归位 / 跟随）。
 */
export function normalizeDeclaredPos(p: string): string {
  const s = String(p ?? '').replace(/^\/+|\/+$/g, '');
  return s === ROOT_POS ? '' : s;
}

/** 给编辑器用的候选值（自由文本属性由全库聚合补充） */
export function candidatesFor(name: string, extra: string[] = []): string[] {
  const spec = SPEC_BY_NAME[name];
  const merged = spec?.values ? [...spec.values] : [];
  for (const e of extra) if (e && !merged.includes(e)) merged.push(e);
  return merged;
}

// ────────────────────────────────────────────────────────────────
// 前言「非标量（嵌套映射）」判据
// ────────────────────────────────────────────────────────────────
/**
 * **非标量前言值（嵌套映射）的键名**（17.2 起）—— 全仓库**唯一定义处**。
 *
 * ⚠️ **P7.16 从 `services/frontmatter.ts` 挪来这儿**（函数一字未改）：`core/vault-index.ts`
 * 的「坏前言」旗标（`fragile-fm`）也要跑同一份判据，而 vault-index 对 services 的依赖
 * 只开给**本文件**这一个口（它的文件头讲了为什么）—— 让 vault-index 去 import
 * frontmatter 会把它拖进 `ui/` 那条链。语义上这里也对：这是「属性值形状」的规范，
 * 与值域、判定函数同族。`frontmatter.ts` 仍是写口（守卫在那边调这一份）。
 *
 * 判据与 `migrate.ts` 当年的 `fragile` 一模一样（提公共 = 一字不改）：
 * 有值、是对象、且**不是数组**（`tags` / `文件位置` 这些列表是合法的，别误伤）。
 * `{{date}}` 这类占位符在真机 YAML 解析里就是对象（`{ '{ date }': null }` 的形状）。
 *
 * ⚠️ **读的是 `metadataCache`**（与全项目"属性一律问缓存"同一口径）——刚被外部
 * 写盘、缓存还没跟上（~300ms）的窗口存在，与别处一样接受。
 */
export function fragileKeys(props: Record<string, unknown>): string[] {
  return Object.entries(props)
    .filter(([, v]) => v != null && typeof v === 'object' && !Array.isArray(v))
    .map(([k]) => k);
}
