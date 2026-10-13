/**
 * modules/graph —— 图谱（**P6 实做挂载**；降级判定 P0 就做对了）
 *
 * 交互规格 §5 / §1.5：内嵌官方图谱；**核心插件被关掉时必须在挂载前检测**。
 * S1 实测（2026-09-24）的三条：
 *   · `new WorkspaceLeaf(app)` + `setViewState({type:'graph'})` + 挂进自有容器 = 可行
 *     （canvas 立刻有尺寸、不占标签页、detach 后渲染循环真停）
 *   · **核心插件关掉时 `getViewType()` 仍返回 `'graph'`** → 靠挂载后的 view type 判断成败
 *     **判断不出来**，必须挂之前读 `internalPlugins.plugins.graph.enabled`
 *   · 挂上去的容器自带 `.view-header`（前进/后退/标题/关闭）→ 得 CSS 藏
 *
 * ── 过滤怎么注入（P6 真机 spike 定的，见 `spikes/README.md` 的 S5）────
 *
 * 🔴 **走程序化，不写 `.obsidian/graph.json`**（用户 2026-09-27 拍板）：
 * 那份文件是**全局**的，写它等于"用户以后手动打开官方图谱，看到的也是被我们过滤过的视图"。
 * 真机实测探到的落点（**逐个取证，不是猜的**）：
 *
 * ```
 * leaf.view.dataEngine.setQuery([{ query: '-path:…', color: null }])
 * ```
 *
 * · `dataEngine` 上还有 `searchQueries` / `fileFilter` / `hasFilter` / `requestUpdateSearch()`；
 *   `setQuery` 正是图谱**自己那套 UI**（`updateSearch()`）的调用点 —— 我们用的是同一个口。
 * · 参数是**数组**（`{query, color}` 一项一条），不是字符串：传字符串不报错，
 *   但会在一行行迭代字符时炸（`o[r].query` 是 undefined）。
 * · **实测它不落盘**：注入后 `.obsidian/graph.json` 一字节没变（立刻查 + 2.5 秒后再查），
 *   `detach()` 再挂载又是干净的 470 个节点（不残留、不叠加）。
 *   原因是 `setQuery` 自己不调 `onOptionsChange()`（那是 UI 路径 `updateSearch()` 才调的）。
 * · 过滤范围（用户拍板）：排 `02_旧知识库`（293 篇历史副本）与操作日志目录
 *   —— **保留 `99_Meta/04_索引与地图`**，MOC 就在那儿，20+ 篇笔记都链它，
 *   排掉整个 `99_Meta` 等于把"看 43 篇怎么分布在 MOC 上"这个选图谱的**原始理由**一起排掉。
 */
import { WorkspaceLeaf, type App } from 'obsidian';
import { btn, clear, div, icon } from '../../ui/primitives';
import { roundPlaceholder } from '../../ui/empty';
import { notify } from '../../ui/notify';
import type { WorkbenchContext } from '../../core/context';

export type GraphCoreState = 'ok' | 'disabled' | 'unknown';

interface InternalPluginsLike {
  plugins?: Record<string, { enabled?: boolean } | undefined>;
}

/** 图谱核心插件是否启用。**必须在挂载之前问**（挂完再问就晚了） */
export function graphCoreState(app: App): GraphCoreState {
  const ip = (app as unknown as { internalPlugins?: InternalPluginsLike }).internalPlugins;
  const entry = ip?.plugins?.graph;
  if (entry && typeof entry.enabled === 'boolean') return entry.enabled ? 'ok' : 'disabled';
  /**
   * 🔴 **形状读不到时再问一次注册表**（§5 给的第二条判据，P6 收尾按独立审查 F5 补上）。
   *
   * 为什么非有不可：这一档原来直接落回 `'unknown'`，而 `render()` 只拦 `'disabled'`
   * → 于是**照挂**。可真机上核心插件关着时是能挂出一片「插件不再活动」占位的，
   * 而 `getViewType()` 仍返回 `graph`（S1 实测）—— 界面上既没有"没开"的说明、
   * 也没有「重试」，看着就是"图谱坏了"。
   *
   * `getViewCreatorByType('graph') === null` = 这个视图类型没有创建者 → 插件没开。
   * 仍然读不到（版本差异 / 没有 viewRegistry）→ 维持 `'unknown'`，由调用方
   * **在说明条里写一句**（别静默）。
   */
  const reg = (app as unknown as {
    viewRegistry?: { getViewCreatorByType?: (t: string) => unknown };
  }).viewRegistry;
  if (reg && typeof reg.getViewCreatorByType === 'function') {
    try {
      if (reg.getViewCreatorByType('graph') == null) return 'disabled';
    } catch {
      /* 版本差异 → 保持 unknown */
    }
  }
  return 'unknown';
}

