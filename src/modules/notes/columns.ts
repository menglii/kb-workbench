/**
 * modules/notes/columns.ts —— 表格的列定义与单元格渲染（交互规格 §3.3）
 *
 * 列分三类：
 *   · 固定三列：**标记**（六种健康标记的真源见 `core/vault-index.ts`）、**名称**（不可隐藏）、
 *     **修改时间 / 大小**
 *   · schema 列：`属性规范.md` 里的属性（值域/多选/只读都由 `services/schema.ts` 说了算）
 *   · 自定义列：前言里出现过、schema 里没有的键（迁移期常见，自动补一列）
 *
 * 值渲染统一走这里，是为了**一处决定"空值长什么样"**：空值一律 `—` 且降低对比度，
 * 不显示 `undefined`、也不显示空白格（空白格看起来像"坏了"）。
 */
import type { HealthFlag, NoteEntry } from '../../core/vault-index';
import { FLAG_META } from '../../core/vault-index';
import { CORE_PROPS, SPECS, SPEC_BY_NAME, asBool, asList, asString, dotClass, fragileKeys } from '../../services/schema';
import { formatBytes, formatRelativeTime } from '../../core/util';
import { div, el, span } from '../../ui/primitives';
import type { Column } from '../../ui/table';

/** 六种标记的悬停说明（交互规格 §3.3 的表；「缺项」v2 退休 · 「坏前言」P7.16 加） */
export const FLAG_HOVER: Record<HealthFlag, string> = {
  'position-mismatch': '属性「文件位置」写的位置与实际目录不一致',
  'broken-link': '指向的笔记不在库里',
  'placeholder-title': '标题还是「未命名」',
  'empty-file': '文件是空的',
  'external-change': '别处改过，还没合并',
  'fragile-fm': '前言里有嵌套值（多半是没加引号的占位符）—— 插件不敢写它',
};

/** 类名对齐 `styles/components.css` 里既有的 `.kbw-flag.flag-*`（别另起一套色） */
export const FLAG_LEVEL: Record<HealthFlag, string> = {
  'position-mismatch': 'flag-red',
  'broken-link': 'flag-red',
  'placeholder-title': 'flag-yellow',
  'empty-file': 'flag-yellow',
  'external-change': 'flag-purple',
  'fragile-fm': 'flag-yellow',
};

/**
 * 「标记」列里的**短词**（P7.7c · 10.5，词表是拍板件 —— 别改词）：
 * `⚠` 字形对六种标记完全一样、差异只在色相上（WCAG 1.4.1「只靠颜色」的候选），
 * 换成短词后**字形即语义**，轻重继续由 `.kbw-flag` 的 16% 淡底色相承担。
 * 悬停 `title` 里仍是全句（`flagDetail()` / `FLAG_HOVER`，信息不丢）。
 * ⚠️ v2：「缺项」随缺必填退休（P7.12）。
 */
export const FLAG_SHORT: Record<HealthFlag, string> = {
  'position-mismatch': '错位',
  'broken-link': '断链',
  'placeholder-title': '未名',
  'empty-file': '空文',
  'external-change': '外改',
  /**
   * 拍定短词 = 「坏前言」（P7.16 · Q3，唯一一枚三字 —— 两字表不下且"前言"是关键词；
   * 列宽按"最多两三枚短词"重算过，装不下只调列宽不调词）。
   */
  'fragile-fm': '坏前言',
};

/** 标记列那一格的悬停文案：写清「哪一条、为什么」 */
export function flagDetail(entry: NoteEntry, flag: HealthFlag): string {
  const base = FLAG_HOVER[flag];
  if (flag === 'position-mismatch') {
    const declared = asList(entry.props['文件位置']).join('、');
    return `位置不一致：属性写的是「${declared || '（空）'}」，实际在「${entry.effectivePosition || '库根'}」`;
  }
  if (flag === 'placeholder-title') return `标题还是「${entry.basename}」`;
  if (flag === 'empty-file') return '文件是 0 字节';
  // 坏前言：点名坏在哪个键（与守卫报的是同一份判据）——修法在「首页 → 待处理 → 坏前言」
  if (flag === 'fragile-fm') {
    const keys = fragileKeys(entry.props);
    return `前言里的「${keys.join('、')}」是嵌套值 —— 插件不敢动这一篇（修法：首页待处理 → 修前言）`;
  }
  return base;
}

