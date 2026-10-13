/**
 * modules/board/tasks.ts —— **卡片上的勾选框直写**（交互规格 §4.2）
 *
 * "勾一下就走，不该为这个开悬浮小窗"。写回走 `vault.process`（原子 + 走 vault 队列：
 * 真库的同步就在同一个进程里跑，裸写会跟它抢）+ `markSelfWrite`（不登记的话，
 * 我们自己写的那一下会被索引判成「外部改动」，首页多一条紫标）。
 *
 * 三条纪律：
 *  ① **按目标态写**，不是翻转（见 `summary.setTaskLine` 的说明）
 *  ② 写之前**先确认那一行现在还是任务行** —— 卡片是几秒前渲染的，中间可能被别处改过；
 *     不是任务行就**不动**，返回 false 让调用方报错（宁可不写，不能写错一行）
 *  ③ 写完**回读核对**：`vault.process` 的返回值就是新内容，核对目标行是不是真变了
 *     （`saveData` 那种静默失败在这个项目里出现过太多次）
 */
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { markSelfWrite } from '../../core/writes';
import { setTaskLine } from './summary';

export async function writeTaskToggle(
  ctx: WorkbenchContext,
  entry: NoteEntry,
  absLine: number,
  checked: boolean,
): Promise<boolean> {
  let wrote = false;
  try {
    markSelfWrite(entry.path);
    await ctx.app.vault.process(entry.file, (text) => {
      const next = setTaskLine(text, absLine, checked);
      wrote = next !== text;
      return next;
    });
  } catch (e) {
    console.error('[经纬] 写回勾选框失败', entry.path, e);
    return false;
  }
  if (!wrote) return false;
  // 回读：确认那一行真的是我们要的样子
  try {
    const back = await ctx.app.vault.cachedRead(entry.file);
    const line = back.split('\n')[absLine] ?? '';
    const m = line.match(/^\s*[-*+]\s+\[([ xX])\]/);
    if (!m) return false;
    return (m[1].toLowerCase() === 'x') === checked;
  } catch (e) {
    console.error('[经纬] 勾选框回读失败', entry.path, e);
    return false;
  }
}
