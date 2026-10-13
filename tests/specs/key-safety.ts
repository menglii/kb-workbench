/**
 * spec：**C7 · key 与"这个库在同步"撞车**（P8 收尾）
 *
 * 决策门 G0/C7 的原文是「核查：真库 `data.json` 是否随云盘同步（key 安全）」——
 * 那张表上**唯一一条非开发类的未决项**。核查的另一半（用户在真机上看什么）写在
 * `坑/平台.md`，这一份管**代码那一半**：探到痕迹就说出来。
 *
 * 三层判据（照本仓的老教训：纯函数有判据 ≠ 接线有判据，P6② 那笔账）：
 *   ① 纯函数 `shouldWarnKeySync` —— 两个条件缺一不可；
 *   ② 探测 `findSyncMarkers` —— 干净库一条不报 / 有痕迹就认得出；
 *   ③ **接线** —— 真的带 key + 库里有痕迹时，加载之后**会**出现那条通知；
 *      反向：没配 key 时**不许**出现（否则每台机器都弹，等于没有）。
 *
 * ⚠️ 探测是"按已知痕迹"的（`SYNC_MARKERS`）：探不到 ≠ 一定安全 ——
 * 所以文案判据专门钉住"**看起来**在同步"，别让它漂成"你的 key 泄露了"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Suite, contains, eq, notContains, ok } from '../framework';
import * as H from '../helpers';
import { findSyncMarkers, keySyncNotice, shouldWarnKeySync } from '../../src/core/key-safety';

/** 通知栏里那些话（同一个助手，三条判据都用它） */
function noticeText(): string {
  return H.textsOf(document.body, '.kbw-notice').join(' || ');
}

export async function specKeySafety(
  suite: Suite,
  app: unknown,
  plugin: unknown,
  vaultRoot: string,
): Promise<void> {
  void app;
  void plugin;
  void vaultRoot;

  await suite.group('C7 · key 与「这个库在同步」（纯函数 · 探测 · 接线）', async () => {
    await suite.it('纯函数：配了 key × 有同步痕迹 才提示（缺一个都不提）', () => {
      ok(shouldWarnKeySync({ apiKey: 'sk-x', markers: ['.git'] }), '两个都有 → 该提');
      ok(!shouldWarnKeySync({ apiKey: '', markers: ['.git'] }), '没配 key → 不提（同步什么都没关系）');
      ok(!shouldWarnKeySync({ apiKey: 'sk-x', markers: [] }), '库是干净的 → 不提');
      ok(!shouldWarnKeySync({ apiKey: '   ', markers: ['.git'] }), '全是空白的 key 等于没配');
      ok(!shouldWarnKeySync({ apiKey: '', markers: [] }), '两个都没有 → 当然不提');
    });

    await suite.it('文案：说"**看起来**在同步"、把探到的痕迹点出来，且不许谎报"泄露"', () => {
      const n = keySyncNotice(['.stfolder', '.obsidian/plugins/nutstore-sync']);
      contains(n.text, '看起来在同步', '措辞是"看起来"—— 痕迹只是痕迹');
      contains(n.detail, '.stfolder', '要把探到的那几条点出来（用户才知道该去关哪个）');
      contains(n.detail, 'nutstore-sync', '同上');
      notContains(n.text + n.detail, '泄露', '不许写成"你的 key 泄露了"（探测是按已知痕迹做的，探不到≠安全）');
    });

    await suite.it('探测：有痕迹就认得出，干净库一条不报（走 adapter，手机端同款）', async () => {
      /**
       * ⚠️ **别在 A 库上造痕迹** —— A 是"只读库"，后面一串 spec 都拿它当基线。
       * 自己起一个小库（`makeTempVault` 每次先 `rmSync` 清干净，同名不串）。
       */
      const v = H.makeTempVault('keysafety');
      const b = await H.bootPlugin(v);
      H.resetDom();
      try {
        eq((await findSyncMarkers(b.app as never)).length, 0, '干净库：一条同步痕迹都不该报');
        fs.mkdirSync(path.join(v, '.stfolder'), { recursive: true });
        fs.mkdirSync(path.join(v, '.obsidian', 'plugins', 'nutstore-sync'), { recursive: true });
        const found = await findSyncMarkers(b.app as never);
        ok(found.includes('.stfolder'), `目录级同步器的标记要认（实际 ${found.join(' · ')}）`);
        ok(found.includes('.obsidian/plugins/nutstore-sync'), '库内同步插件要认');
      } finally {
        await H.shutdown(b.plugin);
      }
    });

    await suite.it('接线：配了 key + 库有痕迹 → 加载之后真的提这一句（纯函数绿 ≠ 接线在）', async () => {
      const v = H.makeTempVault('keysafety-live');
      fs.mkdirSync(path.join(v, '.stfolder'), { recursive: true });
      const b = await H.bootPlugin(v, {
        rawData: { wizardDone: true, ai: { apiKey: 'sk-探针假key-不算配置' } },
      });
      H.resetDom();
      try {
        await H.settle(500);
        contains(noticeText(), '看起来在同步', 'onload 之后该出现那条通知');
      } finally {
        await H.shutdown(b.plugin);
      }
    });

    await suite.it('接线反向：**没配 key** 时不许提（每台机器都弹这句 = 等于没有）', async () => {
      const v = H.makeTempVault('keysafety-quiet');
      fs.mkdirSync(path.join(v, '.stfolder'), { recursive: true });
      const b = await H.bootPlugin(v, { rawData: { wizardDone: true, ai: { apiKey: '' } } });
      H.resetDom();
      try {
        await H.settle(500);
        notContains(noticeText(), '看起来在同步', '没配 key → 一个字都不该提');
      } finally {
        await H.shutdown(b.plugin);
      }
    });
  });
}
