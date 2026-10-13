/**
 * ui/editor-menu.ts —— **往平台自己的笔记右键菜单里加两个子菜单**（P6 段⑥ ⑥；**P7.12 · R8 改版**）
 *
 * `交互规格.md` §8.5 是这一片的边界。R8 改版（2026-10-06 拍定）：
 *  ① **两个子菜单**：**经纬 ›** 与 **经纬AI ›**，各 **最多 3 项**（条件项除外）——
 *     一级不铺开（加项是占用户原生菜单的地方，3 是上限不是目标）；
 *     · 经纬 › = 复制文件路径 / 重命名 / 返回经纬工作台；
 *     · 经纬AI › = 自动整理 / 自动命名 / 美化笔记（+ 有选区时的「问 AI（选中文本）›」）；
 *  ② **放到「插入」之下**：`setSection(EDITOR_SECTION)`（取证见那个常量）；
 *  ③ 只在**库根之下的 `.md`** 上出现（库根之外的 md、非 md、图谱/画布上都不出现）；
 *  ④ 「**问 AI（选中文本）**」：**只有编辑器里有选区时才画**（没有材料就没有可做的事）——
 *     四个预设（润色/扩写/起标题/压缩）是它下面的二级项（`WRITE_PRESETS`）；
 *  ⑤ 「**按规则归位这一篇**」退役、并入「自动整理」（R8 · 拍定 14：自动整理 = 单篇版
 *     AI 预整理，与首页 #9/#11 同一条链）。
 *
 * 🔴 **这一片是全项目唯一一处碰平台菜单的地方**（开工前的静态取证：`new Menu(` 0 处、
 * `editor-menu`/`file-menu` 监听 0 处）。所以规矩写在最前面：
 *  · 动作**必须走既有的出口** —— 动文件过 `services/mover.ts`、动库前确认过 `ui/confirm.ts`、
 *    AI 改正文走「预览对比 → 确认 → 快照」（`ui/beautify.ts`）；这里只负责
 *    "把用户的选择转成一个回调"，**一个字节都不写盘**（`EditorMenuDeps` 那些回调的
 *    实现在 `main.ts`，它们才碰服务）。
 *  · **不做 document 级右键接管**（那是抢平台的活）、**不碰 `file-menu`**（文件列表 / 标签页右键）。
 *
 * ⚠️ **类型定义里没有 `MenuItem.setSubmenu`**（`obsidian.d.ts` 里 `submenu` 三个字一次都没出现），
 * 但它**真实存在** —— 从 `obsidian.asar` 取证（2026-09-28）：
 *
 * ```
 * e.prototype.setSubmenu = function () {
 *   this.submenu || (this.dom.addClass("has-submenu"), this.submenu = new my,
 *     Ag(this.dom.createDiv("menu-item-icon mod-submenu"), "lucide-chevron-right"));
 *   return this.submenu
 * }
 * ```
 *
 * 而且**平台自己就在用**它（编辑器的「格式」菜单：`e.setTitle(…).setSubmenu().addItem(…)`）。
 * 所以这里按取证的结果 cast，不绕路去手搓 DOM —— 与 `WorkspaceLeaf` 构造函数那条同一个处置
 *（`@types` 与实际不符，别为了过编译把该有的能力丢掉）。
 */
/**
 * ⚠️ `Menu` / `TFile` **只以类型身份出现**（`import type`）—— 这不是洁癖：
 * 离线桩（`tests/stub`）里**没有 `Menu` 这个导出**，写成值 import 的话，
 * 打包进测试 bundle 时就是一个不存在的具名导出。类型 import 编译后整段消失，
 * 于是"离线能加载 main.ts"这件事不受影响。运行时要用的只有 `plugin.registerEvent`。
 */
import type { App, Menu, MenuItem, Plugin, TFile } from 'obsidian';
// P7.14：库内范围谓词（'' = 整个库）—— 别用前缀判断（空串下会恒 false，菜单整族消失）
import { inKbScope } from '../core/paths';

