/**
 * spec：属性迁移（P2 起；**v2 大改，P7.12**）
 *
 * 三段：
 *   A **纯函数**：映射表判得对（合成条目，逐条钉住）
 *   B **模板**：按行改正文 + 自检 + 幂等（真模板原文 + 表外模板的通用修整）
 *   C **端到端**：真库数据的副本上跑"预演 → 全部用推荐值 → 执行 → 重跑预演 0 篇"
 *     —— 这一段就是 `开发计划.md` §7 的**完成定义**
 *
 * ⚠️ 完成定义有两条：① 重跑预演 0 篇 ② 首页不再报"迁移该解决的问题"。
 * **它们各自的真实强度（独立审查用突变测过，别高估）**：
 *   · ① 是**同一个 planner 的自反断言** → 保证"幂等、不来回震荡"，**不保证"该改的真改了"**
 *     （实证：把模板改成恒"不用动"，① 照样绿）。真正兜住"真改了"的是本文件里那三条
 *     **直接读盘**的用例：`落盘核对` / `模板也落了盘` / `真数据上的 v2 修整整落了盘`。
 *   · ② 是**纯否定式** → 整块没渲染时天然通过。钉住它的是前面那条**正向**用例
 *     （`首页此刻报着…`）与 `完成定义②` 里补的 flag 计数。
 *
 * ── v2（P7.12 · 2026-10-06 拍定）的迁移面 ──────────────────────
 *   类型 10→7 · 状态 5→3（待整理/持续更新 **删键**）· **删「领域」** ·
 *   **删专属字段（连值）** · 📌 页脚行 + 尾链存量重排（**正文修整**，bodyOps）。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { NoteEntry } from '../../src/core/vault-index';
import {
  applyTemplateEdits,
  checkDecision,
  editsFor,
  patchOf,
  planMigration,
  previewMigration,
  recommendedChoices,
  verifyTemplateText,
} from '../../src/services/migrate';
import { PATCHED_RELS, patchState, patchesOf, pendingPatches } from '../../src/services/doc-patches';
import { buildTodos } from '../../src/modules/home/todo';
import { openMigratePanel } from '../../src/ui/migrate-panel';
import { purgeOverlays } from '../../src/ui/panel';
import { parseFrontmatter, type StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, notContains, ok } from '../framework';
import * as H from '../helpers';

// ── 合成条目（纯函数用）────────────────────────────────────────
function entry(rel: string, props: Record<string, unknown>, isTemplate = false): NoteEntry {
  const path = `01_新知识库/${rel}`;
  const base = rel.split('/').pop() ?? rel;
  return {
    // 纯函数只读 props / path / basename / isTemplate / effectivePosition
    file: { path } as never,
    props,
    flags: [],
    effectivePosition: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    path,
    basename: base.replace(/\.md$/, ''),
    isTemplate,
    mtime: 0,
    size: 0,
  } as NoteEntry;
}

/** 把一份计划"就地执行"到 props 上（幂等性断言用：执行完再预演必须是 0） */
function applyPlanToProps(props: Record<string, unknown>, item: ReturnType<typeof planMigration>['items'][number], picks: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  const { set, del } = patchOf(item);
  for (const k of del) delete out[k];
  for (const [k, v] of Object.entries(set)) out[k] = v;
  for (const c of item.choices) {
    const v = picks[c.id];
    if (v != null) out[c.key] = v;
  }
  return out;
}

