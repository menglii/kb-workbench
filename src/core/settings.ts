/**
 * core/settings.ts —— 插件 data.json（**界面偏好**，不是知识库配置）
 *
 * 唯一真源原则（方案设计.md §3.1）：
 *   知识库层面的配置一律在库内文件（`core/config-files.ts` 管三个 JSON）；
 *   这里只放"这台机器 / 这个界面"的东西——模块开关、当前模块、键位、忽略项。
 *
 * ⚠️ `saveData` 会**静默吞掉失败**（吞 ENOENT，platform-pitfalls #16）→ 写完回读校验。
 */
import type { Plugin } from 'obsidian';
/**
 * ⚠️ `naming.ts` 反过来只 import 本文件的**类型**（`import type` 会被擦除）——
 * 运行时没有环（下面 `namingTemplate` 那条 case 用它的校验）。
 */
import { isNamingTemplateOk } from './naming';
// P7.14：metaRoot 走 joinPath（kbRoot='' = 整个库时不再产出 `/99_Meta` 前导斜杠）
import { joinPath, normPath } from './paths';

// ────────────────────────────────────────────────────────────────
// 模块与开关
// ────────────────────────────────────────────────────────────────
export type ModuleId = 'home' | 'notes' | 'board' | 'graph' | 'review';

/**
 * **新手清单的「动作点」id**（P7.2d · 16.13）—— `onboarding` 数组的合法值。
 * ⚠️ **第 1 项（走完向导）不在这张表里**：它直接读 `wizardDone` 三态
 *（"重置"之后仍然打勾 —— 向导是真走过了，没有"取消走过"这回事）。
 * 四项的完整定义（含第 1 项、文案、点击去向）在 `modules/home/onboarding.ts`，
 * 那边 import 这张表 —— **别在别处再描一份**。
 */
export const ONBOARDING_IDS = ['created', 'view', 'search'] as const;
export type OnboardingId = (typeof ONBOARDING_IDS)[number];
export type FeatureId = ModuleId | 'automation' | 'completion';

/** ⚠️ 新栏**加在末尾**（插中间会让按索引取栏的用例全漂 —— `'review'` 就是加在末尾的，P8） */
export const MODULE_IDS: ModuleId[] = ['home', 'notes', 'board', 'graph', 'review'];

export interface ModuleMeta {
  id: ModuleId;
  label: string;
  icon: string;
  /** 可开关（图谱核心插件被关掉时要能整栏禁用；其余模块常驻） */
  toggleable: boolean;
  /** 该模块落在哪一期（P0 的占位区与开发面板都要显示） */
  round: string;
}

export const MODULES: Record<ModuleId, ModuleMeta> = {
  home: { id: 'home', label: '首页', icon: 'home', toggleable: false, round: 'P1' },
  notes: { id: 'notes', label: '全部笔记', icon: 'list', toggleable: false, round: 'P1' },
  board: { id: 'board', label: '看板', icon: 'layout-grid', toggleable: false, round: 'P4' },
  graph: { id: 'graph', label: '图谱', icon: 'share-2', toggleable: true, round: 'P6' },
  // 回顾常驻（`toggleable: false`）：该字段的原义是"依赖外部核心插件时才需要整栏禁用"，回顾不依赖任何核心插件
  review: { id: 'review', label: '回顾', icon: 'repeat', toggleable: false, round: 'P8' },
};

export interface FeatureMeta {
  id: FeatureId;
  label: string;
  desc: string;
  round: string;
}

export const FEATURES: Record<FeatureId, FeatureMeta> = {
  graph: { id: 'graph', label: '图谱', desc: '工作台里的图谱栏（走 Obsidian 官方图谱）', round: 'P6' },
  automation: {
    id: 'automation',
    label: '自动化',
    desc: '自动归位与目录映射。默认关：只有显式改「文件位置」属性才搬',
    round: 'P3',
  },
  completion: {
    id: 'completion',
    label: '新建笔记补全',
    desc: '新建空白笔记时按模板补前言与尾部双链',
    round: 'P3',
  },
  home: { id: 'home', label: '首页', desc: '工作台的开始界面', round: 'P1' },
  notes: { id: 'notes', label: '全部笔记', desc: '目录树 + 两档视图 + 批量操作', round: 'P1' },
  board: { id: 'board', label: '看板', desc: '自绘看板', round: 'P4' },
  review: { id: 'review', label: '回顾', desc: '从笔记派生问答卡，按间隔安排复习', round: 'P8' },
};

// ────────────────────────────────────────────────────────────────
// 设置形状
// ────────────────────────────────────────────────────────────────
/**
 * 全部笔记的视图档（交互规格 §3.2）。
 * P1 只有「详细信息 / 紧凑」，**网格档是 P6 补的**；**P7.1 起两档化 = 详细信息 / 网格**
 *（删掉「名称+时间」档 —— 存量 `'compact'` 由 `migrateSettings()` 迁成 `'detail'`）。
 * 同一条解析口径：`resolveNotesView()`。
 */
export type NotesView = 'detail' | 'grid';
/** 网格档的排序键（§3.5 的排序下拉**只有这三项**，与表格的任意列 id 不是一回事） */
export type GridSortKey = 'name' | 'mtime' | 'size';
export const GRID_SORT_KEYS: GridSortKey[] = ['name', 'mtime', 'size'];
/** 搜索范围（交互规格 §3.6） */
export type SearchScope = 'all' | 'title' | 'prop' | 'tag';

export interface WorkbenchSettings {
  /**
   * **插件设置的版本号**（17.1，P7.0b）。`data.json` 顶层，跟着 `migrateSettings()` 走。
   *
   * ```
   * 0（或文件里没这个键）→ 存量，**从没迁移过**
   * 1                   → P7.0b 起；v0→v1 只是"补上版本字段"，没有任何真实迁移规则
   * 2                   → P7.1 起；v1→v2 = 视图体系两档化：notesView 'compact' → 'detail'
   *                       ＋「发布进度」补进存量 columnsHidden（两条的完整口径见 migrateSettings）
   * 3                   → P7.2a 起；v2→v3 = 「收藏」补进存量 columnsHidden（与「发布进度」同形 ——
   *                       新属性只进了 DEFAULT_HIDDEN，那只服务"从没动过列"的用户）
   * 4                   → P7.2c 起；v3→v4 = 「来源」补进存量 columnsHidden（三度同形）
   * 5                   → P7.5 起；v4→v5 = **`ai.allowWrite` 退役**（8.1 体检拍的）：
   *                       存量的 true 先映射成逐类等价设置再删键；false 直接删。
   *                       完整口径见 `migrateSettings()` 的 v4→v5 段。
   * ```
   *
   * 🔴 `DEFAULT_SETTINGS.settingsVersion` **故意写 0、不是 `SETTINGS_VERSION`**：
   * 这样"读盘入口忘了迁移"在内存里就是 0（落盘也是 0）—— **看得见**
   *（`tests/specs/settings.ts` 的接线用例就靠它变红）。
   * 写成 `SETTINGS_VERSION` 的话，把 `load()` 里那次 `migrateSettings(` 删掉，
   * `current.settingsVersion` 照样是 2（默认值顶的）→ 那条判据当场变成**假绿**
   *（P6② "纯函数有判据 ≠ 接线有判据"的同一枚硬币，只是这枚藏得更深）。
   */
  settingsVersion: number;
  /**
   * 工作文件夹（**vault 相对路径**）。向导第 1 步可改（P6）。
   * 🔴 `''` = **整个库**（= vault 根，P7.14）：直接管理库内所有笔记 ——
   * 别再把它当"没配"（`normalizeSettings` 有显式 case 收它，见那段注释）。
   */
  kbRoot: string;
  /** 元数据目录名（相对 kbRoot） */
  metaDir: string;
  /** 模块与功能开关 */
  modules: Record<FeatureId, boolean>;
  /** 上次停在哪一栏 */
  activeModule: ModuleId;
  /** 键位覆盖（只在改过时才有键；值形如 ['ctrl+shift+f']） */
  keymap: Record<string, string[]>;
  /** 上次快照时间戳（底部状态区显示「快照 N 分钟前」） */
  lastSnapshotAt: number | null;
  /** 首页「忽略」掉的待处理项（交互规格 §2.3） */
  homeDismissed: string[];
  /**
   * **首页区块的显隐与顺序**（§1.2，P7.2a）。`null` = **还没动过** —— 与
   * `notesView` / `columnsHidden` 同一个哨兵纪律：还没动过时显隐与顺序**全按注册表**
   * （`modules/home/blocks.ts` 的 `defaultOn`：现有五块开、新模块关）；
   * 用户拖过一次 / 勾过一次 → **物化**成 `{ order, hidden }`，从此它是显隐的**完整真源**
   * （不在 `hidden` = 显示，`order` 里没有的块排到末尾、按注册表序）。
   *
   * 🔴 **为什么要 `null` 而不是"默认写死 hidden 含三个新模块"**：将来再加默认关的新块时，
   * 物化过的老用户那份 `hidden` 里不会有它 —— 那时候按既有机制走**一次版本迁移**
   * （「补进 columnsHidden」那条的同一形状），而不是让默认值去猜用户动没动过。
   * 迁移只在读盘入口跑（`SettingsStore.load()`），写入口那份值是用户刚选的、不许动。
   *
   * ⚠️ **`homeBlocks` 这个键本身不升版本**：新键有默认值（null）、不改任何旧键语义 ——
   * 17.1 机制注释里"通常不用动版本"说的就是这种情形。（P7.2a 的 `SETTINGS_VERSION` 2→3
   * 是**另一条**：`收藏` 补进存量 `columnsHidden`，见 `migrateSettings` 的 v2→v3 段。）
   *
   * ⚠️ **它不进视图记忆**（顺序是落盘偏好，本就在 data.json —— 别再存第二套）。
   */
  homeBlocks: HomeBlocks | null;

