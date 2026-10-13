/**
 * ui/wizard.ts —— 首次使用向导（交互规格 §14；**P7.9 改版：四屏、零 lead**）
 *
 * 屏序：**引言（对比即主视觉）→ ①工作文件夹 → ②模块开关 → 结语（接下来去哪）**。
 * **「三步」改「两步」**（P7.9 · ① 拍板）：原第 3 步「现场检测」**整屏退役** ——
 * 库里缺什么，首页「待处理」里都有。引言与结语是**不算步的两屏**：引言可整段跳过；
 * 结语给四张可点的去处卡（P7.10 · #4：**2×2，「首页」在左上**、卡内只有大字居中）。
 *
 * ## 极简口径（P7.9 · ① 拍板；效果稿 = `新手引导-极简版.html`）
 *
 * 每屏结构 = 步名 → 主图示（对比图 / 选项卡 / 开关行 / 去向卡）→ 底部按钮；
 * **零 lead、零括注**；每屏说明性文字 ≤25 字。删掉了：引言 lead、第 1/2 步 lead、
 * 各字段注、开关行的长 desc（压成 ≤6 字）、结语页脚句、第 3 屏整屏。
 *
 * ## 三条口径（拍板时定的，别自己改）
 *
 * · **只在"从未配置过"时自动出现一次**，判据是纯函数 `shouldShowWizard()`
 *   （`wizardDone` 三态 + 默认值双判 —— 为什么必须有 `null` 那一支见那里的注释）。
 *   自动弹的时机在 `main.ts`（**打开工作台那一刻**，不是插件加载期）。
 * · **每一步都能跳过**：向导最讨人厌的形态就是逼人走完。
 * · **第 1 步写完要真的生效** —— 走 `settingsStore.save()`，索引重建在
 *   `main.ts` 的 `settingsStore.onChange` 里（那句"库根/元数据目录变了就 rebuild"已经在）。
 *
 * ## 两个出口（P7.10 二拍②：按钮改叫「跳过教程」—— 语义一个字不变）
 *
 * 「跳过教程」= 记 `wizardDone: false`（**下次打开工作台还会出现**）·「完成」= 记 `true`。
 * Esc / 点 X **按「跳过教程」处理** —— 刻意选成确定性的：关掉一次 = 下次还来，
 * 用户真想让它闭嘴就点「完成」。
 *
 * ## 「上一步」（P7.10 · #5）
 *
 * **引言屏不画**；第 1 步起出现，结语屏也可退回。三条口径：
 *  · **退回不落盘** —— 保存只在"从第 1 步**正向**离开"那一下（`goto` 里那段，逻辑未动：
 *    `screen === 1 && next > 1 && !opts.skip`，往回走天然不满足）；
 *  · 跳过后退回再前进 → **重新走跳过判定**（每一趟正向离开都现判现走，没有"记住了"的账）；
 *  · Esc / ✕ 仍是"关掉并按跳过教程记账"（`onClose` 那条路不变）。
 *
 * ## 写盘口径（P7.9 起"全程无动作口"；**P7.14 起开一个例外**）
 *
 * 向导**只写两样东西**：① 设置（库根 / 库配置目录 / 开关 / `wizardDone`）；
 * ② **「新建」分支那一个空目录**（P7.14 · 用户 2026-10-08 拍板 —— 此前只写设置，
 * 用户得自己去 Obsidian 文件列表里手建文件夹）。建目录走 `createEmptyFolder`
 *（`ui/new-folder.ts` 的**轻量族**：不过 confirm / 不进快照 —— 「下一步」就是用户的确认动作）。
 * 本文件里**仍然不许出现任何写盘 API 字面量**（红线 `redline.ts` 盯着，见那里的"唯一例外"注释）。
 * ⚠️ **P7.17 · 用户第 1 条开的一个口**：屏 2 勾开「笔记自动化」→ 询问卡「去补全」→
 * `openBackfillPanel`（**用户显式点的那一下**才开；"不写盘"的纪律不变 —— 面板自己走确认流）。
 * 其余一切照旧：不转开任何其它动库面板（骨架入口在首页「待处理」），
 * 也不许调 `openRebuildPanel` / `configs.ensure`。
 *
 * ## 配图（P7.9 起只留引言两张 + 结语底纹）
 *
 * `assets/wizard/*.png` **随插件发布**（`scripts/deploy.mjs` 与分享包各拷一份；
 * 原图归档在仓库 `素材/` 下）。地址走 `vault.adapter.getResourcePath(pluginDir + …)`。
 * **加载失败就把整块藏起来**（onerror）—— 缺图时文案与控件自己站得住，不摆破图。
 * 圈注是**拍图时烘焙进 PNG** 的（不是 HTML 叠层），位置随图固定。
 * ⚠️ 暗色下由 CSS 统一压一点亮度、加 1px 边框（浅色截图不刺眼），见 `styles/wizard.css`。
 */
