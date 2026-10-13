/**
 * ui/ai-panel.ts —— AI 助手浮层（交互规格 §11）· P7.3b 重设计
 *
 * ## 这一屏的职责边界（**只有画与点，没有别的**）
 *
 * ```
 * 输入 ──► ctx.ai.agent()          ← 服务层：备料 / 调模型 / 工具循环（services/ai/）
 *    ▲             │  hooks：正文段 / 步骤行 / 待确认卡
 *    │             ▼
 *  「跳过」    画一屏气泡：正文 + 步骤行 + 待确认卡
 *                  │  勾上的那些
 *                  ▼
 *  ui/ai-tools.ts（ToolPort）──► ui/confirm.ts ──► mover / fm / completion
 * ```
 *
 * 🔴 **动库一个字都不在本文件里**（P7.3b 起）：执行体全在 `ui/ai-tools.ts`
 * （`redline.ts` 有静态断言：本文件不许出现 `mover.move` / `confirm(` / `processFrontMatter`
 * 这些写盘形态）。面板只画 `hooks` 报上来的事。
 * ⚠️ **P7.21b 例外一处（G4，如实记着）**：「把本段对话存成能力包」（技能工坊）会调
 * `ctx.completion.createNote` **写库** —— 走的是与「导出为笔记」**同一条既有出口**
 *（红线禁的是"自己开写盘 API"，不是"调用既有出口"；`ui/ai-tools.ts` 那半边照旧一个字不碰）。
 * 新建不覆盖 + 用户显式点「存成能力包」= 不需要再过确认流（与新建对话框同一口径）。
 *
 * ## 设计（2026-10-02 拍板 · `AI面板重设计稿.html`）
 *
 * · 头部一行：历史对话 / 标题 / 档位胶囊 / 新对话 / 导出 —— **没有副标题、没有底栏**；
 * · 历史重画成与实时一致的气泡；**左上角图标开「历史对话」抽屉**（选一段载入接着聊）；
 * · 消息级操作收成一排小图标；停止 = 发送键原地变「停止」；
 * · agent 的干活过程 = 气泡里的**步骤行**（读类淡、写类显 + 状态）；要动库的
 *   停在一张**待确认卡**里等勾选 —— 不点不执行。
 *
 * ## 几个"看起来该做但故意不做"
 *
 * · **不做"AI 直接执行"**：设置里那个开关 = **自动进入确认流**（§11.2 第 3 条）——
 *   省的是"先看表再点执行"，不是确认本身。
 * · **待确认卡等着时输入框禁用**：那一轮在等你的决定；要么勾、要么「跳过」。
 *   直接关面板 / 新对话 = 整轮中止（待确认的那些一条都不执行）。
 * · **助手那一侧渲染 Markdown**（P6 第八段）；⚠️ `MarkdownRenderer.render` 第 5 参
 *   **必须是 `Component`**（自己养一个，别借模块的 —— 面板比模块活得久）。
 * · **不把 key 显示出来**：面板只说"配没配"，要改去 设置 → AI 助手。
 */
