/**
 * ui/settings/types.ts —— 设置面板的栏契约（**七栏**：P6 第八段收的口 + P7.2a 的「首页」）
 *
 * 单独一个文件是**为了避免循环 import**：`settings-panel.ts` 要 import 各个栏，
 * 而每个栏又要用到这个契约（P0 的 `core/context.ts` 同一个理由）。
 *
 * 🔴 **八栏 → 六栏**（P6 第八段用户拍板：用户第 3、6 条"设置界面重新设计 / 视觉排版也要优化"）。
 * 收口的依据是**用途**，不是"少几个更好看"：
 *
 * | 现在 | 原来是 | 为什么收 |
 * |---|---|---|
 * | **自动化** | 自动化 + 目录映射 + 模板库 | 后两个都是**自动化的输入**（归到哪 / 套哪个模板）。分成三栏时，"改自动归位的规则"和"改它查的那张表"隔了两个栏 |
 * | **看板** | 看板默认值 | 没动（只是名字短了） |
 * | **外观** | 外观 | 没动 |
 * | **AI 助手** | AI 助手 | 没动 |
 * | **数据** | 快照 + 日志 | 一个是"改动前的存档"、一个是"改动后的流水"，**同一件事的两头**（§7.6 / §7.7） |
 * | **帮助** | （新）外观里的向导 | "带我走一遍 / 讲给我听"不是"改某个值"，混在任何一栏里都不对（§14.2） |
 *
 * ⚠️ 合并靠 `settings-panel.ts` 的 `compose()`（把子块的标题降级成小节标题），
 * **子块自己的渲染函数一行都没改** —— 那样才不会为了改布局去动五份业务代码。
 * ⚠️ 旧的 id（`templates` / `routes` / `snapshot` / `logs`）**不再是栏 id**；
 * 深链接用新 id（`automation` / `data` / `help`）。`openSettingsPanel(ctx, id)` 是唯一入口。
 *
 * ⚠️ **P7.2a（2026-10-03）再加一栏「首页」**（`home`，§1.2）：首页**内部**的区块显隐与顺序。
 * 不塞进「外观」的理由与「帮助」当年独立成栏同一条 —— "首页有什么"与"外观偏好"不是一回事；
 * 栏内第一句写明它与**模块开关**（原生设置页）的两层分界。
 */
import type { WorkbenchContext } from '../../core/context';

export type SettingsSectionId =
  | 'automation'
  | 'board'
  | 'home'
  | 'appearance'
  | 'ai'
  | 'data'
  | 'help';

export interface SectionApi {
  /** 依赖束（各栏都要用它拿服务；不放模块级变量里，免得"面板关了还指着旧 ctx"） */
  ctx: WorkbenchContext;
  /** 就地重画这一栏（值改了、列表变了） */
  rerender: () => void;
  /** 收起整个面板 */
  close: () => void;
  /**
   * 把一段 Markdown 渲染进 host（P7.2b：帮助栏的教程中心用）。
   *
   * ⚠️ 走的是**面板自己那个 `Component`**（`MarkdownRenderer.render` 第 5 参必须是它 ——
   * 传空/借别人的会让核心从插件栈帧报内存泄漏；看板 `cards.ts` 头注释记过这条）。
   * 各栏别自己 new Component：面板关闭时统一下线，这份才是被管的那个。
   */
  md: (host: HTMLElement, text: string) => Promise<void>;
}

/**
 * **子块**：能并进某一栏的一块内容（P6 第八段）。
 *
 * 与"栏"的区别只有两样：栏才有 `id`（深链接用）与 `icon`（左栏那一格用）。
 * 合并之后 `routes` / `templates` / `snapshot` / `logs` 这四块不再是栏，
 * 它们的 `label` 会在合并时**降级成小节标题**（`settings-panel.ts` 的 `compose()`）。
 */
export interface SettingsBlock {
  /** 块名（合并时当小节标题用） */
  label: string;
  /** 一句话说明（同上；独立成栏时它是左栏项的 `title`） */
  sub: string;
  render: (host: HTMLElement, api: SectionApi) => void | (() => void);
}

export interface SettingsSection extends SettingsBlock {
  id: SettingsSectionId;
  icon: string;
}

export type SectionCtx = WorkbenchContext;
