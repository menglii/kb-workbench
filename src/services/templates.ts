/**
 * services/templates.ts —— 模板渲染 + **与 Templater 的分工**（`开发计划.md` §8）
 *
 * 这一层只做**纯逻辑**（可离线断言）；真正写盘的是 `services/completion.ts`（新建补全）
 * 与 `services/backfill.ts`（存量一键补全）—— 两者共用这里的 `buildFillPlan()`，
 * 免得"新建"和"存量"两套判断各漂一半。
 *
 * ── 与 Templater 的分工（交互规格 §7.1，四条例外缺一不可）──────────
 *   ① `<% %>` 交 Templater 求值；**求不到就跳过不动手** —— 宁可不补，
 *      也不把模板语法写进笔记（写进去就是把模板当内容，肉眼很难发现）
 *   ② 目录被 Templater「目录模板」接管 → 正文整个让给它，本插件不插手，**但属性照补**
 *      （只加「文件位置」一个键、只加不覆盖）
 *   ③ 等待时长**从 Templater 的 300ms 判定点起算**（不是 180ms！）
 *      —— 短于 300ms 会赶在它落笔前抢先写前言，正好触发"先写前言让模板不触发"
 *      （`排查报告.md` §六 记过这条）。期间它又落笔就续期，累计封顶 800ms
 *   ④ 交互式模板（`tp.system.prompt` / suggester）在**等你输入**期间长时间不落笔
 *      → 封顶必须被突破，否则插件误判"它不动手"然后自己写
 *
 * ── 6 个占位符（§7.1）──────────────────────────────────────────
 *   `{{title}}` 文件名（不含扩展名）　`{{date}}` 今天 `YYYY-MM-DD`
 *   `{{folder}}` 所在目录（**相对库根**，库根下就是空串）
 *   `{{center}}` 该目录所属中心页的双链（如 `[[01_新知识库/02_Areas/_领域中心]]`）
 *   `{{moc}}` 知识地图的双链　`{{kb}}` 库根（`01_新知识库`）
 *   求不到的占位符**原样留在笔记里**（§7.1：看得见才好修），不清空。
 */
import { TFile, TFolder, type App } from 'obsidian';
import type { SettingsStore } from '../core/settings';
import { baseName, isInside, joinPath, parentDir, stripExt } from '../core/paths';
import { todayISO } from '../core/util';
import { hasFrontmatter, stripFrontmatter } from './frontmatter';
import { NOTE_TYPES, ROOT_POS, STATUSES, defaultsForDir } from './schema';

// ────────────────────────────────────────────────────────────────
// 占位符
// ────────────────────────────────────────────────────────────────
export const PLACEHOLDERS = ['{{title}}', '{{date}}', '{{folder}}', '{{center}}', '{{moc}}', '{{kb}}'] as const;

export interface NoteContext {
  /** 文件名（不含扩展名） */
  title: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** 所在目录（相对库根；库根下 = ''） */
  folderRel: string;
  /** 库根（相对 vault 根） */
  kbRoot: string;
  /** 中心页双链（求不到 = ''） */
  center: string;
  /** 知识地图双链（求不到 = ''） */
  moc: string;
}

export interface RenderResult {
  text: string;
  /** 求不到、原样留下的占位符 */
  unresolved: string[];
}

/** 只换这 6 个；别的 `{{…}}` 一律原样留（不猜、不清空） */
export function renderPlaceholders(text: string, ctx: NoteContext): RenderResult {
  const map: Record<string, string> = {
    '{{title}}': ctx.title,
    '{{date}}': ctx.date,
    '{{folder}}': ctx.folderRel,
    '{{center}}': ctx.center,
    '{{moc}}': ctx.moc,
    '{{kb}}': ctx.kbRoot,
  };
  const unresolved: string[] = [];
  let out = text;
  for (const ph of PLACEHOLDERS) {
    if (!out.includes(ph)) continue;
    const v = map[ph] ?? '';
    if (!v) {
      // 求不到 → 原样留着（用户看得见才好修），并且报出来
      if (!unresolved.includes(ph)) unresolved.push(ph);
      continue;
    }
    out = out.split(ph).join(v);
  }
  return { text: out, unresolved };
}

/** 正文里还有没有没被求值的 `<% %>`（有 = 不能碰，见文件头 ①） */
export function hasTemplaterSyntax(text: string): boolean {
  return /<%.*?%>/s.test(text);
}

/** 模板是不是**等你输入**的那种（`tp.system.prompt` / suggester）——见文件头 ④ */
export function isInteractiveTemplate(text: string): boolean {
  return /\btp\.system\.(prompt|suggester)\b/.test(text) || /\btp\.system\.multi_suggester\b/.test(text);
}

// ────────────────────────────────────────────────────────────────
// Templater 桥（读它的设置；它不在就安静降级）
// ────────────────────────────────────────────────────────────────
export interface TemplaterInfo {
  /** 装了并且启用了吗 */
  present: boolean;
  /** 「新建文件时触发」开着吗 */
  triggerOnCreate: boolean;
  /** 「目录模板」开着吗 */
  folderTemplates: boolean;
  /** `{ folder, template }`，两者都是库内绝对路径 */
  rules: { folder: string; template: string }[];
  /** 模板库目录（库内绝对路径） */
  templatesFolder: string;
}

const NO_TEMPLATER: TemplaterInfo = {
  present: false,
  triggerOnCreate: false,
  folderTemplates: false,
  rules: [],
  templatesFolder: '',
};

/** 读 Templater 的配置。**它是别人的插件** → 任何异常都当"没装"，绝不让 P3 的功能崩在这 */
export function readTemplater(app: App): TemplaterInfo {
  try {
    const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins
      ?.plugins;
    const tp = plugins?.['templater-obsidian'] as
      | { settings?: Record<string, unknown>; _loaded?: boolean }
      | undefined;
    if (!tp || !tp.settings) return NO_TEMPLATER;
    const s = tp.settings;
    const rules = Array.isArray(s.folder_templates)
      ? (s.folder_templates as unknown[])
          .map((r) => {
            const o = r as { folder?: unknown; template?: unknown };
            return {
              folder: typeof o?.folder === 'string' ? o.folder.replace(/^\/+|\/+$/g, '') : '',
              template: typeof o?.template === 'string' ? o.template.replace(/^\/+|\/+$/g, '') : '',
            };
          })
          .filter((r) => r.folder && r.template)
      : [];
    return {
      present: true,
      triggerOnCreate: s.trigger_on_file_creation === true,
      folderTemplates: s.enable_folder_templates === true,
      rules,
      templatesFolder: typeof s.templates_folder === 'string' ? s.templates_folder : '',
    };
  } catch (e) {
    console.warn('[经纬] 读 Templater 配置失败（当它没装处理）', e);
    return NO_TEMPLATER;
  }
}

