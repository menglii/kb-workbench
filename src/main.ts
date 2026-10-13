/**
 * main.ts —— 插件入口
 *
 * ⚠️ 注册顺序（platform-pitfalls #4）：`registerView` / `addRibbonIcon` / `addCommand` /
 * `addSettingTab` **全部同步放在最前面**，配置读取与索引构建放后面。
 * `onload` 里若先 `await`，注册会被排进微任务——生产环境等价，但时序不可见，调试时极易误判。
 *
 * 服务组装顺序（依赖关系）：
 *   settings → gate → store/keymap → 索引与配置 → 安全三件（report / snapshot / mover）→ ctx → 视图
 */
import { Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, SettingsStore, shouldShowWizard } from './core/settings';
import { ModuleGate } from './core/modules';
import { Store } from './core/store';
import { KEY_ACTIONS, Keymap, ModuleKeys, installGlobalEscape, type KeyActionId } from './core/keymap';
import { ConfigFiles } from './core/config-files';
import { VaultIndex, kbDirsOf } from './core/vault-index';
import { registerCommands } from './core/commands';
import {
  initialState,
  type BoardIntent,
  type NotesIntent,
  type WorkbenchContext,
  type WorkbenchState,
} from './core/context';
import { FrontmatterService } from './services/frontmatter';
import { ReportService } from './services/report';
import { SnapshotService } from './services/snapshot';
import { Mover } from './services/mover';
import { AutomationStore } from './services/automation';
import { CompletionService } from './services/completion';
import { ReviewStore } from './services/review';
import { ReconcileRunner, type ReconcileMove } from './services/reconcile';
import { LEARN_SOURCES, MoveLearner } from './services/suggest-learned';
import { AI_LIMITS, AiService, type AiRef } from './services/ai';
import { openAiPanel } from './ui/ai-panel';
import { openWizard } from './ui/wizard';
import { joinPath, parentDir, relativeTo } from './core/paths';
import { debounce } from './core/util';
import { findSyncMarkers, keySyncNotice, shouldWarnKeySync } from './core/key-safety';
import { clearViewMemory, remapScrollPath } from './core/view-memory';
import { pruneOrder, remapOrder } from './modules/notes/grid-order';
import { ensureWindowDeps, openCardWindow } from './modules/board/editor';
import { recordOnboarding } from './modules/home/onboarding';
import { VIEW_TYPE, WorkbenchView } from './view/workbench-view';
import { NativeSettingsTab } from './settings-tab';
import { openKeysHelp } from './ui/keys-help';
import { brandMark } from './ui/primitives';
import { disposeNotices, notifyInfo, notifyLight, notifyPartial, setLogSink } from './ui/notify';
import { disposeUndoBar } from './ui/undo-bar';
import { closeAllMenus } from './ui/menu';
import { purgeOverlays } from './ui/panel';
import { openSnapshotPanel } from './ui/snapshot-panel';
import { openSettingsPanel, type SettingsSectionId } from './ui/settings-panel';
import { openNewNoteDialog } from './ui/new-note';
import { openRebuildPanel } from './ui/rebuild-panel';
import { openQuickSwitch } from './ui/quick-switch';
import { openQuickCapture } from './ui/quick-capture';
import { registerEditorMenu } from './ui/editor-menu';
import { registerNativePositionMenu } from './ui/native-position';
import { showMoveUndo } from './ui/undo-move';
import { promptText } from './ui/prompt';
import { openTitlePanel } from './ui/title-panel';
import { runBeautify } from './ui/beautify';
import { runInboxTidy } from './modules/home/tidy';
import { sanitize } from './services/completion';

export default class KbWorkbenchPlugin extends Plugin {
  private settingsStore!: SettingsStore;
  private gate!: ModuleGate;
  private store!: Store<WorkbenchState>;
  private keymap!: Keymap;
  private keys!: ModuleKeys;
  private index!: VaultIndex;
  private configs!: ConfigFiles;
  private fm!: FrontmatterService;
  private report!: ReportService;
  private snapshot!: SnapshotService;
  private mover!: Mover;
  private automation!: AutomationStore;
  private completion!: CompletionService;
  private reconcile!: ReconcileRunner;
  private review!: ReviewStore;
  private ai!: AiService;
  private ctx!: WorkbenchContext;
  /**
   * 本次会话里向导弹过没有。
   *
   * 🔴 **为什么不放 `data.json`**：那是**持久**的三态标记（`wizardDone`），
   * 语义是"这个库配过没有"；这一个的语义是"**这次开着 Obsidian 的这段时间**里已经弹过"。
   * 两者都要 —— 少了这一个，用户关掉工作台再打开就会**又**弹一次（同一次会话内）。
   */
  private wizardShownThisSession = false;
  /** 上次的"库根|元数据目录"（用来判断要不要重建索引） */
  private rootKey = '';
  /** "上次看见的声明"落盘（防抖 800ms） */
  private saveSeen = debounce((next: Record<string, string[]>) => {
    void this.settingsStore.save({ reconcileSeen: next });
  }, 800);
  /**
   * 「学你过往的修正」（P7.6）——记录器在这里装配（唯一持有处）。
   * ⚠️ 只学**手动**来源（`LEARN_SOURCES`）：`reconcile`（自动）不学、`ai` 不学（放大器）、
   * `rebuild` 不学（钝工具）、`template` 不学。学习记录落 `data.json`（G6-Q5 拍板）。
   */
  private learner!: MoveLearner;

