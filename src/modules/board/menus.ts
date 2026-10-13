/**
 * modules/board/menus.ts —— 看板的两套菜单（交互规格 §8.1 全局 / §8.2 板块）
 *
 * 第三套（卡片/笔记菜单）**不在这里** —— 它复用 P1 的 `modules/notes/menus.ts`
 * （§8.3 就是那一份），本文件只把 `MenuCtx` 凑齐交给它。
 *
 * 三条硬规矩由 `ui/menu.ts` 兜底（作用域行常驻 / 长菜单要有分组 / 危险项最后），
 * 这里负责的是内容：**不可用项置灰并写出原因**（Windows 手感，位置不跳动），
 * 以及"一项决定一件事"。
 */
import type { WorkbenchContext } from '../../core/context';
import { showContextMenu, type MenuItem, type MenuHandle, type MenuRunCtx } from '../../ui/menu';
import { BOARD_VIEW_DEFAULTS } from '../../core/config-files';
import { CORE_PROPS, PROP_ORDER } from '../../services/schema';
import { NOTIFY_MS, notify } from '../../ui/notify';
import { PANEL_FONT_DELTA, defaultPanelFont } from './panel-ui';
import {
  CARD_H_MAX,
  CARD_MODE_LABEL,
  PANEL_FONT_STEPS,
  CARD_W_MAX,
  CARD_W_MIN,
  FLOW_LABEL,
  hasOverride,
  type BoardConfigStore,
  type BoardFlow,
  type BoardSection,
  type BoardView,
  type CardMode,
  type SortSpec,
} from './config';
import { defaultPropsFor, type BoardGroup } from './sources';
import { DOCK_SIDES, withDockSide, withPeekSide, type DockSide } from '../../ui/dock';
// ⚠️ 方向是 menus → editor（单向）：editor 不 import 菜单（那里只留"弹菜单过 ui/menu"这条红线）。
//    这里只要两个读数与一个动作（谁开着 / 最近交互的是哪一扇 / 认领停靠位）。
import { activePanelId, claimDockForActive, panelCount } from './editor';

/** 停靠方位的说法（菜单、回执都用它 —— 别在两处各写一遍中文） */
const DOCK_LABEL: Record<DockSide, string> = {
  left: '左侧',
  right: '右侧',
  bottom: '底部',
};

/**
 * 窗格大小的三档预设（与窗格边上那根分隔条是两条路走同一件事，见菜单里那段注释）。
 * 数值落在 `ui/dock.ts` 的 `[DOCK_MIN, DOCK_MAX]` 里，底部那档也低于 `DOCK_MAX_BOTTOM`。
 */
const DOCK_PRESETS: { label: string; size: number }[] = [
  { label: '窄（280）', size: 280 },
  { label: '中（380）', size: 380 },
  { label: '宽（520）', size: 520 },
];

export interface BoardMenuCtx {
  ctx: WorkbenchContext;
  store: BoardConfigStore;
  groups: () => BoardGroup[];
  refresh: () => void;
  onReceipt: (text: string) => void;
}

