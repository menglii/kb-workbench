/**
 * modules/board/config.ts —— **看板配置**（库内 `99_Meta/06_工作台/看板配置.json`）
 *
 * 唯一真源原则（方案设计.md §3.1）：看板的全部配置（视图参数 + 板块）都在**这个库内文件**里，
 * 不在插件 `data.json`。理由：它可见、可手改、可 Git、跟着库走 —— **它就是导出物**
 * （决策 7：导入导出功能砍掉，复制这个文件即可）。
 *
 * ⚠️ **写这个文件的唯一入口是 `save()`**：设置面板的「看板默认值」栏也写同一份文件
 * （它只改 `view` 段），所以这里必须**原样保留不认识的键** —— 手写的注释键、
 * 将来别期加的段，都不能被看板一次保存弄丢。
 *
 * 形状（本期定稿，与 `交互规格.md` §4.1 那张表一一对应）：
 * ```jsonc
 * {
 *   "version": 1,
 *   "view": {
 *     ...BOARD_VIEW_DEFAULTS,          // core/config-files.ts 是唯一真源
 *     "props": ["状态", "平台"] | null, // 显示属性多选；null = 还没选过（取默认：前言前 5 个用户属性）
 *     "stripMarkers": ["## 关联笔记"],  // 自定义剥离标记（§4.3 可配）
 *     "sort": { "key": "名称", "dir": "asc" } | null,
 *     "collapsed": ["<板块 key>"],
 *     "manualOrder": { "<板块 key>": ["库内路径", …] }
 *   },
 *   "sections": [
 *     { "id": "s1a2b3", "name": "内容创作", "kind": "folder", "value": "02_Areas/内容创作",
 *       "exclude": [], "limit": null, "sort": null, "cardMode": null, "props": null }
 *   ]
 * }
 * ```
 * **板块级那三项 `null` = 继承看板级**（§4.3 的三态机制：继承 / 只内容 / 只属性 / 两者）。
 * **`id` 是稳定 id**：改名/改数据源都不换 —— 折叠状态与手动顺序都挂在它上面
 * （挂名字的话，改个名就把折叠状态丢了）。
 */
import type { WorkbenchContext } from '../../core/context';
import { BOARD_VIEW_DEFAULTS } from '../../core/config-files';
// 停靠的形状与解析在 `ui/dock.ts`（**唯一出处**）—— 那边是纯运算，离线可穷举
import { normalizeDock, normalizePeek, type DockState, type PeekDock } from '../../ui/dock';

// ────────────────────────────────────────────────────────────────
// 形状
// ────────────────────────────────────────────────────────────────
export type CardMode = 'content' | 'props' | 'both';
/** 板块形态（P4.5 §2.1）：列 = 并排的纵向列；流式 = 横排换行（老形态） */
export type BoardFlow = 'columns' | 'flow';
export const FLOW_LABEL: Record<BoardFlow, string> = {
  columns: '列（并排，各自纵向滚）',
  flow: '流式（横排换行）',
};
/** 四种数据源（「公式」源已随脱离 Bases 移除，§4.1） */
export type SectionKind = 'folder' | 'tag' | 'prop' | 'shelter';

export const SECTION_KIND_LABEL: Record<SectionKind, string> = {
  folder: '文件夹',
  tag: '标签',
  prop: '属性值',
  shelter: '收容所',
};

