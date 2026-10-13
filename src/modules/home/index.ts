/**
 * modules/home —— 首页（P1 实做，交互规格 §2）
 *
 * 形态（视觉稿 ①屏）：上半部 Google 式（居中标识 + 大搜索框 + 四个快捷动作，
 * 靠留白立住）→ 发丝线 → 下半部回到工作台（待处理清单 + 最近改动）。
 * 待处理为空时下半部只剩一句「库是干净的」。
 *
 * ── P7.2a（§1.2）重构：数据驱动的**区块注册表** ──────────────────
 * · 现有五块搬进 `blocks/` 各自的件（**行为一字不改**）；新模块 M1 收藏夹 /
 *   M4 随机漫步 / M8 教程卡片（默认关）。
 * · 渲染循环读 `resolveHomeBlocks()`（`blocks/index.ts` 是显隐/顺序的**唯一解析口**）：
 *   顺序 = `order`、显隐 = `hidden`（还没动过 = 全按注册表 `defaultOn`）。
 * · 显隐/顺序落插件 `data.json` 的 `homeBlocks`（本机偏好：不进库、不参与同步、
 *   **不进视图记忆**——别存第二套）。
 * · 拖序：桌面从块头的**拖柄**拖、触屏**长按块**（400ms，走 `ui/dnd.ts` 基元）；
 *   落点判定是纯函数（`insertionRowAt`）+ FLIP 让位（照 `notes/grid.ts` 的纪律：
 *   **布局坐标**，不能拿带 transform 的 rect 当基准）。
 * · ⋯ 菜单 = 拖拽的**非拖拽等价物**（上移/下移/隐藏，键盘与触屏同样可达）。
 * · **空块自动隐藏**（D3）：块 paint 返回 false → 容器不画。这是新模块的口径；
 *   老五块恒 true（"库是干净的"那类空态照旧画，行为不变）。
 * · 全隐 → 空态给动作（照 `ui/empty.ts` 的纪律：回到「显示模块」入口）。
 *
 * ⚠️ 搜索框**不进任何 Region**（工具条那条经验）：它只随 hero 块重建
 * —— index 变化只重画 todo/recent/fav/walk 这几个 Region。
 */
import type { ModuleRender, WorkbenchContext } from '../../core/context';
import { Disposer, on } from '../../core/util';
import { Region } from '../../core/store';
import { div, el, icon } from '../../ui/primitives';
import { emptyState } from '../../ui/empty';
import { notify, NOTIFY_MS } from '../../ui/notify';
import { showContextMenu } from '../../ui/menu';
import { startPointerDrag, isTouchPointer } from '../../ui/dnd';
import { openInboxChoices } from './tidy';
import { openNewNoteDialog } from '../../ui/new-note';
import { openSnapshotPanel } from '../../ui/snapshot-panel';
import {
  BLOCK_BY_ID,
  HOME_BLOCKS,
  homeCardsRegionKey,
  insertionRowAt,
  resolveHomeBlocks,
  swapNeighbor,
} from './blocks';
import { focusHeroSearch } from './blocks/hero';
import { openTodoRowMenu, todoItemOf } from './blocks/todo';
import { runFullProcess } from './todo-actions';
import type { HomeBlocks } from '../../core/settings';

/**
 * 会用 Region 重画的块（随索引/忽略项变化）。
 * 其余（hero/quick/foot）画一次就够 —— 与"搜索框不重建"是同一条理由。
 * ⚠️ P7.2d 起另有两条**专用 key**（在 `mountBlocks` 的分支里，不在这张表）：
 * `homeCards`（行卡档吃 rev / 窗档不吃 —— 真编辑器不能被重画摘焦点）与
 * `tutorial`（只吃旗标 `onb` —— 打勾/退休要当场反映，索引变化与它无关）。
 */
const REPAINT_IDS = new Set(['todo', 'recent', 'fav', 'walk']);

/** 渲染循环喂给各 Region 的信号 */
interface BlockState {
  rev: number;
  /** homeDismissed 的内容串（引用每次 save 都变，用内容比） */
  dismissed: string;
  /** homeCards 的内容串（同上；「钉住的笔记」的 Region key 吃它，见 `homeCardsRegionKey`） */
  cards: string;
  /** 新手清单的旗标串（`wizardDone` + `onboarding`）——「新手清单」块的 key 吃它 */
  onb: string;
}