import type { WorkbenchContext } from '../core/context';
import { normPath } from '../core/paths';
import { btn, div, el, icon, span } from './primitives';
import { folderTree } from './folder-tree';
// P7.14：「新建」真建目录 —— 轻量族唯一落盘点（本文件仍不许出现写盘 API 字面量）
import { createEmptyFolder, folderNameProblem } from './new-folder';
import { openModal, type PanelHandle } from './panel';
import { onboardingWizardJustFinished } from '../modules/home/onboarding';
// P7.17 · 用户第 1 条：存量补齐的**主入口** —— 屏 2 的询问卡「去补全」开它
//（口径变更记在文件头：P7.9 的"不转开任何动库面板"由此开一个**用户显式点击**的口）
import { openBackfillPanel } from './backfill-panel';
import { planBackfillOf, planTodoCount } from '../services/backfill';

/**
 * 三步标题（步骤条与内容区共用；引言不在这里）。
 * ⚠️ v2（P7.12 · #3 拍定）：加上第 3 格「到处看看」——**结语屏自己就是第 3 步**；
 * 结语屏上三格全部按**非当前态**画（"看完了"，不再强调任何一格）。
 */
const STEP_TITLES = ['工作文件夹', '模块开关', '到处看看'];
/**
 * 屏序：0 引言 · 1..2 = 两步 · 3 结语。
 * ⚠️ v2（P7.12 · #3）：结语屏**自己就是第 3 格「到处看看」** —— 所以屏号 = 标题数（3），
 * **不是**"所有步走完之后"的 +1（那样会多出一个空白屏号、按钮文案也跟着错）。
 */
const SCREEN_INTRO = 0;
const SCREEN_EPILOGUE = STEP_TITLES.length;

/**
 * 面板标题（P7.10 · #1）：**只在引言屏**用长标题（那是唯一的"为什么用经纬"现场），
 * 其余屏回到短标题 —— 判据是"标题随屏切换"（`tests/specs/p72b.ts` 向导组）。
 */
const TITLE_INTRO = '首次使用向导 · 为什么用经纬？';
const TITLE_SHORT = '首次使用向导';

/** 配图文件名（`assets/wizard/` 下；出片脚本见 `scripts/shoot-wizard.mjs`）——
 *  P7.9 极简后只有引言两张在用（结语底纹复用 home）；03–05 仍随包发布、暂不使用。 */
const SHOTS = {
  native: '01-native.png',
  home: '02-home.png',
} as const;

type ShotName = keyof typeof SHOTS;

/**
 * 「新建」分支目录名的默认值（P7.14 · 用户 2026-10-08 拍板：默认叫「经纬知识库」）。
 * ⚠️ 与 `DEFAULT_SETTINGS.kbRoot`（`'01_新知识库'`）**不是一回事** —— 那是"从没配过"的
 * 兜底默认，这是给"新建"输入框的预填名；别把两处合并。
 */
const NEW_FOLDER_DEFAULT = '经纬知识库';

/** 第 1 步的三选一（P7.11 · #11 起允许"未选"；P7.14 加第三张卡「整个库」） */
type FolderMode = 'new' | 'existing' | 'whole';

/** 版本化资产地址：`<插件目录>/assets/wizard/<文件>`（走平台资源协议） */
function assetUrl(ctx: WorkbenchContext, name: string): string {
  return ctx.app.vault.adapter.getResourcePath(`${ctx.pluginDir}/assets/wizard/${name}`);
}