  /**
   * **钉到首页的笔记路径表**（P7.2d · 16.9-b）。入口 = 笔记右键「其他」→ 钉到首页；
   * 上限 `HOME_CARDS_MAX`（第 7 篇给通知、**不顶掉旧的**）。
   *
   * `null` = **还没钉过**（与 `homeBlocks` / `gridOrder` 同一个哨兵纪律；
   * `[]` 是"钉过又全取消了"—— 渲染上两者都自隐，落盘上分开）。
   *
   * ⚠️ **表里存的是路径** → 必须跟着 `vault.on('rename')` 迁键、`vault.on('delete')` 剪枝
   * （挂在 `main.ts` 插件层那两条监听里，与 `gridOrder` 同一处纪律 ——
   * 挂在模块里必漏：改名的四个入口发生时首页多半没挂载）。
   * ⚠️ 界面偏好，落本机 `data.json`；**不动 `settingsVersion`**（新键 + null 哨兵，17.1 口径）。
   */
  homeCards: string[] | null;

  /**
   * **新手清单已完成的动作 id**（P7.2d · 16.13；清单 = `modules/home/onboarding.ts` 的
   * `ONBOARDING_ITEMS`）。打勾 = **动作点置位**：做过就记，不改；"做过 ≠ 现在存在"
   * （不扫库状态 —— 建过的笔记被删了也照样算做过）。
   *
   * `null` = **一项都没做过**（哨兵；设置栏「重置新手清单」= 写回 null）。
   * ⚠️ 第 1 项（走完向导）**不进这个表** —— 它直接用现成的 `wizardDone` 三态；
   * 于是"重置"之后第 1 项仍然打勾（向导是真走过了，没有"取消走过"这回事）。
   * ⚠️ 不动 `settingsVersion`（新键 + null 哨兵）。
   */
  onboarding: string[] | null;

  /**
   * **「全部笔记」的首入讲解看过没有**（P7.10 · #8）。`false` = 还没看过 → **首次进入**
   * 「全部笔记」弹一次性浮层（`ui/notes-intro.ts`）；**用户关掉**（「知道了」/「去看教程」/
   * Esc —— 浮层没有 ✕（`openFloating` 不画））都落成 `true`，从此不再弹。
   * `false` 是产品默认（全新安装该看到这一幕）。
   * ⚠️ **不动 `settingsVersion`**（新键 + 布尔默认，17.1 口径 —— 照 `homeCards` 先例）。
   * ⚠️ 离线夹具里显式写 `true`（"这台设备见过"）—— 见 `tests/helpers.ts` 的 `seedDataJson`。
   */
  notesIntroSeen: boolean;

  // ── 全部笔记的界面偏好（交互规格 §3：切走回来不变）──────────────
  /**
   * 视图档（§3.2）。`null` = **还没切过**。
   *
   * 🔴 `null` 与 `'detail'` 不是一回事（P6）——§3.2 说"触屏默认进网格档"，
   * 而 B7 拍的是"**用户显式切过就以用户为准**"。要同时满足这两条，就得能区分
   * "从没切过"和"切过又切回来"。用 `'detail'` 当哨兵值就再也分不出来了
   * （本项目在 `data.json` 的"还没选过"上栽过一次 —— `columnsHidden` 那条）。
   *
   * 解析规则只有一处：`resolveNotesView()`。
   */
  notesView: NotesView | null;
  /**
   * 隐藏的列 id（**名称列不可隐藏**）。
   * `null` = 用户还没动过 → 用模块自己的一套默认显隐（`columns.ts` 的 `DEFAULT_HIDDEN`）；
   * `[]` = 用户显式全开。**两者不是一回事**，别把 null 收敛成空数组
   * （真机抓到过：收敛成 [] 等于一开始就把 13 个列全摊开，表格 3126px 宽）
   */
  columnsHidden: string[] | null;
  /** 列宽（列 id → px；缺省用 CSS 默认） */
  columnWidths: Record<string, number>;
  /** 排序（列 id + 方向）；null = 默认按名称升序 */
  notesSort: { key: string; dir: 'asc' | 'desc' } | null;
  /**
   * 目录树展开的目录（相对库根；**`''` = 库根自己**）。
   *
   * ⚠️ **P7.24（T2 决策反转）**：根（整个知识库）**不再是"恒开"的特殊节点** ——
   * 它和别的目录一样吃这一份展开态（用户 2026-10-11 真机点名"根 caret 点了没反应"）。
   * **默认开**由 `DEFAULT_SETTINGS`（初次）与 v5→v6 迁移（存量）共同保证：
   * `''` 在列表里 = 根开，摘掉 = 根收起（用户显式收的）。渲染侧原来的 `isRoot ||`
   * 特例已删（`tree.ts` 的 `walk` / `nodeRow`）。
   */
  treeOpen: string[];
  /**
   * 目录树里**「含文件展示」**的目录（P7.23，Q5 拍板持久化）。
   * 语义：`完全展开（含所有子文件夹与文件）` 会给该目录**及其后代**盖上这一项 ——
   * 树渲染时"展开了 + 在这一份里"才列出文件行；`收起此文件夹` 把整棵子树的记录清掉
   *（"收起来就该全收"）。口径与 `treeOpen` 同族（相对库根、normalize 白名单同款）。
   */
  treeShowFiles: string[];
  /** 目录树选中项（'' = 整个知识库） */
  treeSelected: string;
  /** 搜索范围 */
  searchScope: SearchScope;
  /**
   * **设置面板里每行那句解释要不要摊开**（P6 第八段，用户第 3 条）。
   *
   * 默认 `false` = 收起（"简化甚至去除各选项的提示小字"）—— 收起**不是删掉**：
   * 鼠标停在行标签上照样能看见（`settings/kit.ts` 把同一句话挂在 `title` 上），
   * 顶部那枚「显示说明」能一次性摊开。这是**界面偏好**（"这台机器上看不看得惯"），
   * 所以落插件 `data.json`，不进库。
   */
  showSettingHints: boolean;

  // ── P7.2b：命名模板（1.4 的 ①管理面板/③变量帮助）────────────────
  /**
   * **新建笔记的默认名模板**。
   * `null` = 没改过 → `DEFAULT_NAMING_TEMPLATE`（`YYYY-MM-DD HHmm` → `2026-10-03 2105`）。
   *
   * ⚠️ **落 data.json 是拍板定死的**（2b 开工提示词）：它是"这台机器上起名顺不顺手"的
   * 界面偏好，不是知识库层面的配置 —— 不进库、不跟同步。新键 + `null` 哨兵，
   * 与 `homeBlocks` 同形（**不动 `settingsVersion`**）。
   * 渲染与校验的唯一出处：`core/naming.ts`（`resolveNamingTemplate` 收口）。
   */
  namingTemplate: string | null;

  // ── P6：网格档（交互规格 §3.5）────────────────────────────────
  /**
   * **自动排列**（§3.5）：开 = 按排序下拉的规则铺满；关 = **自由摆放**（按 `gridOrder`）。
   * 真机上"拖一下就自动取消勾选"——理由见 `applyGridDrop()`（不改的话，拖完立刻被排序规则顶回去，
   * 症状正是本项目最烦的"点了没反应"）。`null` 不是合法值：它没有"还没选过"的语义（默认就开）。
   */
  gridAutoArrange: boolean;
  /**
   * **自由摆放的顺序表**（只记顺序、**不记绝对坐标** —— §3.5 表下那条注释）。
   * 存**路径**，所以必须跟着 `vault.on('rename')` 迁键（看板两处是现成的样板）。
   * 不在这里的路径 = "还没摆过" → 排在已知项之后，彼此按当前排序规则。
   */
  gridOrder: string[];
  /**
   * 网格档的排序（§3.5 的排序下拉：名称 / 修改日期 / 大小）。
   * ⚠️ 与表格的 `notesSort` **分开**：后者的 key 是任意列 id（含 `prop:领域` 这种），
   * 网格里根本画不出来 —— 共用一份的话，从表格切到网格会得到一个"没有对应项"的排序。
   * `null` = 没选过 → 名称升序。
   */
  gridSort: { key: GridSortKey; dir: 'asc' | 'desc' } | null;

