/**
 * spec：**P7.16b · YAML 专项 · 一补**（原生属性面板「文件位置」那一格 + 选目录补声明 + 小窗改名刷新）
 * —— 条目真源 `P7.16b开工提示词.md` §1；规格回改 `交互规格.md` §8.5。
 *
 * 三组：
 *   · **原生面板那一格（假平台 DOM 全链）** —— 造平台形状的假件
 *     （`.metadata-property[data-property-key="文件位置"] > .multi-select-input`）→ 聚焦 →
 *     我们的菜单开出且候选 = 现算目录（建目录后重开就变）→ 选目录 → 确认流 →
 *     搬 + **未声明也写声明**（本轮新口径）→ 撤销还原；遮蔽类（body 上）开/关跟着走；
 *     手打（input 事件）收菜；Esc 收菜；库外/认不出 → 静默退化（不弹、不抛）。
 *   · **共享链的三处统一** —— 小窗选择器那条老编辑面走同一条链：未声明选目录 →
 *     搬 + 写声明（口径覆盖到了它）。
 *   · **小窗·目录改名刷新**（P7.16 独立审 🟡#4 的那条账）—— 目录改名 → 「文件位置」
 *     候选立刻变（同一扇、不重挂编辑器）。
 *
 * ⚠️ 夹具全带 `__p716b` 前缀，每条自己收场（`metadataCache.settle()` 那套安全删法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { joinPath } from '../../src/core/paths';
import { declaredPositions } from '../../src/services/schema';
import { NotesOps } from '../../src/modules/notes/ops';
import {
  closeCardPanel,
  ensureWindowDeps,
  openCardWindow,
  type CardWindowCtx,
} from '../../src/modules/board/editor';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { NATIVE_MENU_OPEN_CLASS } from '../../src/ui/native-position';

export async function specP716b(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const KB = '01_新知识库';

  /** kbRoot 拨回默认（每个 spec 自己的库，防御性自证前提 —— 与 p715/p716 同款） */
  async function ensureKbRootDefault(): Promise<string> {
    if (ctx().settings.kbRoot() !== KB) {
      await ctx().settings.save({ kbRoot: KB });
      await H.settle(150);
    }
    return KB;
  }

  /**
   * 安全带删法（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 metadataCache 还有一个
   * ~300ms 的滞后重解析定时器 —— 删完必须 `settle()` + 重建索引。
   * ⚠️ 收的是 **OS 绝对路径**（vaultRoot 之下）。
   */
  async function rmFix(abs: string): Promise<void> {
    fs.rmSync(abs, { force: true, recursive: true });
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(120);
  }

  /** 造自用夹具（裸文本；文件位置要写 `[]` 这种形状，H.note 序列化不出来） */
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

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 2500): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  function modalWith(needle: string): HTMLElement | null {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal').filter((m) =>
      H.textOf(m).includes(needle),
    );
    return all.length > 0 ? all[all.length - 1] : null;
  }

  function clickModalBtn(modal: HTMLElement, btnText: string): boolean {
    const b = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
      H.textOf(x).includes(btnText),
    );
    if (!b) return false;
    H.click(b);
    return true;
  }

  // ── 原生面板那一格的"假平台 DOM" ───────────────────────────────
  /**
   * 照 2026-10-08 晚真机活体 DOM 实测的形状造那一格（`P7.16b开工提示词.md` §1 现状那一段）：
   * `.metadata-property[data-property-key] > .metadata-property-value[data-property-type=multitext]
   *  > .multi-select-container > .multi-select-input[contenteditable]`。
   * 挂进**某片叶的容器**里 —— 我们的钩子就是靠"哪片叶装着它"反认是哪一篇的（`fileForEl`）。
   */
  function mountCell(host: HTMLElement): HTMLElement {
    const container = document.createElement('div');
    container.className = 'metadata-container';
    const list = document.createElement('div');
    list.className = 'metadata-properties';
    const cell = document.createElement('div');
    cell.className = 'metadata-property';
    cell.setAttribute('data-property-key', '文件位置');
    const value = document.createElement('div');
    value.className = 'metadata-property-value';
    value.setAttribute('data-property-type', 'multitext');
    const ms = document.createElement('div');
    ms.className = 'multi-select-container';
    const input = document.createElement('div');
    input.className = 'multi-select-input';
    input.setAttribute('contenteditable', 'true');
    ms.appendChild(input);
    value.appendChild(ms);
    cell.appendChild(value);
    list.appendChild(cell);
    container.appendChild(list);
    host.appendChild(container);
    return input;
  }

  /** 开一片真 markdown 叶（桩里 = 平台笔记视图的形状），把假格子挂进去 */
  async function openLeafWithCell(abs: string): Promise<{ input: HTMLElement; detach: () => void }> {
    const leaf = app.workspace.getLeaf(false) as unknown as {
      setViewState: (s: unknown) => Promise<void>;
      view: { containerEl: HTMLElement };
      detach?: () => void;
    };
    await leaf.setViewState({ type: 'markdown', state: { file: abs } });
    return {
      input: mountCell(leaf.view.containerEl),
      detach: () => {
        try {
          leaf.detach?.();
        } catch {
          /* 尽力 */
        }
      },
    };
  }

  const menuItems = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-menu-item');
  const menuText = (): string => H.qa<HTMLElement>(document.body, '.kbw-menu').map(H.textOf).join(' ｜ ');
  const openMenuFrom = (input: HTMLElement): void => {
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  };

  // ════════════════════════════════════════════════════════════
  // 一 · 原生面板那一格：假平台 DOM 上的全链
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.16b · 原生面板那一格（假平台 DOM 全链）', async () => {
    await suite.it('聚焦那一格 → 我们的目录菜单（现算候选）→ 选目录 → 确认 → 搬 + 未声明也写声明 → 撤销还原', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716b原生.md';
      const abs = `${kb}/${rel}`;
      const RAW = `---\n类型: 笔记\n文件位置: []\ntags: []\n---\n\n# 记号-原\n正文原，一字不动。\n`;
      const dirRel = '00_Inbox/__p716b新夹';
      const movedAbs = `${dirRel}/__p716b原生.md`;
      let cell: { input: HTMLElement; detach: () => void } | null = null;
      try {
        const absPath = await writeRaw(rel, RAW);
        eq(absPath, abs, '前提：夹具落在库根之下');
        await app.vault.createFolder(`${kb}/${dirRel}`);
        await app.vault.createFolder(`${kb}/00_Inbox/__p716b改名前`);
        /**
         * ⚠️ **造完目录要对齐一次索引**（P7.16b 实测记档）：桩的 `createFolder` 会整盘
         * `scan()` —— 换一批新对象，而索引（以及后面 `view.file`）认的是**哪一批**必须一致，
         * 否则 mover 重命名的是"另一批里的"对象、`view.file` 停在老路径上，
         * 搬完之后钩子认出的路径就查无此篇（菜单不弹）。rebuild 把索引换成当前这批。
         */
        ctx().index.rebuild();
        await H.settle(220);
        ok(ctx().index.get(abs) != null, '前提：那一篇在索引里');

        cell = await openLeafWithCell(abs);
        // ── 开菜单：认得出那一篇 + 现算候选 ──
        openMenuFrom(cell.input);
        await H.settle(150);
        const menu = await untilEl(() => H.maybe<HTMLElement>(document.body, '.kbw-menu'));
        ok(menu, `★ 聚焦那一格 → 我们的菜单开出来了（${menuText()}）`);
        contains(menuText(), '作用范围：__p716b原生', '★ 作用域行常驻（硬规矩 1，写明改的是哪一篇）');
        contains(menuText(), dirRel, '★ 候选里有库里真实的目录（现算）');
        contains(menuText(), '库根', '候选里有「库根」那一项');
        contains(
          menuText(),
          '就住这儿（写声明，不搬）',
          '★ 未声明 + 当前所在地 → 与另两处同一份口径（positionItems 同一个函数）',
        );
        eq(
          document.body.classList.contains(NATIVE_MENU_OPEN_CLASS),
          true,
          '★ 菜单开着 → body 上挂着遮蔽类（平台自己的建议由作用域 CSS 藏起来）',
        );

        // ── 现算是"现算"：关掉 → 改一个目录名 → 重开就该是新名（见下面为什么用改名验） ──
        H.keydown(document.body, 'Escape');
        await H.settle(150);
        eq(H.maybe(document.body, '.kbw-menu'), null, 'Esc 收菜单');
        eq(
          document.body.classList.contains(NATIVE_MENU_OPEN_CLASS),
          false,
          '★ 菜单关了 → 遮蔽类跟着摘掉',
        );
        /**
         * ⚠️ 为什么用"**改一个目录名**"而不是"新建目录"来验现算（P7.16b 实测记档）：
         * 桩的 `createFolder` 会整盘 `scan()`（换一批新对象），而**索引/这一格手里的还是旧对象**
         * —— 之后 mover 重命名的是 byPath 里那一个新对象，`view.file` 停在老路径上，
         * 下一拍钩子认出的路径就"查无此篇"（症状：搬完之后再聚焦那一格，菜单不弹）。
         * 改名走桩的 `vault.rename`（就地改、不换对象）——既验了现算，又不搅乱对象身份。
         */
        const lateDir = '00_Inbox/__p716b后建夹';
        ok(!menuText().includes(lateDir), '前提：改名之前候选里没有它');
        const folder = app.vault.getAbstractFileByPath(`${kb}/00_Inbox/__p716b改名前`);
        ok(folder != null, '前提：拿得到要改名的那个目录节点');
        await app.vault.rename(folder as never, `${kb}/${lateDir}`);
        await H.settle(200);
        openMenuFrom(cell.input);
        await H.settle(150);
        contains(menuText(), lateDir, '★ 目录改名之后再开菜单：候选立刻是新名（现算、不缓存）');
        ok(!menuText().includes('__p716b改名前'), '……旧名不在候选里');

        // ── 选目录 → 确认流 → 搬 + 写声明 ──
        const item = menuItems().find((i) => H.textOf(i).includes(dirRel));
        ok(item, `★ 菜单里点到「${dirRel}」那一项`);
        H.click(item as Element);
        await H.settle(200);
        const cfm = await untilEl(() => modalWith('搬到'), 2500);
        ok(cfm, '★ 选中 → 确认流（动库前确认只能过 ui/confirm）');
        contains(H.textOf(cfm!), '搬到', '确认单主按钮写明搬去哪');
        eq(
          document.body.classList.contains(NATIVE_MENU_OPEN_CLASS),
          false,
          '选完项菜单就关了 → 遮蔽类同步摘掉',
        );
        /**
         * ★ **动作在飞（确认流期间）→ "焦点回归"不许把菜单开回来**（P7.16b 真机首跑抓到的
         * 那枚：确认流的模态关掉时会把焦点还给那一格的输入框 → focusin → 菜单自己弹回来）。
         * 这里在模态还开着时补派一次 focusin —— 模拟的正是"焦点回到那一格"那一拍。
         */
        openMenuFrom(cell.input);
        await H.settle(120);
        eq(
          H.maybe(document.body, '.kbw-menu'),
          null,
          '★ 确认流还没点、动作在飞：焦点回到那一格也不重开菜单（守卫）',
        );
        ok(clickModalBtn(cfm!, '搬到'), '点了主按钮');
        /**
         * ★ **真焦点回归**（P7.17 · 欠账复盘把这里的替身升成真链）：确认流的模态关掉时
         * 会把焦点**还给它打开之前那一个**（`ui/panel.ts` 的 `previouslyFocused.focus()`）
         * —— 那一个正是这一格的输入框（打开菜单时 `openFor` 真 `input.focus()` 过；
         * **jsdom 对 contenteditable 的焦点是真的** —— 2026-10-09 实测，交接里"焦点是假的"
         * 那句作废）→ **真的一发 focusin** 打过来。上面手补派发那条是近似；这一条不点任何火：
         * 焦点真的回去了、菜单也真的没被顶开（守卫在）。
         */
        await H.settle(150);
        eq(document.activeElement, cell.input, '★ 模态关掉后焦点真的回到了那一格（真 focusin 的源头）');
        eq(
          H.maybe(document.body, '.kbw-menu'),
          null,
          '★ 真焦点回归没有把菜单顶开（动作在飞守卫，不是手补的 focusin）',
        );
        /**
         * ⚠️ 写盘是**异步链**（确认 → mover → 滞后重解析 → 索引 flush）——
         * 固定 settle 赌不到（P7.5/P7.1b 纪律：等异步一律轮询）。
         * 轮询条件取"文件到位 **且** 声明 == 实际落点"。
         */
        ok(
          await H.until(() => {
            const e = ctx().index.get(`${kb}/${movedAbs}`);
            return e != null && declaredPositions(e.props).join(',') === dirRel;
          }, 4000, 40),
          `★ 文件到位 + 「文件位置」写成实际落点（未声明的也写上）—— 盘上：${
            fs.existsSync(path.join(vaultRoot, `${kb}/${movedAbs}`)) ? '已挪' : '没挪'
          }；声明=${JSON.stringify(
            declaredPositions(ctx().index.get(`${kb}/${movedAbs}`)?.props ?? {}),
          )}`,
        );
        ok(!fs.existsSync(path.join(vaultRoot, abs)), '★ 原位置没留副本');
        const e2 = ctx().index.get(`${kb}/${movedAbs}`);
        ok(!(e2?.flags.includes('position-mismatch') ?? true), '……所以不报错位（两条后果一致）');

        // ★ 动作**结束之后**照旧：再聚焦那一格还能开（守卫只挡"在飞期间"）
        await H.settle(120);
        openMenuFrom(cell.input);
        await H.settle(150);
        ok(
          H.maybe(document.body, '.kbw-menu') != null,
          '★ 动作结束后：再聚焦那一格还能开菜单（守卫只挡在飞期间）',
        );
        H.keydown(document.body, 'Escape');
        await H.settle(120);

        // ── 撤销还原（快照）──
        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '★ 搬完出撤销条（快照兜底）');
        H.click(u as Element);
        ok(
          await H.until(
            () => fs.existsSync(path.join(vaultRoot, abs)) && !fs.existsSync(path.join(vaultRoot, `${kb}/${movedAbs}`)),
            4000,
            40,
          ),
          '★ 撤销 = 快照还原：文件回到原位',
        );
        eq(
          fs.readFileSync(path.join(vaultRoot, abs), 'utf8'),
          RAW,
          '★ 逐字节回到原样（连"未声明"的形状一起还回来）',
        );
      } finally {
        closeAllMenus();
        purgeOverlays();
        cell?.detach();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, `${kb}/${dirRel}`));
        await rmFix(path.join(vaultRoot, `${kb}/00_Inbox/__p716b后建夹`));
        await rmFix(path.join(vaultRoot, `${kb}/${movedAbs}`));
        await rmFix(path.join(vaultRoot, abs));
        ctx().goNotes({ dir: '' });
        await H.settle(120);
      }
    });

    await suite.it('手打不受影响（input 收菜）· 认不出就静默退化（库外 / 不在叶里）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716b手打.md';
      const abs = `${kb}/${rel}`;
      const outsideRel = '__p716b库外.md';
      let cell: { input: HTMLElement; detach: () => void } | null = null;
      let outsideCell: { input: HTMLElement; detach: () => void } | null = null;
      let orphan: HTMLElement | null = null;
      try {
        await writeRaw(rel, `---\n类型: 笔记\n文件位置: [00_Inbox]\ntags: []\n---\n\n# 记号-打\n正文打。\n`);
        // 库外的一篇（不在 kbRoot 之下 → 索引不收它）
        const outAbs = outsideRel;
        fs.writeFileSync(path.join(vaultRoot, outAbs), `---\n类型: 笔记\n文件位置: []\n---\n\n# 库外\n`, 'utf8');
        app.vault.rescan();
        await app.metadataCache.settle();
        ctx().index.rebuild();
        await H.settle(150);
        ok(ctx().index.get(outAbs) == null, '前提：库外那篇不在索引里');

        // ── 手打：菜单开着 → 敲进那一格（input 事件）→ 我们的菜单收掉、平台的路让回去 ──
        cell = await openLeafWithCell(abs);
        openMenuFrom(cell.input);
        await H.settle(150);
        ok(H.maybe(document.body, '.kbw-menu') != null, '前提：菜单开出来了');
        cell.input.dispatchEvent(new Event('input', { bubbles: true }));
        await H.settle(120);
        eq(H.maybe(document.body, '.kbw-menu'), null, '★ 一敲（input）→ 我们的菜单收菜，让平台自己的建议接回去');
        eq(
          document.body.classList.contains(NATIVE_MENU_OPEN_CLASS),
          false,
          '……遮蔽类同步摘掉',
        );
        // 再点还能开（click 触发那条路）
        H.realClick(cell.input);
        await H.settle(150);
        ok(H.maybe(document.body, '.kbw-menu') != null, '★ 点击（完整鼠标序列）也能开出来');
        H.keydown(document.body, 'Escape');
        await H.settle(120);

        // ── 静默退化 ①：库外笔记（索引里没有）→ 不弹、不抛 ──
        outsideCell = await openLeafWithCell(outAbs);
        outsideCell.input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await H.settle(150);
        eq(H.maybe(document.body, '.kbw-menu'), null, '★ 库外的笔记 → 不弹菜单（静默退化，平台那片照旧）');
        // ── 静默退化 ②：格子不在任何一片叶里（认不出是哪一篇）──
        orphan = document.createElement('div');
        document.body.appendChild(orphan);
        const orphanInput = mountCell(orphan);
        orphanInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await H.settle(150);
        eq(H.maybe(document.body, '.kbw-menu'), null, '★ 认不出是哪一篇 → 不弹菜单（静默退化）');
      } finally {
        closeAllMenus();
        purgeOverlays();
        cell?.detach();
        outsideCell?.detach();
        orphan?.remove();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, abs));
        await rmFix(path.join(vaultRoot, outsideRel));
        ctx().goNotes({ dir: '' });
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 二 · 共享链的三处统一：小窗那条老编辑面也走补声明
  // ════════════════════════════════════════════════════════════
  const testOps = new NotesOps(ctx(), () => {});
  const panelDeps = (): CardWindowCtx => ({ ...ensureWindowDeps(ctx()), ops: testOps });
  let propsOn = false;
  async function ensurePanelProps(): Promise<void> {
    if (propsOn) return;
    await H.settle(200);
    await panelDeps().cfg.patchView({ panelProps: 'few' });
    propsOn = true;
    await H.settle(250);
  }

  const cwPanel = (): HTMLElement | null => {
    const all = H.qa<HTMLElement>(document.body, '.kbw-cw-panel');
    return all.length > 0 ? all[all.length - 1] : null;
  };
  const propRow = (name: string): HTMLElement | null =>
    H.qa<HTMLElement>(document.body, '.kbw-cw-row').find(
      (r) => (r.querySelector('.kbw-cw-k')?.textContent ?? '') === name,
    ) ?? null;

  await suite.group('P7.16b · 小窗那条链（三处统一 + 目录改名刷新）', async () => {
    await suite.it('小窗选择器：未声明选目录 → 搬 + 写声明（补声明口径覆盖老编辑面）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716b小窗.md';
      const abs = `${kb}/${rel}`;
      const dirRel = '00_Inbox/__p716b小窗夹';
      const movedRel = `${dirRel}/__p716b小窗.md`;
      const RAW = `---\n类型: 笔记\n文件位置: []\ntags: []\n---\n\n# 记号-窗\n正文窗，一字不动。\n`;
      try {
        await writeRaw(rel, RAW);
        await app.vault.createFolder(`${kb}/${dirRel}`);
        await H.settle(220);
        await ensurePanelProps();
        openCardWindow(ctx().index.get(abs)!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        const sel = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(sel, '前提：「文件位置」选择器在');
        sel!.value = dirRel;
        sel!.dispatchEvent(new Event('change'));
        const cfm = await untilEl(() => modalWith('搬到'), 2500);
        ok(cfm, '★ 选中 → 确认流（同一条链）');
        ok(clickModalBtn(cfm!, '搬到'), '点了主按钮');
        ok(
          await H.until(() => {
            const e = ctx().index.get(`${kb}/${movedRel}`);
            return e != null && declaredPositions(e.props).join(',') === dirRel;
          }, 4000, 40),
          `★ 搬到位 + 声明写成实际落点（未声明也写 —— 三处编辑面统一）—— 声明=${JSON.stringify(
            declaredPositions(ctx().index.get(`${kb}/${movedRel}`)?.props ?? {}),
          )}`,
        );
        eq(
          fs.readFileSync(path.join(vaultRoot, `${kb}/${movedRel}`), 'utf8').includes('文件位置'),
          true,
          '……前言里真的多了一条「文件位置」',
        );
      } finally {
        closeCardPanel({ reason: 'p716b-test' });
        closeAllMenus();
        purgeOverlays();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, `${kb}/${dirRel}`));
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('目录改名 → 「文件位置」候选刷新（同一扇、不重挂编辑器）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716b改名.md';
      const abs = `${kb}/${rel}`;
      const oldDir = `${kb}/00_Inbox/__p716b改名前`;
      const newDir = `${kb}/00_Inbox/__p716b改名后`;
      try {
        await writeRaw(rel, `---\n类型: 笔记\n文件位置: [00_Inbox]\ntags: []\n---\n\n# 记号-改\n正文改。\n`);
        await app.vault.createFolder(oldDir);
        await H.settle(220);
        await ensurePanelProps();
        openCardWindow(ctx().index.get(abs)!, panelDeps(), undefined, { quiet: true });
        await H.settle(300);
        const sel0 = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        ok(sel0, '前提：选择器在');
        const opts0 = Array.from(sel0!.options).map((o) => o.value);
        ok(opts0.includes('00_Inbox/__p716b改名前'), '建立之后候选里有它（先钉住前提）');
        // 编辑器叶 = 正文块里挂上的那个容器节点（同一节点 = 没重挂；与 p716 同款）
        const leafNode = H.q<HTMLElement>(cwPanel()!, '.kbw-cw-editor').firstElementChild;
        ok(leafNode != null, '前提：小窗正文里挂着编辑器叶');

        // ── 目录改名（vault.rename 的 TFolder 那条路：事件带 children）──
        const folder = app.vault.getAbstractFileByPath('01_新知识库/00_Inbox/__p716b改名前');
        ok(folder != null, '前提：拿得到那个目录节点');
        await app.vault.rename(folder as never, '01_新知识库/00_Inbox/__p716b改名后');
        await H.settle(250);
        const sel1 = propRow('文件位置')?.querySelector('select') as HTMLSelectElement | null;
        const opts1 = Array.from(sel1?.options ?? []).map((o) => o.value);
        ok(
          opts1.includes('00_Inbox/__p716b改名后'),
          `★ 目录改名 → 候选立刻含新名（不等切 tab / 建删目录自愈）—— 眼下：${opts1.join('、')}`,
        );
        ok(!opts1.includes('00_Inbox/__p716b改名前'), '……旧名不再在候选里');
        eq(sel1?.value, '00_Inbox', '当前项照旧 = 声明值（没被顺手改掉）');
        eq(
          H.q<HTMLElement>(cwPanel()!, '.kbw-cw-editor').firstElementChild,
          leafNode,
          '★ 同一枚编辑器叶（属性块重画没有重挂编辑器）',
        );
      } finally {
        closeCardPanel({ reason: 'p716b-test' });
        closeAllMenus();
        purgeOverlays();
        await H.settle(120);
        await rmFix(path.join(vaultRoot, newDir));
        await rmFix(path.join(vaultRoot, oldDir));
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 三 · 工具区（99_Meta）里的笔记也弹菜单（用户 2026-10-09 真机反馈的回销）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.16b · 工具区（99_Meta）里的笔记', async () => {
    await suite.it('99_Meta 里的一篇（空值「文件位置」）点那一格 → 菜单照常弹（含「现处 99_Meta」）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '99_Meta/__p716b工具区.md';
      const abs = `${kb}/${rel}`;
      /** 复刻用户那篇「1222」的精确形状：`文件位置:` 空值键 + 无「类型」 */
      const RAW =
        '---\n文件位置:\n创建日期: 2026-10-09\ntags: []\n收藏: false\n---\n\n工具区正文。\n';
      let detach = (): void => {};
      try {
        await writeRaw(rel, RAW);
        const cell = await openLeafWithCell(abs);
        detach = cell.detach;
        openMenuFrom(cell.input);
        await H.settle(200);
        const menu = await untilEl(() => H.maybe<HTMLElement>(document.body, '.kbw-menu'));
        ok(
          menu,
          `★ 工具区里的笔记：点那一格照常弹菜单（实得菜单数 ${H.qa(document.body, '.kbw-menu').length}）`,
        );
        contains(menuText(), '__p716b工具区', '作用域行写明这是哪一篇');
        contains(menuText(), '库根', '候选照常（库根在）');
        contains(menuText(), '现处 99_Meta', '「现处 99_Meta」在（P7.18b 新项）');
      } finally {
        closeAllMenus();
        purgeOverlays();
        detach();
        await H.settle(100);
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('重启首段的"懒渲染"格子（没有可编辑输入）→ 点整格也要弹（P7.18b2 放宽）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p716b懒渲染.md';
      const abs = `${kb}/${rel}`;
      let detach = (): void => {};
      try {
        await writeRaw(rel, '---\n文件位置:\n---\n\n懒渲染正文。\n');
        const cell = await openLeafWithCell(abs);
        detach = cell.detach;
        /** 模拟"重启后首段渲染"：把格里的可编辑输入拆掉，只留格子壳 */
        const cellEl = cell.input.closest('.metadata-property') as HTMLElement | null;
        ok(cellEl, '前提：假格结构在');
        cell.input.remove();
        eq(
          cellEl!.querySelector('.multi-select-input'),
          null,
          '前提：格子里确实没有 .multi-select-input（懒渲染形状）',
        );
        // 点在格子壳上（行名区域那一带）→ 我们的钩子也要认（P7.18b2：放宽到整格）
        cellEl!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await H.settle(200);
        const menu = await untilEl(() => H.maybe<HTMLElement>(document.body, '.kbw-menu'));
        ok(menu, '★ 格子里没有输入组件（重启首段懒渲染）→ 点整格照样弹出菜单');
        contains(menuText(), '库根', '菜单内容照常（候选在）');
        contains(menuText(), '就住这儿', '未声明 → 「就住这儿」在（菜单内容照常）');
      } finally {
        closeAllMenus();
        purgeOverlays();
        detach();
        await H.settle(100);
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });
}
