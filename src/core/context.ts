/**
 * core/context.ts —— 模块渲染契约与依赖束
 *
 * 为什么单独一个文件：视图与各模块都要拿到同一批服务，而 `main.ts` 又依赖视图
 * （注册视图类型）——把契约放中间，避免 main ↔ view 的循环 import。
 *
 * 模块的渲染签名就是「区域重绘」原语的那一个（方案设计.md §7.2）：
 *   `render(el, state, ctx)` —— state 变就重画这一块，别的模块不受影响。
 */
import type { App } from 'obsidian';
import type { ConfigFiles } from './config-files';
import type { FeatureId, ModuleId, SettingsStore } from './settings';
import type { ModuleGate } from './modules';
import type { Keymap, ModuleKeys } from './keymap';
import type { Store } from './store';
import type { VaultIndex, HealthFlag } from './vault-index';
import type { FrontmatterService } from '../services/frontmatter';
import type { Mover } from '../services/mover';
import type { ReportService } from '../services/report';
import type { SnapshotService } from '../services/snapshot';
import type { AutomationStore } from '../services/automation';
import type { CompletionService } from '../services/completion';
import type { ReconcileRunner } from '../services/reconcile';
import type { ReviewStore } from '../services/review';
import type { AiRef, AiService } from '../services/ai';
/**
 * 停靠端口（d2 期）。⚠️ 这里是 `core` 里唯一的 **type-only** import `ui` ——
 * 刻意为之：停靠的**词汇表**（`DockSide` / `DockState` / 宿主类名）只有一处出处，
 * 就是 `ui/dock.ts`；在这里再描一遍字面量就是第二份，迟早漂。
 * 类型 import 编译后整段消失，运行时没有任何 core → ui 的依赖（也不会成环）。
 */
import type { DockPort } from '../ui/dock';
/**
 * 设置栏 id（P7.2a）：与 `DockPort` 同一条理由 —— 词汇表只有一处出处
 *（`ui/settings/types.ts`）。type-only import，运行时没有任何 core → ui 的依赖。
 */
import type { SettingsSectionId } from '../ui/settings/types';

// ────────────────────────────────────────────────────────────────
// 视图状态（store 的形状）
// ────────────────────────────────────────────────────────────────
/**
 * 顶栏列头槽（P6 段⑥ ④-A）。**故意是个对象而不是裸 `HTMLElement`** ——
 * 视图收尾时要能判"这一份还是不是我那一份"（多标签时 `ctx.colSlot` 会被后开的覆盖），
 * 裸元素没有身份可比。与 `DockPort` 的 `owner()` 是同一条纪律。
 */
export interface ColSlotPort {
  el: HTMLElement;
}

/**
 * 一次「跳到全部笔记」的意图（首页待处理项 / 快捷动作 / 搜索框都走它）。
 * 为什么要一个意图对象：跳转不只是切模块，还要**预筛选 + 预选中 + 光标落操作栏**
 * （交互规格 §2.2/§2.3）。让目标模块自己读，比让首页去操纵它的内部状态干净。
 */
export interface NotesIntent {
  /** 预选目录（'' = 整个知识库） */
  dir?: string;
  /** 预筛选的健康标记（首页「N 篇有失效双链」这类） */
  flags?: HealthFlag[];
  /** 只列这几篇（首页「筛选这几个文件」） */
  paths?: string[];
  /** 预填搜索词（首页搜索框） */
  search?: string;
  /** 预选中这些路径 */
  selectPaths?: string[];
  /** 全选筛选结果 + 光标落操作栏（首页「整理收件箱」） */
  selectAll?: boolean;
}

/**
 * 一次「跳到看板」的意图（快速切换跳板块 / 跳卡片，e2 期 §4.1）。
 *
 * 与 `NotesIntent` 同一套做法：**让目标模块自己读**，比让浮层去操纵它的内部状态干净。
 * 区别是看板这边要"让它看得见"：板块收起着就先展开（那是配置）、再把卡片滚进视野。
 */
export interface BoardIntent {
  /** 定位到某个板块（展开 + 滚过去，光标落到它第一张卡上） */
  sectionId?: string;
  /** 定位到某张卡片（展开所在板块 + 滚过去 + 落光标） */
  path?: string;
}

export interface WorkbenchState {
  activeModule: ModuleId;
  modules: Record<FeatureId, boolean>;
  /** 全库索引是否就绪（未就绪 → 骨架屏，交互规格 §1.5） */
  indexReady: boolean;
  /** 索引变更计数——区域重绘的 key（没变就不重画） */
  indexRevision: number;
  /** 索引里的笔记数（含模板，完成定义要的 43） */
  entryCount: number;
  flagCounts: Record<HealthFlag, number>;
  lastSnapshotAt: number | null;
  /** 库根被改名/移走（交互规格 §1.5 最后一行） */
  kbRootMissing: boolean;
  /** 待「全部笔记」消费的一次性意图（消费靠 `notesIntentSeq` 判新旧） */
  notesIntent: NotesIntent | null;
  notesIntentSeq: number;
  /** 待「看板」消费的一次性意图（同上，用 `boardIntentSeq` 判新旧） */
  boardIntent: BoardIntent | null;
  boardIntentSeq: number;
}

