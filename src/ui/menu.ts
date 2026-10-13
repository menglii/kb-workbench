/**
 * ui/menu.ts —— 菜单的**唯一出口**（三条架构硬规矩之二）
 *
 * 三级菜单（空白处 / 板块·目录节点 / 卡片·表格行）共用同一份视觉、键盘行为、
 * 子菜单展开逻辑。旧实现里出现过"菜单提示与实现相反"的问题，对策是**文案与它调用的
 * 动作一一对应**，并把三条硬规矩做成**可断言的不变量**（`validateMenuSpec`）：
 *
 *   1. **作用域行常驻** —— 第一行永远写着"这次改的是谁"
 *   2. **一项决定一件事 + 长菜单要有台阶** —— 一级项数**不设死线**（软目标 ~8 项，
 *      见 `MENU_TOP_COMFORT`）：**超过软目标就必须有分组**（分隔线），
 *      或者把同类项收进子菜单 —— 判据是**一眼扫得完**，不是那个数字
 *      （用户 2026-10-02 拍板：看板板块菜单 9 项、批量迁移菜单随库结构变长，都算合理范围；
 *      另有真机几何判据"菜单不超出视口"，在探针里）
 *   3. **危险项永远最后、单独分组** —— 删除上方永远有分隔线
 *
 * `normalizeSpec()` 自动满足排版类要求（危险项挪末尾、补分隔线、收拾多余分隔符），
 * `validateMenuSpec()` 报告违反项——接线时违规会 console.warn，早发现早改。
 *
 * ⚠️ 菜单挂在 document.body 上（fixed 定位），**不给任何祖先加 container-type**，
 * 否则会成为它的包含块，打中"浮层从触发点展开"。
 */
import { div, el, icon, span } from './primitives';
import { measure, placeAt, pointFromEvent, type Point } from './panel';
import { pushEscapeLayer } from '../core/keymap';
import { Disposer, on } from '../core/util';

// ────────────────────────────────────────────────────────────────
// 契约（开发计划 §5.2）
// ────────────────────────────────────────────────────────────────
export type MenuControl =
  | { type: 'toggle'; checked: boolean }
  | { type: 'radio'; checked: boolean; group: string }
  | { type: 'multi'; checked: boolean }
  | { type: 'slider'; value: number; min: number; max: number; step: number; auto?: boolean }
  | { type: 'text'; value: string };

export interface MenuRunCtx {
  evt: Event;
  /** 控件形态会带上新值（拉杆数值 / 文本框内容 / 开关新值） */
  value?: string | number | boolean;
}

export interface MenuItem {
  /**
   * `'hint'`（P7.12 · R2）：**非交互的提示行** —— 给"一句话说清这扇菜单在干什么"用
   *（来源菜单顶部那句）。不进键盘导航（没有 data-index）、不接点击/悬停。
   */
  kind: 'item' | 'separator' | 'hint';
  label?: string;
  /** 15px 线性图标名（lucide） */
  icon?: string;
  /** 带 › 的子菜单（悬停飞出） */
  submenu?: MenuItem[];
  /** 错误色；永远排末位、上方必有分隔线 */
  danger?: boolean;
  /** 非空即置灰，**并把原因显示出来**（「无覆盖」） */
  disabled?: string;
  /**
   * **只展示**的右侧小字（P7.2c：「丢进板块」子菜单每项标「搬过去 / 加标签 / 改属性」）。
   *
   * 与 `disabled` 的区别：这个**不影响可点性**（那是原因，这是说明）。
   * 渲染位与 `disabled` 的原因同格（右侧、`--text-faint`）——两项同时给时只画 `disabled`
   * （灰着的东西，"为什么灰"比"会做什么"要紧）。
   * ⚠️ 带 `submenu` / `checked` 的行不画它（右侧那格给 › 和 ✓）。
   */
  hint?: string;
  /** 控件形态——菜单里有开关 / 单选 / 多选 / 拉杆，不只是"点一下" */
  control?: MenuControl;
  /**
   * 点击回调。
   * ⚠️ 契约把 evt 写成 MouseEvent；拉杆与文本框不是鼠标点击产生的，
   * 故放宽为 Event 并补了 `value`。其余调用方按 `evt` 用即可。
   */
  run?: (ctx: MenuRunCtx) => void;
  /** 点了**不关窗**（改设置回执要用） */
  stay?: boolean;
  /** 显示 ✓ */
  checked?: boolean;
}

