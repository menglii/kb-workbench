/**
 * spec：**P7.16 · YAML 专项一**（属性块脏检查重画 · 选择器两修 · 坏前言一族）
 * —— 条目真源 `YAML优化方案.md` §3 / `P7.16开工提示词.md` §1；规格回改
 * `交互规格.md` §2.3 / §3.3 / §4.2。
 *
 * 四组：
 *   · **纯函数（fm-repair）** —— 确定性修的行级判据 / 前言段的抠与换 / AI 稿校验；
 *   · **#3 旗标 + 待处理行**（真链路）—— 两种坏形状都亮 `fragile-fm`、干净/模板/
 *     保护目录三对照不亮；`buildTodos` 出「坏前言」行（黄 · 筛选意图）；
 *   · **#3 修前言（面板）** —— 首页 ① → 面板 → 确定性批量（**正文逐字节**成对判据）
 *     → 旗标灭 / 行消失 → 撤销还原；AI 路（stub 传输层）→ 预览对比 → 替换 → **守位不破**；
 *     没配 key 的置灰；丢了键的 AI 稿被服务层拒绝；
 *   · **#1/#2 小窗** —— 建目录/外部改 YAML 触发属性块刷新（不重开面板）· 焦点保护
 *     （聚焦时不重建、移开后下次触发补上）；未声明显示「（未声明 · 现处 XX）」·
 *     「就住这儿（写声明，不搬）」两处编辑面（选择器 + 右键菜单）。
 *
 * ⚠️ 夹具全带 `__p716` 前缀，每条自己收场（`metadataCache.settle()` 那套安全删法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TFile } from 'obsidian';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { joinPath } from '../../src/core/paths';
import { declaredPositions, fragileKeys } from '../../src/services/schema';
import { splitFrontmatter } from '../../src/services/frontmatter';
import {
  fixBarePlaceholders,
  frontmatterInnerOf,
  replaceFmInner,
  topLevelKeysOf,
  validateFmRepair,
} from '../../src/services/fm-repair';
import { parseFixFm } from '../../src/services/ai';
import { computeTodoItems } from '../../src/modules/home/todo-actions';
import { openFmRepairPanel } from '../../src/ui/fm-repair-panel';
import { NotesOps } from '../../src/modules/notes/ops';
import {
  closeCardPanel,
  ensureWindowDeps,
  openCardWindow,
  type CardWindowCtx,
} from '../../src/modules/board/editor';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { __resetNotices } from '../../src/ui/notify';
import { clickMenuPath, findMenuItem, menuLabels } from './menu-helpers';

export async function specP716(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** kbRoot 拨回默认（每个 spec 自己的库，防御性自证前提 —— 与 p715 同款） */
  async function ensureKbRootDefault(): Promise<string> {
    const want = '01_新知识库';
    if (ctx().settings.kbRoot() !== want) {
      await ctx().settings.save({ kbRoot: want });
      await H.settle(150);
    }
    return want;
  }

  /**
   * 安全带删法（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 metadataCache 还有一个
   * ~300ms 的滞后重解析定时器 —— 它会去读一个不存在的文件、未捕获异常把整个测试
   * 进程干掉（不是一条用例红）。删完必须 `settle()` + 重建索引。
   */
  async function rmFix(abs: string): Promise<void> {
    fs.rmSync(abs, { force: true, recursive: true });
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(120);
  }

  /** 造自用夹具（**裸文本** —— 坏前言要手写形状，H.note 序列化不出来） */
  async function writeRaw(rel: string, text: string): Promise<string> {
    const abs = joinPath(await ensureKbRootDefault(), rel);
    const full = path.join(vaultRoot, abs);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(150);
    return abs;
  }

  /** 认"最后出现的那枚"模态（面板自己也是一枚 `.kbw-modal` —— P6 段④的老账） */
  function modalWith(needle: string): HTMLElement | null {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal').filter((m) =>
      H.textOf(m).includes(needle),
    );
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /** 在某枚模态的底栏里点一枚按钮（按文案找） */
  function clickModalBtn(modal: HTMLElement, btnText: string): boolean {
    const b = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
      H.textOf(x).includes(btnText),
    );
    if (!b) return false;
    H.click(b);
    return true;
  }

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 2500): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  // ── 小窗 / 首页的共用探针 ─────────────────────────────────────
  const cwPanel = (): HTMLElement | null => {
    const all = H.qa<HTMLElement>(document.body, '.kbw-cw-panel');
    return all.length > 0 ? all[all.length - 1] : null;
  };
  const propRow = (name: string): HTMLElement | null =>
    H.qa<HTMLElement>(document.body, '.kbw-cw-row').find(
      (r) => (r.querySelector('.kbw-cw-k')?.textContent ?? '') === name,
    ) ?? null;
  /** 一块面板里的某张卡（卡头是《标题》） */
  const cardIn = (panel: HTMLElement, needle: string): HTMLElement | null =>
    H.qa<HTMLElement>(panel, '.kbw-title-row').find((r) => H.textOf(r).includes(needle)) ?? null;
  const menuItem = (needle: string): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes(needle));
  const todoRowOf = (needle: string): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-todo').find((r) => H.textOf(r).includes(needle));
  /** 眼下所有通知的文本（断言"报出来了"用 —— 与 p713b 同款） */
  const noticesText = (): string =>
    H.qa<HTMLElement>(document.body, '.kbw-notice')
      .map((n) => H.textOf(n))
      .join(' || ');

  async function goHome(): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
      H.textOf(n).includes('首页'),
    );
    if (nav && !nav.classList.contains('is-on')) {
      H.click(nav);
      await H.settle(200);
    }
  }

  /**
   * 把带这些措辞的待处理行挤进可见区（折叠只画前 5 条 —— 忽略掉挡在前面的行；
   * `homeDismissed` 由调用方 finally 原值归还）。与 p78/p713b 同一手法。
   */
  async function revealRows(needles: string[]): Promise<void> {
    for (let i = 0; i < 60; i += 1) {
      const rows = H.qa<HTMLElement>(document.body, '.kbw-todo');
      const texts = rows.map((r) => H.textOf(r));
      if (needles.every((n) => texts.some((t) => t.includes(n)))) return;
      if (rows.length === 0) {
        await H.settle(150); // 块还没画出来（预演/维护三件是异步的）
        continue;
      }
      const idx = texts.findIndex((t) => !needles.some((n) => t.includes(n)));
      if (idx < 0) return;
      const x = rows[idx].querySelector<HTMLElement>('.kbw-todo-x');
      if (!x) return;
      H.click(x);
      await H.settle(170);
    }
  }

  /**
   * 行右键 → 悬停「✦ AI 自动处理」→ 点 ① / ②（与 p713b 同款）。
   * ⚠️ 坐标给非 0（#6a 起鼠标路径走 `evt.clientX/Y`；0,0 是键盘回退档）。
   */
  async function clickRowAiItem(row: HTMLElement, which: '①' | '②'): Promise<boolean> {
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 30,
        clientY: r.top + 10,
      }),
    );
    const ai = await untilEl(() => menuItem('✦ AI 自动处理') ?? null);
    if (!ai) return false;
    ai.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    const sub = await untilEl(() => {
      const all = H.qa<HTMLElement>(document.body, '.kbw-menu');
      return all.reverse().find((x) => H.textOf(x).includes('自动处理本条')) ?? null;
    });
    if (!sub) return false;
    const item = H.qa<HTMLElement>(sub, '.kbw-menu-item').find((i) => H.textOf(i).startsWith(which));
    if (!item) return false;
    H.click(item);
    await H.settle(220);
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // 一 · 纯函数：fm-repair（确定性修 · 前言段抠换 · AI 稿校验）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.16 · 纯函数：前言文本手术（fm-repair / parseFixFm）', async () => {
    await suite.it('确定性修：整行裸占位符加引号存；改完幂等；认不出的形状一处不动', () => {
      const text = [
        '---',
        '类型: 笔记',
        '创建日期: {{date}}',
        '巡演: {{巡演名:2026}}',
        '状态: { 值: 进行中 }',
        '  {{缩进的不算}}',
        '备注: {{a}} 后面还有字',
        'tags: []',
        '---',
        '',
        '# 正文',
        '正文里也提 {{date}}，但它不在前言里，一个字节都不许动。',
        '',
      ].join('\n');
      const r = fixBarePlaceholders(text);
      eq(r.fixes.length, 2, '只认"整行就是一个裸占位符"的顶格行（两种各一处）');
      contains(r.text, '创建日期: "{{date}}"', '★ 裸占位符 → 加引号存');
      contains(r.text, '巡演: "{{巡演名:2026}}"', '带冒号的占位符同样只按形状修（不解析它什么意思）');
      contains(r.text, '状态: { 值: 进行中 }', '认不出的形状原样留（交给 AI 档）');
      contains(r.text, '  {{缩进的不算}}', '缩进行不动（可能是块标量/嵌套里的内容）');
      contains(r.text, '备注: {{a}} 后面还有字', '值不"整行就是占位符"的不动');
      contains(r.text, '正文里也提 {{date}}', '★ 正文不在前言块里，一个字节不动（成对判据的文本层）');
      const again = fixBarePlaceholders(r.text);
      eq(again.fixes.length, 0, '幂等：改过的不再匹配（第二遍 0 处）');
      eq(again.text, r.text, '第二遍原文一字不改');
    });

    await suite.it('前言段抠出 / 换回：前后文一个字节不动；没有规范前言块 → null / 拒绝', () => {
      const text = '---\n类型: 笔记\ntags: []\n---\n\n# 正\n正文。\n';
      eq(frontmatterInnerOf(text), '类型: 笔记\ntags: []', '抠出的内文不含围栏');
      const rep = replaceFmInner(text, '类型: 资料\ntags: []');
      ok(rep.ok, '替换成功');
      eq(
        rep.text,
        '---\n类型: 资料\ntags: []\n---\n\n# 正\n正文。\n',
        '★ 换前言段：前后（含收尾围栏后的空行与正文）逐字节保留',
      );
      eq(frontmatterInnerOf('没有前言\n正文'), null, '没有前言块 → null');
      eq(frontmatterInnerOf('---\n没收尾\n正文'), null, '没收尾围栏 → null（不收半截前言）');
      const bad = replaceFmInner(text, '类型: 笔记\n---\ntags: []');
      ok(!bad.ok, '新稿里混进 --- 围栏行 → 拒绝（宁可不写，也不要把文件改坏）');
      eq(bad.text, text, '拒绝时原文原样返回');
    });

    await suite.it('AI 稿校验：丢键 / 多键 / 裸占位符 / 围栏（--- 与裸 ```）/ 散文行 → 全部拒绝', () => {
      const before = '类型: 笔记\n状态: { 值: 进行中 }\ntags: []';
      eq(validateFmRepair(before, '类型: 笔记\n状态: 进行中\ntags: []').ok, true, '正常稿通过');
      const lost = validateFmRepair(before, '类型: 笔记\n状态: 进行中');
      ok(!lost.ok && lost.why.includes('丢掉'), '丢了 tags → 拒（why 点名）');
      const added = validateFmRepair(before, '类型: 笔记\n状态: 进行中\ntags: []\n来源: x');
      ok(!added.ok && added.why.includes('多出'), '多出键 → 拒（修的是形状、不是补属性）');
      ok(!validateFmRepair(before, '类型: 笔记\n状态: {{x}}\ntags: []').ok, '还有裸占位符 → 拒');
      ok(!validateFmRepair(before, '类型: 笔记\n状态: 进行中\n---\ntags: []').ok, '--- 围栏漏进来 → 拒');
      /**
       * 🔴 独立审 🟡 补的两条：只拦 `---` 时，模型包一个**裸 ```**或 `~~~`、或加一行
       * 散文，都会通过校验被写进前言 → 整份前言变非法 YAML、**属性全消失**。
       */
      ok(
        !validateFmRepair(before, '```\n类型: 笔记\n状态: 进行中\ntags: []\n```').ok,
        '★ 裸 ``` 围栏 → 拒（独立审 🟡：挡住"写坏整份前言"的形状）',
      );
      ok(
        !validateFmRepair(before, '~~~\n类型: 笔记\n状态: 进行中\ntags: []\n~~~').ok,
        '~~~ 围栏 → 拒',
      );
      const prose = validateFmRepair(before, '以下是修复稿\n类型: 笔记\n状态: 进行中\ntags: []');
      ok(!prose.ok && prose.why.includes('不是键'), '★ 散文行 → 拒（顶格行只能是键/列表/注释）');
      eq(topLevelKeysOf(before).join(','), '类型,状态,tags', '键清单口径（顶格、去重、按出现序）');
      eq(topLevelKeysOf(' 缩进: x\n# 注: y\n真键: 1').join(','), '真键', '缩进行与注释不算顶层键');
    });

    await suite.it('parseFixFm：照收正文；剥 yaml 围栏（含裸 ```/~~~）与 --- 对；空稿抛错', () => {
      eq(parseFixFm('类型: 笔记\ntags: []').inner, '类型: 笔记\ntags: []', '裸文本照收');
      eq(parseFixFm('```yaml\n类型: 笔记\n```').inner, '类型: 笔记', 'yaml 围栏剥掉');
      // 独立审 🟡：裸 ``` / ~~~ 也要剥（不剥就整段进前言；校验那边还有一道兜底）
      eq(parseFixFm('```\n类型: 笔记\n```').inner, '类型: 笔记', '★ 裸 ``` 围栏也剥');
      eq(parseFixFm('~~~\n类型: 笔记\n~~~').inner, '类型: 笔记', '~~~ 围栏也剥');
      eq(parseFixFm('---\n类型: 笔记\n---').inner, '类型: 笔记', '模型把 --- 对也抄上了 → 剥');
      let threw = false;
      try {
        parseFixFm('   ');
      } catch (e) {
        threw = String(e).includes('空稿');
      }
      ok(threw, '空稿 → 抛（绝不拿空稿去替换前言）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // 二 · #3 旗标 + 待处理行（真链路）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.16 · #3：坏前言旗标 + 待处理行', async () => {
    await suite.it('两种坏形状都亮 fragile-fm；干净/模板/保护目录三对照不亮；待处理行出「坏前言」', async () => {
      const KB = await ensureKbRootDefault();
      const bare = `${KB}/00_Inbox/__p716裸占.md`;
      const nested = `${KB}/00_Inbox/__p716嵌套.md`;
      const clean = `${KB}/00_Inbox/__p716干净.md`;
      const tpl = `${KB}/99_Meta/02_模板库/T_坏样.md`;
      const prot = `${KB}/99_Meta/03_AI指令集/__p716坏样.md`;
      const BODY_A = '# 记号-甲\n正文甲，甲乙丙。\n';
      try {
        await writeRaw('00_Inbox/__p716裸占.md', `---\n类型: 笔记\n创建日期: {{date}}\ntags: []\n---\n\n${BODY_A}`);
        await writeRaw('00_Inbox/__p716嵌套.md', `---\n类型: 笔记\n状态: { 值: 进行中 }\ntags: []\n---\n\n# 记号-乙\n正文乙。\n`);
        await writeRaw('00_Inbox/__p716干净.md', `---\n类型: 笔记\n状态: 进行中\ntags: []\n---\n\n# 记号-丙\n正文丙。\n`);
        await writeRaw('99_Meta/02_模板库/T_坏样.md', `---\n类型: 模板\n创建日期: {{date}}\n---\n\n# {{title}}\n`);
        await writeRaw('99_Meta/03_AI指令集/__p716坏样.md', `---\n创建日期: {{date}}\n---\n\n# 保护目录里的\n`);
        await H.settleIndex(app);

        const eBare = ctx().index.get(bare);
        const eNested = ctx().index.get(nested);
        const eClean = ctx().index.get(clean);
        const eTpl = ctx().index.get(tpl);
        const eProt = ctx().index.get(prot);
        ok(eBare && eNested && eClean && eTpl && eProt, '五篇夹具都进了索引');
        eq(fragileKeys(eBare?.props ?? {}).join(','), '创建日期', '前提：裸占位符真的被解析成了嵌套映射');
        eq(fragileKeys(eNested?.props ?? {}).join(','), '状态', '前提：流式映射同样');
        ok(eBare?.flags.includes('fragile-fm') ?? false, '★ 裸占位符那篇亮了「坏前言」');
        ok(eNested?.flags.includes('fragile-fm') ?? false, '★ 嵌套映射那篇亮了「坏前言」');
        ok(!(eClean?.flags.includes('fragile-fm') ?? true), '对照：干净篇不亮');
        ok(!(eTpl?.flags.includes('fragile-fm') ?? true), '对照：模板不亮（模板自身不带前言的那套口径）');
        ok(!(eProt?.flags.includes('fragile-fm') ?? true), '对照：保护目录（AI 指令集）不亮');

        const items = await computeTodoItems(ctx());
        const row = items.find((i) => i.id === 'fragile-fm');
        ok(row != null, `★ 待处理里有「坏前言」行（当前行：${items.map((i) => i.id).join(',')}）`);
        eq(row?.level, 'yellow', '黄档');
        eq(row?.act, '去修', '行尾动作词');
        const flagged = ctx().index.notes().filter((e) => e.flags.includes('fragile-fm'));
        eq(row?.count, flagged.length, '计数 = 当下亮旗标的篇数（从数据里取，不写死）');
        ok(row?.intent?.paths?.includes(bare) ?? false, '②（点行）= 筛选这几篇 —— 裸占位那篇在名单里');
        ok(row?.intent?.paths?.includes(nested) ?? false, '嵌套那篇也在');
      } finally {
        closeAllMenus();
        for (const rel of [
          '00_Inbox/__p716裸占.md',
          '00_Inbox/__p716嵌套.md',
          '00_Inbox/__p716干净.md',
          '99_Meta/02_模板库/T_坏样.md',
          '99_Meta/03_AI指令集/__p716坏样.md',
        ]) {
          // ⚠️ rmFix 收的是 **OS 绝对路径**（vaultRoot 之下）——别拿库内相对路径喂它
          await rmFix(path.join(vaultRoot, KB, rel));
        }
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 三 · #3 修前言面板（确定性批量 + AI 辅助）
  // ════════════════════════════════════════════════════════════
  const testOps = new NotesOps(ctx(), () => {});
  const panelDeps = (): CardWindowCtx => ({ ...ensureWindowDeps(ctx()), ops: testOps });
  /**
   * 小窗属性档默认是「不显示」（C2 拍板：默认只看正文）——下面几条判据要看属性块，
   * 先把它拨成 `few`（本 spec 自己的库；`patchView` = 官方写口，会落进看板配置）。
   */
  let propsOn = false;
  async function ensurePanelProps(): Promise<void> {
    if (propsOn) return;
    await H.settle(200); // 等 ensureWindowDeps 的异步 load 落定，再写
    await panelDeps().cfg.patchView({ panelProps: 'few' });
    propsOn = true;
    await H.settle(250);
  }

  await suite.group('P7.16 · #3：修前言面板（确定性 + AI）', async () => {
    await suite.it('首页 ① → 面板 → 确定性批量（正文逐字节）→ 旗标灭 → 撤销还原', async () => {
      const KB = await ensureKbRootDefault();
      const bare = `${KB}/00_Inbox/__p716裸修.md`;
      const nested = `${KB}/00_Inbox/__p716嵌套修.md`;
      const ORIGINAL = `---\n类型: 笔记\n创建日期: {{date}}\ntags: []\n---\n\n# 记号-丁\n正文丁，一字不动。\n`;
      const FIXED = ORIGINAL.replace('创建日期: {{date}}', '创建日期: "{{date}}"');
      const prevDismissed = ctx().settings.get().homeDismissed.slice();
      try {
        await writeRaw('00_Inbox/__p716裸修.md', ORIGINAL);
        await writeRaw('00_Inbox/__p716嵌套修.md', `---\n类型: 笔记\n状态: { 值: 进行中 }\ntags: []\n---\n\n# 记号-戊\n正文戊。\n`);
        await H.settleIndex(app);

        // 首页 → 把「坏前言」行挤进可见区 → 行菜单 ①
        await ctx().activate();
        await H.settle(80);
        await goHome();
        await revealRows(['前言里有嵌套值']);
        const row = todoRowOf('前言里有嵌套值');
        ok(
          row,
          `前提：坏前言行在（当前行：${H.qa<HTMLElement>(document.body, '.kbw-todo')
            .map((r) => H.textOf(r).slice(0, 12))
            .join(' / ')}）`,
        );
        ok(await clickRowAiItem(row!, '①'), '行菜单 ① 点到了');
        const panel = await untilEl(() => modalWith('修前言'), 3000);
        ok(panel, '★ ① 打开了「修前言」面板');

        const cardA = await untilEl(() => cardIn(panel!, '__p716裸修'), 3000);
        ok(cardA, '裸占位那篇有卡');
        contains(H.textOf(cardA!), '能当场修', '卡上写了"能当场修"（行级预览）');
        const cardB = cardIn(panel!, '__p716嵌套修');
        ok(cardB, '嵌套那篇也有卡');
        contains(H.textOf(cardB!), '认不得', '确定性修认不出的形状 → 标"认不得"');
        contains(H.textOf(cardB!), 'AI', '……那一步交给 AI');
        const runBtn = H.qa<HTMLElement>(panel!, '.kbw-title-bar .kbw-btn').find((b) =>
          H.textOf(b).includes('修能修的'),
        );
        contains(
          H.textOf(runBtn!),
          '1 篇',
          `只算"认得出"的那几篇（实际「${H.textOf(runBtn!)}」；卡：${H.qa<HTMLElement>(panel!, '.kbw-title-row')
            .map((r) => H.textOf(r).replace(/\s+/g, ' ').slice(0, 80))
            .join(' ｜ ')}）`,
        );
        H.click(runBtn!);
        const cfm = await untilEl(() => modalWith('只加引号'), 2500);
        ok(cfm, '确认流弹出来了');
        contains(H.textOf(cfm!), '快照', '确认单上写明快照兜底（批量这条路真进快照）');

        ok(clickModalBtn(cfm!, '修这 1 篇'), '点了主按钮');
        /**
         * ⚠️ 写盘是**异步链**（确认 → 快照 → vault.process → 滞后重解析 ~300ms → 索引
         * flush ~120ms）——固定 settle 赌不到（P7.5/P7.1b 纪律：等异步一律轮询）。
         * 轮询的判据 = 索引旗标灭（它成立时写盘必已完成）。
         */
        ok(
          await H.until(
            () => !(ctx().index.get(bare)?.flags.includes('fragile-fm') ?? true),
            3000,
            40,
          ),
          '★ 修完旗标灭',
        );
        const after = fs.readFileSync(path.join(vaultRoot, bare), 'utf8');
        eq(after, FIXED, '★ 逐字节成对：只动那一个值，正文一个字符没动');
        contains(
          fs.readFileSync(path.join(vaultRoot, nested), 'utf8'),
          '状态: { 值: 进行中 }',
          '没认得出的那篇一个字节没动',
        );
        const items = await computeTodoItems(ctx());
        eq(
          items.find((i) => i.id === 'fragile-fm')?.count,
          1,
          '修掉一篇之后行还在（还剩嵌套那篇）—— 行是现算的',
        );

        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '撤销条在（快照兜底）');
        H.click(u!);
        await H.until(() => fs.readFileSync(path.join(vaultRoot, bare), 'utf8') === ORIGINAL, 3000);
        eq(fs.readFileSync(path.join(vaultRoot, bare), 'utf8'), ORIGINAL, '★ 撤销 = 快照还原：逐字节回到原样');
        H.keydown(document.body, 'Escape');
        await H.settle(150);
      } finally {
        closeAllMenus();
        purgeOverlays();
        await ctx().settings.save({ homeDismissed: prevDismissed });
        await H.settle(120);
        await rmFix(path.join(vaultRoot, bare));
        await rmFix(path.join(vaultRoot, nested));
      }
    });

    await suite.it('AI 路：无 key 置灰说明 → stub 出稿 → 预览对比 → 替换 → 守位不破 → 撤销还原', async () => {
      const KB = await ensureKbRootDefault();
      const nested = `${KB}/00_Inbox/__p716嵌套AI.md`;
      const ORIGINAL = `---\n类型: 笔记\n状态: { 值: 进行中 }\ntags: []\n---\n\n# 记号-己\n正文己，逐字节。\n`;
      const FIXED = ORIGINAL.replace('状态: { 值: 进行中 }', '状态: 进行中');
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await writeRaw('00_Inbox/__p716嵌套AI.md', ORIGINAL);
        await H.settleIndex(app);

        // ── ① 没配 key：那一步置灰并说明（照既有 AI 模式，不许静默）──
        const p1 = openFmRepairPanel(ctx());
        const card1 = await untilEl(() => cardIn(p1.root, '__p716嵌套AI'), 3000);
        ok(card1, '面板里有它那张卡');
        const aiBtn1 = card1!.querySelector<HTMLButtonElement>('.kbw-fmrep-acts .kbw-btn');
        ok(aiBtn1, 'AI 按钮在（那是它唯一的路 —— 确定性修认不出这个形状）');
        eq(aiBtn1?.getAttribute('disabled'), 'true', '★ 没配 key → 置灰');
        contains(
          String(aiBtn1?.getAttribute('title') ?? ''),
          '还没配置 AI',
          '★ 并说明去哪儿配（不许静默）',
        );
        p1.close('test');
        await H.settle(150);
        ok(!modalWith('修前言'), '面板关掉了');

        // ── ② 配好 key + 假传输层：出稿 → 确认 → 替换 ──
        await H.configAi(plugin);
        H.resetAi();
        H.stubAi({ raw: '---\n类型: 笔记\n状态: 进行中\ntags: []\n---' });
        const p2 = openFmRepairPanel(ctx());
        const card2 = await untilEl(() => cardIn(p2.root, '__p716嵌套AI'), 3000);
        ok(card2, '重开面板、卡还在');
        const aiBtn2 = card2!.querySelector<HTMLButtonElement>('.kbw-fmrep-acts .kbw-btn');
        ok(aiBtn2 && !aiBtn2.hasAttribute('disabled'), '配好之后按钮可点了');
        H.click(aiBtn2!);
        const cfm = await untilEl(() => modalWith('修复稿'), 3000);
        ok(cfm, '★ 弹出确认流（AI 出稿 → 你确认才写）');
        const box = H.maybe<HTMLElement>(cfm!, '.kbw-diff');
        ok(box, '★ 预览对比框在（坏稿 → 修稿）');
        contains(H.textOf(box!), '状态: 进行中', '修稿摆在对比框里');
        ok(H.textOf(cfm!).includes('AI'), '确认单点名这稿是 AI 出的');
        ok(clickModalBtn(cfm!, '替换前言'), '点了主按钮');
        await H.settleIndex(app, 400);
        eq(
          fs.readFileSync(path.join(vaultRoot, nested), 'utf8'),
          FIXED,
          '★ 逐字节：只换前言那一段，正文一字不动',
        );

        // ── ③ 守位不破：修完之后属性改得动了 ──
        const f2 = app.vault.getAbstractFileByPath(nested) as unknown as TFile;
        const r = await ctx().fm.setMany(f2, { 状态: '已完成' });
        eq(r.skipped.length, 0, '★ 守位不破：再改属性不弹"有嵌套映射"（守卫不再拦）');
        contains(fs.readFileSync(path.join(vaultRoot, nested), 'utf8'), '状态: 已完成', '改属性真的写进去了');

        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '撤销条在');
        H.click(u!);
        await H.until(() => fs.readFileSync(path.join(vaultRoot, nested), 'utf8') === ORIGINAL, 3000);
        eq(
          fs.readFileSync(path.join(vaultRoot, nested), 'utf8'),
          ORIGINAL,
          '撤销 = 快照还原：连嵌套形状一起还原',
        );
        H.keydown(document.body, 'Escape');
        await H.settle(150);
      } finally {
        closeAllMenus();
        purgeOverlays();
        await H.configAi(plugin, { apiKey: prevKey });
        H.resetAi();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, nested));
      }
    });

    await suite.it('服务层校验：AI 稿丢了键 → 拒绝（原件没动、不弹确认）', async () => {
      const KB = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716拒稿.md';
      const nested = `${KB}/${rel}`;
      const ORIGINAL = `---\n类型: 笔记\n状态: { 值: 进行中 }\ntags: []\n---\n\n# 记号-庚\n正文庚。\n`;
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await writeRaw(rel, ORIGINAL);
        await H.settleIndex(app);
        await H.configAi(plugin);
        H.resetAi();
        // 丢了「状态」「tags」的稿子
        H.stubAi({ raw: '类型: 笔记' });
        let threw = '';
        try {
          await ctx().ai.fixFrontmatter({ rel });
        } catch (e) {
          threw = String(e);
        }
        contains(threw, '没通过检查', '★ 服务层拒绝（校验不过的稿子交不出去）');
        contains(threw, '丢', '……原因点名（丢键）');
        eq(fs.readFileSync(path.join(vaultRoot, nested), 'utf8'), ORIGINAL, '★ 原件逐字节没动');

        // 超长拒绝（规格原话：**绝不截断** —— 截断在这条链上就是静默数据丢失）
        const longRel = '00_Inbox/__p716超长前言.md';
        await writeRaw(longRel, `---\n类型: 笔记\n备注: ${'x'.repeat(4200)}\n---\n\n# 记号-长\n正文。\n`);
        let longThrew = '';
        try {
          await ctx().ai.fixFrontmatter({ rel: longRel });
        } catch (e) {
          longThrew = String(e);
        }
        contains(longThrew, '超过修复上限', '★ 超长前言被拒（长度检查在调模型之前，不花 token）');
        await rmFix(path.join(vaultRoot, `${KB}/${longRel}`));
      } finally {
        closeAllMenus();
        purgeOverlays();
        await H.configAi(plugin, { apiKey: prevKey });
        H.resetAi();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, nested));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 四 · #1 属性块脏检查重画（建目录 / 外部改 YAML / 焦点保护）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.16 · #1：属性块脏检查重画', async () => {
    const PANEL_REL = '00_Inbox/__p716面板.md';
    const PANEL_TEXT = `---\n类型: 笔记\n状态: 进行中\n来源: 示例来源\n文件位置: [00_Inbox]\ntags: []\n---\n\n# 记号-辛\n正文辛。\n`;

    await suite.it('建新目录 → 「文件位置」候选更新（不重开面板）；外部改 YAML → 值跟着变', async () => {
      const KB = await ensureKbRootDefault();
      const abs = `${KB}/${PANEL_REL}`;
      const dirRel = '__p716新夹';
      const dirAbs = path.join(vaultRoot, KB, dirRel);
      try {
        await writeRaw(PANEL_REL, PANEL_TEXT);
        await H.settleIndex(app);
        const e0 = ctx().index.get(abs);
        ok(e0, '前提：面板那篇在索引里');
        await ensurePanelProps();
        openCardWindow(e0!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        ok(cwPanel(), '小窗开了');
        const sel0 = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(sel0, '「文件位置」行在（这篇有声明 → 行才画得出来）');
        ok(!sel0!.disabled, '前提：测试 deps 接了 ops → 选择器可用');
        ok(
          !Array.from(sel0!.options).map((o) => o.value).includes(dirRel),
          '建立之前候选里没有它',
        );
        eq(sel0!.value, '00_Inbox', '当前项 = 声明值（已声明 → 不是"未声明"那条）');
        /**
         * 钉死①/保滚动的判据（独立审 🟡 补）：重画**不重挂编辑器**、**保住属性区滚动**。
         * 编辑器叶 = 正文块里挂上的那个容器节点（同一节点 = 没重挂；与 board.ts 的
         * "叶还是那一个"同款思路，这里用 DOM 身份更直接）。
         */
        const leafNode = H.q<HTMLElement>(cwPanel()!, '.kbw-cw-editor').firstElementChild;
        ok(leafNode != null, '前提：小窗正文里挂着编辑器叶');
        H.q<HTMLElement>(cwPanel()!, '.kbw-cw-props').scrollTop = 24;

        // ── 建目录（**不重开面板**）→ 候选立刻含它 ──
        await app.vault.createFolder(`${KB}/${dirRel}`);
        await H.settle(200);
        ok(cwPanel(), '面板还开着（同一扇，没重开）');
        const sel1 = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(
          Array.from(sel1?.options ?? []).map((o) => o.value).includes(dirRel),
          '★ 建完目录，下拉候选立刻含它（不重开面板、不切 tab）',
        );
        eq(
          H.q<HTMLElement>(cwPanel()!, '.kbw-cw-editor').firstElementChild,
          leafNode,
          '★ 同一枚编辑器叶（属性块重画没有重挂编辑器 —— 钉死①）',
        );
        eq(
          H.q<HTMLElement>(cwPanel()!, '.kbw-cw-props').scrollTop,
          24,
          '★ 属性区滚动位置保住了（e2 的老账：重绘会把滚动位置清零）',
        );

        // ── 外部改 YAML → 属性块的值跟着变 ──
        H.externalWrite(app, abs, PANEL_TEXT.replace('状态: 进行中', '状态: 已完成'));
        await H.settleIndex(app, 350);
        const st = propRow('状态')?.querySelector('select') as HTMLSelectElement | null;
        eq(st?.value, '已完成', '★ 外部改 YAML → 属性块里的值跟着变（不重开面板）');
      } finally {
        closeCardPanel({ reason: 'p716-test' });
        await H.settle(120);
        if (fs.existsSync(dirAbs)) await rmFix(dirAbs);
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('焦点保护：属性区输入框聚焦时触发库变化 → 不重建；焦点移开后下一次触发补上', async () => {
      const KB = await ensureKbRootDefault();
      const abs = `${KB}/${PANEL_REL}`;
      try {
        await writeRaw(PANEL_REL, PANEL_TEXT);
        await H.settleIndex(app);
        const e0 = ctx().index.get(abs);
        ok(e0, '前提：面板那篇在索引里');
        await ensurePanelProps();
        openCardWindow(e0!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        const input0 = propRow('来源')?.querySelector('input') as HTMLInputElement | null;
        ok(input0, '前提：「来源」是自由文本输入框');
        input0!.value = '我还没敲完';
        input0!.focus();
        eq(document.activeElement, input0, '前提：焦点确实在属性区里');

        // 触发一次库变化：外部写同一篇
        H.externalWrite(app, abs, PANEL_TEXT.replace('状态: 进行中', '状态: 已归档'));
        await H.settleIndex(app, 350);
        const input1 = propRow('来源')?.querySelector('input') as HTMLInputElement | null;
        ok(input1 === input0, '★ 聚焦时不被顺手重建（同一个节点）');
        eq(input1?.value, '我还没敲完', '……敲到一半的值还在');
        eq(document.activeElement, input0, '……焦点也还在');
        eq(
          (propRow('状态')?.querySelector('select') as HTMLSelectElement | null)?.value,
          '进行中',
          '这一轮库变化被推迟（别抢焦点）',
        );

        // 移开焦点 → **当场补画**（独立审 🟡：别等"下一次触发"，它可能永远不来）
        input0!.blur();
        await H.settle(60);
        eq(
          (propRow('状态')?.querySelector('select') as HTMLSelectElement | null)?.value,
          '已归档',
          '★ 焦点离开属性块：被推迟的那次当场补上（focusout → 补画）',
        );
        // 再触发一次（也验"下一次触发"这条老路照常）
        H.externalWrite(app, abs, PANEL_TEXT.replace('状态: 进行中', '状态: 已完成'));
        await H.settleIndex(app, 350);
        eq(
          (propRow('状态')?.querySelector('select') as HTMLSelectElement | null)?.value,
          '已完成',
          '★ 焦点移开后的下一次触发：补上了',
        );
        const input2 = propRow('来源')?.querySelector('input') as HTMLInputElement | null;
        ok(input2 !== input0, '重画真的发生了（输入框换了新节点）');
      } finally {
        closeCardPanel({ reason: 'p716-test' });
        await H.settle(120);
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 五 · #2 选择器两修（未声明显示 + 就住这儿）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.16 · #2：选择器两修', async () => {
    await suite.it('未声明显示「（未声明 · 现处 XX）」、sentinel 选中 = no-op；已声明在库根显示「库根」（可区分）', async () => {
      const KB = await ensureKbRootDefault();
      const unset = `${KB}/00_Inbox/__p716空声明.md`;
      const rootOk = `${KB}/__p716根声明.md`;
      try {
        // `文件位置: []` = 老缺陷会给"搬去库根"写下的形状；propsFor 认它"有值" → 行画得出来
        await writeRaw('00_Inbox/__p716空声明.md', `---\n类型: 笔记\n文件位置: []\ntags: []\n---\n\n# 记号-壬\n正文壬。\n`);
        await writeRaw('__p716根声明.md', `---\n类型: 笔记\n文件位置: ['.']\ntags: []\n---\n\n# 记号-癸\n正文癸。\n`);
        await H.settleIndex(app);

        await ensurePanelProps();
        openCardWindow(ctx().index.get(unset)!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        const selU = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(selU, '空声明的行画出来了（propsFor 的口径没动）');
        const curU = selU!.options[selU!.selectedIndex];
        contains(
          curU.textContent ?? '',
          '（未声明 · 现处 00_Inbox）',
          '★ 未声明 → 当前项显示长版（不冒充「库根」）',
        );
        const stayOpt = Array.from(selU!.options).find((o) =>
          (o.textContent ?? '').includes('就住这儿'),
        );
        ok(stayOpt, '★ 当前所在地那项 = 「就住这儿（写声明，不搬）」');
        eq(stayOpt?.value, '00_Inbox', '……它是真目录项（选中它走声明流）');
        eq(selU!.options[0].value, curU.value, '前提：sentinel 是第一项');
        // sentinel 选中 = no-op（不弹确认、不写盘）
        const beforeText = fs.readFileSync(path.join(vaultRoot, unset), 'utf8');
        selU!.value = curU.value;
        selU!.dispatchEvent(new Event('change'));
        await H.settle(200);
        eq(H.maybe(document.body, '.kbw-modal'), null, '★ 选中 sentinel：no-op（不弹确认流）');
        eq(fs.readFileSync(path.join(vaultRoot, unset), 'utf8'), beforeText, '……文件一个字节没动');
        closeCardPanel({ reason: 'p716-test' });
        await H.settle(150);

        // 对照：已声明在库根（['.'] → 归一 ['']）
        openCardWindow(ctx().index.get(rootOk)!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        const selR = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(selR, '根声明那篇的行在');
        eq(selR!.value, '', '★ 已声明在库根 → 选中「库根」那一项（value = 空串）');
        eq(selR!.options[selR!.selectedIndex].textContent, '库根', '★ 显示「库根」——与"未声明"可区分');
        ok(
          !Array.from(selR!.options).some((o) => (o.textContent ?? '').includes('未声明')),
          '对照：已声明 → 不画 sentinel',
        );
      } finally {
        closeCardPanel({ reason: 'p716-test' });
        await H.settle(120);
        await rmFix(path.join(vaultRoot, unset));
        await rmFix(path.join(vaultRoot, rootOk));
      }
    });

    await suite.it('就住这儿（选择器面）：确认流 → 写声明不搬文件 → 体检不报错位 → 正文原样', async () => {
      const KB = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716就地声.md';
      const abs = `${KB}/${rel}`;
      const RAW = `---\n类型: 笔记\n文件位置: []\ntags: []\n---\n\n# 记号-甲甲\n正文甲甲，一字不动。\n`;
      try {
        await writeRaw(rel, RAW);
        await ensurePanelProps();
        openCardWindow(ctx().index.get(abs)!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        const sel = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(sel, '选择器在');
        sel!.value = '00_Inbox';
        sel!.dispatchEvent(new Event('change'));
        const cfm = await untilEl(() => modalWith('只写声明'), 2500);
        ok(cfm, '★ 弹确认流（动库前确认只能过 ui/confirm）');
        contains(H.textOf(cfm!), '只写声明、不动文件', '文案写明"只写声明、不动文件"');
        ok(clickModalBtn(cfm!, '只写声明'), '点了主按钮');
        /**
         * ⚠️ **写盘是异步链**（确认 → setMany → 滞后重解析 ~300ms → 索引 flush ~120ms）——
         * 固定 settle 赌不到它（P7.5/P7.1b 的老纪律：等异步一律轮询）。
         */
        ok(
          await H.until(
            () => declaredPositions(ctx().index.get(abs)?.props ?? {}).length > 0,
            3000,
            40,
          ),
          `★ 声明写上了（盘上：${fs
            .readFileSync(path.join(vaultRoot, abs), 'utf8')
            .slice(0, 140)
            .split('\n')
            .join('⏎')}）`,
        );
        await H.settleIndex(app, 200);
        ok(fs.existsSync(path.join(vaultRoot, abs)), '★ 文件还在原位（没搬）');
        eq(
          declaredPositions(ctx().index.get(abs)?.props ?? {}).join(','),
          '00_Inbox',
          '★ 声明 == 实际',
        );
        const e = ctx().index.get(abs);
        ok(!(e?.flags.includes('position-mismatch') ?? true), '★ 体检不报错位');
        ok(!(e?.flags.includes('fragile-fm') ?? true), '也不是坏前言（走的是正常写口）');
        eq(
          splitFrontmatter(fs.readFileSync(path.join(vaultRoot, abs), 'utf8')).body,
          splitFrontmatter(RAW).body,
          '★ 正文那一段逐字节没动',
        );
      } finally {
        closeCardPanel({ reason: 'p716-test' });
        await H.settle(120);
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('就住这儿/现处（菜单面）：未声明 → 并列两项都可点；已声明在处 → 「现处」可点（P7.18b）', async () => {
      const KB = await ensureKbRootDefault();
      const unsetRel = '00_Inbox/__p716菜单未声明.md';
      const declRel = '00_Inbox/__p716菜单已声明.md';
      const unsetAbs = `${KB}/${unsetRel}`;
      const declAbs = `${KB}/${declRel}`;
      try {
        // 真·未声明（连「文件位置」键都没有）：菜单面不靠行的可见性，这条链对它一样成立
        await writeRaw(unsetRel, `---\n类型: 笔记\ntags: []\n---\n\n# 记号-乙乙\n正文乙乙。\n`);
        await writeRaw(declRel, `---\n类型: 笔记\n文件位置: [00_Inbox]\ntags: []\n---\n\n# 记号-丙丙\n正文丙丙。\n`);
        await H.settleIndex(app);

        ctx().goNotes();
        await H.settle(160);
        const dir0 = await H.enterTopDirWithNotes(ctx(), 1);
        eq(dir0, '00_Inbox', `进到夹具里笔记最多的那一层（${dir0 || '没进去'}）`);
        await H.settle(140);

        // ── 未声明那行：菜单里「就住这儿」可点 → 声明写上、文件不动 ──
        const rowU = H.qa<HTMLElement>(document.body, '.kbw-trow').find(
          (r) => r.dataset.path === unsetAbs,
        );
        ok(rowU, '前提：未声明那篇的行在');
        const ru = rowU!.getBoundingClientRect();
        rowU!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: ru.left + 40,
            clientY: ru.top + 8,
          }),
        );
        await H.settle(150);
        ok(
          await clickMenuPath('改', '属性', '定位', '文件位置'),
          `走到「属性 › 定位 › 文件位置」：${menuLabels().join(' | ')}`,
        );
        const stay = findMenuItem('就住这儿');
        ok(stay, `★ 菜单里有「就住这儿（写声明，不搬）」：${menuLabels().join(' | ')}`);
        ok(
          stay?.getAttribute('aria-disabled') !== 'true',
          '★ 可点（旧实现：置灰，没法只声明不搬）',
        );
        /**
         * **P7.18b 并列项**（用户 2026-10-09 拍板）：未声明时「现处 X（写回当前位置）」
         * 与「就住这儿」**同时在**菜单里 —— 两个语义入口、同一个动作（写声明不搬文件）。
         */
        const hereNew = findMenuItem(`现处 ${dir0}`);
        ok(hereNew, `★ 并列的「现处 ${dir0}」也在：${menuLabels().join(' | ')}`);
        ok(hereNew?.getAttribute('aria-disabled') !== 'true', '……也可点');
        H.click(stay as Element);
        const cfm = await untilEl(() => modalWith('只写声明'), 2500);
        ok(cfm, '确认流弹出来了');
        ok(clickModalBtn(cfm!, '只写声明'), '点了主按钮');
        // 同一条纪律：异步写盘链 → 轮询到索引追上为止（别赌固定毫秒）
        ok(
          await H.until(
            () => declaredPositions(ctx().index.get(unsetAbs)?.props ?? {}).length > 0,
            3000,
            40,
          ),
          '★ 声明写上了',
        );
        await H.settleIndex(app, 200);
        eq(
          declaredPositions(ctx().index.get(unsetAbs)?.props ?? {}).join(','),
          '00_Inbox',
          '★ 声明 == 实际',
        );
        ok(fs.existsSync(path.join(vaultRoot, unsetAbs)), '……文件还在原位（没搬）');
        closeAllMenus();
        await H.settle(120);

        // ── 已声明在处那行：当前所在地照旧置灰 ──
        const rowD = H.qa<HTMLElement>(document.body, '.kbw-trow').find(
          (r) => r.dataset.path === declAbs,
        );
        ok(rowD, '前提：已声明那篇的行在');
        const rd = rowD!.getBoundingClientRect();
        rowD!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rd.left + 40,
            clientY: rd.top + 8,
          }),
        );
        await H.settle(150);
        ok(
          await clickMenuPath('改', '属性', '定位', '文件位置'),
          '再走到选择器',
        );
        const items = H.qa<HTMLElement>(document.body, '.kbw-menu .kbw-menu-item');
        /**
         * ⚠️ **P7.18b 反转**：已声明在处时，当前所在地那项**不再是置灰的目录名**（"它就在这儿"），
         * 而是可点的「现处 X（写回当前位置）」——点了 = 把声明写回现处（已一致时幂等重写）。
         */
        const hereItem = items.find((i) => H.textOf(i).trim().startsWith(`现处 ${dir0}`));
        ok(hereItem != null, `「现处 ${dir0}」在候选里（旧行为：置灰的目录名 +「它就在这儿」）`);
        ok(
          hereItem?.getAttribute('aria-disabled') !== 'true',
          '★ 可点（旧行为：置灰；P7.18b 起全状态可点）',
        );
        closeAllMenus();
        await H.settle(120);
      } finally {
        closeAllMenus();
        purgeOverlays();
        await H.settle(120);
        ctx().goNotes({ dir: '' });
        await H.settle(120);
        await rmFix(path.join(vaultRoot, unsetAbs));
        await rmFix(path.join(vaultRoot, declAbs));
      }
    });

    await suite.it('就住这儿：确认前那一篇刚被别处删掉 → 报出来（别静默"点了没反应"）', async () => {
      const KB = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716竞态篇.md';
      const abs = `${KB}/${rel}`;
      try {
        await writeRaw(rel, `---\n类型: 笔记\ntags: []\n---\n\n# 记号-竞态\n正文。\n`);
        const stale = ctx().index.get(abs);
        ok(stale, '前提：拿到了这一篇的条目');
        await rmFix(path.join(vaultRoot, abs)); // 条目作废：盘上没了（"刚被搬走/删掉"的竞态形状）
        void testOps.declarePositionHere([stale!]);
        const cfm = await untilEl(() => modalWith('只写声明'), 2500);
        ok(cfm, '确认流照弹（渲染用的是条目里那份信息）');
        ok(clickModalBtn(cfm!, '只写声明'), '点了主按钮');
        await H.settle(300);
        ok(
          noticesText().includes('1 篇失败'),
          `★ 全失败要报出来（独立审 🟡：旧实现一声不吭）—— 眼下通知：${noticesText().slice(0, 90)}`,
        );
      } finally {
        closeAllMenus();
        purgeOverlays();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });
}
