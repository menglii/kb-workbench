/**
 * modules/board/summary.ts —— 卡面正文的取数与**行号对齐**（交互规格 §4.3 / §4.2）
 *
 * 两件事，都是纯函数（能离线钉住）：
 *
 * ① **摘要取数**：剥前言 → 剥结尾「关联笔记」段（含上面的分隔线）→ 与卡片标题同名的
 *    首个 H1 抹成空行（**不是删掉**，见下面那段注释）。判据全部复用现成的：
 *    `frontmatter.ts` 的 `stripFrontmatter`、`templates.ts` 的 `stripTailSection`
 *    （**不在这里再写一份**）。空行不专门收 —— 渲染器自己会吞掉。
 *
 * ② **勾选框 ↔ 源文行号**（§4.2「第 n 个框 ↔ 第 n 条任务行对齐；框数对不上宁可不绑」）：
 *    卡面渲染的是**剥过的正文**，而写回要改**整个文件**。两者的行号差 = 剥前言
 *    去掉的行数（剥尾链只从末尾切，不影响前面的行号）。`cardBody()` 把那个偏移量
 *    一起交出来，`toggleTaskLine()` 按**绝对行号**改，于是"框 ↔ 行"永远对得上。
 */
import { stripFrontmatter } from '../../services/frontmatter';
import { stripTailSection } from '../../services/templates';

export interface BodyOptions {
  stripFrontmatter: boolean;
  stripTail: boolean;
  /** 自定义剥离标记（§4.3 可配） */
  markers: string[];
  /** 卡片标题（与它同名的首个 H1 会被去掉 —— 免得卡面第一行又是标题） */
  title: string;
}

export interface CardBody {
  /** 卡面要渲染的正文 */
  text: string;
  /** `text` 的第 0 行 = 原文件的第 `lineOffset` 行（0 基） */
  lineOffset: number;
  /** 原文里有没有前言（界面上"剥前言"开关的提示用） */
  hadFrontmatter: boolean;
  /** 原文里有没有尾部双链段 */
  hadTail: boolean;
}

function countLines(s: string): number {
  return s === '' ? 0 : s.split('\n').length;
}

export function cardBody(full: string, o: BodyOptions): CardBody {
  let text = full;
  let lineOffset = 0;

  if (o.stripFrontmatter) {
    const stripped = stripFrontmatter(text);
    if (stripped !== text) {
      // ⚠️ 偏移量必须按**实际去掉的行数**算，不能假设"前言总是 4 行"
      lineOffset += countLines(text) - countLines(stripped);
      text = stripped;
    }
  }
  const hadFrontmatter = lineOffset > 0;

  let hadTail = false;
  if (o.stripTail) {
    const markers = o.markers.length > 0 ? o.markers : ['## 关联笔记'];
    const stripped = stripTailSection(text, markers);
    hadTail = stripped !== text;
    text = stripped;
  }

  /**
   * 首个 H1 与标题同名 → **抹成空行**（卡面标题已经写了，再显示一遍是噪音）。
   *
   * 🔴 必须是"抹掉"而不是"删掉这一行"（P4 独立审查的真 bug）：
   * 删一行会让它**后面每一行的行号都前移 1**，而 `lineOffset` 是一个标量 ——
   * 「卡面第 n 行 = 原文第 n + lineOffset 行」这个承诺当场作废，
   * **勾选框会写到上面那一行**。模板产出的笔记首行就是 `# 文件名`
   * （P4 基线夹具 71 篇里 17 篇是这个形状、其中 6 篇有任务行），所以这条不是边角。
   * 抹成空行则行数不变、偏移量仍然成立；渲染上完全等价（空行在 Markdown 里不产出东西）。
   */
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && /^#\s+/.test(lines[i]) && lines[i].replace(/^#\s+/, '').trim() === o.title.trim()) {
    lines[i] = '';
    text = lines.join('\n');
  }
  return { text, lineOffset, hadFrontmatter, hadTail };
}

// ────────────────────────────────────────────────────────────────
// 任务行（勾选框写回）
// ────────────────────────────────────────────────────────────────
export interface TaskItem {
  /** 在**卡面正文**里的 0 基行号 */
  line: number;
  checked: boolean;
  /** 这一行的文字（去掉标记，给人看/给报告用） */
  text: string;
}