interface Mounted {
  box: HTMLElement;
  /** 这一轮的块内容容器（`.kbw-hblock-body`）—— `cleanup(host)` 认"自己那一份" */
  content: HTMLElement;
  region: Region<BlockState> | null;
  /** 强制重画这一块（P7.11 · #8「重载此板块」用；Region 块走 `paint(state, true)`） */
  force: () => void;
}

/** `homeBlocks` 的落盘签名（区分"我自己写的"与"外部改的"） */
function sigOf(hb: HomeBlocks | null): string {
  return hb ? JSON.stringify([hb.order, hb.hidden]) : 'null';
}

export const renderHome: ModuleRender = (host, ctx) => {
  const home = new HomeModule(ctx);
  home.mount(host);
  return () => home.dispose();
};

class HomeModule {
  private ctx: WorkbenchContext;
  private d = new Disposer();
  private host!: HTMLElement;
  private mounted = new Map<string, Mounted>();
  /** 全隐空态（有它时，"有没有块"这件事由 `syncEmpty` 管） */
  private emptyEl: HTMLElement | null = null;
  /** 上次见到的 homeBlocks 签名 —— 变了才整块重建（见 `onSettings`） */
  private blocksSig = 'null';
  /** 拖动中的取消函数（模块卸载/重建时要中止） */
  private dragCancel: (() => void) | null = null;

  constructor(ctx: WorkbenchContext) {
    this.ctx = ctx;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    host.classList.add('kbw-home');
    this.blocksSig = sigOf(this.ctx.settings.get().homeBlocks);
    this.mountBlocks();

    this.d.add(
      this.ctx.index.onChange(() => {
        if (this.ctx.store.get().activeModule !== 'home') return;
        this.repaintBlocks();
      }),
    );
    this.d.add(this.ctx.settings.onChange(() => this.onSettings()));
    /**
     * **看板模块开关翻了 → 「钉住的笔记」换档**（P7.2d：看板开 → B 内嵌小窗、
     * 关 → A 行卡）。档位在 `homeCardsRegionKey` 里从 `gate` 现读 —— key 变了
     * 这次 `repaintBlocks` 才会真的重画那一块（其余块的 key 没变 = 空转）。
     */
    this.d.add(
      this.ctx.gate.onChange(() => {
        if (this.ctx.store.get().activeModule !== 'home') return;
        this.repaintBlocks();
      }),
    );

    /**
     * **右键**（B1，§8.1）：挂在整屏根上，分两档（P7.7 收 · 2026-10-05 用户真机：
     * 「首页右键无法直接对首页组件进行设置」）：
     *   · **组件上右键**（落在 `.kbw-hblock` 里）→ **这一块的菜单**（⋯ 同款 + 首页设置…）；
     *   · **空白处右键**（块外的缝 / 页边）→ 首页全局菜单。
     * ⚠️ 旧排除名单里的 `.kbw-todo-row` 是个**死类名**（真实行是 `.kbw-todo`）——
     * 一直没生效也没人发现；现在行上右键按"属于哪个组件"归口，整个删掉。
     * 交互控件（按钮/输入框…）上右键不抢：那是平台原生的右键（剪切/粘贴…）。
     */
    this.d.add(
      on(host, 'contextmenu', (evt) => {
        const t = evt.target as HTMLElement | null;
        if (t?.closest?.('button, input, a, select, textarea, .kbw-gsearch')) return;
        evt.preventDefault();
        const blockEl = t?.closest?.('.kbw-hblock') as HTMLElement | null;
        const id = blockEl?.dataset?.block ?? '';
        if (id && BLOCK_BY_ID[id]) {
          /**
           * **待处理块再分一层**（P7.11 · #4）：落在**行**上 → 「这一项」菜单；
           * 落在块内其它地方 → 块菜单（AI 一层 + 默认四项）。其它块不分。
           */
          if (id === 'todo') {
            const item = todoItemOf(t);
            if (item) {
              const rowEl = t?.closest?.('.kbw-todo') as HTMLElement;
              openTodoRowMenu(this.ctx, evt as MouseEvent, item, rowEl);
              return;
            }
          }
          this.showBlockMenu(evt as MouseEvent, id);
          return;
        }
        this.showMenu(evt as MouseEvent);
      }),
    );

    /**
     * **拖序的起手**（host 级委托）：
     * · 拖柄（`.kbw-hblock-grip`）——桌面路径；
     * · 触屏**长按块体**（400ms 容差在 `ui/dnd.ts` 里）——触屏没有 hover，
     *   交互元素（按钮/输入框）上不起手（长按它们不是"要拖块"）。
     */
    this.d.add(
      on(host, 'pointerdown', (evt) => {
        const e = evt as PointerEvent;
        const t = e.target as HTMLElement | null;
        const blockEl = t?.closest?.('.kbw-hblock') as HTMLElement | null;
        const id = blockEl?.dataset?.block ?? '';
        if (!id || !BLOCK_BY_ID[id]) return;
        if (t?.closest?.('.kbw-hblock-grip')) {
          this.beginBlockDrag(e, id);
          return;
        }
        if (isTouchPointer(e) && !t?.closest?.('button, input, a, select, textarea, [role="button"]')) {
          this.beginBlockDrag(e, id);
        }
      }),
    );

    this.d.add(this.ctx.keys.register('home', host, (action) => this.onKey(action)));
  }