export interface SortSpec {
  /** '手动' | '名称' | '修改日期' | '大小' | 属性名 */
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * 卡片尺寸的取值范围（全局与板块级共用；Ctrl+滚轮缩放也夹在这个区间里）。
 * ⚠️ 上限从 480 提到 **720**（用户 2026-09-25：一屏看到的内容太少）——
 * 改这里要同步 `ui/settings/board.ts` 的拉杆与 `交互规格.md` §7.4/§8.1 那两个数字。
 */
export const CARD_W_MIN = 160;
/** 「两者」档下属性块的高度占比区间（拖动分隔条时夹在这个范围内） */
export const PROPS_RATIO_MIN = 0.15;
export const PROPS_RATIO_MAX = 0.85;
export const CARD_W_MAX = 720;
export const CARD_H_MIN = 160;
export const CARD_H_MAX = 900;

export interface BoardSection {
  id: string;
  name: string;
  kind: SectionKind;
  /** folder = 相对库根的目录；tag = 标签名；prop = 属性名；shelter = '' */
  value: string;
  /** 「排除」：不进本板块的路径或笔记（判据复用 `reconcile.isExcluded`） */
  exclude: string[];
  /** 显示上限；**默认 null = 不限**（它不是性能护栏，见 §8.2） */
  limit: number | null;
  /** 板块级排序覆盖（null = 继承看板级） */
  sort: SortSpec | null;
  /** 板块级显示档（null = 继承） */
  cardMode: CardMode | null;
  /** 板块级属性列覆盖（null = 继承） */
  props: string[] | null;
  /** 板块级**卡片宽度**覆盖（null = 继承看板级） */
  width: number | null;
  /**
   * 板块级**卡片高度**覆盖：`null` = 继承看板级；`>0` = 固定高度。
   * ⚠️ 板块级**没有"自动"这一档**（`0` 在这里被归一化成 `null`=继承）——
   * 想让某块回到自动，就把看板级也设成 0（`view.cardHeight` 那里 0 才有"自动"的含义）。
   */
  height: number | null;
}

/** 小窗属性档（§7.4 / §4.2 的 ⚙ 菜单三档） */
export type PanelPropsMode = 'few' | 'all' | 'none';
/** 小窗正文档（同上） */
export type PanelContentMode = 'editor' | 'preview' | 'none';

/**
 * **一篇笔记自己的小窗设置**（f 期第 3 条）。
 * 每个键都可缺省 = 跟随看板默认；全缺省的条目在 `normalizeView` 里会被**丢掉**
 * （表里不留空壳，`vault.on('rename')` 迁移时也就没有噪音）。
 */
export interface PanelPref {
  props?: PanelPropsMode;
  content?: PanelContentMode;
  /** 字号 px（0 = "没设过" → 用默认，所以这里只在 >0 时才写进来） */
  font?: number;
  /** 属性块占面板高度的比例（0.15–0.85） */
  ratio?: number;
  /**
   * **这一篇的预览换行**（P6b ⑥）：`true`/`false` 才写进来，缺省 = 跟随看板默认。
   * ⚠️ 它**不能**用"有/无"表达 —— 关掉换行本身就是一个要记住的选择。
   */
  wrap?: boolean;
}

/** 小窗字号的可设范围（`0` = 没设过 → 默认 = **平台 −2px**，是**另一档**，不在这个区间里） */
export const PANEL_FONT_MIN = 11;
export const PANEL_FONT_MAX = 24;

/**
 * **菜单里给的那几档字号**（`Ctrl+滚轮` 是连续的 ±1，这串是"点得中"的离散档）。
 *
 * 🔴 **唯一出处**（f 期独立审查 🟡3）：先前面板 ⚙ 菜单与看板工具条菜单**各写了一份**
 * 同一串数字，其中工具条那份还是裸写的 —— 将来改 `PANEL_FONT_MIN/MAX`（比如上限提到 30）时，
 * 那份会给到越界的档，而 `resolvePanelPref` 会**静默丢掉**它 → 症状正是"点了菜单没反应"。
 */
export const PANEL_FONT_STEPS: number[] = [13, 14, 15, 16, 17, 18, 20, 22, 24].filter(
  (px) => px >= PANEL_FONT_MIN && px <= PANEL_FONT_MAX,
);

export interface BoardView {
  cardMode: CardMode;
  /**
   * 板块形态：`columns`（默认）| `flow`。
   * ⚠️ **窄档是 CSS 强制的**（`.kbw-root[data-w="narrow"]` 下不套列形态）——
   * 形态在这里只表达"宽的时候要哪种"，别在 JS 里再判一次窄不窄（两处判迟早会漂）。
   */
  flow: BoardFlow;
  cardWidth: number;
  /** 卡片高度；**0 = 自动**（按内容/摘要行数），>0 = 固定高度（正文填满、内部滚动） */
  cardHeight: number;
  gap: number;
  /** 显示属性多选；null = 还没选过 → 用默认（前言前 5 个用户属性） */
  props: string[] | null;
  /**
   * **每一条笔记自己的比例**（路径 → 0.15–0.85）：拖卡片里那根分隔条写的就是这里
   * （用户 2026-09-25 第二版："我需要的是对**单条笔记**的设置"）。
   * 落在看板配置里而不是 frontmatter 里 —— 不往用户笔记里塞东西。
   * ⚠️ 路径会因为改名/搬移而变 → **必须跟着迁移**（`migrateOrder` 那条 `vault.on('rename')` 里一起做；
   * 挂"改名按钮"必漏入口，这是本项目的老账）。
   */
  propsRatioByPath: Record<string, number>;
  /**
   * **「两者」档下属性块占卡片高度的比例**（0.15–0.85）；`null` = 自动（按内容撑，现状）。
   * 这一份是**全局默认**：某条笔记没自己的值时用它（`Alt` + 拖分隔条写的就是它）。
   * 用户 2026-09-25 要的：属性和正文中间给一根可拖的分隔条，决定各自多高。
   * ⚠️ 百分比要**有确定的基准**才有意义 —— 卡片是自动高度时这个值不起作用（`flex-basis: %` 会退化成 auto），
   * 所以**第一次拖动分隔条时顺手把卡片锁成固定高度**（与 `Ctrl+滚轮` 那条同一套做法）。
   */
  propsRatio: number | null;
  /**
   * **悬浮小窗里显示多少属性**（= "藏不藏 YAML 头"，用户 2026-09-25 要的设置）：
   *   `few` = 前 6 行 + 「显示全部属性（N）」；`all` = 全铺；**`none`（C2 起的默认）= 整块不显示**。
   * ⚠️ 默认值是 `core/config-files.ts` 的 `BOARD_VIEW_DEFAULTS.panelProps`（唯一真源）；
   * 存量文件里那个 `few` 由 `migrateLegacyView()` 迁移，见那儿。
   */
  panelProps: PanelPropsMode;
  /**
   * **预览换行**（P6b ⑥）：卡片摘要与只读预览按它折行；每一篇可在面板 ⚙ 里覆盖
   *（`panelByPath[path].wrap`）。默认 true（见 `core/config-files.ts` 的同名项）。
   */
  previewWrap: boolean;
  /**
   * **小窗字号**（f 期第 2 条）：`0` = 没设过 → 默认（**平台 −2px**，C1 起，P6b ⑤ 降了一档）；>0 = 按这个 px。
   * 面板里 `Ctrl+滚轮` 写它；每一篇可单独覆盖（`panelByPath[path].font`）。
   */
  panelFont: number;
  /**
   * **小窗里属性块占面板高度的比例**（f 期第 5 条）：`null` = 自动（按内容撑，现状）。
   * 拖面板里那根分隔条写它；每一篇可单独覆盖（`panelByPath[path].ratio`）。
   */
  panelPropsRatio: number | null;
  /**
   * **每一条笔记自己的小窗设置**（f 期第 3 条）：路径 → 覆盖。
   * ⚠️ 路径会因为改名/搬移而变 → **跟着 `vault.on('rename')` 迁**（与 `propsRatioByPath`
   * 同一处迁移）。合成一份 map 的理由写在 `core/config-files.ts` 那条默认值上。
   */
  panelByPath: Record<string, PanelPref>;
  /** 面板钉住（d 期）：点外面不关，直到手动关 */
  panelPinned: boolean;
  /**
   * **停靠**（d2 期 §3.1）：面板钉在工作台的左 / 右 / 下，变成一条固定窗格。
   *
   * 三条口径（都在 d2 拍板）：
   *  · 它与 `panelPinned` 是**同一类**偏好（"这个面板该怎么待着"）→ 跨会话记住；
   *    **tab 列表仍然不进配置**（那是工作现场）。
   *  · 停靠 ≈ **恒钉住**：点了别处不关，直到手动取消停靠或关掉最后一篇。
   *  · **窄档（主区 <640px）退回浮层**：挤不下的容器里"钉在边上"没有意义。
   *    这条判定在 `ui/dock.ts` 的 `dockFit()` —— 那里也是"不会来回翻"的论证所在。
   */
  dock: DockState;
  /**
   * **预览窗格（Peek，e 期 §3.2）开着吗**。默认 **关**（拍板 Q2 的原话："要，默认关"）。
   *
   * §3.2 的原话："右侧常驻一个**只读预览**（跟着光标/当前卡片走），不打断手上的操作"。
   * 与 §12 决策 5 否掉的「Ctrl+悬停弹小窗」**不是一回事**（那一句的口径说明已按 Q2 补）：
   *   · 决策 5 否的是**弹窗**（依赖悬停、与"单击开小窗"重复）；
   *   · Peek 是**常驻窗格**（不依赖悬停、不打断任何操作），而且它只跟**键盘光标**
   *     （鼠标掠过时预览跟着变 = 打断正在做的事）。
   *
   * 与 `dock` 的关系：**同一个宿主的两种占用，互斥**（开一个收另一个）。
   */
  peekEnabled: boolean;
  /**
   * 预览窗格停在哪一边 / 多大。与 `dock` 共用 `ui/dock.ts` 的那套算术，
   * 只是**没有"不停靠"这一档**（想要没有它 → 关 `peekEnabled`）。
   */
  peek: PeekDock;
  /**
   * **小窗里怎么显示正文**（用户 2026-09-25 要的设置）：
   *   `editor`（默认）= 真编辑器，就地可编辑（P4 的老行为）；
   *   `preview` = **只读渲染**（剥前言 + 剥尾链 —— 想"藏 YAML / 藏结尾双链"就用它，
   *               因为真编辑器里那两段是文件的一部分，藏不掉）；
   *   `none` = 不显示正文（只改属性/标题）。
   */
  panelContent: 'editor' | 'preview' | 'none';
  allowDuplicate: boolean;
  hideEmpty: boolean;
  shelter: boolean;
  summaryLines: number;
  showHidden: boolean;
  /** 只读模式（§8.1）：打开后所有就地编辑停用（悬浮小窗、勾选框、拖动） */
  readonly: boolean;
  stripFrontmatter: boolean;
  stripTail: boolean;
  /** 自定义剥离标记（§4.3「自定义剥离标记 可配」） */
  stripMarkers: string[];
  /** 看板级排序（null = 名称升序） */
  sort: SortSpec | null;
  /**
   * **收起**着的顶级板块 key（在表里 = 收起）。
   * ⚠️ 子板块的方向**相反**，见 `openSubs` —— 这处不对称是有意的：
   * §4.1 定了「子板块默认收起」，而顶级板块默认展开。
   */
  collapsed: string[];
  /** **展开**着的子板块 key（在表里 = 展开；不在 = 收起，那是默认态） */
  openSubs: string[];
  /** 手动顺序：板块 key → 库内路径表（§4.4） */
  manualOrder: Record<string, string[]>;
}

export interface BoardConfig {
  version: number;
  view: BoardView;
  sections: BoardSection[];
}

/** 默认的尾部剥离标记（与模板产出的那一节同名） */
export const DEFAULT_STRIP_MARKERS = ['## 关联笔记'];

export const SORT_KEYS = ['手动', '名称', '修改日期', '大小'] as const;
export const CARD_MODE_LABEL: Record<CardMode, string> = {
  content: '只内容',
  props: '只属性',
  both: '两者',
};

// ────────────────────────────────────────────────────────────────
// 归一化（读回来的一律先过这里：手改坏的、缺字段的、多出来的键都要能活）
// ────────────────────────────────────────────────────────────────
function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v : d) as T;
}
function clampNum(v: unknown, min: number, max: number, d: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeSection(raw: unknown): BoardSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id).trim();
  const kind = oneOf<SectionKind>(o.kind, ['folder', 'tag', 'prop', 'shelter'], 'folder');
  const value = str(o.value).trim();
  /**
   * 收容所没有值；`tag` / `prop` 没值就是没配完 → 不建这种板块（界面上会是个永远空的怪板块）。
   * ⚠️ **`folder` + 空值是合法的**：= 整个库（`sources.inDir('')` 一直支持这个口径，
   * 而面板的目录候选第一项就是"（整个库）"）。早先在这里一刀切丢掉，症状是
   * **选「（整个库）」= 板块凭空消失 / 建了等于没建**（独立审查 R5）。
   */
  if (!id) return null;
  if (kind !== 'shelter' && kind !== 'folder' && !value) return null;
  const name =
    str(o.name).trim() ||
    (kind === 'shelter' ? '收容所' : value === '' ? '（整个库）' : value);
  const limitRaw = o.limit;
  return {
    id,
    name,
    kind,
    value: kind === 'shelter' ? '' : value,
    exclude: strList(o.exclude),
    limit:
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.round(limitRaw)
        : null,
    sort: normalizeSort(o.sort),
    cardMode:
      o.cardMode == null ? null : oneOf<CardMode>(o.cardMode, ['content', 'props', 'both'], 'content'),
    props: Array.isArray(o.props) ? strList(o.props) : null,
    width: numOrNull(o.width, CARD_W_MIN, CARD_W_MAX),
    height: numOrNull(o.height, CARD_H_MIN, CARD_H_MAX),
  };
}