export interface MenuScope {
  kind: 'global' | 'section' | 'note' | 'folder';
  /** 「全部板块」「内容创作（12 篇）」「未锈铠.md」 */
  label: string;
  icon?: string;
  /**
   * **可点作用域行**（P7.13a · #4 · Q13 拍定；**可选能力**）：给了它，作用域行就变成
   * 一行可点的入口 —— 点它展开这份子菜单（选中后由调用方用 `refresh` 就地更新）。
   * **只有传了才生效**：没传的菜单，作用域行与从前一字不差（硬规矩 1 不破坏）。
   *
   * ⚠️ 两条边界：
   *   · **只认点击、不认悬停**（与 items 的子菜单不同）—— 右键菜单常常就开在光标底下，
   *     悬停即弹会让子菜单在菜单刚出现时凭空飞出；调用点是"用户故意点那一下"。
   *   · 展开出的子菜单**不带**这个能力（`openScopeSubmenu` 会剥掉）——否则无限套娃。
   */
  submenu?: MenuItem[];
}

export interface MenuSpec {
  /** 作用域行常驻——第一行永远写着"这次改的是谁" */
  scope: MenuScope;
  items: MenuItem[];
  /**
   * **不抢焦点**（P7.21b；默认 false = 老行为：菜单拿到焦点，键盘方向键/Enter 导航）。
   * 给了 `true` 的菜单开出来时**不调 `root.focus()`** —— 给"调用方自己要留着焦点"的场合
   * （AI 面板输入框里的 `/` 命令菜单：焦点必须留在输入框，否则继续打字全被吞）。
   * ⚠️ 代价 = 这扇菜单**没有自己的键盘导航**（选点靠鼠标；Esc 照常——它走文档级层）。
   */
  keepFocus?: boolean;
}

export interface MenuHandle {
  el: HTMLElement;
  close(): void;
  /** 改设置不关窗：就地更新（配合 `stay` 的回执） */
  refresh(spec: MenuSpec): void;
  closed: Promise<void>;
}

/**
 * 一级菜单的**软目标**项数（硬规矩 2 的 2026-10-02 版）。
 *
 * 🔴 **不是硬线**（用户拍板放宽）：超过它**不直接判违规** —— 但要满足"清晰"那一条：
 * **必须有分组**（分隔线）。真正的红线是"一眼扫得完"，落地成两条判据：
 *   · 离线（这里）：长且**一坨平铺**（一条分隔线都没有）→ 违规；
 *   · 真机（探针）：菜单几何**不超出视口**（`bottom <= innerHeight` —— 超了就是被裁掉一截）。
 * 放宽的由头：看板板块菜单 9 项（`重置本板块设置` 那档加的）、批量迁移菜单
 * **每个顶层目录一项**（随库结构变长）—— 数字盯着 8 只会让探针每轮报假红。
 */
export const MENU_TOP_COMFORT = 8;

/**
 * **子菜单"移开自动收起"的延迟**（7.1 · P7.2c 拍板 ~300ms）。
 *
 * 口径（只动 hover 路径）：
 *   · 指针离开**整条菜单链**（父—子—孙…任一环）的区域 → 起算 300ms，到点把展开的
 *     子菜单收掉；**期间回到链内任何一处 → 撤销**（"安全三角"就是这条靠延迟兜住的
 *     —— 斜穿父子之间那道缝时 `pointerleave` 会先响，300ms 内进子菜单就不算离开）；
 *   · **移进另一父项立即切换**（不等）：那走的是既有的 row `mouseenter → openSubmenu`，
 *     切换时会 `cancelChainClose()`；
 *   · 🔴 **触屏 / 笔不走这条路**：`pointerleave` 在触屏上是"点完必然发生"的事件，
 *     照它收起会把用户刚用 click 开出来的子菜单当场收掉。判据是 `pointerType === 'mouse'`
 *     （触屏的打开路径是 click，与键盘一样**一个字没动**）。
 */
export const MENU_SUB_CLOSE_MS = 300;

// ────────────────────────────────────────────────────────────────
// 规范化与校验（三条硬规矩的唯一实现点）
// ────────────────────────────────────────────────────────────────
export function isSeparator(item: MenuItem | undefined): boolean {
  return !item || item.kind === 'separator';
}

/** 自动满足排版要求：去多余分隔符、危险项挪末尾、危险项上方必有分隔线 */
export function normalizeSpec(spec: MenuSpec): MenuSpec {
  const items = (spec.items ?? []).filter((i) => i && (isSeparator(i) || i.label || i.submenu || i.control));
  const danger = items.filter((i) => !isSeparator(i) && i.danger);

  // ⚠️ 显式分隔符要**留着**（人工分组线是作者意图）；只清"多余"的那些：
  // 开头的、连续的、末尾的。旧写法先把 separator 全滤掉再"清理"，
  // 那段清理是死代码 —— 于是任何手写分组线都不渲染（独立审查指出的）。
  const cleaned: MenuItem[] = [];
  for (const item of items) {
    if (item.danger) continue;
    if (isSeparator(item)) {
      if (cleaned.length === 0 || isSeparator(cleaned[cleaned.length - 1])) continue;
    }
    cleaned.push(item);
  }
  while (cleaned.length > 0 && isSeparator(cleaned[cleaned.length - 1])) cleaned.pop();

  if (danger.length > 0) {
    if (cleaned.length > 0) cleaned.push({ kind: 'separator' });
    cleaned.push(...danger);
  }
  // ⚠️ `keepFocus` 要**原样带过去**（P7.21b）：它决定"开菜单抢不抢焦点"，
  // 是调用方的意图，不归规范化管 —— 漏掉它 = 那个口子静默失效（且只在真机看得出来）。
  return { scope: spec.scope, items: cleaned, ...(spec.keepFocus === true ? { keepFocus: true } : {}) };
}