  dispose(): void {
    this.dragCancel?.();
    this.dragCancel = null;
    for (const m of this.mounted.values()) m.region?.dispose();
    // ⚠️ `cleanup(host)` 传的是**这一轮的块内容**（挂进宿主的叶 / 窗认它收尾，见 HomeBlock.cleanup）
    for (const b of HOME_BLOCKS) b.cleanup?.(this.mounted.get(b.id)?.content);
    this.mounted.clear();
    this.d.dispose();
  }

  // ── 渲染循环 ────────────────────────────────────────────────
  private blockState(): BlockState {
    return {
      rev: this.ctx.index.revision,
      dismissed: this.ctx.settings.get().homeDismissed.join(','),
      // 引用每次 save 都变，用内容比（与 dismissed 同一条）
      cards: JSON.stringify(this.ctx.settings.get().homeCards ?? null),
      onb: JSON.stringify([
        this.ctx.settings.get().wizardDone === true,
        this.ctx.settings.get().onboarding ?? null,
      ]),
    };
  }

  /**
   * 按 `homeBlocks` 重建全部块（显隐/顺序变化走这里；**拖序不走**
   * ——拖动是就地挪 DOM，见 `beginBlockDrag`）。
   */
  private mountBlocks(): void {
    this.dragCancel?.();
    this.dragCancel = null;
    for (const m of this.mounted.values()) m.region?.dispose();
    // ⚠️ `cleanup(host)` 传**旧内容容器**：挂叶/挂窗的块靠它认"自己那一份"（见 HomeBlock.cleanup）
    for (const b of HOME_BLOCKS) b.cleanup?.(this.mounted.get(b.id)?.content);
    this.mounted.clear();
    this.emptyEl = null;
    while (this.host.firstChild) this.host.removeChild(this.host.firstChild);

    const r = resolveHomeBlocks(this.ctx.settings.get().homeBlocks);
    for (const id of r.order) {
      if (r.hidden.has(id)) continue;
      const block = BLOCK_BY_ID[id];
      if (!block) continue;
      const box = div({ cls: 'kbw-hblock', data: { block: id, w: block.width ?? 'wide' } });
      this.host.appendChild(box);
      const tools = this.mountTools(box, id);
      /**
       * 🔴 **内容画进独立子容器，Region 的宿主是它、不是 box**：
       * `Region.paint` 是"先清宿主、再调渲染函数"——拿 box 当宿主的话，
       * 每轮重画会把块头的工具（拖柄 / ⋯）一起清掉。
       * 离线实测的形状：非 Region 块（hero/quick/foot）工具有，Region 块
       * （todo/recent/fav/walk）**工具凭空消失**（点不到"上移一位"）。
       */
      const content = div({ cls: 'kbw-hblock-body' });
      box.appendChild(content);

      const paintInto = (): void => {
        const has = block.paint(this.ctx, content);
        /**
         * 工具条**入首行**（P7.11 · #6/#7）：每画完一次就把工具挪进块的第一行
         *（段头 `.kbw-sec-head` / 底部状态行 `.kbw-home-foot`）——它是行内 flex 项、
         * 与首行文字**同一中线**（"同排实排"；上一版用算出来的 top 值视觉仍偏）。
         * 没有首行的块（hero/quick）留在容器上，绝对定位照旧。
         * 🔴 **工具用 `tools` 引用重挂，别靠 querySelector 找**：Region 重画是
         * "先清宿主"——工具上轮挪进了首行（在 content 里），这一清就把它摘出 DOM，
         * 从 box 里再也查不到（块一下子就没了拖柄/⋯）。
         */
        this.placeBlockTools(box, content, tools);
        box.hidden = !has;
        this.syncEmpty();
      };
      if (REPAINT_IDS.has(id)) {
        const region = new Region<BlockState>(content, () => paintInto(), {
          key: (s) => `${s.rev}|${s.dismissed}`,
        });
        this.mounted.set(id, { box, content, region, force: () => region.paint(this.blockState(), true) });
        region.paint(this.blockState());
      } else if (id === 'homeCards') {
        /**
         * 「钉住的笔记」有自己的一条 key（`homeCardsRegionKey`）：
         * 行卡档吃 index（行要新）、**窗档不吃**（里面是真编辑器，重画会摘掉焦点）——
         * 两档的取舍与"看板开关换了才换 key"都写在那条函数的注释里。
         */
        const region = new Region<BlockState>(content, () => paintInto(), {
          key: (s) => homeCardsRegionKey(this.ctx, s),
        });
        this.mounted.set(id, { box, content, region, force: () => region.paint(this.blockState(), true) });
        region.paint(this.blockState());
      } else if (id === 'tutorial') {
        /**
         * 「新手清单」只吃旗标（`onb`）：打勾 / 全勾退休 / 设置里重置都要当场反映，
         * 而索引变化与它无关（**不吃 rev** —— 打个勾、retire 一下而已，别白重画）。
         */
        const region = new Region<BlockState>(content, () => paintInto(), {
          key: (s) => `tut|${s.onb}`,
        });
        this.mounted.set(id, { box, content, region, force: () => region.paint(this.blockState(), true) });
        region.paint(this.blockState());
      } else {
        const force = (): void => {
          content.textContent = '';
          paintInto();
        };
        this.mounted.set(id, { box, content, region: null, force });
        paintInto();
      }
    }
    this.syncEmpty();
  }

