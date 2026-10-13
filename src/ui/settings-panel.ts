/**
 * ui/settings-panel.ts —— **工作台内置设置面板**（交互规格 §7，P6 第八段收口 · **P7.2a 起七栏**）
 *
 * 点视图右上角 ⚙ 打开。为什么不放 Obsidian 原生设置页（`方案设计.md` §2.7）：
 * 这些都和工作台内容强耦合 —— 改「目录映射」时想对照目录树，改「看板默认值」时想看看板，
 * 做成独立一页会把这些上下文全切断。原生设置页仍留一个**简版**（模块开关 + 打开这里）。
 *
 * 形态：**左栏七项 + 右栏内容**（P6 第八段起六栏、P7.2a 加「首页」）。每一栏自己负责
 * 渲染与清理（返回清理函数），换栏/关面板时把上一栏的订阅收干净 ——
 * 与模块渲染契约同一套规矩（`core/context.ts`）。
 *
 * 「区域重绘」在这里**不适用**：面板是一次性开的浮层，不进 store；它靠 `api.rerender()`
 * 自己重画（各栏都是"值改了就地重画"的形态）。
 *
 * ## P6 第八段（用户第 3、6 条：重新设计 · 视觉与排版）改了三件事
 *
 * ① **八栏 → 六栏**（依据见 `settings/types.ts` 那张表）：合并靠下面那个 `compose()`，
 *    **子块自己的渲染函数一行没改**。
 * ② **每一行那句解释默认收起**（用户原话："简化甚至去除各选项的提示小字"）。
 *    收起的只是**行内那句解释**，两样东西留着：
 *    · **每一栏顶上的那句**（"这一栏是什么、数据在哪"）—— 设计稿里本来就有它，
 *      它也不是"满屏灰字"的来源；
 *    · **鼠标悬停在行标签上的 `title`** —— 收起之后唯一的口径（`kit.row()` 里挂的）。
 *    顶部一枚「显示说明」把所有解释一次性摊开（选择要记住：它是**界面偏好**，
 *    落在插件 `data.json` 的 `showSettingHints`）。
 * ③ **顶部一个搜索框**：输入 → 右栏换成命中清单 → 点一条跳到那一栏并**把那一行点亮**。
 *    ⚠️ 索引是**懒建**的（第一次搜索才把各栏离屏渲染一遍收标签）——
 *    不搜索就一次也不多渲染，代价只落在真用它的人身上。
 *
 * ⚠️ 合并出来的栏里**只有一个 h3**（栏名），子块降级成 `.kbw-set-group` 小节标题 ——
 * 判据在 `tests/specs/automation.ts`（"每栏只有一份标题"）。
 */
import type { WorkbenchContext } from '../core/context';
import { Component, MarkdownRenderer } from 'obsidian';
import { btn, div, el, icon, span } from './primitives';
import { openModal, type PanelHandle } from './panel';
import { Disposer } from '../core/util';
import { group, setTitle, HINT_SEL } from './settings/kit';
import { makeAiSection } from './settings/ai';
import { makeAppearanceSection } from './settings/appearance';
import { makeAutomationSection } from './settings/automation';
import { makeBoardSection } from './settings/board';
import { makeCleanupSection } from './settings/cleanup';
import { makeHelpSection } from './settings/help';
import { makeHomeSection } from './settings/home';
import { makeLogsSection } from './settings/logs';
import { makeRoutesSection } from './settings/routes';
import { makeSnapshotSection } from './settings/snapshot';
import { makeTemplatesSection } from './settings/templates';
import type { SectionApi, SettingsBlock, SettingsSection, SettingsSectionId } from './settings/types';

export type { SettingsSectionId };

/**
 * **七栏**（顺序就是 §7 的顺序；合并的依据与旧 id 的对照见 `settings/types.ts`）。
 * ⚠️ 每栏是**工厂函数**（不是模块级常量）：栏里有"编辑中的草稿/筛选状态"，
 * 那些状态该活一次打开的时间，不该跨面板残留（`settings/routes.ts` 的头注释）。
 */
