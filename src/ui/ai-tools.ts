/**
 * ui/ai-tools.ts —— agent 的**执行体**（`ToolPort` 的界面侧实现；P7.3b 5.1b）
 *
 * `services/ai/agent.ts` 只认得一个接口（`ToolPort`），真正动手的**全在这里** ——
 * 与 `ui/confirm.ts` 同一层。四层门，顺序固定：
 *
 * ```
 *   能力包白名单（P7.3c；只在用户选了 skill 时存在，**只做减法**）
 *        → 档位（禁/需确认/自动；来自设置）→ 03_AI指令集 硬拦 + 存在性核对
 *        → ui/confirm.ts（写类一律过；「自动」= 自动弹框，不是跳过）
 *        → mover.move / mover.trash / fm.setMany / completion.createNote
 * ```
 *
 * 🔴 **本文件是 `redline.ts` 里那几条静态断言的新家**（原先钉在 `ui/ai-panel.ts`）：
 * 动库只许走 `mover` / `fm` / `completion`；`ui/ai-panel.ts` 反过来**一个字都不许**
 * 出现写盘 API（面板只管画）。
 *
 * ## 三件"看起来该做但故意不做"
 *
 * · **不替模型放宽**：档位来自设置（`effectiveTier`），模型说什么都不改变它
 *   —— 17.10①「模型不能自我授权」的代码落点（提示词那条只是说给模型听的）。
 * · **`03_AI指令集` 拦在确认框之前**：命中的调用连确认都不弹（用户点了也不该执行）。
 *   读允许（AI 本来就要读规范判断），写与搬（进出都算）禁止。
 * · **删除没有第二条路**：`mover.trash`（它自己会拍快照）+ 危险两段确认；
 *   `trashOption === 'none'`（Obsidian 设置成"不删除"）时**直接说明**，不弹框。
 */
// 值导入（P7.24 · #12：只读配置段要 `instanceof TFile` 判存在 —— 不是纯类型位）
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { baseName, isInside, joinPath, parentDir, relativeTo, stripExt } from '../core/paths';
import { kbDirsOf } from '../core/vault-index';
import { declaredPositions } from '../services/schema';
import { writeDeclaredForMoved } from '../services/rebuild';
import { splitFrontmatter } from '../services/frontmatter';
// P7.21 · #2：`stats` 的「待处理」复用首页那一份（同一个 `computeTodoItems`，
// **别在这抄第二份规则** —— "两处各写一份必漂"）。它是 modules 层，但这条依赖的
// 破裂会当场红在全量套件里（P7.3 的"验证钉进套件"那条防线；`todo-actions` 不 import 本文件，无环）。
import { computeTodoItems } from '../modules/home/todo-actions';
import {
  AI_AGENT_LIMITS,
  AI_TOOL_CLASS_OF,
  effectiveTier,
  grepText,
  isAiProtected,
  oneLine,
  planAppend,
  planPatchText,
  rowOfCall,
  TextLru,
  validateCall,
  type AiCallRow,
  type AiToolCall,
  type AiToolName,
  type AiToolOutcome,
  type ToolPort,
} from '../services/ai';
import { cleanNewName, type MoveResult, type MoveTarget } from '../services/mover';
// P7.24 · #12：模板清单（只读）—— 与「新建笔记」的模板下拉同一份（services/templates）
import { templateFiles } from '../services/templates';
import { confirm, type PipeSettle, type PlanRow } from './confirm';
// 服务族（P7.22b 立 L1 · P7.24 升 L2）：跑到确认卡、结算回传（见 AiToolOutcome.settled）
import { openSuggestPanel } from './suggest-panel';
import { openCleanupPanel } from './cleanup-panel';
import { diffBox } from './diff-box';
import { writeDocs, type DocWriteItem } from './doc-write';
import { showMoveUndo } from './undo-move';
import { restoreOrNotify, showUndo } from './undo-bar';
import { notify, NOTIFY_MS } from './notify';

/** 待确认卡上的一行（面板画卡片用；`call` 原样带回去做勾选对齐） */
export interface AiPendingEntry {
  call: AiToolCall;
  row: AiCallRow;
}

export interface AiPortDeps {
  ctx: WorkbenchContext;
  /**
   * 「需确认」档：把这一批摆到气泡里让用户勾选（返回**与传入等长**的布尔数组）。
   * 面板负责：画卡片 · 等点击 · 关面板/停止时把没勾的按 false 收干净。
   * `pendingAuto` = 同一批里**自动档**的条数（它们不进卡、直接排队等确认框）——
   * 面板点「跳过」时的说法要据此如实（独立审查 🟡1：混档时不能写"什么都没改"）。
   */
  askPending(entries: AiPendingEntry[], pendingAuto: number): Promise<boolean[]>;
  /**
   * **能力包的工具白名单**（P7.3c skill 机制；`null` / 不给 = 不限制）。
   *
   * 🔴 **收窄的真正落点在这里**（不在提示词那一侧）：名单外的工具**一律不执行**，
   * 如实回一句"这个能力包没开它"。口径两条：
   *  · 白名单**只会更窄**：名单内的工具照旧走档位 / 确认流 / mover ——
   *    它不改变任何一条既有安全边界，只做减法；
   *  · 它是**用户选的**（面板里显式挑的能力包），不是模型能自己改的。
   */
  allowTools?: AiToolName[] | null;
  /**
   * **本次对话的工作目录**（P7.10 · #12；相对库根，`''` / 不给 = 全库 = 不限定）。
   *
   * 口径（拍板 Q2："本次对话的读写收在选中目录下"）：
   *  · **search / list**：不带 `dir` → 结果收在范围内；带 `dir` 且在范围外 → 拒绝；
   *  · **read / set_prop / set_tags / delete / move 的 `path`**（动的是**哪篇**）必须在范围内；
   *  · **move 的 `to` 不受限** —— 否则"把收件箱归位"这件事本身做不了（落点是目标目录）；
   *  · **create 的 `dir`** 也要在范围内（"写"也收在目录下）。
   * 越界一律**拒绝并如实说明**（`ok:false` + 一句人话，模型看得到原因）——
   * **不做静默过滤**：过滤会让模型以为库里只有这么多，接着瞎猜。
   */
  scopeDir?: string;
  /**
   * **`ask_user` 的回答通道**（P7.21 · #3）：把模型的一个澄清问题摆给用户，收一条答案。
   * 返回 `null` = 用户跳过（或关了面板 —— 等回答时停止键是禁用的）—— 执行体如实回"用户跳过"，**不当错误**。
   * 口径（轮内定，写进冻结说明）：**不设硬超时**，跟随本轮取消；等待时间不计步数预算。
   * 不给这个口子 = 一律按"用户跳过"（离线用例按需注入假回答）。
   */
  askUser?: (question: string) => Promise<string | null>;
}

/**
 * **`grep` 的现扫缓存**（P7.21b · #4）：模块级 —— **跨端口/跨轮次活**（端口每轮新建一个，
 * 放端口里缓存就白瞎了）。指纹 = mtime+size，对不上即失效；容量封顶见 `TextLru`。
 * 纯内存、**无 watcher**（库变靠指纹发现，不做全库监听 —— 那是另一件事）。
 */
const grepCache = new TextLru(AI_AGENT_LIMITS.grepCacheFiles, AI_AGENT_LIMITS.grepCacheChars);

/** 测试用：清空现扫缓存（用例之间别互相吃缓存） */
export function __resetGrepCache(): void {
  grepCache.clear();
}

