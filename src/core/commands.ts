/**
 * core/commands.ts —— 命令面板（交互规格 §1.2：**5 条**）
 *
 * 原则：命令只放"从任何地方都可能想用"的那几条；其余操作都在工作台里
 *（有界面、有上下文），不污染命令面板。
 *
 * ── 第 5 条是 e2 期加的（`快速捕获` §4.3）─────────────────────
 * B5 原先拍的是"设置不加第 5 条"（`排查报告.md` §七 B5，2026-09-24）——
 * **那条结论只针对"设置"**（工作台里的 ⚙ 与原生设置页两个入口已经够了）；
 * e2 期用户认可加第 5 条 `快速捕获`，理由是**平台里"全局热键"就是一条命令带默认热键**：
 * 不加就没有"不离开当前工作"那条路。B5 已在 2026-09-26 回改成同一口径。
 *
 * ⚠️ **命令条数 = 口径**：`commandCount()` 那条断言与 `交互规格.md` §1.2、
 * `排查报告.md` B5 三处永远一起改（**先红后改** —— 那条断言存在的意义就是拦住悄悄涨）。
 *
 * 模块开关关掉后命令**消失**：用公开的 `checkCallback`（返回 false 时
 * 命令面板不列出该命令），不碰 `app.commands` 那些内部 API。
 */
import type { Hotkey, Plugin } from 'obsidian';
import type { FeatureId } from './settings';
import type { ModuleGate } from './modules';

export interface CommandDeps {
  /** 打开工作台（已开着就聚焦，不新开第二个） */
  activate: () => Promise<void>;
  /** 新建笔记（P3 实做） */
  newNote: () => void;
  /** 重排库结构（P5 实做） */
  rebuild: () => void;
  /** 快照面板（P1 实做） */
  snapshotPanel: () => void;
  /** 快速捕获（e2 期 §4.3 实做）—— 往指定板块丢一条 */
  quickCapture: () => void;
}

export interface CommandDef {
  key: 'open' | 'new-note' | 'rebuild' | 'restore-snapshot' | 'quick-capture';
  /**
   * ⚠️ **不要**自己写 `kb-workbench:` 前缀 —— `Plugin.addCommand` 会自动加，
   * 写成 `kb-workbench:open` 的最终注册结果是 `kb-workbench:kb-workbench:open`，
   * 于是 `executeCommandById('kb-workbench:open')` 找不到它。
   * （真机探针抓到的 bug；离线桩原先没模拟这个前缀，所以是假绿）
   */
  id: string;
  name: string;
  icon: string;
  /** 关掉这个功能时命令从面板消失 */
  gate?: FeatureId;
  /**
   * **默认热键**（写进平台注册，用户能在「设置 → 快捷键」里改）。
   * ⚠️ 只在**只有一条命令需要它**时用：给每条命令都塞默认键会把用户的快捷键表撑满。
   * 键位挑选依据：**真机枚举过本体全部默认键**（2026-09-26，`Mod+Alt+N` 没被占；
   * 本体只有 `Mod+Alt+Enter` / `Mod+Alt+←→`）—— 别照记忆抄一张"本体键位表"。
   */
  hotkeys?: Hotkey[];
  run: (deps: CommandDeps) => void;
}

export const COMMANDS: CommandDef[] = [
  {
    key: 'open',
    id: 'open',
    name: '打开工作台',
    icon: 'layout-dashboard',
    run: (d) => void d.activate(),
  },
  {
    key: 'new-note',
    id: 'new-note',
    name: '新建笔记',
    icon: 'file-plus',
    gate: 'completion',
    run: (d) => d.newNote(),
  },
  {
    key: 'rebuild',
    id: 'rebuild',
    name: '重排库结构',
    icon: 'folder-tree',
    run: (d) => d.rebuild(),
  },
  {
    key: 'restore-snapshot',
    id: 'restore-snapshot',
    name: '还原到上一个快照',
    icon: 'history',
    run: (d) => d.snapshotPanel(),
  },
  {
    key: 'quick-capture',
    id: 'quick-capture',
    name: '快速捕获（丢一条到板块）',
    icon: 'zap',
    /**
     * 默认热键 `Ctrl/Cmd+Alt+N`（"N = 新建/捕获"）：
     *  · 真机枚举（2026-09-26）：本体没占 `Mod+Alt+N`（它只占 `Mod+Alt+Enter` 与 `Mod+Alt+←→`）
     *  · 也不撞用户真库里 Templater 自己占的 `Mod+Shift+N`
     *  · 与 §4.1 的 `Mod+Shift+O` 不冲突（那是工作台内的第 14 个动作）
     */
    hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'N' }],
    /**
     * ⚠️ **不挂 `gate`**：这不是"补全"那条链路的一部分 —— 它只是"建一篇空笔记"，
     * 补全关着时照样该能用（关了它，用户会以为"快速捕获坏了"）。
     */
    run: (d) => d.quickCapture(),
  },
];

export function registerCommands(plugin: Plugin, gate: ModuleGate, deps: CommandDeps): void {
  for (const def of COMMANDS) {
    plugin.addCommand({
      id: def.id,
      name: def.name,
      icon: def.icon,
      // 只有需要"全局可用"的那一条带默认键（见 `CommandDef.hotkeys` 的说明）
      ...(def.hotkeys ? { hotkeys: def.hotkeys } : {}),
      // checkCallback：返回 false 时（模块关着）命令不出现在面板里。
      // 这是公开 API，不用去动 app.commands 的内部实现。
      checkCallback: (checking: boolean) => {
        if (def.gate && !gate.isOn(def.gate)) return false;
        if (!checking) def.run(deps);
        return true;
      },
    });
  }
}

/** 命令条数——留个可断言的点，防止哪天悄悄再涨（涨了就要同步改 §1.2 与 B5） */
export function commandCount(): number {
  return COMMANDS.length;
}

/** 平台注册后的完整命令 id（`executeCommandById` 用这个） */
export function fullCommandId(key: CommandDef['key']): string {
  return `kb-workbench:${key}`;
}
