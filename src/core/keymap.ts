/**
 * core/keymap.ts —— 快捷键层（全局层，交互规格 §1.4）
 *
 * 两条设计约定：
 *  ① **全部可配置**，默认值不与 Obsidian 本体冲突；改过的键位覆盖存在 `data.json`
 *  ② **键盘高亮只在键盘真的用过之后才出现** —— 全程用鼠标的话界面上不出现任何新样式
 *     （由视图在第一下 keydown 时给根元素加 `kbw-kbd` 实现）
 *
 * 另外这里还挂着 **Esc 的逐级退出栈**：菜单 → 面板 → 清空选择。
 * 它是全局单例（界面上同时只有一个栈），菜单/面板/确认流各自入栈，谁在最上面谁先收。
 */
import { hasMod } from './util';

export type KeyActionId =
  | 'focus-search'
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'toggle-select'
  | 'range-up'
  | 'range-down'
  | 'select-all'
  | 'open'
  | 'context-menu'
  | 'escape'
  | 'shortcuts-help'
  | 'quick-switch';

export interface KeyActionDef {
  id: KeyActionId;
  label: string;
  scope: string;
  defaults: string[];
  /**
   * **一句人话**（P7.2b，1.6a）：这个动作到底干什么。
   * 「?」表（`ui/keys-help.ts`）把它画在动作名下面 —— 表里原来只有动作名，
   * 每个都补上（Q4 前核过：全 14 个都空着）。
   */
  note?: string;
}

/**
 * 键位写法：普通字符就是字符本身（`/` `?`）；命名键小写（`arrowup` `escape` `f10` `space`）；
 * 修饰键前缀 `mod`（Mac 上是 Cmd，其余平台是 Ctrl）`shift` `alt`。
 */
export const KEY_ACTIONS: KeyActionDef[] = [
  {
    id: 'focus-search',
    label: '聚焦搜索框',
    scope: '工作台内',
    defaults: ['/'],
    note: '跳到首页搜索框，输入即搜',
  },
  {
    id: 'move-up',
    label: '上移高亮',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['arrowup'],
    note: '把高亮移到上一项',
  },
  {
    id: 'move-down',
    label: '下移高亮',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['arrowdown'],
    note: '把高亮移到下一项',
  },
  {
    id: 'move-left',
    label: '网格内左移 / 树内折叠',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['arrowleft'],
    note: '网格里左移一格；目录树里收起这一层',
  },
  {
    id: 'move-right',
    label: '网格内右移 / 树内展开',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['arrowright'],
    note: '网格里右移一格；目录树里展开这一层',
  },
  {
    id: 'toggle-select',
    label: '选中 / 取消选中',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['space'],
    note: '给当前项打勾；再按一次取消',
  },
  {
    id: 'range-up',
    label: '范围选（向上）',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['shift+arrowup'],
    note: '从高亮那项起，向上整段选中',
  },
  {
    id: 'range-down',
    label: '范围选（向下）',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['shift+arrowdown'],
    note: '从高亮那项起，向下整段选中',
  },
  {
    id: 'select-all',
    label: '全选当前筛选结果',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['mod+a'],
    note: '选中当前筛选结果里的全部（不是「就这一页」）',
  },
  {
    id: 'open',
    label: '打开当前项',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['enter'],
    note: '打开当前项 —— 笔记会在新标签页里开',
  },
  {
    id: 'context-menu',
    label: '弹当前项的右键菜单',
    scope: '表格 / 网格 / 卡片区',
    defaults: ['shift+f10', 'contextmenu'],
    note: '在当前项上弹出右键菜单（不用鼠标右键）',
  },
  {
    id: 'escape',
    label: '逐级退出：菜单 → 面板 → 清空选择',
    scope: '工作台内',
    defaults: ['escape'],
    note: '一层一层往回退：先关菜单、再关面板、最后清空选择',
  },
  {
    id: 'shortcuts-help',
    label: '快捷键表',
    scope: '工作台内',
    defaults: ['?'],
    note: '打开这张快捷键表',
  },
  /**
   * **快速切换**（e2 期 §4.1）。默认键的挑法（2026-09-26 在真机上枚举了本体**全部**默认键）：
   *  · 本体的 `Mod+O` 是快速切换器、`Mod+P` 是命令面板 → 我们取 `Mod+Shift+O`
   *    （与本体那个同源记忆："同一件事、更全的那一份"）
   *  · 不撞的**证据在真机上**（`scripts/probe.mjs` 有一条断言：14 个动作的默认键
   *    一个都不在本体的默认键表里）—— 别照记忆抄"本体键位表"
   */
  {
    id: 'quick-switch',
    label: '快速切换（跳笔记 / 板块 / 命令）',
    scope: '工作台内',
    defaults: ['mod+shift+o'],
    note: '一处跳转：笔记 / 板块 / 命令',
  },
];