/**
 * 属性/正文的比例（0.15–0.85）；缺省/越界/非法 → `null`（= 自动，按内容撑）。
 * 夹住两头是**故意的**：让任一块都能留出至少 ~15% 的高度，免得一拖就把另一边挤没。
 */
export function ratioOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(PROPS_RATIO_MAX, Math.max(PROPS_RATIO_MIN, v));
}

/** 可选的正数（缺省/非法 → null = 继承）；给板块级的宽高用 */
function numOrNull(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 可缺省的枚举：认不出就是 `undefined`（= 跟随上级），**不猜**成某一档 */
function pickOneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * 一条 `panelByPath` 条目 → `PanelPref`（纯函数，离线可穷举）。
 * 脏值（手改过 / 旧版本 / 另一台机器同步过来）一律**丢掉那一个键**，其余保留 ——
 * 整条丢掉的话用户其余的设置会跟着没。
 */
export function resolvePanelPref(raw: unknown): PanelPref {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PanelPref = {};
  const props = pickOneOf<PanelPropsMode>(o.props, ['few', 'all', 'none']);
  if (props) out.props = props;
  const content = pickOneOf<PanelContentMode>(o.content, ['editor', 'preview', 'none']);
  if (content) out.content = content;
  const font = Number(o.font);
  if (Number.isFinite(font) && font >= PANEL_FONT_MIN && font <= PANEL_FONT_MAX) {
    out.font = Math.round(font);
  }
  const ratio = ratioOrNull(o.ratio);
  if (ratio != null) out.ratio = ratio;
  // ⚠️ 只收**真的布尔**：`"false"`（手改过的字符串）一律当"没设过"，别让它跟着变成真
  if (typeof o.wrap === 'boolean') out.wrap = o.wrap;
  return out;
}

/**
 * 给**某一篇**的小窗设置打补丁（返回**新的** `panelByPath`，原对象不动）。
 *
 * 传 `null` 的键 = **清掉那一条覆盖**（回到"跟随看板默认"）—— 菜单里的
 * 「跟随看板默认」与分隔条双击恢复自动都走它。
 * 写进去之前过一遍 `resolvePanelPref`（与"读配置"同一条校验路）：
 * 空壳条目直接丢掉，表里不留"什么都没覆盖"的路径（免得改名迁移时搬一堆空对象）。
 */
export type PanelPrefPatch = {
  props?: PanelPropsMode | null;
  content?: PanelContentMode | null;
  font?: number | null;
  ratio?: number | null;
  wrap?: boolean | null;
};

export function withPanelPref(
  view: BoardView,
  path: string,
  patch: PanelPrefPatch,
): Record<string, PanelPref> {
  const merged = { ...(view.panelByPath?.[path] ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const clean = resolvePanelPref(merged);
  const next: Record<string, PanelPref> = { ...(view.panelByPath ?? {}) };
  if (Object.keys(clean).length > 0) next[path] = clean;
  else delete next[path];
  return next;
}

/** 整份 `panelByPath` → 干净的一份（空壳条目丢掉：表里不留"什么都没覆盖"的路径） */
export function normalizePanelByPath(raw: unknown): Record<string, PanelPref> {
  const out: Record<string, PanelPref> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!path) continue;
    const pref = resolvePanelPref(v);
    if (Object.keys(pref).length > 0) out[path] = pref;
  }
  return out;
}

export function normalizeSort(raw: unknown): SortSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const key = str(o.key).trim();
  if (!key) return null;
  return { key, dir: o.dir === 'desc' ? 'desc' : 'asc' };
}

