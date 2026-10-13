/**
 * core/config-files.ts —— **库内配置层**：四个 JSON 的读写与变更监听
 *
 * 唯一真源原则（方案设计.md §3.1）：有意义的配置一律放**库内文件** ——
 * 可见、可手改、可 Git、可分享、跟着库走；改完不用重载插件（监听文件变化）。
 * 插件 `data.json` 只放"这台机器 / 这个界面"的东西（`core/settings.ts`）。
 *
 * 四个文件都在 `01_新知识库/99_Meta/06_工作台/`：
 *   看板配置.json   P4 用
 *   库结构.json     P5 用
 *   自动化.json     P3 用
 *   复习.json       P8 用（回顾卡：**用户数据**，不是界面偏好 —— 所以它在这儿，不在 data.json）
 *
 * ⚠️ 本模块是 P3/P4/P5/P8 的根 —— P0 只提供读写与监听，**不主动创建文件**
 *（谁的期谁负责第一次落盘；`ensure()` 只在对应模块真要用的时候调）。
 */
import { TFile, type App, type EventRef } from 'obsidian';
import { SettingsStore } from './settings';
import { joinPath, parentDir } from './paths';
import { markSelfWrite } from './writes';
import { debounce } from './util';
// ⚠️ core 里第二个 import services 的地方（第一个是 vault-index → schema）：
// 为了**默认值只留一份**（见 automationDefaults 的注释）。这个 import 是单向的
// —— services/automation.ts 只 `import type` 本文件，编译后没有循环。
import { AUTO_DEFAULTS } from '../services/automation';
// 同一条理由（第三个）：回顾卡的**数据形状**只留在 `services/review.ts`
//（`reviewDefaults` 调它）—— 别在这儿再抄一份。
import { reviewDefaults } from '../services/review';

export type ConfigName = 'board' | 'rebuild' | 'automation' | 'review';

/**
 * 骨架 7 个种子页的**初始内容**（P7.2b 初始化模式创建用）。
 *
 * 形状照 v2 五件套：`类型/创建日期/tags/文件位置` +
 * 一句定位 + 待长区。`文件位置` 写的就是自家目录 —— 这样「收拢后复跑重排应 0 搬动」
 * 对新建的种子页自动成立（声明 == 实际）。
 * ⚠️ v2（P7.12）：中心页类型收拢为 `索引`；不写「领域」（退役）、不写状态
 * （结构页可不写状态 —— 「持续更新」也已退役）。
 *
 * ⚠️ **没收录的种子不创建**（`null`）：用户往骨架里手加了 seedFiles 时如实报出，
 * 别拿空文件糊弄（P5 那句"建文件要内容"的旧账，在初始化这里是"有内容的才建"）。
 */
export function seedContentOf(rel: string, today: string): string | null {
  const m: Record<string, { type: string; tags: string[]; title: string; line: string }> = {
    '00_Inbox/_收件箱.md': {
      type: '索引', tags: ['MOC'], title: '📥 收件箱中心',
      line: '零思考捕获区。任何来不及分类的内容先扔这里，定期清空一次。',
    },
    '01_Projects/_项目中心.md': {
      type: '索引', tags: ['MOC', 'GTD'], title: '🚀 项目中心',
      line: '有明确目标 + 截止时间的事项。项目做完后移到 `04_Archives`。',
    },
    '02_Areas/_领域中心.md': {
      type: '索引', tags: ['MOC'], title: '🧭 领域中心',
      line: '需要长期维持的方面（内容创作 / 游戏研究 / 生活健康 …）。',
    },
    '03_Resources/_资源中心.md': {
      type: '索引', tags: ['MOC'], title: '📚 资源中心',
      line: '将来可能有用的素材、参考与收藏。',
    },
    '04_Archives/_归档中心.md': {
      type: '索引', tags: ['MOC'], title: '🗄️ 归档中心',
      line: '已完成、已结束、过时的内容。归档不是删除，是给活跃内容腾地方。',
    },
    '99_Meta/04_索引与地图/MOC_知识地图.md': {
      type: '索引', tags: ['MOC'], title: '🗺️ 知识地图',
      line: '全库的目录页：从核心笔记出发的双链索引，慢慢长。',
    },
    '99_Meta/04_索引与地图/知识库目录说明.md': {
      type: '规范', tags: ['目录', '索引'], title: '📖 知识库目录说明',
      line: '这套目录各是干什么的、笔记该放哪 —— 忘了就看这里。',
    },
  };
  const hit = m[rel];
  if (!hit) return null;
  const dir = parentDir(rel);
  return [
    '---',
    `类型: ${hit.type}`,
    `创建日期: ${today}`,
    'tags:',
    ...hit.tags.map((t) => `  - ${t}`),
    ...(dir ? ['文件位置:', `  - ${dir}`] : []),
    '---',
    '',
    `# ${hit.title}`,
    '',
    `> ${hit.line}`,
    '',
    '## 📇 自动索引',
    '',
    '- 这一节留给「骨架补全 / 查询」类功能往里挂；也可以自己手工列双链。',
    '',
  ].join('\n');
}

