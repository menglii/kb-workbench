/**
 * spec：**P7.24 · 树收口三件 + 文件行右键**（2026-10-11）—— 真源 = `P7.24开工提示词.md` 段 0
 *
 * 用户 2026-10-11 真机手验点名的三件（T 系列的小件，全在 `tree.ts` / `menus.ts` 面上）：
 *  · **T1** 行尾「收起」按钮：完全展开后出现、点它 = 与「收起此文件夹」同一实现、
 *    未展开不画、点它不选中该目录；
 *  · **T2** 根节点收起/展开（**决策反转**：根不再"恒开"，吃 `open`，'' = 库根；
 *    默认/迁移补 ''）+ 迁移纯函数（v5→v6 append-if-array · v6 幂等 · normalize 收敛）；
 *  · **T3** 节点菜单「全部收起」（只给根；**连根一起收**——用户 2026-10-11 拍板，
 *    树只剩「整个知识库」一行）；
 *  · **A22**（P7.23 独立审 🟢5 的"等用户拍"）：树文件行右键 = 笔记菜单（拍板"给"）。
 *
 * 自备库（`makeTempVault('p724')`）：T1/T3 要真建目录链 + 完全展开（文件行），
 * 与别的 spec 互不踩。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { makeAiToolPort } from '../../src/ui/ai-tools';
import { closeAllMenus } from '../../src/ui/menu';
import { migrateSettings, normalizeSettings } from '../../src/core/settings';
import { clickMenuPath, menuLabels } from './menu-helpers';

const KB = '01_新知识库';

export async function specP724(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const settings = () => ctx().settings.get();

  /** 节点行（**带 data-drop** 的才是目录 —— 文件行没有它，别用 `.kbw-tree-item` 裸选） */
  const treeNode = (dir: string): HTMLElement | null =>
    H.qa<HTMLElement>(document.body, '.kbw-tree-item[data-drop]').find(
      (el) => (el.dataset.dir ?? '') === dir,
    ) ?? null;
  const fileRows = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-tree-file');
  const caretOpen = (row: HTMLElement | null): boolean =>
    !!row?.querySelector('.kbw-tree-caret.is-open');
  /** 行尾「收起」按钮（P7.24 · T1） */
  const collapseBtn = (row: HTMLElement | null): HTMLElement | null =>
    row ? row.querySelector<HTMLElement>('.kbw-tree-collapse') : null;
  /** 当前选中的树行（`.is-on`）—— "点按钮 ≠ 选中该目录"要有对照 */
  const onDir = (): string | null =>
    H.maybe<HTMLElement>(document.body, '.kbw-tree-item.is-on')?.dataset.dir ?? null;

  /** 右键一个目录节点 → 等菜单挂出来（`where` = 调用点标签，失败信息一眼定位） */
  async function rightClickNode(dir: string, where = ''): Promise<void> {
    closeAllMenus();
    const node = treeNode(dir);
    ok(node, `树里有节点「${dir === '' ? '整个知识库' : dir}」${where ? `（${where}）` : ''}`);
    node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await H.settle(80);
  }

  /** 进「全部笔记」（树要挂出来才有点击目标） */
  async function openNotes(): Promise<void> {
    ctx().goNotes();
    await H.settle(80);
  }

  /** 走界面切模块（照 notes.ts 的 goHome 口径：点导航项 = 真路径） */
  async function gotoModule(label: string): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(nav, `导航里有「${label}」`);
    H.click(nav as Element);
    await H.settle(120);
  }

  /**
   * 把根开回来（前一条用例可能把它收着走的）—— 走产品路径：点根 caret。
   *
   * ⚠️ **按 DOM 判态，不查 `settings`**（P7.24 实测栽过、探针步同款）：展开态落盘是
   * **防抖 400ms** 的 —— 用例收尾把根一收、下一条起手在 400ms 内读 `treeOpen`，
   * 读到的还是**旧值**（说"开着"、界面其实收着）→ 早退 → 后面全塌。
   */
  async function ensureRootOpen(): Promise<void> {
    const root = treeNode('');
    ok(root, '根行在（ensureRootOpen）');
    if (root?.getAttribute('aria-expanded') === 'true') return;
    H.click(H.q<HTMLElement>(root as HTMLElement, '.kbw-tree-caret'));
    ok(await H.until(() => settings().treeOpen.includes(''), 2000, 30), '根开回来了（treeOpen 收回 \'\'）');
    await H.settle(80);
  }

  /**
   * 夹具：`__p724树/A/甲.md`、`__p724树/A/B/乙.md`。
   *
   * ⚠️ 树**只渲染展开节点的子节点** —— 建完还要把「__p724树」展开，
   * 否则连 A 的行都不在 DOM 里。展开走**产品路径**（节点菜单 →「展开子目录」，幂等）。
   */
  async function seedTree(): Promise<void> {
    H.writeNote(vaultRoot, `${KB}/__p724树/A/甲.md`, H.note('# 甲\n'));
    H.writeNote(vaultRoot, `${KB}/__p724树/A/B/乙.md`, H.note('# 乙\n'));
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settle(120);
    await rightClickNode('__p724树', 'seedTree');
    ok(await clickMenuPath('展开子目录'), '先把「__p724树」展开（A 的行才在）');
    await H.settle(120);
    ok(treeNode('__p724树/A'), '「__p724树/A」可见');
  }

  await suite.group('P7.24 · 树收口三件（T1 收起钮 / T2 根可收 / T3 全部收起 / A22 文件行右键）', async () => {
    await suite.it('T1：行尾「收起」—— 展开态出现 · 点它全收且按钮消失 · 未展开不画 · 点它不选中', async () => {
      await openNotes();
      await ensureRootOpen();
      await seedTree();

      // ① 展开态（一层展开）按钮就在；未展开的目录不画它（99_Meta 有子目录、没展开）
      ok(collapseBtn(treeNode('__p724树/A')), 'A 展开态 → 行尾「收起」按钮出现');
      eq(collapseBtn(treeNode('__p724树/A'))?.getAttribute('aria-label'), '收起', 'aria-label = 收起');
      /**
       * 前置自证（独立审 🟢10b 的建议）：99_Meta 得**真在树上且真有子节点**，
       * "不画按钮"才说明得了显示条件 —— 行不在也会"没有按钮"（空洞依赖）。
       */
      const meta = treeNode('99_Meta');
      ok(meta, '99_Meta 行在（这条判据的前提）');
      ok(meta?.querySelector('.kbw-tree-caret:not(.is-leaf)'), '99_Meta 有子目录（前提：不是叶子）');
      ok(collapseBtn(treeNode('99_Meta')) === null, '未展开的目录不画「收起」（99_Meta）');

      // ② 点它 = 与「收起此文件夹」同一实现：子树行/文件行全收、按钮消失、**不选中该目录**
      H.click(treeNode('00_Inbox') as Element); // 先选中别的目录，"不选中 A"才有对照
      await H.settle(80);
      const onBefore = onDir();
      eq(onBefore, '00_Inbox', '先选中 00_Inbox（对照基线）');

      await rightClickNode('__p724树/A');
      ok(await clickMenuPath('完全展开'), '先把 A 完全展开（文件行才有）');
      await H.settle(120);
      ok(collapseBtn(treeNode('__p724树/A')), '完全展开（含文件）态下按钮照在');

      H.click(collapseBtn(treeNode('__p724树/A')) as Element);
      await H.settle(120);
      eq(treeNode('__p724树/A/B'), null, '子树的行收了（B 的行没了）');
      eq(fileRows().length, 0, '文件行也收了');
      ok(!caretOpen(treeNode('__p724树/A')), 'A 的 caret 归位（收起态）');
      eq(collapseBtn(treeNode('__p724树/A')), null, '按钮消失（不再是展开态）');
      ok(
        await H.until(() => !settings().treeShowFiles.includes('__p724树/A'), 1500, 30),
        'treeShowFiles 子树被清（与「收起此文件夹」同一条 collapseDir）',
      );
      eq(onDir(), onBefore, '点「收起」不改变选中（stopPropagation）');

      // ③ 点三角重新展开：后代 open 记录保留（B 仍在原态），文件行**不**跟着回来
      const rowA = treeNode('__p724树/A');
      H.click(H.q<HTMLElement>(rowA as HTMLElement, '.kbw-tree-caret'));
      await H.settle(120);
      ok(caretOpen(treeNode('__p724树/A/B')), 'B 仍在原态（后代 open 记录保留 —— 与 Q3 同款）');
      eq(fileRows().length, 0, '文件行**不**跟着回来（收起时清干净了）');
    });

    await suite.it('T2：点根 caret 真收真开 —— 只剩根行 · 后代 open 保留 · 记忆落设置 · 切模块往返', async () => {
      await openNotes();
      await ensureRootOpen();
      await seedTree();
      ok(caretOpen(treeNode('__p724树')), '起手：__p724树 开着（后代记录后面要用）');

      // ① 点根 caret → 只剩根一行（顶层行全进不了 DOM —— 根不再恒开）
      const rootRow = treeNode('');
      ok(rootRow, '根行在');
      H.click(H.q<HTMLElement>(rootRow as HTMLElement, '.kbw-tree-caret'));
      await H.settle(120);
      eq(treeNode('__p724树'), null, '收起后顶层目录行没了（根不再恒开）');
      eq(treeNode('00_Inbox'), null, '00_Inbox 也没了');
      ok(treeNode('') !== null, '根行自身仍在（收的是子层）');
      ok(!caretOpen(treeNode('')), '根 caret 变成收起态');
      eq(collapseBtn(treeNode('')), null, '根行尾「收起」也消失（不再是展开态）');
      ok(
        await H.until(() => !settings().treeOpen.includes(''), 2000, 30),
        "treeOpen 摘掉 ''（收起已进设置 —— 防抖 400ms 后写盘）",
      );

      // ② 切走再回来 —— 记忆保持（收起态不因模块往返丢失）
      await gotoModule('首页');
      await gotoModule('全部笔记');
      eq(treeNode('__p724树'), null, '切模块往返后仍是收起态');

      // ③ 再点 → 子树照旧回来，且**后代 open 记录保留**（__p724树 仍开着）
      H.click(H.q<HTMLElement>(treeNode('') as HTMLElement, '.kbw-tree-caret'));
      await H.settle(120);
      ok(treeNode('__p724树'), '展开后顶层行回来');
      ok(caretOpen(treeNode('__p724树')), '__p724树 回到原态（后代 open 记录保留 —— 与 Q3 同款）');
      ok(await H.until(() => settings().treeOpen.includes(''), 2000, 30), "treeOpen 收回 ''（展开已进设置）");
    });

    await suite.it('T2 迁移：v5 存量补 \'\' · 空数组也补 · 缺失不写 · v6 幂等 · normalize 收敛（纯函数）', () => {
      const m5 = migrateSettings({ settingsVersion: 5, treeOpen: ['05_操作日志'] }) as Record<
        string,
        unknown
      >;
      deepEq(m5.treeOpen, ['05_操作日志', ''], "v5→v6：补 ''（append-if-array，存量根开物化）");
      eq(m5.settingsVersion, 6, '版本戳升到 6');
      const m5empty = migrateSettings({ settingsVersion: 5, treeOpen: [] }) as Record<string, unknown>;
      deepEq(m5empty.treeOpen, [''], "v5 的空数组也补（迁移前根就是恒开的）");
      const m5missing = migrateSettings({ settingsVersion: 5 }) as Record<string, unknown>;
      ok(!('treeOpen' in m5missing), 'treeOpen 缺失 → 不写（默认/规范化顶）');
      const m6 = migrateSettings({ settingsVersion: 6, treeOpen: [] }) as Record<string, unknown>;
      deepEq(m6.treeOpen, [], "已是最新版本 → 原样返回（幂等：用户收起的根不会被\"复活\"）");
      deepEq(normalizeSettings({}).treeOpen, [''], "默认 = ['']（根默认开）");
      deepEq(
        normalizeSettings({ treeOpen: ['a', 1, '', null, 'b'] }).treeOpen,
        ['a', '', 'b'],
        "normalize 白名单：'' 是合法项、非字符串剔掉",
      );
    });

    await suite.it('T2 补：根收起时双击文件夹格（openDir）把树展开到看得见它（评审 🟡3）', async () => {
      await openNotes();
      await ensureRootOpen();
      // 切到网格（双击进目录那条路是网格口径；默认可能就是网格，显式切一下）
      const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
        H.textOf(b).includes('网格'),
      );
      ok(seg, '视图档「网格」按钮在');
      H.click(seg as Element);
      await H.settle(80);
      // 收起根
      H.click(H.q<HTMLElement>(treeNode('') as HTMLElement, '.kbw-tree-caret'));
      await H.settle(120);
      eq(treeNode('01_Projects'), null, '前提：根收起、顶层行不渲染');

      /**
       * 双击文件夹格 = `openDir`（同一件事的产物路径）。
       * ⚠️ **不走「在此新建目录」那条**：它起 vault 事件 → 测试环境会撞
       * "indexReady 翻转引发重挂"家族（P7.23 记档的本家）—— 对话框的 `.then` 落在
       * **已死的模块实例**上、openDir 的写入随实例一起丢（实测：`#3 dispose → #4 mount →
       * openDir 跑在 #3`）。双击这条不起 vault 事件、专测 openDir 本身。
       */
      const cell = H.qa<HTMLElement>(document.body, '.kbw-gcell.is-folder').find(
        (c) => c.dataset.dir === '01_Projects',
      );
      ok(cell, '网格里有 01_Projects 的文件夹格');
      // 真机的双击序列是 click → click → dblclick（grid.ts 同款）
      for (const t of ['click', 'click', 'dblclick']) {
        cell?.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      }
      await H.settle(150);
      ok(treeNode('01_Projects'), "树展开到看得见它（根被收着时也要 —— openDir 补 '' 那一行）");
      ok(caretOpen(treeNode('01_Projects')), '进到的目录在树上也是展开态');
      eq(onDir(), '01_Projects', '树的选中跟着走到它（同一件事的下游）');
    });

    await suite.it('T2 补：根收起时树键盘 ↓ 不会落到没渲染的行（评审 🔴2）', async () => {
      await openNotes();
      await ensureRootOpen();
      H.click(H.q<HTMLElement>(treeNode('') as HTMLElement, '.kbw-tree-caret'));
      await H.settle(120);
      eq(treeNode('01_Projects'), null, '前提：根收起、顶层行不渲染');

      // 焦点进树 + 按 ↓（走产品键路：document 捕获 → keymap → onKey → onTreeKey）
      const body = H.q<HTMLElement>(document.body, '.kbw-tree-body');
      body.focus();
      H.keydown(body, 'ArrowDown');
      await H.settle(80);
      eq(onDir(), '', '↓ 之后选中仍在根（落到没渲染的目录 = 评审 🔴2 的漏网点）');
    });

    await suite.it('T3：根菜单「全部收起」= 连根一起收（只剩根行）· 空白菜单那条同一实现', async () => {
      await openNotes();
      await ensureRootOpen();
      await seedTree();

      // 先展开点东西（全部收起得有东西可收）
      await rightClickNode('__p724树', 'T3-a 先展开');
      ok(await clickMenuPath('展开子目录'), '先展开点东西');
      await H.settle(120);

      // ① 根菜单那条
      await rightClickNode('');
      ok(await clickMenuPath('全部收起'), '根菜单里点「全部收起」');
      await H.settle(120);
      ok(treeNode('') !== null, '只剩根一行（根自己也收了 —— 用户 2026-10-11 拍"连根一起收"）');
      eq(treeNode('__p724树'), null, '顶层行全没了');
      eq(treeNode('00_Inbox'), null, '00_Inbox 也没了');
      eq(fileRows().length, 0, '没有文件行');
      ok(await H.until(() => settings().treeOpen.length === 0, 2000, 30), 'treeOpen 清空');
      ok(await H.until(() => settings().treeShowFiles.length === 0, 2000, 30), 'treeShowFiles 清空');

      // ② 空白菜单那条 = 同一实现（`index.ts` 的 `collapseAll`）：再展开点东西，走一遍，落点状态一样
      await ensureRootOpen();
      await rightClickNode('__p724树', 'T3-c 再展开');
      ok(await clickMenuPath('展开子目录'), '再展开点东西（走空白菜单那条）');
      await H.settle(120);
      const bodyEl = H.q<HTMLElement>(document.body, '.kbw-tree-body');
      bodyEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await H.settle(80);
      ok(await clickMenuPath('全部收起'), '空白菜单里点「全部收起」');
      await H.settle(120);
      ok(await H.until(() => settings().treeOpen.length === 0, 2000, 30), '空白菜单同样清空 treeOpen（同一实现）');
      eq(treeNode('__p724树'), null, '树同样只剩根一行');
    });

    await suite.it('A22：文件行右键 = 笔记菜单（与列表行同一份 showNoteMenu；模板行也照给）', async () => {
      await openNotes();
      await ensureRootOpen();
      await seedTree();
      await rightClickNode('__p724树/A');
      ok(await clickMenuPath('完全展开'), '完全展开 A（文件行才有）');
      await H.settle(120);

      const row甲 = fileRows().find((r) => (r.dataset.path ?? '').endsWith('/甲.md'));
      ok(row甲, '「甲」的文件行在');
      closeAllMenus();
      row甲?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await H.settle(80);
      const labels = menuLabels();
      ok(labels.length > 0, `文件行右键弹菜单了（实际：${labels.join(' | ')}）`);
      ok(labels[0]?.startsWith('打开'), '首项是「打开」（笔记菜单形状）');
      ok(
        labels.some((l) => l.includes('问 AI（这一篇）')),
        '含「问 AI（这一篇）」（与列表行同一份 showNoteMenu）',
      );
      closeAllMenus();
      await H.settle(60);

      // 模板行的右键也照给（模板守卫管的是"不可拖"，别把菜单一起裁掉）
      H.writeNote(vaultRoot, `${KB}/__p724树/A/T_模板.md`, H.note('# 模板体\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(120);
      const tplRow = fileRows().find((r) => (r.dataset.path ?? '').endsWith('/T_模板.md'));
      ok(tplRow, '模板的文件行在（完全展开态未动，照列）');
      tplRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await H.settle(80);
      const tplLabels = menuLabels();
      ok(tplLabels.length > 0, `模板行右键也给菜单（实际：${tplLabels.join(' | ')}）`);
      ok(tplLabels[0]?.startsWith('打开'), '模板行首项同样是「打开」');
      closeAllMenus();
      await H.settle(60);
    });

    await suite.it('收场：删 __p724树 夹具（自清理）+ 盘上字节自证（评审 🟢7）', async () => {
      H.rmrf(path.join(vaultRoot, KB, '__p724树'));
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(120);
      eq(treeNode('__p724树'), null, '夹具从树里消失');

      /**
       * **盘上字节自证**（独立审 🟢7 的补法）：前面各用例的"记忆"断言钉的是内存
       * SettingsStore + persist 防抖接线；这里把**防抖已刷后的 data.json** 读回来，
       * 确认 `treeOpen` 真的写到了盘（此刻根是开的 —— '' 应在）。
       */
      await H.until(() => JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')).treeOpen?.includes?.('') === true, 2000, 50);
      const dj = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as Record<string, unknown>;
      ok(
        Array.isArray(dj.treeOpen) && (dj.treeOpen as string[]).includes(''),
        `盘上 data.json 的 treeOpen 含 ''（实际 ${JSON.stringify(dj.treeOpen)}）`,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════
  // 段一 · #12：配置面只读（库结构 / 看板配置 / 模板清单进 stats）
  // ═════════════════════════════════════════════════════════════
  await suite.group('P7.24 · 段一 #12（stats 配置面只读）', async () => {
    /** 经假 port 跑 stats（与 p721 同一条驱动路：只读工具直连执行体） */
    const statsOut = async (): Promise<{ ok: boolean; summary: string; detail?: string }> => {
      const port = makeAiToolPort({
        ctx: ctx(),
        askPending: async () => [],
        allowTools: null as never,
      });
      const out = await port.runBatch([{ tool: 'stats', args: {} }], {});
      return out[0] as { ok: boolean; summary: string; detail?: string };
    };

    /** 配置文件的两个磁盘路径（vault 绝对）——记下初始态，收尾原样还回去 */
    const cfgAbs = (name: 'board' | 'rebuild'): string =>
      path.join(vaultRoot, ctx().configs.pathOf(name));
    const boardAbs = cfgAbs('board');
    const rebuildAbs = cfgAbs('rebuild');
    const boardHad = fs.existsSync(boardAbs);
    const boardOrig = boardHad ? fs.readFileSync(boardAbs, 'utf8') : '';
    const rebuildHad = fs.existsSync(rebuildAbs);
    const rebuildOrig = rebuildHad ? fs.readFileSync(rebuildAbs, 'utf8') : '';

    await suite.it('#12a：三份配置的存在态如实报（结构条目数 / 看板板块数 / 模板清单）', async () => {
      fs.mkdirSync(path.dirname(rebuildAbs), { recursive: true });
      fs.writeFileSync(
        rebuildAbs,
        JSON.stringify({ version: 1, rootName: '01_新知识库', dirs: ['00_Inbox', '01_Projects'] }),
        'utf8',
      );
      fs.writeFileSync(
        boardAbs,
        JSON.stringify({ version: 1, view: { name: '看板' }, sections: [{}, {}] }),
        'utf8',
      );
      app.vault.rescan();
      await H.settle(120);
      const out = await statsOut();
      eq(out.ok, true, 'stats 出得来');
      const detail = String(out.detail ?? '');
      contains(detail, '库级配置（只读）', 'detail 有「库级配置」段');
      contains(detail, '库结构.json：2 个目录', '库结构如实报条目数（写了两条目录）');
      contains(detail, '看板配置.json：2 个板块', '看板如实报板块数（写了两个板块）');
      contains(detail, '模板清单', '模板清单段在');
    });

    await suite.it('#12b：缺失态如实说「没有这份配置」· 坏文件如实说「读不出来」（都不许造/糊默认值）', async () => {
      // ① 坏 JSON：`configs.read` 会静默退回 defaults（报"0 个目录"）——#12 直读自解析，必须如实
      fs.writeFileSync(rebuildAbs, '{ 坏掉的 json', 'utf8');
      app.vault.rescan();
      await H.settle(120);
      const broken = await statsOut();
      const bDetail = String(broken.detail ?? '');
      contains(bDetail, '库结构.json：读不出来', '坏 JSON → 如实"读不出来"');
      ok(
        !bDetail.includes('库结构.json：0 个目录'),
        '坏文件不许被报成"0 个目录"（静默顶默认值 = 假信息）',
      );
      // ② 形状认不出（🟢13）：{} / {"dirs":42} 不许报成"0 个目录"
      fs.writeFileSync(rebuildAbs, JSON.stringify({ dirs: 42 }), 'utf8');
      app.vault.rescan();
      await H.settle(120);
      const shape = await statsOut();
      const sDetail = String(shape.detail ?? '');
      contains(sDetail, '库结构.json：形状认不出', '形状不对 → 如实"形状认不出"');
      ok(!sDetail.includes('库结构.json：0 个目录'), '"形状不对"不许糊成"0 个目录"');
      // ③ 缺失：如实说"没有这份配置"、不造默认值
      H.rmrf(rebuildAbs);
      app.vault.rescan();
      await H.settle(120);
      const out = await statsOut();
      const detail = String(out.detail ?? '');
      contains(detail, '库结构.json：没有这份配置', '缺失 = 如实说「没有这份配置」');
      ok(
        !detail.includes('库结构.json：0 个目录'),
        '不许拿 defaults() 造一份（0 个目录 = 造了默认值，判为假绿）',
      );
    });

    await suite.it('#12c：只读 —— 写面 spy 零调用（运行时）', async () => {
      const spies: string[] = [];
      const wrap = (obj: Record<string, unknown> | null, key: string, tag: string): (() => void) => {
        const orig = obj?.[key];
        if (!obj || typeof orig !== 'function') return () => undefined;
        obj[key] = (...args: unknown[]): unknown => {
          spies.push(tag);
          return (orig as (...a: unknown[]) => unknown).apply(obj, args);
        };
        return () => {
          obj[key] = orig;
        };
      };
      const c = ctx() as unknown as { configs: Record<string, unknown>; fm: Record<string, unknown> };
      const vault = app.vault as unknown as Record<string, unknown>;
      const adapter = (app.vault as unknown as { adapter: Record<string, unknown> }).adapter;
      /** 🟢12（独立审）：写面动词全表（不只原来那七个）—— 静态红线之外的第二张网也要宽 */
      const restores = [
        wrap(c.configs, 'write', 'configs.write'),
        wrap(c.configs, 'ensure', 'configs.ensure'),
        wrap(vault, 'process', 'vault.process'),
        wrap(vault, 'create', 'vault.create'),
        wrap(vault, 'modify', 'vault.modify'),
        wrap(vault, 'delete', 'vault.delete'),
        wrap(vault, 'rename', 'vault.rename'),
        wrap(adapter, 'write', 'adapter.write'),
        wrap(adapter, 'mkdir', 'adapter.mkdir'),
        wrap(adapter, 'rmdir', 'adapter.rmdir'),
        wrap(c.fm, 'setMany', 'fm.setMany'),
        wrap(c.fm, 'remove', 'fm.remove'),
        wrap(c.fm, 'set', 'fm.set'),
        wrap(c.fm, 'update', 'fm.update'),
      ];
      try {
        const out = await statsOut();
        eq(out.ok, true, 'stats 照常出得来（spy 在场）');
      } finally {
        for (const r of restores) r();
      }
      eq(spies.length, 0, `只读：写面零调用（实际：${spies.join(' · ') || '无'}）`);
    });

    await suite.it('#12d：只读 —— 标记块静态红线（独立审 🔴3 修：锚到行首注释，别切到 JSDoc 举例）', () => {
      const src = H.readNote(H.repoRoot(), 'src/ui/ai-tools.ts');
      /**
       * 🔴3（独立审）：第一版 `indexOf('[P7.24-12-BEGIN]')` 命中的是 JSDoc 里的**举例字面**
       * （块 = 18 字符、七条断言恒真 —— 静态守卫等于不存在）。锚定到**行首注释**才唯一。
       */
      const begin = src.indexOf('// [P7.24-12-BEGIN]');
      const end = src.indexOf('// [P7.24-12-END]');
      ok(begin >= 0 && end > begin, '标记块在（行首注释 // [P7.24-12-BEGIN] .. // [P7.24-12-END]）');
      const block = src.slice(begin, end);
      // 块长哨兵：防"切了个空块还全绿"同类复发（真块 ~1.5KB）
      ok(block.length > 800, `块体积像真的（实际 ${block.length} 字符 —— 小于 800 就是切错了）`);
      for (const bad of [
        'configs.write',
        'configs.ensure',
        'vault.process',
        'vault.modify',
        'vault.create',
        'vault.delete',
        'vault.rename',
        'adapter.write',
        'adapter.mkdir',
        'adapter.rmdir',
        'processFrontMatter',
        'mover.',
      ]) {
        ok(!block.includes(bad), `标记块内不出现写调用：${bad}`);
      }
    });

    await suite.it('收尾：两份配置恢复初始态', async () => {
      const put = (abs: string, had: boolean, orig: string): void => {
        if (had) fs.writeFileSync(abs, orig, 'utf8');
        else H.rmrf(abs);
      };
      put(boardAbs, boardHad, boardOrig);
      put(rebuildAbs, rebuildHad, rebuildOrig);
      app.vault.rescan();
      await H.settle(80);
      eq(fs.existsSync(boardAbs), boardHad, '看板配置恢复初始态');
      eq(fs.existsSync(rebuildAbs), rebuildHad, '库结构恢复初始态');
    });
  });
}
