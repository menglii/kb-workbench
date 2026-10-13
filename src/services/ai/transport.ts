/**
 * services/ai/transport.ts —— **把"调模型"这一层单独摘出来**
 *
 * 为什么要有这个文件（交互规格 §11.2 第 4 条拍板）：
 * 整条链路（建议表 → 勾选 → 确认流 → `mover` → 留痕 → 撤销）**与模型无关**，
 * 而真调一次模型要花钱、要联网、**输出还会变** —— 探针那 90 多步每轮都真调，
 * 结果就是"失败集合每轮不一样"（本项目最贵的一类坑：把抖动读成功能坏了）。
 *
 * 于是：**`AiTransport` 是个接口**，默认实现走平台的 `requestUrl`；
 * 离线用例与真机探针**注入假响应**，只把"真实调用"单独做成**一条**判据去验。
 *
 * ## 协议：OpenAI 兼容（`POST <baseUrl>/chat/completions`）
 *
 * 选它是因为它同一份代码能覆盖 DeepSeek（默认）/ OpenAI / Kimi / 本地 vLLM…
 * ——用户拍的是「DeepSeek **或用户自己配置**」，这两件事在 OpenAI 兼容口下是**同一份实现**。
 *
 * 🔴 **刻意不发 `response_format: {type:'json_object'}`**：DeepSeek 与 OpenAI 支持它，
 * 但一堆本地/第三方兼容实现不支持，一发就是一个 400 —— 而它换来的好处
 * （强制 JSON）我们**已经用更稳的方式拿到了**：提示词写死格式 + `parseAdvice` 容错
 * （剥围栏、剥前后废话、括号配平）。兼容性优先。
 *
 * ## 两条不许破的纪律
 *
 * · **key 不进错误信息**：`requestUrl` 的异常可能带着整个请求；这里只抛**自己拼的**
 *   短语（状态码 + 服务端返回的一小段正文），**永不**带 headers。
 * · **`requestUrl` 的失败有两种**：抛异常（网络层）与 `status` 非 2xx（协议层）。
 *   我们传 `throw: false` 把两者**都收成返回值**，于是错误分类只有一处。
 *
 * ## P7.3a 增补：真流式（fetch + SSE）· 超时 · 取消（G4-C2 拍板：真流 + 自动降级）
 *
 * **真机 spike 实测**（2026-10-02，实验库 CDP）：
 *   · Obsidian 渲染进程的 `fetch` **能带 CORS 打到 DeepSeek**（预检全走，401 响应体可读）；
 *   · 真 key + `stream:true` **SSE 真流**：4 个增量块、首块 275ms。
 * 于是主路 = **`fetch` + SSE**；连接层失败（不吐 CORS 头的第三方/本地口、断网）→
 * **本文件自己降级**到 `chat()`（`requestUrl` 整包，不吐增量）——"不吐增量"就是
 * 面板切「打字机回放」的信号，**降级决策只在实现 `stream` 的这一层**，服务层不掺和。
 *
 * 三条口径：
 *   · **降级只发生在"一个增量都还没吐"时** —— 吐到一半断线再重发整包，用户会看到重复；
 *   · **降级的判定记在这个 baseUrl 上**（本实例内）—— 否则每个问题都要先吃一次
 *     连接失败的延迟（几百 ms 起步）；
 *   · **`requestUrl` 不能 abort**：非流式的"取消/超时"是 `Promise.race`，底下的请求
 *     会继续跑完，只是没人听 —— 所以取消在流式那一路才是真取消（`AbortController`）。
 *
 * ## P7.3c 增补：用量回传（17.10② 成本可见）· 采样温度
 *
 * · **返回形状从 `string` 换成 `AiReply`（`{text, usage?}`）** —— 接口冻结的一部分
 *   （`AI接口冻结-P7.3c.md`）。`usage` 只在该家吐得出来时才有，**认不出由调用方回落到
 *   本地字符估算并标注"估算"**（`cost.ts`），这一层不猜。
 * · 流式路会带 `stream_options.include_usage`；**不认它的网关**两种表现都接住了：
 *   忽略（没有 usage → 估算）/ 400（且一个增量都没吐 → 降级走整包，见下面那段注释）。
 * · `temperature` 由请求带（`AiChatRequest.temperature`，不传 = 0 = 3b 起的老行为）。
 *
 * ## P7.22b 增补：Anthropic 原生传输（#4 · 协议两路）
 *
 * `AiChatRequest.protocol`（缺省 = `'openai'` = 现状，老调用方与手写假件一个字不改）选路：
 * `'anthropic'` 走 **Messages API**（`POST <baseUrl>/v1/messages`）+ **prompt caching**
 * （system 块挂 `cache_control: ephemeral` —— 它长且稳定，缓存回报最大）。
 * **契约面不变**（`AiReply` / `AiError` 形状照旧，只是"实现加了一条路"）。口径四条：
 *   · **baseUrl 容错**：结尾的 `/` 归一；**结尾恰好是 `/v1` 也认**（照官方 SDK 习惯写成
 *     `https://api.anthropic.com`、或照 OpenAI 习惯写成 `…/v1`，两种都对）；
 *   · **`max_tokens` 必填**：Anthropic 没有"不限定"这回事 —— `maxTokens` 为 0/缺省时
 *     发一个保守兜底（`ANTHROPIC_FALLBACK_MAX_TOKENS`），别把一个必填字段漏成 400；
 *   · **temperature 夹到 [0, 1]**：设置里允许到 2（OpenAI 口径），Anthropic 超 1 会报错；
 *   · **浏览器直连要带头**：`anthropic-dangerous-direct-browser-access: true`
 *     （只影响 `fetch` 那条流式路；`requestUrl` 不需要，带了也无害）。
 * ⚠️ **缓存价不在单价表里**：usage 只如实回 `input_tokens` / `output_tokens`，
 * 费用照旧按基础单价估（别假装能算缓存命中的折扣）。
 */
