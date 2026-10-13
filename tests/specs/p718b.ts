/**
 * spec：**P7.18b · 位置口径轮**（用户 2026-10-09 真机反馈整改 —— 见当日"整改方案"拍板）
 *
 * 两条口径反转（都是有意识改契约）：
 *   · **A（全统一）**："没声明就保持没声明"已废 → **任何搬动之后，「文件位置」= 实际落点**
 *     （口径收进 `mover.ts` 第 7 步；拖拽 / 批量迁移 / 看板拖卡 / AI 搬动全走这里，
 *     旧的 `declareLandingsAfterMove` 已删 —— 两处各写一份必漂）；
 *   · **菜单并列项**："当前所在地"那一项从**置灰**改成**可点的「现处 X（写回当前位置）」**
 *     （任何状态可点；未声明时「就住这儿（写声明，不搬）」**另有一项** —— 用户拍板并列）。
 *
 * 三组（mover 第 7 步本身的逐条已在 `mover.ts` / `p715.ts` 的反转判据里）：
 *   ① **拖拽入口（真链）**：`runMoveNow(source='drag')` 未声明篇搬完 → 声明 = 新落点；
 *   ② **菜单「现处 X」（未声明）**：点它 → 确认 → 声明写上、文件不动；
 *   ③ **菜单「现处 X」（错位）**：声明 A、实际住 B → 点「现处 B」→ 声明纠回 B、文件不动，
 *      确认单如实显示 A → B。
 *
 * ⚠️ 夹具全带 `__p718b` 前缀，每条自己收场（`metadataCache.settle()` 那套安全删法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { joinPath } from '../../src/core/paths';
import { declaredPositions } from '../../src/services/schema';
import { runMoveNow } from '../../src/modules/notes/ops';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { clickMenuPath, findMenuItem, menuLabels } from './menu-helpers';

export async function specP718b(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** kbRoot 拨回默认（每个 spec 自己的库，防御性自证前提 —— 与 p715/p716 同款） */
  async function ensureKbRootDefault(): Promise<string> {
    const want = '01_新知识库';
    if (ctx().settings.kbRoot() !== want) {
      await ctx().settings.save({ kbRoot: want });
      await H.settle(150);
    }
    return want;
  }

  /** 安全带删法（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 metadataCache 还有滞后重解析定时器 */
  async function rmFix(abs: string): Promise<void> {
    fs.rmSync(abs, { force: true, recursive: true });
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(120);
  }

  /** 造自用夹具（裸文本 —— 未声明 / 错位这些形状 `H.note` 表达不直观） */
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

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 3000): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  async function closeEverything(): Promise<void> {
    for (let i = 0; i < 6 && H.maybe(document.body, '.kbw-modal'); i += 1) {
      H.keydown(document.body, 'Escape');
      await H.settle(120);
    }
    closeAllMenus();
    purgeOverlays();
    await H.settle(150);
  }

  /** 在某一行上开右键菜单并走到「属性 › 定位 › 文件位置」 */
  async function openPositionMenu(rowAbs: string): Promise<boolean> {
    const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find(
      (r) => r.dataset.path === rowAbs,
    );
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 40,
        clientY: rect.top + 8,
      }),
    );
    await H.settle(150);
    return clickMenuPath('改', '属性', '定位', '文件位置');
  }

  // ════════════════════════════════════════════════════════════
  // ① 拖拽入口（真链）：未声明篇搬完 → 声明 = 新落点
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18b · 拖拽入口（runMoveNow · drag）补声明', async () => {
    await suite.it('未声明篇拖拽搬走 → 「文件位置」= 新落点（"拖完也不补"的旧口径已反转）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p718b拖拽.md';
      const abs = `${kb}/${rel}`;
      const toDirRel = '02_Areas/灵感杂记';
      const toAbs = `${kb}/${toDirRel}/__p718b拖拽.md`;
      try {
        await writeRaw(rel, '---\n类型: 笔记\ntags: []\n---\n\n拖拽正文。\n');
        const e = ctx().index.get(abs);
        ok(e, '前提：夹具进索引');
        eq(declaredPositions(e?.props ?? {}).length, 0, '前提：它确实没声明');
        const res = await runMoveNow(ctx(), [e!], toDirRel, 'drag', '测试：拖拽补声明');
        eq(res?.moved.length, 1, '搬走了');
        ok(
          await H.until(
            () => declaredPositions(ctx().index.get(toAbs)?.props ?? {}).length > 0,
            3000,
            40,
          ),
          '★ 未声明的拖拽搬完**也写**声明（旧口径："没声明就保持没声明"）',
        );
        eq(
          declaredPositions(ctx().index.get(toAbs)?.props ?? {})[0],
          toDirRel,
          '★ 声明 = 新落点',
        );
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, toAbs));
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('纯改名**不算搬动**：未声明篇改名不写声明（收件箱兜底链不被顶掉）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p718b改名.md';
      const abs = `${kb}/${rel}`;
      const renamedAbs = `${kb}/00_Inbox/__p718b改名后.md`;
      try {
        await writeRaw(rel, '---\n类型: 笔记\ntags: []\n---\n\n改名正文。\n');
        const e = ctx().index.get(abs);
        ok(e, '前提：夹具进索引');
        eq(declaredPositions(e?.props ?? {}).length, 0, '前提：它确实没声明');
        const res = await ctx().mover.move({
          targets: [{ newName: '__p718b改名后', files: [e!.file] }],
          source: 'batch',
          reason: '测试：纯改名不写声明',
          quiet: true,
        });
        eq(res.moved.length, 1, '改名成功');
        await H.settleIndex(app, 320);
        /**
         * 🔴 **独立审 🔴2 的回销**：纯改名（同目录）不写声明 —— 否则 Inbox 里改过名的笔记
         * 凭空获得"已声明"戳，「一键整理收件箱」兜底与 AI 分诊会对它永久失效。
         */
        eq(
          declaredPositions(ctx().index.get(renamedAbs)?.props ?? {}).length,
          0,
          '★ 纯改名（同目录）**不写**声明 —— 它仍算"用户没表过态"',
        );
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, renamedAbs));
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('附件（非 .md）搬动**不写前言**：字节逐字节不动（独立审 🔴1 的回销）', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p718b附件.bin';
      const toDirRel = '02_Areas/灵感杂记';
      const toAbs = `${kb}/${toDirRel}/__p718b附件.bin`;
      /** 故意混进非 UTF-8 字节（真附件的常态） */
      const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);
      try {
        const full = path.join(vaultRoot, kb, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, BYTES);
        app.vault.rescan();
        await app.metadataCache.settle();
        ctx().index.rebuild();
        await H.settle(150);
        const file = app.vault.getAbstractFileByPath(`${kb}/${rel}`);
        ok(file, '前提：附件在盘上');
        const res = await ctx().mover.move({
          targets: [{ dir: `${kb}/${toDirRel}`, files: [file as never] }],
          source: 'batch',
          reason: '测试：附件搬家不写前言',
          quiet: true,
        });
        eq(res.moved.length, 1, '附件被搬了');
        await H.settleIndex(app, 320);
        const back = fs.readFileSync(path.join(vaultRoot, toAbs));
        ok(back.equals(BYTES), '★ 附件字节逐字节不动（第 7 步不碰非 .md）');
        ok(!back.toString('utf8').startsWith('---'), '……没有被写前言头');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, toAbs));
        await rmFix(path.join(vaultRoot, kb, rel));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 菜单「现处 X」（未声明）：点它 → 声明写上、文件不动
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18b · 菜单「现处 X」（写回当前位置）', async () => {
    await suite.it('未声明：点「现处 00_Inbox」→ 确认 → 声明写上、文件不动', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p718b现处.md';
      const abs = `${kb}/${rel}`;
      try {
        await writeRaw(rel, '---\n类型: 笔记\ntags: []\n---\n\n现处正文。\n');
        ctx().goNotes();
        await H.settle(160);
        const dir0 = await H.enterTopDirWithNotes(ctx(), 1);
        eq(dir0, '00_Inbox', `进到夹具所在层（${dir0 || '没进去'}）`);
        await H.settle(140);
        ok(await openPositionMenu(abs), `走到「属性 › 定位 › 文件位置」：${menuLabels().join(' | ')}`);
        const item = findMenuItem(`现处 ${dir0}`);
        ok(item, `★ 「现处 ${dir0}」在菜单里：${menuLabels().join(' | ')}`);
        ok(item?.getAttribute('aria-disabled') !== 'true', '……可点');
        H.click(item as Element);
        const cfm = await untilEl(() => modalWith('只写声明'));
        ok(cfm, '确认流（只写声明）弹出来了');
        contains(H.textOf(cfm!), '（未声明）', '确认单如实显示"从（未声明）→现处"');
        ok(clickModalBtn(cfm!, '只写声明'), '点了主按钮');
        ok(
          await H.until(
            () => declaredPositions(ctx().index.get(abs)?.props ?? {})[0] === dir0,
            3000,
            40,
          ),
          '★ 声明写上了 = 现处',
        );
        ok(fs.existsSync(path.join(vaultRoot, abs)), '……文件没动（只写声明不搬）');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('错位：声明 00_Inbox、实际住别处 → 点「现处 别处」→ 声明纠回、文件不动、预览 A→B', async () => {
      const kb = await ensureKbRootDefault();
      const dirB = '__p718b别处';
      const rel = `${dirB}/__p718b错位.md`;
      const abs = `${kb}/${rel}`;
      const RAW = '---\n类型: 笔记\n文件位置:\n  - 00_Inbox\ntags: []\n---\n\n错位正文。\n';
      try {
        await writeRaw(rel, RAW);
        ctx().goNotes();
        await H.settle(160);
        ok(await H.clickTreeNode(dirB), `进到「${dirB}」`);
        await H.settle(140);
        ok(await openPositionMenu(abs), `走到选择器：${menuLabels().join(' | ')}`);
        const item = findMenuItem(`现处 ${dirB}`);
        ok(item, `★ 「现处 ${dirB}」在菜单里（旧行为：置灰"它就在这儿"）：${menuLabels().join(' | ')}`);
        ok(item?.getAttribute('aria-disabled') !== 'true', '……可点（P7.18b 起全状态可点）');
        H.click(item as Element);
        const cfm = await untilEl(() => modalWith('只写声明'));
        ok(cfm, '确认流弹出来了');
        contains(H.textOf(cfm!), '00_Inbox', '★ 确认单预览如实显示"从 00_Inbox（旧声明）→"');
        contains(H.textOf(cfm!), dirB, '……"→ 现处别处"');
        ok(clickModalBtn(cfm!, '只写声明'), '点了主按钮');
        ok(
          await H.until(
            () =>
              declaredPositions(ctx().index.get(abs)?.props ?? {})[0] === dirB,
            3000,
            40,
          ),
          '★ 声明纠回现处（00_Inbox → 别处）',
        );
        eq(fs.readFileSync(path.join(vaultRoot, abs), 'utf8'), RAW.replace('00_Inbox', dirB), '……除声明外逐字节不动');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, kb, dirB));
      }
    });
  });
}
