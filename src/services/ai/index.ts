/**
 * services/ai/index.ts —— AI 助手的服务层（交互规格 §11）
 *
 * 三件事，别的一概不做：
 *   ① **备料**：从库里取候选笔记、从 `03_AI指令集/` 取用户的规范正文（**只读**）
 *   ② **问**：拼提示词 → 走 `AiTransport` → `parseAdvice`
 *   ③ **收口**：所有建议一律过 `buildAiPlan()` —— 拦住的行**不进计划**
 *
 * 🔴 **这一层没有写盘能力**。它产出的是一份 `AiPlan`，真正动库的是
 * `ui/ai-panel.ts` → `ui/confirm.ts` → `services/mover.ts` —— 与手工那条**同一个出口**。
 * 这不是"设计上希望如此"，是**类型上就办不到**：本文件 import 不到 `mover`。
 *
 * 🔴 **`protectedDir()` 是那道硬拦的取值处**：`99_Meta/03_AI指令集` 由
 * `settings.metaRoot()` 派生（**不是常量** —— 用户改过元数据目录名之后，
 * 写死的字符串会让这道闸在**新目录名**上失效，而且不报错）。
 */
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { SettingsStore } from '../../core/settings';
import type { NoteEntry, VaultIndex } from '../../core/vault-index';
import { brokenLinkTexts, kbDirsOf, normalizeLinkText } from '../../core/vault-index';
import { baseName, isInside, joinPath, relativeTo } from '../../core/paths';
import {
  buildAiPlan,
  isAiProtected,
  type AiIdea,
  type AiPlan,
} from './plan';
import {
  AI_LIMITS,
  AiParseError,
  type AiCandidate,
  type AiCrossInput,
  type AiMessage,
  type AiRef,
} from './prompt';
import {
  AI_TASKS,
  inWorkDir,
  runAiTaskCore,
  type AiAgentRun,
  type AiSingleRun,
  type AiTaskCross,
  type AiTaskDef,
} from './tasks';
import { isExcluded } from '../reconcile';
import { declaredPositions } from '../schema';
import { splitFrontmatter } from '../frontmatter';
import { frontmatterInnerOf, topLevelKeysOf, validateFmRepair } from '../fm-repair';
import { headOfText, INBOX_DIR } from '../suggest';
import type { AiAgentHooks, AiAgentStep, ToolPort } from './agent';
import type { AiToolName } from './tools';
import { AiError, httpTransport, type AiFailKind, type AiReply, type AiTransport } from './transport';
import { modelOf, type AiTurnUsage } from './cost';
import { AiSkillStore, skillsDirOf, type AiSkill } from './skills';
import { AiTaskPromptStore, taskPromptsDirOf } from './task-prompts';
import {
  AiSessionStore,
  AI_SESSIONS_VERSION,
  migrateSession,
  newSession,
  titleOf,
  type AiSession,
  type AiSessionMeta,
} from './sessions';

export { AiError, AiParseError, isAiProtected };
export { AiSessionStore, AI_SESSIONS_VERSION, migrateSession, newSession, titleOf };
export { formatSessionMd, formatTurnMd } from './sessions';
export {
  AiSkillStore,
  skillsDirOf,
  parseSkill,
  fillSkillParams,
  matchSkillByTrigger,
  SKILL_KEYS,
  SKILL_MAX_CHARS,
} from './skills';
// P7.22b · #3：AI 提示词附加层（读盘 + 截断纯函数）
export { AiTaskPromptStore, taskPromptsDirOf, clipTaskPrompt } from './task-prompts';
export { addUsage, costOf, emptyUsage, estimateTokens, fmtCost, fmtTokens, usageLine } from './cost';
// P7.22b · #5：任务级模型 / 单价多条的纯函数（界面与服务层共用同一份口径）
export { modelOf, priceFor, usageLineFor } from './cost';
export { grepText, TextLru, type GrepHit } from './grep';
// P7.22a · #1：正文编辑（patch_text / append）的纯逻辑（三态幂等 + 尾部包含检查）
export { planPatchText, planAppend, type TextEditPlan } from './text-edit';
export type { AiSkill, AiSkillList } from './skills';
export type { AiTurnUsage } from './cost';
export type { AiReply, AiUsage } from './transport';
export { AI_LIMITS } from './prompt';
export { parseAgentReply, buildAgentMessages, buildClassifyMessages, buildMocPickMessages } from './prompt';
export { buildTitleMessages, parseTitles, buildLocusMessages, parseLocus } from './prompt';
export { buildLinkFixMessages, parseLinkFix } from './prompt';
export { buildBeautifyMessages, parseBeautify, type AiBeautify } from './prompt';
export { buildReviewMessages, parseReview, REVIEW_CARDS_MAX, type AiReview } from './prompt';
export { buildFixFmMessages, parseFixFm, type AiFixFm } from './prompt';
export { runAgentLoop, renderToolResults } from './agent';
export {
  AI_AGENT_LIMITS,
  AI_TOOL_CLASSES,
  AI_TOOL_CLASS_OF,
  AI_TOOL_NAMES,
  DEFAULT_TOOL_TIERS,
  effectiveTier,
  oneLine,
  rowOfCall,
  validateCall,
} from './tools';
// P7.21 · #1 任务注册表与统一 runner（判据 / 文档 / 自证都从这一份取）
export { AI_TASKS, AI_TASK_LIST, taskById, runAiTask, inWorkDir } from './tasks';
export type { AiAgentRun, AiSingleRun, AiTaskCross, AiTaskDef, AiTaskId, AiTaskRun } from './tasks';
export type { AiSession, AiSessionMeta };
export type { AiRef, AiCrossInput } from './prompt';
export type { AiPlan, AiIdea };
export type { AiTransport } from './transport';
export type { AiPlanRow, AiBlocked, AiBlockCode } from './plan';
export type { AiAgentHooks, AiAgentStep, ToolPort } from './agent';
export type { AiCallRow, AiToolCall, AiToolClass, AiToolName, AiToolOutcome, AiToolTier } from './tools';

/** 一问一答的一轮（面板的"上下文"就是它的数组） */
export interface AiTurn {
  question: string;
  /**
   * 这一轮是什么：`chat` = 纯聊；`advice` = v1 的结构化建议（`AiService.ask`）；
   * `agent` = 走工具循环的一轮（P7.3b，`AiService.agent`）。
   */
  kind: 'chat' | 'advice' | 'agent';
  reply: string;
  ideas: AiIdea[];
  /** 过了闸、可以执行的部分（v1 口径；agent 轮恒为空 —— 动作在 `steps` 里） */
  plan: AiPlan;
  /** 模型本来提了几条（用来算"拦下 N 条"） */
  proposed: number;
  /** 形状不对、在解析那一步就被丢掉的条数（**也要摆到界面上**，别静默） */
  dropped: number;
  /**
   * 这一问引用了哪些材料（`@` 引用；P7.3a）。
   * 存进会话是为了**重试**：重试要带同一批材料回去，不然"重试"其实换了问题。
   */
  refs?: AiRef[];
  /** agent 轮的"干活过程"（P7.3b）—— 历史重画与导出用它 */
  steps?: AiAgentStep[];
  /**
   * agent 轮收尾：`limit` = 到步数上限了（界面如实写一句，别假装完事）；
   * `handoff` = **P7.22b 时代值**（打开即收尾）—— P7.24 · L2 起**不再产生**
   *（服务族改成"跑到确认卡"，循环不掐断）；保留在联合里只为**老会话读盘**。
   */
  stopped?: 'done' | 'limit' | 'handoff';
  /** 回话想写 JSON 但写坏了（按聊天轮收尾 + 一句轻说明，**不当错误**） */
  parseError?: boolean;
  /**
   * 这一轮**被停止**（用户按停止 / 关面板）。⚠️ 半截也要进会话（独立审查 🟡2）：
   * agent 是边答边动库的，执行过的步骤不能因为"没跑完"就从记录里消失。
   */
  aborted?: true;
  /**
   * 这一轮**没跑完**的原因（一句话，已从错误对象里取好 —— 存字符串不存对象：
   * 会话是要落盘的，`Error` 序列化出来是 `{}`）。
   */
  failNote?: string;
  /**
   * 这一轮的用量（17.10② 成本可见，P7.3c）—— 服务端报的 + 认不出时本地估算的。
   * 存进会话：历史/导出里也看得到"这段对话花了多少"。
   */
  usage?: AiTurnUsage;
  /** 这一轮用了哪个能力包（名字；P7.3c）—— 历史里看得出"当时是按什么指令干的" */
  skill?: string;
}

