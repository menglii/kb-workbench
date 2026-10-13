/**
 * services/fm-repair.ts —— **「坏前言」的文本层修复**（P7.16 · #3，拍定 D5）
 *
 * 为什么单独一层：这类前言**不能走 `fm.setMany` / `processFrontMatter`**
 * （守卫（`fragileKeys`）就是为它设的；解析再序列化一次往返就把形状弄坏）——
 * 修法一律「读原文 → 按行改 → `vault.process` 写回」。本文件只做**纯文本手术**：
 * 不解析 YAML、不碰 metadataCache、不写盘（写盘在 `ui/fm-repair-panel.ts` 的链上）。
 *
 * 两档修法：
 *   · **确定性**（`fixBarePlaceholders`）：认得形状的当场修 —— 整行就是一个裸占位符
 *     （`创建日期: {{date}}`）→ 加引号存。手法照 `migrate.ts` 的「占位符引号存法」，
 *     同为"按行改、不解析 YAML"；**认不出的行原样留**（同 migrate 的口径）→ 交 AI 档。
 *   · **AI 档**：`services/ai` 出"修好的前言这段文本"，落盘前过 `validateFmRepair`
 *     （键一个不少、坏形状没了、没有围栏漏进来）——**不过检查就不写**。
 *
 * ⚠️ 前言块的识别**不在这里另立一套**：走 `frontmatter.ts` 的 `splitFrontmatter`
 * （与 `stripFrontmatter` / `hasFrontmatter` 同一套"什么算前言"）——`head` 是原文的
 * 前缀，重建 = 新围栏段 + 原文的收尾围栏（含其后空行）+ 正文，**前后文一个字节不动**。
 */
import { splitFrontmatter } from './frontmatter';
import { topKeyOf } from './templates';

/** 一处确定性修（预览与日志用；`line` 是前言块内行号，仅诊断用） */
export interface FmLineFix {
  line: number;
  /** 键名（预览里点名） */
  key: string;
  from: string;
  to: string;
}

/**
 * **整行就是一个裸占位符**（`键: {{…}}`）—— 确定性修唯一认得的形状。
 *
 * 四条边界（都往"少修"一侧收，认不出就走 AI 档）：
 *   · 键必须**顶格**（与 `topKeyOf` 的"缩进行不算顶层键"同一条；缩进行可能是块标量
 *     / 嵌套映射里的内容，那不该被我们当属性行改）；
 *   · `:[ \t]+` —— 冒号后必须有空白（YAML 的映射语法要求；`键:{{x}}` 那种压根不是
 *     映射，属于"YAML 坏了"的另一族，不在这里修）；
 *   · 值必须**整行就是一个** `{{…}}`（占位符前后只有空白；`{{a}} {{b}}`、带尾注释
 *     这些都不认）；
 *   · `[^{}]*` —— 占位符里再套花括号的不认（"整行就是那个裸占位符"的加严）；
 *   · 注释行不认（`^[^#\s]` 挡掉）。
 */
