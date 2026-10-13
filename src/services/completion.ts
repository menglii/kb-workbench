/**
 * services/completion.ts —— 新建笔记补全的**运行时**（`交互规格.md` §7.1 / §13）
 *
 * 三件事，都在这个文件里，别处不许再抄一份：
 *   ① `createNote()` —— 「新建笔记」落一个**空**文件，然后交给 Templater
 *      （⚠️ 不能自己先填内容：先写前言会让 Templater 的"新建时触发"**不触发**，
 *        这正是"180ms 抢写"那个坑的另一面 —— `排查报告.md` §六）
 *   ② 监听 `vault.create`：库里新出现一个空 `.md` → 按 §7.1 那张表决定补什么
 *   ③ `fillFile()` —— 补全一篇（新建与存量共用的写盘口；判据在 `templates.buildFillPlan`）
 *
 * 等待策略（§7.1，两条来自实测）：
 *   · **从 Templater 的 300ms 判定点起算**（不是 180ms），期间它又落笔就续期，累计封顶 800ms
 *   · 模板是**交互式**的（`tp.system.prompt`）→ 封顶必须被突破（它在等你输字，不是"不动手"）
 *
 * 让位规则（§7.1 最后两行）：目录一旦被 Templater 的「目录模板」接管，
 * **正文整个让给它**，本插件只补一个「文件位置」键（只加不覆盖、值留空）。
 */
import { TFile, type App, type EventRef } from 'obsidian';
import type { SettingsStore } from '../core/settings';
import type { ModuleGate } from '../core/modules';
import { markSelfWrite } from '../core/writes';
import { isInside, joinPath, parentDir, relativeTo, stripExt } from '../core/paths';
import { sleep } from '../core/util';
import { notifyLight } from '../ui/notify';
import { buildFillPlan, fencesOf, noteContext, pickTemplate, readTemplater, renderPlaceholders,
  isTemplaterManaged, isInteractiveTemplate, type FillPlan } from './templates';
import { readRouteTable, tagDirs } from './routes';
import { ROOT_POS, asList, asString, defaultsForDir, fragileKeys } from './schema';
import { hasFrontmatter } from './frontmatter';
import { baseName } from '../core/paths';
import type { AutomationStore } from './automation';

/** Templater 的判定点（`排查报告.md` §六：180ms 会赶在它落笔前抢先写） */
export const JUDGE_MS = 300;

/**
 * 目录被 Templater 接管时，**最多等它落笔多久**（毫秒）—— P7.12 收尾加的轮询上限。
 * 取 3s：真机上 Templater 的目录模板通常在 1s 内落笔；探针的新建步等 4s，正好覆盖。
 * 超时 = 按"不插手"返回 none（老纪律，别改成"替它写"）。
 */
export const TEMPLATER_WAIT_MS = 3000;
/** 累计封顶 */
export const CAP_MS = 800;
/** 交互式模板（在等你输入）——封顶必须被突破，但总得有个头 */
export const INTERACTIVE_CAP_MS = 15000;

export interface NewNoteRequest {
  /** 文件名（不含扩展名） */
  title: string;
  /** 落点（**相对库根**；'' = 库根下） */
  dirRel: string;
  /**
   * 用户在对话框里选的模板（库内绝对路径）。
   * ⚠️ **必须传**：不传的话补全会自己按套用规则重挑一个 —— 于是"用户选的模板"被完全忽略，
   * 界面上却写着"Templater 不动手时按你选的模板补"（独立审查抓到的 🔴：选了等于没选）。
   */
  templatePath?: string;
  /**
   * **「不使用模板」**（新建对话框下拉的第一项，用户 2026-09-27 拍板）：
   * 只补前言 + 尾链、正文留空，**不让位给 Templater**（细节见 `FillOptions.noTemplate`）。
   * 与 `templatePath` 互斥：传它就按没有模板走。
   */
  noTemplate?: boolean;
  /**
   * **落盘之后再补的属性**（e2 期 §4.3 Quick Capture）：让这一条**真的落进**用户选的那个板块。
   *
   * 🔴 **必须等 Templater 的判定点之后**才写（就是本服务的 `waitQuiet` 那道）——
   * 先写前言会让 Templater 的「新建时触发」**不触发**（`排查报告.md` §六那条实测）。
   * 所以它走的是"补全流程末尾"这一站，不是"create 之前先写好"。
   */
  extraProps?: ExtraProps;
  /**
   * **正文**（P7.3a「导出为笔记」）。只在 `noTemplate` 那条路上生效：
   * 拼在**前言与尾链之间**，仍是**一次 `vault.create`** —— 不新开写盘路径。
   * 与 `templatePath` 互斥（导出不套模板：对话记录就是正文）。
   */
  body?: string;
  /**
   * 带 `body` 时 rule 文案里那个来源词（默认 `'导出为笔记'`）。
   * P7.2c 剪藏走同一条路（正文 = 剥好的网页文本），rule 里说"导出"就是谎话 ——
   * 收据（`rule`）如实报，是这套链路一贯的口径。
   */
  bodyFrom?: string;
}

/** 「丢一条」时要顺手补的东西（Quick Capture 用；语义见 `modules/board/capture.ts` 头注释） */
export interface ExtraProps {
  /** 覆盖写进前言的属性（用户显式选了落点 → 以他的选择为准） */
  props?: Record<string, unknown>;
  /** **并进** `tags` 的标签（并集：模板已经写了的留着） */
  tags?: string[];
}