import { requestUrl } from 'obsidian';
import type { AiMessage } from './prompt';

export interface AiChatRequest {
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: AiMessage[];
  /** 单次回话的 token 上限（防跑飞；设成 0/负数 = 不限定）。⚠️ anthropic 路必填，兜底见文件头 */
  maxTokens?: number;
  /** 采样温度（0–2）。**不传 = 0**（整理归类要的是稳定，见 `chat` 里那句注释）。⚠️ anthropic 路夹到 [0,1] */
  temperature?: number;
  /**
   * 传输协议（P7.22b · #4）：`'openai'`（缺省 = 现状）· `'anthropic'`（Messages API）。
   * 来源 = 设置里的「协议」下拉（`AiSettings.protocol`）——**选路的唯一来源**，
   * 不做 baseUrl 自动识别（显式、可测、覆盖中转代理域名）。
   */
  protocol?: 'openai' | 'anthropic';
}

/**
 * 服务端报的用量（17.10② 成本可见，P7.3c）。
 *
 * **认得出就用真的、认不出就回落到本地估算**（`cost.ts`）——
 * 所以它是可选的：本地模型 / 网关常常一个 `usage` 都不吐。
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 一次回话 = 文本 + （可能的）用量。**P7.3c 起返回形状从 string 换成它**（接口冻结的一部分） */
export interface AiReply {
  text: string;
  usage?: AiUsage;
}

/** 一次调用的运行时选项（P7.3a：5.6 的超时/取消 + 5.1a 的流式） */
export interface AiCallOptions {
  /** 用户取消（面板的「停止」）。**流式路 = 真取消**；非流式路 = 不再等它，底层请求自己跑完 */
  signal?: AbortSignal;
  /** 流式增量回调。**给了它、且传输层实现了 `stream`，才走流式** */
  onDelta?: (delta: string) => void;
}