export interface ConfigDef {
  name: ConfigName;
  file: string;
  title: string;
  /** 哪一期负责第一次落盘 */
  round: string;
  defaults: () => unknown;
}

/** P5 的目标骨架（开发计划 §10 定稿的格式；21 个目录含 P2 新加的 `生活健康` 与工作台配置目录） */
function rebuildDefaults(): unknown {
  return {
    version: 1,
    rootName: '01_新知识库',
    dirs: [
      '00_Inbox',
      '01_Projects',
      '01_Projects/01_执行中',
      '01_Projects/02_待跟进',
      '01_Projects/03_孵化箱',
      '02_Areas',
      '02_Areas/内容创作',
      '02_Areas/游戏研究',
      '02_Areas/每日任务',
      '02_Areas/灵感杂记',
      '02_Areas/生活健康',
      '03_Resources',
      '04_Archives',
      '99_Meta',
      '99_Meta/01_仪表盘',
      '99_Meta/02_模板库',
      '99_Meta/02_模板库/Templater',
      '99_Meta/03_AI指令集',
      '99_Meta/04_索引与地图',
      '99_Meta/05_操作日志',
      '99_Meta/06_工作台',
    ],
    seedFiles: [
      '00_Inbox/_收件箱.md',
      '01_Projects/_项目中心.md',
      '02_Areas/_领域中心.md',
      '03_Resources/_资源中心.md',
      '04_Archives/_归档中心.md',
      '99_Meta/04_索引与地图/MOC_知识地图.md',
      '99_Meta/04_索引与地图/知识库目录说明.md',
    ],
    excludedTop: ['.obsidian', '.trash', '.tooling', '02_旧知识库'],
    keepTop: [],
  };
}

// ────────────────────────────────────────────────────────────────
// 骨架预设（P7.2b · 16.1）
//
// 🔴 **这一块必须放在 `rebuildDefaults()` 之后**：`scripts/make-share-pack.mjs` 与
// `scripts/make-demo-vault.mjs` 用 `/dirs:\s*\[([\s\S]*?)\]/` 从本文件**正则读骨架**，
// 认的是**全文件第一条** `dirs: [` —— 放前面会把"基础版 9 条"读成骨架、打包脚本当场 fail
// （P7.2b 独立审查 🔴1 实测）。redline 里有一条静态钉盯着这个次序。
// ────────────────────────────────────────────────────────────────

/** 骨架预设（P7.2b · G3-①）：两档清单任意一份 + 「手改过」 */
export type SkeletonPreset = 'basic' | 'full' | 'custom';

/**
 * **基础版预设**（P7.2b · G3-① 拍板：9 目录 / 0 种子页）—— 易上手；
 * 以后一键升完整版 = 走一次重排（只加不删，天然幂等）。
 * ⚠️ 它是**清单**，不是骨架文件格式：面板切换预设 = 把 dirs/seedFiles 覆写成这份清单。
 */
export const BASIC_PRESET: { dirs: string[]; seedFiles: string[] } = {
  dirs: [
    '00_Inbox',
    '01_Projects',
    '02_Areas',
    '03_Resources',
    '04_Archives',
    '99_Meta',
    '99_Meta/02_模板库',
    '99_Meta/05_操作日志',
    '99_Meta/06_工作台',
  ],
  seedFiles: [],
};

/**
 * 两档预设的**唯一清单出处**（P7.2b）：完整版直接从 `rebuildDefaults()` 派生 ——
 * **别抄第二份**（改了骨架清单而预设没跟着改，切预设就会把骨架覆写回旧清单）。
 */
