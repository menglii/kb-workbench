/**
 * spec：**P6 段④ · AI 助手**（2026-09-28）—— 离线能验的那一半
 *
 * 这一轮真正的工作量在"把 §11 的四条安全边界落成代码与判据"，不在界面。
 * 所以本文件的骨架就是那四条，一条一组：
 *
 * | 边界 | 在哪验 |
 * |---|---|
 * | ① 只提建议，不直接动库 | §C：默认档**不**自动进确认流；开了档**才**自动进（负向 + 正向各一条） |
 * | ② 不绕快照 | §C：撤销条能把这一批**整体**撤回去（撤销 = 快照还原） |
 * | ③ 不能改 AI指令集 | §A 纯函数 + §C **真链路**（建议里混着它 → 别的搬了、它一字节没动） |
 * | ④ 每次动库都留痕 | §C：`parseReport(...).ai === true`，来源是「AI 建议」 |
 *
 * ⚠️ **真机才验得了的那些不在这里**：真调一次模型（key 与网络通）· 面板的几何与滚动 ——
 * 全在 `scripts/probe.mjs`。
 *
 * 🔴 **离线绝不联网**：桩的 `requestUrl` 默认抛（`tests/stub/index.ts`），
 * 忘了注入假响应会当场炸，而不是静默去调真模型。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
// ⑧-B：断言「助手那一侧真的渲染过 Markdown」（不是把文本糊上去）
import { MarkdownRenderer } from '../stub/index';
import { Suite, contains, eq, notContains, ok } from '../framework';
import * as H from '../helpers';
import { buildAiPlan, isAiProtected } from '../../src/services/ai/plan';
import {
  AI_LIMITS,
  buildBeautifyMessages,
  buildMessages,
  buildAgentMessages,
  parseAdvice,
  parseAgentReply,
  parseBeautify,
  AiParseError,
} from '../../src/services/ai/prompt';
import { diffLines, diffSummary } from '../../src/core/diff';
import {
  AI_TOOL_CLASSES,
  AI_TOOL_CLASS_OF,
  DEFAULT_TOOL_TIERS,
  effectiveTier,
  validateCall,
  rowOfCall,
} from '../../src/services/ai/tools';
import { AiError } from '../../src/services/ai/transport';
import { normalizeSettings } from '../../src/core/settings';
import fs from 'node:fs';
import path from 'node:path';
import { parseReport } from '../../src/services/report';
import { hasUndoBar } from '../../src/ui/undo-bar';
import { purgeOverlays } from '../../src/ui/panel';

const KB = '01_新知识库';
/** 库内绝对路径的指令集目录（`settings.metaRoot() + /03_AI指令集`） */
const AI_DIR = `${KB}/99_Meta/03_AI指令集`;
const RULE_FILE = `${AI_DIR}/AI操作规范.md`;