import { Component, MarkdownRenderer, MarkdownView, type TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { AiError } from '../services/ai';
import type {
  AiAgentHooks,
  AiCallRow,
  AiRef,
  AiSession,
  AiSkill,
  AiToolCall,
  AiToolName,
  AiToolOutcome,
  AiTurn,
  AiTurnUsage,
} from '../services/ai';
import {
  AI_AGENT_LIMITS,
  AI_LIMITS,
  fillSkillParams,
  formatSessionMd,
  formatTurnMd,
  matchSkillByTrigger,
  newSession,
  modelOf,
  parseSkill,
  SKILL_MAX_CHARS,
  skillsDirOf,
  titleOf,
  usageLineFor,
} from '../services/ai';
import { baseName, isInside, joinPath, parentDir, relativeTo, stripExt } from '../core/paths';
import { kbDirsOf, type NoteEntry } from '../core/vault-index';
import { promptText } from './prompt';
import { sleep, stamp } from '../core/util';
import { btn, clear, div, el, icon, iconBtn, span } from './primitives';
// P7.10 · #12：引用选择器与「工作目录」共用那棵轻量目录树（三处共用的唯一实现）
import { folderTree } from './folder-tree';
import { openFloating, openModal, type PanelHandle } from './panel';
import { notifyError, notifyInfo, notifyLight, NOTIFY_MS, notify } from './notify';
import { openSettingsPanel } from './settings-panel';
import { showMenu, type MenuHandle, type MenuItem, type MenuSpec } from './menu';
import { openNewNoteDialog } from './new-note';
// P7.10 · #11：抽屉行的两个会话动作搬去了独立文件（面板红线「不许出现 confirm(」——
// 那条红线 why 的是**动库**确认流；会话管理不是动库，但它确实要弹轻确认框。见那份文件头）
import { exportSessionById, removeSessionById } from './session-actions';
import { makeAiToolPort, type AiPendingEntry } from './ai-tools';

/**
 * **面板一次最多带几份材料**（P7.23 抽成常量）：`addRef` 的手加上限与 `seedRefs`
 * 的带入口都认它 —— 两处曾各写一个字面量 5（批量栏「问 AI（这 N 篇）」的截断口径
 * 也引用这里，别再让第三处出现第二个数）。⚠️ **它不是 `AI_LIMITS.refs`（10）** ——
 * 那个是**提示词层**的上限，面板自己的交互上限一直是 5（"最多一次引用 5 份材料"）。
 */
export const AI_PANEL_REF_CAP = 5;

export function openAiPanel(ctx: WorkbenchContext, seed?: string, seedRefs?: AiRef[]): PanelHandle {
  // ── 头部（一行；建在 openModal 之前：`headActions` 要现成的元素）──
  /**
   * R4（P7.12）：三枚图标（历史对话 / 新对话 / 导出为笔记）**收进「⋯」**（照 §R4 稿）——
   * 打开后一眼只见标题与 ⋯（关窗走模态自带的 ✕）。
   * 「改库需确认」胶囊**整体去掉**（12:55 二拍：安全语义由确认流承担）——
   * 模型信息改挂 ⋯ 菜单顶部一行 + 按钮 tooltip（`refreshHead` 里刷）。
   */
  const moreBtn = iconBtn(
    'ellipsis',
    '更多',
    (evt) => {
      const el0 = evt.currentTarget as HTMLElement;
      const r = el0.getBoundingClientRect();
      const cfg = ctx.settings.get().ai;
      showMenu(
        { x: r.right, y: r.bottom },
        {
          scope: { kind: 'global', label: '经纬助手', icon: 'settings' },
          items: [
            {
              kind: 'hint',
              // P7.22b · #5：面板跑的是 agent 任务 —— 显示它**实际用的**模型（任务级映射命中就用映射）
              label: ctx.ai.isConfigured() ? `模型：${modelOf(cfg, 'agent')}` : '还没配置 AI（设置 → AI 助手）',
            },
            { kind: 'item', icon: 'history', label: '历史对话', run: () => void toggleDrawer() },
            { kind: 'item', icon: 'square-pen', label: '新对话', run: () => newChat() },
            { kind: 'item', icon: 'download', label: '导出为笔记', run: () => exportSession() },
            // P7.21b · #6 技能工坊 v0：这一段对话 + 当前白名单 → 库内 skills/ 的一个 .md
            { kind: 'item', icon: 'package', label: '把本段对话存成能力包', run: () => void saveAsSkill() },
          ],
        },
      );
    },
    { cls: 'kbw-ai-morebtn' },
  );

  const h = openModal({ title: '经纬助手', width: 'normal', headActions: [moreBtn] });

  /** 已经问过的几轮（「重试」的上下文就是它）。**含恢复进来的** */
  const turns: AiTurn[] = [];
  /** 与 `turns` 对齐的气泡元素 —— 恢复进来的轮次是 `null`（静态重画、没有操作按钮） */
  const bubbles: (HTMLElement | null)[] = [];
  /** 与 `turns` 对齐的用户气泡（重试截断时两半一起摘） */
  const qBubbles: (HTMLElement | null)[] = [];
  /** 当前活跃的那个 AI 气泡（新的气泡出现时它已经画完，不用收起 —— 留着变量给"跳过"提示） */
  let liveBox: HTMLElement | null = null;
  /** 正在跑一轮（等模型 / 等确认都算） */
  let busy = false;
  /** 在飞的那一轮的 AbortController（「停止」/ 关面板 / 新对话时 abort） */
  let ac: AbortController | null = null;
  /** 待确认卡等着时锁输入（那批动作还没落定） */
  let pendingLock = false;
  /** 在等用户点确认卡（关面板时要把它按"全不执行"收干净） */
  let pendingAbort: (() => void) | null = null;
  /** 当前会话（懒建：第一次成功一轮才落一份）。载入旧会话会把它换掉 */
  let session: AiSession | null = null;
  /** 输入框上面那排引用胶囊（`@` 引用） */
  let refs: AiRef[] = [];
  /**
   * **本次对话的工作目录**（P7.10 · #12；相对库根，`''` = 全库 = 没限定）。
   * 与 `refs` / `activeSkill` 同级：都是"这一段对话的模式"—— 换对话 / 载入旧会话时清掉。
   */
  let scopeDir = '';
  /** 「会话没存上」只吵一次 */
  let saveWarned = false;
  /** 恢复是异步的（读盘）——`ask()` 起手要等它 */
  let restoreDone: Promise<void> | null = null;
  /**
   * 轮次序号（防"跑到一半被新对话顶掉"）。
   * 🔴 `ask()` 在几个 `await` 之间会让出线程，用户完全可能在这中间点「新对话」
   * 或载入另一段会话 —— 于是"上一轮"的收尾会往刚清空的界面里塞一条不属于它的
   * 轮次（还会被后面的 persist 存进新会话）。每个 await 之后对一下号即可。
   */
  let turnSeq = 0;
  /** 正文段之间的渲染串行链（打字机回放 / Markdown 渲染按顺序落位） */
  let proseChain: Promise<void> = Promise.resolve();
  /** 历史抽屉（开着的时候这两个元素挂在 body 里） */
  let drawerEl: HTMLElement | null = null;
  let scrimEl: HTMLElement | null = null;
  /** 面板还开着吗（每个 await 之后都要问一句 —— 见下面 `alive` 用法） */
  let alive = true;
  h.disposer.add(() => {
    alive = false;
    ac?.abort(); // 在飞的那次到此为止
    pendingAbort?.(); // 等着确认的那批：按"全不执行"收干净
  });

  /** 面板自己的 `Component`（`MarkdownRenderer.render` 第 5 参必须是它；别借模块的） */
  const mdComponent = new Component();
  mdComponent.load();
  h.disposer.add(() => mdComponent.unload());

  // ── 输入区 ──
  const input = el('textarea', {
    cls: 'kbw-ai-input',
    // P7.10 · #12 输入行修整：**一行起**（+ CSS 对称内边距 → placeholder 上下居中）
    // P7.21b：placeholder 里带一句「打 / 挑能力包」（入口要能被发现 —— 与"边界看得见"同一条纪律）
    attr: { rows: '1', placeholder: '说一句想怎么整理…（打 / 挑能力包）' },
  });
  /** 发送 / 停止**同一枚按钮**（就地变文案 —— 少一枚元素，少一处对不齐） */
  const askBtn = btn({ cls: 'kbw-btn is-primary', text: '问一下' });
  askBtn.addEventListener('click', () => {
    if (busy) {
      ac?.abort();
      return;
    }
    void ask();
  });
  input.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' || evt.shiftKey) return;
    /**
     * P7.21b：`/` 菜单开着时 **Enter = 选中过滤后的第一项**（不是发送）——
     * 菜单不抢焦点（`keepFocus`），Enter 自然落进这个输入框；而"打完 /词 按回车"
     * 就是过滤式命令菜单最顺手的一条路（对齐常见 slash 面板的手感）。
     */
    if (slashMenu && slashPickFirst) {
      evt.preventDefault();
      slashPickFirst();
      return;
    }
    evt.preventDefault();
    void ask();
  });
  /** 输入变化：`/` 菜单 + 触发词自动挂载（P7.21b；两条都在这一个口子上） */
  input.addEventListener('input', () => {
    afterInputChanged();
  });

  /**
   * 输入框变了之后要办的事（P7.21b）—— `input` 事件与"程序性改值"（发完清空 /
   * 点示例问法 / 带 seed 开面板）两处共用，别只在事件里接（那样"发送后清空"会漏掉）。
   */
  function afterInputChanged(): void {
    const v = input.value;
    if (v.trim() === '') triggerMuted = null; // 空输入 = 解除"别再挂它"
    void updateSlashMenu(v);
    scheduleAutoMount();
  }

  const log = div({ cls: 'kbw-ai-log' });
  /** 引用胶囊那一排（建在输入框上方；有引用才占位）；能力包与工作目录的胶囊也画在这一排 */
  const refRow = div({ cls: 'kbw-ai-refrow' });

  /**
   * R4（P7.12）：底部三枚（@ 引用 / 工作目录 / 能力包）**收进「＋」**（照 §R4 稿）——
   * 一个入口三个动作；状态胶囊照旧常驻在输入框上方（"AI 的边界一直看得见"那条不变）。
   */
  const plusBtn = btn({ cls: ['kbw-btn', 'is-ghost', 'kbw-ai-plusbtn'] });
  plusBtn.setAttribute('aria-label', '引用笔记 / 工作目录 / 能力包');
  plusBtn.setAttribute('title', '引用笔记 / 工作目录 / 能力包');
  plusBtn.appendChild(icon('plus', 14));
  plusBtn.addEventListener('click', (evt) => {
    const el0 = evt.currentTarget as HTMLElement;
    const r = el0.getBoundingClientRect();
    showMenu(
      { x: r.left, y: r.bottom },
      {
        scope: { kind: 'global', label: '这次对话' },
        items: [
          { kind: 'item', icon: 'at-sign', label: '引用一篇笔记…', hint: '或当前选区', run: () => openRefPicker() },
          {
            kind: 'item',
            icon: 'folder',
            label: '工作目录…',
            hint: '这次对话的搜/读/挑/搬收在这里',
            run: () => openWorkDirPicker(),
          },
          {
            kind: 'item',
            icon: 'package',
            label: '能力包…',
            hint: '给 AI 装一个"只做某件事"的指令包',
            run: () => void openSkillPicker(),
          },
        ],
      },
    );
  });
  let activeSkill: AiSkill | null = null;
  /**
   * 这个包**是怎么挂上的**（P7.21b）：
   * · `'manual'` = 用户显式选的（`＋ → 能力包…` 或 `/` 菜单）—— 一直挂着，直到换/撤/新对话；
   * · `'trigger'` = **触发词自动挂载**的 —— 胶囊上写明来源；
   *   **存活 = "输入框里的文字还命中它"**（文字不命中了/清空了就自动撤下 ——
   *   它的解释永远是"这段文字命中了触发词"，文字走了它就该走）。
   */
  let skillSource: 'manual' | 'trigger' = 'manual';
  /**
   * 用户刚把**触发词挂上的**那个包 ✕ 掉了 —— 这段文字里别再自动挂它
   *（输入清空 / 文字不再命中时解除；见 `runAutoMount`）。
   */
  let triggerMuted: string | null = null;
  /** 自动挂载的防抖定时器（每敲一个字就查一遍盘太吵） */
  let autoMountTimer: ReturnType<typeof setTimeout> | null = null;
  /** `/` 命令菜单（开着的时候可 `refresh` 就地换过滤结果；`closed` 后置空） */
  let slashMenu: MenuHandle | null = null;
  /**
   * `/` 菜单**当前过滤结果的第一项**怎么选（P7.21b）—— 菜单不抢焦点（`keepFocus`），
   * 所以 Enter 落在输入框上；输入框的 keydown 用它把"回车 = 选中第一项"接起来。
   * 菜单关了就置空（防"菜单没了、回车还去选"）。
   */
  let slashPickFirst: (() => void) | null = null;
  paintRefs();

  /**
   * **开场引导**（P7.0a 批 1⑩；P7.3b 改短）：一句说明 + 2–3 个**按当前库现算**的示例。
   * ⚠️ 先**同步**画出来（既有判据在 `openAi()` 之后不 await 就数子节点）；
   * 恢复出旧对话时摘掉（那属于"第一次打开"）。
   */
  let intro: HTMLElement | null = paintIntro();
  const composer = div(
    { cls: 'kbw-ai-composer' },
    refRow,
    div(
      { cls: 'kbw-ai-composer-row' },
      plusBtn, // R4：@ / 工作目录 / 能力包 三合一
      input,
      div({ cls: 'kbw-ai-send' }, askBtn),
    ),
  );
  const body = div({ cls: 'kbw-ai-body' }, log, composer);
  h.body.appendChild(body);

  if (seed && seed.trim() !== '') {
    input.value = seed;
    // P7.21b：带 seed 开面板（编辑器右键那条路）也可能命中触发词 —— 走一遍输入处理
    afterInputChanged();
  }
  /**
   * **带进来的引用**（5.3 右键「问 AI」/ 写作辅助那条路：那一篇 / 那一段选区已经作为 `@` 引用带上）——
   * 引用要**在面板里显形**（胶囊），别只塞进 seed 文本：用户得看得见"这一问带了什么材料"。
   */
  if (seedRefs && seedRefs.length > 0) {
    refs = seedRefs.slice(0, AI_PANEL_REF_CAP);
    paintRefs();
  }

  // ────────────────────────────────────────────────────────────
  // 会话恢复（P7.3a 5.1a）+ 历史抽屉（P7.3b）
  // ────────────────────────────────────────────────────────────
  restoreDone = restore();

  async function restore(): Promise<void> {
    const last = await ctx.ai.sessions.latest();
    if (!alive || !last || last.turns.length === 0) return;
    loadInto(last);
  }

  /** 把一段会话载入面板（清屏 + 静态重画 + 换成当前会话） */
  function loadInto(s: AiSession): void {
    turnSeq += 1;
    for (const b of bubbles) b?.remove();
    for (const b of qBubbles) b?.remove();
    turns.length = 0;
    bubbles.length = 0;
    qBubbles.length = 0;
    liveBox = null;
    session = s;
    // 载入旧会话 = 换了一段上下文：能力包与工作目录跟着清（它们不属于那条会话的记录）
    activeSkill = null;
    skillSource = 'manual';
    triggerMuted = null;
    scopeDir = '';
    paintRefs();
    for (const t of s.turns) {
      turns.push(t);
      bubbles.push(null); // 恢复的轮次没有气泡引用（不带操作按钮）
    }
    intro?.remove();
    intro = null;
    clear(log);
    paintRestored(s);
    input.focus();
  }

  /**
   * 把一段会话**静态重画**（`.kbw-ai-hist` 一整套自己的类名）。
   * 🔴 刻意不复用 `.kbw-ai-bubble` / `.kbw-ai-plan` 这些活轮次的类 —— 那些选择器
   * 是**别的判据与交互**的锚点（活表勾选态、待确认卡…），历史轮不该混进去。
   */
  function paintRestored(s: AiSession): void {
    const wrap = div({ cls: 'kbw-ai-hist' });
    wrap.appendChild(div({ cls: 'kbw-ai-hist-head', text: '上次的对话' }));
    for (const t of s.turns) {
      wrap.appendChild(div({ cls: 'kbw-ai-hist-q', text: t.question }));
      const a = div({ cls: 'kbw-ai-hist-a' });
      wrap.appendChild(a);
      if (t.reply) void renderReply(a, t.reply);
      else a.textContent = '（没有回话）';
      for (const line of historiesOf(t)) {
        wrap.appendChild(div({ cls: 'kbw-ai-hist-row', text: line }));
      }
      /**
       * 恢复出来的轮次也带**用量脚注**（独立审查 🟢7：`AiTurn.usage` 的注释写着
       * "历史/导出里也看得到"，而恢复那一侧原先不画 —— 注释与实现得同源）。
       * 单价现取设置（单价改过之后，历史里显示的费用是按**当前**单价算的，
       * 所以那一行只写 token 与费用估算，不假装是"当时花的钱"）。
       */
      if (t.usage) {
        const cfg = ctx.settings.get().ai;
        const bits = [usageLineFor(cfg, 'agent', t.usage)];
        if (t.skill) bits.push(`能力包：${t.skill}`);
        wrap.appendChild(div({ cls: ['kbw-ai-hist-row', 'kbw-ai-usage'], text: bits.join(' · ') }));
      }
    }
    log.appendChild(wrap);
    scrollLog();
  }

  /** 一轮在历史里那一行动作摘要（agent 轮取执行结果；v1 的建议取原表） */
  function historiesOf(t: AiTurn): string[] {
    if (t.steps && t.steps.length > 0) {
      return t.steps
        .flatMap((s) => s.items.map((it) => it.outcome.summary))
        .filter((x) => x.trim() !== '')
        .slice(0, 8);
    }
    return t.plan.rows.map((r) => `${r.rel} → ${r.dirRel}${r.why ? `（${r.why}）` : ''}`);
  }

  /** 会话落盘（每次成功一轮后调；失败只吵一次） */
  async function persist(): Promise<void> {
    if (!session) return;
    session.turns = turns.slice();
    session.updatedAt = Date.now();
    if ((session.title === '新对话' || session.title === '') && turns[0]) {
      session.title = titleOf(turns[0].question);
    }
    try {
      session = await ctx.ai.sessions.save(session);
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        notifyError('会话没存上', e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** 「新对话」：清屏开新的一段（旧的那份已经落盘，不算删） */
  function newChat(): void {
    ac?.abort();
    pendingAbort?.();
    turnSeq += 1;
    closeDrawer();
    for (const b of bubbles) b?.remove();
    for (const b of qBubbles) b?.remove();
    turns.length = 0;
    bubbles.length = 0;
    qBubbles.length = 0;
    liveBox = null;
    session = null;
    refs = [];
    // 能力包与工作目录也清掉：那是"这一段对话在干什么"的模式，新对话 = 重新选
    activeSkill = null;
    skillSource = 'manual';
    triggerMuted = null;
    scopeDir = '';
    paintRefs();
    clear(log);
    intro = paintIntro();
    input.focus();
  }

  // ── 历史抽屉（左上角图标）────────────────────────────────────
  async function toggleDrawer(): Promise<void> {
    if (drawerEl) {
      closeDrawer();
      return;
    }
    const metas = await ctx.ai.sessions.list();
    if (!alive) return;
    if (drawerEl) return; // 这中间又点了一下
    drawerEl = div({ cls: 'kbw-ai-drawer' });
    drawerEl.appendChild(div({ cls: 'kbw-ai-drawer-head', text: '历史对话' }));
    /**
     * **「＋ 新建对话」**（P7.9 · ⑦b，用户原话确认"没找到入口"）：抽屉顶部一枚**全宽**按钮 ——
     * 头部那枚 ✎ 保留（行为不变），这里给"正翻着历史、想开一段新的"一个顺手的口。
     * 点了走既有 `newChat()`（它自己会 `closeDrawer()`，不另写清屏逻辑）。
     */
    drawerEl.appendChild(
      btn({
        cls: ['kbw-btn', 'kbw-ai-drawer-new'],
        text: '＋ 新建对话',
        on: { click: () => newChat() },
      }),
    );
    const list = div({ cls: 'kbw-ai-drawer-list' });
    if (metas.length === 0) {
      list.appendChild(div({ cls: 'kbw-ai-drawer-empty', text: '还没有其它对话' }));
    }
    for (const m of metas) {
      /**
       * 行 = **容器 + 主按钮 + 两枚行内动作**（P7.10 · #11）。
       * 为什么拆出主按钮：`button` 里不许嵌 `button`（HTML 规范；点击冒泡也会打架）——
       * 主按钮管"载入这一段"，右边两枚管「导出为笔记 / 删除对话」。
       * ⚠️ `.kbw-ai-sess` 留在**容器**上：`is-active` 与探针/用例按它数行、认高亮的口径都不变。
       * ⚠️ 两枚动作**默认隐藏**（`styles/ai.css` 的 opacity 档），行 hover / focus-within 才现
       *（二拍④；键盘 Tab 进来也会显形 —— `focus-within`）。
       */
      const item = div({ cls: ['kbw-ai-sess', m.id === session?.id ? 'is-active' : null] });
      const pick = btn({ cls: 'kbw-ai-sess-pick', attr: { title: m.title } });
      pick.appendChild(span({ cls: 'kbw-ai-sess-t', text: m.title }));
      pick.appendChild(span({ cls: 'kbw-ai-sess-m', text: `${stampOf(m.updatedAt)} · ${m.turnCount} 轮` }));
      item.appendChild(pick);
      const acts = span({ cls: 'kbw-ai-sess-acts' });
      acts.appendChild(iconBtn('download', '导出为笔记', () => void exportSessionById(ctx, m.id)));
      acts.appendChild(
        iconBtn('trash-2', '删除对话', () => {
          /**
           * ⚠️ **删的是当前载入的那一段时，光删文件不够**（独立审 🟡1）：面板的 `session`
           * 还指着它，下一轮 `persist()` 会把整段原样写回来（复活）。所以真删掉之后
           * 把当前段也**真的收掉** —— 走 `newChat()`（清屏 + 清 turns + 清引用/能力包/工作目录），
           * 语义与确认框里那行"面板会一起清空"一致。非当前段则照旧只刷抽屉。
           */
          const wasActive = m.id === session?.id;
          void removeSessionById(ctx, m.id, m.title, { active: wasActive }).then((removed) => {
            if (!removed) return;
            if (wasActive) {
              newChat();
              return;
            }
            // 其余情况：把抽屉刷新一遍（走既有那条重新 list() 的路，不另写一份渲染）
            if (!drawerEl) return;
            closeDrawer();
            void toggleDrawer();
          });
        }),
      );
      item.appendChild(acts);
      /**
       * 载入的监听挂在**容器**上（不是主按钮）—— "点整行载入"的手感不变（探针与
       * 既有用例点的都是 `.kbw-ai-sess`）；acts 里的两枚按钮靠 `closest` 守卫排掉。
       * 主按钮照样留着：它是键盘与语义载体（Tab 停在它上面，Enter 触发 click 冒泡到这儿）。
       */
      item.addEventListener('click', (evt) => {
        if ((evt.target as HTMLElement | null)?.closest?.('.kbw-ai-sess-acts')) return;
        void pickSession(m.id);
      });
      list.appendChild(item);
    }
    drawerEl.appendChild(list);
    scrimEl = div({ cls: 'kbw-ai-scrim' });
    scrimEl.addEventListener('mousedown', closeDrawer);
    body.appendChild(scrimEl);
    body.appendChild(drawerEl);
  }

  function closeDrawer(): void {
    drawerEl?.remove();
    scrimEl?.remove();
    drawerEl = null;
    scrimEl = null;
  }

  async function pickSession(id: string): Promise<void> {
    if (busy) {
      notifyInfo('先等这一轮跑完，或点「停止」');
      return;
    }
    const s = await ctx.ai.sessions.load(id);
    if (!alive) return;
    if (!s) {
      notifyError('这段对话读不出来', '文件可能在，但格式认不出');
      return;
    }
    closeDrawer();
    loadInto(s);
  }

  /**
   * 抽屉行的两个动作（P7.10 · #11）在 `ui/session-actions.ts` ——
   * 搬家原因见那份文件头（面板有「不许出现 confirm(」的红线；会话管理要轻确认但不动库）。
   */

  // ────────────────────────────────────────────────────────────
  // 开场引导（P7.0a 批 1⑩；P7.3b 改短）
  // ────────────────────────────────────────────────────────────
  /** 按当前库现算的示例问法（纯本地读索引，不调模型） */
  function introExamples(): string[] {
    const es = ctx.index.notes();
    const out: string[] = [];
    const inbox = es.filter((e) => e.effectivePosition === '00_Inbox').length;
    if (inbox > 0) out.push(`把收件箱里那 ${inbox} 篇按内容归位到合适的目录`);
    const loose = es.filter((e) => e.effectivePosition === '').length;
    if (loose > 0) out.push(`库根下散着 ${loose} 篇，看看它们该放哪`);
    if (out.length < 2) out.push('哪些笔记写得差不多了，可以归档了？');
    if (out.length < 3) out.push('挑几篇位置不太对的，给我一个搬运方案');
    return out.slice(0, 3);
  }

  function paintIntro(): HTMLElement {
    const box = div({ cls: ['kbw-ai-bubble', 'is-ai', 'kbw-ai-intro'] });
    const lead = div({ cls: 'kbw-ai-intro-lead' });
    lead.appendChild(icon('sparkles', 15, 'kbw-ai-intro-ico'));
    lead.appendChild(span({ text: '我能读库、查笔记、整理归类 —— 动库前都会让你确认。' }));
    box.appendChild(lead);
    const examples = div({ cls: 'kbw-ai-intro-ex' });
    for (const q of introExamples()) {
      const ex = btn({ cls: 'kbw-btn is-ghost kbw-ai-ex' });
      ex.appendChild(icon('chevron-right', 12, 'kbw-ai-ex-ico'));
      ex.appendChild(span({ text: q }));
      ex.addEventListener('click', () => {
        // 只填进输入框、**不自动发** —— 发不发是用户的事
        input.value = q;
        input.focus();
        // P7.21b：程序性改值也要走一遍输入处理（示例问法可能命中触发词）
        afterInputChanged();
      });
      examples.appendChild(ex);
    }
    box.appendChild(examples);
    log.appendChild(box);
    return box;
  }

  // ────────────────────────────────────────────────────────────
  // `@` 引用（P7.3a 5.1a）：一篇笔记 / 当前编辑器里的选区
  // ────────────────────────────────────────────────────────────
  /**
   * 「当前选区」：两条路，缺一不可（真机探针实测，2026-10-02）——
   * ① 活动视图就是 markdown；② 退回**扫一遍 markdown 叶、从后往前找第一片
   * 还留着选区的**（打开面板会把活动叶切成工作台，而 CodeMirror 的选区还在）。
   */
  function currentSelection(): { path: string; title: string; text: string } | null {
    const pick = (view: MarkdownView | null | undefined): { path: string; title: string; text: string } | null => {
      const ed = view?.editor as unknown as { getSelection?: () => string } | undefined;
      const text = String(ed?.getSelection?.() ?? '');
      const file = view?.file ?? null;
      if (!file || text.trim() === '') return null;
      return { path: file.path, title: file.basename, text };
    };
    try {
      const direct = pick(ctx.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null);
      if (direct) return direct;
      const leaves = ctx.app.workspace.getLeavesOfType('markdown');
      for (let i = leaves.length - 1; i >= 0; i -= 1) {
        const hit = pick(leaves[i].view as MarkdownView | undefined);
        if (hit) return hit;
      }
      return null;
    } catch {
      return null;
    }
  }

  function labelOfRef(r: AiRef): string {
    if (r.kind === 'selection') return `《${r.title}》的选区`;
    if (r.kind === 'folder') return `《${r.title}》（文件夹）`;
    return r.title;
  }

  function addRef(r: AiRef): void {
    if (refs.some((x) => x.kind === r.kind && x.path === r.path)) {
      notifyInfo('这份材料已经引用过了');
      return;
    }
    if (refs.length >= AI_PANEL_REF_CAP) {
      notifyInfo(`最多一次引用 ${AI_PANEL_REF_CAP} 份材料`);
      return;
    }
    refs.push(r);
    paintRefs();
  }

  function paintRefs(): void {
    clear(refRow);
    /**
     * 能力包胶囊**排在最前**（它是"整段对话的模式"，比单份引用更"大"）——
     * 有它就必须可见：用户忘了自己带着一个只开三个工具的能力包时，
     * "为什么这次它做不了那件事"就变得没法解释。
     */
    if (activeSkill) {
      const chip = span({ cls: 'kbw-ai-ref kbw-ai-skillchip' });
      chip.appendChild(icon('package', 12, 'kbw-ai-ref-ico'));
      /**
       * **来源写明**（P7.21b）：触发词自动挂上的 → 胶囊上带「（触发词）」——
       * "为什么挂着"必须一直看得见（与"能力包常驻可见"同一条纪律）。
       */
      const byTrigger = skillSource === 'trigger';
      chip.appendChild(
        span({ cls: 'kbw-ai-ref-label', text: `能力包：${activeSkill.name}${byTrigger ? '（触发词）' : ''}` }),
      );
      const tip: string[] = [];
      if (byTrigger) tip.push('输入的话命中了它的触发词，自动挂上了；点 ✕ 撤掉（这段文字里不再自动挂）');
      if (activeSkill.tools) tip.push(`只开这些工具：${activeSkill.tools.join('、')}`);
      if (tip.length > 0) chip.setAttribute('title', tip.join('；'));
      chip.appendChild(
        btn({
          cls: 'kbw-ai-ref-x',
          text: '✕',
          on: {
            click: () => {
              // 撤掉一个"触发词挂上"的：这段文字里别再自动挂它（清空 / 不再命中时解除）
              if (byTrigger && activeSkill) triggerMuted = activeSkill.path;
              activeSkill = null;
              skillSource = 'manual';
              paintRefs();
            },
          },
        }),
      );
      refRow.appendChild(chip);
    }
    /**
     * **工作目录胶囊**（P7.10 · #12）：选了就**常驻可见** —— 与能力包同一条理由
     * （"AI 的边界"用户必须一直看得出）；✕ = 清掉、恢复全库。
     */
    if (scopeDir !== '') {
      const chip = span({ cls: 'kbw-ai-ref kbw-ai-dirchip' });
      chip.appendChild(icon('folder', 12, 'kbw-ai-ref-ico'));
      chip.appendChild(span({ cls: 'kbw-ai-ref-label', text: `工作目录：${scopeDir}` }));
      chip.setAttribute('title', '这次对话的搜 / 读 / 挑 / 搬都收在这个目录下；点 ✕ 恢复全库');
      chip.appendChild(
        btn({
          cls: 'kbw-ai-ref-x',
          text: '✕',
          on: {
            click: () => {
              scopeDir = '';
              paintRefs();
            },
          },
        }),
      );
      refRow.appendChild(chip);
    }
    for (const r of refs) {
      const chip = span({ cls: 'kbw-ai-ref' });
      chip.appendChild(span({ cls: 'kbw-ai-ref-label', text: labelOfRef(r) }));
      const x = btn({
        cls: 'kbw-ai-ref-x',
        text: '✕',
        on: {
          click: () => {
            refs = refs.filter((v) => v !== r);
            paintRefs();
          },
        },
      });
      chip.appendChild(x);
      refRow.appendChild(chip);
    }
    /**
     * 🔴 **显隐要把能力包也算上**（独立审查 🔴1 抓的真缺陷）：这一排原先只看 `refs.length` ——
     * 于是"只选了能力包、没引用任何笔记"（最常用的那条路）时整排 `display:none`，
     * 胶囊看不见、✕ 也点不到，而**能力包在整段对话里一直生效**（它还在收窄工具目录）。
     * 契约（本文件上面那句注释、§11 增补、冻结说明 §4.5）写的是"**常驻可见**"——
     * 一行之差，三处白纸黑字全落空。
     */
    refRow.style.display = refs.length > 0 || activeSkill !== null || scopeDir !== '' ? '' : 'none';
  }

  /**
   * **能力包挑选器**（P7.3c；P7.21b 起复用一份菜单规格：`＋` 菜单与 `/` 命令两处同源）。
   *
   * 三条口径：
   *  · **读不动的要说出来**：解析失败的文件在菜单里**置灰 + 写明原因**，不静默少一个
   *    （"我明明放了文件，菜单里没有"是最难查的一类）；
   *  · 一个都没有时该项置灰并说明"去哪儿放"（能力包是**库内的数据文件**，不是插件功能）；
   *  · 选中的是**当前内容**（文件可能刚被手改过）—— 所以这里按路径重读一遍再挂上。
   */
  function skillMenuItems(listed: { skills: AiSkill[]; skipped: { file: string; why: string }[] }, filter = ''): MenuItem[] {
    const items: MenuItem[] = [];
    const dirRel = relativeTo(ctx.settings.workbenchDir(), ctx.settings.kbRoot());
    const needle = filter.trim().toLowerCase();
    const shown = needle === '' ? listed.skills : listed.skills.filter((s) => s.name.toLowerCase().includes(needle));
    if (activeSkill && needle === '') {
      items.push({
        kind: 'item',
        label: '不用能力包',
        icon: 'circle-slash',
        run: () => {
          activeSkill = null;
          skillSource = 'manual';
          paintRefs();
        },
      });
      items.push({ kind: 'separator' });
    }
    if (shown.length === 0 && needle !== '') {
      items.push({ kind: 'item', label: `没有叫「${filter}」的能力包`, disabled: '换个词，或看下面的建法' });
    }
    if (listed.skills.length === 0 && listed.skipped.length === 0 && needle === '') {
      /**
       * ⚠️ 置灰理由**不能写死成"库里没有这个目录"**（独立审查 🟢9）：`list()` 在
       * "目录不存在"与"目录在但是空的"两种情况下返回的都是空表 —— 而后者才是常态
       *（用户建了目录、还没放文件）。理由写成上面那句两种情形都成立。
       */
      items.push({ kind: 'item', label: `还没有能力包（放 .md 到 ${dirRel}/skills/）`, disabled: '这个目录里还没有 .md' });
    }
    for (const s of shown) {
      items.push({
        kind: 'item',
        label: s.tools ? `${s.name}（只开 ${s.tools.length} 个工具）` : s.name,
        // P7.21b：`示例问法` 的第一条当提示（"这包适合问什么" —— 只显示，不自动发）
        hint: s.examples.length > 0 ? `例：${s.examples[0]}` : undefined,
        run: () => void pickSkill(s.path),
      });
    }
    for (const bad of listed.skipped) {
      items.push({ kind: 'item', label: `${bad.file}：${bad.why}`, disabled: '这个文件读不出来' });
    }
    return items;
  }

  /** `＋ → 能力包…` 那条路（P7.3c 原有入口；`/` 命令走 `updateSlashMenu`，同一份 items） */
  async function openSkillPicker(): Promise<void> {
    const listed = await ctx.ai.skills.list();
    if (!alive) return;
    const rect = plusBtn.getBoundingClientRect();
    showMenu({ x: rect.left, y: rect.top }, { scope: { kind: 'global', label: '能力包' }, items: skillMenuItems(listed) });
  }

  /**
   * **`/` 命令菜单**（P7.21b · G5）：输入框里打 `/` 就弹能力包菜单；
   * 继续打字 = 就地过滤（`MenuHandle.refresh` 换内容，同一扇菜单不闪）。
   *
   * 口径：只认**行首的 `/` 且后面还没空格**（`^/\S*$`）—— 句子中间的斜杠不算命令；
   * 输入退出这个形状（退格删掉斜杠 / 加了空格）→ 不再管它，菜单让既有的
   * "点外面关 / Esc"兜底（`pick` 之后由菜单自己收）。
   */
  async function updateSlashMenu(v: string): Promise<void> {
    const m = /^\/(\S*)$/.exec(v);
    if (!m) return;
    const filter = m[1] ?? '';
    const listed = await ctx.ai.skills.list();
    if (!alive || input.value !== v) return; // 期间又敲了字：这发作废（下一拍会重来）
    /**
     * 从 `/` 菜单里选中 = 这条 `/命令` 完成了使命：**顺手清掉输入框里的命令文本**
     *（那是命令、不是问题）——只有 `/` 这条路清；`＋ → 能力包…` 那条不清
     *（用户可能已经先写好了问题，再补选一个包）。
     */
    const wrapped = skillMenuItems(listed, filter).map((it) =>
      it.kind === 'item' && it.run
        ? {
            ...it,
            run: (mc: Parameters<NonNullable<MenuItem['run']>>[0]) => {
              input.value = '';
              // 清空也是"输入变了"（G1）：走一遍输入处理 —— 解除 muted、撤下触发词挂的包
              afterInputChanged();
              it.run?.(mc);
              // 选完接着打字（菜单不抢焦点那条路的收尾：鼠标点选后焦点别落到 body 上）
              input.focus();
            },
          }
        : it,
    );
    /** Enter 要选的"第一项"：过滤结果里第一个**可点的**（disabled 的跳过） */
    const firstPickable = wrapped.find((it) => it.kind === 'item' && !it.disabled && it.run);
    slashPickFirst = firstPickable?.run
      ? () => firstPickable.run?.({ evt: new KeyboardEvent('keydown', { key: 'Enter' }) })
      : null;
    const spec: MenuSpec = {
      scope: { kind: 'global', label: '能力包' },
      items: wrapped,
      /**
       * 🔴 **不许抢焦点**（P7.21b · 独立审 R1 的真缺陷）：焦点必须留在输入框 ——
       * 否则打完 `/` 之后敲的字全落进菜单根（非可编辑元素 → 不派 `input` 事件），
       * "继续打字就地过滤"在真机上根本做不到（离线/探针全用程序性改值打字，两道闸门都盲）。
       */
      keepFocus: true,
    };
    if (slashMenu) {
      slashMenu.refresh(spec);
      return;
    }
    const r = input.getBoundingClientRect();
    const handle = showMenu({ x: r.left, y: r.bottom }, spec);
    slashMenu = handle;
    void handle.closed.then(() => {
      if (slashMenu === handle) {
        slashMenu = null;
        slashPickFirst = null;
      }
    });
  }

  /** 从 `/` 菜单或 `＋` 菜单选中一个包：**读当前内容**再挂（文件可能刚被手改过） */
  async function pickSkill(path: string): Promise<void> {
    const s = await ctx.ai.skills.load(path);
    if (!alive) return;
    if (!s) {
      notifyError('这个能力包读不出来', '文件格式或正文有问题 —— 见 AI接口冻结说明里的 skill 格式');
      return;
    }
    await mountSkill(s, 'manual');
  }

  /**
   * **把一个能力包挂上**（P7.21b；手动与触发词两条路共用这一段）。
   *
   * 三件顺带事（全在"用户显式选它"的前提下 —— 触发词那条路只做减法里的减法）：
   *  · `参数槽`：手动选时先弹小表单收值、**替换正文里的 `{{名字}}`**（触发词那条路
   *    **不挂带参数槽的包** —— 正在打字时弹表单是灾难，见 `runAutoMount`）；
   *  · `默认工作目录`：**这次对话还没设**工作目录时才设（库里没这个目录就不设、如实说）；
   *  · `warn`：解析时的提醒照说（"白名单里认不出的名字已忽略"之类）。
   */
  async function mountSkill(s: AiSkill, source: 'manual' | 'trigger'): Promise<void> {
    let mounted = s;
    if (source === 'manual' && s.params.length > 0) {
      const filled = await askSkillParams(s);
      if (!alive) return;
      if (filled === null) return; // 取消填参数 = 不挂（宁可不挂，也别挂个半成品）
      mounted = { ...s, instructions: filled };
    }
    activeSkill = mounted;
    skillSource = source;
    /**
     * `默认工作目录` **也只对"用户显式选它"生效**（独立审 Y1）：两个顺带件
     *（参数槽 / 默认目录）都挂在"手动选"这条路上；触发词自动挂载**不设工作目录** ——
     * 一次打字顺手把整段对话的范围也改了，是"看不见的副作用"（冻结 §4.5 那句
     * "都只对用户显式选它生效"说的就是这条，代码曾经只看 workDir 不看 source）。
     */
    if (source === 'manual' && mounted.workDir !== '' && scopeDir === '') {
      const kbRoot = ctx.settings.kbRoot();
      const allDirs = Array.from(kbDirsOf(ctx.app, kbRoot)).filter((d) => d !== '');
      if (allDirs.includes(mounted.workDir)) {
        scopeDir = mounted.workDir;
        notifyInfo(`这个能力包默认在「${mounted.workDir}」里干活 —— 已设上（可改可清）`);
      } else {
        notifyInfo(`这个能力包默认要「${mounted.workDir}」，但库里没这个目录 —— 没设工作目录`);
      }
    }
    paintRefs();
    if (s.warn) notifyInfo(s.warn);
  }

  /**
   * **参数槽小表单**（P7.21b）：每个槽一个输入框，「挂上」= 替换 `{{名字}}` 后的正文。
   * 返回 `null` = 取消（点 ✕ / 点外面 / Esc 都算 —— 挂个半成品不如不挂）。
   */
  function askSkillParams(s: AiSkill): Promise<string | null> {
    const h = openFloating({ title: `填参数：${s.name}`, anchor: plusBtn });
    h.root.classList.add('kbw-ai-paramform');
    h.body.appendChild(
      div({ cls: 'kbw-ai-dirhint', text: '填的值会替换正文里的 {{名字}}；留空 = 那一处原样留着。' }),
    );
    const inputs = new Map<string, HTMLInputElement>();
    for (const slot of s.params) {
      const row = div({ cls: 'kbw-ai-param-row' });
      row.appendChild(span({ cls: 'kbw-ai-param-label', text: slot }));
      const inp = el('input', {
        cls: 'kbw-input kbw-ai-param-input',
        attr: { type: 'text', placeholder: `{{${slot}}}` },
      }) as HTMLInputElement;
      inputs.set(slot, inp);
      row.appendChild(inp);
      h.body.appendChild(row);
    }
    const okBtn = btn({ cls: ['kbw-btn', 'is-primary'], text: '挂上' });
    const cancelBtn = btn({ cls: 'kbw-btn', text: '取消' });
    h.foot.appendChild(div({ cls: 'kbw-spacer' }));
    h.foot.appendChild(cancelBtn);
    h.foot.appendChild(okBtn);
    return new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        h.close('param');
        resolve(v);
      };
      /** 外路关闭（点外面 / Esc / ✕）也按"取消"收 —— 别让 Promise 悬着 */
      void h.closed.then(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
      okBtn.addEventListener('click', () => {
        const values: Record<string, string> = {};
        inputs.forEach((inp, k) => {
          values[k] = inp.value;
        });
        finish(fillSkillParams(s.instructions, values));
      });
      cancelBtn.addEventListener('click', () => finish(null));
      const first = inputs.values().next().value as HTMLInputElement | undefined;
      first?.focus();
    });
  }

  /**
   * **触发词自动挂载**（P7.21b · G5 ：`/` 菜单 + 自动挂载做成开关，**默认关**）。
   *
   * 口径四条：
   *  · 开关关着 = 一次都不查（默认关；设置 → AI 助手 → 能力包）；
   *  · **`/` 命令模式不参与**（`^/\S*$` —— 那是在选包，不是在说话）；
   *  · **存活 = "文字还命中它"**：文字不命中了 / 清空了 → 自动撤下（见 `skillSource` 的注释）；
   *  · 手动选过的**不会被顶掉**；**带参数槽的包不自动挂**（正在打字时弹表单是灾难），
   *    用户 ✕ 掉某个自动挂的 → 这段文字里不再挂它（`triggerMuted`）。
   */
  function scheduleAutoMount(): void {
    if (autoMountTimer != null) {
      clearTimeout(autoMountTimer);
      autoMountTimer = null;
    }
    if (!ctx.settings.get().ai.triggerAutoMount) return;
    autoMountTimer = setTimeout(() => {
      autoMountTimer = null;
      void runAutoMount();
    }, 300);
  }

  /** 撤下"由触发词挂上"的那个包（手动选的不动 —— 它不是这段话挂上来的） */
  function withdrawTriggerSkill(): void {
    if (activeSkill && skillSource === 'trigger') {
      activeSkill = null;
      skillSource = 'manual';
      paintRefs();
    }
  }

  async function runAutoMount(): Promise<void> {
    if (!alive) return;
    if (!ctx.settings.get().ai.triggerAutoMount) return;
    const text = input.value;
    if (/^\/\S*$/.test(text)) {
      // `/` 命令模式：在选包，不是在说话 —— 也不参与自动挂载；
      // 挂着的触发词包跟着撤（G1：文字已经不含触发词，与"存活 = 文字还命中它"对齐）
      triggerMuted = null;
      withdrawTriggerSkill();
      return;
    }
    if (text.trim() === '') {
      triggerMuted = null;
      withdrawTriggerSkill();
      return;
    }
    const listed = await ctx.ai.skills.list();
    if (!alive || input.value !== text) return; // 期间又敲了字：这发作废
    // 带参数槽的包不参与自动挂载（要填值 —— 让用户手动选）
    const hit = matchSkillByTrigger(
      listed.skills.filter((s) => s.params.length === 0),
      text,
    );
    if (!hit) {
      triggerMuted = null; // 文字不再命中任何触发词 → 解除"别再挂它"
      withdrawTriggerSkill();
      return;
    }
    if (triggerMuted === hit.path) return; // 用户刚 ✕ 掉的就是它
    if (activeSkill?.path === hit.path) return; // 已经挂着同一个（不管来源）
    if (activeSkill && skillSource === 'manual') return; // 手动选的不会被顶掉
    await mountSkill(hit, 'trigger');
  }

  /**
   * `@` 引用选择器（P7.10 · #12：小菜单 → **小面板**）。
   *
   * 四件：顶部搜索 + 左侧目录树（`ui/folder-tree.ts` 三处共用那份）+ 右侧笔记列表
   * + **文件夹可引用**（已拍 Q3：材料 = 该目录下前 N 篇的 文件名 + 路径清单）。
   * 口径：
   *  · 搜索框**空**时列表 = 树上选中目录的**本层**笔记（顺目录翻）；
   *    搜索框**有词**时列表 = 全库按标题/路径过滤（按最近改动倒序，最多 30 条）—— 最快那条路；
   *  · 「引用文件夹」行**只在没搜索时画**（引用的是树上选中的目录；行上写明篇数）；
   *  · 选区（有的话）恒在列表最上，原样保留；**点任何一行 = 加进引用并关面板**（与旧菜单同手感）。
   */
  function openRefPicker(): void {
    const kbRoot = ctx.settings.kbRoot();
    const h = openFloating({ title: '引用进这一问', anchor: plusBtn });
    h.root.classList.add('kbw-ai-refpanel');
    const sel = currentSelection();
    let dirRel = '';
    let query = '';

    const search = el('input', {
      cls: 'kbw-input kbw-ai-refsearch',
      attr: { type: 'text', placeholder: '搜索笔记…' },
    }) as HTMLInputElement;
    const cols = div({ cls: 'kbw-ai-refcols' });
    const treeHost = div({ cls: 'kbw-ai-reftree' });
    const listHost = div({ cls: 'kbw-ai-reflist' });
    h.body.appendChild(search);
    cols.appendChild(treeHost);
    cols.appendChild(listHost);
    h.body.appendChild(cols);

    treeHost.appendChild(
      folderTree(ctx.app, kbRoot, {
        rootRow: '整个知识库',
        onPick: (rel) => {
          dirRel = rel;
          paintList();
        },
      }),
    );

    /** 列表里一行（点 / Enter / Space 都走同一个动作） */
    const pickable = (row: HTMLElement, run: () => void): void => {
      row.addEventListener('click', run);
      row.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          evt.preventDefault();
          run();
        }
      });
    };

    /** 当前目录**本层**的笔记（按名称排） */
    const localNotes = (): NoteEntry[] => {
      // P7.14：按"父目录 = 当前目录（绝对）"判本层 —— 前缀法在空串根（整个库）下无解
      const dirAbs = joinPath(kbRoot, dirRel);
      return ctx
        .index
        .notes()
        .filter((e) => parentDir(e.path) === dirAbs)
        .sort((a, b) => a.basename.localeCompare(b.basename, 'zh'));
    };

    /**
     * 全库搜（标题 / 路径；最近改动倒序）。
     * ⚠️ **`NoteEntry.basename` 本就不含扩展名**（Obsidian 的 `TFile.basename` 语义）——
     * 别再 `stripExt`：那会把「9.16」剥成「9」（P7.10 实测，用户库里真有 `9.16.md`）。
     */
    const searchNotes = (q: string): NoteEntry[] => {
      const needle = q.trim().toLowerCase();
      return ctx
        .index
        .notes()
        .filter((e) => isInside(e.path, kbRoot))
        .filter(
          (e) => e.basename.toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle),
        )
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
    };

    /** 文件夹材料（Q3 拍板）：该目录下前 N 篇的 文件名 + 路径（截断如实说） */
    const FOLDER_REF_CAP = 20;
    function folderRefOf(dirRel0: string): AiRef {
      const dirAbs = joinPath(kbRoot, dirRel0);
      const all = ctx
        .index
        .notes()
        .filter((e) => isInside(e.path, dirAbs))
        .sort((a, b) => b.mtime - a.mtime);
      const shown = all.slice(0, FOLDER_REF_CAP);
      // `e.basename` 已无扩展名（见 searchNotes 上那条注释）—— 直接写
      const lines = shown.map((e) => `- ${e.basename}（${relativeTo(e.path, kbRoot)}）`);
      if (all.length > shown.length) {
        lines.push(`（这个文件夹共 ${all.length} 篇，只列了前 ${FOLDER_REF_CAP} 篇）`);
      }
      const title = dirRel0 === '' ? '整个知识库' : (dirRel0.split('/').pop() ?? dirRel0);
      return { kind: 'folder', path: dirAbs, title, text: lines.join('\n') };
    }

    function paintList(): void {
      clear(listHost);
      // 选区（有才画）恒在列表最上
      if (sel) {
        const row = div({
          cls: ['kbw-ai-refitem', 'is-selection', 'kbw-hover-1'],
          attr: { role: 'button', tabindex: '0', title: sel.path },
        });
        row.appendChild(span({ cls: 'kbw-ai-refitem-t', text: `当前选区（${sel.text.length} 字，选自《${sel.title}》）` }));
        pickable(row, () => {
          addRef({ kind: 'selection', path: sel.path, title: sel.title, text: sel.text.slice(0, AI_LIMITS.refChars) });
          h.close('pick');
        });
        listHost.appendChild(row);
      }
      const searching = query.trim() !== '';
      if (!searching) {
        // 「引用文件夹」行：只认树上选中的目录（搜索态不画 —— 那时"当前目录"没有意义）
        const underN = ctx
          .index
          .notes()
          .filter((e) => {
            const dirAbs = dirRel === '' ? kbRoot : joinPath(kbRoot, dirRel);
            return e.path.startsWith(`${dirAbs}/`);
          }).length;
        const frow = div({ cls: ['kbw-ai-refitem', 'is-folder', 'kbw-hover-1'], attr: { role: 'button', tabindex: '0' } });
        frow.setAttribute('title', `材料 = 这个目录下前 ${FOLDER_REF_CAP} 篇的文件名 + 路径清单`);
        frow.appendChild(icon('folder', 14, 'kbw-ai-refitem-ico'));
        frow.appendChild(
          span({ cls: 'kbw-ai-refitem-t', text: `引用这个文件夹（${dirRel || '整个知识库'} · ${underN} 篇）` }),
        );
        pickable(frow, () => {
          addRef(folderRefOf(dirRel));
          h.close('pick');
        });
        listHost.appendChild(frow);
      }
      const notes = searching ? searchNotes(query) : localNotes();
      if (notes.length === 0) {
        listHost.appendChild(
          div({
            cls: 'kbw-ai-refempty',
            text: searching ? '没搜到' : '这一层没有笔记 —— 点左边的目录往里翻',
          }),
        );
      }
      for (const e of notes) {
        const title = e.basename; // 无扩展名（见 searchNotes 上的注释）
        const row = div({
          cls: ['kbw-ai-refitem', 'kbw-hover-1'],
          attr: { role: 'button', tabindex: '0', title: relativeTo(e.path, kbRoot) },
        });
        row.appendChild(span({ cls: 'kbw-ai-refitem-t', text: title }));
        pickable(row, () => {
          addRef({ kind: 'note', path: e.path, title });
          h.close('pick');
        });
        listHost.appendChild(row);
      }
    }

    search.addEventListener('input', () => {
      query = search.value;
      paintList();
    });
    paintList();
    search.focus();
  }

  /**
   * 「工作目录」选择器（P7.10 · #12）：轻面板 + 库目录树（与引用选择器同一份）。
   * 点节点 = 定这一段的范围，**点完就关**；根行「整个知识库」= 清掉、恢复全库。
   */
  function openWorkDirPicker(): void {
    const kbRoot = ctx.settings.kbRoot();
    const h = openFloating({ title: '这次对话在哪个目录里干活', anchor: plusBtn });
    h.root.classList.add('kbw-ai-dirpanel');
    h.body.appendChild(
      div({
        cls: 'kbw-ai-dirhint',
        text: '选一个目录：这次对话的搜 / 读 / 挑 / 搬都收在它下面。「整个知识库」= 不限定。',
      }),
    );
    h.body.appendChild(
      folderTree(ctx.app, kbRoot, {
        rootRow: '整个知识库',
        selected: scopeDir,
        onPick: (rel) => {
          scopeDir = rel; // ''（整个知识库）= 清掉、恢复全库
          paintRefs();
          h.close('pick');
        },
      }),
    );
  }

  // ────────────────────────────────────────────────────────────
  // 问（agent：流式正文 + 步骤行 + 待确认卡）
  // ────────────────────────────────────────────────────────────
  /** 发送键 / 输入框的忙碌形态（发送 ↔ 停止**同一枚按钮**） */
  function paintBusy(): void {
    askBtn.textContent = busy && !pendingLock ? '停止' : '问一下';
    askBtn.classList.toggle('is-stop', busy && !pendingLock);
    askBtn.toggleAttribute('disabled', pendingLock);
    input.disabled = pendingLock;
    input.placeholder = pendingLock ? '先处理上面的确认，或点「跳过」…' : '说一句想怎么整理…（打 / 挑能力包）';
  }

  /**
   * 问一轮（`opts.q` / `opts.refs` 是「重试」用的）。
   *
   * 一轮 = 一次 `ctx.ai.agent()` 调用；**执行**（含等待确认）全在端口里，
   * 这里只把 `hooks` 报上来的事画进同一个气泡。
   */
  async function ask(opts: { q?: string; refs?: AiRef[] } = {}): Promise<void> {
    if (busy) return;
    /**
     * 🔴 **先进"忙"再 await**（独立审查 🟡3）：恢复是读盘、要 await，而这期间
     * `busy` 还是 false —— 连点两下发送就会**两次都过闸**：两次模型调用、多一条
     * 没有 ops 行、也不在 `turns` 里的孤儿气泡。忙闸必须是同步的第一道动作。
     */
    busy = true;
    if (restoreDone) await restoreDone;
    if (!alive) {
      busy = false;
      return;
    }
    const q = (opts.q ?? input.value).trim();
    if (q === '') {
      busy = false;
      input.focus();
      return;
    }
    if (!ctx.ai.isConfigured()) {
      busy = false;
      paintBusy();
      paintNeedKey();
      return;
    }
    const useRefs = opts.refs ?? refs;
    const mySeq = (turnSeq += 1);
    paintBusy();
    intro?.remove();
    intro = null;
    const qBox = userBubble(q, useRefs);
    log.appendChild(qBox);
    /** 这一轮的活气泡：正文段 / 步骤行 / 待确认卡都长在它里面 */
    const box = div({ cls: ['kbw-ai-bubble', 'is-ai'] });
    liveBox = box;
    log.appendChild(box);
    scrollLog();

    /** 按调用对象找回那一行步骤（onCallStart 建、onCallEnd 更新） */
    const stepRows = new Map<AiToolCall, HTMLElement>();
    let streamEl: HTMLElement | null = null;
    let streamAcc = '';
    let streamHad = false;

    const hooks: AiAgentHooks = {
      onProseStart: () => {
        streamAcc = '';
        streamHad = false;
        streamEl = div({ cls: 'kbw-ai-stream' });
        box.appendChild(streamEl);
        scrollLog();
      },
      onDelta: (d) => {
        streamHad = true;
        streamAcc += d;
        if (streamEl) streamEl.textContent = visibleProse(streamAcc);
        scrollLog();
      },
      onProseEnd: (text, streamed) => {
        const elNow = streamEl;
        streamEl = null;
        const had = streamHad;
        proseChain = proseChain.then(async () => {
          if (!elNow || !alive) return;
          if (!streamed && !had) await typewrite(elNow, text);
          if (!alive) return;
          elNow.textContent = '';
          elNow.classList.remove('kbw-ai-stream');
          elNow.classList.add('kbw-ai-reply');
          await renderReply(elNow, text);
        });
      },
      onCallStart: (call, row) => {
        const line = stepRow(call, row, null);
        stepRows.set(call, line);
        box.appendChild(line);
        scrollLog();
      },
      onCallEnd: (call, row, out) => {
        const line = stepRows.get(call) ?? stepRow(call, row, out);
        if (!stepRows.has(call)) box.appendChild(line);
        updateStepRow(line, call, row, out);
        scrollLog();
      },
    };

    /**
     * 端口带上**能力包的收窄**（`allowTools`）—— 一轮里固定用"这一轮开始时"选中的那个 skill
     *（中途换能力包不该改变正在跑的这一轮）。`null` = 不限制（没选能力包时）。
     */
    /**
     * 端口带上**能力包收窄**（`allowTools`）与**工作目录**（`scopeDir`，P7.10 · #12）——
     * 一轮里固定用"这一轮开始时"的值（中途改不该影响正在跑的这一轮）。
     */
    const port = makeAiToolPort({
      ctx,
      askPending,
      askUser, // P7.21 · #3：模型的澄清提问（轻弹层收一条答案）
      allowTools: activeSkill?.tools ?? null,
      scopeDir,
    });
    const myAc = new AbortController();
    ac = myAc;
    let turn: AiTurn | null = null;
    let err: unknown = null;
    try {
      turn = await ctx.ai.agent({
        question: q,
        history: turns,
        refs: useRefs,
        port,
        hooks,
        signal: myAc.signal,
        skill: activeSkill,
        workDir: scopeDir, // 提示词里说清范围（真正的收窄在 port 里）
      });
    } catch (e) {
      err = e;
    }
    ac = null;
    // 关掉了就什么都不做（连"报个错"都不该做）
    if (!alive) return;
    if (mySeq !== turnSeq) {
      // 这一轮被「新对话」/载入会话顶掉了：界面已经翻篇，别往新屏上补旧的收尾
      busy = false;
      pendingLock = false;
      paintBusy();
      return;
    }
    busy = false;
    pendingLock = false;
    paintBusy();

    /** 这轮干过活吗（真的动过库/跑过工具）—— 决定"半截的一轮"要不要记进会话 */
    const landed = (turn?.steps?.length ?? 0) > 0;
    /**
     * **收尾一轮**（把气泡封口 + 记进 `turns` + 落盘）。
     * 🔴 独立审查 🟡2：agent 是**边答边动库**的 —— 只要 `landed`（哪怕这一轮
     * 后面失败/被停止），它都该进会话：不然"库变了、会话里没记录、这轮不能重试、
     * 下一轮上下文也带不上它"。
     */
    const finalizeTurn = async (t: AiTurn): Promise<void> => {
      await proseChain;
      if (!alive) return;
      if (t.stopped === 'limit') {
        /**
         * **「继续」续跑**（P7.22a · #10）：把"没跑完"变成**可续一拍** ——
         * 点按钮 = 以一句「继续」再发一轮（上一轮的终答已在 `turns` 里，模型看得见
         * 干到哪了；续的那轮 = **新预算**）。照旧也可以自己打「继续」——
         * 按钮只是把那句话说出口的一键（连点由 `ask` 的忙闸挡）。
         */
        box.appendChild(div({ cls: 'kbw-ai-note', text: `已到 ${AI_AGENT_LIMITS.maxSteps} 步上限，先做到这里` }));
        const contBtn = btn({ cls: ['kbw-btn', 'is-small'], text: '继续' });
        contBtn.addEventListener('click', () => {
          // 用过即失效（独立审 🟢10）：否则旧气泡里这枚按钮过后还能再点、白起一轮
          contBtn.disabled = true;
          void ask({ q: '继续' });
        });
        box.appendChild(div({ cls: 'kbw-ai-acts' }, contBtn));
      }
      if (t.parseError) {
        box.appendChild(div({ cls: 'kbw-ai-note', text: '这段没写完，先按聊天看了' }));
      }
      if (t.dropped > 0) {
        box.appendChild(div({ cls: 'kbw-ai-note', text: `另有 ${t.dropped} 条格式不完整，已忽略` }));
      }
      /**
       * **用量脚注**（17.10② 成本可见）：每轮一小行，走服务层给的那份数据。
       * 单价为 0（没填）时不显示金额那一段（`usageLine` 自己处理）—— token 数照显。
       */
      if (t.usage) box.appendChild(usageNote(t.usage));
      box.appendChild(opsRow(t, turns.length));
      turns.push(t);
      bubbles.push(box);
      qBubbles.push(qBox);
      if (input.value.trim() === q) {
        input.value = '';
        // P7.21b：清空也算"输入变了"（触发词挂上的包跟着这段文字走 —— 文字走了它也走）
        afterInputChanged();
      }
      refs = [];
      paintRefs();
      if (!session) session = newSession();
      scrollLog();
      void persist();
    };

    if (err) {
      // agent() 只在"循环还没开始"时抛（配置/形状）；循环里的错会包成 turn 带回来
      if (err instanceof AiError && err.kind === 'cancel') {
        // **用户自己按的「停止」不是错**：留着已经画出来的部分 + 一句"已停止"
        box.appendChild(div({ cls: 'kbw-ai-note', text: '已停止' }));
        scrollLog();
        return;
      }
      if (box.childElementCount > 0) {
        // 跑到一半出的事：把已经画出来的过程留着，补一句说明
        box.appendChild(div({ cls: ['kbw-ai-note', 'is-error'], text: `没跑完：${errText(err)}` }));
        scrollLog();
        return;
      }
      box.remove();
      paintError(err);
      return;
    }
    if (!turn) {
      box.remove();
      return;
    }
    if (turn.aborted) {
      // 停止发生在"没有网络在飞"的时刻（等确认时被停 / 循环中途 abort）
      box.appendChild(div({ cls: 'kbw-ai-note', text: '已停止' }));
      scrollLog();
      if (landed) await finalizeTurn(turn); // 动过库 → 这一轮要留痕（🟡2）
      return;
    }
    if (turn.failNote != null) {
      box.appendChild(div({ cls: ['kbw-ai-note', 'is-error'], text: `没跑完：${turn.failNote}` }));
      scrollLog();
      if (landed) await finalizeTurn(turn);
      else if (box.childElementCount <= 1) {
        // 什么都没画出来（第一跳就失败）：退回老样子 —— 一个错误气泡
        box.remove();
        paintError(new AiError(turn.failNote, 'http'));
      }
      return;
    }

    // 正常收尾
    await finalizeTurn(turn);
  }

  /**
   * **待确认卡**（端口在「需确认」档时回调进来）：把这一批摆出来等勾选。
   * 返回与传入等长的布尔数组（没勾的 = 跳过）。
   * ⚠️ 三种收场都要收干净：点了执行 / 点了跳过 / 面板关了（`pendingAbort`）。
   *
   * `pendingAuto` = 同一批里**自动档**的条数（它们不进这张卡、直接排队等确认框）——
   * 独立审查 🟡1：混档批次里点「跳过」若还写"什么都没改"，就是在**撒谎**
   * （自动档那几条马上会弹确认框）。
   */
  function askPending(entries: AiPendingEntry[], pendingAuto = 0): Promise<boolean[]> {
    if (!alive || !liveBox) return Promise.resolve(entries.map(() => false));
    const box = liveBox;
    const card = div({ cls: 'kbw-ai-plan' });
    card.appendChild(div({ cls: 'kbw-ai-plan-head', text: `待确认 ${entries.length} 项` }));
    const states = entries.map(() => true);
    entries.forEach((e, i) => {
      const line = div({ cls: 'kbw-ai-row' });
      const cb = el('input', { cls: 'kbw-ai-check', attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = true;
      cb.addEventListener('change', () => {
        states[i] = cb.checked;
        line.classList.toggle('is-off', !states[i]);
        refreshRunLabel();
      });
      line.appendChild(cb);
      line.appendChild(span({ cls: 'kbw-ai-name', text: e.row.name, title: e.row.name }));
      line.appendChild(span({ cls: 'kbw-ai-path', text: e.row.detail, title: e.row.detail }));
      if (e.row.why) line.appendChild(span({ cls: 'kbw-ai-why', text: e.row.why, title: e.row.why }));
      card.appendChild(line);
    });
    const runBtn = btn({ cls: 'kbw-btn is-primary' });
    const skipBtn = btn({ cls: 'kbw-btn is-ghost', text: '跳过' });
    const acts = div({ cls: 'kbw-ai-acts' }, runBtn, skipBtn);
    const refreshRunLabel = (): void => {
      runBtn.textContent = `执行这 ${states.filter(Boolean).length} 项`;
    };
    refreshRunLabel();
    box.appendChild(card);
    box.appendChild(acts);
    scrollLog();

    return new Promise<boolean[]>((resolve) => {
      const finish = (flags: boolean[]): void => {
        pendingAbort = null;
        card.remove();
        acts.remove();
        pendingLock = false;
        paintBusy();
        resolve(flags);
      };
      pendingLock = true;
      paintBusy();
      pendingAbort = () => finish(entries.map(() => false));
      runBtn.addEventListener('click', () => {
        if (!states.some(Boolean)) {
          notify({ kind: 'info', text: '一项都没勾', detail: '勾上要执行的，或者点「跳过」', ms: NOTIFY_MS.info });
          return;
        }
        finish(states.slice());
      });
      skipBtn.addEventListener('click', () => {
        box.appendChild(
          div({
            cls: 'kbw-ai-note',
            text:
              pendingAuto > 0
                ? '已跳过这几项（另有自动档的动作，会在确认框里等你点）'
                : '已跳过（什么都没改）',
          }),
        );
        finish(entries.map(() => false));
      });
    });
  }

  /**
   * **`ask_user` 的轻弹层**（P7.21 · #3）：模型拿不准时问一句，收一条答案喂回循环。
   *
   * 与待确认卡同款的三件：`pendingLock` 锁输入、`pendingAbort` 收干净、只画在当前气泡里 ——
   * 区别是它**轻**：一行问题 + 一个输入框 +「回答 / 跳过」（样式走 `.kbw-ai-ask`）。
   *
   * 口径（与冻结说明同源）：**不设硬超时**；跳过 / 关面板 / 按停止 → 回 `null`
   *（执行体转成"用户跳过"，不当错误）；回车 = 回答。
   */
  function askUser(question: string): Promise<string | null> {
    if (!alive || !liveBox) return Promise.resolve(null);
    const box = liveBox;
    const card = div({ cls: 'kbw-ai-ask' });
    card.appendChild(div({ cls: 'kbw-ai-ask-q', text: question }));
    const input = el('input', {
      cls: 'kbw-input kbw-ai-ask-input',
      attr: { type: 'text', placeholder: '回答一句（也可以跳过）' },
    }) as HTMLInputElement;
    const ansBtn = btn({ cls: ['kbw-btn', 'is-primary', 'is-small'], text: '回答' });
    const skipBtn = btn({ cls: ['kbw-btn', 'is-ghost', 'is-small'], text: '跳过' });
    card.appendChild(input);
    card.appendChild(div({ cls: 'kbw-ai-ask-acts' }, ansBtn, skipBtn));
    box.appendChild(card);
    scrollLog();

    return new Promise<string | null>((resolve) => {
      const finish = (v: string | null): void => {
        pendingAbort = null;
        card.remove();
        pendingLock = false;
        paintBusy();
        resolve(v);
      };
      const submit = (): void => {
        const v = input.value.trim();
        if (v === '') {
          notify({ kind: 'info', text: '还没写回答', detail: '写一句，或者点「跳过」', ms: NOTIFY_MS.info });
          return;
        }
        finish(v);
      };
      ansBtn.addEventListener('click', submit);
      skipBtn.addEventListener('click', () => finish(null));
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' && !evt.shiftKey) {
          evt.preventDefault();
          submit();
        }
      });
      pendingLock = true;
      paintBusy();
      pendingAbort = () => finish(null);
      input.focus();
    });
  }

  // ── 步骤行（agent 的"干活过程"）──────────────────────────────
  const STEP_ICON: Record<string, string> = {
    search: 'search',
    read: 'file-text',
    grep: 'search', // 与 search 同图标（lucide 的 'text-search' 没在验证过的名单里，别赌）
    list: 'list',
    stats: 'pie-chart',
    ask_user: 'message-circle',
    suggest: 'sparkles',
    triage: 'sparkles',
    cleanup: 'trash',
    move: 'folder',
    set_prop: 'pencil',
    set_tags: 'tag',
    create: 'plus',
    delete: 'trash',
  };

  /**
   * 写类（显色一点）vs 读类（淡）—— 见重设计稿「读类淡、写类显」。
   * ⚠️ P7.22a 加的三个写工具（rename / patch_text / append）最初漏在这个集合外
   *（照着"点状补齐"的账：它们渲染成了读类淡色）—— P7.22b 顺路补齐（同一份视觉语义）。
   */
  const WRITE_TOOLS = new Set(['move', 'set_prop', 'set_tags', 'create', 'delete', 'rename', 'patch_text', 'append']);

  function stepRow(call: AiToolCall, row: AiCallRow, out: AiToolOutcome | null): HTMLElement {
    const line = div({
      cls: ['kbw-ai-step', row.danger ? 'is-danger' : null, WRITE_TOOLS.has(call.tool) ? 'is-w' : null],
    });
    line.appendChild(icon(STEP_ICON[call.tool] ?? 'dot', 13, 'kbw-ai-step-ic'));
    line.appendChild(span({ cls: 'kbw-ai-step-t', text: stepText(call, row, out) }));
    const st = span({ cls: 'kbw-ai-step-st' });
    line.appendChild(st);
    if (!out) line.classList.add('is-running');
    else setStepStatus(line, st, out);
    return line;
  }

  function updateStepRow(line: HTMLElement, call: AiToolCall, row: AiCallRow, out: AiToolOutcome): void {
    line.classList.remove('is-running');
    const t = line.querySelector('.kbw-ai-step-t');
    if (t) t.textContent = stepText(call, row, out);
    const st = line.querySelector('.kbw-ai-step-st');
    if (st) setStepStatus(line, st as HTMLElement, out);
  }

  function setStepStatus(line: HTMLElement, st: HTMLElement, out: AiToolOutcome): void {
    clear(st);
    st.appendChild(icon(out.ok ? 'check' : 'ban', 13));
    line.classList.add(out.ok ? 'is-ok' : 'is-bad');
  }

  /** 步骤行文字：跑着的是"在干什么"，落地的是"干出了什么" */
  function stepText(call: AiToolCall, row: AiCallRow, out: AiToolOutcome | null): string {
    if (out) return out.summary;
    const name = row.name;
    switch (call.tool as AiToolName) {
      case 'search': {
        const q = String(call.args.query ?? '').trim();
        const dir = String(call.args.dir ?? '').trim();
        return q !== '' ? `搜索「${q}」…` : `列出 ${dir || '整个库'}…`;
      }
      case 'read':
        return `读《${name}》…`;
      case 'grep': {
        const q = String(call.args.query ?? '').trim();
        const d = String(call.args.dir ?? '').trim();
        return `搜正文「${q}」${d ? `（${d}）` : ''}…`;
      }
      case 'list': {
        const d = String(call.args.dir ?? '').trim();
        return `列目录 ${d || '（当前层）'}${call.args.recursive === true ? '（递归）' : ''}…`;
      }
      case 'stats':
        return '看看库概览…';
      case 'ask_user':
        return `问一句「${String(call.args.question ?? '')}」…`;
      case 'suggest':
        // P7.24 · L2：面板是幕后的（不会"打开给用户看"）—— 如实写"跑到确认卡（等用户点）"
        return '跑整理流水线，到确认卡等你点…';
      case 'triage':
        return '跑 AI 分诊，到确认卡等你点…';
      case 'cleanup':
        return '跑退出清理，到确认卡等你点…';
      case 'move':
        return `搬《${name}》…`;
      case 'set_prop':
        return `改《${name}》的「${String(call.args.key ?? '')}」…`;
      case 'set_tags':
        return `改《${name}》的标签…`;
      case 'create':
        return `新建《${name}》…`;
      case 'delete':
        return `删《${name}》…`;
      default:
        return `${call.tool}…`;
    }
  }

  /**
   * 打字机回放（本地动画，**墙钟封顶 ~600ms**）：长了按比例加大步长。
   * 🔴 按墙钟封顶，不能只数步数（后台窗口里 `setTimeout` 会被节流 —— P7.3a 探针实测）。
   */
  async function typewrite(target: HTMLElement, text: string): Promise<void> {
    if (text === '') return;
    const t0 = Date.now();
    const steps = 16;
    const chunk = Math.max(1, Math.ceil(text.length / steps));
    for (let cut = chunk; cut < text.length + chunk; cut += chunk) {
      if (!alive) return;
      target.textContent = text.slice(0, cut);
      scrollLog();
      if (Date.now() - t0 > 600) return;
      await sleep(16);
    }
  }

  /** 流式期间只显示"信封"之前的人话（模型边写 JSON 边流出来的那一段不摆上台面） */
  function visibleProse(acc: string): string {
    const m = acc.match(/(^|\n)\s*\{\s*"/);
    return m && m.index !== undefined ? acc.slice(0, m.index).trimEnd() : acc;
  }

  function userBubble(text: string, used?: AiRef[]): HTMLElement {
    const box = div({ cls: 'kbw-ai-bubble is-me' });
    box.appendChild(div({ cls: 'kbw-ai-me-text', text }));
    if (used && used.length > 0) {
      box.appendChild(div({ cls: 'kbw-ai-refs-note', text: `（引用：${used.map(labelOfRef).join('、')}）` }));
    }
    return box;
  }

  function errText(err: unknown): string {
    if (err instanceof AiError) return err.hint;
    return String(err);
  }

  /**
   * 一轮的用量脚注（单价现取设置）。
   * R4（P7.12）：**默认收起**成一行「⋯ 用量明细」—— token/费用是技术噪音，
   * 点开才看（照 §R4 稿）；内容照旧由 `usageLine` 出。
   */
  function usageNote(u: AiTurnUsage): HTMLElement {
    const cfg = ctx.settings.get().ai;
    const wrap = div({ cls: ['kbw-ai-note', 'kbw-ai-usage'] });
    const fold = el('button', { cls: ['kbw-ai-usage-fold', 'kbw-hover-1'], attr: { type: 'button' } });
    const body = div({
      cls: 'kbw-ai-usage-body',
      // P7.22b · #5：按「这一轮任务实际用的模型」取单价（agent 任务的任务级映射生效）
      text: usageLineFor(cfg, 'agent', u),
    });
    let open = false;
    const paint = (): void => {
      fold.textContent = open ? '▾ 用量明细' : '⋯ 用量明细';
      body.classList.toggle('is-open', open);
    };
    fold.addEventListener('click', () => {
      open = !open;
      paint();
    });
    paint();
    wrap.appendChild(fold);
    wrap.appendChild(body);
    return wrap;
  }

  function paintError(err: unknown): void {
    const box = div({ cls: 'kbw-ai-bubble is-ai is-error' });
    if (err instanceof AiError) {
      box.appendChild(div({ cls: 'kbw-ai-reply', text: `没问成：${err.hint}` }));
      if (err.detail) box.appendChild(div({ cls: 'kbw-ai-detail', text: err.detail.slice(0, 200) }));
    } else {
      box.appendChild(div({ cls: 'kbw-ai-reply', text: `出错了：${String(err)}` }));
    }
    log.appendChild(box);
    scrollLog();
  }

  /** 一段文字 → Markdown（助手那一侧）。渲染器抛错就退回纯文本（宁可少点样式） */
  async function renderReply(host: HTMLElement, text: string): Promise<void> {
    try {
      await MarkdownRenderer.render(ctx.app, text, host, '', mdComponent);
    } catch (e) {
      console.error('[经纬] AI 回话渲染 Markdown 失败', e);
      host.textContent = text;
    }
    if (alive) scrollLog();
  }

  // ────────────────────────────────────────────────────────────
  // 消息级操作（复制 / 重试 / 引用为笔记）
  // ────────────────────────────────────────────────────────────
  function opBtn(name: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = btn({ cls: ['kbw-btn', 'is-ghost', 'is-small', 'kbw-ai-op'] });
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    b.appendChild(icon(name, 13));
    b.addEventListener('click', onClick);
    return b;
  }

  function opsRow(turn: AiTurn, idx: number): HTMLElement {
    return div(
      { cls: 'kbw-ai-ops' },
      opBtn('copy', '复制', () => void copyTurn(turn)),
      opBtn('rotate-cw', '重试', () => void retryAt(idx)),
      opBtn('file-plus', '引用为笔记', () => quoteTurn(turn)),
    );
  }

  async function copyTurn(turn: AiTurn): Promise<void> {
    const text = turn.reply || turn.question;
    try {
      await navigator.clipboard.writeText(text);
      notifyLight('已复制这一轮');
    } catch {
      notifyError('复制失败', '这个环境不允许访问剪贴板');
    }
  }

  /** 重试：**截断到这一轮**（含）之后重问；带同一批引用回去 */
  async function retryAt(idx: number): Promise<void> {
    if (busy) return;
    const t = turns[idx];
    if (!t) return;
    for (let k = turns.length - 1; k >= idx; k -= 1) {
      bubbles[k]?.remove();
      bubbles.pop();
      qBubbles[k]?.remove();
      qBubbles.pop();
      turns.pop();
    }
    liveBox = null;
    if (session) {
      session.turns = turns.slice();
      void persist();
    }
    await ask({ q: t.question, refs: t.refs ?? [] });
  }

  /** 把这一轮导成一篇笔记（走「新建笔记」那条既有出口） */
  function quoteTurn(turn: AiTurn): void {
    openNewNoteDialog(ctx, { presetTitle: titleOf(turn.question), bodyText: formatTurnMd(turn) });
  }

  /** 「导出为笔记」：整段会话 → 新建笔记对话框（预填标题、不套模板） */
  function exportSession(): void {
    if (turns.length === 0) {
      notifyInfo('还没有对话可以导出');
      return;
    }
    const s: AiSession = session ?? { ...newSession(), turns: turns.slice() };
    openNewNoteDialog(ctx, {
      presetTitle: `AI 对话 ${stamp()}`,
      bodyText: formatSessionMd({ ...s, turns: turns.slice() }),
    });
  }

  /**
   * **把本段对话存成能力包**（P7.21b · #6 技能工坊 v0）。
   *
   * 口径（G7 拍板：**复用"导出为笔记"的既有出口**，不新开写盘路径）：
   *  · 写盘 = `ctx.completion.createNote`（`noTemplate`）—— 与「导出为笔记」同一条；
   *  · 内容 = 这一段对话（与导出同一份 `formatSessionMd`）+ 前言两个键
   *    （`名称` = 用户填的名；`工具白名单` = **当前挂着的包**的那份 —— 没挂就不写 = 不限制）。
   *    前言**不塞进 body**：走 `extraProps` 那条既有口子落进前言（补全开着时它并进
   *    平台那份前言里、关着时 `processFrontMatter` 现建一份）——body 里再写一份
   *    `---…---` 会在"补全开着"时被顶成正文文字，那是静默坏掉的一种形状；
   *  · **重名不覆盖**：`createNote` 的既有口径是自动加序号（`名字 2.md`）——
   *    通知里**把实际落点如实报出来**（"存成了 名字 2"，不假装叫那个名）；
   *  · 写完之后**回读自检**：产物必须过 `parseSkill`（读不回来就当场说，别假装成功）。
   */
  async function saveAsSkill(): Promise<void> {
    if (turns.length === 0) {
      notifyInfo('还没有对话 —— 先问一轮，再把它存成能力包');
      return;
    }
    const title0 = (session?.title && session.title !== '新对话' ? session.title : titleOf(turns[0]?.question ?? '')).trim();
    const name = await promptText({
      title: '把本段对话存成能力包',
      label: '能力包名字（能力包菜单里显示的就是它）',
      value: title0.slice(0, 40),
      primary: '存成能力包',
      validate: (v) => (v.trim() === '' ? '名字不能是空的' : null),
    });
    if (name == null) return;
    const title = name.trim();
    // 技能目录的**唯一拼法**（`skillsDirOf`；别在这儿再拼一份 —— P7.14 那条"禁手拼路径"红线）
    const dirRel = relativeTo(skillsDirOf(ctx.settings.workbenchDir()), ctx.settings.kbRoot());
    const s: AiSession = session ?? { ...newSession(), turns: turns.slice() };
    const body = formatSessionMd({ ...s, turns: turns.slice() });
    const props: Record<string, unknown> = { 名称: title };
    if (activeSkill?.tools) props['工具白名单'] = activeSkill.tools.slice();
    try {
      const made = await ctx.completion.createNote({
        title,
        dirRel,
        noTemplate: true,
        body,
        bodyFrom: '存成能力包',
        extraProps: { props },
      });
      /** 回读自检：产物过不了 parseSkill = "存出来了但读不回来"，如实说（不假装成功） */
      const f = ctx.app.vault.getAbstractFileByPath(made.path);
      const text = f && 'stat' in f ? await ctx.app.vault.cachedRead(f as TFile) : '';
      const parsed = parseSkill(text, stripExt(baseName(made.path)));
      if (!parsed.ok) {
        notifyError('存出来了但读不回来', `${made.path}：${parsed.why}`);
        return;
      }
      const fileBase = stripExt(baseName(made.path));
      const renamed = fileBase !== title;
      /**
       * ⚠️ `renamed` 可能来自两种原因（独立审 G3）：**重名**（`uniquePath` 加序号）或
       * **名字里有不能进文件名的字符**（`sanitize` 换成 `_`）—— 文案别把后者也说成"重名"。
       * 另：对话太长时 `parseSkill` 会把正文**静默截断**到 4000（G2）—— 这半边如实说出来。
       */
      const longNote = body.length > SKILL_MAX_CHARS ? '；这段对话较长，能力包正文有 4000 字上限，超出的部分不会进提示词' : '';
      notify({
        kind: 'success',
        text: `已存成能力包「${parsed.skill.name}」`,
        detail: (renamed
          ? `实际存成了 ${fileBase}.md（重名会加序号、名字里的特殊字符会被规整 —— 没有覆盖任何旧文件）`
          : '在输入框打 / 就能选它（「＋ → 能力包…」也行）') + longNote,
        ms: NOTIFY_MS.long,
      });
    } catch (e) {
      notifyError('存能力包失败', e instanceof Error ? e.message : String(e));
    }
  }

  // ────────────────────────────────────────────────────────────
  // 「还没配置」这一屏（**不报错** —— 新装用户的第一次就是这条路）
  // ────────────────────────────────────────────────────────────
  function paintNeedKey(): void {
    if (log.querySelector('.kbw-ai-needkey')) {
      input.focus();
      return;
    }
    const box = div({ cls: 'kbw-ai-bubble is-ai kbw-ai-needkey' });
    box.appendChild(
      div({ cls: 'kbw-ai-reply', text: '还没配置 AI —— 设置 → AI 助手 里填上 baseURL / 模型 / API key' }),
    );
    box.appendChild(
      div({
        cls: 'kbw-ai-detail',
        text: 'key 存在这台机器的插件 data.json 里，不进知识库（库会同步，key 不该跟着笔记上云）',
      }),
    );
    box.appendChild(
      div(
        { cls: 'kbw-ai-acts' },
        btn({
          cls: 'kbw-btn is-primary',
          text: '打开设置',
          on: {
            click: () => {
              h.close('settings');
              openSettingsPanel(ctx, 'ai');
            },
          },
        }),
      ),
    );
    log.appendChild(box);
    scrollLog();
  }

  /**
   * 头部 ⋯ 的 tooltip：模型信息 + "改库都会过确认流"的边界说明。
   * R4（P7.12）：「改库需确认」胶囊整体撤掉（12:55 二拍：安全语义由确认流承担），
   * 这条信息改挂这里与 ⋯ 菜单顶行。
   */
  function refreshHead(): void {
    const cfg = ctx.settings.get().ai;
    moreBtn.setAttribute(
      'title',
      ctx.ai.isConfigured()
        ? `模型：${modelOf(cfg, 'agent')} · ${hostOf(cfg.baseUrl)}\n读与搜索自动进行；改库前都会弹确认框，最终由你点板`
        : '还没配置 —— 设置 → AI 助手',
    );
  }

  function scrollLog(): void {
    log.scrollTop = log.scrollHeight;
  }

  refreshHead();
  paintBusy();
  if (!ctx.ai.isConfigured()) paintNeedKey();
  input.focus();
  return h;
}

// ── 小工具 ─────────────────────────────────────────────────────
/** 只取主机名显示 —— tooltip 那么点地方，放不下整条 URL */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').split('/')[0] || baseUrl;
  }
}

/** 历史列表里的时间：今天只写时分，其余写月-日 */
function stampOf(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `今天 ${hm}`;
  }
  return `${d.getMonth() + 1}-${two(d.getDate())} ${hm}`;
}