/** 造一个端口（面板持有一个；离线用例也用它，注入假的 askPending） */
export function makeAiToolPort(deps: AiPortDeps): ToolPort {
  const { ctx } = deps;

  const absOf = (rel: string): string => joinPath(ctx.settings.kbRoot(), rel);
  const noteAt = (rel: string): TFile | null => {
    if (!rel || !ctx.index.get(absOf(rel))) return null;
    const f = ctx.app.vault.getAbstractFileByPath(absOf(rel));
    return f && 'stat' in f ? (f as TFile) : null;
  };

  /** 库里的目录（库内绝对路径；口径 = `buildAiPlan` 的落点白名单，含库根） */
  const dirSet = (): Set<string> => {
    const kbRoot = ctx.settings.kbRoot();
    const out = new Set<string>([kbRoot]);
    for (const d of kbDirsOf(ctx.app, kbRoot)) if (d !== '') out.add(joinPath(kbRoot, d));
    return out;
  };

  // ── 工作目录（P7.10 · #12；口径见 `AiPortDeps.scopeDir` 的长注释）────────
  /** 工作目录的绝对路径（'' = 全库 = 库根自己） */
  const scopeAbs = (): string => {
    const scope = deps.scopeDir ?? '';
    return scope === '' ? ctx.settings.kbRoot() : joinPath(ctx.settings.kbRoot(), scope);
  };
  const inScope = (abs: string): boolean => {
    // P7.14：走 isInside —— 整个库模式下 scopeAbs()=''（没设工作目录收窄时 = 库根自己），
    // 手拼前缀在空串下会恒 false，把"落点校验"整片拒掉
    return isInside(abs, scopeAbs());
  };
  /** 越界那句话（模型与用户同看 —— 说清限定在哪、怎么改；文案过用户黑名单） */
  const outOfScope = (what: string): AiToolOutcome => ({
    ok: false,
    summary: `${what}在这次对话的工作目录之外（这次限定在「${deps.scopeDir}」）—— 换一个，或把工作目录清掉（输入框左边的文件夹按钮）`,
  });

  /** 待确认卡那一行（校验过的调用 → `rowOfCall`，纯函数在 services 侧） */
  const rowFor = (call: AiToolCall): AiCallRow => {
    const check = validateCall(call);
    return check.ok ? rowOfCall(check.call) : { name: String(call.tool ?? ''), detail: '', why: '', danger: false };
  };

  // ── 只读类：search / read / list / stats（直接执行，不过确认）─────────────────
  /**
   * `list`（P7.21 · #2）：列目录结构（本层 / 递归 + 每层计数）。
   *
   * 口径三条：
   *  · `dir` 空 = **工作目录**（没设 = 库根）—— 与 `search` 不带 `dir` 同一口径；
   *  · 给了 `dir` 而库里**没有**这个目录 → **拒绝**（别静默给"本层 0 篇"——
   *    P7.0b 那条老账：不存在与"存在但是空"必须分得开）；
   *  · 工作目录收窄：`dir` 越界 → 拒绝（与 search 同款，如实说）。
   */
  async function runListTool(call: AiToolCall): Promise<AiToolOutcome> {
    const kbRoot = ctx.settings.kbRoot();
    const dir = String(call.args.dir ?? '').trim();
    const scope = deps.scopeDir ?? '';
    if (scope !== '' && dir !== '' && !inScope(absOf(dir))) return outOfScope(`目录「${dir}」`);
    const base = dir !== '' ? dir : scope;
    const baseAbs = base === '' ? kbRoot : absOf(base);
    const allDirs = Array.from(kbDirsOf(ctx.app, kbRoot)).filter((d) => d !== '');
    if (dir !== '' && !allDirs.includes(dir)) {
      return { ok: false, summary: `库里没有「${dir}」这个目录`, detail: '换一个已知的目录名（或先 list 库里有什么）' };
    }
    const notes = ctx.index.notes().filter((e) => isInside(e.path, baseAbs));
    const local = notes.filter((e) => parentDir(e.path) === baseAbs);
    const recursive = call.args.recursive === true;
    const shown = allDirs
      .filter((d) => (recursive ? isInside(joinPath(kbRoot, d), baseAbs) : parentDir(d) === base))
      .sort((a, b) => a.localeCompare(b, 'zh'));

    const lines: string[] = [];
    lines.push(`目录${recursive ? '（递归）' : '（本层）'}：${shown.length === 0 ? '（没有子目录）' : ''}`);
    for (const d of shown.slice(0, AI_AGENT_LIMITS.listLines)) {
      const abs = joinPath(kbRoot, d);
      const own = notes.filter((e) => parentDir(e.path) === abs).length;
      const under = notes.filter((e) => isInside(e.path, abs)).length;
      lines.push(`- ${relativeTo(abs, baseAbs) || d}/ —— 本层 ${own} · 递归 ${under}`);
    }
    if (shown.length > AI_AGENT_LIMITS.listLines) {
      lines.push(`（还有 ${shown.length - AI_AGENT_LIMITS.listLines} 个目录没列 —— 缩小范围再来）`);
    }
    const names = local.slice(0, AI_AGENT_LIMITS.listNames);
    lines.push('');
    lines.push(`本层笔记 ${local.length} 篇${names.length > 0 ? `（最多列 ${AI_AGENT_LIMITS.listNames} 个）：` : ''}`);
    for (const e of names) lines.push(`- ${e.basename}`); // basename 无扩展名（P7.10 口径，别过 stripExt）
    if (local.length > names.length) lines.push(`（还有 ${local.length - names.length} 篇没列）`);
    return {
      ok: true,
      summary:
        `列了「${base || '库根'}」：本层 ${local.length} 篇 · 子目录 ${shown.length} 个` +
        (recursive ? ` · 递归共 ${notes.length} 篇` : ''),
      detail: lines.join('\n'),
    };
  }

  /**
   * `stats`（P7.21 · #2）：库概览 —— 篇数 / 最近改动 / 待处理几项。
   *
   * 口径两条：
   *  · 篇数与最近改动**收在工作目录里**（没设 = 全库）；
   *  · 「待处理」= **首页那一份规则**（`computeTodoItems` —— 同一份缓存的维护三件 +
   *    迁移预演 + 忽略过滤），**全库口径**，行文如实写明；读不出来如实说（不假装 0 项）。
   */
  async function runStatsTool(): Promise<AiToolOutcome> {
    const kbRoot = ctx.settings.kbRoot();
    const scope = deps.scopeDir ?? '';
    const scoped = scope !== '';
    const scopeAbsPath = scoped ? absOf(scope) : kbRoot;
    const notesAll = ctx.index.notes();
    const notesIn = notesAll.filter((e) => isInside(e.path, scopeAbsPath));
    const recent = notesIn
      .slice()
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    let todo: Awaited<ReturnType<typeof computeTodoItems>> | null = null;
    let todoErr = '';
    try {
      todo = await computeTodoItems(ctx);
    } catch (e) {
      todoErr = e instanceof Error ? e.message : String(e);
    }

    const fmtTime = (ms: number): string => {
      const d = new Date(ms);
      const two = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    };
    const detail: string[] = [];
    if (recent.length > 0) {
      detail.push('最近改动：');
      for (const e of recent) detail.push(`- ${relativeTo(e.path, kbRoot)}（${fmtTime(e.mtime)}）`);
    } else {
      detail.push('最近改动：（这个范围里一篇都没有）');
    }
    detail.push('');
    if (todo) {
      detail.push(`待处理 ${todo.length} 项（与首页「待处理」同一份规则${scoped ? '；全库口径' : ''}）：`);
      for (const t of todo.slice(0, AI_AGENT_LIMITS.statsTodos)) detail.push(`- ${t.text}`);
      if (todo.length > AI_AGENT_LIMITS.statsTodos) {
        detail.push(`（还有 ${todo.length - AI_AGENT_LIMITS.statsTodos} 项没列）`);
      }
    } else {
      detail.push(`待处理：这次读不出来${todoErr ? `（${todoErr}）` : ''}`);
    }
    /**
     * **库级配置（P7.24 · #12）**：库结构 / 看板配置 / 模板清单 —— **只读起步**。
     *
     * 🔴 只读纪律（判据两半）：① **静态** —— `[P7.24-12-BEGIN]..[P7.24-12-END]` 标记块内
     * 不许出现任何写调用（`configs.write/ensure`、`vault.process/modify/create`、
     * `processFrontMatter`；判据在 `tests/specs/p724.ts` 的静态红线）；② **运行时** ——
     * 假 port 跑一遍、写面 spy 零调用。写留后拍（AI 的所有写仍走既有确认流）。
     *
     * 三份都"存在/缺失"两态：**缺失如实说"没有这份配置"** —— `configs.read` 内部会对
     * 缺失/坏文件回默认值，所以先 `exists()` 判存在性，**别拿 defaults() 造一份**。
     */
    // [P7.24-12-BEGIN]
    const cfgLines: string[] = [];
    for (const [name, title] of [
      ['rebuild', '库结构.json'],
      ['board', '看板配置.json'],
    ] as const) {
      try {
        if (!(await ctx.configs.exists(name))) {
          cfgLines.push(`${title}：没有这份配置`);
          continue;
        }
        /**
         * ⚠️ **这里不走 `configs.read`**：它对"文件在、但 JSON 坏了"会**静默退回
         * `defaults()`**（坏文件被报成"0 个目录" —— 违背本段"如实"的承诺，自查处
         * 抓到的）。直读 + 自解析：坏 JSON 当场抛 → 下面 catch → 如实"读不出来"。
         * （只读一条路：`vault.read` / `getAbstractFileByPath`。）
         */
        const f = ctx.app.vault.getAbstractFileByPath(ctx.configs.pathOf(name));
        const raw = f instanceof TFile ? await ctx.app.vault.read(f) : '';
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (name === 'rebuild') {
          // 🟢13（独立审）："形状认不出"与"0 条"要分得开（`{}` / `{"dirs":42}` 不许报成 0 个目录）
          if (!Array.isArray(data.dirs)) {
            cfgLines.push('库结构.json：形状认不出（dirs 不是数组）');
          } else {
            const rootName = typeof data.rootName === 'string' ? data.rootName : '';
            cfgLines.push(`库结构.json：${data.dirs.length} 个目录${rootName ? `（库根名 ${rootName}）` : ''}`);
          }
        } else {
          if (!Array.isArray(data.sections)) {
            cfgLines.push('看板配置.json：形状认不出（sections 不是数组）');
          } else {
            const view = (data.view ?? {}) as Record<string, unknown>;
            const viewName = typeof view.name === 'string' ? view.name : '';
            cfgLines.push(`看板配置.json：${data.sections.length} 个板块${viewName ? `（视图 ${viewName}）` : ''}`);
          }
        }
      } catch (e) {
        cfgLines.push(`${title}：读不出来（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    {
      const tpls = templateFiles(ctx.app, ctx.settings);
      cfgLines.push(
        tpls.length === 0
          ? '模板清单：没有模板'
          : `模板清单 ${tpls.length} 个：${tpls.slice(0, 5).map((t) => t.basename).join(' / ')}${
              tpls.length > 5 ? ' …' : ''
            }`,
      );
    }
    // [P7.24-12-END]
    detail.push('');
    detail.push('库级配置（只读）：');
    for (const l of cfgLines) detail.push(`- ${l}`);

    const parts = [`篇数 ${notesIn.length}${scoped ? `（本目录；全库 ${notesAll.length}）` : ''}`];
    parts.push(todo ? `待处理 ${todo.length} 项` : '待处理读不出');
    return { ok: true, summary: `库概览：${parts.join(' · ')}`, detail: detail.join('\n') };
  }

  /**
   * `ask_user`（P7.21 · #3）：问一句、等一个答案 —— 拿不准时的澄清通道（替代"猜或不动"）。
   *
   * 口径三条（轮内定，写进冻结说明）：
   *  · 归「读」类（自动档）：它不碰库、不需要确认流；
   *  · **不额外占步数**：它就是那一步里的一个动作（等用户的时间不计入任何预算）；
   *  · **没有硬超时**：跟随本轮取消 —— 跳过 / 关面板都回"用户跳过"，不当错误（等回答时那个键是禁用的）。
   */
  async function runAskUser(call: AiToolCall): Promise<AiToolOutcome> {
    const question = String(call.args.question ?? '').trim();
    let answer: string | null = null;
    let failed = false;
    try {
      answer = deps.askUser ? await deps.askUser(question) : null;
    } catch (e) {
      /**
       * 通道自己坏了：**别冒充"用户跳过"**（独立审 🟢3）—— 如实说"问不出来"，
       * 模型据此自己决定接着干什么（这不是它能修的错，所以不进 ok 的红框逻辑之外的文案）。
       */
      console.warn('[经纬] ask_user 的提问通道出错', e);
      failed = true;
    }
    const text = String(answer ?? '').trim();
    if (failed) return { ok: false, summary: '问不出来（提问通道出错，这一步跳过了）' };
    if (text === '') return { ok: true, summary: '用户跳过（没有回答这个问题）' };
    const clipped = text.slice(0, AI_AGENT_LIMITS.askChars);
    return {
      ok: true,
      summary: `用户回答：${clipped}${text.length > clipped.length ? '…（截断）' : ''}`,
    };
  }

  /**
   * **服务族（P7.22b 立 · P7.24 · L2 升格）**：把管线**跑到确认卡前停下**、用户点完
   * 把结算（`PipeSettle`）如实回传 → 循环继续。⚠️ L1 的"打开即收尾 / `handoff: true` /
   * 循环硬停"**已退役**（类型字段也删了）；控制权交人发生在**工具内部等确认卡**那一段。
   * 校验先行（拒了不许开面板、不许让工具悬着等结算）—— 见 body 里的长注释。
   */
  async function runPanelTool(call: AiToolCall): Promise<AiToolOutcome> {
    /**
     * **服务族 L2（P7.24 · #9/G11 —— 有意识改契约，L1「打开即收尾/handoff」退役）**：
     * agent 把管线**跑到确认卡前停下**（面板幕后：只弹卡，D4 用户拍板），用户点
     * 执行 / 取消后把结算（`PipeSettle`）如实回传 → 循环继续。
     *
     * 红线四条（与冻结同步）：
     *  · **不新开写路径** —— 执行走的还是各管线自己的链（`runAuto` / `run()` 同一份实现）；
     *  · **模型不能自我授权** —— 确认卡永远由用户点（`confirm()` 一张不少）；
     *  · 取消 = 零字节（D3：如实回"已取消"，不当失败）；
     *  · 工具本体仍归「读·搜」自动档（它自己一个字节不写）。
     *
     * ⚠️ **校验必须先行**（写在这层）：`new Promise` 的 executor 里的 `return` 只退回
     * executor —— 早退若落在里面，`onSettled` 永远不来、**tool 悬死**。
     */
    let scope = '';
    if (call.tool === 'triage') {
      /**
       * ⚠️ **只有 triage 吃工作目录**（独立审 Y-2 实测后修，L2 照旧）：它会让面板接着跑
       * AI 分诊（那是会进提示词的活）。`suggest` 不卷 workDir —— 卷进去会给出"范围 seg
       * 两枚都不亮 + 候选被静默砍过"的怪态；与冻结 §2 服务族口径③一致。
       */
      scope = deps.scopeDir ?? '';
      const dir = String(call.args.dir ?? '').trim();
      if (dir !== '') {
        if ((deps.scopeDir ?? '') !== '' && !inScope(absOf(dir))) return outOfScope(`目录「${dir}」`);
        const allDirs = Array.from(kbDirsOf(ctx.app, ctx.settings.kbRoot())).filter((d) => d !== '');
        if (!allDirs.includes(dir)) {
          return { ok: false, summary: `库里没有「${dir}」这个目录`, detail: '换一个已知的目录名（或先 list 库里有什么）' };
        }
        scope = dir;
      }
    }
    /** D2 口径：`keys` 缺省 = 键类全预勾（有快照可还原）；`feet:true` 才预勾足迹；样例永不勾 */
    const rawKeys = call.args.keys;
    const preKeys: 'all' | string[] = Array.isArray(rawKeys)
      ? rawKeys.filter((x): x is string => typeof x === 'string')
      : 'all';

    const r = await new Promise<PipeSettle>((resolve) => {
      if (call.tool === 'cleanup') {
        openCleanupPanel(ctx, {
          run: { preKeys, preFeet: call.args.feet === true, offstage: true, onSettled: resolve },
        });
        return;
      }
      openSuggestPanel(ctx, {
        scope,
        autoAi: call.tool === 'triage',
        autoRun: { cls: 'A', offstage: true, onSettled: resolve },
      });
    });
    return {
      ok: true,
      settled: r.action === 'executed' ? 'executed' : r.action === 'cancelled' ? 'cancelled' : undefined,
      summary:
        r.action === 'executed'
          ? `已执行：${r.summary}（改动可撤销）`
          : r.action === 'cancelled'
            ? '用户取消了 —— 一个字节都没动'
            : r.action === 'empty'
              ? `跑完了但没得做：${r.summary}`
              : `没跑成：${r.summary}`,
    };
  }

  /**
   * `grep`（P7.21b · #4）：**正文检索** —— 逐篇现扫，回命中片段（哪篇、第几行、一句上下文）。
   *
   * 口径五条：
   *  · 扫的是**索引里的笔记**（收在工作目录或 `dir` 里），顺序 = **最近改动在前**
   *   （与 search 的排序同一口径；截断时"先看新篇"）；
   *  · **现扫 + LRU 缓存**：指纹（mtime+size）对不上就重读（库变即失效，无 watcher）；
   *  · 到 `grepHits` 段就**不再往下扫**（如实写"可能还有更多"——不假装列全）；
   *  · 大文件（> `grepMaxFileBytes`）**跳过并数出来**（静默跳过 = 让模型以为"库里没有"）；
   *  · `dir` 给了就必须**真存在**（与 `list` 同口径 —— "目录不存在"被说成"没搜到"
   *   会让模型以为"库里没有这个词"）。
   */
  async function runGrepTool(call: AiToolCall): Promise<AiToolOutcome> {
    const kbRoot = ctx.settings.kbRoot();
    const query = String(call.args.query ?? '').trim();
    const dir = String(call.args.dir ?? '').trim();
    const scope = deps.scopeDir ?? '';
    // P7.10 · #12：工作目录收窄（与 search 同款：dir 越界 → 拒绝，如实说）
    if (scope !== '' && dir !== '' && !inScope(absOf(dir))) {
      return outOfScope(`搜索范围「${dir}」`);
    }
    if (dir !== '') {
      const allDirs = Array.from(kbDirsOf(ctx.app, kbRoot)).filter((d) => d !== '');
      if (!allDirs.includes(dir)) {
        return { ok: false, summary: `库里没有「${dir}」这个目录`, detail: '换一个已知的目录名（或先 list 库里有什么）' };
      }
    }
    const base = dir !== '' ? dir : scope;
    const baseAbs = base === '' ? kbRoot : absOf(base);
    const notes = ctx
      .index
      .notes()
      .filter((e) => isInside(e.path, baseAbs))
      .sort((a, b) => b.mtime - a.mtime);

    const lines: string[] = [];
    let hits = 0;
    let truncated = false;
    let skippedBig = 0;
    let unreadable = 0;
    for (const e of notes) {
      if (hits >= AI_AGENT_LIMITS.grepHits) {
        truncated = true;
        break;
      }
      const f = ctx.app.vault.getAbstractFileByPath(e.path);
      if (!f || !('stat' in f)) continue;
      const file = f as TFile;
      const fp = `${file.stat.mtime}:${file.stat.size}`;
      let text = grepCache.get(e.path, fp);
      if (text === null) {
        if (file.stat.size > AI_AGENT_LIMITS.grepMaxFileBytes) {
          skippedBig += 1;
          continue;
        }
        try {
          text = await ctx.app.vault.cachedRead(file);
        } catch {
          unreadable += 1;
          continue;
        }
        grepCache.put(e.path, fp, text);
      }
      const hit = grepText(text, query, AI_AGENT_LIMITS.grepSnippet);
      if (!hit) continue;
      hits += 1;
      lines.push(`- ${relativeTo(e.path, kbRoot)}（第 ${hit.line} 行）：${hit.excerpt}`);
    }
    const about: string[] = [];
    if (truncated) about.push(`到了 ${AI_AGENT_LIMITS.grepHits} 篇上限就停了，可能还有更多`);
    if (skippedBig > 0) about.push(`跳过了 ${skippedBig} 个太大的文件`);
    if (unreadable > 0) about.push(`${unreadable} 篇读不出来`);
    const tail = about.length > 0 ? `（${about.join('；')}）` : '';
    if (hits === 0) return { ok: true, summary: `没搜到「${query}」${tail}` };
    return {
      ok: true,
      summary: `搜到 ${hits} 篇提到「${query}」${tail}`,
      detail: ['命中（相对库根）：', ...lines].join('\n'),
    };
  }

  async function runReadTool(call: AiToolCall): Promise<AiToolOutcome> {
    const kbRoot = ctx.settings.kbRoot();
    if (call.tool === 'list') return runListTool(call);
    if (call.tool === 'stats') return runStatsTool();
    if (call.tool === 'ask_user') return runAskUser(call);
    if (call.tool === 'grep') return runGrepTool(call);
    if (call.tool === 'suggest' || call.tool === 'triage' || call.tool === 'cleanup') {
      return runPanelTool(call);
    }
    if (call.tool === 'search') {
      const query = String(call.args.query ?? '').trim().toLowerCase();
      const dir = String(call.args.dir ?? '').trim();
      /**
       * P7.10 · #12：工作目录收窄（口径见 `AiPortDeps.scopeDir`）——
       * 无 `dir` 时把结果收在范围内；带 `dir` 而它在范围外 → **拒绝**（如实说，别静默空手）。
       */
      const scope = deps.scopeDir ?? '';
      if (scope !== '' && dir !== '' && !inScope(absOf(dir))) {
        return outOfScope(`搜索范围「${dir}」`);
      }
      const base = dir !== '' ? dir : scope;
      const underAbs = base === '' ? kbRoot : absOf(base);
      const hits = ctx
        .index
        .notes()
        .filter((e) => isInside(e.path, underAbs))
        .filter((e) => {
          if (query === '') return true;
          const propsText = Object.entries(e.props ?? {})
            .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join('、') : String(v)}`)
            .join(' ')
            .toLowerCase();
          return (
            e.path.toLowerCase().includes(query) ||
            String(e.basename ?? '').toLowerCase().includes(query) ||
            propsText.includes(query)
          );
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, AI_AGENT_LIMITS.searchHits);
      if (hits.length === 0) return { ok: true, summary: '一篇都没搜到' };
      return {
        ok: true,
        summary: `命中 ${hits.length} 篇`,
        detail: `候选（相对库根）：\n${hits.map((e) => `- ${relativeTo(e.path, kbRoot)}`).join('\n')}`,
      };
    }
    // read
    const rel = String(call.args.path ?? '');
    // P7.10 · #12：工作目录收窄（读的这篇也得在范围内）
    if ((deps.scopeDir ?? '') !== '' && !inScope(absOf(rel))) {
      return outOfScope(`《${stripExt(baseName(rel))}》`);
    }
    const file = noteAt(rel);
    if (!file) return { ok: false, summary: `库里找不到「${rel}」` };
    const props = ctx.fm.props(file);
    const propsLine = Object.entries(props)
      .filter(([k]) => k !== 'position') // metadataCache 自带的块位置，不是用户的属性
      .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join('、') : String(v)}`)
      .join(' | ');
    let body = '';
    try {
      body = (await ctx.fm.body(file)).slice(0, AI_AGENT_LIMITS.readChars);
    } catch {
      body = '';
    }
    return {
      ok: true,
      // `file.basename` 已无扩展名（Obsidian 语义）——别再 stripExt（P7.10 修，9.16 → 9）
      summary: `读了《${file.basename}》`,
      detail: `属性：${propsLine || '（没有前言）'}\n正文（截断到 ${AI_AGENT_LIMITS.readChars} 字符）：\n${body}`,
    };
  }

  /**
   * **写类的预检**（`03_AI指令集` 硬拦 + 存在性 + 目录白名单）。
   *
   * 🔴 放在**待确认卡与确认框之前** —— 被拦下的调用**根本不摆到用户面前**：
   * 让用户对着一条"点了也执行不了"的卡片打勾是骗人（P7.0a 批 1⑨ 那条
   * "迁移菜单死选项"的同一形状）。返回 `planRow` 给确认框预备用。
   *
   * ⚠️ **P7.22a 起是 async**：正文写（`patch_text` / `append`）要**读当刻正文 dry-run**
   * （找不着的原文 / 已改过的补丁在这里就拦掉 —— 同一句"不摆注定失败的卡"）。
   */
  async function preflight(
    call: AiToolCall,
  ): Promise<{ ok: true; planRow: PlanRow } | { ok: false; outcome: AiToolOutcome }> {
    const aiDir = ctx.ai.protectedDir();
    const rel = String(call.args.path ?? '');
    const abs = rel ? absOf(rel) : '';
    const toRel = String(call.args.to ?? call.args.dir ?? '');
    if ((abs !== '' && isAiProtected(abs, aiDir)) || (toRel !== '' && isAiProtected(absOf(toRel), aiDir))) {
      return { ok: false, outcome: { ok: false, summary: 'AI 指令集里的东西只能读、不能改（含搬进搬出）' } };
    }
    /**
     * P7.10 · #12：工作目录收窄（口径见 `AiPortDeps.scopeDir`）。
     * `path`（动的是哪篇）必须在范围内；`create` 的 `dir` 也要；
     * **`move` 的 `to` 例外**（落点是目标目录 —— 否则"把收件箱归位"做不了）。
     */
    const scope = deps.scopeDir ?? '';
    if (scope !== '') {
      if (abs !== '' && !inScope(abs)) return { ok: false, outcome: outOfScope(`「${rel}」`) };
      if (call.tool === 'create' && !inScope(absOf(toRel))) {
        return { ok: false, outcome: outOfScope(`落点「${toRel || '库根'}」`) };
      }
    }
    const dirs = dirSet();
    if (call.tool === 'move') {
      if (!ctx.index.get(abs)) return { ok: false, outcome: { ok: false, summary: `库里找不到「${rel}」` } };
      if (!dirs.has(absOf(toRel))) return { ok: false, outcome: { ok: false, summary: `库里没有「${toRel}」这个目录` } };
      // ⚠️ 撞名警告不在这算（`runWrites` 里统一收集进确认框的 warnings —— 一份口径别写两处）
      return { ok: true, planRow: { kind: 'move', from: rel, to: toRel, count: 1 } };
    }
    if (call.tool === 'rename') {
      const file = noteAt(rel);
      if (!file) return { ok: false, outcome: { ok: false, summary: `库里找不到「${rel}」` } };
      const name = String(call.args.name ?? '');
      /**
       * 「和现在的一样」按**落盘名**判（独立审 🟢8）：模型给 `a.md`（带扩展名）时，
       * 与 `file.basename`（无扩展名）直接比会漏过 → 确认框反而弹一条**误导的**撞名警告
       *（目标名命中的就是它自己）。先把 name 过一遍 `cleanNewName`（与实际落盘同一口径）再比。
       */
      const finalBase = stripExt(baseName(cleanNewName(file.path, name)));
      if (file.basename === finalBase) {
        // `file.basename` 已无扩展名（同 read 那条注释）——与归一后的 name 同口径
        return { ok: false, outcome: { ok: false, summary: `新名字和现在的一样（《${finalBase}》），没有可改的` } };
      }
      // ⚠️ 撞名警告不在这算（与 move 同款：`runWrites` 统一收集进确认框）
      return {
        ok: true,
        planRow: { kind: 'rename', from: file.basename, to: finalBase, count: 1 },
      };
    }
    if (call.tool === 'set_prop' || call.tool === 'set_tags') {
      const file = noteAt(rel);
      if (!file) return { ok: false, outcome: { ok: false, summary: `库里找不到「${rel}」` } };
      if (call.tool === 'set_prop') {
        const key = String(call.args.key ?? '');
        const from = ctx.fm.props(file)[key];
        return {
          ok: true,
          planRow: {
            kind: 'set',
            prop: key,
            from: from == null ? '' : String(Array.isArray(from) ? from.join('、') : from),
            to: call.args.value === null ? '' : String(call.args.value),
            count: 1,
          },
        };
      }
      const add = (call.args.add as string[]) ?? [];
      const rm = (call.args.remove as string[]) ?? [];
      return {
        ok: true,
        planRow: { kind: 'tag', add: add.length ? add : undefined, remove: rm.length ? rm : undefined, count: 1 },
      };
    }
    if (call.tool === 'create') {
      const dirRel = String(call.args.dir ?? '');
      if (!dirs.has(absOf(dirRel))) return { ok: false, outcome: { ok: false, summary: `库里没有「${dirRel}」这个目录` } };
      return { ok: true, planRow: { kind: 'create', title: String(call.args.title ?? ''), to: dirRel, count: 1 } };
    }
    if (call.tool === 'delete') {
      if (!noteAt(rel)) return { ok: false, outcome: { ok: false, summary: `库里找不到「${rel}」` } };
      return { ok: true, planRow: { kind: 'delete', where: rel, count: 1 } };
    }
    if (call.tool === 'patch_text' || call.tool === 'append') {
      return dryRunText(call);
    }
    return { ok: false, outcome: { ok: false, summary: `不认识的工具「${call.tool}」` } };
  }

  /**
   * **正文写的 dry-run**（P7.22a）：拿**当刻正文**跑一遍 `services/ai/text-edit.ts`
   * 的判定 —— 找不着的原文 / 命中多处的 / 已经改过的 / 文末已有那段的，
   * **都在这被拦下**（不进待确认卡）；过了的给一行 `kind:'text'` 预览。
   *
   * ⚠️ 执行时（`executeApproved`）会**再跑一遍同一份判定**（当刻正文可能又变了 ——
   * 那是"幂等/命中以当刻为准"的口径，跟 beautify 的"防呆②"同一件事的两种说法）。
   */
  async function dryRunText(
    call: AiToolCall,
  ): Promise<{ ok: true; planRow: PlanRow } | { ok: false; outcome: AiToolOutcome }> {
    const rel = String(call.args.path ?? '');
    const file = noteAt(rel);
    if (!file) return { ok: false, outcome: { ok: false, summary: `库里找不到「${rel}」` } };
    let text = '';
    try {
      text = await ctx.app.vault.cachedRead(file);
    } catch {
      return { ok: false, outcome: { ok: false, summary: `读不出《${file.basename}》的正文（这次先不动它）` } };
    }
    const body = splitFrontmatter(text).body;
    if (call.tool === 'patch_text') {
      const find = String(call.args.find ?? '');
      const replace = String(call.args.replace ?? '');
      const plan = planPatchText(body, find, replace);
      if ('why' in plan) {
        return { ok: false, outcome: { ok: false, summary: `《${file.basename}》没改：${plan.why}` } };
      }
      return {
        ok: true,
        planRow: {
          kind: 'text',
          // ⚠️ 给**相对路径**（独立审 🟢7）：与删除行同款 —— 多篇同名时认得出来是哪个
          where: rel,
          change: replace.trim() === '' ? `删掉一段：${oneLine(find)}` : `替换：${oneLine(find)} → ${oneLine(replace)}`,
          count: 1,
        },
      };
    }
    const content = String(call.args.content ?? '');
    const plan = planAppend(body, content);
    if ('why' in plan) {
      return { ok: false, outcome: { ok: false, summary: `《${file.basename}》没追加：${plan.why}` } };
    }
    return {
      ok: true,
      planRow: { kind: 'text', where: rel, change: `末尾追加 ${content.length} 字`, count: 1 },
    };
  }

  return {
    async runBatch(calls, opts): Promise<AiToolOutcome[]> {
      const cfg = ctx.settings.get().ai;
      const out: AiToolOutcome[] = new Array(calls.length);
      /**
       * **结果落地的那一刻就写 + 回调**（`ToolPort.runBatch` 的契约）：
       * 被硬拦的、读完成的、被跳过的各按各的时机报出去 —— 整批 await 完才报的话，
       * "被拦下"的步骤行要等用户点完待确认卡才出现，那道硬拦的可见性就晚了半拍。
       */
      const settle = (index: number, outcome: AiToolOutcome): void => {
        out[index] = outcome;
        try {
          opts.onCallEnd?.(index, outcome);
        } catch {
          /* 界面的回调出错不该带崩执行 */
        }
      };
      /** 需要用户先勾选的（档=需确认；已过预检） */
      const askIdx: number[] = [];
      /** 直接进确认框的（档=自动 —— **自动弹确认框，不是跳过确认**；已过预检） */
      const autoIdx: number[] = [];
      /** 已过预检的那几条的确认框行（confirm 的 preview） */
      const planOf = new Map<number, PlanRow>();

      for (let i = 0; i < calls.length; i += 1) {
        const call = calls[i];
        const cls = AI_TOOL_CLASS_OF[call.tool as AiToolName];
        if (!cls) {
          settle(i, { ok: false, summary: `不认识的工具「${call.tool}」` });
          continue;
        }
        /**
         * **能力包白名单**（P7.3c）：名单外的一律不执行（收窄只做减法，见 `AiPortDeps.allowTools`）。
         * ⚠️ 放在档位**之前**：这不是"用户把这类禁了"，而是"这个能力包压根不带这个工具" ——
         * 两句话对模型和用户的含义不同（前者让它别绕，后者让它换工具）。
         */
        if (deps.allowTools && !deps.allowTools.includes(call.tool as AiToolName)) {
          settle(i, { ok: false, summary: `这个能力包没有开「${call.tool}」这个工具，没有执行` });
          continue;
        }
        const tier = effectiveTier(cls, cfg);
        if (tier === 'off') {
          settle(i, { ok: false, summary: '这类操作被设置禁用了（这是用户的选择，别绕）' });
          continue;
        }
        if (cls === 'read') {
          if (tier === 'auto') {
            try {
              opts.onCallStart?.(i);
            } catch {
              /* 同 settle */
            }
            settle(i, await runReadTool(call));
          } else {
            /**
             * 读类被配成「需确认」（3c 的逐类三档里的一个合法组合，比如"读之前先问一声"）
             * —— 独立审查 🟢10：这里以前**静默忽略**它（用户设了没用）。现在照走卡片。
             */
            askIdx.push(i);
          }
          continue;
        }
        /**
         * `trashOption === 'none'`：Obsidian 自己设成"不删除" —— 连确认框都不弹，
         * 直接如实说明（弹一个按钮永远置灰的框只会让人困惑）。
         */
        if (cls === 'delete' && ctx.mover.trashOption() === 'none') {
          settle(i, {
            ok: false,
            summary: '删不了：Obsidian 的「删除文件」设置是「不删除」',
            detail: '用户要先去 Obsidian 设置里改成「移入回收站」（或库内 .trash）',
          });
          continue;
        }
        /** 写类先过预检：被硬拦/不存在的**不摆到用户面前**（正文写还含 dry-run，见 preflight 注释） */
        const pre = await preflight(call);
        if (!pre.ok) {
          settle(i, pre.outcome);
          continue;
        }
        planOf.set(i, pre.planRow);
        if (tier === 'confirm') askIdx.push(i);
        else autoIdx.push(i);
      }

      /** 需确认档：先摆卡片等勾选（「自动」档跳过这一步，直接进确认框） */
      let approved = autoIdx.slice();
      if (askIdx.length > 0) {
        const entries: AiPendingEntry[] = askIdx.map((i) => ({ call: calls[i], row: rowFor(calls[i]) }));
        // `pendingAuto`：混档时面板点「跳过」的说法要如实（🟡1），别写"什么都没改"
        const flags = await deps.askPending(entries, autoIdx.length);
        askIdx.forEach((idx, k) => {
          if (flags[k]) approved.push(idx);
          else settle(idx, { ok: false, summary: '用户跳过了这一步，没有执行' });
        });
      }
      approved = approved.sort((a, b) => a - b);

      /** 读类（只有被配成需确认时才可能在这）直接跑；写类进确认框那一段 */
      const approvedReads = approved.filter((i) => AI_TOOL_CLASS_OF[calls[i].tool as AiToolName] === 'read');
      const approvedWrites = approved.filter((i) => AI_TOOL_CLASS_OF[calls[i].tool as AiToolName] !== 'read');
      for (const i of approvedReads) {
        try {
          opts.onCallStart?.(i);
        } catch {
          /* 同 settle */
        }
        settle(i, await runReadTool(calls[i]));
      }
      if (approvedWrites.length > 0) {
        try {
          await runWrites(calls, approvedWrites, planOf, settle, opts?.signal);
        } catch (e) {
          // 硬错误（快照失败之类）：没填结果的都如实说，别让模型与用户看到假的"没动静"
          const msg = e instanceof Error ? e.message : String(e);
          for (const i of approvedWrites) if (!out[i]) settle(i, { ok: false, summary: `执行失败：${msg}` });
        }
      }
      return out;
    },
  };

  /** 写类的一批（**已过预检**）：确认框（删存在则危险态）→ 分类执行 */
  async function runWrites(
    calls: AiToolCall[],
    idx: number[],
    planOf: Map<number, PlanRow>,
    settle: (index: number, outcome: AiToolOutcome) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const runnable = idx.map((at) => ({ call: calls[at], at }));
    const plan: PlanRow[] = [];
    const warn: string[] = [];
    let hasDelete = false;
    let hasProp = false;
    let hasText = false;
    let renameCount = 0;
    for (const i of idx) {
      const row = planOf.get(i);
      if (row) plan.push(row);
      const t = calls[i].tool;
      if (t === 'delete') hasDelete = true;
      if (t === 'set_prop' || t === 'set_tags') hasProp = true;
      if (t === 'patch_text' || t === 'append') hasText = true;
      if (t === 'move') {
        const call = calls[i];
        const rel = String(call.args.path ?? '');
        if (ctx.index.get(joinPath(absOf(String(call.args.to ?? '')), baseName(rel)))) {
          warn.push(`「${stripExt(baseName(rel))}」在目标目录里已经有同名的了，会跳过`);
        }
      }
      if (t === 'rename') {
        renameCount += 1;
        const call = calls[i];
        const rel = String(call.args.path ?? '');
        const toName = cleanNewName(rel, String(call.args.name ?? ''));
        if (ctx.index.get(joinPath(parentDir(absOf(rel)), toName))) {
          warn.push(`「${stripExt(baseName(rel))}」改过去会和现有的同名，会跳过`);
        }
      }
    }

    /**
     * **改正文的 diff 预览**（G9 拍板"带 diff 预览"；复用 `ui/diff-box.ts`）：
     * 批里**恰好一条**正文写时附一个对比框；多条时不附（预览行各自带摘要，
     * 一堆 diff 会把确认框淹掉）。读不出来/算不出来就**不附**（确认照走 ——
     * 执行时还会以当刻正文再判一次，附不上 diff 不是错误）。
     */
    let attach: ((host: HTMLElement) => void) | undefined;
    const textIdxs = idx.filter((i) => calls[i].tool === 'patch_text' || calls[i].tool === 'append');
    if (textIdxs.length === 1) {
      const call = calls[textIdxs[0]];
      const file = noteAt(String(call.args.path ?? ''));
      if (file) {
        try {
          const full = await ctx.app.vault.cachedRead(file);
          const before = splitFrontmatter(full).body;
          const preview =
            call.tool === 'patch_text'
              ? planPatchText(before, String(call.args.find ?? ''), String(call.args.replace ?? ''))
              : planAppend(before, String(call.args.content ?? ''));
          if ('body' in preview) {
            const after = preview.body;
            attach = (host) => host.appendChild(diffBox(before, after));
          }
        } catch {
          /* 附不上就不附 */
        }
      }
    }

    if (signal?.aborted) {
      for (const r of runnable) settle(r.at, { ok: false, summary: '已停止，没有执行' });
      return;
    }

    /**
     * 确认流：**与手工那条完全同一份** `ui/confirm.ts`（写类一个都不许绕）。
     * 文案按这一批的构成现算：清一色搬运/删除时沿用老口径（更具体），
     * 混着来才用"要做 N 项改动"。
     */
    const kinds = new Set(idx.map((i) => calls[i].tool));
    const allMove = kinds.size === 1 && kinds.has('move');
    const allDel = kinds.size === 1 && kinds.has('delete');
    const hasMove = kinds.has('move');
    const n = runnable.length;
    const option = ctx.mover.trashOption();
    const res = await confirm({
      title: allMove ? `即将按 AI 的建议移动 ${n} 篇` : allDel ? `即将删除 ${n} 篇笔记` : `AI 要做 ${n} 项改动`,
      preview: plan,
      warnings: warn,
      notes: [
        '这是 AI 提的动作 —— 执行走的是与你手工操作完全相同的那条路',
        '列出的落点都已经核对过：库里真有这个目录，且不在 AI 指令集里',
        ...(hasMove ? ['搬完会给没声明「文件位置」的笔记补上声明（这次替它做的决定要留痕）'] : []),
        /**
         * ⚠️ **P7.22a · #11 改口**：这句原先是"属性 / 标签的改动**不进快照**（与手工改一样）"——
         * AI 的批量属性 / 标签写现在是**唯一补上撤销覆盖**的（写前补一次快照，
         * 对齐「一批一动 = 一快照 = 一撤销句柄」）。**手工那条路一个字没动**（本条只说 AI）。
         */
        ...(hasProp ? ['属性 / 标签改动执行前会自动快照，可整批一键还原'] : []),
        ...(hasText ? ['改正文执行前自动快照（只换正文，前言一个字不动）'] : []),
        ...(renameCount > 0 ? ['改名不动内容、不换目录；撞名一律不覆盖（同内容跳过、不同内容留着不动）'] : []),
      ],
      danger: hasDelete
        ? { confirmLabel: '再点一次确认', irreversible: option !== 'local' }
        : undefined,
      primary: { label: allMove ? `移动这 ${n} 篇` : allDel ? `删除 ${n} 篇` : `执行这 ${n} 项` },
      attach,
    });
    if (res.action !== 'primary') {
      for (const r of runnable) settle(r.at, { ok: false, summary: '你在确认框里取消了，没有执行' });
      return;
    }

    await executeApproved(runnable, settle);
  }

  async function executeApproved(
    runnable: { call: AiToolCall; at: number }[],
    settle: (index: number, outcome: AiToolOutcome) => void,
  ): Promise<void> {
    /** 已经落过结果的位置（"还没填才填"要用它 —— 找不到的别被后面的覆盖） */
    const settled = new Set<number>();
    const put = (index: number, outcome: AiToolOutcome): void => {
      settled.add(index);
      settle(index, outcome);
    };

    /**
     * **改属性 / 标签先跑**（P7.9 · ⑦a 修复）：同一批里"搬 A + 改 A 的属性"是正常组合，
     * 而属性写入**不依赖新位置** —— 反过来的话改属性会拿着**旧路径**去找，
     * 文件已被搬走 → "执行时已经找不到"（用户真机上就是这么被绊的，还得再提一次）。
     * 一篇一次 `fm.setMany`（照旧过非标量守卫）。
     *
     * ⚠️ **P7.22a · #11**：这一批写之前**补一次快照** —— 它曾经是"唯一没有撤销覆盖的
     * 写面"（确认框 notes 里也一直如实写着"不进快照"）；现在对齐
     * 「一批一动 = 一快照 = 一撤销句柄」。**手工改属性那条路一个字没动**（本条只说 AI 批量写）。
     * 快照失败 → **整段中止**（一个字节都不写；与 beautify / `ui/doc-write.ts` 同一条语义）。
     */
    const propList = runnable.filter((x) => x.call.tool === 'set_prop' || x.call.tool === 'set_tags');
    if (propList.length > 0) {
      const propFiles: TFile[] = [];
      const propSeen = new Set<string>();
      for (const r of propList) {
        const file = noteAt(String(r.call.args.path ?? ''));
        if (file && !propSeen.has(file.path)) {
          propSeen.add(file.path);
          propFiles.push(file);
        }
      }
      let propSnapId: string | null = null;
      let propSnapErr = '';
      if (propFiles.length > 0) {
        try {
          const snap = await ctx.snapshot.capture({
            reason: `AI 改属性 / 标签：${propFiles.length} 篇`,
            files: propFiles,
          });
          propSnapId = snap.id;
        } catch (e) {
          propSnapErr = e instanceof Error ? e.message : String(e);
        }
      } else {
        /**
         * 全找不到文件（`propFiles` 空）→ **跳过快照**（独立审 🟢11）：原先照样
         * `capture({files: []})`，快照面板会多一条 0 篇的记录。循环里每条照旧如实报"找不到"，
         * 没有写发生（propWrote=0）→ 也不会弹撤销条。
         */
        propSnapId = '';
      }
      if (propSnapId === null) {
        for (const r of propList) put(r.at, { ok: false, summary: `快照失败，没有改（${propSnapErr}）` });
      } else {
        const snapId = propSnapId;
        let propWrote = 0;
        for (const r of propList) {
          const rel = String(r.call.args.path ?? '');
          const file = noteAt(rel);
          if (!file) {
            put(r.at, { ok: false, summary: `执行时已经找不到「${rel}」了` });
            continue;
          }
          const name = file.basename; // 无扩展名（同 read 那条注释 —— P7.10 修 stripExt 二次剥离）
          try {
            if (r.call.tool === 'set_prop') {
              const key = String(r.call.args.key ?? '');
              const w = await ctx.fm.setMany(file, { [key]: r.call.args.value ?? null });
              if (w.skipped.length > 0) {
                put(r.at, { ok: false, summary: `跳过《${name}》：前言里有嵌套映射，写盘会改坏它` });
              } else {
                propWrote += 1;
                put(r.at, { ok: true, summary: `已改《${name}》的「${key}」`, changed: true });
              }
            } else {
              const add = (r.call.args.add as string[]) ?? [];
              const rm = (r.call.args.remove as string[]) ?? [];
              const cur = ctx.fm.props(file)['tags'];
              const curList = Array.isArray(cur) ? cur.map((x) => String(x)) : cur == null ? [] : [String(cur)];
              const next = curList.filter((t) => !rm.includes(t));
              for (const t of add) if (!next.includes(t)) next.push(t);
              const w = await ctx.fm.setMany(file, { tags: next });
              if (w.skipped.length > 0) {
                put(r.at, { ok: false, summary: `跳过《${name}》：前言里有嵌套映射，写盘会改坏它` });
              } else {
                propWrote += 1;
                put(r.at, { ok: true, summary: `已改《${name}》的标签`, changed: true });
              }
            }
          } catch (e) {
            put(r.at, { ok: false, summary: `改《${name}》失败：${e instanceof Error ? e.message : String(e)}` });
          }
        }
        /** 撤销条（真写了才弹；还原 = 快照，与搬动那条同一个口） */
        if (propWrote > 0) {
          showUndo({
            text: `已改 ${propWrote} 处属性 / 标签`,
            detail: '撤销 = 从操作前的快照还原',
            onUndo: () => {
              void restoreOrNotify(ctx.snapshot, snapId).then((r) => {
                if (r) notify({ kind: 'success', text: '已还原这次改动', ms: NOTIFY_MS.light });
              });
            },
            onView: () => void ctx.report.openLatest(),
            onExpire: () =>
              notify({ kind: 'info', text: '撤销条已过期', detail: '仍可在快照面板里还原', ms: NOTIFY_MS.long }),
          });
        }
      }
    }

    /**
     * **改正文（`patch_text` / `append`）**：走 `ui/doc-write.ts` 的共享链
     * （快照 → `vault.process` 当刻重算 → 日志 → 撤销条）—— **一批一动 = 一快照 =
     * 一撤销句柄**（多篇共一张快照、一条撤销条）。
     *
     * 🔴 这是 `redline.ts` 那条"执行体不许出现写盘 API"红线的**第五条出口**：
     * `vault.process` 只在 `ui/doc-write.ts` 里出现，这里只调 `writeDocs`。
     *
     * ⚠️ 执行时**重跑一遍 `services/ai/text-edit.ts` 的判定**（以当刻正文为准）：
     * 预检过了的在这仍可能变成 skip（确认期间正文被别处改过 / 同批前一条改了它）——
     * 如实报、绝不硬写（与 beautify 的"防呆②"同一件事）。
     */
    const textList = runnable.filter((r) => r.call.tool === 'patch_text' || r.call.tool === 'append');
    if (textList.length > 0) {
      const items: { at: number; name: string; item: DocWriteItem }[] = [];
      const snapFiles: TFile[] = [];
      const snapSeen = new Set<string>();
      for (const r of textList) {
        const rel = String(r.call.args.path ?? '');
        const file = noteAt(rel);
        if (!file) {
          put(r.at, { ok: false, summary: `执行时已经找不到「${rel}」了` });
          continue;
        }
        if (!snapSeen.has(file.path)) {
          snapSeen.add(file.path);
          snapFiles.push(file);
        }
        const tool = r.call.tool;
        items.push({
          at: r.at,
          name: file.basename,
          item: {
            file,
            next: (cur) => {
              const plan =
                tool === 'patch_text'
                  ? planPatchText(cur.body, String(r.call.args.find ?? ''), String(r.call.args.replace ?? ''))
                  : planAppend(cur.body, String(r.call.args.content ?? ''));
              return 'body' in plan ? { body: plan.body } : { skip: plan.why };
            },
          },
        });
      }
      if (items.length > 0) {
        const res = await writeDocs(ctx, {
          reason: `AI 改正文：${snapFiles.length} 篇`,
          label: 'AI 改正文',
          items: items.map((x) => x.item),
          logSummary: (n) => `AI 改了 ${n} 处正文（patch_text / append）`,
          logExtra: 'AI 改正文（P7.22a 新写面；只动正文，前言一个字不动）',
          undoText: (n) => (items.length === 1 ? `已改《${items[0].name}》的正文` : `已改 ${n} 处正文`),
          undoDetail: '撤销 = 从操作前的快照还原（正文换回原稿）',
          undoneText: '已还原这次改正文',
        });
        if (res.error != null) {
          for (const x of items) put(x.at, { ok: false, summary: `快照失败，没有改（${res.error}）` });
        } else {
          for (let k = 0; k < items.length; k += 1) {
            const w = res.items[k];
            if (w.state === 'written') {
              put(items[k].at, { ok: true, summary: `已改《${items[k].name}》的正文`, changed: true });
            } else if (w.state === 'skipped') {
              put(items[k].at, { ok: false, summary: `《${items[k].name}》没有改：${w.note ?? ''}` });
            } else {
              put(items[k].at, { ok: false, summary: `改《${items[k].name}》失败：${w.note ?? ''}` });
            }
          }
        }
      }
    }

    /** 搬：一次 mover 调用 = 一个快照 = 一个撤销句柄（与手工同口径） */
    const moveList = runnable.filter((r) => r.call.tool === 'move');
    if (moveList.length > 0) {
      const byDir = new Map<string, TFile[]>();
      /** 源绝对路径 → 这条调用的位置（回填结果用） */
      const atOf = new Map<string, number>();
      /**
       * ⚠️ **同一篇在一批里被提了两次**（不同落点）时取**第一处**（独立审查 🟢10）：
       * `mover` 内部按源去重、`atOf` 也只能记一个下标 —— 不显式定规矩的话，
       * 后一条会把前一条的结果覆盖掉，前一条拿到"这一步没有结果"。
       */
      const claimed = new Set<string>();
      /**
       * **没声明「文件位置」的被搬笔记**（P7.9 · P5）：搬完由 `writeDeclaredForMoved` 补上 ——
       * 与整理建议面板 `runMoves` **同一个函数**（"这次替它做的决定要留痕"）。
       * ⚠️ 属性段已先跑（⑦a），声明若在**这一批里刚被改过**，索引可能滞后一拍 ——
       * 最坏是"多写一次 = 写成实际落脚点"，与 mover 的属性跟随收敛到同一个结果。
       */
      const undeclared = new Set<string>();
      for (const r of moveList) {
        const rel = String(r.call.args.path ?? '');
        const file = noteAt(rel);
        if (!file) {
          put(r.at, { ok: false, summary: `执行时已经找不到「${rel}」了` });
          continue;
        }
        if (claimed.has(file.path)) {
          put(r.at, { ok: false, summary: '同一篇在这一批里提了两次，只按第一处搬' });
          continue;
        }
        claimed.add(file.path);
        const entry = ctx.index.get(file.path);
        if (!entry || declaredPositions(entry.props).length === 0) undeclared.add(file.path);
        const dir = absOf(String(r.call.args.to ?? ''));
        const list = byDir.get(dir) ?? [];
        list.push(file);
        byDir.set(dir, list);
        atOf.set(file.path, r.at);
      }
      if (byDir.size > 0) {
        const moved: MoveResult = await ctx.mover.move({
          targets: Array.from(byDir, ([dir, files]) => ({ dir, files })),
          source: 'ai',
          reason: `AI 建议：把 ${moveList.length} 篇归到指定目录`,
          quiet: true, // 撤销条在（下面 showMoveUndo）→ 不弹重复通知（P7.0a 批 1⑦）
        });
        if (moved.error) {
          for (const r of moveList) {
            if (!settled.has(r.at)) put(r.at, { ok: false, summary: `没搬成：${moved.error}` });
          }
        }
        for (const m of moved.moved) {
          const at = atOf.get(m.from) ?? atOf.get(m.path);
          if (at !== undefined) {
            put(at, {
              ok: true,
              summary: `已移动《${stripExt(baseName(m.path))}》`,
              detail: `相对库根：${relativeTo(m.from, ctx.settings.kbRoot())} → ${relativeTo(m.to, ctx.settings.kbRoot())}`,
              changed: true,
            });
          }
        }
        for (const a of moved.already) {
          const at = atOf.get(a.path);
          if (at !== undefined) put(at, { ok: true, summary: `《${stripExt(baseName(a.path))}》在目标位置已经有了一样的，没重复搬` });
        }
        for (const s of moved.skipped) {
          const at = atOf.get(s.path);
          if (at !== undefined) put(at, { ok: false, summary: `跳过了《${stripExt(baseName(s.path))}》${s.note ? `：${s.note}` : ''}` });
        }
        for (const b of moved.blocked) {
          const at = atOf.get(b.path);
          if (at !== undefined) put(at, { ok: false, summary: `没有动《${stripExt(baseName(b.path))}》：目标目录里的同名文件内容不一样` });
        }
        /**
         * **搬完给"没声明"的补「文件位置」**（P7.9 · P5 拍板）：只补没声明的那些
         *（有声明的由 mover 第 7 步跟过去）。写失败 / 守卫跳过**只报不拦**——
         * 不回滚已完成的搬动，与整理建议面板那条同口径。
         */
        const declaredWarnings: string[] = [];
        await writeDeclaredForMoved(
          { app: ctx.app, fm: ctx.fm },
          moved.moved.filter((m) => undeclared.has(m.from)),
          (m) => relativeTo(parentDir(m.to), ctx.settings.kbRoot()),
          declaredWarnings,
        );
        if (declaredWarnings.length > 0) {
          notify({ kind: 'info', text: '有几篇没跟上', detail: declaredWarnings[0], ms: NOTIFY_MS.long });
        }
        showMoveUndo(
          {
            restore: (id) => ctx.snapshot.restore(id),
            openLatest: () => ctx.report.openLatest(),
            openSnapshotPanel: () => ctx.openSnapshotPanel(),
          },
          moved,
        );
      }
    }

    /**
     * **改名（`rename`）**：走 `mover` 同一条链（纯改名也算搬动 —— P7.18b 守卫照旧：
     * 撞名自查 / 快照 / 撤销 / 日志 `ai:true` / 声明跟随全在那一份里）。
     * 一批改名 = **一次 mover 调用 = 一个快照 = 一条撤销条**（与搬动同口径）。
     * ⚠️ 与 `move` 段一样**不做** `writeDeclaredForMoved` 补声明 —— 改名不换目录，
     * 落点没变，没有"补实际落点"这回事（声明由 mover 的跟随逻辑原样带着走）。
     */
    const renameList = runnable.filter((r) => r.call.tool === 'rename');
    if (renameList.length > 0) {
      const targets: MoveTarget[] = [];
      const atOfRename = new Map<string, number>();
      const oldNameOf = new Map<string, string>();
      for (const r of renameList) {
        const rel = String(r.call.args.path ?? '');
        const file = noteAt(rel);
        if (!file) {
          put(r.at, { ok: false, summary: `执行时已经找不到「${rel}」了` });
          continue;
        }
        /** 同一篇在一批里被提了两次改名 → 取第一处（与 move 段的 `claimed` 同口径） */
        if (atOfRename.has(file.path)) {
          put(r.at, { ok: false, summary: '同一篇在这一批里提了两次改名，只按第一处' });
          continue;
        }
        atOfRename.set(file.path, r.at);
        oldNameOf.set(file.path, file.basename);
        targets.push({ dir: parentDir(file.path), files: [file], newName: String(r.call.args.name ?? '') });
      }
      if (targets.length > 0) {
        const renamed: MoveResult = await ctx.mover.move({
          targets,
          source: 'ai',
          reason: `AI 建议：改名 ${targets.length} 篇`,
          quiet: true, // 撤销条在（下面 showUndo）→ 不弹重复通知（与 move 段同款）
        });
        if (renamed.error) {
          for (const r of renameList) {
            if (!settled.has(r.at)) put(r.at, { ok: false, summary: `没改成：${renamed.error}` });
          }
        }
        for (const m of renamed.moved) {
          const at = atOfRename.get(m.from) ?? atOfRename.get(m.path);
          if (at !== undefined) {
            put(at, {
              ok: true,
              summary: `已改名《${oldNameOf.get(m.from) ?? stripExt(baseName(m.from))}》→《${stripExt(baseName(m.to))}》`,
              changed: true,
            });
          }
        }
        for (const a of renamed.already) {
          const at = atOfRename.get(a.path);
          if (at !== undefined) {
            put(at, { ok: true, summary: `《${oldNameOf.get(a.path) ?? ''}》目标名已经一样，没重复改` });
          }
        }
        for (const s of renamed.skipped) {
          const at = atOfRename.get(s.path);
          if (at !== undefined) {
            put(at, {
              ok: false,
              summary: `没改名《${oldNameOf.get(s.path) ?? ''}》${s.note ? `：${s.note}` : ''}`,
            });
          }
        }
        for (const b of renamed.blocked) {
          const at = atOfRename.get(b.path);
          if (at !== undefined) {
            put(at, {
              ok: false,
              summary: `没有动《${oldNameOf.get(b.path) ?? ''}》：目标名已有同名文件且内容不一样`,
            });
          }
        }
        if (renamed.moved.length > 0) {
          const first = renamed.moved[0];
          showUndo({
            text:
              renamed.moved.length === 1
                ? `已改名：${oldNameOf.get(first.from) ?? stripExt(baseName(first.from))} → ${stripExt(baseName(first.to))}`
                : `已改名 ${renamed.moved.length} 篇`,
            detail: renamed.moved.length === 1 ? undefined : '（可整批还原成原名）',
            onUndo: () => {
              void restoreOrNotify(ctx.snapshot, renamed.snapshotId).then((r) => {
                if (r) notify({ kind: 'success', text: '已还原这次改名', ms: NOTIFY_MS.light });
              });
            },
            onView: () => void ctx.report.openLatest(),
            onExpire: () =>
              notify({ kind: 'info', text: '撤销条已过期', detail: '仍可在快照面板里还原', ms: NOTIFY_MS.long }),
          });
        }
      }
    }

    /** 新建：走「新建笔记」既有出口（不套模板，正文一次落盘） */
    for (const r of runnable.filter((x) => x.call.tool === 'create')) {
      const title = String(r.call.args.title ?? '');
      try {
        const made = await ctx.completion.createNote({
          title,
          dirRel: String(r.call.args.dir ?? ''),
          noTemplate: true,
          body: String(r.call.args.body ?? ''),
        });
        put(r.at, { ok: true, summary: `已新建《${title}》`, detail: made.path, changed: true });
      } catch (e) {
        put(r.at, { ok: false, summary: `新建《${title}》失败：${e instanceof Error ? e.message : String(e)}` });
      }
    }

    /** 删除：`mover.trash`（自己拍快照）+ 撤销条 */
    const delList = runnable.filter((x) => x.call.tool === 'delete');
    if (delList.length > 0) {
      const files: TFile[] = [];
      for (const r of delList) {
        const file = noteAt(String(r.call.args.path ?? ''));
        if (file) files.push(file);
        else put(r.at, { ok: false, summary: `执行时已经找不到「${String(r.call.args.path)}」了` });
      }
      if (files.length > 0) {
        const trashed = await ctx.mover.trash({
          files,
          source: 'ai',
          reason: `AI 建议：删除 ${files.length} 篇`,
        });
        for (const r of delList) {
          if (settled.has(r.at)) continue; // 上面"找不到"已填过
          const abs = absOf(String(r.call.args.path ?? ''));
          const hit = trashed.trashed.find((t) => t.path === abs);
          if (hit) {
            put(r.at, {
              ok: true,
              summary: `已删除《${stripExt(baseName(abs))}》（${trashed.trashOption === 'local' ? '库内 .trash' : '回收站'}，快照可还原）`,
              changed: true,
            });
          } else if (trashed.error) {
            put(r.at, { ok: false, summary: `没删成：${trashed.error}` });
          } else {
            const sk = trashed.skipped.find((s) => s.path === abs);
            put(r.at, { ok: false, summary: `没删成《${stripExt(baseName(abs))}》${sk?.note ? `：${sk.note}` : ''}` });
          }
        }
        if (trashed.trashed.length > 0) {
          showUndo({
            text: `已删除 ${trashed.trashed.length} 篇笔记`,
            detail: trashed.reversible ? '进了库内 .trash' : '进了系统回收站（快照里还有原文）',
            onUndo: () => void restoreOrNotify(ctx.snapshot, trashed.snapshotId),
            onView: () => void ctx.report.openLatest(),
            onExpire: () =>
              notify({
                kind: 'info',
                text: '撤销条已过期',
                detail: '仍可在快照面板里还原',
                ms: NOTIFY_MS.long,
              }),
          });
        }
      }
    }
  }
}