export async function specAi(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 收干净浮层（**每条用例起手与收尾各一次**：残留模态会让 `.pop()` 认错人） */
  function sweep(): void {
    purgeOverlays();
  }

  // ════════════════════════════════════════════════════════════
  // §A 建议 → 计划的闸门（`services/ai/plan.ts`，纯函数）
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ 边界③ · AI 建议的闸门（纯函数）', async () => {
    await suite.it('相对库根 → 库内绝对：只转一次，且转对', () => {
      const plan = buildAiPlan({
        ideas: [{ path: '00_Inbox/_收件箱.md', to: '01_Projects', why: '测试' }],
        kbRoot: KB,
        aiDir: AI_DIR,
        hasNote: () => true,
        dirs: new Set([`${KB}/01_Projects`]),
      });
      eq(plan.blocked.length, 0, '不该被拦');
      eq(plan.rows.length, 1, '放过一条');
      eq(plan.rows[0].path, `${KB}/00_Inbox/_收件箱.md`, '源转成库内绝对路径');
      eq(plan.rows[0].dir, `${KB}/01_Projects`, '落点转成库内绝对路径');
      eq(plan.rows[0].rel, '00_Inbox/_收件箱.md', '界面看的仍是相对口径');
      eq(plan.rows[0].dirRel, '01_Projects', '界面看的落点也是相对口径');
    });

    await suite.it('🔴 硬拦：源在 AI 指令集里 → 拦下，不进计划', () => {
      const plan = buildAiPlan({
        ideas: [{ path: '99_Meta/03_AI指令集/AI操作规范.md', to: '01_Projects', why: '试试' }],
        kbRoot: KB,
        aiDir: AI_DIR,
        hasNote: () => true,
        dirs: new Set([`${KB}/01_Projects`]),
      });
      eq(plan.rows.length, 0, '一条都不许进计划');
      eq(plan.blocked.length, 1, '要报出来（静默丢弃 = 用户以为模型没想到）');
      eq(plan.blocked[0].code, 'protected', '原因码是 protected');
    });

    await suite.it('🔴 硬拦：落点在 AI 指令集里 → 也拦（搬进去 = 同样在改它）', () => {
      const plan = buildAiPlan({
        ideas: [{ path: '00_Inbox/_收件箱.md', to: '99_Meta/03_AI指令集', why: '塞进去' }],
        kbRoot: KB,
        aiDir: AI_DIR,
        hasNote: () => true,
        dirs: new Set([AI_DIR]),
      });
      eq(plan.rows.length, 0, '一条都不许进计划');
      eq(plan.blocked[0].code, 'protected', '原因码是 protected');
    });

    /**
     * ⚠️ **闸门的五类各占一条 `it`**（独立审查 B🟡7）：第一版把 5 个 `eq` 串在一条里，
     * 而 `ok()/eq()` 一失败就**抛** —— 后面几条永远不跑，红出来的是**同一个测试名**，
     * 看不出是哪一关坏了（CLAUDE.md："红线断言一条 `it` 一条"）。
     */
    const dirsOne = new Set([`${KB}/01_Projects`]);
    const oneIdea = (idea: { path: string; to: string }) =>
      buildAiPlan({ ideas: [idea], kbRoot: KB, aiDir: AI_DIR, hasNote: () => true, dirs: dirsOne });

    await suite.it('闸门 · 落点目录库里没有 → no-dir', () => {
      eq(oneIdea({ path: '00_Inbox/a.md', to: '01_Projects/不存在' }).blocked[0]?.code, 'no-dir', '落点目录库里没有');
    });

    await suite.it('闸门 · 压根没写落点 → no-dir', () => {
      eq(oneIdea({ path: '00_Inbox/a.md', to: '' }).blocked[0]?.code, 'no-dir', '没写落点');
    });

    await suite.it('闸门 · 库里找不到这一篇 → missing-note', () => {
      eq(
        buildAiPlan({
          ideas: [{ path: '00_Inbox/a.md', to: '01_Projects' }],
          kbRoot: KB,
          aiDir: AI_DIR,
          hasNote: () => false,
          dirs: dirsOne,
        }).blocked[0]?.code,
        'missing-note',
        '库里找不到这一篇',
      );
    });

    await suite.it('闸门 · 它已经在这个目录里了（假建议）→ same-place', () => {
      eq(
        oneIdea({ path: '01_Projects/a.md', to: '01_Projects' }).blocked[0]?.code,
        'same-place',
        '已经在目标目录里',
      );
    });

    await suite.it('闸门 · 同一篇在这一次建议里出现两次 → 第一篇留、第二篇 duplicate', () => {
      const dup = buildAiPlan({
        ideas: [
          { path: '00_Inbox/a.md', to: '01_Projects' },
          { path: '00_Inbox/a.md', to: '01_Projects' },
        ],
        kbRoot: KB,
        aiDir: AI_DIR,
        hasNote: () => true,
        dirs: dirsOne,
      });
      eq(dup.rows.length, 1, '第一篇留下');
      eq(dup.blocked[0]?.code, 'duplicate', '第二篇拦下');
    });

    await suite.it('`isAiProtected` 含自身、含子路径，不误伤兄弟目录', () => {
      ok(isAiProtected(AI_DIR, AI_DIR), '目录自己');
      ok(isAiProtected(`${AI_DIR}/AI操作规范.md`, AI_DIR), '目录里的文件');
      ok(isAiProtected(`${AI_DIR}/子目录/x.md`, AI_DIR), '目录里的子目录');
      ok(!isAiProtected(`${KB}/99_Meta/05_操作日志/x.md`, AI_DIR), '兄弟目录不算');
      ok(!isAiProtected(`${KB}/00_Inbox/03_AI指令集.md`, AI_DIR), '同名前缀不算（按段比，不是按字符串前缀）');
      ok(!isAiProtected(AI_DIR, ''), '没配元数据目录时这道闸不存在（不误拦）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B 提示词与解析（`services/ai/prompt.ts`，纯函数）
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ · 提示词与回话解析', async () => {
    await suite.it('system 里写着那条硬规矩与"只能从清单里选"', () => {
      const msgs = buildMessages({
        question: '把收件箱那几篇归到项目里',
        kbRoot: KB,
        dirs: ['01_Projects', '02_Areas'],
        rules: '我的规则：有明确目标的进 Projects',
        candidates: [{ rel: '00_Inbox/a.md', title: 'a', props: '类型:想法' }],
      });
      const sys = msgs[0];
      eq(sys.role, 'system', '第一条是 system');
      contains(sys.content, '03_AI指令集', '硬规矩里点到了 AI 指令集目录');
      contains(sys.content, '只能读', '说清是只读');
      // 规范正文放 **system**（不是 user）：夹在长清单里会被淹没，模型漏掉它的概率明显更高
      contains(sys.content, '有明确目标的进 Projects', '用户的规范正文进了 system');
      const last = msgs[msgs.length - 1];
      contains(last.content, '01_Projects', '目录清单进去了');
      contains(last.content, '00_Inbox/a.md', '候选笔记清单进去了');
    });

    await suite.it('提示词允许它"先说话 / 反问"（两段式的第一半，P6 第八段）', () => {
      const msgs = buildMessages({
        question: '你能干嘛',
        kbRoot: KB,
        dirs: ['01_Projects'],
        rules: '',
        candidates: [],
      });
      const sys = msgs[0].content;
      contains(sys, '不要输出 JSON', '明说"聊天时别输出 JSON"（不然它还是会硬凑一个）');
      contains(sys, '正常回答', '给了"正常回答"这条路');
      contains(sys, '也直接问', '说得不清楚时"直接问用户"也允许（条款写在提示词正文里，别照注释抄）');
      // 给建议那条路照旧（松绑不等于放松硬规矩）
      contains(sys, '{"reply"', '给建议时的 JSON 格式还在');
      contains(sys, '03_AI指令集', '硬规矩①照旧在');
    });

    await suite.it('剥围栏与前后废话都算解析成功（真模型很爱这么写）', () => {
      const fenced =
        '好的，我看了这几篇：\n```json\n{"reply":"建议归到项目","ideas":[{"path":"a.md","to":"01_Projects","why":"会结束"}]}\n```\n以上。';
      const a = parseAdvice(fenced);
      eq(a.reply, '建议归到项目', 'reply 读到了');
      eq(a.ideas.length, 1, 'ideas 读到了');
      eq(a.ideas[0].to, '01_Projects', '字段对');
    });

    await suite.it('🔴 JSON 后面还有一段带花括号的话时，按括号配平切，不切到最后一个 `}`', () => {
      const a = parseAdvice('{"reply":"r","ideas":[]}\n\n补充说明：如果 {这种情况} 就再问我。');
      eq(a.reply, 'r', '切出来的是第一个完整对象');
      eq(a.ideas.length, 0, '空数组也是合法的建议（宁可空手）');
      // 反面：真按"第一个 { 到最后一个 }"切，这里会解析失败 —— 那条路会把人
      // 带去查"模型输出质量"，而真因在切法（本项目最烦的一类误诊）
    });

    await suite.it('字符串字面量里的花括号不参与配平', () => {
      const a = parseAdvice('{"reply":"他说{这样}不行","ideas":[]}');
      eq(a.reply, '他说{这样}不行', '引号里的 { } 没被当成层级');
    });

    /**
     * ── P6 第八段：**两段式解析**（用户真机第 1 条）─────────────
     *
     * 用户问"你能干嘛"，模型用散文答（这是**对的**），而旧口径要求只回 JSON →
     * `parseAdvice` 抛错 → 面板把那段好好的回答裱成**红框**。
     * 现在的判据分三档：散文 = 聊天 · 配平但写坏 = 抛 · 合法 JSON 但不是那个形状 = 聊天。
     */
    await suite.it('🔴 散文回答 = 聊天（**不抛**），全文进 reply（用户报的那条）', () => {
      const a = parseAdvice('我没看懂你的意思，能再说一遍吗？');
      eq(a.kind, 'chat', '这是聊天轮，不是错误');
      eq(a.reply, '我没看懂你的意思，能再说一遍吗？', '模型的原话一字不少地留着');
      eq(a.ideas.length, 0, '聊天轮没有建议 —— 但这是**正常**的一轮');
      // 多段散文也要完整留下（别只取第一行）
      const b = parseAdvice('我可以帮你把笔记归位。\n\n比如你说「收件箱里那几篇」\n我就去看看。');
      contains(b.reply, '我就去看看', '多段散文也整段留下');
    });

    await suite.it('🔴 想写 JSON 却写坏了 → **才抛** AiParseError（且只认 `{"` 开头那种）', () => {
      // ⚠️ 判据收得很紧：**"一看就是 JSON 的开头"（`{"`）却解析不了**才算写坏了。
      //    放宽成"有配平对象却解析不了"就会把下面那条散文反例裱成错误（独立审查 A🔴1）
      let threw = false;
      try {
        parseAdvice('好的：{"reply": "建议归到项目", ideas: []}');
      } catch (e) {
        threw = e instanceof AiParseError;
      }
      ok(threw, '以 {" 开头却解析不了 → 抛（它真在写 JSON）');
      // 反面一：**拿花括号当记法**的散文 —— 配平、但一看就不是 JSON，**不抛**
      const c = parseAdvice('如果你想加个 {标签} 的话我做不到；格式是 {path, to, why} 三样');
      eq(c.kind, 'chat', '`{标签}` / `{path, to, why}` 这类记法 → 聊天，不抛');
      contains(c.reply, '我做不到', '原话留着');
    });

    /**
     * 🔴 **独立审查 A🔴1 的三条反例**（拿真源码跑出来的）：
     * 旧写法"从第一个 `{` 起配平"会把模型**先举例再给真东西**的情形整轮丢掉 ——
     * 抠到举例 → 解析失败 → 抛（或当聊天），而模型那份 JSON 一点没坏。
     * 这是**高频形状**（模型很爱先在正文里示范一下格式），所以每条都要钉住。
     */
    await suite.it('🔴 散文里有配平的花括号，**后面**才是真 JSON → 建议照样抠得出来', () => {
      const a = parseAdvice(
        '我会按你自己的规范来。判断依据是「文件位置」，格式形如 {源 → 目标}。\n' +
          '{"reply":"这 2 篇该归到项目","ideas":[{"path":"00_Inbox/a.md","to":"01_Projects","why":"会结束"}]}',
      );
      eq(a.kind, 'advice', '它是建议轮（不是"当成聊天看了"）');
      eq(a.ideas.length, 1, '真建议抠出来了');
      eq(a.ideas[0].path, '00_Inbox/a.md', '字段对');
      eq(a.reply, '这 2 篇该归到项目', 'reply 用的是 JSON 里那一段');
    });

    await suite.it('🔴 「你能干嘛」那种形状（正文里示范 `{path, to, why}`）→ 聊天、不抛', () => {
      const a = parseAdvice(
        '我能做这些：\n1. 把某几篇从一个目录搬到另一个目录\n2. 输出格式是 {path, to, why} 三样。\n你能说说是哪几篇吗？',
      );
      eq(a.kind, 'chat', '纯散文 + 记法花括号 → 聊天（旧写法会在这里抛）');
      contains(a.reply, '你能说说是哪几篇吗', '原话整段留着');
    });

    await suite.it('🔴 前面先举了个**合法**的 JSON 例子、后面才是真建议 → 取形状对的那一个', () => {
      const a = parseAdvice(
        '格式是 {"path":"路径","to":"目录"} 这样。\n' +
          '{"reply":"建议归到项目","ideas":[{"path":"00_Inbox/b.md","to":"01_Projects"}]}',
      );
      eq(a.kind, 'advice', '不能被前面的例子骗成聊天轮');
      eq(a.ideas.length, 1, '取的是后面那份真建议');
      eq(a.ideas[0].path, '00_Inbox/b.md', '字段对');
    });

    await suite.it('合法 JSON 但不是那个形状（正文里举了例子）→ 也当聊天', () => {
      const a = parseAdvice('格式大概是 {"a": 1} 这样，我这次就不改你的库了');
      eq(a.kind, 'chat', '既不 reply 也不 ideas → 当聊天');
      contains(a.reply, '这次就不改你的库了', '原话整段留着（含 JSON 那一段举例）');
    });

    await suite.it('`kind` 的另外半边：有 reply / ideas 就是 advice（**哪怕 ideas 是空的**）', () => {
      const a = parseAdvice('{"reply":"这几篇我看都可以不动","ideas":[]}');
      eq(a.kind, 'advice', '空 ideas 也是"给过建议的一轮"（界面据此说"没有可执行的建议"）');
      eq(a.reply, '这几篇我看都可以不动', 'reply 照读');
    });

    await suite.it('`reply` 空着时回落到 JSON 之外那段散文（别让界面上一句解释都没有）', () => {
      const a = parseAdvice('我看了收件箱这几篇。\n{"reply":"","ideas":[{"path":"a.md","to":"01_Projects"}]}');
      eq(a.kind, 'advice', '仍然是建议轮');
      eq(a.reply, '我看了收件箱这几篇。', 'reply 空 → 用外面那段话顶上');
      eq(a.ideas.length, 1, '建议照收');
      // 反面：JSON 里**有** reply 时以它为准（那是模型专门写给用户的那一段）
      const b = parseAdvice('（旁白）{"reply":"正式说法","ideas":[]}');
      eq(b.reply, '正式说法', '有 reply 就不拿旁白顶替');
    });

    await suite.it('ideas 里形状不对的项被丢掉 —— **但要数出来**（静默丢弃与"拦下要说出来"相抵）', () => {
      const a = parseAdvice(
        '{"reply":"r","ideas":[{"path":"a.md"},{"to":"01_Projects"},{"path":"b.md","to":"02_Areas"},null]}',
      );
      eq(a.ideas.length, 1, '只有完整那一项留下');
      eq(a.ideas[0].path, 'b.md', '留下的是完整那条');
      eq(a.dropped, 3, '缺 path / 缺 to / 压根不是对象 —— 三条都要计数（独立审查 A🟡：第一版是静默丢的）');
    });

    await suite.it('`buildMessages` **不再**截断 history（两处各切一刀会只剩 2 轮）', () => {
      const turns = [1, 2, 3].flatMap((i) => [
        { who: 'user' as const, text: `q${i}` },
        { who: 'ai' as const, text: `a${i}` },
      ]);
      const msgs = buildMessages({
        question: 'x',
        kbRoot: KB,
        dirs: [],
        rules: '',
        candidates: [],
        history: turns,
      });
      eq(msgs.length, 1 + 6 + 1, 'system + 6 条历史 + 当前这一问 —— 喂多少就是多少，口径只留在调用方那一处');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C 真链路（服务层 → 面板 → 确认流 → mover → 日志 → 撤销）
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ · 真链路：问 → 勾 → 确认流 → mover → 留痕 → 撤销', async () => {
    /** 每一轮起手：收浮层、清假响应、把 AI 配好 */
    async function fresh(advice: Parameters<typeof H.stubAi>[0]): Promise<void> {
      sweep();
      H.resetAi();
      H.stubAi(advice);
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      await H.settle(0);
    }

    /** 同上，但喂**一串**回话（agent 的一轮 = 多次模型调用：提动作 → 收尾，见 `H.stubAiSeq`） */
    async function freshSeq(list: Parameters<typeof H.stubAiSeq>[0]): Promise<void> {
      sweep();
      H.resetAi();
      H.stubAiSeq(list);
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      await H.settle(0);
    }

    /** 起一个 AI 面板（走 `ctx.openAi`，与首页那个入口同一条路） */
    function openPanel(seed?: string): HTMLElement {
      ctx().openAi(seed);
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
      ok(modal, 'AI 面板开出来了');
      contains(H.textOf(modal), '经纬助手', '开的是 AI 面板');
      return modal as HTMLElement;
    }

    /** 「这一轮画完了」的信号数（每轮收尾挂一枚 `.kbw-ai-ops`；错误气泡也算一条出路） */
    const opsOf = (modal: HTMLElement): number =>
      modal.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length +
      modal.querySelectorAll('.kbw-ai-log .kbw-ai-bubble.is-error').length;

    /**
     * 在面板里问一句，等到**下一步能动手**为止（三种情形之一）：
     * ① 这一轮画完（`.kbw-ai-ops`，纯聊天轮）；② 待确认卡挂出来（`.kbw-ai-acts`）；
     * ③ 「自动」档直接弹了确认框（第二个 `.kbw-modal`）。
     * ⚠️ **等信号、别赌固定时长**（P7.3a 的教训：打字机回放的墙钟随机器负载变）。
     */
    async function askIn(modal: HTMLElement, q: string): Promise<void> {
      const log = modal.querySelector('.kbw-ai-log') as HTMLElement;
      const done = (): number => opsOf(modal);
      const before = done();
      H.q<HTMLTextAreaElement>(modal, '.kbw-ai-input').value = q;
      H.click(H.q<HTMLElement>(modal, '.kbw-ai-send .kbw-btn'));
      const settled = await H.until(
        () =>
          done() > before ||
          log.querySelector('.kbw-ai-acts') !== null ||
          H.qa(document.body, '.kbw-modal').length > 1,
        4000,
      );
      // 再给一拍让 Markdown 渲染收尾；超时也继续往下（让断言带着现场报，而不是这里静默）
      await H.settle(settled ? 80 : 300);
    }

    /** 点完执行/确认之后，等这一轮**真正收尾**（第二段回话与收尾行都画完） */
    async function waitTurnEnd(modal: HTMLElement, before: number): Promise<void> {
      await H.until(() => opsOf(modal) > before, 4000);
      await H.settle(80);
    }

    /** 点待确认卡的「执行这 N 项」 */
    function runPending(modal: HTMLElement): void {
      H.click(H.q<HTMLElement>(modal, '.kbw-ai-acts .kbw-btn.is-primary'));
    }

    /** 点待确认卡的「跳过」（什么都不执行） */
    function skipPending(modal: HTMLElement): void {
      const b = H.qa<HTMLElement>(modal, '.kbw-ai-acts .kbw-btn').find((x) => H.textOf(x).includes('跳过'));
      ok(b, '找得到「跳过」');
      H.click(b as Element);
    }

    /** 点确认框的主按钮（确认流是**最后一个**模态） */
    async function acceptConfirm(): Promise<string> {
      const m = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
      ok(m, '确认框在');
      const text = H.textOf(m);
      H.click(m.querySelector<HTMLElement>('.kbw-modal-foot .kbw-btn.is-primary') as Element);
      await H.settle(140);
      return text;
    }

    /**
     * 造一篇可控的夹具（**别拿真库那 43 篇当"待搬的"**：它们的形状是别的用例的前提）。
     *
     * ⚠️ **参数是"相对库根"的口径**（`00_Inbox/x.md`，与 AI 建议里的 `path` 同一个口径），
     * 落盘时要补上库根 —— 这两种口径本项目栽过两次（`kbDirs` / `plan.newDirs`），
     * 混了的症状是"文件写到库外去了、索引看不见"，而报出来是"库里找不到这一篇"。
     *
     * @returns `{ rel, abs }`：`rel` 喂建议、`abs` 喂文件断言
     */
    async function fixture(rel: string): Promise<{ rel: string; abs: string }> {
      H.writeNote(vaultRoot, `${KB}/${rel}`, '---\n类型: 想法\n---\n\n正文\n');
      app.vault.rescan();
      /**
       * 🔴 **`rescan()` 之后必须 `index.rebuild()`**（CLAUDE.md 记过的那条）：
       * `rescan()` 会把全部 `TFile` 对象**重新构造**，而索引还攥着旧的那批 ——
       * 不重建的话新造的文件在 `index.get()` 里**查不到**。
       * 症状在这里正是"`库里找不到这一篇`"（建议被 `buildAiPlan` 判成 missing-note），
       * 看着像闸门坏了，其实是夹具没进索引。
       */
      ctx().index.rebuild();
      await H.settleIndex(app);
      return { rel, abs: `${KB}/${rel}` };
    }

    await suite.it('`ask()` 走假传输层 → 出计划；`rows` 是库内绝对路径', async () => {
      await fresh({ reply: '看着像项目笔记', ideas: [{ path: '00_Inbox/_收件箱.md', to: '01_Projects', why: '会结束' }] });
      const turn = await ctx().ai.ask({ question: '把收件箱那篇归到项目' });
      eq(turn.plan.rows.length, 1, '过了一条');
      eq(turn.plan.rows[0].path, `${KB}/00_Inbox/_收件箱.md`, '源是库内绝对路径');
      eq(turn.reply, '看着像项目笔记', 'reply 传上来了');
      H.resetAi();
    });

    /**
     * ── P6 第八段：**聊天形态的判据**（用户第 1、2 条）────────────
     */
    await suite.it('🔴 问「你能干嘛」：散文回答 → 面板**不出红框**、回答完整、Markdown 真渲染过', async () => {
      await fresh({
        raw:
          '# 我能干嘛\n\n我能帮你**把笔记归位**：\n\n- 把收件箱里的项目笔记归到 `01_Projects`\n- 把灵感归到内容创作\n',
      });
      const modal = openPanel();
      const mdBefore = MarkdownRenderer.calls;
      await askIn(modal, '你能干嘛');
      await H.settle(120); // Markdown 渲染是异步的

      // ① **不许有红框** —— 这就是用户截图里那一条
      eq(modal.querySelectorAll('.kbw-ai-bubble.is-error').length, 0, '散文回答不许被画成错误');
      // ② 回答要完整显示（不是"没有建议"那种空话）
      const reply = H.q<HTMLElement>(modal, '.kbw-ai-bubble.is-ai .kbw-ai-reply');
      contains(H.textOf(reply), '把笔记归位', '模型那段回答完整显示出来了');
      contains(H.textOf(reply), '01_Projects', '后半段也在（别只留第一行）');
      // ③ 聊天轮**不画建议表**，也不该说"没有可执行的建议"
      eq(modal.querySelectorAll('.kbw-ai-plan').length, 0, '聊天轮没有表');
      notContains(H.textOf(modal), '这一轮没有可执行的建议', '别把一次正常回答写成"什么都没做"');
      /**
       * ④ **也不许走"格式没写完整"那条路**（这一条是突变测试逼出来的）：
       * 只判"没有红框"是不够的 —— 把散文重新当成 `AiParseError` 时，
       * 面板那条"降级成聊天气泡 + 一句轻说明"的分支**照样不画红框**，
       * 于是前三条断言全绿（突变实测）。散文与"JSON 写坏了"是两回事，这儿要把它们分开。
       */
      notContains(H.textOf(modal), '没写完', '散文不该被当成"格式错误"来对待');
      // ④ **Markdown 真的走了一遍**（"文本在"与"渲染过"是两件事）
      ok(MarkdownRenderer.calls > mdBefore, 'MarkdownRenderer 被调过（不是纯文本糊上去）');
      ok(
        reply.querySelector('p, li, h1, h2, h3, strong, code') !== null,
        '渲染出了元素（判据认 DOM，不认"文本里有没有那行字"）',
      );
      H.resetAi();
    });

    await suite.it('🔴 模型**先说话再给 JSON** → 待确认卡照样出得来（两段式 + 老格式兼容）', async () => {
      const f = await fixture('00_Inbox/__探针AI两段.md');
      await freshSeq([
        {
          raw:
            '我看了收件箱，这篇看着像项目笔记，会结束的那种。\n\n' +
            JSON.stringify({ reply: '建议归到项目', ideas: [{ path: f.rel, to: '01_Projects', why: '会结束' }] }),
        },
        { reply: '那就先不动' },
      ]);
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '整理一下');
      await H.settle(120);
      eq(H.qa(modal, '.kbw-ai-plan .kbw-ai-row').length, 1, '待确认卡出来了（老 `ideas` 格式转成 move 动作）');
      /**
       * ⚠️ 显示的是 **JSON 里那个 `reply`**（"建议归到项目"），不是 JSON 外面那段旁白 ——
       * 那是模型按格式专门写给用户的一段（口径与 `parseAdvice` 一致）。
       * 判据落在它上面，而不是"面板里有没有那段旁白"（第一版就是这么写错的）。
       */
      contains(H.textOf(modal), '建议归到项目', 'JSON 里的 reply 显示出来了');
      eq(modal.querySelectorAll('.kbw-ai-bubble.is-error').length, 0, '同样不许有红框');
      contains(H.textOf(modal), '执行这 1 项', '待确认卡上有执行');
      skipPending(modal);
      await waitTurnEnd(modal, n0);
      sweep();
      H.resetAi();
    });

    await suite.it('多轮上下文：第二轮把上一轮的**动作结果**压成一行带上（"接着弄"接得上）', async () => {
      const f = await fixture('00_Inbox/__探针AI多轮.md');
      sweep();
      H.resetAi();
      const stub = H.stubAiSeq([
        { reply: '先搬这一篇', ideas: [{ path: f.rel, to: '01_Projects', why: 'x' }] },
        { reply: '搬好了' },
        { reply: '第二篇在哪儿？' },
      ]);
      await H.configAi(plugin);
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '把收件箱那篇归到项目');
      runPending(modal);
      await H.settle(40);
      await acceptConfirm();
      await waitTurnEnd(modal, n0);
      await askIn(modal, '那第二篇呢');
      eq(stub.calls.length, 3, '发了三次（提动作 → 收尾 → 下一问；前提）');
      const sent = JSON.parse(String(stub.calls[2].body ?? '{}')) as {
        messages: { role: string; content: string }[];
      };
      const assist = sent.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .join('\n');
      /**
       * 判据落在**发出去的那一份请求体**上：只带 reply 的话模型看不见上一轮真做了什么，
       * "接着弄"就接不上（那正是"多轮上下文没真起作用"）。
       * ⚠️ P7.3b 起带的是**动作结果**（`已移动《…》`），不再是 `path → to` 的清单 ——
       * 用户可能跳过/拒绝，只有结果才代表真的发生过。
       */
      contains(assist, '已移动', '上一轮的动作结果以一行清单带上了');
      contains(assist, '搬好了', 'reply 照旧带');
      sweep();
      H.resetAi();
    });

    await suite.it('🔴 真链路硬拦：模型建议搬 AI操作规范 → 计划里没有它，文件一字节没动', async () => {
      await fresh({
        reply: '我建议挪一下规范文件',
        ideas: [{ path: '99_Meta/03_AI指令集/AI操作规范.md', to: '01_Projects', why: '模型乱说' }],
      });
      const before = H.readNote(vaultRoot, RULE_FILE);
      const turn = await ctx().ai.ask({ question: '随便整理一下' });
      eq(turn.proposed, 1, '模型**提了**这一条（不然这条用例测的是空气）');
      eq(turn.plan.rows.length, 0, '一条都不许进计划');
      eq(turn.plan.blocked[0]?.code, 'protected', '被硬拦');
      eq(H.readNote(vaultRoot, RULE_FILE), before, '内容一字节没变');
      ok(H.exists(vaultRoot, RULE_FILE), '原位还在');
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/AI操作规范.md`), '没有被搬走');
      H.resetAi();
    });

    await suite.it('🔴 混着一条正常建议走完**整个执行路径**：那条搬了、规范那条一字节没动', async () => {
      const ok1 = await fixture('00_Inbox/__探针AI混.md');
      await freshSeq([
        {
          reply: '一条能搬、一条乱说',
          ideas: [
            { path: ok1.rel, to: '01_Projects', why: '这条合规' },
            { path: '99_Meta/03_AI指令集/AI操作规范.md', to: '01_Projects', why: '这条不许' },
          ],
        },
        { reply: '先这样' },
      ]);
      const before = H.readNote(vaultRoot, RULE_FILE);
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '整理一下');
      contains(H.textOf(modal), '执行这 1 项', '只有合规那条进了待确认卡');
      contains(H.textOf(modal), '只能读、不能改', '拦下的要摆出来给用户看（预检先于勾选）');
      runPending(modal);
      await H.settle(40);
      contains(await acceptConfirm(), '移动 1 篇', '确认流只报 1 篇');
      await waitTurnEnd(modal, n0);

      ok(!H.exists(vaultRoot, ok1.abs), '合规那条搬走了');
      ok(H.exists(vaultRoot, `${KB}/01_Projects/__探针AI混.md`), '落在目标位置');
      eq(H.readNote(vaultRoot, RULE_FILE), before, '🔴 规范文件一字节没动');
      ok(H.exists(vaultRoot, RULE_FILE), '🔴 而且还在原位');
      sweep();
      H.resetAi();
    });

    await suite.it('默认档：出完方案**不**自动进确认流（负向判据）', async () => {
      const neg = await fixture('00_Inbox/__探针AI负.md');
      await freshSeq([
        { reply: '建议搬一篇', ideas: [{ path: neg.rel, to: '01_Projects', why: 'x' }] },
        { reply: '那就不动' },
      ]);
      // 默认档（P7.5 起只有默认表一个来源：旧的 allowWrite 已退役）
      eq(effectiveTier('move', ctx().settings.get().ai), 'confirm', '默认档就是"改库需确认"');
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '整一下');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '只有 AI 面板本身 —— 没有自动弹确认框');
      // ⚠️ 光数模态是不够的（独立审查 B🟡8）：计数只说"没弹第二个模态"，
      // **没说文件没动**。成对判一句才真的说明"这一档什么都不做"。
      ok(H.exists(vaultRoot, neg.abs), '那篇还在原位（"需确认"要落在文件上，不是落在模态计数上）');
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/__探针AI负.md`), '也没被搬到目标位置');
      contains(H.textOf(modal), '建议搬一篇', '建议画出来了');
      /**
       * R4（P7.12）：头部「改库需确认」胶囊**整体撤掉**（12:55 二拍：安全语义由确认流
       * 承担）—— 上面那几条"模态计数 + 文件没动 + 待确认卡"就是它的替身判据。
       * ⚠️ 独立审 B4（P7.12 收尾）：原来这里钉的是 `.kbw-ai-chip` 不存在 —— 该类已随功能
       * 从 src 删掉，"不存在"恒真。改钉**新形态**：安全说明挂在「⋯」的 tooltip 上。
       */
      ok(
        (H.maybe(modal, '.kbw-ai-morebtn')?.getAttribute('title') ?? '').includes('改库前都会弹确认框'),
        '「⋯」tooltip 扛起了「改库需确认」的说明（信息没丢，只是收起来了）',
      );
      contains(H.textOf(modal), '执行这 1 项', '待确认卡上有执行');
      contains(H.textOf(modal), '跳过', '「跳过」在');

      /**
       * 🔴 **「跳过」的语义是"一个字都不改"**，而这是个**危险方向**的静默失效点
       *（独立审查 B🔴6 当年抓过同形状的）：把它改成"先真执行一遍再收起"，整组**全绿** ——
       * 用户以为点了"跳过"，其实动了库。所以点一下，然后**成对判文件没动**。
       */
      skipPending(modal);
      await H.settle(80);
      contains(H.textOf(modal), '什么都没改', '跳过之后要说清"什么都没改"');
      eq(modal.querySelectorAll('.kbw-ai-plan .kbw-ai-row').length, 0, '待确认卡收起了');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '点它不该弹确认框');
      ok(H.exists(vaultRoot, neg.abs), '🔴 文件还在原位（「跳过」是一个字都不改）');
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/__探针AI负.md`), '🔴 也没被搬到目标位置');
      await waitTurnEnd(modal, n0);
      sweep();
      H.resetAi();
    });

    await suite.it('写类档位设成「自动」→ 自动进确认流；取消就什么都不发生', async () => {
      const pos = await fixture('00_Inbox/__探针AI正.md');
      await freshSeq([
        { reply: '建议搬一篇', ideas: [{ path: pos.rel, to: '01_Projects', why: 'x' }] },
        { reply: '好' },
      ]);
      // ⚠️ P7.5 起复现这条走**逐类档位**（旧的 allowWrite 已退役；move=auto 与它当年的映射等价）
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: { move: 'auto' } } });
      const modal = openPanel();
      /**
       * R4（P7.12）：头部档位胶囊已撤（安全语义由确认流承担）—— 「档位看得见」改由
       * ⋯ 的 tooltip 承担；行为判据就是下面这几条（自动档也照弹确认框、取消不跳过）。
       */
      const n0 = opsOf(modal);
      await askIn(modal, '整一下');
      const modals = H.qa<HTMLElement>(document.body, '.kbw-modal');
      eq(modals.length, 2, '自动弹出了确认框（AI 面板 + 确认流）');
      contains(H.textOf(modals[1]), '即将按 AI 的建议移动 1 篇', '标题写清是 AI 的建议');
      // 取消掉：这一档也**不许跳过确认**
      const cancel = H.qa<HTMLElement>(modals[1], '.kbw-modal-foot .kbw-btn').find((b) =>
        H.textOf(b).includes('取消'),
      );
      ok(cancel, '确认框里有取消');
      H.click(cancel as Element);
      await H.settle(40);
      ok(H.exists(vaultRoot, pos.abs), '取消之后文件没动');
      await waitTurnEnd(modal, n0);
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: {} } });
      sweep();
      H.resetAi();
    });

    await suite.it('勾选真的生效：勾掉的那条不执行（判据认"文件动没动"）', async () => {
      const a = await fixture('00_Inbox/__探针AI甲.md');
      const b = await fixture('00_Inbox/__探针AI乙.md');
      await freshSeq([
        {
          reply: '两篇都搬',
          ideas: [
            { path: a.rel, to: '01_Projects', why: '甲' },
            { path: b.rel, to: '01_Projects', why: '乙' },
          ],
        },
        { reply: '先这样' },
      ]);
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '搬这两篇');

      const boxes = H.qa<HTMLInputElement>(modal, '.kbw-ai-plan .kbw-ai-check');
      eq(boxes.length, 2, '两行都画出来了');
      boxes[0].checked = false;
      boxes[0].dispatchEvent(new Event('change'));
      contains(H.textOf(modal), '执行这 1 项', '按钮上的 N 跟着勾选变');

      runPending(modal);
      await H.settle(40);
      contains(await acceptConfirm(), '移动 1 篇', '确认流只报 1 篇');
      await waitTurnEnd(modal, n0);

      // 「搬成功了」要**成对判**（P6② 的教训）：新位置有 **且** 老位置没了
      ok(H.exists(vaultRoot, a.abs), '勾掉的那篇还在原位');
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/__探针AI甲.md`), '勾掉的那篇没被搬到目标位置');
      ok(!H.exists(vaultRoot, b.abs), '勾上的那篇老位置没了');
      ok(H.exists(vaultRoot, `${KB}/01_Projects/__探针AI乙.md`), '勾上的那篇在新位置');

      // ── 边界④：日志里读得出"这是 AI 建议的" ──
      /**
       * ⚠️ **只认插件自己写的那种文件名**（`日志-<8位日期>-<6位时间>-<动作>.md`）。
       * 只按"在 `05_操作日志/` 底下"筛是不够的：库里**本来就有**用户手写的
       * `AI操作日志.md` 这类文件（夹具里就有一份），按路径倒序它会排在最后、
       * 被当成"最新那一份"读走 —— 断言报出来是"没标 AI 建议"，
       * 而真因是**读错了文件**（这一类误诊本项目栽过好几次）。
       */
      const logs = app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.includes('05_操作日志') && /\/日志-\d{8}-\d{6}-/.test(`/${f.name}`))
        .sort((x, y) => y.path.localeCompare(x.path));
      ok(logs.length > 0, `写了操作日志（05_操作日志 里现在有：${H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`).join('、')}）`);
      const text = await app.vault.cachedRead(logs[0]);
      const parsed = parseReport(text, logs[0].path.split('/').pop());
      ok(parsed, '日志解析得出来');
      // 失败时把"读的是哪一份、里面写了什么"一起报出来 —— 只报一个 false 的话，
      // 下一轮得从零查"是没写日志、写错了来源、还是读错了文件"
      const diag = `（读的是 ${logs[0].path}｜来源=${parsed!.source}｜摘要=${parsed!.summary}｜` +
        `全文头 120 字=${text.slice(0, 120).replace(/\n/g, '⏎')}）`;
      eq(parsed!.ai, true, `④ 留痕：日志里标着"这条是 AI 建议的"${diag}`);
      eq(parsed!.source, 'AI 建议', '来源也写清了');
      contains(text, '__探针AI乙.md', '搬了哪一篇写在日志里');

      // ── 边界②：撤销条弹了 ──
      ok(hasUndoBar(), '弹了撤销条（边界②：AI 没有自己的回头路）');
      sweep();
      H.resetAi();
    });

    await suite.it('执行 **2** 项时标题写「移动 2 篇」—— N 跟着项数走，不是写死的 1；取消则一条都不动', async () => {
      /**
       * 独立审查 B🟡1：原来**所有**用例都只执行 1 项，于是把确认流标题里的 N 写死成 1
       * 也照样全绿（探针那步同样只勾 1 项）。这条专治那个。
       */
      const d = await fixture('00_Inbox/__探针AI丁.md');
      const e = await fixture('00_Inbox/__探针AI戊.md');
      await freshSeq([
        {
          reply: '两篇都搬',
          ideas: [
            { path: d.rel, to: '01_Projects', why: '丁' },
            { path: e.rel, to: '01_Projects', why: '戊' },
          ],
        },
        { reply: '好' },
      ]);
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '两篇都搬');
      contains(H.textOf(modal), '执行这 2 项', '按钮上就是 2');
      runPending(modal);
      await H.settle(40);
      const cfm = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      contains(H.textOf(cfm), '即将按 AI 的建议移动 2 篇', '确认流标题里的 N 跟着项数走');
      contains(H.textOf(cfm), '移动这 2 篇', '主按钮也重复数量（§9 的文案规则）');
      const cancel = H.qa<HTMLElement>(cfm, '.kbw-modal-foot .kbw-btn').find((b) =>
        H.textOf(b).includes('取消'),
      );
      ok(cancel, '确认框里有取消');
      H.click(cancel as Element);
      await H.settle(60);
      ok(H.exists(vaultRoot, d.abs) && H.exists(vaultRoot, e.abs), '取消之后两篇都还在原位');
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/__探针AI丁.md`), '都没被搬走');
      await waitTurnEnd(modal, n0);
      sweep();
      H.resetAi();
    });

    await suite.it('撤销能把这一批**整体**撤回去（走的是 mover 给的那个快照）', async () => {
      const c = await fixture('00_Inbox/__探针AI丙.md');
      await freshSeq([
        { reply: '搬一篇', ideas: [{ path: c.rel, to: '01_Projects', why: '丙' }] },
        { reply: '搬好了' },
      ]);
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '搬');
      runPending(modal);
      await H.settle(40);
      await acceptConfirm();
      await waitTurnEnd(modal, n0);
      ok(H.exists(vaultRoot, `${KB}/01_Projects/__探针AI丙.md`), '先搬过去了');
      ok(!H.exists(vaultRoot, c.abs), '老位置没了');

      /**
       * ⚠️ **取"当前那一条"撤销条**，不是 `document` 上第一条 ——
       * 换条时旧的要等 400ms 才退场，而 `querySelector` 按文档顺序会先命中**旧的**
       * （`H.currentUndoButton` 的注释里写了这一轮是怎么被它骗掉三轮的）。
       */
      const undo = H.currentUndoButton('撤销');
      ok(undo, '撤销条上找得到「撤销」');
      /**
       * ⚠️ 撤销那条路上**异常会被 `.catch(console.error)` 吞掉**（`ui/undo-bar.ts`）——
       * 所以这里把 console.error 收一份，失败时一并报出来。不收的话，
       * 症状只是"文件没回去"，而"为什么没回去"得从零查。
       */
      /**
       * 盯住还原那一次调用：**撤的必须是"这一次"那个快照**。
       *
       * 为什么单判"文件回去了"不够：**上一轮**（`勾选真的生效` 那次搬乙）留下的撤销条
       * 还在退场窗口里，点错了它照样会把**乙**搬回去 —— 于是"文件回去了"为真，
       * 而这条用例想验的东西一件没验到。P6④ 就是被它骗掉三轮的（详见 `H.currentUndoButton`）。
       */
      const restored: string[] = [];
      const snap = ctx().snapshot;
      const realRestore = snap.restore.bind(snap);
      snap.restore = async (id: string): Promise<Awaited<ReturnType<typeof realRestore>>> => {
        const man = await snap.read(id);
        const r = await realRestore(id);
        restored.push((man?.moves ?? []).map((mv) => `${mv.from} → ${mv.to}`).join(' , '));
        return r;
      };
      // 撤销那条路上异常会让 `.catch(console.error)` 吞掉 → 收一份，失败时一并报出来
      const errs: string[] = [];
      const origErr = console.error;
      console.error = (...a: unknown[]): void => {
        errs.push(a.map((x) => String(x)).join(' '));
        origErr(...a);
      };

      H.click(undo);
      // 还原是**异步**的一串（写回内容 + 逆 rename）→ 等它落地，别用固定时长赌
      const back = await H.until(() => H.exists(vaultRoot, c.abs), 2000, 25);
      console.error = origErr;
      ok(
        back,
        `撤回原位了（全库里带「丙」的：${H.listFiles(vaultRoot, KB).filter((p) => p.includes('丙')).join('、') || '一个都没有'}｜` +
          `还原的是：${restored.join(' ‖ ') || '（一次都没调到）'}｜` +
          `撤销时的 console.error：${errs.join(' ‖ ') || '（无）'}）`,
      );
      eq(
        restored[0],
        `${c.abs} → ${KB}/01_Projects/__探针AI丙.md`,
        '撤的是**这一次**那个快照（不是上一条还在退场的撤销条）',
      );
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/__探针AI丙.md`), '目标位置那份也没了');
      sweep();
      H.resetAi();
    });

    await suite.it('连接失败分得清是哪一种（401 → auth，不是笼统一句"出错了"）', async () => {
      await fresh({ raw: '{"error":{"message":"bad key"}}', status: 401 });
      let err: unknown = null;
      try {
        await ctx().ai.ask({ question: '随便问问' });
      } catch (e) {
        err = e;
      }
      ok(err instanceof AiError, '抛的是 AiError');
      eq((err as AiError).kind, 'auth', '分类到 auth');
      contains((err as AiError).hint, 'key', '给用户的那句话指向 key');
      H.resetAi();
    });

    await suite.it('网络层失败 → network（与 auth 分得开）', async () => {
      await fresh({ reply: 'x', ideas: [] });
      const keep = ctx().ai.transport;
      ctx().ai.transport = { chat: () => Promise.reject(new AiError('连不上', 'network')) };
      let err: unknown = null;
      try {
        await ctx().ai.ask({ question: '随便问问' });
      } catch (e) {
        err = e;
      }
      ok(err instanceof AiError && (err as AiError).kind === 'network', '分类到 network');
      contains((err as AiError).hint, '网络', '提示指向网络');
      ctx().ai.transport = keep;
      H.resetAi();
    });

    await suite.it('面板里问失败：报的是那一条的原因，不是"没有建议"', async () => {
      await fresh({ raw: '{"error":{"message":"bad key"}}', status: 401 });
      const modal = openPanel();
      await askIn(modal, '随便问问');
      contains(H.textOf(modal), 'key 不对或没有权限', '把 auth 那条原因摆出来了');
      sweep();
      H.resetAi();
    });

    await suite.it('没配 key：`isConfigured()` 假 · 面板给"去设置" · **点了问也不发请求**', async () => {
      sweep();
      H.resetAi();
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
      eq(ctx().ai.isConfigured(), false, '没配');
      const modal = openPanel();
      contains(H.textOf(modal), '还没配置', '面板说清是"还没配置"');
      contains(H.textOf(modal), 'API key', '说清要填什么');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '起手只有一层');

      /**
       * 🔴 判"不让问"的那半句（独立审查 B🔴2）：上面那两句断言的是**面板文本**，
       * 而它们是 `openAiPanel()` **打开那一刻**就画好的 —— 跟点了「问一下」之后走哪条路无关。
       * 把 `ask()` 里那段短路整段删掉，原判据**照样绿**。
       *
       * 真判据要落在**行为**上：桩把能力摆在这儿了 —— `H.stubAi()` 返回的 `calls`
       * 就是桩的 `requestLog`（"发出去的每一条请求"）。所以：装一次假响应拿到那个引用，
       * 点一下「问一下」，断言**一条都没发**。
       * ⚠️ 别为了取 `calls` 再调一次 `stubAi`（那会顺手重装一遍处理器）；`resetAi()` 会清空记录。
       */
      const ai = H.stubAi({ reply: '不该被用到', ideas: [] });
      // ⚠️ 这条不用 `askIn`（它等的是"结果画出来"，而这里**什么都不会画**）——
      // 直接点发送、给一拍，判"一条请求都没发"
      H.q<HTMLTextAreaElement>(modal, '.kbw-ai-input').value = '问一句';
      H.click(H.q<HTMLElement>(modal, '.kbw-ai-send .kbw-btn'));
      await H.settle(60);
      eq(ai.calls.length, 0, '没配 key 时**一次请求都不该发**（这才是"不让问"的判据）');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '没有第二层模态、也没有炸');
      contains(H.textOf(modal), '还没配置', '还是那句"还没配置"');
      sweep();
      await H.configAi(plugin);
      H.resetAi();
    });

    await suite.it('🔴 key 不进日志 / 通知（**要真的走一次会写日志的动作**，不然是空跑）', async () => {
      const secret = 'sk-绝密-不该出现在日志里';
      sweep();
      H.resetAi();
      const f = await fixture('00_Inbox/__探针AI密.md');
      const dest = `${KB}/01_Projects/__探针AI密.md`;
      H.stubAiSeq([
        { reply: '搬一篇', ideas: [{ path: f.rel, to: '01_Projects', why: 'x' }] },
        { reply: '搬好了' },
      ]);
      // ⚠️ **必须先把 key 设好，再走完整条路** —— 第一版只调了 `ai.ask()`，
      //    而 `ask()` **一张日志都不写**（写日志的是 mover/report，要跑完「问→勾→执行」才有）。
      //    于是它扫的是"key 设进去之前那批日志"，**永远不含这次的 key**：
      //    独立审查 B 用两步对照证死了 —— 把 `report.render()` 改成每张日志都带 apiKey，
      //    这条判据**照样绿**；在用例里补一句真写日志 → 当场红。改法就是下面这条真链路。
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: secret } });
      const modal = openPanel();
      const n0 = opsOf(modal);
      await askIn(modal, '整理一下');
      runPending(modal);
      await H.settle(40);
      await acceptConfirm();
      await waitTurnEnd(modal, n0);
      ok(!H.exists(vaultRoot, f.abs) && H.exists(vaultRoot, dest), '先确认这一趟**真的写了日志**（文件搬了）');

      const logs = app.vault
        .getMarkdownFiles()
        .filter((pf) => pf.path.includes('05_操作日志') && /\/日志-\d{8}-\d{6}-/.test(`/${pf.name}`));
      ok(logs.length > 0, '有这次写出来的日志可查（不然这条还是空跑）');
      let touched = 0;
      for (const lf of logs) {
        const text = await app.vault.cachedRead(lf);
        if (!text.includes('__探针AI密')) continue;
        touched += 1;
        notContains(text, secret, `${lf.path.split('/').pop()} 里不许有 key（§11.2：不进日志）`);
      }
      ok(touched > 0, '至少扫到一张**这一次**写的日志（扫到 0 张 = 又变成空跑了）');
      // 通知那一半：§11.2 说的是"不进任何**日志 / 通知 / 报告**"，通知就直接扫屏幕上的字
      notContains(document.body.textContent ?? '', secret, '屏幕上（通知/面板）也不许出现 key');
      sweep();
      await H.configAi(plugin, { apiKey: 'test-key' });
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.0a · 批 1⑩：开场引导（第一次打开不再是一片空白）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.0a · AI 面板开场引导', async () => {
    await suite.it('⑩ 打开就有引导 + 按当前库现算的示例问法；点了填输入框、不自动发；首问后收起', async () => {
      sweep();
      H.resetAi();
      ctx().openAi();
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
      ok(modal, 'AI 面板开出来了');
      const log = H.q<HTMLElement>(modal as HTMLElement, '.kbw-ai-log');
      // 判据本体：打开时不是空白（截图 09-ai 里那 220px 的空洞）
      ok(log.children.length >= 1, `开场不该是空白（.kbw-ai-log 现有 ${log.children.length} 个子节点）`);
      const exs = H.qa<HTMLElement>(log, '.kbw-ai-ex');
      ok(exs.length >= 2, `示例问法 ≥2 条（实际 ${exs.length}）`);

      // **按当前库现算**：00_Inbox 有笔记时，示例里该出现它的篇数（写死的例句做不到）
      const inboxN = ctx()
        .index.notes()
        .filter((e) => e.effectivePosition === '00_Inbox').length;
      if (inboxN > 0) {
        ok(
          exs.some((e) => H.textOf(e).includes(String(inboxN))),
          `示例要按当前库现算（00_Inbox 此刻 ${inboxN} 篇）：${exs.map((e) => H.textOf(e)).join(' | ')}`,
        );
      }

      // 点了**只填进输入框**、不自动发（发不发是用户的事）
      const input = H.q<HTMLTextAreaElement>(modal as HTMLElement, '.kbw-ai-input');
      H.click(exs[0]);
      await H.settle(30);
      eq(input.value, H.textOf(exs[0]), '点示例 = 填进输入框');
      eq(H.qa(log, '.kbw-ai-bubble.is-me').length, 0, '不自动发（没有用户气泡）');
      eq(H.qa(log, '.kbw-ai-step').length, 0, '也没有真的在问模型（没有步骤行）');

      // 首问之后开场引导收起（它只属于"开场"，别一直占着聊天区）
      H.stubAi({ reply: '收到', ideas: [] });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      H.click(H.q<HTMLElement>(modal as HTMLElement, '.kbw-ai-send .kbw-btn'));
      await H.settle(80);
      eq(H.qa(log, '.kbw-ai-intro').length, 0, '问出去之后开场引导收起');

      sweep();
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.3b · agent：工具循环 · 三档权限 · 参数净化（17.10①）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3b · agent 工具循环与权限', async () => {
    /** 「这一轮画完了」的信号数（与 §C 组同一口径；这组自己起头，就不依赖那边的闭包了） */
    const opsOf = (modal: HTMLElement): number =>
      modal.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length +
      modal.querySelectorAll('.kbw-ai-log .kbw-ai-bubble.is-error').length;
    function runPending(modal: HTMLElement): void {
      H.click(H.q<HTMLElement>(modal, '.kbw-ai-acts .kbw-btn.is-primary'));
    }
    async function waitTurnEnd(modal: HTMLElement, before: number): Promise<void> {
      await H.until(() => opsOf(modal) > before, 4000);
      await H.settle(80);
    }

    // ── 纯函数那一半 ─────────────────────────────────────────
    await suite.it('`validateCall`：不认识的字段丢掉（模型塞 force / confirmed 不算数）', () => {
      const r = validateCall({
        tool: 'move',
        args: { path: '00_Inbox/a.md', to: '01_Projects', force: true, confirmed: true },
      });
      ok(r.ok, '合法调用过校验');
      if (r.ok) {
        eq(
          Object.keys(r.call.args).sort().join(','),
          'path,to,why',
          '只留下认识的字段（force / confirmed 在门口就没了）',
        );
      }
    });

    await suite.it('`validateCall`：绝对路径 / `..` / 不认识的工具 / 形状不对 → 拒', () => {
      eq(validateCall({ tool: 'move', args: { path: '/etc/passwd', to: '01_Projects' } }).ok, false, '绝对路径拒');
      eq(validateCall({ tool: 'read', args: { path: '../外.md' } }).ok, false, '跳出库的路径拒');
      eq(validateCall({ tool: 'rm_rf', args: {} }).ok, false, '不认识的工具拒');
      eq(validateCall({ tool: 'search', args: {} }).ok, false, 'search 两样都空 → 拒');
      eq(validateCall({ tool: 'set_prop', args: { path: 'a.md', key: '状态', value: {} } }).ok, false, 'value 只能标量或 null');
      eq(validateCall({ tool: 'set_tags', args: { path: 'a.md' } }).ok, false, 'set_tags 两边都没给 → 拒');
    });

    await suite.it('`effectiveTier`：默认表 · 显式配置优先（P7.5 起没有第三句）', () => {
      eq(effectiveTier('read', {}), 'auto', '读默认自动');
      eq(effectiveTier('move', {}), 'confirm', '搬默认需确认');
      eq(effectiveTier('move', { toolTiers: { move: 'auto' } }), 'auto', '写类显式设「自动」→ auto（自动弹确认）');
      eq(effectiveTier('delete', {}), 'confirm', '删默认需确认（G4-C3）');
      eq(
        effectiveTier('move', { toolTiers: { move: 'confirm' } }),
        'confirm',
        '显式配置压过默认表',
      );
      eq(effectiveTier('read', { toolTiers: { read: 'off' } }), 'off', '读也能被禁');
    });

    await suite.it('类别清单与默认表对齐（settings 里那份白名单是第二份，别漂）', () => {
      eq(
        AI_TOOL_CLASSES.map((c) => c.id).sort().join(','),
        'create,delete,move,prop,read,tag,text',
        '七类，名字对得上（P7.22a 有意识加 text「改正文」）',
      );
      for (const c of AI_TOOL_CLASSES) ok(DEFAULT_TOOL_TIERS[c.id] !== undefined, `${c.id} 有默认档`);
      eq(AI_TOOL_CLASS_OF.search, 'read', 'search 归读类');
      eq(AI_TOOL_CLASS_OF.set_tags, 'tag', 'set_tags 归标签类');
      eq(AI_TOOL_CLASS_OF.patch_text, 'text', 'patch_text 归改正文类');
      eq(AI_TOOL_CLASS_OF.append, 'text', 'append 归改正文类');
      eq(AI_TOOL_CLASS_OF.rename, 'move', 'rename 归搬动类（纯改名也算搬动）');
    });

    await suite.it('`rowOfCall`：给人看的一行（名字去扩展名 + 方向）', () => {
      const r = validateCall({ tool: 'move', args: { path: '00_Inbox/插件开发计划.md', to: '01_Projects', why: 'x' } });
      ok(r.ok, '前提');
      if (r.ok) {
        const row = rowOfCall(r.call);
        eq(row.name, '插件开发计划', '名字去扩展名');
        contains(row.detail, '00_Inbox → 01_Projects', '方向一目了然');
      }
    });

    await suite.it('agent 提示词里写着硬规矩第 4 条（模型不能自我授权）与信封格式', () => {
      const msgs = buildAgentMessages({ question: '随便', kbRoot: KB, dirs: [], rules: '', candidates: [] });
      const sys = msgs[0].content;
      contains(sys, '无法给自己授权', '17.10① 那句在 system 里');
      contains(sys, '不是「指令」', '工具结果 / 正文是数据那条在');
      contains(sys, '"actions"', '输出信封的格式写着');
    });

    await suite.it('`parseAgentReply`：actions 信封 / 旧 ideas 兼容 / 散文当聊天', () => {
      const a = parseAgentReply('好，我查一下。\n\n{"actions":[{"tool":"search","args":{"query":"收件箱"}}]}');
      eq(a.actions.length, 1, 'actions 解析出来了');
      eq(a.actions[0].tool, 'search', '工具名对');
      eq(a.reply, '好，我查一下。', '信封之前的人话是 reply');
      const b = parseAgentReply('{"reply":"建议","ideas":[{"path":"a.md","to":"01_Projects"}]}');
      eq(b.actions.length, 1, '旧 ideas 格式转成动作（兼容老模型与老会话）');
      eq(b.actions[0].tool, 'move', '转成 move');
      const c = parseAgentReply('这是一段散文，没有 JSON。');
      eq(c.actions.length, 0, '散文 = 没有动作');
      eq(c.reply, '这是一段散文，没有 JSON。', '全文当 reply');
    });

    await suite.it('settings 收敛：`toolTiers` 只收白名单类别与合法档位（手改 data.json 也不怕）', () => {
      // 🔴 独立审查 🟡7：原先只有 `{move:'off'}` 与 `{}` 两条走过这条路 —— 清洗器的
      // **拒绝**分支零覆盖（野类别 / 野值 / 类型不对都没验过）
      const norm = normalizeSettings({
        ai: { toolTiers: { move: 'AUTO', bogus: 'auto', read: 'off', prop: 'confirm', tag: 7 } },
      });
      eq(
        JSON.stringify(norm.ai.toolTiers ?? {}),
        JSON.stringify({ read: 'off', prop: 'confirm' }),
        '野类别 / 野档位 / 类型不对的全丢，合法的留下',
      );
      const empty = normalizeSettings({ ai: { toolTiers: 'off' } });
      eq(JSON.stringify(empty.ai.toolTiers ?? {}), '{}', '整个 toolTiers 类型不对 → 空表（不炸）');
    });

    // ── 真链路那一半（面板 → 循环 → 端口 → 确认流 → mover）────────
    /** 造一篇可控夹具（口径同 §C 的 `fixture`：造文件 → rescan → 重建索引） */
    async function mk(rel: string): Promise<{ rel: string; abs: string }> {
      H.writeNote(vaultRoot, `${KB}/${rel}`, '---\n类型: 想法\n---\n\n正文\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      return { rel, abs: `${KB}/${rel}` };
    }

    await suite.it('工具循环：同一批里搜索 + 搬运（步骤行先于卡片 · 结果按原序喂回模型）', async () => {
      const f = await mk('00_Inbox/__探针AI循环.md');
      sweep();
      H.resetAi();
      /**
       * ⚠️ **搜索与搬运放同一批**（独立审查 🟡5）：这样"卡片出现时搜索的步骤行已经在屏上"
       * 才是一条**真**判据 —— 把端口的回调改成"整批 await 完才报"，这一条当场红
       *（搜索在上一批的话，那种突变照样绿）。
       */
      const stub = H.stubAiSeq([
        {
          reply: '我先搜一下，再搬它。',
          actions: [
            { tool: 'search', args: { dir: '00_Inbox' } },
            { tool: 'move', args: { path: '00_Inbox/__探针AI循环.md', to: '01_Projects', why: 'x' } },
          ],
        },
        { reply: '搬好了。' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '整理一下收件箱';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      contains(H.textOf(panel), '命中', '搜索那一步的结果已经画成步骤行（同一批里，先于待确认卡）');
      eq(H.qa(panel, '.kbw-ai-plan .kbw-ai-row').length, 1, '搬运停在待确认卡里');
      runPending(panel);
      await H.settle(40);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-modal').pop()?.querySelector('.kbw-modal-foot .kbw-btn.is-primary') as Element);
      await H.settle(140);
      await H.until(
        () =>
          panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > 0,
        4000,
      );
      const steps = H.qa<HTMLElement>(panel, '.kbw-ai-step');
      eq(steps.length, 2, `两步都有记录（实际：${steps.map((s) => H.textOf(s)).join(' | ')}）`);
      ok(steps.some((s) => H.textOf(s).includes('已移动')), '搬运那一步写着结果');
      eq(stub.calls.length, 2, '两次模型调用（一批动作 → 收尾）');
      const sent2 = JSON.parse(String(stub.calls[1].body ?? '{}')) as {
        messages: { role: string; content: string }[];
      };
      const fed = sent2.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      contains(fed, '工具结果', '第二次调用把工具结果喂回去了');
      contains(fed, '命中', '结果里有"搜到了什么"');
      // 🔴 结果**按模型提出的原序**编号（独立审查 🟢10：乱序会让它对错行）
      ok(fed.indexOf('search') >= 0 && fed.indexOf('search') < fed.indexOf('move'), '搜索结果排在搬运结果之前（原序）');
      ok(
        !H.exists(vaultRoot, f.abs) && H.exists(vaultRoot, `${KB}/01_Projects/__探针AI循环.md`),
        '文件真的搬过去了',
      );
      sweep();
      H.resetAi();
    });

    await suite.it('🔴 「禁」档：模型提了也执行不了（这是用户的选择，不是模型能翻的）', async () => {
      const f = await mk('00_Inbox/__探针AI禁.md');
      sweep();
      H.resetAi();
      H.stubAiSeq([
        { reply: '我要搬它。', actions: [{ tool: 'move', args: { path: '00_Inbox/__探针AI禁.md', to: '01_Projects' } }] },
        { reply: '那就算了。' },
      ]);
      await H.configAi(plugin);
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: { move: 'off' } } });
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '搬一下';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      contains(H.textOf(panel), '被设置禁用', '被禁的要说出来');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '不弹确认框（禁了就是禁了）');
      ok(H.exists(vaultRoot, f.abs), '🔴 文件一字节没动');
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: {} } });
      sweep();
      H.resetAi();
    });

    await suite.it('🔴 17.10①：删除参数里塞 force / confirmed 也不算授权 —— 照样停在待确认卡', async () => {
      const f = await mk('00_Inbox/__探针AI权.md');
      sweep();
      H.resetAi();
      H.stubAiSeq([
        {
          reply: '删掉它。',
          actions: [{ tool: 'delete', args: { path: '00_Inbox/__探针AI权.md', force: true, confirmed: true } }],
        },
        { reply: '好。' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '把这篇删了';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      eq(H.qa(panel, '.kbw-ai-plan .kbw-ai-row').length, 1, '停在待确认卡（"授权"二字没让它跳过去）');
      ok(H.exists(vaultRoot, f.abs), '🔴 还没执行，文件在');
      contains(H.textOf(panel), '删除到回收站', '那一行如实写着要干什么');
      const skip = H.qa<HTMLElement>(panel, '.kbw-ai-acts .kbw-btn').find((x) => H.textOf(x).includes('跳过'));
      ok(skip, '找得到「跳过」');
      H.click(skip as Element);
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      ok(H.exists(vaultRoot, f.abs), '🔴 跳过之后文件还在（自授权一个字都没算数）');
      sweep();
      H.resetAi();
    });

    /**
     * 🔴 **执行体四条工具的端到端判据**（独立审查 🟡4：此前只有 search + move 走到底，
     * create / set_prop / set_tags / delete 的执行体是"突变全绿"的 —— 尤其 delete
     * 那条能"报成功但没删"（与 B🔴6 同形的危险方向静默失效））。
     */
    await suite.it('create + set_prop + set_tags 走完整条链：落对目录、前言真的改了（含"减"标签）', async () => {
      const rel = '00_Inbox/__探针AI改.md';
      const abs = `${KB}/${rel}`;
      H.writeNote(vaultRoot, abs, '---\n类型: 想法\ntags:\n  - 旧标签\n  - 留着\n---\n\n正文\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      sweep();
      H.resetAi();
      H.stubAiSeq([
        {
          reply: '建一篇、再改两个地方。',
          actions: [
            { tool: 'create', args: { dir: '00_Inbox', title: '__探针AI新建', body: '新正文' } },
            { tool: 'set_prop', args: { path: rel, key: '状态', value: '进行中' } },
            { tool: 'set_tags', args: { path: rel, add: ['新标签'], remove: ['旧标签'] } },
          ],
        },
        { reply: '好了' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const n0 = opsOf(panel);
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '建一篇，再改两处';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      eq(H.qa(panel, '.kbw-ai-plan .kbw-ai-row').length, 3, '三行都在卡里（新建 + 改属性 + 改标签）');
      runPending(panel);
      await H.settle(40);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-modal')
          .pop()
          ?.querySelector('.kbw-modal-foot .kbw-btn.is-primary') as Element,
      );
      await H.settle(160);
      await waitTurnEnd(panel, n0);

      // ① create：**落在点名的目录里**（突变 dirRel→dirRell 会在这红：那会落到库根）
      ok(H.exists(vaultRoot, `${KB}/00_Inbox/__探针AI新建.md`), '新建的笔记落在 00_Inbox');
      ok(!H.exists(vaultRoot, `${KB}/__探针AI新建.md`), '没落到库根去');
      contains(H.readNote(vaultRoot, `${KB}/00_Inbox/__探针AI新建.md`), '新正文', '正文一次落盘');
      // ② set_prop：前言真改了
      const after = H.readNote(vaultRoot, abs);
      contains(after, '状态: 进行中', '属性真的写进去了');
      // ③ set_tags：加一减一都对（突变"去掉 remove 过滤"会在这红）
      contains(after, '新标签', '新标签加上了');
      contains(after, '留着', '没动别的标签');
      notContains(after, '旧标签', '要减的标签真的减掉了');

      fs.rmSync(path.join(vaultRoot, `${KB}/00_Inbox/__探针AI新建.md`), { force: true });
      fs.rmSync(path.join(vaultRoot, abs), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      sweep();
      H.resetAi();
    });

    /**
     * ⑦a（P7.9 · 用户真机反馈的缺陷回归）：**同一批「搬 + 改属性」** ——
     * 旧次序（搬先跑）下改属性会拿着**旧路径**去找，文件已被搬走 → "执行时已经找不到"；
     * 新次序（属性先跑）两件都成功，且 P5 起搬完给没声明的补「文件位置」。
     */
    await suite.it('⑦a 回归：同批「搬 + 改属性」都成功（属性先跑，再搬 —— 顺序反了当场红）', async () => {
      const rel = '00_Inbox/__p79搬改.md';
      const abs = `${KB}/${rel}`;
      const dst = `${KB}/02_Areas/内容创作/__p79搬改.md`;
      H.writeNote(vaultRoot, abs, '---\n类型: 想法\n状态: 草稿\n---\n\n正文\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      sweep();
      H.resetAi();
      H.stubAiSeq([
        {
          reply: '改个状态，再把它搬去内容创作。',
          actions: [
            { tool: 'move', args: { path: rel, to: '02_Areas/内容创作' } },
            { tool: 'set_prop', args: { path: rel, key: '状态', value: '进行中' } },
          ],
        },
        { reply: '好了' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const n0 = opsOf(panel);
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '改状态并搬走';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      eq(H.qa(panel, '.kbw-ai-plan .kbw-ai-row').length, 2, '两行都在卡里（搬 + 改属性）');
      runPending(panel);
      await H.settle(40);
      const cfm = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      // P5 拍板：确认卡要写明"会给没声明的补上位置声明"
      contains(H.textOf(cfm), '没声明', '确认卡写明会给没声明的补声明（P5）');
      H.click(H.q<HTMLElement>(cfm, '.kbw-modal-foot .kbw-btn.is-primary'));
      await H.settle(160);
      await waitTurnEnd(panel, n0);

      // 搬到位（成对判：新有旧无）
      ok(H.exists(vaultRoot, dst), '真搬到了 02_Areas/内容创作');
      ok(!H.exists(vaultRoot, abs), '老位置没了');
      const after = H.readNote(vaultRoot, dst);
      // 🔴 次序 bug 的核心断言：属性改的是**搬之前**的那份文件 —— 两件都要成功
      contains(after, '状态: 进行中', '属性真的改了（"文件在改属性之前就被搬走了"不再发生）');
      contains(after, '文件位置', 'P5：搬完给没声明的补了「文件位置」');
      contains(after, '02_Areas/内容创作', '补的声明指向新位置');
      fs.rmSync(path.join(vaultRoot, dst), { force: true });
      fs.rmSync(path.join(vaultRoot, abs), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      sweep();
      H.resetAi();
    });

    await suite.it('🔴 delete 走完整条链：危险两段确认 → 真删 + 撤销条 + 快照能还原', async () => {
      const f = await mk('00_Inbox/__探针AI删.md');
      sweep();
      H.resetAi();
      H.stubAiSeq([
        { reply: '删掉它。', actions: [{ tool: 'delete', args: { path: '00_Inbox/__探针AI删.md' } }] },
        { reply: '删了' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const n0 = opsOf(panel);
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '删掉那篇';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      eq(H.qa(panel, '.kbw-ai-plan .kbw-ai-row').length, 1, '停在待确认卡');
      runPending(panel);
      await H.settle(40);
      const cfm = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      contains(H.textOf(cfm), '即将删除 1 篇笔记', '确认流是危险态（删独立成句）');
      const primary = H.q<HTMLElement>(cfm, '.kbw-modal-foot .kbw-btn.is-danger');
      ok(primary, '主按钮是危险色');
      H.click(primary);
      await H.settle(40);
      contains(H.textOf(primary), '再点一次确认', '第一下只是上膛（危险两段）');
      H.click(primary);
      await H.settle(200);
      await waitTurnEnd(panel, n0);
      // 🔴 突变"不调 mover.trash、直接报成功"会在这红
      ok(!H.exists(vaultRoot, f.abs), '文件真的删掉了');
      ok(hasUndoBar(), '撤销条在（删除也给了回头路）');
      const undo = H.currentUndoButton('撤销');
      ok(undo, '撤销条上找得到「撤销」');
      H.click(undo as Element);
      const back = await H.until(() => H.exists(vaultRoot, f.abs), 2000, 25);
      ok(back, '撤销之后文件回来了（快照能还原这次删除）');
      sweep();
      H.resetAi();
    });

    await suite.it('🔴 混档批次：点「跳过」不许说"什么都没改"（自动档的动作还在确认框里等你点）', async () => {
      /**
       * 独立审查 🟡1 的原始复现：一步里同时提 delete（需确认）与 move（自动档，
       * P7.5 起用逐类 `toolTiers: { move: 'auto' }` 复现 —— 旧 allowWrite 已退役）——
       * 卡片只显示 delete 那一行，点「跳过」若还写"什么都没改"就是撒谎：
       * 自动档的搬运紧接着会弹确认框，用户点了确认，库就变了。
       */
      const a = await mk('00_Inbox/__探针AI混甲.md');
      const b = await mk('00_Inbox/__探针AI混乙.md');
      H.stubAiSeq([
        {
          reply: '删一篇、搬一篇。',
          actions: [
            { tool: 'delete', args: { path: '00_Inbox/__探针AI混甲.md' } },
            { tool: 'move', args: { path: '00_Inbox/__探针AI混乙.md', to: '01_Projects' } },
          ],
        },
        { reply: '好' },
      ]);
      await H.configAi(plugin);
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: { move: 'auto' } } });
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const n0 = opsOf(panel);
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '删一篇搬一篇';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      eq(H.qa(panel, '.kbw-ai-plan .kbw-ai-row').length, 1, '卡片只有 delete 那一行（move 是自动档）');
      const skip = H.qa<HTMLElement>(panel, '.kbw-ai-acts .kbw-btn').find((x) => H.textOf(x).includes('跳过'));
      ok(skip, '找得到「跳过」');
      H.click(skip as Element);
      // 跳过之后，自动档的搬运紧接着弹确认框（这就是"自动弹确认框"的语义）
      await H.until(() => H.qa(document.body, '.kbw-modal').length >= 2, 2000);
      await H.settle(40);
      const panelText = H.textOf(panel);
      contains(panelText, '已跳过', '跳过的说明在');
      notContains(panelText, '什么都没改', '🔴 混档时不许写"什么都没改"（自动档的还在确认框里）');
      const cfm = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const cancel = H.qa<HTMLElement>(cfm, '.kbw-modal-foot .kbw-btn').find((x) => H.textOf(x).includes('取消'));
      ok(cancel, '自动档那条弹了确认框（前提）');
      H.click(cancel as Element);
      await H.settle(60);
      await waitTurnEnd(panel, n0);
      ok(H.exists(vaultRoot, a.abs) && H.exists(vaultRoot, b.abs), '跳过 + 取消之后两篇都还在原位');
      ok(!H.exists(vaultRoot, `${KB}/01_Projects/__探针AI混乙.md`), '也没被搬走');
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: {} } });
      sweep();
      H.resetAi();
    });

    await suite.it('🔴 执行过动作之后这一轮出错：半截也进会话（独立审查 🟡2：库变了、会话里不能没记录）', async () => {
      const f = await mk('00_Inbox/__探针AI半截.md');
      sweep();
      H.resetAi();
      /** 第一步提 move；第二步**服务端 500** —— 崩在这一轮中间 */
      H.stubAiSeq([
        { reply: '搬它。', actions: [{ tool: 'move', args: { path: '00_Inbox/__探针AI半截.md', to: '01_Projects' } }] },
        { raw: '{"error":{"message":"boom"}}', status: 500 },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const n0 = opsOf(panel);
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '搬一下再出错';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-acts') !== null, 4000);
      await H.settle(80);
      runPending(panel);
      await H.settle(40);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-modal')
          .pop()
          ?.querySelector('.kbw-modal-foot .kbw-btn.is-primary') as Element,
      );
      await H.settle(160);
      await waitTurnEnd(panel, n0);

      ok(!H.exists(vaultRoot, f.abs), '文件真的搬了（前提：库确实变了）');
      contains(H.textOf(panel), '已移动', '执行过的那一步留在气泡里');
      contains(H.textOf(panel), '没跑完', '如实写了没跑完的原因');
      ok(opsOf(panel) > n0, '这一轮**封了口**（有 ops 行 —— 能被重试/复制/引用）');

      // 会话层面：等 persist 落盘 → 重开面板 → 恢复块里该有这一轮（修前这里什么都没有）
      await H.settle(240);
      sweep();
      ctx().openAi();
      const back = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      await H.until(() => back.querySelector('.kbw-ai-hist') !== null, 2000);
      await H.settle(120);
      const hist = back.querySelector('.kbw-ai-hist') as HTMLElement | null;
      ok(hist, '重开之后恢复块在');
      contains(H.textOf(hist), '搬一下再出错', '🔴 半截那一轮真的进了会话（修前：库变了、会话里没有它）');
      contains(H.textOf(hist), '已移动', '动作记录也在会话里（重试/上下文都带得上）');
      sweep();
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.12 · R8 · 美化笔记（纯函数 + 服务层；真链路在 p6d 组里走菜单）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.12 · R8 美化笔记（纯函数 + 服务层）', async () => {
    await suite.it('diffLines：行级对齐（增/删/同）+ 摘要；同一对输入永远同一份输出', () => {
      const d = diffLines('甲\n乙\n丙', '甲\n乙改\n丙\n丁');
      eq(d.map((l) => l.kind).join(','), 'same,del,add,same,add', '乙 → 乙改 是 del+add；尾部多了 丁');
      eq(d.filter((l) => l.kind === 'same').length, 2, '两行原样对上（丙 也对上）');
      eq(diffSummary(d).added, 2, '新增两行');
      eq(diffSummary(d).removed, 1, '删除一行');
      eq(diffLines('x\ny', 'x\ny').every((l) => l.kind === 'same'), true, '无改动 → 全 same');
      eq(
        JSON.stringify(diffLines('甲\n乙', '甲\n\n乙')),
        JSON.stringify(diffLines('甲\n乙', '甲\n\n乙')),
        '确定性：同一对输入同一份输出（重跑不漂）',
      );
      ok(
        diffLines('甲\n乙', '甲\n\n乙').some((l) => l.kind === 'add' && l.text === ''),
        '"改了个空行"也是改动（空行不吞）',
      );
    });

    await suite.it('parseBeautify：整段围栏剥掉、空稿抛错（绝不拿空稿替换正文）', () => {
      eq(parseBeautify('  正文甲\n正文乙  ').body, '正文甲\n正文乙', '首尾空白修掉');
      eq(parseBeautify('```md\n# 标题\n正文\n```').body, '# 标题\n正文', '整段围栏剥掉（模型手痒的常见形态）');
      eq(parseBeautify('# 标题\n\n正文').body, '# 标题\n\n正文', '没包围栏的不动');
      /**
       * ⚠️ 独立审 A2（P7.12 收尾）：正文**自己**以围栏代码块开头/结尾时（```js 首尾夹
       * 正文），旧判据 `^```[a-zA-Z]*…$` 会把正文自己的第一/最后一个围栏剥掉 ——
       * 第一个代码块降级成散文、后续围栏就地错位。判据收紧到 markdown 系标记后：
       * 语言标记一律**不剥**（宁可不剥，也不误剥）。
       */
      const fenced = '```js\nconst a = 1;\n```\n\n中间正文\n\n```js\nconst b = 2;\n```';
      eq(parseBeautify(fenced).body, fenced, '```js 开头结尾的正文：原样保留（不许误剥）');
      const bare = '```\n纯文本围栏里的话\n```';
      eq(parseBeautify(bare).body, bare, '裸 ``` 不剥（与"整篇就一个代码块"的笔记不可区分，宁可不剥）');
      eq(
        parseBeautify(`\`\`\`markdown\n${fenced}\n\`\`\``).body,
        fenced,
        '```markdown 包装照剥：剥完正是正文本身（含它自己的 ```js 围栏）',
      );
      let threw = false;
      try {
        parseBeautify('   ');
      } catch (e) {
        threw = e instanceof AiParseError;
      }
      ok(threw, '空稿 → AiParseError（服务层与界面都不会去替换）');
    });

    await suite.it('buildBeautifyMessages：正文原样进材料；硬规矩（双链原样 / 零编造）写在 system 里', () => {
      const msgs = buildBeautifyMessages({
        kbRoot: '01_新知识库',
        rel: '00_Inbox/x.md',
        title: 'x',
        body: '# 标题\n[[双链]]',
      });
      eq(msgs.length, 2, 'system + user 两条');
      contains(msgs[0].content, '双链', 'system 写着"链接原样保留"');
      contains(msgs[0].content, '不要添加任何新信息', 'system 写着"零编造"');
      contains(msgs[1].content, '# 标题\n[[双链]]', '正文原样在 user 里（前言根本不进提示词）');
      eq(msgs[1].content.includes('---'), false, '提示词里没有前言分隔线（它够不着前言）');
    });

    await suite.it('服务层 beautify：正常出稿 · 空正文拒绝 · 超长拒绝（**绝不截断**、也绝不发请求）', async () => {
      sweep();
      H.resetAi();
      const stub = H.stubAi({ raw: '美化后的正文\n第二行' });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      /** ⚠️ 服务层收的是**相对库根**的 rel（它自己 joinPath(库根)）—— 别带 KB 前缀 */
      const relOk = '00_Inbox/__r8美.md';
      const relEmpty = '00_Inbox/__r8空.md';
      const relLong = '00_Inbox/__r8长.md';
      H.writeNote(vaultRoot, `${KB}/${relOk}`, '---\n类型: 笔记\n---\n\n# 甲\n\n正文一\n');
      H.writeNote(vaultRoot, `${KB}/${relEmpty}`, '---\n类型: 笔记\n---\n\n   \n');
      H.writeNote(
        vaultRoot,
        `${KB}/${relLong}`,
        `---\n类型: 笔记\n---\n\n${'甲'.repeat(AI_LIMITS.beautifyChars + 20)}`,
      );
      app.vault.rescan();
      await H.settleIndex(app);
      ctx().index.rebuild();
      await H.settleIndex(app);
      try {
        const res = await ctx().ai.beautify({ rel: relOk });
        eq(res.body, '美化后的正文\n第二行', '正常出稿（照单全收）');
        eq(stub.calls.length, 1, '只发了一次请求');

        let e1 = '';
        try {
          await ctx().ai.beautify({ rel: relEmpty });
        } catch (e) {
          e1 = e instanceof Error ? e.message : String(e);
        }
        contains(e1, '没有正文', '空正文 → 本地拒绝');

        let e2 = '';
        try {
          await ctx().ai.beautify({ rel: relLong });
        } catch (e) {
          e2 = e instanceof Error ? e.message : String(e);
        }
        /** 前置自证：三个夹具文件真的都写进去了（别让"拒绝"红成"找不到文件"） */
        ok(H.exists(vaultRoot, `${KB}/${relLong}`), '前置：超长那篇在盘上');
        contains(e2, '超过美化上限', '超长 → 拒绝（整篇替换的截断 = 数据丢失）');
        eq(stub.calls.length, 1, '两条拒绝都在**发请求之前**拦下（模型没见过它们）');
      } finally {
        for (const p of [relOk, relEmpty, relLong]) {
          const abs = `${KB}/${p}`;
          if (H.exists(vaultRoot, abs)) fs.rmSync(path.join(vaultRoot, abs), { force: true });
        }
        app.vault.rescan();
        await H.settleIndex(app);
        ctx().index.rebuild();
        await H.settleIndex(app);
        await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
        H.resetAi();
      }
    });
  });

  sweep();
}