  /**
   * 把块头工具（拖柄 / ⋯）**挪进块的第一行**（P7.11 · #6/#7 批注定稿的"同排实排"）。
   * 第一行的口径 = 内容容器里的 `.kbw-sec-head` 或 `.kbw-home-foot`（直接子级）；
   * 没有的就让它留在容器上（绝对定位 `top:4px` 照旧 —— 没有文字行可对齐）。
   * ⚠️ 工具**用引用传进来**（见 `paintInto` 的注释：Region 清宿主会把它从 DOM 摘掉，
   * 按选择器找不到）；`appendChild` 到行尾 = 行内最右，本来就要在那儿。
   */
  private placeBlockTools(box: HTMLElement, content: HTMLElement, tools: HTMLElement): void {
    const row = content.querySelector<HTMLElement>(':scope > .kbw-sec-head, :scope > .kbw-home-foot');
    if (row) {
      if (tools.parentElement !== row || tools.nextElementSibling !== null) row.appendChild(tools);
      tools.classList.add('is-inline');
    } else {
      if (tools.parentElement !== box) box.appendChild(tools);
      tools.classList.remove('is-inline');
    }
  }

  /** 索引/忽略项变了 → 按各 Region 的 key 重画（hero 那些不在列表里，不重建） */
  private repaintBlocks(): void {
    const state = this.blockState();
    for (const m of this.mounted.values()) m.region?.paint(state);
  }

  /**
   * 设置变化。**两条路要分开**：
   * · `homeBlocks` 变了（显隐/顺序被外部改，比如设置面板）→ 整块重建；
   * · 其余（忽略项恢复等）→ 按 key 重画。
   *
   * ⚠️ 拖序/隐藏/上移这些**自己写**的路子会先更新 `blocksSig` 再落盘 ——
   * 于是这里的比对相等、不会把刚摆好的 DOM 无谓重建（搜索框不再闪一次）。
   */
  private onSettings(): void {
    const now = sigOf(this.ctx.settings.get().homeBlocks);
    if (now !== this.blocksSig) {
      this.blocksSig = now;
      this.mountBlocks();
      return;
    }
    this.repaintBlocks();
  }

