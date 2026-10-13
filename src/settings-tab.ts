/**
 * settings-tab.ts —— Obsidian 原生设置页（**简版**）
 *
 * 交互规格 §7 的完整设置面板（七栏）在**工作台里的 ⚙**（`ui/settings-panel.ts`，P3 实做）。
 * 这一页按 §7 末尾那条要求保留**简版**：模块开关 +「打开工作台设置」按钮 ——
 * 保证从标准位置（Obsidian 设置）也找得到那些配置。
 * 另外两件只有这里能做：工作文件夹（含「整个库」模式切换，P7.14）、快捷键表入口。
 *
 * ⚠️ `TextComponent.onChange` 挂在 `input` 事件上 = 每按一个键回调一次
 * （platform-pitfalls #23）——回调里**绝不能整页重画**，否则焦点会丢、
 * 症状是"一次只能打进去一个字符"。这里只存值，不 display()。
 */
import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, FEATURES, type FeatureId, type SettingsStore } from './core/settings';
import type { ModuleGate } from './core/modules';
import { div, el } from './ui/primitives';

export interface SettingsTabDeps {
  app: App;
  plugin: Plugin;
  settings: SettingsStore;
  gate: ModuleGate;
  openWorkbench: () => Promise<void>;
  /** 打开工作台内置的七栏设置面板（P3） */
  openWorkbenchSettings: () => void;
  /** 值变了让工作台重画 */
  onChanged: () => void;
}

export class NativeSettingsTab extends PluginSettingTab {
  private deps: SettingsTabDeps;

  constructor(deps: SettingsTabDeps) {
    super(deps.app, deps.plugin);
    this.deps = deps;
  }

  display(): void {
    const root = this.containerEl;
    while (root.firstChild) root.removeChild(root.firstChild);

    const { settings } = this.deps;

    const header = el('h2', { text: '经纬 · 知识工作台' });
    header.style.marginTop = '0';
    root.appendChild(header);
    root.appendChild(
      div({
        cls: 'kbw-modal-sub',
        text: '完整的七栏设置面板（自动化 / 看板 / 首页 / 外观 / AI 助手 / 数据 / 帮助）在工作台里的 ⚙。这一页是简版：模块开关、库根、入口。',
      }),
    );

    // ── 打开工作台设置（§7 末尾那条：标准位置也找得到）───────────
    new Setting(root)
      .setName('工作台设置')
      .setDesc('自动化（新建补全 / 自动归位 / 存量补全）· 看板 · 首页 · 外观 · AI 助手 · 数据（快照与日志）· 帮助')
      .addButton((b) =>
        b
          .setButtonText('打开工作台设置')
          .setCta()
          .onClick(() => this.deps.openWorkbenchSettings()),
      );

    // ── 管理模式：指定文件夹 / 整个库（P7.14）──────────────────
    const kbRoot = settings.get().kbRoot;
    const whole = kbRoot === '';
    new Setting(root)
      .setName('管理模式')
      .setDesc(
        whole
          ? '当前：整个库 —— 直接管理库内所有笔记（点开头的目录不看）'
          : '当前：指定文件夹 —— 只管理工作文件夹里的笔记',
      )
      .addDropdown((d) =>
        d
          .addOption('folder', '指定文件夹')
          .addOption('whole', '整个库')
          .setValue(whole ? 'whole' : 'folder')
          .onChange((v) => {
            if (v === 'whole') {
              if (!whole) void settings.save({ kbRoot: '' }).then(() => this.deps.onChanged());
            } else if (settings.get().kbRoot === '') {
              // 切回"指定文件夹"：回到默认路径（没有"上次路径"这个记忆 —— 别加新键）
              void settings.save({ kbRoot: DEFAULT_SETTINGS.kbRoot }).then(() => this.deps.onChanged());
            }
          }),
      );

    // ── 工作文件夹（'' = 整个库时这一行只作状态说明；换回来走上面的「管理模式」）──
    const exists = !whole && this.deps.app.vault.getAbstractFileByPath(kbRoot) != null;
    new Setting(root)
      .setName('工作文件夹')
      .setDesc(
        whole
          ? '当前：整个库（库根 = 库顶层）—— 在上面「管理模式」里切回指定文件夹'
          : exists
            ? `当前：${kbRoot}（找得到）`
            : `当前：${kbRoot} —— ⚠️ 库里没有这个目录。工作台会显示降级提示，直到路径改对`,
      )
      .addText((t) =>
        t.setValue(whole ? '' : kbRoot).onChange((v) => {
          if (!v) return;
          void settings.save({ kbRoot: v.trim() }).then(() => {
            this.deps.onChanged();
          });
        }),
      );

    // ── 模块开关 ─────────────────────────────────────────────
    const modHead = el('h3', { text: '模块开关' });
    modHead.style.marginTop = 'var(--sp-6)';
    root.appendChild(modHead);
    root.appendChild(
      div({
        cls: 'kbw-modal-sub',
        text: '关掉之后命令面板里的对应命令会消失，残留入口也会被明确拒绝（「关掉就真的停手」）。',
      }),
    );

    for (const id of ['graph', 'automation', 'completion'] as FeatureId[]) {
      const meta = FEATURES[id];
      new Setting(root)
        /**
         * ⚠️ **名字后面不许再挂期号**（`（${meta.round}）` —— 独立审 2026-10-04 🔴）：
         * 那是开发用的落期信息，用户读到的就是一脸「P3 / P6」。
         */
        .setName(meta.label)
        .setDesc(meta.desc)
        .addToggle((t) =>
          t.setValue(this.deps.gate.isOn(id)).onChange(async (v) => {
            await this.deps.gate.set(id, v);
            this.deps.onChanged();
          }),
        );
    }

    // ── 入口 ─────────────────────────────────────────────────
    const foot = el('h3', { text: '入口' });
    foot.style.marginTop = 'var(--sp-6)';
    root.appendChild(foot);
    new Setting(root).setName('打开工作台').addButton((b) =>
      b.setButtonText('打开').onClick(() => void this.deps.openWorkbench()),
    );
    new Setting(root)
      .setName('快捷键')
      .setDesc('在工作台里按 ? 或点 ⌨ 打开快捷键表，可改键位。')
      .addButton((b) =>
        b.setButtonText('打开工作台').onClick(() => void this.deps.openWorkbench()),
      );

    if (settings.writeFailures > 0) {
      const warn = div({
        cls: 'kbw-msg is-warn',
        text: `设置写入回读校验失败了 ${settings.writeFailures} 次（data.json 可能被静默吞掉）。详见控制台。`,
      });
      root.appendChild(warn);
    }
  }
}
