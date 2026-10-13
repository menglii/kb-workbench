/**
 * spec：**测试台自己的行为**（P1 补的欠账 —— 钉住，不许悄悄退回"离线永远绿"）
 *
 * 这三条原本都是"桩没模拟 → 离线永远是绿的"类问题：
 *   ① metadataCache 的 ~300ms 滞后（写盘后立刻读属性读到的是**旧值**）
 *   ② 外部写入走**事件链路**（原先只能用 `rescan()`，它一个事件都不发）
 *   ③ 布局未就绪 → 骨架屏（原先 `onLayoutReady` 同步回调，这条分支从没渲染过）
 *   ④ 核心插件门 `internalPlugins`（原先桩里没有，`graphCoreState()` 三个分支零覆盖）
 *
 * ⚠️ 桩的行为一旦被改回"同步 / 零滞后"，**这些用例必须红** —— 否则 P1 之后所有
 * 表格、属性编辑器、首页的用例都建立在假绿之上。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import fs from 'node:fs';
import path from 'node:path';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { graphCoreState } from '../../src/modules/graph';
import { clearUserEdits } from '../../src/core/writes';

const KB = '01_新知识库';

export async function specHarness(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  await suite.group('测试台 · metadataCache 滞后（照真机 ~300ms）', async () => {
    await suite.it('写完立刻读：元数据与索引都还是旧值；滞后到期后才更新', async () => {
      const rel = `${KB}/00_Inbox/__滞后测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 滞后测试\n', {}, { 状态: '进行中' }));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);
      eq(ctx().index.get(rel)?.props['状态'], '进行中', '起始值');

      await ctx().fm.setMany(file, { 状态: '已完成' });

      // ① 磁盘上已经是新值（这是真事实）
      contains(H.readNote(vaultRoot, rel), '状态: 已完成', '磁盘上写进去了');
      // ② 元数据缓存**还是旧值**（滞后窗口内）
      eq(
        app.metadataCache.getFileCache(file)?.frontmatter?.['状态'],
        '进行中',
        '滞后窗口内 metadataCache 还没更新 —— 真机就是这样',
      );
      // ③ 索引跟着元数据走 → 也是旧值
      eq(ctx().index.get(rel)?.props['状态'], '进行中', '索引跟着 metadataCache 走');

      // ④ 真的等过滞后 → 两边都更新
      await H.tick(app.metadataCache.lagMs + 60);
      eq(
        app.metadataCache.getFileCache(file)?.frontmatter?.['状态'],
        '已完成',
        '滞后到期后 metadataCache 更新',
      );
      await H.settle(200);
      eq(ctx().index.get(rel)?.props['状态'], '已完成', '索引最终一致');

      H.writeNote(vaultRoot, rel, H.note('# 滞后测试\n', {}, { 状态: '进行中' }));
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('**新文件**也走滞后：create 之后立刻读是 null，滞后到期才解析出来', async () => {
      const rel = `${KB}/00_Inbox/__滞后新文件.md`;
      const file = await app.vault.create(rel, H.note('# 滞后新文件\n', {}, { 状态: '已完成' }));
      // 刚创建：metadataCache 还没解析过它 → getFileCache 返回 null（真机同理）
      eq(app.metadataCache.getFileCache(file), null, '刚 create 的文件还没有元数据缓存');
      await H.tick(app.metadataCache.lagMs + 60);
      const cache = app.metadataCache.getFileCache(file);
      ok(cache, '滞后到期后解析出来了');
      eq(cache?.frontmatter?.['状态'], '已完成', '解析出的属性正确');
      await H.settle(200);
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('滞后窗口内改两次：只结算最后一次，不会用中间态覆盖', async () => {
      const rel = `${KB}/00_Inbox/__连改两次.md`;
      H.writeNote(vaultRoot, rel, H.note('# 连改两次\n', {}, { 状态: '进行中' }));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);

      await ctx().fm.setMany(file, { 状态: '已完成' });
      /**
       * ⚠️ 独立审 B1（P7.12 收尾）：第二次写换个**不同的值**（原先两次都是「已完成」）——
       * 同值的话"最后一次写的赢"/"中间态覆盖"/"丢了一次更新"三种行为的结果全一样，
       * 这条用例存在的唯一理由（滞后窗口内只结算最后一次）就恒真了。
       * 三值域里还剩「已归档」可用，拿它当第二次。
       */
      await ctx().fm.setMany(file, { 状态: '已归档' });
      await H.settleIndex(app);

      eq(ctx().index.get(rel)?.props['状态'], '已归档', '最终值 = 最后一次写的（已归档）');
      contains(H.readNote(vaultRoot, rel), '状态: 已归档', '磁盘一致');

      H.writeNote(vaultRoot, rel, H.note('# 连改两次\n', {}, { 状态: '进行中' }));
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  await suite.group('测试台 · 外部写入走事件链路', async () => {
    await suite.it('别的程序改了库 → 打 external-change（不是靠手动 trigger 出来的）', async () => {
      const rel = `${KB}/00_Inbox/__外部写入.md`;
      H.writeNote(vaultRoot, rel, H.note('# 外部写入\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ok(!ctx().index.get(rel)?.flags.includes('external-change'), '刚造出来不该有标记');

      H.externalWrite(app, rel, H.note('# 外部写入\n\n别处改了一下\n'));
      await H.settleIndex(app);
      ok(
        ctx().index.get(rel)?.flags.includes('external-change'),
        '外部改动应该被打上 external-change',
      );

      // 我们自己写一次 → 标记清掉（"自己写的"登记簿）
      await ctx().fm.setMany(H.fileAt(app, rel), { 状态: '进行中' });
      await H.settleIndex(app);
      ok(
        !ctx().index.get(rel)?.flags.includes('external-change'),
        '自己写之后不该再算外部改动',
      );

      H.writeNote(vaultRoot, rel, H.note('# 外部写入\n'));
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it(
      'P7.14：用户在编辑器里打字（editor-change 先记账）→ **不算**外部改动；没这道预告的写照旧标',
      async () => {
        const rel = `${KB}/00_Inbox/__编辑器写.md`;
        H.writeNote(vaultRoot, rel, H.note('# 编辑器写\n'));
        app.vault.rescan();
        ctx().index.rebuild();
        ok(!ctx().index.get(rel)?.flags.includes('external-change'), '刚造出来不该有标记');

        // 演"编辑器里敲字"：workspace 先发 editor-change（接线在 vault-index.attach）
        app.workspace.trigger('editor-change', {}, { file: { path: rel } });
        H.externalWrite(app, rel, H.note('# 编辑器写\n\n我又打了一行\n'));
        await H.settleIndex(app);
        ok(
          !ctx().index.get(rel)?.flags.includes('external-change'),
          '编辑器里写的（editor-change 在账上）不该算外部改动 —— 用户真机反馈的那条',
        );

        /**
         * 对照：**没有 editor-change 的写照旧要标**（同步/别的程序拉进来的改动
         * 不会发那个事件 —— 那正是这枚旗标要保的价值，别把口径放宽成"永远不标"）。
         * ⚠️ 控件组登记簿有 3 次命中额度，先清掉免得把对照的写也认领了。
         */
        clearUserEdits();
        H.externalWrite(app, rel, H.note('# 编辑器写\n\n别处又改了一下\n'));
        await H.settleIndex(app);
        ok(
          ctx().index.get(rel)?.flags.includes('external-change'),
          '没有 editor-change 的写必须照旧标外改（对照）',
        );

        H.writeNote(vaultRoot, rel, H.note('# 编辑器写\n'));
        app.vault.rescan();
        ctx().index.rebuild();
        clearUserEdits();
      },
    );
  });

  await suite.group('测试台 · 布局未就绪的骨架屏', async () => {
    const vault = H.makeTempVault('harness-ready');
    const b = await H.bootPlugin(vault, { deferLayoutReady: true });

    await suite.it('索引没就绪 → 骨架屏；布局就绪后骨架屏退场', async () => {
      await b.plugin.activate();
      await H.settle(40);
      ok(H.maybe(document.body, '.kbw-skel'), '未就绪时应该是骨架屏（不是空白、也不是空态）');
      eq(b.plugin.context().store.get().indexReady, false, 'store 里也应是未就绪');

      b.app.workspace.fireLayoutReady();
      await H.settle(80);
      eq(b.plugin.context().store.get().indexReady, true, '布局就绪后索引建起来了');
      ok(!H.maybe(document.body, '.kbw-skel'), '骨架屏该退场');
    });

    await suite.it('核心插件门：ok / disabled / unknown 三个分支都认', async () => {
      const ip = b.app.internalPlugins;
      ip.plugins.graph = { enabled: true };
      eq(graphCoreState(b.app as never), 'ok', '开着 → ok');
      ip.plugins.graph = { enabled: false };
      eq(graphCoreState(b.app as never), 'disabled', '关着 → disabled');
      ip.plugins.graph = undefined;
      eq(graphCoreState(b.app as never), 'unknown', '问不到 → unknown');
      ip.plugins.graph = { enabled: true };
    });

    await H.shutdown(b.plugin);
    H.resetDom();
  });
}