  /** 全隐（或全空）→ 空态给动作；有可见块就收掉它 */
  private syncEmpty(): void {
    const anyVisible = [...this.host.querySelectorAll<HTMLElement>('.kbw-hblock')].some(
      (b) => !b.hidden,
    );
    if (anyVisible) {
      this.emptyEl?.remove();
      this.emptyEl = null;
      return;
    }
    if (this.emptyEl) return;
    this.emptyEl = emptyState({
      kind: 'home',
      title: '首页上的区块都被收起来了',
      desc: '想找回哪块就打开模块设置；或者一步恢复到默认布局。',
      action: { label: '显示模块', run: () => this.ctx.openWorkbenchSettings('home') },
    });
    this.host.appendChild(this.emptyEl);
  }

  // ── 块头工具（拖柄 + ⋯）────────────────────────────────────
  /** 建工具条并挂在容器上；**返回它**——重画时要靠这个引用重挂（见 `paintInto`） */
  private mountTools(box: HTMLElement, id: string): HTMLElement {
    const tools = div({ cls: 'kbw-hblock-tools' });
    const grip = el('button', {
      cls: ['kbw-htool', 'kbw-hblock-grip'],
      attr: { type: 'button', title: '拖动调整顺序', 'aria-label': '拖动这块调整顺序' },
    });
    grip.appendChild(icon('grip-vertical', 14));
    tools.appendChild(grip);
    const more = el('button', {
      cls: ['kbw-htool', 'kbw-hblock-more'],
      attr: { type: 'button', title: '这块的更多操作', 'aria-label': '这块的更多操作' },
    });
    more.appendChild(icon('more-horizontal', 14));
    more.addEventListener('click', (evt) => this.showBlockMenu(evt as MouseEvent, id));
    tools.appendChild(more);
    box.appendChild(tools);
    return tools;
  }

  /**
   * 每块的「⋯」菜单：**拖拽的非拖拽等价物**（照看板卡片「在这一块里」的纪律 ——
   * WCAG 2.2 Dragging Movements）。到边了**置灰写明原因**（"改不动就别留着"的反面：
   * 置灰 + title 说清为什么）。
   * **P7.7 收**：同一份菜单也是「组件上右键」的落点（用户真机：右键该能直接设置组件），
   * 并补一条「首页设置…」→ 设置面板的「首页」栏（区块显隐/顺序的键盘与触屏落点）。
   */
  private showBlockMenu(evt: MouseEvent, id: string): void {
    const r = resolveHomeBlocks(this.ctx.settings.get().homeBlocks);
    const visible = r.order.filter((x) => !r.hidden.has(x));
    const at = visible.indexOf(id);
    const block = BLOCK_BY_ID[id];
    showContextMenu(evt, {
      scope: { kind: 'global', label: block?.title ?? id, icon: 'home' },
      items: [
        /**
         * **「✦ 一键完全处理」置顶**（P7.13b · #6b / Q25 拍定：块菜单把它**升级为一级项**
         * ——不套子菜单；「一键自动整理 + 目录列表」随子菜单一起退役）。
         * 下面**默认四项照常保留**（2026-10-06 批注："板块的默认设置选项是要保留的"）。
         */
        ...(id === 'todo'
          ? [
              {
                kind: 'item' as const,
                label: '✦ 一键完全处理',
                run: () => void runFullProcess(this.ctx),
              },
            ]
          : []),
        /**
         * **「重载此板块」**（P7.11 · #8）：默认 = 该块**强制重画**；随机漫步覆写成
         * "顺带换新三篇"（Q5 拍板：= 点一次「换一批」；**不上菜单文案** —— 批注④口径）。
         */
        { kind: 'item', label: '重载此板块', icon: 'refresh-cw', run: () => this.reloadBlock(id, true) },
        { kind: 'separator' },
        {
          kind: 'item',
          label: '上移一位',
          icon: 'arrow-up',
          disabled: at <= 0 ? '已经是最上面一块' : undefined,
          run: () => this.moveBlock(id, -1),
        },
        {
          kind: 'item',
          label: '下移一位',
          icon: 'arrow-down',
          disabled: at < 0 || at >= visible.length - 1 ? '已经是最下面一块' : undefined,
          run: () => this.moveBlock(id, 1),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: '隐藏这块',
          icon: 'eye-off',
          run: () => this.hideBlock(id),
        },
        {
          kind: 'item',
          label: '首页设置…',
          icon: 'settings',
          run: () => this.ctx.openWorkbenchSettings('home'),
        },
      ],
    });
  }

