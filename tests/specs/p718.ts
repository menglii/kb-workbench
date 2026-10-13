/**
 * spec：**P7.18 · YAML 专项 · 三**（退出清理）—— 条目真源 `P7.18开工提示词.md` §1；
 * 口径回改在 `交互规格.md` §15 / `YAML优化方案.md` §3。
 *
 * 五组（判据草案逐条落）：
 *   · **逐键删一条**（真写盘）：勾「状态」→ 只该键消失、其余键与正文逐字节不动 → 撤销逐字节还原；
 *     顺带钉「扫描只读」与「默认全不勾（主按钮置灰）」；
 *   · **坏前言跳过一条**：坏前言夹具被跳过 + 逐篇报 + 引导「去修前言」；勾了键也一字不动；
 *   · **足迹清一条**（真写盘）：勾配置/日志 → 文件真没了、笔记一个字节不动、认不出的不删
 *     （目录壳留着）→ 撤销还原；
 *   · **幂等一条**：清完再扫 = 0（面板自己变 0；**自备小库根**，与默认库的存量无关）；
 *   · **入口一条**：设置 →「数据」栏 → 行「退出插件前的清理…」→ 打开面板。
 *
 * ⚠️ 夹具全带 `__p718` 前缀，每条自己收场（`metadataCache.settle()` 那套安全删法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { joinPath } from '../../src/core/paths';
import { planCleanupOf } from '../../src/services/cleanup';
import { openCleanupPanel } from '../../src/ui/cleanup-panel';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';

export async function specP718(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const KB = '01_新知识库';

  /** kbRoot 拨回默认（每个 spec 自己的库，防御性自证前提 —— 与 p715/p716/p717 同款） */
  async function ensureKbRootDefault(): Promise<string> {
    if (ctx().settings.kbRoot() !== KB) {
      await ctx().settings.save({ kbRoot: KB });
      await H.settle(150);
    }
    return KB;
  }

  /** 安全带删法（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 metadataCache 还有一个滞后重解析定时器 */
  async function rmFix(abs: string): Promise<void> {
    fs.rmSync(abs, { force: true, recursive: true });
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(120);
  }

  /** 造自用夹具（裸文本；六件齐 / 坏前言这些形状 `H.note` 序列化不出来） */
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

  /** 裸文本写（路径**相对 vault 根**）—— 自备小库根那些用例用 */
  async function writeAt(relFromVault: string, text: string): Promise<void> {
    const full = path.join(vaultRoot, relFromVault);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(150);
  }

  const readAbs = (abs: string): string => fs.readFileSync(path.join(vaultRoot, abs), 'utf8');

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 4000): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  function topModal(needle = ''): HTMLElement | null {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal').filter(
      (m) => needle === '' || H.textOf(m).includes(needle),
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

  /** 面板 foot 上的「清理所选（N 项）」主按钮 */
  function runBtn(): HTMLElement | undefined {
    return H.qa<HTMLElement>(document.body, '.kbw-modal-foot .kbw-btn').find((b) =>
      H.textOf(b).startsWith('清理所选'),
    );
  }

  /** 面板里含某段文案的勾选行（`.kbw-clean-pick`） */
  function pickRow(needle: string): HTMLElement | undefined {
    return H.qa<HTMLElement>(document.body, '.kbw-clean-pick').find((r) =>
      H.textOf(r).includes(needle),
    );
  }

  function check(row: HTMLElement): HTMLInputElement {
    const cb = row.querySelector('input.kbw-mig-check') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return cb;
  }

  /** 危险态两段式：第一下上膛、第二下执行 */
  async function armAndGo(cfm: HTMLElement, first: string): Promise<void> {
    ok(clickModalBtn(cfm, first), `点了主按钮（第一下 = 上膛：${first}）`);
    await H.settle(80);
    ok(clickModalBtn(cfm, '再点一次确认'), '第二下才真的执行');
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

  // ════════════════════════════════════════════════════════════
  // 一 · 逐键删（扫描只读 · 默认全不勾 · 只删勾选的键 · 撤销逐字节还原）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 逐键删（只删勾选的键 · 撤销逐字节还原）', async () => {
    await suite.it('勾「状态」→ 只该键消失、其余键与正文逐字节不动 → 撤销 = 快照还原', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p718六件.md';
      const abs = `${kb}/${rel}`;
      /** 六件齐 + 控制字段（`tags` 块值 / 网址值 / 布尔值都要保形） */
      const RAW =
        [
          '---',
          '类型: 笔记',
          '状态: 进行中',
          '文件位置:',
          '  - 00_Inbox',
          '创建日期: 2026-01-01',
          'tags:',
          '  - 保留我',
          '收藏: false',
          '位置锁定: true',
          '来源: https://example.com/p718',
          '---',
          '',
          '正文，一字不动。',
          '',
        ].join('\n');
      try {
        await writeRaw(rel, RAW);
        openCleanupPanel(ctx());
        const row = await untilEl(() => pickRow('「状态」'), 5000);
        ok(row, '★ 面板列出「状态」键行');
        contains(H.textOf(row!), '会从', '行里是"会从 N 篇里删掉"的预览');
        // 扫描只读：这时候文件一个字节都不许动
        eq(readAbs(abs), RAW, '★ 打开面板（扫描）不改任何东西');
        const cb = row!.querySelector('input.kbw-mig-check') as HTMLInputElement;
        ok(cb, '行里有勾选框');
        eq(cb.checked, false, '★ 默认全不勾（D3 拍板）');
        eq(runBtn()?.hasAttribute('disabled') ?? false, true, '★ 没勾时主按钮是灰的');
        check(row!);
        await H.settle(80);
        ok(
          (runBtn()?.hasAttribute('disabled') ?? true) === false,
          '勾了 → 主按钮就绪',
        );
        contains(H.textOf(runBtn()!), '清理所选', '按钮文案带"清理所选"');
        H.click(runBtn() as Element);
        const cfm = await untilEl(() => topModal('即将清理'));
        ok(cfm, '★ 确认流（动库前确认只能过 ui/confirm）');
        contains(H.textOf(cfm!), '状态', '确认单写明删哪个键');
        await armAndGo(cfm!, '清理 1 项');
        ok(
          await H.until(() => !/(^|\n)状态:/.test(readAbs(abs)), 5000, 40),
          '★ 「状态」键真删了',
        );
        const after = readAbs(abs);
        contains(after, '类型: 笔记', '其余键在');
        contains(after, '来源: https://example.com/p718', '控制字段在（没勾不删）');
        contains(after, '位置锁定: true', 'bool 保形');
        contains(after, '  - 保留我', '块值保形');
        contains(after, '正文，一字不动。', '正文不动');
        {
          /** 除被删那一行外，原文每一行按原序都还在（重排 / 丢行会红） */
          const rawLines = RAW.split('\n').filter((l) => l !== '状态: 进行中');
          let cursor = 0;
          const inOrder = rawLines.every((line) => {
            const at = after.indexOf(line, cursor);
            if (at < 0) return false;
            cursor = at + line.length;
            return true;
          });
          ok(inOrder, '★ 除被删那行外，原样每一行按原序都在');
        }
        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '★ 清理完出撤销条（快照兜底）');
        H.click(u as Element);
        ok(await H.until(() => readAbs(abs) === RAW, 6000, 40), '★ 撤销 = 快照还原：逐字节回到原样');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 二 · 坏前言跳过（整篇跳过 · 逐篇报 · 引导修前言）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 坏前言跳过（守卫不拆）', async () => {
    await suite.it('坏前言篇整篇跳过：逐篇列名 + 「去修前言」在；勾了键执行也一字不动', async () => {
      const kb = await ensureKbRootDefault();
      const relBad = '00_Inbox/__p718坏前言.md';
      const relOk = '00_Inbox/__p718好篇.md';
      const absBad = `${kb}/${relBad}`;
      const absOk = `${kb}/${relOk}`;
      const RAW_BAD = '---\n创建日期: {{date}}\n状态: 进行中\n---\n\n坏前言正文。\n';
      const RAW_OK = '---\n类型: 笔记\n状态: 进行中\n---\n\n好篇正文。\n';
      try {
        await writeRaw(relBad, RAW_BAD);
        await writeRaw(relOk, RAW_OK);
        // 服务层：坏前言进 fragile 档、不进键计数
        const plan = await planCleanupOf(ctx());
        ok(plan.fragile.some((x) => x.path === absBad), '★ 服务层：坏前言进「跳过」档');
        ok(
          !plan.keys.some((k) => k.key === '状态' && k.samples.includes('__p718坏前言')),
          '……坏前言篇不计进「状态」的样例',
        );
        openCleanupPanel(ctx());
        const skipRow = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-mig-row.is-skip').find((r) =>
              H.textOf(r).includes('坏前言跳过'),
            ),
          5000,
        );
        ok(skipRow, '★ 面板上有「坏前言跳过」分档');
        contains(H.textOf(skipRow!), '__p718坏前言', '逐篇列名');
        ok(
          H.qa<HTMLElement>(skipRow!, '.kbw-btn').some((b) => H.textOf(b).includes('去修前言')),
          '★ 引导「去修前言」（P7.16 的修前言面板）',
        );
        // 勾「状态」真执行：好篇删掉、坏前言篇一字不动
        const row = await untilEl(() => pickRow('「状态」'), 5000);
        ok(row, '前提：「状态」键行在');
        check(row!);
        await H.settle(80);
        H.click(runBtn() as Element);
        const cfm = await untilEl(() => topModal('即将清理'));
        ok(cfm, '确认流开了');
        await armAndGo(cfm!, '清理 ');
        ok(
          await H.until(() => !/(^|\n)状态:/.test(readAbs(absOk)), 5000, 40),
          '★ 好篇的状态键删掉了',
        );
        eq(readAbs(absBad), RAW_BAD, '★ 坏前言篇一字不动（守卫整篇拦下）');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, absBad));
        await rmFix(path.join(vaultRoot, absOk));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 三 · 足迹清（文件真没了 · 认不出的不删 · 撤销还原）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 足迹清（配置/日志 · 认不出的不删）', async () => {
    await suite.it('勾配置/日志 → 文件真没了、笔记一字节不动、sneaky 不删壳留着 → 撤销还原', async () => {
      /**
       * ⚠️ **自备小库根**：不动合成夹具的 `99_Meta`（那儿可能有自己的配置/日志，
       * 覆盖或删掉会波及其它用例）。小库里一切自备，收场删净 + 拨回。
       */
      const scratch = '09_p718足迹';
      const scratchAbs = path.join(vaultRoot, scratch);
      const noteRel = `${scratch}/00_Inbox/__p718足迹对照.md`;
      const wbDir = `${scratch}/99_Meta/06_工作台`;
      const logDir = `${scratch}/99_Meta/05_操作日志`;
      const autoRel = `${wbDir}/自动化.json`;
      const sneakyRel = `${wbDir}/sneaky.txt`;
      const logRel = `${logDir}/日志-20260101-120000-测试.md`;
      const NOTE_RAW = '---\n类型: 笔记\n状态: 进行中\n---\n\n足迹对照正文。\n';
      const AUTO_RAW = '{ "version": 1 }\n';
      const LOG_RAW = '---\n类型: 日志\n---\n\n# 测试日志\n';
      const abs = (rel: string): string => path.join(vaultRoot, rel);
      try {
        await writeAt(noteRel, NOTE_RAW);
        await writeAt(autoRel, AUTO_RAW);
        await writeAt(sneakyRel, 'x');
        await writeAt(logRel, LOG_RAW);
        await ctx().settings.save({ kbRoot: scratch });
        await H.settle(200);
        ctx().index.rebuild();
        await H.settle(150);
        // 服务层形状：认得出的才列、认不出的进 others
        const plan = await planCleanupOf(ctx());
        const wb = plan.footprints.find((f) => f.id === 'workbench');
        ok(wb, '★ 服务层：工作台配置进清单');
        ok(wb!.files.some((f) => f.name === '自动化.json'), '……认得出自动化.json');
        ok(!wb!.files.some((f) => f.name === 'sneaky.txt'), '★ 认不出的不列（不删）');
        ok(wb!.others.includes('sneaky.txt'), '……只在"另有 N 项"里点名');
        const lg = plan.footprints.find((f) => f.id === 'logs');
        ok(lg && lg.files.some((f) => f.name === '日志-20260101-120000-测试.md'), '★ 日志按文件名形态认得出');
        openCleanupPanel(ctx());
        const wbRow = await untilEl(() => pickRow('工作台配置'), 5000);
        ok(wbRow, '★ 面板上有「工作台配置」行');
        contains(H.textOf(document.body), '不是插件写的，不动', '行里说明"认不出的不动"');
        check(wbRow!);
        const lgRow = pickRow('操作日志');
        ok(lgRow, '「操作日志」行在');
        check(lgRow!);
        await H.settle(80);
        H.click(runBtn() as Element);
        const cfm = await untilEl(() => topModal('即将清理'));
        ok(cfm, '确认流开了');
        await armAndGo(cfm!, '清理 2 项');
        ok(await H.until(() => !fs.existsSync(abs(autoRel)), 5000, 40), '★ 自动化.json 真没了');
        ok(await H.until(() => !fs.existsSync(abs(logRel)), 5000, 40), '★ 日志文件真没了');
        eq(readAbs(noteRel), NOTE_RAW, '★ 笔记一个字节不动');
        ok(fs.existsSync(abs(sneakyRel)), '★ 认不出的 sneaky.txt 没被删');
        ok(fs.existsSync(abs(wbDir)), '……目录壳也留着（里面还有别的东西）');
        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '★ 清理完出撤销条');
        H.click(u as Element);
        ok(
          await H.until(
            () => fs.existsSync(abs(autoRel)) && readAbs(autoRel) === AUTO_RAW,
            6000,
            40,
          ),
          '★ 撤销 = 快照还原：配置文件逐字节回来',
        );
        ok(fs.existsSync(abs(logRel)), '……日志也回来了');
      } finally {
        await closeEverything();
        await ensureKbRootDefault();
        fs.rmSync(scratchAbs, { force: true, recursive: true });
        app.vault.rescan();
        await app.metadataCache.settle();
        ctx().index.rebuild();
        await H.settle(150);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 四 · 幂等（清完再扫 = 0；自备小库根）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 幂等（清完再扫 = 0）', async () => {
    await suite.it('小库：全勾 → 清 → 重扫 = 0（面板自己变 0；日志目录空壳也摘掉）', async () => {
      const scratch = '09_p718小库';
      const scratchAbs = path.join(vaultRoot, scratch);
      try {
        await writeAt(`${scratch}/00_Inbox/__p718甲.md`, '---\n类型: 笔记\n状态: 进行中\n收藏: false\n---\n\n甲正文。\n');
        await writeAt(`${scratch}/99_Meta/05_操作日志/日志-20260101-130000-甲.md`, '---\n类型: 日志\n---\n\n# 甲刊\n');
        await ctx().settings.save({ kbRoot: scratch });
        await H.settle(200);
        ctx().index.rebuild();
        await H.settle(150);
        openCleanupPanel(ctx());
        ok(await untilEl(() => pickRow('「状态」'), 5000), '★ 小库里扫出可清的键');
        // 全勾（键 + 足迹）
        const picks = H.qa<HTMLElement>(document.body, '.kbw-clean-pick');
        ok(picks.length >= 2, `勾选行 ≥2（键 + 足迹），实际 ${picks.length}`);
        for (const p of picks) check(p);
        await H.settle(80);
        H.click(runBtn() as Element);
        const cfm = await untilEl(() => topModal('即将清理'));
        ok(cfm, '确认流开了');
        await armAndGo(cfm!, '清理 ');
        ok(
          await H.until(() => !H.maybe(document.body, '.kbw-modal')?.textContent?.includes('正在扫描'), 6000, 60),
          '执行后自动重扫',
        );
        ok(
          await H.until(() => H.textOf(document.body).includes('没有可清的'), 6000, 60),
          '★ 清完再扫 = 0（面板自己变 0，与 §13 同款完成定义）',
        );
        ok(
          !fs.existsSync(path.join(vaultRoot, `${scratch}/99_Meta/05_操作日志`)),
          '★ 日志目录清空后连空壳也摘掉了',
        );
        ok(
          !/(^|\n)状态:/.test(readAbs(`${scratch}/00_Inbox/__p718甲.md`)),
          '甲篇的键也清掉了',
        );
      } finally {
        await closeEverything();
        await ensureKbRootDefault();
        fs.rmSync(scratchAbs, { force: true, recursive: true });
        app.vault.rescan();
        await app.metadataCache.settle();
        ctx().index.rebuild();
        await H.settle(150);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 四补 · 「整个库」模式（独立审 🔴2 的回销：手拼前缀在空串根下恒 false）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 「整个库」模式不整片空掉', async () => {
    await suite.it('kbRoot = 空串时扫描照样有篇有键（旧写法：记 0 篇 + "没有可清的 ✅"假绿）', async () => {
      try {
        await ctx().settings.save({ kbRoot: '' });
        await H.settle(250);
        ctx().index.rebuild();
        await H.settle(150);
        const plan = await planCleanupOf(ctx());
        ok(
          plan.scanned > 0,
          `★ 整个库模式扫过的篇数 > 0（旧写法手拼前缀恒 false → 0）——实际 ${plan.scanned}`,
        );
        ok(plan.keys.length > 0, '★ 扫得出属性键（旧写法：一片空 + 面板报"没有可清的 ✅"）');
      } finally {
        await ensureKbRootDefault();
        ctx().index.rebuild();
        await H.settle(150);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 四补二 · 撤销不弹假警报（独立审 🔴3 的回销：deletions 的重建归第 ④ 步）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 撤销不弹假警报（被删文件的重建归 deletions 管）', async () => {
    await suite.it('capture(files + deletions) → 真删 → restore：problems 必须为空、文件逐字节回来', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '99_Meta/05_操作日志/日志-20260101-140000-假警报.md';
      const abs = `${kb}/${rel}`;
      const RAW = '---\n类型: 日志\n---\n\n# 假警报夹具\n';
      try {
        await writeRaw(rel, RAW);
        const file = ctx().index.get(abs)?.file ?? null;
        ok(file, '前提：夹具进索引');
        const snap = await ctx().snapshot.capture({
          reason: '测试：撤销的假警报（deletions 重建归第 ④ 步）',
          files: [file!],
          deletions: [{ path: abs, trashed: false }],
        });
        await ctx().app.fileManager.trashFile(file!);
        ok(!fs.existsSync(path.join(vaultRoot, abs)), '前提：真删了（模拟清理足迹之后）');
        const r = await ctx().snapshot.restore(snap.id);
        eq(
          r.problems.length,
          0,
          `★ 正常还原不许报"没做到"（旧写法会推一条"已不在原位"的假账）——实际：${r.problems.join('；')}`,
        );
        eq(readAbs(abs), RAW, '★ 文件按 deletions 重建回来（逐字节）');
      } finally {
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 五 · 入口（设置 →「数据」栏）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.18 · 入口（设置 →「数据」栏那行）', async () => {
    await suite.it('设置 → 数据：行「退出插件前的清理…」在（含三层出口说明）→ 打开面板', async () => {
      await ensureKbRootDefault();
      try {
        ctx().openWorkbenchSettings('data');
        await H.settle(300);
        const row = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) =>
              H.textOf(r).includes('退出插件前的清理'),
            ),
          5000,
        );
        ok(row, '★ 「数据」栏里有「退出插件前的清理…」行');
        const btnOpen = H.qa<HTMLElement>(row!, '.kbw-btn').find((b) => H.textOf(b).includes('打开'));
        ok(btnOpen, '行里是「打开…」按钮');
        contains(H.textOf(document.body), '关掉模块开关 = 停手', '三层出口的说明就在这一栏');
        contains(H.textOf(document.body), '删掉插件目录 = 完全退出', '……第二层');
        H.click(btnOpen as Element);
        ok(await untilEl(() => topModal('退出插件前的清理')), '★ 打开 → 清理面板开');
      } finally {
        await closeEverything();
      }
    });
  });
}
