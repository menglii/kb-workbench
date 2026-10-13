/**
 * spec：mover / snapshot / report —— **动库的那条链**
 *
 * 对应完成定义：
 *   · `mover.move()` 手动调能搬一篇笔记，且：撞名被拦住、生成快照、写日志、弹通知
 *   · 快照能还原（含逆 rename、删空目录、还原保留）
 *
 * 全部在临时副本上跑，实验库本体一个字节都不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { declaredPositions } from '../../src/services/schema';
import { __resetNotices } from '../../src/ui/notify';

const KB = '01_新知识库';

export async function specMover(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const abs = (rel: string): string => path.join(vaultRoot, rel);
  const inboxCount = (): number =>
    ctx().index.notes().filter((e) => e.effectivePosition === '00_Inbox').length;

  await suite.group('mover · 基本搬运', async () => {
    // ⚠️ 通知断言读的是"第一条 .kbw-notice"，不先清掉会读到上一个 spec 的残留
    __resetNotices();

    await suite.it('搬一篇 Inbox → 02_Areas/内容创作：文件真的到了，快照写了，日志写了，通知弹了', async () => {
      // 自己造一篇：实验库是活的，真机测试可能已经把 Inbox 搬空了
      const fixture = `${KB}/00_Inbox/__搬运链路测试.md`;
      H.writeNote(vaultRoot, fixture, H.note('# 搬运链路测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();

      const before = inboxCount();
      ok(before > 0, 'Inbox 里得先有东西');

      const target = ctx().index.notes().find((e) => e.path === fixture);
      ok(target, '找到刚造的那篇');
      const origAbs = abs(target.path);
      const origText = fs.readFileSync(origAbs, 'utf8');
      const toDir = `${KB}/02_Areas/内容创作`;
      const toPath = `${toDir}/${target.basename}.md`;

      const logsBefore = H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`);
      const res = await ctx().mover.move({
        targets: [{ dir: toDir, files: [target.file] }],
        source: 'batch',
        reason: '测试：搬一篇',
      });
      await H.settleIndex(app);

      eq(res.error ?? '', '', '不该有硬错误');
      eq(res.moved.length, 1, '搬走 1 篇');
      eq(res.moved[0].from, target.path, 'from 是旧路径（renameFile 会就地改 file.path）');
      eq(res.moved[0].to, toPath, 'to 是新路径');
      ok(H.exists(vaultRoot, toPath), `目标文件存在：${toPath}`);
      ok(!H.exists(vaultRoot, target.path), '源文件不在了');
      eq(
        H.readNote(vaultRoot, toPath).split('---').slice(2).join('---'),
        origText.split('---').slice(2).join('---'),
        '正文一个字符都没动（前言可能被「属性跟随」改过）',
      );
      ok(res.snapshotId, '返回了快照 id');

      // 快照落盘
      const snapDir = `.obsidian/plugins/kb-workbench/snapshots/${res.snapshotId}`;
      ok(H.exists(vaultRoot, `${snapDir}/manifest.json`), 'manifest.json 写了');
      const manifest = JSON.parse(H.readNote(vaultRoot, `${snapDir}/manifest.json`)) as {
        contents: { path: string; bytes: number; file: string }[];
        moves: { from: string; to: string }[];
        newDirs: string[];
        deletions: unknown[];
        totalBytes: number;
      };
      eq(manifest.moves.length, 1, '快照记了 from→to');
      eq(manifest.moves[0].from, target.path, '快照里的旧路径');
      eq(manifest.moves[0].to, toPath, '快照里的新路径');
      ok(manifest.contents.some((c) => c.path === target.path), '快照存了原文');
      for (const c of manifest.contents) {
        eq(fs.statSync(abs(`${snapDir}/${c.file}`)).size, c.bytes, `${c.file} 字节数对得上`);
      }
      ok(manifest.totalBytes > 0, '总字节数大于 0');

      // 日志
      const logsAfter = H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`);
      eq(logsAfter.length, logsBefore.length + 1, '新增一条操作日志');
      const logPath = `${KB}/99_Meta/05_操作日志/${logsAfter.find((f) => !logsBefore.includes(f))}`;
      const logText = H.readNote(vaultRoot, logPath);
      contains(logText, '类型: 日志', '日志前言里带 类型: 日志（它也是笔记实体）');
      contains(logText, '已移动 1 篇笔记', '日志里的结论');
      contains(logText, toPath, '日志里记了新路径');

      // 通知
      const notice = H.textOf(H.maybe(document.body, '.kbw-notice'));
      contains(notice, '已移动 1 篇笔记', '弹了成功通知');

      // 还原回去，保持后续用例的环境
      const rest = await ctx().snapshot.restore(res.snapshotId);
      eq(rest.movedBack, 1, '还原把文件搬回原位');
      eq(rest.blocked.length, 0, '还原没有受阻项');
      await H.settleIndex(app);
      eq(H.readNote(vaultRoot, target.path), origText, '还原后内容与原文逐字节一致');
      eq(inboxCount(), before, 'Inbox 篇数回到原样');

      fs.rmSync(abs(fixture), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('搬到不存在的目录 → 先建目录，快照记下 newDirs', async () => {
      const fixture = `${KB}/00_Inbox/__新目录测试.md`;
      H.writeNote(vaultRoot, fixture, H.note('# 新目录测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const target = ctx().index.notes().find((e) => e.path === fixture);
      ok(target, '找到刚造的那篇');
      const newDir = `${KB}/08_新建目录/更深一层`;
      eq(fs.existsSync(abs(newDir)), false, '目录本来不存在');

      const res = await ctx().mover.move({
        targets: [{ dir: newDir, files: [target.file] }],
        source: 'batch',
        reason: '测试：搬到新目录',
      });
      await H.settleIndex(app);
      eq(res.moved.length, 1, '搬走了');
      ok(fs.existsSync(abs(newDir)), '目录建出来了');
      const manifest = await ctx().snapshot.read(res.snapshotId);
      ok(manifest?.newDirs.includes(newDir), '快照记了新建目录');
      eq(
        [...(manifest?.newDirs ?? [])].sort().join(','),
        [`${KB}/08_新建目录`, `${KB}/08_新建目录/更深一层`].sort().join(','),
        '连同中间层一起记（还原才知道该删哪几层）',
      );

      // 还原：删空目录
      await ctx().snapshot.restore(res.snapshotId);
      await H.settleIndex(app);
      eq(fs.existsSync(abs(`${KB}/08_新建目录/更深一层`)), false, '还原把新建的空目录删掉了');
      eq(fs.existsSync(abs(`${KB}/08_新建目录`)), false, '上级空目录也删掉了');

      fs.rmSync(abs(fixture), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('位置锁定的笔记：v2 起连自动归位也照搬（显式=手动语义）', async () => {
      const rel = `${KB}/00_Inbox/__锁定测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 锁定测试\n', { 位置锁定: true }));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);

      /**
       * v2（P7.12 · #12）：**mover 里原先那条 `source === 'reconcile' && 位置锁定 → 跳过`
       * 已删除** —— 自动归位唯一的触发就是"用户显式改声明"（显式=手动语义），
       * 与 batch 待遇相同：**锁不拦**。这条用例钉住的正是这个有意识的行为变化。
       */
      const auto = await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas/内容创作`, files: [file] }],
        source: 'reconcile',
        reason: '测试：显式改声明触发的归位',
      });
      eq(auto.moved.length, 1, 'v2：显式语义下锁不拦（原先这里跳过）');
      await H.settleIndex(app);
      await ctx().snapshot.restore(auto.snapshotId);
      await H.settleIndex(app);
      fs.rmSync(abs(rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('属性跟随：声明过「文件位置」的，搬家后声明跟着走', async () => {
      const rel = `${KB}/00_Inbox/__位置声明测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 位置声明测试\n', {}, { 位置: ['00_Inbox'] }));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);
      const toDir = `${KB}/02_Areas/游戏研究`;

      const res = await ctx().mover.move({
        targets: [{ dir: toDir, files: [file] }],
        source: 'batch',
        reason: '测试：属性跟随',
      });
      await H.settleIndex(app);
      eq(res.moved.length, 1, '搬走了');
      const movedFile = H.fileAt(app, `${toDir}/__位置声明测试.md`);
      const props = ctx().fm.props(movedFile);
      eq(
        (Array.isArray(props['文件位置']) ? props['文件位置'] : [props['文件位置']]).join(','),
        '02_Areas/游戏研究',
        '声明跟着搬到了新位置',
      );
      await ctx().snapshot.restore(res.snapshotId);
      await H.settleIndex(app);
      fs.rmSync(abs(rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('没声明过「文件位置」的，搬完**也写** —— 声明 = 新落点（P7.18b 口径反转）', async () => {
      const rel = `${KB}/00_Inbox/__无声明测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 无声明测试\n', {}, { 位置: [] }));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);
      const toDir = `${KB}/02_Areas/灵感杂记`;
      const res = await ctx().mover.move({
        targets: [{ dir: toDir, files: [file] }],
        source: 'batch',
        reason: '测试：无声明搬家',
      });
      await H.settleIndex(app);
      eq(res.moved.length, 1, '搬走了');
      /**
       * 🔴 **P7.18b 口径反转**（用户 2026-10-09 拍板 —— 原话"通过拖动文件的方式改变文件位置，
       * 也不会把位置属性补回来"→ 现在会）：旧行为"搬完仍然留空"已废 ——
       * **任何搬动之后，「文件位置」= 实际落点**（拖拽 / 批量迁移 / 看板拖卡 / AI 搬动全走这里）。
       */
      const movedPath = `${toDir}/__无声明测试.md`;
      ok(
        await H.until(
          () => declaredPositions(ctx().index.get(movedPath)?.props ?? {}).length > 0,
          3000,
          40,
        ),
        '★ 未声明的搬完也写上声明（轮询等 metadataCache 追上来）',
      );
      eq(
        declaredPositions(ctx().index.get(movedPath)?.props ?? {}).join(','),
        '02_Areas/灵感杂记',
        '★ 声明 = 新落点（不是留空）',
      );
      await ctx().snapshot.restore(res.snapshotId);
      await H.settleIndex(app);
      fs.rmSync(abs(rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  await suite.group('mover · 撞名护栏', async () => {
    await suite.it('撞名且内容不同 → blocked，两边都不动', async () => {
      const rel = `${KB}/00_Inbox/__撞名源.md`;
      const toDir = `${KB}/02_Areas/内容创作`;
      const toPath = `${toDir}/__撞名源.md`;
      H.writeNote(vaultRoot, rel, H.note('# 撞名源（原版）\n'));
      H.writeNote(vaultRoot, toPath, H.note('# 撞名源（目标已有，内容不同）\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);
      const srcText = H.readNote(vaultRoot, rel);
      const dstText = H.readNote(vaultRoot, toPath);

      const res = await ctx().mover.move({
        targets: [{ dir: toDir, files: [file] }],
        source: 'batch',
        reason: '测试：撞名',
      });
      eq(res.moved.length, 0, '一篇都不该搬');
      eq(res.blocked.length, 1, '记一条真冲突');
      eq(res.blocked[0].why, 'content-conflict', '原因 = 内容冲突');
      eq(H.readNote(vaultRoot, rel), srcText, '源文件没动');
      eq(H.readNote(vaultRoot, toPath), dstText, '目标文件没被覆盖');

      fs.rmSync(abs(rel), { force: true });
      fs.rmSync(abs(toPath), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('撞名且内容相同 → already（静默跳过，幂等）', async () => {
      const rel = `${KB}/00_Inbox/__已搬过.md`;
      const toDir = `${KB}/02_Areas/内容创作`;
      const toPath = `${toDir}/__已搬过.md`;
      const text = H.note('# 已搬过（同一份内容）\n');
      H.writeNote(vaultRoot, rel, text);
      H.writeNote(vaultRoot, toPath, text);
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);

      const res = await ctx().mover.move({
        targets: [{ dir: toDir, files: [file] }],
        source: 'batch',
        reason: '测试：已搬过',
      });
      eq(res.moved.length, 0, '不搬');
      eq(res.blocked.length, 0, '不是冲突');
      eq(res.already.length, 1, '记一条「已搬过」');

      fs.rmSync(abs(rel), { force: true });
      fs.rmSync(abs(toPath), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('搬到原处（from === to）→ 当幂等处理，不抛异常', async () => {
      const rel = `${KB}/00_Inbox/__原地.md`;
      H.writeNote(vaultRoot, rel, H.note('# 原地\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);
      const res = await ctx().mover.move({
        targets: [{ dir: `${KB}/00_Inbox`, files: [file] }],
        source: 'batch',
        reason: '测试：原地',
      });
      eq(res.already.length, 1, '算「已搬过」');
      eq(res.error, undefined, '没有错误');
      fs.rmSync(abs(rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  await suite.group('快照 · 双链与还原保留', async () => {
    /**
     * 🔴 **名字里带点的改名不许被切**（P6 逮到的真缺陷，先红后修）。
     *
     * 原来的实现是 `stripExt(newName)` —— 它切掉的是**最后一个** `.xxx`，
     * 于是 `9.16-改` 被当成"扩展名是 `.16-改`"、剩下 `9` → 文件**静默**变成 `9.md`。
     * 只有名字带点时才现形，所以这个 bug 一直躺在 mover 里没人碰。
     * ⚠️ 这条用例必须用**带点的名字**，否则它复现不出来（第一版就是随便挑了个名字 → 恒绿）。
     */
    await suite.it('改名：名字里带点的（`9.16-改`）原样保留，不许切成 `9`', async () => {
      const src = `${KB}/00_Inbox/__点号测试9.16.md`;
      H.writeNote(vaultRoot, src, H.note('# 点号测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, src);

      const res = await ctx().mover.move({
        targets: [{ dir: `${KB}/00_Inbox`, newName: '__点号测试9.16-改', files: [file] }],
        source: 'batch',
        reason: '测试：带点的名字改名',
      });
      await H.settleIndex(app);

      const want = `${KB}/00_Inbox/__点号测试9.16-改.md`;
      eq(res.moved.length, 1, '改名成功');
      ok(H.exists(vaultRoot, want), `名字里的点要留着：期望 ${want}`);
      ok(!H.exists(vaultRoot, `${KB}/00_Inbox/__点号测试9.md`), '**不许**被切成 `…9.md`');
      // 顺手把"用户连 `.md` 一起打进来"那条也钉住（那才是 stripExt 当初想解决的问题）
      const res2 = await ctx().mover.move({
        targets: [{ dir: `${KB}/00_Inbox`, newName: '__点号测试9.16-改.md', files: [H.fileAt(app, want)] }],
        source: 'batch',
        reason: '测试：带扩展名的名字改名（幂等）',
      });
      await H.settleIndex(app);
      eq(res2.moved.length + res2.already.length, 1, '带上原扩展名 → 不该出第二个文件');
      ok(H.exists(vaultRoot, want), '结果还是同一个路径（`.md` 被识别成扩展名去掉了）');

      fs.rmSync(abs(want), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('被双链修复波及的其他文件会进 touched，内容存进快照，还原后引用回到旧名', async () => {
      const aPath = `${KB}/00_Inbox/__引用者A.md`;
      const bPath = `${KB}/00_Inbox/__被引用B.md`;
      H.writeNote(vaultRoot, aPath, H.note('# 引用者A\n\n见 [[__被引用B]]\n'));
      H.writeNote(vaultRoot, bPath, H.note('# 被引用B\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const bFile = H.fileAt(app, bPath);

      // 改名（basename 变了 → 平台会同步改写 A 里的双链）
      const res = await ctx().mover.move({
        targets: [{ dir: `${KB}/00_Inbox`, newName: '__被引用B新名', files: [bFile] }],
        source: 'batch',
        reason: '测试：改名带动双链',
      });
      await H.settleIndex(app);
      eq(res.moved.length, 1, '改名成功');
      ok(res.touched.some((t) => t.path === aPath), `touched 里应有引用者 A，实际 ${JSON.stringify(res.touched)}`);
      contains(H.readNote(vaultRoot, aPath), '[[__被引用B新名]]', '平台把双链改了');

      const manifest = await ctx().snapshot.read(res.snapshotId);
      ok(manifest?.contents.some((c) => c.path === aPath), '快照把引用者 A 也存了');

      // 还原：内容写回 → A 的双链回到旧名
      const restored = await ctx().snapshot.restore(res.snapshotId);
      await H.settleIndex(app);
      eq(restored.blocked.length, 0, `不该有不让路的：${JSON.stringify(restored.blocked)}`);
      contains(H.readNote(vaultRoot, aPath), '[[__被引用B]]', '还原之后引用者指回旧名');
      ok(H.exists(vaultRoot, bPath), '被改名的文件搬回了原位');
      ok(!H.exists(vaultRoot, `${KB}/00_Inbox/__被引用B新名.md`), '新名不该还在');

      fs.rmSync(abs(aPath), { force: true });
      fs.rmSync(abs(bPath), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('还原不让路：原位被"快照之后新建的文件"占了 → 挪到「还原保留-<时间戳>/」', async () => {
      const rel = `${KB}/00_Inbox/__还原保留测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 还原保留测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);

      // 搬到别处（模拟一次移动操作），然后手工把"删除"这一步做掉：
      // 手段是搬走之后，在旧位置新建一个同名文件（= 快照之后新建的）
      const toDir = `${KB}/02_Areas/游戏研究`;
      const res = await ctx().mover.move({
        targets: [{ dir: toDir, files: [file] }],
        source: 'batch',
        reason: '测试：还原保留',
      });
      await H.settleIndex(app);
      H.writeNote(vaultRoot, rel, H.note('# 还原时占位的另一篇\n'));
      app.vault.rescan();

      const restored = await ctx().snapshot.restore(res.snapshotId);
      await H.settleIndex(app);
      eq(restored.blocked.length, 0, `不该有不让路的：${JSON.stringify(restored.blocked)}`);
      ok(restored.keptAside.length >= 1, '应该把占位文件挪走而不是覆盖');
      ok(
        restored.keptAside.some((p) => p.includes('还原保留-')),
        `挪到「还原保留-<时间戳>/」，实际 ${JSON.stringify(restored.keptAside)}`,
      );
      ok(H.exists(vaultRoot, rel), '原文件回来了');

      // 清理
      fs.rmSync(abs(rel), { force: true });
      for (const p of restored.keptAside) fs.rmSync(abs(p), { force: true });
      fs.rmSync(abs(`${KB}/02_Areas/游戏研究/__还原保留测试.md`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('还原**不会**给"被双链波及的文件"在旧路径复制一份（真机踩过的坑）', async () => {
      const aOld = `${KB}/00_Inbox/__引用者X.md`;
      const bOld = `${KB}/00_Inbox/__目标Y.md`;
      H.writeNote(vaultRoot, aOld, H.note('# 引用者X\n\n见 [[__目标Y]]\n'));
      H.writeNote(vaultRoot, bOld, H.note('# 目标Y\n'));
      app.vault.rescan();
      ctx().index.rebuild();

      // ① 把「目标Y」搬到别的目录 → 快照里 contents = 目标Y@旧路径 + 引用者X（touched，也按当时的路径记）
      const snap1 = await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas/游戏研究`, files: [H.fileAt(app, bOld)] }],
        source: 'batch',
        reason: '测试：先搬目标',
      });
      eq(snap1.moved.length, 1, '目标搬走了');
      eq(snap1.touched.length, 1, '引用者被平台改写，进了 touched');
      await H.settleIndex(app);

      // ② 再把「引用者X」也合法地搬到别处
      const snap2 = await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas/灵感杂记`, files: [H.fileAt(app, aOld)] }],
        source: 'batch',
        reason: '测试：再搬引用者',
      });
      eq(snap2.moved.length, 1, '引用者也搬走了');
      await H.settleIndex(app);

      // ③ 还原第一份快照：引用者X 的旧路径是空的，**绝不能凭空造一份出来**
      const restored = await ctx().snapshot.restore(snap1.snapshotId);
      await H.settleIndex(app);
      eq(
        H.exists(vaultRoot, aOld),
        false,
        '旧路径不该冒出一份副本（那只是"被双链波及的文件"，不是本次要搬回去的文件）',
      );
      // ⚠️ "已不在原位/没写回"是**没做到**那一档（P5 把 `problems` 与信息类 `notifications` 分开了）
      ok(
        restored.problems.some((n) => n.includes('已不在原位')),
        `该说明"没写回"而不是悄悄复制：${JSON.stringify(restored.problems)}`,
      );
      // 引用者现在应该在它被搬去的那个目录，且内容没被弄坏
      ok(H.exists(vaultRoot, `${KB}/02_Areas/灵感杂记/__引用者X.md`), '引用者还在它被搬去的地方');

      for (const p of [aOld, bOld, `${KB}/02_Areas/灵感杂记/__引用者X.md`, `${KB}/02_Areas/游戏研究/__目标Y.md`]) {
        fs.rmSync(abs(p), { force: true });
      }
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('快照写盘失败 → 一条都不搬（失败即停，不赌运气）', async () => {
      const rel = `${KB}/00_Inbox/__快照失败测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 快照失败测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const file = H.fileAt(app, rel);

      const originalWrite = app.vault.adapter.write.bind(app.vault.adapter);
      (app.vault.adapter as unknown as { write: unknown }).write = async (): Promise<void> => {
        throw new Error('模拟磁盘写不了');
      };
      try {
        const res = await ctx().mover.move({
          targets: [{ dir: `${KB}/02_Areas/游戏研究`, files: [file] }],
          source: 'batch',
          reason: '测试：快照失败',
        });
        eq(res.moved.length, 0, '不该搬任何东西');
        ok(!!res.error, '应该带错误信息');
        ok(H.exists(vaultRoot, rel), '源文件原地不动');
      } finally {
        (app.vault.adapter as unknown as { write: unknown }).write = originalWrite;
      }
      fs.rmSync(abs(rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  await suite.group('快照 · 账本', async () => {
    await suite.it('列表 / 读 / 占用 / 清理 都可用', async () => {
      const list = await ctx().snapshot.list();
      ok(list.length > 0, '前面已经拍过若干快照');
      eq(list[0].id, [...list].sort((a, b) => b.id.localeCompare(a.id))[0].id, '最新在前');
      const total = await ctx().snapshot.totalBytes();
      ok(total > 0, '占用大于 0');
      const first = list[0];
      const m = await ctx().snapshot.read(first.id);
      eq(m?.id, first.id, '读回来的 id 对得上');

      // 清理：只留 1 个
      const removed = await ctx().snapshot.prune(1, 365);
      ok(removed > 0, `应该清掉一些，实际 ${removed}`);
      const after = await ctx().snapshot.list();
      eq(after.length, 1, '只留 1 个');
    });
  });
}