// ────────────────────────────────────────────────────────────────
// §8.1 全局菜单（看板空白处右键）
// ────────────────────────────────────────────────────────────────
export function showBoardMenu(m: BoardMenuCtx, evt: MouseEvent): MenuHandle {
  /**
   * ⚠️ `view` / `chosen` / `dirty` **都要在 `build()` 里现取**，不能在开菜单时捕获一次：
   * 「改设置不关窗」是就地 `refresh(build())`，用开局快照的话 —— 同一个菜单里连改两项，
   * 第二项会拿第一项之前的值算（**前一项被静默吞掉**），而且复选框显示的还是旧状态
   * （"菜单显示与文件相反"，正是硬规矩 2 要防的事）。独立审查 R3。
   */
  const snapshot = (): { view: BoardView; chosen: string[]; dirty: boolean; allProps: string[] } => {
    const view = m.store.get().view;
    return {
      view,
      chosen: view.props ?? defaultPropsFor(m.ctx.index.notes()),
      dirty: isViewDirty(m.store),
      allProps: propsPresent(m.ctx),
    };
  };
  let handle: MenuHandle | null = null;

  /**
   * 「停靠面板」**作用在哪一扇窗**（f 期多窗）：菜单里明写出来，别让用户猜。
   * 判据来自 `editor.ts`（那里才是"谁开着、最近交互的是哪一扇"的真源）。
   */
  const targetLabel = (): string => {
    const n = panelCount();
    if (n === 0) return '作用对象：（现在没有小窗 —— 只改偏好）';
    return `作用对象：小窗 #${activePanelId() ?? '?'}（最近用的那个，共 ${n} 扇）`;
  };
  const targetSuffix = (): string =>
    panelCount() === 0 ? '（下次打开小窗时生效）' : '（作用在最近用的小窗）';

  const set = (patch: Parameters<BoardConfigStore['patchView']>[0], receipt: string): void => {
    void m.store.patchView(patch).then(() => {
      m.refresh();
      m.onReceipt(receipt);
      // 「改设置不关窗」：就地刷新菜单（§4.1 的"不关窗 + 顶上一行回执"）
      handle?.refresh(build());
    });
  };

  const build = (): { scope: { kind: 'global'; label: string }; items: MenuItem[] } => {
    const { view, chosen, dirty, allProps } = snapshot();
    return {
    scope: { kind: 'global', label: `全部板块（${m.store.get().sections.length} 个）` },
    items: [
      {
        kind: 'item',
        label: '卡片显示',
        icon: 'layout-grid',
        submenu: (['content', 'props', 'both'] as CardMode[]).map((k) => ({
          kind: 'item' as const,
          label: CARD_MODE_LABEL[k],
          control: { type: 'radio' as const, checked: view.cardMode === k, group: 'cardMode' },
          run: () => set({ cardMode: k }, `卡片显示：${CARD_MODE_LABEL[k]}`),
        })),
      },
      {
        /**
         * 板块形态（P4.5 §2.1 / 拍板 Q4：**列默认、流式可选**）。
         * ⚠️ 窄档（<640px）走 CSS 强制回流式 —— 这里选「列」也看不出来，
         * 所以标签里写清"宽的时候"（免得在窄窗里选了列、以为坏了）。
         */
        kind: 'item',
        label: '板块形态',
        icon: 'columns-3',
        submenu: (['columns', 'flow'] as BoardFlow[]).map((k) => ({
          kind: 'item' as const,
          label: FLOW_LABEL[k],
          control: { type: 'radio' as const, checked: view.flow === k, group: 'flow' },
          run: () => set({ flow: k }, `板块形态：${FLOW_LABEL[k]}（窄窗下强制流式）`),
        })),
      },
      {
        kind: 'item',
        label: '显示属性',
        icon: 'tags',
        submenu: allProps.map((p) => ({
          kind: 'item' as const,
          label: p,
          control: { type: 'multi' as const, checked: chosen.includes(p) },
          stay: true,
          run: (run) => {
            const on = run.value === true;
            const next = on
              ? Array.from(new Set([...chosen, p]))
              : chosen.filter((x) => x !== p);
            set({ props: next }, `显示属性：${next.join('、') || '（空）'}`);
          },
        })),
      },
      {
        kind: 'item',
        label: '卡片宽度',
        icon: 'move-horizontal',
        control: { type: 'slider', value: view.cardWidth, min: CARD_W_MIN, max: CARD_W_MAX, step: 10 },
        // 拉杆/开关/多选都 **stay**：改设置不关窗（§4.1），回执在顶上那一行
        stay: true,
        run: (run) => set({ cardWidth: Number(run.value) }, `卡片宽度：${run.value}px`),
      },
      {
        kind: 'item',
        // 0 = 自动高度（拉杆最左边就是自动，标签会显示「自动」）
        label: '卡片高度（0 = 自动）',
        icon: 'move-vertical',
        control: {
          type: 'slider',
          value: view.cardHeight,
          min: 0,
          max: CARD_H_MAX,
          step: 20,
          auto: view.cardHeight === 0,
        },
        stay: true,
        run: (run) => {
          const v = Number(run.value);
          set({ cardHeight: v }, v === 0 ? '卡片高度：自动' : `卡片高度：${v}px`);
        },
      },
      {
        kind: 'item',
        label: '网格间距',
        icon: 'grid',
        control: { type: 'slider', value: view.gap, min: 0, max: 64, step: 2 },
        stay: true,
        run: (run) => set({ gap: Number(run.value) }, `网格间距：${run.value}px`),
      },
      {
        kind: 'item',
        label: '更多显示',
        icon: 'sliders-horizontal',
        submenu: [
          {
            /**
             * 悬浮小窗显示什么（用户 2026-09-25 要的）：
             * "可以选择隐藏每篇笔记的 YAML 头或结尾双链或笔记内容（默认显示小部分 YAML + 笔记）"。
             * 拆成两个正交选项：属性区 = YAML 头那块 UI；正文区 = 笔记内容。
             * 「结尾双链」只有**只读预览**档才藏得掉 —— 真编辑器里那是文件的一部分（菜单文案里写明了）。
             */
            kind: 'item',
            label: '小窗属性',
            icon: 'list',
            submenu: [
              { v: 'few' as const, label: '前 6 行（默认）' },
              { v: 'all' as const, label: '全部' },
              { v: 'none' as const, label: '不显示' },
            ].map((x) => ({
              kind: 'item' as const,
              label: x.label,
              control: { type: 'radio' as const, checked: view.panelProps === x.v, group: 'panelProps' },
              run: () => set({ panelProps: x.v }, `小窗属性：${x.label}`),
            })),
          },
          {
            kind: 'item',
            label: '小窗正文',
            icon: 'file-text',
            submenu: [
              { v: 'editor' as const, label: '可编辑（默认）' },
              { v: 'preview' as const, label: '只读预览（剥前言与尾链）' },
              { v: 'none' as const, label: '不显示' },
            ].map((x) => ({
              kind: 'item' as const,
              label: x.label,
              control: { type: 'radio' as const, checked: view.panelContent === x.v, group: 'panelContent' },
              run: () => set({ panelContent: x.v }, `小窗正文：${x.label}`),
            })),
          },
          {
            /**
             * **预览换行**（P6b ⑥，用户 2026-09-27 原话："看板窗口笔记预览内容要换行，
             * 默认换行显示，也可以设置为当前可以左右拖动的状态"）。
             * 一处开关两处生效：**卡片摘要**与**小窗只读预览**（同一份 `view.previewWrap`）。
             */
            kind: 'item',
            label: '预览换行',
            icon: 'text',
            submenu: [
              {
                kind: 'item' as const,
                label: '换行（默认）',
                control: { type: 'radio' as const, checked: view.previewWrap === true, group: 'previewWrap' },
                run: () => set({ previewWrap: true }, '预览换行：折行'),
              },
              {
                kind: 'item' as const,
                label: '横向滚动（不折行）',
                control: { type: 'radio' as const, checked: view.previewWrap === false, group: 'previewWrap' },
                run: () => set({ previewWrap: false }, '预览换行：横向滚动'),
              },
            ],
          },
          {
            /**
             * **钉住面板**（d 期 §3.1）—— 与面板头上那个图钉按钮**同一个开关**（`view.panelPinned`）。
             * 两处入口是故意的：图钉在面板上（顺手），这一条在空白处右键里（找得到）。
             * ⚠️ 真正生效的位置是面板自己 —— 它订阅 `cfg.onChange` 跟着走，
             * 所以不管从哪个入口改，面板都会立刻跟着变（不是"下次打开才生效"）。
             */
            kind: 'item',
            label: '钉住面板（点外面不关）',
            control: { type: 'toggle', checked: view.panelPinned },
            stay: true,
            run: (run) =>
              set({ panelPinned: run.value === true }, `面板：${run.value === true ? '已钉住' : '不再钉住'}`),
          },
          {
            /**
             * **停靠面板**（d2 期 §3.1）：把就地编辑面板从"浮在工作台上面"变成
             * "钉在工作台边上"（左 / 右 / 下），仍然是一组 tab、仍各挂真编辑器。
             *
             * ⚠️ 入口**只做菜单**（d2 拍板）：PyCharm 那套"拖到边缘高亮落点"的
             * 边缘探测 + 落点高亮 + 松手判定成本不小，且要与既有三套手势
             *（卡片拖动 / 面板头拖动 / 分隔条）不打架 —— 留给单独一期。
             *
             * ⚠️ 位置放在「更多显示」里而不是单开一个一级项：空白处右键那个菜单
             * **一级已经 9 项**（硬规矩 2 写的是 8）—— 再加就是往超载上再加。
             * 「钉住面板」也在这儿，两者本来就该挨着（同一类"面板该怎么待着"）。
             */
            kind: 'item',
            label: '停靠面板',
            icon: 'panel-right',
            submenu: [
              /**
               * 🔴 **多窗时的作用对象**（f 期口径 ③，用户 2026-09-26 拍板）：窗格只有一个口子，
               * 所以"停靠"这条菜单必须指名道姓 —— 认**最近交互的那一扇**（`claimDockForActive()`）。
               * 没有窗时照旧只写偏好（下次点开卡片直接落进窗格）。
               * 菜单文案里把这个说清楚（`target` 那句），免得用户以为"随便哪扇都行"。
               */
              { kind: 'item' as const, label: targetLabel(), disabled: '这是作用对象（不是开关）' },
              { kind: 'separator' as const },
              ...DOCK_SIDES.map((s) => ({
                kind: 'item' as const,
                label: `停靠到${DOCK_LABEL[s]}`,
                control: { type: 'radio' as const, checked: view.dock.where === s, group: 'dockWhere' },
                run: () => {
                  claimDockForActive();
                  set({ dock: withDockSide(view.dock, s) }, `停靠：${DOCK_LABEL[s]}${targetSuffix()}`);
                },
              })),
              {
                kind: 'item' as const,
                label: '不停靠（回浮层）',
                control: { type: 'radio' as const, checked: view.dock.where === null, group: 'dockWhere' },
                run: () => {
                  claimDockForActive();
                  set({ dock: withDockSide(view.dock, null) }, `停靠：已取消（面板回到浮层）${targetSuffix()}`);
                },
              },
              { kind: 'separator' as const },
              /**
               * **窗格大小的三档预设**。与窗格边上那根分隔条是**两条路走同一件事**：
               * 拖动是顺手，预设是"拖不动的时候也能改"—— WCAG 2.2 的
               * Dragging Movements 明确要求拖动必须有非拖动的等价操作（§4.3 记过这条口径），
               * 所以**两条都得留**，别看着重复就删掉一条。
               */
              ...DOCK_PRESETS.map((x) => ({
                kind: 'item' as const,
                label: `大小：${x.label}`,
                control: {
                  type: 'radio' as const,
                  checked: view.dock.size === x.size,
                  group: 'dockSize',
                },
                disabled: view.dock.where ? undefined : '先选一个停靠位置',
                run: () => {
                  claimDockForActive();
                  set(
                    { dock: { where: view.dock.where, size: x.size } },
                    `停靠大小：${x.size}px`,
                  );
                },
              })),
            ],
          },
          {
            /**
             * **预览窗格（Peek，e 期 §3.2）**：右侧常驻一个只读预览，跟着**键盘光标**走。
             *
             * 三条口径（`看板优化方案.md` §6.15，别在别处再判一次）：
             *  · **默认关**（拍板 Q2 的原话："要，默认关"）；
             *  · **只跟键盘光标**（方向键 / `[` `]`）—— 跟着鼠标闪就正好违反"不打断手上的操作"；
             *  · 与**停靠面板互斥**（同一个宿主的两种占用）：开它会把编辑面板收掉，反之亦然。
             *
             * ⚠️ 位置与「停靠面板」挨着：两者是同一类东西（窗格里放什么），
             * 而且互斥关系一眼看得见。一级项已经 9 项（硬规矩 2 写的是 8），
             * 所以照旧收进「更多显示」里，不加一级项。
             */
            kind: 'item',
            label: '预览窗格',
            icon: 'book-open',
            submenu: [
              {
                kind: 'item',
                label: '显示预览窗格（只读）',
                control: { type: 'toggle', checked: view.peekEnabled },
                run: () =>
                  set(
                    { peekEnabled: !view.peekEnabled },
                    view.peekEnabled
                      ? '预览窗格：已关（窗格让给编辑面板）'
                      : '预览窗格：已开（跟键盘光标走）',
                  ),
              },
              ...DOCK_SIDES.map((s) => ({
                kind: 'item' as const,
                label: `停到${DOCK_LABEL[s]}`,
                control: { type: 'radio' as const, checked: view.peek.where === s, group: 'peekWhere' },
                disabled: view.peekEnabled ? undefined : '先打开预览窗格',
                run: () => set({ peek: withPeekSide(view.peek, s) }, `预览窗格：${DOCK_LABEL[s]}`),
              })),
              { kind: 'separator' as const },
              ...DOCK_PRESETS.map((x) => ({
                kind: 'item' as const,
                label: `大小：${x.label}`,
                control: { type: 'radio' as const, checked: view.peek.size === x.size, group: 'peekSize' },
                disabled: view.peekEnabled ? undefined : '先打开预览窗格',
                run: () => set({ peek: { where: view.peek.where, size: x.size } }, `预览窗格大小：${x.size}px`),
              })),
            ],
          },
          {
            kind: 'item',
            label: '允许重复',
            control: { type: 'toggle', checked: view.allowDuplicate },
            stay: true,
            run: (run) => set({ allowDuplicate: run.value === true }, `允许重复：${run.value === true ? '开' : '关'}`),
          },
          {
            kind: 'item',
            label: '隐藏空板块',
            control: { type: 'toggle', checked: view.hideEmpty },
            stay: true,
            run: (run) => set({ hideEmpty: run.value === true }, `隐藏空板块：${run.value === true ? '开' : '关'}`),
          },
          {
            kind: 'item',
            label: '只读模式',
            control: { type: 'toggle', checked: view.readonly },
            stay: true,
            run: (run) => set({ readonly: run.value === true }, `只读模式：${run.value === true ? '开' : '关'}`),
          },
          /**
           * **「重载」从一级收进来了**（f 期，2026-09-26）：
           * 当时的硬规矩 2 是"一级最多 8 项"，而这个菜单一级**实际是 9 项**
           *（真机每跑一轮 `console.warn` 四条），多出来的正是这个「重载」。
           * 它是个**一次性动作**（不是显示偏好），收进这个"其它设置都在里面"的子菜单最合适。
           * ⚠️ **2026-10-02 口径变了**：8 项不再是硬线（软目标 + "长菜单要有分组"，见
           * `ui/menu.ts` 的 `MENU_TOP_COMFORT`）—— 但这一条**照样留着**：
           * 它当时是"降噪"，现在是"同一类动作放一起"（结论没变，理由换了）。
           */
          { kind: 'separator' },
          {
            kind: 'item',
            label: '重载',
            icon: 'refresh-cw',
            run: () => {
              m.ctx.index.rebuild();
              /**
               * ⚠️ 也要**重读库内配置**：手改过 `看板配置.json` 的人点这一下，想要的是
               * "按文件现状重来" —— 只重建索引的话配置那半仍是内存里的旧值
               * （`ConfigFiles.read` 不回写缓存，所以这里必须显式再读一遍）。
               */
              void m.store.load(false).then(() => {
                m.refresh();
                m.onReceipt('已重载（索引与看板配置都按库里的现状重建）');
              });
            },
          },
          {
            kind: 'item',
            label: '查看隐藏的文件',
            control: { type: 'toggle', checked: view.showHidden },
            stay: true,
            run: (run) =>
              set({ showHidden: run.value === true }, `查看隐藏的文件：${run.value === true ? '开' : '关'}`),
          },
          {
            kind: 'item',
            label: '摘要行数',
            icon: 'text',
            control: {
              type: 'slider',
              value: view.summaryLines,
              min: 0,
              max: 20,
              step: 1,
              auto: view.summaryLines === 0,
            },
            stay: true,
            run: (run) => {
              const v = Number(run.value);
              set({ summaryLines: v }, v === 0 ? '摘要行数：不显示正文' : `摘要行数：${v} 行`);
            },
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: '排序方式',
            submenu: [
              ...(['名称', '修改日期', '大小', '手动'] as const).map((k) => ({
                kind: 'item' as const,
                label: k,
                control: {
                  type: 'radio' as const,
                  checked: (view.sort?.key ?? '名称') === k,
                  group: 'sortKey',
                },
                run: () => set({ sort: { key: k, dir: view.sort?.dir ?? 'asc' } }, `排序：${k}`),
              })),
              { kind: 'separator' as const },
              ...allProps.map((p) => ({
                kind: 'item' as const,
                label: `按「${p}」`,
                control: { type: 'radio' as const, checked: view.sort?.key === p, group: 'sortKey' },
                run: () => set({ sort: { key: p, dir: view.sort?.dir ?? 'asc' } }, `排序：按${p}`),
              })),
            ],
          },
          {
            kind: 'item',
            label: '自动排列',
            disabled: 'P6（网格档的自由摆放）',
            control: { type: 'toggle', checked: true },
          },
          { kind: 'item', label: '列', disabled: 'P6（表格档）' },
        ],
      },
      {
        kind: 'item',
        label: '恢复本视图默认设置',
        icon: 'rotate-ccw',
        danger: true,
        disabled: dirty ? undefined : '当前就是默认值',
        run: () => {
          // 只重置**视图参数**，板块一个都不动（那不是"视图设置"）
          const { cardMode, cardWidth, gap, allowDuplicate, hideEmpty, shelter, summaryLines, showHidden, stripFrontmatter, stripTail } =
            BOARD_VIEW_DEFAULTS;
          void m.store
            .patchView({
              cardMode,
              cardWidth,
              gap,
              allowDuplicate,
              hideEmpty,
              shelter,
              summaryLines,
              showHidden,
              stripFrontmatter,
              stripTail,
              props: null,
              sort: null,
            })
            .then(() => {
              m.refresh();
              m.onReceipt('已恢复本视图的默认设置（板块没动；只读模式不算视图参数，不受影响）');
            });
        },
      },
    ],
    };
  };

  handle = showContextMenu(evt, build());
  return handle;
}

