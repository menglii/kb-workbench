/**
 * spec：全库索引与健康标记（真数据）
 * 对应完成定义：
 *   · 全库索引列出 43 篇及属性，且能算出健康标记
 *   · 改一个文件增量更新
 */
import path from 'node:path';
import fs from 'node:fs';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, eq, ok } from '../framework';
import * as H from '../helpers';
import { FLAG_META, type HealthFlag } from '../../src/core/vault-index';
import { declaredPositions } from '../../src/services/schema';
import { clearSelfWrites } from '../../src/core/writes';

export async function specVaultIndex(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const kbRoot = path.join(vaultRoot, '01_新知识库');

  await suite.group('全库索引（真数据 43 篇）', async () => {
    await suite.it('索引的条目数 = 磁盘上的 .md 数（含 7 个模板）', async () => {
      // ⚠️ 实验库是**活的**：真机测试会往 99_Meta/05_操作日志/ 写日志、会搬文件，
      // 所以这里断言"索引与磁盘一致"，而不是钉死某个数字（P0 初版钉过 43，
      // 真机跑一轮之后就红了 —— 那不是 bug，是插件在正常工作）
      const mdOnDisk = H.listFiles(vaultRoot, '01_新知识库').filter((f) => f.endsWith('.md')).length;
      const all = ctx().index.getAll();
      const notes = ctx().index.notes();
      eq(all.length, mdOnDisk, '索引条目总数 = 磁盘 .md 数');
      eq(all.length - notes.length, 7, '模板数（T_* 共 7 个）');
      eq(notes.length, mdOnDisk - 7, '笔记数 = 全部 - 模板');
      ok(mdOnDisk >= 43, `至少 43 篇（P-0 基线），实际 ${mdOnDisk}`);
    });

    await suite.it('每篇都带属性对象与合法 flags 数组', async () => {
      const bad: string[] = [];
      for (const entry of ctx().index.getAll()) {
        if (!Array.isArray(entry.flags)) bad.push(`${entry.path}: flags 不是数组`);
        if (typeof entry.props !== 'object') bad.push(`${entry.path}: props 不是对象`);
        for (const f of entry.flags) {
          if (!(f in FLAG_META)) bad.push(`${entry.path}: 未知标记 ${f}`);
        }
        if (typeof entry.effectivePosition !== 'string') bad.push(`${entry.path}: effectivePosition 不是字符串`);
      }
      eq(bad.join(' | '), '', '索引条目形状问题');
    });

    await suite.it('实际目录相对库根算对了，且与「文件位置」的断言一致', async () => {
      const inboxOnDisk = H.listFiles(vaultRoot, '01_新知识库/00_Inbox').filter((f) =>
        f.endsWith('.md'),
      ).length;
      const inbox = ctx().index.notes().filter((e) => e.effectivePosition === '00_Inbox');
      eq(inbox.length, inboxOnDisk, '00_Inbox 的篇数与磁盘一致');

      const sample = ctx().index.notes().find((e) => e.basename === '9.16');
      ok(sample, '应该能找到 9.16.md（不管它现在在哪个目录）');
      eq(sample?.props['类型'], '任务', '属性读到了（走 metadataCache；v2 值域）');
      const declared = declaredPositions(sample?.props ?? {});
      const actual = sample?.effectivePosition ?? '';
      // 收紧：不能写成 `declared.length === 0 || ...`（"属性被误清空"恰好走恒真分支）
      ok(declared.length >= 1, `9.16.md 应该声明过「文件位置」，实际 ${JSON.stringify(declared)}`);
      ok(
        declared.includes(actual),
        `声明 ${JSON.stringify(declared)} 与实际 ${actual} 应一致（真机搬过之后属性会跟着走）`,
      );
      ok(!sample?.flags.includes('position-mismatch'), '声明与实位一致时不该报位置不一致');
    });

    await suite.it('**「缺必填」已退休**：v2 起不存在这个旗标，全库都算不出来', async () => {
      // v2（P7.12）：v2 无"必填"概念 —— 五件套的完整性由"新建即配置"保证，不再挂旗标
      const flagged = ctx().index.notes().filter((e) => (e.flags as string[]).includes('missing-required'));
      eq(flagged.length, 0, '没有一篇挂着「缺项」');
      ok(!('missing-required' in ctx().index.flagCounts()), 'flagCounts 里也不该有这个键');
    });

    await suite.it('模板不参与健康标记（它们本来就不适用）', async () => {
      const templates = ctx().index.getAll().filter((e) => e.isTemplate);
      eq(templates.length, 7, '模板数');
      const flagged = templates.filter((e) => e.flags.includes('position-mismatch') || e.flags.includes('empty-file'));
      eq(flagged.length, 0, '模板不该报位置/空文件这类标记');
    });

    await suite.it('健康标记计数与逐篇统计一致', async () => {
      const counts = ctx().index.flagCounts();
      const flags: HealthFlag[] = [
        'position-mismatch',
        'placeholder-title',
        'broken-link',
        'external-change',
        'empty-file',
      ];
      for (const f of flags) {
        const manual = ctx().index.getAll().filter((e) => e.flags.includes(f)).length;
        eq(counts[f], manual, `${FLAG_META[f].label} 计数`);
      }
    });

    await suite.it('标签与属性值聚合可用（属性编辑器的候选值靠它）', async () => {
      ok(ctx().index.tags().length > 0, '标签聚合不该是空的');
      // 单值属性（不是列表）也要收进来 —— 「悬垂 else」那个坑就是栽在这
      ok(ctx().index.valuesOf('状态').length >= 2, '状态这种单值属性也要聚合到');
      ok(ctx().index.valuesOf('类型').includes('任务'), '类型里有任务（v2 值域）');
      ok(!ctx().index.valuesOf('类型').includes('任务清单'), '旧值不该还在');
    });
  });

  await suite.group('增量更新', async () => {
    await suite.it('改一个文件的属性 → 索引里那一篇跟着变，其余不受影响', async () => {
      const target = ctx().index.notes().find((e) => e.basename === '9.16');
      ok(target, '找到 9.16.md');
      const before = ctx().index.revision;
      const othersBefore = ctx().index.notes().length;

      await ctx().fm.setMany(target.file, { 状态: '已完成' });
      await H.settleIndex(app); // 桩按真机模拟了 metadataCache 的 ~300ms 滞后

      const after = ctx().index.get(target.path);
      eq(after?.props['状态'], '已完成', '属性已更新');
      ok(ctx().index.revision > before, '修订号应该涨');
      eq(ctx().index.notes().length, othersBefore, '条目数不变');

      // 还原，别影响后面的用例
      await ctx().fm.setMany(target.file, { 状态: '进行中' });
      await H.settleIndex(app);
    });

    await suite.it('新文件出现 → 进索引；删掉 → 出索引', async () => {
      const rel = '01_新知识库/00_Inbox/__索引增量测试.md';
      const base = ctx().index.getAll().length;
      H.writeNote(vaultRoot, rel, H.note('# 索引增量测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ok(
        ctx().index.get(rel),
        `新文件应该进索引（当前 ${ctx().index.getAll().length} 条，kbRoot=${ctx().settings.kbRoot()}）`,
      );
      eq(ctx().index.getAll().length, base + 1, '条目数 +1');

      fs.rmSync(path.join(kbRoot, '00_Inbox/__索引增量测试.md'));
      app.vault.rescan();
      ctx().index.rebuild();
      eq(ctx().index.get(rel), undefined, '删掉之后不该还在');
      eq(ctx().index.getAll().length, base, '条目数回到基数');
    });
  });

  await suite.group('外部改动检测', async () => {
    await suite.it('别人改的 → 打 external-change；我们自己写的 → 不打', async () => {
      const target = ctx().index.notes().find((e) => e.basename === '9.16');
      ok(target, '找到 9.16.md');

      // ① 模拟"外部"改动：清掉"自己写的"登记 + 直接写盘 + 让 vault 发事件
      clearSelfWrites();
      const abs = path.join(vaultRoot, target.path);
      const text = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, text.replace('进行中', '进行中'), 'utf8');
      app.vault.rescan();
      const file = app.vault.getAbstractFileByPath(target.path);
      app.vault.trigger('modify', file);
      await H.settleIndex(app);
      ok(
        ctx().index.get(target.path)?.flags.includes('external-change'),
        '外部改动应该被打上 external-change',
      );

      // ② 我们自己写一次 → 标记清掉
      await ctx().fm.setMany(target.file, { 状态: '进行中' });
      await H.settleIndex(app);
      ok(
        !ctx().index.get(target.path)?.flags.includes('external-change'),
        '自己写之后不该再算外部改动',
      );
    });
  });
}