  // ── 外观（交互规格 §7.5；P3 实做）──────────────────────────
  /**
   * 密度：`standard` = 表格 31px 行高（§3.2 定稿值）· `compact` = 26px。
   * 与「视图档」（P7.1 起是详细信息/网格）不是一回事：视图档决定**显示哪些列**，
   * 密度只决定**行有多高**，两个可以任意组合（原第三档「紧凑」已删，这个名字如今只属于密度）。
   */
  density: 'standard' | 'compact';
  /** 动效：`system` = 跟随 `prefers-reduced-motion` · `reduce` = 强制减少 */
  motion: 'system' | 'reduce';
  /**
   * **打开工作台时自动收起 Obsidian 左侧栏**（用户 2026-09-28 拍板：打开就收，**不按宽度判断**）。
   *
   * 为什么需要它：真机量到「窗口 830 + 左栏 200 → 工作台只剩 586」，
   * 而 586 < 640 就是**窄档** → `.kbw-root[data-w='narrow'] .kbw-notes-side{display:none}`
   * 把工作台自己的目录栏整个藏掉（树行量到 0×0）——用户看到的"目录导航消失了"就是这个。
   * 工作台要横向空间：导航 152 + 目录栏 208 + 主区 ≥640 ⇒ **1000+** 才舒展，左栏一开就吃掉 200。
   *
   * ⚠️ 开门见山那条：**默认 true**，但**只收"这一次打开时真收了的"**，关掉工作台**不还回去**
   * （用户自己点一下就开，见 `main.ts` 的 `collapseSidebarOnOpen`）。
   * ⚠️ 触屏**不做特例**（拍板原文：平板/手机上的侧栏本就是抽屉，收了等于没动）。
   * ⚠️ 这是"会动用户布局"的动作 → 必须留这条退路（关掉它 = 一个字都不碰侧栏）。
   */
  collapseSidebarOnOpen: boolean;

  // ── P3：自动归位的"上次看见的声明"（本机会话状态，不是库内配置）──
  /**
   * `库内路径 → 上次看见的「文件位置」值`。
   * 为什么它必须存在：自动归位的唯一触发条件是"**显式改**了 `文件位置`" ——
   * 要看出"改了"，就得有个"上次看见的是什么"。
   * ⚠️ 第一次见到一篇笔记时**只登记、不搬**（否则打开插件就会把库里所有
   * "声明与实际不符"的笔记搬走，那不是显式改，是惊喜）。
   */
  reconcileSeen: Record<string, string[]>;

  // ── P7.6：整理建议的"学你过往的修正"（本机使用习惯，不是库内配置）──
  /**
   * 「用户把 X 类笔记搬到了 Y」的频次表（建议源②的数据）。
   * 形状：`{ tag: { X: { Y: n } }, dir: { X: { Y: n } } }` ——
   * `tag` 类按笔记的标签、`dir` 类按笔记原来所在的目录。
   *
   * 🔴 **为什么存这里而不是库内 JSON**（G6-Q5 拍板）：它是"**这台机器看见过什么习惯**"，
   * 与 `reconcileSeen` 同一族（会话状态，不是知识库配置）。写库还会给同步流添一个热文件。
   * 上限（记录侧执行）：每类 ≤50 键、每键 ≤8 落点、计数封顶 99。
   * 新键 + 空哨兵、不改任何旧键语义 → **不动 `settingsVersion`**（17.1 口径）。
   */
  moveStats: MoveStats;

  // ── P4.5 e2：快速捕获的"上次丢给谁"（界面偏好）─────────────────
  /**
   * 上一次选的落点键（`<板块 id>` / `<板块 id>::<取值>` / `dir:<相对路径>`，
   * 见 `modules/board/capture.ts`；`dir:` 是 P7.2c 的第五类"直接选目录"）。
   * 板块/取值没了的话 `pickTarget` 会落回第一个 —— **记住的键失效不是错**，
   * 所以这里只存字符串，不做校验。
   */
  lastCapture: string | null;

  // ── P7.2c：小窗的几何记忆（4.3-②；Q3 拍板"全记尺寸+位置"）────────
  /**
   * **小窗的「全局默认」几何**：拖/缩过的那扇窗把 `{x,y,w,h}`（视口坐标）记在这儿，
   * **新窗首次打开**用它；没记过（`null`）就照旧锚在被点那一列的顶部。
   *
   * 三条口径（2c 开工提示词 Q3 拍板）：
   *   · **全局一份**，不是每扇/每篇一份 —— 所以**不进** `board/config.ts` 的
   *     `panelByPath`（那是"每篇偏好"的家，几何不是）；也不进库（界面偏好）。
   *   · **会话内各窗独立**：这只是"下次新窗从哪儿开始"，改动**不回溯**现开着的窗；
   *   · 读回时**越界夹回**（`keepInside` 口径）—— 换小显示器/改分辨率后老坐标
   *     可能在屏幕外。
   *
   * ⚠️ **落盘时机 = 拖动/缩放"结束"那一下**（不能在 pointermove 每帧写盘）。
   * 新键 + `null` 哨兵、不改任何旧键语义 → **不动 `settingsVersion`**（17.1 口径）。
   */
  panelGeo: { x: number; y: number; w: number; h: number } | null;

  // ── P6 段④：AI 助手（交互规格 §11）──────────────────────────
  /**
   * AI 助手的连接与档位。**key 存这里**（插件 `data.json` = 本机位置）。
   *
   * 🔴 **为什么 key 不能进库**：库会同步（真库走 Obsidian 内的 `nutstore-sync`），
   * 库内 JSON 等于"跟着笔记一起上云"。`方案设计.md` §3.1 的唯一真源原则说的是
   * **知识库层面的配置**放库内；"这台机器能不能连某个服务"属于这台机器。
   * ⚠️ 同一条纪律的另一半：key **不进任何日志 / 通知 / 报告** —— 报告正文由 `report.ts`
   * 按 spec 拼，AI 那条路上不把 key 传进去。
   */
  ai: AiSettings;

  // ── P6 段④：首次使用向导（交互规格 §14.1）───────────────────
  /**
   * 向导的**三态**标记。
   *
   * ```
   * true   用户走完 / 点了「完成」/「跳过向导」 → 永不再自动弹
   * false  用户点了「稍后」/ 直接关掉           → 下次打开工作台还会出现
   * null   **这个键从来没写过**（存量 data.json / 全新安装）
   *        → 再看路径：kbRoot 与 metaDir **都还是默认值**才算"没配过"
   * ```
   *
   * 🔴 **`null` 这一支不是可有可无的**：`normalizeSettings` 会给缺项补默认值，
   * 于是"用户主动选了默认值"与"从没配过"在读盘之后长得一模一样 ——
   * 只看布尔标志会**漏掉所有存量用户**（他们的 `data.json` 里根本没有这个键）。
   * 判据只有一处：`shouldShowWizard()`。
   */
  wizardDone: boolean | null;
}

/**
 * 「学你过往的修正」的频次表（P7.6 建议源②；见 `WorkbenchSettings.moveStats`）。
 *
 * `tag` 段：标签 → { 落点目录（相对库根）: 次数 }；`dir` 段：来源目录 → 同上。
 * 记录与出建议的口径在 `services/suggest-learned.ts`（那才是唯一实现）；
 * 这里只是**落盘的形状**（settings 是 data.json 的收口）。
 */
export interface MoveStats {
  tag: Record<string, Record<string, number>>;
  dir: Record<string, Record<string, number>>;
}

/**
 * AI 助手的连接参数（交互规格 §11.2 拍板）。
 *
 * **走 OpenAI 兼容协议**：`baseUrl` + `/chat/completions`。
 * 于是"DeepSeek"与"用户自己配置（OpenAI / Kimi / 本地 vLLM…）"是**同一份代码**，
 * 默认值指向 DeepSeek。
 */