/**
 * **「小窗显示」菜单**（f 期第 3 条要的"多开入口"）。
 *
 * 用户 2026-09-26 的原话是"这个设置**只有那一个入口**"（面板头上那颗 ⚙）——
 * 现在给它第二、第三个入口：设置在「设置 · 看板默认值」栏里有一份（P3 起就有），
 * 而**工具条上"卡片显示"旁边**这一份是给人顺手用的（找"显示档"时手边就有）。
 *
 * 与空白处右键 → 更多显示里那两条**同一份字段**（`panelProps` / `panelContent` / `panelFont`），
 * 只是把三档选项直接铺成三项（工具条这一份不需要再套一层子菜单）。
 * ⚠️ 「每一篇单独设」不在这里 —— 那需要"哪一篇"这个上下文，只有面板自己的 ⚙ 有
 *（菜单里最后一行文案把这件事说明白，免得用户在这里找）。
 */
export function showPanelDisplayMenu(m: BoardMenuCtx, evt: MouseEvent): MenuHandle {
  const snapshot = (): BoardView => m.store.get().view;
  let handle: MenuHandle | null = null;

  const set = (patch: Parameters<BoardConfigStore['patchView']>[0], receipt: string): void => {
    void m.store.patchView(patch).then(() => {
      m.refresh();
      m.onReceipt(receipt);
      handle?.refresh(build());
    });
  };

  const build = (): { scope: { kind: 'global'; label: string }; items: MenuItem[] } => {
    const view = snapshot();
    return {
      scope: { kind: 'global', label: '小窗显示（所有窗的默认）' },
      items: [
        {
          kind: 'item',
          label: '小窗属性',
          icon: 'list',
          submenu: [
            { v: 'few' as const, label: '前 6 行（默认）' },
            { v: 'all' as const, label: '全部' },
            { v: 'none' as const, label: '不显示（藏掉 YAML 头那块）' },
          ].map((x) => ({
            kind: 'item' as const,
            label: x.label,
            control: { type: 'radio' as const, checked: view.panelProps === x.v, group: 'pdProps' },
            run: () => set({ panelProps: x.v }, `小窗属性：${x.label}`),
          })),
        },
        {
          kind: 'item',
          label: '小窗正文',
          icon: 'file-text',
          submenu: [
            { v: 'editor' as const, label: '可编辑（默认）' },
            { v: 'preview' as const, label: '只读预览（剥前言与尾链）' },
            { v: 'none' as const, label: '不显示' },
          ].map((x) => ({
            kind: 'item' as const,
            label: x.label,
            control: { type: 'radio' as const, checked: view.panelContent === x.v, group: 'pdContent' },
            run: () => set({ panelContent: x.v }, `小窗正文：${x.label}`),
          })),
        },
        {
          kind: 'item',
          label: '小窗字号',
          icon: 'type',
          submenu: [
            {
              kind: 'item' as const,
              // ⚠️ 与面板 ⚙ 菜单同源：0 = "没设过 → 平台 −2px"（C1 起），不是"跟随平台"
              label: `默认（平台 ${PANEL_FONT_DELTA}px → ${defaultPanelFont()}px）`,
              control: { type: 'radio' as const, checked: view.panelFont === 0, group: 'pdFont' },
              run: () => set({ panelFont: 0 }, `小窗字号：默认（${defaultPanelFont()}px）`),
            },
            ...PANEL_FONT_STEPS.map((px) => ({
              kind: 'item' as const,
              label: `${px}px`,
              control: { type: 'radio' as const, checked: view.panelFont === px, group: 'pdFont' },
              run: () => set({ panelFont: px }, `小窗字号：${px}px`),
            })),
          ],
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: '某一篇单独设：打开那篇小窗后点它头上的齿轮',
          icon: 'info',
          disabled: '这是说明，不是开关',
        },
      ],
    };
  };

  handle = showContextMenu(evt, build());
  return handle;
}

