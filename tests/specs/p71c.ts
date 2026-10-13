/**
 * spec：**P7.1c · 网格 Windows 六件 + 列宽自适应 + 2.7**（2026-10-03）
 *
 * 分段对表（`P7.1c开工提示词.md` §2）：
 *   · **2.7「移动到…」目录直选**：单篇菜单换成树形子菜单（复用 `migrateItems`）——
 *     没有文本框了 · 当前所在目录那项不画 · 点一项真搬 + 撤销
 *   · **① F2 就地改名（网格）**：输入框挂进 `.kbw-gname`（`is-renaming` 解 clamp）·
 *     Enter 真改名 / Esc 取消 · 改名进行中挡拖动
 *   · **② Del 删除**：`trashOption` 三种值各验一条道（local 直删 + 撤销能还原；
 *     system/none 弹确认、取消后一个文件没动）
 *   · **③ 拖到面包屑 = 上移**：拖动期间工具条让位给面包屑（`dragActive`）· 落点高亮 ·
 *     拖到根段 / 祖先段都真搬 + 撤销
 *   · **④ 拖拽悬停展开树节点**：~500ms 展开 · 提前移开不展开 · 展开后同一手势直接落进去
 *   · **⑤ 多选整组拖**（已有实现，本轮补判据）：浮标计数 · **一次 mover = 一条撤销条能全还原**
 *   · **⑥ 边缘自动滚动（纯映射）+ Home/End**
 *   · **⑦ 列宽双击自适应**：纯函数（算宽）+ 双击抓手接线
 *   · **用户 2026-10-03 加条**：文件夹行「标记」聚合（红>黄>紫 / 空目录 ⚠ / 都正常「—」）·
 *     属性列横杠 · 创建日期 = 文件夹的真创建时间（`adapter.stat` 异步补）
 *
 * ⚠️ **真机才验得了的那些不在这里**：几何（自适应宽到刚好放下 / 边缘滚动真涨 / Home·End 视野）、
 * 拖动观感、`is-drop` 高亮的真机颜色 —— 全在 `scripts/probe.mjs`。
 *
 * 全部在**动库库（B）**上跑（拖 / 删会真动文件）—— 每条自造夹具、finally 清场。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { __resetUndo, hasUndoBar } from '../../src/ui/undo-bar';
import { EDGE_BAND, EDGE_MAX_SPEED, edgeScrollVelocity } from '../../src/modules/notes/autoscroll';
import { fitWidthOf } from '../../src/ui/table';
import { todayISO } from '../../src/core/util';

const KB = '01_新知识库';

export async function specP71c(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const settings = () => ctx().settings.get();
  const rows = (): HTMLElement[] => H.qa(document.body, '.kbw-trow');
  const rowPaths = (): string[] => rows().map((r) => r.dataset.path ?? '');
  const cells = (): HTMLElement[] => H.qa(document.body, '.kbw-gcell:not(.is-folder)');
  const cellPaths = (): string[] => cells().map((c) => c.dataset.path ?? '');
  const frows = (): HTMLElement[] => H.qa(document.body, '.kbw-frow');
  const treeItem = (dir: string): HTMLElement | null =>
    H.qa<HTMLElement>(document.body, '.kbw-tree-item').find((el) => el.dataset.dir === dir) ?? null;
  const keyRoot = (): HTMLElement => H.q(document.body, '.kbw-root');

  /** 清掉批量栏的选择（别的组失败留下的选择会让后面每条都"找不到按钮"） */
  async function clearSel(): Promise<void> {
    const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
    if (!bar) return;
    const x = H.qa<HTMLElement>(bar, 'button').find((b) =>
      (b.getAttribute('aria-label') ?? '').includes('清空选择'),
    );
    if (x) H.click(x);
    await H.settle(70);
  }

  /** 切视图档（先清选择：有选择时 seg 整条被批量栏顶掉） */
  async function pickView(label: string): Promise<void> {
    closeAllMenus();
    await clearSel();
    const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(seg, `视图档「${label}」在`);
    H.click(seg as Element);
    await H.settle(240);
  }

  /** 进一个目录（必要时先展开父节点 —— 树默认只展开根） */
  async function enterDir(dir: string): Promise<boolean> {
    if (!treeItem(dir)) {
      const parent = dir.split('/').slice(0, -1).join('/');
      const p = treeItem(parent);
      const caret = p?.querySelector('.kbw-tree-caret');
      if (caret) H.click(caret as Element);
      await H.settle(100);
    }
    return H.clickTreeNode(dir);
  }

  /**
   * **手势兜底**：断言在拖动中途炸掉时，把这次拖动**干净中止** ——
   * 不然 document 上那套 pointermove/up 监听会留着，下一发同 pointerId 的事件
   * 会喂给这条僵尸拖动（实测：③ 中途红一次，⑤ 跟着红，失败点完全不相干）。
   * 手势已经正常收尾时它是空操作（`disposed`，可重复调）。
   */
  async function killDrag(): Promise<void> {
    H.pointerCancel(document.body, { x: 0, y: 0 });
    await H.settle(40);
  }

  /** 撤销条上点「撤销」（有就点，返回有没有点到） */
  async function clickUndo(): Promise<boolean> {
    const btn = H.currentUndoButton('撤销');
    if (!btn) return false;
    H.click(btn);
    await H.settleIndex(app);
    return true;
  }

  /** 顶层确认流（可能叠着别的）*/
  const topModal = (): HTMLElement => {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal');
    return all[all.length - 1] ?? H.q(document.body, '.kbw-modal');
  };

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · 2.7 移动到（树形子菜单，复用 migrateItems）', async () => {
    await suite.it('单篇菜单：没有文本框了 · 树形子菜单 · 当前目录那项不画 · 点一项真搬 + 撤销', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      const dir = await H.enterTopDirWithNotes(ctx(), 1);
      ok(dir, `进到一个本层 ≥1 篇的目录（${dir || '取不到'}）`);
      await pickView('详细信息');
      const row = rows()[0];
      ok(row, '有笔记行');
      const fromPath = row.dataset.path ?? '';
      const dirName = dir.split('/').pop() ?? dir;

      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(80);
      // 打开 改 ›（它把 重命名… / 移动到… / 属性 / 加标签 收在里面）
      // ⚠️ 子菜单项的文本尾部带一个 '›'（`ui/menu.ts` 的箭头）—— 用 startsWith 认
      const gai = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find(
        (i) => H.textOf(i).trim().startsWith('改'),
      );
      ok(gai, `菜单里有「改」分组：${H.textsOf(document.body, '.kbw-menu-item').join(' | ')}`);
      H.click(gai as Element);
      await H.settle(60);
      const moveItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('移动到'),
      );
      ok(moveItem, '「改」里有「移动到…」');
      /**
       * **没有文本框了**（旧实现是 `control: { type: 'text' }` 就地输入）——
       * 这是 2.7 这一条最直白的身份判据。
       */
      eq(
        H.qa(document.body, '.kbw-menu input').length,
        0,
        '菜单里没有任何输入框（旧的"原地输入目录名"已经撤了）',
      );
      // 进它的子菜单：树形目录
      H.click(moveItem as Element);
      await H.settle(60);
      const texts = H.textsOf(document.body, '.kbw-menu-item');
      // ⚠️ 子菜单项尾带 '›' → 正则别写 `$`（第一版就栽在这：树明明在那儿、判据说没有）
      ok(
        texts.some((t) => /（\d+）/.test(t)),
        `子菜单列出目录树（「名（N）」）：${texts.join(' | ')}`,
      );
      ok(
        texts.some((t) => t.includes('移到库根')),
        `不在库根的笔记有「移到库根」（口径同批量迁移）：${texts.join(' | ')}`,
      );

      /**
       * 当前所在目录：**死选项不画**（P7.0a ⑨ 的判据，`migrateItems` 同一份实现）。
       * 两种形态**取决于它是不是叶子**（「过滤后空了的叶子节点整个不画」是 ⑨ 的原话）：
       *   · 它下面还住着别的目录 → 节点留着，但「移到「它」」那一项不画；
       *   · 它是叶子且这一篇就在它里面 → **整个节点都不画**。
       * 夹具里进的是哪个目录是动态的 → 先按索引判它是哪种，再断言对应形态。
       */
      const kidsUnder = ctx()
        .index.notes()
        .filter((e) => e.effectivePosition.startsWith(`${dir}/`)).length;
      const curNode = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).trim().startsWith(`${dirName}（`),
      );
      if (kidsUnder > 0) {
        ok(curNode, `当前目录「${dirName}」下面还有别的目录 → 节点留着：${texts.join(' | ')}`);
        H.click(curNode as Element);
        await H.settle(60);
        const inner = H.textsOf(document.body, '.kbw-menu-item');
        ok(
          !inner.some((t) => t.includes(`移到「${dirName}」`)),
          `当前目录的「移到…」是死选项 → 不画：${inner.join(' | ')}`,
        );
      } else {
        ok(
          !curNode,
          `当前目录「${dirName}」是叶子且这一篇就在里面 → 整个节点不画（⑨：过滤后空了的叶子不画）`,
        );
      }
      closeAllMenus();
      await H.settle(40);

      // 换一个目录：点完后真搬 + 撤销
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(60);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).trim().startsWith('改')) as Element);
      await H.settle(50);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('移动到')) as Element);
      await H.settle(50);
      const other = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find(
        (i) => /（\d+）/.test(H.textOf(i)) && !H.textOf(i).trim().startsWith(`${dirName}（`),
      );
      ok(other, '有一个别的目录节点可选');
      H.click(other as Element);
      await H.settle(50);
      const leaf = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('移到「'),
      );
      ok(leaf, '子菜单里有「移到「X」」');
      const targetLabel = H.textOf(leaf as Element);
      H.click(leaf as Element);
      await H.settleIndex(app);
      closeAllMenus();

      const moved = ctx()
        .index.notes()
        .find((e) => e.path.endsWith(fromPath.split('/').pop() ?? ''));
      ok(moved, '那篇还在索引里（换个位置而已）');
      ok(moved && moved.effectivePosition !== dir, `真搬了：${dir} → ${moved?.effectivePosition}（点了「${targetLabel}」）`);
      ok(hasUndoBar(), '搬完出撤销条');
      ok(await clickUndo(), '撤销点得到');
      eq(
        Boolean(app.vault.getAbstractFileByPath(fromPath)),
        true,
        '撤销之后回到原处（夹具不受污染）',
      );
      await clearSel();
      ctx().goNotes();
      await H.settle(80);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ① F2 就地改名（网格）', async () => {
    await suite.it('F2 → 输入框挂进 .kbw-gname（is-renaming 解 clamp）→ Enter 真改名 → 撤销收回', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      ok(await H.enterTopDirWithNotes(ctx(), 1), '进到一个本层 ≥1 篇的目录');
      await pickView('网格');
      const cell = cells()[0];
      ok(cell, '网格里有格子');
      const oldPath = cell.dataset.path ?? '';
      const oldName = oldPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
      H.click(cell);
      await H.settle(60);

      H.keydown(keyRoot(), 'F2');
      await H.settle(80);
      const input = H.maybe<HTMLInputElement>(document.body, '.kbw-gcell .kbw-gname .kbw-inline-input');
      ok(input, 'F2 之后网格的「名称处」有输入框（P7.1c ① 的落点）');
      const gname = H.q(document.body, '.kbw-gcell .kbw-gname');
      ok(gname.classList.contains('is-renaming'), '名格贴了 is-renaming（解开 line-clamp —— c 期那笔账）');
      eq(input?.value, oldName, '输入框预填旧名');

      const newName = `__小修网格改名-${Date.now()}`;
      (input as HTMLInputElement).value = newName;
      H.keydown(input as Element, 'Enter');
      await H.settleIndex(app);
      const newPath = `${oldPath.slice(0, oldPath.length - oldName.length - 3)}${newName}.md`;
      ok(
        await H.until(() => H.exists(vaultRoot, newPath), 2000, 50),
        `文件真的改名了：${newPath}`,
      );
      ok(hasUndoBar(), '改名出撤销条');
      /**
       * 收尾：撤销回去（动库库不能让改名漏给后面的 spec —— 网格那条既有用例记过这笔账）。
       */
      ok(await clickUndo(), '撤销点得到（回旧名）');
      eq(Boolean(app.vault.getAbstractFileByPath(oldPath)), true, '名字收回来了');
      await clearSel();
    });

    await suite.it('🔴 F2 撞车修复：平台管线先问 Scope —— 工作台内接管 / 台外放行（真机实证那一条的离线半边）', async () => {
      /**
       * 由头（P7.1c 真机探针实证，P1 起的老账）：平台核心命令 `workspace:edit-file-title`
       * （「重命名文件」）**默认键就是 F2**，它在 document 层把事件吃掉 —— 根元素那套监听
       * 永远收不到，插件的 F2 改名在真机上**从未生效过**（离线测不出：桩里没有平台层）。
       * 修法 = 平台给的正路 `Scope`：平台自己的键盘管线会先把事件问我们。
       * 这里验**路由那一半**（注册了没有 / 工作台内接管 / 台外放行）；
       * "平台真的会先问 scope" 那一半归真机探针（探针步骤里 F2 就是这么按的）。
       */
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      ok(await H.enterTopDirWithNotes(ctx(), 1), '进到一个本层 ≥1 篇的目录');
      await pickView('网格');

      // ① 工作台开着，就注册了 F2 的 scope（多标签/重挂时可能叠着几个 —— 逐个问过去）
      const f2Scopes = app.keymap.scopes.filter((s) => s.handlers.some((h) => h.key === 'F2'));
      ok(f2Scopes.length >= 1, `工作台视图把 F2 注册进了 Scope（实际 ${app.keymap.scopes.length} 个 scope）`);

      // ② 像平台那样派一发：键落在工作台里 → 接管（返回 false = 已处理）+ 起改名输入框
      const cell = cells()[0];
      ok(cell, '网格里有格子');
      const oldPath = cell.dataset.path ?? '';
      H.click(cell);
      await H.settle(60);
      const evtInside = new KeyboardEvent('keydown', { key: 'F2', bubbles: false, cancelable: true });
      cell.dispatchEvent(evtInside); // 让 target = 格子（bubbles:false → 根监听那条路不掺和）
      const tries = f2Scopes.map((sc) => ({ sc, r: sc.__dispatch(evtInside) }));
      const claimers = tries.filter((t) => t.r.result === false);
      eq(
        claimers.length >= 1,
        true,
        `恰好有 scope 接管（共 ${f2Scopes.length} 个 F2 scope，结果 ${JSON.stringify(tries.map((t) => t.r.result))}）`,
      );
      const scope = claimers.length > 0 ? claimers[0].sc : tries[tries.length - 1].sc;
      await H.settle(80);
      const input = H.maybe<HTMLInputElement>(document.body, '.kbw-gcell .kbw-gname .kbw-inline-input');
      ok(input, '走 scope 这一条路，改名输入框真的开起来了（根监听在真机上收不到这条键）');
      if (input) {
        H.keydown(input, 'Escape'); // 取消，文件不许动
        await H.settleIndex(app);
      }
      ok(app.vault.getAbstractFileByPath(oldPath), '取消之后文件没动');

      // ③ 台外放行：target 不在工作台根里 → 不接管（undefined = 放行给平台，别的标签页 F2 仍是「重命名文件」）
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      const evtOutside = new KeyboardEvent('keydown', { key: 'F2', bubbles: false, cancelable: true });
      outside.dispatchEvent(evtOutside);
      const r2 = scope.__dispatch(evtOutside);
      eq(r2.matched, true, 'scope 仍认得这个键');
      eq(r2.result, undefined, '台外 → 放行（不消费）');
      outside.remove();
      await clearSel();
      ctx().goNotes();
      await H.settle(60);
    });

    await suite.it('Esc 取消（文件不动）· 改名进行中挡住拖动', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      ok(await H.enterTopDirWithNotes(ctx(), 1), '进到一个本层 ≥1 篇的目录');
      await pickView('网格');
      const cell = cells()[0];
      ok(cell, '网格里有格子');
      const oldPath = cell.dataset.path ?? '';
      H.click(cell);
      await H.settle(60);
      H.keydown(keyRoot(), 'F2');
      await H.settle(60);
      const input = H.maybe<HTMLInputElement>(document.body, '.kbw-gcell .kbw-inline-input');
      ok(input, '输入框开了');

      /**
       * **改名进行中挡住拖动**：在格子上按下 + 拖 20px → 不该起拖（没有浮标）。
       * `onCellPointerDown` 里那条 `inner.querySelector('.kbw-inline-input')` 守卫就是它。
       */
      try {
        H.pointerDown(cell, { x: 100, y: 100 });
        H.pointerMove(cell, { x: 130, y: 100 });
        await H.tick(30);
        eq(
          H.maybe(document.body, '.kbw-dragghost'),
          null,
          '改名进行中不起拖动（没有拖动浮标）',
        );
        H.pointerUp(cell, { x: 130, y: 100, buttons: 0 });
        await H.tick(20);
      } finally {
        await killDrag();
      }

      input!.value = '不会被采用的名字';
      H.keydown(input as Element, 'Escape');
      await H.settleIndex(app);
      ok(app.vault.getAbstractFileByPath(oldPath), 'Esc 取消 → 文件没动（名字也没变）');
      ok(
        !H.exists(vaultRoot, `${oldPath.slice(0, -3)}不会被采用的名字.md`),
        '也没在盘上留下那个输入的名字',
      );
      await clearSel();
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ② Del 删除（local 直删 / system·none 走确认流）', async () => {
    await suite.it('trashOption=local：Del 直删（不进确认流）+ 撤销能还原', async () => {
      closeAllMenus();
      const orig = app.vault.getConfig('trashOption');
      app.vault.setConfig('trashOption', 'local');
      const rel = `${KB}/00_Inbox/__小修Del直删.md`;
      try {
        H.writeNote(vaultRoot, rel, H.note('# Del 直删\n'));
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(60);
        __resetUndo();
        ctx().goNotes({ dir: '00_Inbox' });
        await H.settle(80);
        await pickView('详细信息');
        const row = rows().find((r) => r.dataset.path === rel);
        ok(row, '找到那篇');
        H.click(row as Element);
        await H.settle(40);

        H.keydown(keyRoot(), 'Delete');
        await H.settleIndex(app);
        eq(H.qa(document.body, '.kbw-modal').length, 0, 'local 直删**不进确认流**（没有模态）');
        eq(Boolean(app.vault.getAbstractFileByPath(rel)), false, '文件被删掉了');
        eq(app.vault.systemTrashed.length, 0, '走的是库内 .trash（不是系统回收站）');
        ok(H.exists(vaultRoot, '.trash/__小修Del直删.md'), '进了库内 .trash');
        ok(hasUndoBar(), '删除出撤销条');
        ok(await clickUndo(), '撤销点得到');
        eq(Boolean(app.vault.getAbstractFileByPath(rel)), true, '撤销把文件带回来了');
      } finally {
        app.vault.setConfig('trashOption', orig as 'system' | 'local' | 'none');
        if (H.exists(vaultRoot, rel) === false && H.exists(vaultRoot, '.trash/__小修Del直删.md')) {
          // 兜底：撤销没成的话把 .trash 里的搬回来，再不行就删干净（别把夹具留给后面）
          fs.cpSync(
            path.join(vaultRoot, '.trash/__小修Del直删.md'),
            path.join(vaultRoot, rel),
            { recursive: true },
          );
        }
        fs.rmSync(path.join(vaultRoot, rel), { force: true });
        fs.rmSync(path.join(vaultRoot, '.trash'), { recursive: true, force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(80);
        await clearSel();
      }
    });

    await suite.it('批量 Del（local）：一次删 N 篇**不走确认流** · 一条撤销全还原（独立审 🟡7 补）', async () => {
      /**
       * 🟡7：原先"点一行删一行"（选中集恒为 1），**"一次删 N 篇且不进确认流"这条最重的安全分支零判据**。
       * 安全语义来自 2.3 拍板：local 档 = 可程序化还原（库内 .trash + 快照），与拖拽同一档待遇。
       */
      closeAllMenus();
      const orig = app.vault.getConfig('trashOption');
      app.vault.setConfig('trashOption', 'local');
      const rels = [`${KB}/00_Inbox/__小修Del批-甲.md`, `${KB}/00_Inbox/__小修Del批-乙.md`];
      try {
        for (const r of rels) H.writeNote(vaultRoot, r, H.note('# 批删\n'));
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(60);
        __resetUndo();
        ctx().goNotes({ dir: '00_Inbox' });
        await H.settle(80);
        await pickView('详细信息');
        const r1 = rows().find((x) => x.dataset.path === rels[0]);
        const r2 = rows().find((x) => x.dataset.path === rels[1]);
        ok(r1 && r2, '两篇都在');
        H.click(r1 as Element);
        await H.settle(30);
        H.click(r2 as Element, { ctrlKey: true });
        await H.settle(40);
        eq(H.qa(document.body, '.kbw-trow.is-selected').length, 2, '选中 2 篇');

        H.keydown(keyRoot(), 'Delete');
        await H.settleIndex(app);
        eq(H.qa(document.body, '.kbw-modal').length, 0, 'local 档批量删也**不进确认流**');
        for (const r of rels) eq(Boolean(app.vault.getAbstractFileByPath(r)), false, `删掉了：${r}`);
        ok(hasUndoBar(), '删除出撤销条（快照兜底）');
        ok(await clickUndo(), '撤销点得到');
        for (const r of rels) {
          eq(Boolean(app.vault.getAbstractFileByPath(r)), true, `一条撤销把两篇都带回来：${r}`);
        }
      } finally {
        app.vault.setConfig('trashOption', orig as 'system' | 'local' | 'none');
        for (const r of rels) {
          if (!app.vault.getAbstractFileByPath(r) && H.exists(vaultRoot, `.trash/${r.split('/').pop()}`)) {
            fs.cpSync(path.join(vaultRoot, `.trash/${r.split('/').pop()}`), path.join(vaultRoot, r));
          }
          fs.rmSync(path.join(vaultRoot, r), { force: true });
        }
        fs.rmSync(path.join(vaultRoot, '.trash'), { recursive: true, force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(60);
        await clearSel();
      }
    });

    await suite.it('没有选中时 Del 删的是**光标那篇**（Windows 手感；独立审 🟡7 补）', async () => {
      closeAllMenus();
      const orig = app.vault.getConfig('trashOption');
      app.vault.setConfig('trashOption', 'local');
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(80);
      await pickView('详细信息');
      let cursorPath = '';
      try {
        // 用 End 把光标放到最后一行（**只移高亮、不选中** —— 与 ↑↓ 同一口径）
        H.keydown(keyRoot(), 'End');
        await H.settle(60);
        cursorPath =
          H.qa<HTMLElement>(document.body, '.kbw-trow.is-cursor')[0]?.dataset.path ?? '';
        ok(cursorPath, '光标落在某一行上');
        eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, '前提：没有选中任何行');
        __resetUndo();

        H.keydown(keyRoot(), 'Delete');
        await H.settleIndex(app);
        eq(
          Boolean(app.vault.getAbstractFileByPath(cursorPath)),
          false,
          `没有选中时删的是光标那篇（${cursorPath}）`,
        );
        ok(await clickUndo(), '撤销点得到');
        eq(Boolean(app.vault.getAbstractFileByPath(cursorPath)), true, '那篇回来了');
      } finally {
        app.vault.setConfig('trashOption', orig as 'system' | 'local' | 'none');
        // 兜底：撤销没成 → 从库内 .trash 拷回来（这是 B 库的既有夹具，别毁在探针手上）
        if (cursorPath && !app.vault.getAbstractFileByPath(cursorPath)) {
          const flat = `.trash/${cursorPath.split('/').pop()}`;
          if (H.exists(vaultRoot, flat)) {
            fs.cpSync(path.join(vaultRoot, flat), path.join(vaultRoot, cursorPath));
          }
        }
        fs.rmSync(path.join(vaultRoot, '.trash'), { recursive: true, force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(60);
        await clearSel();
      }
    });

    await suite.it('trashOption=system / none：Del 弹确认流；取消后一个文件没动', async () => {
      closeAllMenus();
      const orig = app.vault.getConfig('trashOption');
      for (const option of ['system', 'none'] as const) {
        app.vault.setConfig('trashOption', option);
        const rel = `${KB}/00_Inbox/__小修Del确认.md`;
        try {
          H.writeNote(vaultRoot, rel, H.note('# Del 确认\n'));
          app.vault.rescan();
          ctx().index.rebuild();
          await H.settle(60);
          ctx().goNotes({ dir: '00_Inbox' });
          await H.settle(80);
          await pickView('详细信息');
          const row = rows().find((r) => r.dataset.path === rel);
          ok(row, `[${option}] 找到那篇`);
          H.click(row as Element);
          await H.settle(40);

          H.keydown(keyRoot(), 'Delete');
          await H.settle(80);
          const modal = topModal();
          ok(modal, `[${option}] Del 弹确认流（不是直删）`);
          const danger = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) =>
            H.textOf(b).includes('删除'),
          );
          ok(danger, `[${option}] 确认流里有「删除」按钮`);
          if (option === 'none') {
            eq(danger?.hasAttribute('disabled'), true, '[none] 按钮置灰（平台设置是「不删除」）');
            contains(H.textOf(modal), '不删除', '[none] 置灰原因写在界面上');
          }
          H.keydown(modal, 'Escape');
          await H.settle(60);
          eq(
            Boolean(app.vault.getAbstractFileByPath(rel)),
            true,
            `[${option}] 取消后文件一个没动`,
          );
          eq(app.vault.systemTrashed.length, 0, `[${option}] 也没进系统回收站`);
        } finally {
          fs.rmSync(path.join(vaultRoot, rel), { force: true });
          app.vault.rescan();
          ctx().index.rebuild();
          await H.settle(60);
        }
      }
      app.vault.setConfig('trashOption', orig as 'system' | 'local' | 'none');
      await clearSel();
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ③ 拖到面包屑 = 上移（拖动期间工具条让位）', async () => {
    await suite.it('拖动中面包屑在场（批量栏让位）· 落点高亮 · 拖到根段真搬到库根 + 撤销', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      const dir = await H.enterTopDirWithNotes(ctx(), 2);
      ok(dir, `进到一个本层 ≥2 篇的目录（${dir || '取不到'}）`);
      await pickView('详细信息');
      const row = rows()[0];
      ok(row, '有笔记行');
      const fromPath = row.dataset.path ?? '';
      ok(fromPath, '行带路径');

      try {
        H.pointerDown(row, { x: 60, y: 60 });
        H.pointerMove(row, { x: 90, y: 60 });
        await H.settle(60); // 越过 4px 阈值 → dragActive → 工具条重画
        ok(
          !H.maybe(document.body, '.kbw-notes-bar.is-batch'),
          '拖动期间批量栏让位（dragActive 那条分支）',
        );
        ok(
          H.qa(document.body, '.kbw-crumb[data-drop]').length > 0,
          '拖动期间面包屑段在场（每一段都是落点）',
        );
        const rootCrumb = H.qa<HTMLElement>(document.body, '.kbw-crumb').find(
          (c) => c.dataset.drop === '',
        );
        ok(rootCrumb, '有根段（data-drop="" = 库根）');
        H.pointerMove(rootCrumb as Element, { x: 40, y: 12 });
        await H.settle(40);
        ok(
          (rootCrumb as HTMLElement).classList.contains('is-drop'),
          '掠过面包屑段 → 就地高亮 .is-drop',
        );
        H.pointerUp(rootCrumb as Element, { x: 40, y: 12, buttons: 0 });
        await H.settleIndex(app);

        const name = fromPath.split('/').pop() ?? '';
        eq(Boolean(app.vault.getAbstractFileByPath(`${KB}/${name}`)), true, '真搬到库根（拖到根段）');
        eq(Boolean(app.vault.getAbstractFileByPath(fromPath)), false, '老位置没了（成对判）');
        ok(hasUndoBar(), '搬完出撤销条');
      } finally {
        await killDrag();
        await clickUndo();
        if (!app.vault.getAbstractFileByPath(fromPath)) {
          // 兜底：撤销没成 → 手动搬回来
          const name = fromPath.split('/').pop() ?? '';
          const src = path.join(vaultRoot, KB, name);
          if (fs.existsSync(src)) {
            fs.renameSync(src, path.join(vaultRoot, fromPath));
            app.vault.rescan();
            ctx().index.rebuild();
            await H.settle(80);
          }
        }
      }
      await clearSel();
      ctx().goNotes();
      await H.settle(60);
    });

    await suite.it('拖到**祖先段**（两级目录）→ 搬到那一级 + 撤销', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      /**
       * 找一个"本层有笔记、且直接子目录里也有笔记"的顶层目录 —— 与 1b 的 `pickDir` 同口径
       * （两级路径才有"祖先段"这个落点）。
       */
      const entries = ctx().index.notes();
      const tops = Array.from(
        new Set(entries.map((e) => e.effectivePosition.split('/')[0]).filter((d) => d !== '')),
      );
      const top = tops.find((d) => {
        const subs = new Set(
          entries
            .map((e) => e.effectivePosition.split('/'))
            .filter((p) => p.length > 1 && p[0] === d)
            .map((p) => p[1]),
        );
        return subs.size >= 1;
      });
      ok(top, '夹具里有一个"有子目录"的顶层目录');
      const sub = Array.from(
        new Set(
          entries
            .map((e) => e.effectivePosition.split('/'))
            .filter((p) => p.length > 1 && p[0] === top)
            .map((p) => p[1]),
        ),
      ).find((s) => entries.some((e) => e.effectivePosition === `${top}/${s}`));
      ok(sub, `「${top}」里有一个本层有笔记的子目录`);
      ok(await enterDir(`${top}/${sub}`), `进到 ${top}/${sub}`);
      await pickView('详细信息');
      const row = rows()[0];
      ok(row, '有笔记行');
      const fromPath = row.dataset.path ?? '';
      ok(fromPath, '行带路径');

      try {
        H.pointerDown(row, { x: 60, y: 60 });
        H.pointerMove(row, { x: 90, y: 60 });
        await H.settle(60);
        const crumb = H.qa<HTMLElement>(document.body, '.kbw-crumb').find(
          (c) => c.dataset.drop === top,
        );
        ok(crumb, `面包屑里有祖先段（${top}）`);
        H.pointerMove(crumb as Element, { x: 40, y: 12 });
        await H.settle(40);
        ok(crumb?.classList.contains('is-drop'), '祖先段落点高亮');
        H.pointerUp(crumb as Element, { x: 40, y: 12, buttons: 0 });
        await H.settleIndex(app);

        const name = fromPath.split('/').pop() ?? '';
        const target = `${KB}/${top}/${name}`;
        eq(Boolean(app.vault.getAbstractFileByPath(target)), true, `真搬到祖先那一级：${target}`);
        eq(Boolean(app.vault.getAbstractFileByPath(fromPath)), false, '老位置没了（成对判）');
        /**
         * 🔴 **别把 `settleIndex(200ms)` 当成"索引一定跟上了"**（P7.19 全量实测）：
         * `vaultB` 是**与前面十几个 spec 共享**的库，全量跑到这儿已被撑到 **152+ 篇**
         * （夹具本体只有 43 篇）—— 索引 rebuild 一次要更久，**200ms 死等不够**，
         * 于是 `notes()` 里**连这篇的旧路径都没有**（实测失败信息：`索引共 152 条 ·
         * 其中 path 含该名的 0 条`）。
         * 子集跑库小（43 篇）→ 200ms 够 → 所以这条**只在全量红**（基线对照：HEAD 亦然）。
         * ⇒ 改成**等条件**（等它真的进索引），不再猜时间。
         */
        await H.until(() => ctx().index.notes().some((e) => e.path.endsWith(name)), 4000);
        const moved = ctx().index.notes().find((e) => e.path.endsWith(name));
        /**
         * ⚠️ **失败信息带上下文**（P7.19）：这条在**全量**下偶发红（`实际 undefined`），而原信息只报个
         * `undefined` —— 分不清是"索引里根本没这一篇"（rebuild 没跟上）还是"命中了同名的那一篇"。
         * 把两个数亮出来：索引总条数 + 其中 path 含 `name` 的条数。
         */
        eq(
          moved?.effectivePosition,
          top,
          moved
            ? '索引里的位置也是那一级'
            : `索引里找不到刚搬过的那篇（name=「${name}」· top=「${top}」· ` +
              `fromPath=「${fromPath}」· 索引共 ${ctx().index.notes().length} 条 · ` +
              `其中 path 含该名的 ${ctx().index.notes().filter((e) => e.path.includes(name)).length} 条）`,
        );
      } finally {
        await killDrag();
        await clickUndo();
        if (!app.vault.getAbstractFileByPath(fromPath)) {
          const name = fromPath.split('/').pop() ?? '';
          const src = path.join(vaultRoot, KB, top, name);
          if (fs.existsSync(src)) {
            fs.renameSync(src, path.join(vaultRoot, fromPath));
            app.vault.rescan();
            ctx().index.rebuild();
            await H.settle(80);
          }
        }
      }
      await clearSel();
      ctx().goNotes();
      await H.settle(60);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ④ 拖拽悬停展开树节点', async () => {
    await suite.it('掠过折叠节点 ~500ms 展开 · 提前移开不展开 · 展开后同一手势直接落进去', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      const dir = await H.enterTopDirWithNotes(ctx(), 1);
      ok(dir, `进到一个本层 ≥1 篇的目录（${dir || '取不到'}）`);
      await pickView('详细信息');
      /**
       * 目标 = 一个"有子节点、且不是当前目录"的折叠顶层目录。
       * 树默认展开根；如果它已经是展开的，点三角收起来（本条的判据要它**先折叠**）。
       */
      const entries = ctx().index.notes();
      const withKids = Array.from(
        new Set(
          entries
            .map((e) => e.effectivePosition.split('/'))
            .filter((p) => p.length > 1)
            .map((p) => p[0]),
        ),
      ).filter((d) => d !== dir);
      const target = withKids[0];
      ok(target, `有一个可作目标的目录（${withKids.join('、')}）`);
      let node = treeItem(target);
      ok(node, `树里有「${target}」节点`);
      if (node?.getAttribute('aria-expanded') === 'true') {
        H.click(node.querySelector('.kbw-tree-caret') as Element);
        await H.settle(100);
        node = treeItem(target);
      }
      eq(node?.getAttribute('aria-expanded'), 'false', `「${target}」现在是折叠的（前提）`);

      const row = rows()[0];
      ok(row, '有笔记行');
      const fromPath = row.dataset.path ?? '';
      try {
        H.pointerDown(row, { x: 60, y: 60 });
        H.pointerMove(row, { x: 90, y: 60 });
        await H.settle(40);
        // 掠过 → 250ms 就移开：**不该**展开（计时器要被清掉）
        H.pointerMove(node as Element, { x: 30, y: 30 });
        await H.tick(250);
        H.pointerMove(row, { x: 90, y: 60 }); // 移开（回到没有 data-drop 的行上）
        await H.tick(420);
        eq(
          treeItem(target)?.getAttribute('aria-expanded'),
          'false',
          '提前移开 → 不展开（计时器被清了）',
        );

        // 再掠回目标：这次停留够 500ms → 真展开
        node = treeItem(target);
        H.pointerMove(node as Element, { x: 30, y: 30 });
        await H.tick(560);
        eq(
          treeItem(target)?.getAttribute('aria-expanded'),
          'true',
          '停留 ~500ms → 折叠节点展开（aria-expanded 变 true）',
        );

        // 同一手势里直接落进去：松手（目标还是那个节点；重绘后要**重新取**元素）
        node = treeItem(target);
        ok(node, '展开后节点还在（树重绘过，取的是新元素）');
        H.pointerUp(node as Element, { x: 30, y: 30, buttons: 0 });
        await H.settleIndex(app);
        /**
         * ⚠️ 认**精确新路径**（不按 basename 反查索引：夹具里重名很常见 ——
         * 「未命名.md」这种占位名能在好几个目录里出现，按名字找会命中别人）。
         */
        const name = fromPath.split('/').pop() ?? '';
        const toPath = `${KB}/${target}/${name}`;
        ok(H.exists(vaultRoot, toPath), `展开后同一手势直接落进去（${toPath}）`);
        eq(Boolean(app.vault.getAbstractFileByPath(fromPath)), false, '老位置没了（成对判）');
        ok(hasUndoBar(), '搬完出撤销条');
      } finally {
        await killDrag();
        await clickUndo();
        if (!app.vault.getAbstractFileByPath(fromPath)) {
          const name = fromPath.split('/').pop() ?? '';
          const src = path.join(vaultRoot, KB, target, name);
          if (fs.existsSync(src)) {
            fs.renameSync(src, path.join(vaultRoot, fromPath));
            app.vault.rescan();
            ctx().index.rebuild();
            await H.settle(80);
          }
        }
        // 目标节点的展开态是**落盘偏好** → 收起，别把状态留给后面
        const back = treeItem(target);
        if (back?.getAttribute('aria-expanded') === 'true') {
          H.click(back.querySelector('.kbw-tree-caret') as Element);
          await H.settle(80);
        }
        await clearSel();
        ctx().goNotes();
        await H.settle(60);
      }
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ⑤ 多选整组拖（一次 mover = 一条撤销条全还原）', async () => {
    await suite.it('网格：选中 3 篇拖到目录树 → 浮标「3 篇」· 一次搬完 · 撤销一条全回来', async () => {
      closeAllMenus();
      const d = `__小修三拖-${Date.now()}`;
      const names = ['甲', '乙', '丙'];
      try {
        for (const n of names) {
          H.writeNote(vaultRoot, `${KB}/${d}/${n}.md`, H.note(`# ${n}\n`));
        }
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(80);
        ctx().goNotes({ dir: d });
        await H.settle(80);
        await pickView('网格');
        eq(cells().length, 3, '自造的三篇都在网格里');

        H.click(cells()[0]);
        await H.settle(30);
        H.click(cells()[1], { ctrlKey: true });
        H.click(cells()[2], { ctrlKey: true });
        await H.settle(40);
        eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 3, '选中 3 格');

        const src = cells()[0];
        const targetDir = H.qa<HTMLElement>(document.body, '.kbw-tree-item').find(
          (t) => t.dataset.dir === '00_Inbox',
        );
        ok(targetDir, '树上有 00_Inbox 节点（落点）');
        H.pointerDown(src, { x: 100, y: 100 });
        H.pointerMove(src, { x: 130, y: 100 });
        await H.tick(30);
        const ghost = H.maybe(document.body, '.kbw-dragghost');
        ok(ghost, '进入拖动（有浮标）');
        eq(H.textOf(ghost), '3 篇', '浮标计数 = 整组的篇数（不是 1）');
        /**
         * 🔴 掠过目录树会让树区重绘（dragDir 进 key）→ **先前拿到的节点引用是游离节点**，
         * 而在游离元素上派事件**到不了 document**（传播路径只到它自己）——
         * 拖动的 move/up 监听都挂在 document 上 → 每一发都要**重新取**在世的那个节点。
         */
        const liveTarget = (): HTMLElement | null =>
          H.qa<HTMLElement>(document.body, '.kbw-tree-item').find(
            (t) => t.dataset.dir === '00_Inbox',
          ) ?? null;
        H.pointerMove(liveTarget() as Element, { x: 30, y: 30 });
        await H.tick(20);
        const upOn = liveTarget();
        ok(upOn, '指针底下那个节点还在（重绘后重新取）');
        H.pointerUp(upOn as Element, { x: 30, y: 30, buttons: 0 });
        await H.settleIndex(app);

        for (const n of names) {
          eq(
            Boolean(app.vault.getAbstractFileByPath(`${KB}/00_Inbox/${n}.md`)),
            true,
            `「${n}」搬进了 00_Inbox`,
          );
        }
        eq(H.qa(document.body, '.kbw-dragghost').length, 0, '浮标收掉了');
        ok(hasUndoBar(), '整组搬完只有一条撤销条');
        ok(await clickUndo(), '撤销点得到');
        for (const n of names) {
          eq(
            Boolean(app.vault.getAbstractFileByPath(`${KB}/${d}/${n}.md`)),
            true,
            `撤销把「${n}」带回原处（一条撤销条全还原）`,
          );
        }
      } finally {
        await killDrag();
        // 兜底：两边都清，别把夹具留给后面的 spec
        for (const n of names) {
          fs.rmSync(path.join(vaultRoot, KB, '00_Inbox', `${n}.md`), { force: true });
        }
        fs.rmSync(path.join(vaultRoot, KB, d), { recursive: true, force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(80);
        await clearSel();
        ctx().goNotes();
        await H.settle(60);
      }
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ⑥ 边缘自动滚动（纯映射）+ Home / End', async () => {
    await suite.it('edgeScrollVelocity：带内速度 ∝ 深入程度 · 带外 0 · 太矮的容器恒 0', () => {
      // 容器 0–400，带 48：上半带 [0,48)、下半带 (352,400]
      const top = (y: number): number => edgeScrollVelocity(y, 0, 400, 48, 600);
      const bottom = (y: number): number => edgeScrollVelocity(y, 0, 400, 48, 600);
      eq(top(24), -300, '带中点 = 半速（线性：深入一半）');
      eq(top(0), -600, '贴死上边线 = 满速');
      eq(bottom(400), 600, '贴死下边线 = 满速（方向相反）');
      eq(bottom(376), 300, '下半带中点 = 半速');
      eq(top(200), 0, '中间区域不滚');
      eq(top(48), 0, '带的外沿（pos = start+band）不滚（含端点）');
      eq(edgeScrollVelocity(200, 0, 80, 48, 600), 0, '容器矮于两倍带宽 → 恒 0（"边"无意义）');
      eq(edgeScrollVelocity(0, 0, 400, 0, 600), 0, 'band=0 防御性返回 0');
      // 常量本身也钉住（探针的期望值引它）
      eq(EDGE_BAND, 48, '带宽 48（改它要同步探针）');
      eq(EDGE_MAX_SPEED, 600, '上限 600px/s（改它要同步探针）');
      void bottom;
    });

    await suite.it('Home / End：两档都能把光标挪到首/尾格，且**只移高亮不改选中**', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      ok(await H.enterTopDirWithNotes(ctx(), 3), '进到一个本层 ≥3 篇的目录');
      await pickView('详细信息');
      const paths = rowPaths();
      ok(paths.length >= 3, `详细档有 ≥3 行（${paths.length}）`);

      H.keydown(keyRoot(), 'End');
      await H.settle(60);
      deepEq(
        H.qa<HTMLElement>(document.body, '.kbw-trow.is-cursor').map((r) => r.dataset.path),
        [paths[paths.length - 1]],
        'End → 光标到**最后一篇**（身份而不是数量）',
      );
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, '只移高亮，不改选中');
      H.keydown(keyRoot(), 'Home');
      await H.settle(60);
      deepEq(
        H.qa<HTMLElement>(document.body, '.kbw-trow.is-cursor').map((r) => r.dataset.path),
        [paths[0]],
        'Home → 光标到第一篇',
      );

      await pickView('网格');
      const cpaths = cellPaths();
      ok(cpaths.length >= 3, `网格档有 ≥3 格（${cpaths.length}）`);
      H.keydown(keyRoot(), 'End');
      await H.settle(60);
      deepEq(
        H.qa<HTMLElement>(document.body, '.kbw-gcell.is-cursor').map((c) => c.dataset.path),
        [cpaths[cpaths.length - 1]],
        '网格档 End → 光标到最后一格',
      );
      H.keydown(keyRoot(), 'Home');
      await H.settle(60);
      deepEq(
        H.qa<HTMLElement>(document.body, '.kbw-gcell.is-cursor').map((c) => c.dataset.path),
        [cpaths[0]],
        '网格档 Home → 光标到第一格',
      );
      await clearSel();
      ctx().goNotes();
      await H.settle(60);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · ⑦ 列宽双击自适应（17.9③）', async () => {
    await suite.it('fitWidthOf：纯函数（取最大 + 夹范围 + 边框余量）', () => {
      eq(fitWidthOf([], 120), 120, '没有量到任何格 → 落到 min');
      eq(fitWidthOf([0, 0], 120), 120, '量到的全是 0（空格子）→ 也落 min');
      eq(fitWidthOf([80, 143, 97], 60), 144, '取最大 + 1px 边框余量');
      eq(fitWidthOf([2000], 60), 900, '上限 900（与拖动同一个 MAX）');
      eq(fitWidthOf([10], 120), 120, '名称列这类有 minWidth 的被抬到 min');
      eq(fitWidthOf([NaN, 143], 60), 144, 'NaN 不参与（只数有效值）');
    });

    await suite.it('双击抓手 → 走 onColumnResize 落盘（宽度进配置，夹在 [60,900]）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(80);
      ok(await H.enterTopDirWithNotes(ctx(), 1), '进到一个本层 ≥1 篇的目录');
      await pickView('详细信息');
      const before = { ...settings().columnWidths };
      try {
        // 找「类型」列的抓手（有真实文本的列，量出来才有意义）
        const th = H.qa<HTMLElement>(document.body, '.kbw-table th').find(
          (t) => t.dataset.col === 'prop:类型',
        );
        ok(th, '有「类型」列的表头');
        const grip = th?.querySelector('.kbw-col-grip');
        ok(grip, '表头上有列宽抓手');
        grip?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await H.settle(60);
        // 落盘走 store → 防抖 400ms
        ok(
          await H.until(
            () => typeof settings().columnWidths['prop:类型'] === 'number',
            1200,
            40,
          ),
          '双击之后宽度记进了配置（走 onColumnResize）',
        );
        const w = settings().columnWidths['prop:类型'];
        ok(w >= 60 && w <= 900, `宽度夹在 [60, 900]（实际 ${w}）`);
      } finally {
        // 拨回原样（这批宽度是落盘偏好，不还原会漏给后面的 spec）
        await ctx().settings.save({ columnWidths: before });
        await H.settle(80);
      }
      await clearSel();
      ctx().goNotes();
      await H.settle(60);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.1c · 文件夹行：标记聚合 / 属性列横杠 / 创建时间（用户 2026-10-03 加条）', async () => {
    await suite.it('标记 = 子树聚合（待整理 · 红>黄>紫）· 空目录「空」· 都正常「—」· 属性列横杠 · 创建日期 = 真创建时间', async () => {
      closeAllMenus();
      const t = Date.now();
      const dRed = `__小修红-${t}`;
      const dYellow = `__小修黄-${t}`;
      const dClean = `__小修净-${t}`;
      const dEmpty = `__小修空-${t}`;
      try {
        /**
         * 三种子树形状（判别性夹具 —— 两条读法必须渲染出**不同**的东西）：
         *   · 红：一篇「文件位置」声明 ≠ 实际目录 → position-mismatch（红）
         *   · 黄：一篇 0 字节 → empty-file（黄）+ 缺必填（黄）
         *   · 净：一篇齐活儿的清笔记 → 无标记
         *   · 空：没有笔记的目录
         */
        H.writeNote(
          vaultRoot,
          `${KB}/${dRed}/红.md`,
          H.note('# 红\n', {}, { 位置: ['00_Inbox'] }),
        );
        H.writeNote(vaultRoot, `${KB}/${dYellow}/黄.md`, '');
        H.writeNote(vaultRoot, `${KB}/${dClean}/净.md`, H.note('# 净\n'));
        fs.mkdirSync(path.join(vaultRoot, KB, dEmpty), { recursive: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(120);

        ctx().goNotes();
        await H.settle(80);
        await pickView('详细信息');
        // 目录树选择是**全局残留**的（前面每条用例都动过）→ 显式站回库根
        ok(await H.clickTreeNode(''), '站回库根这一层（四个自造目录都是它的直接子目录）');

        const rowOf = (d: string): HTMLElement | null =>
          frows().find((r) => r.dataset.dir === d) ?? null;
        const flagCell = (r: HTMLElement): HTMLElement | null =>
          r.querySelector<HTMLElement>('td[data-col="flags"]');

        const rRed = rowOf(dRed);
        const rYellow = rowOf(dYellow);
        const rClean = rowOf(dClean);
        const rEmpty = rowOf(dEmpty);
        ok(rRed && rYellow && rClean && rEmpty, `四个文件夹行都在（${frows().length} 行）`);

        // ① 红：最重级别上色 + 悬停说明（P7.7c · 10.5 起画短词「待整理」）
        const redFlag = flagCell(rRed as HTMLElement)?.querySelector('.kbw-flag');
        ok(redFlag, '红那个文件夹有胶囊');
        eq(H.textOf(redFlag as Element), '待整理', '聚合画短词「待整理」');
        ok(redFlag?.classList.contains('flag-red'), `最重级别是红（实际 class：${redFlag?.className}）`);
        eq(redFlag?.getAttribute('title'), null, '#7：不挂 title（双提示根治）');
        contains(redFlag?.getAttribute('aria-label') ?? '', '位置不一致', '悬停写明是哪一类（aria-label）');

        // ② 黄：里面只有黄标记 → 黄
        const yellowFlag = flagCell(rYellow as HTMLElement)?.querySelector('.kbw-flag');
        ok(yellowFlag, '黄那个文件夹有胶囊');
        eq(H.textOf(yellowFlag as Element), '待整理', '聚合都画「待整理」（轻重才分色）');
        ok(
          yellowFlag?.classList.contains('flag-yellow'),
          `只有黄标记时上黄（实际 class：${yellowFlag?.className}）`,
        );

        // ③ 都正常 → 横杠
        const cleanCell = flagCell(rClean as HTMLElement);
        eq(H.textOf(cleanCell?.querySelector('.kbw-cell-empty') ?? null), '—', '都正常的文件夹画「—」');
        eq(cleanCell?.querySelector('.kbw-flag'), null, '没有胶囊');

        // ④ 空目录 → 「空」（P7.7c · 10.5；悬停仍保留原拍板全句）
        const emptyFlag = flagCell(rEmpty as HTMLElement)?.querySelector('.kbw-flag');
        ok(emptyFlag, '空目录也有胶囊');
        eq(H.textOf(emptyFlag as Element), '空', '空目录画短词「空」');
        eq(emptyFlag?.getAttribute('title'), null, '#7：不挂 title');
        contains(emptyFlag?.getAttribute('aria-label') ?? '', '还没有笔记', '悬停说明它是空的（aria-label）');

        // ⑤ 属性列（类型/状态 —— v2 五件套里默认可见的那两个）：文件夹没有这些值 → 横杠（不是空格子）
        for (const col of ['prop:类型', 'prop:状态']) {
          const cell = rRed?.querySelector<HTMLElement>(`td[data-col="${col}"]`);
          ok(cell, `文件夹行有「${col}」格`);
          eq(
            H.textOf(cell?.querySelector('.kbw-cell-empty') ?? null),
            '—',
            `「${col}」格画「—」（用户加条：没有就打横杠）`,
          );
        }
        /**
         * 复选框列是**结构列**（每行一根，不是"没有值"）→ 保持空白，不画横杠。
         * ⚠️ 「大小」列不进这条判据：它在 `DEFAULT_HIDDEN` 里 —— 默认压根不渲染，
         * 拿它断言等于空转（第一版就写了它，红在"格都不存在"）。
         */
        eq(
          H.textOf(rRed?.querySelector('td[data-col="check"]') ?? null),
          '',
          '复选框列留空白（结构列，不是"没有值"）',
        );

        // ⑥ 创建日期列：打开它 → 文件夹行给**真创建时间**（adapter.stat 异步补的那一格）
        /**
         * 显隐走**菜单**（与既有「列显隐」用例同一套路 —— 模块状态不订阅设置变化，
         * 绕过界面改设置等于没验），收尾也走菜单拨回去。
         */
        const cdateVisible = (): boolean =>
          H.qa(document.body, '.kbw-table th[data-col="prop:创建日期"]').length > 0;
        const toggleCdate = async (): Promise<void> => {
          closeAllMenus();
          await H.settle(30);
          const colBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find(
            (b) => H.textOf(b) === '列',
          );
          ok(colBtn, '工具条有「列」按钮');
          H.click(colBtn as Element);
          await H.settle(40);
          const other = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
            H.textOf(i).startsWith('其他'),
          );
          ok(other, '列菜单里有「其他」分组（创建日期住在里面）');
          H.click(other as Element);
          await H.settle(40);
          const cdate = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
            H.textOf(i).includes('创建日期'),
          );
          ok(cdate, '「其他」里有「创建日期」');
          H.click(cdate as Element);
          await H.settle(120);
          closeAllMenus();
          await H.settle(120);
        };
        const cdateBefore = cdateVisible();
        try {
          if (!cdateBefore) await toggleCdate();
          ok(cdateVisible(), '创建日期列画出来了');

          const rClean2 = rowOf(dClean);
          ok(rClean2, '重画之后行还在');
          const cdateCell = rClean2?.querySelector<HTMLElement>('td[data-col="prop:创建日期"]');
          ok(cdateCell, '这一行的创建日期格在');
          // 异步补值：等它从「—」变成日期
          const got = await H.until(
            () => /^\d{4}-\d{2}-\d{2}$/.test(H.textOf(cdateCell)),
            2500,
            60,
          );
          ok(got, `文件夹的创建日期补上了真值（实际「${H.textOf(cdateCell)}」）`);
          const expect = todayISO(new Date(fs.statSync(path.join(vaultRoot, KB, dClean)).ctimeMs));
          eq(H.textOf(cdateCell), expect, '创建日期 = 文件夹的 fs 创建时间（与 statSync 同源对上）');
          // 空目录也应有一个（它也是真目录）
          const rEmpty2 = rowOf(dEmpty);
          ok(
            await H.until(
              () =>
                /^\d{4}-\d{2}-\d{2}$/.test(
                  H.textOf(rEmpty2?.querySelector('td[data-col="prop:创建日期"]') ?? null),
                ),
              2500,
              60,
            ),
            '空目录的创建日期也补上了',
          );
        } finally {
          if (cdateVisible() !== cdateBefore) await toggleCdate(); // 拨回原显隐
        }
      } finally {
        for (const d of [dRed, dYellow, dClean, dEmpty]) {
          fs.rmSync(path.join(vaultRoot, KB, d), { recursive: true, force: true });
        }
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(100);
        await clearSel();
        ctx().goNotes();
        await H.settle(60);
      }
    });
  });
}
