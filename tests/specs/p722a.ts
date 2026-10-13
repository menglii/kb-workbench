/**
 * spec：**P7.22a · 写面扩容**（2026-10-11）—— #1 正文编辑 · #8 rename · #10 上限与继续 ·
 * #11 属性/标签批改补快照 · #13 全权预设（本轮 a 段；b 段的 #2/#3/#4/#5 另有 spec）
 *
 * 判据草案来自开工提示词 §1（逐条落）：
 *  · #1：离线（三态幂等 / 多命中拒 / 快照还原**逐字节** / 03_AI指令集硬拦照旧 /
 *    skill 白名单自动认新工具 / diff 预览在）＋ 探针（真机改一篇再还原）；
 *  · #8：离线（真改名 + 快照还原 + 同名拒 + 撞名不覆盖）+ 探针一条；
 *  · #10：31 个动作一步 —— 前 30 **真执行**、第 31 如实说"只执行了前 30 个"·
 *    「继续」续跑（面板真链路）；
 *  · #11：离线（AI 改 3 篇属性 → 撤销**逐字节**还原 + 快照失败不写）；
 *  · #13：三按钮各点一次 → `toolTiers` 值对 + 当前档明示文案。
 *
 * ⚠️ 真机才验得了的（正文 diff 的观感 / 撤销条手感）在 `scripts/probe.mjs` 的 P7.22a 新步。
 * 🔴 离线绝不联网：面板链路全走 `H.stubAiSeq`（桩的 `requestUrl` 默认抛）。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, notContains, ok } from '../framework';
import * as H from '../helpers';
import { relativeTo } from '../../src/core/paths';
import { purgeOverlays } from '../../src/ui/panel';
import {
  AI_AGENT_LIMITS,
  DEFAULT_TOOL_TIERS,
  planAppend,
  planPatchText,
  runAgentLoop,
  validateCall,
  type AiToolOutcome,
} from '../../src/services/ai';
import { makeAiToolPort } from '../../src/ui/ai-tools';

const KB = '01_新知识库';

export async function specP722a(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 造一篇笔记（本轮的 `__p722a*` 夹具）+ 索引跟上（与 p721b 的 mk 同款） */
  async function mk(rel: string, text: string): Promise<string> {
    H.writeNote(vaultRoot, `${KB}/${rel}`, text);
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app);
    return rel;
  }

  /** 收干净浮层与菜单（直驱用例的起手/收尾仪式） */
  function sweep(): void {
    purgeOverlays();
  }

  /** 等一个元素出现（`H.until` 只回布尔） */
  async function untilEl<T>(fn: () => T | null | undefined, ms = 3000): Promise<T | null> {
    const hit = await H.until(() => fn() != null, ms);
    return hit ? ((fn() as T) ?? null) : null;
  }

  // ════════════════════════════════════════════════════════════
  // §A · #1 正文编辑（纯函数 · 三态幂等）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22a · #1 正文编辑（纯函数 · 三态幂等）', async () => {
    await suite.it('planPatchText：恰好 1 处才换 · >1 处拒 · 0 处分"抄错 / 已改过"两态 · 空 replace = 删段', () => {
      const body = '第一段 旧词 的话。\n\n第二段不动。\n';
      const okPlan = planPatchText(body, '旧词', '新词');
      eq(
        'body' in okPlan ? okPlan.body : '（被拒）',
        '第一段 新词 的话。\n\n第二段不动。\n',
        '恰好 1 处 → 换（别的字一个不动）',
      );
      const many = planPatchText('x x', 'x', 'y');
      ok('why' in many, '超过 1 处 → 不写（拒）');
      contains('why' in many ? many.why : '', '2 处', '说清出现几处（引导多抄几个字）');
      const miss = planPatchText(body, '不存在的原文', '新');
      ok('why' in miss, '0 处且 replace 也不在 → 不写');
      contains('why' in miss ? miss.why : '', '没找到', '说清"没找到"（find 要原文照抄）');
      const done = planPatchText('正文里已经是 Gamma 了', 'Beta', 'Gamma');
      ok('why' in done, '0 处但 replace 在 → 不写（幂等）');
      contains('why' in done ? done.why : '', '已经改过', '如实说"已改过"（三态的"已打"）');
      const del = planPatchText(body, '旧词', '');
      eq('body' in del ? del.body : '（被拒）', '第一段  的话。\n\n第二段不动。\n', 'replace 空 = 删掉这一段');
      ok('why' in planPatchText(body, '   ', 'x'), '全空白的 find → 拒');
      // 含标点的"原文照抄"（不多不少地命中）
      const punct = planPatchText('先看 Alpha 的话。后看别的。', 'Alpha 的话。', 'Beta 的话。');
      eq('body' in punct ? punct.body : '（被拒）', '先看 Beta 的话。后看别的。', '标点照抄也命中');
    });

    await suite.it('planAppend：末尾追加（分隔保守，既有字符不动）· 尾部已含 = 幂等跳过 · 空正文直落', () => {
      const e1 = planAppend('', '开头的话');
      eq('body' in e1 ? e1.body : '（被拒）', '开头的话', '空正文直接落');
      const e2 = planAppend('正文', '追加段');
      eq('body' in e2 ? e2.body : '（被拒）', '正文\n\n追加段', '正文不以换行结尾 → 补空行分隔');
      const e3 = planAppend('正文\n', '追加段');
      eq('body' in e3 ? e3.body : '（被拒）', '正文\n\n追加段', '以单个换行结尾 → 补一个');
      const e4 = planAppend('正文\n\n', '追加段');
      eq('body' in e4 ? e4.body : '（被拒）', '正文\n\n追加段', '已有空行 → 直接接');
      const dup = planAppend('正文\n\n追加段', '追加段');
      ok('why' in dup, '文末已有同样内容 → 不重复追加（幂等的自证口径）');
      contains('why' in dup ? dup.why : '', '已经有', '如实说');
      ok('why' in planAppend('正文', '  '), '空 content → 拒');
    });

    await suite.it('validateCall：三个新工具的必填 / 拒法（replace 超长**拒、不截断**）· 自我授权字段照旧门口丢掉', () => {
      eq(validateCall({ tool: 'patch_text', args: { path: 'a.md', find: 'x', replace: 'y' } }).ok, true, '正常 patch 过');
      eq(validateCall({ tool: 'patch_text', args: { path: 'a.md', replace: 'y' } }).ok, false, '缺 find → 拒');
      eq(
        validateCall({ tool: 'patch_text', args: { path: 'a.md', find: 'x', replace: 'z'.repeat(5000) } }).ok,
        false,
        'replace 超长**拒**（截断 = 把半截话写进正文 —— 与 body 的"截断好过拒掉"刻意相反）',
      );
      eq(validateCall({ tool: 'append', args: { path: 'a.md' } }).ok, false, '缺 content → 拒');
      eq(validateCall({ tool: 'append', args: { path: 'a.md', content: 'ok' } }).ok, true, '正常 append 过');
      eq(validateCall({ tool: 'rename', args: { path: 'a.md', name: 'a/b' } }).ok, false, 'name 带目录 → 拒');
      eq(validateCall({ tool: 'rename', args: { path: 'a.md', name: '' } }).ok, false, 'name 空 → 拒');
      eq(validateCall({ tool: 'rename', args: { path: 'a.md', name: '新名' } }).ok, true, '正常 rename 过');
      const junk = validateCall({ tool: 'patch_text', args: { path: 'a.md', find: 'x', replace: 'y', force: true } });
      ok(junk.ok, '塞 force 的正常调用照过');
      if (junk.ok) eq('force' in junk.call.args, false, '`force` 在门口丢掉（模型不能自我授权）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B · #1 正文编辑（执行体 · 真写 + 快照还原）／#8 rename
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22a · 执行体（正文写 · rename · 还原）', async () => {
    /** 直驱执行体（写类：`askPending` 假批准；confirm 由下面的 runWrites 助手点掉） */
    const port = (opts: { allowTools?: string[] | null } = {}) =>
      makeAiToolPort({
        ctx: ctx(),
        askPending: async (entries) => entries.map(() => true),
        allowTools: (opts.allowTools ?? null) as never,
      });

    /**
     * **预期被拒的调用**（dry-run 拒 / 硬拦）：起 `runBatch`，同时挂一个**确认框监视器**。
     *
     * 🔴 为什么需要（P7.22a 突变实测）：突变把"拒"打断成"执行"时，确认框会**弹出来等点击** ——
     * 没人点就是**挂死**（判定器只能看到超时，读成"测试没跑起来"），而不是一条清晰的"红"。
     * 监视器一看到框就**点取消**（诚实收场：什么都没写、用例带着 `unexpectedModal` 红）。
     */
    async function runExpectReject(
      calls: { tool: string; args: Record<string, unknown> }[],
      opts: { allowTools?: string[] | null } = {},
    ): Promise<{ out: AiToolOutcome[]; unexpectedModal: boolean }> {
      let unexpected = false;
      let stopped = false;
      const watcher = (async () => {
        for (let i = 0; i < 40 && !stopped; i += 1) {
          await H.settle(50);
          const ms = H.qa<HTMLElement>(document.body, '.kbw-modal');
          if (ms.length > 0 && !stopped) {
            unexpected = true;
            const btns = Array.from(ms[ms.length - 1].querySelectorAll<HTMLElement>('.kbw-modal-foot .kbw-btn'));
            const cancel = btns.find((b) => (b.textContent ?? '').trim() === '取消');
            H.click(cancel ?? btns[0] ?? ms[ms.length - 1]);
            break;
          }
        }
      })();
      const out = await port(opts).runBatch(calls, {});
      stopped = true;
      await watcher;
      return { out, unexpectedModal: unexpected };
    }

    /** 跑一批**写类**：等确认框 → 点主按钮 → 收结果（与手工同一条确认流） */
    async function runWrites(
      calls: { tool: string; args: Record<string, unknown> }[],
      opts: { allowTools?: string[] | null } = {},
    ): Promise<{ out: AiToolOutcome[]; confirmText: string; modal: HTMLElement | null }> {
      const p = port(opts).runBatch(calls, {});
      const m = await untilEl(() => H.qa<HTMLElement>(document.body, '.kbw-modal')[0] ?? null, 3000);
      const confirmText = m ? H.textOf(m) : '';
      if (m) {
        H.click(H.q<HTMLElement>(m, '.kbw-modal-foot .kbw-btn.is-primary'));
        await H.settle(80);
      }
      const out = await p;
      return { out, confirmText, modal: m };
    }

    await suite.it('patch_text 全链：确认框（带 diff 预览）→ 只换命中处（前言不动）→ 撤销条 → **逐字节**还原', async () => {
      sweep();
      const before = '---\n类型: 笔记\ntags: []\n---\n\n第一段 旧词 在这里。\n\n第二段不动。\n';
      const rel = await mk('__p722a正文甲.md', before);
      const abs = `${KB}/${rel}`;
      const { out, confirmText, modal } = await runWrites([
        { tool: 'patch_text', args: { path: rel, find: '旧词', replace: '新词' } },
      ]);
      eq(out[0].ok, true, `写成了（实际：${out[0].summary}）`);
      ok(modal, '确认框弹出来了（写类必过确认流）');
      const diff = modal ? H.maybe<HTMLElement>(modal, '.kbw-diff') : null;
      ok(diff, 'diff 预览在（G9 拍板"带 diff 预览"）');
      if (diff) contains(H.textOf(diff), '对比', '对比框有抬头');
      contains(confirmText, '改正文', '预览行写明"改正文"');
      const after = H.readNote(vaultRoot, abs);
      contains(after, '新词', '正文换了');
      notContains(after, '旧词', '旧词没了（成对判）');
      ok(after.startsWith('---\n类型: 笔记\ntags: []\n---\n'), '前言原样保留（只换正文）');
      contains(after, '第二段不动。', '没碰别的段');
      const undo = H.currentUndoButton('撤销');
      ok(undo, '撤销条在（快照还原）');
      H.click(undo as Element);
      await H.settle(420);
      eq(H.readNote(vaultRoot, abs), before, '**逐字节**还原到写前');
      sweep();
    });

    /**
     * ⬇️ **独立审 🟡5 的补齐**：`confirm → 执行` 之间正文被别处改过的 **skip 路**
     * （`ui/doc-write.ts` 的 `{skip}` 分支 + 执行体的"没有改"文案）原先没有判据 ——
     * 而这正是文档反复承诺的"防呆"语义。手法：起一批拿 promise → 等确认框 → **改盘** → 再点主按钮。
     */
    await suite.it('防呆：确认框之后、执行之前正文被别处改过 → 不覆盖（skip 如实报 · 别处那笔逐字节保留）', async () => {
      sweep();
      const rel = await mk('__p722a防呆.md', '---\ntags: []\n---\n\n原来那句 旧词 在这里。\n');
      const abs = `${KB}/${rel}`;
      // ⚠️ 先拿 promise 再等框（别 await 在前面 —— 那会自己等自己）
      const p = port().runBatch([{ tool: 'patch_text', args: { path: rel, find: '旧词', replace: '新词' } }], {});
      const m = await untilEl(() => H.qa<HTMLElement>(document.body, '.kbw-modal')[0] ?? null, 3000);
      ok(m, '确认框在（前提自证）');
      /**
       * 确认期间"别处"改了正文（模拟同步拉进来一笔 / 别的窗口在编辑）：把 find 段换掉。
       * ⚠️ 替换文本里**不能带上 `find` 的子串**（第一版写"没有旧词了"——"旧词"恰在里头，
       * find 又命中一次、防呆没被触发；夹具文案自己摆的乌龙）。
       */
      const elsewhere = '---\ntags: []\n---\n\n已经被别处整段改掉了，这句不一样。\n';
      H.writeNote(vaultRoot, abs, elsewhere);
      H.click(H.q<HTMLElement>(m as HTMLElement, '.kbw-modal-foot .kbw-btn.is-primary'));
      await H.settle(80);
      const out = await p;
      eq(out[0].ok, false, '没写（防呆：以**当刻正文**重跑判定）');
      contains(String(out[0].summary), '没有改', '如实报"没有改"');
      eq(H.readNote(vaultRoot, abs), elsewhere, '别处那一笔**逐字节保留**（没有被覆盖）');
      sweep();
    });

    await suite.it('patch_text 幂等与拒法（执行体层）：已改过 / 找不到 / 多命中 —— 都不弹确认框、如实回话', async () => {
      sweep();
      const body = '---\ntags: []\n---\n\n甲 乙 甲 都在这一段。\n';
      const rel = await mk('__p722a正文乙.md', body);
      // 多命中 → 拒（预期被拒的调用一律走 runExpectReject：突变打断"拒"时不挂死、只红）
      const many = await runExpectReject([{ tool: 'patch_text', args: { path: rel, find: '甲', replace: '丙' } }]);
      eq(many.unexpectedModal, false, '多命中不该弹确认框');
      eq(many.out[0].ok, false, '多命中 → 拒');
      contains(String(many.out[0].summary), '2 处', '说清几处');
      // 找不到 → 拒
      const miss = await runExpectReject([{ tool: 'patch_text', args: { path: rel, find: '不存在的', replace: 'x' } }]);
      eq(miss.unexpectedModal, false, '找不到不该弹确认框');
      eq(miss.out[0].ok, false, '找不到 → 拒');
      contains(String(miss.out[0].summary), '没找到', '如实说没找到');
      // 正常改一处（唯一的那段） → 再改同一处 → dry-run 认出"已改过"
      const once = await runWrites([{ tool: 'patch_text', args: { path: rel, find: '乙', replace: '丁' } }]);
      eq(once.out[0].ok, true, '第一发改成');
      const twice = await runExpectReject([{ tool: 'patch_text', args: { path: rel, find: '乙', replace: '丁' } }]);
      eq(twice.unexpectedModal, false, '重复执行不该弹确认框（该在 dry-run 就认出"已改过"）');
      eq(twice.out[0].ok, false, '同一条再来 → 拒（幂等：已改过）');
      contains(String(twice.out[0].summary), '已经改过', '如实说已改过');
      eq(H.qa(document.body, '.kbw-modal').length, 0, '三次拒都**没弹确认框**（不摆注定失败的卡）');
      // 清掉撤销条（别影响后面的用例）
      H.click(H.currentUndoButton('撤销') as Element);
      await H.settle(420);
      eq(H.readNote(vaultRoot, `${KB}/${rel}`), body, '还原回来了（前提自证）');
      sweep();
    });

    await suite.it('append：真追加（分隔 +\\n\\n）· 重复追加被幂等挡 · 03_AI指令集硬拦照旧 · 白名单自动认新工具', async () => {
      sweep();
      const rel = await mk('__p722a正文丙.md', '---\ntags: []\n---\n\n已有正文');
      const abs = `${KB}/${rel}`;
      // ① 正常追加
      const first = await runWrites([{ tool: 'append', args: { path: rel, content: '补一段' } }]);
      eq(first.out[0].ok, true, '追加成了');
      contains(H.readNote(vaultRoot, abs), '已有正文\n\n补一段', '分隔 +\\n\\n、既有字符不动');
      // ② 重复同上 → 幂等挡
      const again = await runExpectReject([{ tool: 'append', args: { path: rel, content: '补一段' } }]);
      eq(again.unexpectedModal, false, '重复追加不该弹确认框（该在 dry-run 就挡）');
      eq(again.out[0].ok, false, '重复追加 → 拒');
      contains(String(again.out[0].summary), '已经有', '如实说"文末已有"');
      // 清撤销条
      H.click(H.currentUndoButton('撤销') as Element);
      await H.settle(420);
      // ③ 03_AI指令集 硬拦（写与搬进出都拦 —— 正文写也是写）
      const guardRel = `${relativeTo(ctx().ai.protectedDir(), ctx().settings.kbRoot())}/__p722a护.md`;
      H.writeNote(vaultRoot, `${KB}/${guardRel}`, '---\ntags: []\n---\n\n指令集里的\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      const guarded = await runExpectReject([{ tool: 'patch_text', args: { path: guardRel, find: '指令集', replace: 'x' } }]);
      eq(guarded.unexpectedModal, false, 'AI 指令集不该弹确认框（硬拦在预检就挡）');
      eq(guarded.out[0].ok, false, 'AI 指令集 → 拒');
      contains(String(guarded.out[0].summary), '只能读', '如实说硬拦原因');
      // ④ 能力包白名单自动认新工具（收窄只做减法）
      // ⚠️ 这条会弹确认框 —— 先拿 promise 再点（**别 await 在前面**，那是自己等自己）
      const allowedP = port({ allowTools: ['patch_text'] }).runBatch(
        [{ tool: 'patch_text', args: { path: rel, find: '已有', replace: '改过' } }],
        {},
      );
      const m = await untilEl(() => H.qa<HTMLElement>(document.body, '.kbw-modal')[0] ?? null, 2000);
      ok(m, '白名单收窄照走确认流（框弹出来了）');
      if (m) {
        H.click(H.q<HTMLElement>(m, '.kbw-modal-foot .kbw-btn.is-primary'));
        await H.settle(80);
      }
      const allowedOut = await allowedP;
      eq(allowedOut[0].ok, true, '白名单开了 patch_text → 正常执行');
      const denied = await runExpectReject([{ tool: 'patch_text', args: { path: rel, find: '改过', replace: 'x' } }], {
        allowTools: ['search'],
      });
      eq(denied.unexpectedModal, false, '白名单没开不该弹确认框');
      eq(denied.out[0].ok, false, '白名单没开 → 拒');
      contains(String(denied.out[0].summary), '没有开', '如实说"这个能力包没有开"');
      // 收尾：还原 + 删指令集夹具
      if (H.currentUndoButton('撤销')) {
        H.click(H.currentUndoButton('撤销') as Element);
        await H.settle(420);
      }
      H.rmrf(`${vaultRoot}/${KB}/${guardRel}`);
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      sweep();
    });

    await suite.it('rename 全链：真改名（内容逐字节不动）→ 撤销还原原名 · 同名拒 · 撞名不覆盖', async () => {
      sweep();
      const before = '---\n类型: 笔记\n---\n\n正文内容。\n';
      const relOld = await mk('__p722a旧名.md', before);
      // ① 新名和现在的一样 → 拒（不弹确认框）
      const same = await runExpectReject([{ tool: 'rename', args: { path: relOld, name: '__p722a旧名' } }]);
      eq(same.unexpectedModal, false, '同名不该弹确认框');
      eq(same.out[0].ok, false, '同名 → 拒');
      contains(String(same.out[0].summary), '一样', '如实说"和现在的一样"');
      // ② 正常改名
      const { out } = await runWrites([{ tool: 'rename', args: { path: relOld, name: '__p722a新名' } }]);
      eq(out[0].ok, true, `改名成了（实际：${out[0].summary}）`);
      ok(H.exists(vaultRoot, `${KB}/__p722a新名.md`), '新名字在');
      eq(H.exists(vaultRoot, `${KB}/__p722a旧名.md`), false, '旧名字没了');
      eq(H.readNote(vaultRoot, `${KB}/__p722a新名.md`), before, '内容**逐字节**不动（只改名）');
      // ③ 撤销 → 原名还原
      const undo = H.currentUndoButton('撤销');
      ok(undo, '撤销条在（mover 同一条链）');
      H.click(undo as Element);
      await H.settle(420);
      ok(H.exists(vaultRoot, `${KB}/__p722a旧名.md`), '撤销后原名回来了');
      eq(H.readNote(vaultRoot, `${KB}/__p722a旧名.md`), before, '还原逐字节');
      // ④ 撞名（目标名已存在）→ mover 判 skipped，如实报
      await mk('__p722a撞乙.md', '---\ntags: []\n---\n\n另一个不同内容\n');
      const clash = await runWrites([{ tool: 'rename', args: { path: relOld, name: '__p722a撞乙' } }]);
      eq(clash.out[0].ok, false, '撞名 → 没改成');
      eq(H.readNote(vaultRoot, `${KB}/__p722a旧名.md`), before, '原篇一个字节没动');
      contains(clash.confirmText, '同名', '确认框的 warnings 里提前说了撞名');
      sweep();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C · #10 上限（31 动作一步）＋「继续」续跑
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22a · #10 上限与继续', async () => {
    await suite.it('契约常量：一步 30 · search 50 · read 6000（三处同改的代码侧锚点）', () => {
      eq(AI_AGENT_LIMITS.maxCallsPerStep, 30, '一步 30 个动作（P7.22a 放宽）');
      eq(AI_AGENT_LIMITS.searchHits, 50, 'search 回 50 条');
      eq(AI_AGENT_LIMITS.readChars, 6000, 'read 回 6000 字符');
      eq(AI_AGENT_LIMITS.maxSteps, 6, '步数保留 6（"继续"兜没跑完的那一半）');
    });

    await suite.it('31 个动作一步：前 30 **真执行**，第 31 个如实说"只执行了前 30 个"', async () => {
      sweep();
      const rels: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        rels.push(await mk(`__p722a上${String(i).padStart(2, '0')}.md`, `---\ntags: []\n---\n\n第 ${i} 篇\n`));
      }
      const actions = [
        ...rels.map((r) => ({ tool: 'read', args: { path: r } })),
        { tool: 'stats', args: {} },
      ];
      let calls = 0;
      const res = await runAgentLoop({
        messages: [],
        callModel: async () => {
          calls += 1;
          return calls === 1 ? JSON.stringify({ reply: '开干', actions }) : '都看过了，收工。';
        },
        port: makeAiToolPort({ ctx: ctx(), askPending: async (entries) => entries.map(() => true) }),
      });
      /**
       * ⚠️ `steps` 只记**带动作的拍**（终答拍直接收尾、不入账）—— 第一版断言写"两步"
       * 就是这么红的。前提自证改成：一拍动作 + 终答真的收到了（`calls === 2`）。
       */
      eq(res.steps.length, 1, '一拍动作（终答拍不入 steps —— 它的记号是下面的 reply）');
      eq(calls, 2, '模型真的被调了两次（第二拍 = 终答）—— 前提自证');
      eq(res.reply, '都看过了，收工。', '终答收尾');
      const items = res.steps[0].items;
      eq(items.length, 31, '31 条结果都回给了模型（30 执行 + 1 溢出）');
      const ran = items.filter((x) => x.outcome.ok && String(x.outcome.summary).startsWith('读了'));
      eq(ran.length, 30, `**前 30 条真执行**（真读了 30 篇；实际 ${ran.length}）`);
      const over = items[items.length - 1];
      eq(over.outcome.ok, false, '第 31 条没执行');
      contains(String(over.outcome.summary), `只执行了前 ${AI_AGENT_LIMITS.maxCallsPerStep} 个`, '如实说溢出了');
    });

    await suite.it('「继续」续跑：到上限 → 按钮出现 → 点它接着做（面板真链路）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin);
      // 6 步动作（每步一个 search —— 参数不同，不会被"重复调用当场挡"）+ 第 7 拍终答
      const seq: { reply?: string; actions?: { tool: string; args?: Record<string, unknown> }[] }[] = [];
      for (let i = 0; i < AI_AGENT_LIMITS.maxSteps; i += 1) {
        seq.push({ reply: `看第 ${i} 批`, actions: [{ tool: 'search', args: { query: `查${i}` } }] });
      }
      seq.push({ reply: '都看完了，收工。' });
      H.stubAiSeq(seq);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(panel, '面板开出来了');
      const opsOf = (): number => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      /** 问一句并等到"能动手"（与 ai.ts 的 askIn 同款） */
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '开始干活';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      const noteEl = await untilEl(
        () => H.qa<HTMLElement>(panel, '.kbw-ai-note').find((n) => H.textOf(n).includes('步上限')) ?? null,
        12000,
      );
      ok(noteEl, `到上限的收尾如实画出来（前提自证）—— ${AI_AGENT_LIMITS.maxSteps} 步跑满`);
      const contBtn = H.qa<HTMLElement>(panel, '.kbw-ai-acts .kbw-btn').find((b) => H.textOf(b) === '继续');
      ok(contBtn, '「继续」按钮在（把"没跑完"变可续一拍）');
      const opsBefore = opsOf();
      H.click(contBtn as Element);
      ok(await H.until(() => opsOf() > opsBefore, 12000), '点了 → 新一轮真跑起来并收尾');
      const meTexts = H.textsOf(panel, '.kbw-ai-log .kbw-ai-bubble.is-me .kbw-ai-me-text');
      ok(meTexts.some((t) => t.includes('继续')), '新一轮的用户气泡写着「继续」');
      sweep();
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §D · #11 属性 / 标签批改补快照
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22a · #11 属性批改补快照', async () => {
    const port = () =>
      makeAiToolPort({
        ctx: ctx(),
        askPending: async (entries) => entries.map(() => true),
      });
    async function runWrites(
      calls: { tool: string; args: Record<string, unknown> }[],
    ): Promise<{ out: AiToolOutcome[]; confirmText: string }> {
      const p = port().runBatch(calls, {});
      const m = await untilEl(() => H.qa<HTMLElement>(document.body, '.kbw-modal')[0] ?? null, 3000);
      const confirmText = m ? H.textOf(m) : '';
      if (m) {
        H.click(H.q<HTMLElement>(m, '.kbw-modal-foot .kbw-btn.is-primary'));
        await H.settle(80);
      }
      return { out: await p, confirmText };
    }

    await suite.it('AI 改 3 篇属性：写前补快照（确认框如实改口）→ 撤销**逐字节**还原', async () => {
      sweep();
      const head = '---\n类型: 笔记\n状态: 进行中\ntags: []\n---\n\n正文。\n';
      const rels: string[] = [];
      for (const ch of ['甲', '乙', '丙']) rels.push(await mk(`__p722a属${ch}.md`, head));
      const originals = rels.map((r) => H.readNote(vaultRoot, `${KB}/${r}`));
      const { out, confirmText } = await runWrites(
        rels.map((r) => ({ tool: 'set_prop', args: { path: r, key: '状态', value: '已完成' } })),
      );
      ok(out.every((o) => o.ok), `三篇都改了（${out.map((o) => o.summary).join('；')}）`);
      contains(H.readNote(vaultRoot, `${KB}/${rels[0]}`), '已完成', '属性真的写进去了');
      contains(confirmText, '自动快照', '确认框 notes 如实改口（不再写"不进快照"）');
      notContains(confirmText, '不进快照', '旧文案没了');
      const undo = H.currentUndoButton('撤销');
      ok(undo, '撤销条在 —— **这条曾经没有**（#11 补上的就是它）');
      H.click(undo as Element);
      await H.settle(420);
      for (let i = 0; i < rels.length; i += 1) {
        eq(H.readNote(vaultRoot, `${KB}/${rels[i]}`), originals[i], `第 ${i + 1} 篇**逐字节**还原`);
      }
      sweep();
    });

    await suite.it('快照失败 → 属性段**一个字节都不写**（每条如实说，不静默半写）', async () => {
      sweep();
      const head = '---\n类型: 笔记\n状态: 进行中\n---\n\n正文。\n';
      const rel = await mk('__p722a属快败.md', head);
      const before = H.readNote(vaultRoot, `${KB}/${rel}`);
      const snap = ctx().snapshot as unknown as Record<string, unknown>;
      const origCapture = snap.capture;
      snap.capture = (): Promise<never> => Promise.reject(new Error('模拟快照失败'));
      try {
        const { out } = await runWrites([{ tool: 'set_prop', args: { path: rel, key: '状态', value: '已完成' } }]);
        eq(out[0].ok, false, '如实报没执行');
        contains(String(out[0].summary), '快照失败', '说清是快照失败');
        eq(H.readNote(vaultRoot, `${KB}/${rel}`), before, '文件**逐字节**没动');
        eq(H.currentUndoButton('撤销'), null, '没写就没有撤销条');
      } finally {
        snap.capture = origCapture;
        sweep();
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // §E · #13 全权预设（设置页三按钮）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22a · #13 全权预设', async () => {
    await suite.it('三按钮各点一次 → toolTiers 值对 + 当前档明示（保守 = 只读顾问 · 标准 = 默认表 · 全权 = 全自动）', async () => {
      purgeOverlays();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        ctx().openWorkbenchSettings();
        await H.settle(200);
        const tab = H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes('AI 助手'));
        ok(tab, '设置里能找到「AI 助手」栏');
        H.click(tab as HTMLElement);
        await H.settle(200);
        const findRow = (): HTMLElement | undefined =>
          H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) => H.textOf(r).includes('整档预设'));
        ok(findRow(), '「权限」组里有「整档预设」行');
        const clickPreset = async (label: string): Promise<void> => {
          const row = findRow();
          ok(row, '行还在（每次重查 —— 预设点了会整页重画）');
          const b = H.qa<HTMLElement>(row as HTMLElement, '.kbw-btn').find((x) => H.textOf(x) === label);
          ok(b, `找得到「${label}」`);
          H.click(b as Element);
          await H.settle(250);
        };
        const tiers = (): Record<string, string> => ({ ...(ctx().settings.get().ai.toolTiers ?? {}) });

        await clickPreset('全权');
        deepEq(
          tiers(),
          { read: 'auto', prop: 'auto', tag: 'auto', create: 'auto', move: 'auto', delete: 'auto', text: 'auto' },
          '全权 = 七类全自动（显式写全）',
        );
        contains(H.textOf(findRow()), '当前：全权', '当前档明示');

        await clickPreset('保守');
        deepEq(
          tiers(),
          { read: 'auto', prop: 'off', tag: 'off', create: 'off', move: 'off', delete: 'off', text: 'off' },
          '保守 = 只读顾问（写类全禁）',
        );
        contains(H.textOf(findRow()), '当前：保守', '当前档明示');

        await clickPreset('标准');
        /**
         * ⚠️ **直接对 `DEFAULT_TOOL_TIERS` 比对**（独立审 🟡4 的配套）：手抄一份字面量
         * 就是第二份真源 —— 断言与实现（`{ ...DEFAULT_TOOL_TIERS }`）同源，"标准恒等于默认表"
         * 这条口径才真的被钉住（改默认表忘改预设 → 这里当场红）。
         */
        deepEq(tiers(), { ...DEFAULT_TOOL_TIERS }, '标准 = 今天的默认表（与真源逐键对齐）');
        contains(H.textOf(findRow()), '当前：标准', '当前档明示');

        /** 手动改一类 → 当前档变为"自定义"（明示口径：对不上任何预设就说自定义） */
        await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: { ...tiers(), text: 'auto' } } });
        ctx().openWorkbenchSettings();
        await H.settle(200);
        const tab2 = H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes('AI 助手'));
        H.click(tab2 as HTMLElement);
        await H.settle(200);
        contains(H.textOf(findRow()), '当前：自定义', '手动改过 → 自定义');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        purgeOverlays();
      }
    });
  });
}