export function openWizard(ctx: WorkbenchContext): PanelHandle {
  /** 「这一屏已经是定局了」—— `onClose` 据此决定要不要按「稍后」记账 */
  let settled = false;
  /** 第 1 步三个字段的值（离开那一步时才落盘） */
  let kbRoot = ctx.settings.kbRoot();
  /**
   * 「新建」分支的目录名 —— 与 `kbRoot` **分开存**：一个语义是"给新目录起名"、
   * 一个是"指向已有路径"；此前共用一个变量，正是"新建默认名 = 当前库根"的来源。
   * P7.14 起初值 = 「经纬知识库」（用户 2026-10-08 拍板）。
   */
  let newName = NEW_FOLDER_DEFAULT;
  let metaDir = ctx.settings.get().metaDir;
  /** 屏序（见文件头） */
  let screen = SCREEN_INTRO;
  /**
   * 第 1 步的**三选一**。**不预选**（P7.11 · #11，Q8 拍板）：试卷感优先 ——
   * 先问你、再给填空；丢掉原先"按现状猜"（库根存在 → 用现成的）。
   * `null` = 还没选 → 下方**什么都不画**。
   */
  let mode: FolderMode | null = null;

  const h = openModal({
    title: TITLE_SHORT,
    // P7.10 · #6 二拍③：副标题只留两句 —— 「每步可跳过」不再写（按钮自己说明了一切）
    sub: '约 1 分钟 · 可在设置中再次观看',
    width: 'wide',
    onClose: () => {
      /**
       * ⚠️ **Esc / 点 X 也算「跳过教程」**（`wizardDone: false`）：
       * 不写的话它保持 `null`，而 `null` 在"路径还是默认值"时会**继续弹** ——
       * 看起来一样，但语义不同（用户明确关过 vs 从没弹过），以后想区分就分不出来了。
       */
      if (!settled) void ctx.settings.save({ wizardDone: false });
    },
  });

  const stepsBar = div({ cls: 'kbw-wiz-steps' });
  const body = div({ cls: 'kbw-wiz-body' });
  h.body.appendChild(stepsBar);
  h.body.appendChild(body);

  /**
   * 「上一步」（P7.10 · #5）：引言屏**不画** —— `paint()` 里把节点整个摘掉，
   * **刻意不挂隐藏类**：底栏遍历判据（`tests/specs/panels.ts`）明确不许底栏按钮带
   * 已知隐藏类（那是"按钮点得到、看不见"事故的回归钉）。
   * 往回走就是 `goto(screen - 1)`：`goto` 的落盘闸是"从第 1 步**正向**离开"
   * （`screen === 1 && next > 1 && !skip`），往回天然不满足 → **退回不落盘**；
   * 跳过后退回再前进也重新现判现走（见文件头那三条口径）。
   */
  const backBtn = btn({
    cls: 'kbw-btn is-ghost',
    text: '上一步',
    on: { click: () => void goto(screen - 1) },
  });
  const skipBtn = btn({
    cls: 'kbw-btn is-ghost',
    text: '跳过这一步',
    on: { click: () => void goto(screen + 1, { skip: true }) },
  });
  // P7.10 二拍②：「稍后」→「跳过教程」（语义不变：关掉并记下次还来）
  const laterBtn = btn({ cls: 'kbw-btn', text: '跳过教程', on: { click: () => finish(false) } });
  const nextBtn = btn({
    cls: 'kbw-btn is-primary',
    text: '下一步',
    on: { click: () => void goto(screen + 1) },
  });
  h.foot.appendChild(backBtn);
  h.foot.appendChild(skipBtn);
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(laterBtn);
  h.foot.appendChild(nextBtn);

  // ────────────────────────────────────────────────────────────
  async function goto(next: number, opts: { skip?: boolean } = {}): Promise<void> {
    if (next > SCREEN_EPILOGUE) {
      finish(true);
      return;
    }
    // 离开第 1 步时落盘（**跳过就不落** —— 用户没确认过自己改的东西，替他把改动应用上更吓人）
    // P7.11 · #11：**没选过**（mode === null，直接点「下一步」）也什么都不落 —— 没填的卷子不改分
    if (screen === 1 && next > 1 && !opts.skip) {
      if (mode === 'existing') {
        const changed = kbRoot !== ctx.settings.kbRoot() || metaDir !== ctx.settings.get().metaDir;
        if (changed) await ctx.settings.save({ kbRoot, metaDir });
      } else if (mode === 'whole') {
        // P7.14：「整个库」= kbRoot 置空（'' = vault 根）；不建目录；库配置目录照常可改
        const changed = ctx.settings.kbRoot() !== '' || metaDir !== ctx.settings.get().metaDir;
        if (changed) await ctx.settings.save({ kbRoot: '', metaDir });
      } else if (mode === 'new') {
        /**
         * P7.14（用户 2026-10-08 拍板）：**真的把文件夹建出来** —— 此前只写设置，
         * 用户得自己去 Obsidian 文件列表里手建。三条支路：
         *   · 空名 / 名字形状不合法 → 不建不落、**允许离开**（hint 里写着问题）；
         *   · 库里已有同名 → 不建、只把库根指过去（hint 已指路"想用它请切到用现成的"）；
         *   · 否则 `createEmptyFolder`（轻量族：不过 confirm / 不进快照）——
         *     **建失败留在第 1 步**（动作失败不是校验，toast 里说明了原因）。
         */
        const rel = normPath(newName);
        if (rel !== '' && folderNameProblem(rel) == null) {
          if (ctx.app.vault.getAbstractFileByPath(rel) != null) {
            if (rel !== ctx.settings.kbRoot()) await ctx.settings.save({ kbRoot: rel });
          } else {
            const r = await createEmptyFolder(ctx, rel);
            if (r === 'failed') return; // 建失败：不离开（'created' / 'exists' 都继续）
            if (rel !== ctx.settings.kbRoot()) await ctx.settings.save({ kbRoot: rel });
          }
        }
      }
      /**
       * ⚠️ 这里**不自己** `index.rebuild()`：`main.ts` 的 `settingsStore.onChange`
       * 里那句"库根|元数据目录变了就重建索引"已经在管这件事（P6b 加的）。
       * 在这儿再调一次不是"更保险"，是**第二份真相** —— 哪天那句口径改了
       *（比如改成延时防抖），这里的即时重建会让两条路打架。
       */
    }
    screen = next;
    await paint();
  }

  function finish(done: boolean): void {
    settled = true;
    /** 独立审 🟢1：全勾之后**重跑**一遍向导不该再弹一次"四步都完成了"（那不是"补全那一瞬"） */
    const wasDone = ctx.settings.get().wizardDone === true;
    void ctx.settings.save({ wizardDone: done });
    /**
     * 16.13（P7.2d）：向导走完 = 新手清单第 1 项（打勾读的就是 `wizardDone` 本身）。
     * 这里只补"**它是最后一脚**"那一种的完成提示 —— 其余三项各自在
     * `recordOnboarding` 里判（那边也判同一件事的另一半，两处共用 `flagsAll`）。
     */
    if (done && !wasDone) onboardingWizardJustFinished(ctx);
    h.close(done ? 'done' : 'later');
  }

  // ────────────────────────────────────────────────────────────
  async function paint(): Promise<void> {
    paintSteps();
    body.replaceChildren();
    /** 标题随屏切换（P7.10 · #1）：长标题只在引言屏（那屏才在讲"为什么用经纬"） */
    h.setTitle(screen === SCREEN_INTRO ? TITLE_INTRO : TITLE_SHORT);
    /** 「上一步」：引言屏摘掉；回到别的屏时插回最左（摘/插，不挂隐藏类 —— 见 backBtn 注释） */
    if (screen === SCREEN_INTRO) backBtn.remove();
    else if (!backBtn.isConnected) h.foot.insertBefore(backBtn, skipBtn);
    nextBtn.textContent = screen === SCREEN_EPILOGUE ? '完成' : '下一步';
    skipBtn.textContent = screen === SCREEN_INTRO ? '跳过介绍' : '跳过这一步';
    // 「跳过这一步」在结语屏没有意义（skipped 就是完成，而「完成」就在旁边）；
    // 「跳过教程」在结语屏同理（已经走完了，"下次再说"没有语义）
    skipBtn.classList.toggle('is-hidden', screen === SCREEN_EPILOGUE);
    laterBtn.classList.toggle('is-hidden', screen === SCREEN_EPILOGUE);
    if (screen === SCREEN_INTRO) paintIntro();
    else if (screen === 1) paintFolders();
    else if (screen === 2) paintModules();
    else paintEpilogue();
  }

  function paintSteps(): void {
    stepsBar.replaceChildren();
    stepsBar.style.display = screen === SCREEN_INTRO ? 'none' : '';
    if (screen === SCREEN_INTRO) return;
    /** v2（#3）：结语屏 = 第 3 步「到处看看」本身，**三格全按非当前态（灰）画** */
    const epi = screen === SCREEN_EPILOGUE;
    STEP_TITLES.forEach((t, i) => {
      const stepNo = i + 1;
      stepsBar.appendChild(
        div({
          cls: [
            'kbw-wiz-step',
            !epi && screen === stepNo ? 'is-on' : null,
            epi || stepNo < screen ? 'is-done' : null,
          ],
          text: `${stepNo}. ${t}`,
        }),
      );
    });
  }

  /** 一张配图 + 一行圈注说明。**加载失败整块隐藏**（不摆破图；文案自己站得住） */
  function shot(name: ShotName, cap: string): HTMLElement {
    const box = div({ cls: 'kbw-wiz-shot' });
    const img = el('img', {
      cls: 'kbw-wiz-img',
      attr: { src: assetUrl(ctx, SHOTS[name]), alt: cap || '向导配图', draggable: 'false' },
    }) as HTMLImageElement;
    img.addEventListener('error', () => box.classList.add('is-missing'));
    box.appendChild(img);
    if (cap) box.appendChild(div({ cls: 'kbw-wiz-cap', text: cap }));
    return box;
  }

  // ── 屏 0：引言（**对比即主视觉**；零 lead —— P7.9 · ①）────────
  function paintIntro(): void {
    const grid = div({ cls: 'kbw-wiz-intro' });
    const col = (title: string, good: boolean, shotName: ShotName, facts: string[]): HTMLElement => {
      const c = div({ cls: ['kbw-wiz-col', good ? 'is-good' : null] });
      c.appendChild(div({ cls: 'kbw-wiz-col-t', text: title }));
      c.appendChild(shot(shotName, ''));
      const ul = el('ul', { cls: 'kbw-wiz-facts' });
      for (const f of facts) ul.appendChild(el('li', { text: f }));
      c.appendChild(ul);
      return c;
    };
    grid.appendChild(
      // P7.10 · #1：左栏加问号（一设问一答案 —— 右栏还是陈述句）
      col('直接用 Obsidian？', false, 'native', [
        '属性和状态要自己记',
        '搜、标签、属性分三处',
        '归类搬家全靠手',
      ]),
    );
    grid.appendChild(div({ cls: 'kbw-wiz-arrow', text: '→' }));
    grid.appendChild(
      // P7.11 · #1：「用经纬」→「试试经纬！」（一设问、一邀请 —— 左栏已是问句）
      col('试试经纬！', true, 'home', [
        '每篇一眼看清',
        '一处搜全库',
        '自动归位 + 一键补全',
      ]),
    );
    body.appendChild(grid);
  }

  // ── 屏 1：工作文件夹（P7.12 · #1/#8 重设计：两卡横排、去圆点）──
  /**
   * P7.12 · #8（用户点名"启用设计 skill"；效果稿 = 演示稿 §W#8 卡片）：
   * 「选哪条路」= **两张横排的选择卡**（图标 + 标题 + 小字）；选中 = 描边 + 淡底 +
   * 右上角 ✓ 角标；**圆点整个去掉**（#1 一并解决 —— 不靠颜色也能看出选中）。
   * 内容区（树 / 字段）随选择**淡入**（~140ms，CSS 动画）。
   * 文案逐字不动（新建 / 起个名字 / 用现成的 / 选已有文件夹 / 两个字段名）；
   * **选中才出内容区、默认不预选**（P7.11 · #11 的试卷感，原样保留）。
   */
  function paintFolders(): void {
    body.appendChild(div({ cls: 'kbw-wiz-lead kbw-wiz-q', text: '工作文件夹放在哪？' }));
    const grid = div({ cls: 'kbw-wiz-optgrid', attr: { role: 'radiogroup', 'aria-label': '工作文件夹怎么来' } });
    const opts: { id: FolderMode; title: string; sub: string; icon: string }[] = [
      { id: 'new', title: '新建', sub: '起个名字', icon: 'folder-plus' },
      { id: 'existing', title: '用现成的', sub: '选已有文件夹', icon: 'folder-open' },
      // P7.14：第三张卡「整个库」—— 直接管库内所有笔记（kbRoot = ''，= vault 根）
      { id: 'whole', title: '整个库', sub: '不用再选文件夹', icon: 'library' },
    ];
    for (const o of opts) {
      const card = div({
        cls: ['kbw-wiz-opt', mode === o.id ? 'is-on' : null],
        attr: { role: 'radio', tabindex: '0', 'aria-checked': mode === o.id ? 'true' : 'false' },
      });
      card.appendChild(span({ cls: 'kbw-wiz-opt-ic' }, icon(o.icon, 18)));
      const tx = div({ cls: 'kbw-wiz-opt-tx' });
      tx.appendChild(span({ cls: 'kbw-wiz-opt-t', text: o.title }));
      tx.appendChild(div({ cls: 'kbw-wiz-opt-s', text: o.sub }));
      card.appendChild(tx);
      // ✓ 角标**只在选中时画**（不进未选态的可读文本 —— 判据读 textContent）
      if (mode === o.id) card.appendChild(span({ cls: 'kbw-wiz-ck', text: '✓' }));
      const pick = (): void => {
        mode = o.id;
        void paint();
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          evt.preventDefault();
          pick();
        }
      });
      grid.appendChild(card);
    }
    body.appendChild(grid);

    // **选中才出内容区**：未选 → 下方什么都不画（试卷感：先问你、再给填空）
    if (mode === null) return;
    const content = div({ cls: 'kbw-wiz-content' });

    const hint = div({ cls: 'kbw-wiz-hint' });
    /**
     * 现读现判：**只提示，不拦**（用户可能是想先改完再建）。三支各自的判据：
     * · 新建 —— 名字形状（与 `folderNameProblem` 同串）/ 撞名 / 合法时给一行"将建在哪"；
     * · 用现成的 —— 目录在不在库里；
     * · 整个库 —— 没有"工作文件夹"可判，只看库配置目录。
     */
    function refreshHint(): void {
      const issues: string[] = [];
      let info = '';
      if (mode === 'new') {
        const rel = normPath(newName);
        if (rel === '') issues.push('目录名不能为空');
        else if (rel.includes('/')) issues.push('只填一个目录名（多级路径请用「用现成的」）');
        else if (ctx.app.vault.getAbstractFileByPath(rel) != null) {
          issues.push(`库里已经有「${rel}」了 —— 想用它请切到「用现成目录」`);
        } else {
          const p = folderNameProblem(rel);
          if (p) issues.push(p);
          else info = `将在库的顶层新建「${rel}」`;
        }
      } else if (mode === 'whole') {
        if (normPath(metaDir) === '') issues.push('库配置目录不能为空');
        else info = '管理库内所有笔记（点开头的目录不显示）';
      } else if (mode === 'existing') {
        const root = normPath(kbRoot);
        if (root === '') issues.push('工作文件夹不能为空');
        else if (ctx.app.vault.getAbstractFileByPath(root) == null) {
          issues.push(`库里还没有「${root}」这个目录`);
        }
        if (normPath(metaDir) === '') issues.push('库配置目录不能为空');
      }
      hint.textContent = issues.length > 0 ? issues.join(' · ') : info;
      hint.classList.toggle('is-warn', issues.length > 0);
    }

    if (mode === 'new') {
      const input = el('input', {
        cls: 'kbw-input',
        attr: { type: 'text', spellcheck: 'false' },
      }) as HTMLInputElement;
      input.value = newName;
      input.addEventListener('input', () => {
        newName = input.value.trim();
        refreshHint();
      });
      field('目录名', input, content);
      input.focus();
    } else if (mode === 'whole') {
      /**
       * P7.14 ·「整个库」：只出「库配置目录」一个字段 —— 根就是 vault 根，
       * 没有"工作文件夹"可填、也没有可点的树（整库 = 不选层级）。
       * 范围说明由 `refreshHint` 的 info 行给。
       */
      const metaInput = el('input', {
        cls: 'kbw-input',
        attr: { type: 'text', spellcheck: 'false' },
      }) as HTMLInputElement;
      metaInput.value = metaDir;
      metaInput.addEventListener('input', () => {
        metaDir = metaInput.value.trim();
        refreshHint();
      });
      field('库配置目录', metaInput, content);
      metaInput.focus();
    } else {
      /**
       * 现成（P7.10 · #2）：原生 datalist → **库目录树**（`ui/folder-tree.ts`，三处共用）。
       * 点节点 = 选中（写进输入框）；**输入框保留成"手动输入"小口**（照样能手输完整相对路径）。
       * 树以**库根**为基准（'' = 库根自己；不画"根"那一行 —— 工作文件夹选的就是库根之下哪一坨）。
       * ⚠️ **「新建」模式照旧不画树**：目录还不存在，没有可点的东西。
       */
      const treebox = div({ cls: 'kbw-wiz-treebox' });
      const tree = folderTree(ctx.app, '', {
        onPick: (rel) => {
          kbRoot = rel;
          input.value = rel;
          refreshHint();
        },
        selected: normPath(kbRoot),
      });
      treebox.appendChild(tree);
      content.appendChild(treebox);
      const input = el('input', {
        cls: 'kbw-input',
        attr: { type: 'text', spellcheck: 'false', placeholder: '也可直接输入相对路径' },
      }) as HTMLInputElement;
      input.value = kbRoot;
      input.addEventListener('input', () => {
        kbRoot = input.value.trim();
        refreshHint();
      });
      field('工作文件夹', input, content);
      const metaInput = el('input', {
        cls: 'kbw-input',
        attr: { type: 'text', spellcheck: 'false' },
      }) as HTMLInputElement;
      metaInput.value = metaDir;
      metaInput.addEventListener('input', () => {
        metaDir = metaInput.value.trim();
        refreshHint();
      });
      // P7.10 · #2：「元数据目录名」→「库配置目录」（label + 下面校验提示两处；内部键名不动）
      field('库配置目录', metaInput, content);
      input.focus();
    }

    refreshHint();
    content.appendChild(hint);
    body.appendChild(content);
  }

  // ── 屏 2：模块开关（零 lead；desc 压成 ≤6 字 —— P7.9 · ①）────
  function paintModules(): void {
    for (const f of [
      { id: 'graph' as const, label: '图谱', desc: '笔记之间的连线' },
      {
        // P7.10 · #3：向导这一处叫「笔记自动化」——**只此一处**（设置栏名 / 底栏状态 /
        // FEATURES 标签保持「自动化」；`自动化.json` 与内部 id 不动。已拍板，别顺手全仓改）
        id: 'automation' as const,
        label: '笔记自动化',
        desc: '归位与补全',
      },
    ]) {
      const on = ctx.gate.isOn(f.id);
      const row = div({ cls: ['kbw-wiz-toggle', on ? 'is-on' : null] });
      /**
       * ⚠️ 类名**不要**跟 AI 面板那个勾选框共用（`kbw-ai-check`）：两处的勾选语义完全不同
       *（那边是"执行哪几条建议"，这边是"开哪个模块"），而 `document` 上按类名找元素是
       *本项目判据的常规动作 —— 共用一个类名会让"数勾选框"这类判据数到别人家的。
       */
      const cb = el('input', { cls: 'kbw-wiz-check-box', attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = on;
      cb.addEventListener('change', () => {
        void ctx.gate.set(f.id, cb.checked);
        row.classList.toggle('is-on', cb.checked);
        /**
         * P7.17 · 用户第 1 条：**勾开「笔记自动化」→ 滑出存量补齐询问卡**
         *（只认"拨开"这一下；进屏时已经开着的**不弹卡** —— 那多半是重跑向导，
         * 次入口在设置 → 自动化里）。关掉 → 卡跟着撤。
         */
        if (f.id === 'automation') {
          if (cb.checked) void showBackfillAsk(row);
          else dismissBackfillAsk();
        }
      });
      row.appendChild(cb);
      const txt = div({ cls: 'kbw-wiz-toggle-txt' });
      txt.appendChild(div({ cls: 'kbw-wiz-toggle-label', text: f.label }));
      txt.appendChild(div({ cls: 'kbw-wiz-toggle-desc', text: f.desc }));
      row.appendChild(txt);
      body.appendChild(row);
    }
  }

  // ── 屏 2 的询问卡（P7.17 · 存量补齐主入口）────────────────────
  /**
   * 「勾开笔记自动化 → 库里还有 N 篇旧笔记没有完整属性头 —— 要现在补齐吗？」
   *
   * 三条口径（P7.17 §1 入口）：
   *   · **N = "会改到的"篇数**（补 / 覆盖；纯跳过的不计）—— `backfill.planTodoCount`，
   *     与 backfill 面板、设置里那条动态提示**同一个数**；
   *   · **异步扫、卡先出**（别让向导卡在扫描上）：先插"正在清点…"，扫完原地更新；
   *   · N = 0 → 换成"都齐了 ✓"（不是画一张"0 篇补什么"的卡）。
   * 「去补全」开 `openBackfillPanel`（叠一扇模态在向导上 —— 与 confirm 叠面板同一形态）；
   * 「以后再说」撤卡；再拨一次开关会重新清点。
   */
  let askCard: HTMLElement | null = null;

  function dismissBackfillAsk(): void {
    askCard?.remove();
    askCard = null;
  }

  async function showBackfillAsk(anchor: HTMLElement): Promise<void> {
    dismissBackfillAsk();
    const card = div({ cls: 'kbw-wiz-ask' });
    const line = div({ cls: 'kbw-wiz-ask-t', text: '正在清点库里还有多少篇旧笔记…' });
    card.appendChild(line);
    anchor.after(card);
    askCard = card;
    let n: number;
    try {
      const plan = await planBackfillOf(ctx);
      if (askCard !== card) return; // 已经被"以后再说"撤掉 / 被下一次拨开替换
      n = planTodoCount(plan);
    } catch (e) {
      console.warn('[经纬] 向导里清点存量笔记失败（不画询问卡）', e);
      if (askCard === card) dismissBackfillAsk();
      return;
    }
    const btns = div({ cls: 'kbw-wiz-ask-btns' });
    if (n === 0) {
      line.textContent = '库里的属性头都已经齐了 ✓';
      btns.appendChild(
        btn({ cls: 'kbw-btn is-small is-ghost', text: '知道了', on: { click: () => dismissBackfillAsk() } }),
      );
    } else {
      line.textContent = `库里还有 ${n} 篇旧笔记没有完整属性头 —— 要现在补齐吗？`;
      btns.appendChild(
        btn({
          cls: 'kbw-btn is-small is-primary',
          text: '去补全',
          on: {
            click: () => {
              dismissBackfillAsk();
              openBackfillPanel(ctx);
            },
          },
        }),
      );
      btns.appendChild(
        btn({ cls: 'kbw-btn is-small is-ghost', text: '以后再说', on: { click: () => dismissBackfillAsk() } }),
      );
    }
    card.appendChild(btns);
  }

  // ── 屏 3：结语（接下来去哪；P7.10 · #4：四张卡 2×2、「首页」在左上、卡内只有大字居中）──
  function paintEpilogue(): void {
    body.appendChild(div({ cls: 'kbw-wiz-lead', text: '都齐了。接下来去哪？' }));
    const zone = div({ cls: 'kbw-wiz-cards' });
    /** 底图 = 引言右侧那张首页照（复用，不额外拍）——加载失败只是没底纹，不影响任何事 */
    const bg = el('img', {
      cls: 'kbw-wiz-cardbg',
      attr: { src: assetUrl(ctx, SHOTS.home), alt: '', draggable: 'false' },
    }) as HTMLImageElement;
    bg.addEventListener('error', () => bg.classList.add('is-missing'));
    zone.appendChild(bg);
    const row = div({ cls: 'kbw-wiz-cardrow' });
    /**
     * 四张卡（P7.10 · #4；二拍①：**卡内不放小字，四张全大字居中**）。
     * 「首页」排第一（2×2 的左上格）、`is-home` 紫色强调 —— 修的就是
     * "结语想去首页没有出口"（原先三张卡没首页，得先随便切一个再点导航）。
     */
    const cards: { id: 'home' | 'notes' | 'board' | 'ai'; title: string }[] = [
      { id: 'home', title: '首页' },
      { id: 'notes', title: '全部笔记' },
      { id: 'board', title: '看板' },
      { id: 'ai', title: 'AI 助手' },
    ];
    for (const c of cards) {
      const card = div({
        cls: ['kbw-wiz-card', c.id === 'home' ? 'is-home' : null],
        attr: { role: 'button', tabindex: '0' },
      });
      card.appendChild(div({ cls: 'kbw-wiz-card-t', text: c.title }));
      /**
       * **点卡片 = 记「完成」+ 切过去**（与「完成」同一个出口，再走导航同一条路：
       * `ctx.goHome() / goNotes() / goBoard() / openAi()` —— 不新开通道。
       * `goHome` 是 P7.10 补的那一口，`main.ts` 里与 goNotes/goBoard 同型）。
       */
      const pick = (): void => {
        finish(true);
        if (c.id === 'home') ctx.goHome();
        else if (c.id === 'notes') ctx.goNotes();
        else if (c.id === 'board') ctx.goBoard();
        else ctx.openAi();
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (evt) => {
        const k = (evt as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          evt.preventDefault();
          pick();
        }
      });
      row.appendChild(card);
    }
    zone.appendChild(row);
    body.appendChild(zone);
    // 页脚句已删（P7.9 · ①：点一张就知道 —— 效果稿注明）
  }

  // ── 小工具：一行「标签 + 控件」（字段注随极简版一起退役 —— P7.9 · ①）──
  // v2（#8）：挂载宿主可传（内容区那层要整块淡入），默认仍是 body。
  function field(label: string, input: HTMLInputElement, host: HTMLElement = body): void {
    const row = div({ cls: 'kbw-wiz-field' });
    row.appendChild(span({ cls: 'kbw-wiz-field-label', text: label }));
    row.appendChild(input);
    host.appendChild(row);
  }

  void paint();
  return h;
}