/** 这个目录被 Templater 的「目录模板」接管了吗（最长前缀优先，与 Templater 自己一致） */
export function folderTemplateFor(info: TemplaterInfo, folderPath: string): string | null {
  if (!info.present || !info.folderTemplates) return null;
  const f = folderPath.replace(/^\/+|\/+$/g, '');
  let best: { template: string; len: number } | null = null;
  for (const rule of info.rules) {
    if (f !== rule.folder && !f.startsWith(`${rule.folder}/`)) continue;
    if (!best || rule.folder.length > best.len) best = { template: rule.template, len: rule.folder.length };
  }
  return best?.template ?? null;
}

/**
 * 这个目录会被 Templater **自动**接管吗（新建文件时）。
 * 三个条件同时成立才算：装了 + 「新建时触发」开 + 目录模板命中。
 */
export function isTemplaterManaged(info: TemplaterInfo, folderPath: string): boolean {
  return info.present && info.triggerOnCreate && folderTemplateFor(info, folderPath) != null;
}

// ────────────────────────────────────────────────────────────────
// 找中心页 / 知识地图（`{{center}}` / `{{moc}}`）
// ────────────────────────────────────────────────────────────────
/** 从目录往上找第一个 `_开头` 的中心页（`_收件箱` / `_领域中心` …），返回双链文本 */
export function findCenterLink(app: App, folderPath: string, kbRoot: string): string {
  let dir = folderPath.replace(/^\/+|\/+$/g, '');
  const root = kbRoot.replace(/^\/+|\/+$/g, '');
  for (;;) {
    const node = app.vault.getAbstractFileByPath(dir);
    if (node instanceof TFolder) {
      const hit = node.children
        .filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
        .filter((c) => c.basename.startsWith('_'))
        .sort((a, b) => a.path.localeCompare(b.path, 'zh'))[0];
      if (hit) return `[[${stripExt(hit.path)}]]`;
    }
    if (!dir || dir === root) break;
    const up = parentDir(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return '';
}

/** 知识地图：库根下第一个 `MOC_*.md`（不是就找名字里带 MOC 的） */
export function findMocLink(app: App, kbRoot: string): string {
  // P7.14：走 isInside —— kbRoot=''（整个库）时"全库找 MOC"仍成立（手拼前缀在空串下恒 false）
  const all = app.vault.getMarkdownFiles().filter((f) => isInside(f.path, kbRoot));
  const hit =
    all.find((f) => f.basename.startsWith('MOC_')) ??
    all.find((f) => f.basename.toUpperCase().includes('MOC'));
  return hit ? `[[${stripExt(hit.path)}]]` : '';
}

/** 组装一篇笔记的占位符上下文 */
export function noteContext(
  app: App,
  settings: SettingsStore,
  rel: { title: string; folderRel: string },
): NoteContext {
  const kbRoot = settings.kbRoot();
  const folderAbs = rel.folderRel ? joinPath(kbRoot, rel.folderRel) : kbRoot;
  return {
    title: rel.title,
    date: todayISO(),
    folderRel: rel.folderRel,
    kbRoot,
    center: findCenterLink(app, folderAbs, kbRoot),
    moc: findMocLink(app, kbRoot),
  };
}

// ────────────────────────────────────────────────────────────────
// 尾部双链段
// ────────────────────────────────────────────────────────────────
/** 尾部双链段的标题（判据的唯一真源：`hasTailSection` 与 `stripTailSection` 共用） */
export const TAIL_HEADING = '关联笔记';

/** 正文里已经有「关联笔记」段了吗（幂等的判据） */
export function hasTailSection(body: string): boolean {
  return new RegExp(`^#{1,4}\\s*${TAIL_HEADING}\\s*$`, 'm').test(body);
}

/**
 * **剥掉尾部双链段**（P4 卡片摘要要它，交互规格 §4.3）。
 *
 * 从匹配到的那一行起、**到文末**全去掉，并把它上面那条分隔线（`---`）一起带走 ——
 * 模板产出的形状是：
 * ```
 * 正文…
 * ---              ← 这条也要去掉，否则摘要尾巴是一根横线
 * ## 关联笔记
 * - 所属中心：[[…]]
 * ```
 * `markers` 可配（§4.3「自定义剥离标记」）：每一项既按**整行文本**比、
 * 也按 **ATX 标题的文本**比（`## 关联笔记` 能匹配到 `### 关联笔记`）。
 */
export function stripTailSection(body: string, markers: string[] = [`## ${TAIL_HEADING}`]): string {
  const cut = tailHeadingLine(body, markers);
  if (cut < 0) return body;
  const lines = body.split('\n');
  const norm = (s: string): string => s.replace(/[ \t]+$/g, '').trim();
  // 往上吃掉紧邻的分隔线（`---` / `***` / `___`）与空行
  let start = cut;
  while (start > 0) {
    const prev = norm(lines[start - 1]);
    if (prev === '' || /^(-{3,}|\*{3,}|_{3,})$/.test(prev)) start -= 1;
    else break;
  }
  return lines.slice(0, start).join('\n');
}

/**
 * **尾部双链段那一行的行号**（0 基，匹配不到就是 `-1`）。
 *
 * 判据与 `stripTailSection` **同一份**（那一条改成调它了）：同样收 `markers`、
 * 同样"整行比 + ATX 标题文本比"。为什么要有这个纯函数：
 *
 * 🔴 **面板里那一窗挂的是真编辑器，内容一个字都不能改**（`editor.ts` 的口径）——
 * 所以"藏掉尾链"只能靠**折叠**，而折叠要的正是"从**哪一行**开始折"
 * （平台的折叠指示器长在标题那一行上，见 `看板优化方案.md` §6.18 的真机取证）。
 * 与摘要那边共用同一份判据，才不会出现"卡片里剥掉了、小窗里折的不是同一段"。
 */
export function tailHeadingLine(body: string, markers: string[] = [`## ${TAIL_HEADING}`]): number {
  const lines = body.split('\n');
  const norm = (s: string): string => s.replace(/[ \t]+$/g, '').trim();
  const headingText = (s: string): string => norm(s).replace(/^#{1,6}\s*/, '');
  const wanted = markers.map((m) => norm(m)).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = norm(lines[i]);
    if (!line) continue;
    for (const mk of wanted) {
      if (line === mk || headingText(line) === headingText(mk)) return i;
    }
  }
  return -1;
}

/**
 * 生成尾部双链段（与模板库里那 6 个模板的写法一致）。
 * 中心页求不到就不写那一行 —— 宁可少一行，也不写一个 [[ ]] 空链。
 *
 * ⚠️ **v2 行序（P7.12 · 21.7 拍定，上→下）**：相关笔记 → 所属中心 → 返回大地图；
 * 标签也改了字（「相关」→「相关笔记」、「返回」→「返回大地图」）。
 * 存量重排走迁移链（`migrate.ts` 的 `fixTailLines`），判据同一份口径。
 */
export function tailSection(ctx: NoteContext): string {
  const lines = ['## 关联笔记'];
  lines.push('- 相关笔记：[[]]');
  if (ctx.center) lines.push(`- 所属中心：${ctx.center}`);
  if (ctx.moc) lines.push(`- 返回大地图 ${ctx.moc}`);
  return `${lines.join('\n')}\n`;
}

/**
 * **📌 页脚行清理**（P7.12 · 21.8 拍定："全变体一并去"）：整行删除
 * `> 📌 由 Templater 自动生成 · …`（模板与存量笔记共用；只认这个前缀）。
 * 幂等：没有这种行 → `removed = 0`、文本原样返回。
 */
export function stripPinLines(text: string): { text: string; removed: number } {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const out = lines.filter((l) => !/^\s*>\s*📌\s*由\s*Templater\s*自动生成/.test(l));
  const removed = lines.length - out.length;
  return { text: removed > 0 ? out.join('\n') : src, removed };
}

/**
 * **尾链存量重排**（P7.12 · 21.7 拍定）：把「## 关联笔记」段里认得出的三类行
 * 重排成 **相关笔记 → 所属中心 → 返回大地图** 并归一标签（「相关」→「相关笔记」、
 * 「返回」→「返回大地图」；「所属中心」不变）。
 *
 * 三条纪律（与 `tailSection` 同一份口径）：
 *   · **只动认得出的行**（`- 相关…` / `- 所属中心…` / `- 返回…` 开头），段内其他行原样；
 *   · 重排 = 三类行**搬到第一枚分类行的位置**重新摆（组内保持原相对次序，多枚不丢）；
 *   · 幂等：结果与原文一致 → `changed = false`（迁移链靠它回 0 篇）。
 */
export function fixTailLines(text: string): { text: string; changed: boolean } {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const norm = (l: string): string => l.replace(/[ \t]+$/g, '').trim();
  let head = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#{1,6}\s*(.+?)\s*$/.exec(norm(lines[i]));
    if (m && m[1] === TAIL_HEADING) {
      head = i;
      break;
    }
  }
  if (head < 0) return { text: src, changed: false };
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(norm(lines[i]))) {
      end = i;
      break;
    }
  }
  type Kind = 'rel' | 'center' | 'back';
  const kindOf = (l: string): Kind | null => {
    const t = l.trim();
    if (!t.startsWith('- ')) return null;
    const body = t.slice(2);
    if (/^相关(笔记)?\s*[:：]/.test(body)) return 'rel';
    if (/^所属中心\s*[:：]/.test(body)) return 'center';
    if (/^返回(大地图)?\s/.test(body) || /^返回(大地图)?\s*[:：]/.test(body)) return 'back';
    return null;
  };
  const rewrite = (l: string, kind: Kind): string => {
    const indent = l.slice(0, l.length - l.trimStart().length);
    const body = l.trim().slice(2);
    if (kind === 'center') return l; // 标签不变
    if (kind === 'rel') {
      return `${indent}- 相关笔记：${body.replace(/^相关(笔记)?\s*[:：]?\s*/, '')}`;
    }
    return `${indent}- 返回大地图 ${body.replace(/^返回(大地图)?\s*[:：]?\s*/, '')}`;
  };
  const found: { idx: number; kind: Kind; next: string }[] = [];
  for (let i = head + 1; i < end; i += 1) {
    const k = kindOf(lines[i]);
    if (k) found.push({ idx: i, kind: k, next: rewrite(lines[i], k) });
  }
  if (found.length === 0) return { text: src, changed: false };
  const order: Kind[] = ['rel', 'center', 'back'];
  const sorted = order.flatMap((k) => found.filter((f) => f.kind === k).map((f) => f.next));
  const dropAt = new Set(found.map((f) => f.idx));
  const firstAt = found[0].idx;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i === firstAt) out.push(...sorted);
    if (dropAt.has(i)) continue;
    out.push(lines[i]);
  }
  const next = out.join('\n');
  return { text: next, changed: next !== src };
}

