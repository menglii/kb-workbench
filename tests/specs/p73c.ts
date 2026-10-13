/**
 * spec：**P7.3c · 集成与交付**（2026-10-02）—— 离线能验的那一半
 *
 * 分段对表（`P7.3c开工提示词.md` §2）：
 *   · **5.3 右键「问 AI」**：工作台笔记菜单那一项（动作 = 打开面板 + 带引用，**不动库**）·
 *     平台 `editor-menu` 的「问 AI（选中文本） › 四个预设」（有选区才画）
 *   · **8.2 设置扩展**：权限面板（六类 × 三档 → `ai.toolTiers`）· 会话管理 · 模型参数 · 单价
 *   · **17.10② 成本可见**：`usage` 优先 / 认不出回落估算（`estimated` 必须置位）· 费用只做乘法
 *   · **17.10③ 本地模型诊断**：「测试连接」按 `AiError.kind` 分类 · 404 给"写到 /v1 为止"
 *   · **skill 机制**：解析（含各种坏形状）· 读盘 · 提示词收窄 · **执行体白名单**（真链路）
 *
 * ⚠️ **真机才验得了的那些不在这里**：菜单在两套菜单里的实际观感 · 平台 `editor-menu`
 * 真的被右键触发 · 面板里能力包胶囊的几何 · 真模型上报的 usage —— 全在 `scripts/probe.mjs`。
 *
 * 🔴 **离线绝不联网**：每个传输层都带注入的假实现；桩的 `requestUrl` 默认抛。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { parseSkill, skillsDirOf } from '../../src/services/ai/skills';
import { addUsage, costOf, emptyUsage, estimateTokens, fmtCost, fmtTokens, usageLine } from '../../src/services/ai/cost';
import { buildAgentMessages } from '../../src/services/ai/prompt';
import { AI_TOOL_NAMES, effectiveTier } from '../../src/services/ai/tools';
import { normalizeSettings } from '../../src/core/settings';
import { AiError } from '../../src/services/ai/transport';
import { diagnoseTest } from '../../src/ui/settings/ai';
import { buildAiSubmenu, WRITE_PRESETS } from '../../src/ui/editor-menu';
import { showNoteMenu } from '../../src/modules/notes/menus';
import { newSession, type AiSession } from '../../src/services/ai/sessions';

const KB = '01_新知识库';

/** 一份合法的 skill 文本（前言 + 正文） */
const SKILL_OK = [
  '---',
  '名称: 收件箱速理',
  '触发词: [收件箱, 速理]',
  '工具白名单: [search, read, move]',
  '---',
  '你只做收件箱归位：先搜、再读、最后提出搬运。',
].join('\n');

// ────────────────────────────────────────────────────────────────
// 假菜单（形状最小；与 `tests/specs/p6d.ts` 那份同形）
// ────────────────────────────────────────────────────────────────
interface FakeItem {
  title: string;
  run: () => void;
  sub: FakeMenu | null;
}
interface FakeMenu {
  items: FakeItem[];
  addItem(cb: (i: unknown) => void): FakeMenu;
}

function makeMenu(): FakeMenu {
  const menu: FakeMenu = {
    items: [],
    addItem(cb: (i: unknown) => void) {
      const rec: FakeItem = { title: '', run: () => undefined, sub: null };
      const handle = {
        setTitle: (t: string) => {
          rec.title = t;
          return handle;
        },
        setIcon: () => handle,
        setSection: () => handle,
        onClick: (fn: () => void) => {
          rec.run = fn;
          return handle;
        },
        setSubmenu: () => {
          rec.sub = makeMenu();
          return rec.sub;
        },
      };
      cb(handle);
      menu.items.push(rec);
      return menu;
    },
  };
  return menu;
}