export function buildSections(): SettingsSection[] {
  return [
    compose(
      'automation',
      '自动化',
      'zap',
      '新建笔记怎么补、什么时候自动归位，以及它查的那张目录表和模板库',
      // ⚠️ 顺序 = "规则 → 它查的表 → 它用的模板"（从小到大）
      [makeAutomationSection(), makeRoutesSection(), makeTemplatesSection()],
    ),
    makeBoardSection(),
    makeHomeSection(),
    makeAppearanceSection(),
    makeAiSection(),
    compose('data', '数据', 'database', '快照、操作日志，与「不用了怎么清干净」的出口', [
      makeSnapshotSection(),
      makeLogsSection(),
      makeCleanupSection(),
    ]),
    makeHelpSection(),
  ];
}

/**
 * 把两个以上的块**并成一栏**（P6 第八段）。
 *
 * 为什么不直接改那几份块的渲染函数：它们各自都从 `setTitle()` 起手，
 * 而栏里只能有一份大标题（否则就是用户 2026-09-27 报的那个"两个标题"）。
 * 在这里做一层"降级子块标题"的包装，那几份业务代码就不用为了布局动一次。
 *
 * **栏顶那份标题从哪儿来**（两条都只产生一个 h3）：
 * · 有子块的名字就是栏名（「自动化」栏里的自动化那块）→ **用它自己那份** ——
 *   它的副标题写着"库内配置在哪儿"（`…/06_工作台/自动化.json`），比这里现编一句有用得多；
 * · 否则（「数据」栏是两个谁都不叫"数据"的块拼的）→ 由这里现画一份。
 */
function compose(
  id: SettingsSectionId,
  label: string,
  icon: string,
  sub: string,
  parts: SettingsBlock[],
): SettingsSection {
  return {
    id,
    label,
    icon,
    sub,
    render(host, api) {
      const own = parts.find((p) => p.label === label);
      if (!own) host.appendChild(setTitle(label, sub));
      const cleanups: (() => void)[] = [];
      // ⚠️ 别叫 `sub` —— 那是上面那个字符串参数的名字（遮蔽之后 TS 会指着别处报错）
      const blockDisposer = new Disposer();
      for (const p of parts) {
        const fn = renderPart(host, p, api, p === own, blockDisposer);
        if (typeof fn === 'function') cleanups.push(fn);
      }
      return () => {
        blockDisposer.dispose();
        for (const f of cleanups) {
          try {
            f();
          } catch (e) {
            console.error(`[经纬] 设置子块 ${id} 卸载出错`, e);
          }
        }
      };
    },
  };
}

/**
 * 把一块渲染进宿主（它自己那份标题要么留着当栏顶、要么降级成小节标题）。
 *
 * 🔴 **三件都要做对，前两件各栽过一次**：
 * ① **必须给它一个"住得下去"的盒子**（`div.kbw-set-block`），不能"渲染到离屏再搬节点"：
 *    有几块的 `paint()` 是 **async** 的（`automation.ts` 要先 `await configs.read()`），
 *    后面的行是 **await 之后**才 append 的 —— 离屏容器那时候已经脱开了，
 *    那些行会**静默落在没人看的地方**（症状：自动化栏里只有标题和提示，开关一个都不见）。
 * ② **标题也常常是 await 之后才建的**（`routes.ts` 那一块就是）→ 渲染返回时它还不存在。
 *    所以降级要**盯着它出现再动手**（`MutationObserver`），出现之后立刻断开。
 * ③ **降级要保住它自己那份文案** —— 别拿 `part.sub` 另写一句：那一句常常是
 *    "这个文件在哪儿"（目录映射那块就是：`库内文件：…/标签-目录映射.json`）。
 *    第一版用 `group(part.label, part.sub)` 重写，**把那句话弄丢了**，
 *    用例报的是"要写清这张表在哪儿"（真机上用户会直接看不到路径）。
 *    ⇒ 做法是**把原来那个 head 就地变成 group**，一个字都不改。
 */