/** 排序取值（表格列与筛选引擎共用同一份） */
export function sortValueOf(entry: NoteEntry, key: string): string | number | null {
  if (key === 'name') return entry.basename;
  if (key === 'mtime') return entry.mtime;
  if (key === 'size') return entry.size;
  if (key.startsWith('prop:')) {
    const v = entry.props[key.slice(5)];
    if (v == null || v === '') return null;
    return asString(v);
  }
  return null;
}

const DOT_PROPS = ['状态'];

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 空值格「—」（导出给 `index.ts` 的文件夹行用 —— "空值长什么样"只许有一处口径） */
export function emptyCell(): HTMLElement {
  return span({ cls: 'kbw-cell-empty', text: '—' });
}

function listCell(values: string[]): HTMLElement {
  const wrap = div({ cls: 'kbw-chips' });
  for (const v of values.slice(0, 3)) wrap.appendChild(span({ cls: 'kbw-chip is-small', text: v }));
  if (values.length > 3) wrap.appendChild(span({ cls: 'kbw-chip is-small is-more', text: `+${values.length - 3}` }));
  return wrap;
}

function propCell(entry: NoteEntry, name: string): HTMLElement | string {
  const spec = SPEC_BY_NAME[name];
  const v = entry.props[name];
  if (isEmpty(v)) return emptyCell();
  if (spec?.kind === 'bool') {
    return span({ cls: asBool(v) ? 'kbw-cell-on' : 'kbw-cell-off', text: asBool(v) ? '是' : '否' });
  }
  if (spec?.multi || Array.isArray(v)) {
    const list = asList(v);
    return list.length === 0 ? emptyCell() : listCell(list);
  }
  const text = asString(v);
  if (DOT_PROPS.includes(name)) {
    const wrap = div({ cls: 'kbw-dotcell' });
    wrap.appendChild(span({ cls: ['kbw-dot', dotClass(text)] }));
    wrap.appendChild(span({ text }));
    return wrap;
  }
  /** 日期类列（创建日期 / 目标发布日 / 截止日期）：等宽数字 —— 竖排要对齐（P7.7c · 顺路收四笔） */
  if (spec?.kind === 'date') return span({ cls: 'kbw-tabnum', text });
  return text;
}

function flagsCell(entry: NoteEntry): HTMLElement {
  const wrap = div({ cls: 'kbw-flagcell' });
  if (entry.isTemplate) {
    wrap.appendChild(span({ cls: 'kbw-chip is-small is-more', text: '模板' }));
    return wrap;
  }
  if (entry.flags.length === 0) {
    wrap.appendChild(span({ cls: 'kbw-cell-empty', text: '—' }));
    return wrap;
  }
  for (const flag of entry.flags) {
    wrap.appendChild(
      span({
        cls: ['kbw-flag', FLAG_LEVEL[flag]],
        text: FLAG_SHORT[flag],
        /** #7（P7.12）：**只挂 aria-label 不挂 title** —— 双挂 = 双提示框（实拍 FB4-现状-8） */
        attr: { 'aria-label': flagDetail(entry, flag) },
      }),
    );
  }
  return wrap;
}

/**
 * 文件夹行「标记」格的聚合数据（P7.1c，用户 2026-10-03 加条）。
 * 口径与 `foldersFor` 的计数同源：**整棵子树（含子目录）**，模板不计（`entries()` 已排除）。
 */
export interface FolderHealth {
  /** 子树里的笔记数 */
  notes: number;
  /** 其中带健康标记的篇数 */
  flagged: number;
  /** 标记 → 条数（一篇可带多个） */
  flags: Map<HealthFlag, number>;
}

/** 严重度从重到轻（取色与明细排序都吃它）——与 `FLAG_META.level` 同一套词 */
const LEVEL_ORDER: ('red' | 'yellow' | 'purple')[] = ['red', 'yellow', 'purple'];

/**
 * 文件夹行「标记」格（P7.1c 拍板；P7.7c · 10.5 换短词）：
 *   · **子树 0 篇** → 「空」（悬停全句保留了原拍板的「文件夹里还没有笔记」——
 *     空目录也是要留意的一件事：填内容或删掉它）；
 *   · **有带标记的笔记** → 「待整理」，按**最重级别**上色（红 > 黄 > 紫，与笔记行六色语言同源），
 *     悬停写「N 篇需要处理」+ 各类条数；
 *   · **有笔记且都干净** → 「—」（与笔记行"没标记就画横杠"完全同款）。
 */