export async function specP73c(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  /** 收干净浮层（每条用例起手与收尾各一次：残留模态会让 `.pop()` 认错人） */
  function sweep(): void {
    purgeOverlays();
    closeAllMenus();
  }
  void app;
  void vaultRoot;

  // ════════════════════════════════════════════════════════════
  // §A · skill 解析与读盘（D1：skills = 数据）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3c · skill 机制：解析与读盘', async () => {
    await suite.it('`parseSkill`：三个键都认（名称 / 触发词 / 工具白名单）+ 正文原样进 instructions', () => {
      const r = parseSkill(SKILL_OK, '随便');
      ok(r.ok, '这份该解析得出来');
      if (r.ok) {
        eq(r.skill.name, '收件箱速理', '名称来自前言（不是文件名）');
        eq(r.skill.triggers.join(','), '收件箱,速理', '触发词拆开了');
        eq((r.skill.tools ?? []).join(','), 'search,read,move', '工具白名单认出来的是 canonical 名字');
        contains(r.skill.instructions, '只做收件箱归位', '正文进 instructions');
        eq(r.skill.warn, undefined, '没有要提醒的');
      }
    });

    await suite.it('`parseSkill`：缺名称用文件名 · 缺白名单 = 不限制 · 块列表也认', () => {
      const r = parseSkill('---\n工具白名单:\n  - search\n  - move\n---\n干活。', '我的能力包');
      ok(r.ok, '没有「名称」但正文在 → 仍可用');
      if (r.ok) {
        eq(r.skill.name, '我的能力包', '名字回落到文件名');
        eq(r.skill.triggers.length, 0, '没有触发词 = 空数组（不是错）');
        eq((r.skill.tools ?? []).join(','), 'search,move', '块列表形式也认');
      }
      const noList = parseSkill('---\n名称: 光有指令\n---\n干点活。', 'x');
      ok(noList.ok, '整个白名单键不给 = 不限制');
      if (noList.ok) eq(noList.skill.tools, null, 'null = 不限制（与"空数组"是两回事）');
    });

    /**
     * 🔴 **坏形状必须拒**（而不是"当成空能力包跑"）：空正文 / 白名单全不认识 ——
     * 静默放行的话，用户会看到一个"什么都不做"的能力包，还以为是自己写错了指令。
     */
    await suite.it('`parseSkill`：空正文 / 白名单全不认得 → 拒，并说清为什么', () => {
      const empty = parseSkill('---\n名称: 空的\n---\n\n', 'x');
      eq(empty.ok, false, '正文是空的 → 拒');
      if (!empty.ok) contains(empty.why, '正文', '理由指向正文');

      const bogus = parseSkill('---\n名称: 野的\n工具白名单: [fly, teleport]\n---\n飞。', 'x');
      eq(bogus.ok, false, '一个都不认识 → 拒');
      // 理由要**说清怎么改**（把认得的名字列出来）；判据只认那句关键话，别把文案写死
      if (!bogus.ok) contains(bogus.why, '没有一个认识的工具', '理由说清"白名单里没有认得的工具"');

      const blank = parseSkill('---\n名称: 空名单\n工具白名单: []\n---\n干。', 'x');
      eq(blank.ok, false, '显式空名单 = 配置错了（不是"什么都不做"）');

      const partial = parseSkill('---\n名称: 半对\n工具白名单: [search, fly]\n---\n干。', 'x');
      ok(partial.ok, '认得的留下');
      if (partial.ok) {
        eq((partial.skill.tools ?? []).join(','), 'search', '只留认得的');
        contains(partial.skill.warn ?? '', 'fly', '认不得的要**说出来**（别静默丢）');
      }
    });

    await suite.it('`AiSkillStore`：列目录（坏文件记进 skipped）· 非 .md 不看 · load 按路径', async () => {
      const dir = skillsDirOf(ctx().settings.workbenchDir());
      // 用桩的 adapter 造文件（`.md` 两份 + 一份 .txt）
      await app.vault.adapter.mkdir(dir);
      await app.vault.adapter.write(`${dir}/收件箱速理.md`, SKILL_OK);
      await app.vault.adapter.write(`${dir}/坏的.md`, '---\n名称: 坏的\n---\n');
      await app.vault.adapter.write(`${dir}/说明.txt`, '不是 skill');
      const listed = await ctx().ai.skills.list();
      eq(listed.skills.length, 1, `只收 .md 且能解析的（实际 ${JSON.stringify(listed.skills.map((s) => s.name))}）`);
      eq(listed.skills[0].name, '收件箱速理', '名字对');
      eq(listed.skipped.length, 1, '坏的那份记进 skipped（读不动的要说出来）');
      contains(listed.skipped[0].file, '坏的', 'skipped 里是坏的那份');
      const one = await ctx().ai.skills.load(listed.skills[0].path);
      ok(one, '按路径取得到');
      eq(one?.path, listed.skills[0].path, 'path 是库内绝对路径');
      // 收场：把探针造的文件收走（下一组看不到它们 —— 面板的"能力包"菜单读的就是这个目录）
      await app.vault.adapter.remove(`${dir}/收件箱速理.md`);
      await app.vault.adapter.remove(`${dir}/坏的.md`);
      await app.vault.adapter.remove(`${dir}/说明.txt`);
    });

    await suite.it('提示词收窄：正文进 system · 工具目录只列白名单里的', () => {
      const parsed = parseSkill(SKILL_OK, 'x');
      ok(parsed.ok, '前提');
      if (!parsed.ok) return;
      const msgs = buildAgentMessages({
        question: '理一下收件箱',
        kbRoot: KB,
        dirs: [],
        rules: '',
        candidates: [],
        skill: parsed.skill,
      });
      const sys = msgs[0].content;
      contains(sys, '收件箱速理', '能力包的名字在 system 里');
      contains(sys, '只做收件箱归位', '它的正文原样进了 system');
      contains(sys, '"tool":"move"', '白名单里的 move 在工具目录里');
      ok(!sys.includes('"tool":"delete"'), '白名单外的 delete 不出现在工具目录里');
      ok(!sys.includes('"tool":"set_prop"'), 'set_prop 同样不出现（不是"列出来但标注不许用"）');

      const all = buildAgentMessages({ question: 'x', kbRoot: KB, dirs: [], rules: '', candidates: [] });
      for (const t of AI_TOOL_NAMES) {
        contains(all[0].content, `"tool":"${t}"`, `不带 skill 时 ${t} 在工具目录里`);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B · 执行体白名单（真链路：面板 → 循环 → 端口）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3c · 执行体白名单（收窄只做减法）', async () => {
    async function mk(rel: string): Promise<{ rel: string; abs: string }> {
      H.writeNote(vaultRoot, `${KB}/${rel}`, '---\n类型: 想法\n---\n\n正文\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      return { rel, abs: `${KB}/${rel}` };
    }

    await suite.it('🔴 白名单外的工具：模型提了也不执行，如实回一句（文件一字节没动、不弹确认框）', async () => {
      const f = await mk('00_Inbox/__探针AI窄.md');
      sweep();
      H.resetAi();
      H.stubAiSeq([
        { reply: '我把它搬走。', actions: [{ tool: 'move', args: { path: '00_Inbox/__探针AI窄.md', to: '01_Projects' } }] },
        { reply: '那算了。' },
      ]);
      await H.configAi(plugin);
      /**
       * 造一个**只开 search** 的能力包，把它以面板的真入口挂上去：
       * 面板的 skill 按钮 → 菜单里那一项 → 面板记住 activeSkill。
       * ⚠️ 走 UI 而不是直接塞内部状态：这条要验的是"用户选了能力包之后，执行体真的收窄"，
       * 直接塞变量就绕过了"选"的那一半。
       */
      const dir = skillsDirOf(ctx().settings.workbenchDir());
      await app.vault.adapter.mkdir(dir);
      const skillPath = `${dir}/只搜不动.md`;
      await app.vault.adapter.write(skillPath, '---\n名称: 只搜不动\n工具白名单: [search]\n---\n只看不动手。');
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      // R4：能力包收进「＋」菜单 —— 先开 ＋ 点「能力包…」，再等能力包菜单
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(30);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('能力包'),
        ) as HTMLElement,
      );
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) => H.textOf(i).includes('只搜不动')),
        3000,
      );
      const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('只搜不动'));
      ok(item, '能力包菜单里有它');
      H.click(item as HTMLElement);
      await H.settle(160);
      /**
       * 🔴 **要判"看得见"，不是"在 DOM 里"**（独立审查 🔴1 的真缺陷：那一排原先只看 `refs.length`，
       * 选中能力包而不引用任何笔记时整排 `display:none` —— 胶囊在 DOM 里、用户看不见、
       * ✕ 也点不到，而能力包还在生效）。jsdom 没有布局，所以判**内联样式**那一档
       *（`.kbw-ai-refrow` 的 display 就是 `paintRefs()` 写的）。
       */
      const chip = H.maybe(panel, '.kbw-ai-skillchip');
      ok(chip, '选中之后胶囊在 DOM 里');
      eq(H.q<HTMLElement>(panel, '.kbw-ai-refrow').style.display === 'none', false, '🔴 那一排不能是 display:none（常驻可见）');
      contains(H.textOf(panel), '只搜不动', '胶囊上写着名字');

      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '搬一下收件箱';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      contains(H.textOf(panel), '没有开', '如实说"这个能力包没开这个工具"');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '连待确认卡都不该有（连带确认框也没有）');
      eq(panel.querySelectorAll('.kbw-ai-plan .kbw-ai-row').length, 0, '没摆到用户面前');
      ok(H.exists(vaultRoot, f.abs), '🔴 文件一字节没动');
      // 收场
      await app.vault.adapter.remove(skillPath);
      sweep();
      H.resetAi();
    });

    await suite.it('白名单"内"的工具照旧走原路（收窄不会把该做的也拦了）', async () => {
      await mk('00_Inbox/__探针AI宽.md');
      sweep();
      H.resetAi();
      H.stubAiSeq([
        { reply: '我搜一下。', actions: [{ tool: 'search', args: { dir: '00_Inbox' } }] },
        { reply: '只有这些。' },
      ]);
      await H.configAi(plugin);
      const dir = skillsDirOf(ctx().settings.workbenchDir());
      await app.vault.adapter.mkdir(dir);
      const skillPath = `${dir}/只搜不动.md`;
      await app.vault.adapter.write(skillPath, '---\n名称: 只搜不动\n工具白名单: [search]\n---\n只看不动手。');
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(30);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('能力包'),
        ) as HTMLElement,
      );
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) => H.textOf(i).includes('只搜不动')),
        3000,
      );
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('只搜不动')) as HTMLElement,
      );
      await H.settle(160);
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '搜一下';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      contains(H.textOf(panel), '命中', '白名单里的 search 照旧执行（步骤行画出了结果）');
      await app.vault.adapter.remove(skillPath);
      sweep();
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C · 用量与成本（17.10②）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3c · 成本可见（17.10②）', async () => {
    await suite.it('纯函数：估算 / 费用 / 短写法 / 累加（真实与估算可以混在一轮里）', () => {
      eq(estimateTokens(''), 0, '空串 = 0');
      eq(estimateTokens('abcd'), 2, '4 字符 → 2 token（chars/2 向上取整）');
      eq(costOf({ promptTokens: 1_000_000, completionTokens: 0 }, 2, 8), 2, '输入 100 万 × 2 = 2');
      eq(costOf({ promptTokens: 0, completionTokens: 1_000_000 }, 2, 8), 8, '输出 100 万 × 8 = 8');
      eq(costOf({ promptTokens: 1000, completionTokens: 1000 }, 0, 0), 0, '单价为 0 → 0（界面据此不显示费用）');
      eq(fmtTokens(945), '945', '不到 1000 直接写');
      eq(fmtTokens(1234), '1.2k', '四位数进 k');
      eq(fmtTokens(12345), '12k', '整数位够了就不给小数');
      eq(fmtCost(0.004_2, '¥'), '¥0.0042', '分位以下给四位（再往后就是假精度）');
      eq(fmtCost(0.12, '¥'), '¥0.12', '一毛二');

      let u = emptyUsage();
      u = addUsage(u, { promptTokens: 100, completionTokens: 20 });
      eq(u.estimated, false, '服务端报了就不算估算');
      eq(u.calls, 1, '记一次调用');
      u = addUsage(u, undefined, { promptText: 'abcd', completionText: 'ef' });
      eq(u.estimated, true, '有一次没报 → 整轮标成"估算"');
      eq(u.promptTokens, 102, '没报的那次按字符估算补上（100 + 2）');
      eq(u.completionTokens, 21, '输出同理（20 + 1）');
      eq(usageLine(u, 2, 8, '¥').includes('估算'), true, '一行说明里带着"估算"二字');
      eq(usageLine(u, 0, 0, '¥').includes('¥'), false, '单价是 0 时不显示金额那一段');
    });

    await suite.it('真链路：服务端报 usage → 面板那一行是真数字（没有"估算"）', async () => {
      sweep();
      H.resetAi();
      H.stubAiSeq([
        {
          reply: '好。',
          actions: [{ tool: 'search', args: { dir: '00_Inbox' } }],
          usage: { prompt_tokens: 1500, completion_tokens: 300 },
        },
        { reply: '说完了。', usage: { prompt_tokens: 2000, completion_tokens: 40 } },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '看一眼';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      /**
       * ⚠️ **要取"活的那一轮"的脚注，不是恢复出来的历史那一行**（P7.3c 收尾实测：
       * 面板打开时会恢复上一段会话，而 `paintRestored` 也画用量行 —— 于是
       * `querySelector` 拿到的是**历史那一行**，数字当然对不上）。
       * 活轮次的行在 `.kbw-ai-bubble` 里，历史的在 `.kbw-ai-hist` 里。
       */
      const line = H.qa<HTMLElement>(panel, '.kbw-ai-bubble .kbw-ai-usage').pop();
      ok(line, '每一轮收尾都有一行用量脚注');
      contains(H.textOf(line), '3.5k', '输入是两次之和（1500 + 2000 = 3.5k）');
      contains(H.textOf(line), '340', '输出同样是和（300 + 40）');
      ok(!H.textOf(line).includes('估算'), '两次都报了 → 不标估算');
      sweep();
      H.resetAi();
    });

    await suite.it('R4（P7.12）：用量明细**默认收起**（点开才看）；头部收「⋯」、底栏收「＋」、胶囊撤', async () => {
      sweep();
      H.resetAi();
      H.stubAiSeq([{ reply: '好。', usage: { prompt_tokens: 1500, completion_tokens: 300 } }]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      // 收纳结构（照 §R4 稿）
      ok(H.maybe(panel, '.kbw-ai-morebtn'), '头部有「⋯」');
      ok(H.maybe(panel, '.kbw-ai-plusbtn'), '底栏有「＋」');
      ok(
        (H.maybe(panel, '.kbw-ai-morebtn')?.getAttribute('title') ?? '').includes('改库前都会弹确认框'),
        '「⋯」tooltip 扛起了「改库需确认」的说明',
      );
      /**
       * ⚠️ 独立审 B4（P7.12 收尾）：原来这里钉"三枚旧图标类不存在"（`.kbw-ai-refbtn` 等
       * 已随功能从 src 删掉，恒真）。改钉**新形态**：三件确实都收进了「＋」菜单里
       * —— 入口在、只是位置变了（这才是"收纳"要保证的不变量）。
       */
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(30);
      const plusLabels = H.qa<HTMLElement>(document.body, '.kbw-menu-item').map((i) => H.textOf(i));
      for (const want of ['引用一篇笔记', '工作目录', '能力包']) {
        ok(plusLabels.some((l) => l.includes(want)), `「＋」菜单里有「${want}」（@ / 工作目录 / 能力包三件）`);
      }
      closeAllMenus();
      await H.settle(20);
      // 跑一轮 → 用量脚注默认收起，点开才有明细
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '看一眼';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      const wrap = H.qa<HTMLElement>(panel, '.kbw-ai-bubble .kbw-ai-usage').pop();
      ok(wrap, '每一轮收尾仍有用量脚注（换成了可折叠的）');
      const fold = H.q<HTMLElement>(wrap!, '.kbw-ai-usage-fold');
      contains(H.textOf(fold), '用量明细', '默认是一行「⋯ 用量明细」开关');
      const body = H.q<HTMLElement>(wrap!, '.kbw-ai-usage-body');
      ok(!body.classList.contains('is-open'), '默认收起（is-open 不在）');
      H.click(fold);
      await H.settle(30);
      ok(body.classList.contains('is-open'), '点开就展开');
      contains(H.textOf(body), '1.5k', '展开后明细在里面（输入 1500）');
      sweep();
      H.resetAi();
    });

    await suite.it('真链路：服务端不报 usage → 回落到本地估算，并且**标出来**', async () => {
      sweep();
      H.resetAi();
      H.stubAiSeq([{ reply: '好。' }]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '随便问问';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      const line = H.qa<HTMLElement>(panel, '.kbw-ai-bubble .kbw-ai-usage').pop();
      ok(line, '照样有那一行（认不出 ≠ 不显示）');
      contains(H.textOf(line), '估算', '🔴 必须标明是估算（悄悄拿估算当实数比不显示更坏）');
      // ⚠️ 别写 /\d/（'0' 也能过）—— 认"输入/输出都不是 0"
      ok(!/输入 0 \/ 输出 0 token/.test(H.textOf(line)), `两边的 token 数都得有（实际：${H.textOf(line)}）`);
      sweep();
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §D · 测试连接（17.10③）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3c · 本地模型诊断（17.10③）', async () => {
    const keep = (): { chat: unknown; stream?: unknown } => {
      const t = ctx().ai.transport as unknown as { chat: unknown; stream?: unknown };
      return t;
    };
    async function withTransport(
      t: { chat: (req?: unknown, opts?: unknown) => Promise<{ text: string }>; stream?: (req?: unknown, opts?: unknown) => Promise<{ text: string }> },
      fn: () => Promise<void>,
    ): Promise<void> {
      const old = keep();
      try {
        ctx().ai.transport = t as never;
        await fn();
      } finally {
        ctx().ai.transport = old as never;
      }
    }

    await suite.it('没配 key → no-key（不真发请求）', async () => {
      const cur = ctx().settings.get().ai;
      await ctx().settings.save({ ai: { ...cur, apiKey: '' } });
      let called = 0;
      await withTransport(
        {
          chat: async () => {
            called += 1;
            return { text: 'x' };
          },
        },
        async () => {
          const res = await ctx().ai.testConnection();
          eq(res.ok, false, '不算连上');
          eq(res.kind, 'no-key', '分类到 no-key');
        },
      );
      eq(called, 0, '一个请求都没发');
      await H.configAi(plugin);
    });

    await suite.it('401 → auth；404 → http + status（分类与面板里其它错误同一套）', async () => {
      await withTransport(
        {
          chat: async () => {
            throw new AiError('HTTP 401', 'auth', 401);
          },
        },
        async () => {
          const res = await ctx().ai.testConnection();
          eq(res.ok, false, '失败');
          eq(res.kind, 'auth', 'kind 就是 AiError 的那一个（没另造一套）');
          eq(res.status, 401, '状态码带出来');
          contains(res.hint ?? '', 'key', 'hint 是同一份文案');
        },
      );
      await withTransport(
        {
          chat: async () => {
            throw new AiError('HTTP 404', 'http', 404);
          },
        },
        async () => {
          const res = await ctx().ai.testConnection();
          eq(res.kind, 'http', '404 归 http 档');
          const d = diagnoseTest(res);
          contains(d.text, '/v1', '404 要给"写到 /v1 为止"这条对症建议');
          eq(d.kind, 'error', '当成错误画');
        },
      );
    });

    await suite.it('成功：走流式 → via=stream；不吐增量（降级）→ via=chat + 如实说明', async () => {
      await withTransport(
        {
          chat: async () => ({ text: 'ok' }),
          stream: async (_req, opts) => {
            (opts as { onDelta?: (d: string) => void }).onDelta?.('o');
            return { text: 'ok' };
          },
        },
        async () => {
          const res = await ctx().ai.testConnection();
          eq(res.ok, true, '连上了');
          eq(res.via, 'stream', '走的是流式那一路');
        },
      );
      await withTransport(
        {
          chat: async () => ({ text: 'ok' }),
          stream: async () => ({ text: 'ok' }),
        },
        async () => {
          const res = await ctx().ai.testConnection();
          eq(res.ok, true, '降级也算连上');
          eq(res.via, 'chat', '如实报"走的是整包"');
          contains(res.note ?? '', '降级', '并说明为什么');
        },
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // §E · 设置面板（8.2）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3c · 设置面板：权限 / 会话 / 参数', async () => {
    async function goAiRail(): Promise<HTMLElement> {
      if (!H.maybe(document.body, '.kbw-set-shell')) {
        ctx().openWorkbenchSettings();
        await H.settle(160);
      }
      const tab = H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes('AI 助手'));
      ok(tab, '左栏有「AI 助手」');
      H.click(tab as HTMLElement);
      await H.settle(200);
      return H.q<HTMLElement>(document.body, '.kbw-set-shell');
    }

    await suite.it('🔴 权限面板：点一档 → 写进 `ai.toolTiers`，并且真的生效', async () => {
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: {} } });
      await goAiRail();
      /** 找「搬动文件」那一行（类别名来自 `AI_TOOL_CLASSES`，判据认它） */
      const rowOf = (label: string): HTMLElement =>
        H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) => H.textOf(r).includes(label)) as HTMLElement;
      const moveRow = rowOf('搬动文件');
      ok(moveRow, '有「搬动文件」这一行');
      const segs = H.qa<HTMLElement>(moveRow, '.kbw-segbtn');
      eq(segs.map((s) => H.textOf(s)).join('/'), '禁/需确认/自动', '三档按钮');
      eq(H.textOf(segs[1]), '需确认', '默认那份是"需确认"');
      ok(segs[1].classList.contains('is-on'), '默认档亮着的是"需确认"（显示的是**生效值**）');
      H.click(segs[0]);
      await H.settle(160);
      eq(ctx().settings.get().ai.toolTiers?.move, 'off', '点「禁」→ 落盘');
      eq(effectiveTier('move', ctx().settings.get().ai), 'off', '🔴 真的生效：写进去的值流进了 effectiveTier（执行体读的就是它）');
      const row2 = rowOf('搬动文件');
      ok(H.qa<HTMLElement>(row2, '.kbw-segbtn')[0].classList.contains('is-on'), '重画之后"禁"亮着');
      // 「全部恢复默认」清空显式表
      const reset = H.qa<HTMLElement>(document.body, '.kbw-btn').find((b) => H.textOf(b).includes('全部恢复默认'));
      ok(reset, '有「全部恢复默认」');
      H.click(reset as HTMLElement);
      await H.settle(160);
      eq(JSON.stringify(ctx().settings.get().ai.toolTiers ?? {}), '{}', '清空 = 回落到默认表');
    });

    await suite.it('旧开关已退役：AI 栏不再画「允许 AI 直接动库」', async () => {
      /**
       * 🔴 **P7.5（8.1 体检拍板）**：粗档旧开关退役 —— 面板上不该再出现它那一行/那片字；
       * 权限只剩六类档位这一套口径（存量的 true 由 v4→v5 迁移映射成逐类，见 settings.spec）。
       * 这条是"退役到位"的 UI 侧判据（迁移侧判据在 `tests/specs/settings.ts`）。
       */
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: {} } });
      const shell = await goAiRail();
      const text = H.textOf(shell);
      ok(!text.includes('旧开关'), '🔴 旧开关那一行没了');
      ok(!text.includes('允许 AI 直接动库'), '连那片字也不该在');
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-set-row').some((r) => H.textOf(r).includes('搬动文件')),
        '六类档位行照常在（前提自证 —— 整栏没画出来时上面两条会假绿）',
      );
      /**
       * ⚠️ **P7.21b 改写**：原判据是"这一栏一个开关都没有"（`.kbw-switch` 数 === 0）——
       * 那是"旧粗档开关退役到位"的**代理**。P7.21b 往这一栏加了「触发词自动挂载」
       * 开关（能力包那一组，与退役那件事无关）→ 代理失效。改钉**意图本身**：
       * 全栏的开关**恰好一个、且必须是它**（独立审 Y4：`every` 空集恒真 —— 整组消失
       * 时 ['…'].every = true 会假绿，所以要同时钉个数）。
       */
      const switches = H.qa<HTMLElement>(document.body, '.kbw-switch');
      eq(switches.length, 1, `这一栏恰好一个开关（实际 ${switches.length} 个）`);
      ok(
        switches.every((sw) => H.textOf(sw.closest('.kbw-set-row') ?? sw).includes('触发词自动挂载')),
        '且它只能是「触发词自动挂载」（旧开关要是溜回来，行文案不是这个，照样红）',
      );
      sweep();
    });

    await suite.it('模型参数与单价：落盘 + 夹取（手改 data.json 塞野值也不怕）', async () => {
      await goAiRail();
      const nums = H.qa<HTMLInputElement>(document.body, '.kbw-set-row input[type="number"]');
      ok(nums.length >= 4, `参数 + 单价那几个数字框都在（实际 ${nums.length}）`);
      const set = (input: HTMLInputElement, v: string): void => {
        input.value = v;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // 第一个是「单次回答上限」，第二个是「温度」，第三/四两个是单价
      set(nums[0], '800');
      await H.settle(120);
      eq(ctx().settings.get().ai.maxTokens, 800, 'maxTokens 落盘');
      set(nums[1], '0.7');
      await H.settle(120);
      eq(ctx().settings.get().ai.temperature, 0.7, 'temperature 落盘');
      set(nums[2], '3');
      await H.settle(120);
      eq(ctx().settings.get().ai.priceIn, 3, '输入单价落盘');
      set(nums[1], '9');
      await H.settle(120);
      eq(ctx().settings.get().ai.temperature, 2, '温度被夹到 2（越界不落盘成野值）');
      /**
       * 🔴 **"手改 data.json 塞野值"要真的过一遍收敛器**（独立审查 🟡4：用例名这么承诺，
       * 而原先只测了控件那一层的 min/max）—— 直接拿野 JSON 喂 `normalizeSettings`。
       */
      const norm = normalizeSettings({
        ai: { maxTokens: -5, temperature: 9, priceIn: -1, priceOut: 1e6, priceUnit: '￥￥￥￥￥￥', apiKey: 'k' },
      });
      eq(norm.ai.maxTokens, 0, '负数夹到 0（= 不限定）');
      eq(norm.ai.temperature, 2, '越界温度夹到 2');
      eq(norm.ai.priceIn, 0, '负单价夹到 0');
      eq(norm.ai.priceOut, 100_000, '天文数字单价夹到上限');
      eq(norm.ai.priceUnit.length, 4, '货币符号截到 4 个字');
      const bad = normalizeSettings({ ai: { maxTokens: '很多', temperature: null, priceUnit: 7 } });
      eq(bad.ai.maxTokens, 1200, '类型不对 → 保持默认（不是 NaN）');
      eq(bad.ai.priceUnit, '¥', '类型不对的货币符号也保持默认');
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, maxTokens: 1200, temperature: 0, priceIn: 2 } });
    });

    await suite.it('会话管理：列表 → 重命名 → 删除（两段确认）→ 少一行', async () => {
      const store = ctx().ai.sessions;
      const before = await store.list();
      const mkSession = async (title: string): Promise<AiSession> => {
        const s = newSession();
        s.title = title;
        s.turns = [{ question: title, kind: 'chat', reply: '嗯', ideas: [], plan: { rows: [], blocked: [] }, proposed: 0, dropped: 0 }];
        return store.save(s);
      };
      const a = await mkSession('__探针会话甲');
      const b = await mkSession('__探针会话乙');
      try {
        await goAiRail();
        // 切栏重画会重读列表（`fillSessions` 是 await 的）—— 换个栏再回来，保证它画完
        const railTab = (name: string): HTMLElement | undefined =>
          H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes(name));
        H.click(railTab('外观') as HTMLElement);
        await H.settle(120);
        H.click(railTab('AI 助手') as HTMLElement);
        await H.settle(240);
        const listRows = (): HTMLElement[] =>
          H.qa<HTMLElement>(document.body, '.kbw-set-sesslist .kbw-set-row');
        const titles = listRows().map((r) => H.textOf(r.querySelector('.kbw-set-label-t')));
        ok(titles.some((t) => t.includes('__探针会话甲')), `列表里有刚造的那一段（实际 ${titles.join(' | ')}）`);

        // ── 重命名 ──
        const rowA = listRows().find((r) => H.textOf(r).includes('__探针会话甲')) as HTMLElement;
        H.click(H.qa<HTMLElement>(rowA, '.kbw-btn').find((x) => H.textOf(x) === '重命名') as HTMLElement);
        await H.settle(160);
        /** 问名字的小模态 = **最后开的那个** `.kbw-modal`（设置面板本身也是一个） */
        const promptModal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
        const promptInput = promptModal ? H.maybe<HTMLInputElement>(promptModal, 'input.kbw-input') : null;
        ok(promptInput, '弹出问名字的小模态');
        (promptInput as HTMLInputElement).value = '__探针会话甲改';
        H.click(H.q<HTMLElement>(promptModal as HTMLElement, '.kbw-modal-foot .kbw-btn.is-primary'));
        await H.settle(240);
        const reloaded = await store.load(a.id);
        eq(reloaded?.title, '__探针会话甲改', '标题真的改了（落盘）');

        // ── 删除（危险两段）──
        H.click(railTab('外观') as HTMLElement);
        await H.settle(120);
        H.click(railTab('AI 助手') as HTMLElement);
        await H.settle(240);
        const rowB = listRows().find((r) => H.textOf(r).includes('__探针会话乙')) as HTMLElement;
        H.click(H.qa<HTMLElement>(rowB, '.kbw-btn').find((x) => H.textOf(x) === '删除') as HTMLElement);
        await H.settle(160);
        contains(H.textOf(document.body), '不碰任何笔记', '确认框里写清"删的是对话记录"');
        const dangerBtn = H.qa<HTMLElement>(document.body, '.kbw-modal-foot .kbw-btn.is-danger').pop();
        ok(dangerBtn, '危险态的按钮在');
        H.click(dangerBtn as HTMLElement); // 第一下 = 上膛
        await H.settle(120);
        H.click(H.qa<HTMLElement>(document.body, '.kbw-modal-foot .kbw-btn.is-danger').pop() as HTMLElement);
        await H.settle(240);
        const after = await store.list();
        eq(after.some((m) => m.id === b.id), false, '删掉的那份不在列表里了');
        eq(after.some((m) => m.id === a.id), true, '另一份没被误删');
      } finally {
        await store.remove(a.id);
        await store.remove(b.id);
        eq((await store.list()).length, before.length, '探针造的会话都收走了');
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // §F · 两个入口（5.3）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.3c · 右键「问 AI」（5.3）', async () => {
    await suite.it('🔴 笔记菜单：「问 AI（这一篇）」点了只打开面板 + 带上引用（不动库、不弹确认）', async () => {
      sweep();
      const calls: { seed?: string; refs?: unknown[] }[] = [];
      const entry = {
        path: `${KB}/00_Inbox/甲.md`,
        // ⚠️ `basename` **不带扩展名**（Obsidian `TFile.basename` 的真实语义 —— 夹具旧版
        // 写成 '甲.md'，靠 stripExt 恰好蒙对；P7.10 修 stripExt 二次剥离时当场现形）
        basename: '甲',
        props: {},
        effectivePosition: '00_Inbox',
      } as never;
      const fakeCtx = {
        openAi: (seed?: string, refs?: unknown[]) => {
          calls.push({ seed, refs });
        },
        // P7.1c 起「移动到…」是树形子菜单（`migrateItems` → `buildTree(ctx.index.notes())`），
        // **建菜单这一趟**也要 `notes()` —— 空数组 = 树里一个目录都没有（这条用例不看它）
        index: { tags: () => [] as string[], notes: () => [] },
        // P7.2c 起「改」组里还有「丢进板块」（读 `ctx.configs.cached('board')` 的同步缓存）——
        // 假件返回 null = 配置没热过 → 那一行不画（这条用例不看它）
        configs: { cached: () => null },
        // P7.2d 起「其他」组里还有「钉到首页」（`isHomePinned` 读 `ctx.settings.get().homeCards`）——
        // **同一条账第三次**（P7.2c 的 `configs.cached` 是前一次）：给共享函数加新依赖，
        // 全仓手写假件都要跟着补（坑/判据与验证.md 那条就是这么写的）。
        settings: { get: () => ({ homeCards: null }), kbRoot: () => KB },
        // P7.15 · #2 起「移动到…」的树改吃**真实目录**（`buildTreeFromVault` →
        // `kbDirsOf(app, kbRoot)`）—— **同一条账第四次**。空库（`getAllLoadedFiles` 给空）
        // = 树里只有根，这条用例不看它。
        app: { vault: { getAllLoadedFiles: () => [] } },
        // P8 起「回顾卡 ›」子菜单的「已有 N 张」读 `ctx.review` 的同步缓存——
        // **同一条账第五次**。缓存在假件里返回 null = 没热过 → 不显示张数（这条用例不看它）。
        review: { cached: () => null, cardsOf: () => [] },
      };
      /**
       * 假件的**最小集**：`showNoteMenu` 在**建菜单**这一趟就会碰这几个
       *（`ops.revealBlockReason` / `fileListBlockReason` 在开头，`ctx.index.tags()` 在「加标签」那一支，
       * `ctx.index.notes()` 在「移动到…」的子菜单那一支，`ctx.configs.cached()` 在「丢进板块」那一支）——
       * 其余 `ops.*` 只出现在别的项的 `run` 里，这一条用不到（假件别铺大，那等于给自己打分）。
       */
      showNoteMenu(entry, new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
        ctx: fakeCtx,
        ops: {
          revealBlockReason: () => null,
          fileListBlockReason: () => null,
          setProp: () => undefined,
          changeTags: () => undefined,
        },
        onRename: () => undefined,
        onExpandAll: () => undefined,
      } as never);
      const items = H.qa<HTMLElement>(document.body, '.kbw-menu-item');
      const ask = items.find((i) => H.textOf(i).includes('问 AI'));
      ok(ask, `菜单里有「问 AI（这一篇）」（实际 ${items.map((i) => H.textOf(i)).join(' | ')}）`);
      contains(H.textOf(ask as HTMLElement), '这一篇', '文案明确"这一篇"');
      H.click(ask as HTMLElement);
      closeAllMenus();
      eq(calls.length, 1, '点了正好调一次 openAi');
      eq(calls[0].seed, '', '不硬塞一句预设（用户想说什么自己写）');
      const refs = (calls[0].refs ?? []) as { kind: string; path: string; title: string }[];
      eq(refs.length, 1, '带上一份引用');
      eq(refs[0].kind, 'note', '引用是"这一篇笔记"');
      eq(refs[0].path, `${KB}/00_Inbox/甲.md`, 'path 是**库内绝对路径**（脚本口径）');
      eq(refs[0].title, '甲', '显示用 basename 原样（本就无扩展名 —— P7.10 修 stripExt 后夹具须与真身同形）');
      sweep();
    });

    await suite.it('🔴 editor-menu：有选区才画「问 AI（选中文本） › 四个预设」；无选区不画（R8：收在经纬AI 栏下）', async () => {
      const deps = {
        app: app as never,
        kbRoot: () => KB,
        openInWorkbench: () => undefined,
        copyPath: () => undefined,
        rename: () => undefined,
        tidyOne: () => undefined,
        aiTitle: () => undefined,
        beautify: () => undefined,
        askAi: () => undefined,
      };
      const file = { path: `${KB}/00_Inbox/乙.md`, basename: '乙.md', extension: 'md' } as never;

      const noSel = makeMenu();
      buildAiSubmenu(noSel as never, file, deps, '');
      eq(
        noSel.items.map((i) => i.title).join('|'),
        '自动整理|自动命名|美化笔记',
        '没有选区 → 常态三项（R8：不再有「用工作台打开」，那在经纬栏）',
      );

      const asked: { presetId: string; seed: string; selection: string }[] = [];
      const withSel = makeMenu();
      buildAiSubmenu(
        withSel as never,
        file,
        { ...deps, askAi: (req) => asked.push({ presetId: req.presetId, seed: req.seed, selection: req.selection }) },
        '  这段要被润色  ',
      );
      const titles = withSel.items.map((i) => i.title);
      eq(titles.length, 4, `有选区 → 多出「问 AI（选中文本）」这一项：${titles.join('|')}`);
      const askItem = withSel.items[3];
      contains(askItem.title, '问 AI', '条件是「问 AI（选中文本）」');
      const subs = (askItem.sub?.items ?? []).map((i) => i.title);
      eq(subs.join('|'), WRITE_PRESETS.map((p) => p.label).join('|'), '四个预设按表列出来');
      askItem.sub?.items[0].run();
      eq(asked.length, 1, '点第一个预设 → 调一次 askAi');
      eq(asked[0].presetId, WRITE_PRESETS[0].id, '带的是那个预设的 id');
      eq(asked[0].selection, '这段要被润色', '选区**去掉首尾空白**（编辑器里的缩进不该带进提示词）');
      contains(asked[0].seed, '润色', '预填那句话就是这个预设的');
    });

    await suite.it('真链路：面板带着引用打开 —— 胶囊显形（不是只塞进 seed 文本）', async () => {
      sweep();
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, toolTiers: {} } });
      ctx().openAi('', [
        { kind: 'selection', path: `${KB}/00_Inbox/丙.md`, title: '丙.md', text: '一段选中文本' },
      ]);
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const chips = H.qa<HTMLElement>(panel, '.kbw-ai-ref');
      eq(chips.length, 1, '引用以胶囊显形');
      contains(H.textOf(chips[0]), '丙', '胶囊上写着是哪一篇');
      contains(H.textOf(chips[0]), '选区', '并标明是"选区"');
      sweep();
    });
  });
}
