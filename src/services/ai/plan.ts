/**
 * services/ai/plan.ts —— **AI 的建议 → 可执行的移动计划**（交互规格 §11.1 边界 ③ 的实现点）
 *
 * 🔴 **这个文件是"AI 能不能动库"的唯一闸门**。`ui/ai-panel.ts` 只负责画；
 * 它拿到的每一行都必须先过这里 —— 过了的行进 `rows`，没过的行进 `blocked` 并**写明原因**。
 * 于是"界面上不提供那个入口"这种软拦法在这里是不成立的：**建议里带了它，也执行不了**。
 *
 * ## 为什么要它（三条各自挡一种）
 *
 * 1. **不许碰 `03_AI指令集/`**（§11 边界 ③）。§11 原文点的是里面那个 `AI操作规范` 文件，
 *    这里拦的是**整个目录** —— "把文件从指令集里搬出去"与"改它"在效果上是同一件事，
 *    拦目录是拦文件的安全超集。
 * 2. **落点必须是库里真有的目录**。模型很容易编一个听起来对的目录名
 *    （`01_Projects/进行中` 而库里叫 `01_执行中`）—— 那种行要在**动库之前**就掉下来，
 *    而不是等 `mover` 建出一个用户没要过的新目录（`mover` 会 mkdir 缺失的祖先，那是给 P5 骨架用的）。
 * 3. **源文件必须真在库里、且落点与现在不同**。"搬到自己所在目录"在 `mover` 里是 `already`
 *    （静默没事发生），但在这里就是一条**假建议** —— 用户勾了、点了执行、什么都没发生，
 *    然后开始怀疑整个功能。
 *
 * ## 两种目录口径（坑/动库.md 的那条红线，这里栽过一次就够）
 *
 * **模型输出的是"相对库根"的路径**（`00_Inbox/x.md`、`01_Projects/01_执行中`）——
 * 那是用户视角的写法，也是属性 `文件位置` 的口径。
 * **`mover` 要的是库内绝对路径**（`01_新知识库/00_Inbox/x.md`）。
 * 转换**只在本文件里发生一次**（`abs()`），别的地方不许再转一遍。
 */
import { joinPath, normPath, parentDir, isInside } from '../../core/paths';

/** 模型给的一行建议（**相对库根**路径；字段名短，是为了省 token） */
export interface AiIdea {
  /** 要搬的笔记，相对库根，如 `00_Inbox/插件开发计划.md` */
  path: string;
  /** 落点目录，相对库根，如 `01_Projects/01_执行中` */
  to: string;
  /** 为什么（给用户看的理由，模型自己写的） */
  why?: string;
}

/** 被拦下的原因码（判据按码断言，别按文案） */
export type AiBlockCode =
  /** 命中了 `03_AI指令集/`（§11 边界 ③）—— **这是那道硬拦** */
  | 'protected'
  /** 源文件不在库里（或不在库根之下） */
  | 'missing-note'
  /** 落点目录库里没有 */
  | 'no-dir'
  /** 已经在那个位置了（假建议） */
  | 'same-place'
  /** 同一篇在同一次建议里出现两次 */
  | 'duplicate';

export interface AiBlocked {
  code: AiBlockCode;
  /** 相对库根的路径（拿不到源路径时是空串） */
  path: string;
  to: string;
  /** 给人看的一句话 */
  why: string;
}

/** 通过了检查的一行 —— **`from` / `to` 都是库内绝对路径**（直接喂 `mover`） */
export interface AiPlanRow {
  /** 库内绝对路径（= `mover` 的 `from`） */
  path: string;
  /** 相对库根（给界面显示用，仍是用户视角） */
  rel: string;
  /** 库内绝对目录（= `mover` 的 `targets[].dir`） */
  dir: string;
  /** 相对库根的落点目录（给界面显示用） */
  dirRel: string;
  why: string;
}

export interface AiPlanInput {
  ideas: AiIdea[];
  kbRoot: string;
  /**
   * **AI 指令集目录（库内绝对路径）**，形如 `01_新知识库/99_Meta/03_AI指令集`。
   * 传空串 = 这条防线不存在 —— ⚠️ **别这么用**，调用方一律从
   * `settings.metaRoot() + '/03_AI指令集'` 取（见 `services/ai/index.ts`）。
   */
  aiDir: string;
  /** 这篇在不在库里（库内绝对路径）—— 由调用方用索引给，保持本函数是纯的 */
  hasNote: (abs: string) => boolean;
  /** 库里真有的目录（**库内绝对路径**，含库根自身） */
  dirs: Set<string>;
}