  /**
   * **重载某一块**（P7.11 · #8）：默认 = 强制重画（Region force / 非 Region 的清掉重画）；
   * 块自己可以覆写（`HomeBlock.reload?` —— 随机漫步 = `seed = nextSeed(seed)`，
   * 重画自然换新三篇，与「换一批」同源）。
   */
  private reloadBlock(id: string, notifyUser: boolean): void {
    const m = this.mounted.get(id);
    if (!m) return;
    BLOCK_BY_ID[id]?.reload?.(this.ctx);
    m.force();
    if (notifyUser) {
      const title = BLOCK_BY_ID[id]?.title ?? id;
      notify({ kind: 'info', text: `已重载「${title}」`, ms: NOTIFY_MS.info });
    }
  }

  /** 上移/下移一位（可见序里换位；到边 → `swapNeighbor` 原样返回，点了什么都不会发生） */
  private moveBlock(id: string, dir: -1 | 1): void {
    const r = resolveHomeBlocks(this.ctx.settings.get().homeBlocks);
    const visible = r.order.filter((x) => !r.hidden.has(x));
    const nextOrder = swapNeighbor(r.order, id, dir, visible);
    if (nextOrder.join('|') === r.order.join('|')) return;
    this.applyOrder(nextOrder, [...r.hidden], true);
  }

  /**
   * 落盘 + 就地重排 DOM（**appendChild 移动节点，保活** —— 不重建、不丢状态）+
   * FLIP 让位动画（布局坐标，见 `blocks/index.ts` 的纪律注释）。
   */
  private applyOrder(order: string[], hidden: string[], animate: boolean): void {
    const payload: HomeBlocks = { order, hidden };
    this.blocksSig = sigOf(payload);
    void this.ctx.settings.save({ homeBlocks: payload });

    const boxes = [...this.host.querySelectorAll<HTMLElement>('.kbw-hblock')];
    const first = new Map(boxes.map((b) => [b.dataset.block ?? '', b.offsetTop]));
    for (const bid of order) {
      const m = this.mounted.get(bid);
      if (m) this.host.appendChild(m.box);
    }
    // 空态永远排最后（若有）
    if (this.emptyEl) this.host.appendChild(this.emptyEl);
    if (animate) this.flipBoxes(boxes, first);
  }

  private flipBoxes(boxes: HTMLElement[], first: Map<string, number>): void {
    const moved: HTMLElement[] = [];
    for (const b of boxes) {
      const f = first.get(b.dataset.block ?? '');
      if (f === undefined) continue;
      const dy = f - b.offsetTop;
      if (Math.round(dy) === 0) continue;
      b.style.transition = 'none';
      b.style.transform = `translateY(${dy}px)`;
      moved.push(b);
    }
    if (moved.length === 0) return;
    // 强制回流，让"瞬移回去"先落定，再放开 transition → 它才滑回来
    void this.host.offsetHeight;
    for (const b of moved) {
      b.style.transition = '';
      b.style.transform = '';
    }
  }

  private hideBlock(id: string): void {
    const r = resolveHomeBlocks(this.ctx.settings.get().homeBlocks);
    const hidden = [...r.hidden, id];
    const payload: HomeBlocks = { order: r.order, hidden };
    this.blocksSig = sigOf(payload);
    void this.ctx.settings.save({ homeBlocks: payload });
    const m = this.mounted.get(id);
    m?.region?.dispose();
    BLOCK_BY_ID[id]?.cleanup?.(m?.content);
    m?.box.remove();
    this.mounted.delete(id);
    this.syncEmpty();
    const title = BLOCK_BY_ID[id]?.title ?? id;
    notify({
      kind: 'info',
      text: `已隐藏「${title}」`,
      detail: '可在 设置 → 首页 里找回',
      ms: NOTIFY_MS.info,
    });
  }

