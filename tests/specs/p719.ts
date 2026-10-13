/**
 * spec：**P7.19 · 流水线硬化**的产品面判据 —— 本轮"动了 undo 产品链"的那一半。
 *
 * 钉的那只虫（附录 B1，3/3 稳定复现）：一条**引用已消费 / 已被修剪快照**的撤销条被点到
 * 第二次 → `snapshot.restore(id)` throw（`快照不存在或读不了：<id>`）→ 而调用点写成
 * `() => void ctx.snapshot.restore(id)` → promise 被 `void` 吞成 `undefined`（**undo-bar
 * 那一层也接不住**）→ unhandled rejection → 套件按设计**整轮判红**。
 *
 * 产品侧两件（#1②③）就是钉这条链的：
 *   · `restoreOrNotify(snap, id)` —— 全仓 20 处 fire-and-forget 的统一落点：失败兜住
 *     （`[经纬]` warn + 轻提示），成功原样回吐 `RestoreResult`（**成功路径文案一处没动**）；
 *   · `ui/undo-bar.ts` 的**离场守卫** —— `dismiss()` 之后那条还会在 DOM 上挂最多 400ms
 *     （等 `animationend` / 兜底定时器），这期间再点任何按钮 = **幂等跳过 + 轻提示**（G1 拍板）。
 *
 * ⚠️ 只有一条真夹具（`__p719甲.md`），每条自己收场。
 * ⚠️ "**零未捕获**"这一半是**套件级**判据（`scripts/test.mjs` 的 unhandled 通道会把整轮判红）
 *    —— 所以这些用例只要跑完不动声色，就已经在证它；用例内部的断言钉的是"**兜住了 + 只生效一次**"。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { __resetNotices } from '../../src/ui/notify';
import { __resetUndo, restoreOrNotify, showUndo } from '../../src/ui/undo-bar';

const KB = '01_新知识库';

export async function specP719(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const abs = (rel: string): string => path.join(vaultRoot, KB, rel);
  const noticesText = (): string => H.textsOf(document.body, '.kbw-notice').join(' || ');

  function writeFix(rel: string, text: string): void {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text, 'utf8');
    app.vault.rescan();
    ctx().index.rebuild();
  }
  function rmFix(rels: string[]): void {
    for (const rel of rels) {
      try {
        fs.rmSync(abs(rel), { recursive: true, force: true });
      } catch {
        /* 没了就算了 */
      }
    }
    app.vault.rescan();
    ctx().index.rebuild();
  }

  /**
   * 造一个"**读不回来**的快照 id"：真拍一份快照，再把它删掉。
   * 等价于 B1 现场那两种成因（已被消费 / 被 `prune` 修剪过），但**确定性** ——
   * 不依赖"顺序相关"的现场（那正是当初这条虫难抓的地方）。
   */
  async function goneSnapshot(): Promise<string> {
    const snap = await ctx().snapshot.capture({ reason: 'P7.19 · B1 复现', files: [] });
    await ctx().snapshot.remove(snap.id);
    return snap.id;
  }

  await suite.group('P7.19 · #1 二次 restore（B1 转正）', async () => {
    await suite.it('restoreOrNotify：快照读不回来 → **兜住**（resolve null + 轻提示），不抛', async () => {
      const id = await goneSnapshot();
      __resetNotices();
      const r = await restoreOrNotify(ctx().snapshot, id);
      eq(r, null, '读不回来的快照 → resolve null（调用点拿得到"没成"，不必靠 unhandled 才知道）');
      contains(noticesText(), '没撤销成功', `要有一条轻提示（实际：${noticesText().slice(0, 160)}）`);
      __resetNotices();
    });

    await suite.it('撤销条：快照已被消费 → 点「撤销」兜住（轻提示、条走掉，零未捕获）', async () => {
      const id = await goneSnapshot();
      __resetNotices();
      __resetUndo();
      // 生产里的接线形状（21 处收口之后的那个样子）
      showUndo({ text: '已移动 1 篇笔记', onUndo: () => void restoreOrNotify(ctx().snapshot, id) });
      const btn = H.currentUndoButton('撤销');
      ok(btn, '撤销条在');
      H.click(btn!);
      await H.until(() => noticesText().includes('没撤销成功'), 2000);
      contains(noticesText(), '没撤销成功', '兜住 → 轻提示（不是静默，更不是未捕获）');
      ok(!H.currentUndoButton('撤销'), '条已经走了（离场中不算"还在"）');
      __resetNotices();
      __resetUndo();
    });

    await suite.it('撤销条：**点两次只生效一次**（离场窗口里再点 = 幂等跳过 + 轻提示）', async () => {
      const SRC = '__p719甲.md';
      writeFix(SRC, H.note('正文。\n'));
      await H.settleIndex(app);
      const before = fs.readFileSync(abs(SRC), 'utf8');
      const snapSvc = ctx().snapshot;
      const origRestore = snapSvc.restore;
      let calls = 0;
      snapSvc.restore = (id: string) => {
        calls += 1;
        return origRestore.call(snapSvc, id);
      };
      try {
        const snap = await snapSvc.capture({ reason: 'P7.19 · 双击', files: [`${KB}/${SRC}`] });
        /**
         * ⚠️ **先把它改坏，再撤销**（P7.19 独立审查 🟡4 指出）：原先 capture 之后**没人动过它**，
         * 于是收尾那条"内容逐字节回到快照那一刻"**恒真** —— restore 一次都不跑也绿
         * （`before` 与盘上本来就是一回事）。改掉中间这一拍，那条断言才有判别力。
         */
        fs.writeFileSync(abs(SRC), H.note('事后又被改过的正文。\n'), 'utf8');
        app.vault.rescan();
        ctx().index.rebuild();
        __resetNotices();
        __resetUndo();
        showUndo({
          text: '已移动 1 篇笔记',
          onUndo: () => void restoreOrNotify(ctx().snapshot, snap.id),
        });
        const btn = H.currentUndoButton('撤销');
        ok(btn, '撤销条在');

        // ── 第一下：真还原 ──
        H.click(btn!);
        await H.until(() => calls >= 1, 2000);
        eq(calls, 1, '第一下真调了 restore 一次');
        eq(fs.readFileSync(abs(SRC), 'utf8'), before, '内容逐字节回到快照那一刻');

        // ── 第二下：条还在离场窗口里（400ms 兜底还没到）──
        ok(btn!.isConnected, '前提：条还挂在 DOM 上（离场窗口）');
        H.click(btn!);
        await H.settle(260);
        eq(
          calls,
          1,
          '**第二次点击幂等跳过** —— 不许再调一次 restore（B1 那只虫正是从这儿长出来的）',
        );
        contains(
          noticesText(),
          '正在收走',
          `要给一条轻提示，而不是装作没发生（实际：${noticesText().slice(0, 160)}）`,
        );
      } finally {
        snapSvc.restore = origRestore;
        rmFix([SRC]);
        __resetNotices();
        __resetUndo();
        await H.settle(120);
      }
    });

    await suite.it('撤销条：离场窗口里「查看」也不再触发（同一个守卫）', async () => {
      __resetNotices();
      __resetUndo();
      let views = 0;
      showUndo({
        text: '已移动 1 篇笔记',
        onUndo: () => {},
        onView: () => {
          views += 1;
        },
      });
      const view = H.currentUndoButton('查看');
      ok(view, '「查看」在');
      H.click(view!);
      eq(views, 1, '第一下照常');
      ok(view!.isConnected, '前提：条还在离场窗口里');
      H.click(view!);
      await H.settle(120);
      eq(views, 1, '第二下被离场守卫挡下（同一套口径，「查看」不是例外）');
      __resetNotices();
      __resetUndo();
    });
  });
}