function renderPart(
  host: HTMLElement,
  part: SettingsBlock,
  api: SectionApi,
  keepTitle: boolean,
  disposer: Disposer,
): (() => void) | undefined {
  const box = div({ cls: 'kbw-set-block' });
  host.appendChild(box);
  const clean = part.render(box, api);

  /** 把它那份标题降级成小节标题（栏顶那一份由 `compose` 管）——返回"做完了没有" */
  const demote = (): boolean => {
    if (keepTitle) return true;
    const head = box.querySelector<HTMLElement>('.kbw-set-h');
    if (!head) return false;
    const t = head.querySelector('h3')?.textContent?.trim() ?? part.label;
    const s = head.querySelector('.kbw-set-sub')?.textContent?.trim() ?? '';
    head.replaceWith(group(t, s));
    return true;
  };
  if (!demote()) {
    const mo = new MutationObserver(() => {
      if (demote()) mo.disconnect();
    });
    mo.observe(box, { childList: true, subtree: true });
    disposer.add(() => mo.disconnect());
  }

  return typeof clean === 'function' ? clean : undefined;
}

/** 搜索索引里的一条（懒建，见文件头） */
interface IndexEntry {
  section: SettingsSectionId;
  /** 行标签 / 小节标题 */
  label: string;
  /** 那句解释（收起状态下它就是悬停提示） */
  hint: string;
}

/**
 * 这一行"当前是什么"（P7.5 · C）——给「问 AI」拼清单用：只读值优先，其次开关
 *（开/关）、再其次分段控件选中的那一档。
 *
 * 🔴 **绝不读输入框的 `value`**：AI 栏的 API key 就是一个 `<input>` —— 把 value 拼进
 * 提示词 = 把 key 发给模型（key 的三条纪律见 `settings/ai.ts` 文件头）。开关 / 分段 /
 * 只读文本已经覆盖"我现在什么状态"的主要价值；输入框内容一律不带（判据钉着：
 * 假 key 在提示词里出现就红）。
 */
function currentValueOf(row: HTMLElement): string {
  const read = (row.querySelector('.kbw-set-read')?.textContent ?? '').trim();
  if (read) return read;
  const sw = row.querySelector<HTMLElement>('.kbw-switch');
  if (sw) return sw.classList.contains('is-on') ? '开' : '关';
  const seg = row.querySelector<HTMLElement>('.kbw-seg .kbw-segbtn.is-on');
  if (seg) return (seg.textContent ?? '').trim();
  return '';
}