  // ── 拖序（D2：桌面拖柄 / 触屏长按；落点/让位全在 `ui/dnd.ts` + FLIP 上）──
  private beginBlockDrag(down: PointerEvent, id: string): void {
    const m = this.mounted.get(id);
    if (!m) return;
    const box = m.box;
    const host = this.host;
    let gap: HTMLElement | null = null;
    let ghost: HTMLElement | null = null;
    let offX = 0;
    let offY = 0;

    /** 参与让位的"静态块"（不含被拖的与空位；**布局坐标**量出来的 y 也是视口系） */
    const staticBoxes = (): HTMLElement[] =>
      [...host.querySelectorAll<HTMLElement>('.kbw-hblock')].filter(
        (b) => b !== box && b !== gap && !b.hidden,
      );

    const cleanDom = (): void => {
      ghost?.remove();
      ghost = null;
      document.documentElement.classList.remove('kbw-home-dragging');
      this.dragCancel = null;
    };

    this.dragCancel = startPointerDrag(down, { id }, {
      onStart: () => {
        const r = box.getBoundingClientRect();
        offX = down.clientX - r.left;
        offY = down.clientY - r.top;
        gap = div({ cls: ['kbw-hblock', 'kbw-hgap'] });
        gap.style.height = `${Math.round(r.height)}px`;
        box.parentElement?.insertBefore(gap, box);
        box.style.display = 'none';
        ghost = box.cloneNode(true) as HTMLElement;
        ghost.classList.add('kbw-hfloat');
        ghost.style.width = `${Math.round(r.width)}px`;
        ghost.style.left = `${r.left}px`;
        ghost.style.top = `${r.top}px`;
        document.body.appendChild(ghost);
        document.documentElement.classList.add('kbw-home-dragging');
      },
      onOver: (_target, c) => {
        if (!ghost || !gap) return;
        ghost.style.left = `${Math.round(c.x - offX)}px`;
        ghost.style.top = `${Math.round(c.y - offY)}px`;
        this.moveGap(gap, staticBoxes(), c.y);
      },
      onDrop: () => {
        if (!gap) return;
        /**
         * 🔴 **先把 display 恢复、再做 DOM 落位 —— 顺序不能反**（P7.2b 真机取证）：
         * 移动 box 一步会把块里嵌的**真 iframe**（图谱卡）的浏览上下文整棵重建 →
         * 平台在 iframe load 里重建 canvas 并当场量尺寸 —— 此刻若还是 display:none，
         * 量到 0×0，新 canvas 从此定格空白（用户报的"拖图谱块后内容消失"；
         * 被别的块位移只吃 FLIP transform、不移动 DOM，所以不坏）。
         * 离线判据在 `tests/specs/p72a.ts`（钉"移动那一刻 display 已还原"）。
         */
        box.style.display = '';
        gap.replaceWith(box);
        cleanDom();
        // 写顺序：可见 DOM 序 + 隐藏块（按原相对次序）接后面
        const domOrder = [...host.querySelectorAll<HTMLElement>('.kbw-hblock')]
          .map((b) => b.dataset.block ?? '')
          .filter(Boolean);
        const r = resolveHomeBlocks(this.ctx.settings.get().homeBlocks);
        const hiddenIds = r.order.filter((x) => r.hidden.has(x));
        const payload: HomeBlocks = { order: [...domOrder, ...hiddenIds], hidden: [...r.hidden] };
        this.blocksSig = sigOf(payload);
        void this.ctx.settings.save({ homeBlocks: payload });
      },
      onCancel: () => {
        box.style.display = '';
        gap?.remove();
        gap = null;
        cleanDom();
      },
    });
  }

  /**
   * 空位挪到落点 + FLIP 让位。两端都量**布局盒**（`offsetTop/offsetHeight`，
   * 不含 transform）—— FLIP 的 200ms 过渡期间指针每 ~16ms 调一次，
   * 拿 `getBoundingClientRect()` 会读到过渡中途位置、落点来回跳（grid 的教训）。
   */
  private moveGap(gap: HTMLElement, staticBoxes: HTMLElement[], y: number): void {
    if (staticBoxes.length === 0) return;
    const base = this.host.getBoundingClientRect();
    const first = staticBoxes.map((b) => b.offsetTop);
    const rows = staticBoxes.map((b) => ({ top: base.top + b.offsetTop, height: b.offsetHeight }));
    const idx = insertionRowAt(rows, y);
    const before = staticBoxes[idx] ?? null;
    if (gap.nextSibling === before) return; // 位置没变，别白动
    gap.parentElement?.insertBefore(gap, before);

    const moved: HTMLElement[] = [];
    staticBoxes.forEach((b, i) => {
      const dy = first[i] - b.offsetTop;
      if (Math.round(dy) === 0) return;
      b.style.transition = 'none';
      b.style.transform = `translateY(${dy}px)`;
      moved.push(b);
    });
    if (moved.length === 0) return;
    void this.host.offsetHeight;
    for (const b of moved) {
      b.style.transition = '';
      b.style.transform = '';
    }
  }

