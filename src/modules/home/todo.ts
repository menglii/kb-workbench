/**
 * modules/home/todo.ts —— 首页「待处理」的生成规则（**纯逻辑**；现 12 条 —— P7.16 加「坏前言」）
 *
 * 交互规格 §2.3：**这是功能，不只是展示** —— 每条都要能点进去、带着
 * 「预筛选 + 预选中 + 光标落操作栏」跳到全部笔记（靠 `NotesIntent`）；
 * 例外是三条"文件不在笔记索引里"的库维护规则（孤儿附件 / 重复文件），
 * 它们点开一个**轻菜单**列文件（`action`，见 `blocks/todo.ts`）。
 *
 * 排序：按严重度（红 > 黄 > 蓝），同级按数量降序。超过 5 条时折叠（§2.3）。
 * 口径都从索引来（`HealthFlag` 的同一份判定），不另立标准；
 * 16.4 三件的计算在 `services/maintenance.ts`（缓存口径也在那边）。
 *
 * P7.8（1.5）：两行带 `ai` 标记（收件箱 = classify，未命名 = title）——
 * 行右键菜单据此画「✦ AI 处理这一项」（P7.12 · R5 撤掉了行尾的 ✦ 按钮，
 * 菜单入口保留），接线与拍板理由见 `TodoItem.ai` 的注释。
 */
import type { NotesIntent } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import type { MaintenanceFindings } from '../../services/maintenance';
import { listBrief } from '../../services/rebuild';

export type TodoLevel = 'red' | 'yellow' | 'blue';

export interface TodoItem {
  id: string;
  level: TodoLevel;
  /** 「收件箱有 7 篇待整理」 */
  text: string;
  /** 行尾的动作词（「整理这 7 篇」「去补全」） */
  act: string;
  /** 第二行的佐证：几个名字 / 目录 */
  meta: string;
  count: number;
  /** 跳到「全部笔记」的意图（直接动作类的项没有这个） */
  intent?: NotesIntent;
  /**
   * 直接动作（不走 goNotes）：
   * `migrate` = 打开迁移面板；`orphans` / `duplicates` = 打开轻菜单列文件
   *（附件/重复组不在笔记索引里，跳「全部笔记」选不到它们）。
   */
  action?: 'migrate' | 'orphans' | 'duplicates';
  /**
   * **配了「AI 处理」的行**（P7.8 · 1.5；只标类型不写文案 —— 渲染层画行菜单项）：
   * · `'classify'` = 开整理建议面板并直接落 AI 分类那一跳（收件箱）；
   * · `'title'` = 开「AI 起标题」面板（未命名）。
   * ⚠️ **只有两行配、只这两档**（P7.8 拍板；「缺领域」那一行 P7.12 随领域退役退场）：
   * · 位置不一致**不配** —— 它的笔记**有声明**，按 P7.6 的守卫（声明是用户意图）
   *   进不了 AI 分诊；修法是机制活（搬回声明处 / 改声明）；
   * · 其余各条（迁移 / 失效双链 / 外改 / 空文 / 孤儿 / 重复 / 一次性标签）不配，
   *   逐条理由在 `期末交接-P7.8.md`。
   */
  ai?: 'classify' | 'title';
}

const LEVEL_ORDER: Record<TodoLevel, number> = { red: 0, yellow: 1, blue: 2 };

/** 折叠阈值（交互规格 §2.3：超过 5 条时，5 条之后收进「还有 N 项」） */
export const FOLD_AT = 5;

/** `buildTodos` 的外部输入（凡是靠纯索引算不出来的，从这里进来） */
export interface TodoInputs {
  /** 属性迁移：还有几篇是旧规范（含"工具碰不了、得人工改"的那几篇；0 = 不出这一条） */
  migrateCount?: number;
  /** 迁移那条的旁注（「2 处待你定」之类） */
  migrateMeta?: string;
  /** 库维护三件（P7.6 · 16.4；计算在 `services/maintenance.ts`） */
  maintenance?: MaintenanceFindings;
  /**
   * 「还没写内容」的**空壳笔记**（P7.14；**vault 绝对路径** —— 与 `entries` 同口径，
   * 转换在调用方做）。0 字节那半边照旧由 `empty-file` 旗标出；这里补的是
   * "有自动前言、正文空白"那些（`maintenance.emptyNotes`）。
   */
  emptyNotes?: string[];
}