export function skeletonPresets(): {
  basic: { dirs: string[]; seedFiles: string[] };
  full: { dirs: string[]; seedFiles: string[] };
} {
  const full = rebuildDefaults() as { dirs: string[]; seedFiles: string[] };
  return {
    basic: { dirs: [...BASIC_PRESET.dirs], seedFiles: [...BASIC_PRESET.seedFiles] },
    full: { dirs: [...full.dirs], seedFiles: [...full.seedFiles] },
  };
}

/**
 * P4 的看板**视图默认值**（交互规格 §7.4 / §8.1 的默认档）。
 *
 * ⚠️ **唯一真源**：`ui/settings/board.ts`（设置面板那七栏之一）import 的就是它 ——
 * 面板里再抄一份的话，"面板改了默认、P4 建板块时用的还是老值"就会漂
 * （独立审查在 P3 收尾时抓到过：当时有 2 份活代码 + 文档那张表 = 三份）。
 */
export const BOARD_VIEW_DEFAULTS = {
  cardMode: 'content', // 只内容（默认）
  /**
   * 板块形态（P4.5 §2.1 / 拍板 Q4）：`columns` = 并排的纵向列（**默认**）· `flow` = 横排换行。
   * ⚠️ **窄档（<640px）由 CSS 强制回流式**，不看这个值 —— 窄屏横向滚是很差的手感，
   * 而"窄"是**容器宽度**决定的（工作台可能被别的标签页挤窄），不是配置。
   */
  flow: 'columns',
  /**
   * 「两者」档下属性块占卡片高度的比例；`null` = 自动（按内容撑）。
   * 拖动卡片里那根分隔条会把它写实（同时把卡片锁成固定高度）。
   */
  propsRatio: null,
  /** 每条笔记自己的属性/正文比例（路径 → 比例）；空对象 = 都用全局那份 */
  propsRatioByPath: {},
  /**
   * 悬浮小窗显示多少属性（few = 前 6 行 + 展开链接；all = 全铺；**none = 不显示**）。
   *
   * 🔴 **C2（2026-09-27 用户拍板）把默认从 `few` 改成 `none`** —— 原话是
   * "我需要默认只显示笔记正文"。⚠️ 只改这一个常量**不够**：存量 `看板配置.json` 里
   * 那个 `"panelProps": "few"` 是**旧默认被物化**下来的（不是用户选的），不改它的话
   * "改默认"对已经打开过看板的库一点效果都没有（本项目在"恢复默认值"上栽过一次）
   * → 配套的**一次性迁移**在 `modules/board/config.ts` 的 `migrateLegacyView()`（认版本号）。
   */
  panelProps: 'none',
  /** 悬浮小窗的正文：editor = 真编辑器（可编辑）· preview = 只读渲染（剥前言/尾链）· none = 不显示 */
  panelContent: 'editor',
  /**
   * **预览换行**（P6b ⑥，用户 2026-09-27 原话："看板窗口笔记预览内容**要换行，默认换行显示**，
   * 也可以设置为**当前可以左右拖动的状态**"）：卡片摘要与只读预览都按这个值折行。
   *
   * · `true`（**默认**）= `overflow-wrap: anywhere` + 不横滚；
   * · `false` = 回到"文本按原样、容器横向滚"（读宽表格/长代码时更顺手）。
   * ⚠️ 边界（文档要写明）：`white-space` 只管**文本** —— 表格/代码块仍按内容宽度排，
   * 关掉换行之后它们照旧横向滚（那是 Markdown 的语义，不是我们的开关能改的）。
   */
  previewWrap: true,
  /**
   * **小窗字号**（f 期第 2 条，用户 2026-09-26 要）：`0` = **没设过 → 用默认**。
   * ⚠️ C1（2026-09-27）起，默认**不是"跟随平台"**而是**平台 −2px**（`defaultPanelFont()`；P6b ⑤ 从 −1 又降了一档）。
   * >0 = 那一扇小窗里的文字按这个 px 走（正文本体 + 面板自己的行）。
   * 面板里 `Ctrl+滚轮` 缩放写的就是它；**每一篇可以单独覆盖**（`panelByPath[path].font`）。
   * ⚠️ 量出来的机制在 `看板优化方案.md` §6.18：正文走 `--font-text-size`（**P7.12 收尾补：
   * 1.13.7 的正文规则读 `--font-preferred-size`，两个都要设** —— 见 `panel-ui.ts` 的 `applyPanelFont`），
   * 面板自己那几行走 `--kbw-cw-scale` —— 两者都由同一个值算出来，只改一处。
   */
  panelFont: 0,
  /**
   * **小窗里属性块占面板高度的比例**（f 期第 5 条）：`null` = 自动（按内容撑）。
   * 与卡片的 `propsRatio` 是**同一套形状**（可拖的分隔条 + 看板级默认 + 每篇覆盖），
   * 但**各占一个字段**：卡片是卡片、小窗是小窗，尺寸口径完全不同，
   * 合成一个的话"拖了卡片的分隔条，小窗跟着变"（用户没要过那个）。
   */
  panelPropsRatio: null,
  /**
   * **每一条笔记自己的小窗设置**（f 期第 3 条）：路径 → 那一篇的覆盖。
   *
   * 🔴 为什么合成**一个** map 而不是四份 `panelXxxByPath`（与 `propsRatioByPath` 那套不同）：
   * 这些键**全部**要跟着 `vault.on('rename')` 迁（表里存的是路径，本项目在这上面栽过好几次）——
   * 四份表就是四处迁移点，漏一处是**静默失效**（那一篇的设置凭空回默认）。
   * 一份 map = 一个迁移点。值里每个键都可缺省：缺 = 跟随看板默认。
   * ⚠️ 值的形状**只有一处出处**（`modules/board/config.ts` 的 `PanelPref`），
   * 这里只给一个空对象当默认值（与 `propsRatioByPath` 同一条写法）。
   */
  panelByPath: {},
  /**
   * **面板钉住**（d 期 §3.1）：钉住后点外面不关，直到手动关（IDE tool window 口径）。
   * 进配置而不是临时态 —— 它是用户对"这个面板该怎么待着"的**偏好**，关一次再开又变回
   * "点外面就关"会很烦。⚠️ 只记住这个开关；**开着哪几篇（tab 列表）不进配置** ——
   * 那是"这一会儿在编辑什么"，且库内配置会跟着同步走，不该把工作现场带过去。
   */
  panelPinned: false,
  /**
   * **停靠**（d2 期 §3.1）：面板钉在工作台的哪一边，`null` = 不停靠（还是浮层那套）。
   * 与 `panelPinned` 同一类东西 —— 它是"这个面板该怎么待着"的**偏好**，跨会话该记住。
   * ⚠️ 尺寸是**一个数**：左右两边当"宽"、底部当"高"（见 `ui/dock.ts` 的 `maxSize`）。
   *
   * ⚠️ 与 `panelPinned` 一样**不算"视图参数"**：不参与「恢复本视图默认设置」，
   * 也不进 `isViewDirty`（那是卡片/密度那些参数的记账）。
   */
  dock: { where: null as 'left' | 'right' | 'bottom' | null, size: 380 },
  /**
   * **预览窗格（Peek，e 期 §3.2）**：`enabled` 默认 **false**（拍板 Q2 的原话是"要，**默认关**"）。
   *
   * 它与 `dock` 是**同一个宿主的两种占用**（互斥：开一个收另一个，见
   * `modules/board/peek.ts` 头注释）—— 所以形状完全一样，只是**没有"不停靠"这一档**：
   * Peek 只有窗格形态（浮起来的预览就是决策 5 否掉的那个东西）。
   */
  peekEnabled: false,
  peek: { where: 'right' as 'left' | 'right' | 'bottom', size: 380 },
  cardWidth: 240,
  /**
   * **卡片高度**：`0` = 自动（按摘要行数）。
   *
   * 🔴 **P7.5（8.1 体检 M1 + 独立审加固）补进这张表**：它是历史遗漏 —— 这一栏在设置面板
   * 里**会渲染**，却一直没进"默认集合"，于是"看板配置.json 还没被 `normalizeView` 物化过"
   * 的库上 `undefined` 一路流进输入框（显示空框）、`save()` 落盘时该键被 `JSON.stringify`
   * 静默丢掉。值 `0` 与 `normalizeView` 的兜底（`clampNum(o.cardHeight, 0, CARD_H_MAX, 0)`）
   * 同源 —— 也把它改成读这里，别再各写一份。
   */
  cardHeight: 0,
  gap: 12,
  allowDuplicate: true,
  hideEmpty: false,
  shelter: false, // 显示收容所：默认关
  summaryLines: 3,
  showHidden: false,
  stripFrontmatter: true,
  stripTail: true,
} as const;