export function initialState(
  activeModule: ModuleId,
  modules: Record<FeatureId, boolean>,
): WorkbenchState {
  return {
    activeModule,
    modules,
    indexReady: false,
    indexRevision: 0,
    entryCount: 0,
    flagCounts: {
      'position-mismatch': 0,
      'placeholder-title': 0,
      'broken-link': 0,
      'external-change': 0,
      'empty-file': 0,
      'fragile-fm': 0,
    },
    lastSnapshotAt: null,
    kbRootMissing: false,
    notesIntent: null,
    notesIntentSeq: 0,
    boardIntent: null,
    boardIntentSeq: 0,
  };
}

// ────────────────────────────────────────────────────────────────
// 依赖束（main.ts 组装，视图与模块消费）
// ────────────────────────────────────────────────────────────────
export interface WorkbenchContext {
  app: App;
  /**
   * **插件自己的目录**（vault 相对路径，如 `.obsidian/plugins/kb-workbench`；P7.2b 加）。
   *
   * 随插件发布的**静态资产**从这儿取 —— 现在只有向导配图：
   * `app.vault.adapter.getResourcePath(`${pluginDir}/assets/wizard/xx.png`)`。
   * main.ts 里它与 `snapshot` / `ai` 用的是**同一份**（组装处那个 `const pluginDir`）。
   */
  pluginDir: string;
  settings: SettingsStore;
  gate: ModuleGate;
  store: Store<WorkbenchState>;
  index: VaultIndex;
  configs: ConfigFiles;
  fm: FrontmatterService;
  snapshot: SnapshotService;
  report: ReportService;
  mover: Mover;
  keymap: Keymap;
  /** 模块键盘路由（视图只绑一次键，按当前模块 + 焦点分派） */
  keys: ModuleKeys;
  /**
   * **停靠宿主**（d2 期 §3.1）：工作台外壳建好窗格、把口子交出来。
   *
   * 🔴 为什么是"外壳建好交出去"而不是"看板自己去找宿主"：宿主要在 `.kbw-shell`
   * 的布局里（`main` 得把宽度让出来），而 `.kbw-shell` 是 `view/workbench-view.ts`
   * 建的。让 board 去 import view 就是**循环 import** —— 现在是 view → board 单向
   *（view 为了收面板 import 了 `closeCardPanel`），这一期不许把它掰成双向。
   *
   * 可缺省：**外壳没起来的时候**（离线单测直接渲染看板模块）没有它，
   * 面板就当"停靠不可用"——配置里写着停靠也按浮层显示，绝不抛错。
   */
  dock?: DockPort;

  /**
   * **顶栏「列头槽」**（P6 段⑥ ④-A）：外壳在顶栏那一行留出的一格，
   * 宽 = 目录栏宽（`--kbw-col-w`），**由当前模块填** —— 「全部笔记」把「目录」二字放进来，
   * 于是「经纬 / 目录 / 全部笔记」三个列头落在**同一基线**，目录树头上多让出 42px。
   *
   * 为什么要有这个口子：顶栏归外壳（`view/workbench-view.ts`）所有，而标题归模块 ——
   * 让 notes 去 import view 找宿主就是**循环 import**，与 `dock` 同一条理由。
   *
   * 可缺省：**外壳没起来的时候**（离线单测直接渲染 notes 模块）没有它 ——
   * 那时目录树表头照旧留在树里（见 `modules/notes/index.ts` 的 `paintTree`），
   * 而不是把标题弄丢。
   *
   * ⚠️ **与 `dock` 同一个单槽警告**：多标签时 `ctx.colSlot` 是"后开的视图胜"，
   * 所以模块要**认一次、用到底**（别每次从 ctx 现取），视图收尾也只撤自己那一份。
   */
  colSlot?: ColSlotPort;

  // ── P3：自动化（§7.1 / §13）────────────────────────────────
  /** 库内 `06_工作台/自动化.json`（两个开关的唯一真源） */
  automation: AutomationStore;
  /** 新建笔记补全 + 「新建笔记」落空文件（`services/completion.ts`） */
  completion: CompletionService;
  /** 自动归位（默认关；只有显式改「文件位置」才搬） */
  reconcile: ReconcileRunner;
  /**
   * 回顾卡（P8）。数据落**库内** `99_Meta/06_工作台/复习.json`（`config-files` 第 4 个条目）——
   * 读写都走它（`ui` 层不直接碰那个文件）；卡片是**派生数据**，不写笔记属性、不建笔记。
   */
  review: ReviewStore;
  /**
   * AI 助手（P6 段④ §11）。**它没有写盘能力** —— 产出的是建议计划，
   * 真正动库的是面板 → `ui/confirm.ts` → `services/mover.ts`。
   */
  ai: AiService;

