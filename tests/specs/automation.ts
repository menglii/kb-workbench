/**
 * spec：P3 · 自动化（新建补全 / 自动归位 / 模板库 / 目录映射 / 存量补全）
 *
 * 分三层，从便宜到贵：
 *   A. **纯函数**（占位符渲染 / 填什么 / 路由表 / 体检 / 自动归位的计划）
 *      —— 这一层不需要库，是"判据"本身
 *   B. **真链路**（在真数据副本上新建一篇 → 补全 → 幂等；改 `文件位置` → 自动归位）
 *   C. **界面**（设置面板七栏能开、目录映射栏能存、存量补全面板扫描是只读的）
 *
 * ⚠️ 数据源是 `BASE_KB`（**迁移后**的那份）：P3 的功能都建在"属性已经统一"之上。
 */
import path from 'node:path';
import fs from 'node:fs';
import type { TFile } from 'obsidian';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
// ⑧-C：断言「问 AI」真的走了那条链路（读它发出去的请求体）
import { requestLog } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { __resetNotices } from '../../src/ui/notify';
import {
  PLACEHOLDERS,
  buildFillPlan,
  buildYaml,
  extractTemplate,
  firstHeading,
  hasTailSection,
  hasTemplaterSyntax,
  isInteractiveTemplate,
  isTemplaterManaged,
  folderTemplateFor,
  parseStaticFrontmatter,
  renderPlaceholders,
  tailSection,
  templateFileName,
  type NoteContext,
} from '../../src/services/templates';
import {
  checkRoutes,
  defaultRouteTable,
  dirRelOf,
  normalizeRouteTable,
  vaultPathOf,
  aliasDirs,
  tagDirs,
  type RouteTable,
} from '../../src/services/routes';
import { isExcluded, mergeSeen, planReconcile, snapshotDeclared } from '../../src/services/reconcile';
import { describeItem, inBackfillScope, planBackfill, countPlan } from '../../src/services/backfill';
import { normalizeAutomation, AUTO_DEFAULTS } from '../../src/services/automation';
import { isRecentSelfWrite } from '../../src/core/writes';
import { openNewNoteDialog } from '../../src/ui/new-note';
import { __escapeLabels } from '../../src/core/keymap';
import type { NoteEntry } from '../../src/core/vault-index';

const KB = '01_新知识库';

/** 造一个 NoteEntry（纯函数层用，不碰库） */
function entry(pathStr: string, props: Record<string, unknown>, basename?: string): NoteEntry {
  const rel = pathStr.startsWith(`${KB}/`) ? pathStr.slice(KB.length + 1) : pathStr;
  const parts = rel.split('/');
  const name = basename ?? (parts.pop() ?? '').replace(/\.md$/, '');
  const dir = parts.join('/');
  return {
    file: { path: pathStr, basename: name } as TFile,
    props,
    flags: [],
    effectivePosition: dir,
    path: pathStr,
    basename: name,
    isTemplate: false,
    mtime: 0,
    size: 10,
  };
}

const ctx0: NoteContext = {
  title: '示例笔记',
  date: '2026-09-24',
  folderRel: '02_Areas/内容创作',
  kbRoot: KB,
  center: `[[${KB}/02_Areas/_领域中心]]`,
  moc: `[[${KB}/99_Meta/04_索引与地图/MOC_知识地图]]`,
};