/**
 * 任务行：`- [ ] x` / `* [x] x` / `+ [ ] x` / `1. [ ] x` —— **有序清单也算**。
 * ⚠️ marker 与 `[` 之间**只许 1–4 个空格/Tab**：超过 4 个时清单项的第一块是**缩进代码块**
 *（内容列 = marker 后一列），里面的 `[ ]` 是代码、**不画勾选框**（独立审查 🔴2 的形状 f）。
 */
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]{1,4}\[([ xX])\]\s?/;
/** 行首到勾选框为止的那一段（写回时原样保留：缩进、`>`、序号都不许改形） */
const TASK_HEAD_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;
/** 任何清单项（不只任务行）—— 判"缩进算不算清单项"要看它们撑出来的层级。
 *  三段：缩进 / marker / marker 后的空白（内容列要按 marker + 空白算，见 `markerPad`）*/
const LIST_RE = /^(\s*)((?:[-*+]|\d+[.)]))(\s+)/;

/**
 * 空白串的**视觉宽度**：Tab 一律算 **4 格**（不是"展开到下一个制表位"）。
 *
 * 🔴 这条被**真机实测**纠正过一次（2026-09-26，e2 期收尾）—— 别照着 CommonMark 的
 * 规格正文想当然：按规格"Tab 补到下一个制表位（4 格一档）"的话，`  \t`（2 空格 + Tab）
 * 会算成列 4、判成"父项的子项"；而真机渲染器**不给它画框**。逐条量出来的表（父项内容列 = 2）：
 *
 * | 缩进 | 按"制表位" | 按"Tab=4" | 真机画框吗 |
 * |---|---|---|---|
 * | ` \t`（1 空格 + Tab） | 4 | 5 | **画** |
 * | `  \t`（2 空格 + Tab） | 4 | 6 | **不画** |
 * | `   \t`（3 + Tab） | 4 | 7 | **不画** |
 * | `\t `（Tab + 1 空格） | 5 | 5 | **画** |
 * | `     `（5 空格） | 5 | 5 | **画** |
 * | `      `（6 空格） | 6 | 6 | **不画** |
 *
 * 只有"Tab=4"这一列与真机的画/不画**逐条对得上**（判据是 `indent - 父内容列 <= 3`）。
 * 至于为什么 —— 可能是打包进来的 micromark 对 Tab 的处理与规格正文有出入，
 * 但**判据以真机为准**（"口径不一致就整张卡只读"的代价太大，不值得赌规格）。
 */
function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

/**
 * 清单项**内容列**相对缩进的宽度 = marker + 它后面的空白。
 * ⚠️ marker 后超过 4 个空白时，内容列只到 marker+1（剩下那 4 格开一个缩进代码块）——
 * 独立审查 🔴2 的形状 f（`-     [ ] a`）就是靠这一条认出"那不是一个勾选框"的。
 */
function markerPad(spaces: string): number {
  return spaces.length <= 4 ? spaces.length : 1;
}

/**
 * 卡面正文里的任务行，按出现顺序（第 n 个 = 渲染出来的第 n 个勾选框）。
 *
 * 🔴 **只留"渲染器真的会画勾选框"的那些行**（a.6 修的真机 bug）——
 * 原先这里是"只要长得像任务行就算"，而渲染器（CommonMark）还有一条**缩进**规则：
 * 缩进比所在清单项的内容列**深超过 3 格**的行，不算新的清单项，而是上一段的**续行**
 * （渲染成普通文字，不生成勾选框）。
 *
 * 真机撞到的形状（实验库 `9.20.md`，用户自己写的笔记）：
 * ```
 * - [x] 终末地
 *     - [x] 战争回响
 * \t\t    - [x] 刷活动      ← 8 空格 + 4 空格 = 12 格，比父项的内容列(6)深 6 格
 * ```
 * 源文件里 34 条任务行、渲染出来只有 33 个框 → 两边**永久对不上** →
 * 老口径"对不上就不绑"的后果是**那一篇的每一个框都点不动**
 *（而且真机上框**根本不是 disabled 的**，"不绑"看着就是"点了没反应"，见 `bindTaskBoxes`）。
 *
 * 判据就是这一条缩进规则（不重写整个 CommonMark 解析器，够用即可）：
 * 维护一叠"还开着的清单项的内容列"，某行的缩进不超过栈顶 + 3 才算清单项。
 *
 * ── 这套规则**不是**完整的 CommonMark 块解析器：**已知缺口**（后果都是"整张卡只读"）──
 *  ① **引用块里的任务行**（`> - [ ] x`）：真机渲染器**会**给它画框（2026-09-26 实测），
 *     这里认不出（`>` 不在 `\s` 里）。要支持得连 `setTaskLine` 的写回一起把 `>` 前缀算进去。
 *  ② **HTML 块里的任务行**：⚠️ 真机实测（2026-09-26）**没有这个问题** ——
 *     `<div>` / `- [ ] x` / `</div>` 那种形状，渲染器照样画框，我们的条数**与它一致**。
 *     （独立审查当初按 CommonMark 规格推断"HTML 块里不解析清单"，实测不成立 —— 以真机为准。）
 *  ③ 更深的块结构（引用块套清单、表格里的 `- [ ]`、松紧列表的边界）同理。
 *
 * ⚠️ 四条口径（e2 期独立审查 🔴2 逐条对齐过）：栈空时也按"缩进 ≥4 = 缩进代码块"判；
 * Tab 按**制表位**展开；marker 后 >4 空格时内容列只到 marker+1；空行 + 顶格段落会关掉清单。
 *
 * 为什么"多收/少收"都算坏：`bindTaskBoxes` 的判据是 `boxes.length !== tasks.length`，
 * 任一边偏了都会让**那篇的每一个框被按成只读**（比老口径的"点了没反应"好，但仍是功能退化）。
 * 想真正钉住这些形状只能在**真机**上量（探针 `e2 · 勾一下不跳` 那一步就在读 `data-task-mismatch`）。
 */