/** AI 分类（P7.6 · 源③）的结果：建议表 + 过了 `buildAiPlan` 的结果 + 用量 */
export interface AiClassifyResult {
  kind: 'chat' | 'advice';
  reply: string;
  ideas: AiIdea[];
  plan: AiPlan;
  proposed: number;
  /** 形状不对被丢掉的条数（如实报，别静默） */
  dropped: number;
  usage?: AiTurnUsage;
}

/** MOC 挑节（P7.6 · 并族 B）的结果：ideas 的 `to` = 节名（合法性由 suggest.ts 复核） */
export interface AiMocPickResult {
  reply: string;
  ideas: AiIdea[];
  dropped: number;
  usage?: AiTurnUsage;
}

/** AI 起标题（P7.8 · 1.5 的「未命名」行）的结果：**只出候选，不动库** */
export interface AiTitlesResult {
  /** 每篇：rel（相对库根）+ 当前名 + 1–3 个候选（已清洗） */
  items: { rel: string; current: string; options: string[] }[];
  /** 硬拦（`03_AI指令集` 只能读 —— 改名也是写；与 §11.1 边界 ③ 同一道闸） */
  blocked: { rel: string; why: string }[];
  /**
   * 真喂给模型的那些篇（相对库根；受 `AI_LIMITS.titleNotes` 上限）。
   * 面板拿它区分「模型没给候选」与「这一轮压根没给模型看」（原因与事实不许错位）。
   */
  fed: string[];
  /** 形状不对、或不在候选清单里（幻觉路径）被丢掉的条数（如实报，别静默） */
  dropped: number;
  reply: string;
  usage?: AiTurnUsage;
}

/**
 * AI 补声明（P7.12 · v2：AI 补属性 = 给缺「文件位置」的笔记挑落点目录）的结果：
 * **只出候选值，不动库**。产物由 `ui/suggest-panel.ts` / 一键整理接走 →
 * 确认流 → `fm.set`（与起标题同构）。
 */
export interface AiLocusResult {
  /** 每篇：rel（相对库根）+ 提议的落点目录（**已复核：库里真有的目录、不在收件箱/工具区**） */
  items: { rel: string; to: string }[];
  /** 真喂给模型的那些篇（相对库根；受 `AI_LIMITS.locusNotes` 上限） */
  fed: string[];
  /** 形状不对 / 目录不在清单里（幻觉值）被丢掉的条数（如实报，别静默） */
  dropped: number;
  reply: string;
  usage?: AiTurnUsage;
}

/**
 * 「AI 修链」（P7.13b · E1）的结果：**只出候选，不动库**。
 * 产物由 `ui/link-panel.ts` 接走 → 确认流 → 快照 → `vault.process` 按行改
 *（只改认得出的那条：别名 / `#小标题` 保留）。
 */
export interface AiLinksResult {
  /**
   * 每条失效链：rel（相对库根）+ from（**归一化后**的旧目标）+ 1–2 个候选
   *（**已复核：都在全库标题清单里**——清单外一律判丢）。
   */
  items: { rel: string; from: string; options: string[] }[];
  /** 真喂给模型的那些篇（相对库根；受 `AI_LIMITS.linkNotes` 上限） */
  fed: string[];
  /** 形状不对 / 幻觉路径 / 目标不在标题清单里 被丢掉的条数（如实报，别静默） */
  dropped: number;
  reply: string;
  usage?: AiTurnUsage;
}

/**
 * 「美化笔记」（P7.12 · R8）的结果：**只出稿，不动库** —— 替换由界面走
 * 「确认流 → 快照 → `vault.process`」（与 §8.5 的出口纪律同一条）。
 */
export interface AiBeautifyResult {
  /** 相对库根 */
  rel: string;
  /** 美化后的整篇正文（已剥围栏、去首尾空白；**前言不在里面**） */
  body: string;
  /** 模型的原话（撤了什么围栏之前的样子，排错用） */
  reply: string;
  usage?: AiTurnUsage;
}

/**
 * 「生成回顾卡」（P8 · 回顾期 4）的结果：**只出稿，不动库** —— 写不写由界面
 * （`ui/review-gen.ts` → 确认流 → `ctx.review.addCards`）说了算。
 */
export interface AiReviewResult {
  /** 相对库根 */
  rel: string;
  /** AI 出的卡（最多 `REVIEW_CARDS_MAX` 张） */
  cards: { front: string; back: string }[];
  /** 超出上限被丢掉几张（**说出来**，别静默） */
  truncated: number;
  /** 模型的原话（排错用） */
  reply: string;
  usage?: AiTurnUsage;
}

/**
 * 「修前言」（P7.16 · #3）的结果：**只出稿，不动库** —— 替换由界面
 * （`ui/fm-repair-panel.ts`）走「确认流 → 快照 → `vault.process`」。
 *
 * ⚠️ **不走 `processFrontMatter`**（守卫就是为这类前言设的、往返还会弄坏形状）——
 * 落盘是"把前言整段换成这段文本"，正文一个字节不动（`services/fm-repair.ts`）。
 * 出稿前已过 `validateFmRepair`（键一个不少、坏形状没了、没有围栏漏进来）。
 */
export interface AiFixFmResult {
  /** 相对库根 */
  rel: string;
  /**
   * **出稿所依据的那一版前言段**（服务层那次读的；不含 `---` 围栏）。
   * ⚠️ 独立审 🟡：面板写盘前的防呆**要比对它**（而不是面板自己扫描/现读的那一份）——
   * 否则"校验过的稿子"与"写时认的原文"可能不同源（两次读之间被改过又改回）。
   */
  innerBefore: string;
  /** 修好的前言段（**不含 `---` 围栏**；已剥围栏、去首尾空白） */
  inner: string;
  /** 模型的原话（剥围栏之前的样子，排错用） */
  reply: string;
  usage?: AiTurnUsage;
}

/**
 * 硬拦（`03_AI指令集`）那句话 —— **唯一出处**：服务层的 `blocked.why` 与
 * 面板建行时的本地判定共用一份（独立审 🔴1：面板本地判定不许等 AI 回话才有，
 * 文案也不许两处各写一句）。
 */
export const AI_PROTECTED_WHY = 'AI 指令集里的东西只能读、不能改名';

/**
 * 「AI 起标题」的候选派生（**唯一一份**：`proposeTitles` 取材与 `ui/title-panel.ts`
 * 建行共用 —— 两处各写一遍筛选链迟早漂；独立审 🟡2）。
 * 口径：非模板 + `placeholder-title` 标记 + 在库根之下；mtime 倒序（新的先看）。
 */
export function placeholderTitleNotes(
  entries: NoteEntry[],
  kbRoot: string,
): { rel: string; entry: NoteEntry }[] {
  const out: { rel: string; entry: NoteEntry }[] = [];
  for (const e of entries
    .filter((x) => !x.isTemplate && x.flags.includes('placeholder-title'))
    .sort((a, b) => b.mtime - a.mtime)) {
    const rel = relativeTo(e.path, kbRoot);
    if (!rel || rel === e.path) continue;
    out.push({ rel, entry: e });
  }
  return out;
}

/**
 * 「测试连接」的结果（17.10③）。**形状与 `AiError.kind` 对齐**（用户拍的口径：
 * 别另造一套错误分类）—— `kind` 那几个字面量就是 `AiFailKind` 的子集。
 */
export interface AiTestResult {
  ok: boolean;
  /** 失败原因的分类（与面板里那些错误同一份口径；`no-key` 是这里额外补的第一个闸） */
  kind?: AiFailKind;
  /** HTTP 状态码（有就带上 —— 404 与 401 的处理方向完全不同） */
  status?: number;
  /** 给用户看的一句话（`AiError.hint` 同一份文案） */
  hint?: string;
  /** 服务端正文片段（已截断，不含请求头） */
  detail?: string;
  /** 成功时：实际走了哪条路 */
  via?: 'stream' | 'chat';
  /** 成功但有话要说（如"这家不吐流式，已降级"） */
  note?: string;
}

