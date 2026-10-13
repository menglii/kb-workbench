/**
 * spec：**库内配置层**（`core/config-files.ts`，四个 JSON）
 *
 * 为什么单独一个 spec：P0 完成定义第 3 条就是"库内三个 JSON 能读能写能监听变化"，
 * 而独立审查发现它**零覆盖**（全 `tests/` 没有一个文件 import 它）。
 * 它是 P3/P4/P5 的根，读坏/写坏的后果是"配置静默退回默认值"或"和同进程的同步抢写"。
 * （P8 期 2 起是第 4 个：`复习.json` —— 详见 `review.ts` 里那一组。）
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, eq, ok } from '../framework';
import * as H from '../helpers';

export async function specConfigs(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  await suite.group('库内配置层（四个 JSON）', async () => {
    await suite.it('文件不存在时：返回默认值，且**不落盘**（谁的期谁负责第一次落盘）', async () => {
      const path = ctx().configs.pathOf('rebuild');
      ok(!H.exists(vaultRoot, path), '前提：库结构.json 本来不存在');
      const data = (await ctx().configs.read('rebuild')) as { dirs?: string[] };
      ok(Array.isArray(data.dirs) && data.dirs.length > 10, '读到默认骨架（21 个目录）');
      ok(!H.exists(vaultRoot, path), 'read 不该写盘');
      eq(await ctx().configs.exists('rebuild'), false, 'exists 应为 false');
    });

    await suite.it('write：自动建目录、落盘、能读回；再写是覆盖', async () => {
      await ctx().configs.write('board', { version: 1, view: { cardWidth: 333 }, sections: [] });
      const path = ctx().configs.pathOf('board');
      ok(H.exists(vaultRoot, path), '文件写出来了（多级目录也建了）');
      const back = (await ctx().configs.read('board')) as { view: { cardWidth: number } };
      eq(back.view.cardWidth, 333, '读回一致');
      eq(await ctx().configs.exists('board'), true, 'exists 应为 true');

      await ctx().configs.write('board', { version: 1, view: { cardWidth: 444 }, sections: [] });
      const back2 = (await ctx().configs.read('board')) as { view: { cardWidth: number } };
      eq(back2.view.cardWidth, 444, '覆盖写生效');
    });

    await suite.it('ensure：不存在就把默认值写下去', async () => {
      const cfgPath = ctx().configs.pathOf('automation');
      /**
       * ⚠️ **"不存在"由用例自己造**：P3 的真机跑过之后，这份夹具的库里
       * 已经有 `自动化.json` 了 —— 原来那句"前提：还不存在"是写死夹具状态的
       * （换基线就假红，P4 开工正是这么红的）。
       */
      fs.rmSync(path.join(vaultRoot, cfgPath), { force: true });
      app.vault.rescan();
      ok(!H.exists(vaultRoot, cfgPath), '前提：自动化.json 已被删掉');
      const d = await ctx().configs.ensure('automation');
      ok(H.exists(vaultRoot, cfgPath), 'ensure 落了盘');
      const auto = d as { reconcile?: { enabled?: boolean }; completion?: { enabled?: boolean } };
      ok(auto.reconcile, '默认值里有 reconcile 段');
      eq(auto.reconcile?.enabled, false, '自动归位默认关（决策 7）');
      eq(auto.completion?.enabled, true, '新建补全默认开（交互规格 §7.1）');
    });

    await suite.it('JSON 被改坏：退回默认值、不抛异常（但会在控制台报）', async () => {
      const path = ctx().configs.pathOf('board');
      H.writeNote(vaultRoot, path, '{ 这不是合法 JSON');
      app.vault.rescan();
      const back = (await ctx().configs.read('board')) as { view?: unknown };
      ok(back.view, '退回默认值而不是抛出去');
      // 收尾：写回合法内容，别给后面的用例留个坏文件
      await ctx().configs.write('board', { version: 1, view: { cardWidth: 240 }, sections: [] });
    });

    await suite.it('外部改了文件 → attach 挂的监听会把新内容推给 watch', async () => {
      const path = ctx().configs.pathOf('automation');
      let got: unknown = null;
      const off = ctx().configs.watch('automation', (d) => {
        got = d;
      });
      H.writeNote(vaultRoot, path, JSON.stringify({ version: 1, reconcile: { enabled: true } }, null, 2));
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(path));
      await H.settle(600); // 监听是 150ms debounce
      off();
      ok(got, 'watch 的回调被调到了');
      eq((got as { reconcile: { enabled: boolean } }).reconcile.enabled, true, '拿到的是新内容');

      // 收尾：恢复默认值形态
      await ctx().configs.write('automation', { version: 1, reconcile: { enabled: false } });
    });

    /**
     * 🔴 **自己写的也要通知订阅者**。
     *
     * 为什么单列一条：写完之后 cache 与文件内容一致，防抖那一轮（比 cache vs 文件）
     * 会判成"没变"→ **一次都不通知**。真机上看得见的后果：在设置面板改「看板默认值」
     * （写的是**同一份** `看板配置.json` 的 `view` 段），开着的看板不跟着变。
     * 这条断言很脆（改回"write 不通知"就红）—— 正是要这样。
     */
    await suite.it('我们自己 write 下去的内容，也要推给订阅者（不是只推外部改动）', async () => {
      let got: unknown = null;
      const off = ctx().configs.watch('board', (d) => {
        got = d;
      });
      await ctx().configs.write('board', { version: 1, view: { cardWidth: 222 }, sections: [] });
      await H.settle(60);
      off();
      ok(got, 'watch 的回调被调到了（不是只有外部改动才推）');
      eq(
        (got as { view: { cardWidth: number } })?.view?.cardWidth,
        222,
        '拿到的是刚写下去的那份',
      );
    });

    await suite.it('同名文件在别处 → 不触发（守卫按完整路径比）', async () => {
      const path = ctx().configs.pathOf('board');
      let hits = 0;
      const off = ctx().configs.watch('board', () => {
        hits += 1;
      });
      H.writeNote(vaultRoot, `01_新知识库/00_Inbox/看板配置.json`, '{"version":9}');
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath('01_新知识库/00_Inbox/看板配置.json'));
      await H.settle(350);
      off();
      eq(hits, 0, '别处的同名文件不该触发');
      // 收尾
      const stray = app.vault.getAbstractFileByPath('01_新知识库/00_Inbox/看板配置.json');
      if (stray) await app.vault.delete(stray, true);
      void path;
      app.vault.rescan();
    });
  });
}
