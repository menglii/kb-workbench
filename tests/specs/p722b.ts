/**
 * spec：**P7.22b · 段二（集成与自定义）**（2026-10-11）—— #2 服务族 · #3 提示词覆写（附加层）·
 * #4 Anthropic 原生传输 · #5 任务级模型 + 单价表多条
 *
 * 判据草案来自开工提示词 §1（逐条落）：
 *  · #2：离线（打开即停：面板真开 + 本轮循环优雅结束；同批其它动作照常走各自的门）；
 *  · #3：注入顺序（附加层落在能力包那一段后）+ 预算截断（超限截断**如实**）+ 任务隔离；
 *  · #4：离线假传输层（Messages API 请求体形状 / headers / 响应解析 / 错误映射 / 流式 SSE /
 *    降级路径照旧）—— 真机一条（**暂无 key，如实记"未验成"**，在交接里）；
 *  · #5：设置读写（迁移/夹取）+ 分派判据（两个任务各自请求体里 model 不同 + 费用按各自单价算）。
 *
 * ⚠️ #2 的真机那一条在 `scripts/probe.mjs` 的 `P7.24 · 服务族 L2` 步（P7.22b 的旧步已随 L2 替换）。
 * 🔴 离线绝不联网：面板链路全走 `H.stubAiSeq`（桩的 `requestUrl` 默认抛）；
 *    #4 一律注入假 requestUrl / 假 fetch（生产路径只有 `httpTransport()` 那一次接线）。
 */
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, notContains, ok } from '../framework';
import * as H from '../helpers';
import { normalizeSettings, type AiSettings } from '../../src/core/settings';
import { purgeOverlays } from '../../src/ui/panel';
import {
  AI_LIMITS,
  AI_TOOL_CLASS_OF,
  AiError,
  clipTaskPrompt,
  migrateSession,
  modelOf,
  priceFor,
  runAgentLoop,
  usageLine,
  usageLineFor,
  validateCall,
  type AiSkill,
} from '../../src/services/ai';
import {
  ANTHROPIC_FALLBACK_MAX_TOKENS,
  httpTransport,
  type AiChatRequest,
} from '../../src/services/ai/transport';
import { makeAiToolPort } from '../../src/ui/ai-tools';

const KB = '01_新知识库';