/** 喂给提示词的属性名（挑几个最能说明"这篇是什么"的）—— v2：领域/发布进度已退役 */
const BRIEF_PROPS = ['类型', '状态', '文件位置'];

export class AiService {
  /**
   * 传输层。**公开字段、可整体换掉** —— 离线用例与真机探针往里塞假响应
   * （交互规格 §11.2 第 4 条拍的是"接口抽出来"，不是一个测试专用的开关）。
   */
  transport: AiTransport;

  /**
   * **默认那条 HTTP 传输层**（构造时那一个）—— 留着是为了**能换回来**。
   *
   * 🔴 少了它，"临时换成假响应"就是**单向**的：用例/探针换完没处还原，
   * 后面那几条会在一个"永远不会成功"的传输层上跑，症状是"莫名其妙全红"。
   * 探针里的那条真连判据就是靠 `transport = ai.http` 把真的换回来的。
   */
  readonly http: AiTransport;

  /**
   * 会话仓库（5.1a）—— 存**插件目录** `ai-sessions/`（不进库，G4-C1 拍板）。
   * 面板从这里读回/保存；「导出为笔记」把它变成库内笔记（那是另一条既有出口）。
   */
  readonly sessions: AiSessionStore;

  /**
   * **能力包仓库**（P7.3c skill 机制）—— 读**库内** `<元数据目录>/06_工作台/skills/*.md`。
   * ⚠️ 目录**现取**（`dirOf` 回调）：用户改过库根 / 元数据目录名之后下一次 list 就该看新地方。
   */
  readonly skills: AiSkillStore;

  /**
   * **AI 提示词附加层仓库**（P7.22b · #3）—— 读**库内**
   * `<元数据目录>/06_工作台/AI提示词/<任务id>.md`（一个任务一个文件，只读）。
   * 目录同样**现取**（与 `skills` 同款）。
   */
  readonly taskPrompts: AiTaskPromptStore;

  constructor(
    private app: App,
    private settings: SettingsStore,
    private index: VaultIndex,
    pluginDir: string,
    transport?: AiTransport,
  ) {
    this.http = transport ?? httpTransport();
    this.transport = this.http;
    this.sessions = new AiSessionStore(app, pluginDir);
    this.skills = new AiSkillStore(app, () => skillsDirOf(this.settings.workbenchDir()));
    this.taskPrompts = new AiTaskPromptStore(app, () => taskPromptsDirOf(this.settings.workbenchDir()));
  }

  /** **AI 不许碰的那个目录**（库内绝对路径）。空串 = 元数据目录还没配出来 */
  protectedDir(): string {
    const metaDir = this.settings.get().metaDir.replace(/^\/+|\/+$/g, '');
    if (!metaDir) return '';
    return joinPath(this.settings.kbRoot(), metaDir, '03_AI指令集');
  }

  /** 配没配 key（面板据此显示"还没配置"，而不是让用户点了才报错） */
  isConfigured(): boolean {
    return this.settings.get().ai.apiKey.trim() !== '';
  }

  /**
   * 调模型的那一跳（5.1a 流式 / 5.6 取消都在这里分流）。
   *
   * 口径：**要增量且有 `stream` 才走流式** —— 没有 `onDelta` 的调用（探针的真连判据、
   * 老用例）走原路，一个字不变。降级是传输层自己的责任（见 `transport.ts` 头注）：
   * 不吐增量 = 面板切打字机回放的信号。
   */
  private async callModel(
    conn: { baseUrl: string; model: string; apiKey: string; protocol: 'openai' | 'anthropic' },
    messages: AiMessage[],
    opts: { onDelta?: (delta: string) => void; signal?: AbortSignal },
  ): Promise<AiReply> {
    const cfg = this.settings.get().ai;
    const req = {
      baseUrl: conn.baseUrl,
      model: conn.model,
      apiKey: conn.apiKey,
      // P7.22b · #4：协议选路（设置里那个下拉；缺省 = openai = 现状）
      protocol: conn.protocol,
      messages,
      // 模型参数（8.2 的口子）：**默认值就是 3b 起写死的那两个**（1200 / 0）
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
    };
    if (opts.onDelta && this.transport.stream) {
      return this.transport.stream(req, { onDelta: opts.onDelta, signal: opts.signal });
    }
    return this.transport.chat(req, { onDelta: opts.onDelta, signal: opts.signal });
  }

  /**
   * **统一 runner 的接线**（P7.21 · #1）：把"调模型那一跳"接上真实传输 + 设置里的
   * baseUrl / model / key，把横切（`skill` / `workDir`）与取消 / 流式一起递下去。
   *
   * 八条管线与 `ask` / `agent` 全走这里 —— 提示词构建、解析、**用量累计**都归
   * `tasks.ts` 的 `runAiTask` 一条路（成本脚注因此自动覆盖全任务）。
   * 两种形状按行里的 `tools` 分派（重载把返回类型也拆开，见 `runAiTask`）。
   */
  private runTask<I extends AiCrossInput, O>(
    def: AiTaskDef<I, O> & { tools: AiToolName[] },
    input: I,
    cross: AiTaskCross,
    extra?: { port?: ToolPort; hooks?: AiAgentHooks },
  ): Promise<AiAgentRun>;
  private runTask<I extends AiCrossInput, O>(
    def: AiTaskDef<I, O> & { tools: null },
    input: I,
    cross: AiTaskCross,
    extra?: { port?: ToolPort; hooks?: AiAgentHooks },
  ): Promise<AiSingleRun<O>>;
  private async runTask<I extends AiCrossInput, O>(
    def: AiTaskDef<I, O>,
    input: I,
    cross: AiTaskCross,
    extra?: { port?: ToolPort; hooks?: AiAgentHooks },
  ): Promise<AiSingleRun<O> | AiAgentRun> {
    const cfg = this.settings.get().ai;
    /**
     * P7.22b · #3：这一趟任务的**提示词附加层**（`06_工作台/AI提示词/<任务id>.md`）——
     * 现读（改了文件下一趟就生效）；读不到 = `undefined` = 提示词一个字不变。
     */
    const taskNote = await this.taskPrompts.read(def.id);
    return runAiTaskCore(def, input, { ...cross, taskNote: taskNote ?? undefined }, {
      /**
       * **分派点**（P7.22b · #5）：模型按**任务 id** 取 ——
       * `modelOf(cfg, def.id)` = 任务级映射命中就用它，否则主模型。
       * 只在这一处接线（不改 runner 的横切）——"分类走便宜、写作走强"全从这里生效；
       * 协议（#4）同理：`cfg.protocol` 随每一次调用带进传输层。
       */
      callModel: (msgs, o) =>
        this.callModel(
          { baseUrl: cfg.baseUrl, model: modelOf(cfg, def.id), apiKey: cfg.apiKey, protocol: cfg.protocol },
          msgs,
          o,
        ),
      port: extra?.port,
      hooks: extra?.hooks,
    });
  }

  /**
   * 问一轮。
   *
   * ⚠️ **不自己 try/catch 成"没有建议"**：`AiError`（网络/key）与 `AiParseError`
   *（**想写 JSON 但写坏了**）要**分成两条**报给用户 —— 前者"去检查设置"，后者"换个说法再试"。
   * 把两者都吞成空建议，用户会以为 AI 觉得没事可做。
   *
   * ⚠️ 但**散文回答不在这两类里**（P6 第八段）：模型正常聊两句也算成功的一轮，
   * `kind:'chat'` 一路带到界面，别在外面又按"没有建议"处理一遍。
   */
  async ask(input: {
    question: string;
    history?: AiTurn[];
    /** 用户 `@` 引用的材料（note 由服务层现读；selection 由面板带 text） */
    refs?: AiRef[];
    /** 流式增量（P7.3a 5.1a）。**给了它且传输层实现了 `stream`，才走流式** */
    onDelta?: (delta: string) => void;
    /** 用户取消（5.6；面板的「停止」） */
    signal?: AbortSignal;
    /**
     * 横切（P7.21 · #1）：能力包 / 工作目录 —— 与 `agent()` 同一口径。
     * 老调用方（设置栏「问 AI」）不传，行为一个字不变。
     */
    skill?: AiSkill | null;
    workDir?: string;
  }): Promise<AiTurn> {
    const question = String(input.question ?? '').trim();
    if (question === '') throw new AiError('还没输入内容', 'http');

    const refs = await this.resolveRefs(input.refs ?? []);
    const run = await this.runTask(
      AI_TASKS.ask,
      {
        question,
        kbRoot: this.settings.kbRoot(),
        dirs: this.usableDirs(),
        rules: await this.readRules(),
        candidates: this.candidates().filter((c) => inWorkDir(c.rel, input.workDir)),
        refs,
        /**
         * 上下文带**问与答的文字**，外加把上一轮的建议**压成一行清单**（见 `recapOf`）。
         * ⚠️ **截断只在这一处**（按轮；`AI_LIMITS.history` 是这里的预算）——
         * `buildMessages` 里不再切第二刀（第一版两处各切一次，实际只剩 2 轮）。
         */
        history: (input.history ?? []).slice(-AI_LIMITS.history).flatMap((t) => [
          { who: 'user' as const, text: t.question },
          { who: 'ai' as const, text: recapOf(t) },
        ]),
      },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal, onDelta: input.onDelta },
    );
    const advice = run.parsed;