export function buildTodos(
  entries: NoteEntry[],
  inboxDir: string,
  extra: TodoInputs = {},
): TodoItem[] {
  const notes = entries.filter((e) => !e.isTemplate);
  const out: TodoItem[] = [];

  const withFlag = (flag: string): NoteEntry[] =>
    notes.filter((e) => e.flags.includes(flag as never));

  // 红：失效双链 / 位置不一致
  const broken = withFlag('broken-link');
  if (broken.length > 0) {
    out.push({
      id: 'broken-link',
      level: 'red',
      text: `${broken.length} 篇有失效双链`,
      act: '去看看',
      meta: names(broken),
      count: broken.length,
      intent: { flags: ['broken-link'], paths: paths(broken), selectPaths: paths(broken) },
    });
  }
  const posMismatch = withFlag('position-mismatch');
  if (posMismatch.length > 0) {
    out.push({
      id: 'position-mismatch',
      level: 'red',
      text: `${posMismatch.length} 篇位置不一致`,
      act: '去看看',
      meta: names(posMismatch),
      count: posMismatch.length,
      intent: { flags: ['position-mismatch'], paths: paths(posMismatch), selectPaths: paths(posMismatch) },
    });
  }
  const external = withFlag('external-change');
  if (external.length > 0) {
    out.push({
      id: 'external-change',
      level: 'yellow',
      text: `${external.length} 篇有外部改动没合并`,
      act: '去看看',
      meta: names(external),
      count: external.length,
      intent: { flags: ['external-change'], paths: paths(external), selectPaths: paths(external) },
    });
  }

  // 黄：占位标题 / 0 字节
  // ⚠️ v2：「缺领域」行随领域退役退场（P7.12 · 2026-10-06）—— 别再把它加回来。
  // 黄：属性还是旧规范（v2 迁移要解决的问题；迁完这一条自己消失）
  const migrateCount = extra.migrateCount ?? 0;
  if (migrateCount > 0) {
    out.push({
      id: 'migrate',
      level: 'yellow',
      text: `${migrateCount} 篇的属性还是旧规范`,
      act: '去迁移',
      meta: extra.migrateMeta ?? '只读预演 → 逐篇确认 → 执行',
      count: migrateCount,
      action: 'migrate',
    });
  }
  const placeholder = withFlag('placeholder-title');
  if (placeholder.length > 0) {
    out.push({
      id: 'placeholder-title',
      level: 'yellow',
      text: `${placeholder.length} 篇标题还是「未命名」`,
      act: '去改名',
      meta: dirs(placeholder),
      count: placeholder.length,
      intent: { paths: paths(placeholder), selectPaths: paths(placeholder) },
      ai: 'title',
    });
  }
  /**
   * 「还没写内容」= 0 字节（旗标）∪ 空壳笔记（P7.14：只有自动前言、正文空白 ——
   * 原先只看 0 字节，新建出来的空笔记一条都不报，还反倒掉进「内容重复」里，真机反馈）。
   */
  const emptyExtra = new Set(extra.emptyNotes ?? []);
  const empty = notes.filter((e) => e.flags.includes('empty-file') || emptyExtra.has(e.path));
  if (empty.length > 0) {
    out.push({
      id: 'empty-file',
      level: 'yellow',
      text: `${empty.length} 篇还没写内容`,
      act: '去看看',
      meta: names(empty),
      count: empty.length,
      intent: { paths: paths(empty), selectPaths: paths(empty) },
    });
  }

  /**
   * **坏前言**（P7.16 · #3，拍定 Q3）：前言里有嵌套映射（多半是没加引号的占位符）的篇 ——
   * 插件写不了它（守卫整篇跳过：属性改不了 / 补全补不了 / 迁移跳过 / 声明跟随写不进）。
   * ①（行菜单自动处理）= 修前言流程（确定性修 + AI 辅助）；点行 = 跳全部笔记筛这几篇。
   */
  const fragile = withFlag('fragile-fm');
  if (fragile.length > 0) {
    out.push({
      id: 'fragile-fm',
      level: 'yellow',
      text: `${fragile.length} 篇前言里有嵌套值`,
      act: '去修',
      meta: names(fragile),
      count: fragile.length,
      intent: { paths: paths(fragile), selectPaths: paths(fragile) },
    });
  }

  // 蓝：收件箱待整理
  const inbox = notes.filter((e) => e.effectivePosition === inboxDir);
  if (inbox.length > 0) {
    out.push({
      id: 'inbox',
      level: 'blue',
      text: `收件箱有 ${inbox.length} 篇待整理`,
      act: `整理这 ${inbox.length} 篇`,
      meta: inboxDir,
      count: inbox.length,
      intent: { dir: inboxDir, selectAll: true },
      ai: 'classify',
    });
  }

  // 蓝：库维护三件（P7.6 · 16.4）—— 只报数；动作是轻菜单（文件不在笔记索引里）
  const m = extra.maintenance;
  if (m && m.orphans.rels.length > 0) {
    out.push({
      id: 'orphan-files',
      level: 'blue',
      text: `${m.orphans.rels.length} 件附件没人引用`,
      act: '去看看',
      meta: relNames(m.orphans.rels),
      count: m.orphans.rels.length,
      action: 'orphans',
    });
  }
  if (m && m.dups.groups.length > 0) {
    const fileN = m.dups.groups.reduce((n, g) => n + g.length, 0);
    out.push({
      id: 'dup-files',
      level: 'blue',
      text: `${m.dups.groups.length} 组文件内容重复（共 ${fileN} 件）`,
      act: '去看看',
      meta: relNames(m.dups.groups[0]),
      count: m.dups.groups.length,
      action: 'duplicates',
    });
  }
  if (m && m.unusedTags.tags.length > 0) {
    out.push({
      id: 'unused-tags',
      level: 'blue',
      text: `${m.unusedTags.tags.length} 个标签只用过一次`,
      act: '去看看',
      meta: listBrief(m.unusedTags.tags, 3),
      // ⚠️ `listBrief` 的分隔是「、」，这行标签列表沿用（与上面三条的名字列表不同风格是既有实现）
      count: m.unusedTags.tags.length,
      intent: { paths: m.unusedTags.notePaths, selectPaths: m.unusedTags.notePaths },
    });
  }

  out.sort((a, b) => {
    const lv = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
    return lv !== 0 ? lv : b.count - a.count;
  });
  return out;
}

