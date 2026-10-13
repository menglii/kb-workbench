/**
 * ui/native-position.ts —— **原生属性面板「文件位置」那一格，点开就是库里的文件夹**
 *（P7.16b · 用户 2026-10-08 晚点名两次的落点）
 *
 * 用户原话："要求在变更文件夹时，笔记 YAML 位置属性里的文件夹选项**一同变更**；
 * 选项里选择某一项，**自动将文件迁移**到对应文件夹下。" 走的是**平台的属性面板**
 * （不是我们的任何一屏）。
 *
 * 🔴 **这是全仓第一次靠平台类名钩原生面板**（用户知情后拍板的破例）。边界写在 §8.6：
 *  · **契约面（就是下面这几个类名 —— 平台内部结构，不是公开 API）**：
 *    `.metadata-property[data-property-key="文件位置"]` →
 *    `.multi-select-input`（那一格的可编辑输入）。
 *    （2026-10-08 晚用户真机活体 DOM 实测；平台自己弹出的建议是
 *    `.suggestion-container.mod-property-value`，**只列库里已出现过的取值、永远不列文件夹**，
 *    且**没有公开 API** 让插件往里加项 —— 所以做法 = 我们的菜单挂在那格上，
 *    **不碰**平台建议列表本体。）
 *  · **静默退化**：钩不上（类名变了 / 认不出这是哪一篇）→ **什么都不做**，
 *    绝不抛错、绝不破坏原生编辑（用户拍板接受这条风险的代价）。
 *  · **手打不受影响**：菜单开着也把焦点还给那一格 —— 敲键照样落进输入框；
 *    一敲（input 事件）就把我们的菜单收掉，把平台自己的建议让回去。
 *
 * 动作出口（三条硬规矩一条不破）：菜单过 `ui/menu.ts`；选中 → **同一条链**
 * `modules/notes/ops.ts` 的模块级函数 `runSetPositionByMove` / `runDeclarePositionHere`
 *（确认流 → `mover` → 撤销条；"就住这儿"写声明不搬）—— 与小窗、全部笔记右键
 * **用的就是同一份实现**，候选口径也一样（`positionItems`，现算目录）。
 * ⚠️ 这一层**不 import `NotesOps` 那个类**（它要 ctx + refresh 两样这儿都没有）——
 * 共享链抽成模块级函数就是为这个（P7.16b 开工提示词 §1）。
 */