  /** 打开工作台（已开着就聚焦） */
  activate: () => Promise<void>;
  /** 快捷键表 */
  openKeysHelp: () => void;
  /** 打开 Obsidian 原生设置页（简版：模块开关） */
  openNativeSettings: () => void;
  /**
   * 打开工作台内置设置面板（P3 实做）。
   * `section` = 直接落到哪一栏（P7.2a 加：首页全隐空态的「显示模块」按钮
   * 要落到「首页」栏、教程卡片落到「帮助」栏）——不传 = 上次/第一栏。
   */
  openWorkbenchSettings: (section?: SettingsSectionId) => void;
  /** 快照面板（首页快捷动作 / 底部状态 / 撤销条超时 / 命令面板都走它） */
  openSnapshotPanel: () => void;
  /** 跳到「全部笔记」，可带一次意图（预筛选 / 预选中 / 搜索词） */
  goNotes: (intent?: NotesIntent) => void;
  /** 跳到「看板」，可带一次意图（展开那个板块 / 定位到那张卡）—— e2 期 §4.1 加的 */
  goBoard: (intent?: BoardIntent) => void;
  /**
   * 跳到「首页」（P7.10 补：向导结语的「首页」卡要用 —— 与 goNotes/goBoard 同型，
   * 无意图）。**别再让调用方自己 `store.set` + `settings.save` 拼一份**：那条路
   * 在 `main.ts` 里有两处先例（本口与导航点击），该收敛成一口。
   */
  goHome: () => void;
  /**
   * **重扫全库索引**（P7.11 · #8）：顶栏那枚 ⟳ 与首页全局菜单「重载（重扫全库索引）」
   * **同一件事、一处实现**（`main.ts`）—— 别在调用方拼 `index.rebuild()` + 通知。
   */
  reloadIndex: () => void;
  /** 快速切换浮层（§4.1：跳笔记 / 跳板块 / 跑命令） */
  quickSwitch: () => void;
  /** 快速捕获浮层（§4.3：往指定板块丢一条，不离开当前工作） */
  quickCapture: () => void;
  /**
   * **把一篇笔记以看板那套卡片小窗打开**（P7.2d · 16.9-c「最近改动」的桥）。
   *
   * 语义与 `ui/menu.ts` 的 `MenuCtx.openFloating` 是同一条：**"看板给了钩子才有"** ——
   * 卡片小窗是看板域的能力，别的模块（首页）不自己造第二种小窗。
   * 返回值：`true` = 已在某扇小窗里开着（抬到最前/闪一下那条路也算"处理了"）、
   * 或真的开了；`false` = **处理不了**（看板模块关着 / 路径不在索引里）——
   * 调用方照旧退到"开标签页"（条目 `title` 里写明两种方式）。
   *
   * ⚠️ 装配点在 `main.ts`（**插件级**、不是"看板模块挂载时挂"）：
   * 「最近改动」住在首页，而看板模块在首页时**已被卸载** ——
   * 挂在模块上那个口子在它唯一的使用场景里永远拿不到（记录见 `期末交接-P7.2.md` 2d 段）。
   * 可缺省：**离线单测手搓 ctx** 时不传（那时退标签页，不抛错）。
   */
  openNoteWindow?: (path: string) => boolean;
  /**
   * AI 助手浮层（§11）。`seed` = 预填进输入框的一句话
   * （首页搜索框"搜不到 → 提议交给 AI"那条就是把搜索词带过来）。
   *
   * **P7.3c 5.3 增补**：`refs` = 一进来就带上的 `@` 引用（右键「问 AI」那条路：
   * 那一篇笔记 / 编辑器里那一段选区）。⚠️ 引用要**在面板里显形**（胶囊），
   * 别只把内容塞进 `seed` 文本 —— 用户得看得见"这一问带了什么材料"。
   */
  openAi: (seed?: string, refs?: AiRef[]) => void;
  /** 首次使用向导（§14）。自动弹由 `main.ts` 判；这里只是「随时可重开」那个口 */
  openWizard: () => void;
  /** 「这一期还没到」的统一说法，别各处自己写文案 */
  notYet: (round: string, what: string) => void;
}

/**
 * 模块渲染契约（方案设计.md §7.2）。
 * 返回值是**清理函数**：模块内部的订阅与定时器要在模块被换掉/视图关闭时收干净
 * （P1 起模块自己订阅索引做区域重绘，不再由外壳每次清空重画）。
 */
export type ModuleCleanup = () => void;
export type ModuleRender = (el: HTMLElement, ctx: WorkbenchContext) => ModuleCleanup | void;