/** 去掉被忽略的（忽略存插件 data.json，设置里可恢复） */
export function filterDismissed(items: TodoItem[], dismissed: string[]): TodoItem[] {
  return items.filter((i) => !dismissed.includes(i.id));
}

/** 折叠：前 5 条 + 「还有 N 项」 */
export function fold(items: TodoItem[]): { shown: TodoItem[]; rest: number } {
  if (items.length <= FOLD_AT) return { shown: items, rest: 0 };
  return { shown: items.slice(0, FOLD_AT), rest: items.length - FOLD_AT };
}

function paths(entries: NoteEntry[]): string[] {
  return entries.map((e) => e.path);
}

/** 相对库根路径们 → 「前 3 个名字 等 N 件」（与 `names()` 同风格） */
function relNames(rels: string[]): string {
  const names = rels.map((r) => r.split('/').pop() ?? r);
  const list = names.slice(0, 3);
  return names.length > 3 ? `${list.join(' · ')} 等 ${names.length} 件` : list.join(' · ');
}

function names(entries: NoteEntry[]): string {
  const list = entries.slice(0, 3).map((e) => e.basename);
  return entries.length > 3 ? `${list.join(' · ')} 等 ${entries.length} 篇` : list.join(' · ');
}

function dirs(entries: NoteEntry[]): string {
  const uniq = Array.from(new Set(entries.map((e) => e.effectivePosition || '库根')));
  return uniq.length > 3 ? `${uniq.slice(0, 3).join(' · ')} 等 ${uniq.length} 个目录` : uniq.join(' · ');
}