  async onload(): Promise<void> {
    // 上一次实例可能留下悬挂的浮层 DOM（通知容器挂在 body 上，不随视图销毁）
    // → 加载时先收干净，保证"重载之后 body 上不留孤儿"（真机探针量到过 9 个）
    disposeNotices();
    disposeUndoBar();
    // 菜单/模态/浮层也挂在 body 上：重载时若正开着，会留下孤儿（`.kbw-backdrop` 是全屏遮罩，
    // 挡住整块工作台且 Esc 层已随卸载消失 —— 只能靠点它自己关）
    closeAllMenus();
    purgeOverlays();
    // 上一次实例镜像在 body 上的外观属性（P7.7 · 10.1）—— 新实例会按自己的设置重写
    document.body.removeAttribute('data-motion');

    // ── ① 组装（全同步，不 await）──────────────────────────────
    this.settingsStore = new SettingsStore(this);
    this.gate = new ModuleGate(this.settingsStore, (msg) => notifyInfo(msg));
    this.store = new Store<WorkbenchState>(
      initialState(DEFAULT_SETTINGS.activeModule, { ...DEFAULT_SETTINGS.modules }),
    );
    this.keymap = new Keymap(() => this.settingsStore.get().keymap);
    this.keys = new ModuleKeys();

    this.fm = new FrontmatterService(this.app);
    this.report = new ReportService(this.app, this.settingsStore);
    this.index = new VaultIndex(this.app, this.settingsStore);
    /**
     * 插件自己的目录（vault 相对路径）——**一份，三处共用**（快照、AI 会话、向导配图）。
     * `manifest.dir` 真机上有、桩里也默认填；兜底那句照旧是保险。
     */
    const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    this.snapshot = new SnapshotService(
      this.app,
      pluginDir,
      () => this.settingsStore.kbRoot(),
      // 还原写回内容前的守卫：这份文件被**别处**改过吗（§1.5 不静默覆盖）
      (path) => this.index.isExternallyChanged(path),
    );
    this.learner = new MoveLearner({
      read: () => this.settingsStore.get().moveStats,
      save: (next) => void this.settingsStore.save({ moveStats: next }),
    });
    this.mover = new Mover(
      this.app,
      this.settingsStore,
      this.fm,
      this.snapshot,
      this.report,
      (info) => {
        if (!(LEARN_SOURCES as readonly string[]).includes(info.source)) return;
        this.learner.learn(
          info.moved.map((m) => ({ from: m.from, to: m.to, tags: info.tagsOf(m.from) })),
          this.settingsStore.kbRoot(),
        );
      },
    );
    this.configs = new ConfigFiles(this.app, this.settingsStore);
    this.automation = new AutomationStore(this.configs);
    this.completion = new CompletionService(this.app, this.settingsStore, this.gate, this.automation);
    this.review = new ReviewStore(this.app, this.configs);
    /**
     * AI 助手（P6 段④）。**传输层在构造时注入、之后也能整体换掉**（`ai.transport` 是公开字段）——
     * 离线用例与真机探针往里塞假响应，真机上就是默认的 `httpTransport()`。
     */
    this.ai = new AiService(this.app, this.settingsStore, this.index, pluginDir);
    this.reconcile = new ReconcileRunner({
      kbRoot: () => this.settingsStore.kbRoot(),
      entries: () => this.index.getAll(),
      dirs: () => this.kbDirs(),
      // ⚠️ v2（P7.12 · #12）：「自动归位开关」（reconcile.enabled）退役 ——
      // 显式改 = 直接搬，不看开关；这里只剩模块开关这一层总闸。
      enabled: async () => this.gate.isOn('automation'),
      exclude: async () => (await this.automation.get()).reconcile.exclude,
      seen: () => this.settingsStore.get().reconcileSeen,
      // ⚠️ **防抖落盘**：批量搬一次（P5 会一次搬几十篇）会连着触发好几轮，
      // 每轮都写一次 data.json 既吵又慢（P1 的界面偏好就是这么处理的）
      saveSeen: (next) => this.saveSeen(next),
      move: (moves) => this.runReconcile(moves),
      onSkip: (skips) => {
        notifyPartial(
          `自动归位跳过了 ${skips.length} 篇`,
          skips
            .slice(0, 2)
            .map((s) => `${s.path.split('/').pop()}：${s.why}`)
            .join('；'),
        );
      },
      watch: (cb) => this.index.onChange(() => cb()),
    });

    this.ctx = {
      app: this.app,
      pluginDir,
      settings: this.settingsStore,
      gate: this.gate,
      store: this.store,
      index: this.index,
      configs: this.configs,
      fm: this.fm,
      snapshot: this.snapshot,
      report: this.report,
      mover: this.mover,
      keymap: this.keymap,
      keys: this.keys,
      automation: this.automation,
      completion: this.completion,
      reconcile: this.reconcile,
      review: this.review,
      ai: this.ai,
      activate: () => this.activate(),
      openKeysHelp: () => this.openKeysHelp(),
      openNativeSettings: () => this.openNativeSettings(),
      openWorkbenchSettings: (section?: SettingsSectionId) => {
        openSettingsPanel(this.ctx, section);
      },
      openSnapshotPanel: () => {
        openSnapshotPanel(this.ctx);
      },
      goNotes: (intent?: NotesIntent) => this.goNotes(intent),
      goBoard: (intent?: BoardIntent) => this.goBoard(intent),
      goHome: () => this.goHome(),
      reloadIndex: () => this.reloadIndex(),
      quickSwitch: () => openQuickSwitch(this.ctx),
      quickCapture: () => openQuickCapture(this.ctx),
      openNoteWindow: (path: string) => this.openNoteWindow(path),
      openAi: (seed?: string, refs?: AiRef[]) => openAiPanel(this.ctx, seed, refs),
      openWizard: () => openWizard(this.ctx),
      notYet: (round, what) => this.notYet(round, what),
    };

    // ── ② 注册（必须在任何 await 之前）─────────────────────────
    /**
     * 第三个参数 = ③ 那条"打开工作台就收左侧栏"的**第二个入口**：视图 `onOpen` 时喊一声。
     * 为什么除了 `activate()` 还要这一个 —— **会话恢复**那条路上 `activate()` 根本不会被调用
     *（Obsidian 直接把上一次的布局连同工作台一起挂起来），而那时工作台可能正好在最前面、
     *  侧栏也开着 → 用户看到的还是"目录栏不见了"。两个入口都不会重复收：
     * `collapseSidebarOnOpen()` 里判了"已经收着就什么都不做"。
     */
    this.registerView(VIEW_TYPE, (leaf) => new WorkbenchView(leaf, this.ctx, () => this.collapseSidebarOnOpen()));

    /**
     * 侧栏那个插件图标用**自己的标记**（用户 2026-09-25 要的"经纬的插件图标换成自己的图标"）。
     * `addRibbonIcon` 只吃 lucide 名字，所以照常注册（拿到元素 + 点击行为 + 提示文案），
     * 再把里面那个占位 SVG 换成 `brandMark()`（一纵两横 + 两个交点圆点）——
     * **与工作台左上角那个 Logo 共用同一个函数**，图标只有一个真源，别在这儿手画一份。
     * ⚠️ 用原生 `replaceChildren`（不用平台的 `empty()` DOM 扩展）：离线桩也走同一条代码路径。
     */
    const ribbon = this.addRibbonIcon('layout-dashboard', '经纬 · 打开工作台', () => void this.activate());
    ribbon.replaceChildren(brandMark(18));

    registerCommands(this, this.gate, {
      activate: () => this.activate(),
      newNote: () => openNewNoteDialog(this.ctx),
      rebuild: () => openRebuildPanel(this.ctx),
      snapshotPanel: () => openSnapshotPanel(this.ctx),
      quickCapture: () => openQuickCapture(this.ctx),
    });

    this.addSettingTab(
      new NativeSettingsTab({
        app: this.app,
        plugin: this,
        settings: this.settingsStore,
        gate: this.gate,
        openWorkbench: () => this.activate(),
        openWorkbenchSettings: () => this.ctx.openWorkbenchSettings(),
        onChanged: () => this.repaintAll(),
      }),
    );

    // Esc 逐级退出：菜单 / 模态挂在 body 上，焦点不在工作台里也要能收
    this.register(installGlobalEscape(() => this.keymap.keysFor('escape')));

    // 13 个动作**在插件层绑一次**（handler 只用 ctx，与视图实例无关）：
    // 绑在视图上的话，分屏开第二个工作台标签再来回关，就会把唯一的处理函数删掉
    //（`Keymap.bind` 每个动作只留最后一个），剩下的视图全部快捷键失灵
    for (const action of KEY_ACTIONS) {
      /**
       * 这两个是**工作台级的动作**（不归任何模块管）：直接绑到打开对应的浮层，
       * 不走 `ModuleKeys` 那套"按当前模块 + 焦点选人"的路由 ——
       * 走那条路的话，在首页/图谱里按下去会没人接（那两屏没有模块 handler）。
       */
      if (action.id === 'shortcuts-help' || action.id === 'quick-switch') continue;
      this.register(
        this.keymap.bind(action.id, (evt) =>
          this.keys.dispatch(this.store.get().activeModule, action.id as KeyActionId, evt),
        ),
      );
    }
    this.register(this.keymap.bind('shortcuts-help', () => this.openKeysHelp()));
    this.register(this.keymap.bind('quick-switch', () => this.ctx.quickSwitch()));

    // 「轻量改动」的通知也能落一条日志（动库操作自己写详细报告，不走这条）
    setLogSink((spec) => {
      void this.report.log({
        action: '操作',
        result: spec.kind === 'error' ? 'error' : 'ok',
        source: 'manual',
        summary: spec.text,
        extra: spec.detail,
      });
    });

    // ── ③ 读设置、起索引、挂监听 ───────────────────────────────
    await this.settingsStore.load();
    /**
     * ③ 的**补做一次**（独立审查 A6）：视图 `onOpen` 若在"设置还没读出来"那一瞬间跑过，
     * 那次 `collapseSidebarOnOpen()` 会**按 isLoaded 短路**（见那里的注释）——
     * 这里读完设置补一次，冷启动那条路才不会漏收。
     * ⚠️ 条件与视图 `onOpen` 那条**同一个口径**：只在工作台**此刻就是最前面那个视图**时收
     *（后台标签里的工作台不该因为一次插件重载就去动用户的布局）。
     * 幂等：真收过的（`collapsed === true`）不会被收第二遍。
     */
    if (this.app.workspace.getActiveViewOfType(WorkbenchView)) this.collapseSidebarOnOpen();
    this.applySettingsToStore();
    this.rootKey = `${this.settingsStore.get().kbRoot}|${this.settingsStore.get().metaDir}`;

    this.snapshot.onCapture = (manifest) => {
      this.store.set({ lastSnapshotAt: manifest.at });
      void this.settingsStore.save({ lastSnapshotAt: manifest.at });
    };

    this.index.onChange(() => this.syncFromIndex());
    this.settingsStore.onChange((s, changed) => {
      /**
       * **纯界面偏好：只落盘、不碰 store / 索引 / repaint**（P7.11 · #9，Q6 拍板：
       * 先只放行 `showSettingHints` 一个键 —— 最小修复；扩展等真实用量再说，**别顺手加**）。
       * 设置面板自己的 `applyHintMode()` 已就地换类名，视觉不受影响；原先无条件走
       * `applySettingsToStore + 索引 + repaintAll` 会让整个工作台（首页十个块）在面板
       * 底下整片重建 —— "点一下显示说明像卡住半秒"的根因。
       * ⚠️ 别的订阅者照旧收到通知（这一条只省 main 这条重链）。
       */
      if (changed.every((k) => k === 'showSettingHints')) return;
      this.applySettingsToStore();
      // ⚠️ 只有**库根/元数据目录真的变了**才重建索引：界面偏好（排序/列宽/树展开…）
      // 也走这个 onChange，无条件 rebuild 会让 revision+1 → 整张表重画 → 滚动位置归零、
      // 就地改名的输入框被重建（独立审查指出）
      const key = `${s.kbRoot}|${s.metaDir}`;
      if (key !== this.rootKey) {
        this.rootKey = key;
        this.index.rebuild();
      }
      this.syncFromIndex();
      this.repaintAll();
    });

    this.configs.attach();
    /**
     * **预热看板配置的同步缓存**（P7.2c）：笔记右键「丢进板块」要在 `contextmenu`
     * 那一帧就画出子菜单，只能读 `configs.cached('board')`（`read()` 是异步的，来不及）。
     * 这里先热一份；之后任何人读写配置、或库内文件变化（`attach()` 那条链）都会自动保鲜。
     * 没热到时那一项**先不画**（下一次右键就有）—— 别拿 `defaults()` 硬造。
     */
    void this.configs.read('board').catch(() => undefined);
    /**
     * 回顾卡的表也预热（P8 期 2）：右键菜单那行「已有 N 张」走**同步缓存** ——
     * 不预热的话，新会话里第一次右键一篇已经有卡的笔记，提示不显示
     *（要等用户进过「回顾」栏、或文件被改动过才出现）。与 board 那条逐字同一个理由。
     */
    void this.configs.read('review').catch(() => undefined);
    // 库内配置被手改/同步过来 → 缓存作废（下次读就是新值）
    this.configs.onChange(() => {
      this.automation.invalidate();
    });
    this.index.start();

    /**
     * **视图记忆里"以路径结尾"的键要跟着 rename 走**（P5 补，e2 留下的那笔）。
     *
     * 🔴 为什么必须挂在**插件层**，而不是看板模块里（看板自己那套 rename 处理还在，
     * 它管的是"当场把 DOM 上的卡面位置钉下来"）：
     * 看板模块没挂载的时候，它的 rename 监听**根本不在** ——
     * 而 P5 的重排正是从「全部笔记」那边发起的**一次搬几十篇**，
     * 那时看板手里的 `pendingScroll` 里全是 `card:<板块>:<旧路径>` 这种键，
     * 没人迁 → 切回看板时认不出键 → **整片滚动位置重置**（用户会当成重排的 bug）。
     * 这条监听与哪个模块在屏幕上无关，所以放在这里；`remapScrollPath` 是幂等的
     *（第二次找 `:<旧路径>` 后缀已经找不到了），与看板自己那一处不会互相干扰。
     */
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        remapScrollPath(oldPath, f?.path ?? '');
        /**
         * **网格「自由摆放」的顺序表同一条账**（P6）。
         *
         * 它也是"表里存的是路径"，而且**比滚动快照更怕漏迁**：
         * 漏一次的后果是那一篇从手动顺序里**失联、掉到末尾**，还查不出原因
         *（本项目在"表里存路径"上栽过好几次，看板的两处是现成的样板）。
         * 挂插件层的理由与上面那句**一模一样**：改名有四个入口
         *（悬浮小窗 / 笔记菜单 / 表格 / 跨板块拖动），而「全部笔记」的网格
         * 在改名发生时**多半没挂载** —— 挂在模块里必漏。
         * ⚠️ 走 `remapOrder` 而**不是**就地改数组：settings 的写入要过
         * `SettingsStore.save()`（合并 + 回读校验），直接改 `get()` 拿到的对象是改不动的。
         * 表里没有这个旧路径时 `remapOrder` 原样返回，所以不会平白多写一次盘。
         */
        const st = this.settingsStore.get();
        const next = remapOrder(st.gridOrder, oldPath, f?.path ?? '');
        if (next.length !== st.gridOrder.length || next.some((p, i) => p !== st.gridOrder[i])) {
          void this.settingsStore.save({ gridOrder: next });
        }
        /**
         * **「钉到首页」的表同一条账**（P7.2d · 16.9-b）：也是"表里存路径"，
         * 漏迁 → 那一篇从首页块里失联（用户会念"我明明钉过"）。
         * 同一处、同一把 `remapOrder`；没命中时原样返回，不多写盘。
         */
        const pins = st.homeCards;
        if (pins && pins.length > 0) {
          const nextPins = remapOrder(pins, oldPath, f?.path ?? '');
          if (nextPins.some((p, i) => p !== pins[i])) {
            void this.settingsStore.save({ homeCards: nextPins });
          }
        }
        /**
         * **回顾卡的 `note` 同样要迁**（P8）。卡片里存的是**来源笔记的路径**，
         * 漏迁一次 = 那一篇的问答卡指空（面板里点不开、也复习不了），而且**只有真机上才现形**。
         * 与上面两条**同一处、同一时刻**；挂插件层而不是「回顾」模块里 ——
         * 理由与前两条逐字相同：改名有四个入口，而改名发生时「回顾」栏多半没挂载。
         * `remapNote` 认精确命中 + 整目录前缀（改文件夹名是一个事件）；**没命中不写盘**。
         * ⚠️ `.catch` 是必须的（独立审 🟢1）：`复习.json` 坏了时 `ReviewRefusedError` 是
         * **设计内拒写** —— 事件钩子里没人接这个 reject 就是**未处理拒绝**（严格 Node 会崩进程）。
         * 事件流里不提示（界面三条路各自已把"没写进去"报在用户看得到的地方），吞掉即对。
         */
        void this.review.remapNote(oldPath, f?.path ?? '').catch(() => undefined);
      }),
    );
    /**
     * **删掉的笔记要把它的路径从顺序表里剪掉**。
     *
     * 不剪也不会显示错（`applyManualOrder` 查不到就跳过），但死键会一直攒着，
     * 而"下一次真正的插入"是**以死键为邻**定位的 —— 攒多了就会看着像"插歪了"。
     * ⚠️ 挂在 `delete`（文件真没了）而**不是**渲染路径上顺手剪：索引重扫期间
     * 会有"一时什么都看不见"的窗口，在那上面剪等于把用户的顺序整批清空。
     */
    this.registerEvent(
      this.app.vault.on('delete', (f) => {
        const st = this.settingsStore.get();
        if (!f?.path) return;
        if (st.gridOrder.length > 0) {
          const alive = new Set(this.index.notes().map((n) => n.path));
          // 刚被删的那一篇此刻可能还留在索引里（事件先于索引刷新）→ 显式排除
          alive.delete(f.path);
          const next = pruneOrder(st.gridOrder, alive);
          if (next.length !== st.gridOrder.length) void this.settingsStore.save({ gridOrder: next });
        }
        /**
         * **「钉到首页」的表也要剪**（P7.2d）：不剪的话首页块会一直想开一篇
         * 不存在的笔记（现在只是跳过不画，但死键会攒着 —— 与 `gridOrder` 同一条账）。
         */
        const pins = st.homeCards ?? [];
        if (pins.length > 0) {
          const nextPins = pins.filter((p) => p !== f.path);
          if (nextPins.length !== pins.length) void this.settingsStore.save({ homeCards: nextPins });
        }
        /**
         * **回顾卡也要剪**（P8）：笔记真没了，指着它的卡就是死键 ——
         * 面板会画出一张点不开的卡。与上面两条同一处账（`delete` 而不是渲染路径上顺手剪）。
         * ⚠️ `.catch` 同 `rename` 那条（坏文件 = 设计内拒写，别让事件钩子产生未处理拒绝）。
         */
        void this.review.pruneNote(f.path).catch(() => undefined);
      }),
    );

    // ── P3：自动化两个运行时 ───────────────────────────────────
    // 补全：监听新出现的空笔记（Templater 若接管，只补属性）
    this.completion.start();
    // 自动归位：跟着索引走（默认关；开了也只认"显式改「文件位置」"）
    this.reconcile.start();

    /**
     * **平台笔记右键菜单里的那两个子菜单**（P6 段⑥ ⑥ 起；**P7.12 · R8 两栏化**）。
     * 边界在 `ui/editor-menu.ts` 头注。
     *
     * ⚠️ 动作的**判据与实现都在这儿**（那一层只负责画菜单）：动文件过 `mover`、
     * 动库前确认过 `confirm`、AI 改正文走「预览对比 → 确认 → 快照」——
     * 与手工那条**完全同一套**出口。
     */
    registerEditorMenu(this, {
      app: this.app,
      kbRoot: () => this.settingsStore.kbRoot(),
      openInWorkbench: (file) => {
        /**
         * 「返回经纬工作台」= 打开工作台**并定位到这一篇**（不是只把工作台翻到前面）——
         * 走 e2 那条既有的跳转意图：一次性清单（`paths`）+ 预选中（`selectPaths`）。
         * ⚠️ 传的是**库内绝对路径**（与 `vault.on('rename')` 那两处同一个口径）。
         */
        this.goNotes({ paths: [file.path], selectPaths: [file.path] });
      },
      /**
       * 「复制文件路径」：**库内绝对路径**（与 notes 的 `ops.copyPaths` 同一口径，
       * 如 `01_新知识库/00_Inbox/9.16.md`），复制后轻提示。
       */
      copyPath: (file) => {
        void navigator.clipboard
          .writeText(file.path)
          .then(() => notifyLight('已复制文件路径', file.path))
          .catch(() => notifyInfo('复制失败', '这个环境不允许写剪贴板'));
      },
      rename: (file) => void this.renameFromMenu(file),
      /**
       * 「自动整理」= **单篇版 AI 预整理**（R8 拍定 14）—— `runInboxTidy` 的收窄档
       *（`only`）：补声明 / 归位 → 一次确认 → mover → 补尾链，全在那条既有链上。
       * `scope` 用"它现在在哪"（与 `planRebuild` 的 `scopeDir` 判据同一口径）。
       */
      tidyOne: (file) => {
        const entry = this.index.get(file.path);
        void runInboxTidy(this.ctx, {
          scope: entry?.effectivePosition ?? '',
          only: [file.path],
          label: `《${file.basename}》`,
        });
      },
      /** 「自动命名」= AI 起标题面板的单篇档（**整篇为材料**） */
      aiTitle: (file) => openTitlePanel(this.ctx, { only: [file.path] }),
      /** 「美化笔记」= 出稿 → 预览对比 → 确认 → 整体替换（`ui/beautify.ts`） */
      beautify: (file) => void runBeautify(this.ctx, file),
      /**
       * **「问 AI」（写作辅助）**：打开面板 + 带引用 + 预填一句。
       *
       * 🔴 **一个字节都不动库**（5.3 的红线）：它连确认流都不碰 —— 面板里真要动库，
       * 照旧过待确认卡 → `ui/confirm.ts` → `mover`。这里只做"把材料与话说一半"。
       *
       * 引用的形状：`kind:'selection'`（正文由**这里**带过去 —— 选区在编辑器里，
       * 服务层够不着，与 `ui/ai-panel.ts` 的 `@` 引用同一条口径）。
       */
      askAi: ({ file, selection, seed }) => {
        const ref: AiRef = {
          kind: 'selection',
          // ⚠️ 库内绝对路径（脚本口径；显示一律用 title）
          path: file.path,
          title: file.basename,
          text: selection.slice(0, AI_LIMITS.refChars),
        };
        this.ctx.openAi(seed, [ref]);
      },
    });
    /**
     * **原生属性面板「文件位置」那一格**（P7.16b · 用户点名的落点）：点它弹**我们**的
     * 目录菜单（现算候选 + 同一条搬动链），替掉平台那条"只列已出现过取值"的建议。
     * 边界（平台内部 DOM 依赖 · 静默退化 · 手打不受影响）写在 `ui/native-position.ts` 头注
     * 与 `交互规格.md` §8.6；动作出口全在共享链（`notes/ops.ts` 的模块级函数）里。
     */
    registerNativePositionMenu(this, this.ctx);
    this.app.workspace.onLayoutReady(() => {
      this.syncFromIndex();
      this.repaintAll();
      // 首帧之后登记一次"上次看见的声明"（**只登记不搬**，见 ReconcileRunner 头注释）
      void this.reconcile.tick();
      /**
       * **冷启动那条路上向导该弹就弹**（交互规格 §14.2）。
       *
       * 这里与 `activate()` 那条是**两个入口**：用户点插件图标走 `activate()`；
       * 而 Obsidian **会话恢复**时工作台可能已经开着、`activate()` 根本不会被调用
       * （与"打开就收侧栏"是同一件事的两个入口，坑也一样）。
       * 两条都靠 `wizardShownThisSession` 去重，不会弹两次。
       */
      if (this.app.workspace.getActiveViewOfType(WorkbenchView)) this.maybeShowWizard();
      // C7：key 存在库内 data.json，库要是在同步就把它一起带上云 —— 探到就提一句
      void this.checkKeySafety();
    });

    console.info('[经纬] 已加载（P3）');
  }

  /**
   * **C7 核查的代码那一半**（另一半是给用户的自查步骤，见 `坑/平台.md` 的
   * 「AI key 与这个库在同步」那条）。
   *
   * 只做一件事：探到"库根有同步痕迹"且"配了 AI key"就提示一次。
   * 🔴 **不动 key 的存放位置** —— 那是既有产品决策（P7.3c 拍的"key 存插件 data.json"），
   * 要挪得先拍板 + 迁存量，不属于这一笔（2026-10-12 拍板：本轮只收守卫）。
   * 探测是**按已知痕迹**做的（`SYNC_MARKERS`）：探不到 ≠ 一定安全，所以措辞是
   * "这个库看起来在同步"，不是"你的 key 安全"。
   */
  private async checkKeySafety(): Promise<void> {
    const markers = await findSyncMarkers(this.app);
    if (!shouldWarnKeySync({ apiKey: this.settingsStore.get().ai.apiKey, markers })) return;
    const n = keySyncNotice(markers);
    notifyPartial(n.text, n.detail);
  }

  /**
   * 自动归位的执行口：**动文件只能过 mover**（三条硬规矩之一）——
   * 一次检查 = 一个快照 = 一个撤销句柄（多篇一起搬也只有一个）。
   *
   * ⚠️ **目录有两种口径，混了就搬错地方**（坑/动库.md 记过的那条）：
   * 计划里的 `declared` 是**相对库根**的（`02_Areas/内容创作`，属性值就是这个口径），
   * 而 **`mover` 要的是库内绝对路径**（`01_新知识库/02_Areas/内容创作`）。
   * 忘了转换的后果不是报错，是**文件被搬到 vault 根目录下**（真机实测：一篇笔记
   * 落到了 `02_Areas/内容创作/__探针.md` —— 库根之外，索引都看不见它）。
   */
  private async runReconcile(moves: ReconcileMove[]): Promise<void> {
    const kbRoot = this.settingsStore.kbRoot();
    const byDir = new Map<string, Set<string>>();
    for (const m of moves) byDir.set(m.declared, (byDir.get(m.declared) ?? new Set()).add(m.path));
    const targets = [];
    for (const [dirRel, paths] of byDir) {
      const files = [];
      for (const p of paths) {
        const e = this.index.get(p);
        if (e) files.push(e.file);
      }
      if (files.length > 0) targets.push({ dir: joinPath(kbRoot, dirRel), files });
    }
    if (targets.length === 0) return;
    const n = targets.reduce((sum, t) => sum + t.files.length, 0);
    const res = await this.mover.move({
      targets,
      source: 'reconcile',
      reason: `自动归位：${n} 篇改了「文件位置」`,
    });
    /**
     * 🔴 v2（P7.12 · #12）：**显式改 = 直接搬**（没有确认流）→ 撤销条是这条路
     * 唯一的"后悔药"，必须自己弹（`mover` 不弹条，弹条的是调用方 —— 见 `ui/undo-move.ts`）。
     * 与编辑器菜单那两条（R8 的「重命名」；「自动整理」自己那条链）共用同一份实现。
     */
    showMoveUndo(
      {
        restore: (id) => this.snapshot.restore(id),
        openLatest: () => this.report.openLatest(),
        openSnapshotPanel: () => this.ctx.openSnapshotPanel(),
      },
      res,
    );
  }

  /**
   * **「重命名」的动作**（R8 · 编辑器右键「经纬 › 重命名」）：问一句新名字 → `mover`。
   *
   * 🔴 与手工那条**完全同一套出口**（§8.5 的硬规矩）：`mover` 自己带快照 / 日志；
   * 撤销条**调用方自己弹**（`mover` 不弹，见 `ui/undo-move.ts`）。
   * 名字清洗用 `sanitize`（与 F2 就地改名同一个口径）——这里只做**输入校验**，
   * 真正的落地清洗仍在 `mover` 那一层（预览与执行同源，`9.16.md` 的教训钉着）。
   *
   * ⚠️ 与标题面板那条（AI 起名 → `source:'ai'`）**刻意不同**：这是用户自己敲的名字，
   * `source:'menu'` —— 与「自动命名」（AI 参与）在日志里分得开。
   */
  private async renameFromMenu(file: TFile): Promise<void> {
    const name = await promptText({
      title: '重命名',
      label: `在 ${parentDir(relativeTo(file.path, this.settingsStore.kbRoot())) || '库根'} 下`,
      value: file.basename,
      placeholder: '文件名（不带 .md）',
      primary: '改名',
      validate: (v) => {
        const t = v.trim();
        if (t === '') return '名字不能为空';
        if (t !== file.basename && t !== sanitize(t)) return '名字里不能有 \\ / : * ? " < > |';
        return null;
      },
    });
    const clean = (name ?? '').trim();
    if (clean === '' || clean === file.basename) return;
    const moved = await this.mover.move({
      targets: [{ newName: clean, files: [file] }],
      source: 'menu',
      reason: `重命名（编辑器菜单）：${file.basename} → ${clean}`,
      quiet: true, // 撤销条在（下面 showMoveUndo）→ 不弹重复通知（P7.0a 批 1⑦）
    });
    /**
     * 🔴 **撤销条要自己弹**（判据抓到的缺口）：`mover` **不弹**它 —— 弹条的是**调用方**
     *（`notes/ops.ts` / `board/drag.ts` / `home/tidy.ts` / 三个面板各弹各的）。
     * §8.5 对菜单这条路的要求就是**与手工那条完全同一套**（快照 + 日志 + 撤销条）——
     * 走 `ui/undo-move.ts` 那一份共用实现，别再抄一遍。
     */
    showMoveUndo(
      {
        restore: (id) => this.snapshot.restore(id),
        openLatest: () => this.report.openLatest(),
        openSnapshotPanel: () => this.ctx.openSnapshotPanel(),
      },
      moved,
    );
  }

  /**
   * 库根之下的目录（相对库根）—— 自动归位的"目标目录必须已存在"判据用它。
   *
   * ⚠️ 实现搬去了 `core/vault-index.ts` 的 `kbDirsOf()`（P6 段④）：AI 助手那半边
   * 要的是**同一份口径**（"落点只能从这些里选"），在这儿留一份、那儿再写一份，
   * 两边迟早会漂 —— 而"库里有哪些目录"漂了的症状是**搬家落到不存在的目录**或
   * **明明存在的目录被判成不存在**，两种都很难从现象倒推回来。
   */
  private kbDirs(): Set<string> {
    return kbDirsOf(this.app, this.settingsStore.kbRoot());
  }

  /** 服务与状态的访问口（开发面板 / 离线测试用；P0 需要从外部拿到这批服务） */
  context(): WorkbenchContext {
    return this.ctx;
  }

  onunload(): void {
    setLogSink(null);
    this.completion.stop();
    this.reconcile.stop();
    disposeNotices();
    disposeUndoBar();
    // 菜单/模态/浮层也挂在 body 上：重载时若正开着，会留下孤儿（`.kbw-backdrop` 是全屏遮罩，
    // 挡住整块工作台且 Esc 层已随卸载消失 —— 只能靠点它自己关）
    closeAllMenus();
    purgeOverlays();
    /**
     * **视图记忆也要清**（e 期 §4.4）：那张表是**模块作用域**的，而插件重载时
     * 模块不会重新求值（bundle 被平台缓存）→ 上一次会话的滚动位置/光标会漏到下一次，
     * 症状是"刚重载完，工作台自己滚到了半中间"。与上面那几笔"挂在 body 上的孤儿 DOM"
     * 是同一类账。
     */
    clearViewMemory();
    // 外观镜像属性也别在 body 上留（P7.7 · 10.1：`data-motion` 由视图镜像到 body，
    // 覆盖挂在 body 上的浮层；这是插件自己的标记，卸载时原样摘掉）
    document.body.removeAttribute('data-motion');
    this.snapshot.onCapture = null;
    this.index.stop();
    this.configs.dispose();
    // 视图由 registerView 自动清理；这里把叶子收掉，避免留下"插件不再活动"的空壳
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.detach();
    }
  }

  // ── 打开 / 聚焦（已开着就不新开第二个）──────────────────────
  async activate(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      /**
       * ⚠️ **只有"从别处切过来"才收侧栏**：工作台**已经是最前面那个视图**时，
       * 说明用户正在它里面活动 —— 而 `goNotes` / `goBoard`（首页待处理、快速切换跳转…）
       * 也是走这条 `activate()`，每次跳一下就把用户自己打开的侧栏拍下去会很讨厌。
       * 「新开一个工作台」那条路在下面（它一定不在最前）；「会话恢复时工作台就在最前」
       * 那条由视图自己的 `onOpen` 兜（见 `registerView` 那行）。
       */
      if (!workspace.getActiveViewOfType(WorkbenchView)) this.collapseSidebarOnOpen();
      await workspace.revealLeaf(existing[0]);
      /**
       * ⚠️ **向导排在这里、`revealLeaf` 之后**：它要盖在工作台上，
       * 而在"工作台还没露出来"的时候弹，用户会先看到向导、后看到底下那屏（顺序反了）。
       * `return` 之前那一条不能漏 —— 已开着的那条路也要能弹。
       */
      this.maybeShowWizard();
      return;
    }
    this.collapseSidebarOnOpen();
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    this.maybeShowWizard();
  }

  /**
   * **首次使用向导的自动弹出**（交互规格 §14.2）。
   *
   * 三条口径（拍板时定的，别自己改）：
   *  · 只在**打开工作台那一刻**弹，不挂在插件加载期（理由见 §14.2 —— 加载期弹是打扰，
   *    而且会让每一条走 `bootPlugin()` 的离线用例先撞上一个向导）；
   *  · 判据只有一处：`shouldShowWizard()`（纯函数，`wizardDone` 三态 + 默认值双判）；
   *  · **一次会话最多弹一次**（`wizardShownThisSession`）—— 用户关掉工作台再打开不该又来一次。
   *
   * 重开入口在**设置面板**（「重新运行首次向导」），不是命令面板 —— §1.2 那 5 条命令是固定的（B5 拍过）。
   */
  private maybeShowWizard(): void {
    if (this.wizardShownThisSession) return;
    // 读盘读完之前不判（与 `collapseSidebarOnOpen` 同一条：那时读到的是默认值）
    if (!this.settingsStore.isLoaded()) return;
    if (!shouldShowWizard(this.settingsStore.get())) return;
    this.wizardShownThisSession = true;
    openWizard(this.ctx);
  }

  /**
   * ③ **打开工作台时收起 Obsidian 左侧栏**（用户 2026-09-28 拍板：打开就收、**不按宽度判断**）。
   *
   * 为什么（真机量到的因果链）：
   * ```
   * 窗口 830 + 左栏 200 → 工作台容器只剩 586 → <640 = 窄档
   * → `.kbw-root[data-w='narrow'] .kbw-notes-side { display:none }` 把工作台的目录栏整个藏掉
   * ```
   * 而工作台要横向空间：导航 152 + 目录栏 208 + 主区 ≥640 ⇒ **1000+** 才舒展。
   *
   * 三条口径（都是拍板时定的，别自己改）：
   *  · **只收，不还**：关掉工作台时**不**把它打开 —— 用户自己点一下就回来了（"我替你记住"更烦人）；
   *  · **触屏不特例**：平板/手机上侧栏本就是抽屉，收了等于没动；
   *  · **关得掉**：设置 → 外观 → 「打开工作台时自动收起侧栏」（默认开）关掉就是一个字都不碰。
   *
   * ⚠️ 这是**布局动作**，不是数据动作：整个包在 try/catch 里 —— 侧栏收不起来绝不该
   * 把"打开工作台"带崩（`leftSplit` 在极老的版本上可能不存在）。
   */
  private collapseSidebarOnOpen(): void {
    try {
      /**
       * ⚠️ **读盘读完之前不许按设置动布局**（P6⑤ 独立审查 A6）：`registerView` 在
       * `await settingsStore.load()` 之前，冷启动恢复布局时视图 `onOpen` 可能落在这个窗口里 ——
       * 那时读到的是**默认值 true**，于是"用户把开关关掉了、重开 Obsidian 还是被收一次"。
       * 读完之后由 `onload()` 里那句补做一次（见那里的注释）。
       */
      if (!this.settingsStore.isLoaded()) return;
      if (!this.settingsStore.get().collapseSidebarOnOpen) return;
      const split = this.app.workspace.leftSplit;
      // 已经是收着的 → 什么都不做（**"这次真收了的"才有意义**，别谎报功劳）
      if (!split || split.collapsed) return;
      /**
       * 🔴 **必须调 `collapse()`，写 `split.collapsed = true` 是静默无效的**。
       *
       * 2026-09-28 真机量到的（探针 ③ 那条第一次跑就红在这儿）：
       * ```
       *   split.collapsed = true  → 元素仍然 200px、class 也没变（那个字段不负责重排 DOM）
       *   split.collapse()        → 200px → 0px，元素上出现 is-sidedock-collapsed
       * ```
       * 类型定义里 `collapsed` 与 `collapse()` **两个都在**（`WorkspaceSidedock`），
       * 所以**编译器拦不住这个错** —— 只有真机几何判据能拦（探针 ③ 就是为它写的；
       * 离线上桩另记一个 `collapseCalls` 计数，见 `tests/stub`）。
       */
      split.collapse();
    } catch (e) {
      console.error('[经纬] 收起侧栏失败（不影响打开工作台）', e);
    }
  }

  private notYet(round: string, what: string): void {
    notifyInfo(`${what} · 在 ${round} 提供`, '这一期还没做到这儿');
  }

  /**
   * 跳到「全部笔记」并带上一次意图（首页待处理 / 整理收件箱 / 搜索框都走它）。
   * 序号每次 +1：**同样内容的意图再来一次也要生效**（区域 key 靠它判新旧）。
   *
   * 🔴 **`intent.dir` 先验一遍**（14.8a，P7.0b）：目录是**相对库根**的口径
   *（`''` = 整个知识库，见 `kbDirsOf()`），而传进来的东西未必是目录 ——
   * 探针里就发生过把树节点的**标签**（「整个知识库」）当目录传进去：
   * 守卫之前是**静默给"本层 0 篇"**（整屏空、看着像功能坏了，查了一轮才排除）。
   * 现在：不认识的目录 **`console.warn` 说出来** + **只丢这一个字段**
   *（意图的其余条件照旧生效 —— 那是 P7.0a "不带 flags/paths 的意图不清 filters"
   * 的同一枚硬币：守卫不许把整条意图一起吞掉）。
   * ⚠️ 探针那边同时收 `[经纬]` 的 warn（`scripts/probe.mjs`）——
   * 别把这条降级成没人看的日志。
   */
  private goNotes(intent?: NotesIntent): void {
    let clean = intent ?? null;
    if (clean?.dir != null) {
      // 容忍手滑多写的斜杠（`/00_Inbox/`），但**别做更聪明的转换**：
      // "带库根前缀"那种错要**报出来**，不是悄悄替它剥一层（两种目录口径混用是 P3/P5 的旧账）
      const dir = clean.dir.replace(/^\/+|\/+$/g, '');
      if (!this.kbDirs().has(dir)) {
        console.warn(
          `[经纬] goNotes 收到不存在的目录「${clean.dir}」——已忽略它（目录是相对库根的口径，不带库根前缀）；跳转只保留其余条件`,
        );
        clean = { ...clean, dir: undefined };
      } else if (dir !== clean.dir) {
        clean = { ...clean, dir };
      }
    }
    this.store.set({
      activeModule: 'notes',
      notesIntent: clean,
      notesIntentSeq: this.store.get().notesIntentSeq + 1,
    });
    void this.settingsStore.save({ activeModule: 'notes' });
    void this.activate();
  }

  /**
   * 跳到「看板」并带上一次意图（快速切换跳板块 / 跳卡片，e2 期 §4.1）。
   * 与 `goNotes` 同一套：序号每次 +1，**同样内容的意图再来一次也要生效**。
   */
  private goBoard(intent?: BoardIntent): void {
    this.store.set({
      activeModule: 'board',
      boardIntent: intent ?? null,
      boardIntentSeq: this.store.get().boardIntentSeq + 1,
    });
    void this.settingsStore.save({ activeModule: 'board' });
    void this.activate();
  }

  /**
   * 跳到「首页」（P7.10 · #4：向导结语的「首页」卡）。与 `goBoard` 同型
   * （切模块 + 落盘 + activate），没有意图这一说 —— 首页不吃 intent。
   */
  private goHome(): void {
    this.store.set({ activeModule: 'home' });
    void this.settingsStore.save({ activeModule: 'home' });
    void this.activate();
  }

  /**
   * **重扫全库索引**（P7.11 · #8）：顶栏那枚 ⟳ 与首页全局菜单共用这一处
   * （原先两行写在 `view/workbench-view.ts` 的按钮里 —— 两处入口要同一件事）。
   * 通知文案逐字照旧（顶栏时代就这一句）。
   */
  private reloadIndex(): void {
    this.index.rebuild();
    this.repaintAll();
    notifyInfo('已重扫全库索引');
  }

  private openKeysHelp(): void {
    // 16.13（P7.2d）：按过「?」看快捷键 = 新手清单第 4 项的一半（另一半是"用过搜索"）
    recordOnboarding(this.ctx, 'search');
    openKeysHelp({
      keymap: this.keymap,
      overrides: () => this.settingsStore.get().keymap,
      onSave: (ops) => {
        const merged = { ...this.settingsStore.get().keymap };
        for (const id of ops.reset ?? []) delete merged[id];
        for (const [id, keys] of Object.entries(ops.set ?? {})) merged[id] = keys as string[];
        void this.settingsStore.save({ keymap: merged });
      },
    });
  }

  /**
   * **「最近改动」→ 看板小窗的桥**（P7.2d · 16.9-c；`ctx.openNoteWindow` 的实现）。
   *
   * 为什么装配在**插件层**而不是"看板模块挂载时挂"：模块是"切到谁才挂谁"，
   * 而调用方（首页「最近改动」）住在首页 —— 那一刻看板模块已被卸载，
   * 挂在模块上的口子**在它唯一的使用场景里永远拿不到**（登记在 `期末交接-P7.2.md` 2d 段）。
   * 于是拆成两层："口子常驻"（这里）＋"开不开"（`gate` 现读）：
   *  · 看板模块关着 → `false`，调用方退"开标签页"（Q3 拍板的退化口径）；
   *  · 已知在某扇小窗里开着 → `openCardWindow` 内部抬到最前 + 闪一下，同样 `true`；
   *  · 路径不在索引里（刚删）→ `false`。
   * `quiet: true` = 与看板里单击卡片同一条主路径（闪一下就是反馈，不再弹回执）。
   */
  private openNoteWindow(path: string): boolean {
    if (!this.gate.isOn('board')) return false;
    const entry = this.index.get(path);
    if (!entry) return false;
    openCardWindow(entry, ensureWindowDeps(this.ctx), undefined, { quiet: true });
    return true;
  }

  private applySettingsToStore(): void {
    const s = this.settingsStore.get();
    this.store.set({
      activeModule: s.activeModule,
      modules: { ...s.modules },
      lastSnapshotAt: s.lastSnapshotAt,
    });
  }

  private syncFromIndex(): void {
    const kbRoot = this.settingsStore.kbRoot();
    // ⚠️ `kbRoot !== ''` 是**故意的**（P7.14）：'' = 整个库（根就是 vault 根，永远存在）——
    // 别把这句"顺手改成" isInside 之类，那样整个库模式会一直弹"库根不存在"的降级页
    const kbRootMissing = kbRoot !== '' && this.app.vault.getAbstractFileByPath(kbRoot) == null;
    this.store.set({
      indexReady: this.index.isReady(),
      indexRevision: this.index.revision,
      entryCount: this.index.size(),
      flagCounts: this.index.flagCounts(),
      kbRootMissing,
    });
    this.repaintAll();
  }

  private repaintAll(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WorkbenchView) view.repaint();
    }
  }

  private openNativeSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById?.(this.manifest.id);
  }
}
