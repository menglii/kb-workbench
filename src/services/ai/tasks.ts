/**
 * services/ai/tasks.ts —— **任务注册表 + 统一 runner**（P7.21 · #1）
 *
 * ## 为什么有这份文件
 *
 * 在这之前，AI 有"一条 agent + 八条硬编码管线"：每条管线各写一遍
 * 「拼提示词 → 调模型 → 解析 → 算用量」，**加一个新场景 = 改 5 处**；
 * 而 skill（能力包）/ 工作目录这些**横切能力只有 agent 一条路接得进去**（成本脚注各管线
 * 各算各的一份 —— 不是没有，是**没有单一口径**，谁漏了没人知道）。
 *
 * 现在：**一条任务 = 一行数据**（id · 人话名 · 会话 kind · 入口 · 工具面 ·
 * 提示词 builder · 输出 parser）。提示词与解析还是各任务自己的纯函数（住在
 * `prompt.ts`）—— 注册表负责的是**把线接起来**：统一 runner 走同一段
 * 「build → 调模型（累计用量）→ parse」，横切输入（`skill` / `workDir` /
 * `taskNote` —— P7.22b · #3 的 AI 提示词附加层）由
 * runner 统一递给每一条任务的 builder，**没人漏得掉**。
 *
 * ## 两种形状，一段 runner
 *
 * · `tools === null`（八条管线 + 老轻量 `ask`）：单轮 —— 调一次、解析一次；
 * · `tools !== null`（`agent`）：交给 `runAgentLoop` 的工具循环，parser 也走行里那份。
 *
 * ## 判据（`tests/specs/p721.ts`）
 *
 * ① **任取两任务**：skill 进 system · workDir 收候选 · 成本脚注（`usage`）都生效；
 * ② **新任务 = 一条数据**：临时造一行假任务，走 `runAiTask` 能跑通（不进产品）。
 *
 * 🔴 本文件与 `tools.ts` / `agent.ts` / `prompt.ts` 同守一条隔离：不许 import
 * `ui/` / `modules/` / `mover` / `obsidian`（静态断言钉着 —— 新文件要同步进
 * `tests/specs/redline.ts` 的名单，别让"新文件天然逃逸"再犯一次）。
 */
import type { AiAgentHooks, AiAgentResult, ToolPort } from './agent';
import { runAgentLoop } from './agent';
import { addUsage, emptyUsage, type AiTurnUsage } from './cost';
import {
  buildAgentMessages,
  buildBeautifyMessages,
  buildClassifyMessages,
  buildFixFmMessages,
  buildLinkFixMessages,
  buildLocusMessages,
  buildMessages,
  buildMocPickMessages,
  buildReviewMessages,
  buildTitleMessages,
  parseAdvice,
  parseAgentReply,
  parseBeautify,
  parseFixFm,
  parseLinkFix,
  parseLocus,
  parseReview,
  parseTitles,
  type AiAdvice,
  type AiBeautify,
  type AiCrossInput,
  type AiFixFm,
  type AiLinkFix,
  type AiLocus,
  type AiMessage,
  type AiReview,
  type AiTitles,
  type BeautifyInput,
  type ClassifyInput,
  type FixFmInput,
  type LinkFixInput,
  type LocusInput,
  type MocPickInput,
  type PromptInput,
  type ReviewInput,
  type TitleInput,
} from './prompt';
import { AI_TOOL_NAMES, type AiToolName } from './tools';
import type { AiReply } from './transport';

// ────────────────────────────────────────────────────────────────
// 注册表
// ────────────────────────────────────────────────────────────────
/**
 * 任务 id（调用方按它取行；改名字 = 改契约，文档与判据跟着改）。
 *
 * ⚠️ **开放联合**（末尾的 `(string & {})`）：前十个是注册表里现成的 id（有补全），
 * 后面留口子 —— "新任务 = 一条数据"那句话就靠它落地：临时造一行假任务
 * （`tests/specs/p721.ts` 的自证用例）**不必回来改这个 type**。
 */
export type AiTaskId =
  | 'ask'
  | 'agent'
  | 'classify'
  | 'moc'
  | 'titles'
  | 'locus'
  | 'links'
  | 'beautify'
  | 'fix-fm'
  | 'review'
  | (string & {});