export async function specAutomation(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 模板渲染（纯函数）', async () => {
    await suite.it('6 个占位符：求得到的替换、求不到的**原样留着**', () => {
      eq(PLACEHOLDERS.length, 6, '占位符就是 6 个');
      const r = renderPlaceholders(
        '{{title}} @ {{date}} in {{folder}} -> {{center}} / {{moc}} / {{kb}}',
        ctx0,
      );
      eq(r.unresolved.length, 0, '这一套都求得到');
      contains(r.text, '示例笔记');
      contains(r.text, '2026-09-24');
      contains(r.text, '02_Areas/内容创作');
      contains(r.text, 'MOC_知识地图');

      // 中心页求不到（库根下没有 `_` 开头的文件）→ 原样留着，不清空
      const bare: NoteContext = { ...ctx0, center: '' };
      const r2 = renderPlaceholders('中心：{{center}}', bare);
      eq(r2.text, '中心：{{center}}', '求不到就原样留（看得见才好修）');
      deepEq(r2.unresolved, ['{{center}}'], '并且要报出来是哪几个');

      // 写错的占位符（`{{标题}}`）不在这 6 个里 → 一个字都不动
      eq(renderPlaceholders('{{标题}}', ctx0).text, '{{标题}}', '没登记过的占位符不猜');
    });

    await suite.it('Templater 分工：`<% %>` 判定 / 交互式模板 / 目录接管', () => {
      ok(hasTemplaterSyntax('a <% tp.date.now() %> b'), '认出 <% %>');
      ok(!hasTemplaterSyntax('a {{date}} b'), '{{}} 不算 Templater 语法');
      ok(isInteractiveTemplate('<%* await tp.system.prompt("名字") %>'), 'prompt 是交互式');
      ok(isInteractiveTemplate('<%* await tp.system.suggester(a,b) %>'), 'suggester 是交互式');
      ok(!isInteractiveTemplate('<% tp.date.now("YYYY-MM-DD") %>'), '取日期不是交互式');

      const tp = {
        present: true,
        triggerOnCreate: true,
        folderTemplates: true,
        rules: [
          { folder: `${KB}/02_Areas`, template: `${KB}/tpl/领域.md` },
          { folder: `${KB}/02_Areas/每日任务`, template: `${KB}/tpl/每日.md` },
        ],
        templatesFolder: `${KB}/tpl`,
      };
      eq(isTemplaterManaged(tp, `${KB}/02_Areas/内容创作`), true, '父目录规则命中 = 接管');
      eq(isTemplaterManaged(tp, `${KB}/00_Inbox`), false, '没有规则 = 不接管');
      // 三个条件缺一不可
      eq(isTemplaterManaged({ ...tp, triggerOnCreate: false }, `${KB}/02_Areas`), false, '关掉"新建时触发" = 不接管');
      eq(isTemplaterManaged({ ...tp, present: false }, `${KB}/02_Areas`), false, '没装 Templater = 不接管');
    });

    await suite.it('尾部双链段：中心页求不到就少一行，不写空链', () => {
      const t = tailSection(ctx0);
      contains(t, '## 关联笔记');
      contains(t, '所属中心');
      ok(!t.includes('[[]]\n- 返回') || t.includes('相关：[[]]'), '「相关」那行留空是模板本来的形状');
      const noCenter = tailSection({ ...ctx0, center: '' });
      ok(!noCenter.includes('所属中心'), '中心页求不到就不写那一行');
      ok(noCenter.includes('MOC'), '返回 MOC 还在');
      ok(hasTailSection('## 关联笔记\n- x'), '识别已有的尾链段（幂等的判据）');
      ok(!hasTailSection('# 标题\n正文'), '没有就是没有');
    });

    await suite.it('从笔记提取模板：占位化（H1 → {{title}}、创建日期 → "{{date}}"）', () => {
      const src = `---\n类型: 笔记\n创建日期: 2026-09-01\ntags: []\n---\n\n# 我的标题\n\n正文\n`;
      const r = extractTemplate(src);
      contains(r.text, '# {{title}}');
      // v2 · #6①：占位符**带引号存**（裸占位符是 YAML 流式映射，属性往返会被写坏）
      contains(r.text, '创建日期: "{{date}}"');
      contains(r.text, '类型: 模板', '提取出的模板：类型 = 模板');
      contains(r.text, '正文', '正文一个字不动');
      eq(r.replaced.length, 3, '三处占位化（H1 / 创建日期 / 类型）');
      // 幂等：再抽一次不该再动（也不该变成 {{title}} 套 {{title}}）
      const again = extractTemplate(r.text);
      eq(again.replaced.length, 0, '已经占位化过的不再动');
      eq(templateFileName('我的模板'), 'T_我的模板.md');
      eq(templateFileName('T_x.md'), 'T_x.md', '已带前缀不重复加');
      eq(firstHeading('# 甲\n# 乙'), '甲');
    });

    await suite.it('模板里的静态前言：数组/映射不抄，`<% %>` 的值保留原样（由调用方判）', () => {
      // ⚠️ 用**真实形状**：Templater 脚本块最后一个 `%>` 与该行 `---` 贴在一起
      // （模板库里 6 个模板都是 `%>---`；只认整行 `---` 会把结束那个当起始 —— P2 踩过）
      const tpl = `<%*\nconst x = 1;\n%>---\n类型: 内容作品\n状态: 进行中\n发布进度: 1-灵感\ntags: [a, b]\n创建日期: <% today %>\n---\n`;
      const fm = parseStaticFrontmatter(tpl);
      eq(fm['类型'], '内容作品');
      eq(fm['状态'], '进行中');
      eq(fm['发布进度'], '1-灵感');
      eq(fm['tags'], undefined, '列表值不抄（那是"这一篇"的标签，不是模板形状）');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 填什么（新建补全与存量补全共用的判据）', async () => {
    const tplText = `---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-01-01\ntags: []\n---\n\n# {{title}}\n\n正文骨架\n`;

    await suite.it('空白笔记 → 套整套模板（占位符已替换）', () => {
      const plan = buildFillPlan('', { ctx: ctx0, templateText: tplText, templatePath: 'x/T_a.md' });
      eq(plan.kind, 'template', '空白走 template 分支');
      if (plan.kind === 'template') {
        contains(plan.text, '# 示例笔记', '{{title}} 换成了文件名');
        ok(!plan.text.includes('{{title}}'), '不该留下没换的占位符');
      }
    });

    await suite.it('模板含 `<% %>` 且没求值 → **跳过不动手**（不把模板语法写进笔记）', () => {
      const plan = buildFillPlan('', {
        ctx: ctx0,
        templateText: '---\n类型: 想法\n---\n\n# <% tp.file.title %>\n',
        templatePath: 'x/T_b.md',
      });
      eq(plan.kind, 'skip');
      if (plan.kind === 'skip') contains(plan.why, 'Templater');
    });

    await suite.it('正文里残留 `<% %>` → 不碰（谁写的谁负责）', () => {
      const plan = buildFillPlan('---\n类型: 想法\n---\n\n# 甲\n<% tp.date.now() %>\n', {
        ctx: ctx0,
        templateText: tplText,
        templatePath: 'x/T_a.md',
      });
      eq(plan.kind, 'skip');
    });

    await suite.it('有正文 → 只在两头补；都齐了 → `none`（幂等的判据）', () => {
      // ① 前言 + 尾链都在 → 什么都不做（**幂等就靠这一条**）
      const complete =
        '---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-01-01\ntags: []\n---\n\n# 甲\n\n有正文\n\n## 关联笔记\n- 返回大地图 [[x]]\n';
      const done = buildFillPlan(complete, { ctx: ctx0, templateText: tplText, templatePath: 'x/T_a.md' });
      eq(done.kind, 'none', `已经完整 → 什么都不做（实际 ${done.kind}）`);

      // ② 缺尾链：只补尾
      const body = `${complete.split('\n## 关联笔记')[0]}\n`;
      const noTail = body.replace(/\n$/, '');
      const p2 = buildFillPlan(noTail, {
        ctx: ctx0,
        templateText: tplText,
        templatePath: 'x/T_a.md',
      });
      eq(p2.kind, 'patch');
      if (p2.kind === 'patch') {
        eq(p2.yaml, undefined, '前言齐了就不补前言');
        ok(p2.tail, '补尾链');
        contains(p2.tail as string, '## 关联笔记');
      }

      // 缺前言（只有正文）：补 YAML，且**不碰正文**
      const p3 = buildFillPlan('就是一段裸正文\n', {
        ctx: ctx0,
        templateText: tplText,
        templatePath: 'x/T_a.md',
      });
      eq(p3.kind, 'patch');
      if (p3.kind === 'patch') {
        ok(p3.yaml, '补前言');
        contains(p3.yaml as string, '类型: 笔记', '类型按模板抄（v2 值域）');
        ok(p3.tail, '尾链也补');
      }
    });

    await suite.it('目录被 Templater 接管 → 让位（正文一个字不碰）', () => {
      const plan = buildFillPlan('', {
        ctx: ctx0,
        templateText: tplText,
        templatePath: 'x/T_a.md',
        managed: true,
      });
      eq(plan.kind, 'skip');
      if (plan.kind === 'skip') contains(plan.why, 'Templater');
    });

    await suite.it('YAML v2：类型/状态 = 模板静态前言优先、目录默认兜底；**不写「领域」**；新建写「文件位置」', () => {
      // ① 模板没给类型/状态 → 按目录默认（#4 那张表）；新建（withPosition）写「文件位置」= 所在目录
      const built = buildYaml({
        ctx: { ...ctx0, folderRel: '01_Projects/01_执行中' },
        templateText: null,
        templatePath: '',
        withPosition: true,
        ctime: Date.parse('2026-03-05T10:00:00'),
      });
      const y = built.text ?? '';
      contains(y, '类型: 笔记', '按目录默认（01_Projects → 笔记）');
      contains(y, '状态: 进行中', '按目录默认（01_Projects → 进行中）');
      contains(y, '文件位置:', '新建写「文件位置」');
      contains(y, '  - 01_Projects/01_执行中', '值 = 所在目录（相对库根）');
      contains(y, '创建日期: 2026-03-05', '老笔记用它的创建时间，不是今天');
      contains(y, 'tags: []');
      ok(!y.includes('领域'), 'v2 不写「领域」');
      ok(!y.includes('<%'), '不带任何 Templater 语法');

      // ② 模板静态前言的值合法 → 照用；`类型: 模板` 是模板文件自己的类型 → 按目录默认换算
      const viaTpl = buildYaml({
        ctx: { ...ctx0, folderRel: '02_Areas' },
        templateText: '---\n类型: 模板\n状态: 已完成\n---\n',
        templatePath: 'x/T_a.md',
      });
      const y2 = viaTpl.text ?? '';
      contains(y2, '类型: 笔记', '模板给的是「模板」→ 按目录默认换算');
      contains(y2, '状态: 已完成', '模板给的合法状态照用');

      // ③ 存量补全（不传 withPosition）**不写**「文件位置」（声明 == 实际会让它退出"待整理"）
      const noPos = buildYaml({ ctx: ctx0, templateText: null, templatePath: '' });
      ok(!(noPos.text ?? '').includes('文件位置'), '存量补全不写「文件位置」');
      // ④ 00_Inbox 不写状态（"还在 Inbox"本身就是待整理）
      const inbox = buildYaml({ ctx: { ...ctx0, folderRel: '00_Inbox' }, templateText: null, templatePath: '' });
      contains(inbox.text ?? '', '类型: 笔记');
      ok(!(inbox.text ?? '').includes('状态'), '00_Inbox 不写状态');
    });

    /**
     * P7.13a · #0 · Q0：**六件口径** —— `收藏: false` 跟着 `withPosition` 走
     * （新建即配置写它；存量补全不写 —— 与「文件位置」同一条闸）。
     */
    await suite.it('六件口径（P7.13a · #0）：`收藏: false` 只在新建路（withPosition）写', () => {
      const neu = buildYaml({ ctx: ctx0, templateText: null, templatePath: '', withPosition: true });
      contains(neu.text ?? '', '收藏: false', '新建即配置：六件口径');
      const old = buildYaml({ ctx: ctx0, templateText: null, templatePath: '' });
      ok(!(old.text ?? '').includes('收藏'), '存量补全不写收藏（与「文件位置」同一条闸）');
    });

    /**
     * 🔴 P7.13a · #2（Q4 拍定）：套用模板后的组装 —— **正文保真 + YAML 缺哪补哪 +
     * 类型/状态按目录默认优先**。夹具 = #1 拍定的骨架（六键 + 尾链三行占位符）。
     */
    const skeletonText = [
      '---',
      '类型: 模板',
      '状态:',
      '文件位置:',
      '  - 99_Meta/02_模板库/Templater',
      '创建日期: "{{date}}"',
      'tags: []',
      '收藏: false',
      '---',
      '',
      '# {{title}}',
      '',
      '## 关联笔记',
      '- 相关笔记：[[]]',
      '- 所属中心：{{center}}',
      '- 返回大地图 {{moc}}',
      '',
    ].join('\n');

    await suite.it('套用补齐（P7.13a · #2）：六件缺哪补哪 · 目录默认优先 · 文件位置=所在目录 · 尾链求不到的行整行删', () => {
      const p = buildFillPlan('', {
        // 中心/地图都求不到 → 尾链那两行该被整行删
        ctx: { ...ctx0, folderRel: '01_Projects/01_执行中', center: '', moc: '' },
        templateText: skeletonText,
        templatePath: 'x/T_样例-会议记录.md',
        withPosition: true,
        ctime: Date.parse('2026-03-05T10:00:00'),
      });
      eq(p.kind, 'template', '空白 + 无前言 → template 分支');
      if (p.kind === 'template') {
        contains(p.text, '类型: 笔记', '模板写死的「模板」→ 按目录默认换算（模板值不采用）');
        contains(p.text, '状态: 进行中', '状态：目录有默认 → 覆盖模板的空值');
        ok(
          p.text.includes('文件位置:\n  - 01_Projects/01_执行中'),
          '文件位置 = 所在目录（新建路；模板里指向模板库的旧值被换掉）',
        );
        contains(p.text, '创建日期: "2026-09-24"', '模板已写的键原样保留（渲染后的引号存法）');
        contains(p.text, 'tags: []', '已有键保留');
        contains(p.text, '收藏: false', '已有键保留（六件口径）');
        contains(p.text, '# 示例笔记', '正文保真：标题渲染进去了');
        contains(p.text, '- 相关笔记：[[]]', '有值的那行在');
        ok(!p.text.includes('所属中心') && !p.text.includes('返回大地图'), '求不到的行整行删');
        ok(!p.text.includes('{{'), '不留没求值的占位符（都被处理了）');
        deepEq(p.pruned, ['{{center}}', '{{moc}}'], '删走的是哪几个要报出来（与"原样留着"分开）');
        deepEq(p.unresolved, [], '没有被"原样留着"的');
      }
    });

    await suite.it('套用补齐（P7.13a · #2）：目录没默认 → 沿用模板原值；缺的键按 ctime 补；尾链缺就补标准三行', () => {
      const p = buildFillPlan('', {
        ctx: { ...ctx0, folderRel: '00_Inbox' },
        // ⚠️ 模板**自带** `文件位置`（指向模板库）——存量路要把它删掉，不许照抄（独立审 🟡3）
        templateText:
          '---\n类型: 日志\n状态: 已完成\n文件位置:\n  - 99_Meta/02_模板库/Templater\n---\n\n正文\n',
        templatePath: 'x/T_b.md',
        ctime: Date.parse('2026-03-05T10:00:00'),
      });
      eq(p.kind, 'template');
      if (p.kind === 'template') {
        contains(p.text, '类型: 笔记', 'Inbox 的类型有默认 → 覆盖模板的「日志」（模板写死的值不采用）');
        contains(p.text, '状态: 已完成', 'Inbox 没有状态默认 → **沿用模板原值**（不删作者写的键）');
        contains(p.text, '创建日期: 2026-03-05', '缺创建日期 → 落文件创建时间（不是今天）');
        contains(p.text, 'tags: []', '缺 tags → []');
        contains(p.text, '## 关联笔记', '整篇缺尾链段 → 补标准三行');
        contains(p.text, `- 所属中心：${ctx0.center}`, '中心页求得到就写那一行');
        ok(
          !p.text.includes('文件位置') && !p.text.includes('收藏'),
          '存量路（无 withPosition）：不写这两键，**模板自带的那份也删掉**（照抄模板库的值 = 给存量笔记盖错声明）',
        );
        contains(p.text, '正文', '正文保真');
      }
    });

    await suite.it('套用补齐（P7.13a · #2 · 独立审 🟡2）：正文里的 `---` 不算前言 —— 整套前言现拼在正文前', () => {
      // 手写模板"节间画线 + 尾链前那条线"的形状：没有前言、正文里两条 `---`
      const tpl = '# {{title}}\n\n---\n\n正文在这里\n\n---\n\n## 关联笔记\n- 相关笔记：[[]]\n';
      const p = buildFillPlan('', {
        ctx: { ...ctx0, folderRel: '01_Projects/01_执行中' },
        templateText: tpl,
        templatePath: 'x/T_无前言.md',
        withPosition: true,
      });
      eq(p.kind, 'template');
      if (p.kind === 'template') {
        ok(p.text.startsWith('---\n'), '第 1 行就是前言围栏（不是把六键合并进正文中段 —— 那样前言整块作废）');
        contains(p.text, '类型: 笔记', '六件现拼（按目录默认）');
        contains(p.text, '正文在这里', '正文保真');
        contains(p.text, '## 关联笔记', '模板自带的尾链段照在');
      }
    });

    await suite.it('套用补齐（P7.13a · #2 · 独立审 🟡4）：键写成块列表的形状也正确置换（不留坏 YAML）', () => {
      const p = buildFillPlan('', {
        ctx: { ...ctx0, folderRel: '00_Inbox' },
        templateText: '---\n类型:\n  - 笔记\n状态: 待办\n---\n\n正文\n',
        templatePath: 'x/T_块值.md',
      });
      eq(p.kind, 'template');
      if (p.kind === 'template') {
        contains(p.text, '类型: 笔记', '块值形状（键 + 缩进 `- x`）被整体换成目录默认');
        ok(!p.text.includes('  - 笔记'), '旧值行不许残留（键行下面挂着 `  - x` = YAML 直接坏）');
      }
    });

    await suite.it('套用补齐（P7.13a · #2）：「模板」字面 + 目录没默认可换算 → 删键（别漏进新笔记）', () => {
      const p = buildFillPlan('', {
        ctx: { ...ctx0, folderRel: '09_临时' },
        templateText: '---\n类型: 模板\n---\n\n正文\n',
        templatePath: 'x/T_c.md',
      });
      eq(p.kind, 'template');
      if (p.kind === 'template') {
        ok(!p.text.includes('类型'), '「模板」是模板文件自己的标记：没默认可换算就删键');
        contains(p.text, '正文', '正文保真');
      }
    });

    await suite.it('开关拆两层（P7.13a · #2 · Q6）：`bare` = 只落模板原文（不补六件与尾链）', () => {
      const p = buildFillPlan('', {
        // 中心/地图也求不到：求不到的占位符在 bare 路**原样留**（不修剪、不补尾链）
        ctx: { ...ctx0, folderRel: '01_Projects/01_执行中', center: '', moc: '' },
        templateText: skeletonText,
        templatePath: 'x/T_样例-会议记录.md',
        withPosition: true,
        bare: true,
      });
      eq(p.kind, 'template');
      if (p.kind === 'template') {
        eq(p.bare, true, '带上了"只落原文"的标记（通知文案要说实话）');
        contains(p.text, '类型: 模板', '开关关着：字面「模板」**不换算**（一个字符不加不删）');
        ok(p.text.includes('  - 99_Meta/02_模板库/Templater'), '文件位置不换（还是模板里那个值）');
        ok(p.text.includes('收藏: false'), '模板自带的键照落');
        ok(p.text.includes('## 关联笔记'), '模板自带的尾链照落');
        contains(p.text, '- 所属中心：{{center}}', '求不到的占位符**原样留**（§7.1 老纪律）');
      }
      // 同一个模板、目录里没有尾链的样子：bare 不补尾链（补齐归开关）
      const p2 = buildFillPlan('', {
        ctx: ctx0,
        templateText: '---\n类型: 模板\n创建日期: "{{date}}"\n---\n\n# {{title}}\n',
        templatePath: 'x/T_d.md',
        withPosition: true,
        bare: true,
      });
      eq(p2.kind, 'template');
      if (p2.kind === 'template') {
        ok(!p2.text.includes('## 关联笔记'), 'bare：缺尾链也不补（那是开关管的那半截）');
        ok(!p2.text.includes('收藏'), 'bare：不补六件套');
        contains(p2.text, '# 示例笔记', '但正文照渲染（套用本身不受开关管）');
      }
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 目录映射（路由表 + 体检，纯函数）', async () => {
    await suite.it('路径口径：相对库根 ↔ 库内绝对，两种写法都认', () => {
      eq(vaultPathOf('02_Areas/内容创作', KB), `${KB}/02_Areas/内容创作`);
      eq(vaultPathOf(`${KB}/02_Areas/内容创作`, KB), `${KB}/02_Areas/内容创作`, '已是绝对的别再加一层');
      eq(dirRelOf(`${KB}/02_Areas/内容创作`, KB), '02_Areas/内容创作');
      eq(dirRelOf('02_Areas/内容创作', KB), '02_Areas/内容创作', '手写的相对值也认');
      eq(vaultPathOf('', KB), KB, '空 = 库根自己');
    });

    await suite.it('读表：注释键保留、非字符串丢弃、缺段补空', () => {
      const raw = {
        _说明: '给人看的',
        _用法: '用法',
        标签: { 收件箱: `${KB}/00_Inbox`, 坏的: 42 },
        领域: { 内容创作: `${KB}/02_Areas/内容创作`, 游戏研究: '  ' },
        领域兜底: `${KB}/02_Areas`,
        用户自己加的段: { a: 1 },
      };
      const t = normalizeRouteTable(raw);
      eq(t._说明, '给人看的', '注释键要在');
      eq(t.标签['坏的'], undefined, '非字符串值丢掉（不是数字就是坏表）');
      eq(t.领域['游戏研究'], undefined, '全空白也不要');
      eq(t['领域兜底'], `${KB}/02_Areas`);
      deepEq(Object.keys(t.标签), ['收件箱']);
    });

    await suite.it('表是唯一真源：表里有就有、没有就没有（v2：不再有内置兜底表）', () => {
      const t: RouteTable = { 标签: {}, 领域: { 内容创作: `${KB}/09_搬到别处` } };
      const dirs = aliasDirs(t, KB);
      eq(dirs['内容创作'], '09_搬到别处', '表里的值说了算');
      eq(dirs['游戏研究'], undefined, '表里没有的就没有（目录末段名由启发层另推，不在这里铺底）');
      const t2: RouteTable = {
        标签: { 收件箱: `${KB}/00_Inbox` },
        领域: {},
      };
      eq(tagDirs(t2, KB)['收件箱'], '00_Inbox');
    });

    await suite.it('体检三类：目录不存在 / 重复落点 / 兜底目录（v2：值域检查随领域退役删除）', () => {
      const exists = (p: string): boolean => p !== `${KB}/不存在`;
      const t: RouteTable = {
        标签: { a: `${KB}/00_Inbox`, b: `${KB}/00_Inbox` },
        领域: { 内容创作: `${KB}/不存在`, 任意关键词: `${KB}/00_Inbox` },
        领域兜底: `${KB}/02_Areas`,
      };
      const issues = checkRoutes(t, { exists, kbRoot: KB });
      const msgs = issues.map((i) => i.msg).join('\n');
      contains(msgs, '目录不存在', '① 目录不在库里');
      contains(msgs, '重复落点', '② 两个键指同一个目录');
      ok(
        issues.some((i) => i.level === 'error'),
        '至少有一条是 error（目录不存在）',
      );
      // 干净的表不该报错
      const clean = checkRoutes(defaultRouteTable(KB), { exists: () => true, kbRoot: KB });
      eq(clean.filter((i) => i.level === 'error').length, 0, '默认表没有 error');
    });

  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 自动归位（只有显式改「文件位置」才搬）', async () => {
    await suite.it('排除项：路径前缀 / 任意一段 / `.开头` 特例', () => {
      const ex = AUTO_DEFAULTS.reconcile.exclude;
      eq(isExcluded('99_Meta/05_操作日志/x.md', ex), true);
      eq(
        isExcluded('02_Areas/还原保留-20260924-120000/x.md', ex),
        true,
        '任意一段命中就算排除（快照还原建的目录名带时间戳，所以按"段/前缀"匹配）',
      );
      eq(isExcluded('.hidden/x.md', ex), true, '`.开头` 是特例');
      eq(isExcluded('02_Areas/内容创作/x.md', ex), false);
    });

    await suite.it('计划：改了才搬；没改不动；第一次见**只登记不搬**', () => {
      const opts = { kbRoot: KB, exclude: [], dirs: new Set(['00_Inbox', '02_Areas/内容创作']) };
      const a = entry(`${KB}/00_Inbox/a.md`, { 文件位置: '00_Inbox' });
      const b = entry(`${KB}/00_Inbox/b.md`, { 文件位置: '02_Areas/内容创作' });

      // 第一次见（seen 里没有）→ 什么都不做
      const p0 = planReconcile([a, b], {}, opts);
      eq(p0.moves.length, 0, '第一次见不搬（否则开插件就等于全库大搬家）');

      // 声明与上次一样 → 不搬
      const seen = snapshotDeclared([a, b]);
      const p1 = planReconcile([a, b], seen, opts);
      eq(p1.moves.length, 0, '没改过就不动');

      // 改了 a 的声明（00_Inbox → 02_Areas/内容创作）→ 搬
      const a2 = entry(`${KB}/00_Inbox/a.md`, { 文件位置: '02_Areas/内容创作' });
      const p2 = planReconcile([a2, b], seen, opts);
      eq(p2.moves.length, 1, '改了声明的那一篇要搬');
      eq(p2.moves[0].to, '02_Areas/内容创作/a.md');
    });

    await suite.it('**位置锁定不拦**（v2 · #12：显式=手动语义）；目标目录不存在也不搬', () => {
      const seen = { [`${KB}/00_Inbox/a.md`]: ['00_Inbox'] };
      const locked = entry(`${KB}/00_Inbox/a.md`, { 文件位置: '02_Areas/内容创作', 位置锁定: true });
      const p = planReconcile([locked], seen, {
        kbRoot: KB,
        exclude: [],
        dirs: new Set(['00_Inbox', '02_Areas/内容创作']),
      });
      eq(p.moves.length, 1, '锁了也搬（显式改 = 显式意图，锁定不拦这条路）');
      eq(p.moves[0].to, '02_Areas/内容创作/a.md');

      const ghost = entry(`${KB}/00_Inbox/a.md`, { 文件位置: '99_没建的目录' });
      const p2 = planReconcile([ghost], seen, { kbRoot: KB, exclude: [], dirs: new Set(['00_Inbox']) });
      eq(p2.moves.length, 0, '目标目录不存在 -> 不自动建、不搬');
      contains(p2.skips[0].why, '不建目录');
    });

    await suite.it('声明改成留空 = 取消声明，不是"搬到库根"', () => {
      const seen = { [`${KB}/00_Inbox/a.md`]: ['02_Areas/内容创作'] };
      const cleared = entry(`${KB}/00_Inbox/a.md`, { 文件位置: [] });
      const p = planReconcile([cleared], seen, {
        kbRoot: KB,
        exclude: [],
        dirs: new Set(['00_Inbox', '02_Areas/内容创作']),
      });
      eq(p.moves.length, 0);
      eq(p.skips.length, 0, '清空不算"跳过"，就是没声明了');
    });

    await suite.it('seen 合并：新增/删除/改值都能看出来，没变就返回 false（不写盘）', () => {
      const a = entry(`${KB}/00_Inbox/a.md`, { 文件位置: ['00_Inbox'] });
      const m0 = mergeSeen({}, [a]);
      eq(m0.changed, true, '第一次登记算变化');
      const m1 = mergeSeen(m0.next, [a]);
      eq(m1.changed, false, '没变就不该写盘（否则每次索引动一下都写 data.json）');
      const a2 = entry(`${KB}/00_Inbox/a.md`, { 文件位置: ['02_Areas/内容创作'] });
      eq(mergeSeen(m0.next, [a2]).changed, true, '值变了要能看出来');
      eq(mergeSeen(m0.next, []).changed, true, '文件没了也要能看出来（顺手清理）');
    });

    await suite.it('设置形状：排除项是那四条；reconcile.enabled 键保留但已退役', () => {
      const a = normalizeAutomation(null);
      // ⚠️ v2（#12）：「自动归位开关」退役 —— 键还在（不动库内文件形状）、但不再被读
      eq(a.reconcile.enabled, false, '键保留（默认值照旧），语义已退役');
      eq(a.completion.enabled, true, '新建补全默认开（§7.1）');
      deepEq(a.reconcile.exclude, ['99_Meta', '02_旧知识库', '还原保留', '.开头']);
      const bad = normalizeAutomation({ completion: { enabled: 'yes' }, reconcile: { exclude: 'x' } });
      eq(bad.completion.enabled, true, '类型不对就退回默认（表被手改坏也不崩）');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 存量补全（计划是纯函数）', async () => {
    await suite.it('范围：库根之下，但**不碰 99_Meta 与模板库**', () => {
      const scope = { kbRoot: KB, metaRoot: `${KB}/99_Meta`, templateDir: `${KB}/99_Meta/02_模板库/Templater` };
      eq(inBackfillScope(entry(`${KB}/00_Inbox/a.md`, {}), scope), true);
      eq(inBackfillScope(entry(`${KB}/99_Meta/03_AI指令集/AI操作规范.md`, {}), scope), false, 'AI 指令集是红线文件');
      eq(inBackfillScope(entry(`${KB}/99_Meta/02_模板库/Templater/T_x.md`, {}), scope), false);
      const tpl = { ...entry(`${KB}/00_Inbox/T_x.md`, {}), isTemplate: true };
      eq(inBackfillScope(tpl, scope), false, '模板不参与存量补全');
      eq(inBackfillScope(entry(`${KB}/.hidden/a.md`, {}), scope), false, '点开头的路径');
    });

    await suite.it('计划：空白套整套模板 / 有正文只补两头 / 已经完整就不列出来', () => {
      const blank = entry(`${KB}/02_Areas/游戏研究/空.md`, {});
      const bodyNote = entry(`${KB}/02_Areas/游戏研究/有正文.md`, {});
      const done = entry(`${KB}/00_Inbox/完整.md`, {});
      const tplText = `---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-01-01\ntags: []\n---\n\n# {{title}}\n`;
      const texts: Record<string, string | null> = {
        [`${KB}/02_Areas/游戏研究/空.md`]: '',
        [`${KB}/02_Areas/游戏研究/有正文.md`]: '一段裸正文\n',
        /**
         * ⚠️ P7.17 · #1 改了这篇夹具的形状：旧夹具只有五件（缺 `文件位置`/`收藏`）——
         * 修洞之后那已经是"可补"的形状了。"不列出来"现在必须是**真完整**（六件齐 + 尾链在）。
         */
        [`${KB}/00_Inbox/完整.md`]:
          '---\n类型: 笔记\n状态: 进行中\n文件位置:\n  - 00_Inbox\n创建日期: 2026-01-01\ntags: []\n收藏: false\n---\n\n正文\n\n## 关联笔记\n- 返回 [[x]]\n',
      };
      const plan = planBackfill({
        entries: [blank, bodyNote, done],
        kbRoot: KB,
        metaRoot: `${KB}/99_Meta`,
        templateDir: `${KB}/99_Meta/02_模板库/Templater`,
        templateTexts: { 'tpl/T.md': tplText },
        templateFor: () => ({ path: 'tpl/T.md', rule: '文件夹规则：02_Areas' }),
        contextOf: () => ctx0,
        textOf: (p) => texts[p] ?? null,
        ctimeOf: () => Date.parse('2026-02-02T00:00:00'),
      });
      eq(plan.scanned, 3, '扫过 3 篇');
      eq(plan.items.length, 2, '两篇要动（完整的那篇不列）');
      const kinds = plan.items.map((i) => `${i.basename}:${i.kind}`).sort();
      deepEq(kinds, ['有正文:patch', '空:template']);
      eq(countPlan(plan).tail, 2, '两篇都要补尾链');
      eq(countPlan(plan).yaml, 2, '两篇都要有前言（一个整套、一个只补头）');
      contains(describeItem(plan.items[0]), '套整套模板');
    });

    /**
     * 🔴 **P7.17 · #1（修洞）**：**有前言也补缺键**。
     * 旧判据 `needYaml = !hadFm` 让"有前言（哪怕只有一行 tags）"的篇一个键都不补
     * —— 0-② 的主洞。成对判据：缺的键在 + **已有键逐字节不动**；补完再扫 = 0（幂等）。
     */
    await suite.it('修洞：有前言缺键 → 按行合并补缺键（已有键一字不动；补完再扫就不列了）', () => {
      const rel = `${KB}/00_Inbox/半份.md`;
      const RAW =
        '---\n类型: 想法\n状态: 进行中\ntags:\n  - 保留我\n---\n\n正文属于用户，一字不动。\n\n## 关联笔记\n- 返回 [[x]]\n';
      /** 这一篇住在 00_Inbox（不是共享的 `ctx0` 那个目录）—— 落点断言要按它的 */
      const ctxInbox: NoteContext = { ...ctx0, title: '半份', folderRel: '00_Inbox' };
      const only = entry(rel, { 类型: '想法', 状态: '进行中', tags: ['保留我'] });
      const base = {
        entries: [only],
        kbRoot: KB,
        metaRoot: `${KB}/99_Meta`,
        templateDir: `${KB}/99_Meta/02_模板库/Templater`,
        templateTexts: { 'tpl/T.md': '---\n类型: 笔记\n---\n\n# {{title}}\n' },
        templateFor: () => ({ path: 'tpl/T.md', rule: '文件夹规则：00_Inbox' }),
        contextOf: () => ctxInbox,
        textOf: () => RAW,
        ctimeOf: () => Date.parse('2026-02-02T00:00:00'),
      };
      const plan = planBackfill(base);
      eq(plan.items.length, 1, '缺键 → 可补（旧口径会漏掉它）');
      const it0 = plan.items[0];
      eq(it0.yaml, true, '要动前言');
      deepEq(
        it0.yamlAdded ?? [],
        ['文件位置', '创建日期', '收藏'],
        '缺哪补哪（类型/状态/tags 都已在 → 一个都不碰；D1 起文件位置/收藏也补）',
      );
      // 判据表同一份：buildFillPlan 直调（有前言 → 整块替换模式，不是拼在开头）
      const built = buildFillPlan(RAW, {
        ctx: ctxInbox,
        templateText: null,
        templatePath: '',
        withPosition: true,
        ctime: Date.parse('2026-02-02T00:00:00'),
      });
      ok(built.kind === 'patch' && built.yamlMode === 'replace', '有前言 → `replace`（整块替换）');
      const block = built.kind === 'patch' ? built.yaml ?? '' : '';
      contains(block, '类型: 想法', '已有键原样在（值都没被动）');
      contains(block, '  - 保留我', '块值也一字不动');
      contains(block, '创建日期: 2026-02-02', '创建日期 = 文件创建时间（不是今天）');
      contains(block, '文件位置:\n  - 00_Inbox', 'D1：文件位置 = 实际落点');
      contains(block, '收藏: false', 'D1：收藏写齐');
      // 幂等：补后的文本再扫 → 不再是可补项（items 空）
      const AFTER =
        '---\n类型: 想法\n状态: 进行中\n文件位置:\n  - 00_Inbox\n创建日期: 2026-02-02\ntags:\n  - 保留我\n收藏: false\n---\n\n正文属于用户，一字不动。\n\n## 关联笔记\n- 返回 [[x]]\n';
      const plan2 = planBackfill({ ...base, textOf: () => AFTER });
      eq(plan2.items.length, 0, '补完再扫 = 0 篇（幂等）');
    });

    await suite.it('计划里模板读不到 → 跳过（不猜、不写半个）', () => {
      const blank = entry(`${KB}/02_Areas/游戏研究/空2.md`, {});
      const plan = planBackfill({
        entries: [blank],
        kbRoot: KB,
        metaRoot: `${KB}/99_Meta`,
        templateDir: `${KB}/99_Meta/02_模板库/Templater`,
        templateTexts: {},
        templateFor: () => ({ path: 'tpl/没有这个.md', rule: '当前模板' }),
        contextOf: () => ctx0,
        textOf: () => '',
        ctimeOf: () => Date.now(),
      });
      eq(plan.items.length, 0);
      eq(plan.skipped.length, 1);
      contains(plan.skipped[0].why, '读不到模板');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 真数据：新建补全与存量补全（真写盘）', async () => {
    const tmp = path.join(vaultRoot, '01_新知识库', '09_P3');
    fs.mkdirSync(tmp, { recursive: true });
    const write = (name: string, text: string): void => {
      fs.writeFileSync(path.join(tmp, name), text, 'utf8');
    };

    await suite.it('新建：落一个**空**文件（0 字节）→ 交给 Templater', async () => {
      const res = await ctx().completion.createNote({ title: 'P3 新建测试', dirRel: '09_P3' });
      ok(res.path.endsWith('P3 新建测试.md'), `落点对：${res.path}`);
      const f = app.vault.getAbstractFileByPath(res.path) as TFile;
      ok(f, '文件在库里');
      eq(await app.vault.read(f), '', '建成 0 字节 —— 先写内容会让 Templater 不触发');
      ok(res.rule.length > 0, `落点依据要能报出来（排查报告 ⭐4）：${res.rule}`);
    });

    await suite.it('新建重名：自动加序号，不覆盖', async () => {
      const r1 = await ctx().completion.createNote({ title: '重名', dirRel: '09_P3' });
      const r2 = await ctx().completion.createNote({ title: '重名', dirRel: '09_P3' });
      ok(r1.path !== r2.path, '两个不同的路径');
      contains(r2.path, '重名 2.md', '第二个加序号');
    });

    /**
     * **A1（用户 2026-09-27）**：「不使用模板」= 只建 YAML 头 + 结尾双链，正文留空。
     *
     * 这条路与上面那条**是两种做法**：上面落 0 字节文件让 Templater 接管，
     * 这条**一次落盘**（正文非空 → Templater 的"新建时触发"看到的不是空文件，不动手）。
     * 三条判据分别钉三件事：① 不是空文件 ② 前言 + 尾链真的写了 ③ 正文是空的。
     */
    await suite.it('A1 「不使用模板」：带着前言 + 尾链一次落盘，正文留空', async () => {
      const res = await ctx().completion.createNote({
        title: 'A1 不用模板',
        dirRel: '09_P3',
        noTemplate: true,
      });
      const f = app.vault.getAbstractFileByPath(res.path) as TFile;
      const text = await app.vault.read(f);
      ok(text.length > 0, '不是空文件（空文件才是"让 Templater 接管"那个形状）');
      ok(text.startsWith('---\n'), `开头就是前言：${JSON.stringify(text.slice(0, 12))}`);
      contains(text, '创建日期', '前言里有 创建日期');
      contains(text, '文件位置:', 'v2 · #4：新建同时写「文件位置」');
      contains(text, '  - 09_P3', '值 = 所在目录（相对库根）');
      contains(text, '## 关联笔记', '尾链写了');
      /**
       * **正文必须留空**：把前言与尾链剥掉之后，中间不该剩下任何东西
       *（模板的正文骨架一个字都不许进来 —— 那正是"不使用模板"要的效果）。
       */
      /**
       * ⚠️ 别用正则剥这里的两段 —— 第一版写的 `/^[\s\S]*?## 关联笔记/` 是**从开头**配到
       * 第一个「## 关联笔记」，留下的正是尾链自己那几行（判据当场红）。
       * 真正说明问题的是下面这条：**前言与尾链之间**什么都没有。
       */
      const headEnd = text.indexOf('\n---\n');
      const tailAt = text.indexOf('## 关联笔记');
      ok(headEnd > 0 && tailAt > headEnd, '前言与尾链都在位');
      eq(text.slice(headEnd + 5, tailAt).trim(), '', '前言与尾链之间没有别的内容（正文留空）');
      contains(res.rule, '不使用模板', `落点依据要说清这条路：${res.rule}`);
    });

    await suite.it('v2 · #4 新建即配置：「不使用模板」也写齐五件套（类型/状态按目录默认、文件位置=所在目录）', async () => {
      const mk = async (dirRel: string, title: string): Promise<string> => {
        const res = await ctx().completion.createNote({ title, dirRel, noTemplate: true });
        return res.path;
      };
      const p1 = await mk('01_Projects/01_执行中', `A1 目录默认 ${Date.now()}`);
      const p2 = await mk('00_Inbox', `A1 收件箱默认 ${Date.now()}`);
      try {
        const t1 = await app.vault.read(app.vault.getAbstractFileByPath(p1) as TFile);
        contains(t1, '类型: 笔记', '01_Projects → 类型 笔记');
        contains(t1, '状态: 进行中', '01_Projects → 状态 进行中');
        contains(t1, '  - 01_Projects/01_执行中', '文件位置 = 所在目录（相对库根）');
        const t2 = await app.vault.read(app.vault.getAbstractFileByPath(p2) as TFile);
        contains(t2, '类型: 笔记', '00_Inbox → 类型 笔记');
        ok(!t2.includes('状态'), '00_Inbox 不写状态（"还在 Inbox"本身就是待整理）');
      } finally {
        /**
         * ⚠️ 独立审 B3（P7.12 收尾）：收尾挂 `finally` —— 这两篇自造笔记喂的是**同一个 B 库**，
         * 中途断言抛错留残留会让后面 10+ 个 spec 连锁红（"失败集合每次都变"的老形态）。
         */
        for (const p of [p1, p2]) {
          const f2 = app.vault.getAbstractFileByPath(p);
          if (f2) await app.vault.delete(f2 as never, true);
        }
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);
      }
    });

    await suite.it('A1 对话框：下拉第一项 = 「不使用模板」且默认选中（换落点也不丢）', async () => {
      openNewNoteDialog(ctx());
      await H.settle(60);
      const modal = H.q(document.body, '.kbw-modal');
      const selects = H.qa<HTMLSelectElement>(modal, 'select.kbw-select');
      /**
       * 两个下拉的第一项**都是空串**（落点那个是"库根"）→ 不能按值挑。
       * 按**第一项的文案**挑：只有模板那个写着「不使用模板」。
       */
      const tplSel = selects.find((s) =>
        (s.options[0]?.textContent ?? '').includes('不使用模板'),
      );
      ok(tplSel, '模板下拉在');
      const opts = Array.from((tplSel as HTMLSelectElement).options);
      eq(opts[0].value, '', '第一项的值是空串（= 不使用模板）');
      // P7.9 · ② 极简：括注（"只补前言 + 结尾双链"）删了 —— 第一项文案就是这五个字
      eq(opts[0].textContent, '不使用模板', '第一项文案');
      eq((tplSel as HTMLSelectElement).value, '', '默认选中它');
      /**
       * ⚠️ **先卡"下拉里不止一项"**（P6② 独立审查 B 路 🔴2.6）：桩的 `TFolder.children`
       * 原先恒空 → `templateFiles()` 离线恒返回 [] → 下拉只有"不使用模板"一项，
       * "第一项是默认项"就退化成**自证**（把实现改成"默认选第一个模板"照样绿）。
       * 桩已修（`scan()` 现在会把子节点挂到 `parent.children`）→ 这条现在有分辨力了。
       */
      ok(opts.length > 1, `模板下拉里不止一项（实际 ${opts.length}）：${opts.map((o) => o.textContent).join(' | ')}`);
      /**
       * 换落点会**整块重画这个下拉**（`paintTemplates`）→ 默认项必须还在、选择不许被顶掉。
       * 这是"第一项/默认项"最容易在重画里丢掉的地方。
       */
      const dirSel = selects.find((s) => s !== tplSel) as HTMLSelectElement | undefined;
      ok(dirSel, '落点下拉在');
      dirSel?.dispatchEvent(new Event('change'));
      await H.settle(40);
      const opts2 = Array.from((tplSel as HTMLSelectElement).options);
      eq(opts2[0].value, '', '重画之后第一项仍是「不使用模板」');
      eq((tplSel as HTMLSelectElement).value, '', '选择没被顶掉');
      H.keydown(modal, 'Escape');
      await H.settle(60);
    });

    await suite.it('补全一篇有正文的：补前言 + 尾链，**正文一个字符不动**', async () => {
      const body = '原始正文第一行\n\n第二行\n';
      write('裸正文.md', body);
      app.vault.rescan();
      app.metadataCache.settle();
      await H.settle(120);
      const f = app.vault.getAbstractFileByPath(`${KB}/09_P3/裸正文.md`) as TFile;
      const outcome = await ctx().completion.fillFile(f);
      eq(outcome.kind, 'filled', `该补上：${outcome.detail}`);
      const after = await app.vault.read(f);
      contains(after, '原始正文第一行');
      contains(after, '第二行');
      ok(after.includes(body.trim()), '正文原样在里面（只加不删）');
      contains(after, '## 关联笔记');
      eq(hasTemplaterSyntax(after), false, '不该有任何模板语法');
      // 幂等：再补一次什么都不会发生
      const again = await ctx().completion.fillFile(f);
      eq(again.kind, 'none', `第二次不该再动：${again.detail}`);
    });

    await suite.it('补全一篇空白笔记：套整套模板（模板是本目录的规则模板）', async () => {
      write('空白.md', '');
      app.vault.rescan();
      app.metadataCache.settle();
      await H.settle(120);
      const f = app.vault.getAbstractFileByPath(`${KB}/09_P3/空白.md`) as TFile;
      // 09_P3 没有目录规则 → 兜底的「当前模板」（T_收件箱速记）含 <% %> → 按 §7.1 跳过
      const outcome = await ctx().completion.fillFile(f);
      ok(
        outcome.kind === 'skipped' || outcome.kind === 'filled',
        `要么跳过要么补上（实际 ${outcome.kind}：${outcome.detail}）`,
      );
      if (outcome.kind === 'skipped') {
        contains(outcome.detail, 'Templater', '跳过要说清是"模板要 Templater 求值"');
        eq(await app.vault.read(f), '', '跳过的场合**一个字节都不写**');
      }
    });

    await suite.it('补全的模板里没有 `<% %>` → 真的套上整套（前言 + 骨架 + 尾链）', async () => {
      // 造一个不含 Templater 语法的模板，放进模板库，再用它补
      const tplPath = `${KB}/99_Meta/02_模板库/Templater/T_P3测试.md`;
      fs.writeFileSync(
        path.join(vaultRoot, tplPath),
        '---\n类型: 笔记\n状态: 进行中\n创建日期: {{date}}\ntags: []\n---\n\n# {{title}}\n\n骨架\n',
        'utf8',
      );
      write('套模板.md', '');
      app.vault.rescan();
      app.metadataCache.settle();
      await H.settle(150);
      const f = app.vault.getAbstractFileByPath(`${KB}/09_P3/套模板.md`) as TFile;
      const tpl = app.vault.getAbstractFileByPath(tplPath) as TFile;
      const outcome = await ctx().completion.fillFile(f, {
        templatePath: tplPath,
        templateText: await app.vault.read(tpl),
      });
      eq(outcome.kind, 'filled', outcome.detail);
      const after = await app.vault.read(f);
      contains(after, '# 套模板', '{{title}} 换成文件名');
      contains(after, '类型: 笔记');
      contains(after, '骨架');
      ok(!after.includes('{{'), '不该留下占位符');
    });

    /**
     * 独立审查抓到的 🔴 之一：**对话框里选的模板必须真的被用上**。
     * 第一版 `createNote` 只收 `title`/`dirRel`，补全自己按套用规则重挑一个 ——
     * 于是"用户选的模板"被完全忽略（界面上却写着"Templater 不动手时按你选的模板补"）。
     */
    await suite.it('新建：对话框里选的模板**真的被用上**（不是被套用规则顶掉）', async () => {
      const tplPath = `${KB}/99_Meta/02_模板库/Templater/T_P3选用.md`;
      // ⚠️ 模板要落在**模板库目录**里（vault 相对路径）—— 别用上面那个"相对 09_P3"的 write
      H.writeNote(
        vaultRoot,
        tplPath,
        '---\n类型: 笔记\n状态: 进行中\n创建日期: {{date}}\ntags: []\n---\n\n# {{title}}\n\n这份来自「用户选的模板」\n',
      );
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);

      /**
       * 🔴 v2（P7.12 · #6② 真机复现的竞态）：**钉"fillFile 收到的实参"**，
       * 不能只看最终内容 —— 真机上曾出现"选的是 T_muban、补全却按默认模板
       * （T_收件箱速记，含 `<% %>`）走 → 跳过 → 空文件"，而离线时序恰好躲过。
       * 捕获实参后：收到 ≠ 选的那个，这条当场红（不管时序怎么摆）。
       */
      const caught: { templatePath?: string }[] = [];
      const origFill = ctx().completion.fillFile.bind(ctx().completion);
      (ctx().completion as unknown as { fillFile: (f2: TFile, given?: { templatePath?: string }) => Promise<unknown> }).fillFile = async (f2, given) => {
        caught.push({ templatePath: given?.templatePath });
        return origFill(f2, given as never);
      };
      const res = await ctx().completion.createNote({
        title: '选用模板测试',
        dirRel: '09_P3',
        templatePath: tplPath,
      });
      const file = app.vault.getAbstractFileByPath(res.path) as TFile;
      ok(file, '文件建出来了');
      // 等补全跑完（waitQuiet 的 300ms 判定点 + 写盘）：`H.until` 的判定是同步的，
      // 所以这里用"睡够 + 轮询"两步，别把异步读塞进判定里
      let text = '';
      for (let i = 0; i < 40; i += 1) {
        await H.settle(80);
        try {
          text = await app.vault.read(file);
        } catch {
          text = '';
        }
        if (text.includes('用户选的模板')) break;
      }
      eq(caught.length > 0, true, `补全真的跑过（fillFile 被调 ${caught.length} 次）`);
      eq(
        caught[0]?.templatePath,
        tplPath,
        `补全收到的是**对话框里选的那个**模板（防 P7.12 真机竞态回归；lastSkip=${ctx().completion.lastSkip ?? '无'}）`,
      );
      contains(
        text,
        '用户选的模板',
        `用的必须是对话框里选的那一个（lastSkip=${ctx().completion.lastSkip ?? '无'} · pending 文件=${res.path}）`,
      );
      contains(text, '类型: 笔记', '（选的那个模板没 Templater 语法，所以真的能套上）');
      ok(!text.includes('<%'), '不该有模板语法残留');
    });

    /**
     * 🔴 P7.13a · #2 · Q6（真链路）：**开关拆两层** —— 同一个模板、同一个落点，
     * 只差「新建笔记补全」这一个开关：
     *   · 关着 → **只落模板原文**（字面「模板」不换算、不补六件与尾链）；
     *   · 开着 → 六件补齐（类型按目录默认换算、文件位置=所在目录、收藏）+ 尾链。
     */
    await suite.it('开关拆两层（P7.13a · #2 · Q6 · 真链路）：关着 = 只落模板原文；开着 = 六件补齐 + 尾链', async () => {
      const tplPath = `${KB}/99_Meta/02_模板库/Templater/T_P713A开关.md`;
      H.writeNote(vaultRoot, tplPath, '---\n类型: 模板\n状态:\n---\n\n# {{title}}\n\n正文保留\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);

      const wasOn = ctx().gate.isOn('completion');
      const made: string[] = [];
      /** 等补全跑完（waitQuiet 的 300ms 判定点 + 写盘）——照上面那条的手工轮询 */
      const readWhen = async (path2: string, needle: string): Promise<string> => {
        let text2 = '';
        for (let i = 0; i < 40; i += 1) {
          await H.settle(80);
          try {
            text2 = await app.vault.read(app.vault.getAbstractFileByPath(path2) as TFile);
          } catch {
            text2 = '';
          }
          if (text2.includes(needle)) break;
        }
        return text2;
      };
      try {
        // ① 关着：只落模板原文
        await ctx().gate.set('completion', false);
        const t1 = `P713A关${Date.now()}`;
        const r1 = await ctx().completion.createNote({ title: t1, dirRel: '01_Projects/01_执行中', templatePath: tplPath });
        made.push(r1.path);
        const off = await readWhen(r1.path, `# ${t1}`);
        contains(off, '# ' + t1, '正文照渲染（套用是显式动作、不受开关管）');
        contains(off, '正文保留', '模板正文一个字符不删');
        contains(off, '类型: 模板', '关着：字面「模板」不换算（只落原文）');
        ok(!off.includes('文件位置'), '关着：不补「文件位置」');
        ok(!off.includes('收藏'), '关着：不补「收藏」（六件归开关）');
        ok(!off.includes('## 关联笔记'), '关着：不补尾链（也归开关）');

        // ② 开着：同一个模板 → 六件补齐 + 尾链
        await ctx().gate.set('completion', true);
        const t2 = `P713A开${Date.now()}`;
        const r2 = await ctx().completion.createNote({ title: t2, dirRel: '01_Projects/01_执行中', templatePath: tplPath });
        made.push(r2.path);
        const on = await readWhen(r2.path, `# ${t2}`);
        contains(on, '类型: 笔记', '开着：字面「模板」→ 按目录默认换算');
        contains(on, '状态: 进行中', '开着：状态按目录默认补齐（模板的空值被覆盖）');
        ok(
          on.includes('文件位置:\n  - 01_Projects/01_执行中'),
          '开着：文件位置 = 所在目录（新建路）',
        );
        contains(on, '收藏: false', '开着：六件口径');
        contains(on, '## 关联笔记', '开着：尾链缺就补');
        contains(on, '正文保留', '正文保真（开着也一样）');
      } finally {
        await ctx().gate.set('completion', wasOn);
        for (const p2 of made) {
          const f2 = app.vault.getAbstractFileByPath(p2);
          if (f2) await app.vault.delete(f2 as never, true);
        }
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);
      }
    });

    /**
     * 独立审查抓到的另一个 🔴：**"有前言 + 正文空"的笔记被整篇替换** ——
     * `文件位置`/`位置锁定`/`tags` 这些只在前言里的键全丢，与确认弹窗写的
     * "已有属性一个字符都不动"相反。这个形状**本插件自己就会造出来**
     * （目录被 Templater 接管时 `ensurePositionKey` 会补一个「文件位置」键 ——
     *  P7.12 收尾 · 独立审 A4 起，值 = 所在目录，不再是 `[]`）。
     */
    await suite.it('有前言 + 正文空：前言**一个键都不许动**，只补正文骨架与尾链', async () => {
      const tplPath = `${KB}/99_Meta/02_模板库/Templater/T_P3骨架.md`;
      H.writeNote(
        vaultRoot,
        tplPath,
        '---\n类型: 笔记\n状态: 进行中\n创建日期: {{date}}\ntags: []\n---\n\n# {{title}}\n\n## 一、背景\n> 骨架来自模板\n',
      );
      write(
        '有前言空正文.md',
        '---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-03-03\ntags:\n  - 保留我\n文件位置:\n  - 09_P3\n位置锁定: true\n---\n\n',
      );
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);

      const f = app.vault.getAbstractFileByPath(`${KB}/09_P3/有前言空正文.md`) as TFile;
      ok(f, '夹具在');
      const tplText = await app.vault.read(app.vault.getAbstractFileByPath(tplPath) as TFile);
      const outcome = await ctx().completion.fillFile(f, { templatePath: tplPath, templateText: tplText });
      eq(outcome.kind, 'filled', `该补上：${outcome.detail}`);
      const after = await app.vault.read(f);
      // 前言里的键一个都不许丢（这是这一条的全部意义）
      contains(after, '位置锁定: true', '`位置锁定` 必须原样在');
      contains(after, '保留我', '`tags` 必须原样在');
      contains(after, '创建日期: 2026-03-03', '创建日期不许被改成今天');
      contains(after, '骨架来自模板', '正文骨架按模板补上了');
      contains(after, '## 关联笔记', '尾链也补了');
      // 前言只能有一份（不许被模板那份顶掉或叠加）
      eq((after.match(/^---$/gm) ?? []).length, 2, `前言围栏只该有一对（实际 ${after}`);
    });

    await suite.it('存量补全：扫描是只读的（跑两遍一个字节都不变）', async () => {
      const before = fs.readFileSync(path.join(tmp, '裸正文.md'), 'utf8');
      const snapCount = (await ctx().snapshot.list()).length;
      eq(fs.readFileSync(path.join(tmp, '裸正文.md'), 'utf8'), before, '扫描没动文件');
      eq((await ctx().snapshot.list()).length, snapCount, '扫描不产生快照');
    });

    /**
     * **真链路**：自动归位的计划 → `mover` → 文件真的搬到那个目录。
     *
     * ⚠️ 这一条是**真机教训换来的**：纯函数层的 `planReconcile` 全绿，
     * 而真机上文件被搬到了 **vault 根目录**下（`02_Areas/内容创作/xx.md`，
     * 库根之外、索引都看不见）—— 因为计划里的目录是**相对库根**的
     * （`02_Areas/内容创作`），而 `mover` 要的是**库内绝对路径**
     * （`01_新知识库/02_Areas/内容创作`）。两种口径混了不会报错，只会搬错地方。
     * 所以这里断言的正是"落在库根之下"这一点。
     */
    await suite.it('运行时（真链路）：改了「文件位置」→ 真的搬进那个目录（口径不能混）', async () => {
      write(
        '归位.md',
        '---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-09-24\ntags: []\n---\n\n正文\n',
      );
      app.vault.rescan();
      ctx().index.rebuild(); // 直接写盘的夹具不会发 create 事件 → 手动重建索引（与 flags spec 同一手法）
      await H.settleIndex(app);
      await ctx().gate.set('automation', true); // 模块开关（v2：#12 起这是唯一的总闸）
      await ctx().reconcile.tick(); // 登记（只登记不搬）
      await H.settle(120);

      const from = app.vault.getAbstractFileByPath(`${KB}/09_P3/归位.md`) as TFile;
      await ctx().fm.update(from, (fm) => {
        fm['文件位置'] = ['02_Areas/内容创作'];
      });
      await H.settleIndex(app);
      const plan = await ctx().reconcile.tick();
      await H.settle(400);

      eq(plan.moves.length, 1, `该排出一篇要搬（实际 ${plan.moves.length}）`);
      ok(
        H.exists(vaultRoot, `${KB}/02_Areas/内容创作/归位.md`),
        '搬到了目标目录（**库根之下**）',
      );
      ok(
        !H.exists(vaultRoot, '02_Areas/内容创作/归位.md'),
        '绝不能落在 vault 根目录下 —— 那就是把"相对库根"当成了"库内绝对路径"',
      );
      // 关回去（别给后面的用例留状态）
      await ctx().gate.set('automation', false);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 设置面板七栏（界面）', async () => {
    __resetNotices();
    /** 面板没开就开一个（用例之间**不靠顺序**：`KBW_TEST_ONLY` 单跑也要能过） */
    async function ensurePanel(): Promise<void> {
      if (!H.maybe(document.body, '.kbw-modal')) {
        ctx().openWorkbenchSettings();
        await H.settle(100);
      }
    }
    /**
     * **子块 → 它现在住的那一栏**（P6 第八段把八栏收成六栏之后）。
     * ⚠️ 这几块不再是栏，所以"切到某一栏"要落到它们的宿主栏上；
     * `openSection` 还会顺带自证那个子块真的画出来了（下面那句 `ok`）。
     */
    const SUB_OF: Record<string, string> = {
      模板库: '自动化',
      目录映射: '自动化',
      快照: '数据',
      日志: '数据',
    };

    /** 切到某一栏（或某个子块所在的那一栏），返回它的内容宿主 */
    async function openSection(name: string): Promise<HTMLElement> {
      await ensurePanel();
      const rail = SUB_OF[name] ?? name;
      const tab = H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) =>
        H.textOf(t).includes(rail),
      );
      ok(tab, `有「${rail}」栏`);
      H.click(tab as HTMLElement);
      await H.settle(90);
      const body = H.q<HTMLElement>(document.body, '.kbw-set-body');
      /**
       * 子块要**自证它在**，而且**认元素、不认裸文本**：
       * 第一版写的是 `contains(text, '目录映射')` —— 被「自动化」那块正文里的同四个字骗过
       *（它某条 hint 里就写着"目录映射"），于是这条自证**恒真**，
       * 真正没画出来的子块要等到几十行之后才红。现在认的是小节标题那个元素：
       * `compose()` 把子块的标题降级成的正是它（`.kbw-set-group-t`）。
       *
       * ⚠️ 必须**等**（`H.until`）而不是定长 settle：这几块的 `paint()` 都是
       * **`await` 读完库内文件才画**（`routes.ts` / `templates.ts` / `logs.ts` 都是），
       * 定长等待在慢机器上就是一条"夹具没到"型的假红。
       */
      if (SUB_OF[name]) {
        const painted = await H.until(
          () =>
            H.qa<HTMLElement>(body, '.kbw-set-group-t').some((g) => H.textOf(g) === name),
          1500,
          30,
        );
        ok(painted, `「${rail}」栏里该有「${name}」那一块的小节标题`);
      }
      return body;
    }
    /** 栏内容重画之后旧的引用就失效了 —— 每次操作完重新取一份 */
    function bodyNow(): HTMLElement {
      return H.q<HTMLElement>(document.body, '.kbw-set-body');
    }

    await suite.it('⚙ 能开，七栏都在，逐栏点一遍都能画出来', async () => {
      await ensurePanel();
      const modal = H.q(document.body, '.kbw-modal');
      ok(H.textOf(modal).includes('工作台设置'), '面板开着');
      const tabs = H.qa<HTMLElement>(modal, '.kbw-set-tab').filter(
        (t) => !t.classList.contains('is-ghost'),
      );
      /**
       * 🔴 **七栏**（P6 第八段从八栏收的口 + P7.2a 加的「首页」，依据见 `交互规格.md` §7 与 `settings/types.ts`）：
       * 模板库 / 目录映射是"自动化的输入"，收进「自动化」；
       * 快照 + 日志是"同一件事的两头"，收成「数据」；
       * 「帮助」（向导 + 逐栏「问 AI」）；P7.2a 的「首页」= 首页内部区块的显隐与顺序。
       */
      deepEq(
        tabs.map((t) => H.textOf(t)),
        ['自动化', '看板', '首页', '外观', 'AI 助手', '数据', '帮助'],
        '七栏，顺序与 §7 一致',
      );
      for (const t of tabs) {
        H.click(t);
        await H.settle(60);
        const body = H.q(document.body, '.kbw-set-body');
        ok(H.textOf(body).length > 0, `「${H.textOf(t)}」栏有内容`);
      }
    });

    /**
     * ② **一栏只有一个标题**（用户 2026-09-27 原话："右边具体的设置面板有两个标题，只保留一个"）。
     * 真机上量到的是「自动化」在 54px 内出现两次（外层 h2 @127 + 栏内 h3 @181）——
     * 修法是删掉外层那层 head，标题统一由各栏 `setTitle` 提供，
     * 那句短说明降级成左栏项的 `title`（悬停提示）。
     */
    await suite.it('设置栏：每栏只有一份标题 · 左栏项的悬停提示非空', async () => {
      await ensurePanel();
      const tabs = H.qa<HTMLElement>(document.body, '.kbw-set-tab').filter(
        (t) => !t.classList.contains('is-ghost'),
      );
      eq(tabs.length, 7, '七栏（P6 第八段六栏 + P7.2a 的「首页」）');

      // 左栏每一项都要有悬停提示（`sub` 在删掉外层 head 之后的唯一落点）
      for (const t of tabs) {
        const label = H.textOf(t);
        const title = t.getAttribute('title') ?? '';
        ok(title.trim().length > 0, `「${label}」的左栏项要有 title（悬停提示），实际「${title}」`);
        ok(title !== label, `「${label}」的 title 不该只是把名字重一遍（那它就没带任何信息）`);
      }

      // 逐栏：`.kbw-set-main` 里 h2/h3 **只能有一个**，而且它就是这一栏的名字
      for (const t of tabs) {
        const label = H.textOf(t);
        H.click(t);
        await H.settle(90);
        const main = H.q<HTMLElement>(document.body, '.kbw-set-main');
        const heads = H.qa<HTMLElement>(main, 'h2, h3').map((h) => H.textOf(h).trim());
        eq(heads.length, 1, `「${label}」栏里只该有一个标题，实际 ${heads.join(' / ') || '(一个都没有)'}`);
        ok(heads[0].includes(label), `「${label}」栏的那个标题就是它自己（实际「${heads[0]}」）`);
      }

      H.keydown(document.body, 'Escape');
      await H.settle(120);
      eq(H.maybe(document.body, '.kbw-modal'), null, 'Esc 关掉面板');
    });

    /**
     * ③ 的**「关得掉」**那条承诺（独立审查 B2：删掉「外观」栏那一整行，全量照样全绿）。
     * 「打开工作台就收侧栏」是**会动用户布局**的动作 —— 留一条退路是它的一部分，不是装饰。
     * 判据落在**真界面**上：那一栏里找得到开关，点一下真的把设置写下去。
     */
    await suite.it('③ 「外观」栏有关掉它的开关，点一下真的写进设置', async () => {
      const body = await openSection('外观');
      contains(H.textOf(body), '打开工作台时自动收起侧栏', '开关得在「外观」栏里（不在就得翻文档找）');
      const sw = H.qa<HTMLElement>(body, '.kbw-switch')[0];
      ok(sw, '那个开关画出来了');
      const before = ctx().settings.get().collapseSidebarOnOpen;
      eq(sw.getAttribute('aria-checked'), before ? 'true' : 'false', '开关的初态跟着设置走');
      H.click(sw);
      await H.settle(200);
      eq(
        ctx().settings.get().collapseSidebarOnOpen,
        !before,
        '点一下真的把设置翻过来了（不是个装饰性开关）',
      );
      // 翻回去，别把状态漏给后面的用例
      H.click(H.qa<HTMLElement>(bodyNow(), '.kbw-switch')[0]);
      await H.settle(200);
      eq(ctx().settings.get().collapseSidebarOnOpen, before, '再点一下能翻回来');
    });

    await suite.it('自动化栏：一个开关（自动归位已退役）+ 占位符 + 存量补全入口', async () => {
      const body = await openSection('自动化');
      const text = H.textOf(body);
      contains(text, '新建笔记补全');
      contains(text, '自动归位');
      contains(text, '显式改「文件位置」= 直接搬', 'v2：触发口径写出来（不再是"开关 + 触发条件"）');
      contains(text, '{{title}}', '占位符要看得见');
      contains(text, '一键补全存量笔记');
      const switches = H.qa<HTMLElement>(body, '.kbw-switch');
      // v2（#12）：「自动归位」开关退役 —— 只剩「新建笔记补全」这一个
      eq(switches.length, 1, '一个开关（新建补全）；自动归位开关已退役');
    });

    await suite.it('自动化栏：开「新建笔记补全」写进库内 自动化.json（不是 data.json）', async () => {
      const body = await openSection('自动化');
      const switches = H.qa<HTMLElement>(body, '.kbw-switch');
      H.click(switches[0]);
      await H.settle(150);
      const cfg = (await ctx().configs.read('automation')) as {
        completion?: { enabled?: boolean };
      };
      eq(cfg.completion?.enabled, false, '开关落到库内配置（点一下 = 关）');
      ok(fs.existsSync(path.join(vaultRoot, `${KB}/99_Meta/06_工作台/自动化.json`)), '文件真的落盘了');
      // 开回去（别给后面的用例留状态）
      H.click(switches[0]);
      await H.settle(150);
      const cfg2 = (await ctx().configs.read('automation')) as { completion?: { enabled?: boolean } };
      eq(cfg2.completion?.enabled, true, '能开回去');
    });

    await suite.it('目录映射栏：显示库内那张表 + 体检结果；改一行再放弃，文件不变', async () => {
      const body = await openSection('目录映射');
      const text = H.textOf(body);
      contains(text, '标签-目录映射.json', '要写清这张表在哪儿');
      contains(text, '体检');
      contains(text, '内容创作', '表里的领域段要画出来');
      const rows = H.qa(document.body, '.kbw-set-row.is-route');
      ok(rows.length >= 10, `表里的行要画出来（实际 ${rows.length}）`);

      const filePath = `${KB}/99_Meta/02_模板库/标签-目录映射.json`;
      const before = fs.readFileSync(path.join(vaultRoot, filePath), 'utf8');
      // 改一个输入框的值（不点保存）→ 只该是"有未保存的改动"
      const input = H.q<HTMLInputElement>(rows[0], 'input');
      input.value = '改了个名字';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(60);
      eq(fs.readFileSync(path.join(vaultRoot, filePath), 'utf8'), before, '没点保存就不该写盘');
      ok(H.textOf(bodyNow()).includes('未保存'), '要提示有未保存的改动');
      // 放弃改动 → 草稿丢掉
      const giveUp = H.qa<HTMLElement>(bodyNow(), '.kbw-btn').find((b) => H.textOf(b) === '放弃改动');
      H.click(giveUp as Element);
      await H.settle(80);
      eq(fs.readFileSync(path.join(vaultRoot, filePath), 'utf8'), before, '放弃之后还是原样');
      ok(H.textOf(bodyNow()).includes('已同步'), '状态回到"已同步"');
    });

    /**
     * ⚠️ 第三路（突变测试）指出：**没有任何用例真的点过「保存」** ——
     * 把 `writeRouteTable` 写回时丢掉 `_说明`/`_用法` 照样全绿（r20）。
     * 这条补的就是那个动作：改一行 → 点保存 → 库里那张表真的写回、注释键保住。
     */
    await suite.it('目录映射栏：改一行 → **点「保存」** → 写回库内那张表且注释键不丢', async () => {
      await openSection('目录映射');
      const filePath = `${KB}/99_Meta/02_模板库/标签-目录映射.json`;
      const rawBefore = JSON.parse(fs.readFileSync(path.join(vaultRoot, filePath), 'utf8'));
      const firstKey = Object.keys(rawBefore.领域 ?? {})[0];
      ok(firstKey, `夹具里的领域段得有条目（实际 ${Object.keys(rawBefore.领域 ?? {}).join('/')}）`);

      // 把「领域」段第一条的目标目录改到一个**存在**的目录（否则体检报错、保存会弹确认流）
      const rows = H.qa<HTMLElement>(bodyNow(), '.kbw-set-row.is-route');
      const target = rows.find((r) => {
        const i = r.querySelector('input');
        return i && i.value === firstKey;
      });
      ok(target, `找得到「${firstKey}」那一行`);
      const dirInput = H.qa<HTMLInputElement>(target, 'input')[1];
      dirInput.value = `${KB}/02_Areas`;
      dirInput.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(80);

      const saveBtn = H.qa<HTMLElement>(bodyNow(), '.kbw-btn').find((b) => H.textOf(b) === '保存');
      ok(saveBtn, '有「保存」按钮');
      ok(!saveBtn.hasAttribute('disabled'), '改过之后「保存」该是可点的');
      H.click(saveBtn);
      await H.settle(250);
      /**
       * 体检有 error 时保存会先弹确认流（**这批夹具数据里真有一条**：
       * `02_Areas/游戏研究` 那个目录从没建过 → "落点目录不存在"）。
       * 这正好把确认流那条路也一起验了：点「仍然保存」→ 才真的写回。
       */
      const confirmModal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
      if (confirmModal && H.textOf(confirmModal).includes('仍要保存')) {
        const okBtn = H.qa<HTMLElement>(confirmModal, '.kbw-btn').find((b) =>
          H.textOf(b).includes('仍然保存'),
        );
        ok(okBtn, '体检有错时，确认流里该有「仍然保存」');
        H.click(okBtn as Element);
        await H.settle(300);
      }

      const after = JSON.parse(fs.readFileSync(path.join(vaultRoot, filePath), 'utf8'));
      const modalOpen = `最后一个模态 = ${H.textOf(H.qa<HTMLElement>(document.body, '.kbw-modal').pop() ?? document.body).slice(0, 80)}`;
      eq(
        after.领域[firstKey],
        `${KB}/02_Areas`,
        `改动真的写回库里了（模态=${H.maybe(document.body, '.kbw-modal') ? '开着' : '无'}：${modalOpen}）`,
      );
      eq(after._说明, rawBefore._说明, '注释键 `_说明` 一个字不许丢');
      if (rawBefore._用法) eq(after._用法, rawBefore._用法, '注释键 `_用法` 也不许丢');
      deepEq(Object.keys(after.标签 ?? {}), Object.keys(rawBefore.标签 ?? {}), '标签段没被动过');
      ok(H.textOf(bodyNow()).includes('已同步'), '保存之后状态回到"已同步"');

      // 还原（别给后面的用例留状态）—— 直接写回原文本
      fs.writeFileSync(path.join(vaultRoot, filePath), `${JSON.stringify(rawBefore, null, 2)}\n`, 'utf8');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
    });

    /**
     * **收尾：把设置面板关掉、把 Esc 层收干净**（2026-09-28 加）。
     *
     * 为什么值得单列一条（本轮实测出来的）：这一组**跑完时留着浮层** ——
     * 面板还开着，Esc 栈上压着 `board:clear-transient > modal:工作台设置 > multiselect-dropdown`
     * 三层（后两层是更早那几组留下的）。而 `dispatchEscape` **只问栈顶** ——
     * 下一组（看板）里任何"按一下 Esc"的用例都会弹到**别人的层**，
     * 判据以"Esc 没生效"的样子红、真因却在几十条之前
     *（本轮踩到过：单跑全绿、全量 33 条级联假红）。
     */
    await suite.it('收尾：关掉设置面板并把 Esc 层收干净（别把浮层留给下一组）', async () => {
      for (let i = 0; i < 6 && __escapeLabels().length > 0; i += 1) {
        H.keydown(document.body, 'Escape');
        await H.settle(40);
      }
      ok(
        __escapeLabels().length === 0,
        `Esc 层该收干净（还剩 ${__escapeLabels().join(' > ')}）`,
      );
      eq(H.maybe(document.body, '.kbw-modal'), null, '设置面板也关掉了（浮层不许跨组留着）');
    });
  });

  /**
   * ────────────────────────────────────────────────────────────
   * P6⑧ · **设置面板这一屏本身**（用户第 3、6 条）
   *
   * 四件各一条：说明默认收起（但 `title` 兜底）· 「显示说明」开关记得住 ·
   * 搜索 → 命中清单 → 跳过去点亮那一行 · 每栏那枚「问 AI」。
   *
   * ⚠️ **离线的边界**：jsdom 里没有样式表，所以"收起了没有"判的是
   * **`.kbw-set-shell` 上有没有 `is-showsub`**（那条 CSS 规则的两半由 `redline.ts` 静态钉住，
   * "真的没占位"由真机探针判）—— 与 ⑧-A 底栏那条同一个形状，别把它当成全部。
   */
  await suite.group('P6⑧ · 设置面板（收起说明 / 搜索 / 问 AI）', async () => {
    const panelOpen = (): boolean => H.maybe(document.body, '.kbw-modal') !== null;
    async function ensurePanel(): Promise<void> {
      if (!panelOpen()) {
        ctx().openWorkbenchSettings();
        await H.settle(120);
      }
    }
    const shell = (): HTMLElement => H.q<HTMLElement>(document.body, '.kbw-set-shell');
    const searchBox = (): HTMLInputElement => H.q<HTMLInputElement>(document.body, '.kbw-set-search');
    const railTab = (name: string): HTMLElement | undefined =>
      H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes(name));
    /** 站到某一栏（切完等它画完 —— 好几块都是 await 之后才画） */
    async function goRail(name: string): Promise<void> {
      await ensurePanel();
      const t = railTab(name);
      ok(t, `左栏有「${name}」`);
      H.click(t as HTMLElement);
      await H.settle(160);
    }

    await suite.it('① 每行那句解释默认收起，但**同一句话挂在标签的 title 上**（收起 ≠ 信息没了）', async () => {
      await goRail('自动化');
      eq(
        shell().classList.contains('is-showsub'),
        false,
        '默认不摊开（顶上那枚开关的默认态）',
      );
      const rows = H.qa<HTMLElement>(document.body, '.kbw-set-row');
      ok(rows.length >= 4, `这一栏该有若干行（实际 ${rows.length}）`);
      /**
       * ⚠️ **只挑"标签里那句解释"**（`.kbw-set-label .kbw-set-hint`）：
       * `.kbw-set-hint` 这个类**被状态行复用了**（「已同步 / 有未保存的改动」·「统计中…」·
       * 体检的逐行小字）—— 那些是**反馈**、不是解释，收起规则也不该碰它们
       *（第一版范围写宽了，这条断言当场报出 9 行"没挂 title"，真因在 CSS 那一侧）。
       */
      const withHint = rows.filter((r) => H.maybe(r, '.kbw-set-label .kbw-set-hint') !== null);
      ok(withHint.length >= 3, `前提：这些行本来是有解释的（实际 ${withHint.length} 行有）`);
      const missing = withHint.filter(
        (r) => (r.querySelector('.kbw-set-label-t')?.getAttribute('title') ?? '') === '',
      );
      // ⚠️ 断言把**是哪几行**一起报出来（不报的话下次只能再加一次临时 log）
      eq(
        missing.map((r) => H.textOf(r.querySelector('.kbw-set-label-t'))).join(' | '),
        '',
        `有解释的行必须把同一句话挂到 title 上（漏了 ${missing.length} 行）`,
      );
      // **同一句话**，不是另写一句（两处各写一份必然漂）
      const one = withHint[0];
      eq(
        one.querySelector('.kbw-set-label-t')?.getAttribute('title'),
        H.textOf(one.querySelector('.kbw-set-hint')),
        'title 与那句解释逐字一致',
      );
    });

    await suite.it('② 「显示说明」摊开 / 收起，并且**记得住**（落 data.json 的 showSettingHints）', async () => {
      await goRail('自动化');
      // 它是**可点的胶囊**（`.kbw-chip.is-pickable`，开着时带 `.is-on`），不是普通按钮
      const btn = H.qa<HTMLElement>(document.body, '.kbw-modal-actions button').find((b) =>
        H.textOf(b).includes('说明'),
      );
      ok(btn, '面板头上有那枚开关');
      H.click(btn as Element);
      await H.settle(120);
      ok(shell().classList.contains('is-showsub'), '点一下摊开');
      ok(
        await H.until(() => ctx().settings.get().showSettingHints === true, 1500, 30),
        '写进设置（界面偏好，**不进库**）',
      );
      /**
       * 🔴 **要读盘，不能只读内存**（独立审查 B🟡3）：只 `settings.get()` 的话，
       * 把 `SettingsStore.save()` 里的 `saveData` 整个跳过也**全绿** ——
       * 而"下次打开还在不在"靠的正是那个文件。
       * 写法与 `wizard.ts` 那条「`wizardDone` 落盘」一致（直接读 `data.json`）。
       */
      const disk = JSON.parse(
        await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json'),
      ) as { showSettingHints?: boolean };
      eq(disk.showSettingHints, true, '真的写进 data.json 了（不是只改了内存）');
      // 再点回去 —— 别把这个偏好留给后面的用例（它是**落盘**的）
      H.click(btn as Element);
      await H.settle(160);
      eq(shell().classList.contains('is-showsub'), false, '再点收起');
      ok(
        await H.until(() => ctx().settings.get().showSettingHints === false, 1500, 30),
        '收起也落盘',
      );
    });

    await suite.it('③ 搜索：命中清单 → 点一条**跳到那一栏**并把那一行点亮', async () => {
      // 先站在一个**不含**目标项的那一栏 —— 不跳过去的话下面那条判据才会红
      await goRail('外观');
      ok(
        H.qa(document.body, '.kbw-set-row').every(
          (r) => !H.textOf(r).includes('自动归位'),
        ),
        '前提：外观栏里没有「自动归位」（不然"跳过去"看不出来）',
      );
      searchBox().value = '自动归位';
      searchBox().dispatchEvent(new Event('input', { bubbles: true }));
      /**
       * ⚠️ **索引是懒建 + 异步的**（第一次搜索才把各栏渲染到离屏容器里、等它们的
       * `await` 数据回来）—— 定长 `settle(160)` 是**不够的**，那样只能看到
       * "正在整理设置项…"（第一版就是这么假红的）。
       */
      const arrived = await H.until(
        () => H.qa(document.body, '.kbw-set-result').length > 0,
        3000,
        40,
      );
      const results = H.qa<HTMLElement>(document.body, '.kbw-set-result');
      ok(arrived, `该有命中（实际 ${results.length}）`);
      const hit = results.find((r) => H.textOf(r).includes('自动归位'));
      ok(hit, `命中清单里该有「自动归位」（实际 ${results.map((r) => H.textOf(r)).join(' / ')}）`);
      contains(H.textOf(hit as HTMLElement), '自动化', '命中项要写清它在哪一栏');
      H.click(hit as Element);
      await H.settle(220);
      eq(searchBox().value, '', '点完清空搜索框（回到正常视图）');
      eq(H.qa(document.body, '.kbw-set-result').length, 0, '命中清单收起来了');
      contains(
        H.textOf(H.q<HTMLElement>(document.body, '.kbw-set-main')),
        '自动归位',
        '真的跳到了那一栏（那一项在眼前）',
      );
      const flashed = H.qa<HTMLElement>(document.body, '.kbw-set-row.is-flash');
      eq(flashed.length, 1, '而且**正好点亮一行**（不是"有没有"——数是它自己数出来的）');
      contains(H.textOf(flashed[0]), '自动归位', '点亮的就是它');
      /**
       * 点亮是 1.4 秒的事后自己摘掉 —— 用 `until` 等而不是定长 sleep：
       * 那一下的起点可能因为"等异步子块画完再点"晚个几十毫秒，
       * 定长 1500 会卡在边界上假红（第一版就是这么红的）。
       */
      ok(
        await H.until(() => H.qa(document.body, '.kbw-set-row.is-flash').length === 0, 3000, 60),
        '过一会儿自己摘掉（别一直亮着）',
      );
    });

    await suite.it('③b 清空搜索框 → **回到搜索前那一栏**（不是被踢到第一栏）', async () => {
      // 挑一个**不是第一栏**的（被踢到第一栏才看得出来）
      await goRail('数据');
      const before = H.textsOf(document.body, '.kbw-set-tab.is-on').join(',');
      eq(before, '数据', '前提：现在停在「数据」栏');
      searchBox().value = '快照';
      searchBox().dispatchEvent(new Event('input', { bubbles: true }));
      ok(
        await H.until(() => H.qa(document.body, '.kbw-set-result').length > 0, 3000, 40),
        '命中清单出来了',
      );
      // 常规操作：全选删掉（`input` 事件带空值）
      searchBox().value = '';
      searchBox().dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(200);
      eq(
        H.textsOf(document.body, '.kbw-set-tab.is-on').join(','),
        '数据',
        '回到搜索前那一栏（搜索态下 current 必为 null，写 `current?.id ?? 第一栏` 会把人踢走）',
      );
      eq(H.qa(document.body, '.kbw-set-result').length, 0, '命中清单收起来了');
    });

    await suite.it('④ 每栏标题右边有「问 AI」；没配 key 时**明说去哪配**（不报错）', async () => {
      await goRail('外观');
      const ask = H.qa<HTMLElement>(document.body, '.kbw-set-askai');
      eq(ask.length, 1, '这一栏标题右边正好一枚');
      ok(
        (ask[0].textContent ?? '').includes('问 AI'),
        '它写着「问 AI」',
      );
      // 先把 key 摘掉，验"没配"那一条路（不联网、也不该报错）
      const before = ctx().settings.get().ai.apiKey;
      await H.configAi(plugin, { apiKey: '' });
      H.click(ask[0]);
      await H.settle(150);
      const box = H.q<HTMLElement>(document.body, '.kbw-set-ai');
      contains(H.textOf(box), '还没配置 AI', '明说去哪配，而不是"出错了"');
      contains(H.textOf(box), 'AI 助手', '点名去哪一栏填');
      // 还原（免得把"没配 key"这个状态留给后面的用例）
      await H.configAi(plugin, { apiKey: before });
      await H.settle(120);
    });

    await suite.it('④c 「问 AI」的回答落在**能看见的地方**（合并栏里也不能塞到十几行以下）', async () => {
      const before = ctx().settings.get().ai.apiKey;
      H.resetAi();
      H.stubAi({ reply: '讲完了。' });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      try {
        /**
         * 挑**合并出来的「自动化」栏**（独立审查 A🟡4）：它的栏题在第一个子块**里面**，
         * 所以"插到第一个子节点之后"= 插到自动化块与目录映射块之间（十几行以下）——
         * 用户点完什么都看不见。判据：回答框必须排在**第一个 `.kbw-set-row` 之前**。
         */
        await goRail('自动化');
        const ask = H.qa<HTMLElement>(document.body, '.kbw-set-askai');
        ok(ask.length === 1, '自动化栏有「问 AI」');
        H.click(ask[0]);
        const box = H.q<HTMLElement>(document.body, '.kbw-set-ai');
        ok(
          await H.until(() => H.maybe(box, '.kbw-set-ai-body') !== null, 2000, 30),
          '回答画出来了',
        );
        const body = H.q<HTMLElement>(document.body, '.kbw-set-body');
        const firstRow = body.querySelector('.kbw-set-row');
        ok(firstRow, '前提：这一栏有设置行');
        ok(
          box.compareDocumentPosition(firstRow as Node) === Node.DOCUMENT_POSITION_FOLLOWING,
          '回答框排在第一个设置行**之前**（不然就是"点了没反应"）',
        );
      } finally {
        H.resetAi();
        await H.configAi(plugin, { apiKey: before });
        await H.settle(120);
      }
    });

    await suite.it('④b 配了模型时：走的是**同一条链路** —— 回答以 Markdown 渲染在这一栏顶上', async () => {
      const before = ctx().settings.get().ai.apiKey;
      H.resetAi();
      H.stubAi({ reply: '**这一栏**是管密度和动效的，改了立刻生效。' });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      try {
        await goRail('外观');
        const ask = H.qa<HTMLElement>(document.body, '.kbw-set-askai');
        ok(ask.length === 1, '那一栏有「问 AI」');
        H.click(ask[0]);
        const box = H.q<HTMLElement>(document.body, '.kbw-set-ai');
        ok(
          await H.until(() => H.maybe(box, '.kbw-set-ai-body') !== null, 2000, 30),
          '回答画出来了（等模型那一步是异步的）',
        );
        const body = H.q<HTMLElement>(box, '.kbw-set-ai-body');
        contains(H.textOf(body), '密度和动效', '回答内容在');
        ok(body.querySelector('strong, p') !== null, 'Markdown 真渲染过（不是一坨文本）');
        // 问出去的那一句话里要带上这一栏的**项目**（不然模型不知道在讲什么）
        const sent = String(requestLog[requestLog.length - 1]?.body ?? '');
        contains(sent, '密度', '请求里带着这一栏的项目');
        contains(sent, '外观', '也说了是哪一栏');
      } finally {
        // 🔴 清场：假传输层、假响应、key 全都还原（别把"配好了"留给后面的用例）
        H.resetAi();
        await H.configAi(plugin, { apiKey: before });
        await H.settle(120);
      }
    });

    await suite.it('⑧ 小窗字号哨兵 0：输入框留空 + placeholder「默认」；清空提交写回 0（P7.0a 批 1⑧）', async () => {
      await goRail('看板');
      const fontInput = (): HTMLInputElement | null => {
        const row = H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) =>
          H.textOf(r).includes('小窗字号'),
        );
        return row?.querySelector<HTMLInputElement>('input.kbw-input') ?? null;
      };
      /** 安全读：板配置可能还没落盘（第一次 save 才创建那个文件）→ 缺席按 NaN 报 */
      const readFont = async (): Promise<number> => {
        const cfg = (await ctx().configs.read('board')) as
          | { view?: { panelFont?: number } }
          | null;
        return cfg?.view?.panelFont ?? NaN;
      };
      /** 落盘 + 重画之后再轮询（配置写入是异步的，别拿定长 settle 赌） */
      const submit = async (value: string): Promise<number> => {
        const inp = fontInput();
        ok(inp, '「小窗字号」那一行有数字输入框');
        (inp as HTMLInputElement).value = value;
        (inp as HTMLInputElement).dispatchEvent(new Event('change'));
        let seen = NaN;
        for (let i = 0; i < 25; i += 1) {
          await H.settle(60);
          seen = await readFont();
          if (value === '' ? seen === 0 : seen === Number(value)) break;
        }
        return seen;
      };

      // ① 清空提交 = 写回哨兵 0（不管起点是什么值）
      eq(await submit(''), 0, '清空提交 → 落盘写成哨兵 0');

      // ② 面板重画后：输入框**留空**、placeholder 才是「默认」（别把 0 画给用户看）
      ok(
        await H.until(() => (fontInput()?.value ?? 'x') === '', 1500, 40),
        `哨兵 0 时输入框该留空（实际 "${fontInput()?.value}"）`,
      );
      eq(fontInput()?.getAttribute('placeholder'), '默认', 'placeholder 写着「默认」');

      // ③ 填真值照样走（哨兵语义没把普通输入弄坏）
      eq(await submit('17'), 17, '填 17 → 落盘 17');
      ok(
        await H.until(() => (fontInput()?.value ?? '') === '17', 1500, 40),
        `非哨兵值正常显示（实际 "${fontInput()?.value}"）`,
      );

      /**
       * ④ **没传 `emptyAt` 的控件（网格间距）清空提交照旧落 0** —— 独立审查 🔴2 的回归判据：
       * `numberCtl` 第一版把"空输入"整个拦掉（无 `emptyAt` 时直接 return），等于把
       * "卡片高度/间距清空 = 回 0"这类既有行为悄悄改没了（框空着、配置不动、不报错）。
       */
      const gapRow = (): HTMLElement | undefined =>
        H.qa<HTMLElement>(H.q(document.body, '.kbw-set-body'), '.kbw-set-row').find((r) =>
          H.textOf(r).includes('网格间距'),
        );
      const readGap = async (): Promise<number> => {
        const cfg = (await ctx().configs.read('board')) as { view?: { gap?: number } } | null;
        return cfg?.view?.gap ?? NaN;
      };
      const gap0 = await readGap();
      const gapInput = gapRow()?.querySelector<HTMLInputElement>('input.kbw-input') ?? null;
      ok(gapInput, '「网格间距」那一行在');
      (gapInput as HTMLInputElement).value = '24';
      (gapInput as HTMLInputElement).dispatchEvent(new Event('change'));
      let gapSeen = NaN;
      for (let i = 0; i < 25 && gapSeen !== 24; i += 1) {
        await H.settle(60);
        gapSeen = await readGap();
      }
      eq(gapSeen, 24, '网格间距填 24 → 落盘 24');
      const gapInput2 = gapRow()?.querySelector<HTMLInputElement>('input.kbw-input') ?? null;
      (gapInput2 as HTMLInputElement).value = '';
      (gapInput2 as HTMLInputElement).dispatchEvent(new Event('change'));
      gapSeen = NaN;
      for (let i = 0; i < 25 && gapSeen !== 0; i += 1) {
        await H.settle(60);
        gapSeen = await readGap();
      }
      eq(gapSeen, 0, '清空提交 → 照旧落 0（没声明哨兵的控件行为不变）');
      // 还原间隔（别把 0 留给后面的用例）
      if (Number.isFinite(gap0)) {
        const gapInput3 = gapRow()?.querySelector<HTMLInputElement>('input.kbw-input') ?? null;
        (gapInput3 as HTMLInputElement).value = String(gap0);
        (gapInput3 as HTMLInputElement).dispatchEvent(new Event('change'));
        await H.settle(200);
      }

      // 收尾：清回哨兵 0（别把 17 留给后面的用例）
      eq(await submit(''), 0, '收尾清回 0');
    });

    await suite.it('收尾：把设置面板关掉（别把浮层留给下一组）', async () => {
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      eq(H.maybe(document.body, '.kbw-modal'), null, '面板关掉了');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P3 · 红线（静态断言：约定必须钉在源码里）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    /**
     * ⚠️ **静态断言一律先剥注释**：第三路的突变测试证明了两件事 ——
     * ① 注释里留一句 `// source: 'reconcile'` 就能骗过文本判据（s1，假绿）
     * ② 注释里写一句 `// 这里不调 buildFillPlan()` 又能把"不许调"那条**误伤**（s3，假红）
     * 判"代码里有没有这件事"，就该只看代码。
     */
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read = (rel: string): string => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

    await suite.it('等待时长写的是 300ms 判定点 + 800ms 封顶（不是 180ms）', () => {
      const src = read('src/services/completion.ts');
      ok(/JUDGE_MS\s*=\s*300/.test(src), '判定点必须是 300ms（180ms 会赶在 Templater 落笔前抢写）');
      ok(/CAP_MS\s*=\s*800/.test(src), '封顶 800ms');
      ok(/INTERACTIVE_CAP_MS/.test(src), '交互式模板要能突破封顶');
      ok(!/JUDGE_MS\s*=\s*180/.test(src), '不许再出现 180ms');
    });

    await suite.it('自动归位**只**经 mover 动文件（不许自己调 fileManager/vault.rename）', () => {
      const src = read('src/services/reconcile.ts');
      ok(!/fileManager/.test(src), 'reconcile 里不许出现 fileManager');
      ok(!/\.rename\(/.test(src), 'reconcile 里不许直接 rename');
      /**
       * ⚠️ 原判据是文本匹配 `source: 'reconcile'` —— 突变 s1 实测：真调用改成 `'manual'`、
       * 注释里留一句 `source: 'reconcile'` 就**照样绿**。文本判据只能当"粗筛"，
       * 真正的行为断言在下面的「容器被接管/自动归位」用例里（读操作日志的来源标签）。
       */
      ok(/source: 'reconcile'/.test(read('src/main.ts')), 'main.ts 里确实把 source 标成 reconcile（文本粗筛）');
    });

    await suite.it('路由表只有一个写点（`services/routes.ts`），别处不许写这张表', () => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
          if (e.isDirectory()) walk(`${dir}/${e.name}`);
          else if (e.name.endsWith('.ts')) files.push(`${dir}/${e.name}`);
        }
      };
      walk('src');
      /**
       * ⚠️ 判据钉在**代码符号**上，不能钉文件名字符串：
       * 第一版写的是"含 `标签-目录映射.json` 且含 vault 写" —— 而那个文件名在
       * `routes.ts` 里**只出现在注释**（真路径走 `settings.routeTablePath()`），
       * 于是① 第二个写点只要用 `routeTablePath()` 就看不见（**假绿**）
       * ② 谁改一句注释就会红（**假红**）。独立审查抓到的。
       * 现在判的是：**用 `routeTablePath()` 拿路径、又真的写 vault 的文件，只许有一个**。
       */
      const writers = files.filter((f) => {
        const s = read(f);
        // ⚠️ `vault.adapter.write()` 也算"写"（`snapshot.ts` 就在用它）——
        // 只认 `vault.process|create|modify` 的话，第二个写点绕 adapter 就看不见了
        return (
          s.includes('routeTablePath') &&
          /vault\.(process|create|modify)|adapter\.(write|append)/.test(s)
        );
      });
      deepEq(writers, ['src/services/routes.ts'], '写这张表的只能是 routes.ts');
      ok(
        read('src/core/settings.ts').includes('routeTablePath'),
        '路径的唯一来源是 core/settings.ts 的 routeTablePath()',
      );
    });

    await suite.it('存量补全与新建补全共用同一个判据（`buildFillPlan`）', () => {
      // ⚠️ 都判"**调用**"而不是"文本里出现过"：调用形态带 `(`，注释里写不出这个形态
      ok(/buildFillPlan\s*\(/.test(read('src/services/backfill.ts')), 'planner 调统一判据');
      ok(/buildFillPlan\s*\(/.test(read('src/services/completion.ts')), '补全走同一份判据');
      /**
       * ⚠️ P6 段④ 起面板走的是 `planBackfillOf(ctx)`（"拼输入 + 扫描"那一段抽去了
       * `services/backfill.ts`，因为**向导第 3 步要报同一个数**）——
       * 它里面调的就是 `planBackfill`。所以这条判据要连着看两级。
       *
       * 🔴 **第二级原来恒真**（独立审查 B🔴4）：`services/backfill.ts` 里
       * **第 107 行就是 `export function planBackfill(input: …)`** —— 那个 `/planBackfill\s*\(/`
       * 匹配的是**函数定义那一行**，而不是任何调用。于是把 `return planBackfill({…})` 换成
       * `return { items: [], skipped: [] }`（定义原样保留）→ **不带过滤词的全量 656/656 全绿**，
       * 用户点「一键补全」会看到"0 篇"而验收一个字都不说。
       * ⇒ 判据要**把那一段函数体切出来**，只在这个范围内找**调用形态**。
       *（本项目在 `reconcileOneFromMenu` 那条上已经用过这个写法。）
       */
      ok(/planBackfillOf\s*\(/.test(read('src/ui/backfill-panel.ts')), '面板用 planner');
      const bfSrc = read('src/services/backfill.ts');
      const bfFnStart = bfSrc.indexOf('export async function planBackfillOf(');
      ok(bfFnStart >= 0, '找得到 planBackfillOf（找不到就是被改名了）');
      const bfFnEnd = bfSrc.indexOf('\n}', bfFnStart);
      const bfFn = bfSrc.slice(bfFnStart, bfFnEnd < 0 ? undefined : bfFnEnd);
      ok(/return\s+planBackfill\s*\(/.test(bfFn), '`planBackfillOf` 的函数体里要真的 `return planBackfill(…)`');
      /**
       * 反证（**否则上面那条可能还是空的**）：这段切出来的体里**不许**出现函数定义那一行 ——
       * 出现了就说明 indexOf 切错了位置，判据又在自证。
       */
      ok(!/export function planBackfill\(/.test(bfFn), '切出来的那一段不该含定义行（含了说明切错位置了）');
      // 反面那条只在"剥掉注释之后"才有意义（注释里写 `buildFillPlan()` 会误伤 —— 第三路 s3 实测）
      ok(
        !/buildFillPlan\s*\(/.test(read('src/ui/backfill-panel.ts')),
        '面板自己不许调判据（判据只在 services 里）',
      );
    });

    await suite.it('设置了 `disabled` 的按钮用 `toggleAttribute`（P2 那条真机 bug 不许复发）', () => {
      for (const f of ['src/ui/backfill-panel.ts', 'src/ui/settings/routes.ts']) {
        const s = read(f);
        ok(!/setAttribute\('disabled',\s*'false'\)/.test(s), `${f} 不许把 'false' 写进 disabled`);
      }
    });
  });

  // ────────────────────────────────────────────────────────────
  /**
   * 这一组全是**第三路（突变测试）指出的零覆盖**：那些行为改坏了离线也全绿。
   * 每条对应一条"改坏了不红"的突变，清单见 `tests/.tmp/review-p3-tests.md`。
   */
  await suite.group('P3 · 补覆盖（突变测试指出的零覆盖）', async () => {
    const write0 = (rel: string, text: string): void => {
      const abs = path.join(vaultRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
    };
    const read0 = (rel: string): string => fs.readFileSync(path.join(vaultRoot, rel), 'utf8');
    const refresh = async (): Promise<void> => {
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
    };

    await suite.it('等待真的有在等：到判定点 · 交互式突破封顶 · 期间落笔就让位', async () => {
      write0(`${KB}/09_P3/等待.md`, '---\n类型: 想法\n---\n\n正文\n');
      await refresh();
      const f = app.vault.getAbstractFileByPath(`${KB}/09_P3/等待.md`) as TFile;

      // ① 没人写 → 至少要等到判定点（"due=t0"那类突变会变成 ~0ms → 这条红）
      const t0 = Date.now();
      const wrote = await ctx().completion.waitQuiet(f, false);
      const dt = Date.now() - t0;
      eq(wrote, false, '没人写时返回 false');
      ok(dt >= 260, `至少等到判定点附近（实际 ${dt}ms；判定点 300ms）`);

      // ② 交互式模板：封顶必须被突破
      const t1 = Date.now();
      await ctx().completion.waitQuiet(f, true);
      const dt2 = Date.now() - t1;
      ok(dt2 > 800, `交互式要等得比封顶(800ms)久（实际 ${dt2}ms）—— 这就是"突破封顶"`);

      // ③ 期间有人落笔 → 返回 true（调用方据此让位）
      setTimeout(() => {
        try {
          app.vault.simulateExternalWrite(`${KB}/09_P3/等待.md`, '---\n类型: 想法\n---\n\n别人写的\n');
        } catch {
          /* 忽略 */
        }
      }, 120);
      const wrote2 = await ctx().completion.waitQuiet(f, false);
      eq(wrote2, true, '期间落笔 → 让位');
    });

    await suite.it('目录被 Templater 接管：只补「文件位置」，且**不覆盖已有的值**', async () => {
      /**
       * ⚠️ 这条路径原来**离线一次都没走到**：桩里没有 `app.plugins.plugins`，
       * `readTemplater` 恒返回"没装" → `ensurePositionKey` 整块零覆盖
       * （第三路实测：把它改成"覆盖已存在的键"照样 225 全绿）。
       */
      const tplDir = `${KB}/99_Meta/02_模板库/Templater`;
      const fake = app as unknown as { plugins: { plugins: Record<string, unknown> } };
      fake.plugins.plugins['templater-obsidian'] = {
        settings: {
          trigger_on_file_creation: true,
          enable_folder_templates: true,
          templates_folder: tplDir,
          folder_templates: [{ folder: `${KB}/09_P3`, template: `${tplDir}/T_收件箱速记.md` }],
        },
      };
      try {
        write0(
          `${KB}/09_P3/接管甲.md`,
          '---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-01-01\ntags: []\n---\n\n正文\n',
        );
        /**
         * 乙：**已经有**「文件位置」，而且前言里带一个**非标量值**（`创建日期: {{date}}`）。
         * 为什么故意放这个：`ensurePositionKey` 那道"已经有就不动"的守卫**真正用途**，
         * 就是别对不需要改的笔记跑 YAML 往返 —— 一往返，`{{date}}` 这种流式映射就被改形
         * （P2 实测过）。只用普通前言测的话，"去掉守卫"照样绿（往返结果恰好一样）。
         */
        const bBody =
          '---\n类型: 笔记\n状态: 进行中\n创建日期: {{date}}\ntags: []\n文件位置:\n  - 02_Areas/内容创作\n---\n\n正文\n';
        write0(`${KB}/09_P3/接管乙.md`, bBody);
        await refresh();

        const a = app.vault.getAbstractFileByPath(`${KB}/09_P3/接管甲.md`) as TFile;
        ctx().completion.schedule(a, { announce: false });
        await H.settle(1200);
        const afterA = read0(`${KB}/09_P3/接管甲.md`);
        contains(afterA, '文件位置', '接管目录里：补的是「文件位置」这个键');
        // 独立审 A4（P7.12 收尾）：值 = **所在目录**（v2 · #4/#12 口径），不是空数组 ——
        // 空值会让这篇一直挂在「缺『文件位置』」的整理建议里。
        contains(afterA, '09_P3', '值是所在目录（相对库根）——不是留空');
        contains(afterA, '正文', '正文一个字没动（让给 Templater）');
        ok(!afterA.includes('## 关联笔记'), '正文让位 → 不补尾链');

        const b = app.vault.getAbstractFileByPath(`${KB}/09_P3/接管乙.md`) as TFile;
        ctx().completion.schedule(b, { announce: false });
        await H.settle(1200);
        eq(
          read0(`${KB}/09_P3/接管乙.md`),
          bBody,
          '**已经有「文件位置」的：一个字节都不许改**（含那个非标量 `{{date}}` —— 一写就改形）',
        );
        /**
         * ⚠️ 再加一条"**根本没碰它**"的断言：只看文件字节的话，去掉那道守卫**照样绿** ——
         * 因为桩的 `processFrontMatter` 不像真机那样把 `{{date}}` 改形（往返结果恰好一样）。
         * `isRecentSelfWrite` 直接答"我们刚才写过它吗"，与桩的 YAML 行为无关。
         */
        eq(
          isRecentSelfWrite(`${KB}/09_P3/接管乙.md`),
          false,
          '已经有「文件位置」→ **连写盘都不该尝试**（那道守卫的真正用途）',
        );
        eq(isRecentSelfWrite(`${KB}/09_P3/接管甲.md`), true, '对照组：甲补了键 = 确实写过');
        /**
         * 丙：**迁移给 `T_*` 模板盖的「类型: 模板」被 Templater 原样带进新笔记** ——
         * 插件套用路径有"字面「模板」→ 目录默认"的换算（`templates.ts`），Templater 路径
         * 绕过了它（P7.12 收尾真机抓到的真 bug）。托管分支要补同一份换算：
         * 09_P3 不在目录默认表里 → 拿不准就**删键**（与 buildYaml 同口径）。
         */
        write0(
          `${KB}/09_P3/接管丙.md`,
          '---\n类型: 模板\n状态: 进行中\ntags: []\n---\n\n正文\n',
        );
        await refresh();
        const c3 = app.vault.getAbstractFileByPath(`${KB}/09_P3/接管丙.md`) as TFile;
        ctx().completion.schedule(c3, { announce: false });
        await H.settle(1200);
        const afterC = read0(`${KB}/09_P3/接管丙.md`);
        ok(!afterC.includes('类型: 模板'), '「类型: 模板」被换算掉（不许原样落进新笔记）');
        contains(afterC, '状态: 进行中', '同一次写盘里别的键照旧（只动「类型」那一行）');
        contains(afterC, '正文', '正文照旧不动');
      } finally {
        delete fake.plugins.plugins['templater-obsidian'];
      }
    });

    await suite.it('落笔比判定点慢（真机竞态）：等到前言后照样补「文件位置」+ 换算「类型: 模板」', async () => {
      /**
       * P7.12 收尾真机实况：Templater 的目录模板比 `JUDGE_MS` 慢 → 旧实现"看一眼空文件就放弃、
       * 且永不重试" → 「文件位置」没补、模板身份换算也没跑（`类型: 模板` 原样落进笔记）。
       * 修法 = 轮询等落笔（`TEMPLATER_WAIT_MS` 上限）；本用例把"迟到落笔"演出来。
       */
      const tplDir2 = `${KB}/99_Meta/02_模板库/Templater`;
      const fake2 = app as unknown as { plugins: { plugins: Record<string, unknown> } };
      fake2.plugins.plugins['templater-obsidian'] = {
        settings: {
          trigger_on_file_creation: true,
          enable_folder_templates: true,
          templates_folder: tplDir2,
          folder_templates: [{ folder: `${KB}/09_P3`, template: `${tplDir2}/T_收件箱速记.md` }],
        },
      };
      try {
        const f = await app.vault.create(`${KB}/09_P3/接管丁.md`, '');
        ctx().completion.schedule(f as unknown as TFile, { announce: false });
        // 「Templater」慢一拍（> JUDGE_MS 的 300ms）才落笔
        await H.settle(650);
        write0(`${KB}/09_P3/接管丁.md`, '---\n类型: 模板\ntags: []\n---\n\n正文\n');
        await H.settle(1800);
        const after = read0(`${KB}/09_P3/接管丁.md`);
        ok(!after.includes('类型: 模板'), '迟到的落笔也要被换算（轮询等到了）');
        contains(after, '文件位置', '迟到的落笔也要补「文件位置」');
        contains(after, '正文', '正文照旧不动');
      } finally {
        delete fake2.plugins.plugins['templater-obsidian'];
      }
    });

    await suite.it('补全范围：`99_Meta` 与模板库里的空笔记**一律不碰**', async () => {
      // 第三路 r4：`inScope` 去掉 `metaRoot` 排除也全绿 —— 而那是"红线文件不许被碰"的实现
      eq(ctx().completion.inScope(`${KB}/99_Meta/03_AI指令集/__探针零字节.md`), false, '99_Meta 不在范围');
      eq(
        ctx().completion.inScope(`${KB}/99_Meta/02_模板库/Templater/__探针零字节.md`),
        false,
        '模板库也不在',
      );
      eq(ctx().completion.inScope(`${KB}/02_Areas/内容创作/__探针零字节.md`), true, '普通目录在范围内');

      const inMeta = await app.vault.create(`${KB}/99_Meta/03_AI指令集/__探针零字节.md`, '');
      await H.settle(1500);
      eq(read0(`${KB}/99_Meta/03_AI指令集/__探针零字节.md`), '', '99_Meta 里的空笔记：一个字节都不该被写');
      await ctx().mover.trash({
        files: [inMeta as unknown as TFile],
        source: 'batch',
        reason: '补覆盖用例（用完删）',
      });
    });

    await suite.it('尾链段形状：**逐行**与模板一致（不用 `||` 兜底式断言）', () => {
      // 第三路 r10：删掉「相关」那行也全绿 —— 原断言是 `A || B`，实质恒真。
      // ⚠️ v2（P7.12 · 21.7）：行序与标签都改了 —— 相关笔记 → 所属中心 → 返回大地图
      deepEq(
        tailSection(ctx0).trimEnd().split('\n'),
        ['## 关联笔记', '- 相关笔记：[[]]', `- 所属中心：${ctx0.center}`, `- 返回大地图 ${ctx0.moc}`],
        '尾链段要**恰好**这 4 行（v2 新序，与 6 个模板一致）',
      );
    });

    await suite.it('目录模板：**最长前缀优先**（断言的是"哪一条"，不是布尔）', () => {
      // 第三路 r11：去掉"最长前缀"（先命中先用）也全绿 —— 原来只断言了布尔
      const tp = {
        present: true,
        triggerOnCreate: true,
        folderTemplates: true,
        templatesFolder: `${KB}/tpl`,
        rules: [
          { folder: `${KB}/02_Areas`, template: `${KB}/tpl/领域.md` },
          { folder: `${KB}/02_Areas/每日任务`, template: `${KB}/tpl/每日.md` },
        ],
      };
      eq(folderTemplateFor(tp, `${KB}/02_Areas/每日任务`), `${KB}/tpl/每日.md`, '最深的规则赢');
      eq(folderTemplateFor(tp, `${KB}/02_Areas/内容创作`), `${KB}/tpl/领域.md`, '浅的那条兜住');
      eq(folderTemplateFor(tp, `${KB}/00_Inbox`), null, '没有规则 = 不接管');
    });

    await suite.it('多选控件：Backspace 删掉胶囊之后，候选列表还能开（第三路 r25）', async () => {
      // `paint()` 第一版会把**开着的下拉**也删掉，而模块变量 `drop` 仍非空 → 再也开不回来
      const { multiSelect } = await import('../../src/ui/primitives');
      const box = multiSelect({
        value: ['甲', '乙'],
        candidates: () => ['甲', '乙', '丙'],
        onChange: () => {},
      });
      document.body.appendChild(box.el);
      const input = H.q<HTMLInputElement>(box.el, 'input');
      input.dispatchEvent(new Event('focus'));
      await H.settle(30);
      ok(H.maybe(box.el, '.kbw-dropdown'), '聚焦后候选列表弹出来了');
      H.keydown(input, 'Backspace');
      await H.settle(30);
      eq(box.getValue().length, 1, '删掉了一个胶囊');
      ok(H.maybe(box.el, '.kbw-dropdown'), '**候选列表还在**（第一版会被 paint 删掉且再也开不回来）');
      box.el.remove();
    });
  });
}
