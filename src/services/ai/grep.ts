/**
 * services/ai/grep.ts —— **正文检索**（`grep` 工具）的纯逻辑件（P7.21b · #4）
 *
 * 「问我的库」的先行件：`search` 只搜标题 / 路径 / 属性（**不搜正文**），
 * 想在正文里找"哪几篇提到过某个词"就得一篇篇现扫。这个文件装两样**不碰盘**的东西：
 *
 * · `grepText()` —— 一篇文本里找**第一处**命中：行号 + 一句截断如实的上下文；
 * · `TextLru` —— 现扫的 **LRU 缓存**（键 = 路径，指纹 = mtime+size）。
 *   口径（开工提示词点名）：**现扫 + LRU 缓存，库变即失效，别上万能 watcher** ——
 *   指纹对不上就丢缓存重读，那是唯一一条失效规则（文件改成同 mtime 同 size 认不出，
 *   这是指纹式的固有边界，如实记着）。
 *
 * 为什么单独一个文件：与 `tools.ts` / `agent.ts` / `prompt.ts` / `tasks.ts` 同守一条
 * 隔离 —— **不许 import ui / modules / mover / obsidian**（纯逻辑，`tests/specs/redline.ts`
 * 的名单里加了它）。读盘那半在 `ui/ai-tools.ts` 的执行体（它才拿得到 `vault`）。
 *
 * ⚠️ 千篇级要不要上索引**不在本轮**（等 17.6 大库基线结论）—— 这里就是"扫一遍"，
 * 缓存的职责只是"同一篇别读两遍"。
 */

/** 一篇里的第一处命中：行号（1 起）+ 截断过的上下文 */
export interface GrepHit {
  line: number;
  excerpt: string;
}

/**
 * 找 `query` 在 `text` 里**第一处**命中（大小写不敏感 —— 与 `search` 同一口径）。
 * 没命中回 `null`。`snippetMax` = 上下文截断宽度（超了**两头对称地剪**并带省略号，
 * 让命中词尽量留在片段里；剪了就是剪了，省略号如实写）。
 */
export function grepText(text: string, query: string, snippetMax: number): GrepHit | null {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const idx = line.toLowerCase().indexOf(needle);
    if (idx < 0) continue;
    return { line: i + 1, excerpt: cutAround(line, idx, needle.length, snippetMax) };
  }
  return null;
}

/** 把命中那一行裁成 ≤ max 的一小段（命中词居中；两头剪了就写省略号） */
function cutAround(line: string, idx: number, needleLen: number, max: number): string {
  const s = line.trim();
  /** 行首空白被 trim 掉之后，命中下标要跟着往前挪 */
  const lead = line.length - line.trimStart().length;
  const at = Math.max(0, idx - lead);
  const width = Math.max(1, Math.floor(max));
  if (s.length <= width) return s;
  const head = Math.max(0, Math.floor((width - needleLen) / 2));
  let start = Math.max(0, at - head);
  start = Math.min(start, s.length - width);
  const piece = s.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${piece}${start + width < s.length ? '…' : ''}`;
}

/**
 * 现扫的 **LRU 缓存**：路径 → （指纹，正文）。
 *
 * 口径三条：
 *  · **指纹对不上 = 这条作废**（库变即失效）—— 删掉旧条目、回 `null`，由调用方重读；
 *  · **条数封顶**（LRU 淘汰最旧的）—— 别让缓存变成"另一份内存里的库"；
 *  · **总字符封顶**（P7.21b · 独立审 G5）：只封条数的话，200 条 × 单文件上限 512KB
 *    理论最坏 ~100MB 常驻 —— 加一条"总字符预算"，超了从最旧的开始淘汰。
 *    单条超过预算的正文**不进缓存**（读了就用、不留）。
 */
export class TextLru {
  private map = new Map<string, { fp: string; text: string }>();
  private total = 0;

  constructor(
    private cap: number,
    private maxChars = Number.POSITIVE_INFINITY,
  ) {}

  /** 命中且指纹一致回正文（并刷新新鲜度）；否则回 null（指纹不一致时顺手清掉旧条目） */
  get(path: string, fp: string): string | null {
    const hit = this.map.get(path);
    if (!hit) return null;
    if (hit.fp !== fp) {
      this.map.delete(path);
      this.total -= hit.text.length;
      return null;
    }
    this.map.delete(path);
    this.map.set(path, hit);
    return hit.text;
  }

  put(path: string, fp: string, text: string): void {
    // 单条就超预算：不进缓存（不然它自己就把别人全挤出去、还不一定塞得下）
    if (text.length > this.maxChars) return;
    const old = this.map.get(path);
    if (old) this.total -= old.text.length;
    this.map.delete(path);
    this.map.set(path, { fp, text });
    this.total += text.length;
    while ((this.map.size > this.cap || this.total > this.maxChars) && this.map.size > 0) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const gone = this.map.get(oldest);
      if (gone) this.total -= gone.text.length;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** 缓存里正文的总字符数（判据用） */
  get chars(): number {
    return this.total;
  }
}