    const plan = buildAiPlan({
      ideas: advice.ideas,
      kbRoot: this.settings.kbRoot(),
      aiDir: this.protectedDir(),
      hasNote: (abs) => this.index.get(abs) !== undefined,
      dirs: this.absDirs(),
    });
    return {
      question,
      kind: advice.kind,
      reply: advice.reply,
      ideas: advice.ideas,
      plan,
      proposed: advice.ideas.length,
      dropped: advice.dropped,
      // 存**原始引用**（含 path —— 重试时能重新读一遍最新的正文），不多带正文副本
      refs: input.refs && input.refs.length > 0 ? input.refs : undefined,
      // 用量照记（17.10②）：轻量路不画那一行，但会话里得有（导出时也看得到）
      usage: run.usage,
    };
  }

  /**
   * **「测试连接」**（17.10③ 本地模型诊断，P7.3c）。
   *
   * 发一条**最短**的消息（把 maxTokens 压到 8：只求连通，不要回答质量），
   * 然后**按 `AiError.kind` 如实分类**报出来 —— 不另造一套错误口径
   *（`hint` 与面板里那些错误用的是同一份文案）。
   *
   * `via` 说的是**实际走了哪条路**：
   *   · `'stream'` —— 流式那一路真的吐了增量（说明这家过 CORS / 认 SSE）；
   *   · `'chat'` —— 走的整包（第三方 / 本地口不吐 CORS 头时**自动降级**的结果，
   *     或者本来就只实现了 `chat`）。这一栏是"连不上"诊断里最有用的一格：
   *     本地模型连不上时，"降级了"与"压根不通"是两件事。
   *
   * ⚠️ **只发一次**（不重试、不带上下文）—— 它是诊断，不是提问。
   */
  async testConnection(): Promise<AiTestResult> {
    const cfg = this.settings.get().ai;
    if (String(cfg.apiKey ?? '').trim() === '') {
      return { ok: false, kind: 'no-key', hint: '还没配置 API key —— 上面那一栏填上再测' };
    }
    const messages: AiMessage[] = [{ role: 'user', content: '你好' }];
    const req = {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      // P7.22b · #4：「测试连接」按**当前选的那个协议**发（两路都兼容）
      protocol: cfg.protocol,
      messages,
      maxTokens: 8,
      temperature: 0,
    };
    let sawDelta = false;
    try {
      if (this.transport.stream) {
        await this.transport.stream(req, { onDelta: () => { sawDelta = true; } });
        if (!sawDelta) {
          /**
           * 一个增量都没吐 = 降级走了整包。**再问一次 `chat` 是错的**（白花一次钱），
           * 直接按"整包"报 —— 用户要看的是"为什么连不上 / 有没有降级"。
           */
          return { ok: true, via: 'chat', note: '连上了，但这家不吐流式增量（已自动降级为整包回传）' };
        }
        return { ok: true, via: 'stream' };
      }
      await this.transport.chat(req, {});
      return { ok: true, via: 'chat' };
    } catch (e) {
      if (e instanceof AiError) {
        return { ok: false, kind: e.kind, status: e.status, hint: e.hint, detail: e.detail };
      }
      return { ok: false, hint: `没连上：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * **agent 一轮**（P7.3b 5.1b）：工具循环 + 端口执行。
   *
   * 与 `ask()` 的关系：`ask()` 是 v1 的单发轻量路径（设置面板那枚「问 AI」还在用），
   * 这条是面板的正式形态。**动库的门一道没少**：动作全部经 `port`（`ui/ai-tools.ts`）
   * 过档位与 `ui/confirm.ts`；这一层 import 不到 mover —— 类型上就办不到。
   *
   * ⚠️ 停等（等用户确认）发生在 `port.runBatch` 里面：`signal` 一路带下去，
   * 关面板 / 按停止都会让端口把待确认的整批收干净（返回"跳过"而不是挂死）。
   */
  async agent(input: {
    question: string;
    history?: AiTurn[];
    refs?: AiRef[];
    /** 执行端口（界面侧实现：档位 / 确认流 / mover / fm / completion 都在那一侧） */
    port: ToolPort;
    /** 面板画"干活过程"的钩子 */
    hooks?: AiAgentHooks;
    signal?: AbortSignal;
    /**
     * 用户显式选中的能力包（P7.3c）。给了就：①正文进 system；②工具目录按白名单收窄。
     * ⚠️ **权限一个字都不动**（档位照旧来自设置）—— 收窄的真正执行在 `input.port`。
     */
    skill?: AiSkill | null;
    /**
     * **本次对话的工作目录**（P7.10 · #12；相对库根，`''` / 不给 = 全库）。
     * 提示词里说清范围；**真正的收窄在 `input.port`**（`ui/ai-tools.ts` 的 `scopeDir`）。
     */
    workDir?: string;
  }): Promise<AiTurn> {
    const question = String(input.question ?? '').trim();
    if (question === '') throw new AiError('还没输入内容', 'http');

    const refs = await this.resolveRefs(input.refs ?? []);
    const protectedAbs = this.protectedDir();
    const skill = input.skill ?? null;
    const run = await this.runTask(
      AI_TASKS.agent,
      {
        question,
        kbRoot: this.settings.kbRoot(),
        dirs: this.usableDirs(),
        rules: await this.readRules(),
        // 工作目录收窄（横切 · P7.21）：候选也收在范围内（与提示词那句同口径）
        candidates: this.candidates().filter((c) => inWorkDir(c.rel, input.workDir)),
        refs,
        // 指令集的真实相对写法（用户改过元数据目录名时，提示词里那条硬规矩也得跟着改口）
        aiDirRel: protectedAbs ? relativeTo(protectedAbs, this.settings.kbRoot()) : '',
        // 上下文口径与 `ask()` 完全一致（同一份 `recapOf`、同一处截断）
        history: (input.history ?? []).slice(-AI_LIMITS.history).flatMap((t) => [
          { who: 'user' as const, text: t.question },
          { who: 'ai' as const, text: recapOf(t) },
        ]),
      },
      { skill: skill ?? undefined, workDir: input.workDir, signal: input.signal },
      { port: input.port, hooks: input.hooks },
    );
    const res = run.agent;

    /** 用量（17.10②）：循环里的多次调用由 runner 统一累加（服务端报了用真数字，没报按字符估算） */
    const usage = run.usage;
    return {
      question,
      kind: res.steps.length > 0 ? 'agent' : 'chat',
      reply: res.reply,
      ideas: [],
      plan: { rows: [], blocked: [] },
      proposed: res.proposed,
      dropped: res.dropped,
      refs: input.refs && input.refs.length > 0 ? input.refs : undefined,
      steps: res.steps.length > 0 ? res.steps : undefined,
      stopped: res.stopped,
      parseError: res.parseError || undefined,
      // 停止 / 出错：半截结果照常带回（面板据此如实收尾，见独立审查 🟡2）
      aborted: res.aborted === true ? true : undefined,
      failNote: res.error != null ? (res.error instanceof AiError ? res.error.hint : String(res.error)) : undefined,
      // 一次都没调成（第一跳失败）时不摆一行"0 token" —— 那行没有信息量
      usage: usage.calls > 0 ? usage : undefined,
      skill: skill ? skill.name : undefined,
    };
  }

  /**
   * **AI 分类**（P7.6 · 11.1 源③）：把 scope 内的候选笔记**逐篇分诊**，出落点建议。
   *
   * 🔴 **只出建议表，不动库**：产物 ideas 照常过 `buildAiPlan`（解析/预检/硬拦全复用）——
   * 面板拿 `plan.rows` 换算成建议行，再走同一条确认流。**不走 agent 工具循环**（G6-Q4 拍）。
   *
   * 与 `ask()` 的区别只在**任务口径**：单轮分诊（candidates 带摘要，全 scope，
   * 不接追问）；`buildAiPlan` / `readRules` / 目录白名单这些一个字都没变。
   */
  async classify(input: {
    /** 范围（相对库根，如 `00_Inbox`；'' = 全库） */
    scopeRel?: string;
    /** 排除表（与自动化那份同源；由面板带进来）——候选里先剔掉 */
    exclude?: string[];
    signal?: AbortSignal;
    /** 横切（P7.21 · #1）：能力包 / 工作目录 */
    skill?: AiSkill | null;
    workDir?: string;
  }): Promise<AiClassifyResult> {
    const kbRoot = this.settings.kbRoot();
    const scope = String(input.scopeRel ?? '').replace(/^\/+|\/+$/g, '');
    const exclude = input.exclude ?? [];
    const picked = this.index
      .notes()
      .filter((e) => {
        const rel = relativeTo(e.path, kbRoot);
        if (!rel || rel === e.path) return false;
        if (isExcluded(rel, exclude)) return false;
        /**
         * **有声明的笔记不进 AI 分诊**（独立审查 🟡3，与规则层/学过往同一个守卫）：
         * 声明是用户明写的意图 —— 声明==现状的笔记"位置已定"，让模型提搬家建议
         * 等于在界面上直接推翻它；声明≠现状的另有权威档/待定的既有口径。
         */
        if (declaredPositions(e.props).length > 0) return false;
        // 工作目录收窄（横切 · P7.21）：候选也收在范围内
        if (!inWorkDir(rel, input.workDir)) return false;
        if (scope && !(e.effectivePosition === scope || e.effectivePosition.startsWith(`${scope}/`))) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, AI_LIMITS.candidates);

    const candidates: AiCandidate[] = [];
    for (const e of picked) {
      candidates.push({
        rel: relativeTo(e.path, kbRoot),
        title: e.basename, // 无扩展名（P7.10 修 stripExt 二次剥离）
        props: briefProps(e),
        snippet: await this.snippetOf(e),
      });
    }

    const protectedAbs = this.protectedDir();
    const run = await this.runTask(
      AI_TASKS.classify,
      {
        kbRoot,
        dirs: this.usableDirs(),
        rules: await this.readRules(),
        candidates,
        aiDirRel: protectedAbs ? relativeTo(protectedAbs, kbRoot) : '',
      },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const advice = run.parsed;
    const plan = buildAiPlan({
      ideas: advice.ideas,
      kbRoot,
      aiDir: protectedAbs,
      hasNote: (abs) => this.index.get(abs) !== undefined,
      dirs: this.absDirs(),
    });
    return {
      kind: advice.kind,
      reply: advice.reply,
      ideas: advice.ideas,
      plan,
      proposed: advice.ideas.length,
      dropped: advice.dropped,
      usage: run.usage,
    };
  }

  /**
   * **MOC 挑节**（P7.6 · 并族 B 的 AI 形态）：给《知识地图》的**未挂笔记**挑一个真实存在的节。
   *
   * 产物是 `{path, to=节名}` 的 ideas —— 节的合法性（真实存在 / 没挂过）由
   * `services/suggest.ts` 的 precheck 复核，这里不做第二套判定。
   */
  async classifyMoc(input: {
    /** 页面里真实存在的 H2 节名（原样） */
    sections: string[];
    /** 候选（库内绝对路径 + basename）——由 suggest.ts 的 MOC 收集挑出"未挂过"的那些 */
    candidates: { path: string; basename: string }[];
    signal?: AbortSignal;
    /** 横切（P7.21 · #1）：能力包 / 工作目录 */
    skill?: AiSkill | null;
    workDir?: string;
  }): Promise<AiMocPickResult> {
    const kbRoot = this.settings.kbRoot();
    const cands: AiCandidate[] = [];
    for (const c of input.candidates.slice(0, AI_LIMITS.candidates)) {
      const e = this.index.get(c.path);
      if (!e) continue;
      const rel = relativeTo(e.path, kbRoot);
      // 工作目录收窄（横切 · P7.21）：候选也收在范围内
      if (!inWorkDir(rel, input.workDir)) continue;
      cands.push({
        rel,
        title: e.basename, // 无扩展名（P7.10 修 stripExt 二次剥离）
        props: briefProps(e),
        snippet: await this.snippetOf(e),
      });
    }
    const run = await this.runTask(
      AI_TASKS.moc,
      { kbRoot, sections: input.sections, candidates: cands },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const advice = run.parsed;
    return {
      reply: advice.reply,
      ideas: advice.ideas,
      dropped: advice.dropped,
      usage: run.usage,
    };
  }

  /**
   * **AI 起标题**（P7.8 · 1.5 的「未命名」行）：给占位标题的笔记出候选名。
   *
   * 与 `classify` / `classifyMoc` 同族：**单轮任务、结构化返回、不走 agent 工具循环**
   *（工具表没有"改名"，这一条也不是加工具 —— 产物由 `ui/title-panel.ts` 接走，
   * 走既有的确认流 + `mover` 链）。
   * 🔴 **只出候选、不动库**：本方法一个写动作都没有。
   */
  async proposeTitles(
    input: {
      signal?: AbortSignal;
      notes?: string[];
      /** 横切（P7.21 · #1）：能力包 / 工作目录 */
      skill?: AiSkill | null;
      workDir?: string;
    } = {},
  ): Promise<AiTitlesResult> {
    const kbRoot = this.settings.kbRoot();
    const protectedAbs = this.protectedDir();
    /**
     * **`input.notes` 给了就按名单收窄**（P7.12 · R8「自动命名」：编辑器右键进来，
     * 只服务这一篇 —— 它**不需要**是「未命名」，用户就是想给这篇起个名）；
     * 不给 = 老路一个字不变（全库的占位标题笔记）。
     * ⚠️ 单篇档每篇多带材料（`titleCharsFull` —— "整篇为材料"），上限 20 篇照旧兜底。
     */
    const only = input.notes !== undefined ? new Set(input.notes) : null;
    const picked = only
      ? this.index
          .notes()
          .map((entry) => ({ rel: relativeTo(entry.path, kbRoot), entry }))
          .filter((x) => x.rel !== '' && x.rel !== x.entry.path && only.has(x.rel))
      : placeholderTitleNotes(this.index.notes(), kbRoot);
    /** 工作目录收窄（横切 · P7.21）：候选也收在范围内（两条取数路都过它） */
    const scoped = picked.filter((x) => inWorkDir(x.rel, input.workDir));
    const chars = only ? AI_LIMITS.titleCharsFull : AI_LIMITS.titleChars;
    const blocked: { rel: string; why: string }[] = [];
    const cands: { rel: string; current: string; snippet: string }[] = [];
    for (const { rel, entry } of scoped) {
      /**
       * 🔴 硬拦（§11.1 边界 ③ 的同一道闸）**先于上限**（独立审 🔴1）：
       * 原来 `break` 在上限处，第 21 篇之后**根本没进保护判定** —— 面板却把它们全列出来，
       * 其中的指令集笔记就漏过去了。现在保护对**全量**判定，上限只收「喂给模型的」。
       */
      if (isAiProtected(entry.path, protectedAbs)) {
        blocked.push({ rel, why: AI_PROTECTED_WHY });
        continue;
      }
      if (cands.length >= AI_LIMITS.titleNotes) continue;
      cands.push({
        rel,
        // ⚠️ `NoteEntry.basename` 本来就**不带扩展名**（TFile.basename 的口径）——
        // 别再过 `stripExt`（那是切"最后一个 .xxx"的，会把 `9.16` 这种名字切成 `9`）
        current: entry.basename,
        snippet: await this.snippetOf(entry, chars),
      });
    }
    const fed = cands.map((c) => c.rel);
    if (cands.length === 0) {
      return { items: [], blocked, fed, dropped: 0, reply: '' };
    }
    const run = await this.runTask(
      AI_TASKS.titles,
      { kbRoot, notes: cands },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const parsed = run.parsed;
    const known = new Map(cands.map((c) => [c.rel, c]));
    const items: AiTitlesResult['items'] = [];
    let dropped = parsed.dropped;
    for (const row of parsed.list) {
      const c = known.get(row.path);
      if (!c) {
        dropped += 1; // 幻觉路径 / 没有原样照抄
        continue;
      }
      if (items.some((it) => it.rel === c.rel)) {
        dropped += 1; // 同一篇列了两遍 —— 只留第一遍
        continue;
      }
      items.push({ rel: c.rel, current: c.current, options: row.options });
    }
    return {
      items,
      blocked,
      fed,
      dropped,
      reply: parsed.reply,
      usage: run.usage,
    };
  }

  /**
   * **AI 补声明**（P7.12 · v2：AI 补属性 = 给缺「文件位置」的笔记挑落点目录）。
   *
   * 与 `proposeTitles` 同族：单轮任务、结构化返回、不走 agent 工具循环；
   * **只出候选值、不动库** —— 产物由 `ui/suggest-panel.ts` / 一键整理接走，
   * 走确认流 → `fm.set`（补「文件位置」）。
   * 三条口径：
   *  · 候选 = **没有「文件位置」声明**（`declaredPositions` 为空，与建议链同一份判据）、
   *    非模板、库根之下、不在工具区（`metaDir` 之下）、
   *    非 `03_AI指令集`（保护目录整篇跳过 —— 那条链不许碰它，与起标题同一道闸）；
   *  · 值域 = **库里真有的目录**（去掉收件箱与工具区 —— 落点建议不该是"留在原地"、
   *    也不该指向配置区）；**模型给了清单外的值一律判丢**；
   *  · 上限 `AI_LIMITS.locusNotes`（`fed` 如实回报"看过哪几篇"）；
   *  · `input.notes` 给了就**按名单收窄**（P7.12 · #9/#11「一键整理」：本范围里那几篇；
   *    改声明那类**本来就带声明**（只是指向不存在/排除区目录）——带上名单也照喂。
   *    不给名单 = 建议面板那条路，一字不动）。
   */
  async proposeLocus(
    input: {
      signal?: AbortSignal;
      notes?: string[];
      /** 横切（P7.21 · #1）：能力包 / 工作目录 */
      skill?: AiSkill | null;
      workDir?: string;
    } = {},
  ): Promise<AiLocusResult> {
    const kbRoot = this.settings.kbRoot();
    const protectedAbs = this.protectedDir();
    const metaPrefix = `${this.settings.get().metaDir.replace(/^\/+|\/+$/g, '')}/`;
    /** 允许的落点：库里的目录，去掉收件箱 / 工具区 / 库根自身（`usableDirs` 已去 ''） */
    const dirs = this.usableDirs().filter(
      (d) => d !== INBOX_DIR && !(d === metaPrefix.slice(0, -1) || d.startsWith(metaPrefix)),
    );
    const only = input.notes !== undefined ? new Set(input.notes) : null;
    const picked = this.index
      .notes()
      .filter((e) => {
        if (e.isTemplate) return false;
        const rel = relativeTo(e.path, kbRoot);
        if (!rel || rel === e.path) return false;
        if (rel.startsWith(metaPrefix)) return false;
        if (isAiProtected(e.path, protectedAbs)) return false;
        // 工作目录收窄（横切 · P7.21）：候选也收在范围内
        if (!inWorkDir(rel, input.workDir)) return false;
        if (only) return only.has(rel);
        return declaredPositions(e.props).length === 0;
      })
      .sort((a, b) => b.mtime - a.mtime);
    const cands: { rel: string; title: string; snippet: string }[] = [];
    for (const e of picked) {
      if (cands.length >= AI_LIMITS.locusNotes) break;
      cands.push({
        rel: relativeTo(e.path, kbRoot),
        // ⚠️ `NoteEntry.basename` 不带扩展名（TFile 口径）—— 别再过 stripExt（`9.16` 会被切坏）
        title: e.basename,
        snippet: await this.snippetOf(e, AI_LIMITS.locusChars),
      });
    }
    const fed = cands.map((c) => c.rel);
    if (cands.length === 0) {
      return { items: [], fed, dropped: 0, reply: '' };
    }
    const run = await this.runTask(
      AI_TASKS.locus,
      { kbRoot, dirs, notes: cands },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const parsed = run.parsed;
    const known = new Map(cands.map((c) => [c.rel, c]));
    const allowed = new Set(dirs);
    const items: AiLocusResult['items'] = [];
    let dropped = parsed.dropped;
    for (const row of parsed.list) {
      const c = known.get(row.path);
      if (!c) {
        dropped += 1; // 幻觉路径 / 没有原样照抄
        continue;
      }
      if (!allowed.has(row.to)) {
        dropped += 1; // 清单外的目录 —— 判丢，别让下游去替它兜
        continue;
      }
      if (items.some((it) => it.rel === c.rel)) {
        dropped += 1; // 同一篇列了两遍 —— 只留第一遍
        continue;
      }
      items.push({ rel: c.rel, to: row.to });
    }
    return {
      items,
      fed,
      dropped,
      reply: parsed.reply,
      usage: run.usage,
    };
  }

  /**
   * **AI 修链**（P7.13b · E1）：给失效双链猜目标。
   *
   * 与 `proposeTitles` / `proposeLocus` 同族：单轮任务、结构化返回、不走 agent 工具循环；
   * **只出候选值、不动库** —— 产物由 `ui/link-panel.ts` 接走，走
   * 「确认流 → 快照 → `vault.process` 按行改（只改认得出的那条）」。
   * 四条口径：
   *  · 候选笔记 = **带 `broken-link` 旗标**的非模板笔记（与首页那一行**同源**）；
   *    保护目录（`03_AI指令集`）整篇跳过 —— 这条链会写它的正文，归那道闸管；
   *  · 材料 = 这一篇的**失效链清单**（`brokenLinkTexts`，与旗标**同一份实现**）
   *    ＋ 正文开头（`AI_LIMITS.linkChars`）；
   *  · 值域 = **全库标题**（非模板、去保护目录、去重排序；上限 `AI_LIMITS.linkTitles`）
   *    —— 清单外一律判丢（模型很爱编一个"听起来对"的名字）；
   *  · `from` 必须**归一化后原样命中**该篇的失效链之一 —— 编的判丢。
   */
  async proposeLinks(
    input: {
      signal?: AbortSignal;
      notes?: string[];
      /** 横切（P7.21 · #1）：能力包 / 工作目录 */
      skill?: AiSkill | null;
      workDir?: string;
    } = {},
  ): Promise<AiLinksResult> {
    const kbRoot = this.settings.kbRoot();
    const protectedAbs = this.protectedDir();
    const only = input.notes !== undefined ? new Set(input.notes) : null;
    const picked = this.index
      .notes()
      .filter((e) => {
        if (!e.flags.includes('broken-link')) return false;
        const rel = relativeTo(e.path, kbRoot);
        if (!rel || rel === e.path) return false;
        if (isAiProtected(e.path, protectedAbs)) return false;
        // 工作目录收窄（横切 · P7.21）：候选也收在范围内
        if (!inWorkDir(rel, input.workDir)) return false;
        if (only) return only.has(rel);
        return true;
      })
      .sort((a, b) => b.mtime - a.mtime);
    const cands: { rel: string; title: string; links: string[]; snippet: string }[] = [];
    for (const e of picked) {
      if (cands.length >= AI_LIMITS.linkNotes) break;
      const links = brokenLinkTexts(this.app, e.file, this.app.metadataCache.getFileCache(e.file));
      if (links.length === 0) continue; // 竞态：旗标还在、链已经被修好
      cands.push({
        rel: relativeTo(e.path, kbRoot),
        // ⚠️ `NoteEntry.basename` 不带扩展名（TFile 口径）—— 别再过 stripExt
        title: e.basename,
        links,
        snippet: await this.snippetOf(e, AI_LIMITS.linkChars),
      });
    }
    const fed = cands.map((c) => c.rel);
    /** 标题池（候选值域）：非模板、去保护目录、去重、按名排序（确定性）；上限在切片处 */
    const titleSet = new Set<string>();
    for (const e of this.index.notes()) {
      if (isAiProtected(e.path, protectedAbs)) continue;
      titleSet.add(e.basename);
    }
    const titles = Array.from(titleSet)
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .slice(0, AI_LIMITS.linkTitles);
    if (cands.length === 0) {
      return { items: [], fed, dropped: 0, reply: '' };
    }
    const run = await this.runTask(
      AI_TASKS.links,
      { kbRoot, titles, notes: cands },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const parsed = run.parsed;
    const known = new Map(cands.map((c) => [c.rel, c]));
    const allowed = new Set(titles);
    const items: AiLinksResult['items'] = [];
    let dropped = parsed.dropped;
    for (const row of parsed.list) {
      const c = known.get(row.path);
      if (!c) {
        dropped += 1; // 幻觉路径 / 没有原样照抄
        continue;
      }
      const from = normalizeLinkText(row.from);
      if (from === '' || !c.links.includes(from)) {
        dropped += 1; // from 认不出 / 不是这一篇的失效链
        continue;
      }
      const options = row.options.filter((o) => allowed.has(o));
      if (options.length === 0) {
        dropped += 1; // 候选全在标题清单外（幻觉）
        continue;
      }
      if (items.some((it) => it.rel === c.rel && it.from === from)) {
        dropped += 1; // 同一条链列了两遍 —— 只留第一遍
        continue;
      }
      items.push({ rel: c.rel, from, options });
    }
    return {
      items,
      fed,
      dropped,
      reply: parsed.reply,
      usage: run.usage,
    };
  }

  /**
   * **「美化笔记」**（P7.12 · R8）：读这一篇的正文 → 出美化稿（**整篇正文**）。
   *
   * 四条口径：
   *   · **只出稿，不动库**——写不写由界面（`ui/beautify.ts`）走
   *     「预览对比 → 确认流 → 快照 → `vault.process`」；本方法连 `markSelfWrite` 都不碰；
   *   · 前言**根本不进提示词、也不在返回里**（模型够不着 = 改不了）；
   *   · 🔴 **超长拒绝、绝不截断**：这一档是"整篇替换"，没看全的内容会被替换稿整个吃掉
   *     （截断在这里 = 静默数据丢失）——上限 `AI_LIMITS.beautifyChars`，超了直接拒绝。
   *   · 保护目录（`03_AI指令集`）**在这里不判** —— 与起标题同一道闸在调用方
   *     （`ui/beautify.ts` 建流程前就拦），这里只做"够得着的东西"。
   */
  async beautify(input: {
    rel: string;
    signal?: AbortSignal;
    /** 横切（P7.21 · #1）：能力包 / 工作目录（单篇任务 —— 越界 = 直接拒，不静默换篇） */
    skill?: AiSkill | null;
    workDir?: string;
  }): Promise<AiBeautifyResult> {
    const kbRoot = this.settings.kbRoot();
    if (!inWorkDir(input.rel, input.workDir)) {
      throw new Error(`这一篇在这次对话的工作目录「${input.workDir}」之外（换一篇，或把工作目录清掉）`);
    }
    const abs = joinPath(kbRoot, input.rel);
    const file = this.app.vault.getAbstractFileByPath(abs);
    if (!(file instanceof TFile)) throw new Error('这一篇不在库里了（可能刚被搬走或改名）');
    const text = await this.app.vault.cachedRead(file);
    const { body } = splitFrontmatter(text);
    if (body.trim() === '') throw new Error('这篇没有正文（空笔记没什么可美化的）');
    if (body.length > AI_LIMITS.beautifyChars) {
      throw new Error(
        `正文有 ${body.length} 字，超过美化上限 ${AI_LIMITS.beautifyChars} 字 —— 先拆短再试（这一档整篇替换，截断会丢内容）`,
      );
    }
    const run = await this.runTask(
      AI_TASKS.beautify,
      {
        kbRoot,
        rel: input.rel,
        title: file.basename,
        body,
      },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const parsed = run.parsed;
    return {
      rel: input.rel,
      body: parsed.body,
      reply: run.text,
      usage: run.usage,
    };
  }

  /**
   * **从一篇笔记生成回顾卡**（P8 期 4）。
   *
   * 与「美化笔记」同一条边界（逐条对齐，别在实现里放宽）：
   *   · **只出稿、不动库** —— 写不写由界面（`ui/review-gen.ts` → 确认流 → 落库）
   *     说了算；本方法连 `markSelfWrite` 都不碰；
   *   · 前言**根本不进提示词**（模型够不着）；
   *   · 🔴 **超长拒绝、绝不截断**（截断 = 漏掉该出的卡，是**静默的质量损失**）；
   *   · 保护目录（`03_AI指令集`）**不在这里判** —— 与起标题/美化同一道闸在调用方。
   *
   * ⚠️ **不给 AI 加新工具**（`AI接口冻结-P7.3c.md` 的工具表已冻结）：
   * "从笔记生成卡片"是**插件侧的动作** —— 模型只说，插件才做。
   */
  async reviewCards(input: { rel: string; signal?: AbortSignal }): Promise<AiReviewResult> {
    const kbRoot = this.settings.kbRoot();
    const abs = joinPath(kbRoot, input.rel);
    const file = this.app.vault.getAbstractFileByPath(abs);
    if (!(file instanceof TFile)) throw new Error('这一篇不在库里了（可能刚被搬走或改名）');
    const text = await this.app.vault.cachedRead(file);
    const { body } = splitFrontmatter(text);
    if (body.trim() === '') throw new Error('这篇没有正文（空笔记里没什么可问的）');
    if (body.length > AI_LIMITS.reviewChars) {
      throw new Error(
        `正文有 ${body.length} 字，超过生成上限 ${AI_LIMITS.reviewChars} 字 —— 先拆短再试（截断会漏掉该出的卡）`,
      );
    }
    const run = await this.runTask(
      AI_TASKS.review,
      { kbRoot, rel: input.rel, title: file.basename, body },
      { signal: input.signal },
    );
    const parsed = run.parsed;
    return {
      rel: input.rel,
      cards: parsed.cards,
      truncated: parsed.truncated,
      reply: run.text,
      usage: run.usage,
    };
  }

  /**
   * **「修前言」**（P7.16 · #3）：读这一篇的前言段 → 出"修好的前言这段文本"。
   *
   * 五条口径：
   *   · **只出稿，不动库**——写不写由界面（`ui/fm-repair-panel.ts`）走
   *     「预览对比 → 确认流 → 快照 → `vault.process`」；本方法连 `markSelfWrite`
   *     都不碰（那条链标它）；
   *   · 材料 = **前言段原文 + 顶层键名清单**（键清单既是给模型的约束，
   *     也是这里出稿后校验的锚：`validateFmRepair`，键一个不少、一个不多）；
   *   · **超长拒绝、绝不截断**：这一档是"整段替换"，没看全会被修稿整个吃掉
   *     ——上限 `AI_LIMITS.fmChars`（前言正常只有几行，4000 字足够宽裕）；
   *   · 保护目录（`03_AI指令集`）**在这里不判** —— 与美化/起标题同一道闸在调用方
   *     （修前言面板按旗标收篇、旗标本就不给保护目录亮；这里只做"够得着的东西"）；
   *   · 校验不过 → 抛 `AiParseError`（**绝不把没通过检查的稿子交出去**）。
   */
  async fixFrontmatter(input: {
    rel: string;
    signal?: AbortSignal;
    /** 横切（P7.21 · #1）：能力包 / 工作目录（单篇任务 —— 越界 = 直接拒，不静默换篇） */
    skill?: AiSkill | null;
    workDir?: string;
  }): Promise<AiFixFmResult> {
    const kbRoot = this.settings.kbRoot();
    if (!inWorkDir(input.rel, input.workDir)) {
      throw new Error(`这一篇在这次对话的工作目录「${input.workDir}」之外（换一篇，或把工作目录清掉）`);
    }
    const abs = joinPath(kbRoot, input.rel);
    const file = this.app.vault.getAbstractFileByPath(abs);
    if (!(file instanceof TFile)) throw new Error('这一篇不在库里了（可能刚被搬走或改名）');
    const text = await this.app.vault.cachedRead(file);
    const inner = frontmatterInnerOf(text);
    if (inner == null) throw new Error('这篇没有规范的前言块（开头三横线、收尾三横线那一种）');
    if (inner.length > AI_LIMITS.fmChars) {
      throw new Error(
        `前言有 ${inner.length} 字，超过修复上限 ${AI_LIMITS.fmChars} 字 —— 先手工收拾一下再试（这一档整段替换，截断会丢内容）`,
      );
    }
    const keys = topLevelKeysOf(inner);
    const run = await this.runTask(
      AI_TASKS['fix-fm'],
      {
        kbRoot,
        rel: input.rel,
        title: file.basename,
        inner,
        keys,
      },
      { skill: input.skill ?? undefined, workDir: input.workDir, signal: input.signal },
    );
    const parsed = run.parsed;
    const check = validateFmRepair(inner, parsed.inner);
    if (!check.ok) {
      throw new AiParseError(`AI 的修复稿没通过检查：${check.why}（没有替换，原件没动）`, run.text);
    }
    return {
      rel: input.rel,
      // 出稿依据的那一版（面板写盘前比对它 —— 见 AiFixFmResult.innerBefore 的注释）
      innerBefore: inner,
      inner: parsed.inner,
      reply: run.text,
      usage: run.usage,
    };
  }

  /** 候选摘要：剥前言 → 压空白 → 截 120 字（分类提示词的"读摘要"） */
  private async snippetOf(e: NoteEntry, chars = 120): Promise<string> {
    try {
      const f = this.app.vault.getAbstractFileByPath(e.path);
      if (!(f instanceof TFile)) return '';
      const text = headOfText(await this.app.vault.cachedRead(f)).replace(/\s+/g, ' ').trim();
      return text.slice(0, chars);
    } catch {
      return '';
    }
  }

  /**
   * 把 `@` 引用解析成"喂给提示词的材料"：`note` 现读正文（`cachedRead`，截断交给 `buildMessages`），
   * `selection` 用面板带来的正文。**读不到的文件静默跳过**（提完问的一瞬间被搬走/删了是竞态，
   * 不值得为它拦下整次提问 —— 面板在发送前已经把不在库里的过滤掉了）。
   */
  private async resolveRefs(refs: AiRef[]): Promise<AiRef[]> {
    const out: AiRef[] = [];
    for (const r of refs.slice(0, AI_LIMITS.refs)) {
      /**
       * ⚠️ 防御性筛（独立审查 🟢10）：会话文件是**长期资产**，手改/损坏的 `refs`
       * 可能缺 `path` —— 不筛的话 `getAbstractFileByPath(undefined)` 会在下面抛，
       * 一次正常提问变成看不懂的报错。
       */
      if (typeof r?.path !== 'string' || r.path === '') continue;
      // selection（选区）与 folder（文件夹清单，P7.10 · #12）的正文都由面板带过来
      if (r.kind === 'selection' || r.kind === 'folder') {
        out.push({ ...r, text: String(r.text ?? '') });
        continue;
      }
      const f = this.app.vault.getAbstractFileByPath(r.path);
      if (!(f instanceof TFile)) continue;
      try {
        out.push({ ...r, text: await this.app.vault.cachedRead(f) });
      } catch {
        // 读不到就跳过（与 `readRules` 同一条口径：材料是锦上添花）
      }
    }
    return out;
  }

  /**
   * **只读**地取用户自己定的整理规范（`03_AI指令集/` 下的全部 `.md`）。
   *
   * 读不到（还没建、或用户删了）就当空串 —— 提示词里那一段整体不出现。
   * **绝不写**：整个文件里没有任何一处对它调写盘 API。
   */
  async readRules(): Promise<string> {
    const dir = this.protectedDir();
    if (!dir) return '';
    const out: string[] = [];
    let budget = AI_LIMITS.rulesChars;
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFile) || f.extension !== 'md') continue;
      if (!f.path.startsWith(`${dir}/`)) continue;
      try {
        const text = await this.app.vault.cachedRead(f);
        const slice = text.slice(0, Math.max(0, budget));
        if (slice.trim() === '') continue;
        out.push(`### ${baseName(f.path)}\n${slice}`);
        budget -= slice.length;
      } catch {
        // 读不到就跳过：规范是"锦上添花"，缺一段不该让整次提问失败
      }
      if (budget <= 0) break;
    }
    return out.join('\n\n');
  }

  /** 提示词里那份目录清单（相对库根；去掉 `''` 这条"库根本身"） */
  private usableDirs(): string[] {
    const all = Array.from(kbDirsOf(this.app, this.settings.kbRoot())).filter((d) => d !== '');
    all.sort();
    return all.slice(0, AI_LIMITS.dirs);
  }

  /** `buildAiPlan` 要的落点白名单：**库内绝对路径**（含库根自身） */
  private absDirs(): Set<string> {
    const kbRoot = this.settings.kbRoot();
    const out = new Set<string>();
    for (const d of kbDirsOf(this.app, kbRoot)) out.add(d === '' ? kbRoot : joinPath(kbRoot, d));
    return out;
  }

  /**
   * 候选笔记：库根之下、**按 mtime 倒序**取前 N 篇。
   *
   * 为什么按 mtime：用户说"把这 3 篇…"时，他多半刚看过/刚写它们。
   * 为什么截断：整库喂进去既贵又会让模型抓不住重点（本项目实测库 40+ 篇尚可，
   * 上千篇就废了）—— 截断是**明说的**，提示词里那句"`path` 只能从这些里选"就是它。
   */
  private candidates(): AiCandidate[] {
    const kbRoot = this.settings.kbRoot();
    const list: NoteEntry[] = this.index
      .notes()
      .filter((e) => isInside(e.path, kbRoot))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, AI_LIMITS.candidates);
    return list.map((e) => ({
      rel: relativeTo(e.path, kbRoot),
      title: e.basename, // 无扩展名（P7.10 修 stripExt 二次剥离）
      props: briefProps(e),
    }));
  }
}