/**
 * 历史副本那座库的顶层目录名。
 * ⚠️ 与 `core/config-files.ts` 的 `excludedTop` 是**同一件事的两处**；这里只用到名字，
 * 值本身在 `redline.ts` 里被钉住（改了要一起改）。
 */
export const OLD_KB_TOP = '02_旧知识库';

/**
 * 注入给图谱的过滤表达式（Obsidian 图谱搜索语法：`-` 取反、`path:` 按路径子串匹配）。
 *
 * 两条排除：**旧库** + **操作日志目录**。后者只增不减（真库现在 3 条、实验库已 100+），
 * 在图上会连成一大团，把 43 篇的分布淹掉。
 * 日志目录的路径从 `ctx.paths.logDir()` 取（`01_新知识库/99_Meta/05_操作日志`）——
 * 不写死，库根改了它跟着走。
 */
export function graphExcludeQuery(ctx: WorkbenchContext): string {
  // ⚠️ 日志目录在 `SettingsStore` 上（`ctx.settings.logDir()`），不是 `ctx.paths`
  return [`-path:${OLD_KB_TOP}`, `-path:${ctx.settings.logDir()}`].join(' ');
}

/** 过滤注入的结果（`unsupported` = 这个版本上摸不到那个口，**要退成不注入并说明**）*/
export type FilterResult = 'ok' | 'unsupported';

interface DataEngineLike {
  setQuery?: (queries: { query: string; color: null }[]) => void;
}

/**
 * 程序化注入过滤。**失败不抛给调用方**（图谱照常显示，只是不过滤）——
 * §5 的出口是"显示说明"，不是"整页崩掉"。
 */
export function applyGraphFilter(view: unknown, query: string): FilterResult {
  const de = (view as { dataEngine?: DataEngineLike } | null)?.dataEngine;
  if (!de || typeof de.setQuery !== 'function') return 'unsupported';
  try {
    de.setQuery([{ query, color: null }]);
    return 'ok';
  } catch (e) {
    // 版本差异 / 内部形状变了 —— 记下来，界面上给说明
    console.error('[经纬] 图谱过滤注入失败（图谱照常显示，未过滤）', e);
    return 'unsupported';
  }
}

/**
 * **把官方图谱挂进任意容器**（P7.2d 抽出：图谱模块与首页「图谱卡」**同一份**）。
 *
 * 🔴 Q1 的红线原话："与 `modules/graph` 同一套挂载/过滤封装（先抽件再接线，
 * 两处算两遍必漂）" —— 页面的三条降级出口（关着 / 挂失败 / 过滤摸不到）
 * 由**调用方**决定怎么画，这里只管"裸叶 + 挂载 + 过滤注入 + detach 收干净"。
 *
 * 内部次序（每条都有真机教训，别动）：
 *  · 裸叶 `new WorkspaceLeaf(app)` 不进工作区（S1：`getLeavesOfType` 找不到它）；
 *  · **先 setViewState 挂上去、再注入过滤** —— 反了的话那时 `view.dataEngine`
 *    还是 undefined，会被判成 `unsupported`，图谱就永远不过滤；
 *  · `dispose()` 后挂载途中回来的那一份**不再往上挂**（防重试叠两片）；
 *  · 过滤注入走 `applyGraphFilter`（`setQuery`，不落盘 —— 见本文件头注）。
 */