export interface MenuViolation {
  rule: 'scope' | 'clarity' | 'danger';
  message: string;
}

/** 检查（不修改）。接线自检与离线测试都用它 */
export function validateMenuSpec(spec: MenuSpec): MenuViolation[] {
  const out: MenuViolation[] = [];
  if (!spec.scope || !spec.scope.label) {
    out.push({ rule: 'scope', message: '缺作用域行：菜单第一行必须写清"这次改的是谁"' });
  }
  const top = spec.items.filter((i) => !isSeparator(i));
  /**
   * **长菜单要有台阶**（2026-10-02 放宽后的那一版，见 `MENU_TOP_COMFORT` 的注释）：
   * 超过软目标**不直接算违规**，但一条分隔线都没有（一坨平铺）就是"扫不动"。
   * ⚠️ 判据看的是**这张 spec 自己有没有分隔线**（不是"数量少就没事"）——
   * 两个方向都要能红：长且平铺 → 报；长但分了组 → 不报。
   */
  if (top.length > MENU_TOP_COMFORT && !spec.items.some((i) => isSeparator(i))) {
    out.push({
      rule: 'clarity',
      message: `一级 ${top.length} 项且没有分组 —— 长菜单要有视觉台阶（分隔线），或把同类项收进子菜单`,
    });
  }
  const dangerIdx = spec.items.findIndex((i) => !isSeparator(i) && i.danger);
  if (dangerIdx >= 0) {
    if (spec.items.slice(dangerIdx + 1).some((i) => !isSeparator(i) && !i.danger)) {
      out.push({ rule: 'danger', message: '危险项后面还有普通项 —— 危险项必须排末位' });
    }
    const hasRealBefore = spec.items.slice(0, dangerIdx).some((i) => !isSeparator(i));
    if (hasRealBefore && !isSeparator(spec.items[dangerIdx - 1])) {
      out.push({ rule: 'danger', message: '危险项上方缺分隔线' });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 实例（同一时刻只允许一条菜单链）
// ────────────────────────────────────────────────────────────────
interface Instance {
  root: HTMLElement;
  spec: MenuSpec;
  parent?: Instance;
  child?: Instance;
  activeIndex: number;
  anchor: Point;
  /** "移开自动收起"的倒计时（**只挂在链顶那一个上**，见 `scheduleChainClose`） */
  closeTimer: number | null;
  disposer: Disposer;
  popEscape: () => void;
  closeSelf(closeChildren?: boolean): void;
  paint(): void;
}

let topInstance: Instance | null = null;

export function closeAllMenus(): void {
  if (topInstance) topInstance.closeSelf(true);
  topInstance = null;
}

/** 右键菜单入口（带 preventDefault） */
export function showContextMenu(evt: MouseEvent, spec: MenuSpec): MenuHandle {
  evt.preventDefault();
  evt.stopPropagation();
  return showMenu({ x: evt.clientX, y: evt.clientY }, spec);
}

export function showMenu(at: Point | MouseEvent, spec: MenuSpec): MenuHandle {
  closeAllMenus();
  const inst = createInstance(spec, undefined, at);
  topInstance = inst;
  return {
    el: inst.root,
    close: () => {
      inst.closeSelf(true);
      if (topInstance === inst) topInstance = null;
    },
    refresh: (next: MenuSpec) => {
      /**
       * ⚠️ **飞出去的子菜单也要一起重建**：父子菜单各存一份 spec，
       * 只重画父的话，子菜单里那几个复选框还是旧的 checked（"菜单显示与文件相反"），
       * 而它的 `run` 闭包也还抱着旧的取值 —— 同一个菜单里连改两项时第二项会算错。
       * 做法：记住当前展开的是第几项 → 重画父 → 用新 spec 重新展开同一项。
       * （看板菜单的「改设置不关窗」正是踩在这上面；独立审查 R3）
       *
       * 🔴 **只重开"旧 spec 那个下标本来就是子菜单"的**（P7.1a 独立审查 R1 抓的）：
       * 悬停移开**不会**关子菜单（全文件没有 mouseleave），而"就近换内容"那类用法
       * （表头右键 →「打开列设置…」）新旧两份 spec 的**下标含义完全不同** ——
       * 不加这道条件时，鼠标移向目标项途中掠过的行留下的子菜单会让 `activeIndex`
       * 落在新 spec 的**别的分组**上 → 换完内容后那个分组**被自动展开**。
       * ⚠️ 离线/探针都派不出 `mouseenter`，这条只有真机鼠标路径会撞上 —— 用例要手动派。
       */
      const oldAt = inst.activeIndex >= 0 ? inst.spec.items[inst.activeIndex] : undefined;
      const reopen = inst.child && oldAt?.submenu ? inst.activeIndex : -1;
      // 就地换内容是有意的"重开"—— 把"移开收起"的倒计时撤掉，别让它中途把新子菜单收了
      cancelChainClose(topOf(inst));
      inst.spec = normalizeSpec(next);
      warnIfInvalid(inst.spec);
      if (inst.child) {
        inst.child.closeSelf(true);
        inst.child = undefined;
      }
      inst.paint();
      if (reopen >= 0) openSubmenu(inst, reopen);
    },
    closed: new Promise<void>((res) => inst.disposer.add(res)),
  };
}

/** 判断传进来的是坐标还是事件对象 */
function isPoint(v: Point | MouseEvent): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    'x' in v &&
    'y' in v &&
    !('clientX' in v)
  );
}

function warnIfInvalid(spec: MenuSpec): void {
  const violations = validateMenuSpec(spec);
  if (violations.length > 0) {
    console.warn('[经纬] 菜单违反硬规矩：', violations.map((v) => v.message).join('；'), spec);
  }
}

function createInstance(spec: MenuSpec, parent: Instance | undefined, at: Point | MouseEvent): Instance {
  const disposer = new Disposer();
  const normalized = normalizeSpec(spec);
  warnIfInvalid(normalized);

  const root = div({
    cls: ['kbw-menu', parent ? 'is-sub' : null],
    attr: { role: 'menu', tabindex: '-1' },
  });

  const inst: Instance = {
    root,
    spec: normalized,
    parent,
    activeIndex: -1,
    anchor: at instanceof Object && 'clientX' in at ? { x: at.clientX, y: at.clientY } : (at as Point),
    closeTimer: null,
    disposer,
    popEscape: () => {},
    closeSelf: () => {},
    paint: () => {},
  };

  inst.closeSelf = (closeChildren = true) => {
    if (inst.closeTimer != null) {
      window.clearTimeout(inst.closeTimer);
      inst.closeTimer = null;
    }
    if (closeChildren && inst.child) inst.child.closeSelf(true);
    inst.child = undefined;
    // 从父的指针上摘掉自己，否则父以后还会以为"我有子菜单"（Esc 会一次退不动）
    if (inst.parent && inst.parent.child === inst) inst.parent.child = undefined;
    inst.disposer.dispose();
    inst.popEscape();
    root.remove();
    if (topInstance === inst) topInstance = parent ?? null;
  };

  inst.paint = () => {
    while (root.firstChild) root.removeChild(root.firstChild);
    // 硬规矩 1：作用域行常驻
    const pickable = (inst.spec.scope.submenu?.length ?? 0) > 0;
    const scope = div({
      cls: [
        'kbw-menu-scope',
        inst.spec.scope.kind === 'note' ? 'is-note' : null,
        // 可点作用域行（P7.13a · #4）：hover 背景复用 kbw-hover-1（base.css，已包 @media (hover: hover)）
        pickable ? 'is-pick' : null,
        pickable ? 'kbw-hover-1' : null,
      ],
      text: `作用范围：${inst.spec.scope.label}`,
      attr: pickable ? { role: 'menuitem', 'aria-haspopup': 'true' } : undefined,
    });
    if (inst.spec.scope.icon) scope.insertBefore(icon(inst.spec.scope.icon, 12), scope.firstChild);
    if (pickable) {
      scope.appendChild(span({ cls: 'kbw-menu-arrow', text: '›' }));
      scope.addEventListener('click', () => openScopeSubmenu(inst));
    }
    root.appendChild(scope);

    inst.spec.items.forEach((item, index) => {
      if (isSeparator(item)) {
        root.appendChild(div({ cls: 'kbw-menu-sep' }));
        return;
      }
      /** 非交互的提示行（P7.12 · R2：来源菜单顶部「这些建议从哪来？勾谁算谁」） */
      if (item.kind === 'hint') {
        root.appendChild(div({ cls: 'kbw-menu-hintline', text: item.label ?? '' }));
        return;
      }
      root.appendChild(buildRow(inst, item, index));
    });
  };

  disposer.add(
    on(root, 'keydown', (evt) => {
      const kev = evt as KeyboardEvent;
      if (handleKey(inst, kev)) {
        kev.preventDefault();
        kev.stopPropagation();
      }
    }),
  );

  document.body.appendChild(root);

  const popEscape = pushEscapeLayer(() => {
    // Esc 逐级退出：先收子菜单，收到根就整条关掉
    if (inst.child) {
      inst.child.closeSelf(true);
      inst.child = undefined;
      root.focus();
      return true;
    }
    if (inst.parent) {
      inst.closeSelf(true);
      inst.parent.root.focus();
      return true;
    }
    inst.closeSelf(true);
    return true;
  }, `menu:${normalized.scope.label}`);
  inst.popEscape = popEscape;

  /**
   * **点菜单外面就关掉**（用户 2026-09-25 真机反馈：「右键菜单打开后，点击别处空白没法关」）。
   *
   * 为什么挂在**根**实例上、而不是每个实例都挂：整条菜单链同生共死 ——
   * 挂子实例上的话，点空白会先关子菜单、剩下的父菜单还在，得多点几下。
   *
   * 三个细节：
   *  ① 监听 `mousedown` + `pointerdown` 两种（触屏不一定合成 mousedown）；
   *     同一次点击两个都触发也没关系 —— 第一个已经把整条链关掉了，第二个进来时 `root` 已脱离文档。
   *  ② **不 `stopPropagation`/`preventDefault`**：吞掉这一下会让"点一下既关菜单又点到别处"
   *     变成"要点两下"，而看板/表格里的点击本身就是主路径。与 `panel.ts` 的 `openFloating`
   *     同一个口径（那边也是"点外面就关，不吞"）。
   *  ③ 判"外面"要**连子菜单一起算**：`root.contains` 只看父菜单，
   *     鼠标从左边的父菜单移到右边飞出去的子菜单时会被判成"外面"。
   */
  if (!parent) {
    const isInside = (t: Node | null): boolean => {
      if (!t) return false;
      if (root.contains(t)) return true;
      return !!inst.child && inst.child.root.contains(t);
    };
    const onOutside = (evt: Event): void => {
      const t = evt.target as Node | null;
      if (isInside(t)) return;
      if (topInstance) closeAllMenus();
    };
    disposer.add(on(document, 'mousedown', onOutside));
    disposer.add(on(document, 'pointerdown', onOutside));
  }

  /**
   * **移开自动收起**（7.1 · P7.2c）。两个监听挂在**每一环**上（父—子—孙都挂）：
   *   · `pointerenter`：回到链内任何一处 → 撤销倒计时（"三角内往返不算离开"）；
   *   · `pointerleave`：离开**整条链**才算离开（`relatedTarget` 在链内 = 链内移动，
   *     比如从父菜单斜穿那道缝进子菜单 —— 它会先响，但目标在链内就不起倒计时）。
   *
   * 🔴 **触屏 / 笔直接 return**：`pointerleave` 在触屏上是"点完必然发生"的事件
   *（触点没有 hover，抬起来就 leave）—— 照它收起，用户 click 开出来的子菜单
   * 会当场被收掉。鼠标才有"移开"这回事。
   * 🔴 **键盘路径不碰**：这里只看指针事件，方向键/Enter 那条链（`handleKey`）一个字没动。
   */
  disposer.add(on(root, 'pointerenter', () => cancelChainClose(topOf(inst))));
  disposer.add(
    on(root, 'pointerleave', (evt) => {
      const pe = evt as PointerEvent;
      const pt = (pe as { pointerType?: string }).pointerType;
      if (pt && pt !== 'mouse') return;
      const top = topOf(inst);
      if (chainHas(top, (pe.relatedTarget as Node | null) ?? null)) return;
      scheduleChainClose(top);
    }),
  );

  inst.paint();

  if (parent) {
    positionSubmenu(inst, parent);
  } else {
    // ⚠️ 这里必须区分"点了哪儿"和"事件对象"：
    // `pointFromEvent` 只认 clientX/clientY，喂它一个普通 `{x,y}` 会一路落到
    // "视口正中"的兜底分支 —— 于是所有菜单都开在屏幕中间（独立审查实测：
    // 右键 (321,111) 开在 (516,388)）。决策 30「从触发点展开」就只剩动画原点是对的。
    const point = isPoint(at) ? at : pointFromEvent(at as MouseEvent | undefined);
    placeAt(root, point);
    /**
     * 🔴 **`keepFocus` = 不抢焦点**（P7.21b；AI 面板的 `/` 命令菜单要它）：
     * 默认 `root.focus()` 是**键盘导航的载体**（root 上的 keydown 管方向键/Enter）——
     * 但对"输入框里打 `/` 弹出的菜单"，抢焦点会把后续打字全吞进菜单根（非可编辑元素，
     * `input` 事件永不发）→ 真机上"继续打字就地过滤"根本做不到（独立审 R1 实测：
     * `activeElement` 变成 `.kbw-menu`；离线与探针**两道闸门都盲**，因为它们都用
     * "程序性改值 + 派事件"打字）。
     * 开了它的菜单：焦点留在调用方那儿（打字照旧），**Esc 照常管用**（走的是
     * `pushEscapeLayer` 的文档级栈，与焦点无关）、**选点依旧靠鼠标**；代价 = 这扇菜单
     * 自己没有方向键导航（对"过滤式命令菜单"是合理取舍）。
     */
    if (!normalized.keepFocus) root.focus();
  }
  return inst;
}

function buildRow(inst: Instance, item: MenuItem, index: number): HTMLElement {
  const tall = item.control && (item.control.type === 'slider' || item.control.type === 'text');
  const row = div({
    cls: [
      'kbw-menu-item',
      'kbw-hover-1',
      item.danger ? 'is-danger' : null,
      item.disabled ? 'is-disabled' : null,
      tall ? 'is-tall' : null,
      item.checked ? 'is-checked' : null,
    ],
    attr: {
      role: 'menuitem',
      'aria-disabled': item.disabled ? 'true' : 'false',
      'aria-haspopup': item.submenu ? 'true' : undefined,
    },
    data: { index },
  });

  const ico = span({ cls: 'kbw-ico' });
  if (item.icon) ico.appendChild(icon(item.icon, 15, ''));
  row.appendChild(ico);
  row.appendChild(div({ cls: 'kbw-menu-label', text: item.label ?? '' }));

  // 硬规矩：不可用项**置灰而不是隐藏**，并把原因写出来
  if (item.disabled) row.appendChild(span({ cls: 'kbw-menu-hint', text: item.disabled }));
  else if (item.submenu) row.appendChild(span({ cls: 'kbw-menu-arrow', text: '›' }));
  else if (item.checked) row.appendChild(span({ cls: 'kbw-menu-arrow', text: '✓' }));
  // 只展示的说明小字（P7.2c；右侧那格空着才给）
  else if (item.hint) row.appendChild(span({ cls: 'kbw-menu-hint', text: item.hint }));

  if (item.control) row.appendChild(buildControl(inst, item, row));

  const interactive = !item.disabled;
  if (interactive) {
    row.addEventListener('click', (evt) => {
      if (item.control) {
        // 拉杆/文本框自己处理点击；开关/单选/多选点整行也生效
        if (item.control.type === 'slider' || item.control.type === 'text') return;
        // ⚠️ 点整行必须把**新值**交出去：toggle 取反、radio 恒 true、multi 取反。
        // 旧写法 `run({evt})` 不带值 → 调用方按新值写配置会写成 undefined
        // （契约里明写了"控件形态会带上新值"，独立审查指出交付不全）
        const c = item.control;
        const next = c.type === 'toggle' || c.type === 'multi' ? !c.checked : true;
        if (c.type === 'toggle' || c.type === 'multi') applyControlValue(row, item, next);
        fire(inst, item, evt, next);
        return;
      }
      if (item.submenu) {
        openSubmenu(inst, index);
        return;
      }
      item.run?.({ evt });
      if (!item.stay) closeAllMenus();
    });
    if (item.submenu) {
      row.addEventListener('mouseenter', () => openSubmenu(inst, index));
    }
  }
  row.addEventListener('mouseenter', () => setActive(inst, index));
  return row;
}

/**
 * 点整行时**把新值写回控件本身**（P7.1a 发现的老账，真机截图抓到）。
 *
 * 🔴 为什么必须有这一下：以前只把值 `fire(..., next)` 交出去，控件自己的 DOM
 * 与 `control.checked` 都停在旧值 —— 两个后果：
 *  ① **勾选框视觉不翻转**（列菜单里点一行，列藏了、框还空着，看着像"勾了没反应"）；
 *  ② `control.checked` 不更新 → 同一扇菜单里再点一次**又送出同一个值**
 *    （multi 只会开、toggle 只会收一半）—— 与「就地改的状态不能在渲染闭包里读」
 *     是同一个病（`坑/界面与样式.md` 那条的老形状）。
 * ⚠️ **必须直接写 DOM**，别指望 `fire` 的 `inst.paint()`：它只重画**当前这一层**，
 * 飞出去的子菜单（复选框正住在那里）不会跟着重画。
 */
function applyControlValue(row: HTMLElement, item: MenuItem, next: boolean): void {
  const c = item.control;
  if (!c || (c.type !== 'multi' && c.type !== 'toggle')) return;
  c.checked = next;
  const box = row.querySelector<HTMLInputElement>('input.kbw-check');
  if (box) box.checked = next;
  const sw = row.querySelector<HTMLElement>('.kbw-switch');
  if (sw) sw.classList.toggle('is-on', next);
}

function fire(inst: Instance, item: MenuItem, evt: Event, value?: string | number | boolean): void {
  item.run?.({ evt, value });
  if (!item.stay) closeAllMenus();
  else inst.paint();
  void value;
}

function buildControl(inst: Instance, item: MenuItem, row: HTMLElement): HTMLElement {
  const c = item.control!;
  const wrap = div({ cls: 'kbw-menu-control' });
  if (c.type === 'toggle') {
    const sw = div({ cls: ['kbw-switch', c.checked ? 'is-on' : null], attr: { role: 'switch' } });
    sw.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      // 与「点整行」那条路保持同一份当前值（两条路混用时不会各自记一份旧值）
      c.checked = next;
      item.run?.({ evt, value: next });
    });
    wrap.appendChild(sw);
  } else if (c.type === 'radio') {
    wrap.appendChild(span({ cls: 'kbw-menu-arrow', text: c.checked ? '●' : '○' }));
  } else if (c.type === 'multi') {
    const box = el('input', { cls: 'kbw-check', attr: { type: 'checkbox', checked: c.checked || undefined } });
    box.addEventListener('click', (evt) => evt.stopPropagation());
    box.addEventListener('change', (evt) => {
      // 与「点整行」那条路保持同一份当前值 —— 少了这句，两条路混用时点整行会按旧值取反、
      // 把刚点框那一下**吞掉**（独立审查 R2；与 toggle 那条同款，别只补一半）
      c.checked = box.checked;
      item.run?.({ evt, value: box.checked });
    });
    wrap.appendChild(box);
  } else if (c.type === 'slider') {
    const input = el('input', {
      cls: 'kbw-range',
      attr: {
        type: 'range',
        min: String(c.min),
        max: String(c.max),
        step: String(c.step),
        value: String(c.value),
      },
    });
    const label = span({ cls: 'kbw-slider-val', text: c.auto ? '自动' : String(c.value) });
    input.addEventListener('input', (evt) => {
      label.textContent = String(input.value);
      item.run?.({ evt, value: Number(input.value) });
    });
    input.addEventListener('click', (evt) => evt.stopPropagation());
    wrap.appendChild(input);
    wrap.appendChild(label);
  } else if (c.type === 'text') {
    const input = el('input', { cls: 'kbw-input', attr: { type: 'text', value: c.value } });
    input.addEventListener('click', (evt) => evt.stopPropagation());
    input.addEventListener('change', (evt) => fire(inst, item, evt, input.value));
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        fire(inst, item, evt, input.value);
      }
    });
    wrap.appendChild(input);
  }
  void row;
  return wrap;
}