// ────────────────────────────────────────────────────────────────
// §8.2 板块菜单（板块标题 / 子板块行右键）
// ────────────────────────────────────────────────────────────────
export interface SectionMenuCtx {
  ctx: WorkbenchContext;
  cfg: BoardConfigStore;
  group: BoardGroup;
  /** ⚠️ 开菜单那一刻的板块快照；**每次要用都走 `cur()` 现取**（见 `showBoardMenu` 的同一条注释） */
  section: BoardSection | null;
  refresh: () => void;
  onRename: () => void;
  onReceipt: (text: string) => void;
  onOpenPanel: () => void;
  onExpandAll: (open: boolean) => void;
  onNewNote: () => void;
  onDelete: () => void;
}

export function showSectionMenu(m: SectionMenuCtx, evt: MouseEvent): void {
  /** 现取这一块（「改设置不关窗」时菜单会就地重建，吃开局快照会吞掉上一次改动） */
  const cur = (): BoardSection | null =>
    m.cfg.get().sections.find((x) => x.id === (m.section?.id ?? '')) ?? null;
  let armed = false;
  let handle: MenuHandle | null = null;

  const setSection = (patch: Partial<BoardSection>, receipt: string): void => {
    const target = cur();
    if (!target) return;
    const sections = m.cfg.get().sections.map((s) => (s.id === target.id ? { ...s, ...patch } : s));
    void m.cfg.save({ sections }).then(() => {
      m.refresh();
      m.onReceipt(receipt);
      handle?.refresh(build());
    });
  };

  const cardModeItems = (): MenuItem[] => {
    const forMode = cur()?.cardMode ?? null;
    const secNow = cur();
    const opts: [CardMode | null, string][] = [
      [null, '继承'],
      ['content', '只内容'],
      ['props', '只属性'],
      ['both', '两者'],
    ];
    const modes: MenuItem[] = opts.map(([v, label]) => ({
      kind: 'item' as const,
      label,
      control: { type: 'radio' as const, checked: forMode === v, group: 'secCardMode' },
      run: () => setSection({ cardMode: v }, `「${m.group.title}」卡片显示：${label}`),
    }));
    /**
     * **尺寸与摘要行数**也收在这个子菜单里（板块级覆盖）。
     * 为什么不单开一个一级项：一级最多 8 项，这个板块菜单**正好占满**了
     * （§8.4 硬规矩之二）。拉杆拖到哪儿就是显式覆盖；想回到"继承看板"用「重置本板块设置」。
     */
    const view = m.cfg.get().view;
    const size: MenuItem[] = [
      { kind: 'separator' as const },
      {
        kind: 'item' as const,
        label: '卡片宽度',
        icon: 'move-horizontal',
        control: {
          type: 'slider' as const,
          value: secNow?.width ?? view.cardWidth,
          min: CARD_W_MIN,
          max: CARD_W_MAX,
          step: 10,
        },
        stay: true,
        run: (run: MenuRunCtx) =>
          setSection({ width: Number(run.value) }, `「${m.group.title}」卡片宽度：${run.value}px`),
      },
      {
        kind: 'item' as const,
        // ⚠️ 板块级的 0 是「**继承看板级**」，不是「自动」——语义与看板级那条不同，
        // 标签照实写（看板级那条才是 0 = 自动）
        label: '卡片高度（0 = 继承）',
        icon: 'move-vertical',
        control: {
          type: 'slider' as const,
          value: secNow?.height ?? view.cardHeight,
          min: 0,
          max: CARD_H_MAX,
          step: 20,
          auto: (secNow?.height ?? view.cardHeight) === 0,
        },
        stay: true,
        run: (run: MenuRunCtx) => {
          const v = Number(run.value);
          setSection(
            { height: v === 0 ? null : v },
            v === 0 ? `「${m.group.title}」卡片高度：继承看板` : `「${m.group.title}」卡片高度：${v}px`,
          );
        },
      },
      {
        kind: 'item' as const,
        label: '摘要行数',
        icon: 'text',
        control: {
          type: 'slider' as const,
          value: view.summaryLines,
          min: 0,
          max: 20,
          step: 1,
          auto: view.summaryLines === 0,
        },
        stay: true,
        run: (run: MenuRunCtx) => {
          const v = Number(run.value);
          // ⚠️ 摘要行数是**看板级**参数（板块级没有覆盖项）→ 直接写 view 段
          void m.cfg.patchView({ summaryLines: v }).then(() => {
            m.refresh();
            m.onReceipt(`摘要行数：${v} 行`);
            handle?.refresh(build());
          });
        },
      },
    ];
    return [...modes, ...size];
  };

  const build = (): { scope: { kind: 'section'; label: string }; items: MenuItem[] } => {
    const sec = cur();
    const override = sec ? hasOverride(sec) : false;
    const allProps = propsPresent(m.ctx);
    const count = m.group.total;
    const items: MenuItem[] = [
      {
        kind: 'item',
        label: '在此新建笔记',
        icon: 'file-plus',
        run: () => m.onNewNote(),
      },
      {
        kind: 'item',
        label: '重命名',
        icon: 'pencil',
        disabled: m.group.sub ? '子板块名来自目录' : undefined,
        run: () => m.onRename(),
      },
      {
        kind: 'item',
        label: '卡片显示',
        icon: 'layout-grid',
        disabled: m.group.sub ? '子板块跟着父板块' : undefined,
        submenu: cardModeItems(),
      },
      {
        kind: 'item',
        label: '本板块属性列',
        icon: 'tags',
        disabled: m.group.sub ? '子板块跟着父板块' : undefined,
        submenu: [
          {
            kind: 'item',
            label: '继承看板',
            control: { type: 'radio', checked: sec?.props == null, group: 'secProps' },
            run: () => setSection({ props: null }, `「${m.group.title}」属性列：继承看板`),
          },
          { kind: 'separator' },
          ...allProps.map((p) => ({
            kind: 'item' as const,
            label: p,
            control: {
              type: 'multi' as const,
              checked: (sec?.props ?? []).includes(p),
            },
            run: (run: MenuRunCtx) => {
              const cur = sec?.props ?? [];
              const next = run.value === true ? Array.from(new Set([...cur, p])) : cur.filter((x) => x !== p);
              setSection({ props: next }, `「${m.group.title}」属性列：${next.join('、') || '（空）'}`);
            },
          })),
        ],
      },
      {
        kind: 'item',
        label: '排序',
        icon: 'arrow-up-down',
        disabled: m.group.sub ? '子板块跟着父板块' : undefined,
        submenu: [
          ...(['手动', '名称', '修改日期', '大小'] as const).map((k) => ({
            kind: 'item' as const,
            label: k,
            control: {
              type: 'radio' as const,
              checked: (sec?.sort?.key ?? '继承') === k,
              group: 'secSort',
            },
            run: () => setSection({ sort: { key: k, dir: 'asc' } as SortSpec }, `「${m.group.title}」排序：${k}`),
          })),
          {
            kind: 'item' as const,
            label: '继承看板',
            control: { type: 'radio' as const, checked: sec?.sort == null, group: 'secSort' },
            run: () => setSection({ sort: null }, `「${m.group.title}」排序：继承看板`),
          },
          { kind: 'separator' as const },
          ...allProps.map((p) => ({
            kind: 'item' as const,
            label: `按「${p}」`,
            control: { type: 'radio' as const, checked: sec?.sort?.key === p, group: 'secSort' },
            run: () => setSection({ sort: { key: p, dir: 'asc' } }, `「${m.group.title}」排序：按${p}`),
          })),
        ],
      },
      {
        kind: 'item',
        label: '显示上限',
        icon: 'list-filter',
        disabled: m.group.sub ? '子板块跟着父板块' : undefined,
        submenu: [
          ...([null, 5, 10, 20, 50] as (number | null)[]).map((n) => ({
            kind: 'item' as const,
            label: n == null ? '不限（默认）' : `前 ${n} 篇`,
            control: {
              type: 'radio' as const,
              checked: (sec?.limit ?? null) === n,
              group: 'secLimit',
            },
            run: () =>
              setSection({ limit: n }, n == null ? `「${m.group.title}」不限条数` : `「${m.group.title}」只显示前 ${n} 篇`),
          })),
          { kind: 'separator' as const },
          {
            kind: 'item' as const,
            label: '上限不是性能护栏',
            disabled: '43 篇全量渲染毫无压力；它只是"只给我看前 N 篇"',
          },
        ],
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: '板块管理…',
        icon: 'settings',
        run: () => m.onOpenPanel(),
      },
      {
        kind: 'item',
        label: '重置本板块设置',
        icon: 'rotate-ccw',
        disabled: override ? undefined : '无覆盖',
        run: () =>
          setSection(
            { cardMode: null, props: null, sort: null, width: null, height: null },
            `「${m.group.title}」已恢复继承`,
          ),
      },
      {
        kind: 'item',
        label: armed ? '再点一次确认' : `删除「${m.group.title}」板块`,
        icon: 'trash-2',
        danger: true,
        // 两下确认（§4.1）：第一下只改文案，**不关窗**（关了就点不了第二下）
        stay: !armed,
        disabled: m.group.sub ? '子板块跟着父板块' : undefined,
        run: () => {
          if (!armed) {
            armed = true;
            return;
          }
          m.onDelete();
        },
      },
    ];
    void count;
    return { scope: { kind: 'section', label: `${m.group.title}（${count} 篇）` }, items };
  };

  handle = showContextMenu(evt, build());
}