export function normalizeView(raw: unknown): BoardView {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const manual: Record<string, string[]> = {};
  const ratioByPath: Record<string, number> = {};
  if (o.propsRatioByPath && typeof o.propsRatioByPath === 'object') {
    for (const [k, v] of Object.entries(o.propsRatioByPath as Record<string, unknown>)) {
      const r = ratioOrNull(v);
      if (r != null) ratioByPath[k] = r;
    }
  }
  const panelMap = normalizePanelByPath(o.panelByPath);
  if (o.manualOrder && typeof o.manualOrder === 'object') {
    for (const [k, v] of Object.entries(o.manualOrder as Record<string, unknown>)) {
      if (Array.isArray(v)) manual[k] = strList(v);
    }
  }
  return {
    cardMode: oneOf<CardMode>(o.cardMode, ['content', 'props', 'both'], BOARD_VIEW_DEFAULTS.cardMode),
    flow: oneOf<BoardFlow>(o.flow, ['columns', 'flow'], BOARD_VIEW_DEFAULTS.flow),
    cardWidth: clampNum(o.cardWidth, CARD_W_MIN, CARD_W_MAX, BOARD_VIEW_DEFAULTS.cardWidth),
    cardHeight: clampNum(o.cardHeight, 0, CARD_H_MAX, BOARD_VIEW_DEFAULTS.cardHeight),
    gap: clampNum(o.gap, 0, 64, BOARD_VIEW_DEFAULTS.gap),
    props: Array.isArray(o.props) ? strList(o.props) : null,
    propsRatio: ratioOrNull(o.propsRatio),
    propsRatioByPath: ratioByPath,
    // ⚠️ 兜底值**取常量**（不再写死 `'few'`）：P3 抓过"看板默认值有两份活代码"，
    // 这正是那一类 —— C2 把默认改成 `none` 时，写死的那一份会把它拉回旧默认
    panelProps: oneOf<'few' | 'all' | 'none'>(
      o.panelProps,
      ['few', 'all', 'none'],
      BOARD_VIEW_DEFAULTS.panelProps as 'few' | 'all' | 'none',
    ),
    panelFont: clampNum(o.panelFont, 0, PANEL_FONT_MAX, 0),
    panelPropsRatio: ratioOrNull(o.panelPropsRatio),
    previewWrap: bool(o.previewWrap, BOARD_VIEW_DEFAULTS.previewWrap),
    panelByPath: panelMap,
    panelPinned: o.panelPinned === true,
    /**
     * 停靠（d2 期 §3.1）。解析走 `ui/dock.ts` 的 `normalizeDock`（**唯一出处**）：
     * 认不出的边一律当"不停靠"，尺寸按当前边夹一次 —— 手改过 / 旧版本 / 另一台机器
     * 同步过来的脏值都在那一处收口。⚠️ **必须可缺省**（老配置里没有这个键）。
     */
    dock: normalizeDock(o.dock),
    // 预览窗格（e 期 §3.2）：`enabled` 默认关；落点走 normalizePeek（**不许是 null**）
    peekEnabled: o.peekEnabled === true,
    peek: normalizePeek(o.peek),
    panelContent: oneOf<'editor' | 'preview' | 'none'>(
      o.panelContent,
      ['editor', 'preview', 'none'],
      'editor',
    ),
    allowDuplicate: bool(o.allowDuplicate, BOARD_VIEW_DEFAULTS.allowDuplicate),
    hideEmpty: bool(o.hideEmpty, BOARD_VIEW_DEFAULTS.hideEmpty),
    shelter: bool(o.shelter, BOARD_VIEW_DEFAULTS.shelter),
    summaryLines: clampNum(o.summaryLines, 0, 10, BOARD_VIEW_DEFAULTS.summaryLines),
    showHidden: bool(o.showHidden, BOARD_VIEW_DEFAULTS.showHidden),
    readonly: bool(o.readonly, false),
    stripFrontmatter: bool(o.stripFrontmatter, BOARD_VIEW_DEFAULTS.stripFrontmatter),
    stripTail: bool(o.stripTail, BOARD_VIEW_DEFAULTS.stripTail),
    stripMarkers: Array.isArray(o.stripMarkers)
      ? strList(o.stripMarkers)
      : [...DEFAULT_STRIP_MARKERS],
    sort: normalizeSort(o.sort),
    collapsed: strList(o.collapsed),
    openSubs: strList(o.openSubs),
    manualOrder: manual,
  };
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

/**
 * 看板配置的**版本号**（写文件时带上；一次性迁移认它）。
 * v1 → v2：小窗「属性块」的默认从 `few` 改成 `none`（C2，见 `migrateLegacyView`）。
 */
export const BOARD_CONFIG_VERSION = 2;
/** v1 时代被物化进配置文件的那个默认值（迁移只认它） */
const LEGACY_PANEL_PROPS = 'few';

/**
 * 🔴 **一次性迁移**（C2，2026-09-27）：小窗属性块的默认 `few` → `none`。
 *
 * 为什么非要它：`normalizeView` 会给每个键**落一个具体值**，于是任何打开过看板的库
 * 都存着 `"panelProps": "few"` —— 那是**旧默认被物化**下来的，不是用户选的。
 * 只改常量的话，"改默认"在这些库上**一点效果都没有**（症状是"文档说改了、真机没变"）。
 *
 * 三条口径：
 *   · **只在读盘这一个入口做**（`BoardConfigStore.apply`）—— 写的时候那些值是用户刚选的，
 *     不能迁移（否则用户选 `few` 会被当场改回 `none`，又是"选了等于没选"）；
 *   · **认版本号**：文件里 `version >= 2` 就不再迁 —— 所以"用户后来真的选了 few"能留住
 *     （选择会经由 `save()` 把版本号写成 2，见那里同一常量）；
 *   · **只改这一个键**，别的原样（迁移越窄越不容易误伤）。
 */
export function migrateLegacyView(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = raw as Record<string, unknown>;
  const ver = typeof o.version === 'number' ? o.version : 1;
  if (ver >= BOARD_CONFIG_VERSION) return raw;
  const view = o.view;
  if (!view || typeof view !== 'object') return raw;
  const v = view as Record<string, unknown>;
  if (v.panelProps !== LEGACY_PANEL_PROPS) return raw;
  // 抹成 null → 由 `normalizeView` 的兜底给新默认（`BOARD_VIEW_DEFAULTS.panelProps`）
  return { ...o, view: { ...v, panelProps: null } };
}

export function normalizeBoard(raw: unknown): BoardConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sections: BoardSection[] = [];
  const seen = new Set<string>();
  let sawShelter = false;
  for (const s of Array.isArray(o.sections) ? o.sections : []) {
    const sec = normalizeSection(s);
    if (!sec) continue;
    if (seen.has(sec.id)) continue; // id 撞了：留第一个（手改出来的重复）
    // ⚠️ 收容所只认第一个：`planBoard` 里它固定排最后、只发一组，多建的几块
    // 在面板上各显示"没有命中"却永远画不出来（独立审查 10a）
    if (sec.kind === 'shelter') {
      if (sawShelter) continue;
      sawShelter = true;
    }
    seen.add(sec.id);
    sections.push(sec);
  }
  return { version: BOARD_CONFIG_VERSION, view: normalizeView(o.view), sections };
}