/** 工作台子菜单的名字 = 插件名（用户的菜单栏里只多这一行） */
const SUBMENU_TITLE = '经纬';
/** AI 子菜单（R8）：与 `ui/title-panel.ts` 的 ✦ 同族标识 */
const AI_SUBMENU_TITLE = '经纬AI';

/**
 * 「放到『插入』那条的下面」的实现 = **`setSection('insert')`** —— 段名不是猜的：
 * `obsidian.asar`（本机 1.14.4，2026-10-06 离线取证）编辑器右键菜单的段序表原文：
 *
 * ```
 * addSections(["title","correction","spellcheck","open","selection-link","selection",
 *   "selection.format","selection.paragraph","selection.paragraph.list",
 *   "selection.paragraph.heading","selection.paragraph.block",
 *   "selection.insert.basic","selection.insert.advanced","insert","clipboard",
 *   "info","info.copy","action","view","","danger"])
 * ```
 *
 * 裸 `insert` 这一格正夹在「插入」子菜单（`selection.insert.*`）之后、剪切区
 *（`clipboard`）之前；而且平台自己**没有别的东西**占这一格（全 asar 的 `setSection`
 * 调用清单里没有任何一条用裸 "insert"）—— 它就是这个位置的空槽。
 * ⚠️ **不认识的段名会被追加到表尾**（`""===s||n.contains(s)||n.push(s)`）——
 * 旧实现的 `'kbw'` 就是这么落到整个菜单最底下的（正好印证了段序表的存在）。
 * ⚠️ 收尾真机复核一次渲染顺序（离线取证 + 真机眼见为实，两样都要）。
 */
export const EDITOR_SECTION = 'insert';

/**
 * **写作辅助的四个预设**（P7.3c 顺手件；R8 起收在「经纬AI › 问 AI（选中文本）›」下）。
 *
 * 口径：预设 = **一句预填进输入框的话**（`seed`）+ 那段选区（作为 `@` 引用）。
 * 🔴 **不直接动库、也不改编辑器**：它只是"把面板打开、把话说一半"，
 * 发不发、怎么改，由用户在面板里决定（要 AI 改正文走「美化笔记」那条确认过的写路径）。
 */
export const WRITE_PRESETS: { id: string; label: string; seed: string }[] = [
  { id: 'polish', label: '润色这段', seed: '润色我引用的这段文字：更通顺、更准确，保持原意与原语气，直接给改好的版本。' },
  { id: 'expand', label: '扩写这段', seed: '把我引用的这段文字扩写成一段更充实的内容：补足细节与过渡，别编造事实。' },
  { id: 'title', label: '起个标题', seed: '根据我引用的这段文字，起 3 个标题候选（一句话说清每个的侧重）。' },
  { id: 'shorten', label: '压缩这段', seed: '把我引用的这段文字压缩到一半以内：留住关键信息，去掉重复与废话。' },
];

/**
 * `MenuItem` 上那个**没进类型定义**的方法。单独一个 type 而不是就地 `as any`：
 * 出处只有这里一处，理由（asar 取证）也附在上面 —— 以后再有人看到它会知道去查什么。
 */
type WithSubmenu = MenuItem & { setSubmenu?: () => Menu };