/** 一条回话（成功时是助手那段文本 + 用量） */
export interface AiTransport {
  chat(req: AiChatRequest, opts?: AiCallOptions): Promise<AiReply>;
  /**
   * 流式（可选实现）。返回**完整文本与用量**（与 `chat` 同一个形状），增量经 `opts.onDelta` 吐出。
   * 允许自己降级成"整包 + 不吐增量"（见文件头）；**降级是这层的责任**，调用方只看有没有增量。
   */
  stream?(req: AiChatRequest, opts: AiCallOptions): Promise<AiReply>;
}

export type AiFailKind =
  /** 没配 key */
  | 'no-key'
  /** 401/403 —— key 不对或没权限 */
  | 'auth'
  /** 429 */
  | 'rate'
  /** 5xx */
  | 'server'
  /** 连不上（DNS / 超时 / 断网） */
  | 'network'
  /** 其它非 2xx */
  | 'http'
  /** 2xx 但回话里没有内容 */
  | 'shape'
  /** 用户自己按了「停止」（**不是错** —— 面板按"已停止"画，别画成红框） */
  | 'cancel'
  /** 等太久了（整体超时 / 流式空转超时） */
  | 'timeout';

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: AiFailKind,
    readonly status?: number,
    /** 服务端返回的正文片段（**已截断**；不含任何请求头） */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiError';
  }

  /** 给用户看的一句话（界面直接用这个，别各处自己 if/else 文案） */
  get hint(): string {
    switch (this.kind) {
      case 'no-key':
        return '还没配置 API key —— 设置 → AI 助手 里填上';
      case 'auth':
        return 'key 不对或没有权限（401/403）';
      case 'rate':
        return '被限流了（429），等一会儿再试';
      case 'server':
        return '对方服务器出错了（5xx），等一会儿再试';
      case 'network':
        return '连不上 —— 检查网络与 baseURL';
      case 'shape':
        return '对方回了内容，但没有可用的文本';
      case 'cancel':
        return '已停止';
      case 'timeout':
        return '等太久了 —— 检查网络，或给模型设一个更短的回答';
      default:
        return this.message;
    }
  }
}

/** 末尾斜杠归一：`https://x/v1/` 与 `https://x/v1` 是同一个口 */
export function joinUrl(baseUrl: string, path: string): string {
  const b = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return `${b}/${String(path).replace(/^\/+/, '')}`;
}

/**
 * 三个超时（毫秒）。G4 没把数值拿出来单拍 —— 取的是"远大于正常回答"的保守值：
 * 一次 `max_tokens: 1200` 的回答在常见 provider 上 60s 内都能完，120s 是"真出事了"的线。
 * `streamIdleMs` 管的是"流开着但一直没新内容"（provider 卡死 / 中间设备掐了连接）。
 */
export const AI_TIMEOUTS = {
  /** 非流式整体 */
  requestMs: 120_000,
  /** 流式：两个增量之间最多等多久 */
  streamIdleMs: 30_000,
  /** 流式整体上限（防"一直滴、滴不完"） */
  streamTotalMs: 300_000,
} as const;

/**
 * Anthropic `max_tokens` 的**兜底值**（P7.22b · #4）：那个 API 必填、没有"不限定"——
 * `maxTokens` 为 0/缺省时发它。4096 是"够大多数回答、又不会一次跑飞"的保守值。
 */
export const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096;

/** 选路归一：`'anthropic'` 之外一律按 `'openai'`（缺省 = 现状；手写假件不用改） */
export function protocolOf(req: { protocol?: 'openai' | 'anthropic' }): 'openai' | 'anthropic' {
  return req.protocol === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * anthropic 路的 URL：结尾 `/` 归一；**恰好以 `/v1` 结尾也认**（剥掉再拼 `/v1/messages`——
 * 用户照 OpenAI 习惯写到 `/v1` 时不该拼成 `/v1/v1/messages`）。
 */
export function anthropicMessagesUrl(baseUrl: string): string {
  let b = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(b)) b = b.replace(/\/v1$/i, '');
  // 顺手：把**整条 endpoint** 粘进来的也认（独立审 🟢3 —— 不剥会拼成 …/messages/v1/messages → 404）
  if (/\/v1\/messages$/i.test(b)) b = b.replace(/\/v1\/messages$/i, '');
  return joinUrl(b, 'v1/messages');
}