export function taskItems(body: string): TaskItem[] {
  const out: TaskItem[] = [];
  const lines = body.split('\n');
  /**
   * ⚠️ 只在**围栏代码块之外**找任务行：代码块里写 `- [ ]` 是示例文本，不是待办，
   * 而渲染出来的代码块里**没有勾选框** —— 不排除的话框数与行数对不上，
   * 整张卡片的勾选就再也不绑定了（"宁可不绑"会退化成"永远不绑"）。
   */
  let fence: string | null = null;
  /** 还开着的清单项的**内容列**（缩进 + 标记宽度），由浅到深 */
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    const f = t.match(/^(```+|~~~+)/);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    /**
     * 先判"这一行算不算清单项"（见 `taskItems` 头注释里那条缩进规则）——
     * **任何**清单项都要参与（不只任务行）：层级是它们共同撑起来的。
     */
    const L = lines[i].match(LIST_RE);
    if (L) {
      const indent = indentWidth(L[1]);
      // 比栈顶浅 = 上面那些项在本行之前已经结束
      while (stack.length > 0 && indent < stack[stack.length - 1]) stack.pop();
      const top = stack.length > 0 ? stack[stack.length - 1] : 0;
      /**
       * 深超过 3 格就不是清单项了（是上一段的续行）→ 渲染器不会给它画勾选框。
       * 🔴 **栈空时一样判**（文档根的内容列 = 0）：缩进 ≥4 就是**缩进代码块**
       *（独立审查 🔴2 的形状 a/b/c —— 老代码那句 `stack.length === 0 ||` 是错的）。
       */
      const isItem = indent - top <= 3;
      if (!isItem) continue;
      stack.push(indent + L[2].length + markerPad(L[3]));
    } else if (lines[i].trim() !== '') {
      /**
       * **非空、又不是清单项的一行 —— 它可能把上面的清单关掉**（独立审查 🔴2 的形状 e）：
       * CommonMark 里"空行 + 顶格段落"就结束了那个清单，之后 4 空格缩进是代码块。
       * ⚠️ 引用块 / HTML 那类前缀**不参与**（保守）：误关会让本该收的任务行收不到，
       * 而"少收"和"多收"都会落进"整张卡只读"，宁可不动它。
       */
      if (!/^\s*[<>]/.test(lines[i])) {
        const indent = indentWidth((lines[i].match(/^\s*/) ?? [''])[0]);
        while (stack.length > 0 && indent < stack[stack.length - 1]) stack.pop();
      }
    }

    const m = lines[i].match(TASK_RE);
    if (m) out.push({ line: i, checked: m[1].toLowerCase() === 'x', text: lines[i].replace(TASK_RE, '').trim() });
  }
  return out;
}

/**
 * 把原文某一行（**绝对行号**）的勾选态**设成 `checked`**。
 *
 * 为什么不是"翻转"：交给它的是勾选框**现在的状态**（渲染器已经把框画成勾上了），
 * 按目标态写才是幂等的 —— 翻转在"文件已经是对的"时会写反（重复点击、外部已改都踩得到）。
 * 不是任务行、行号越界、本来就是这个状态 → **原样返回**，调用方据此判断有没有写成功。
 */
export function setTaskLine(full: string, absLine: number, checked: boolean): string {
  const lines = full.split('\n');
  if (absLine < 0 || absLine >= lines.length) return full;
  const line = lines[absLine];
  const m = line.match(TASK_HEAD_RE);
  if (!m) return full;
  const want = checked ? 'x' : ' ';
  if (m[2] === want) return full;
  lines[absLine] = line.replace(TASK_HEAD_RE, `$1${want}$3`);
  return lines.join('\n');
}