  // ── 空白处菜单（B1，§8.1）───────────────────────────────────
  /**
   * 放什么：这一屏**真正做得了**的事（新建 / 整理收件箱的两条路 / 还原快照 /
   * 两个浮层 / 设置 / 快捷键）。不放进"看板专属"那些（显示属性、板块宽度…）——
   * 那些在这里点了也没有作用对象（§8.1 那张表是**看板**的全局菜单）。
   *
   * P7.11 · #5（批注定稿的顺序）：还原快照下面加「✦ 问 AI」；「重载（重扫全库索引）」
   * 从底部位到「首页设置…」上面；新增「首页设置…」（与块菜单**同一份措辞**）。
   * 菜单项**不带右侧提示小字**（批注④口径）。
   */
  private showMenu(evt: MouseEvent): void {
    showContextMenu(evt, {
      scope: { kind: 'global', label: '首页', icon: 'home' },
      items: [
        {
          kind: 'item',
          label: '新建笔记',
          icon: 'plus',
          run: () => openNewNoteDialog(this.ctx),
        },
        {
          /**
           * P7.13a · #4：与首页快捷按钮的「整理收件箱」**合成同一份实现**
           *（`openInboxChoices` —— 同一个菜单：作用域行可点选一级目录 + 三项动作）。
           * 原来这里是个固定在 00_Inbox 的静态子菜单。
           *
           * ⚠️ `stay: true` 是必需的：run 里 `openInboxChoices` 会 `showMenu`
           *（先 `closeAllMenus` 收掉本菜单、再把新菜单设为 `topInstance`）——
           * 不加它，`fire` 尾随的那一下 `closeAllMenus` 会把**刚开的新菜单**当场收掉。
           */
          kind: 'item',
          label: '整理收件箱',
          icon: 'list-checks',
          stay: true,
          run: (c) => {
            /**
             * 锚点 = 被点的那一行；键盘 Enter 走合成事件（没有 currentTarget）→
             * 退到当前焦点（键盘导航时焦点就在菜单根上）→ 再退 body。
             * **必须在 showMenu 之前取 rect**（新菜单一开，这条链就被收掉了）。
             */
            const t =
              (c.evt.currentTarget as HTMLElement | null) ??
              (document.activeElement as HTMLElement | null) ??
              document.body;
            openInboxChoices(this.ctx, t);
          },
        },
        {
          kind: 'item',
          label: '还原快照',
          icon: 'history',
          run: () => openSnapshotPanel(this.ctx),
        },
        {
          kind: 'item',
          label: '✦ 问 AI',
          run: () => this.ctx.openAi(),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: '快速切换',
          icon: 'search',
          run: () => this.ctx.quickSwitch(),
        },
        {
          kind: 'item',
          label: '快速捕获',
          icon: 'zap',
          run: () => this.ctx.quickCapture(),
        },
        { kind: 'separator' },
        {
          // 与顶栏那枚 ⟳ 同一件事（P7.11 · #8：抽成 ctx.reloadIndex() 一处实现两处入口）
          kind: 'item',
          label: '重载（重扫全库索引）',
          icon: 'refresh-cw',
          run: () => this.ctx.reloadIndex(),
        },
        {
          kind: 'item',
          label: '首页设置…',
          icon: 'settings',
          run: () => this.ctx.openWorkbenchSettings('home'),
        },
        {
          kind: 'item',
          label: '工作台设置',
          icon: 'settings',
          run: () => this.ctx.openWorkbenchSettings(),
        },
        {
          kind: 'item',
          label: '快捷键一览',
          icon: 'keyboard',
          run: () => this.ctx.openKeysHelp(),
        },
      ],
    });
  }

  private onKey(action: string): boolean {
    if (action === 'focus-search') {
      focusHeroSearch();
      return true;
    }
    return false;
  }
}
