/**
 * ui/new-note.ts —— 「新建笔记」对话框（交互规格 §1.2 / §2.2 / §8.2）
 *
 * 三个入口都走它，**只有一处实现**：命令面板「经纬：新建笔记」、首页「＋ 新建笔记」、
 * 目录树节点的「在此新建笔记」（后者预填那个目录）。
 *
 * 流程（用户 2026-09-24 拍板）：**选模板 → 文件名（默认当天日期）→ 笔记位置（默认 00_Inbox，可改）**
 *   → 落一个**空文件** → 交给 Templater → 本插件只在它不动手时补
 *
 * ⚠️ **下拉的第一项是「不使用模板」（默认项，用户 2026-09-27 拍板）**：它走的是**另一条路** ——
 *   带着前言 + 尾链**一次落盘**、不落空文件、也不让位给 Templater（正文非空它就不动手）。
 *   为什么默认它：这条是"我就想从空白开始写"的诉求，而"选一个模板"是更重的决定。
 *   它**不落进任何持久化字段**：每次打开对话框都回到这一项（那是"这次的选择"，不是"上次的选择"）。
 *
 * **极简版（P7.9 · ② 拍板）**：去掉三条字段注 / 下拉长说明段 / 子标题 —— 表单只剩三行（值）。
 *   两处替代：
 *   · 「＋ 新建模板…」= 模板下拉底部的特值项（选中 → 问名字 → 在模板目录落 `T_<名>.md`
 *     → 刷新并选中；**不打断**当前流程，通知里给「打开它」）；
 *   · **条件警告**（P1）：常态零小字，只有"选了模板但当前环境不会应用它"才出现一行
 *     （见 `refreshWarn` 的三种情形）—— 那是必要告知，不是解释。
 *
 * 为什么落空文件而不是直接写模板：Templater 的「新建时触发」只在**空文件**上生效，
 * 先写前言会让它**不触发**（`排查报告.md` §六 那条实测）。所以"用户选的模板"
 * 只在 Templater 不接管时生效 —— 不生效时由那行条件警告说出来，别让人以为选了个寂寞。
 *
 * 笔记位置依据会跟着通知报出来（`排查报告.md` §五 ⭐4：标签源落点是查表算的，落错要知道改哪条）。
 */
import type { TFile, TFolder } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { inKbScope, joinPath, relativeTo } from '../core/paths';
import { renderNamingTemplate, resolveNamingTemplate } from '../core/naming';
import { markSelfWrite } from '../core/writes';
import {
  folderTemplateFor,
  hasTemplaterSyntax,
  isTemplaterManaged,
  readTemplater,
  templateFiles,
} from '../services/templates';
import { btn, div, el, span } from './primitives';
import { openModal } from './panel';
import { notify, notifyError, NOTIFY_MS } from './notify';
import { promptText } from './prompt';
import { uniqueTemplatePath } from './settings/templates';
// P7.10 · #7：对话框左下那枚「如何新建模板」→ 教程中心该篇（待消费意图）
import { openTutorialCenter } from './tutorial';
import { recordOnboarding } from '../modules/home/onboarding';

/**
 * 「＋ 新建模板…」的骨架（**P7.13a · #1 拍定**：六件 + 骨架 + 尾链段）。
 * `{{title}}` / `{{date}}` / `{{center}}` / `{{moc}}` 是本插件的占位符
 * （`services/templates.ts` 的 6 个），**不依赖 Templater** —— 没装它这骨架
 * 也照样能被"新建笔记补全"求值（套用时求不到的行整行删，见 `composeFromTemplate`）。
 *
 * 六键（Q1 拍定 B 档：五件套全上 + `收藏: false`）：
 *   · `类型: 模板`（这份文件自己是模板 —— 套用时的真类型由补全按目录默认换算）；
 *   · `状态:`（空 —— 模板文件没有"进行中"这回事，套用时按目录默认换算）；
 *   · `文件位置` = 模板库目录（这份文件自己的所在地）；
 *   · `创建日期: "{{date}}"` —— **带引号存**：裸占位符在 YAML 里是流式映射，
 *     属性面板往返一次就被写成 `{"{ date }":null}`（P2 实测，这就是 #6 的"坏模板"根源）；
 *   · `tags: []`；`收藏: false`（Q0：骨架 + 新建笔记都带）。
 *
 * ⚠️ `状态:` 空值的**属性面板往返安全性**是拍定里点名的真机验证项（P2 教训）。
 * 纯函数（喂目录出文本），判据在 `tests/specs/p79.ts`。
 */