export async function specMigrate(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const opts = { kbRoot: '01_新知识库' };

  // ── A 纯函数 ────────────────────────────────────────────────
  await suite.group('属性迁移 · 预演（纯函数）', async () => {
    await suite.it('「状态」的流水线值 → 进行中 / 已完成（**不再拆 发布进度**）', async () => {
      const plan = planMigration([entry('02_Areas/内容创作/示例.md', { 类型: '内容作品', 状态: '3-撰写中', 创建日期: '2026-09-01', tags: [] })], opts);
      const ops = plan.changes[0]?.ops ?? [];
      eq(ops.find((o) => o.kind === 'set' && o.key === '状态')?.value, '进行中', '3-撰写中 → 进行中');
      ok(!ops.some((o) => o.key === '发布进度'), 'v2 不再拆出发布进度');
      eq(plan.changes[0]?.choices.length, 0, '这一步不需要人定');
    });

    await suite.it('「5-已发布」→ 状态: 已完成', async () => {
      const plan = planMigration([entry('02_Areas/内容创作/a.md', { 类型: '内容作品', 状态: '5-已发布', 创建日期: 'x', tags: [] })], opts);
      const ops = plan.changes[0]?.ops ?? [];
      eq(ops.find((o) => o.key === '状态')?.value, '已完成', '已发布 → 已完成');
    });

    await suite.it('「归档」→ 已归档（不产生发布进度）', async () => {
      const plan = planMigration([entry('04_Archives/旧资料/x.md', { 类型: '资料', 状态: '归档', 创建日期: 'x', tags: [] })], opts);
      const ops = plan.changes[0]?.ops ?? [];
      eq(ops.find((o) => o.key === '状态')?.value, '已归档', '归档 → 已归档');
      ok(!ops.some((o) => o.key === '发布进度'), '不该有发布进度');
    });

    await suite.it('「待整理」/「持续更新」→ **删键**（连值删，不折算）', async () => {
      const p1 = planMigration([entry('00_Inbox/a.md', { 类型: '笔记', 状态: '待整理', 创建日期: 'x', tags: [] })], opts);
      const d1 = p1.changes[0]?.ops.find((o) => o.kind === 'del' && o.key === '状态');
      eq(d1?.from, '待整理', '待整理 连值删');
      const p2 = planMigration([entry('99_Meta/a.md', { 类型: '索引', 状态: '持续更新', 创建日期: 'x', tags: [] })], opts);
      ok(p2.changes[0]?.ops.some((o) => o.kind === 'del' && o.key === '状态' && o.from === '持续更新'), '持续更新 连值删');
    });

    await suite.it('类型收拢（v0 名 → v1 → v2 的完整链）', async () => {
      const one = (t: string) =>
        planMigration([entry('00_Inbox/a.md', { 类型: t, 状态: '进行中', 创建日期: 'x', tags: [] })], opts)
          .changes[0]?.ops.find((o) => o.key === '类型')?.value;
      eq(one('区域中心'), '索引', '区域中心 → 中心页 → 索引');
      eq(one('学习笔记'), '笔记', '学习笔记 → 资料 → 笔记');
      eq(one('参考资料'), '笔记', '参考资料 → 资料 → 笔记');
      eq(one('MOC索引'), '索引', 'MOC索引 → MOC → 索引');
      eq(one('操作日志'), '日志', '操作日志 → 日志');
    });

    await suite.it('类型 v1→v2 七值映射（10 → 7 的正式映射）', async () => {
      const one = (t: string) =>
        planMigration([entry('00_Inbox/a.md', { 类型: t, 状态: '进行中', 创建日期: 'x', tags: [] })], opts)
          .changes[0]?.ops.find((o) => o.key === '类型')?.value;
      eq(one('内容作品'), '笔记', '内容作品');
      eq(one('项目笔记'), '笔记', '项目笔记');
      eq(one('想法'), '笔记', '想法');
      eq(one('资料'), '笔记', '资料');
      eq(one('任务清单'), '任务', '任务清单');
      eq(one('中心页'), '索引', '中心页');
      eq(one('MOC'), '索引', 'MOC');
      // 已经在七值域里的：一步不动
      const keep = planMigration([entry('00_Inbox/a.md', { 类型: '日志', 状态: '进行中', 创建日期: 'x', tags: [] })], opts);
      eq(keep.count, 0, '日志 已是 v2 值 → 不改');
    });    await suite.it('删旧键：主题 / 仅显示于 / 聚焦；中文键「标签」先并入 tags 再删', async () => {
      const plan = planMigration(
        [entry('00_Inbox/a.md', { 类型: '想法', 状态: '进行中', 创建日期: 'x', tags: ['知识库'], 主题: '标题副本', 仅显示于: '创作看板', 聚焦: true, 标签: ['AI', '知识库'] })],
        opts,
      );
      const ops = plan.changes[0]?.ops ?? [];
      const deleted = ops.filter((o) => o.kind === 'del').map((o) => o.key);
      deepEq([...deleted].sort(), ['主题', '标签', '聚焦', '仅显示于'].sort(), '四个旧键都要删（领域不在 props 里）');
      deepEq(ops.find((o) => o.kind === 'set' && o.key === 'tags')?.value, ['知识库', 'AI'], '中文键「标签」并进 tags（去重）');
    });

    await suite.it('**「领域」退役：任何值都连值删**；tags 不再被"精简"（用户自管）', async () => {
      const plan = planMigration(
        [entry('02_Areas/内容创作/a.md', { 类型: '内容作品', 领域: '内容创作', 状态: '进行中', 创建日期: 'x', tags: ['内容创作'] })],
        opts,
      );
      const d = plan.changes[0]?.ops.find((o) => o.kind === 'del' && o.key === '领域');
      eq(d?.from, '内容创作', '连值删除、预览能看到值');
      ok(!plan.changes[0]?.ops.some((o) => o.key === 'tags' && o.kind === 'set'), 'tags 不因领域退役被"精简"（用户自管）');
    });

    await suite.it('**专属字段连值删除**（8 个；预览逐条列出键与值）', async () => {
      const plan = planMigration(
        [entry('99_Meta/a.md', {
          类型: '内容作品',
          状态: '进行中',
          创建日期: 'x',
          tags: [],
          发布进度: '3-撰写中',
          平台: ['B站'],
          形式: '视频',
          目标发布日: '2026-10-01',
          封面: '示例封面',
          简介: '一句话',
          截止日期: '2026-10-02',
          阶段: '01_执行中',
        })],
        opts,
      );
      const dels = (plan.changes[0]?.ops ?? []).filter((o) => o.kind === 'del');
      const keys = dels.map((o) => o.key).sort();
      deepEq(
        keys,
        ['发布进度', '平台', '形式', '目标发布日', '封面', '简介', '截止日期', '阶段'].sort(),
        '八个专属键全部连值删',
      );
      eq(dels.find((o) => o.key === '发布进度')?.from, '3-撰写中', '预览逐条列出将被删的键与值');
      eq(dels.find((o) => o.key === '平台')?.from, 'B站', '列表值也要看得见');
    });

    await suite.it('值域换不出来的 → 生成「待你定」（类型: 待整理 / 状态: 已整理）', async () => {
      const plan = planMigration(
        [entry('00_Inbox/a.md', { 类型: '待整理', 状态: '已整理', 创建日期: 'x', tags: [] })],
        opts,
      );
      const keys = [...(plan.changes[0]?.choices.map((c) => c.key) ?? [])].sort().join(',');
      eq(keys, ['类型', '状态'].sort().join(','), '两处都要人定');
      ok(plan.changes[0]?.choices.every((c) => c.options.length > 1), '每处都有候选');
      // v2：类型推荐按**目录默认**（00_Inbox → 笔记）
      eq(plan.changes[0]?.choices.find((c) => c.key === '类型')?.recommend, '笔记', '按目录默认推荐');
    });

    await suite.it('选完之后：逐篇定的值进入 op，且选项不再要求确认', async () => {
      const e = entry('00_Inbox/a.md', { 类型: '待整理', 状态: '已整理', 创建日期: 'x', tags: [] });
      const first = planMigration([e], opts);
      const picks = recommendedChoices(first);
      const second = planMigration([e], { ...opts, choices: picks });
      eq(second.changes[0]?.choices.length, 0, '定过的项不该再问');
      eq(second.changes[0]?.ops.find((o) => o.key === '类型')?.value, picks['00_Inbox/a.md::类型'], '类型用的是选中的值');
    });

    await suite.it('正文补丁表与库里的原文**逐条对得上**（原文漂了就会从这里红）', async () => {
      // ⚠️ 这条必须在**执行之前**跑（执行完它们就都成了"已打"）→ 所以放在纯函数组
      let total = 0;
      for (const rel of PATCHED_RELS) {
        const text = H.readNote(vaultRoot, `01_新知识库/${rel}`);
        const all = patchesOf(rel);
        const pending = pendingPatches(rel, text);
        eq(pending.length, all.length, `${rel}：${all.length} 处补丁都该处于「待打」（说明 find 与原文一字不差）`);
        total += all.length;
      }
      eq(total, 16, '补丁总数 = 16');
    });

    await suite.it('值会被写坏的篇 → **整篇跳过**（一个 op 都不出）', async () => {
      // 真实来源：`创建日期: {{date}}` 被 YAML 当成流式映射 → 往返一次就改形（真机实测 4 篇）
      const e = entry('04_Archives/旧资料/陈旧模板.md', {
        类型: '资料',
        领域: 'Meta',
        状态: '已归档',
        创建日期: { '{ date }': null },
        tags: [],
        主题: '副本',
      });
      const plan = planMigration([e], opts);
      eq(plan.count, 0, '不算"要改"（否则预演永远回不到 0）');
      eq(plan.blocked.length, 1, '列进"跳过"');
      eq(plan.items[0]?.ops.length, 0, '一个 op 都不出（半个改动也会把那个值改形）');
      contains(String(plan.blocked[0]?.blocked), '创建日期', '要写清是哪个键');
    });

    await suite.it('拍板值的两道网：值域外要报', async () => {
      // 表是手维护的：写错一个字（每天任务）不能静默落库 —— 落进去之后没有任何一处会报
      contains(String(checkDecision('类型', '每天任务')), '不在值域里', '值域外的拍板值要报出来');
      eq(checkDecision('状态', '进行中'), null, '值域内的放行');
      // 不支持的键一律返回"有问题"（v2 只支持 类型/状态）
      contains(String(checkDecision('阶段', '01_执行中')), '不是这张表支持的键', '不支持的键也要说清');
    });

    await suite.it('**表外模板也能被通用修整**（复制出来的 T_xxx 1.md / 用户手搓的）', async () => {
      const path = '01_新知识库/99_Meta/02_模板库/Templater/T_新玩意.md';
      const e = entry('99_Meta/02_模板库/Templater/T_新玩意.md', {}, true);
      const text = [
        '---',
        '类型: 想法',
        '领域: Meta',
        '主题: <% title %>',
        '状态: 进行中',
        'tags: []',
        '---',
        '',
        '# <% title %>',
        '',
        '## 关联笔记',
        '- 所属中心：[[_领域中心]]',
        '- 相关：[[]]',
        '- 返回 [[MOC_知识地图]]',
        '',
        '---',
        '> 📌 由 Templater 自动生成 · 示例',
        '',
      ].join('\n');
      const plan = planMigration([e], { ...opts, texts: { [path]: text } });
      eq(plan.blocked.length, 0, 'v2 起表外模板不再"跳过" —— 通用修整能把它改好');
      ok(plan.count === 1, '它算"要改"');
      const fixed = applyTemplateEdits(text, 'T_新玩意.md');
      contains(fixed, '类型: 模板', '类型收拢成模板');
      notContains(fixed, '领域:', '领域删掉（表外也走通用链：v0 旧键 + v2 退役键一起清）');
      notContains(fixed, '主题:', 'v0 旧键删掉');
      notContains(fixed, '📌', '📌 页脚行删掉');
      contains(fixed, '- 相关笔记：[[]]', '尾链改字');
      const order = ['- 相关笔记：[[]]', '- 所属中心：', '- 返回大地图 [['].map((s) => fixed.indexOf(s));
      ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `尾链新序（实际 ${order.join(',')}）`);
      eq(verifyTemplateText(fixed, 'T_新玩意.md').join('、'), '', '自检通过');
      // 已经干净的（表外 + 无旧键）：不用动、也不拦
      const clean = ['---', '类型: 模板', '状态: 进行中', 'tags: []', '---', '', 'x', ''].join('\n');
      const p2 = planMigration([e], { ...opts, texts: { [path]: clean } });
      eq(p2.blocked.length, 0, '干净的不用拦');
      eq(p2.count, 0, '也不用动');
    });

    await suite.it('缺 tags → 补空数组（空数组合法）', async () => {
      const plan = planMigration([entry('00_Inbox/a.md', { 类型: '笔记', 状态: '进行中', 创建日期: 'x' })], opts);
      deepEq(plan.changes[0]?.ops.find((o) => o.key === 'tags')?.value, [], '补 []');
    });

    await suite.it('`来源` 是控制字段（v2 拍定保留）；**别的**自定义键只报告、不删', async () => {
      const plan = planMigration(
        [entry('99_Meta/a.md', { 类型: '笔记', 状态: '进行中', 创建日期: 'x', tags: [], 来源: 'https://example.com', 我的自定义键: 'x' })],
        opts,
      );
      ok(!(plan.changes[0]?.ops ?? []).some((o) => o.key === '来源'), '来源 不删（P7.12 拍定 ⑥：控制字段保留）');
      eq(plan.items[0]?.keep.map((k) => k.key).join(','), '我的自定义键', '规范外的自定义键只报告');
    });

    await suite.it('已经符合 v2 规范的 → 一步不动（幂等的第一半）', async () => {
      const plan = planMigration([entry('99_Meta/a.md', { 类型: '规范', 状态: '进行中', 创建日期: '2026-09-01', tags: [] })], opts);
      eq(plan.count, 0, '0 篇要改');
      eq(plan.items.length, 1, '但仍然列在 items 里（没漏看）');
    });

    await suite.it('幂等的第二半：把计划执行掉再预演 → 0 篇', async () => {
      const src = [
        entry('00_Inbox/a.md', { 类型: '待整理', 领域: '未分类', 状态: '已整理', 创建日期: 'x', tags: ['未分类'], 主题: 'a', 聚焦: true }),
        entry('02_Areas/内容创作/b.md', { 类型: '内容作品', 领域: '内容创作', 状态: '1-灵感', 创建日期: 'x', tags: ['内容创作'] }),
        entry('01_Projects/01_执行中/c.md', { 类型: '项目笔记', 领域: '项目', 状态: '进行中', 创建日期: 'x', tags: [], 阶段: '01_执行中' }),
      ];
      const first = planMigration(src, opts);
      const picks = recommendedChoices(first);
      const after = src.map((e) => {
        const item = first.items.find((i) => i.path === e.path);
        return item ? entry(item.rel, applyPlanToProps(e.props, item, picks)) : e;
      });
      const second = planMigration(after, { ...opts, choices: picks });
      eq(second.count, 0, `执行完再预演必须 0 篇，实际还有：${second.changes.map((c) => `${c.rel}(${c.summary})`).join(' | ')}`);
    });
  });

  // ── B 模板（真模板原文）────────────────────────────────────
  await suite.group('属性迁移 · 模板（按行改正文）', async () => {
    const tplDir = '01_新知识库/99_Meta/02_模板库/Templater';

    await suite.it('T_内容作品：类型→模板 + 删领域/简介/发布进度/平台/形式/目标发布日/封面 + 尾链新序 + 去 📌', async () => {
      const text = H.readNote(vaultRoot, `${tplDir}/T_内容作品.md`);
      const next = applyTemplateEdits(text, 'T_内容作品.md');
      notContains(next, '主题:', '主题该删');
      contains(next, '类型: 模板', '类型收拢成模板');
      contains(next, '状态: 进行中', '状态保留');
      for (const k of ['领域:', '简介:', '发布进度:', '平台:', '形式:', '目标发布日:', '封面:']) {
        notContains(next, k, `${k} 该删`);
      }
      notContains(next, '📌', '📌 页脚行该删（全变体）');
      contains(next, '- 相关笔记：[[]]', '尾链改字');
      const order = ['- 相关笔记：[[]]', '- 所属中心：', '- 返回大地图 [['].map((s) => next.indexOf(s));
      ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `尾链新序（实际 ${order.join(',')}）`);
      contains(next, 'tags: []', 'tags 保留清空');
      eq(verifyTemplateText(next, 'T_内容作品.md').join('、'), '', '自检通过');
    });

    await suite.it('T_项目笔记：类型→模板 + 删阶段/截止日期/领域 + tags 收敛', async () => {
      const next = applyTemplateEdits(H.readNote(vaultRoot, `${tplDir}/T_项目笔记.md`), 'T_项目笔记.md');
      contains(next, '类型: 模板', '类型收拢成模板');
      contains(next, 'tags: []', 'tags 收敛');
      notContains(next, '主题:', '主题该删');
      for (const k of ['阶段:', '截止日期:', '领域:']) notContains(next, k, `${k} 该删`);
      eq(verifyTemplateText(next, 'T_项目笔记.md').join('、'), '', '自检通过');
    });

    await suite.it('T_领域笔记：类型→模板 + 删领域 + tags 清空', async () => {
      const next = applyTemplateEdits(H.readNote(vaultRoot, `${tplDir}/T_领域笔记.md`), 'T_领域笔记.md');
      contains(next, '类型: 模板', '类型收拢成模板');
      notContains(next, '领域:', '领域删掉（占位符 <% area %> 那行一并走）');
      contains(next, 'tags: []', '与领域重复的标签清掉');
      eq(verifyTemplateText(next, 'T_领域笔记.md').join('、'), '', '自检通过');
    });

    await suite.it('T_参考资料：类型→模板 + 删领域 + 状态/ tags 保留', async () => {
      const next = applyTemplateEdits(H.readNote(vaultRoot, `${tplDir}/T_参考资料.md`), 'T_参考资料.md');
      contains(next, '类型: 模板', '类型收拢成模板');
      notContains(next, '领域:', '领域删掉');
      contains(next, '状态: 进行中', '状态保留');
      contains(next, 'tags: [<% cat %>]', 'tags 原样（用户自管）');
      eq(verifyTemplateText(next, 'T_参考资料.md').join('、'), '', '自检通过');
    });

    await suite.it('T_收件箱速记：类型→模板 + 删领域/状态（待整理） + tags 清空', async () => {
      const next = applyTemplateEdits(H.readNote(vaultRoot, `${tplDir}/T_收件箱速记.md`), 'T_收件箱速记.md');
      contains(next, '类型: 模板', '类型收拢成模板');
      notContains(next, '领域:', '领域删掉');
      notContains(next, '状态:', '「待整理」是退役状态值 → 整行删');
      contains(next, 'tags: []', '「待整理」是状态值，不是标签');
      eq(verifyTemplateText(next, 'T_收件箱速记.md').join('、'), '', '自检通过');
    });

    await suite.it('自检也管**值**（`状态: 进行中2` 这种错字要拦）', async () => {
      const text = H.readNote(vaultRoot, `${tplDir}/T_内容作品.md`);
      const migrated = applyTemplateEdits(text, 'T_内容作品.md');
      const broken = migrated.replace('状态: 进行中', '状态: 进行中2');
      contains(verifyTemplateText(broken, 'T_内容作品').join('、'), '不在值域里', '错字要报出来');
      // 占位符不算错（那是 Templater 求值的）
      eq(verifyTemplateText(migrated, 'T_内容作品').join('、'), '', '改完的不该报');
    });

    await suite.it('自检能拦下"没改"的文本（负向）', async () => {
      const text = H.readNote(vaultRoot, `${tplDir}/T_内容作品.md`);
      const bad = verifyTemplateText(text, 'T_内容作品.md');
      ok(bad.length > 0, '原文应该被自检报出来');
      contains(bad.join('、'), '主题', '报告要指出是哪个键');
    });

    await suite.it('给了正文之后：改好的模板不再出现在计划里（**否则预演永远回不到 0**）', async () => {
      const before = H.readNote(vaultRoot, `${tplDir}/T_领域笔记.md`);
      const entries = ctx().index.getAll();
      const noText = planMigration(entries, opts);
      ok(
        noText.changes.some((c) => c.isTemplate && c.basename === 'T_领域笔记'),
        '没给正文时保守地把模板列出来',
      );
      const withText = planMigration(entries, {
        ...opts,
        texts: { [`${tplDir}/T_领域笔记.md`]: applyTemplateEdits(before, 'T_领域笔记') },
      });
      ok(
        !withText.changes.some((c) => c.isTemplate && c.basename === 'T_领域笔记'),
        '给了"已经改好"的正文 → 不再算要改',
      );
    });

    await suite.it('幂等：改两遍 == 改一遍', async () => {
      for (const name of ['T_内容作品.md', 'T_项目笔记.md', 'T_领域笔记.md', 'T_参考资料.md', 'T_收件箱速记.md', 'T_每日任务.md']) {
        const once = applyTemplateEdits(H.readNote(vaultRoot, `${tplDir}/${name}`), name);
        eq(applyTemplateEdits(once, name), once, `${name} 第二遍不该再变`);
      }
    });

    await suite.it('没在前言块里的同名行不受影响（正文里的「主题:」不动）', async () => {
      const text = ['---', '类型: 模板', '主题: x', '---', '', '正文里写 主题: 保持原样', ''].join('\n');
      const next = applyTemplateEdits(text, 'T_每日任务.md');
      contains(next, '正文里写 主题: 保持原样', '正文不该被动');
      notContains(next, '\n主题: x', '前言里的要删');
    });

    await suite.it('表的键与索引给的 basename 对得上（**踩过：带不带 .md 差一个后缀就静默跳过**）', async () => {
      // 索引给的是 `T_内容作品`（不带扩展名），表里写的是 `T_内容作品.md`
      eq(editsFor('T_内容作品').length > 0, true, '不带扩展名也要查到');
      eq(editsFor('T_内容作品.md').length > 0, true, '带扩展名当然也要查到');
      const tpls = ctx().index.getAll().filter((e) => e.isTemplate);
      eq(tpls.length, 7, '实验库里 7 个模板');
      for (const t of tpls) {
        if (t.basename === 'T_智能新建') {
          eq(editsFor(t.basename).length, 0, 'T_智能新建 是脚本（自身没有前言）→ 表里没有它，正常');
          continue;
        }
        ok(editsFor(t.basename).length > 0, `${t.basename} 该在表里（表 ops 之外它还有通用修整兜底）`);
      }
    });
  });

  // ── C 端到端（真数据的副本）─────────────────────────────────
  /** 端到端的预演一律走异步入口（否则模板永远算"要改"，完成定义永远红） */
  const preview = () => previewMigration(app.vault, ctx().index.getAll(), opts);

  await suite.group('属性迁移 · 端到端（真数据副本）', async () => {
    let plan0 = await preview();
    let snapIds: string[] = [];
    // 上一组用例若中途失败，可能留着开着的模态 → 先收干净，免得到处选错元素
    purgeOverlays();

    await suite.it('预演：数出每一篇要改什么（含逐篇要定的）', async () => {
      // 夹具必须是"迁移前"的那一份：0 篇就说明拿错了库（**别让它空跑成绿**）
      ok(
        plan0.count > 0,
        `夹具里没有要迁的东西 → 多半拿的不是"迁移前"的备份（KBW_BACKUP_KB 指错了）。当前预演 ${plan0.count} 篇`,
      );
      ok(plan0.choiceCount > 0, '应该有人工判断项（类型: 待整理 / 状态: 已整理）');
      // 正文补丁：三篇说明文字（AI 规范 / 使用指南 / README）都在计划里
      const patched = plan0.changes.filter((i) => (i.docPatches ?? 0) > 0);
      eq(patched.length, 3, '三篇说明文字要打正文补丁');
      eq(
        patched.reduce((n, i) => n + (i.docPatches ?? 0), 0),
        16,
        '合计 16 处（AI规范 5 + 使用指南 5 + README 6）',
      );
      // 正文修整：执行中1（旧尾链重排）+ 未锈铠（旧尾链 + 📌 行）= 至少 2 处
      ok(plan0.bodyCount >= 2, `正文修整至少 2 处（旧尾链/📌），实际 ${plan0.bodyCount}`);
      const bodied = plan0.changes.filter((i) => (i.bodyOps?.length ?? 0) > 0).map((i) => i.rel);
      ok(bodied.includes('01_Projects/01_执行中/执行中1.md'), '执行中1 的旧尾链要被判出来');
      ok(bodied.includes('02_Areas/内容创作/未锈铠.md'), '未锈铠 的 📌 行要被判出来');

      // 汇总打印：收尾时给人过目（不是断言，是证据）。
      // 要看逐篇全表：`KBW_MIGRATE_PLAN=1 npm test`
      console.log(`      预演：${plan0.count} 篇要改 / ${plan0.opCount} 处改动 / ${plan0.choiceCount} 处待定 / ${plan0.bodyCount} 处正文修整`);
      if (process.env.KBW_MIGRATE_PLAN) {
        for (const c of plan0.changes) {
          console.log(`      · [${c.ops.length}] ${c.rel} — ${c.summary}`);
        }
      }
    });

    await suite.it('预演是只读的：跑三遍，库里的文件一个字节没动', async () => {
      const before = H.readNote(vaultRoot, '01_新知识库/99_Meta/03_AI指令集/AI操作规范.md');
      await preview();
      await preview();
      eq(H.readNote(vaultRoot, '01_新知识库/99_Meta/03_AI指令集/AI操作规范.md'), before, '文件没变');
    });

    await suite.it('首页此刻报着「N 篇的属性还是旧规范」', async () => {
      const todos = buildTodos(ctx().index.notes(), '00_Inbox', { migrateCount: plan0.count });
      ok(todos.some((t) => t.id === 'migrate'), '应该有待迁移那一条');
    });

    await suite.it('面板：打开 → 列出待改的篇 → 「全部用推荐值」把待定清零', async () => {
      purgeOverlays();
      const h = openMigratePanel(ctx());
      await H.until(() => h.body.querySelectorAll('.kbw-mig-row').length > 0, 800);
      const rows = Array.from(h.body.querySelectorAll('.kbw-mig-row'));
      eq(rows.length, plan0.count, '列出的行数 = 预演篇数');
      contains(H.textOf(h.body), '待你定', '标题要说明有多少处要人定');
      ok(h.body.querySelectorAll('.kbw-mig-field').length > 0, '该有逐篇要定的下拉');
      // ⚠️ 断言「执行」按钮**真的没被禁用**：`setAttribute('disabled','false')` 会让它
      // 永久禁用（布尔属性在即为禁用），而 `H.click`（dispatchEvent）**不吃 disabled** → 假绿
      const run = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.kbw-btn')).find((b) =>
        H.textOf(b).startsWith('执行'),
      );
      ok(run, '有执行按钮');
      eq(run?.hasAttribute('disabled'), false, '有要改的时候按钮不许带 disabled 属性');
      eq(run?.disabled, false, '也不许是禁用态（.disabled 真值）');
      const allRec = Array.from(h.root.querySelectorAll('.kbw-btn')).find((b) => H.textOf(b) === '全部用推荐值');
      ok(allRec, '有「全部用推荐值」按钮');
      H.click(allRec as Element);
      await H.tick(50);
      eq(h.body.querySelectorAll('.kbw-mig-field').length, 0, '点了之后面板里不该还有待定的下拉');
      notContains(H.textOf(h.body), '待你定', '标题也不该再写「待你定」');
      // 引擎侧同一件事：把推荐值喂回去，预演必须不再要求确认
      const after = await previewMigration(app.vault, ctx().index.getAll(), {
        ...opts,
        choices: recommendedChoices(plan0),
      });
      eq(after.choiceCount, 0, '推荐值能把所有待定项解掉');
      ok(after.count > 0, '但篇数还在（还没执行）');
      h.close('test');
    });

    await suite.it('执行：确认流 → 快照 → 逐篇写 → 通知', async () => {
      purgeOverlays();
      const before = await ctx().snapshot.list();
      const h = openMigratePanel(ctx());
      const allRec = Array.from(h.root.querySelectorAll('.kbw-btn')).find((b) => H.textOf(b) === '全部用推荐值');
      H.click(allRec as Element);
      await H.tick(50);
      const runBtn = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.kbw-btn')).find((b) =>
        H.textOf(b).startsWith('执行'),
      );
      ok(runBtn, '找得到执行按钮');
      // ⚠️ 这里**故意走 `el.click()`**（元素自己的点击路径）：它在禁用时**不触发监听器**，
      // 所以"按钮被误禁用"这种 bug 会被这条用例抓住（`dispatchEvent` 抓不到）
      runBtn?.click();
      await H.tick(120);
      // 确认流（⚠️ 迁移面板自己也是 `.kbw-modal` → 取**最后一个**，别抓到面板）
      const modals = Array.from(document.querySelectorAll<HTMLElement>('.kbw-modal'));
      const modal = modals.reverse().find((m) => H.textOf(m).includes('即将改动'));
      ok(modal, '确认流该弹出来');
      contains(H.textOf(modal), '即将改动', '标题要带动作');
      const primary = Array.from(modal!.querySelectorAll('.kbw-btn')).find((b) => H.textOf(b).startsWith('改这'));
      ok(primary, '主按钮带数量');
      H.click(primary as Element);
      await H.settle(900);
      const after = await ctx().snapshot.list();
      ok(after.length === before.length + 1, '执行前拍了一份快照');
      const fresh = after[0];
      contains(fresh.reason, '属性迁移', '快照的 reason 写清是什么操作');
      // 通知上不该有失败（成功那句才带"已迁移"）
      contains(H.textsOf(document.body, '.kbw-notice').join(' || '), '已迁移', '成功后弹通知');
      notContains(H.textsOf(document.body, '.kbw-notice').join(' || '), '失败', '不该有失败项');
      snapIds = [fresh.id];
      // 日志按 mover 用例的同一套写法核（直接读盘；`report.recent()` 依赖内存树，桩里那条链不全）
      const logsAfter = H.listFiles(vaultRoot, '01_新知识库/99_Meta/05_操作日志');
      const logText = H.readNote(vaultRoot, `01_新知识库/99_Meta/05_操作日志/${logsAfter[logsAfter.length - 1]}`);
      contains(logText, '属性迁移', '日志里写清了这次是什么操作');
      h.close('test');
    });

    await suite.it('完成定义 ①：重跑预演 = 0 篇', async () => {
      await H.settleIndex(app);
      const plan = await preview();
      eq(plan.count, 0, `还有要改的：${plan.changes.map((c) => `${c.rel}(${c.summary})`).join(' | ')}`);
    });

    await suite.it('完成定义 ②：首页不再报「旧规范」；也没有外部改动假标', async () => {
      const plan = await preview();
      const todos = buildTodos(ctx().index.notes(), '00_Inbox', { migrateCount: plan.count });
      ok(!todos.some((t) => t.id === 'migrate'), '迁移那条该消失');
      // ⚠️ 反面也得验：整块没渲染时上面那条否定断言天然通过（假绿）。
      // `external-change` 那条还能抓住"模板写盘漏了 markSelfWrite" —— 独立审查实测：
      //  把 markSelfWrite 删掉，6 个模板会被判成外部改动，而当时用例全绿
      const flags = ctx().index.flagCounts();
      eq(flags['external-change'], 0, '迁移之后不该有「外部改动」（漏 markSelfWrite 就会冒出来）');
    });

    await suite.it('执行之后补丁全部落地，且再算就是 0 处（幂等）', async () => {
      for (const rel of PATCHED_RELS) {
        const text = H.readNote(vaultRoot, `01_新知识库/${rel}`);
        eq(pendingPatches(rel, text).length, 0, `${rel} 不该还有待打补丁`);
        eq(patchState(text, patchesOf(rel)[0]), 'done', '第一篇该是「已打」状态');
      }
      contains(
        H.readNote(vaultRoot, '01_新知识库/99_Meta/03_AI指令集/AI操作规范.md'),
        '已归档',
        'AI 规范里 `归档` → `已归档` 落地了',
      );
      contains(
        H.readNote(vaultRoot, '01_新知识库/99_Meta/01_仪表盘/知识库使用指南.md'),
        '（类型/领域/状态）',
        '使用指南里的字段清单落地了',
      );
    });

    await suite.it('真数据上的 v2 修整整落了盘（不是只有合成用例钉着）', async () => {
      // 9.16 那批（旧「生活健康」领域）：v2 里领域**整个删掉**
      for (const rel of [
        '00_Inbox/9.16.md',
        '02_Areas/每日任务/2026-09-08 任务.md',
        '02_Areas/每日任务/2026-09-09 任务.md',
        '02_Areas/每日任务/2026-09-10 任务.md',
      ]) {
        const fm = parseFrontmatter(H.readNote(vaultRoot, `01_新知识库/${rel}`)) ?? {};
        ok(!('领域' in fm), `${rel} 的「领域」该删掉（v2 退役）`);
        eq(fm['类型'], '任务', `${rel} 类型收拢为 任务`);
      }
      // 正文修整落了盘：执行中1 的尾链是新序
      const exec1 = H.readNote(vaultRoot, '01_新知识库/01_Projects/01_执行中/执行中1.md');
      notContains(exec1, '- 相关：', '旧标签「相关：」没了');
      notContains(exec1, '- 返回 [[', '旧标签「返回 [[」没了');
      contains(exec1, '- 相关笔记：[[]]', '新标签「相关笔记」在');
      contains(exec1, '- 返回大地图 [[', '新标签「返回大地图」在');
      ok(
        exec1.indexOf('- 相关笔记：[[]]') < exec1.indexOf('- 所属中心：'),
        '新序：相关笔记在所属中心之前',
      );
      // 未锈铠的 📌 行没了、尾链也在
      const rust = H.readNote(vaultRoot, '01_新知识库/02_Areas/内容创作/未锈铠.md');
      notContains(rust, '📌', '📌 页脚行删掉');
      contains(rust, '- 返回大地图 [[', '尾链改字');
      const tpl = H.readNote(vaultRoot, '01_新知识库/99_Meta/02_模板库/Templater/T_项目笔记.md');
      contains(tpl, '类型: 模板', '模板类型 = 模板');
      notContains(tpl, '阶段:', '阶段 删掉');
      eq(
        verifyTemplateText(tpl, 'T_项目笔记').join('、'),
        '',
        '模板改完自检要过（含值域检查）',
      );
    });

    await suite.it('落盘核对：旧键真没了、新值真在（直接读文件，不靠索引）', async () => {
      const files = [
        '01_新知识库/99_Meta/03_AI指令集/AI操作规范.md', // 中文键「标签」那篇
        '01_新知识库/99_Meta/05_操作日志/2026-09-18 1615 笔记自动化·一键补全.md', // 类型: 操作日志 + 状态: 已整理
        '01_新知识库/02_Areas/内容创作/示例_小红书图文.md', // 3-撰写中 + 聚焦
        '01_新知识库/01_Projects/01_执行中/执行中1.md', // 项目笔记 → 类型收拢 + 尾链重排
      ];
      for (const f of files) {
        const fm = parseFrontmatter(H.readNote(vaultRoot, f)) ?? {};
        for (const k of ['主题', '标签', '仅显示于', '聚焦', '领域']) {
          ok(!(k in fm), `${f} 不该还有「${k}」`);
        }
      }
      const fm1 = parseFrontmatter(H.readNote(vaultRoot, files[0])) ?? {};
      deepEq(fm1['tags'], ['AI', '规范', 'Copilot', '构建逻辑'], '中文键「标签」并进 tags');
      const fm2 = parseFrontmatter(H.readNote(vaultRoot, files[1])) ?? {};
      eq(fm2['类型'], '日志', '类型收拢');
      eq(fm2['状态'], '已完成', '「已整理」+ 日志 → 已完成（逐篇确认的推荐值）');
      const fm3 = parseFrontmatter(H.readNote(vaultRoot, files[2])) ?? {};
      eq(fm3['状态'], '进行中', '3-撰写中 → 进行中（v2：不拆发布进度）');
      ok(!('发布进度' in fm3), '发布进度该删');
      const fm4 = parseFrontmatter(H.readNote(vaultRoot, files[3])) ?? {};
      eq(fm4['类型'], '笔记', '项目笔记 → 笔记');
      eq(JSON.stringify(fm4['tags']), JSON.stringify(['项目']), 'tags 里的「项目」不再被清（v2：用户自管）');
    });

    await suite.it('模板也落了盘（正文里的 YAML 段 + 尾链新序 + 📌 清掉）', async () => {
      const t = H.readNote(vaultRoot, '01_新知识库/99_Meta/02_模板库/Templater/T_内容作品.md');
      notContains(t, '主题:', '模板里的主题该删');
      notContains(t, '领域:', '模板里的领域该删');
      notContains(t, '发布进度:', '模板里的发布进度该删');
      notContains(t, '📌', '模板里的 📌 页脚行也删');
      contains(t, '类型: 模板', '模板类型 = 模板');
      contains(t, '- 返回大地图 [[', '模板尾链改字');
      const t2 = H.readNote(vaultRoot, '01_新知识库/99_Meta/02_模板库/Templater/T_领域笔记.md');
      contains(t2, '类型: 模板', '模板类型收拢');
      notContains(t2, '领域:', '领域删掉');
    });

    await suite.it('撤销条：点「撤销」还原 → 旧键回来、新键撤掉', async () => {
      const id = snapIds[0];
      ok(id, '有快照 id');
      // 走界面（撤销条上的按钮），不是直接调 API —— 这条链才是用户真会用的
      /**
       * ⚠️ **P7.19 收编**（独立审查 🟡3 指出）：原来是
       * `document.querySelector('.kbw-undobar .kbw-btn.is-primary')` —— **裸查询、按文档顺序取第一个**，
       * 命中的很可能是上一条用例留下的**离场中孤儿条**（B1 那只虫的测试侧根因，与已收编的 13 处同族）。
       * 改用 `H.currentUndoButton('撤销')`：取**最后一条且非离场**的。
       */
      const undoBtn = H.currentUndoButton('撤销');
      ok(undoBtn, '撤销条该在（执行成功之后 5 秒内）');
      H.click(undoBtn as Element);
      await H.settle(900);
      await H.settleIndex(app);
      const fm = parseFrontmatter(H.readNote(vaultRoot, '01_新知识库/02_Areas/内容创作/示例_小红书图文.md')) ?? {};
      eq(fm['聚焦'], true, '「聚焦」回来了');
      eq(fm['领域'], '内容创作', '「领域」回来了（还原 = 快照整份写回）');
      eq(fm['状态'], '3-撰写中', '状态也回到迁移前的流水线值');
      const plan = await preview();
      ok(plan.count > 0, '还原之后预演又该有要改的');
      // 收尾：把快照删掉，别给后面的用例留残渣
      await ctx().snapshot.remove(id);
    });
  });
}