export interface NewNoteResult {
  path: string;
  /** 落点依据（给人看的：Notice 报的就是它，排查报告 ⭐4） */
  rule: string;
}

export interface FillOutcome {
  kind: 'filled' | 'props' | 'none' | 'skipped' | 'failed';
  /** 给人看的一句话 */
  detail: string;
  path: string;
}

interface PendingFill {
  announce: boolean;
  templatePath?: string;
  extraProps?: ExtraProps;
  /** 这一轮的补全 IIFE 已经起过了吗（`startRun` 幂等 —— 见 `createNote` 的预登记注释） */
  started?: boolean;
}

export class CompletionService {
  private app: App;
  private settings: SettingsStore;
  private gate: ModuleGate;
  private automation: AutomationStore;
  private refs: EventRef[] = [];
  /**
   * 正在等的文件 → 这一轮的参数（避免同一个文件被两次 create 事件重复排程；
   * 后到的那一次只**合并参数**，见 `schedule` 的注释）
   */
  private pending = new Map<string, PendingFill>();
  /** 测试与排查用：最近一次为什么没补 */
  public lastSkip: string | null = null;

  constructor(app: App, settings: SettingsStore, gate: ModuleGate, automation: AutomationStore) {
    this.app = app;
    this.settings = settings;
    this.gate = gate;
    this.automation = automation;
  }

  // ── 配置 ──────────────────────────────────────────────────────
  /** 补全开着吗：模块开关 + `自动化.json` 里的 completion.enabled 两个都要看 */
  async isOn(): Promise<boolean> {
    if (!this.gate.isOn('completion')) return false;
    return (await this.automation.get()).completion.enabled;
  }

  // ── 建一篇新笔记 ──────────────────────────────────────────────
  /**
   * 落一个**空文件**（0 字节），把正文让给 Templater。
   * 返回落点与依据 —— 依据要能被 Notice 报出来（落错了得知道改哪条规则）。
   */
  async createNote(req: NewNoteRequest): Promise<NewNoteResult> {
    const kbRoot = this.settings.kbRoot();
    const dirRel = String(req.dirRel ?? '').replace(/^\/+|\/+$/g, '');
    const dirAbs = dirRel ? joinPath(kbRoot, dirRel) : kbRoot;
    if (!(await this.app.vault.adapter.exists(dirAbs))) {
      await this.app.vault.adapter.mkdir(dirAbs); // S3 实测：一次能建多级
    }
    const title = String(req.title ?? '').trim() || '未命名';
    const path = this.uniquePath(joinPath(dirAbs, `${sanitize(title)}.md`));
    /**
     * 🔴 **「不使用模板」：带着前言 + 尾链一次落盘**（`FillOptions.noTemplate`）。
     * 不落空文件、也不等 Templater —— 那两件事都属于"让它接管"，而这条路恰恰是
     * "我们说了算"。一次 `vault.create(path, text)` 还有个附带好处：**没有空文件窗口**，
     * Templater 的「新建时触发」连一帧都看不到空正文（它认的就是"剥掉前言后正文为空"）。
     */
    if (req.noTemplate) {
      const made = await this.noTemplateText(path, req.body);
      markSelfWrite(path);
      const file = await this.app.vault.create(path, made?.text ?? '');
      const hasBody = req.body != null && req.body.trim() !== '';
      /**
       * 🔴 **`extraProps` 在这条路上也要补**（P7.2c 剪藏）：Templater 的那条理由
       *（"先写前言会让它不触发"）在这条路上**不存在** —— 正文一次落盘、Templater
       * 本来就看不到空文件。剪藏的 `来源` 走的就是这里（走"排程补全"那条会漏）。
       */
      const outcome = await this.applyExtraProps(file, req.extraProps, {
        kind: hasBody ? 'filled' : 'props',
        detail: '',
        path: file.path,
      });
      const extraNote = outcome.detail.replace(/^；/, '');
      const from = req.bodyFrom ?? '导出为笔记';
      return {
        path: file.path,
        rule:
          (made == null
            ? '不使用模板（「新建笔记补全」关着，落了个空文件）'
            : hasBody
              ? made.didFm
                ? `${from}：正文随前言 + 尾链一次落盘`
                : `${from}：只写了正文（「新建笔记补全」关着，没补前言）`
              : made.didFm
                ? '不使用模板：只补了前言 + 结尾双链'
                : '不使用模板：只写了正文') + (extraNote ? ` · ${extraNote}` : ''),
      };
    }
    markSelfWrite(path);
    /**
     * 🔴 **预登记这一轮的参数（P7.12 · #6② 真机复现的竞态修复）**：
     * `vault.create('')` 会在**同一次调用里**派发 `create` 事件 —— 事件那条路立刻开始排程补全，
     * 而它对"对话框里选的模板"一无所知。旧版靠"后到的 schedule 合并参数"补救，
     * **但补全 IIFE 可能已经读过 `templatePath` 了**（真机实测：对话框里选的是 `T_muban`，
     * 补全却按默认模板 `T_收件箱速记` 走 → 含 `<% %>` → 跳过 → **空文件** ——
     * 正是用户报的"根据模板新建的笔记却是空的"）。
     * 修法：**在 create 之前**把参数挂进 `pending`，任何先到的那一轮都拿到完整参数；
     * `schedule` 的合并分支同时负责 `startRun`（幂等，三条路谁先都可以）。
     */
    this.pending.set(path, { announce: true, templatePath: req.templatePath, extraProps: req.extraProps });
    const file = await this.app.vault.create(path, '');
    const tp = readTemplater(this.app);
    const choice = pickTemplate(this.app, this.settings, tp, {
      folderPath: dirAbs,
      defaultTemplate: (await this.automation.get()).completion.defaultTemplate,
    });
    const managed = isTemplaterManaged(tp, dirAbs);
    // 排程补全（Templater 若接管，这里会只补属性）；参数已预登记，这里只是"确保跑起来"
    this.schedule(file, { announce: true, templatePath: req.templatePath, extraProps: req.extraProps });
    const rule = managed
      ? `Templater 目录模板 → ${dirRel || kbRoot}`
      : req.templatePath
        ? `对话框里选的模板：${baseName(req.templatePath)}`
        : choice.rule;
    return { path: file.path, rule };
  }