/** 板块 id：短、稳定、不随改名变。库里没有 crypto.randomUUID 的顾虑 → 时间戳 + 计数器 */
let seq = 0;
export function newSectionId(): string {
  seq += 1;
  return `s${Date.now().toString(36)}${seq.toString(36)}`;
}

// ────────────────────────────────────────────────────────────────
// 读写（唯一写点）
// ────────────────────────────────────────────────────────────────
export class BoardConfigStore {
  private ctx: WorkbenchContext;
  private data: BoardConfig = normalizeBoard(null);
  private rawExtra: Record<string, unknown> = {};
  /** 还没读过盘吗（首次渲染前要 read 一次） */
  private loaded = false;
  private listeners = new Set<() => void>();

  constructor(ctx: WorkbenchContext) {
    this.ctx = ctx;
  }

  get(): BoardConfig {
    return this.data;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 读一次。`ensure = true` 时**不存在就落盘**（"谁的期谁负责第一次落盘"——
   * 看板是 P4，所以第一次打开看板时它才出现；没打开过看板的人库里不该多这个文件）。
   */
  async load(ensure = false): Promise<BoardConfig> {
    const raw = ensure
      ? ((await this.ctx.configs.ensure('board')) as Record<string, unknown>)
      : ((await this.ctx.configs.read('board')) as Record<string, unknown>);
    this.apply(raw);
    this.loaded = true;
    return this.data;
  }

  private apply(raw: unknown): void {
    // 🔴 一次性迁移只在这一个入口（读盘）做 —— 见 `migrateLegacyView` 的注释
    this.data = normalizeBoard(migrateLegacyView(raw));
    // 不认识的键原样留着（手写的注释、别期加的段）
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    this.rawExtra = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'version' || k === 'view' || k === 'sections') continue;
      this.rawExtra[k] = v;
    }
  }

  /**
   * 写回。`patch` 是**整份 BoardConfig 的浅补丁**（view 段整体替换）。
   * ⚠️ 先 `read` 一遍再写：设置面板可能刚改过 `view`（它在另一个入口写同一份文件），
   * 拿内存里那份旧的全覆盖会把它的改动吞掉。
   */
  async save(patch: Partial<BoardConfig>): Promise<void> {
    /**
     * ⚠️ **先读一遍盘再合并**（注释承诺过、代码原先没做，独立审查 R7）：
     * 设置面板写的是**同一份文件的 `view` 段**，拿内存里那份旧 view 整段覆盖
     * 会把它的改动吞掉（窗口 = 面板写入 → 看板下一次 save 之间）。
     */
    try {
      const disk = (await this.ctx.configs.read('board')) as Record<string, unknown>;
      this.apply(disk);
    } catch (e) {
      console.error('[经纬] 保存看板配置前重读失败（按内存里那份继续）', e);
    }
    const merged: BoardConfig = {
      version: BOARD_CONFIG_VERSION,
      view: patch.view ? normalizeView(patch.view) : this.data.view,
      sections: patch.sections ? normalizeBoard({ sections: patch.sections }).sections : this.data.sections,
    };
    this.data = merged;
    this.loaded = true;
    await this.ctx.configs.write('board', {
      ...this.rawExtra,
      version: BOARD_CONFIG_VERSION,
      view: merged.view,
      sections: merged.sections,
    });
    this.emit();
  }

  /**
   * 「看板默认值」那种只改 view 一段的保存。
   * `extra` 给"**要同时改 view 与别的段**"用（P4.5：卡片上移一次要同时写
   * `view.manualOrder` 与 `sections[].sort`）—— 分两次写会多出一次重画，
   * 中间那一帧是"手动档 + 旧顺序"，界面上看着是卡片先乱跳一下再归位。
   */
  async patchView(patch: Partial<BoardView>, extra: Partial<BoardConfig> = {}): Promise<void> {
    await this.save({ ...extra, view: { ...this.data.view, ...patch } });
  }

  /** 配置被外面改了（手改文件 / 设置面板）→ 重读并通知 */
  watchExternal(): () => void {
    return this.ctx.configs.watch('board', (raw) => {
      this.apply(raw);
      if (!this.loaded) this.loaded = true;
      this.emit();
    });
  }

  private emit(): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn();
      } catch (e) {
        console.error('[经纬] 看板配置订阅者出错', e);
      }
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// ────────────────────────────────────────────────────────────────
// 查询辅助
// ────────────────────────────────────────────────────────────────
export function sectionById(cfg: BoardConfig, id: string): BoardSection | undefined {
  return cfg.sections.find((s) => s.id === id);
}