export function openSettingsPanel(ctx: WorkbenchContext, initial?: SettingsSectionId): PanelHandle {
  /**
   * 顶部那枚「显示说明」——**要在 `openModal` 之前建好**（`headActions` 收的是现成元素）。
   * 它的状态落在插件设置里（界面偏好），换栏/重开都还在。
   */
  const hintBtn = el('button', {
    /**
     * 用**可点的胶囊**（`.kbw-chip.is-pickable`）而不是 ghost 按钮：它是个**开关**，
     * 得看得见"现在是开还是关"（`.is-on` 会上 accent 色）。
     * 真机截图上第一版是 `.kbw-btn.is-ghost` —— 透明边框 + 灰字，读起来像一句**标注**，
     * 不像能点的东西（用户第 6 条要的正是这一层"看得懂"）。
     */
    cls: ['kbw-chip', 'is-pickable'],
    attr: { type: 'button', title: '把每一行、每一小节下面那句解释摊开（默认收起；鼠标停在行标签上也看得到）' },
    text: '显示说明',
    on: { click: () => void toggleHints() },
  });

  const h = openModal({
    title: '工作台设置',
    sub: '改完即时生效（库内配置那几个跟着库走）',
    width: 'wide',
    headActions: [hintBtn],
  });

  /** 面板自己的 `Component`（`MarkdownRenderer.render` 的第 5 参**必须是它**） */
  const mdComponent = new Component();
  mdComponent.load();
  h.disposer.add(() => mdComponent.unload());

  const sections = buildSections();
  const searchBox = el('input', {
    cls: 'kbw-input kbw-set-search',
    attr: { type: 'search', placeholder: '搜索设置项…' },
  });
  const shell = div({ cls: 'kbw-set-shell' });
  const rail = div({ cls: 'kbw-set-rail' });
  const main = div({ cls: 'kbw-set-main' });
  shell.appendChild(rail);
  shell.appendChild(main);
  h.body.appendChild(div({ cls: 'kbw-set-searchbar' }, searchBox));
  h.body.appendChild(shell);

  let current: SettingsSection | null = null;
  let cleanup: (() => void) | null = null;
  /** 搜索词（非空时右栏画的是命中清单，不是某一栏） */
  let query = '';
  /**
   * 右栏现在画的是什么。**它是异步索引的护栏**：
   * 索引要几百毫秒才建好，这期间用户完全可以点左栏切走 —— 回来的时候
   * 那一份结果**不许再往上盖**（第一版没有这道闸，用户点了「外观」之后
   * 被一份迟到的搜索结果整个换掉）。
   */
  let mode: 'section' | 'search' = 'section';
  /** 懒建的索引（第一次搜索才建） */
  let index: IndexEntry[] | null = null;
  /** 正在建索引的那一趟（**去重**：慢索引期间连着敲字不该并发跑两份全栏渲染） */
  let building: Promise<IndexEntry[]> | null = null;
  /**
   * **搜索之前在看哪一栏** —— 清空搜索框时要回到它。
   * 🔴 少了这一格就会"顺手搜一下再删掉，结果被踢到第一栏「自动化」"：
   * 搜索态下 `current` 必为 null（两条渲染路径都会把它清掉），
   * 于是 `current?.id ?? sections[0].id` 永远兜到第一栏（独立审查 A🟡2）。
   */
  let lastSection: SettingsSectionId | null = null;
  /** 这一次会话里被点亮的那一行（换栏/重画就没了） */
  let flashLabel: string | null = null;

  const api: SectionApi = {
    ctx,
    rerender: () => show(current?.id ?? sections[0].id),
    close: () => h.close('close'),
    // 教程中心的 Markdown（P7.2b）—— 第 5 参就是面板自己那个 mdComponent
    md: (host, text) => MarkdownRenderer.render(ctx.app, text, host, '', mdComponent),
  };

  // ── 显示说明（界面偏好，落 data.json）──────────────────────
  async function toggleHints(): Promise<void> {
    const on = ctx.settings.get().showSettingHints !== true;
    await ctx.settings.save({ showSettingHints: on });
    applyHintMode();
  }

  function applyHintMode(): void {
    const on = ctx.settings.get().showSettingHints === true;
    shell.classList.toggle('is-showsub', on);
    hintBtn.textContent = on ? '收起说明' : '显示说明';
    hintBtn.classList.toggle('is-on', on);
  }

  function disposeCurrent(): void {
    if (cleanup) {
      try {
        cleanup();
      } catch (e) {
        console.error('[经纬] 设置栏卸载出错', e);
      }
      cleanup = null;
    }
  }

  function show(id: SettingsSectionId): void {
    const next = sections.find((s) => s.id === id) ?? sections[0];
    const same = current?.id === next.id;
    /**
     * 🔴 **两件事都要做**：
     * ① **同栏重画也要调上一份 cleanup**（独立审查 A🟢6）：那段 DOM 要被整个清掉，
     *    挂在它上面的订阅/定时器就该释放 —— 否则"下一块真的返回 cleanupl"那天会静默漏掉。
     *    ⚠️ 这**不**影响"草稿留在栏的闭包里"：那份状态属于栏工厂，不属于这次的 DOM。
     * ② **保住滚动位置**（同栏重画时）：栏目合并之后一栏很长，改个开关就跳回顶上会很难用
     *   （本项目在 e2 期栽过同一课：重绘把滚动清零）。换栏才回顶。
     */
    const keepScroll = same ? main.scrollTop : 0;
    disposeCurrent();
    while (main.firstChild) main.removeChild(main.firstChild);
    current = next;
    lastSection = next.id;
    mode = 'section';
    paintRail();
    /**
     * 🔴 **栏顶只留一份标题**（用户 2026-09-27 原话："右边具体的设置面板有两个标题，只保留一个"）。
     * 合并出来的栏由 `compose()` 保证（子块的标题降级成小节标题，见那边的注释）。
     * ⚠️ 别在这里再加一层 —— 判据是「同一栏里 h2/h3 数量 = 1」（离线 + 探针各一条）。
     */
    const body = div({ cls: 'kbw-set-body' });
    main.appendChild(body);
    try {
      const fn = next.render(body, { ...api, rerender: () => show(next.id) });
      cleanup = typeof fn === 'function' ? fn : null;
    } catch (e) {
      console.error(`[经纬] 设置栏 ${next.id} 渲染出错`, e);
      body.appendChild(div({ cls: 'kbw-set-note is-error', text: String(e) }));
    }
    mountAskAi(body, next);
    if (flashLabel) flashRow(body, flashLabel);
    main.scrollTop = keepScroll;
  }

  // ── 搜索（懒建索引 → 右栏换成命中清单）─────────────────────
  async function onSearch(): Promise<void> {
    query = searchBox.value.trim();
    if (query === '') {
      show(lastSection ?? current?.id ?? sections[0].id);
      return;
    }
    mode = 'search';
    paintSearchHint();
    const idx = await buildIndex();
    /**
     * 索引是异步建的，回来时要**问一句"还该由我画吗"**（两道闸）：
     * ① 词变了 → 让新一轮去画；② 用户点了别的栏（`mode` 不再是 search）→ 别盖他选的那一栏。
     */
    if (mode !== 'search' || searchBox.value.trim() !== query) return;
    paintResults(idx);
  }

  /** 索引没好之前先说一句 —— 别让界面看着像卡住了 */
  function paintSearchHint(): void {
    if (H_hasResults()) return;
    disposeCurrent();
    current = null;
    mode = 'search';
    while (main.firstChild) main.removeChild(main.firstChild);
    paintRail();
    main.appendChild(
      div({ cls: 'kbw-set-body' }, div({ cls: 'kbw-set-empty', text: '正在整理设置项…' })),
    );
  }

  function H_hasResults(): boolean {
    return main.querySelector('.kbw-set-results') !== null;
  }

  /**
   * **懒建**索引：把每一栏在一个**离屏但活着**的容器里渲染一遍，收下"行标签 + 那句解释"。
   *
   * 🔴 **不能同步读完就丢**：`automation` / `routes` / `templates` / `snapshot` / `logs`
   * 这几块的 `paint()` 都是 **`await` 读完库内文件才往宿主 append 行**的 ——
   * 同步那一瞬间它们的行还没生出来。第一版就是"渲染完立刻读"，
   * 索引出来是一份**空表**：搜什么都 0 命中（用例当场抓的）。
   * ⇒ 容器挂在面板里（`display:none`）+ 等到"行数不再变多"再收。
   *
   * ⚠️ 收完**立刻调各块的 cleanup 并把容器摘掉**（那份 DOM 只用来读标签，订阅一个都不留）。
   */
  async function buildIndex(): Promise<IndexEntry[]> {
    if (index) return index;
    if (building) return building;
    building = buildIndexOnce();
    try {
      return await building;
    } finally {
      building = null;
    }
  }

  async function buildIndexOnce(): Promise<IndexEntry[]> {
    const host = div({ cls: 'kbw-set-indexhost', css: { display: 'none' } });
    h.body.appendChild(host);
    const cleanups: (() => void)[] = [];
    for (const s of sections) {
      /**
       * **每栏一个自己的盒子 + `data-sec`**：合并栏里的子块也会建 `.kbw-set-block`
       *（`renderPart` 建的），靠"第几个块"去猜栏会**猜错**
       *（合并栏内层的块会顶掉后一栏的位置）。用属性认人，别用位置。
       */
      const box = div({ cls: 'kbw-set-block', attr: { 'data-sec': s.id } });
      host.appendChild(box);
      try {
        const fn = s.render(box, api);
        if (typeof fn === 'function') cleanups.push(fn);
      } catch (e) {
        console.error(`[经纬] 建搜索索引时 ${s.id} 渲染出错`, e);
      }
    }
    /**
     * 等异步块把行画进来。判据是"**连续 4 次采样行数都没变**"（≈360ms 静默）——
     * ⚠️ 只要求"相邻两次相等"是不够的（独立审查 A🟡3）：`logs` 那块的
     * `paint()` 里有多段 await（先取 200 条日志、再逐篇 `cachedRead`），
     * 中间只要空一拍就会被当成"画完了"，后面才到的行**不进索引**——
     * 而 `index` 一旦建好就不再重建，那些设置项**这辈子都搜不到**，还不报错。
     * 有上界（16 轮 ≈ 1.5s），不会卡住。
     */
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 16; i += 1) {
      await new Promise((r) => setTimeout(r, 90));
      const n = host.querySelectorAll('.kbw-set-row').length;
      stable = n > 0 && n === last ? stable + 1 : 0;
      if (stable >= 3) break;
      last = n;
    }
    const out: IndexEntry[] = [];
    for (const row of Array.from(host.querySelectorAll<HTMLElement>('.kbw-set-row'))) {
      out.push({
        section: sectionOfNode(row),
        label: row.querySelector('.kbw-set-label-t')?.textContent?.trim() ?? '',
        // ⚠️ 认**标签里**那一句解释（读法唯一出处 = kit 的 `HINT_SEL`，别手拼选择器）
        hint: row.querySelector(HINT_SEL)?.textContent?.trim() ?? '',
      });
    }
    for (const g of Array.from(host.querySelectorAll<HTMLElement>('.kbw-set-group-t'))) {
      out.push({ section: sectionOfNode(g), label: g.textContent?.trim() ?? '', hint: '' });
    }
    /**
     * **栏顶那句"数据在哪"也进索引**（P7.5 · 8.3/B）：如自动化栏的
     * "库内配置：…/自动化.json（跟着库走，可手改）"—— 搜「跟着库走」这类词能命中。
     *
     * ⚠️ **两类都要收**（独立审 2026-10-04 🟡）：`.kbw-set-sub` 是**本栏**那句；
     * 合并栏里**子块**的那句（如「目录映射」块的"库内文件：…/标签-目录映射.json"）
     * 在 `renderPart` 降级时已换成 `.kbw-set-group-s` —— 只收前者的话，
     * 搜「标签-目录映射」会 0 命中，而摊开说明时那句明明就在屏上。
     * ⚠️ 命中的 label 不会是任何行标签，跳过去只是**不点行**（`flashRow` 有界重试后放弃），
     * 属预期；栏本身能跳到就够了。
     */
    for (const s of Array.from(
      host.querySelectorAll<HTMLElement>('.kbw-set-sub, .kbw-set-group-s'),
    )) {
      out.push({ section: sectionOfNode(s), label: s.textContent?.trim() ?? '', hint: '' });
    }
    for (const f of cleanups) {
      try {
        f();
      } catch (e) {
        console.error('[经纬] 搜索索引容器卸载出错', e);
      }
    }
    host.remove();
    index = out.filter((e) => e.label !== '');
    return index;
  }

  /** 这个节点属于哪一栏 —— 索引容器里每栏一个 `[data-sec]` 盒子，认属性不认位置 */
  function sectionOfNode(node: HTMLElement): SettingsSectionId {
    const id = node.closest('[data-sec]')?.getAttribute('data-sec') ?? '';
    // 认不出来就退回第一栏：宁可归错栏，也别让一整条索引被丢掉
    return (sections.find((s) => s.id === id)?.id ?? sections[0].id) as SettingsSectionId;
  }

  function paintResults(idx: IndexEntry[]): void {
    disposeCurrent();
    current = null;
    while (main.firstChild) main.removeChild(main.firstChild);
    paintRail();
    const body = div({ cls: 'kbw-set-body' });
    main.appendChild(body);

    const q = query.toLowerCase();
    const hits = idx.filter(
      (e) => e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q),
    );
    body.appendChild(div({ cls: 'kbw-set-h' }, el('h3', { text: `搜索「${query}」` })));
    if (hits.length === 0) {
      body.appendChild(
        div({ cls: 'kbw-set-empty', text: '没有匹配的设置项 —— 换个词，或者把左侧七栏看一遍' }),
      );
      return;
    }
    body.appendChild(div({ cls: 'kbw-set-hsearch-n', text: `${hits.length} 项（点一条跳过去）` }));
    const list = div({ cls: 'kbw-set-results' });
    for (const hit of hits) {
      const row = el('button', {
        cls: ['kbw-set-result', 'kbw-hover-1'],
        attr: { type: 'button' },
        on: {
          click: () => {
            query = '';
            searchBox.value = '';
            flashLabel = hit.label;
            show(hit.section);
          },
        },
      });
      row.appendChild(span({ cls: 'kbw-set-result-sec', text: sectionLabel(hit.section) }));
      row.appendChild(span({ cls: 'kbw-set-result-t', text: hit.label }));
      if (hit.hint) row.appendChild(span({ cls: 'kbw-set-result-h', text: hit.hint }));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  function sectionLabel(id: SettingsSectionId): string {
    return sections.find((s) => s.id === id)?.label ?? id;
  }

  /**
   * 跳过去之后**把那一行点亮一下** —— 否则用户只看到"跳到了这一栏"，不知道是哪一行。
   *
   * 🔴 **要等它画出来再点**：点进去的那一栏可能是**异步画行**的
   *（`automation` / `routes` / `templates` / `snapshot` / `logs` 都要先 `await` 读库内文件），
   * `show()` 那一刻那些行还不存在 —— 一次就放弃的话点的是空气
   *（离线实测：搜索结果点了「自动归位」，跳过去却是**一行都没点亮**；
   * 同一个坑在项目里出现过：`f` 期"小窗里尾链照样整段显示"就是"一次就放弃"）。
   * 所以：**有界重试**（20 × 60ms），找到就点、找不到就算了（不无限等）。
   */
  function flashRow(body: HTMLElement, label: string): void {
    flashLabel = null;
    let tries = 0;
    const tick = (): void => {
      const rows = Array.from(body.querySelectorAll<HTMLElement>('.kbw-set-row'));
      const hit = rows.find(
        (r) => (r.querySelector('.kbw-set-label-t')?.textContent ?? '').trim() === label,
      );
      if (!hit) {
        if (tries < 20 && body.isConnected) {
          tries += 1;
          window.setTimeout(tick, 60);
        }
        return;
      }
      hit.classList.add('is-flash');
      // ⚠️ 可选调用（`?.`）：jsdom 里没有 `scrollIntoView` —— 直接调会**同步抛**，
      //    于是下面那句"1.4 秒后摘掉"根本排不上，那一行就永远亮着（离线实测）
      hit.scrollIntoView?.({ block: 'center' });
      window.setTimeout(() => hit.classList.remove('is-flash'), 1400);
    };
    tick();
  }

  // ── 「问 AI」：每一栏标题右边一枚（外壳注入，各栏不用自己管）──
  /**
   * 它走的是**与 AI 助手完全相同的那条链路**（`ctx.ai.ask`）——
   * 不新开一条、不自己拼 HTTP、也**不动库**（`ctx.ai` 那一层在类型上就写不了盘）。
   * 回答就地显示在这一栏顶上（不弹第二个面板：这里问的是"眼前这些东西是什么意思"）。
   */
  function mountAskAi(body: HTMLElement, sec: SettingsSection): void {
    const head = body.querySelector<HTMLElement>('.kbw-set-h');
    if (!head) return;
    const b = btn({
      cls: ['kbw-btn', 'is-small', 'is-ghost', 'kbw-set-askai'],
      text: '问 AI',
      attr: { title: '让模型用大白话讲一遍这一栏（只回答，不动库）' },
      on: { click: () => void askAi(body, sec) },
    });
    head.appendChild(b);
  }

  async function askAi(body: HTMLElement, sec: SettingsSection): Promise<void> {
    // 点第二次就把上一块收掉（不然连着问两次会叠两块，谁也不知道哪块是新的）
    body.querySelector('.kbw-set-ai')?.remove();
    const box = div({ cls: 'kbw-set-ai' });
    const say = (text: string): void => {
      box.textContent = '';
      box.appendChild(div({ cls: 'kbw-set-ai-t', text }));
    };
    /**
     * 🔴 **落点要挂在栏题下面**，不能写"第一个子节点之后"（独立审查 A🟡4）：
     * 合并出来的栏（「自动化」）第一个子节点是**整个子块**，写在它后面就等于
     * 把回答插到"自动化块与目录映射块之间"—— 十几行以下，用户点完**什么都看不见**
     *（而注释还写着"就地显示在这一栏顶上"）。
     */
    const anchor = body.querySelector('.kbw-set-h');
    const place = (): void => {
      if (anchor?.parentElement) anchor.after(box);
      else body.prepend(box);
    };
    place();
    if (!ctx.ai.isConfigured()) {
      say('还没配置 AI —— 去左边「AI 助手」那一栏填 baseURL / 模型 / key（用的是同一份配置）。');
      return;
    }
    say('正在问模型…');
    const items = Array.from(body.querySelectorAll<HTMLElement>('.kbw-set-row'))
      .map((r) => {
        const label = (r.querySelector('.kbw-set-label-t')?.textContent ?? '').trim();
        const hint = (r.querySelector(HINT_SEL)?.textContent ?? '').trim();
        const value = currentValueOf(r);
        return `- ${label}${value ? `（当前：${value}）` : ''}${hint ? `：${hint}` : ''}`;
      })
      .filter((line) => line !== '- ');
    const question = [
      `用大白话讲一下「${sec.label}」这一栏是干什么的、每一项什么时候该动。`,
      '读者是刚装好这个知识库插件的人，别说术语，也别建议我去改任何东西，只解释。',
      '',
      '这一栏的项目：',
      ...items,
    ].join('\n');

    let turn: { reply: string } | null = null;
    try {
      turn = await ctx.ai.ask({ question });
    } catch (e) {
      say(`没问成：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!box.isConnected) return; // 问的过程中用户换栏了 —— 别往一个已经拆掉的盒子里画
    box.textContent = '';
    const host = div({ cls: 'kbw-set-ai-body' });
    box.appendChild(host);
    try {
      await MarkdownRenderer.render(ctx.app, turn.reply || '（模型没给说明）', host, '', mdComponent);
    } catch {
      host.textContent = turn.reply;
    }
  }

  function paintRail(): void {
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    for (const s of sections) {
      const item = el('button', {
        cls: ['kbw-set-tab', 'kbw-hover-1', current?.id === s.id ? 'is-on' : null],
        // `title` = 这一栏那句短的说明（栏顶那一层 head 删掉之后它唯一的落点）
        attr: { type: 'button', 'data-section': s.id, title: s.sub },
        on: { click: () => show(s.id) },
      });
      /**
       * 图标走 `icon()`（P7.7c 图标纪律）：这里原来手抄了一份它的内部
       * （setIcon + 手动设 16px），行为一模一样 —— 统一出处，别再开第二份。
       */
      item.appendChild(icon(s.icon, 16));
      item.appendChild(span({ text: s.label }));
      rail.appendChild(item);
    }
    // 底部：模块开关（粗粒度那一层）+ 打开原生设置页
    const foot = div({ cls: 'kbw-set-railfoot' });
    foot.appendChild(
      el('button', {
        cls: ['kbw-set-tab', 'is-ghost'],
        attr: { type: 'button' },
        text: '模块开关 / 原生设置',
        on: { click: () => ctx.openNativeSettings() },
      }),
    );
    rail.appendChild(foot);
  }

  searchBox.addEventListener('input', () => void onSearch());
  h.disposer.add(disposeCurrent);
  applyHintMode();
  show(initial ?? 'automation');
  return h;
}