  /**
   * 「不使用模板」那篇新笔记的**全文**（前言 + 正文 + 尾链），拿不到就返回 `null`。
   *
   * 走 `buildFillPlan` 的 `noTemplate` 分支 —— 与"套模板""存量补全"**同一份判据**，
   * 不在这里另拼一份 YAML（否则"新建"与"存量"迟早漂成两套，P3 的账）。
   *
   * ⚠️ **正文（`body`，P7.3a「导出为笔记」）在补全关着时也要落** ——
   * 补全关只管"补不补前言"，不该管"用户要写的内容"有没有写进去。
   * 返回值带 `didFm` 是为了让调用方的**文案不说谎**（前言补没补要如实报）。
   */
  private async noTemplateText(
    path: string,
    body?: string,
  ): Promise<{ text: string; didFm: boolean } | null> {
    const bodyMd = body != null && body.trim() !== '' ? `${body.replace(/\s*$/, '')}\n` : '';
    if (!(await this.isOn())) {
      return bodyMd === '' ? null : { text: bodyMd, didFm: false };
    }
    const rel = relativeTo(path, this.settings.kbRoot());
    const folderRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const ctx = noteContext(this.app, this.settings, {
      title: stripExt(baseName(path)),
      folderRel,
    });
    const plan = buildFillPlan('', {
      ctx,
      templateText: null,
      templatePath: '',
      noTemplate: true,
      // #4 拍定：新建同时写「文件位置」= 所在目录（存量补全不写，见 FillOptions.withPosition）
      withPosition: true,
      ctime: Date.now(),
    });
    if (plan.kind !== 'patch') return bodyMd === '' ? null : { text: bodyMd, didFm: false };
    /**
     * 与 `applyPlan` 的 patch 分支同一套拼法：前言（已自带一个空行）+ 正文 + 尾链。
     * `body` 只有「导出为笔记」会带（P7.3a）—— 没有它就与从前一字不差。
     */
    let out = plan.yaml ?? '';
    const didFm = out.trim() !== '';
    if (bodyMd !== '') out = `${out.replace(/\s*$/, '')}\n\n${bodyMd}`;
    if (plan.tail) out = `${out.replace(/\s*$/, '')}\n\n${plan.tail}`;
    return { text: out, didFm };
  }