/** 生效的显示档（板块级覆盖看板级） */
export function effectiveCardMode(cfg: BoardConfig, sec: BoardSection | null): CardMode {
  return sec?.cardMode ?? cfg.view.cardMode;
}

/** 生效的属性列（板块级覆盖看板级；null = 还没选过 → 由调用方按默认算） */
export function effectiveProps(cfg: BoardConfig, sec: BoardSection | null): string[] | null {
  return sec?.props ?? cfg.view.props;
}

/** 生效的排序（板块级覆盖看板级） */
export function effectiveSort(cfg: BoardConfig, sec: BoardSection | null): SortSpec | null {
  return sec?.sort ?? cfg.view.sort;
}

/** 板块/子板块的 key（折叠状态与手动顺序都挂它） */
export function groupKey(sectionId: string, sub = ''): string {
  return sub ? `${sectionId}::${sub}` : sectionId;
}

/**
 * 这一组现在是收起的吗。
 * ⚠️ **顶级板块与子板块的默认态相反**（§4.1：子板块默认收起）：
 *   · 顶级：在 `collapsed` 里才是收起
 *   · 子板块：不在 `openSubs` 里就是收起
 * 所以要传 `sub` —— 少传一个参数的症状是"子板块默认全摊开"。
 */
export function isCollapsed(cfg: BoardConfig, key: string, sub = false): boolean {
  return sub ? !cfg.view.openSubs.includes(key) : cfg.view.collapsed.includes(key);
}

