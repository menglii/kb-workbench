/**
 * spec：**P7.3a · AI v2 对话与底座**（2026-10-02）—— 离线能验的那一半
 *
 * 分段对表（P7.3开工提示词 §2 的 3a 清单）：
 *   · **5.5 流式**：`fetch` + SSE 真流 / 连接层失败自动降级 / 整包误开 stream / 非 2xx 分类
 *   · **5.6 超时与取消**：整体超时 / 流式空转超时 / 用户取消（连接阶段与读到一半各一条）
 *   · **17.2 fragile 守卫**：四条写路径全过它 · 整篇跳过 + 报出来
 *   · **5.1a 会话**：存 / 读回 / 版本号 / 列表与删除
 *   · **5.1a 导出为笔记**：走的是「新建笔记」那条既有出口
 *
 * ⚠️ **真机才验得了的那些不在这里**：真调一次模型（key 与网络通 · 首块延迟）、
 * SSE 在真渲染进程里的分块节奏、面板几何 —— 全在 `scripts/probe.mjs`。
 * 这里用**注入的假 fetch / 假 requestUrl** 把逻辑钉死（生产路径只有 `httpTransport()` 那一次接线）。
 *
 * 🔴 **离线绝不联网**：每个传输层都带注入的假实现；桩的 `requestUrl` 默认抛。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import * as S from '../stub/index';
import { Suite, contains, eq, notContains, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { fragileKeys } from '../../src/services/schema';
import { AI_TIMEOUTS, AiError, httpTransport, type AiChatRequest } from '../../src/services/ai/transport';
import {
  AI_SESSIONS_VERSION,
  formatSessionMd,
  formatTurnMd,
  newSession,
  titleOf,
} from '../../src/services/ai/sessions';
import type { AiTurn } from '../../src/services/ai';

const KB = '01_新知识库';

/** 一条 SSE `data:` 行（OpenAI 兼容的增量形状） */
function sseDelta(piece: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
}

/**
 * 假 fetch：把 `chunks` 原样逐块喂进 body（**不帮你切行** —— 跨块断行是刻意的测点）。
 * `calls` 记每次调用的 url 与 init（断言 `stream:true` 与 abort 信号要用）。
 */