/**
 * 一条任务 = 一行数据。
 *
 * · `kind` 是**声明的会话 kind**（记进 `AiTurn.kind` 的口径；agent 轮实际值由运行结果的
 *   steps 定、单轮由解析产物的 `kind` 定 —— 由 runner 折算，见 `AiTaskRun.kind`）；
 * · `tools` 非 null = 这条任务走**工具循环**（名字就是它的工具面）；
 * · `build` / `parse` 都是纯函数（住 `prompt.ts`，可离线逐条断言）。
 */
export interface AiTaskDef<I extends AiCrossInput, O> {
  id: AiTaskId;
  /** 人话名（文档 / 自证 / 排错用） */
  label: string;
  /** 声明的会话 kind（`chat` / `advice` / `agent`） */
  kind: 'chat' | 'advice' | 'agent';
  /** 入口：哪块界面拉起这条任务（文档与自证认它） */
  entry: string;
  /** 需要的工具面（null = 这条任务不碰工具） */
  tools: AiToolName[] | null;
  /** 材料 → 提示词（纯函数） */
  build(input: I): AiMessage[];
  /** 回话 → 产物（纯函数；形状不对抛 `AiParseError`） */
  parse(text: string): O;
}

/**
 * **任务注册表**（真源）。加一条任务 = 往这里加一行 + 它的 builder/parser
 * （`tests/specs/p721.ts` 有一条"新任务 = 一条数据"的自证）。
 */
export const AI_TASKS = {
  ask: {
    id: 'ask',
    label: '问一轮（轻量）',
    kind: 'advice',
    entry: '设置栏「问 AI」',
    tools: null,
    build: buildMessages,
    parse: parseAdvice,
  } satisfies AiTaskDef<PromptInput, AiAdvice>,

  agent: {
    id: 'agent',
    label: '干活一轮（工具循环）',
    kind: 'agent',
    entry: 'AI 面板（浮层）',
    // 工具面 = 全表（从 `tools.ts` 那张表来 —— 别在这儿抄第二份名单，会漂）
    tools: [...AI_TOOL_NAMES],
    build: buildAgentMessages,
    parse: parseAgentReply,
  } satisfies AiTaskDef<PromptInput, ReturnType<typeof parseAgentReply>>,

  classify: {
    id: 'classify',
    label: '逐篇分诊',
    kind: 'advice',
    entry: '整理建议面板 · A 类「AI 自动去做」',
    tools: null,
    build: buildClassifyMessages,
    parse: parseAdvice,
  } satisfies AiTaskDef<ClassifyInput, AiAdvice>,

  moc: {
    id: 'moc',
    label: 'MOC 挑节',
    kind: 'advice',
    entry: '整理建议面板 · C 类（知识地图）',
    tools: null,
    build: buildMocPickMessages,
    parse: parseAdvice,
  } satisfies AiTaskDef<MocPickInput, AiAdvice>,

  titles: {
    id: 'titles',
    label: '起标题',
    kind: 'advice',
    entry: '起标题面板 / 编辑器右键「自动命名」',
    tools: null,
    build: buildTitleMessages,
    parse: parseTitles,
  } satisfies AiTaskDef<TitleInput, AiTitles>,

  locus: {
    id: 'locus',
    label: '补「文件位置」声明',
    kind: 'advice',
    entry: '整理建议面板 · B 类 / 首页一键整理',
    tools: null,
    build: buildLocusMessages,
    parse: parseLocus,
  } satisfies AiTaskDef<LocusInput, AiLocus>,

  links: {
    id: 'links',
    label: '修失效双链',
    kind: 'advice',
    entry: '修链面板',
    tools: null,
    build: buildLinkFixMessages,
    parse: parseLinkFix,
  } satisfies AiTaskDef<LinkFixInput, AiLinkFix>,

  beautify: {
    id: 'beautify',
    label: '美化笔记',
    kind: 'advice',
    entry: '编辑器右键「美化笔记」',
    tools: null,
    build: buildBeautifyMessages,
    parse: parseBeautify,
  } satisfies AiTaskDef<BeautifyInput, AiBeautify>,

  'fix-fm': {
    id: 'fix-fm',
    label: '修前言',
    kind: 'advice',
    entry: '修前言面板（待处理 · 坏前言）',
    tools: null,
    build: buildFixFmMessages,
    parse: parseFixFm,
  } satisfies AiTaskDef<FixFmInput, AiFixFm>,

  review: {
    id: 'review',
    label: '生成回顾卡',
    kind: 'advice',
    entry: '回顾栏「从笔记生成」/ 笔记右键「用 AI 生成」（P8）',
    tools: null,
    build: buildReviewMessages,
    parse: parseReview,
  } satisfies AiTaskDef<ReviewInput, AiReview>,
};