/** 这个板块有没有"自己的覆盖"（重置菜单据此置灰，§8.2） */
export function hasOverride(sec: BoardSection): boolean {
  return (
    sec.cardMode != null ||
    sec.props != null ||
    sec.sort != null ||
    sec.width != null ||
    sec.height != null
  );
}

/** 生效的卡片宽度（板块级覆盖看板级） */
export function effectiveWidth(cfg: BoardConfig, sec: BoardSection | null): number {
  return sec?.width ?? cfg.view.cardWidth;
}

/** 生效的卡片高度（0 = 自动；板块级覆盖看板级） */
export function effectiveHeight(cfg: BoardConfig, sec: BoardSection | null): number {
  return sec?.height ?? cfg.view.cardHeight;
}

// ────────────────────────────────────────────────────────────────
// 小窗（面板）的生效值 —— 每一个都是"**这一篇的覆盖 → 看板默认**"（f 期第 3 条）
// ────────────────────────────────────────────────────────────────
/**
 * 🔴 这四个函数是**唯一出处**：面板画属性块 / 正文块 / 字号 / 分隔条比例时都必须走它们。
 * 各写一遍 `cfg.view.panelProps` 的话，"每篇覆盖"那条路必然有几处漏掉 ——
 * 而漏掉的那处**看起来一切正常**（只是那一篇的设置不生效）。
 */