export interface AiSettings {
  /** 不带 `/chat/completions` 后缀；协议为 anthropic 时填到域名/前缀为止（带 `/v1` 也认，见 transport.ts） */
  baseUrl: string;
  /**
   * **传输协议**（P7.22b · #4）：`'openai'` = OpenAI 兼容（现状，默认）·
   * `'anthropic'` = Anthropic 原生 Messages API（带 prompt caching）。
   *
   * 🔴 选路的**唯一来源**（拍板口径：设置里给「协议」小下拉 —— 显式可测，
   * 也覆盖中转 / 代理域名；**不做** baseUrl 自动识别）。手改 data.json 塞别的值 →
   * 读盘收敛回默认（见 normalizeSettings 的 case 'ai'）。
   */
  protocol: 'openai' | 'anthropic';
  model: string;
  /**
   * ⚠️ 空串 = 还没配。面板**不报错**，显示一句"还没配置，去 设置 → AI 助手 填上"
   * —— 新装用户的第一次就是这条路，不该看到一个红色错误。
   */
  apiKey: string;
  /**
   * **逐类档位**（P7.3b 三档：禁 / 需确认 / 自动；类别清单 = `AI_TOOL_CLASSES`）。
   *
   * ⚠️ **没写的类别回落到默认表**（见 `effectiveTier`）。
   *
   * ⚠️ **P7.5 起这里没有 `allowWrite` 了**：旧的「允许 AI 直接动库」粗档开关
   * 已退役（P7.3b 把它降级成兼容口径后就只剩"没设过的类别跟随它"这一件事，
   * 而逐类设置本来就完整覆盖它）。存量的 `true` 由 `migrateSettings()` 的
   * v4→v5 段**映射成逐类等价设置**（改属性/标签/新建/搬 → 「自动」）再删键 ——
   * 行为等价，不会悄悄关掉谁的权限；`false`（默认，没人点过）直接删键。
   * 设置面板（3c 的 8.2）写这个键；手改 `data.json` 也认，但**只收白名单里的值**
   * （读盘收敛在下面 `case 'ai'` 里逐项校验，防手改把档位改成乱七八糟的东西）。
   *
   * 🔴 「自动」对**写类**的含义 = **自动弹确认框**（不是跳过确认）：
   * 红线只认拖拽一个例外，AI 没有第二个（§11.2 第 3 条）。
   */
  toolTiers?: Partial<
    Record<'read' | 'prop' | 'tag' | 'create' | 'move' | 'delete' | 'text', 'off' | 'confirm' | 'auto'>
  >;
  /**
   * **模型参数**（P7.3c 8.2）：给"愿意折腾的人"一个口子，**默认值 = 3b 起写死的那两个**
   * （1200 / 0，见 `services/ai/index.ts` 的 `callModel`）—— 默认行为一个字不变。
   *
   * ⚠️ `maxTokens: 0` 是**有意义的**（= 不限定，transport 会整段不发这个字段）；
   * 别把它当"没设过"的哨兵（本项目在 `panelFont: 0` 上专门记过这类账）。
   */
  maxTokens: number;
  /** 0–2（OpenAI 兼容的范围）。整理归类这件事要的是稳定，所以默认 0 */
  temperature: number;
  /**
   * **任务级模型映射**（P7.22b · #5）：任务 id（`AI_TASKS` 的 id）→ 模型名；
   * "分类走便宜、写作走强"就靠它。该任务没写（或整个键缺）= 用主模型 `model`。
   *
   * ⚠️ **键不做白名单**（与 `toolTiers` 那套"core 抄第二份类别名"刻意不同）：
   * 任务 id 是**开放联合**（"新任务 = 一条数据"）—— 在 core 里再抄一份 id 名单，
   * 将来加任务时那份拷贝不会跟着长，映射会被读盘层**静默丢掉**。
   * 认不出的键无害（永不参与分派），所以只收敛"值的形状"（非空串 + 长度夹取）。
   */
  taskModels: Record<string, string>;
  /**
   * **按模型定价**（P7.22b · #5）：多模型多条（每百万 token 的单价，只本地做乘法）。
   * 命中就用它（**模型名逐字相等**，去首尾空白）；没命中的模型回落下面的
   * `priceIn` / `priceOut`（"回落现值"）—— 货币符号只有一个（`priceUnit`）。
   *
   * ⚠️ 各家的价目表会漂（分时段 / 分缓存命中），文案里照旧写"以你家的价为准"。
   */
  modelPrices: { model: string; priceIn: number; priceOut: number }[];
  /**
   * **成本可见（17.10②）的单价表**：每百万 token 的单价 + 货币符号，**只本地做乘法、不联网**。
   * P7.22b 起它是**默认档 / 回落值**（上面 `modelPrices` 按模型覆盖）。
   *
   * 默认填的是 DeepSeek `deepseek-chat` 的**高峰时段**价（元 / 百万 token）——
   * 取值偏保守（空闲时段是它的一半，缓存命中的输入低到 0.04），
   * 界面文案明说「以你家的价为准」，愿意精确的人自己改。
   */
  priceIn: number;
  priceOut: number;
  /** 只是显示用（`¥` / `$` / 空串都行）—— 这里不换算汇率 */
  priceUnit: string;
  /**
   * **触发词自动挂载**（P7.21b · G5 拍板的那个开关）：输入的话命中某个能力包的
   * `触发词` 时，自动把那个包挂上（胶囊明示来源、一键可撤）。
   *
   * ⚠️ **默认 `false`**（拍板原话"默认可关"）—— 不写这个键 = 关。它只影响
   * "要不要自动挂"，挂上之后的收窄 / 安全边界一个字不变（skill 只做减法）。
   */
  triggerAutoMount: boolean;
}

/**
 * **AI 工具类别白名单**（`normalizeSettings` 的逐键收敛 + `migrateSettings` 的 v4→v5
 * 映射**同用一份** —— 迁移里的"除读/删"差集从它派生，不写死四类字面量）。
 *
 * ⚠️ 这里是**刻意的第二份**字面量：类别名的真源在 `services/ai/tools.ts` 的 `AI_TOOL_CLASSES`，
 * 而 `core/` 不依赖 `services/`（分层）—— `tests/specs/redline.ts` 有一条判据**读两个文件**
 * 比对这份名单（改一处忘另一处当场红）。
 */
const AI_TIER_CLASSES = ['read', 'prop', 'tag', 'create', 'move', 'delete', 'text'] as const;

export const AI_DEFAULTS: AiSettings = {
  // DeepSeek 的 OpenAI 兼容口（`/v1` 可有可无，官方两种写法都收；这里用带 v1 的那条）
  baseUrl: 'https://api.deepseek.com/v1',
  // P7.22b · #4：默认还是 OpenAI 兼容（现状零变化；换 Anthropic 原生要用户显式选）
  protocol: 'openai',
  model: 'deepseek-chat',
  apiKey: '',
  // P7.22b · #5：缺省 = 主模型 / 默认单价（都不写字面量，见两份字段注释）
  taskModels: {},
  modelPrices: [],
  maxTokens: 1200,
  temperature: 0,
  // ⚠️ 这两个数会漂（DeepSeek 分时段、分缓存命中）—— 文案里必须写"以你家的价为准"
  priceIn: 2,
  priceOut: 8,
  priceUnit: '¥',
  // P7.21b：触发词自动挂载 —— 默认关（拍板"默认可关"；没这个键 = 关）
  triggerAutoMount: false,
};

/**
 * 「从未配置过」的**唯一判据**（交互规格 §14.1）。
 *
 * 纯函数，两处调用（自动弹 / 设置里重开），可离线双向断言 ——
 * 尤其是**负向**那条：`wizardDone === true` 时一次都不许弹（否则"永远弹"也会绿）。
 */
export function shouldShowWizard(s: Pick<WorkbenchSettings, 'wizardDone' | 'kbRoot' | 'metaDir'>): boolean {
  if (s.wizardDone === true) return false;
  // 显式点过「稍后」→ 下次打开工作台再来（那是「稍后」的意思）
  if (s.wizardDone === false) return true;
  // null = 从没写过这个键：只有**路径也还是默认值**才认作"没配过"
  return (
    s.kbRoot === DEFAULT_SETTINGS.kbRoot && s.metaDir === DEFAULT_SETTINGS.metaDir
  );
}

/**
 * 首页区块的显隐与顺序（P7.2a §1.2）——**一个键整组原子落盘**（D1 口径）。
 * 块 id 的注册表在 `modules/home/blocks.ts`（这里是"落盘形状"，不认识具体块）。
 */
export interface HomeBlocks {
  /** 完整顺序（用户排过的）；**不在表里的块排到末尾**、彼此按注册表顺序 */
  order: string[];
  /** 隐藏的块 id —— **显隐的完整真源**（不在表里 = 显示） */
  hidden: string[];
}

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  /**
   * 🔴 **故意是 0**（= "还没迁移过"），不是 `SETTINGS_VERSION` —— 见 `settingsVersion`
   * 那段注释：它让"读盘时没迁移"在内存/盘上都看得见（0）。
   */
  settingsVersion: 0,
  kbRoot: '01_新知识库',
  metaDir: '99_Meta',
  modules: {
    home: true,
    notes: true,
    board: true,
    graph: true,
    /**
     * ⚠️ `review` 这一项**不是"默认开启的开关"**（`MODULES.review.toggleable === false`）——
     * 它是 `Record<FeatureId, boolean>` 的类型完整性：`ModuleId` 里有了它、`FeatureId` 就含它，
     * 漏了 TS 直接红。`true` 只是让 `WorkbenchState.modules` 这个快照字段有值，
     * 常驻模块不看它（`paintNav` 里 `!meta.toggleable` 那半边已经放行）。
     */
    review: true,
    // 自动归位默认关（决策 7）；新建补全默认开（交互规格 §7.1）
    automation: false,
    completion: true,
  },
  activeModule: 'home',
  keymap: {},
  lastSnapshotAt: null,
  homeDismissed: [],
  // 还没动过 → 显隐与顺序全按注册表（现有五块开、新模块关）
  homeBlocks: null,
  // 还没钉过（[] 是"钉过又全取消了"——哨兵纪律见 homeCards 的注释）
  homeCards: null,
  // 新手清单：一项都没做过
  onboarding: null,
  // 「全部笔记」首入讲解：还没看过（P7.10 · #8 —— 与 homeCards 同款"新键+默认、不动版本"）
  notesIntroSeen: false,

  // null = 还没切过 → **一律网格**（P6⑧ 起；`resolveNotesView()` 是唯一出处）
  notesView: null,
  columnsHidden: null,
  columnWidths: {},
  notesSort: null,
  // P7.24 · T2：'' = 库根 —— 默认开着（根也是普通节点；存量由 v5→v6 迁移补上）
  treeOpen: [''],
  treeShowFiles: [],
  treeSelected: '',
  searchScope: 'all',
  // 设置面板里每行那句解释**默认收起**（P6 第八段，用户第 3 条）
  showSettingHints: false,
  // 命名模板：null = 没改过 → `core/naming.ts` 的 DEFAULT_NAMING_TEMPLATE
  namingTemplate: null,

  gridAutoArrange: true,
  gridOrder: [],
  gridSort: null,

  density: 'standard',
  motion: 'system',
  collapseSidebarOnOpen: true,

  reconcileSeen: {},
  // 还没学过任何一次搬动
  moveStats: { tag: {}, dir: {} },
  lastCapture: null,
  panelGeo: null,

  ai: { ...AI_DEFAULTS },
  // ⚠️ 默认是 **null 而不是 false**：见 `wizardDone` 那段注释
  wizardDone: null,
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof WorkbenchSettings)[];