/** 一条 SSE `data:` 行（anthropic 的形状：event 行 + data 行） */
function anthSse(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 假 fetch：把 `chunks` 原样逐块喂进 body（照 `p73a.ts` 的 `sseFetch` 抄的形状）。
 * `calls` 记每次调用的 url 与 init（断言 headers / body 要用）。
 */
function sseFetch(
  chunks: string[],
  status = 200,
): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const enc = new TextEncoder();
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const stream = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(stream, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 假 requestUrl：记下参数、回一段给定的整包（`requestUrl` 的形状：{status,text,json,headers}） */
function fakeRequestUrl(
  make: (p: { url: string; headers?: Record<string, string>; body?: string }) => {
    status: number;
    payload: unknown;
  },
): { impl: never; calls: { url: string; headers?: Record<string, string>; body?: string }[] } {
  const calls: { url: string; headers?: Record<string, string>; body?: string }[] = [];
  const impl = (async (p: { url: string; headers?: Record<string, string>; body?: string }) => {
    calls.push(p);
    const { status, payload } = make(p);
    return { status, text: JSON.stringify(payload), json: payload, headers: {} };
  }) as never;
  return { impl, calls };
}

export async function specP722b(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 造一篇笔记（本轮的 `__p722b*` 夹具）+ 索引跟上（与 p722a 的 mk 同款） */
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

  const port = (opts: { scopeDir?: string; allowTools?: string[] | null } = {}) =>
    makeAiToolPort({
      ctx: ctx(),
      askPending: async (entries) => entries.map(() => true),
      allowTools: (opts.allowTools ?? null) as never,
      scopeDir: opts.scopeDir,
    });

  /** 面板在不在（面板 modal 的 body 类名；`openSuggestPanel` 给 body 打 `kbw-suggest`） */
  const suggestOpen = (): boolean => H.qa(document.body, '.kbw-suggest').length > 0;

  // ════════════════════════════════════════════════════════════
  // §A · #2 服务族 **L2**（suggest / triage / cleanup）—— 跑到确认卡（P7.24 · #9/G11 改口径）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22b · #2 服务族（L2：跑到确认卡）', async () => {
    /**
     * 可见的那张确认卡（幕后面板**挂在 DOM 里**但 backdrop 带 `kbw-offstage` ——
     * 找"没贴幕后类"的 backdrop 里最后一张 modal = 确认卡）。
     */
    const confirmCard = (): HTMLElement | null => {
      const cards = H.qa<HTMLElement>(document.body, '.kbw-backdrop:not(.kbw-offstage) .kbw-modal');
      return cards.length > 0 ? (cards[cards.length - 1] as HTMLElement) : null;
    };
    /** 等卡 → 点「取消」或主按钮（危险卡主按钮要点两下：上膛 → 再点一次确认） */
    async function answerCard(action: 'primary' | 'cancel', twice = false): Promise<boolean> {
      const up = await H.until(() => confirmCard() != null, 6000);
      if (!up) return false;
      const clickOnce = async (): Promise<boolean> => {
        const card = confirmCard();
        if (!card) return false;
        const btns = H.qa<HTMLElement>(card, '.kbw-modal-foot .kbw-btn');
        const b =
          action === 'cancel'
            ? btns.find((x) => H.textOf(x).trim() === '取消')
            : // 危险卡的主按钮是 .is-danger（confirm.ts:188）、普通卡是 .is-primary —— 两个都认
              btns.find((x) => x.classList.contains('is-primary') || x.classList.contains('is-danger'));
        if (!b) return false;
        H.click(b);
        await H.settle(150);
        return true;
      };
      if (!(await clickOnce())) return false;
      if (action === 'primary' && twice) await clickOnce();
      return true;
    }
    /** 配 AI + 造一条**确定性的**分诊提案（假模型 JSON：把夹具搬去 02_Areas/灵感杂记） */
    const seedRow = '00_Inbox/__p722b卡.md';
    async function aiWithOneMove(): Promise<void> {
      await mk(seedRow, '---\ntags: []\n---\n\n正文\n');
      H.resetAi();
      await H.configAi(plugin);
      H.stubAiSeq([
        { reply: '分诊看完了', ideas: [{ path: seedRow, to: '02_Areas/灵感杂记', why: '用例' }] },
      ]);
    }

    await suite.it('三个新工具：形状校验 + 归「读·搜」类 + 自我授权字段照旧门口丢掉', () => {
      eq(AI_TOOL_CLASS_OF.suggest, 'read', 'suggest 归读·搜（跑管线零写库——写都在确认卡之后）');
      eq(AI_TOOL_CLASS_OF.triage, 'read', 'triage 归读·搜');
      eq(AI_TOOL_CLASS_OF.cleanup, 'read', 'cleanup 归读·搜');
      eq(validateCall({ tool: 'suggest', args: {} }).ok, true, 'suggest 无参过');
      eq(validateCall({ tool: 'cleanup', args: { force: true } }).ok, true, '塞 force 的正常调用照过');
      const junk = validateCall({ tool: 'cleanup', args: { force: true } });
      if (junk.ok) eq('force' in junk.call.args, false, '`force` 在门口丢掉（模型不能自我授权）');
      /**
       * 🔴2（独立审）：cleanup 的 `keys`/`feet` 必须**真的过门**（第一版被"无参"分支吞掉，
       * 文档承诺与实现互相打架）；清洗口径与 set_tags 同款（去空/去重/截断），缺省保持"没给"。
       */
      // 清洗口径 = `cleanList`（与 set_tags 同源）：去重 / 去空 / null 剔；数字按既有语义字符串化
      const kept = validateCall({ tool: 'cleanup', args: { keys: ['类型', '类型', '', null], feet: true } });
      ok(kept.ok, 'cleanup 带 keys/feet 过');
      if (kept.ok) {
        deepEq(kept.call.args.keys, ['类型'], 'keys 过门且被清洗（去重/去空/null 剔 —— cleanList 同款）');
        eq(kept.call.args.feet, true, 'feet:true 保留');
      }
      const bare = validateCall({ tool: 'cleanup', args: {} });
      ok(bare.ok, 'cleanup 无参过');
      if (bare.ok) eq('keys' in bare.call.args, false, '缺省保持"没给"（执行体按"全部可清的键"走）');
      const feetJunk = validateCall({ tool: 'cleanup', args: { feet: 'yes' } });
      if (feetJunk.ok) eq(feetJunk.call.args.feet, false, "feet 只认严格 true（'yes' → false）");
      eq(validateCall({ tool: 'triage', args: {} }).ok, true, 'triage 不带 dir 过（= 工作目录 / 整个库）');
      eq(validateCall({ tool: 'triage', args: { dir: '00_Inbox' } }).ok, true, 'triage 带合法 dir 过');
      eq(validateCall({ tool: 'triage', args: { dir: '../跑路' } }).ok, false, 'triage 的 dir 带 .. → 拒');
      eq(validateCall({ tool: 'triage', args: { dir: '/绝对' } }).ok, false, 'triage 的 dir 绝对路径 → 拒');
    });

    await suite.it('suggest：未配 AI → 如实"没跑成"（不弹卡）；面板只挂不显（幕后）', async () => {
      sweep();
      H.resetAi();
      const out = await port().runBatch([{ tool: 'suggest', args: {} }], {});
      eq(out[0].ok, true, '没配 AI 不是错误（如实回执）');
      eq(out[0].settled, undefined, '没跑成 = 不带 settled 标记（那是"用户表过态"的专用位）');
      contains(String(out[0].summary), '没跑成', '如实说没跑成');
      eq(confirmCard(), null, '没得跑就不弹卡');
      ok(!suggestOpen(), '幕后面板跑完即关（含"没跑成"—— 用户连一闪都不该看见）');
      sweep();
    });

    await suite.it('suggest L2：跑到确认卡 · 幕后（面板不可见）· 取消 = 零字节（D3 如实回）', async () => {
      sweep();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        await aiWithOneMove();
        const before = ctx().index.notes().length;
        const p = port().runBatch([{ tool: 'suggest', args: {} }], {});
        const up = await H.until(() => confirmCard() != null, 8000);
        ok(up, '确认卡到（跑到卡前停下）');
        ok(
          suggestOpen() && H.q(document.body, '.kbw-backdrop.kbw-offstage') != null,
          '幕后：面板挂在 DOM 里、backdrop 贴了 kbw-offstage（用户只该看见确认卡）',
        );
        ok(await answerCard('cancel'), '点「取消」');
        const out = await p;
        eq(out[0].settled, 'cancelled', '结算 = 已取消（D3）');
        contains(String(out[0].summary), '取消', '如实回"用户取消了"');
        eq(ctx().index.notes().length, before, '取消 = 零字节（负向判据）');
        ok(await H.until(() => !suggestOpen(), 2000), '结算后幕后面板自关');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
        sweep();
      }
    });

    await suite.it('suggest L2：执行路 —— 确认卡执行 → 真搬（mover 链）→ 撤销逐字节还原', async () => {
      sweep();
      const aiWas = { ...ctx().settings.get().ai };
      const src = `${KB}/${seedRow}`;
      const text = H.readNote(vaultRoot, src);
      try {
        await aiWithOneMove();
        const p = port().runBatch([{ tool: 'suggest', args: {} }], {});
        ok(await answerCard('primary'), '确认卡上点主按钮（执行这 N 项）');
        const out = await p;
        eq(out[0].settled, 'executed', '结算 = 已执行');
        contains(String(out[0].summary), '已执行', '摘要如实');
        // 🟡5（独立审）：前缀只许加一层（第一版 "已执行：已执行：…"）
        ok(!String(out[0].summary).includes('已执行：已执行'), '前缀不叠（PipeSettle 不带前缀、可见前缀由 ai-tools 统一加）');
        ok(await H.until(() => !H.exists(vaultRoot, src), 3000), '真搬：原路径不在了（mover 链）');
        ok(H.exists(vaultRoot, `${KB}/02_Areas/灵感杂记/__p722b卡.md`), '落点是假模型给的那个目录');
        // 撤销逐字节还原
        const un = H.currentUndoButton('撤销');
        ok(un, '撤销条在');
        H.click(un as Element);
        ok(await H.until(() => H.exists(vaultRoot, src), 4000), '撤销把文件放回原路径');
        eq(H.readNote(vaultRoot, src), text, '逐字节还原');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
        sweep();
        H.rmrf(path.join(vaultRoot, KB, '02_Areas/灵感杂记/__p722b卡.md'));
        H.rmrf(path.join(vaultRoot, KB, src));
        app.vault.rescan();
        await H.settleIndex(app);
      }
    });

    await suite.it('suggest **不吃工作目录**（独立审 Y-2 的回归，L2 照旧）：范围 seg 仍停在「全库」', async () => {
      sweep();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        await aiWithOneMove();
        const p = port({ scopeDir: '02_Areas' }).runBatch([{ tool: 'suggest', args: {} }], {});
        const up = await H.until(() => confirmCard() != null, 8000);
        ok(up, '确认卡到');
        ok(suggestOpen(), '面板照挂');
        const onSeg = H.qa<HTMLElement>(document.body, '.kbw-suggest .kbw-segbtn').filter((b) =>
          b.classList.contains('is-on'),
        );
        eq(onSeg.length, 1, '恰好一枚 seg 亮着（不是"两枚都不亮"的怪态）');
        eq(onSeg[0] ? H.textOf(onSeg[0]) : '', '全库', '亮的是「全库」—— suggest 没被 workDir 静默收窄');
        await answerCard('cancel');
        await p;
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
        sweep();
      }
    });

    await suite.it('会话往返：stopped=handoff 存读保留（**老会话读盘兼容**，L2 起不再产生）；未知值收敛成 undefined', () => {
      const mkTurn = (stopped: unknown): unknown => ({
        question: 'q',
        kind: 'agent',
        reply: 'r',
        plan: { rows: [], blocked: [] },
        proposed: 0,
        dropped: 0,
        stopped,
      });
      const s1 = migrateSession({ id: 's1', turns: [mkTurn('handoff')] });
      eq(s1?.turns[0]?.stopped, 'handoff', '「handoff」原样读回（P7.22b 时代的老会话）');
      const s2 = migrateSession({ id: 's2', turns: [mkTurn('随便什么')] });
      eq(s2?.turns[0]?.stopped, undefined, '未知值 → 收敛成不带（不猜）');
      const s3 = migrateSession({ id: 's3', turns: [mkTurn('limit')] });
      eq(s3?.turns[0]?.stopped, 'limit', '老值照旧（前提自证）');
    });

    await suite.it('cleanup L2：跑到确认卡（键类全预勾，D2）· 取消 = 零字节 · 夹具逐字节自证', async () => {
      sweep();
      const note = '00_Inbox/__p722b清.md';
      const text = '---\n类型: 想法\ntags:\n  - 用例\n创建日期: 2026-10-11\n---\n\n正文\n';
      await mk(note, text);
      const before = ctx().index.notes().length;
      const p = port().runBatch([{ tool: 'cleanup', args: {} }], {});
      const up = await H.until(() => confirmCard() != null, 8000);
      ok(up, '确认卡到（扫完 → 预勾 → 停在卡前）');
      const cardText = up ? H.textOf(confirmCard() as HTMLElement) : '';
      contains(cardText, '即将清理', '卡是「清理」那张（各管线自己那张）');
      ok(await answerCard('cancel'), '点「取消」');
      const out = await p;
      eq(out[0].settled, 'cancelled', '结算 = 已取消');
      eq(ctx().index.notes().length, before, '取消 = 零字节');
      eq(H.readNote(vaultRoot, `${KB}/${note}`), text, '夹具字节未动（逐字节）');
      H.rmrf(path.join(vaultRoot, KB, note));
      app.vault.rescan();
      await H.settleIndex(app);
      sweep();
    });

    await suite.it('cleanup L2：执行路 —— 危险卡两段确认 → 真删键 → 撤销还原（settled=executed）', async () => {
      sweep();
      const note = '00_Inbox/__p722b清.md';
      const text = '---\n类型: 想法\ntags:\n  - 用例\n创建日期: 2026-10-11\n---\n\n正文\n';
      await mk(note, text);
      const p = port().runBatch([{ tool: 'cleanup', args: { keys: ['类型'] } }], {});
      ok(await answerCard('primary', true), '危险卡：主按钮点两下（上膛 → 再点一次确认）');
      const out = await p;
      eq(out[0].settled, 'executed', '结算 = 已执行');
      contains(String(out[0].summary), '已执行', '摘要如实');
      ok(
        await H.until(() => !H.readNote(vaultRoot, `${KB}/${note}`).includes('类型'), 3000),
        '那篇的「类型」键真删了',
      );
      const un = H.currentUndoButton('撤销');
      ok(un, '撤销条在');
      H.click(un as Element);
      ok(
        await H.until(() => H.readNote(vaultRoot, `${KB}/${note}`).includes('类型'), 4000),
        '撤销把键还原回来',
      );
      // 收场：删夹具
      H.rmrf(path.join(vaultRoot, KB, note));
      app.vault.rescan();
      await H.settleIndex(app);
      sweep();
    });

    await suite.it('triage L2：AI 分诊真跑（模型被调过）→ 到确认卡 → 取消', async () => {
      sweep();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        await mk(seedRow, '---\ntags: []\n---\n\n正文\n');
        H.resetAi();
        await H.configAi(plugin);
        const seq = H.stubAiSeq([
          { reply: '分诊看完了', ideas: [{ path: seedRow, to: '02_Areas/灵感杂记', why: '用例' }] },
        ]);
        const p = port().runBatch([{ tool: 'triage', args: {} }], {});
        ok(
          await H.until(() => seq.calls.length >= 1, 4000),
          'autoAi 那一跳真跑了 —— triage 与 suggest 的区别就在这',
        );
        // 🔴1（独立审）：分诊**只许跑一遍**（第一版 autoAi 跳完又跑一遍，费用翻倍 + 提案被覆盖）
        await H.settle(250);
        eq(seq.calls.length, 1, '分诊只被调一次（runAuto 不再重复跑 classify —— 独立审 🔴1 的验收）');
        ok(await answerCard('cancel'), '到确认卡 → 取消');
        const out = await p;
        eq(out[0].settled, 'cancelled', '结算 = 已取消');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
        sweep();
      }
    });

    await suite.it('triage 的 dir 走工作目录收窄：库里没有的目录 / 越界目录 → 拒（不弹卡）', async () => {
      sweep();
      const missing = await port().runBatch([{ tool: 'triage', args: { dir: '__p722b没有这目录' } }], {});
      eq(missing[0].ok, false, '库里没有的目录 → 拒');
      contains(String(missing[0].summary), '没有', '如实说目录不存在');
      eq(suggestOpen(), false, '拒了就不许开面板（也不许留悬着的卡）');
      const scoped = port({ scopeDir: '00_Inbox' });
      const outside = await scoped.runBatch([{ tool: 'triage', args: { dir: '02_Areas' } }], {});
      eq(outside[0].ok, false, '越界目录 → 拒');
      contains(String(outside[0].summary), '工作目录', '如实说越界（限定在哪）');
      eq(suggestOpen(), false, '越界了也不许开面板');
      sweep();
    });

    await suite.it('🔴 L2 全链：runAgentLoop 里 service tool 跑到卡前 →（点取消）→ 循环**继续**（旧"打开即停"退役）', async () => {
      sweep();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        await aiWithOneMove();
        let calls = 0;
        const p = runAgentLoop({
          messages: [],
          callModel: async () => {
            calls += 1;
            // 第二拍是"循环继续了"的证据 —— P7.22b 时代它叫"不该被叫到的哨兵"，L2 里它**该**被叫到
            return calls === 1
              ? JSON.stringify({
                  reply: '我先读一下，再跑一趟整理。',
                  actions: [
                    { tool: 'read', args: { path: seedRow } },
                    { tool: 'suggest', args: {} },
                  ],
                })
              : JSON.stringify({ reply: '收到结果，收工。', actions: [] });
          },
          port: makeAiToolPort({ ctx: ctx(), askPending: async (entries) => entries.map(() => true) }),
        });
        // 卡到 → 点取消 → 循环应继续
        ok(await answerCard('cancel'), '确认卡到（循环挂在卡上等用户）');
        const res = await p;
        eq(res.stopped, 'done', 'L2：循环不再"打开即停"——取消之后接着跑完了（stopped=done）');
        eq(calls, 2, '模型被调了两次（第二拍 = 循环继续的证据）');
        const items = res.steps[0].items;
        eq(items.length, 2, '两条都有结果（同批的动作一个不落）');
        ok(items[0].outcome.ok, `同一批里的 read 照常执行（实际：${items[0].outcome.summary}）`);
        ok(String(items[0].outcome.summary).startsWith('读了'), 'read 真读了（不是跳过）');
        eq(items[1].outcome.settled, 'cancelled', 'suggest 那条带 settled=cancelled（用户点了取消）');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
        sweep();
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B · #3 AI 提示词附加层（06_工作台/AI提示词/<任务id>.md）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22b · #3 AI 提示词附加层', async () => {
    const noteDir = (): string => `${ctx().settings.workbenchDir()}/AI提示词`;

    /** 写一份附加层文件（adapter 直写 —— 那条链读的就是 adapter；用完自己删） */
    async function writeNoteFile(id: string, text: string): Promise<string> {
      const dir = noteDir();
      await app.vault.adapter.mkdir(dir);
      const p = `${dir}/${id}.md`;
      await app.vault.adapter.write(p, text);
      return p;
    }

    /** 跑一次 titles 任务、取回真发出去的 system 文本（假 key + 假回话，跑完原样还回去） */
    async function systemOfTitles(rel: string, skill?: AiSkill | null): Promise<string> {
      H.resetAi();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        await H.configAi(plugin);
        const seq = H.stubAiSeq([{ reply: '看完了' }]);
        await ctx().ai.proposeTitles({ notes: [rel], skill: skill ?? null });
        const body = JSON.parse(seq.calls[0]?.body ?? '{}') as {
          messages?: { role: string; content: string }[];
        };
        return body.messages?.find((m) => m.role === 'system')?.content ?? '';
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
      }
    }

    await suite.it('clipTaskPrompt 纯函数：未超限原样（trim）· 超限截断 + **如实带一句**', () => {
      const plain = clipTaskPrompt('  写短一点。  ');
      eq(plain.text, '写短一点。', '首尾空白修掉（其余原样）');
      eq(plain.truncated, false, '没超限');
      eq(clipTaskPrompt('   ').text, '', '全空白 = 空（调用方当"没写"）');
      const long = '甲'.repeat(AI_LIMITS.taskNoteChars + 40);
      const clipped = clipTaskPrompt(long);
      eq(clipped.truncated, true, '超限 → truncated');
      ok(clipped.text.startsWith('甲'.repeat(AI_LIMITS.taskNoteChars)), '保留的是前 6000 字');
      const tail = clipped.text.slice(AI_LIMITS.taskNoteChars);
      notContains(tail.slice(0, 50), '甲', '超出部分**不带**（只留那句注）');
      contains(clipped.text, `前 ${AI_LIMITS.taskNoteChars} 字`, '如实带一句"只带了前 6000 字"');
    });

    await suite.it('注入顺序：附加层落在能力包那一段后、输出格式之前；硬规矩段原样在内', async () => {
      sweep();
      const rel = await mk('__p722b附加靶.md', '---\ntags: []\n---\n\n正文\n');
      const notePath = await writeNoteFile('titles', 'NOTE_ONLY_MARK：标题里不要用书名号。');
      try {
        const skill: AiSkill = {
          path: '(内联)',
          name: '__p722b样',
          triggers: [],
          tools: null,
          params: [],
          workDir: '',
          examples: [],
          instructions: 'SKILL_ONLY_MARK：这一轮只给名。',
        };
        const system = await systemOfTitles(rel, skill);
        contains(system, 'NOTE_ONLY_MARK', '附加层进了 system');
        contains(system, 'SKILL_ONLY_MARK', '能力包也进了 system（前提自证）');
        const iSkill = system.indexOf('SKILL_ONLY_MARK');
        const iNote = system.indexOf('NOTE_ONLY_MARK');
        const iFormat = system.indexOf('## 输出格式');
        ok(iSkill >= 0 && iNote >= 0 && iFormat >= 0, '三段都在（前提自证）');
        ok(iNote > iSkill, '附加层落在能力包**之后**');
        ok(iNote < iFormat, '附加层落在输出格式**之前**');
        contains(system, '## 硬规矩', '硬规矩段原样在内（只做加法 —— 用户文件动不了它）');
      } finally {
        await app.vault.adapter.remove(notePath);
        sweep();
      }
    });

    await suite.it('预算截断（端到端）：超 6000 字 → system 里只有前 6000 字 + 一句如实说明', async () => {
      sweep();
      const rel = await mk('__p722b截断靶.md', '---\ntags: []\n---\n\n正文\n');
      const keep = '起'.repeat(AI_LIMITS.taskNoteChars);
      const notePath = await writeNoteFile('titles', `${keep}尾标记ZZZ`);
      try {
        const system = await systemOfTitles(rel);
        contains(system, keep, '前 6000 字**真进去了**（产物规模，不只验提示语）');
        notContains(system, '尾标记ZZZ', '第 6001 字起没带（真截了）');
        contains(system, `前 ${AI_LIMITS.taskNoteChars} 字`, '一句如实说明在');
      } finally {
        await app.vault.adapter.remove(notePath);
        sweep();
      }
    });

    await suite.it('文件不在 = 一个字都不进；文件名认任务 id（links 的不会跑进 titles）', async () => {
      sweep();
      const rel = await mk('__p722b隔离靶.md', '---\ntags: []\n---\n\n正文\n');
      const linksPath = await writeNoteFile('links', 'LINKSONLY_MARK：只属于修链的附加要求。');
      try {
        const system = await systemOfTitles(rel);
        notContains(system, '用户附加要求', 'titles 没有附加层文件 → 一个字都不进（行为与从前逐字一致）');
        notContains(system, 'LINKSONLY_MARK', 'links 的文件**不会**跑进 titles（文件名 = 任务 id）');
      } finally {
        await app.vault.adapter.remove(linksPath);
        sweep();
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C · #4 Anthropic 原生传输（离线假传输层）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22b · #4 Anthropic 原生传输', async () => {
    const REQ: AiChatRequest = {
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-x',
      apiKey: 'sk-ant',
      protocol: 'anthropic',
      messages: [
        { role: 'system', content: 'SYS_ONLY_MARK' },
        { role: 'user', content: 'hi' },
      ],
    };

    await suite.it('chat 请求形状：URL / 头 / system 块 + cache_control / max_tokens 兜底 / system 不进 messages', async () => {
      const fake = fakeRequestUrl(() => ({
        status: 200,
        payload: { content: [{ type: 'text', text: '好的' }], usage: { input_tokens: 12, output_tokens: 3 } },
      }));
      const tr = httpTransport({ requestUrl: fake.impl, fetchImpl: null });
      const out = await tr.chat(REQ, {});
      eq(out.text, '好的', '文本从 content 的 text 块里取');
      eq(out.usage?.promptTokens, 12, 'anthropic 的 input_tokens → promptTokens');
      eq(out.usage?.completionTokens, 3, 'output_tokens → completionTokens');
      const seen = fake.calls[0];
      eq(seen.url, 'https://api.anthropic.com/v1/messages', 'URL 是 Messages API 那条');
      eq(seen.headers?.['x-api-key'], 'sk-ant', 'key 走 x-api-key 头');
      eq(seen.headers?.['anthropic-version'], '2023-06-01', 'anthropic-version 头在');
      const body = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
      const sys = body.system as { type: string; text: string; cache_control: { type: string } }[];
      eq(sys?.[0]?.text, 'SYS_ONLY_MARK', 'system 单独拎进 system 参数');
      eq(sys?.[0]?.cache_control?.type, 'ephemeral', 'prompt caching：cache_control 挂在 system 块上');
      deepEq(body.messages, [{ role: 'user', content: 'hi' }], 'system 不在 messages 里（只有 user/assistant）');
      eq(body.max_tokens, ANTHROPIC_FALLBACK_MAX_TOKENS, 'maxTokens 缺省 → 必填字段兜底（别漏成 400）');
      eq(body.temperature, 0, '不传 = 0');
    });

    await suite.it('参数口径：maxTokens 有值照发 · temperature 夹到 1 · baseURL 带 /v1 也认', async () => {
      const fake = fakeRequestUrl(() => ({
        status: 200,
        payload: { content: [{ type: 'text', text: 'ok' }] },
      }));
      const tr = httpTransport({ requestUrl: fake.impl, fetchImpl: null });
      await tr.chat({ ...REQ, baseUrl: 'https://relay.test/anthropic/v1', maxTokens: 321, temperature: 2 }, {});
      const seen = fake.calls[0];
      eq(seen.url, 'https://relay.test/anthropic/v1/messages', '结尾 /v1 认（不拼成 /v1/v1/messages）');
      const body = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
      eq(body.max_tokens, 321, 'maxTokens 有值就照发');
      eq(body.temperature, 1, 'temperature 2 → 夹到 1（anthropic 上限）');
      await tr.chat({ ...REQ, baseUrl: 'https://api.anthropic.com/' }, {});
      eq(fake.calls[1].url, 'https://api.anthropic.com/v1/messages', '结尾斜杠归一');
      // 顺手把**整条 endpoint** 粘进来也认（独立审 🟢3：不剥会拼成 …/messages/v1/messages → 404）
      await tr.chat({ ...REQ, baseUrl: 'https://api.anthropic.com/v1/messages' }, {});
      eq(fake.calls[2].url, 'https://api.anthropic.com/v1/messages', '整条 endpoint 粘进来也认');
    });

    await suite.it('响应解析与错误映射：只收 text 块 · 401→auth · 529→server（同一套 kind）', async () => {
      const mixed = fakeRequestUrl(() => ({
        status: 200,
        payload: {
          content: [
            { type: 'text', text: '甲' },
            { type: 'tool_use', id: 'x', name: 'y', input: {} },
            { type: 'text', text: '乙' },
          ],
        },
      }));
      const tr1 = httpTransport({ requestUrl: mixed.impl, fetchImpl: null });
      const out = await tr1.chat(REQ, {});
      eq(out.text, '甲乙', '只拼 text 块（tool_use 那类不是给用户看的话）');

      const auth = fakeRequestUrl(() => ({ status: 401, payload: { error: { message: 'bad key' } } }));
      const tr2 = httpTransport({ requestUrl: auth.impl, fetchImpl: null });
      let err: unknown = null;
      try {
        await tr2.chat(REQ, {});
      } catch (e) {
        err = e;
      }
      ok(err instanceof AiError && err.kind === 'auth', '401 → auth（与 OpenAI 路同一套 kind）');
      ok(err instanceof AiError && !String(err.message).includes('sk-ant'), 'key 不进错误信息（五条纪律之一）');

      const over = fakeRequestUrl(() => ({ status: 529, payload: { error: { message: 'overloaded' } } }));
      const tr3 = httpTransport({ requestUrl: over.impl, fetchImpl: null });
      let err3: unknown = null;
      try {
        await tr3.chat(REQ, {});
      } catch (e) {
        err3 = e;
      }
      ok(err3 instanceof AiError && err3.kind === 'server', '529（overloaded）→ server 类');
    });

    await suite.it('流式（fetch + SSE）：content_block_delta 出增量 · usage 从 message_start/message_delta 收 · 请求体无 stream_options', async () => {
      const { impl, calls } = sseFetch([
        anthSse('message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } }),
        anthSse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }),
        anthSse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }),
        anthSse('message_delta', { type: 'message_delta', usage: { output_tokens: 5 } }),
        anthSse('message_stop', { type: 'message_stop' }),
      ]);
      const tr = httpTransport({ fetchImpl: impl });
      const deltas: string[] = [];
      const out = await tr.stream!(REQ, { onDelta: (d: string) => deltas.push(d) });
      eq(out.text, '你好', '全文拼对');
      deepEq(deltas, ['你', '好'], '增量按到达顺序吐出（message_start / message_stop 那些不吐）');
      eq(out.usage?.promptTokens, 7, 'usage.input_tokens 收进来了');
      eq(out.usage?.completionTokens, 5, 'usage.output_tokens 收进来了');
      const seen = calls[0];
      eq(seen.url, 'https://api.anthropic.com/v1/messages', '流式走同一条 URL');
      const headers = seen.init.headers as Record<string, string>;
      eq(
        headers['anthropic-dangerous-direct-browser-access'],
        'true',
        'fetch 路带浏览器直连头（官方 CORS 要求）',
      );
      const body = JSON.parse(String(seen.init.body)) as Record<string, unknown>;
      eq(body.stream, true, 'stream:true');
      eq('stream_options' in body, false, 'anthropic 没有 stream_options 这个字段（别把 OpenAI 那套抄过来）');
    });

    await suite.it('「测试连接」按**当前选的协议**发（协议随请求透传）· 默认还是 openai', async () => {
      const aiWas = { ...ctx().settings.get().ai };
      const seen: { protocol?: string }[] = [];
      try {
        ctx().ai.transport = {
          chat: async (req) => {
            seen.push({ protocol: req.protocol });
            return { text: 'hi' };
          },
        };
        await H.configAi(plugin, { protocol: 'anthropic' });
        const r1 = await ctx().ai.testConnection();
        eq(r1.ok, true, '假传输层连上了');
        eq(seen[0]?.protocol, 'anthropic', '按当前协议（anthropic）发');
        await H.configAi(plugin, { protocol: 'openai' });
        await ctx().ai.testConnection();
        eq(seen[1]?.protocol, 'openai', '切回 openai 也照发');
        // 缺省（老配置没有这个键）= openai —— normalize 会给默认值，这里直接看默认表
        eq(normalizeSettings({}).ai.protocol, 'openai', '没配过 → 默认 openai（现状零变化）');
      } finally {
        ctx().ai.transport = ctx().ai.http;
        await ctx().settings.save({ ai: { ...aiWas } });
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // §D · #5 任务级模型 + 单价表多条
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.22b · #5 任务级模型与单价', async () => {
    await suite.it('设置夹取：protocol 只认两个字面量 · taskModels 只收非空串值 · modelPrices 逐条夹取', () => {
      const norm = normalizeSettings({
        ai: {
          protocol: 'ANTHROPIC',
          taskModels: { ask: 'm1', b: '  ', c: 7, d: 'x'.repeat(500) },
          modelPrices: [
            { model: 'm1', priceIn: -3, priceOut: 2 },
            { model: ' ', priceIn: 1, priceOut: 1 },
            '不是对象',
            { model: 'm2', priceIn: 1e9, priceOut: '8' },
          ],
        },
      });
      eq(norm.ai.protocol, 'openai', 'protocol 大小写不认 → 落回默认（手改塞别的值一律当没写）');
      deepEq(norm.ai.taskModels, { ask: 'm1' }, 'taskModels：空串 / 非字符串 / 超长值全丢，好的留下');
      deepEq(
        norm.ai.modelPrices,
        [
          { model: 'm1', priceIn: 0, priceOut: 2 },
          { model: 'm2', priceIn: 100_000, priceOut: 0 },
        ],
        'modelPrices：负夹 0 / 天文夹顶 / 字符串值判丢 / 空名与非对象丢弃',
      );
    });

    await suite.it('modelOf / priceFor / usageLineFor 纯函数：命中用映射，没命中回落', () => {
      const cfg = {
        model: 'M',
        taskModels: { titles: 'T' },
        modelPrices: [{ model: 'T', priceIn: 1, priceOut: 2 }],
        priceIn: 10,
        priceOut: 20,
        priceUnit: '¥',
      };
      eq(modelOf(cfg, 'titles'), 'T', '命中任务级映射');
      eq(modelOf(cfg, 'links'), 'M', '没配的任务回落主模型');
      deepEq(priceFor(cfg, 'T'), { priceIn: 1, priceOut: 2 }, '命中按模型单价');
      deepEq(priceFor(cfg, 'X'), { priceIn: 10, priceOut: 20 }, '没命中的模型回落默认单价');
      const u = { promptTokens: 1_000_000, completionTokens: 0, estimated: false, calls: 1 };
      eq(usageLineFor(cfg, 'titles', u), usageLine(u, 1, 2, '¥'), '费用按 titles 实际用的模型单价算');
      eq(usageLineFor(cfg, 'links', u), usageLine(u, 10, 20, '¥'), '没映射的任务按主模型单价算');
    });

    await suite.it('分派端到端：两个任务各自请求体里 model 不同（分派点在 runTask 接线处）', async () => {
      sweep();
      const aiWas = { ...ctx().settings.get().ai };
      try {
        H.resetAi();
        await H.configAi(plugin, {
          taskModels: { titles: '模型T', classify: '模型C' },
          modelPrices: [
            { model: '模型T', priceIn: 1, priceOut: 2 },
            { model: '模型C', priceIn: 3, priceOut: 4 },
          ],
        });
        const rel = await mk('__p722b分派靶.md', '---\ntags: []\n---\n\n正文\n');
        const seq1 = H.stubAiSeq([{ reply: '给候选' }]);
        await ctx().ai.proposeTitles({ notes: [rel] });
        const m1 = (JSON.parse(seq1.calls[0]?.body ?? '{}') as { model?: string }).model;
        eq(m1, '模型T', 'titles 任务走它自己的映射');
        H.resetAi();
        const seq2 = H.stubAiSeq([{ reply: '分诊完了' }]);
        await ctx().ai.classify({ scopeRel: '' });
        const m2 = (JSON.parse(seq2.calls[0]?.body ?? '{}') as { model?: string }).model;
        eq(m2, '模型C', 'classify 任务走它自己的映射');
        ok(m1 !== m2, '两个任务各自请求体里 model 不同（判据原文）');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        H.resetAi();
        sweep();
      }
    });

    await suite.it('设置页：协议一键切换落盘 · 任务模型行改写落盘 · 按模型定价条目可改可删', async () => {
      purgeOverlays();
      const aiWas: AiSettings = { ...ctx().settings.get().ai };
      try {
        await ctx().settings.save({
          ai: { ...aiWas, protocol: 'openai', modelPrices: [{ model: '模型T', priceIn: 1, priceOut: 2 }] },
        });
        ctx().openWorkbenchSettings();
        await H.settle(200);
        const tab = H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes('AI 助手'));
        ok(tab, '设置里能找到「AI 助手」栏');
        H.click(tab as HTMLElement);
        await H.settle(200);

        const rowByText = (needle: string): HTMLElement | undefined =>
          H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) => H.textOf(r).includes(needle));

        // ① 协议：点「Anthropic 原生」→ 落盘
        const protoRow = rowByText('Anthropic 原生');
        ok(protoRow, '「协议」行在');
        const anthBtn = H.qa<HTMLElement>(protoRow as HTMLElement, '.kbw-segbtn').find(
          (b) => H.textOf(b) === 'Anthropic 原生',
        );
        ok(anthBtn, '「Anthropic 原生」那一枚在');
        H.click(anthBtn as Element);
        await H.settle(250);
        eq(ctx().settings.get().ai.protocol, 'anthropic', '点一下 → 协议落盘');
        // 独立审 Y-3 的回归：行内选中态跟着走（segCtl 的 is-on 建时算死 —— 落盘后必须重画）
        const row2 = rowByText('Anthropic 原生');
        const onNow = row2
          ? H.qa<HTMLElement>(row2, '.kbw-segbtn').find((b) => b.classList.contains('is-on'))
          : undefined;
        eq(onNow ? H.textOf(onNow) : '', 'Anthropic 原生', '行内选中态跟着走');

        // ② 任务模型：改「起标题」那行的输入 → taskModels.titles 落盘
        const tRow = rowByText('任务 id：titles');
        ok(tRow, '「起标题」任务行在（带任务 id 提示）');
        const tIn = H.q<HTMLInputElement>(tRow as HTMLElement, 'input');
        eq(tIn.value, '', '没配过 → 输入框是空的（placeholder 写着"跟主模型"）');
        tIn.value = '模型Q';
        tIn.dispatchEvent(new Event('change'));
        await H.settle(80);
        eq(ctx().settings.get().ai.taskModels.titles, '模型Q', '改一行 → 任务映射落盘');
        // 清空 = 删掉这个键（回车空值）
        tIn.value = '';
        tIn.dispatchEvent(new Event('change'));
        await H.settle(80);
        eq('titles' in ctx().settings.get().ai.taskModels, false, '清空 → 键删掉（回落主模型）');

        // ③ 按模型定价：预置一条 → 行渲染、改数字落盘、删掉
        const pRow = rowByText('条目 1');
        ok(pRow, '预置的「条目 1」行在');
        const nums = H.qa<HTMLInputElement>(pRow as HTMLElement, 'input');
        eq(nums.length, 3, '一行三个输入（模型名 / 输入价 / 输出价）');
        nums[1].value = '4';
        nums[1].dispatchEvent(new Event('change'));
        await H.settle(80);
        eq(ctx().settings.get().ai.modelPrices[0]?.priceIn, 4, '改数字 → 落盘');
        const delBtn = H.qa<HTMLElement>(pRow as HTMLElement, '.kbw-btn').find((b) => H.textOf(b) === '删');
        ok(delBtn, '「删」在');
        H.click(delBtn as Element);
        await H.settle(120);
        eq(ctx().settings.get().ai.modelPrices.length, 0, '删掉 → 条目没了');
      } finally {
        await ctx().settings.save({ ai: { ...aiWas } });
        purgeOverlays();
      }
    });
  });
}