// ────────────────────────────────────────────────────────────────
// 模板选择（§7.1 的「套用规则」）
//   标签规则 → 文件夹规则（最长前缀优先）→「当前模板」兜底
// ────────────────────────────────────────────────────────────────
export interface TemplateChoice {
  /** 库内绝对路径（可能不存在 —— 兜底的默认模板被删了就会这样） */
  path: string;
  /** 命中哪条规则（给人看的，新建之后的 Notice 报的就是它） */
  rule: string;
  file: TFile | null;
}

/**
 * 给一个目录挑模板。
 * `tagHit` 是「标签规则」命中时的目录（调用方从路由表标签段算，见 `routes.tagDirs`）——
 * 有它就用它挑文件夹规则，没有就用文件自己的目录。
 */
export function pickTemplate(
  app: App,
  settings: SettingsStore,
  tp: TemplaterInfo,
  opts: { folderPath: string; tagDir?: string | null; defaultTemplate: string },
): TemplateChoice {
  const kbRoot = settings.kbRoot();
  const byFolderRule = (folder: string): TemplateChoice | null => {
    const tplPath = folderTemplateFor(tp, folder);
    if (!tplPath) return null;
    const f = app.vault.getAbstractFileByPath(tplPath);
    const file = f instanceof TFile ? f : null;
    return { path: tplPath, rule: `文件夹规则：${folder}`, file };
  };

  if (opts.tagDir) {
    const byTag = byFolderRule(joinPath(kbRoot, opts.tagDir));
    if (byTag) return { ...byTag, rule: `标签规则 → ${opts.tagDir}` };
  }
  const byRule = byFolderRule(opts.folderPath);
  if (byRule) return byRule;

  // 兜底：「当前模板」（`自动化.json` 的 completion.defaultTemplate，就在模板库目录下）
  const fallback = joinPath(settings.templateDir(), baseName(opts.defaultTemplate || ''));
  const f = app.vault.getAbstractFileByPath(fallback);
  return { path: fallback, rule: '当前模板', file: f instanceof TFile ? f : null };
}

/** 模板库目录下的模板文件（排除脚本类模板 `T_智能新建`） */
export function templateFiles(app: App, settings: SettingsStore): TFile[] {
  const dir = app.vault.getAbstractFileByPath(settings.templateDir());
  if (!(dir instanceof TFolder)) return [];
  return dir.children
    .filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
    .filter((c) => !isScriptTemplate(c))
    .sort((a, b) => a.basename.localeCompare(b.basename, 'zh'));
}

/**
 * 「脚本类模板」：自身不是给人套用的模板，而是一个 Templater 脚本（`T_智能新建`）。
 * ⚠️ 判据是**文件名**（`T_智能新建`）—— 不是内容：内容判据要读全文（这是同步 API，读不了），
 * 而且"整篇一个 `<%* %>` 块"这个形状将来可能有别的脚本模板，那时再加一条内容判据。
 */