export function folderFlagsCell(h: FolderHealth | undefined): HTMLElement {
  const wrap = div({ cls: 'kbw-flagcell' });
  if (!h || h.notes === 0) {
    const label = '文件夹里还没有笔记';
    /** #7（P7.12）：只挂 aria-label（同款双提示根治） */
    wrap.appendChild(span({ cls: ['kbw-flag', 'flag-yellow'], text: '空', attr: { 'aria-label': label } }));
    return wrap;
  }
  if (h.flagged === 0 || h.flags.size === 0) {
    wrap.appendChild(emptyCell());
    return wrap;
  }
  let level: 'red' | 'yellow' | 'purple' = 'purple';
  outer: for (const lv of LEVEL_ORDER) {
    for (const f of h.flags.keys()) {
      if (FLAG_META[f].level === lv) {
        level = lv;
        break outer;
      }
    }
  }
  const breakdown = Array.from(h.flags.entries())
    .sort((a, b) => LEVEL_ORDER.indexOf(FLAG_META[a[0]].level) - LEVEL_ORDER.indexOf(FLAG_META[b[0]].level))
    .map(([f, n]) => `${FLAG_META[f].label} ×${n}`)
    .join('、');
  const label = `子树里有 ${h.flagged} 篇需要处理：${breakdown}`;
  wrap.appendChild(
    span({
      cls: ['kbw-flag', `flag-${level}`],
      text: '待整理',
      /** #7（P7.12）：只挂 aria-label（同款双提示根治） */
      attr: { 'aria-label': label },
    }),
  );
  return wrap;
}

function nameCell(entry: NoteEntry): HTMLElement {
  const wrap = div({ cls: 'kbw-namecell' });
  wrap.appendChild(span({ cls: 'kbw-name', text: entry.basename, title: entry.path }));
  if (asBool(entry.props['隐藏'])) {
    wrap.appendChild(span({ cls: 'kbw-chip is-small is-more', text: '已隐藏', title: '隐藏: true' }));
  }
  if (asBool(entry.props['位置锁定'])) {
    wrap.appendChild(span({ cls: 'kbw-chip is-small is-more', text: '锁定', title: '位置锁定: true' }));
  }
  return wrap;
}

/**
 * 行首的复选框。
 * ⚠️ 勾选态由模块在重画后统一刷（`paintSelection`）——列定义拿不到选中集合，
 * 也不该拿：列是"怎么显示"，选中是"状态"。
 *
 * ⚠️ v2 · #5（P7.12）：**模板行不画复选框**（选择集 / 批量栏照旧排除模板）——
 * 看得见（行 + 计数），但不可被批量操作。占位空格照留（列宽不跳）。
 */
function checkCell(entry: NoteEntry): HTMLElement {
  if (entry.isTemplate) return span({ cls: 'kbw-cell-empty', text: '' });
  return el('input', {
    cls: 'kbw-rowcheck',
    attr: { type: 'checkbox', 'aria-label': `选择 ${entry.basename}`, 'data-path': entry.path },
  });
}

const CHECK_COL = (): Column<NoteEntry> => ({
  id: 'check',
  label: '',
  width: 34,
  fixed: true,
  title: '选择这一行',
  render: (e) => checkCell(e),
});

/**
 * 默认隐藏的列（界面上只留最常看的几列；全开在「列」菜单里）。
 * ⚠️ **必须是完整的列 id**：属性列的 id 是 `prop:<属性名>`，写成裸属性名
 * 就会一个都匹配不上 —— 症状是"默认摊开 25 列、表格 3126px 宽"（真机探针抓到过）。
 */
export const DEFAULT_HIDDEN: string[] = [
  'prop:创建日期',
  'prop:tags',
  'prop:文件位置',
  'prop:位置锁定',
  'prop:隐藏',
  // P7.2a：`收藏` 是低频标记（与「位置锁定 / 隐藏」同待遇）—— 默认隐藏
  'prop:收藏',
  /**
   * P7.2c：`来源` 是剪藏留下的 URL（选填、只有剪藏笔记才填）—— 默认隐藏。
   * ⚠️ 与「收藏」同款：这只服务"从没动过列"的用户，
   * 物化过 `columnsHidden` 的由 `SETTINGS_VERSION` 3→4 那段迁移补（`migrateSettings`）。
   */
  'prop:来源',
  'size',
];

/**
 * 某一批笔记的"默认隐藏列" = 固定的那 15 个 + **全部自定义属性列**。
 * 自定义键在迁移期很常见（`主题`/`标签`/`仅显示于`…），一上来就摊开会把表格撑得很宽。
 */