/** 全表（数组视图；文档 / 自证 / 遍历用 —— 类型取 `keyof`，别用开放联合去索引，TS 不许） */
export const AI_TASK_LIST: readonly (typeof AI_TASKS)[keyof typeof AI_TASKS][] = Object.values(AI_TASKS);

/** 按 id 取一行（拿不准 id 时用 `AI_TASKS.xxx` 直接取也行 —— 这里给运行期字符串用的） */
export function taskById(id: string): (typeof AI_TASKS)[keyof typeof AI_TASKS] | null {
  return Object.prototype.hasOwnProperty.call(AI_TASKS, id)
    ? (AI_TASKS as Record<string, (typeof AI_TASKS)[keyof typeof AI_TASKS]>)[id]
    : null;
}

/**
 * **工作目录收窄**（横切 · 单一出处）：`rel` 在这条相对目录之下吗（`''` / 不给 = 全库）。
 * 服务层挑材料的各条任务都过它 —— "候选收在工作目录里"这句话的代码落点。
 */
export function inWorkDir(rel: string, workDir?: string): boolean {
  const d = String(workDir ?? '').replace(/^\/+|\/+$/g, '');
  if (d === '') return true;
  return rel === d || rel.startsWith(`${d}/`);
}

// ────────────────────────────────────────────────────────────────
// 统一 runner
// ────────────────────────────────────────────────────────────────
/** 横切输入 + 这一趟的取消/流式（`skill` / `workDir` / `taskNote` 由 runner 统一递给 builder） */
export interface AiTaskCross extends AiCrossInput {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

/** runner 的依赖：怎么调模型（服务层接真实传输；用例/自证接假的）+ 工具循环的两个口子 */
export interface AiTaskDeps {
  callModel(
    messages: AiMessage[],
    opts: { onDelta?: (delta: string) => void; signal?: AbortSignal },
  ): Promise<AiReply>;
  /** 工具循环的执行端口（**只有 `tools` 非 null 的任务用得到**） */
  port?: ToolPort;
  hooks?: AiAgentHooks;
}

/**
 * 一趟 runner 的结果（成本脚注 / 材料 / 产物都在这里 —— 各任务按需取）。
 * 两种形状按行里的 `tools` 分（见 `runAiTask` 的重载）：
 * 单轮任务有 `parsed`、工具循环任务有 `agent` —— **合起来就是完成定义里
 * "任务注册表的两种形态"**，调用方拿到的字段永远是确定的（不是可选字段满地 `!`）。
 */
export interface AiSingleRun<O> {
  task: AiTaskId;
  /** **实际的**会话 kind（单轮：由解析产物的 `kind` 定、缺省回落行里的声明） */
  kind: 'chat' | 'advice';
  /** 这一趟真发出去的消息（判据 / 排错看它） */
  messages: AiMessage[];
  /** 模型的终答（已 trim） */
  text: string;
  /** 解析产物 */
  parsed: O;
  /** 这一趟的用量（横切：**每条任务都由这里出**，界面照旧画"成本脚注"） */
  usage: AiTurnUsage;
}

export interface AiAgentRun {
  task: AiTaskId;
  /** **实际的**会话 kind（循环：`steps` 非空 = agent 轮，否则聊天轮） */
  kind: 'chat' | 'agent';
  messages: AiMessage[];
  /** 模型的终答（最后一轮散文） */
  text: string;
  /** 工具循环的结果（steps / stopped / aborted / error 都在里面） */
  agent: AiAgentResult;
  usage: AiTurnUsage;
}

/** 兼容别名（文档与自证里泛指"一趟结果"时用） */
export type AiTaskRun<O> = AiSingleRun<O> | AiAgentRun;

/**
 * **统一 runner**：build → 调模型（用量统一累计）→ parse。
 * 横切在这儿一次做对：`skill` / `workDir` 并进每一条任务的 build 输入（没人漏得掉）。
 *
 * 两种形状按行里的 `tools` 分派（重载把返回类型也拆开）：
 * · `tools: null` → 单轮（`AiSingleRun`）；· `tools` 非 null → 工具循环（`AiAgentRun`）。
 */
export async function runAiTask<I extends AiCrossInput, O>(
  def: AiTaskDef<I, O> & { tools: AiToolName[] },
  input: I,
  cross: AiTaskCross,
  deps: AiTaskDeps,
): Promise<AiAgentRun>;
export async function runAiTask<I extends AiCrossInput, O>(
  def: AiTaskDef<I, O> & { tools: null },
  input: I,
  cross: AiTaskCross,
  deps: AiTaskDeps,
): Promise<AiSingleRun<O>>;
export async function runAiTask<I extends AiCrossInput, O>(
  def: AiTaskDef<I, O>,
  input: I,
  cross: AiTaskCross,
  deps: AiTaskDeps,
): Promise<AiSingleRun<O> | AiAgentRun> {
  return runAiTaskCore(def, input, cross, deps);
}

/**
 * 统一 runner 的**实机实现**（与上面同一个函数体；这条出口给"手里只有宽类型"的调用方用 ——
 * 服务层的 `runTask` 接线就是，它拿到的 `def` 已经擦成 `AiTaskDef<I, O>`）。
 * ⚠️ 判据 / 自证 / 新调用方走上面的 `runAiTask`（返回类型按行拆开，少一次类型擦除）。
 */
export async function runAiTaskCore<I extends AiCrossInput, O>(
  def: AiTaskDef<I, O>,
  input: I,
  cross: AiTaskCross,
  deps: AiTaskDeps,
): Promise<AiSingleRun<O> | AiAgentRun> {
  const messages = def.build({
    ...input,
    skill: cross.skill,
    workDir: cross.workDir,
    // P7.22b · #3：AI 提示词附加层（服务层读好、切好递进来；没写 = undefined = 不出现）
    taskNote: cross.taskNote,
  });

  /** 用量累计（17.10②）：服务端报了就用真数字，没报就按"这次发出去的消息 + 回来的正文"估算 */
  let usage = emptyUsage();
  const call = async (
    msgs: AiMessage[],
    opts: { onDelta?: (delta: string) => void; signal?: AbortSignal },
  ): Promise<AiReply> => {
    const r = await deps.callModel(msgs, opts);
    usage = addUsage(usage, r.usage, {
      promptText: msgs.map((m) => m.content).join('\n'),
      completionText: r.text,
    });
    return r;
  };

  if (def.tools !== null) {
    // ── 工具循环那条路（agent）：parser 也走行里那份（`agent.ts` 缺省回落到同一份）──
    if (!deps.port) throw new Error(`任务「${def.id}」要走工具循环，但没给执行端口（port）`);
    const res = await runAgentLoop({
      messages,
      callModel: async (msgs, opts) => (await call(msgs, opts)).text,
      port: deps.port,
      hooks: deps.hooks,
      signal: cross.signal,
      parse: def.parse as (text: string) => ReturnType<typeof parseAgentReply>,
    });
    return {
      task: def.id,
      kind: res.steps.length > 0 ? 'agent' : 'chat',
      messages,
      text: res.reply,
      agent: res,
      usage,
    };
  }

  // ── 单轮那条路（八条管线 + 轻量 ask）──
  const reply = await call(messages, { onDelta: cross.onDelta, signal: cross.signal });
  const parsed = def.parse(reply.text);
  /**
   * 实际 kind：解析产物自带 `kind` 的（`parseAdvice` 那一族）以它为准；
   * 否则回落行里的声明 —— 单轮任务的声明只该是 chat / advice
   *（写成 agent 的行是标错了，回落 advice，别把一个单轮结果说成 agent 轮）。
   */
  const k = (parsed as { kind?: unknown })?.kind;
  return {
    task: def.id,
    kind: k === 'chat' || k === 'advice' ? k : def.kind === 'chat' ? 'chat' : 'advice',
    messages,
    text: reply.text,
    parsed,
    usage,
  };
}