export function templateSkeleton(dirRel: string): string {
  return [
    '---',
    '类型: 模板',
    '状态:',
    '文件位置:',
    `  - ${dirRel}`,
    '创建日期: "{{date}}"',
    'tags: []',
    '收藏: false',
    '---',
    '',
    '# {{title}}',
    '',
    '## 关联笔记',
    '- 相关笔记：[[]]',
    '- 所属中心：{{center}}',
    '- 返回大地图 {{moc}}',
    '',
  ].join('\n');
}

export interface NewNoteOptions {
  /** 预填落点（目录树「在此新建」传它；相对库根） */
  dirRel?: string;
  /** 预填文件名（「导出为笔记」用；不传 = 今天日期） */
  presetTitle?: string;
  /**
   * **导出为笔记**（P7.3a）：带它 = 正文会写进这篇新笔记。
   * 这条路**不套模板**（对话记录就是正文）—— 模板那一行整行不画，文案换一句实话。
   */
  bodyText?: string;
}

/** 库根之下的全部目录（相对库根，按路径排序）——落点下拉的候选 */
export function kbDirs(ctx: WorkbenchContext): string[] {
  const kbRoot = ctx.settings.kbRoot();
  const out: string[] = [''];
  const all = ctx.app.vault.getAllLoadedFiles();
  for (const f of all) {
    const node = f as TFolder;
    if (!node.children) continue; // 不是文件夹
    // P7.14：inKbScope（'' = 整个库）；库根本身排除（out 里已经有 '' 那项）
    if (!inKbScope(node.path, kbRoot)) continue;
    const rel = relativeTo(node.path, kbRoot);
    if (rel === '') continue;
    out.push(rel);
  }
  out.sort((a, b) => a.localeCompare(b, 'zh'));
  return out;
}