export function defaultHiddenFor(entries: NoteEntry[]): string[] {
  return [...DEFAULT_HIDDEN, ...customPropsOf(entries).map((n) => `prop:${n}`)];
}

/**
 * 默认可见的列（离线断言钉住它，别让默认显隐悄悄漂）。
 * ⚠️ **v2 起是 6 列**：「领域」随领域退役移除（P7.12）；与 `DEFAULT_HIDDEN`
 * **互为补集**（加上自定义属性列），改一边要对着另一边看。
 */
export const DEFAULT_VISIBLE_IDS = [
  'check',
  'flags',
  'name',
  'prop:类型',
  'prop:状态',
  'mtime',
] as const;

/** schema 里的属性列顺序：核心层在前，其余按 PROP_ORDER */
function schemaColumnOrder(): string[] {
  const core = SPECS.filter((s) => CORE_PROPS.includes(s.name)).map((s) => s.name);
  const rest = SPECS.map((s) => s.name).filter((n) => !core.includes(n));
  return [...core, ...rest];
}

/** 前言里出现过、schema 里没有的键（迁移期常见 → 自动补一列） */
export function customPropsOf(entries: NoteEntry[]): string[] {
  const known = new Set(SPECS.map((s) => s.name));
  const found = new Set<string>();
  for (const e of entries) {
    for (const k of Object.keys(e.props)) {
      if (known.has(k)) continue;
      if (k === 'position') continue;
      if (isEmpty(e.props[k])) continue;
      found.add(k);
    }
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b, 'zh'));
}

export function buildColumns(entries: NoteEntry[]): Column<NoteEntry>[] {
  const cols: Column<NoteEntry>[] = [
    CHECK_COL(),
    {
      id: 'flags',
      label: '标记',
      /**
       * 宽度按「最多两三枚短词」重算（P7.7c · 10.5，原先 72px 只够画 2–3 个 `⚠`）：
       * 一枚 2 字胶囊 = 5 + 11×2 + 5 = 32px，加 3px 间距 → 三枚 = 102px；
       * 单元格内边距左右各 10px（`notes.css` 的 `td` 规则）→ 102 + 20 = 122，**取 124**（亚像素取整的余量）。
       * 超过三枚（如「错位+缺项+未名+空文」四连）沿既有行为**裁切**（td 是 `overflow:hidden`，改前也一样）——
       * 词是拍板件，塞不下只调列宽、不动词。
       */
      width: 124,
      title: '健康标记：错位＝位置不一致 / 断链＝失效双链（红）· 未名＝占位标题 / 空文＝空文件 / 坏前言＝前言里有嵌套映射（黄）· 外改＝外部改动（紫）',
      render: (e) => flagsCell(e),
    },
    {
      id: 'name',
      label: '名称',
      width: 260,
      minWidth: 120,
      fixed: true,
      sortValue: (e) => sortValueOf(e, 'name') ?? '',
      render: (e) => nameCell(e),
    },
  ];

  for (const name of schemaColumnOrder()) {
    const spec = SPEC_BY_NAME[name];
    cols.push({
      id: `prop:${name}`,
      label: name,
      width: spec?.kind === 'date' ? 110 : 130,
      title: spec?.readOnly ? `${name}（只读，不允许手改）` : spec?.hint,
      sortValue: (e) => sortValueOf(e, `prop:${name}`) ?? '',
      render: (e) => propCell(e, name),
    });
  }

  for (const custom of customPropsOf(entries)) {
    cols.push({
      id: `prop:${custom}`,
      label: custom,
      width: 130,
      title: `${custom}（自定义属性）`,
      sortValue: (e) => sortValueOf(e, `prop:${custom}`) ?? '',
      render: (e) => propCell(e, custom),
    });
  }

  cols.push(
    {
      id: 'mtime',
      label: '修改时间',
      width: 130,
      sortValue: (e) => e.mtime,
      render: (e) => (e.mtime ? formatRelativeTime(e.mtime) : '—'),
    },
    {
      id: 'size',
      label: '大小',
      width: 90,
      align: 'right',
      sortValue: (e) => e.size,
      render: (e) => formatBytes(e.size),
    },
  );
  return cols;
}

/** 「列」菜单里给用户看的名字 */
export function columnLabel(cols: Column<NoteEntry>[], id: string): string {
  return cols.find((c) => c.id === id)?.label ?? id;
}