/**
 * 插件设置（`data.json`）的**当前版本号**（17.1，P7.0b）。
 *
 * 改这里的数字时**必须同时**在 `migrateSettings()` 里补一段"从上一版迁过来"的规则 ——
 * 那是这套机制唯一的用法：**改默认值/删键都不能只改常量**
 *（P6② 的教训原话："改默认值 = 改常量 + 迁移存量 + 钉住接线"，三件事缺一不可）。
 * 形状照 `board/config.ts` 的 `BOARD_CONFIG_VERSION` + `migrateLegacyView` 抄。
 */
export const SETTINGS_VERSION = 6;

/**
 * **插件设置的一次性迁移**（17.1）。纯函数：读原始 JSON、返回原始 JSON，不碰盘也不补默认。
 *
 * 三条口径（与 `migrateLegacyView` 同一套，别自创）：
 *   · **只在读盘那一个入口跑**（`SettingsStore.load()`）—— 写入口那些值是用户**刚选的**，
 *     在那儿迁移 = "选了等于没选"；
 *   · **认版本号**：文件里 `settingsVersion >= SETTINGS_VERSION` 就**原样返回**（幂等，
 *     连 key 顺序都不动 —— "再 load 一次一个字节都不该变"那条判据要的就是这个）；
 *   · **只改该改的键**，其余键（含未知键）一个不动 —— 补默认是 `normalizeSettings` 的事，
 *     顺序是 `normalizeSettings(migrateSettings(raw))`（先迁移原始 JSON，再补默认）。
 *
 * v0 → v1：**只是补上版本字段**（P7.0b 建机制，故意不含任何真实规则）。
 * v1 → v2（P7.1）两条（都属于"视图体系两档化"）：
 *   ① **删「名称+时间」视图档** —— 存量 `notesView: 'compact'` 改写成 `'detail'`
 *      （原"紧凑档"= 现在的"详细信息"，所以是**等义改名**，不是改行为）。
 *      ⚠️ **只改这一个值**：`'detail'` / `'grid'` / `null`（= 从没切过）一个都不动 ——
 *      后者是"还没切过"那条口径的哨兵，动它等于把用户的显式选择抹掉（B7）。
 *   ② **「发布进度」进默认隐藏**（2.4 方案 B）：`columnsHidden` 是数组（= 用户动过列）时把它补进去。
 *      **为什么不违反"以用户为准"**：这条列在原默认里**本来就是可见**的 ——
 *      用户显式点过它的唯一方向是"隐藏"，那样它已经在数组里（这次补是 no-op）；
 *      数组里没有它 = 用户从没对这条列表过态，补进去只是把新默认补齐。
 *      之后想再显示它，从「列」菜单勾回来即可 —— 迁移**不会重复跑**（版本号挡住），
 *      这就是"幂等"的含义：只对**迁移前**的状态生效。
 *      `columnsHidden` 是 `null`（从没动过列）时不写任何东西 —— 新默认在渲染时自然生效。
 * v2 → v3（P7.2a）一条：**「收藏」补进存量 `columnsHidden`** —— 与上面 ② **完全同形**
 *   （理由也一样：新属性只进了 `DEFAULT_HIDDEN`，那只服务"从没动过列"的用户）。
 * v3 → v4（P7.2c）一条：**「来源」补进存量 `columnsHidden`** —— 三度同形（剪藏的新属性）。
 *   `panelGeo`（同一轮的另一个新键）**不进迁移**：新键有默认值（null）、不改旧键语义。
 * v4 → v5（P7.5）一条：**`ai.allowWrite` 退役**（8.1 体检拍板）。两步：
 *   ① 盘上是 `true`（真有人点过旧开关）→ 先把它**映射成逐类等价设置**
 *      （改属性/标签/新建/搬 → `'auto'`，仅当该类在 `toolTiers` 里还没有显式档位时），
 *      再把 `ai.allowWrite` 键删掉 —— 行为等价（旧口径下这四类也是"自动"），
 *      不覆盖用户后来逐类设过的值；
 *   ② 盘上是 `false`（默认值，没人点过）或键不存在 → 直接删键，零行为变化。
 *   🔴 **为什么必须映射而不是一删了之**：`allowWrite` 是"没设过的类别跟随它"的兜底，
 *   直接删会让开过它的人从"自动"掉回"需确认" —— 那是**权限方向的静默变化**
 *   （变保守，不危险，但没道理）。映射之后怎么删都是等价的。
 * v5 → v6（P7.24 · T2）一条：**根节点进 `open`**（"根恒开"决策反转，见 `treeOpen` 的注释）。
 *   存量 `treeOpen` 数组补上 `''`（append-if-array，口径与上面三条「补进列」**完全同形**）——
 *   用户可见行为零变化：迁移前根就是恒开的，补 `''` 只是把那份恒开**物化**成数据；
 *   迁移后用户再点根 caret 收起 = 摘掉 `''`，正常持久化。数组缺失/坏形状**不写**
 *   —— 那是 `DEFAULT_SETTINGS.treeOpen: ['']` 的事（normalize 补默认）。
 */
export function migrateSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // 全新安装 / 读盘失败（null）→ 当 v0 迁到当前版：给一个最小的当前版形状
    return { settingsVersion: SETTINGS_VERSION };
  }
  const o = raw as Record<string, unknown>;
  const ver = typeof o.settingsVersion === 'number' && Number.isFinite(o.settingsVersion)
    ? o.settingsVersion
    : 0;
  if (ver >= SETTINGS_VERSION) return raw; // 已是最新（或更新版写入的）→ 原样
  /**
   * 逐级迁移：以后每加一版就在这里补一段 `if (ver < N) { … }`，
   * 落点一律"改形状、别改键名以外的东西"。
   * v0→v1 没有真实规则（只补版本字段，由末尾那句统一落）。
   */
  const next: Record<string, unknown> = { ...o };
  if (ver < 2) {
    if (next.notesView === 'compact') next.notesView = 'detail';
    const hid = next.columnsHidden;
    if (Array.isArray(hid) && !hid.includes('prop:发布进度')) {
      next.columnsHidden = [...hid, 'prop:发布进度'];
    }
  }
  if (ver < 3) {
    /**
     * v2→v3（P7.2a）：「**收藏**」补进存量 `columnsHidden` —— 与「发布进度」那条**完全同形**：
     * P7.2a 把新属性 `收藏` 加进了 `DEFAULT_HIDDEN`（`columns.ts`），而那份默认
     * **只服务 `columnsHidden === null`（从没动过列）的用户**；物化过数组的用户
     * 不迁的话会**凭空多出一列「收藏」**。口径同上：只 append、不重排用户的选择；
     * `null` 不写任何东西（新默认渲染时自然生效）。
     */
    const hid3 = next.columnsHidden;
    if (Array.isArray(hid3) && !hid3.includes('prop:收藏')) {
      next.columnsHidden = [...hid3, 'prop:收藏'];
    }
  }
  if (ver < 4) {
    /**
     * v3→v4（P7.2c）：「**来源**」补进存量 `columnsHidden` —— 与「收藏」「发布进度」**完全同形**
     * （新属性只进了 `DEFAULT_HIDDEN`，那只服务"从没动过列"的用户；物化过数组的用户
     * 不迁的话会凭空多出一列「来源」）。只 append、不重排；`null` 不写任何东西。
     */
    const hid4 = next.columnsHidden;
    if (Array.isArray(hid4) && !hid4.includes('prop:来源')) {
      next.columnsHidden = [...hid4, 'prop:来源'];
    }
  }
  if (ver < 5) {
    /**
     * v4→v5（P7.5）：**`ai.allowWrite` 退役**（完整口径见 `migrateSettings` 的 JSDoc）。
     *
     * 两条注意：
     *   · 映射**只写"还没有显式档位"的类** —— 用户后来在逐类面板上设过的值一个字不动
     *     （那是"逐类优先"的旧口径原样搬过来）；
     *   · `ai` 不是对象（手改坏了）时不碰 —— 删键这一步天然 no-op，坏形状交给 `normalizeSettings`。
     */
    const ai = next.ai;
    if (ai && typeof ai === 'object' && !Array.isArray(ai)) {
      const a = { ...(ai as Record<string, unknown>) };
      if (a.allowWrite === true) {
        const tiers =
          a.toolTiers && typeof a.toolTiers === 'object' && !Array.isArray(a.toolTiers)
            ? { ...(a.toolTiers as Record<string, unknown>) }
            : {};
        /**
         * ⚠️ **"除读/删"这份差集从六类白名单派生**（独立审 2026-10-04 🟡）：不写死四类
         * 字面量 —— 将来加第 7 个类别时这里自动跟上（旧 `effectiveTier` 的
         * `cls !== 'read' && cls !== 'delete'` 对任何新类都给 auto，写死会让新类别静默落回默认档）。
         * ⚠️ **"设过没有"要判值合不合法**（同审 🔴）：手改塞进来的野值（`"unknown"`）会被
         * `normalizeSettings` 丢掉 —— 只判"键在不在"的话它顶掉映射、随后被丢 → 该类**静默降档**，
         * 违反本段的"行为等价"承诺。只把三档合法值算作"已设过"。
         */
        for (const cls of AI_TIER_CLASSES) {
          if (cls === 'read' || cls === 'delete') continue;
          const cur = tiers[cls];
          if (cur !== 'off' && cur !== 'confirm' && cur !== 'auto') tiers[cls] = 'auto';
        }
        a.toolTiers = tiers;
      }
      delete a.allowWrite;
      next.ai = a;
    }
  }
  if (ver < 6) {
    /**
     * v5→v6（P7.24 · T2）：**根节点进 `open`**（完整口径见 `migrateSettings` 的 JSDoc）。
     * `''` 是库根自己 —— 迁移前的"根恒开"由渲染特例顶着、从不落盘，补上它把那份恒开
     * **物化**成数据（用户可见行为零变化）；此后根 caret 收起/展开走正常持久化。
     * 与上面三条「补进列」**完全同形**：只 append、数组缺失或坏形状不写（DEFAULT 顶）。
     */
    const to6 = next.treeOpen;
    if (Array.isArray(to6) && !to6.includes('')) next.treeOpen = [...to6, ''];
  }
  return { ...next, settingsVersion: SETTINGS_VERSION };
}