function positionSubmenu(inst: Instance, parent: Instance): void {
  const parentRow = parent.root.querySelector<HTMLElement>(`[data-index="${parent.activeIndex}"]`);
  const anchor = parentRow ?? parent.root;
  const r = anchor.getBoundingClientRect();
  const { w, h } = measure(inst.root);
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const width = w || 220;
  const height = h || 200;
  const flipX = r.right + width > vw - 4;
  const x = flipX ? Math.max(4, r.left - width - 2) : r.right + 2;
  const y = Math.min(Math.max(4, r.top - 6), Math.max(4, vh - height - 4));
  inst.root.style.left = `${Math.round(x)}px`;
  inst.root.style.top = `${Math.round(y)}px`;
  inst.root.style.setProperty('--kbw-origin', flipX ? '100% 0' : '0 0');
}

/** 这条链的**链顶**（父—子—孙一路向上）——"移开收起"的倒计时只挂在它身上 */
function topOf(inst: Instance): Instance {
  let i = inst;
  while (i.parent) i = i.parent;
  return i;
}

/** `node` 是不是落在这一条菜单链（父—子—孙…）的任何一环里 */
function chainHas(top: Instance, node: Node | null): boolean {
  if (!node) return false;
  for (let i: Instance | undefined = top; i; i = i.child) {
    if (i.root.contains(node)) return true;
  }
  return false;
}

