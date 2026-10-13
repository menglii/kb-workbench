/**
 * spec：**P7.21 · AI 地基**（2026-10-11）—— 离线能验的那一半
 *
 * 本轮 #1「任务注册表 + 统一 runner」的两条判据（开工提示词 §1 给的草案原样落）：
 *   ① **注册表驱动的"任取两任务"**：skill 进 system · workDir 收候选 · 成本脚注（`usage`）都生效
 *      ——这里**任取 `classify` 与 `locus`** 两条管线（材料形状不同：一条按 scope 分诊、
 *      一条给缺声明的笔记挑落点；别的任务走的是同一条 runner，见静态判据）；
 *   ② **"新任务 = 一条数据"的自证**：临时造一行假任务（`__selftest`），走 `runAiTask` 跑通
 *      ——连横切输入都是 runner 自动递的（那行假任务的 build 一个字没写 skill/workDir）。
 *
 * ⚠️ 会话 kind / 面板行为那些**真机才验得了的**在 `scripts/probe.mjs`（探针步）。
 * 🔴 离线绝不联网：传输层全走 `H.stubAi`（桩的 `requestUrl` 默认抛）。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { writeFileSync, mkdirSync } from 'fs';
import { join as joinFs } from 'path';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import {
  AI_AGENT_LIMITS,
  AI_TASKS,
  AI_TASK_LIST,
  AI_TOOL_NAMES,
  inWorkDir,
  parseSkill,
  runAiTask,
  taskById,
  validateCall,
  type AiCrossInput,
  type AiSkill,
  type AiTaskDef,
  type AiToolOutcome,
} from '../../src/services/ai';
import { makeAiToolPort } from '../../src/ui/ai-tools';

const KB = '01_新知识库';

export async function specP721(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 造一篇笔记（本轮的 `__p721*` 夹具；这个库是本 spec 专用，不跨组共享关键状态） */
  async function mk(rel: string, text: string): Promise<string> {
    H.writeNote(vaultRoot, `${KB}/${rel}`, text);
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app);
    return rel;
  }

  /** 发给模型的第一条请求（`{messages:[…]}` 形状）—— 判据看"材料真的有什么" */
  function firstRequestBody(calls: { body?: string }[]): { system: string; user: string } {
    const body = JSON.parse(String(calls[0]?.body ?? '{}')) as {
      messages?: { role: string; content: string }[];
    };
    return { system: body.messages?.[0]?.content ?? '', user: body.messages?.[1]?.content ?? '' };
  }

  // ════════════════════════════════════════════════════════════
  // §A · 注册表本身（静态面）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21 · #1 任务注册表（一行一条任务）', async () => {
    await suite.it('表里十行（九条管线含 ask ＋ agent）· id 唯一 · 字段齐全', () => {
      const rows = AI_TASK_LIST;
      eq(rows.length, 10, `表里十行（实际 ${rows.length}）`);
      const ids = rows.map((r) => r.id).sort();
      eq(
        ids.join(','),
        ['agent', 'ask', 'beautify', 'classify', 'fix-fm', 'links', 'locus', 'moc', 'review', 'titles'].sort().join(','),
        'id 名单（改名单 = 改契约）',
      );
      eq(new Set(ids).size, ids.length, 'id 不许重');
      for (const r of rows) {
        ok(r.label.trim() !== '', `${r.id}：人话名不许空`);
        ok(r.entry.trim() !== '', `${r.id}：入口不许空（文档与自证认它）`);
        ok(['chat', 'advice', 'agent'].includes(r.kind), `${r.id}：kind 三值之一（实际 ${r.kind}）`);
        eq(typeof r.build, 'function', `${r.id}：build 是函数（提示词构建，住 prompt.ts）`);
        eq(typeof r.parse, 'function', `${r.id}：parse 是函数（输出解析，住 prompt.ts）`);
      }
    });

    await suite.it('工具面：只有 agent 行非 null，且 = 全工具表（别抄第二份名单）', () => {
      eq(AI_TASKS.agent.tools?.join(','), AI_TOOL_NAMES.join(','), 'agent 的工具面 = AI_TOOL_NAMES（同一份）');
      for (const r of AI_TASK_LIST) {
        if (r.id === 'agent') continue;
        eq(r.tools, null, `${r.id}：管线不碰工具（tools === null）`);
      }
    });

    await suite.it('taskById：认得的取得到同一行 · 不认得给 null（别把拼错的 id 静默当成存在）', () => {
      eq(taskById('titles'), AI_TASKS.titles, '认得的取回同一行');
      eq(taskById('fix-fm'), AI_TASKS['fix-fm'], '带连字符的 id 照取');
      eq(taskById('nope'), null, '不认得 = null');
    });

    await suite.it('inWorkDir：不给 = 一切；给了只认本目录与子目录（不误伤同前缀兄弟）', () => {
      ok(inWorkDir('00_Inbox/a.md', undefined), '不限定 = 一切（老调用方一个字不变）');
      ok(inWorkDir('00_Inbox/a.md', ''), '空串同"不限定"');
      ok(inWorkDir('00_Inbox', '00_Inbox'), '目录自身算在下');
      ok(inWorkDir('00_Inbox/子/a.md', '00_Inbox'), '子目录算在下');
      ok(!inWorkDir('00_InboxX/a.md', '00_Inbox'), '同前缀的兄弟目录**不算**（别用 startsWith 裸拼）');
      ok(!inWorkDir('01_Projects/a.md', '00_Inbox'), '别的目录不算');
      ok(inWorkDir('00_Inbox/a.md', '/00_Inbox/'), '写法容错：首尾斜杠归一');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B · 判据①：任取两任务 —— skill / workDir / 成本脚注都生效
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21 · #1 判据①：任取两任务（classify / locus）', async () => {
    /**
     * 这一组共用的能力包（假件 —— P7.21b 起 `AiSkill` 还有 `params` / `workDir` / `examples`
     * 三个**必填**新字段：手写假件清单跟着类型走，编译器当场抓，别只在解析器那侧改）。
     */
    const skill: AiSkill = {
      path: '（假件）',
      name: '收件箱速理',
      triggers: [],
      tools: null,
      params: [],
      workDir: '',
      examples: [],
      instructions: '只做收件箱归位。',
    };

    await suite.it('任务 A（classify）：能力包进 system · 工作目录收候选 · usage 照出', async () => {
      H.resetAi();
      await H.configAi(plugin);
      await mk('00_Inbox/__p721a.md', '---\n类型: 想法\n---\n\n甲\n');
      await mk('01_Projects/__p721b.md', '---\n类型: 想法\n---\n\n乙\n');
      const calls = H.stubAi({ reply: '看过了', ideas: [] });
      const res = await ctx().ai.classify({ scopeRel: '', exclude: [], workDir: '00_Inbox', skill });
      ok(res.usage && res.usage.calls === 1, '成本脚注：usage 照出（runner 统一出的那一份）');
      const { system, user } = firstRequestBody(calls.calls);
      contains(system, '## 这一轮启用的能力包：收件箱速理', '能力包段落进 system（横切 · 没人漏得掉）');
      contains(system, '只做收件箱归位。', '能力包正文原样进 system');
      contains(system, '## 这次对话的工作目录：00_Inbox（相对库根）', '工作目录段落进 system');
      contains(user, '00_Inbox/__p721a.md', '范围内的候选在材料里');
      ok(!user.includes('01_Projects/__p721b.md'), '范围外的候选被收窄（不进材料）');
    });

    await suite.it('任务 B（locus）：同两样横切照常生效 · 产物只从范围内出来', async () => {
      H.resetAi();
      await H.configAi(plugin);
      // 材料与产物都要求这两篇在库里（上一组已造；这里保证顺序无关——再造一遍幂等）
      await mk('00_Inbox/__p721a.md', '---\n类型: 想法\n---\n\n甲\n');
      await mk('01_Projects/__p721b.md', '---\n类型: 想法\n---\n\n乙\n');
      const calls = H.stubAi({
        raw: JSON.stringify({
          reply: '给了',
          locus: [
            { path: '01_Projects/__p721b.md', to: '01_Projects' },
            { path: '00_Inbox/__p721a.md', to: '01_Projects' },
          ],
        }),
      });
      const res = await ctx().ai.proposeLocus({ workDir: '01_Projects', skill });
      ok(res.usage && res.usage.calls === 1, '成本脚注：usage 照出');
      ok(res.fed.includes('01_Projects/__p721b.md'), '范围内的笔记被喂了');
      ok(!res.fed.includes('00_Inbox/__p721a.md'), '范围外的笔记没被喂（收窄在服务层选材）');
      eq(res.items.length, 1, `产物只剩范围内那一条（实际 ${JSON.stringify(res.items)}）`);
      eq(res.items[0]?.rel, '01_Projects/__p721b.md', '就是范围内那一篇');
      const { system, user } = firstRequestBody(calls.calls);
      contains(system, '## 这一轮启用的能力包：收件箱速理', '能力包段落进 system');
      contains(system, '## 这次对话的工作目录：01_Projects（相对库根）', '工作目录段落进 system');
      contains(user, '01_Projects/__p721b.md', '材料里有范围内的笔记');
      ok(!user.includes('00_Inbox/__p721a.md'), '材料里没有范围外的笔记');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C · 判据②：新任务 = 一条数据（自证；不进产品）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21 · #1 判据②：新任务 = 一条数据（自证）', async () => {
    await suite.it('临时造一行假任务 → runAiTask 直接跑通，连横切都是它自动递的', async () => {
      interface FakeIn extends AiCrossInput {
        question: string;
      }
      const fake: AiTaskDef<FakeIn, { reply: string }> & { tools: null } = {
        id: '__selftest',
        label: '自证任务',
        kind: 'advice',
        entry: '（判据临时造 —— 不进产品）',
        tools: null,
        // 这行假任务的 build **一个字都没提 skill / workDir** —— 全靠 runner 递进来
        build: (input) => [
          {
            role: 'system',
            content: `自证 system｜能力包=${input.skill?.name ?? '无'}｜目录=${input.workDir ?? '无'}`,
          },
          { role: 'user', content: input.question },
        ],
        parse: (text) => ({ reply: text.trim() }),
      };
      const sent: string[] = [];
      const run = await runAiTask(
        fake,
        { question: '你好' },
        { skill: { name: '临时包', instructions: '只做一件事。', tools: null }, workDir: '00_Inbox' },
        {
          callModel: async (msgs) => {
            sent.push(msgs.map((m) => `${m.role}:${m.content}`).join('\n'));
            return { text: '好' };
          },
        },
      );
      eq(run.task, '__selftest', '结果带着这行的 id');
      eq(run.kind, 'advice', 'kind 回落行里的声明（解析产物没带 kind）');
      eq(run.parsed.reply, '好', 'parser 是行里那份（单轮：产物原样带回）');
      eq(run.usage.calls, 1, '成本脚注自动出（runner 统一算）');
      contains(sent[0] ?? '', '能力包=临时包', '**新行没写横切** —— runner 自动把 skill 递给它的 build');
      contains(sent[0] ?? '', '目录=00_Inbox', '工作目录同样自动覆盖新行');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §D · #2 只读工具族（list / stats）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21 · #2 只读工具族（list / stats）', async () => {
    /** 直接驱动执行体（只读工具不用走面板那一圈；`askPending` 给个永不会被读到的假件） */
    const port = (opts: { allowTools?: string[] | null; scopeDir?: string } = {}) =>
      makeAiToolPort({
        ctx: ctx(),
        askPending: async () => [],
        allowTools: (opts.allowTools ?? null) as never,
        scopeDir: opts.scopeDir,
      });
    const run = async (
      call: { tool: string; args: Record<string, unknown> },
      opts: { allowTools?: string[] | null; scopeDir?: string } = {},
    ): Promise<AiToolOutcome> => {
      const out = await port(opts).runBatch([{ tool: call.tool, args: call.args }], {});
      return out[0] as AiToolOutcome;
    };

    await suite.it('list 本层：篇数/子目录计数/本层笔记名（结果形状照着模型能用的来）', async () => {
      const out = await run({ tool: 'list', args: { dir: '00_Inbox' } });
      eq(out.ok, true, `要列得出来（实际：${out.summary}）`);
      contains(out.summary, '列了「00_Inbox」', 'summary 说清列的是哪层');
      const detail = String(out.detail ?? '');
      contains(detail, '目录（本层）', '目录段在');
      contains(detail, '本层笔记', '本层笔记段在');
      contains(detail, '__p721a', '刚造的夹具在本层笔记里（basename 不带扩展名）');
      ok(!/\.md\b/.test(detail.split('\n').filter((l) => l.startsWith('- __p721a'))[0] ?? 'x.md'), '笔记名不带 .md');
    });

    await suite.it('list 递归：每一层都带「本层 · 递归」两个计数', async () => {
      const out = await run({ tool: 'list', args: { dir: '', recursive: true } });
      eq(out.ok, true, '要列得出来');
      const detail = String(out.detail ?? '');
      contains(detail, '目录（递归）', '递归口径写清楚');
      const line = detail.split('\n').find((l) => l.includes('01_Projects/'));
      ok(line, `递归列表里有 01_Projects（实际：\n${detail.slice(0, 400)}）`);
      contains(String(line), '本层', '每行带本层计数');
      contains(String(line), '递归', '每行带递归计数');
    });

    await suite.it('list 不存在的目录：拒绝并说清（与"存在但是空"分得开 —— P7.0b 老账）', async () => {
      const out = await run({ tool: 'list', args: { dir: '00_Inbox/__p721没有这个目录' } });
      eq(out.ok, false, '不存在 = 拒绝');
      contains(out.summary, '库里没有', '如实说"没有这个目录"');
      // 而"存在但是空"照常能列（下面造一个空目录试试）
    });

    await suite.it('list 空目录照常能列（0 篇 ≠ 不存在）', async () => {
      mkdirSync(joinFs(vaultRoot, KB, '00_Inbox', '__p721空目录'), { recursive: true });
      app.vault.rescan();
      const out = await run({ tool: 'list', args: { dir: '00_Inbox/__p721空目录' } });
      eq(out.ok, true, '空目录照常列（不报错）');
      contains(out.summary, '本层 0 篇', '如实给 0');
    });

    await suite.it('list 截断：真截（列出条数 = 上限）+ 如实写"还有 N 个没列"', async () => {
      const dir = joinFs(vaultRoot, KB, '00_Inbox', '__p721多');
      for (let i = 0; i < AI_AGENT_LIMITS.listLines + 5; i += 1) {
        mkdirSync(joinFs(dir, `子${String(i).padStart(2, '0')}`), { recursive: true });
        writeFileSync(joinFs(dir, `子${String(i).padStart(2, '0')}`, 'x.md'), '---\n---\n\nx\n', 'utf8');
      }
      app.vault.rescan();
      const out = await run({ tool: 'list', args: { dir: '00_Inbox/__p721多' } });
      eq(out.ok, true, '列得出来');
      const detail = String(out.detail ?? '');
      contains(detail, '还有 5 个目录没列', '截断如实说');
      /**
       * 🔴 **真截才算数**（P7.21a 突变逮住的假绿：只断言"那句提示在"时，把
       * `shown.slice(0, listLines)` 摘掉照样绿 —— 提示语是照写不误的）。
       * 数**目录行**（`- …/ —— 本层`）的条数，它必须**恰好等于上限**。
       */
      const dirLines = detail.split('\n').filter((l) => l.startsWith('- ') && l.includes('—— 本层')).length;
      eq(dirLines, AI_AGENT_LIMITS.listLines, `列出的目录行数 = 上限（实际 ${dirLines}）`);
    });

    await suite.it('stats：篇数 / 最近改动 / 待处理（复用首页那一份规则）', async () => {
      const out = await run({ tool: 'stats', args: {} });
      eq(out.ok, true, '要出得来');
      contains(out.summary, '库概览', 'summary 是库概览');
      contains(out.summary, '篇数', '篇数在');
      const detail = String(out.detail ?? '');
      contains(detail, '最近改动', '最近改动段在');
      contains(detail, '待处理', '待处理段在（与首页同一个 computeTodoItems）');
      contains(detail, '__p721', '最近改动里有刚写的夹具（mtime 最新）');
      /**
       * 🔴 **截断要数规模**（独立审 🟡1 拿突变实证过：只断言"段在/有夹具名"时，
       * `recent.slice(0, 3)` 摘掉照绿）—— 最近改动**恰好 3 行**（库里 ≥4 篇，4 就露馅）。
       */
      const recentPart = detail.slice(detail.indexOf('最近改动'), detail.indexOf('待处理'));
      const recentLines = recentPart.split('\n').filter((l) => l.startsWith('- ')).length;
      eq(recentLines, 3, `最近改动恰好 3 行（实际 ${recentLines}）`);
      /**
       * 待处理明细：**不得超上限**。⚠️ 上限内的"真截"现夹具验不了（触发的规则数 < `statsTodos`，
       * 要 >8 条规则同时亮不现实）—— 如实记账（见交接 §6），别拿"没验"当"验了"。
       * ⚠️ **P7.24 · #12 起**：detail 在本段之后再挂一段「库级配置（只读）」（行也是 `- `）——
       * 圈定要**切到那一段之前**，别把配置行也数进待处理明细（第一版全量红的就这一条）。
       */
      const cfgAt = detail.indexOf('库级配置');
      const todoPart = detail.slice(detail.indexOf('待处理'), cfgAt >= 0 ? cfgAt : undefined);
      const todoLineCount = todoPart.split('\n').filter((l) => l.startsWith('- ')).length;
      ok(
        todoLineCount <= AI_AGENT_LIMITS.statsTodos,
        `待处理明细行数 ≤ 上限（实际 ${todoLineCount} / ${AI_AGENT_LIMITS.statsTodos}）`,
      );
    });

    await suite.it('list 本层笔记名的截断：恰好列上限个 + 如实写"还有 N 篇没列"', async () => {
      const dir = joinFs(vaultRoot, KB, '00_Inbox', '__p721多篇');
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < AI_AGENT_LIMITS.listNames + 5; i += 1) {
        writeFileSync(joinFs(dir, `n${String(i).padStart(2, '0')}.md`), '---\ntags: []\n---\n\nx\n', 'utf8');
      }
      // ⚠️ 笔记名走**索引**（`ctx.index.notes()`）——rescan 只让 vault 看见文件，
      //    必须再 rebuild + settleIndex（第一版漏了这步，断言读到"本层 0 篇"当场红）
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      const out = await run({ tool: 'list', args: { dir: '00_Inbox/__p721多篇' } });
      eq(out.ok, true, '列得出来');
      const detail = String(out.detail ?? '');
      contains(detail, '还有 5 篇没列', '截断如实说');
      const nameLines = detail.split('\n').filter((l) => /^- n\d\d$/.test(l)).length;
      eq(nameLines, AI_AGENT_LIMITS.listNames, `本层笔记名恰好列上限个（实际 ${nameLines}）`);
    });

    await suite.it('✅ skill 收窄对新工具生效：白名单少一个词，调用被拒且如实说明', async () => {
      const denied = await run({ tool: 'list', args: { dir: '00_Inbox' } }, { allowTools: ['search'] });
      eq(denied.ok, false, '名单外 = 拒');
      contains(denied.summary, '没有开', '如实说"这个能力包没有开"');
      const allowed = await run({ tool: 'list', args: { dir: '00_Inbox' } }, { allowTools: ['list'] });
      eq(allowed.ok, true, '名单里有它 = 照常跑（新工具名认得出）');
      // parseSkill 那条链也自动认新名字（`isAiToolName` 是同一份表）
      const parsed = parseSkill('---\n名称: 列目录\n工具白名单: [list, stats]\n---\n列吧。', 'x');
      ok(parsed.ok, '白名单写新工具名 = 解析得过（不用改 skill 层）');
      if (parsed.ok) eq((parsed.skill.tools ?? []).join(','), 'list,stats', '两个新名字都认');
    });

    await suite.it('stats 的工作目录收窄：篇数收在范围内、待处理如实标全库口径', async () => {
      const out = await run({ tool: 'stats', args: {} }, { scopeDir: '01_Projects' });
      eq(out.ok, true, '要出得来');
      const detail = String(out.detail ?? '');
      contains(String(out.summary), '全库', 'summary 里带着全库篇数做对照');
      contains(detail, '全库口径', '待处理那段写明是全库口径（不装成"范围内"）');
    });

    await suite.it('validateCall：list 的坏 dir 拒 · stats 的乱塞字段照丢（自我授权进不来）', async () => {
      /**
       * ⚠️ 这一条要**直接调 `validateCall`**：`runBatch` 不跑参数校验（那是**循环那一层**
       * 的闸，见 `agent.ts`）—— 拿 `runBatch` 验"形状不对进不进执行体"验的是别的东西
       *（第一版就是这么写错的，P7.21 当场红）。
       */
      eq(validateCall({ tool: 'list', args: { dir: '/绝对路径' } }).ok, false, 'list 绝对路径 = 拒');
      eq(validateCall({ tool: 'list', args: { dir: '..' } }).ok, false, 'list 的 .. = 拒');
      const okList = validateCall({ tool: 'list', args: { dir: '', recursive: true } });
      ok(okList.ok, '空 dir 合法（= 工作目录，没设就是库根）');
      if (okList.ok) eq(okList.call.args.recursive, true, 'recursive 真值带下去');
      const junk = validateCall({ tool: 'stats', args: { force: true, confirmed: true } });
      ok(junk.ok, 'stats 照过（不认识的字段在门口就丢了）');
      if (junk.ok) eq(Object.keys(junk.call.args).length, 0, '塞进来的 force / confirmed 没进执行体');
      // 端到端那半：真的过一遍执行体（agent 循环里的顺序是 validateCall → runBatch）
      const out = await run({ tool: 'list', args: { dir: '00_Inbox' } });
      eq(out.ok, true, '合法调用照常执行');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §E · #3 ask_user（澄清提问）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21 · #3 ask_user（澄清提问）', async () => {
    /** 收干净浮层（面板用例起手与收尾各一次） */
    function sweep(): void {
      purgeOverlays();
      closeAllMenus();
    }
    const port = (deps: { askUser?: (q: string) => Promise<string | null>; allowTools?: string[] | null } = {}) =>
      makeAiToolPort({
        ctx: ctx(),
        askPending: async () => [],
        askUser: deps.askUser,
        allowTools: (deps.allowTools ?? null) as never,
      });

    await suite.it('执行体：答案如实成为工具结果（截断如实 · 不当错误）', async () => {
      const out = (
        await port({ askUser: async () => '按 2026 年归档' }).runBatch(
          [{ tool: 'ask_user', args: { question: '按哪年归档？' } }],
          {},
        )
      )[0];
      eq(out?.ok, true, '问到了就是成功');
      eq(out?.summary, '用户回答：按 2026 年归档', '答案原样回给模型');
      const long = 'x'.repeat(AI_AGENT_LIMITS.askChars + 50);
      const clipped = (
        await port({ askUser: async () => long }).runBatch(
          [{ tool: 'ask_user', args: { question: '长答案？' } }],
          {},
        )
      )[0];
      contains(String(clipped?.summary), '（截断）', '超上限如实写"截断"（不悄悄吃掉）');
      eq(String(clipped?.summary).length <= AI_AGENT_LIMITS.askChars + '用户回答：'.length + '…（截断）'.length + 8, true, '截断真的截了');
    });

    await suite.it('跳过两条路：没给回答通道 / 通道回 null → "用户跳过"（不是错误）', async () => {
      const noPort = (
        await port().runBatch([{ tool: 'ask_user', args: { question: '问一句？' } }], {})
      )[0];
      eq(noPort?.ok, true, '跳过不是错（ok:true）');
      contains(String(noPort?.summary), '用户跳过', '如实说跳过');
      const nullPort = (
        await port({ askUser: async () => null }).runBatch(
          [{ tool: 'ask_user', args: { question: '问一句？' } }],
          {},
        )
      )[0];
      contains(String(nullPort?.summary), '用户跳过', 'null = 跳过（关面板 / 停止走的就是这条路）');
      const emptyPort = (
        await port({ askUser: async () => '   ' }).runBatch(
          [{ tool: 'ask_user', args: { question: '问一句？' } }],
          {},
        )
      )[0];
      contains(String(emptyPort?.summary), '用户跳过', '空答案同跳过');
    });

    await suite.it('validateCall：缺 question 拒 · 白名单外拒（收窄照旧对新工具生效）', async () => {
      // 形状那一半在 `validateCall`（循环层的闸 —— `runBatch` 不跑它，别拿它验形状）
      eq(validateCall({ tool: 'ask_user', args: {} }).ok, false, '没写问题 = 不进执行体');
      eq(validateCall({ tool: 'ask_user', args: { question: '   ' } }).ok, false, '空白问题 = 拒');
      ok(validateCall({ tool: 'ask_user', args: { question: '问？' } }).ok, '正常问题 = 过');
      // 白名单那一半在执行体（`runBatch` 跑的就是它）
      const denied = (
        await port({ askUser: async () => 'x', allowTools: ['search'] }).runBatch(
          [{ tool: 'ask_user', args: { question: '问？' } }],
          {},
        )
      )[0];
      eq(denied?.ok, false, '能力包没开它 = 拒');
      contains(String(denied?.summary), '没有开', '如实说"这个能力包没有开"');
    });

    await suite.it('真链路：模型问 → 答案作为工具结果喂回 → 据答继续（第二发里带着答案）', async () => {
      H.resetAi();
      await H.configAi(plugin);
      const asked: string[] = [];
      const calls = H.stubAiSeq([
        { reply: '我想确认一下。', actions: [{ tool: 'ask_user', args: { question: '要按哪年归档？' } }] },
        { reply: '好，按 2026 归档。' },
      ]);
      const turn = await ctx().ai.agent({
        question: '帮我归档',
        port: port({
          askUser: async (q) => {
            asked.push(q);
            return '按 2026 年';
          },
        }),
      });
      eq(asked.length, 1, '问题真的摆出来了（一次）');
      eq(asked[0], '要按哪年归档？', '问题原样送达');
      eq(turn.steps?.length, 1, '问 = 那一步里的一个动作（不额外开一步）');
      eq(turn.steps?.[0]?.items[0]?.outcome.summary, '用户回答：按 2026 年', '答案如实成为工具结果');
      eq(turn.kind, 'agent', '这一轮照常是 agent 轮');
      const sent2 = JSON.parse(String(calls.calls[1]?.body ?? '{}')) as {
        messages: { role: string; content: string }[];
      };
      const fed = (sent2.messages ?? []).map((m) => m.content).join('\n');
      contains(fed, '用户回答：按 2026 年', '答案喂回第二发（据答继续）');
      eq(turn.reply, '好，按 2026 归档。', '模型收尾那一段照常回来');
    });

    await suite.it('面板轻弹层：真开得出（`.kbw-ai-ask`）· 回答后收尾、输入框解锁', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin);
      const stub = H.stubAiSeq([
        { reply: '我先问一句。', actions: [{ tool: 'ask_user', args: { question: '按哪年归档？' } }] },
        { reply: '好，按 2026。' },
      ]);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '帮我归档';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelector('.kbw-ai-ask') !== null, 4000);
      contains(H.textOf(panel), '按哪年归档？', '问题原样摆出来（轻弹层）');
      ok(H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').disabled, '等着回答时输入框锁着（与待确认卡同款）');
      const box = H.q<HTMLInputElement>(panel, '.kbw-ai-ask-input');
      box.value = '按 2026 年';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-ask-acts .kbw-btn.is-primary'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > 0, 4000);
      const steps = H.qa<HTMLElement>(panel, '.kbw-ai-step');
      ok(
        steps.some((s) => H.textOf(s).includes('用户回答：按 2026 年')),
        `步骤行写着答案（实际：${steps.map((s) => H.textOf(s)).join(' | ')}）`,
      );
      eq(stub.calls.length, 2, '回答之后模型真的继续跑（第二发）');
      ok(!H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').disabled, '收尾后输入框解锁');
      sweep();
      H.resetAi();
    });
  });
}