export const KEY_ACTION_BY_ID: Record<string, KeyActionDef> = Object.fromEntries(
  KEY_ACTIONS.map((a) => [a.id, a]),
);

/**
 * 把键盘事件规范化成键位串。
 * 规则：
 *  · 单字符键用**字符本身**（`?` 就是 `?`，不是 `shift+/`）
 *  · 单字符是字母且按了 Shift → 带 `shift`（区分 `Ctrl+A` 与 `Ctrl+Shift+A`）
 *  · 命名键（Arrow… / Escape / F10 / Space）的修饰键全都带
 */
export function normalizeKey(ev: KeyboardEvent): string {
  const raw = ev.key;
  const isChar = raw.length === 1;
  const base = raw === ' ' ? 'space' : isChar ? raw.toLowerCase() : raw.toLowerCase();
  const mods: string[] = [];
  if (hasMod(ev)) mods.push('mod');
  if (ev.altKey) mods.push('alt');
  if (!isChar && ev.shiftKey) mods.push('shift');
  else if (isChar && ev.shiftKey && /^[a-z]$/i.test(raw)) mods.push('shift');
  return [...mods, base].join('+');
}

export function prettyKey(key: string): string {
  const parts = key.split('+');
  const out = parts.map((p) => {
    if (p === 'mod') return 'Ctrl/⌘';
    if (p === 'shift') return 'Shift';
    if (p === 'alt') return 'Alt';
    if (p === 'space') return 'Space';
    if (p === 'escape') return 'Esc';
    if (p.length === 1) return p.toUpperCase();
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  return out.join('+');
}

export type KeyHandler = (evt: KeyboardEvent) => boolean | void;

export class Keymap {
  private handlers = new Map<KeyActionId, KeyHandler>();
  private overrides: () => Record<string, string[]>;

  constructor(overrides: () => Record<string, string[]>) {
    this.overrides = overrides;
  }

  bind(id: KeyActionId, fn: KeyHandler): () => void {
    this.handlers.set(id, fn);
    return () => {
      if (this.handlers.get(id) === fn) this.handlers.delete(id);
    };
  }

  /**
   * 这个动作当前的键位。
   * ⚠️ 三种状态要分清：
   *   没设过        → 默认值
   *   `['mod+k']`  → 覆盖成这个
   *   `[]`（空数组）→ **显式解绑，一个键都不绑**（抢键时会把旧的动作解绑成这个）
   */
  keysFor(id: KeyActionId): string[] {
    const o = this.overrides()[id];
    if (Array.isArray(o)) return o;
    return KEY_ACTION_BY_ID[id]?.defaults ?? [];
  }

  /** 某个键位被哪个动作占用（键位表用来标冲突） */
  ownerOf(key: string, except?: KeyActionId): KeyActionId | null {
    for (const action of KEY_ACTIONS) {
      if (action.id === except) continue;
      if (this.keysFor(action.id).includes(key)) return action.id;
    }
    return null;
  }

  /** 处理一个键盘事件；返回 true 表示已被消费（调用方应 preventDefault） */
  handle(evt: KeyboardEvent): boolean {
    // Esc 走分层栈，不看当前焦点在哪
    const escKeys = this.keysFor('escape');
    if (escKeys.includes(normalizeKey(evt))) {
      if (dispatchEscape()) return true;
    }

    // 在输入框里打字时，别的快捷键一律不抢
    if (isEditable(evt.target)) return false;

    const key = normalizeKey(evt);
    for (const action of KEY_ACTIONS) {
      if (action.id === 'escape') continue;
      if (!this.keysFor(action.id).includes(key)) continue;
      const fn = this.handlers.get(action.id);
      if (!fn) continue;
      const handled = fn(evt) !== false;
      if (handled) return true;
    }
    return false;
  }
}

/** 焦点在输入类元素里吗（模块的 raw 键处理要用同一条判据，别各写一份） */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
}

// ────────────────────────────────────────────────────────────────
// 模块键盘路由
//
// 为什么需要它：`Keymap.bind` 对每个动作**只保留最后一个处理函数**（抢绑会互相顶掉），
// 而「全部笔记」「首页」都要接同一批键（方向键、Space、Enter、`/`…）。
// 所以视图只绑一次，再按"当前模块 + 焦点在哪"路由给模块自己的处理函数。
// ────────────────────────────────────────────────────────────────
export type ModuleKeyHandler = (action: KeyActionId, evt: KeyboardEvent) => boolean | void;

interface ModuleKeyReg {
  module: string;
  host: HTMLElement;
  handler: ModuleKeyHandler;
  /**
   * **不在 `KEY_ACTIONS` 里的键**（F2 原地改名 / mod+Enter 新标签打开）。
   * 它和上面的 handler 走同一套"当前模块 + 焦点在哪"的选人逻辑 ——
   * 别在模块里自己挂 keydown：真实焦点在工作台根元素上，事件**不会向下**传到模块宿主。
   */
  raw?: (evt: KeyboardEvent) => boolean | void;
}

export class ModuleKeys {
  private regs: ModuleKeyReg[] = [];

  /** 模块挂载时注册；返回注销函数（模块卸载时调） */
  register(
    module: string,
    host: HTMLElement,
    handler: ModuleKeyHandler,
    raw?: (evt: KeyboardEvent) => boolean | void,
  ): () => void {
    const reg: ModuleKeyReg = { module, host, handler, raw };
    this.regs.push(reg);
    return () => {
      const i = this.regs.indexOf(reg);
      if (i >= 0) this.regs.splice(i, 1);
    };
  }

  /** 分派：优先给"焦点在它里面"的那个；焦点不在任何模块里就取最后一个注册的 */
  dispatch(module: string, action: KeyActionId, evt: KeyboardEvent): boolean {
    const hit = this.pick(module);
    return hit ? hit.handler(action, evt) === true : false;
  }

  /** 分派"表里没有的键"（F2 / mod+Enter…）；同样按当前模块 + 焦点选人 */
  dispatchRaw(module: string, evt: KeyboardEvent): boolean {
    const hit = this.pick(module);
    return hit?.raw ? hit.raw(evt) === true : false;
  }

  private pick(module: string): ModuleKeyReg | undefined {
    const candidates = this.regs.filter((r) => r.module === module);
    if (candidates.length === 0) return undefined;
    const focused = document.activeElement as HTMLElement | null;
    return (
      (focused && candidates.find((r) => r.host.contains(focused))) ??
      candidates[candidates.length - 1]
    );
  }

  /** 探针/测试用 */
  size(): number {
    return this.regs.length;
  }
}

// ────────────────────────────────────────────────────────────────
// Esc 逐级退出栈（全局单例）
// ────────────────────────────────────────────────────────────────
interface EscapeLayer {
  close: () => boolean | void;
  /** 调试用 */
  label: string;
}

const escapeLayers: EscapeLayer[] = [];

/**
 * 入栈；返回出栈函数（关闭时务必调，否则栈会一直长）。
 *
 * ⚠️ **`bottom: true` 给"背景层"用**（2026-09-25 P4.5 修的）：
 * 像"清掉临时态（光标 / 回执）"这种层，语义上**永远该是最后一个被问到的**——
 * 它压得早晚取决于用户先点哪儿，压晚了就会盖在面板/菜单上面把 Esc 吃掉，
 * 症状是"面板里改一项设置，Esc 就关不掉面板了"（回执出来那一刻，
 * 看板那条层才第一次入栈 → 落在面板层上面）。基线里它是**碰巧**压得早（垫在下面）才没露出来。
 * 所以这种层**显式压到底**，别赌顺序。
 */
export function pushEscapeLayer(
  close: () => boolean | void,
  label = 'layer',
  opts: { bottom?: boolean } = {},
): () => void {
  const layer: EscapeLayer = { close, label };
  if (opts.bottom) escapeLayers.unshift(layer);
  else escapeLayers.push(layer);
  return () => {
    const i = escapeLayers.indexOf(layer);
    if (i >= 0) escapeLayers.splice(i, 1);
  };
}

/** 从最上层往下找一个"接得住"的层；返回是否有人处理 */
export function dispatchEscape(): boolean {
  while (escapeLayers.length > 0) {
    const top = escapeLayers[escapeLayers.length - 1];
    const handled = top.close() !== false;
    if (handled) return true;
    // 这层不想处理（比如已经空了）→ 出栈继续往下
    escapeLayers.pop();
  }
  return false;
}

export function escapeDepth(): number {
  return escapeLayers.length;
}

/** 栈里各层的标签（**调试用**：Esc"关不掉某个东西"时，先看是不是被上面一层截了） */
export function __escapeLabels(): string[] {
  return escapeLayers.map((l) => l.label);
}

export function __clearEscapeLayers(): void {
  escapeLayers.length = 0;
}

/**
 * 装一个 **document 级（捕获阶段）的 Esc 监听**。
 *
 * 为什么必须有它：菜单与模态挂在 `document.body` 上，不是工作台的子节点；
 * 焦点在它们里面时，按键根本走不到工作台的 keydown 处理器 ——
 * 于是"Esc 关窗"会整个失效。这里在捕获阶段先处理，谁在最上层谁先收，
 * 处理完就 `stopPropagation`，避免工作台再收到一次、一次退两层。
 *
 * 返回取消函数（插件 onunload 时调）。
 */
export function installGlobalEscape(keys: () => string[]): () => void {
  const handler = (evt: KeyboardEvent): void => {
    if (!keys().includes(normalizeKey(evt))) return;
    if (dispatchEscape()) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  };
  document.addEventListener('keydown', handler, true);
  return () => document.removeEventListener('keydown', handler, true);
}
