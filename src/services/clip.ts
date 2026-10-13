/**
 * services/clip.ts —— **剪藏：URL → 一条笔记的原料**（P7.2c · 2c 段顺路塞的那件）
 *
 * 口径（2c 开工提示词 · Q1 拍板）：
 *   · 抓取走**平台 `requestUrl`**（绕 CORS —— 浏览器 fetch 过不去的大半页面它能过）；
 *   · **零运行时依赖**：正文靠手写粗剥（去 script/style → 优先 `<article>`/`<main>`，
 *     退回 `<body>` → 标签剥成文本、压空白）；**不引 readability 类库**；
 *   · 🔴 超时要短（~8s）、失败要降级：**这份解析永远不抛** —— 超时 / 打不开 /
 *     非网页 / 剥出来是空，一律返回 `kind: 'degraded'`，由调用方落成"标题+链接"的
 *     普通一条（"绝不阻塞浮层"是这条的设计承诺）。
 *
 * 🔴 **别碰 `res.json`**：平台的返回值里 `json` 是个 getter，2xx + 非 JSON 时会**抛**，
 * 而且那句 throw 在 try 之外、绕开错误分类（P6 段④ 真机教训，`坑/平台.md`）。
 * 一律 `res.text`。
 *
 * ⚠️ `requestUrl` **不能 abort**（AI 接口冻结说明里写过）—— 超时只是"不等了"，
 * 底下的请求自己跑完。所以这里用 `Promise.race` 而不是 AbortController。
 */
import { requestUrl } from 'obsidian';

/** 等网页的上限（Q1 拍的 ~8s）—— 超过就降级，不拖住用户 */
export const CLIP_TIMEOUT_MS = 8000;

export interface ClipResult {
  /** `ok` = 抓到正文；`degraded` = 没抓到（照落"标题+链接"一条，通知里如实说） */
  kind: 'ok' | 'degraded';
  /** 网页标题（拿不到就没有 —— 调用方别拿空串去覆盖用户自己写的标题） */
  title?: string;
  /** 剥好的正文（只有 `ok` 有） */
  text?: string;
  /** 降级原因（给人看的一句，进面板状态行与通知） */
  reason?: string;
}

/**
 * 这串看着像不像一条要打开的网址。
 * **一处实现两处用**：面板的"粘到哪儿都算"路由 + 抓取判据 —— 两处写两份必漂。
 */
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** 抓一条 URL（**永远 resolve**，失败走 `degraded`） */
export async function clipUrl(url: string, timeoutMs = CLIP_TIMEOUT_MS): Promise<ClipResult> {
  let res: { status: number; text: string; headers?: Record<string, string> };
  try {
    res = await withTimeout(requestUrl({ url }), timeoutMs);
  } catch (e) {
    if (e instanceof ClipTimeout) return { kind: 'degraded', reason: `超时了（等满 ${Math.round(timeoutMs / 1000)} 秒）` };
    return { kind: 'degraded', reason: '网络没通' };
  }
  if (res.status >= 400) return { kind: 'degraded', reason: `页面打不开（HTTP ${res.status}）` };
  /**
   * ⚠️ **content-type 有才判**：骨架级桩可能不给这个头，别把"没头"当"非网页"
   * （那是把桩的简陋判成产品降级 —— 判据会跟着假红）。
   * 🔴 **收编范围只到 HTML**（独立审 2026-10-04 🟡3，与 Q1 拍板的"非 HTML 就降级"对齐）：
   * 早先写成"非 html 且非 text 才降级"，会把 `text/javascript` / `text/csv` 这类
   * **源码文本**当"正文"存进笔记 —— 那不在拍板口径里。`application/xhtml+xml` 含 "html" ✓。
   */
  const ct = String(res.headers?.['content-type'] ?? '').toLowerCase();
  if (ct !== '' && !ct.includes('html')) {
    return { kind: 'degraded', reason: `不是网页（${ct.split(';')[0].trim() || '未知类型'}）` };
  }
  const parsed = extractReadable(String(res.text ?? ''));
  if (parsed.text === '') return { kind: 'degraded', reason: '页面里没剥出正文' };
  return { kind: 'ok', title: parsed.title || undefined, text: parsed.text };
}

class ClipTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ClipTimeout('clip-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 块级元素的名单：每个后面补一个换行，否则整页会粘成一行 */
const BLOCKS =
  'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,section,article,header,footer,blockquote,pre,tr,br,hr,figure,figcaption,table,dl,dt,dd,form';

/**
 * **零依赖粗剥**（导出直测）：HTML 文本 → `{ title, text }`。
 *
 * 步骤照 2c 提示词：去 `<script>/<style>` → 优先 `<article>`/`<main>`，退回 `<body>`
 * → 标签剥成文本、压空白；标题拿 `<title>`。
 * ⚠️ jsdom 与真机浏览器**都认 `DOMParser`**（测试环境在 `scripts/test.mjs` 里显式装了），
 * 所以这条能离线穷举 —— 不用"注入解析器"那种口子。
 */
export function extractReadable(htmlText: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const title = (doc.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
  if (!root) return { title, text: '' };
  const clone = root.cloneNode(true) as Element;
  for (const bad of Array.from(clone.querySelectorAll('script,style,noscript,template,svg,iframe'))) {
    bad.remove();
  }
  for (const b of Array.from(clone.querySelectorAll(BLOCKS))) {
    b.appendChild(doc.createTextNode('\n'));
  }
  const raw = clone.textContent ?? '';
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