export interface EditorMenuDeps {
  app: App;
  /** 库根（相对路径换算的唯一出处） */
  kbRoot: () => string;
  /** 「返回经纬工作台」—— 打开工作台并把这一篇定位出来 */
  openInWorkbench: (file: TFile) => void;
  /** 「复制文件路径」—— 库内绝对路径 + 轻提示（与 `modules/notes/ops.ts` 的 `copyPaths` 同一口径） */
  copyPath: (file: TFile) => void;
  /** 「重命名」—— 问一句新名字 → `mover`（快照 / 撤销条 / 日志都在实现里，见 `main.ts`） */
  rename: (file: TFile) => void;
  /**
   * **「自动整理」**（R8：单篇版 AI 预整理）—— = 首页「一键自动整理」那条链收窄到这一篇
   *（`modules/home/tidy.ts` 的 `runInboxTidy({ only })`：补声明/归位 → 一次确认 →
   * mover → 补尾链）。原「按规则归位这一篇」并入这里（拍定 14）。
   */
  tidyOne: (file: TFile) => void;
  /** 「自动命名」—— 开 AI 起标题面板（P7.8 那个），**只服务这一篇、整篇为材料** */
  aiTitle: (file: TFile) => void;
  /** 「美化笔记」—— AI 出稿 → 预览对比 → 确认 → 整体替换（`ui/beautify.ts` 的确认过的新写路径） */
  beautify: (file: TFile) => void;
  /**
   * **「问 AI」（写作辅助）** —— **只打开面板 + 带上引用 + 预填一句**，
   * **一个字节都不动库**（与 5.3 的红线同一条：动库照旧过待确认卡 → confirm → mover）。
   *
   * 这一层只负责"把用户点的那个预设翻译成一次调用"；面板、引用、seed 的拼装
   * 全在 `main.ts`（那一层才知道 `ctx.openAi` 与路径口径）。
   */
  askAi: (req: { file: TFile; selection: string; presetId: string; seed: string }) => void;
}

/**
 * 这一篇该不该有我们的子菜单：**在库根之下（含库根本身）且没有 `.` 开头的路径段**。
 *
 * ⚠️ **P7.14 语义变更**：此前 `if (!root) return false` —— 于是**整个库模式（kbRoot=''）
 * 下编辑器右键的整套「经纬 › / 经纬AI ›」会集体消失**（空串不是"没配"，是"根 = vault 根"）。
 * 现在走 `inKbScope`：'' 根 = 全库（除点开头）；非空根行为与旧版一致（"`01_新知识库-备份/…`
 * 不算进来"那条口径也由它保住），只是多了"点开头的路径段不算"——`.foo/x.md` 本来就不该有菜单。
 */
export function underKbRoot(path: string, kbRoot: string): boolean {
  return inKbScope(path, kbRoot);
}

/** 这一篇该不该有我们这两个子菜单（两条入口共用的唯一判据） */
export function menuAppliesTo(file: TFile | null, kbRoot: string): boolean {
  if (!file) return false;
  if (file.extension !== 'md') return false;
  return underKbRoot(file.path, kbRoot);
}

/**
 * 造 **经纬 ›** 那份子菜单（**纯函数式**：不注册、不碰 app，离线可断言）。
 * 三项：复制文件路径 / 重命名 / 返回经纬工作台（恒有 —— 都是对"这一篇文件"的动作）。
 */
export function buildEditorSubmenu(sub: Menu, file: TFile, deps: EditorMenuDeps): void {
  sub.addItem((item) =>
    item
      .setTitle('复制文件路径')
      .setIcon('clipboard-copy')
      .onClick(() => deps.copyPath(file)),
  );
  sub.addItem((item) =>
    item
      .setTitle('重命名')
      .setIcon('text-cursor-input')
      .onClick(() => deps.rename(file)),
  );
  sub.addItem((item) =>
    item
      .setTitle('返回经纬工作台')
      .setIcon('layout-dashboard')
      .onClick(() => deps.openInWorkbench(file)),
  );
}

/**
 * 造 **经纬AI ›** 那份子菜单（同上，纯函数式）。
 *
 * 常态三项：**自动整理 / 自动命名 / 美化笔记**；**有选中文本**时多出
 * 「问 AI（选中文本）›」（四个预设是它的二级项 —— 顶层不摊开，§8.5：
 * "两个子菜单各 ≤3 项（条件项除外）"）。
 *
 * @param selection 编辑器里当前选中的文本（**空串 = 没有选区**）。
 */