/**
 * 上一轮喂回上下文时，**AI 那一侧写什么**（P6 第八段：让多轮真的接得上）。
 *
 * 🔴 只带 `reply` 的话，"把第二篇也挪过去"这种话模型根本接不上 —— 它看不见上一轮提了哪几篇。
 * 但**也不能把整张表原样喂回去**：那会让它倾向于"在旧表上小改"，而用户说「改一下」
 * 多半是换了意思（`prompt.ts` 头注那条）。折中：正文照给，**建议压成一行清单**（最多 5 条）。
 */
function recapOf(t: AiTurn): string {
  const head = t.reply.trim();
  /**
   * agent 轮的"做过什么"从 `steps` 里的**结果**取（不是从建议取）——
   * 用户可能勾掉/跳过几条，只有结果才代表真的发生过。
   */
  const lines =
    t.steps && t.steps.length > 0
      ? t.steps.flatMap((s) => s.items.map((it) => it.outcome.summary)).filter((s) => s.trim() !== '')
      : t.ideas.slice(0, 5).map((i) => `${i.path} → ${i.to}`);
  if (lines.length === 0) return head;
  const shown = lines.slice(0, 6);
  const more = lines.length > shown.length ? `（另有 ${lines.length - shown.length} 条）` : '';
  const label = t.steps && t.steps.length > 0 ? '上一轮做过' : '上一轮我提的建议';
  return `${head}\n（${label}：${shown.join('；')}${more}）`;
}

/** 几个关键属性压成一行（只列有值的，全空就返回空串） */
function briefProps(e: NoteEntry): string {
  const parts: string[] = [];
  for (const key of BRIEF_PROPS) {
    const v = e.props?.[key];
    if (v == null) continue;
    const s = Array.isArray(v) ? v.join('、') : String(v);
    if (s.trim() === '') continue;
    parts.push(`${key}:${s.trim()}`);
  }
  // 已有的位置声明是**最重要的一条**（模型据此判"这篇该不该动"）
  if (parts.length === 0 && e.effectivePosition) parts.push(`在:${e.effectivePosition}`);
  return parts.join(' ');
}

export type { AiMessage };