export interface AiPlan {
  rows: AiPlanRow[];
  blocked: AiBlocked[];
}

/** 库内绝对化：模型输出的是相对库根口径，这里转一次（别处不许再转） */
function abs(kbRoot: string, rel: string): string {
  return joinPath(kbRoot, normPath(rel));
}

/**
 * 这条路径是不是"AI 不许碰的"（§11 边界 ③）。
 *
 * 判据是**包含关系**（`isInside` 含自身），不是相等：
 * 目录本身、目录里的任何一层、以及**将要落到它里面的目标**全都算。
 * ⚠️ 大小写按原样比（Obsidian 在 Windows 上不区分，但本项目全程用库里的规范路径，
 * 不额外做大小写归一 —— 那是另一条会漂的规则）。
 */
export function isAiProtected(absPath: string, aiDir: string): boolean {
  if (!aiDir) return false;
  const p = normPath(absPath);
  const d = normPath(aiDir);
  /**
   * 既拦"源在指令集里"（把规范文件搬走），也拦"目标在指令集里"
   * （把别的笔记塞进规范目录 —— 那同样是在改这个目录的内容）。
   */
  return isInside(p, d);
}

/**
 * 建议 → 计划。**纯函数**：不碰文件、不读盘，两个方向（通过 / 拦下）都能离线断言。
 */
export function buildAiPlan(input: AiPlanInput): AiPlan {
  const kbRoot = normPath(input.kbRoot);
  const aiDir = normPath(input.aiDir);
  const rows: AiPlanRow[] = [];
  const blocked: AiBlocked[] = [];
  /** 同一篇被建议了两次 —— 第一次赢，后面的挡掉（`mover` 里也有 `seen` 去重，但那样是**静默**的） */
  const seenNote = new Set<string>();

  for (const idea of input.ideas ?? []) {
    const rel = normPath(idea?.path ?? '');
    const toRel = normPath(idea?.to ?? '');
    const why = String(idea?.why ?? '').trim();
    if (!rel) {
      blocked.push({ code: 'missing-note', path: '', to: toRel, why: '这条建议没写要搬哪一篇' });
      continue;
    }
    const from = abs(kbRoot, rel);
    const dir = abs(kbRoot, toRel);

    // ① 硬拦：源或落点碰到 AI 指令集（§11 边界 ③）
    if (isAiProtected(from, aiDir) || (toRel !== '' && isAiProtected(dir, aiDir))) {
      blocked.push({
        code: 'protected',
        path: rel,
        to: toRel,
        why: 'AI 指令集里的东西只能读、不能改（含搬进搬出）',
      });
      continue;
    }
    // ② 源必须在库里、且在库根之下
    // ⚠️ P7.14：**别再写 `!kbRoot` 硬拦** —— kbRoot=''（整个库，= vault 根）是合法配置，
    // `isInside(from, '')` 本就恒真，空串不是"没配"。
    if (!isInside(from, kbRoot) || !input.hasNote(from)) {
      blocked.push({ code: 'missing-note', path: rel, to: toRel, why: '库里找不到这一篇' });
      continue;
    }
    // ③ 同一篇出现两次
    if (seenNote.has(from)) {
      blocked.push({ code: 'duplicate', path: rel, to: toRel, why: '同一篇在这一次建议里出现了两次' });
      continue;
    }
    // ④ 落点目录必须**库里真有**（不新建 —— `mover` 会 mkdir，那是给 P5 骨架留的口子）
    if (!toRel) {
      blocked.push({ code: 'no-dir', path: rel, to: toRel, why: '这条建议没写要搬到哪' });
      continue;
    }
    if (!input.dirs.has(dir)) {
      blocked.push({ code: 'no-dir', path: rel, to: toRel, why: `库里没有「${toRel}」这个目录` });
      continue;
    }
    // ⑤ 已经在那个位置 = 假建议
    if (parentDir(from) === dir) {
      blocked.push({ code: 'same-place', path: rel, to: toRel, why: '它已经在这个目录里了' });
      continue;
    }

    seenNote.add(from);
    rows.push({ path: from, rel, dir, dirRel: toRel, why });
  }

  return { rows, blocked };
}