export function buildAiSubmenu(
  sub: Menu,
  file: TFile,
  deps: EditorMenuDeps,
  selection = '',
): void {
  sub.addItem((item) =>
    item
      .setTitle('自动整理')
      .setIcon('wand-2')
      .onClick(() => deps.tidyOne(file)),
  );
  sub.addItem((item) =>
    item
      .setTitle('自动命名')
      .setIcon('sparkles')
      .onClick(() => deps.aiTitle(file)),
  );
  sub.addItem((item) =>
    item
      .setTitle('美化笔记')
      .setIcon('paintbrush')
      .onClick(() => deps.beautify(file)),
  );
  /**
   * 「问 AI（选中文本）」：**有材料才画**（与旧版同一条纪律：点了注定没反应的东西
   * 不该出现在菜单里）。四个预设走二级 —— 顶层只多这一行。
   */
  const sel = String(selection ?? '').trim();
  if (sel === '') return;
  sub.addItem((item) => {
    item.setTitle('问 AI（选中文本）').setIcon('message-circle-question-mark');
    const inner = (item as WithSubmenu).setSubmenu?.();
    if (!inner) return; // 兜底：至少不会把四项预设平铺进子菜单
    for (const p of WRITE_PRESETS) {
      inner.addItem((it) =>
        it
          .setTitle(p.label)
          .onClick(() => deps.askAi({ file, selection: sel, presetId: p.id, seed: p.seed })),
      );
    }
  });
}

/**
 * 注册 `editor-menu`。**返回值没用**（事件挂在 plugin 上，`onunload` 由平台收）——
 * 之所以还要 `plugin.registerEvent` 而不是裸 `workspace.on`：插件重载时裸监听会留在平台上。
 */
export function registerEditorMenu(plugin: Plugin, deps: EditorMenuDeps): void {
  plugin.registerEvent(
    deps.app.workspace.on('editor-menu', (menu, editor, info) => {
      const file = (info as { file?: TFile | null } | null)?.file ?? null;
      if (!menuAppliesTo(file, deps.kbRoot())) return;
      const real = file as TFile;
      /** 选区（写作辅助的"材料"）：拿不到就当没有 —— 那一项不画，不是报错 */
      let selection = '';
      try {
        selection = String((editor as { getSelection?: () => string } | null)?.getSelection?.() ?? '');
      } catch {
        selection = '';
      }
      /**
       * 一级只加**两项**（两个子菜单的入口）—— 平台自己的菜单里已经有几十项了，
       * 铺开一级项会把它挤到看不清（§8.5「收进子菜单」那条口径的由来）。
       * 两项都挂 `setSection(EDITOR_SECTION)`：渲染时落在「插入」之下（取证见常量）。
       *
       * ⚠️ **平台没有 `setSubmenu`（或它哪天改名了）时，那一项会是一个"没有动作的入口"** ——
       * 这是本文件**唯一一处做不到承诺**的地方，如实写在下面（独立审查 A🟢6/B🟢9 指出的：
       * 原先这里的注释写着"什么都不加"，**与事实相反**）：
       *
       * `menu.addItem()` 已经把那一项加进去了，而 `Menu` **没有"移除一项"的公开 API**
       *（`addItem` / `addSeparator` / `setParentElement` / `showAtMouseEvent` / `hide` …）。
       * 能做的只有"别再往下铺" —— 至少**不会**退化成"把动作直接铺进用户的一级菜单"，
       * 那才是 §8.5 真正要避免的占位。
       * ⇒ 真要收拾那一项，得去碰平台的 `items` 数组（不在公开 API 里）；为一条
       * "实测 1.13.7 起不会发生"的分支去碰它，**不值当**。所以这一支是**记账**，不是"已处理"。
       */
      menu.addItem((item) => {
        item
          .setTitle(SUBMENU_TITLE)
          .setIcon('layout-dashboard')
          .setSection(EDITOR_SECTION);
        const sub = (item as WithSubmenu).setSubmenu?.();
        if (!sub) return;
        buildEditorSubmenu(sub, real, deps);
      });
      menu.addItem((item) => {
        item.setTitle(AI_SUBMENU_TITLE).setIcon('sparkles').setSection(EDITOR_SECTION);
        const sub = (item as WithSubmenu).setSubmenu?.();
        if (!sub) return;
        buildAiSubmenu(sub, real, deps, selection);
      });
    }),
  );
}