export function panelPrefOf(cfg: BoardConfig, path: string): PanelPref {
  return cfg.view.panelByPath?.[path] ?? {};
}

/** 这一篇的小窗属性档（覆盖 → 看板默认） */
export function panelPropsFor(cfg: BoardConfig, path: string): PanelPropsMode {
  return panelPrefOf(cfg, path).props ?? cfg.view.panelProps;
}

/** 这一篇的小窗正文档（覆盖 → 看板默认） */
export function panelContentFor(cfg: BoardConfig, path: string): PanelContentMode {
  return panelPrefOf(cfg, path).content ?? cfg.view.panelContent;
}

/** 这一篇的小窗字号（px；**0 = 没设过 → 默认（平台 −2px）**） */
export function panelFontFor(cfg: BoardConfig, path: string): number {
  return panelPrefOf(cfg, path).font ?? cfg.view.panelFont;
}

/** 这一篇的小窗属性/正文比例（`null` = 自动） */
export function panelRatioFor(cfg: BoardConfig, path: string): number | null {
  return panelPrefOf(cfg, path).ratio ?? cfg.view.panelPropsRatio;
}

/**
 * **这一篇的预览换行**（P6b ⑥）：这一篇设过就按它，否则跟随看板默认。
 * ⚠️ 判据是 `typeof === 'boolean'`（**不能**写 `?? cfg.view.previewWrap` ——
 * `wrap: false` 是"显式关掉"，用 `??` 的话它会被当成"没设过"而回落到默认 true，
 * 症状正是"点了关闭换行，还是折行"）。
 */
export function panelWrapFor(cfg: BoardConfig, path: string): boolean {
  const own = panelPrefOf(cfg, path).wrap;
  return typeof own === 'boolean' ? own : cfg.view.previewWrap;
}

/** 数据源的一句话描述（面板与菜单上显示） */
export function describeSource(sec: BoardSection): string {
  if (sec.kind === 'shelter') return '收容所（哪条规则都没命中的笔记）';
  if (sec.kind === 'folder') return `文件夹：${sec.value}`;
  if (sec.kind === 'tag') return `标签：${sec.value}`;
  return `属性值：${sec.value}`;
}
