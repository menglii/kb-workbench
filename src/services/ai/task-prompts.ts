/**
 * services/ai/task-prompts.ts —— **AI 提示词附加层**（P7.22b · #3）
 *
 * 用户在 `<元数据目录>/06_工作台/AI提示词/<任务id>.md` 里写一份**附加要求**，
 * 对应的任务（`AI_TASKS` 的 id）每次开跑都把它整段拼进 system
 *（落点在能力包那一段之后，见 `prompt.ts` 的 `taskNoteBlock`）。
 *
 * ## 口径（拍板：**附加层**，不是替换）
 *
 * · **只做加法**：内置任务指令 / 输出格式段 / 硬规矩段一个字都不动 ——
 *   "用户文件只能动任务指令段"那条在这里变成**结构上不可能**（没给替换的口子）。
 * · **文件不存在 = 一个字都不进**（行为与从前逐字一致）；文件名叫别的
 *   （认不出任务 id）就没人读它 —— 无害。
 * · **预算上限 + 截断如实**：超 `AI_LIMITS.taskNoteChars`（6000，仿 `rulesChars` 先例）
 *   截断，并在注入文本尾部**如实带一句**"超出的部分没带" —— 模型与排查的人都看得见
 *   （静默截断会让用户以为全量生效了）。
 * · 它是**用户自己写的指令**（与能力包同族，来自库内配置文件）：不是模型能自我加的东西，
 *   也**不改变任何一条安全边界**（档位照旧来自设置）。
 * · ⚠️ 与 #4 的交互：它是 system 的一部分 —— **改这个文件 = prompt 缓存失效**
 *   （冻结 §1 里如实记着这句）。
 *
 * ⚠️ 本文件与 `skills.ts` 同一条分层纪律：只 import `core/` 与 `services/ai` 自己
 * （对 obsidian 只做 type-only import —— `redline.ts` 有静态断言钉着这两个文件的形态）。
 */
import type { App } from 'obsidian';
import { joinPath } from '../../core/paths';
import { AI_LIMITS } from './prompt';

/**
 * 截断（**纯函数**，可离线逐条断言）：去首尾空白后超 `AI_LIMITS.taskNoteChars` 就切，
 * 并追一句如实说明。空文本 → `''`（调用方当"没写"处理）。
 */
export function clipTaskPrompt(raw: string): { text: string; truncated: boolean } {
  const all = String(raw ?? '').trim();
  if (all === '') return { text: '', truncated: false };
  if (all.length <= AI_LIMITS.taskNoteChars) return { text: all, truncated: false };
  const kept = all.slice(0, AI_LIMITS.taskNoteChars).trim();
  return {
    text: `${kept}\n\n（注：这份附加要求超过 ${AI_LIMITS.taskNoteChars} 字，上面只带了前 ${AI_LIMITS.taskNoteChars} 字。）`,
    truncated: true,
  };
}

/**
 * 读盘（与 `AiSkillStore` 同一个形状：`vault.adapter`，不碰库内写盘）。
 * 一个任务一个文件，**只读**；不存在 / 读不动 / 空文件 → `null`（= 与没写过一样）。
 */
export class AiTaskPromptStore {
  constructor(
    private app: App,
    /**
     * 目录**现取**（与 `AiSkillStore` 同款）：用户改过库根 / 元数据目录名之后，
     * 下一次读就该看新地方。
     */
    private dirOf: () => string,
  ) {}

  rootDir(): string {
    return this.dirOf().replace(/^\/+|\/+$/g, '');
  }

  /** 读某个任务的附加层正文（切好、带"截断如实"那句；没有就是 null） */
  async read(taskId: string): Promise<string | null> {
    const id = String(taskId ?? '').trim();
    // 任务 id 里不该有路径分隔（有的话直接当"没有"，别让它拼出目录穿越）
    if (id === '' || id.includes('/') || id.includes('\\')) return null;
    const path = joinPath(this.rootDir(), `${id}.md`);
    try {
      const raw = await this.app.vault.adapter.read(path);
      const { text } = clipTaskPrompt(raw);
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }
}

/** 目录的**唯一拼法**（`workbenchDir()` 之下；别在别处再拼一份 —— 与 `skillsDirOf` 同款） */
export function taskPromptsDirOf(workbenchDir: string): string {
  return joinPath(workbenchDir.replace(/^\/+|\/+$/g, ''), 'AI提示词');
}