function cancelChainClose(top: Instance): void {
  if (top.closeTimer != null) {
    window.clearTimeout(top.closeTimer);
    top.closeTimer = null;
  }
}

/**
 * 指针离开整条链 → 起 300ms 倒计时，到点**把展开的子菜单收掉**
 *（关整个菜单链的活儿仍归"点外面 / Esc / 点非 stay 项"—— 与从前一致）。
 * 到点那一刻**现读** `top.child`：期间 refresh 换过内容/关过子菜单也不怕。
 */
function scheduleChainClose(top: Instance): void {
  if (!top.child) return;
  cancelChainClose(top);
  top.closeTimer = window.setTimeout(() => {
    top.closeTimer = null;
    if (top.child) {
      top.child.closeSelf(true);
      top.child = undefined;
    }
  }, MENU_SUB_CLOSE_MS);
}

function openSubmenu(inst: Instance, index: number): void {
  const item = inst.spec.items[index];
  if (!item?.submenu) return;
  /**
   * ⚠️ **撤销倒计时要放在"已经是这一个"的早退之前**（独立审 2026-10-04 🟡2）：
   * `openSubmenu` 也是**键盘路径**（`ArrowRight` / `Enter` 都调它）——
   * 鼠标把子菜单开着、指针离开起了 300ms 倒计时，此时用方向键"回到同一个父项"
   * 会走早退分支：不撤销的话，到点把用户正用键盘操作着的子菜单收掉。
   */
  cancelChainClose(topOf(inst));
  if (inst.child && inst.activeIndex === index) return; // 已经是这一个了
  if (inst.child) {
    inst.child.closeSelf(true);
    inst.child = undefined;
  }
  inst.activeIndex = index;
  const sub = createInstance({ scope: strippedScope(inst), items: item.submenu }, inst, { x: 0, y: 0 });
  inst.child = sub;
}