/** P4 的看板配置整份默认值 */
function boardDefaults(): unknown {
  return { version: 1, view: { ...BOARD_VIEW_DEFAULTS }, sections: [] };
}

/**
 * P3 的自动化默认值（交互规格 §7.1）。
 * ⚠️ **形状只留在 `services/automation.ts` 一处**（`AUTO_DEFAULTS`）——
 * 这里抄一份的话，"别处改了默认值、这里没改"就会漂（P2 的 `AREA_DIRS` 就是这么漂的）。
 * 加 `version` 是因为它是**库内文件**，将来要能按版本迁移。
 */
function automationDefaults(): unknown {
  return { version: 1, ...JSON.parse(JSON.stringify(AUTO_DEFAULTS)) };
}

export const CONFIGS: Record<ConfigName, ConfigDef> = {
  board: { name: 'board', file: '看板配置.json', title: '看板配置', round: 'P4', defaults: boardDefaults },
  rebuild: { name: 'rebuild', file: '库结构.json', title: '库结构', round: 'P5', defaults: rebuildDefaults },
  automation: { name: 'automation', file: '自动化.json', title: '自动化', round: 'P3', defaults: automationDefaults },
  review: { name: 'review', file: '复习.json', title: '复习', round: 'P8', defaults: reviewDefaults },
};