export interface GraphMountHandle {
  /** detach 收干净（S1：detach 后 DOM 清空、渲染循环真停，再挂不叠加） */
  dispose(): void;
}

export function mountGraphInto(
  stage: HTMLElement,
  ctx: WorkbenchContext,
  hooks: { onFail?: (err: unknown) => void; onFilterUnsupported?: () => void } = {},
): GraphMountHandle {
  let leaf: WorkspaceLeaf | null = null;
  let disposed = false;

  const detach = (): void => {
    const l = leaf;
    leaf = null;
    if (!l) return;
    try {
      // S1 实测：detach 后 DOM 清空、渲染循环真停（rAF 284 → 0），再挂不叠加
      l.detach();
    } catch (e) {
      console.error('[经纬] 图谱卸载失败', e);
    }
  };

  let l: WorkspaceLeaf;
  try {
    /**
     * ⚠️ `@types/obsidian` 把 `WorkspaceLeaf` 的构造函数写成 **0 参**（与实际不符，
     * P4 的悬浮小窗那轮就确认过）→ 要 cast，**别为了过编译把 `app` 丢掉**
     *（丢了的话真机上 `new WorkspaceLeaf()` 造出来的叶不属于这个 app）。
     */
    const LeafCtor = WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf;
    l = new LeafCtor(ctx.app);
  } catch (e) {
    hooks.onFail?.(e);
    return { dispose: detach };
  }
  leaf = l;
  void l
    .setViewState({ type: 'graph' })
    .then(() => {
      // 挂载途中宿主被卸载 / 又被重试了一次 → 这片叶已经不是当前那片了，别往上挂
      if (disposed || leaf !== l) return;
      stage.appendChild(l.view.containerEl);
      /**
       * ⚠️ **给真机探针留的把手**：把挂上去的那份视图实例记在宿主元素上。
       *
       * 为什么要它：这片叶是**裸叶**（`new WorkspaceLeaf(app)`，不进工作区），
       * `workspace.getLeavesOfType('graph')` **找不到它**（S1 实测：不占标签页）。
       * 而"过滤到底生效没有"（`dataEngine.hasFilter` / 图上还剩几个旧库节点）
       * **只有真机能证** —— 离线桩只记录"收到了什么查询串"、不跑真匹配
       *（e2 那条教训：参照物抄了实现 = 离线永远绿）。
       *
       * 用 DOM 属性而不是全局变量：作用域跟着这一屏走，切走就自然没了。
       */
      (stage as unknown as { kbwGraphView?: unknown }).kbwGraphView = l.view;
      /**
       * **挂上去之后再注入过滤**（`dataEngine` 要等视图 load 完才有）
       * —— 顺序不能反：先注入的话那时 `view.dataEngine` 还是 undefined，
       * 会被判成 `unsupported`，图谱就永远不过滤了。
       */
      if (applyGraphFilter(l.view, graphExcludeQuery(ctx)) === 'unsupported') {
        hooks.onFilterUnsupported?.();
      }
    })
    .catch((e) => {
      if (disposed || leaf !== l) return;
      hooks.onFail?.(e);
    });

  return {
    dispose: () => {
      disposed = true;
      detach();
    },
  };
}