/** 把任意来源的对象收敛成合法设置（缺项补默认、类型不对就丢弃） */
export function normalizeSettings(raw: unknown): WorkbenchSettings {
  const out: WorkbenchSettings = structuredCloneish(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const k of SETTING_KEYS) {
    const v = src[k];
    if (v === undefined) continue;
    switch (k) {
      case 'settingsVersion': {
        /**
         * 版本号是**数字**，而 `default` 那一支只收字符串 —— 不显式接住的话会被
         * **静默丢掉**，回落成 0（"没迁移过"）。读盘那条路上迁移已经把它改成数字了，
         * 所以这里丢掉不会立刻出事；出事的是**将来**：某次 `SETTINGS_VERSION` 升到 2、
         * 文件里写着 2，读进来却变 0 → 每次 load 都重跑一遍迁移（甚至误迁）。
         */
        if (typeof v === 'number' && Number.isFinite(v)) out.settingsVersion = v;
        break;
      }
      case 'modules': {
        if (v && typeof v === 'object') {
          for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
            if (fk in out.modules && typeof fv === 'boolean') out.modules[fk as FeatureId] = fv;
          }
        }
        break;
      }
      case 'keymap': {
        if (v && typeof v === 'object') {
          for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
            if (Array.isArray(av) && av.every((x) => typeof x === 'string')) {
              out.keymap[ak] = av as string[];
            }
          }
        }
        break;
      }
      case 'homeDismissed': {
        if (Array.isArray(v)) out.homeDismissed = v.filter((x): x is string => typeof x === 'string');
        break;
      }
      case 'homeBlocks': {
        /**
         * 🔴 **必须显式接住**（P7.2a）：`default` 那一支只收字符串 —— 对象会被**静默丢掉**、
         * 回落成 `null`（= "还没动过"）→ 用户拖好的顺序每次重载都清零，
         * 且不报任何错（本项目在 `collapseSidebarOnOpen` 的 `false` 上记过同款账）。
         * `null` **原样保留**：它是"还没动过"这个独立状态，不是非法值。
         */
        if (v === null) {
          out.homeBlocks = null;
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          const hb = v as { order?: unknown; hidden?: unknown };
          out.homeBlocks = {
            order: Array.isArray(hb.order) ? hb.order.filter((x): x is string => typeof x === 'string') : [],
            hidden: Array.isArray(hb.hidden) ? hb.hidden.filter((x): x is string => typeof x === 'string') : [],
          };
        }
        break;
      }
      case 'activeModule': {
        if (MODULE_IDS.includes(v as ModuleId)) out.activeModule = v as ModuleId;
        break;
      }
      case 'lastSnapshotAt': {
        if (typeof v === 'number' && Number.isFinite(v)) out.lastSnapshotAt = v;
        break;
      }
      case 'notesView': {
        // ⚠️ `null` **必须原样保留**：它是"还没切过"这个独立状态，不是"非法值"。
        // 写成 `if (v === ...) out.notesView = v;` 而漏掉 null 的话，用户在触屏上
        // 每次重载都会被重新判成"没切过"——而他要的恰恰是"我切过了，别动我的"。
        // ⚠️ **P7.1 两档化之后这里不再收 `'compact'`**：存量值由 `migrateSettings()`
        // 在读盘时改写成 `'detail'`（顺序是先迁移、后归一化）——走到这里的 `'compact'`
        // 只可能是"版本号已是最新却写着旧值"的手改文件，丢掉它（回落 null = 网格）是对的。
        if (v === null || v === 'detail' || v === 'grid') out.notesView = v;
        break;
      }
      case 'gridAutoArrange': {
        if (typeof v === 'boolean') out.gridAutoArrange = v;
        break;
      }
      case 'gridOrder': {
        // ⚠️ 数组必须显式处理：`default` 那一支只收字符串，数组会被**静默丢掉**
        if (Array.isArray(v)) out.gridOrder = v.filter((x): x is string => typeof x === 'string');
        break;
      }
      case 'gridSort': {
        if (v && typeof v === 'object') {
          const g = v as { key?: unknown; dir?: unknown };
          if (GRID_SORT_KEYS.includes(g.key as GridSortKey) && (g.dir === 'asc' || g.dir === 'desc')) {
            out.gridSort = { key: g.key as GridSortKey, dir: g.dir };
          }
        }
        break;
      }
      case 'searchScope': {
        if (v === 'all' || v === 'title' || v === 'prop' || v === 'tag') out.searchScope = v;
        break;
      }
      case 'density': {
        if (v === 'standard' || v === 'compact') out.density = v;
        break;
      }
      case 'motion': {
        if (v === 'system' || v === 'reduce') out.motion = v;
        break;
      }
      case 'showSettingHints': {
        // 与 `collapseSidebarOnOpen` 同一个道理：非字符串的值**必须在这里明写一条**
        if (typeof v === 'boolean') out.showSettingHints = v;
        break;
      }
      case 'notesIntroSeen': {
        // P7.10 · #8：同款纪律 —— 不显式接住的话 `true` 会被静默丢掉、回落 `false`，
        // 症状是"关过的讲解每次进全部笔记都再弹一遍"（不报错的那种错）
        if (typeof v === 'boolean') out.notesIntroSeen = v;
        break;
      }
      case 'collapseSidebarOnOpen': {
        /**
         * 🔴 这一条**必须有显式 case**：`default` 那一支只收字符串 ——
         * 存进去的 `false` 会被静默丢掉、回落成默认的 `true`，
         * 症状是"我把开关关了，重开工作台侧栏还是被收走"（本项目的经典坑：
         * `data.json` 里凡是非字符串的值都得在这里明写一条）。
         */
        if (typeof v === 'boolean') out.collapseSidebarOnOpen = v;
        break;
      }
      case 'lastCapture': {
        if (typeof v === 'string' && v !== '') out.lastCapture = v;
        break;
      }
      case 'panelGeo': {
        /**
         * ⚠️ 与 `homeBlocks` 同一条纪律：**对象必须显式接住**（`default` 那一支只收字符串，
         * 对象会被静默丢掉 → 用户拖好的窗尺寸每次重载都忘光）。`null` 原样保留。
         * 只收"四个有限数、宽高为正"的整份 —— 缺一个就当没记过（宁可回默认锚点，
         * 也别拿半份坐标去摆窗）。
         */
        if (v === null) {
          out.panelGeo = null;
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          const g = v as Record<string, unknown>;
          const okNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
          if (okNum(g.x) && okNum(g.y) && okNum(g.w) && okNum(g.h) && g.w > 0 && g.h > 0) {
            out.panelGeo = { x: g.x, y: g.y, w: g.w, h: g.h };
          }
        }
        break;
      }
      case 'namingTemplate': {
        /**
         * 🔴 **必须显式接住 `null`**（P7.2b，与 `homeBlocks` 同款）：`default` 那一支
         * 只收字符串 —— `null` 会被**静默丢掉**、回落成默认值。这里默认值恰好也是 null
         * 所以看不出，但一旦有人把默认值改成实串、或删掉这一支，症状就是
         * "每次重载命名模板都被重置"（一条靠肉眼看不出来的错）。
         *
         * ⚠️ **只收"合法模板"**（独立审 2026-10-03 🟢7）：手改 `data.json` 塞进来的
         * 空串 / 未知变量 / Windows 禁字一律丢弃、回落默认 —— 与产品口径
         * 「非法不落盘」同一条原则（那种值只可能来自手改，面板自己永远不会写出来）。
         */
        if (v === null) out.namingTemplate = null;
        else if (typeof v === 'string' && isNamingTemplateOk(v)) out.namingTemplate = v;
        break;
      }
      case 'wizardDone': {
        /**
         * 🔴 **必须显式处理 `null`**（本项目在 `data.json` 的"还没选过"上栽过好几次，
         * 最近一次是 `notesView`）：`default` 那一支只收字符串 ——
         * `null` 会被**静默丢掉**、回落成默认值。这里默认值恰好也是 `null` 所以看不出，
         * 但一旦有人把默认值改成别的（或把这一支删掉），症状就是
         * "存量用户永远等不到向导" —— 一条靠肉眼看不出来的错。
         */
        if (v === null || typeof v === 'boolean') out.wizardDone = v;
        break;
      }
      case 'homeCards': {
        /**
         * 🔴 **必须显式接住**（P7.2d，与 `homeBlocks` 同款纪律）：`default` 那一支只收字符串 ——
         * 数组会被**静默丢掉**、回落成 `null`（= "还没钉过"）→ 用户钉的卡片每次重载都清零，
         * 且不报任何错。`null` **原样保留**（它是"还没钉过"这个独立状态）。
         */
        if (v === null) {
          out.homeCards = null;
        } else if (Array.isArray(v)) {
          out.homeCards = v.filter((x): x is string => typeof x === 'string');
        }
        break;
      }
      case 'onboarding': {
        /**
         * 与 `homeCards` 同一条纪律；额外**只收认识的 id**（手改 `data.json` 塞进来的
         * 杂项一律丢掉 —— 清单是有限集合，合法值就是 `ONBOARDING_IDS`，
         * 清单的四项定义在 `modules/home/onboarding.ts`（那边 **import 这里**，不描第二份）。
         */
        if (v === null) {
          out.onboarding = null;
        } else if (Array.isArray(v)) {
          out.onboarding = (v as unknown[]).filter(
            (x): x is string =>
              typeof x === 'string' && (ONBOARDING_IDS as readonly string[]).includes(x),
          );
        }
        break;
      }
      case 'ai': {
        /**
         * ⚠️ 逐键收敛（不是 `{...out.ai, ...v}`）：那份 raw 来自磁盘上可能被人手改过的 JSON，
         * 多出来的键、类型不对的值都不该进内存。
         * ⚠️ 其中的 **`allowWrite` 已在 P7.5 退役**（8.1 体检）—— 这里不再收它；
         * 存量的 `true` 由读盘路上的 `migrateSettings()` 映射成逐类档位后再流到这里，
         * 走到这一步的 `allowWrite` 只可能是手改塞回来的，**读完即弃**（不报错）。
         */
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const a = v as Record<string, unknown>;
          const next: AiSettings = { ...out.ai };
          if (typeof a.baseUrl === 'string' && a.baseUrl.trim() !== '') next.baseUrl = a.baseUrl.trim();
          if (typeof a.model === 'string' && a.model.trim() !== '') next.model = a.model.trim();
          // P7.22b · #4：协议只收两个字面量（手改塞别的值一律当没写 = 默认 OpenAI 兼容）
          if (a.protocol === 'openai' || a.protocol === 'anthropic') next.protocol = a.protocol;
          if (typeof a.apiKey === 'string') next.apiKey = a.apiKey.trim();
          /**
           * P7.22b · #5：**任务级模型映射** —— 只收敛"值的形状"（键不做白名单，
           * 理由写在 `AiSettings.taskModels` 的注释里）；上限 40 条防手改塞一大坨。
           */
          if (a.taskModels && typeof a.taskModels === 'object' && !Array.isArray(a.taskModels)) {
            const tm: Record<string, string> = {};
            for (const [k, val] of Object.entries(a.taskModels as Record<string, unknown>)) {
              if (Object.keys(tm).length >= 40) break;
              const key = String(k).trim();
              if (key === '' || key.length > 64) continue;
              if (typeof val !== 'string') continue;
              const model = val.trim();
              if (model === '' || model.length > 120) continue;
              tm[key] = model;
            }
            next.taskModels = tm;
          }
          /**
           * `toolTiers`（P7.3b）：**只收白名单里的类别 × 合法的三档值**。
           * 类别名与档位值的真源在 `services/ai/tools.ts`，这里描字面量是第二份 ——
           * 刻意为之：`core/` 不依赖 `services/`（分层），而这份白名单很短、改它时
           * 两边一起改（`tests/specs/redline.ts` 有一条判据**读两个文件比对**这两份名单）。
           */
          if (a.toolTiers && typeof a.toolTiers === 'object' && !Array.isArray(a.toolTiers)) {
            const cls = AI_TIER_CLASSES;
            const vals = ['off', 'confirm', 'auto'] as const;
            const tiers: NonNullable<AiSettings['toolTiers']> = {};
            for (const [k, val] of Object.entries(a.toolTiers as Record<string, unknown>)) {
              if (!(cls as readonly string[]).includes(k)) continue;
              if (!(vals as readonly string[]).includes(String(val))) continue;
              tiers[k as (typeof cls)[number]] = val as (typeof vals)[number];
            }
            next.toolTiers = tiers;
          }
          /**
           * 模型参数与单价（P7.3c 8.2）：**逐项夹取**（手改 data.json 塞个负数 / 天文数字
           * 不该让费用那一行算出一串看不懂的东西）。⚠️ `maxTokens: 0` 是合法值（= 不限定）。
           */
          const num = (v: unknown, lo: number, hi: number): number | null =>
            typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
          const mt = num(a.maxTokens, 0, 200_000);
          if (mt !== null) next.maxTokens = Math.round(mt);
          const tp = num(a.temperature, 0, 2);
          if (tp !== null) next.temperature = tp;
          const pi = num(a.priceIn, 0, 100_000);
          if (pi !== null) next.priceIn = pi;
          const po = num(a.priceOut, 0, 100_000);
          if (po !== null) next.priceOut = po;
          if (typeof a.priceUnit === 'string') next.priceUnit = a.priceUnit.trim().slice(0, 4);
          /**
           * P7.22b · #5：**按模型定价**逐条夹取 —— 模型名去空白、空串丢弃；
           * 单价照旧夹 [0, 100000]；最多 50 条（手改塞一大坨不至于把设置面板撑爆）。
           */
          if (Array.isArray(a.modelPrices)) {
            const rows: AiSettings['modelPrices'] = [];
            for (const it of a.modelPrices.slice(0, 50)) {
              if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
              const r = it as Record<string, unknown>;
              const model = typeof r.model === 'string' ? r.model.trim().slice(0, 120) : '';
              if (model === '') continue;
              const pi2 = num(r.priceIn, 0, 100_000);
              const po2 = num(r.priceOut, 0, 100_000);
              rows.push({ model, priceIn: pi2 ?? 0, priceOut: po2 ?? 0 });
            }
            next.modelPrices = rows;
          }
          // P7.21b：触发词自动挂载 —— 只收布尔（手改塞别的值一律当没写 = 关）
          if (typeof a.triggerAutoMount === 'boolean') next.triggerAutoMount = a.triggerAutoMount;
          out.ai = next;
        }
        break;
      }
      case 'reconcileSeen': {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const seen: Record<string, string[]> = {};
          for (const [p, list] of Object.entries(v as Record<string, unknown>)) {
            if (Array.isArray(list)) {
              seen[p] = list.filter((x): x is string => typeof x === 'string');
            }
          }
          out.reconcileSeen = seen;
        }
        break;
      }
      case 'moveStats': {
        // 形状收敛只做"结构化清洗"（键/落点非空、计数取整到 1..99）；
        // 上限截断在**记录侧**（suggest-learned 的 recordMove），读侧不悄悄丢数据
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const src = v as { tag?: unknown; dir?: unknown };
          const section = (raw: unknown): Record<string, Record<string, number>> => {
            const outSec: Record<string, Record<string, number>> = {};
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return outSec;
            for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
              const k = key.trim();
              if (!k || !val || typeof val !== 'object' || Array.isArray(val)) continue;
              const dirs: Record<string, number> = {};
              for (const [dir, n] of Object.entries(val as Record<string, unknown>)) {
                const d = dir.trim();
                const num = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
                if (!d || num <= 0) continue;
                dirs[d] = Math.min(num, 99);
              }
              if (Object.keys(dirs).length > 0) outSec[k] = dirs;
            }
            return outSec;
          };
          out.moveStats = { tag: section(src.tag), dir: section(src.dir) };
        }
        break;
      }
      case 'columnsHidden': {
        if (Array.isArray(v)) out.columnsHidden = v.filter((x): x is string => typeof x === 'string');
        break;
      }
      case 'treeOpen': {
        // ⚠️ `''` 是**合法项**（= 库根，P7.24 · T2）—— 白名单只按"是字符串"收，别顺手剔空串
        if (Array.isArray(v)) out.treeOpen = v.filter((x): x is string => typeof x === 'string');
        break;
      }
      case 'treeShowFiles': {
        // P7.23：与 `treeOpen` 同族同口径（字符串数组白名单；旧 data.json 没这个键 → 空数组）
        if (Array.isArray(v)) out.treeShowFiles = v.filter((x): x is string => typeof x === 'string');
        break;
      }
      case 'columnWidths': {
        if (v && typeof v === 'object') {
          for (const [cid, w] of Object.entries(v as Record<string, unknown>)) {
            if (typeof w === 'number' && Number.isFinite(w) && w > 0) out.columnWidths[cid] = w;
          }
        }
        break;
      }
      case 'notesSort': {
        if (v && typeof v === 'object') {
          const s = v as { key?: unknown; dir?: unknown };
          if (typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc')) {
            out.notesSort = { key: s.key, dir: s.dir };
          }
        }
        break;
      }
      case 'kbRoot': {
        /**
         * P7.14：**显式收 `''`**（= 整个库，= vault 根）—— 别再走 default + 尾部兜底那一对：
         * "假值即顶默认"会让空串永远存不进、读不回（这就是此前整个库模式立不起来的原因）。
         */
        if (typeof v === 'string') out.kbRoot = normPath(v);
        break;
      }
      default: {
        if (typeof v === 'string') (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  /**
   * ⚠️ kbRoot **不在这里兜底**（P7.14）：`''` 是合法值（整个库）。它经上面
   * `case 'kbRoot'` 只会落到字符串（初值 = 默认值、唯一赋值点做了类型检查）；
   * 此处原先的 `if (!out.kbRoot)` 假值兜底正是"空串被顶回默认"的入口，已删。
   * metaDir 仍按"假值即顶"（空串不是合法的配置目录）。
   */
  if (!out.metaDir) out.metaDir = DEFAULT_SETTINGS.metaDir;
  return out;
}

function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * **视图档的唯一解析口**（§3.2 + 排查报告 B7 的优先级）。
 *
 * ```
 * 存的是 'detail' / 'grid'  → 那是用户切过的，**以用户为准**（B7）
 * 存的是 null（从没切过）               → **网格**（P6 第八段起，桌面与触屏都是）
 * ```
 *
 * 🔴 **默认档在 P6 第八段从「桌面→详细信息」改成「一律网格」**（用户真机第 5 条：
 * "网格视图设为默认视图"）。改的是**只有 `null` 那一支**：
 * · 存着 `'detail'` 的 = 用户**显式切过**（`modules/notes/index.ts` 是唯一的写入方，
 *   只有真去点那个切换器才会写）→ 一个字都不动（B7："用户显式切过以用户为准"）。
 * · 所以这条改动**不需要版本号迁移**，也不需要给存量用户"重置" —— 他们的是显式选择。
 *
 * ⚠️ `touch` 这个参数**留着但不再分支**：触屏与桌面的默认现在一样（都是网格）。
 * 别删它 —— 调用方（`modules/notes/index.ts`）传的就是它，而且以后若要再分档，
 * 唯一出处还是这里（两处各写一份必漂）。
 */
export function resolveNotesView(stored: NotesView | null, touch: boolean): NotesView {
  void touch;
  return stored ?? 'grid';
}

// ────────────────────────────────────────────────────────────────
// 读写
// ────────────────────────────────────────────────────────────────
export class SettingsStore {
  private current: WorkbenchSettings = structuredCloneish(DEFAULT_SETTINGS);
  /** 订阅者：`changed` = 本次真的变了的键（P7.11 · #9 起带上；订阅方靠它分流轻重） */
  private listeners = new Set<(s: WorkbenchSettings, changed: string[]) => void>();
  private plugin: Plugin;
  /** 读盘完成（见 `isLoaded()`）—— 没读完之前**别按设置做"会动用户布局"的动作** */
  private loaded = false;
  /** 回读校验失败的次数 —— 开发面板会显示，避免"存了像没存"无声无息 */
  public writeFailures = 0;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  get(): Readonly<WorkbenchSettings> {
    return this.current;
  }

  /**
   * 读盘读完了吗。
   *
   * 🔴 **为什么需要它**（P6⑤ 独立审查 A6）：`main.ts` 的 `registerView` 在
   * `await settingsStore.load()` **之前** —— 而视图 `onOpen` 现在会做"收侧栏"那件事，
   * 读的正是设置。冷启动恢复布局时若落在那个窗口里，读到的就是**默认值**：
   * 用户明明把「打开工作台时自动收起侧栏」关掉了，还会被收一次。
   * 口径与 `BoardConfigStore.isLoaded()`、`peek.ts` 那句"配置还没读出来时只接线不动手"同一条。
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<WorkbenchSettings> {
    let raw: unknown = null;
    try {
      raw = await this.plugin.loadData();
    } catch (e) {
      console.error('[经纬] 读插件 data.json 失败', e);
    }
    /**
     * 🔴 **这里是全插件唯一的"读盘入口"**（`save()` 里那次 `loadData()` 是**回读校验**，
     * 不是读盘入口）—— 设置的迁移只挂这一处（17.1）。顺序：**先迁移原始 JSON、
     * 再 `normalizeSettings` 补默认**（反过来就是把迁移写在了默认值的产物上）。
     * ⚠️ 迁移**不写盘**：内存里立刻是迁过的形状，落盘等下一次 `save()`（P7.0b 实测口径）。
     */
    this.current = normalizeSettings(migrateSettings(raw));
    this.loaded = true;
    return this.current;
  }

  /**
   * 合并写入 + **回读校验**（saveData 静默失败的唯一对策）。
   * ⚠️ 写入**串行**：两次紧邻的 save（比如"点忽略"紧跟"跳模块"）如果并发，
   * 后发先落时磁盘上会留下较早的那份全量快照 → 重载后少一次改动（独立审查指出）。
   */
  save(patch: Partial<WorkbenchSettings>): Promise<void> {
    const prev = this.current;
    const next = normalizeSettings({ ...this.current, ...patch });
    this.current = next;
    /**
     * **变更键清单**（P7.11 · #9）：`prev`/`next` **逐键比**（值都小，JSON 串比够用）。
     * 订阅方靠它分流 —— 纯界面偏好（目前只放行 `showSettingHints`）只落盘、
     * 不触发工作台整片重画（"点一下显示说明卡半秒"的根因就是无条件重画）。
     */
    const changed: string[] = [];
    for (const k of Object.keys(next) as (keyof WorkbenchSettings)[]) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) changed.push(String(k));
    }
    const run = async (): Promise<void> => {
      try {
        await this.plugin.saveData(next);
      } catch (e) {
        this.writeFailures += 1;
        console.error('[经纬] 写插件 data.json 抛异常', e);
        throw e;
      }
      // 回读：确认真的落到盘上了
      try {
        const back = normalizeSettings(await this.plugin.loadData());
        if (JSON.stringify(back) !== JSON.stringify(next)) {
          this.writeFailures += 1;
          console.error('[经纬] 设置写入后回读不一致 —— 可能被静默吞掉了', { next, back });
        }
      } catch (e) {
        this.writeFailures += 1;
        console.error('[经纬] 设置回读失败', e);
      }
      for (const fn of Array.from(this.listeners)) fn(next, changed);
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** 写队列（见 save 的说明）*/
  private queue: Promise<void> = Promise.resolve();

  /**
   * 订阅设置变化。回调第二参 `changed` = 本次真的变了的键（P7.11 · #9）。
   * 只写 `(s) => …` 的订阅者照旧可用（第二参是可忽略的）。
   */
  onChange(fn: (s: WorkbenchSettings, changed: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── 库内路径（都由 kbRoot 派生，避免各处硬编码）─────────────
  kbRoot(): string {
    return this.current.kbRoot.replace(/^\/+|\/+$/g, '');
  }

  metaRoot(): string {
    // P7.14：走 joinPath —— kbRoot=''（整个库）时不再产出 `/99_Meta` 那种前导斜杠
    //（下游有直接喂平台的调用：getAbstractFileByPath / adapter.exists 等）
    return joinPath(this.kbRoot(), this.current.metaDir.replace(/^\/+|\/+$/g, ''));
  }

  /** 库内工作台配置目录：`01_新知识库/99_Meta/06_工作台/` */
  workbenchDir(): string {
    return `${this.metaRoot()}/06_工作台`;
  }

  /** 操作日志目录：`…/99_Meta/05_操作日志/` */
  logDir(): string {
    return `${this.metaRoot()}/05_操作日志`;
  }

  /** 模板库目录 */
  templateDir(): string {
    return `${this.metaRoot()}/02_模板库/Templater`;
  }

  /** 路由表（唯一真源，插件 data.json 里不存副本） */
  routeTablePath(): string {
    return `${this.metaRoot()}/02_模板库/标签-目录映射.json`;
  }
}