export function isScriptTemplate(file: TFile): boolean {
  return file.basename === 'T_智能新建';
}

// ────────────────────────────────────────────────────────────────
// 填哪些（新建补全 / 存量补全共用的唯一判据）
// ────────────────────────────────────────────────────────────────
export type FillPlan =
  | { kind: 'none'; why: string }
  | {
      kind: 'skip';
      why: string;
      /** 机器可认的跳过原因（给人看的仍是 `why`）：`fragile` = 坏前言（P7.17 起） */
      code?: 'fragile';
    }
  | {
      kind: 'template';
      text: string;
      templatePath: string;
      unresolved: string[];
      /** 开关关着：只落模板原文（没做六件套 + 尾链的补齐）—— 见 `FillOptions.bare` */
      bare?: boolean;
      /** 尾链段里"求不到的行整行删"带走的那几个占位符（给文案说清，别和"原样留着"混） */
      pruned?: string[];
    }
  | {
      kind: 'patch';
      yaml?: string;
      /**
       * `yaml` 怎么落盘（P7.17 · #1）：
       *  · `prepend`（默认，原行为）——`yaml` 是一整块新前言（带围栏），拼在文件开头
       *    （这条路只出现在"整篇没有前言"时）；
       *  · `replace`——`yaml` 是**合并后的新前言块**（带围栏），替换掉文件里原有那一块
       *    （"有前言、缺键"那条路：按行合并算出，正文一个字节不动）。
       */
      yamlMode?: 'prepend' | 'replace';
      /** `replace` 时**补了哪几个键**（报告与预览都按它说"补了：类型、创建日期…"） */
      yamlAdded?: string[];
      /**
       * 只补**正文骨架**（模板的正文部分，占位符已替换）。
       * 专门给"有前言但正文是空的"那一种形状：前言是用户的（可能有 `文件位置`/`位置锁定`
       * 这些只在这里的键），**一个都不许覆盖**；空的正文则按模板补上。
       */
      body?: string;
      tail?: string;
      templatePath: string;
      unresolved: string[];
    };

export interface FillOptions {
  ctx: NoteContext;
  /** 该用的模板正文（读不到 = null）；`template` 分支必须要有它 */
  templateText: string | null;
  templatePath: string;
  /**
   * 该目录被 Templater 目录模板接管了吗（接管 → 一律让位，只补属性）。
   * ⚠️ **只有"新建补全"该传它**：Templater 的目录模板只在**新建文件**时触发，
   * 对已经存在的笔记不会动手 → 存量补全（§13 的显式维护）照两分支走，不传。
   */
  managed?: boolean;
  /**
   * **「不使用模板」**（新建对话框下拉的第一项；用户 2026-09-27 拍板）：
   * 只补前言 + 尾链，**正文留空**，而且**不让位给 Templater**。
   *
   * 与"套整套模板"的区别只有一处，但那一处是关键：这条路**不读模板、不等 300ms**，
   * 调用方带着这段文本**一次 `vault.create()` 落盘** —— Templater 的「新建时触发」
   * 看到的是一篇正文非空的笔记，于是根本不动手（`排查报告.md` §六 那条判据）。
   * 用户选它要的就是"这篇别塞任何模板内容"。
   */
  noTemplate?: boolean;
  /**
   * **这是"新建"这条路吗**（P7.12 · #4 补录拍定：新建同时写「文件位置」= 所在目录）。
   * ⚠️ 只有 `completion.createNote` 的两条新建路径传 `true` —— 存量补全
   * （§13 的显式维护 / 补尾链）**不写「文件位置」**：给存量笔记写上"它就住这儿"
   * 会让它们从"待整理"里消失（声明 == 实际 → 一键整理不动它），那是替用户做决定。
   * ⚠️ P7.13a · #2 起它同时管**六件套里的 `收藏: false`**（Q0：「新建即配置」六件口径）。
   */
  withPosition?: boolean;
  /**
   * 🔴 **坏前言**（P7.17 · #1）：嵌套映射的键名（`schema.fragileKeys` 的产物；
   * 没有就传空/不传）。
   *
   * 这类篇的写口守卫会整篇拦下（`processFrontMatter` 往返会把嵌套值的原文形状改掉，
   * P2 实测）→ 补全对它们**整篇跳过**（逐篇报出来 + 引导去「修前言」面板，
   * P7.16 的 `fragile-fm` 旗标一族）。判据只有一处出处（`schema.fragileKeys`），
   * 调用方从 metadataCache 取 props 现算。
   */
  fragile?: string[];
  /**
   * 🔴 **只落模板原文**（P7.13a · #2 · Q6"开关拆两层"）：`completion.fillCore` 在
   * **「新建笔记补全」关着、但用户显式选了模板**时传它 —— 模板照套（渲染占位符），
   * 但六件套补齐与尾链（`composeFromTemplate` 那两步）都不做。
   */
  bare?: boolean;
  /** 文件创建时间（毫秒）——老笔记补前言时 `创建日期` 取它，不是今天 */
  ctime?: number;
}

/**
 * 规划这一篇要写什么。**纯函数**（喂 text 出 plan），四类结果：
 *   · `none`     什么都不用做（已经完整）
 *   · `skip`     不能动手（原因会显示出来）
 *   · `template` 空白笔记 → 套整套模板
 *   · `patch`    有正文 → 只在开头补 YAML、结尾补尾链（**正文一个字符不动**）
 */