/** 作用域行子菜单在下标上的"身份"：它不在 `items` 里 → `activeIndex` 记它时用 -1 */
const SCOPE_INDEX = -1;

/**
 * **作用域行那份子菜单**（P7.13a · #4 · Q13）：与 `openSubmenu` 同一套"同一时刻只开一条链"
 * 的簿记，差别只在下标（作用域行不在 `items` 里，`activeIndex` 记 -1 —— 负数同时也是
 * `refresh()` 的"不重开"档：选完新范围不该再把选择器弹回来）。
 * 只由作用域行的 click 触发（**不挂悬停**：右键菜单常常就开在光标底下，见 `MenuScope.submenu`）。
 */
function openScopeSubmenu(inst: Instance): void {
  const items = inst.spec.scope.submenu;
  if (!items || items.length === 0) return;
  cancelChainClose(topOf(inst));
  if (inst.child && inst.activeIndex === SCOPE_INDEX) return; // 已经开着这一个了
  if (inst.child) {
    inst.child.closeSelf(true);
    inst.child = undefined;
  }
  inst.activeIndex = SCOPE_INDEX;
  const sub = createInstance({ scope: strippedScope(inst), items }, inst, { x: 0, y: 0 });
  inst.child = sub;
}

/**
 * 子菜单的作用域行**剥掉可点能力**（P7.13a · #4）：不剥的话，子菜单自己的作用域行
 * 又是个入口，点下去开同一份目录列表 —— 无限套娃（同一份 spec 递归展开）。
 */
