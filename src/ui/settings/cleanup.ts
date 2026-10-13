/**
 * ui/settings/cleanup.ts —— 设置 · **退出清理**块（「数据」栏 · `交互规格.md` §15 · P7.18）
 *
 * 入口（D3 拍板 · §1.1）：**设置 → 「数据」栏**，行名「**退出插件前的清理…**」——
 * 快照 + 日志的同族（"清理类动作本来就在这一栏"）。**命令面板固定 4 条，不加第 5 条**。
 *
 * 块里那句 note 是**三层出口**的一句话版（完整版在面板与教程中心那篇里）：
 *   ① 关模块开关 = 停手（插件不再动库，笔记与配置都留着）
 *   ② 删插件目录 = 完全退出（笔记里的键都是普通 YAML 属性，没有锁）
 *   ③ 本清理工具 = 清残留（删属性键 + 清工具区足迹）
 */
import { btn } from '../primitives';
import { openCleanupPanel } from '../cleanup-panel';
import { note, row, setTitle } from './kit';
import type { SettingsBlock } from './types';

export function makeCleanupSection(): SettingsBlock {
  return {
    label: '退出清理',
    sub: '不用了怎么清干净（删属性键 / 清工具区足迹）',
    render(host, api) {
      const ctx = api.ctx;
      host.appendChild(
        setTitle('退出清理', '把插件写进库里的东西清干净：笔记上的属性键 + 工具区留下的文件'),
      );
      host.appendChild(
        row(
          '退出插件前的清理…',
          btn({
            cls: 'kbw-btn is-small',
            text: '打开…',
            on: { click: () => openCleanupPanel(ctx) },
          }),
          '只读预览 → 逐项勾选（默认全不勾）→ 确认 → 快照 → 清理；可一键还原',
        ),
      );
      host.appendChild(
        note(
          '不想用插件了，三条路：' +
            '① 关掉模块开关 = 停手 —— 插件不再动库，笔记与配置都原样留着；' +
            '② 删掉插件目录 = 完全退出 —— 笔记里的键都是普通属性，没有插件照样能读写；' +
            '③ 用上面的清理工具 = 把残留清干净。',
        ),
      );
    },
  };
}