export function buildFillPlan(text: string, opts: FillOptions): FillPlan {
  const { ctx, templateText, templatePath } = opts;

  // ① 目录被 Templater 接管 → 正文让给它（写盘那边只补「文件位置」）
  if (opts.managed) return { kind: 'skip', why: '这个目录由 Templater 目录模板接管，正文让给它' };

  // ② 正文里还有没求值的 `<% %>` → 不碰（求不到值就不动手）
  if (hasTemplaterSyntax(text)) {
    return { kind: 'skip', why: '正文里还有没求值的 <% %>：模板得交给 Templater，本插件不动手' };
  }

  /**
   * ②.5 **坏前言整篇跳过**（P7.17 · #1，红线："坏前言不拆守卫"）：前言里有嵌套映射值
   *（如没求值的 `创建日期: {{date}}`）→ 任何经过 `processFrontMatter` 的写往返
   * 都会把它改形（P2 真机实测，原文本再也回不去）。这类篇去 P7.16 的「修前言」面板
   *（确定性修 + AI 修，一律按行改、不走 fm 写口）。
   * 判据出处只有一处：`schema.fragileKeys`（调用方现算后从 `opts.fragile` 传进来）。
   */
  const fragile = opts.fragile ?? [];
  if (fragile.length > 0) {
    return {
      kind: 'skip',
      code: 'fragile',
      why: `前言里有嵌套值（${fragile.join('、')}）—— 去「修前言」处理`,
    };
  }

  const body = stripFrontmatter(text);
  const blank = body.trim() === '';
  const hadFm = hasFrontmatter(text);

  /**
   * ⚠️ **只有"整个文件真的是空的"才走"套整套模板"**。
   * 判据原来只看"正文是不是空的"，于是"**有前言 + 正文为空**"的笔记会被
   * `vault.process(file, () => plan.text)` **整篇替换** —— 前言里那些只在这里的键
   * （`文件位置` / `位置锁定` / `tags` / 自定义键）**全丢**，而确认弹窗上写的是
   * "只加不删：已有属性一个字符都不动"（独立审查抓到的 🔴）。
   * 这个形状**本插件自己就会造出来**（目录被 Templater 接管时 `ensurePositionKey`
   * 给"有前言、正文空"的笔记补 `文件位置: []`）—— 是"还没炸的雷"，不是理论问题。
   */
  if (blank && !hadFm) {
    /**
     * 🔴 **「不使用模板」**（用户 2026-09-27 拍板）：只补前言 + 尾链，正文留空。
     * 与下面那条"套整套模板"在同一格里 —— 差别是 `templateText` 一律当没有，
     * 于是 `buildYaml` 不会去抄模板前言里的 `类型/状态`（那本来就该由模板决定）。
     * 见 `FillOptions.noTemplate` 上那段：这条路同时意味着**不让位给 Templater**。
     */
    if (opts.noTemplate) {
      const built = buildYaml({ ...opts, templateText: null });
      if (!built.text) return { kind: 'skip', why: built.why ?? '前言拼不出来' };
      return {
        kind: 'patch',
        yaml: built.text,
        tail: tailSection(ctx),
        templatePath: '',
        unresolved: built.unresolved,
      };
    }
    if (!templateText) return { kind: 'skip', why: `读不到模板：${templatePath}` };
    if (hasTemplaterSyntax(templateText)) {
      return {
        kind: 'skip',
        why: `模板 ${baseName(templatePath)} 含 <% %>，要 Templater 求值（没求到就不补）`,
      };
    }
    const r = renderPlaceholders(templateText, ctx);
    /**
     * **开关关着（`bare`）= 只落模板原文**（P7.13a · #2 · Q6 拆两层的下半截）：
     * 套用是用户的显式动作、不受「新建笔记补全」开关管；**六件套 + 尾链的补齐才归开关**。
     * 原样渲染（求不到的占位符照 §7.1 老纪律原样留着），一个字符不加不删。
     */
    if (opts.bare) {
      return { kind: 'template', text: r.text, templatePath, unresolved: r.unresolved, bare: true };
    }
    /**
     * 🔴 **P7.13a · #2（Q4/Q5 拍定）**：套用后的组装 —— 正文保真（渲染结果一个字符不删）
     * ＋ **尾链缺就补 / 自带尾链段时"求不到的行整行删"** ＋ **YAML 缺哪补哪、类型/状态
     * 按目录默认优先**。详情在 `composeFromTemplate`。
     */
    const composed = composeFromTemplate(r.text, opts);
    return {
      kind: 'template',
      text: composed.text,
      templatePath,
      unresolved: composed.unresolved,
      pruned: composed.pruned,
    };
  }

  // ③ 其余一律**只加不删**（含"有前言但正文空"）
  /**
   * 🔴 P7.17 · #1（**修洞**）：**有前言的也要补缺键**。旧写法是 `const needYaml = !hadFm` ——
   * 只要这篇有任何前言（哪怕只有一行 `tags`），YAML 部分**一个字都不碰**，
   * "只加不删"实际落地成"有前言 = 完全不补"，缺的键永远补不上（0-② 的主洞）。
   * 现在改走**按行合并**（`mergeMissingTemplateKeys` —— 与"套用模板"同一台合并机器，
   * 参数化复用）：六件缺哪补哪、**已有键一个字节不动**；改没改由 `merged.text !== text` 说了算。
   */
  const needBody = blank && hadFm && templateText != null && !hasTemplaterSyntax(templateText);
  const needTail = !hasTailSection(body);
  const unresolved: string[] = [];
  let yaml: string | undefined;
  let yamlMode: 'prepend' | 'replace' | undefined;
  let yamlAdded: string[] | undefined;
  if (!hadFm) {
    // 整篇没有前言：现拼一整块、拼在开头（原行为）
    const built = buildYaml(opts);
    yaml = built.text;
    unresolved.push(...built.unresolved);
    if (!yaml) return { kind: 'skip', why: built.why ?? '前言拼不出来' };
    yamlMode = 'prepend';
  } else {
    const merged = mergeMissingTemplateKeys(text, opts);
    if (merged.text !== text) {
      // 取合并后的前言块（连围栏）交给写盘口"整块替换"——正文与其余行一个字节不动
      const mergedLines = merged.text.split('\n');
      const f = fencesOf(mergedLines);
      yaml = `${mergedLines.slice(f.start, f.end + 1).join('\n')}\n`;
      yamlMode = 'replace';
      yamlAdded = merged.added;
    }
  }
  if (!yaml && !needBody && !needTail) return { kind: 'none', why: '已经有前言与尾部双链' };

  let skeleton: string | undefined;
  if (needBody) {
    // 模板的**正文部分**（剥掉它自己的前言），占位符照换；前言一个字都不动
    const r = renderPlaceholders(stripFrontmatter(templateText as string), ctx);
    skeleton = r.text.trim();
    unresolved.push(...r.unresolved);
  }
  let tail: string | undefined;
  if (needTail) {
    tail = tailSection(ctx);
    if (!ctx.center) unresolved.push('{{center}}');
  }
  return { kind: 'patch', yaml, yamlMode, yamlAdded, body: skeleton, tail, templatePath, unresolved };
}

// ────────────────────────────────────────────────────────────────
// 套用模板后的组装（P7.13a · #2 拍定 —— 正文保真 + 缺哪补哪）
// ────────────────────────────────────────────────────────────────
/**
 * **尾链段里"求不到的行整行删"**（P7.13a · #1/#2 拍定）：**只认那三行的形状**
 * （`- 相关笔记…` / `- 所属中心…` / `- 返回大地图…`）× **只限「## 关联笔记」段内** ——
 * 行里只要还留着一个**登记过的**占位符（六个之一；渲染后还留着 = 没求到值）就整行删。
 * 其余占位符、其余行一个字不动（§7.1 的"求不到原样留"仍是常态）。
 */