/** 请求头（两协议各一份；`forFetch` 时 anthropic 再带"浏览器直连"头 —— 官方 CORS 要求） */
export function headersFor(
  proto: 'openai' | 'anthropic',
  apiKey: string,
  forFetch = false,
): Record<string, string> {
  if (proto === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(forFetch ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    };
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

/**
 * 请求体（两协议各一份）。anthropic 侧四件：
 * system 单独拎出（块数组 + `cache_control` = prompt caching 的落点）、
 * `max_tokens` 必填兜底、temperature 夹 [0,1]、`stream: true` 直接嵌进来。
 */
export function buildChatBody(req: AiChatRequest, proto: 'openai' | 'anthropic', stream: boolean): string {
  const temp = req.temperature ?? 0;
  if (proto === 'anthropic') {
    const sys = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const rest = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const maxTok = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : ANTHROPIC_FALLBACK_MAX_TOKENS;
    return JSON.stringify({
      model: req.model,
      max_tokens: maxTok,
      // prompt caching：system 长且稳定，缓存回报最大；短于最小可缓存长度时被忽略、不报错
      ...(sys !== '' ? { system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: rest,
      temperature: Math.min(1, Math.max(0, temp)),
      ...(stream ? { stream: true } : {}),
    });
  }
  return JSON.stringify({
    model: req.model,
    messages: req.messages,
    // 整理归类这件事要的是稳定，不是创意（不传 = 0，与 3b 起的行为一致）
    temperature: temp,
    /**
     * 流式时让服务端把用量也吐出来（17.10②）——⚠️ **不是每家都认这个字段**：
     * 认不出的网关有两种表现（忽略它 = 没有 usage → 本地估算；或直接 400 →
     * 流式路那段"400 且一个增量都没吐"的降级接住）。
     */
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(req.maxTokens && req.maxTokens > 0 ? { max_tokens: req.maxTokens } : {}),
  });
}

/**
 * 可注入的依赖 —— **只为离线判据**：`fetch` 的 SSE 解析、降级、超时这些逻辑
 * 只有注入假 fetch 才能在没有网、没有 key 的套件里逐条验（真机那条只验"真的通"）。
 * 生产路径（`httpTransport()` 不带参）用平台 `requestUrl` + 全局 `fetch`。
 */
export interface HttpTransportDeps {
  requestUrl?: typeof requestUrl;
  /** `null` = 这个环境没有 fetch（强制走降级路）；不给 = 用全局的 */
  fetchImpl?: typeof fetch | null;
  /**
   * ⚠️ 别写成 `Partial<typeof AI_TIMEOUTS>` —— 那个常量是 `as const`，
   * 于是每一项都是**字面量类型**（`requestMs?: 120000`），注入 40ms 过不了编译。
   */
  timeouts?: Partial<{ requestMs: number; streamIdleMs: number; streamTotalMs: number }>;
}

/** 默认实现：`requestUrl`（整包）+ `fetch`（SSE 流）。见文件头两条纪律 */
export function httpTransport(deps: HttpTransportDeps = {}): AiTransport {
  const doRequest = deps.requestUrl ?? requestUrl;
  const t = { ...AI_TIMEOUTS, ...(deps.timeouts ?? {}) };
  /**
   * 已知"流式在这家不通"的 baseUrl（本实例内）。第一个问题吃一次连接失败，
   * 之后直接走整包 —— 见文件头第三条口径。
   */
  const streamBlocked = new Set<string>();

  function pickFetch(): typeof fetch | null {
    if (deps.fetchImpl !== undefined) return deps.fetchImpl;
    return typeof fetch === 'function' ? fetch : null;
  }

  /** 把 HTTP 状态码分级成 `AiError`（整包与流式共用，别写两份） */
  function classifyStatus(status: number, bodyText: string): AiError {
    const detail = bodyText.slice(0, 400);
    return new AiError(
      `HTTP ${status}`,
      status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate' : status >= 500 ? 'server' : 'http',
      status,
      detail,
    );
  }

  /**
   * 从响应体里取用量（17.10②）。OpenAI 兼容的形状是
   * `usage: {prompt_tokens, completion_tokens}`；anthropic 是
   * `usage: {input_tokens, output_tokens}`（**缓存命中字段不掺和** —— 见文件头那句）。
   * **认不出就返回 undefined**（调用方回落到本地字符估算并标注"估算" —— 本地模型 / 网关常常一个都不吐）。
   * 数字型字符串也认（有些网关把 token 数写成字符串）。
   */
  function pickUsage(json: unknown, proto: 'openai' | 'anthropic' = 'openai'): AiUsage | undefined {
    if (!json || typeof json !== 'object') return undefined;
    const numOf = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    };
    /**
     * ⚠️ **anthropic 的流式里 usage 有两个落点**（真机文档形状）：整包响应与
     * `message_delta` 在**顶层** `usage`，而 `message_start` 在 `message.usage` 下面 ——
     * 只认顶层会把 input_tokens 整段漏掉（第一版就这么漏的，判据当场逮住）。
     */
    let u: unknown = (json as { usage?: unknown }).usage;
    if (proto === 'anthropic' && (!u || typeof u !== 'object')) {
      u = (json as { message?: { usage?: unknown } }).message?.usage;
    }
    if (!u || typeof u !== 'object') return undefined;
    if (proto === 'anthropic') {
      const p = numOf((u as Record<string, unknown>).input_tokens);
      const c = numOf((u as Record<string, unknown>).output_tokens);
      if (p === null && c === null) return undefined;
      return { promptTokens: p ?? 0, completionTokens: c ?? 0 };
    }
    const p = numOf((u as Record<string, unknown>).prompt_tokens);
    const c = numOf((u as Record<string, unknown>).completion_tokens);
    if (p === null && c === null) return undefined;
    return { promptTokens: p ?? 0, completionTokens: c ?? 0 };
  }

  /**
   * 从响应体里取助手那段文本（整包路用；流式路的收尾兜底也用它）。
   * OpenAI 兼容的形状是 `choices[0].message.content`；但**有些实现**会给
   * `choices[0].text`、或者把 `content` 摆成数组（多模态那套）。三种都认。
   * anthropic 的形状是顶层 `content: [{type:'text', text}]` —— 只收 `type:'text'` 的块
   *（tool_use / thinking 那类块不是给用户看的话）。
   */
  function pickContent(json: unknown, bodyText: string, proto: 'openai' | 'anthropic' = 'openai'): string {
    const obj = (json ?? tryParse(bodyText)) as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') return '';
    if (proto === 'anthropic') {
      const content = (obj as { content?: unknown }).content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((b) =>
            b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
              ? String((b as { text?: unknown }).text ?? '')
              : '',
          )
          .join('')
          .trim();
      }
      return '';
    }
    const choices = (obj as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const c0 = choices[0] as Record<string, unknown>;
    const msg = c0?.message as Record<string, unknown> | undefined;
    const content = msg?.content ?? c0?.text;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : ''))
        .join('')
        .trim();
    }
    return '';
  }

  /**
   * 流式一块里的**文本增量**（两协议各一份，`stream()` 的 handleLine 用）：
   * OpenAI 在 `choices[0].delta.content`（或 `choices[0].text`）；
   * anthropic 只在 `{type:'content_block_delta', delta:{type:'text_delta', text}}` 里。
   */
  function deltaOf(obj: unknown, proto: 'openai' | 'anthropic'): string {
    if (!obj || typeof obj !== 'object') return '';
    if (proto === 'anthropic') {
      const o = obj as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
      if (o.type === 'content_block_delta' && o.delta?.type === 'text_delta' && typeof o.delta.text === 'string') {
        return o.delta.text;
      }
      return '';
    }
    const o = obj as { choices?: { delta?: { content?: unknown }; text?: unknown }[] };
    const d = o.choices?.[0]?.delta?.content ?? o.choices?.[0]?.text;
    return typeof d === 'string' ? d : '';
  }

  /**
   * 给一个 promise 加"取消 + 整体超时"（`requestUrl` 不能 abort，只能不再等它）。
   * `AbortSignal` 监听在 finally 里摘掉 —— 一次会话里问很多轮的话，不摘会攒监听器
   *（17.11 那类"卸载泄漏"的同一形状）。
   */
  async function raceCall<T>(p: Promise<T>, opts: AiCallOptions | undefined, ms: number): Promise<T> {
    const signal = opts?.signal;
    if (signal?.aborted) throw new AiError('已停止', 'cancel');
    let onAbort: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const guards: Promise<never>[] = [];
    if (signal) {
      guards.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new AiError('已停止', 'cancel'));
          signal.addEventListener('abort', onAbort);
        }),
      );
    }
    guards.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiError(`等待超过 ${Math.round(ms / 1000)} 秒`, 'timeout')), ms);
      }),
    );
    try {
      return await Promise.race([p, ...guards]);
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    }
  }

  const chat: AiTransport['chat'] = async (req, opts) => {
    const apiKey = String(req.apiKey ?? '').trim();
    if (apiKey === '') throw new AiError('没有 API key', 'no-key');
    const baseUrl = String(req.baseUrl ?? '').trim();
    if (baseUrl === '') throw new AiError('没有配置 baseURL', 'http');

    const proto = protocolOf(req);
    let res: Awaited<ReturnType<typeof requestUrl>>;
    try {
      res = await raceCall(
        doRequest({
          url: proto === 'anthropic' ? anthropicMessagesUrl(baseUrl) : joinUrl(baseUrl, 'chat/completions'),
          method: 'POST',
          headers: headersFor(proto, apiKey),
          body: buildChatBody(req, proto, false),
          // 非 2xx **不抛**：把两条失败路径收成一处（见文件头）
          throw: false,
        }),
        opts,
        t.requestMs,
      );
    } catch (e) {
      // raceCall 自己抛的取消/超时是 AiError，原样放行
      if (e instanceof AiError) throw e;
      // 走到这儿 = 网络层就失败了（DNS / 超时 / 断网）
      throw new AiError(
        `请求发不出去：${e instanceof Error ? e.message : String(e)}`,
        'network',
      );
    }

    const status = res.status ?? 0;
    const bodyText = typeof res.text === 'string' ? res.text : '';
    if (status < 200 || status >= 300) throw classifyStatus(status, bodyText);

    /**
     * 🔴 **`res.json` 是平台的 getter，2xx + 非 JSON 时它自己会抛**（独立审查 A🟡 抓到）——
     * 而那句 throw 发生在上面那个 try 的**外面**，于是它会以**原始异常**冒出去，
     * 绕开 `AiError` 的分类（界面上就成了一句看不懂的 `Unexpected token '<'`）。
     * 所以：**先用我们自己的 `tryParse(res.text)`**，`res.json` 只当兜底且也包起来。
     * （离线桩的 `json` 是个普通字段，永远不抛 —— 这条**只有真机能复现**，本轮未复现，
     *   按防御性修法处理，注释里记明这一点。）
     */
    let parsed: unknown = null;
    try {
      parsed = tryParse(bodyText);
    } catch {
      parsed = null;
    }
    if (parsed == null) {
      try {
        parsed = res.json;
      } catch {
        parsed = null;
      }
    }
    const text = pickContent(parsed, bodyText, proto);
    if (text === '') {
      throw new AiError('回话里没有可用文本（可能是 HTML 错误页或网关响应）', 'shape', status, bodyText.slice(0, 400));
    }
    return { text, usage: pickUsage(parsed, proto) };
  };

  /**
   * `fetch` + SSE。**降级与超时都在这层**（见文件头）：
   *   · 已知不通的 baseUrl → 直接 `chat()`（不吐增量 = 面板打字机）；
   *   · 一个增量都没吐时的连接失败 → 记下这个 baseUrl，改走 `chat()`；
   *   · 吐过增量再断 → 如实抛（重发整包会重复）。
   */
  const stream: AiTransport['stream'] = async (req, opts) => {
    const apiKey = String(req.apiKey ?? '').trim();
    if (apiKey === '') throw new AiError('没有 API key', 'no-key');
    const baseUrl = String(req.baseUrl ?? '').trim();
    if (baseUrl === '') throw new AiError('没有配置 baseURL', 'http');
    const f = pickFetch();
    if (!f) return chat(req, opts);
    if (streamBlocked.has(baseUrl)) return chat(req, opts);
    const proto = protocolOf(req);

    let res: Response;
    /**
     * 超时/取消统一走 `AbortController`（这次是真 abort）：
     *   · 外部 signal（用户按「停止」）→ 直接 abort；
     *   · 整体上限 + **空转计时**（每收到一段数据就重置）→ abort。
     * 谁 abort 的用一个标记区分，好把错误分成 cancel 与 timeout 两种。
     */
    const ac = new AbortController();
    let byUser = false;
    let byTimeout = false;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        byTimeout = true;
        ac.abort();
      }, t.streamIdleMs);
    };
    const onAbort = (): void => {
      byUser = true;
      ac.abort();
    };
    if (opts.signal?.aborted) throw new AiError('已停止', 'cancel');
    opts.signal?.addEventListener('abort', onAbort);
    totalTimer = setTimeout(() => {
      byTimeout = true;
      ac.abort();
    }, t.streamTotalMs);
    armIdle();

    const cleanup = (): void => {
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    try {
      res = await f(
        proto === 'anthropic' ? anthropicMessagesUrl(baseUrl) : joinUrl(baseUrl, 'chat/completions'),
        {
          method: 'POST',
          // anthropic 的 fetch 路要带"浏览器直连"头（官方 CORS 要求，见 headersFor）
          headers: headersFor(proto, apiKey, true),
          // 请求体两协议各一份，见 buildChatBody
          body: buildChatBody(req, proto, true),
          signal: ac.signal,
        },
      );
    } catch (e) {
      cleanup();
      if (ac.signal.aborted) {
        if (byUser) throw new AiError('已停止', 'cancel');
        throw new AiError('流式等待超时', 'timeout');
      }
      /**
       * `fetch` 的连接层失败 = `TypeError`（CORS 被拦 / DNS / 断网，Chromium 分不出来）。
       * 这里**降级**：记下这个 baseUrl，走整包 —— 这正是不吐 CORS 头的 provider 的活路。
       */
      streamBlocked.add(baseUrl);
      return chat(req, opts);
    }

    /**
     * ⚠️ `emitted` / `full` / `buffer` 声明在 try **外面**：读流中途断线时，
     * catch 里要靠 `emitted` 决定"如实抛错"还是"降级重发"（吐过一半再重发 = 重复）。
     */
    let emitted = false;
    let full = '';
    let buffer = '';
    let raw = '';
    /** 流式路的用量（末块才有；认不出就是 undefined） */
    let usage: AiUsage | undefined;
    try {
      const status = res.status ?? 0;
      if (status < 200 || status >= 300) {
        /**
         * 🔴 **400 且一个增量都没吐 = 大概率是"这家不认我们加的请求字段"**
         * （`stream_options.include_usage` 是本轮新加的；有些本地/第三方口会对未知字段
         * 直接 400）→ 与连接层失败同一条处置：记下这个 baseUrl、**降级走整包**
         * （整包路不带宽限字段），而不是把一次能成的调用废在"HTTP 400"上。
         *
         * ⚠️ 只认 400：401/403（auth）、429（rate）、5xx（server）**换条路也一样**，
         * 如实分类往下抛 —— 把它们也降级会多打一次注定失败的请求。
         */
        const bodyText = await res.text().catch(() => '');
        if (status === 400 && !emitted) {
          streamBlocked.add(baseUrl);
          return chat(req, opts);
        }
        throw classifyStatus(status, bodyText);
      }
      const reader = res.body?.getReader();
      if (!reader) {
        // 理论上 fetch 总有 body；没有就当形状不对（别假装成功）
        const bodyText = await res.text().catch(() => '');
        const text = pickContent(null, bodyText, proto);
        if (text === '') throw new AiError('流式响应没有可读的正文', 'shape', status, bodyText.slice(0, 400));
        opts.onDelta?.(text);
        return { text, usage: pickUsage(tryParse(bodyText), proto) };
      }

      const decoder = new TextDecoder();
      const handleLine = (line: string): void => {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed.startsWith('data:')) return; // 空行、注释、event: 行都跳过
        const payload = trimmed.slice(5).trim();
        if (payload === '') return;
        if (payload === '[DONE]') return;
        const obj = tryParse(payload);
        /**
         * 用量块常常是"`choices` 空数组 + 只有 usage"那一块（anthropic 则来自
         * message_start / message_delta）—— 必须在下面那个 return **之前**收。
         * ⚠️ **按字段取大合并**：anthropic 分两拍报（start 给 input、delta 给 output），
         * 直接覆盖会把前一拍抹掉；openai 只在末块报一次，取大同样安全。
         */
        const u = pickUsage(obj, proto);
        if (u) {
          usage = {
            promptTokens: Math.max(usage?.promptTokens ?? 0, u.promptTokens),
            completionTokens: Math.max(usage?.completionTokens ?? 0, u.completionTokens),
          };
        }
        const piece = deltaOf(obj, proto);
        if (piece === '') return;
        emitted = true;
        full += piece;
        opts.onDelta?.(piece);
        armIdle(); // 有内容 = 连接还活着
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        const chunkText = decoder.decode(value, { stream: true });
        raw += chunkText; // 整包疑似（非 SSE）时的兜底原文 —— buffer 会被逐行切空，不能拿它当全文
        buffer += chunkText;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      }
      if (buffer !== '') handleLine(buffer);
      /**
       * 一个增量都没吐：可能是"provider 收了 stream:true 却回整包 JSON"。
       * 按整包再解析一次 —— 解析出来就直接当一次增量交给面板（它照常显示）。
       * 什么都没有（含"只有 `[DONE]`"的空回答）→ **与整包路一致地抛 shape**
       *（独立审查 🟢4：原先这里 return ''，而服务层的 parseAdvice('') 会把空串
       * 当聊天轮收下 —— 两条路对"空回答"的处理不一致，注释还是错的）。
       */
      if (!emitted) {
        const parsed = tryParse(raw);
        const text = pickContent(parsed, raw, proto);
        if (text !== '') {
          opts.onDelta?.(text);
          return { text, usage: pickUsage(parsed, proto) ?? usage };
        }
        throw new AiError('流式响应里没有可用的文本', 'shape', status, raw.slice(0, 200));
      }
      /**
       * `trim()` 与整包路（`pickContent` 那边）**同一个口径** —— 冻结说明里
       * `AiReply.text`"已 trim"那句话得是真的（独立审查 🟢6 抓的：流式路原先没 trim）。
       */
      return { text: full.trim(), usage };
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (byUser) throw new AiError('已停止', 'cancel');
      if (byTimeout) throw new AiError('流式等待超时', 'timeout');
      // 吐过增量再断：如实抛（重发整包会重复）
      if (emitted) throw new AiError(`流式读到一半断了：${e instanceof Error ? e.message : String(e)}`, 'network');
      // 一个增量都没吐：当连接层问题处理 —— 降级走整包
      streamBlocked.add(baseUrl);
      return chat(req, opts);
    } finally {
      cleanup();
    }
  };

  return { chat, stream };
}

function tryParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