export type ConfigListener = (name: ConfigName, data: unknown) => void;

export class ConfigFiles {
  private app: App;
  private settings: SettingsStore;
  private listeners = new Set<ConfigListener>();
  private refs: EventRef[] = [];
  private cache = new Map<ConfigName, unknown>();
  private flush = debounce(() => void this.refreshPending(), 150);
  private pending = new Set<ConfigName>();

  constructor(app: App, settings: SettingsStore) {
    this.app = app;
    this.settings = settings;
  }

  pathOf(name: ConfigName): string {
    return joinPath(this.settings.workbenchDir(), CONFIGS[name].file);
  }

  /** 读。**文件不存在就返回默认值，不写盘**（谁的期谁负责第一次落盘） */
  async read<T = unknown>(name: ConfigName): Promise<T> {
    const path = this.pathOf(name);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        const text = await this.app.vault.read(f);
        const data = JSON.parse(text);
        this.cache.set(name, data);
        return data as T;
      } catch (e) {
        console.error(`[经纬] 解析 ${path} 失败，退回默认值`, e);
        return CONFIGS[name].defaults() as T;
      }
    }
    return CONFIGS[name].defaults() as T;
  }

  async exists(name: ConfigName): Promise<boolean> {
    const f = this.app.vault.getAbstractFileByPath(this.pathOf(name));
    return f instanceof TFile;
  }

  /**
   * **读 + 把"文件坏了"这件事说出来**（P8 · 回顾期 2 加；形状照 `services/routes.ts`
   * 的 `readRouteTable`，那里早就这么干了）。
   *
   * 🔴 为什么非有不可：`read()` 遇 `JSON.parse` 失败只 `console.error` 然后**返回默认值** ——
   * 调用方拿不到"解析失败"这个信号，于是"读到一个空默认值"和"文件坏了"长得一模一样。
   * 对一个**用户数据**文件（复习.json 是手写的卡片）来说那是致命的：紧接着一次
   * read-modify-write 就会拿"空表"拼出整份新文件**把用户的卡片全抹掉**。
   * 本文件恰是被鼓励手改的（面板头明写「库内文件：…」），而真库同步就在同一进程里跑
   *（CLAUDE.md 红线）—— 同步写一半的 JSON 也会走到这条路上。
   *
   * `broken` 非空 = **存在但读不动**（解析失败）；`exists: false` 才是"还没建"。
   * 调用方必须区别对待：坏的**不许写**。
   */
  async readDetailed<T = unknown>(
    name: ConfigName,
  ): Promise<{ data: T; exists: boolean; broken: string | null }> {
    const path = this.pathOf(name);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      return { data: CONFIGS[name].defaults() as T, exists: false, broken: null };
    }
    try {
      const text = await this.app.vault.read(f);
      const data = JSON.parse(text);
      this.cache.set(name, data);
      return { data: data as T, exists: true, broken: null };
    } catch (e) {
      console.error(`[经纬] 解析 ${path} 失败`, e);
      return {
        data: CONFIGS[name].defaults() as T,
        exists: true,
        broken: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * **同步读缓存**（P7.2c）—— 只给"菜单必须同步画出来"这类场景用（右键菜单在
   * `contextmenu` 那一帧就得出现，`read()` 是异步的、来不及）。
   *
   * 缓存由这三条路热起来/保鲜：① 任何人 `read()`/`write()` 过它；② 插件 onload 的
   * 预热（`main.ts` 里那行 `void ctx.configs.read('board')`）；③ 文件变化监听
   *（`attach()` → `refreshPending()` 自己会读一遍再更新缓存）。
   * **没热过就是 `null`** —— 调用方按"这项先不画"处理（下一次就有），别拿 `defaults()`
   * 硬造一份（那等于绕过"配置文件还没落盘"这个真实状态）。
   */
  cached<T = unknown>(name: ConfigName): T | null {
    const v = this.cache.get(name);
    return v === undefined ? null : (v as T);
  }

  /** 确保存在（不存在就把默认值写下去）—— 给 P3/P4/P5 用 */
  async ensure<T = unknown>(name: ConfigName): Promise<T> {
    const path = this.pathOf(name);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) return this.read<T>(name);
    const data = CONFIGS[name].defaults() as T;
    await this.write(name, data);
    return data;
  }

  /**
   * 写。走 `vault.process`（原子 + 走 vault 队列）——真库的同步就在同一进程里跑，
   * 直接 `adapter.write` 会和它抢。目录不存在时先 `mkdir`（S3 实测：一次建多级）。
   */
  async write<T>(name: ConfigName, data: T): Promise<void> {
    const path = this.pathOf(name);
    const text = JSON.stringify(data, null, 2) + '\n';
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      markSelfWrite(path);
      await this.app.vault.process(existing, () => text);
    } else {
      const dir = parentDir(path);
      if (dir && !(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      markSelfWrite(path);
      await this.app.vault.create(path, text);
    }
    this.cache.set(name, data);
    /**
     * ⚠️ **自己写的也要通知订阅者**：写完之后 cache 与文件内容一致，于是防抖那一轮
     * （`refreshPending` 比 cache vs 文件）判成"没变"→ **一次都不会通知**。
     * 后果是真机上看得见的：在设置面板改「看板默认值」（写的是**同一份**
     * 看板配置.json 的 view 段），开着的看板不会跟着变，要切走再回来。
     */
    this.emit(name, data);
  }

  /** 监听单个配置的变化 */
  watch(name: ConfigName, cb: (data: unknown) => void): () => void {
    const fn: ConfigListener = (n, data) => {
      if (n === name) cb(data);
    };
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 监听全部（P3/P4/P5 都可能要"配置被外面改了"的广播） */
  onChange(cb: ConfigListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 挂上文件变化监听（插件 onload 调一次） */
  attach(): void {
    if (this.refs.length > 0) return;
    const nameByPath = new Map<string, ConfigName>();
    for (const def of Object.values(CONFIGS)) nameByPath.set(def.file, def.name);

    const consider = (path: string | undefined, deleted: boolean): void => {
      if (!path) return;
      const base = path.split('/').pop() ?? '';
      const name = nameByPath.get(base);
      if (!name) return;
      // 还要确认是工作台目录下那一个（同名的别处文件不管）
      if (path !== this.pathOf(name)) return;
      if (deleted) {
        this.cache.delete(name);
      }
      this.pending.add(name);
      this.flush();
    };

    this.refs.push(
      this.app.vault.on('modify', (f) => consider(f?.path, false)),
      this.app.vault.on('create', (f) => consider(f?.path, false)),
      this.app.vault.on('delete', (f) => consider(f?.path, true)),
      this.app.vault.on('rename', (f, old) => {
        consider(old, true);
        consider(f?.path, false);
      }),
    );
  }

  private async refreshPending(): Promise<void> {
    const names = Array.from(this.pending);
    this.pending.clear();
    for (const name of names) {
      // ⚠️ 必须在 `read()` 之前把旧值取出来：`read()` 自己也会更新 cache，
      // 之后再比就永远相等 → 监听者一次都收不到（新加的配置层测试抓到的真 bug）
      const prev = this.cache.get(name);
      const data = await this.read(name);
      if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(data)) continue;
      this.cache.set(name, data);
      this.emit(name, data);
    }
  }

  /** 通知订阅者（外部改动与**我们自己写的**都走这里，见 `write()` 的注释） */
  private emit(name: ConfigName, data: unknown): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(name, data);
      } catch (e) {
        console.error('[经纬] 配置监听者出错', e);
      }
    }
  }

  dispose(): void {
    for (const ref of this.refs) this.app.vault.offref(ref);
    this.refs = [];
    this.listeners.clear();
    this.flush.cancel();
  }
}