function pruneTailPlaceholderLines(text: string): { text: string; pruned: string[] } {
  const cut = tailHeadingLine(text);
  if (cut < 0) return { text, pruned: [] };
  const lines = text.split('\n');
  let end = lines.length;
  for (let i = cut + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  const pruned: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > cut && i < end && /^\s*-\s*(相关笔记|所属中心|返回大地图)/.test(lines[i])) {
      const hit = PLACEHOLDERS.find((ph) => lines[i].includes(ph));
      if (hit) {
        if (!pruned.includes(hit)) pruned.push(hit);
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return { text: kept.join('\n'), pruned };
}

/**
 * **套用模板后的 YAML 合并**（P7.13a · #2 拍定；**按行改、不解析 YAML** ——
 * 与迁移修模板同一套手法：认不出的行原样留、既有键不重排、不碰非标量的原文形状）。
 *
 * | 键 | 处置 |
 * |---|---|
 * | `类型` / `状态` | **按目录默认优先**：目录有默认 → 覆盖模板值（"模板写死的值不采用"）；目录没默认（如 Inbox 的状态）→ **沿用模板原值**（不删作者写的键）；`模板` 字面例外 —— 那是"模板文件自己"的标记，没默认可换算就**删键** |
 * | `文件位置` | `withPosition` = 所在目录（与 `buildYaml` 同一条口径；⚠️ **P7.17 · D1** 起存量补齐也传它，值 = **实际落点**——模板那个值指向模板库，照抄 = 错声明，所以这里只可能是"改写成实际"或"删掉"，不会照抄）；`withPosition` 关着 → **删掉**（见函数内 ② 的注释） |
 * | `创建日期` | 缺则落文件创建时间（不是今天 —— 老笔记要保住"首次创建"语义） |
 * | `tags` | 缺则 `[]` |
 * | `收藏` | 缺则 `false`（六件口径，同样只在新建路） |
 *
 * 模板没有**真前言**（第 1 行不是 `---`）时：整套前言由 `buildYaml` 现拼、拼在正文之前。
 * **其余键原样保留**（正文保真在 `composeFromTemplate` 的统一口径里）。
 */
export function mergeTemplateYaml(text: string, opts: FillOptions): string {
  return mergeYamlBlock(text, opts, 'apply').text;
}

/**
 * **存量补缺键**（P7.17 · #1「有前言也补缺键」）：与 `mergeTemplateYaml` **同一台合并机器**
 *（参数化复用，别再写第二份）——差别只有一处：`fill` 模式**只加不删**：
 *   · 六件**缺哪补哪**；**已有键一个字节都不动**（连"目录默认覆盖"那半截都不做 ——
 *     那是"套用模板"的口径；存量笔记已有的值归用户 / 迁移面板 / 覆盖模式管）；
 *   · `类型`/`状态` 的值**只按目录默认**（"拿不准就留空"，不拿模板猜）；
 *   · `文件位置`（= 实际落点，库根写 `.`）与 `收藏: false` 仍按 `withPosition` 闸 ——
 *     ⚠️ P7.17 **D1（用户 2026-10-08 拍板）**：存量补齐也传 `true`（写齐六件，
 *     与新建路完全一致），所以这两键现在也会补进存量笔记。
 *
 * `added` = 这次真补进去的键（报告文案"补了：类型、创建日期…"用它）。
 */
export function mergeMissingTemplateKeys(
  text: string,
  opts: FillOptions,
): { text: string; added: string[] } {
  return mergeYamlBlock(text, opts, 'fill');
}

function mergeYamlBlock(
  text: string,
  opts: FillOptions,
  mode: 'apply' | 'fill',
): { text: string; added: string[] } {
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  /**
   * ⚠️ **只认"真前言"**（P7.13a 独立审 🟡2）：`fencesOf` 会认**正文里任意一行** `---` ——
   * 手写模板"节间画线 + 尾链前那条线"的形状（没有前言、正文里两条 `---`）会被当成键区，
   * 六键被合并进正文中段、产物首行不是 `---`（前言整块作废，属性全成散文）。
   * 真前言的判据 = **第 1 行就是 `---`**（与 `frontmatter.ts` 的 `hasFrontmatter` 同口径）；
   * 不满足就走"整套前言现拼、拼在正文之前"那条。
   */
  if (start !== 0 || end < 0) {
    // 没有"真前言"：`fill` 模式无从合并（调用方只对"有前言"的篇调它）→ 原样返回
    if (mode === 'fill') return { text, added: [] };
    const built = buildYaml({ ...opts, templateText: null });
    if (!built.text) return { text, added: [] };
    return { text: `${built.text}${text.replace(/^\n+/, '')}`, added: [] };
  }
  const block = lines.slice(start + 1, end);
  const out: string[] = [...block];
  /** 六件套的"规范序"：新增的键插在第一个"更靠后的既有键"之前，否则接段尾 */
  const CANON = ['类型', '状态', '文件位置', '创建日期', 'tags', '收藏'];
  const findIdx = (key: string): number => out.findIndex((l) => topKeyOf(l) === key);
  const valueOf = (i: number): string => out[i].slice(out[i].indexOf(':') + 1).trim();
  /** 键的"值区" = 键行 + 紧随的块值行（`  - x`）——替换/删除都整段处理 */
  const valueEnd = (i: number): number => {
    let j = i + 1;
    while (j < out.length && /^\s+-/.test(out[j])) j += 1;
    return j;
  };
  const insertAt = (key: string, add: string[]): void => {
    const my = CANON.indexOf(key);
    let at = out.length;
    for (let i = 0; i < out.length; i += 1) {
      const k = topKeyOf(out[i]);
      if (k && CANON.indexOf(k) > my) {
        at = i;
        break;
      }
    }
    out.splice(at, 0, ...add);
  };
  const setScalar = (key: string, value: string): void => {
    const i = findIdx(key);
    if (i >= 0) {
      /**
       * ⚠️ 独立审 🟡4：键写成**块列表**的形状（`类型:` + 缩进 `- 笔记`）要**连值区一起换** ——
       * 只换键行会在旧值行上面叠一个新值（`类型: 笔记` 下一行还挂着 `  - 笔记`）→ YAML 直接坏。
       */
      out.splice(i, valueEnd(i) - i, `${key}: ${value}`);
    } else {
      insertAt(key, [`${key}: ${value}`]);
    }
  };
  const setBlockList = (key: string, values: string[]): void => {
    const want = [key + ':', ...values.map((v) => `  - ${v}`)];
    const i = findIdx(key);
    if (i < 0) {
      insertAt(key, want);
      return;
    }
    out.splice(i, valueEnd(i) - i, ...want);
  };
  const deleteKey = (key: string): void => {
    const i = findIdx(key);
    if (i < 0) return;
    out.splice(i, valueEnd(i) - i);
  };

  const added: string[] = [];
  if (mode === 'fill') {
    /**
     * **只加不删**（P7.17 · #1）：六件缺哪补哪 —— 每个键先 `findIdx` 看在不在，
     * 在就**一个字节都不动**（连值都不看一眼）。
     * 值只按目录默认（`defaultsForDir`）：拿不准就留空（与"新建即配置"同一口径，
     * 不拿模板写死的值猜布局）。
     */
    const defaults = defaultsForDir(opts.ctx.folderRel);
    for (const key of ['类型', '状态'] as const) {
      if (findIdx(key) >= 0) continue;
      const want = defaults[key];
      if (!want) continue;
      setScalar(key, want);
      added.push(key);
    }
    /**
     * 「文件位置」**键在值空也算缺**（独立审 🟡2）：`文件位置: []` / `文件位置:` 空行
     * 就是 P7.16b 起"**未声明**"的形状，`declaredPositions()` 读回来仍为空 ——
     * 不补的话这类篇会**永远挂在**整理建议 B 类的「缺文件位置」候选里，与 D1"声明 =
     * 已安顿、候选清掉一批"的承诺打架（矩阵里那条"空值键不动"针对的是 `状态:` 这种
     * 往返安全的空标量，别一概而论）。只对这**一个键**开这个口。
     */
    const isDeclared = ((): boolean => {
      const i = findIdx('文件位置');
      if (i < 0) return false;
      const after = out[i].slice(out[i].indexOf(':') + 1).trim();
      if (after === '[]') return false;
      if (after !== '') return true;
      return valueEnd(i) - i > 1;
    })();
    if (opts.withPosition && !isDeclared) {
      setBlockList('文件位置', [opts.ctx.folderRel || ROOT_POS]);
      added.push('文件位置');
    }
    if (findIdx('创建日期') < 0) {
      setScalar('创建日期', opts.ctime ? todayISO(new Date(opts.ctime)) : opts.ctx.date);
      added.push('创建日期');
    }
    if (findIdx('tags') < 0) {
      setScalar('tags', '[]');
      added.push('tags');
    }
    if (opts.withPosition && findIdx('收藏') < 0) {
      setScalar('收藏', 'false');
      added.push('收藏');
    }
  } else {
    const defaults = defaultsForDir(opts.ctx.folderRel);
    // ① 类型 / 状态：目录默认优先；没默认沿用模板原值；`模板` 字面没默认可换算 → 删键
    for (const key of ['类型', '状态'] as const) {
      const want = defaults[key];
      const i = findIdx(key);
      const cur = i >= 0 ? valueOf(i) : '';
      if (want) setScalar(key, want);
      else if (i >= 0 && cur === '模板') deleteKey(key);
    }
    // ② 文件位置：新建路 = 所在目录（**库根顶层写 `.`** —— P7.15 · #1，与 buildYaml 同口径）；
    //    `withPosition` 关着时**删掉模板带来的值**
    //    （独立审 🟡3：模板那个值指向模板库 —— 照抄就是给每篇被补的存量笔记盖一个错声明。
    //      P7.17 · D1 起存量补齐也传 `withPosition: true`，走上面那支 = 改写成实际落点，
    //      模板值同样活不下来；这个删除支留给"真的不该写"的调用方）
    if (opts.withPosition) {
      setBlockList('文件位置', [opts.ctx.folderRel || ROOT_POS]);
    } else {
      deleteKey('文件位置');
    }
    // ③ 六件缺谁补谁（创建日期/tags 两种路径都补；收藏只在新建路）
    if (findIdx('创建日期') < 0) {
      setScalar('创建日期', opts.ctime ? todayISO(new Date(opts.ctime)) : opts.ctx.date);
    }
    if (findIdx('tags') < 0) setScalar('tags', '[]');
    if (opts.withPosition && findIdx('收藏') < 0) setScalar('收藏', 'false');
  }

  return { text: [...lines.slice(0, start + 1), ...out, ...lines.slice(end)].join('\n'), added };
}

/**
 * **套用模板后的组装**（P7.13a · #2 拍定：正文保真 + 缺哪补哪）。两步：
 *   ① **尾链**：模板自带「## 关联笔记」段 → 段内三行里**含没求值占位符的整行删**
 *      （`pruneTailPlaceholderLines`）；整篇缺尾链段 → 补标准三行（`tailSection`，
 *      与"不使用模板"同一条，求不到的行自动省）。
 *   ② **YAML 合并**（`mergeTemplateYaml`）。
 * 除这两处，渲染结果**一个字符不删**。
 *
 * `unresolved` 按**最终文本**现扫（求不到又没被修剪带走的那些 —— "原样留着"的那批）；
 * 被修剪带走的另记 `pruned`（两种实情，文案别混）。
 */
export function composeFromTemplate(
  rendered: string,
  opts: FillOptions,
): { text: string; unresolved: string[]; pruned: string[] } {
  const prunedRes = pruneTailPlaceholderLines(rendered);
  let out = prunedRes.text;
  if (!hasTailSection(out)) out = `${out.replace(/\s*$/, '')}\n\n${tailSection(opts.ctx)}`;
  out = mergeTemplateYaml(out, opts);
  const unresolved = PLACEHOLDERS.filter((ph) => out.includes(ph));
  return { text: out, unresolved, pruned: prunedRes.pruned };
}

export interface YamlBuild {
  text?: string;
  why?: string;
  unresolved: string[];
}

/**
 * 拼一份"只加不删"的 YAML 前言（**v2**）。
 *
 * 判断（P7.12：#4「新建即配置」+ 属性 v2；P7.13a · #2：六件口径）：
 *   · `类型` / `状态` —— **模板静态前言写死的那个值**（把 `模板` 与值域外的值除外）；
 *     模板没写 / 值不可用时 → **按目录默认**（`defaultsForDir`，#4 那张表；
 *     00_Inbox 不写状态 —— "还在 Inbox"本身就是待整理）
 *   · `文件位置` —— **只在"新建"这条路写**（`withPosition`）= 所在目录；
 *     存量补全不写（见 `FillOptions.withPosition` 的理由）
 *   · `创建日期` —— 文件的创建时间（`file.stat.ctime`），不是今天
 *   · `tags` —— `[]`（空数组合法）
 *   · `收藏` —— `false`（六件口径；同样只在"新建"这条路写 —— Q0 拍定）
 *   · 其余键一概不猜；**「领域」与专属字段（发布进度/阶段/平台/…）v2 起不再写**
 */
export function buildYaml(opts: FillOptions): YamlBuild {
  const ctx = opts.ctx;
  const unresolved: string[] = [];
  const out: Record<string, string> = {};

  // 模板里的静态前言 → 只取这两键；`模板` 是"模版文件自己"的类型（套用时按目录默认换算）
  const tplFm = opts.templateText ? parseStaticFrontmatter(opts.templateText) : {};
  const dirDefaults = defaultsForDir(ctx.folderRel);
  const pick = (key: '类型' | '状态', allow: readonly string[]): string => {
    const v = tplFm[key];
    if (
      typeof v === 'string' &&
      v.trim() &&
      !hasTemplaterSyntax(v) &&
      v.trim() !== '模板' &&
      allow.includes(v.trim())
    ) {
      return v.trim();
    }
    return dirDefaults[key] ?? '';
  };
  const type = pick('类型', NOTE_TYPES);
  if (type) out['类型'] = type;
  const status = pick('状态', STATUSES);
  if (status) out['状态'] = status;

  // 创建日期：**老笔记用它的创建时间**（不是今天）——否则一次补全会把 26 篇的创建日期
  // 全改成今天，"首次创建"这个语义就没了
  out['创建日期'] = opts.ctime ? todayISO(new Date(opts.ctime)) : ctx.date;
  out['tags'] = '[]';

  const lines: string[] = ['---'];
  /** 按固定顺序出键；`文件位置` 特殊：列表型两行 + 只在新建路写（写所在目录，相对库根） */
  const scalarKeys = ['类型', '状态', '创建日期', 'tags'];
  for (const key of ['类型', '状态', '文件位置', '创建日期', 'tags', '收藏']) {
    if (key === '文件位置') {
      /**
       * P7.15 · #1（用户 2026-10-08 拍定）：**库根顶层也写** —— 值 = `.`（根标记）。
       * 原先 `folderRel === ''` 直接跳过（"顶层无从表达"，P7.14 口径）—— 用户否了：
       * "要求保留此条属性，文件位置就写他目前的文件路径"。读那一侧由
       * `normalizeDeclaredPos` 把 `.` 映射回空串，体检不假红。
       */
      if (opts.withPosition) lines.push('文件位置:', `  - ${ctx.folderRel || ROOT_POS}`);
      continue;
    }
    // P7.13a · #2 · Q0：六件口径 —— 「收藏」恒写 false、且只在新建路（存量补全不写）
    if (key === '收藏') {
      if (opts.withPosition) lines.push('收藏: false');
      continue;
    }
    if (out[key] !== undefined) lines.push(`${key}: ${out[key]}`);
  }
  for (const [k, v] of Object.entries(out)) {
    if (scalarKeys.includes(k)) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  // 前言下面要空一行再接正文（与模板库里那 6 个模板一致）
  return { text: `${lines.join('\n')}\n\n`, unresolved, why: undefined };
}

/**
 * 从模板正文里读「前言里的键 → 字符串值」，**只看标量**（数组/嵌套值一律忽略）。
 * 这是给 `buildYaml` 抄「类型/状态」用的，不是通用 YAML 解析器
 * —— 真属性一律问 `metadataCache`（`services/frontmatter.ts` 的口径）。
 */
export function parseStaticFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  const { start, end } = fencesOf(lines);
  if (start < 0 || end < 0) return out;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    const m = line.match(/^([^#\s][^:]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (!key || value === '') continue;
    if (value.startsWith('[') || value.startsWith('{')) continue; // 列表/映射：不抄
    out[key] = value;
  }
  return out;
}

/**
 * 前言那对 `---` 在哪儿（**行号**）。
 *
 * ⚠️ 起始那一行可能是 `---`，也**可能是 `%>---`** —— 模板库里 6 个模板都是
 * "Templater 脚本块紧跟着前言"这个形状。只认 `trimEnd() === '---'` 会把**结束**那个
 * `---` 当成起始，于是模板一个字节都改不动（P2 踩过这个坑）。
 * 这个判据原先长在 `services/migrate.ts` 里；P3 的模板渲染也要用同一套 → 上移到这儿，
 * migrate 反过来 import 它（**只留一份**：两处各写一份一定会漂）。
 */
export function fencesOf(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => /^(%>)?\s*---\s*$/.test(l));
  if (start < 0) return { start: -1, end: -1 };
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*---\s*$/.test(lines[i])) return { start, end: i };
  }
  return { start, end: -1 };
}

/**
 * 顶格 `键:` 的键名（缩进行 / 注释返回 null）。
 * ⚠️ 原住 `services/migrate.ts`，**P7.13a 上移到这里** —— 套用模板的 YAML 合并
 * （`mergeTemplateYaml`）与迁移修模板要**同一份**键判据（两处各写一份一定会漂；
 * `fencesOf` 当年也是这么上移的）。migrate 反过来 import 它。
 */
export function topKeyOf(line: string): string | null {
  if (/^\s/.test(line)) return null;
  if (/^\s*#/.test(line)) return null;
  const m = line.match(/^([^\s#][^:]*?):(\s|$)/);
  return m ? m[1].trim() : null;
}

/** 模板里第一条 H1 的标题（给「从笔记提取」用；没有就返回 ''） */
export function firstHeading(text: string): string {
  const m = stripFrontmatter(text).match(/^#{1,3}\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

/**
 * 「从笔记提取模板」：把一篇笔记变成模板（用户 2026-09-24 拍板：**占位化**）。
 *   · H1 标题 → `{{title}}`
 *   · `创建日期` 的值 → `"{{date}}"`（**v2 带引号**：裸占位符是 YAML 流式映射，
 *     属性面板往返一次就被写坏 —— P7.12 #6① 的拍定存法）
 *   · `类型` 的值 → `模板`（这份文件是模板；套用时的真类型由补全按目录换算）
 *   · `tags` 这类列表值原样留（它们是横切标签，不是"这一篇"的信息）
 * 幂等：已经占位化过的不再动（`{{title}}` 已在就不换）。
 */
export function extractTemplate(text: string): { text: string; replaced: string[] } {
  const replaced: string[] = [];
  let out = text;

  const h1 = out.match(/^#\s+(.+)$/m);
  if (h1 && !h1[1].includes('{{title}}')) {
    out = out.replace(/^#\s+.+$/m, '# {{title}}');
    replaced.push('H1 → {{title}}');
  }
  const dateLine = out.match(/^(创建日期)\s*:\s*(.+)$/m);
  if (dateLine && !dateLine[2].includes('{{date}}')) {
    out = out.replace(/^(创建日期)\s*:\s*.+$/m, '$1: "{{date}}"');
    replaced.push('创建日期 → "{{date}}"');
  }
  const typeLine = out.match(/^(类型)\s*:\s*(.+)$/m);
  if (typeLine && typeLine[2].trim() !== '模板') {
    out = out.replace(/^(类型)\s*:\s*.+$/m, '$1: 模板');
    replaced.push('类型 → 模板');
  }
  return { text: out, replaced };
}

/** 模板文件名：`T_<名字>.md`（重名时调用方自己加序号） */
export function templateFileName(name: string): string {
  const base = String(name || '').trim().replace(/\.md$/i, '');
  if (!base) return '';
  return `${base.startsWith('T_') ? base : `T_${base}`}.md`;
}

/** 这个模板值是不是 `T_` 系列（模板库里都叫这个） */
export function looksLikeTemplate(basename: string): boolean {
  return basename.startsWith('T_');
}