function strippedScope(inst: Instance): MenuScope {
  const s = { ...inst.spec.scope };
  delete s.submenu;
  return s;
}

function setActive(inst: Instance, index: number): void {
  inst.activeIndex = index;
  const rows = Array.from(inst.root.querySelectorAll<HTMLElement>('.kbw-menu-item'));
  for (const row of rows) row.classList.toggle('is-active', Number(row.dataset.index) === index);
}

function handleKey(inst: Instance, evt: KeyboardEvent): boolean {
  const rows = Array.from(inst.root.querySelectorAll<HTMLElement>('.kbw-menu-item'));
  const enabled = rows.filter((r) => r.getAttribute('aria-disabled') !== 'true');
  const idx = enabled.findIndex((r) => Number(r.dataset.index) === inst.activeIndex);

  if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
    if (enabled.length === 0) return true;
    const dir = evt.key === 'ArrowDown' ? 1 : -1;
    const next =
      idx < 0 ? (dir > 0 ? 0 : enabled.length - 1) : (idx + dir + enabled.length) % enabled.length;
    setActive(inst, Number(enabled[next].dataset.index));
    return true;
  }
  if (evt.key === 'ArrowRight') {
    const item = inst.spec.items[inst.activeIndex];
    if (item?.submenu) {
      openSubmenu(inst, inst.activeIndex);
      inst.child?.root.focus();
      return true;
    }
    return false;
  }
  if (evt.key === 'ArrowLeft') {
    if (inst.parent) {
      const parent = inst.parent;
      parent.child = undefined;
      inst.closeSelf(true);
      parent.root.focus();
      return true;
    }
    return false;
  }
  if (evt.key === 'Enter' || evt.key === ' ') {
    if (inst.activeIndex < 0) return true;
    const item = inst.spec.items[inst.activeIndex];
    if (!item || item.disabled) return true;
    if (item.submenu) {
      openSubmenu(inst, inst.activeIndex);
      inst.child?.root.focus();
      return true;
    }
    if (item.control && (item.control.type === 'slider' || item.control.type === 'text')) return true;
    const fake = new MouseEvent('click', { bubbles: false });
    fire(inst, item, fake);
    return true;
  }
  return false;
}