import type { App, Plugin, TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { positionItems } from '../modules/notes/menus';
import { runDeclarePositionHere, runSetPositionByMove } from '../modules/notes/ops';
import { showMenu, type MenuHandle, type MenuSpec } from './menu';

/**
 * 菜单开着期间挂在 body 上的类 —— 作用域 CSS（`styles/menu.css`）拿它把**平台的**
 * 属性建议（`.suggestion-container.mod-property-value`）暂时藏起来，别让两个菜单打架。
 * ⚠️ 字符串在 TS 与 CSS 两处各写一遍 —— 改名字要两边一起改（红线里有静态断言钉着）。
 */
export const NATIVE_MENU_OPEN_CLASS = 'kbw-native-menu-open';

/** 那一格的可编辑输入（契约面之一） */
const CELL_INPUT_SEL = '.multi-select-input';
/** 那一格本身（契约面之一：靠 data-property-key 认「文件位置」） */
const CELL_KEY = '文件位置';

/**
 * 从事件目标往上认"这是不是「文件位置」那一格"——命中返回"弹菜单要用的元素"
 *（优先格里的可编辑输入 `.multi-select-input`；没有就退回**格子本身**），
 * 认不出（点的是别处）→ null，调用方静默走开。
 *
 * 🔴 **P7.18b2（用户 2026-10-09 晚真机反馈"点了没反应"）**：原版**只认**
 * `.multi-select-input` —— 而用户实测：**Obsidian 重启后**（全新会话、恢复的窗口里），
 * 「文件位置」那一格（空值形状）**点下去不长出我们的菜单**；但**新建/重开一次页面之后
 * 同一格就能弹**（"页面渲染时刻决定"——重启首段渲染的那一版格子里没有可编辑输入组件）。
 * ⇒ **放宽到整格**：点在格子的**任何地方**（含左侧行名"文件位置"四个字）都算命中；
 * 可编辑输入在就用它（"敲字照样落进去"的口径不变），不在也不拦——**先让菜单出来**。
 * ⚠️ 触发面放宽的同时**判定收严**：认的是 `data-property-key="文件位置"` 的整格（不是任意
 * `multi-select-input`）——原判据一字未动，只是"格子内没有输入"时不再静默退出。
 */
function cellInputOf(target: EventTarget | null): HTMLElement | null {
  try {
    if (!(target instanceof HTMLElement)) return null;
    const input = target.closest(CELL_INPUT_SEL);
    const cell = (input instanceof HTMLElement ? input : target).closest('.metadata-property');
    if (!(cell instanceof HTMLElement)) return null;
    if (cell.getAttribute('data-property-key') !== CELL_KEY) return null;
    if (input instanceof HTMLElement) return input;
    // 格子内**没有**可编辑输入（重启首段的懒渲染）→ 退回格子本身，也要弹
    return (cell.querySelector(CELL_INPUT_SEL) as HTMLElement | null) ?? cell;
  } catch {
    return null; // 平台 DOM 出什么幺蛾子都按"认不出"处理（静默退化）
  }
}

/**
 * 从那一格往上认"这是哪一篇"：**哪片叶的容器里装着它，就是哪片叶的笔记**。
 * 走公开 API `workspace.iterateAllLeaves`（比对 `view.containerEl`）；它不在
 * （平台老版 / 桩还没补）就退到 `getLeavesOfType('markdown')` —— 两条都拿不到 = 认不出，
 * 静默退化（调用方不弹菜单）。
 */
function fileForEl(app: App, el: HTMLElement): TFile | null {
  try {
    const ws = app.workspace as unknown as {
      iterateAllLeaves?: (cb: (leaf: unknown) => void) => void;
      getLeavesOfType?: (t: string) => unknown[];
    };
    let hit: TFile | null = null;
    const check = (leaf: unknown): void => {
      const view = (leaf as { view?: { containerEl?: HTMLElement; file?: unknown } } | null)?.view;
      const root = view?.containerEl;
      if (!root || !root.contains(el)) return;
      const f = view?.file as TFile | null | undefined;
      if (f && typeof f.path === 'string') hit = f;
    };
    if (typeof ws.iterateAllLeaves === 'function') ws.iterateAllLeaves(check);
    else if (typeof ws.getLeavesOfType === 'function') {
      for (const l of ws.getLeavesOfType('markdown')) check(l);
    }
    return hit;
  } catch (e) {
    console.error('[经纬] 认不出原生属性面板属于哪一篇（已静默退化）', e);
    return null;
  }
}

/**
 * 注册这个新面（`main.ts` 的 `onload` 调，插件级 —— 与模块开关无关：
 * 原生属性面板不归任何一屏管）。
 *
 * 触发 = **焦点/点击进入那一格的输入框**（`document` 级事件委托 —— 平台会在
 * 切笔记/改属性时重建那一格，绑在元素上必被重画甩掉）。
 */
export function registerNativePositionMenu(plugin: Plugin, ctx: WorkbenchContext): void {
  /** 眼下开着的那条（同一时刻最多一条 —— 与 `ui/menu.ts` 的"单链"同拍） */
  let open: { input: HTMLElement; handle: MenuHandle } | null = null;
  /** 正在执行动作的那一格（确认流期间"焦点回归不许重开菜单"的守卫 —— 见 `actOn`） */
  let actingOn: HTMLElement | null = null;

  /** 收掉我们这条（并摘掉遮蔽类）。Esc / 点外面 / 选完项由 menu.ts 自己收，那条走下面的 closed */
  const closeOurMenu = (): void => {
    if (!open) return;
    const cur = open;
    open = null;
    document.body.classList.remove(NATIVE_MENU_OPEN_CLASS);
    cur.handle.close();
  };

  /**
   * **"这一格正在执行动作"期间不自动重开菜单**（P7.16b 真机首跑抓到的一枚）：
   * 确认流的模态关掉时会把焦点**还给打开它之前的那一个**（`ui/panel.ts` 的
   * `previouslyFocused.focus()`）—— 那多半就是这一格的输入框 → `focusin` → 菜单**自己弹回来**
   * （用户看到的：点了「搬到」→ 菜单又冒出来、平台的建议又被藏了）。
   * 记下"哪一格在干活"，**动作彻底结束**（确认 + 搬 + 补声明）之前不放行；
   * 结束之后照旧（再点那一格还能开）。取消（Esc / 「取消」）也走这条 —— 取消完不自己弹回来。
   */
  const actOn = (input: HTMLElement, p: Promise<void>): void => {
    actingOn = input;
    void p
      .catch((e) => console.error('[经纬] 原生属性面板「文件位置」动作失败', e))
      .finally(() => {
        if (actingOn === input) actingOn = null;
      });
  };

  /**
   * 开菜单。**认不出 / 不在索引里 → 直接 return**（静默退化：不弹、不报、
   * 平台的建议照旧弹它的 —— 钩子失联时用户看到的还是"原生那片"）。
   */
  const openFor = (input: HTMLElement): void => {
    // 已经开着这一个了（含下面"把焦点还回去"触发的 focusin 回环）→ 不重开
    if (open?.input === input) return;
    // 这一格的动作还在飞（确认流期间）→ 不许被"焦点回归"顶开一扇（见 `actOn`）
    if (actingOn === input) return;
    try {
      const file = fileForEl(ctx.app, input);
      // `index.get` 本身就是闸：只认库根之下的 .md（库外 / 非笔记 → undefined）
      const entry = file ? ctx.index.get(file.path) : undefined;
      if (!entry) return;
      const spec: MenuSpec = {
        scope: { kind: 'note', label: entry.basename, icon: 'file-text' },
        /**
         * 候选与「当前所在地 / 就住这儿（写声明，不搬）」= **`positionItems` 同一份实现**
         *（与小窗选择器、全部笔记右键菜单同一个函数）—— 现算目录、每次点开重算，
         * 建/删/改名天然立刻反映。
         */
        items: positionItems(
          ctx,
          entry,
          // ⚠️ 走 `actOn`（不是裸 `void`）：动作在飞期间要挡住"焦点回归 → 重开菜单"（见 `actOn`）
          (dir) => actOn(input, runSetPositionByMove(ctx, [entry], dir)),
          () => actOn(input, runDeclarePositionHere(ctx, [entry])),
        ),
      };
      const r = input.getBoundingClientRect();
      const handle = showMenu({ x: r.left, y: r.bottom }, spec);
      open = { input, handle };
      document.body.classList.add(NATIVE_MENU_OPEN_CLASS);
      void handle.closed.then(() => {
        // Esc / 点外面 / 选完项（menu.ts 自己关的）—— 遮蔽类跟着摘
        if (open?.handle === handle) {
          open = null;
          document.body.classList.remove(NATIVE_MENU_OPEN_CLASS);
        }
      });
      /**
       * **焦点还给输入框**（"手打不受影响"的关键一拍）：菜单开着也让人能直接敲。
       * 敲进去由下面的 `input` 监听收菜（把平台自己的建议让回来）。
       * ⚠️ 必须在 `open` 记好之后调 —— `focus()` 是同步发 `focusin` 的，
       * 上面那句"已经开着这一个了"的守卫靠它挡住回环。
       */
      input.focus();
    } catch (e) {
      // 🔴 静默退化：绝不抛错、绝不把原生编辑弄坏 —— 顶多是我们这条菜单没出来
      console.error('[经纬] 原生属性面板「文件位置」菜单失败（已静默退化）', e);
      closeOurMenu();
    }
  };

  const onFocusIn = (evt: Event): void => {
    const input = cellInputOf(evt.target);
    if (input) openFor(input);
  };
  const onClick = (evt: Event): void => {
    const input = cellInputOf(evt.target);
    if (input) openFor(input);
  };
  /**
   * **手打不受影响**：菜单开着时往那一格里敲（`input` 事件）→ 收掉我们的菜单、
   * 摘掉遮蔽类 —— 用户要的是"直接敲值"，平台自己的建议接回去继续干活。
   */
  const onInput = (evt: Event): void => {
    const input = cellInputOf(evt.target);
    if (input && open?.input === input) closeOurMenu();
  };
  /**
   * 焦点离开那一格 → 收菜单（Tab 走掉 / 点进别的属性格）。
   * ⚠️ `relatedTarget == null` **不处理**：那是"鼠标点了不可聚焦的东西"的形状
   * （点哪儿都伴随 mousedown，由 `ui/menu.ts` 自己的"点外面关"兜底）——
   * 在这儿一并收会把"点我们菜单里的项"那一下也误伤（menu 项是 div，点它不转移焦点，
   * focusout 的 relatedTarget 正是 null → 菜单当场没了、项永远点不中）。
   */
  const onFocusOut = (evt: FocusEvent): void => {
    const input = cellInputOf(evt.target);
    if (!input || open?.input !== input) return;
    const to = evt.relatedTarget as Node | null;
    if (!to) return;
    if (open.handle.el.contains(to)) return; // 焦点进了我们的菜单（↓ 转发过去那条）
    closeOurMenu();
  };
  /**
   * **↓/↑ = 进菜单**（组合框手感：输入框还握着焦点，方向键把焦点交给菜单去走键盘导航）。
   * ⚠️ 捕获阶段 + 拦下：平台对那一格的 ↓ 有自己的处理（推着它自己那份建议列表走），
   * 不拦的话两边的选中会一起动、而且平台那份还被我们藏着 —— 用户看到的只有我们在动。
   */
  const onKeyDown = (evt: Event): void => {
    const kev = evt as KeyboardEvent;
    if (kev.key !== 'ArrowDown' && kev.key !== 'ArrowUp') return;
    const input = cellInputOf(evt.target);
    if (!input || open?.input !== input) return;
    kev.preventDefault();
    kev.stopPropagation();
    open.handle.el.focus();
  };

  /**
   * 全部走**捕获阶段**的 document 委托：平台对那一格的输入控件可能自己
   * `stopPropagation`（冒泡阶段就轮不到我们了），而捕获一定先过我们。
   * ⚠️ 用不了 `registerDomEvent`（它没有 options 口）—— 手动挂 + `plugin.register` 收。
   */
  const listeners: [string, EventListener][] = [
    ['focusin', onFocusIn],
    ['click', onClick],
    ['input', onInput],
    ['focusout', onFocusOut as EventListener],
    ['keydown', onKeyDown],
  ];
  for (const [type, fn] of listeners) {
    document.addEventListener(type, fn, true);
    plugin.register(() => document.removeEventListener(type, fn, true));
  }
}