export function renderGraph(host: HTMLElement, ctx: WorkbenchContext): () => void {
  const shell = div({ cls: 'kbw-graph' });
  host.appendChild(shell);
  const stage = div({ cls: 'kbw-graph-stage' });
  const note = div({ cls: 'kbw-graph-note' });

  /** 当前这一片叶的把手（重试 / 卸载都先收它）—— 挂载细节全在 `mountGraphInto` */
  let current: GraphMountHandle | null = null;

  function showFailure(err: unknown): void {
    current?.dispose();
    current = null;
    clear(stage);
    note.textContent = '';
    stage.appendChild(
      roundPlaceholder('P6', '图谱没挂上', `内嵌官方图谱这一步失败了（${errText(err)}）。其余模块不受影响。`),
    );
    const row = div({ cls: 'kbw-graph-actions' });
    row.appendChild(
      btn({ cls: 'kbw-btn is-primary', on: { click: () => render() } }, icon('refresh-cw', 15), '重试'),
    );
    stage.appendChild(row);
  }

  /**
   * **整屏重建**（首帧 + 每一次「重试」都走它）。
   *
   * 为什么「重试」不能只重跑"挂载"那一段：核心插件关着时画的是**降级界面**
   * （`buildDisabled`），它压根没有 `stage` / `note` 这两个元素 ——
   * 只重跑挂载的话会往一个不存在的容器上写（第一版就是这么炸的）。
   * 统一从"这一屏该长什么样"重新判一次，三条出口（关着 / 挂上 / 挂失败）才都成立。
   */
  function render(): void {
    // 上一次的叶先彻底摘掉（重试两次不许叠出两片）
    current?.dispose();
    current = null;
    clear(shell);

    const state = graphCoreState(ctx.app);
    if (state === 'disabled') {
      // §5 第一条出口：**挂载之前**就拦住（挂完再看 view type 是看不出来的 —— S1）
      shell.appendChild(buildDisabled(ctx, () => render()));
      return;
    }

    clear(stage);
    clear(note);
    note.textContent = '';
    note.classList.remove('is-warn');
    /**
     * `'unknown'`（两条判据都读不到）→ 照挂，但**留一句话**（独立审查 F5）：
     * 真机上核心插件关着时会挂出一片「插件不再活动」占位、而 `getViewType()` 仍返回
     * `graph`，用户看到的只是"图谱坏了"—— 至少让他知道去哪儿看。
     */
    if (state === 'unknown') {
      note.classList.add('is-warn');
      note.textContent = '读不到「图谱」核心插件的状态。如果这一屏是空的，去 设置 → 核心插件 看它开没开 —— ';
      // 就地给一个出口：开完不用离开这一屏（与"关着"那条出口同一套动作）
      note.appendChild(
        btn({ cls: 'kbw-btn is-small', on: { click: () => render() } }, icon('refresh-cw', 13), '重试'),
      );
    }
    shell.appendChild(stage);
    shell.appendChild(note);

    current = mountGraphInto(stage, ctx, {
      onFail: showFailure,
      onFilterUnsupported: () => {
        note.classList.add('is-warn');
        note.textContent =
          '这个 Obsidian 版本上注入过滤没成功（图谱内部入口变了）——图谱照常显示，但没有排除旧库。';
      },
    });
  }

  render();

  return () => {
    current?.dispose();
    current = null;
  };
}

export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
}

/** 核心插件关着 → 说明 + 「去开启」+「重试」（§5 的第一条出口）*/
function buildDisabled(ctx: WorkbenchContext, onRetry: () => void): HTMLElement {
  const box = div({});
  box.appendChild(
    roundPlaceholder('P6', '图谱', '内嵌官方图谱（S1 已实测通过），但「图谱」核心插件现在是关着的'),
  );
  const row = div({ cls: 'kbw-graph-actions' });
  row.appendChild(
    btn({ cls: 'kbw-btn is-primary', on: { click: () => openCorePluginSettings(ctx) } }, icon('settings', 15), '去开启「图谱」核心插件'),
  );
  row.appendChild(btn({ cls: 'kbw-btn', on: { click: onRetry } }, icon('refresh-cw', 15), '重试'));
  box.appendChild(row);
  return box;
}

/** 打开 Obsidian 设置并尽量跳到「核心插件」那一栏 */
function openCorePluginSettings(ctx: WorkbenchContext): void {
  const setting = (ctx.app as unknown as {
    setting?: { open: () => void; openTabById?: (id: string) => void };
  }).setting;
  if (!setting) {
    ctx.openNativeSettings();
    return;
  }
  try {
    setting.open();
    setting.openTabById?.('core-plugins');
  } catch (e) {
    console.error('[经纬] 打开核心插件设置失败', e);
    ctx.openNativeSettings();
  }
  notify({ kind: 'info', text: '开启「图谱」后回到工作台点「重试」', ms: 4000 });
}