// ────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────
/** 库里真有的属性（按规范顺序，自定义的排后面）—— 菜单的候选项 */
/**
 * 库里真有的属性（按规范顺序，自定义的排后面）。
 * ⚠️ **核心项与元属性排到最后**：`defaultPropsFor`（默认档）会把它们筛掉，
 * 这里只是让"显式想加 `状态`/`类型` 当 kv 行"的人找得到 —— 顺序本身就是提示
 * （独立审查 10c：两处的候选口径不一致，会让人以为默认档里有它们）。
 */
const META_PROPS = new Set([...CORE_PROPS, '隐藏', '位置锁定', '文件位置']);

function propsPresent(ctx: WorkbenchContext): string[] {
  const present = new Set<string>();
  for (const e of ctx.index.notes()) for (const k of Object.keys(e.props)) present.add(k);
  const known = PROP_ORDER.filter((p) => present.has(p));
  const custom = Array.from(present)
    .filter((p) => !PROP_ORDER.includes(p))
    .sort((a, b) => a.localeCompare(b, 'zh'));
  const all = [...known, ...custom];
  return [...all.filter((p) => !META_PROPS.has(p)), ...all.filter((p) => META_PROPS.has(p))];
}

/** 视图参数改过没有（「恢复本视图默认设置」据此置灰） */
function isViewDirty(store: BoardConfigStore): boolean {
  const v = store.get().view;
  const d = BOARD_VIEW_DEFAULTS;
  return (
    v.cardMode !== d.cardMode ||
    v.cardWidth !== d.cardWidth ||
    v.gap !== d.gap ||
    v.allowDuplicate !== d.allowDuplicate ||
    v.hideEmpty !== d.hideEmpty ||
    v.shelter !== d.shelter ||
    v.summaryLines !== d.summaryLines ||
    v.showHidden !== d.showHidden ||
    v.stripFrontmatter !== d.stripFrontmatter ||
    v.stripTail !== d.stripTail ||
    v.props != null ||
    v.sort != null
  );
}

/** 板级"这一期还没到"的统一说法（别各处自己写文案） */
export function boardNotYet(what: string): void {
  notify({ kind: 'info', text: `${what}在 P6 提供`, ms: NOTIFY_MS.info });
}
