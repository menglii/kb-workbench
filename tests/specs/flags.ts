/**
 * spec：健康标记（**确定性夹具**；v2 起五种：错位/断链/未名/空文/外改）
 *
 * 真数据只能验"跑得通"，验不出"判得对"。这里自己造 6 篇，每篇精准命中一种标记，
 * 逐个断言。对照的是 `交互规格.md` §3.3 的标记表 + `排查报告.md` §六点五 #18
 *（三处清单取并集，以交互规格为准）。
 * ⚠️ v2（P7.12）：第六种「缺必填（missing-required）」退休 —— ② 号夹具改成
 * "属性不全也不报标记"的负向钉。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, eq, ok } from '../framework';
import * as H from '../helpers';

export async function specFlags(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const kb = path.join(vaultRoot, '01_新知识库');
  const dir = '01_新知识库/09_夹具';

  await suite.group('健康标记（确定性夹具）', async () => {
    await suite.it('造 6 篇夹具并重扫', async () => {
      // 实验库是活的，基数每次都可能不同 → 记下加夹具之前的数
      const base = ctx().index.getAll().length;
      fs.mkdirSync(path.join(kb, '09_夹具'), { recursive: true });
      fs.mkdirSync(path.join(kb, '09_夹具/子目录'), { recursive: true });

      // ① 位置不一致：声明 00_Inbox，实际在 09_夹具
      H.writeNote(vaultRoot, `${dir}/位置不一致.md`, H.note('# 位置不一致\n', {}, { 位置: ['00_Inbox'] }));
      // ② 属性不全的（没有 状态 / 创建日期）—— v2 起**不该**报任何标记（缺必填已退休）
      fs.writeFileSync(
        path.join(kb, '09_夹具/属性不全.md'),
        ['---', '类型: 笔记', 'tags: []', '---', '# 属性不全', ''].join('\n'),
        'utf8',
      );
      // ③ 占位名
      H.writeNote(vaultRoot, `${dir}/未命名.md`, H.note('# 还没起名\n'));
      // ④ 失效双链
      H.writeNote(vaultRoot, `${dir}/失效双链.md`, H.note('# 失效双链\n\n见 [[根本不存在的一篇]]\n'));
      // ⑤ 空文件
      fs.writeFileSync(path.join(kb, '09_夹具/空文件.md'), '', 'utf8');
      // ⑥ 干净的（对照组：一个标记都不该有）
      H.writeNote(vaultRoot, `${dir}/子目录/干净.md`, H.note('# 干净\n\n[[位置不一致]]\n', {}, { 位置: ['09_夹具/子目录'] }));

      app.vault.rescan();
      ctx().index.rebuild();
      eq(ctx().index.getAll().length, base + 6, '基数 + 6 篇夹具');

      await H.settleIndex(app);
    });

    await suite.it('① 文件位置 ≠ 实际目录 → position-mismatch', async () => {
      const e = ctx().index.get(`${dir}/位置不一致.md`);
      ok(e, '找到夹具');
      ok(e?.flags.includes('position-mismatch'), '应该报位置不一致');
      eq(e?.effectivePosition, '09_夹具', '实际目录');
    });

    await suite.it('② 属性不全 → **不报任何标记**（v2：缺必填退休）', async () => {
      const e = ctx().index.get(`${dir}/属性不全.md`);
      ok(e, '找到夹具');
      eq((e?.flags ?? []).join(','), '', '属性不全不再挂旗标');
    });

    await suite.it('③ 标题是占位名 → placeholder-title', async () => {
      const e = ctx().index.get(`${dir}/未命名.md`);
      ok(e?.flags.includes('placeholder-title'), '应该报占位名');
    });

    await suite.it('④ 失效双链 → broken-link', async () => {
      const e = ctx().index.get(`${dir}/失效双链.md`);
      ok(e?.flags.includes('broken-link'), '应该报失效双链');
    });

    await suite.it('⑤ 0 字节 → empty-file', async () => {
      const e = ctx().index.get(`${dir}/空文件.md`);
      ok(e?.flags.includes('empty-file'), '应该报空文件');
    });

    await suite.it('⑥ 对照组：干净的那篇一个标记都没有', async () => {
      const e = ctx().index.get(`${dir}/子目录/干净.md`);
      ok(e, '找到对照组');
      eq((e?.flags ?? []).join(','), '', '对照组不该有标记');
    });

    await suite.it('指向 .base 的链接不算失效（platform-pitfalls #22 的误报）', async () => {
      H.writeNote(
        vaultRoot,
        `${dir}/指向base.md`,
        H.note('# 指向 base\n\n[[某个视图.base]]\n'),
      );
      app.vault.rescan();
      ctx().index.rebuild();
      const e = ctx().index.get(`${dir}/指向base.md`);
      ok(!e?.flags.includes('broken-link'), '.base 的链接不该被算失效双链');
    });

    await suite.it('正文里的 #标签 也进聚合', async () => {
      H.writeNote(vaultRoot, `${dir}/带标签.md`, H.note('# 带标签\n\n随便写点 #测试标签 在这里\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ok(ctx().index.tags().includes('测试标签'), '应该聚合到正文里的 #测试标签');
    });
  });
}