const BARE_PLACEHOLDER_LINE = /^([^#\s][^:\n]*:[ \t]+)(\{\{[^{}]*\}\})([ \t]*)$/;

/** 引号存法：优先双引号；内容里本来有双引号 → 退回单引号存（内部单引号翻倍转义） */
export function quotePlaceholder(v: string): string {
  if (v.includes('"')) return `'${v.replace(/'/g, "''")}'`;
  return `"${v}"`;
}

/**
 * 前言这一段原文（**不含围栏**；null = 没有规范前言块或开头不是 `---`）。
 * ⚠️ 判据即 `splitFrontmatter`（`head` 非空且首行是 `---`、"收尾围栏"同一条正则）。
 */
export function frontmatterInnerOf(text: string): string | null {
  const head = splitFrontmatter(String(text ?? '')).head;
  if (head === '') return null;
  const lines = head.split('\n');
  if (lines[0].trimEnd() !== '---') return null;
  const close = closeFenceIndex(lines);
  if (close < 0) return null;
  return lines.slice(1, close).join('\n');
}

function closeFenceIndex(lines: string[]): number {
  // 与 `stripFrontmatter` 的收尾判据**同一条正则**（改那边时一起看这里）
  for (let i = 1; i < lines.length; i += 1) if (/^---[ \t]*$/.test(lines[i])) return i;
  return -1;
}

/**
 * **把前言整段换成 `newInner`**（前后文一个字节不动）。不成功时原样返回、`ok: false`：
 *   · 没有规范前言块 / 新稿里混进了 `---` 围栏行 → 拒（宁可不写，也不要把文件改坏）。
 *
 * ⚠️ `head` 是 `text` 的前缀（`splitFrontmatter` 的切法），重建 = `---` + 新内文 +
 * `head` 里"收尾围栏及其后的空行" + body —— 收尾围栏后的排版空行按原样还回去。
 */
export function replaceFmInner(text: string, newInner: string): { text: string; ok: boolean } {
  const src = String(text ?? '');
  const { head, body } = splitFrontmatter(src);
  if (head === '') return { text: src, ok: false };
  const lines = head.split('\n');
  if (lines[0].trimEnd() !== '---') return { text: src, ok: false };
  const close = closeFenceIndex(lines);
  if (close < 0) return { text: src, ok: false };
  const inner = String(newInner ?? '').split('\n');
  if (inner.some((l) => /^\s*---\s*$/.test(l))) return { text: src, ok: false };
  const tail = lines.slice(close); // 收尾围栏行 + 其后空行（原样保留）
  const newHead = ['---', ...inner, ...tail].join('\n');
  return { text: newHead + body, ok: true };
}

/**
 * **确定性修**：把认得出形状的裸占位符加引号存（按行改、不解析 YAML）。幂等
 * （改过的行不再匹配）。返回改后的全文 + 每一处改动（预览/日志用）。
 */
export function fixBarePlaceholders(text: string): { text: string; fixes: FmLineFix[] } {
  const src = String(text ?? '');
  const inner = frontmatterInnerOf(src);
  if (inner == null) return { text: src, fixes: [] };
  const lines = inner.split('\n');
  const fixes: FmLineFix[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = BARE_PLACEHOLDER_LINE.exec(lines[i]);
    if (!m) continue;
    const to = `${m[1]}${quotePlaceholder(m[2])}${m[3]}`;
    const key = m[1].replace(/:[ \t]*$/, '').trim();
    fixes.push({ line: i, key, from: lines[i], to });
    lines[i] = to;
  }
  if (fixes.length === 0) return { text: src, fixes: [] };
  const r = replaceFmInner(src, lines.join('\n'));
  return r.ok ? { text: r.text, fixes } : { text: src, fixes: [] };
}

/** 顶格 `键:` 的键清单（缩进行 / 注释不算；判据借 `templates.topKeyOf` —— 全仓同一份） */
export function topLevelKeysOf(inner: string): string[] {
  const out: string[] = [];
  for (const line of String(inner ?? '').split('\n')) {
    const key = topKeyOf(line);
    if (key != null && key !== '' && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * **AI 稿落盘前的检查**（不过检查就拒绝应用 —— 宁可不修，也不要悄悄弄丢一个键）：
 *   · 键一个不少、一个不多（修的是"值的形状"，不是"补属性"）；
 *   · 坏形状没了（还剩整行裸占位符 = 没修干净）；
 *   · **没有任何围栏行**（`---` / ``` / `~~~` 三种都拦 —— 独立审 🟡：只拦 `---` 时，
 *     模型把整段包进裸 ``` 会被原样写进前言 → 整份前言变非法 YAML、**属性全消失**）；
 *   · **每个顶格行都得是"前言该有的行"**（键 / 列表项 / 注释）—— 散文行（如
 *     「以下是修复稿」）同样会把前言写坏，也在拦之列。
 */
const FENCE_LINE = /^\s*(---|```|~~~)\s*$/;
const LIST_ITEM_LINE = /^\s*-\s+/;

export function validateFmRepair(
  beforeInner: string,
  afterInner: string,
): { ok: boolean; why: string } {
  const before = topLevelKeysOf(beforeInner);
  const after = topLevelKeysOf(afterInner);
  const lost = before.filter((k) => !after.includes(k));
  if (lost.length > 0) return { ok: false, why: `丢掉了原有的键（${lost.join('、')}）` };
  const added = after.filter((k) => !before.includes(k));
  if (added.length > 0) return { ok: false, why: `多出了原来没有的键（${added.join('、')}）` };
  if (afterInner.split('\n').some((l) => BARE_PLACEHOLDER_LINE.test(l))) {
    return { ok: false, why: '还有裸占位符没加引号' };
  }
  for (const line of afterInner.split('\n')) {
    if (FENCE_LINE.test(line)) return { ok: false, why: `混进了围栏行（${line.trim()}）` };
    if (/^\s/.test(line) || line.trim() === '') continue; // 缩进行 / 空行：结构由键行与列表决定
    if (line.trimStart().startsWith('#')) continue; // 注释（原样保留是允许的）
    if (LIST_ITEM_LINE.test(line)) continue; // 列表项（上一个键的值）
    if (topKeyOf(line) != null) continue; // 顶格键行
    return { ok: false, why: `前言里冒出了不是键/列表/注释的行：「${line.trim().slice(0, 24)}」` };
  }
  return { ok: true, why: '' };
}