  /**
   * 套用规则的**第一档：标签规则**（`交互规格.md` §7.1）。
   * 读路由表的「标签」段：这篇笔记的 `tags` 命中哪一条，就用那个目录去挑模板
   * （目录决定"文件夹规则"命中谁 —— 与 `T_智能新建` 脚本同一套表、同一个顺序）。
   * 新建的笔记还没有标签 → 命中不了 → 自然落到文件夹规则，正合设计。
   */
  private async tagDirFor(file: TFile): Promise<string | null> {
    try {
      const props = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const tags = asList(props['tags']).map((t) => String(t).replace(/^#/, '').trim());
      if (tags.length === 0) return null;
      const table = (await readRouteTable(this.app, this.settings)).table;
      const dirs = tagDirs(table, this.settings.kbRoot());
      for (const t of tags) {
        const dir = dirs[t];
        if (dir) return dir;
      }
      return null;
    } catch (e) {
      console.warn('[经纬] 查标签规则失败（当没有）', e);
      return null;
    }
  }

  private uniquePath(want: string): string {
    let candidate = want;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = want.replace(/\.md$/i, ` ${n}.md`);
      n += 1;
      if (n > 500) break;
    }
    return candidate;
  }

  // ── 监听新文件 ────────────────────────────────────────────────
  start(): void {
    if (this.refs.length > 0) return;
    this.refs.push(
      this.app.vault.on('create', (f) => {
        if (!(f instanceof TFile)) return;
        void this.onCreated(f);
      }),
    );
  }

  stop(): void {
    for (const ref of this.refs) this.app.vault.offref(ref);
    this.refs = [];
    this.pending.clear();
  }

  /** 在不在补全的范围内（**模板库与 99_Meta 不碰**：那是配置区，不是知识笔记） */
  inScope(path: string): boolean {
    if (!path.toLowerCase().endsWith('.md')) return false;
    if (!isInside(path, this.settings.kbRoot())) return false;
    if (isInside(path, this.settings.metaRoot())) return false;
    if (isInside(path, this.settings.templateDir())) return false;
    return !path.split('/').some((seg) => seg.startsWith('.'));
  }

  private async onCreated(file: TFile): Promise<void> {
    if (!this.inScope(file.path)) return;
    // 建出来就有内容（粘贴 / 别的插件注入 / 我们的操作日志）→ 不碰
    if ((file.stat?.size ?? 0) > 0) return;
    this.schedule(file, { announce: false });
  }

  /**
   * 排程一次补全。**不阻塞 create 事件**（等待最长 800ms）。
   * `announce`：是我们自己建的（命令/首页＋）→ 完事给一句轻量通知；
   * 别人建的空笔记 → 安静补，别打断。
   */
  schedule(file: TFile, opts: { announce: boolean; templatePath?: string; extraProps?: ExtraProps }): void {
    const path = file.path;
    const existing = this.pending.get(path);
    if (existing) {
      /**
       * 已经排过一轮（三路都会来：`createNote` 的**预登记**、`vault.create` 的 create 事件、
       * `createNote` 末尾那次 schedule —— 谁先到不定）。
       * ⚠️ 不能直接 `return`：那样**后到的 `announce`/`templatePath` 会被丢掉** ——
       * 若平台先发 create 事件（不带 announce），用户就永远看不到「已按模板补好这篇笔记」，
       * 而且补全可能用的是自己挑的模板而不是用户选的那个。
       * 🔴 v2（P7.12 · #6② 真机复现）：合并**必须**同时把这一轮**跑起来**
       *（`startRun` 幂等）—— 旧版在"预登记已存在"时只合并、不启动/不管启动时机，
       * 留下过"补全 IIFE 已经读过 `templatePath`、合并才姗姗来迟"的竞态，
       * 真机症状 = 用户选的模板被默认模板顶掉（详见 `createNote` 的预登记注释）。
       */
      if (opts.announce) existing.announce = true;
      if (opts.templatePath) existing.templatePath = opts.templatePath;
      if (opts.extraProps) existing.extraProps = mergeExtra(existing.extraProps, opts.extraProps);
      this.startRun(file, existing);
      return;
    }
    const rec: PendingFill = { announce: opts.announce, templatePath: opts.templatePath, extraProps: opts.extraProps };
    this.pending.set(path, rec);
    this.startRun(file, rec);
  }

  /**
   * 把这一轮的补全 IIFE 跑起来（**幂等**：`started` 只让第一条调用真正起跑）。
   * ⚠️ 记录（`rec`）**按引用**传下去：后到的 schedule 合并会落在这同一条记录上 ——
   * 一旦起跑，合并就来不及了，所以参数必须在起跑前全部就位
   *（这就是 `createNote` 要**预登记**的原因）。
   */
  private startRun(file: TFile, rec: PendingFill): void {
    if (rec.started) return;
    rec.started = true;
    const path = file.path;
    void (async () => {
      try {
        const outcome = await this.runFill(file, rec);
        if (rec.announce && outcome.kind === 'filled') {
          notifyLight('已按模板补好这篇笔记', outcome.detail);
        } else if (rec.announce && outcome.kind === 'props') {
          /**
           * ⚠️ **`props` 这一档也要报**（e2 期自查抓的）：Quick Capture 往"标签源/属性值源"板块丢时，
           * 正文可能一个字都不用补、只补了"让它进得了那个板块"的属性 —— 那时 `detail` 里
           * 写着"已补 状态=进行中（覆盖了原来的 待办）"，正是用户最需要看见的一句
           * （否则他会以为"我明明丢进 进行中，怎么还在 待办"）。
           *
           * ⚠️ 标题**中性**（e2 独立审查 🟡4）：`props` 这一档有**两个来源** ——
           * "补上落点需要的属性"（Quick Capture）与"目录被 Templater 接管、只补「文件位置」键"
           *（§7.1 那条老路，见 `ensurePositionKey`）。写死成"落点"会在后一条路上说谎
           *（那条跟"落点"没关系）。说清"补了什么"是 `detail` 的活儿。
           */
          notifyLight('已补上前言里的属性', outcome.detail);
        } else if (rec.announce && outcome.kind === 'skipped') {
          notifyLight('这篇没有补全', outcome.detail);
        }
      } catch (e) {
        console.error('[经纬] 新建补全出错', e);
        this.lastSkip = e instanceof Error ? e.message : String(e);
      } finally {
        this.pending.delete(path);
      }
    })();
  }

  /**
   * 等 + 读 + 写 + （可选）补属性。这是 §7.1 那张表的唯一实现点
   *（`announce` 只影响通知，在 `schedule` 里用）。
   *
   * ⚠️ **`extraProps` 一律在最后补**（不是先写进 create 的那个空文件里）：
   * 先写前言会让 Templater 的「新建时触发」不触发 —— 那条实测记在 `排查报告.md` §六。
   */
  private async runFill(
    file: TFile,
    req: { templatePath?: string; extraProps?: ExtraProps } = {},
  ): Promise<FillOutcome> {
    const outcome = await this.fillCore(file, req);
    return this.applyExtraProps(file, req.extraProps, outcome);
  }

  /**
   * **补「落进那个板块」需要的属性**（Quick Capture 的最后一站）。
   *
   * 三条口径（写进 `modules/board/capture.ts` 的头注释了，这里只实现）：
   *  ① **属性覆盖、标签并集** —— 用户显式选了"丢进 状态=进行中"，模板却写了 `状态: 待办` 时，
   *     让位就等于"点了没点"（那种"界面承诺了、代码没做"是本项目最忌的一类账）；
   *     而标签是**集合**，覆盖会毁掉模板给的标签 → 并集。
   *  ② **合并读的是 `processFrontMatter` 回调里那份 `fm`**（平台现读文件、不是 metadataCache）：
   *     刚被 Templater 写过时缓存还是旧的（平台要 ~300ms），照缓存合并会把它的标签**盖掉**。
   *  ③ 覆盖了什么**如实报出来**（`detail` 里带上"原 X → Y"），别让人以为模板没生效。
   *
   * ⚠️ `processFrontMatter` 是"解析再序列化"，会改非标量值的原文形状（P2 实测）。
   * 这里可以接受：**这一篇是几秒前才建出来的**（前言是模板机写的），不是用户手写的历史文本。
   */
  private async applyExtraProps(
    file: TFile,
    extra: ExtraProps | undefined,
    outcome: FillOutcome,
  ): Promise<FillOutcome> {
    const wantProps = extra?.props ?? {};
    const wantTags = extra?.tags ?? [];
    if (Object.keys(wantProps).length === 0 && wantTags.length === 0) return outcome;
    const cur = this.app.vault.getAbstractFileByPath(file.path);
    if (!(cur instanceof TFile)) {
      return { ...outcome, detail: `${outcome.detail}；（文件已经不在了，没补属性）` };
    }
    const changed: string[] = [];
    markSelfWrite(cur.path);
    try {
      await this.app.fileManager.processFrontMatter(cur, (fm) => {
        for (const [k, v] of Object.entries(wantProps)) {
          const now = (fm as Record<string, unknown>)[k];
          if (now !== undefined && asString(now) !== asString(v)) {
            changed.push(`${k}（原 ${asString(now)} → ${asString(v)}）`);
          }
          (fm as Record<string, unknown>)[k] = v;
        }
        if (wantTags.length > 0) {
          const bag = fm as Record<string, unknown>;
          const have = asList(bag['tags']).map((x) => String(x));
          bag['tags'] = Array.from(new Set([...have, ...wantTags]));
        }
      });
    } catch (e) {
      console.error('[经纬] 补属性失败', cur.path, e);
      return { ...outcome, detail: `${outcome.detail}；（补属性失败，见控制台）` };
    }
    const what = [
      ...Object.entries(wantProps).map(([k, v]) => `${k}=${asString(v)}`),
      ...(wantTags.length > 0 ? [`标签 +${wantTags.join(' ')}`] : []),
    ].join(' ');
    const note = changed.length > 0 ? `（覆盖了原来的 ${changed.join('、')}）` : '';
    const kind: FillOutcome['kind'] =
      outcome.kind === 'none' || outcome.kind === 'skipped' ? 'props' : outcome.kind;
    return { ...outcome, kind, detail: `${outcome.detail}；已补 ${what}${note}` };
  }

  private async fillCore(file: TFile, req: { templatePath?: string } = {}): Promise<FillOutcome> {
    const path = file.path;
    /**
     * 🔴 **P7.13a · #2 · Q6"开关拆两层"**：开关管的是**六件套 + 尾链的补齐**；
     * **显式选模板的"套用"不受它管**（关着也套、只落模板原文 —— `FillOptions.bare`）。
     * 所以这里不再"关着一律早退"：
     *   · 关着 + 没选模板 → 老样子（什么都不做）；
     *   · 关着 + 选了模板 → 继续往下走，由 `bare` 把"开关关着"带进补全判据。
     */
    const on = await this.isOn();
    const tp = readTemplater(this.app);
    const folderAbs = parentDir(path);
    const auto = await this.automation.get();
    /**
     * ⚠️ **在 await 之后才读**（见 schedule 那段注释）：后到的 merge 才能生效 ——
     * 下面那道闸也**必须**读这个"读回来的值"，别改回 `req.templatePath` 直读
     * （那样就把 P7.12 修过的竞态又放回来了）。
     */
    const askedTemplate = req.templatePath;
    if (!on && !askedTemplate) {
      return { kind: 'none', detail: '「新建笔记补全」关着', path };
    }
    const choice = pickTemplate(this.app, this.settings, tp, {
      folderPath: folderAbs,
      tagDir: await this.tagDirFor(file),
      defaultTemplate: auto.completion.defaultTemplate,
    });

    // ① 目录被 Templater 接管 → 正文让位，只补一个属性键（§7.1）
    if (isTemplaterManaged(tp, folderAbs)) {
      /**
       * ⚠️ 托管分支里"补属性"仍是**补全**的一部分 → 开关关着就一个字节都不写
       *（正文本来就归 Templater；插件连「文件位置」也不补 —— 与改动前一致）。
       */
      if (!on) {
        return { kind: 'none', detail: '「新建笔记补全」关着：正文由 Templater 目录模板接管', path };
      }
      /**
       * ⚠️ **P7.12 收尾真机抓到的竞态**：原来是 `sleep(JUDGE_MS)` 后**只看一眼** ——
       * Templater 落笔比 300ms 慢时（真机实测常见：Inbox 的目录模板晚一拍），
       * `ensurePositionKey` 撞上"还没有前言"直接 none，**而且永不重试**（pending 记录已删）
       * → 「文件位置」没补、模板身份换算（「类型: 模板」→ 目录默认）也没跑。
       * 改成**轮询等它落笔**（上限 `TEMPLATER_WAIT_MS`）：一有前言立刻补；超时仍按老纪律
       * "不插手"返回 none（不写空前言那半句纪律不变）。
       */
      const deadline = Date.now() + TEMPLATER_WAIT_MS;
      for (;;) {
        await sleep(JUDGE_MS); // 让它先落笔；我们不抢
        const cur = this.app.vault.getAbstractFileByPath(path);
        if (!(cur instanceof TFile)) return { kind: 'failed', detail: '文件不在了', path };
        if (hasFrontmatter(await this.safeRead(cur))) break;
        if (Date.now() >= deadline) {
          return { kind: 'none', detail: '正文让给 Templater（等了一段它还没落笔，本插件不插手）', path };
        }
      }
      return this.ensurePositionKey(file);
    }

    /**
     * ② 等 Templater 的判定点（交互式模板突破封顶）。
     * ⚠️ **用户选的模板优先**（对话框里那个下拉）：`req.templatePath` 有值就用它，
     * 没有才用套用规则挑出来的那个（独立审查抓到的 🔴：以前选了等于没选）。
     */
    const usePath = askedTemplate ?? choice.path;
    const useRule = askedTemplate ? '你在新建对话框里选的模板' : choice.rule;
    const templateText = await this.readTemplate(usePath);
    const interactive = templateText != null && isInteractiveTemplate(templateText);
    const wrote = await this.waitQuiet(file, interactive);
    if (wrote) {
      // 期间有人（Templater / 你）落了笔 → **不覆盖**
      return { kind: 'none', detail: '新建期间已经有内容进来了，本插件不覆盖', path };
    }

    // ③ 没人动手 → 按 §7.1 补（**新建路**：写「文件位置」= 所在目录，#4 拍定）
    //    开关关着（`bare`）= 只落模板原文（六件套 / 尾链的补齐归开关 —— P7.13a · #2 · Q6）
    return this.fillFile(file, {
      templatePath: usePath,
      templateText,
      rule: useRule,
      withPosition: true,
      bare: !on,
    });
  }

  /**
   * 等"安静"：从 `JUDGE_MS` 起算，期间每来一次写盘就续期，累计不超过封顶。
   * 返回**期间有没有人写过**（有 = 让位，不覆盖）。
   */
  async waitQuiet(file: TFile, interactive = false): Promise<boolean> {
    const cap = interactive ? INTERACTIVE_CAP_MS : CAP_MS;
    const t0 = Date.now();
    let last = t0;
    let wrote = false;
    let ref: EventRef | null = null;
    // ⚠️ 形参类型要跟平台声明一致（`TAbstractFile`）：`vault.on` 是重型重载，
    // 写成 `(f: TFile) => void` 在 strictFunctionTypes 下**一个重载都匹配不上**
    // （函数参数是逆变的），报的是"没有匹配的重载"——照抄类型最省事
    const onModify = (f: { path?: string }): unknown => {
      if (!f || f.path !== file.path) return;
      wrote = true;
      last = Date.now();
    };
    ref = this.app.vault.on('modify', onModify);
    try {
      for (;;) {
        const now = Date.now();
        const due = Math.max(last + JUDGE_MS, t0 + JUDGE_MS);
        if (now >= due) break;
        if (now - t0 >= cap) break;
        await sleep(Math.min(60, Math.max(10, due - now)));
      }
      // 交互式模板：给它更长的机会落笔（它在等输入），但别无限等
      if (interactive && !wrote) {
        const left = cap - (Date.now() - t0);
        if (left > 0) await sleep(Math.min(left, 1200));
      }
      return wrote;
    } finally {
      if (ref) this.app.vault.offref(ref);
    }
  }

  private async readTemplate(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    try {
      return await this.app.vault.read(f);
    } catch {
      return null;
    }
  }

  /** 目录被 Templater 接管时只做这一件事：补一个「文件位置」键（只加不覆盖；值 = 所在目录） */
  private async ensurePositionKey(file: TFile): Promise<FillOutcome> {
    const cur = this.app.vault.getAbstractFileByPath(file.path);
    if (!(cur instanceof TFile)) return { kind: 'failed', detail: '文件不在了', path: file.path };
    const props = this.app.metadataCache.getFileCache(cur)?.frontmatter ?? {};
    if ('文件位置' in props) {
      return { kind: 'none', detail: '正文让给 Templater；「文件位置」已经在了', path: file.path };
    }
    /**
     * 正文还没被 Templater 落笔时**不动**（没前言可补，写了反倒会造出一个空前言）。
     * ⚠️ 判据用 `hasFrontmatter`（第 1 行是 `---` 且有闭合行）—— **不能**用"有没有一整行 `---`"：
     * 正文里一条水平分割线也会命中，于是给没有前言的笔记凭空补出一个空前言。
     */
    if (!hasFrontmatter(await this.safeRead(cur))) {
      return { kind: 'none', detail: '正文让给 Templater（它还没落笔，本插件不插手）', path: file.path };
    }
    /**
     * ⚠️ **值 = 所在目录**（独立审 A4，2026-10-07 修正）：旧写法补的是**空数组**（v1 口径
     * "留空=未锁定"的遗留）—— 但 v2 · #4/#12 拍定是「新建即写『文件位置』= 所在目录」，
     * 普通新建路（`templates.ts` 的 `buildYaml`）已经这么写。空值不是"安全默认"：
     * `declaredPositions()` 为空 → 这篇会**一直**出现在「整理建议 B 类（缺『文件位置』）」
     * 与一键整理的 AI 补声明候选里，与"新建即配置"的承诺相反。Templater 只是代管正文，
     * 位置声明照写（真有目录模板日后挪文件的极端情况，「位置不一致」旗标报得也对）。
     */
    const rel = relativeTo(cur.path, this.settings.kbRoot());
    const folderRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    markSelfWrite(cur.path);
    await this.app.fileManager.processFrontMatter(cur, (fm) => {
      // P7.15 · #1：库根顶层不写空数组了 —— 写 `.`（根标记），否则 `declaredPositions()` 为空、
      // 又绕回上面注释里那条"一直出现在缺声明候选里"的坑（read 侧统一映射回空串）。
      if (!('文件位置' in fm)) fm['文件位置'] = [folderRel || ROOT_POS];
      /**
       * ⚠️ P7.12 收尾（真机抓到 · 与 A4 同族）：迁移给 6 个 `T_*` 模板的 YAML 盖了
       * 「类型: 模板」（模板自己的身份标记）—— **插件套用路径**有换算（`templates.ts`：
       * 字面「模板」→ 目录默认），但 **Templater 目录模板这条路绕过插件套用**，
       * 原样把 `类型: 模板` 落进新笔记（真机实测：Inbox 新建的笔记成了"模板"）。
       * 这里补**同一份换算**：字面「类型: 模板」→ `defaultsForDir`，拿不准就删键
       *（与 buildYaml"拿不准留空"同一口径）。只在托管分支做——插件套用路径不需要（那边已换算）。
       */
      if (asString(fm['类型']) === '模板') {
        const d = defaultsForDir(folderRel);
        if (d.类型) fm['类型'] = d.类型;
        else delete fm['类型'];
      }
    });
    return {
      kind: 'props',
      detail: folderRel
        ? `正文让给 Templater，只补了「文件位置」键（= ${folderRel}）`
        : '正文让给 Templater，只补了「文件位置」键',
      path: file.path,
    };
  }

  private async safeRead(file: TFile): Promise<string> {
    try {
      return await this.app.vault.read(file);
    } catch {
      return '';
    }
  }

  /**
   * 补一篇（**新建与存量共用的写盘口**）。
   * `templatePath` 不传就按套用规则现挑；`withPosition` 只有新建路传（v2 · #4）。
   */
  async fillFile(
    file: TFile,
    given: {
      templatePath?: string;
      templateText?: string | null;
      rule?: string;
      withPosition?: boolean;
      /** 只落模板原文（开关关着的显式套用）—— 见 `FillOptions.bare`（P7.13a · #2 · Q6） */
      bare?: boolean;
    } = {},
  ): Promise<FillOutcome> {
    const cur = this.app.vault.getAbstractFileByPath(file.path);
    if (!(cur instanceof TFile)) return { kind: 'failed', detail: '文件不在了', path: file.path };
    const text = await this.safeRead(cur);
    const rel = relativeTo(cur.path, this.settings.kbRoot());
    const folderRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const ctx = noteContext(this.app, this.settings, { title: cur.basename, folderRel });

    let templatePath = given.templatePath;
    let templateText = given.templateText;
    let rule = given.rule ?? '';
    if (templatePath === undefined) {
      const tp = readTemplater(this.app);
      const auto = await this.automation.get();
      const choice = pickTemplate(this.app, this.settings, tp, {
        folderPath: parentDir(cur.path),
        tagDir: await this.tagDirFor(cur), // 套用规则第一档：标签规则
        defaultTemplate: auto.completion.defaultTemplate,
      });
      templatePath = choice.path;
      rule = choice.rule;
      templateText = await this.readTemplate(choice.path);
    }

    /**
     * ⚠️ **「让位」只属于新建路径**（§7.1）：Templater 的目录模板只在**新建文件**时触发，
     * 对已经存在的笔记它不会动手 —— 所以存量补全（§13 的显式维护动作）照两分支走，
     * 不传 `managed`。
     * （独立审查指出过：两条路径对同一份判据的输入不同，看起来像"共用了半个判据"。
     *  定下的口径是**故意的不同**：`managed` 是"新建时的分工"，不是"对所有补全都生效的开关"。
     *  这条口径同时写在 `templates.ts` 的 `managed` 注释与 `交互规格.md` §7.1/§13 里。）
     */
    const plan = buildFillPlan(text, {
      ctx,
      templateText: templateText ?? null,
      templatePath,
      withPosition: given.withPosition === true,
      bare: given.bare === true,
      /**
       * P7.17 · #1：坏前言**整篇跳过**（守卫不拆）。判据只有一处出处 ——
       * `schema.fragileKeys`（与写口守卫、`fragile-fm` 旗标同一份），这里现算传进去。
       */
      fragile: fragileKeys(this.app.metadataCache.getFileCache(cur)?.frontmatter ?? {}),
      ctime: cur.stat?.ctime ?? Date.now(),
    });
    return this.applyPlan(cur, plan, rule);
  }

  /** 把计划落到盘上。**只加不删**：patch 分支只往两头拼，正文一个字符不动 */
  async applyPlan(file: TFile, plan: FillPlan, rule: string): Promise<FillOutcome> {
    const path = file.path;
    if (plan.kind === 'none') {
      this.lastSkip = plan.why;
      return { kind: 'none', detail: plan.why, path };
    }
    if (plan.kind === 'skip') {
      this.lastSkip = plan.why;
      return { kind: 'skipped', detail: plan.why, path };
    }
    markSelfWrite(path);
    if (plan.kind === 'template') {
      await this.app.vault.process(file, () => plan.text);
      const extra = plan.unresolved.length > 0 ? `（${plan.unresolved.join(' ')} 没求到值，原样留着）` : '';
      // 尾链段里"求不到的行整行删"带走的那批 —— 与"原样留着"是两种实情，分开说（P7.13a · #2）
      const pruned = plan.pruned && plan.pruned.length > 0 ? `（${plan.pruned.join(' ')} 没求到值：尾链那一行已省去）` : '';
      const what = plan.bare
        ? '只落了模板原文（「新建笔记补全」关着：没补属性与尾链）'
        : '套了模板';
      return { kind: 'filled', detail: `${what}（${rule}）${extra}${pruned}`, path };
    }
    // patch：前言拼在开头 / **替换原块**（有前言补缺键那条路）、正文骨架接在前言之后、尾链拼在结尾
    const yaml = plan.yaml;
    const skeleton = plan.body;
    const tail = plan.tail;
    await this.app.vault.process(file, (cur) => {
      let out = cur;
      if (yaml) {
        out =
          plan.yamlMode === 'replace'
            ? replaceFrontmatterBlock(out, yaml)
            : `${yaml}${out.replace(/^\n+/, '')}`;
      }
      if (skeleton) out = `${out.replace(/\s*$/, '')}\n\n${skeleton}\n`;
      if (tail) out = `${out.replace(/\s*$/, '')}\n\n${tail}`;
      return out;
    });
    /**
     * 文案按**实际干了什么**说：`replace` 那条路报"补了：类型、创建日期…"（P7.17 §2 的
     * 报告口径）；`prepend` 还是"补了前言"（整块新拼）。
     */
    const yamlWhat =
      plan.yamlMode === 'replace' && plan.yamlAdded && plan.yamlAdded.length > 0
        ? `补了：${plan.yamlAdded.join('、')}`
        : '补了前言';
    const what = [yaml ? yamlWhat : '', skeleton ? '补了正文骨架' : '', tail ? '补了尾部双链' : '']
      .filter(Boolean)
      .join(' + ');
    const extra = plan.unresolved.length > 0 ? `（${plan.unresolved.join(' ')} 没求到值，原样留着）` : '';
    return { kind: 'filled', detail: `${what}${extra}（模板 ${rule}）`, path };
  }

  /** 占位符渲染（给面板的「预览」用：新建后的正文长什么样） */
  preview(text: string, ctx: ReturnType<typeof noteContext>): string {
    return renderPlaceholders(text, ctx).text;
  }

  /** 批量补全（存量）的写盘口：失败逐篇报，不中断整批 */
  async fillMany(
    files: TFile[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<FillOutcome[]> {
    const out: FillOutcome[] = [];
    let done = 0;
    for (const f of files) {
      try {
        out.push(await this.fillFile(f, {}));
      } catch (e) {
        out.push({
          kind: 'failed',
          detail: e instanceof Error ? e.message : String(e),
          path: f.path,
        });
      }
      done += 1;
      onProgress?.(done, files.length);
      await sleep(30); // 别把 vault 队列塞满（真库的同步在同一进程里跑）
    }
    return out;
  }
}

/**
 * 用**合并后的前言块**替换文件里原有的那一块（P7.17 · #1"有前言补缺键"的写口）：
 * 只动两条围栏之间的区间，正文与块外的空行**一个字节不动**。
 *
 * 🔴 **只认"第 1 行就是 `---`"的真前言**（`start === 0`，与 `hasFrontmatter` 同口径 ——
 * 独立审 🟡1）：计划期的 `hadFm` 判过是 `true`，但 `vault.process` 拿到的 `cur` 可能
 * 已经变了（同步/外部写入）。若 `cur` 的前言没了、而**正文里恰好有一对 `---`**
 *（模板的分隔线 / 尾链前那条线，都很常见），不拦就会把**正文中段整块换成前言**
 *（快照能救，但那是静默吃正文）。认不出真前言 → 退回"拼在开头"（合并块本身含全部
 * 原键，是这一档里损失最小的落法）。
 * ⚠️ 残余窗口（记档，独立审 🟡1 后半）：replace 用的是"读时算好的块"，读→写窗口内
 * 对前言的并发改动会被整块覆盖 —— 毫秒级、有快照兜底，留观察。
 */
function replaceFrontmatterBlock(text: string, block: string): string {
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  if (start !== 0 || end < 0) return `${block}\n${text.replace(/^\n+/, '')}`;
  const blockLines = block.replace(/\n$/, '').split('\n');
  return [...lines.slice(0, start), ...blockLines, ...lines.slice(end + 1)].join('\n');
}

/** 文件名安全化（Windows 上不能出现 `\ / : * ? " < > |`） */
export function sanitize(name: string): string {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '未命名';
}

/** 批量补全的汇总通知文案（面板与命令共用） */
export function summarizeOutcomes(outcomes: FillOutcome[]): string {
  const filled = outcomes.filter((o) => o.kind === 'filled').length;
  const skipped = outcomes.filter((o) => o.kind === 'skipped').length;
  const failed = outcomes.filter((o) => o.kind === 'failed').length;
  return `补全 ${filled} 篇${skipped > 0 ? `，跳过 ${skipped} 篇` : ''}${failed > 0 ? `，失败 ${failed} 篇` : ''}`;
}

/** 两份 `ExtraProps` 合并（`createNote` 与 `vault.create` 事件谁先到不定 —— 两边都要并进来） */
function mergeExtra(a: ExtraProps | undefined, b: ExtraProps | undefined): ExtraProps {
  return {
    props: { ...(a?.props ?? {}), ...(b?.props ?? {}) },
    tags: Array.from(new Set([...(a?.tags ?? []), ...(b?.tags ?? [])])),
  };
}