function sseFetch(
  chunks: (string | Uint8Array)[],
  status = 200,
): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const enc = new TextEncoder();
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const stream = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
        c.close();
      },
    });
    return new Response(stream, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 假 requestUrl：回一段整包 JSON（OpenAI 兼容形状） */
function wholeRequestUrl(content: string, status = 200): { impl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const impl = (async (p: unknown) => {
    calls.push(p);
    const payload =
      status >= 400
        ? { error: { message: content } }
        : { choices: [{ message: { role: 'assistant', content } }] };
    return { status, text: JSON.stringify(payload), json: payload, headers: {} };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const REQ: AiChatRequest = {
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  apiKey: 'sk-test',
  messages: [{ role: 'user', content: 'hi' }],
};

export async function specP73a(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  void app;
  void vaultRoot;

  // ════════════════════════════════════════════════════════════
  // 5.5 / 5.6 · 传输层：真流 · 降级 · 超时 · 取消（纯注入，不需要库）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3a · 传输层：SSE 真流与降级（5.5）', async () => {
    await suite.it('🔴 真流：增量按到达顺序吐出、返回全文；请求体带 stream:true', async () => {
      /**
       * 第二块刻意从 `ta:` 起 —— 前一块的尾巴是 `da`，**断行跨块**必须靠缓冲拼回来
       *（不缓冲的话这一块会被当成"不是 data: 行"整块丢掉，而返回值可能照样对 —— 假绿温床）。
       */
      const { impl, calls } = sseFetch([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\nda',
        'ta: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
      ]);
      const tr = httpTransport({ fetchImpl: impl });
      const deltas: string[] = [];
      const out = await tr.stream!(REQ, { onDelta: (d) => deltas.push(d) });
      eq(out.text, '你好', '返回的是全文');
      eq(deltas.join(''), '你好', '增量顺序拼起来 = 全文');
      eq(deltas.length, 2, '两块各吐一次（跨块那半句没被吞）');
      eq(calls.length, 1, '只发了一次请求');
      contains(calls[0].url, '/chat/completions', '打到的是 OpenAI 兼容口');
      ok(String(calls[0].init.body).includes('"stream":true'), '请求体开了 stream');
    });

    await suite.it('🔴 连接层失败（fetch TypeError）→ 降级整包、不吐增量，并记住这个 baseUrl', async () => {
      let fetchCalls = 0;
      const failingFetch = (async () => {
        fetchCalls += 1;
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch;
      const whole = wholeRequestUrl('整包回复');
      const tr = httpTransport({ fetchImpl: failingFetch, requestUrl: whole.impl as never });
      const deltas: string[] = [];
      const out1 = await tr.stream!(REQ, { onDelta: (d) => deltas.push(d) });
      eq(out1.text, '整包回复', '降级拿到了整包内容');
      eq(deltas.length, 0, '降级**不吐增量**（面板据此切打字机回放）');
      eq(fetchCalls, 1, '第一次试过 fetch');
      const out2 = await tr.stream!(REQ, { onDelta: (d) => deltas.push(d) });
      eq(out2.text, '整包回复', '第二次照样能用');
      eq(fetchCalls, 1, '🔴 记住这个 baseUrl：第二次**不再碰 fetch**（省一次连接失败的延迟）');
      eq(whole.calls.length, 2, '两次都走了整包');
    });

    await suite.it('读流中途断、一个增量都没吐 → 也降级（不把"断线"当答案）', async () => {
      const brokenFetch = (() => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.error(new Error('socket closed'));
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;
      const whole = wholeRequestUrl('断线之后拿到的整包');
      const tr = httpTransport({ fetchImpl: brokenFetch, requestUrl: whole.impl as never });
      const deltas: string[] = [];
      const out = await tr.stream!(REQ, { onDelta: (d) => deltas.push(d) });
      eq(out.text, '断线之后拿到的整包', '降级拿到了内容');
      eq(deltas.length, 0, '降级不吐增量');
      eq(whole.calls.length, 1, '确实走了整包');
    });

    await suite.it('provider 收了 stream:true 却回整包 JSON → 当一次增量交给面板', async () => {
      const whole = JSON.stringify({ choices: [{ message: { content: '我按整包回了' } }] });
      const { impl } = sseFetch([whole]);
      const tr = httpTransport({ fetchImpl: impl });
      const deltas: string[] = [];
      const out = await tr.stream!(REQ, { onDelta: (d) => deltas.push(d) });
      eq(out.text, '我按整包回了', '返回全文');
      eq(deltas.length, 1, '合成一次增量（面板不至于一个字符都看不到）');
    });

    await suite.it('流式非 2xx → 如实分类（auth），**不降级**（换条路也一样）', async () => {
      const { impl } = sseFetch(['{"error":{"message":"bad key"}}'], 401);
      let reqCalls = 0;
      const req = (async () => {
        reqCalls += 1;
        return { status: 200, text: '{}', json: {}, headers: {} };
      }) as unknown as typeof fetch;
      const tr = httpTransport({ fetchImpl: impl, requestUrl: req as never });
      let err: unknown = null;
      try {
        await tr.stream!(REQ, { onDelta: () => {} });
      } catch (e) {
        err = e;
      }
      ok(err instanceof AiError, '要抛 AiError');
      eq((err as AiError).kind, 'auth', '分类到 auth');
      eq(reqCalls, 0, '协议层的错不试整包');
    });

    /**
     * 🔴 **P7.3c 新增的两条流式行为**（独立审查 🟡3：这两条写进了冻结说明与 `坑/平台.md`，
     * 却一条判据都没有 —— 把代码挪坏（usage 收到 `if (piece === '') return` 之后、
     * 400 改成不降级）全套照样绿）。
     */
    await suite.it('🔴 P7.3c：用量块（choices 空数组那一块）要收集到 · 请求体要带 stream_options', async () => {
      const { impl, calls } = sseFetch([
        sseDelta('好'),
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } })}\n\n`,
        'data: [DONE]\n\n',
      ]);
      const tr = httpTransport({ fetchImpl: impl });
      const out = await tr.stream!(REQ, { onDelta: () => {} });
      eq(out.text, '好', '正文照旧');
      eq(
        JSON.stringify(out.usage),
        JSON.stringify({ promptTokens: 11, completionTokens: 2 }),
        '用量块收进了 usage（先判"没有 delta 就 return"的写法会把它漏掉）',
      );
      ok(
        String(calls[0].init.body).includes('"include_usage":true'),
        '请求体里带上了 stream_options.include_usage（不然服务端根本不吐这一块）',
      );
    });

    await suite.it('🔴 P7.3c：流式回 400（网关不认加的字段）→ 降级走整包，并记住这个 baseUrl', async () => {
      let fetchCalls = 0;
      const badStream = (async () => {
        fetchCalls += 1;
        return new Response('{"error":{"message":"unknown field stream_options"}}', { status: 400 });
      }) as unknown as typeof fetch;
      const whole = wholeRequestUrl('整包回复');
      const tr = httpTransport({ fetchImpl: badStream, requestUrl: whole.impl as never });
      const out = await tr.stream!(REQ, { onDelta: () => {} });
      eq(out.text, '整包回复', '400 之后降级拿到了内容（不是把一次能成的调用废在"HTTP 400"上）');
      eq(fetchCalls, 1, '试过一次流式');
      const out2 = await tr.stream!(REQ, { onDelta: () => {} });
      eq(out2.text, '整包回复', '第二次照样能用');
      eq(fetchCalls, 1, '🔴 记住了这个 baseUrl：第二次不再碰 fetch');
      eq(whole.calls.length, 2, '两次都走了整包');
    });

    await suite.it('环境没有 fetch → 直接走整包（不抛）', async () => {
      const whole = wholeRequestUrl('没有 fetch 的世界');
      const tr = httpTransport({ fetchImpl: null, requestUrl: whole.impl as never });
      const deltas: string[] = [];
      const out = await tr.stream!(REQ, { onDelta: (d) => deltas.push(d) });
      eq(out.text, '没有 fetch 的世界', '整包内容');
      eq(deltas.length, 0, '不吐增量');
    });
  });

  await suite.group('P7.3a · 传输层：超时与取消（5.6）', async () => {
    await suite.it('🔴 用户取消（连接阶段）：抛 cancel、**不是错**', async () => {
      const hangingFetch = ((_url: unknown, init: RequestInit) =>
        new Promise((_res, rej) => {
          const sig = init.signal as AbortSignal;
          sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        })) as unknown as typeof fetch;
      const tr = httpTransport({ fetchImpl: hangingFetch });
      const ac = new AbortController();
      const p = tr.stream!(REQ, { onDelta: () => {}, signal: ac.signal });
      setTimeout(() => ac.abort(), 10);
      let err: unknown = null;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      ok(err instanceof AiError, '要抛 AiError');
      eq((err as AiError).kind, 'cancel', '分类到 cancel（面板按"已停止"画，别画红框）');
    });

    await suite.it('🔴 读到一半取消：已吐的增量保留、抛 cancel', async () => {
      const enc = new TextEncoder();
      const halfFetch = ((_url: unknown, init: RequestInit) => {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            c.enqueue(enc.encode(sseDelta('一半')));
          },
        });
        (init.signal as AbortSignal).addEventListener('abort', () =>
          ctrl.error(new DOMException('aborted', 'AbortError')),
        );
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;
      const tr = httpTransport({ fetchImpl: halfFetch });
      const ac = new AbortController();
      const deltas: string[] = [];
      const p = tr.stream!(REQ, {
        onDelta: (d) => {
          deltas.push(d);
          setTimeout(() => ac.abort(), 10); // 收到第一块之后才取消
        },
        signal: ac.signal,
      });
      let err: unknown = null;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      eq(deltas.join(''), '一半', '取消之前吐出来的那块还在');
      ok(err instanceof AiError && (err as AiError).kind === 'cancel', '分类到 cancel');
    });

    await suite.it('流式空转超时：抛 timeout（不是 cancel），且**由空转计时触发**、不是总时长', async () => {
      const enc = new TextEncoder();
      const idleFetch = ((_url: unknown, init: RequestInit) => {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            c.enqueue(enc.encode(sseDelta('开头')));
            // 之后一直不吐 —— 空转计时该动手了
          },
        });
        (init.signal as AbortSignal).addEventListener('abort', () =>
          ctrl.error(new DOMException('aborted', 'AbortError')),
        );
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;
      const tr = httpTransport({
        fetchImpl: idleFetch,
        timeouts: { streamIdleMs: 40, streamTotalMs: 5000 },
      });
      const t0 = Date.now();
      let err: unknown = null;
      try {
        await tr.stream!(REQ, { onDelta: () => {} });
      } catch (e) {
        err = e;
      }
      const ms = Date.now() - t0;
      ok(err instanceof AiError, '要抛 AiError');
      eq((err as AiError).kind, 'timeout', '分类到 timeout');
      /**
       * 🔴 **耗时断言**（独立审查 🟢7）：只判 kind 的话，把 `armIdle` 整段删掉、
       * 靠 5000ms 的总时长兜底也会得到同一个 `kind` —— 这条判据就没钉住"空转"这个机制。
       * 40ms 的空转 vs 5000ms 的总时长，落中间取 2000ms 分界。
       */
      ok(ms < 2000, `由空转计时触发（实测 ${ms}ms，总时长是 5000ms）`);
    });

    await suite.it('非流式：整体超时与取消（对 requestUrl 的 race）', async () => {
      const never = (async () => new Promise(() => {})) as unknown as typeof fetch; // 永不落定
      const tr = httpTransport({ requestUrl: never as never, timeouts: { requestMs: 40 } });
      let err: unknown = null;
      try {
        await tr.chat(REQ, {});
      } catch (e) {
        err = e;
      }
      ok(err instanceof AiError && (err as AiError).kind === 'timeout', '整体超时分类到 timeout');

      const ac = new AbortController();
      const p = tr.chat(REQ, { signal: ac.signal });
      setTimeout(() => ac.abort(), 10);
      let err2: unknown = null;
      try {
        await p;
      } catch (e) {
        err2 = e;
      }
      ok(err2 instanceof AiError && (err2 as AiError).kind === 'cancel', '取消分类到 cancel');
    });

    await suite.it('默认超时值是保守量（别把正常的慢回答掐了）', () => {
      ok(AI_TIMEOUTS.requestMs >= 60_000, '非流式整体 ≥ 60s');
      ok(AI_TIMEOUTS.streamIdleMs >= 15_000, '流式空转 ≥ 15s');
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5.1a · 服务层分流：给了 onDelta 且传输层有 stream → 走流式
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3a · AiService 分流（要增量才走流式）', async () => {
    await suite.it('🔴 有 onDelta + transport.stream → 走流式；没有 onDelta → 走整包', async () => {
      const seen = { chat: 0, stream: 0, deltaChars: [] as string[] };
      const old = ctx().ai.transport;
      try {
        ctx().ai.transport = {
          chat: async () => {
            seen.chat += 1;
            return { text: '整包路径' };
          },
          stream: async (_req, opts) => {
            seen.stream += 1;
            opts.onDelta?.('甲');
            opts.onDelta?.('乙');
            return { text: '甲乙' };
          },
        };
        const turn = await ctx().ai.ask({ question: '测试流式', onDelta: (d) => seen.deltaChars.push(d) });
        eq(seen.stream, 1, '走了流式');
        eq(seen.chat, 0, '没走整包');
        eq(seen.deltaChars.join(''), '甲乙', '增量透传到了调用方');
        eq(turn.reply, '甲乙', '返回的轮次用的是全文');

        const seen2 = { chat: 0 };
        ctx().ai.transport = {
          chat: async () => {
            seen2.chat += 1;
            return { text: '只有整包' };
          },
        };
        const turn2 = await ctx().ai.ask({ question: '测试整包' });
        eq(seen2.chat, 1, '没有 onDelta → 走整包（老路径一个字不变）');
        eq(turn2.reply, '只有整包');
      } finally {
        ctx().ai.transport = old;
      }
    });

    await suite.it('流式报错时错误照旧分类传出去（不吞成空建议）', async () => {
      const old = ctx().ai.transport;
      try {
        ctx().ai.transport = {
          chat: async () => ({ text: '不会走到' }),
          stream: async () => {
            throw new AiError('已停止', 'cancel');
          },
        };
        let err: unknown = null;
        try {
          await ctx().ai.ask({ question: '测试', onDelta: () => {} });
        } catch (e) {
          err = e;
        }
        ok(err instanceof AiError && (err as AiError).kind === 'cancel', 'cancel 原样传出');
      } finally {
        ctx().ai.transport = old;
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 17.2 · fragile 守卫（四条写路径全过它）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3a · 17.2 fragile 守卫（写前言的路径全过它）', async () => {
    const fragRel = `${KB}/00_Inbox/__探针守旧模板.md`;
    const okRel = `${KB}/00_Inbox/__探针守正常.md`;
    /**
     * `创建日期: {{date}}` 在真机 YAML 里是**嵌套映射**（P2 实测 4 篇）。
     * 桩自本轮起照实模拟（`tests/stub` 的 `FlowMap`）—— 不模拟的话这条判据离线**恒绿**。
     */
    const FRAG_TEXT = [
      '---',
      '类型: 想法',
      '领域: 未分类',
      '状态: 待整理',
      '创建日期: {{date}}',
      'tags: []',
      '---',
      '',
      '正文。',
      '',
    ].join('\n');
    const OK_TEXT = FRAG_TEXT.replace('创建日期: {{date}}', '创建日期: 2026-01-01');

    function plant(): void {
      H.writeNote(vaultRoot, fragRel, FRAG_TEXT);
      H.writeNote(vaultRoot, okRel, OK_TEXT);
      app.vault.rescan();
      ctx().index.rebuild();
    }

    function fileOf(rel: string) {
      const f = app.vault.getAbstractFileByPath(rel);
      ok(f, `夹具不在库里：${rel}`);
      return f as import('obsidian').TFile;
    }

    /** 最近一条"跳过"通知（通知区会留别的用例的尾巴，按内容挑） */
    function skipNotice(): HTMLElement | null {
      const all = H.qa<HTMLElement>(document.body, '.kbw-notice');
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (H.textOf(all[i]).includes('跳过')) return all[i];
      }
      return null;
    }

    async function cleanup(): Promise<void> {
      for (const rel of [fragRel, okRel]) {
        try {
          fs.rmSync(path.join(vaultRoot, rel));
        } catch {
          /* 不在就算了 */
        }
      }
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
    }

    try {
      plant();
      await H.settleIndex(app);

      await suite.it('纯函数：数组/空/标量都不算"脆"，嵌套映射才算', () => {
        eq(fragileKeys({ tags: ['a', 'b'], 文件位置: ['00_Inbox'], x: null, y: 1, z: 's' }).length, 0, '列表与标量不算');
        eq(fragileKeys({ 创建日期: { '{ date }': null } }).join(','), '创建日期', '嵌套映射算');
      });

      await suite.it('🔴 setMany：命中守卫 → 整篇跳过 + partial 通知 + 文件一字节没动', async () => {
        // 负向对照：同一批里的正常篇照常写（别把门焊死）
        const okRes = await ctx().fm.setMany(fileOf(okRel), { 状态: '进行中' });
        eq(okRes.skipped.length, 0, '正常篇照写');
        ok(H.readNote(vaultRoot, okRel).includes('状态: 进行中'), '正常篇真的落盘了');

        const before = H.readNote(vaultRoot, fragRel);
        const res = await ctx().fm.setMany(fileOf(fragRel), { 状态: '进行中' });
        eq(res.skipped.join(','), '创建日期', '报出是哪个键');
        eq(H.readNote(vaultRoot, fragRel), before, '🔴 一字节没动（不是"只改了别的键"）');
        const notice = skipNotice();
        ok(notice, '"报出来"：必须有一条通知');
        eq(notice!.className.includes('is-partial'), true, '是 partial（部分没做到）那一档');
        contains(H.textOf(notice!), '创建日期', '通知里要说清哪个键');
        contains(H.textOf(notice!), '嵌套映射', '并说清为什么跳过');
      });

      await suite.it('remove 与 update 走同一个守卫；set 委托 setMany 也过它', async () => {
        const before = H.readNote(vaultRoot, fragRel);
        const r1 = await ctx().fm.remove(fileOf(fragRel), ['标签']);
        eq(r1.skipped.length, 1, 'remove 被拦');
        const r2 = await ctx().fm.update(fileOf(fragRel), (fm) => {
          fm['状态'] = '进行中';
        });
        eq(r2.skipped.length, 1, 'update 被拦');
        const r3 = await ctx().fm.set(fileOf(fragRel), '状态', '进行中');
        eq(r3.skipped.length, 1, 'set（委托 setMany）被拦');
        eq(H.readNote(vaultRoot, fragRel), before, '三条路径加起来也一字节没动');
      });

      await suite.it('🔴 调用方不许把"跳过"报成"已改"：ops.setProp 的计数（独立审查 🟡1）', async () => {
        const { NotesOps } = await import('../../src/modules/notes/ops');
        const fragEntry = ctx().index.get(fragRel);
        const okEntry = ctx().index.get(okRel);
        ok(fragEntry && okEntry, '两篇夹具都在索引里');
        const before = H.readNote(vaultRoot, fragRel);
        // n=2 → 走确认流（点头之后才写）
        const p = new NotesOps(ctx(), () => {}).setProp([fragEntry, okEntry], '状态', '进行中');
        await H.settle(60);
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
        ok(modal, '确认流弹了');
        H.click(H.q<HTMLElement>(modal as HTMLElement, '.kbw-modal-foot .kbw-btn.is-primary'));
        await p;
        await H.settle(60);
        eq(H.readNote(vaultRoot, fragRel), before, '脆的那篇一字节没动');
        ok(H.readNote(vaultRoot, okRel).includes('状态: 进行中'), '正常那篇写了');
        const notices = H.qa<HTMLElement>(document.body, '.kbw-notice').map((n) => H.textOf(n));
        const opsNotice = notices.find((t) => t.includes('篇已改'));
        ok(opsNotice, `有一条计数通知（实际：${notices.join(' ｜ ')}）`);
        contains(opsNotice as string, '1 篇已改', '计数只说改成了的那些');
        contains(opsNotice as string, '1 篇跳过', '跳过如实报出来');
        notContains(notices.join('\n'), '已改好', '🔴 绝不许把跳过的算成"已改好 N 篇"');
      });

      await suite.it('突变自证：拿掉守卫时，这个夹具**真的会被改形**（判据不是恒绿）', async () => {
        /**
         * 这条不是测产品代码，是**测夹具与桩**：直接走 `processFrontMatter`
         *（守卫之外的原始路径）—— 若桩模拟得对，`{{date}}` 会被改形成嵌套块。
         * 没有这一条的话，"一字节没动"可能只是因为桩**根本不会改形**（假绿温床）。
         */
        const copyRel = `${KB}/00_Inbox/__探针守旧副本.md`;
        H.writeNote(vaultRoot, copyRel, FRAG_TEXT);
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);
        await app.fileManager.processFrontMatter(fileOf(copyRel), (fm) => {
          fm['状态'] = '进行中';
        });
        const after = H.readNote(vaultRoot, copyRel);
        ok(!after.includes('{{date}}'), '桩模拟：原文形状真的会回不去');
        contains(after, '"{ date }"', '改形成的嵌套块形状与真机实测一致');
        fs.rmSync(path.join(vaultRoot, copyRel));
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);
      });
    } finally {
      await cleanup();
    }
  });

  // ════════════════════════════════════════════════════════════
  // 5.1a · 会话存储（插件目录 · 带版本号）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3a · 5.1a 会话存储（插件目录 · 带版本号）', async () => {
    const store = () => ctx().ai.sessions;
    const sessionsDir = path.join(vaultRoot, '.obsidian/plugins/kb-workbench/ai-sessions');

    function mkTurn(q: string, reply = '好的'): AiTurn {
      return { question: q, kind: 'chat', reply, ideas: [], plan: { rows: [], blocked: [] }, proposed: 0, dropped: 0 };
    }

    await suite.it('存 → 读回：id 自动生成、轮次与标题都在', async () => {
      const s = newSession();
      s.turns.push(mkTurn('第一篇怎么归位？', '我看看'));
      s.title = titleOf(s.turns[0].question);
      const saved = await store().save(s);
      ok(saved.id !== '', '空 id 自动取一个');
      const back = await store().load(saved.id);
      ok(back, '读得回来');
      eq(back!.turns.length, 1, '轮次在');
      eq(back!.turns[0].question, '第一篇怎么归位？', '问在');
      eq(back!.turns[0].reply, '我看看', '答在');
      eq(back!.title, '第一篇怎么归位？', '标题是首问');
    });

    await suite.it('列表按最近更新倒序；latest() = 列表第一份', async () => {
      const s2 = newSession();
      s2.updatedAt = Date.now() + 60_000; // 明确比上一份新
      s2.turns.push(mkTurn('第二段对话'));
      s2.title = titleOf('第二段对话');
      const saved2 = await store().save(s2);
      const list = await store().list();
      ok(list.length >= 2, `至少两份（实际 ${list.length}）`);
      eq(list[0].id, saved2.id, '最新的排最前');
      const latest = await store().latest();
      eq(latest?.id, saved2.id, 'latest 就是它');
      ok(list.every((m) => m.turnCount >= 0), 'meta 带轮数');
    });

    await suite.it('🔴 旧版（无 version 字段）读得回、缺的字段整形；未来版本跳过（不猜）', async () => {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, 'legacy.json'),
        JSON.stringify({
          id: 'legacy',
          title: '老会话',
          createdAt: 1,
          updatedAt: 2,
          turns: [{ question: '旧的', kind: 'chat', reply: '旧答' }], // 缺 plan/proposed/dropped
        }),
        'utf8',
      );
      const legacy = await store().load('legacy');
      ok(legacy, '旧文件读得回（走迁移，不是报错）');
      eq(legacy!.version, AI_SESSIONS_VERSION, '版本号补到当前');
      eq(legacy!.turns.length, 1, '缺字段的轮次被整形（不整份作废）');
      eq(legacy!.turns[0].plan.rows.length, 0, '缺的 plan 补成空计划');
      eq(legacy!.turns[0].proposed, 0, '缺的数字补 0');

      fs.writeFileSync(
        path.join(sessionsDir, 'future.json'),
        JSON.stringify({ version: 99, id: 'future', title: '未来', turns: [] }),
        'utf8',
      );
      eq(await store().load('future'), null, '未来版本：读不动就跳过，不猜');
      const list = await store().list();
      ok(!list.some((m) => m.id === 'future'), '列表里也不出现它');

      fs.writeFileSync(path.join(sessionsDir, '烂.json'), '{oops', 'utf8');
      eq(await store().load('烂'), null, 'JSON 烂了也只是一份读不出（不炸）');
      fs.rmSync(path.join(sessionsDir, 'legacy.json'));
      fs.rmSync(path.join(sessionsDir, 'future.json'));
      fs.rmSync(path.join(sessionsDir, '烂.json'));
    });

    await suite.it('删除：remove 之后 load 读不到了', async () => {
      const s = newSession();
      s.turns.push(mkTurn('要删的'));
      const saved = await store().save(s);
      await store().remove(saved.id);
      eq(await store().load(saved.id), null, '删干净了');
    });

    await suite.it('导出格式化：问、答、建议行都在（相对口径）', () => {
      const t = mkTurn('把这两篇归位', '建议如下');
      t.kind = 'advice';
      t.plan.rows = [
        { path: '01_新知识库/00_Inbox/a.md', rel: '00_Inbox/a.md', dir: '01_新知识库/01_Projects', dirRel: '01_Projects', why: '属于项目' },
      ];
      const md = formatTurnMd(t);
      contains(md, '**我**：把这两篇归位');
      contains(md, '**助手**：建议如下');
      contains(md, '`00_Inbox/a.md` → `01_Projects`', '建议行用相对口径');
      contains(md, '属于项目', '理由在');
      const s = newSession();
      s.turns = [t];
      const full = formatSessionMd(s);
      contains(full, '经纬 · 工作台', '导出正文带来源标注');
      contains(full, '把这两篇归位');
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5.1a · 导出为笔记（走「新建笔记」那条既有出口）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3a · 5.1a 导出为笔记（既有出口）', async () => {
    const body = '**我**：你好\n\n**助手**：你也好';
    const made: string[] = [];

    async function drop(rel: string): Promise<void> {
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
    }

    try {
      await suite.it('🔴 createNote 带 body：正文落盘、在前言之后、规则文案说实话', async () => {
        const res = await ctx().completion.createNote({
          title: '__探针导出对话',
          dirRel: '00_Inbox',
          noTemplate: true,
          body,
        });
        made.push(res.path);
        const text = H.readNote(vaultRoot, res.path);
        contains(text, '**我**：你好', '正文在');
        contains(text, '**助手**：你也好', '整段都在');
        ok(text.startsWith('---\n'), '补全开着 → 前言在最前');
        const headEnd = text.indexOf('\n---\n');
        ok(headEnd > 0, '前言闭合行在');
        const afterFm = text.slice(headEnd + 5);
        ok(afterFm.trimStart().startsWith('**我**：'), '正文紧跟前言（不是被尾链挤到后面）');
        contains(res.rule, '导出为笔记', '规则文案注明是导出（别谎称"只补了前言+尾链"）');
      });

      await suite.it('补全关着：导出正文照落（没补前言而已，不许静默丢正文）', async () => {
        await ctx().gate.set('completion', false);
        try {
          const res = await ctx().completion.createNote({
            title: '__探针导出无补全',
            dirRel: '00_Inbox',
            noTemplate: true,
            body,
          });
          made.push(res.path);
          const text = H.readNote(vaultRoot, res.path);
          contains(text, '**我**：你好', '关着补全，正文也要落');
          contains(res.rule, '只写了正文', '如实说没补前言');
        } finally {
          await ctx().gate.set('completion', true);
        }
      });

      await suite.it('不带 body：与从前一字不差（前言 + 尾链、正文留空）', async () => {
        const res = await ctx().completion.createNote({
          title: '__探针导出对照',
          dirRel: '00_Inbox',
          noTemplate: true,
        });
        made.push(res.path);
        const text = H.readNote(vaultRoot, res.path);
        const headEnd = text.indexOf('\n---\n');
        const tailAt = text.indexOf('## 关联笔记');
        ok(headEnd > 0 && tailAt > headEnd, '前言与尾链都在位');
        eq(text.slice(headEnd + 5, tailAt).trim(), '', '正文照旧留空');
      });
    } finally {
      for (const rel of made) await drop(rel);
    }
  });

  // ════════════════════════════════════════════════════════════
  // 5.1a / 5.6 · 面板：真流可见 · 停止 · 恢复 · 消息操作 · @ 引用
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3a · 面板（流式 / 停止 / 恢复 / 消息操作 / @ 引用）', async () => {
    const sessionsDir = path.join(vaultRoot, '.obsidian/plugins/kb-workbench/ai-sessions');

    function openPanel(): HTMLElement {
      ctx().openAi();
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
      ok(modal, 'AI 面板开出来了');
      return modal as HTMLElement;
    }

    function send(modal: HTMLElement, q: string): void {
      H.q<HTMLTextAreaElement>(modal, '.kbw-ai-input').value = q;
      H.click(H.q<HTMLElement>(modal, '.kbw-ai-send .kbw-btn'));
    }

    /** 等这一轮**画完**（收尾挂一枚 `.kbw-ai-ops`）—— 不赌固定时长 */
    async function waitTurn(modal: HTMLElement, before = 0): Promise<void> {
      await H.until(() => modal.querySelectorAll('.kbw-ai-ops').length > before, 4000);
      await H.settle(60);
    }

    /** 消息级操作的那枚小图标（按 aria-label 找 —— P7.3b 起是图标不是文字按钮） */
    function opButton(modal: HTMLElement, label: string): HTMLElement | undefined {
      return H.qa<HTMLElement>(modal, '.kbw-ai-ops .kbw-btn').find(
        (b) => b.getAttribute('aria-label') === label,
      );
    }

    /** 一条 SSE `data:` 块（OpenAI 增量形状） */
    function sse(piece: string): string {
      return `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
    }

    const enc = new TextEncoder();

    /**
     * 每条用例起手：收浮层/菜单、清假响应、装好 key、**换一个全新的默认传输层**。
     *
     * 🔴 为什么不用现成的 `ctx.ai.http`：它内部有一张「这个 baseUrl 流式不通」的备忘
     *（连接层失败一次就记下、之后直接走整包 —— 生产上是对的，省一次连接失败的延迟）。
     * 而全量跑时，**前面的 specAi 用例**会让 fetch 撞上桩守卫（没装 handler = 抛 TypeError）
     * → 备忘就此记下 DeepSeek 这个 baseUrl → 到了本组，哪怕我们装了假 fetch 也**永远走不到流式**
     *（症状：`fetchLog` 空、"连不上"的红框 —— 单独跑本组则全绿，典型的跨用例污染）。
     */
    async function freshPanel(): Promise<void> {
      purgeOverlays();
      closeAllMenus();
      H.resetAi();
      await H.configAi(plugin);
      ctx().ai.transport = httpTransport();
      await H.settle(20);
    }

    try {
      await suite.it('🔴 真流：增量边到边显示（不等到整包）', async () => {
        await freshPanel();
        let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
        S.setFetchHandler(() => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              ctrl = c;
              c.enqueue(enc.encode(sse('第一段。')));
            },
          });
          return new Response(stream, { status: 200 });
        });
        const modal = openPanel();
        send(modal, '流式测试');
        await H.settle(80);
        // 还没关流：增量应当已经上屏（这就是"流式看得见"）
        const during = H.textOf(H.q(modal, '.kbw-ai-stream'));
        contains(during, '第一段。', '增量在流还没结束时就已经显示（不是整包到了才画）');
        // 收流
        ctrl!.enqueue(enc.encode(sse('第二段。')));
        ctrl!.close();
        await waitTurn(modal);
        const log = H.q(modal, '.kbw-ai-log');
        contains(H.textOf(log), '第一段。第二段。', '收尾后的正式气泡是全文');
        ok(S.fetchLog.length >= 1, '走了 fetch（真流那一路）');
        ok(String(S.fetchLog[S.fetchLog.length - 1].init.body).includes('"stream":true'), '请求体开了 stream');
        purgeOverlays();
      });

      await suite.it('🔴 停止：abort 传到底、保留已收到的一半、不画红框', async () => {
        await freshPanel();
        let aborted = false;
        S.setFetchHandler((_url, init) => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(sse('半句')));
              (init.signal as AbortSignal).addEventListener('abort', () => {
                aborted = true;
                c.error(new DOMException('aborted', 'AbortError'));
              });
            },
          });
          return new Response(stream, { status: 200 });
        });
        const modal = openPanel();
        send(modal, '停止测试');
        await H.settle(60);
        /**
         * ⚠️ P7.3b 起「停止」**不再是并排的第二枚按钮**：发送键在飞的时候原地变「停止」
         *（同一枚 `.kbw-ai-send .kbw-btn`，见 `AI面板重设计稿.html`）。
         */
        const stop = H.qa<HTMLElement>(modal, '.kbw-ai-send .kbw-btn')[0];
        ok(stop, '发送/停止这枚按钮在');
        contains(H.textOf(stop), '停止', '在飞的时候它写着「停止」');
        H.click(stop);
        await H.settle(80);
        ok(aborted, 'abort 真的传到了底下那层（不是只在界面上装样子）');
        contains(H.textOf(modal), '半句', '已经收到的部分留着');
        contains(H.textOf(modal), '已停止', '有"已停止"这句说明');
        eq(H.qa(modal, '.kbw-ai-bubble.is-error').length, 0, '用户自己按的停止不是错误（不许红框）');
        const ask = H.qa<HTMLButtonElement>(modal, '.kbw-ai-send .kbw-btn')[0];
        eq(ask.hasAttribute('disabled'), false, '发送键恢复可用');
        contains(H.textOf(ask), '问一下', '按钮变回「问一下」');
        purgeOverlays();
      });

      await suite.it('🔴 会话恢复：关掉面板再打开，上一段对话还在（含"新对话"清屏）', async () => {
        await freshPanel();
        fs.rmSync(sessionsDir, { recursive: true, force: true });
        S.setFetchHandler(() => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(sse('收到，这是一段会被记住的回答。')));
              c.close();
            },
          });
          return new Response(stream, { status: 200 });
        });
        const modal = openPanel();
        send(modal, '恢复测试问题');
        await waitTurn(modal);
        contains(H.textOf(modal), '会被记住的回答', '这一轮答完了');

        // 关面板 → 再打开（完成定义那条）
        purgeOverlays();
        await H.settle(30);
        const back = openPanel();
        await H.settle(80);
        const hist = H.q(back, '.kbw-ai-hist');
        ok(hist, '恢复块画出来了（.kbw-ai-hist）');
        contains(H.textOf(hist), '恢复测试问题', '上次的问题在');
        contains(H.textOf(hist), '会被记住的回答', '上次的回答在');
        eq(H.qa(back, '.kbw-ai-intro').length, 0, '有历史就不再摆开场引导');

        // 「新对话」清屏 + 引导回来（R4 起收进头部「⋯」菜单 —— 开菜单再点）
        H.click(H.q<HTMLElement>(back, '.kbw-ai-morebtn'));
        await H.settle(30);
        const newItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('新对话'),
        );
        ok(newItem, '「新对话」在 ⋯ 菜单里');
        H.click(newItem!);
        await H.settle(30);
        eq(H.qa(back, '.kbw-ai-hist').length, 0, '历史清掉了');
        ok(H.qa(back, '.kbw-ai-intro').length >= 1, '引导回来了（又是新的一段）');
        purgeOverlays();
      });

      await suite.it('消息级操作：复制 / 重试（截断重问）/ 引用为笔记', async () => {
        await freshPanel();
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async (t: string) => void copied.push(t) },
          configurable: true,
        });
        let call = 0;
        S.setFetchHandler(() => {
          call += 1;
          const text = call === 1 ? '第一版回答' : '第二版回答';
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(sse(text)));
              c.close();
            },
          });
          return new Response(stream, { status: 200 });
        });
        const modal = openPanel();
        send(modal, '操作测试问题');
        await waitTurn(modal);
        const log = H.q(modal, '.kbw-ai-log');
        contains(H.textOf(log), '第一版回答', '第一轮答完');

        // 复制（P7.3b 起消息操作是图标按钮，按 aria-label 找）
        const copyBtn = opButton(modal, '复制');
        ok(copyBtn, '复制按钮在');
        H.click(copyBtn!);
        await H.settle(30);
        eq(copied.length, 1, '剪贴板收到一次');
        contains(copied[0], '第一版回答', '复制的是这一轮的回答');

        // 重试：同题重问 + 旧气泡被截掉
        const retryBtn = opButton(modal, '重试');
        ok(retryBtn, '重试按钮在');
        H.click(retryBtn!);
        // ⚠️ 重试会先把旧气泡（含它的 ops 行）**摘掉**再重问 —— 不能拿"ops 计数变大"当信号，
        // 认"第二版回答上屏"这个事实
        await H.until(() => call === 2 && H.textOf(log).includes('第二版回答'), 4000);
        await H.settle(60);
        eq(call, 2, '真的又发了一次');
        contains(String(S.fetchLog[S.fetchLog.length - 1].init.body), '操作测试问题', '重问的是同一句');
        contains(H.textOf(log), '第二版回答', '第二版的回答上屏');
        notContains(H.textOf(log), '第一版回答', '旧气泡被截掉了（截断到那一轮）');

        // 引用为笔记：打开新建对话框（预填问题）→ 新建 → 内容落地
        const quoteBtn = opButton(modal, '引用为笔记');
        ok(quoteBtn, '引用为笔记按钮在');
        H.click(quoteBtn!);
        await H.settle(40);
        const dialog = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
        ok(dialog && dialog !== modal, '新建笔记对话框开了');
        eq(H.q<HTMLInputElement>(dialog!, '.kbw-input').value, '操作测试问题', '标题预填了这一轮的问题');
        H.click(H.q<HTMLElement>(dialog!, '.kbw-modal-foot .kbw-btn.is-primary'));
        await H.settle(160);
        const created = app.vault.getAbstractFileByPath(`${KB}/00_Inbox/操作测试问题.md`);
        ok(created, '笔记建出来了（走的是新建那条既有出口）');
        const text = H.readNote(vaultRoot, `${KB}/00_Inbox/操作测试问题.md`);
        contains(text, '第二版回答', '这一轮的问答写进了正文');
        fs.rmSync(path.join(vaultRoot, `${KB}/00_Inbox/操作测试问题.md`), { force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        purgeOverlays();
      });

      await suite.it('🔴 @ 引用：一篇笔记塞进这一问的材料（模型真的收到了）', async () => {
        await freshPanel();
        const refRel = `${KB}/00_Inbox/__探针被引用.md`;
        H.writeNote(vaultRoot, refRel, `---\n类型: 想法\n领域: 未分类\n状态: 待整理\n创建日期: 2026-01-01\ntags: []\n---\n\n独一无二的引用内容标记甲乙丙。\n`);
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);

        S.setFetchHandler(() => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(sse('好的')));
              c.close();
            },
          });
          return new Response(stream, { status: 200 });
        });
        const modal = openPanel();
        // R4：「@ 引用」收进「＋」菜单 —— 先开 ＋ 再点「引用一篇笔记…」
        H.click(H.q<HTMLElement>(modal, '.kbw-ai-plusbtn'));
        await H.settle(30);
        const refItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('引用一篇笔记'),
        );
        ok(refItem, '「引用一篇笔记…」在 ＋ 菜单里');
        H.click(refItem!);
        await H.settle(30);
        // P7.10 · #12：@ 引用从"小菜单"升级成**小面板**（搜索 + 目录树 + 列表）——
        // 用搜索框最快找到那一篇（全库按标题过滤）
        const picker = H.q<HTMLElement>(document.body, '.kbw-ai-refpanel');
        ok(picker, '引用小面板开出来了');
        const search = H.q<HTMLInputElement>(picker, '.kbw-ai-refsearch');
        search.value = '__探针被引用';
        search.dispatchEvent(new Event('input'));
        await H.settle(30);
        const items = H.qa<HTMLElement>(picker, '.kbw-ai-refitem');
        const target = items.find((it) => H.textOf(it).includes('__探针被引用'));
        ok(target, `面板里有这篇（实际 ${items.length} 项）`);
        H.click(target!);
        await H.settle(20);
        const chip = H.q<HTMLElement>(modal, '.kbw-ai-ref');
        ok(chip, '胶囊出来了');
        contains(H.textOf(chip), '__探针被引用', '胶囊写着引用了谁');

        send(modal, '看看引用的这篇');
        await waitTurn(modal);
        const body = String(S.fetchLog[S.fetchLog.length - 1].init.body);
        contains(body.replace(/\\n/g, '\n'), '独一无二的引用内容标记甲乙丙', '被引用的正文进了提示词');
        contains(H.textOf(modal), '（引用：', '用户气泡上标了引用');

        fs.rmSync(path.join(vaultRoot, refRel), { force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        purgeOverlays();
      });

      await suite.it('🔴 @ 引用：编辑器选区也进材料（桩补了 getSelection —— 这条以前离线进不去）', async () => {
        await freshPanel();
        const refRel = `${KB}/00_Inbox/__探针选区.md`;
        H.writeNote(
          vaultRoot,
          refRel,
          `---\n类型: 想法\n领域: 未分类\n状态: 待整理\n创建日期: 2026-01-01\ntags: []\n---\n\n独一无二的选区标记文字。\n`,
        );
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);

        // 开成活动叶 + 设一段选区（真机语义：getSelection 取得到、就带上）
        const leaf = app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: 'markdown', state: { file: refRel } });
        await H.settle(40);
        const view = leaf.view as unknown as {
          editor: {
            getValue(): string;
            setSelection(a: { line: number; ch: number }, b?: { line: number; ch: number }): void;
          };
        };
        const lines = view.editor.getValue().split('\n');
        const li = lines.findIndex((l) => l.includes('选区标记'));
        ok(li >= 0, '夹具里找得到标记行');
        view.editor.setSelection({ line: li, ch: 0 }, { line: li, ch: 4 }); // 选中「独一无二」

        S.setFetchHandler(() => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(sse('好的')));
              c.close();
            },
          });
          return new Response(stream, { status: 200 });
        });
        const modal = openPanel();
        H.click(H.q<HTMLElement>(modal, '.kbw-ai-plusbtn'));
        await H.settle(30);
        H.click(
          H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
            H.textOf(i).includes('引用一篇笔记'),
          ) as HTMLElement,
        );
        await H.settle(30);
        // P7.10 · #12：小面板里「当前选区」恒在列表最上（有选区才画）
        const picker2 = H.q<HTMLElement>(document.body, '.kbw-ai-refpanel');
        const selItem = H.qa<HTMLElement>(picker2, '.kbw-ai-refitem').find((it) =>
          H.textOf(it).includes('当前选区'),
        );
        ok(selItem, '引用面板里有「当前选区」（桩现在有 getSelection 了）');
        H.click(selItem!);
        await H.settle(20);
        contains(H.textOf(H.q(modal, '.kbw-ai-ref')), '选区', '胶囊写着是选区');
        send(modal, '这选的是什么');
        await waitTurn(modal);
        const body = String(S.fetchLog[S.fetchLog.length - 1].init.body).replace(/\\n/g, '\n');
        contains(body, '选中自《__探针选区》的一段', '材料写清是"选中自某篇"');
        contains(body, '独一无二', '选区的原文进了提示词');

        leaf.detach();
        fs.rmSync(path.join(vaultRoot, refRel), { force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        purgeOverlays();
      });
    } finally {
      S.setFetchHandler(null);
      closeAllMenus();
      purgeOverlays();
      H.resetAi();
    }
  });
}