export function openNewNoteDialog(ctx: WorkbenchContext, opts: NewNoteOptions = {}): void {
  const exportMode = opts.bodyText != null && opts.bodyText.trim() !== '';
  const h = openModal({
    title: '新建笔记',
    // P7.9 · ② 拍板：**子标题整句删除**（极简：表单自己说话）——导出模式也一样
    width: 'normal',
  });

  const dirs = kbDirs(ctx);
  const defaultDir =
    opts.dirRel != null && dirs.includes(opts.dirRel)
      ? opts.dirRel
      : dirs.includes('00_Inbox')
        ? '00_Inbox'
        : '';

  // ── 文件名 ────────────────────────────────────────────────────
  /**
   * 默认名 = **命名模板渲染**（1.4，P7.2b）：`namingTemplate` 没改过时是
   * `YYYY-MM-DD HHmm` → `2026-10-03 2105`（原来的 `YYYY-MM-DD` 不再使用）。
   * 渲染与默认值都在 `core/naming.ts` —— 两处共用那一份。
   */
  const titleInput = el('input', {
    cls: 'kbw-input',
    attr: {
      type: 'text',
      placeholder: '文件名（不含 .md）',
      value:
        opts.presetTitle?.trim() ||
        renderNamingTemplate(resolveNamingTemplate(ctx.settings.get()), new Date()),
    },
  });

  // ── 落点 ─────────────────────────────────────────────────────
  const dirSel = el('select', { cls: 'kbw-select' });
  for (const d of dirs) {
    dirSel.appendChild(
      el('option', { attr: { value: d }, text: d === '' ? `（库根：${ctx.settings.kbRoot() || '整个库'}）` : d }),
    );
  }
  dirSel.value = defaultDir;

  // ── 模板 ─────────────────────────────────────────────────────
  const tplSel = el('select', { cls: 'kbw-select' });

  /**
   * 下拉的**第一项、也是默认项**（用户 2026-09-27 拍板）：不套任何模板，
   * 只补前言 + 结尾双链，正文留空给你自己写。用**空串**当它的值 ——
   * `templateFiles()` 出来的一律是库内绝对路径，空串不可能是模板路径。
   * ⚠️ 选项文案 P7.9 收成「不使用模板」（原括注进条件警告 / 文档，极简拍板）。
   */
  const NO_TEMPLATE = '';
  /** 「＋ 新建模板…」的特值（真模板一律是库内绝对路径，造不出这个名字） */
  const NEW_TEMPLATE = '\u0000new-template';

  /**
   * **条件警告**（P1 拍板）：常态零小字 —— 只有"选了模板但当前环境不会应用它"
   * 才出现一行。`refreshWarn` 里是三种情形；行文各自说清是哪种。
   */
  const tplWarn = div({ cls: 'kbw-form-hint is-warn' });
  const showWarn = (text: string): void => {
    tplWarn.textContent = text;
    tplWarn.style.display = text ? '' : 'none';
  };
  showWarn('');

  const tp = readTemplater(ctx.app);
  let tpls = templateFiles(ctx.app, ctx.settings);
  /** 上一次的**真实**选择（取消「新建模板」时要回到这儿；特值项不进这里） */
  let lastTpl = NO_TEMPLATE;

  /**
   * `reset` = 重新摆默认项（只在开场那一次）。
   * ⚠️ 换落点时**不重置**：用户刚挑好的模板不该因为他改了目录就被顶回去。
   */
  const paintTemplates = (reset: boolean): void => {
    const keep = tplSel.value;
    while (tplSel.firstChild) tplSel.removeChild(tplSel.firstChild);
    tplSel.appendChild(
      el('option', {
        attr: { value: NO_TEMPLATE },
        text: '不使用模板',
      }),
    );
    const dirRel = dirSel.value;
    const dirAbs = joinPath(ctx.settings.kbRoot(), dirRel);
    const recommended = folderTemplateFor(tp, dirAbs);
    for (const f of tpls) {
      const isRec = recommended != null && f.path === recommended;
      tplSel.appendChild(
        el('option', {
          attr: { value: f.path },
          text: `${isRec ? '★ ' : '   '}${f.basename}`,
        }),
      );
    }
    /**
     * 底部特值项（P7.9 · ② 拍板）：**＋ 新建模板…** —— 原生下拉放不了按钮，
     * 特值选项 + change 事件就是那条路（选中 → 问名字 → 落盘 → 刷新并选中）。
     */
    tplSel.appendChild(el('option', { attr: { value: NEW_TEMPLATE }, text: '＋ 新建模板…' }));
    tplSel.value = reset ? NO_TEMPLATE : keep;
  };

  /**
   * 条件警告的判据（P1 拍板）——**只回答一件事：你这次的选择会不会按预期生效**。
   * 情形（独立审 🟡3 修正后；**P7.13a · #2 · Q6 拆两层后重排**）：
   *   ⓪ 「不使用模板」+ 补全关着 → 落的是**空文件**（旧长说明那句的接棒 —— 极简后由这行说）；
   *   ① 目录**被 Templater 接管**：选的就是 ★ 那一枚 → **生效**（Templater 拿它填，只是换了个执行者）；
   *      选的不是 → 不生效；
   *   ② 模板含 `<% %>` 且目录没被接管 → 本插件跳过、Templater 也不来（**开关开没开都一样**，
   *      所以判在开关那条**前面**）；
   *   ③ 补全关着（且不是 ①② ）→ **模板照套、只落原文**：六件套 + 尾链的补齐归开关
   *      （拍定原话："套用是显式动作、不受开关管；补齐归开关"）。
   * ⚠️ 判 ② 要异步读模板正文 —— 用序号防"切得快、回包乱序"。
   */
  let warnSeq = 0;
  async function refreshWarn(): Promise<void> {
    const seq = ++warnSeq;
    const path = tplSel.value;
    if (path === NEW_TEMPLATE) {
      showWarn('');
      return;
    }
    const dirRel = dirSel.value;
    const dirAbs = joinPath(ctx.settings.kbRoot(), dirRel);
    const recommended = folderTemplateFor(tp, dirAbs);
    const managed = isTemplaterManaged(tp, dirAbs);
    const completionOn = await ctx.completion.isOn();
    if (seq !== warnSeq) return; // 又切过了，这发作废
    if (path === NO_TEMPLATE) {
      showWarn(completionOn ? '' : '「新建笔记补全」关着：这次只落一个空文件');
      return;
    }
    /**
     * 目录被 Templater 接管：正文由 ★ 那个目录模板来填 ——
     * 选的**就是它** = 生效（不管补全开没开）；选的是别的 = 你选的这枚不生效。
     */
    if (managed) {
      showWarn(path === recommended ? '' : '这个目录由 Templater 接管：你选的模板现在不会生效');
      return;
    }
    const file = ctx.app.vault.getAbstractFileByPath(path);
    let hasTpl = false;
    if (file && 'stat' in file) {
      try {
        hasTpl = hasTemplaterSyntax(await ctx.app.vault.cachedRead(file as TFile));
      } catch {
        hasTpl = false;
      }
    }
    if (seq !== warnSeq) return;
    if (hasTpl) {
      showWarn(
        tp.present
          ? '模板含 <% %>，而这个目录没有 Templater 目录规则：不会生效'
          : '没装 Templater：这个模板现在不会生效',
      );
      return;
    }
    if (!completionOn) {
      // P7.13a · #2 · Q6：模板照套（只落原文）——如实说少了什么，别再写"不会生效"
      showWarn('「新建笔记补全」关着：这次只套用模板原文（不补属性与尾链）');
      return;
    }
    showWarn('');
  }

  /**
   * 「＋ 新建模板…」（P7.9 · ② · P2 拍板）：问名字 → 在模板目录落 `T_<名>.md`
   *（强制 `T_` 前缀、重名加序号）→ 刷新下拉并**选中刚建的那个**。
   * **不打断当前流程**：建完这个对话框还在原地（通知里给「打开它」，想去才去）。
   * 落盘走 `vault.create` + `markSelfWrite`（与设置栏「新建空白模板」同口径 ——
   * 新建不覆盖、不是 mover 的活；`uniqueTemplatePath` 两条入口共用一份）。
   */
  async function createTemplate(): Promise<void> {
    const name = await promptText({
      title: '新建模板',
      label: '模板名（自动加 T_ 前缀）',
      placeholder: 'T_我的模板',
      primary: '创建',
      // P7.10 · #7：左下那枚 —— 关掉本框、打开帮助栏并展开《如何新建模板》
      //（点它 = 取消：`promptText` 先 `finish(null)`，下面的 `if (!name)` 分支照常收尾）
      link: { label: '如何新建模板', run: () => openTutorialCenter(ctx, 'new-template') },
    });
    if (!name) {
      tplSel.value = lastTpl;
      void refreshWarn();
      return;
    }
    try {
      const path = await uniqueTemplatePath(ctx, name);
      markSelfWrite(path);
      // 骨架的「文件位置」= 模板库目录（相对库根）—— 与"这份文件自己的所在地"一致
      const made = await ctx.app.vault.create(
        path,
        templateSkeleton(relativeTo(ctx.settings.templateDir(), ctx.settings.kbRoot())),
      );
      tpls = templateFiles(ctx.app, ctx.settings);
      paintTemplates(false);
      tplSel.value = made.path;
      lastTpl = made.path;
      void refreshWarn();
      notify({
        kind: 'success',
        text: `已新建模板 ${made.basename}`,
        detail: '正文里的 {{title}} / {{date}} 是占位符，套用时自动替换',
        actions: [
          { label: '打开它', run: () => void ctx.app.workspace.getLeaf('tab').openFile(made) },
        ],
        ms: NOTIFY_MS.long,
      });
    } catch (e) {
      notifyError('新建模板失败', e instanceof Error ? e.message : String(e));
      tplSel.value = lastTpl;
    }
  }

  tplSel.addEventListener('change', () => {
    const v = tplSel.value;
    if (v === NEW_TEMPLATE) {
      void createTemplate();
      return;
    }
    lastTpl = v;
    void refreshWarn();
  });
  dirSel.addEventListener('change', () => {
    paintTemplates(false);
    void refreshWarn();
  });
  paintTemplates(true);
  void refreshWarn();

  // ── 组装（P7.9 · ②：**三行 + 值**，零字段注；条件警告挂在模板行下）────
  const form = div({ cls: 'kbw-form' });
  form.appendChild(field('文件名', titleInput));
  form.appendChild(field('笔记位置', dirSel));
  if (!exportMode) form.appendChild(field('模板', tplSel, tplWarn));
  h.body.appendChild(form);

  // ── 底部 ─────────────────────────────────────────────────────
  h.foot.style.display = '';
  let busy = false;
  const createBtn = btn({
    cls: 'kbw-btn is-primary',
    text: '新建',
    on: {
      click: () => {
        void run();
      },
    },
  });
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => h.close('cancel') } }));
  h.foot.appendChild(createBtn);

  titleInput.addEventListener('keydown', (evt) => {
    if ((evt as KeyboardEvent).key === 'Enter') {
      evt.preventDefault();
      void run();
    }
  });

  async function run(): Promise<void> {
    if (busy) return;
    const title = titleInput.value.trim();
    if (!title) {
      notifyError('先给这篇笔记取个名字');
      titleInput.focus();
      return;
    }
    busy = true;
    createBtn.toggleAttribute('disabled', true);
    try {
      const res = await ctx.completion.createNote({
        title,
        dirRel: dirSel.value,
        // 空串 = 「不使用模板」：两条互斥的路，别同时传；导出模式一律走"不使用模板"
        noTemplate: exportMode || tplSel.value === NO_TEMPLATE,
        templatePath: exportMode || tplSel.value === NO_TEMPLATE ? undefined : tplSel.value,
        body: exportMode ? opts.bodyText : undefined,
      });
      // 16.13（P7.2d）：建过第一篇笔记 —— 新建对话框这条成功路（快捕/剪藏另有两处）
      recordOnboarding(ctx, 'created');
      notify({
        kind: 'success',
        text: `已新建「${title}」`,
        detail: `笔记位置 ${dirSel.value || ctx.settings.kbRoot() || '整个库'} · 依据：${res.rule}`,
        ms: NOTIFY_MS.light,
      });
      h.close('created');
      // 打开它让你直接写（Templater 的落笔与这一步无关，它认的是 vault 事件）
      const file = ctx.app.vault.getAbstractFileByPath(res.path);
      if (file) await ctx.app.workspace.getLeaf('tab').openFile(file as TFile);
    } catch (e) {
      notifyError('新建失败', e instanceof Error ? e.message : String(e));
      busy = false;
      createBtn.toggleAttribute('disabled', false);
    }
  }

  titleInput.focus();
  titleInput.select();
}

/**
 * 一行「标签 + 控件（+ 可选小字）」。`hint` 收字符串（静态小字）或元素
 *（P7.9 · ②：条件警告是个**活的** div，要能就地改文案 / 显隐）。
 */
function field(label: string, control: HTMLElement, hint?: string | HTMLElement): HTMLElement {
  const row = div({ cls: 'kbw-form-row' });
  row.appendChild(span({ cls: 'kbw-form-label', text: label }));
  const box = div({ cls: 'kbw-form-ctl' });
  box.appendChild(control);
  if (typeof hint === 'string') box.appendChild(div({ cls: 'kbw-form-hint', text: hint }));
  else if (hint) box.appendChild(hint);
  row.appendChild(box);
  return row;
}
