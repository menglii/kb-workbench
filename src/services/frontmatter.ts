/**
 * services/frontmatter.ts —— 属性读写（唯一写路径）
 *
 * 两条铁律：
 *  ① **改属性只能走 `fileManager.processFrontMatter`**（platform-pitfalls #17）：
 *     它是公开 API、走 vault 队列 = 原子。真库的同步（云盘）就跑在本插件同一个进程里，
 *     直接 `vault.modify` 拼 YAML 会和同步抢写。
 *  ② **动笔前先 `markSelfWrite`** —— 否则健康检查会把我们自己的写当成「外部改动」。
 *
 * 附加（17.2，P7.3a）：**写之前先过「非标量守卫」**（`fragileKeys`）——
 * `processFrontMatter` 是"解析再序列化"，`创建日期: {{date}}` 这种嵌套映射一次往返
 * 就变成 `创建日期:` + `  "{ date }":`，原文本再也回不去（P2 真机实测）。凡命中者
 * **整篇跳过 + 报出来**；本文件的四条写路径（`set` / `setMany` / `remove` / `update`）全过它。
 *
 * 读取一律走 `metadataCache`（快）。**刚写完别立刻读属性**：
 * `adapter.write` 后索引 0ms 可见，但 metadataCache 要 ~300ms（P-1 S3 实测）。
 * 需要"刚写就确认"的场合走 `vault.read` 比内容（`body()`），别去问属性。
 */
import type { App, TFile } from 'obsidian';
import { baseName } from '../core/paths';
import { markSelfWrite } from '../core/writes';
import { fragileKeys } from './schema';
import { notifyPartial } from '../ui/notify';

/**
 * ⚠️ **`fragileKeys`（非标量前言值的键名）已搬去 `services/schema.ts`**（P7.16）——
 * 定义挪窝的原因写在那边（vault-index 的「坏前言」旗标要跑同一份判据，而 core 对
 * services 的依赖只开给 schema 那一个口）。**判定口径一字未改**，本文件的四条写路径
 * （`set` / `setMany` / `remove` / `update`）照旧全过它。
 */

/** 写前言的统一结果：`skipped` 非空 = **整篇跳过**了，一个字节都没写 */
export interface FmWriteResult {
  skipped: string[];
}

export class FrontmatterService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** 属性（走 metadataCache；没有前言时返回空对象） */
  props(file: TFile): Record<string, unknown> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    return fm && typeof fm === 'object' ? { ...fm } : {};
  }

  /** 有没有前言（不解析内容，只回答"这篇有没有前言"） */
  hasFrontmatter(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache?.frontmatterPosition != null;
  }

  /**
   * **非标量守卫**（17.2）：命中就整篇跳过 + 报出来。
   *
   * 为什么"只改别的键"也不行：`processFrontMatter` 写的是**整份前言**（解析再序列化），
   * 只要进了那个回调，那个嵌套映射就已经被改形了 —— 这不是"会不会"的问题（P2 实测）。
   * 为什么服务层自己报：与 `mover` / `snapshot` 同一条纪律 —— 靠每个调用方记得转达，一定会漏。
   */
  private guardFragile(file: TFile): FmWriteResult | null {
    const keys = fragileKeys(this.props(file));
    if (keys.length === 0) return null;
    notifyPartial(
      `跳过「${baseName(file.path)}」：前言里有嵌套映射`,
      `写盘会把「${keys.join('、')}」的原文形状改掉（多半是 {{…}} 这类占位符，改了就回不去）。这一篇得人工改；同一批里其他篇不受影响。`,
    );
    return { skipped: keys };
  }

  async set(file: TFile, key: string, value: unknown): Promise<FmWriteResult> {
    return this.setMany(file, { [key]: value });
  }

  /** 批量写（一次 processFrontMatter，一次落盘）。命中守卫 → `skipped` 非空、没写盘 */
  async setMany(file: TFile, patch: Record<string, unknown>): Promise<FmWriteResult> {
    const target = this.app.vault.getAbstractFileByPath(file.path);
    if (!target) throw new Error(`文件不在库里：${file.path}`);
    const guard = this.guardFragile(file);
    if (guard) return guard;
    markSelfWrite(file.path);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete fm[k];
        else fm[k] = v;
      }
    });
    return { skipped: [] };
  }

  /** 删键（P2 迁移用：`主题` / `标签` / `仅显示于` / `聚焦`）。同样过守卫 */
  async remove(file: TFile, keys: string[]): Promise<FmWriteResult> {
    if (keys.length === 0) return { skipped: [] };
    const guard = this.guardFragile(file);
    if (guard) return guard;
    markSelfWrite(file.path);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const k of keys) delete fm[k];
    });
    return { skipped: [] };
  }

  /** 自由改写（回调里改 fm 对象本身）。同样过守卫 */
  async update(file: TFile, fn: (fm: Record<string, unknown>) => void): Promise<FmWriteResult> {
    const guard = this.guardFragile(file);
    if (guard) return guard;
    markSelfWrite(file.path);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fn(fm as Record<string, unknown>);
    });
    return { skipped: [] };
  }

  /** 正文（**剥掉前言**）—— 走 vault.read，不走 metadataCache */
  async body(file: TFile): Promise<string> {
    const text = await this.app.vault.read(file);
    return stripFrontmatter(text);
  }

  /** 全文（原样） */
  async text(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }
}

/**
 * 拆成 **{ head, body }**（P7.12 · R8「美化笔记」用）—— "只换正文、前言原样保留"
 * 要的就是这两半。判据与 `stripFrontmatter` **同一套**（第一行是 `---`、找 `---` 收尾行）——
 * 不解析 YAML、不另写一套。
 *
 * ⚠️ **前言收尾行之后的空行归 head**（与 `stripFrontmatter` 的切法故意不同）：
 * 那是"隔开前言与正文"的排版空白，替换正文时留着它，文件不会变成
 * `---` 紧贴正文的难看样。**没有收尾换行的前言 = 退化 = 整篇当 head、body 为空**
 *（调用方按"没有正文"拒绝，绝不让模型把前言块当正文吃掉）。
 */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const t = String(text ?? '');
  if (!t.startsWith('---')) return { head: '', body: t };
  const firstLineEnd = t.indexOf('\n');
  if (firstLineEnd < 0 || t.slice(0, firstLineEnd).trimEnd() !== '---') {
    return { head: '', body: t };
  }
  const rest = t.slice(firstLineEnd + 1);
  const close = rest.match(/^---[ \t]*$/m);
  if (!close || close.index === undefined) return { head: '', body: t };
  const afterClose = rest.indexOf('\n', close.index);
  if (afterClose < 0) return { head: t, body: '' }; // 前言没收尾换行 → 退化（见上）
  let bodyStart = firstLineEnd + 1 + afterClose + 1;
  while (t[bodyStart] === '\n') bodyStart += 1; // 紧跟的空行也归 head
  return { head: t.slice(0, bodyStart), body: t.slice(bodyStart) };
}

/**
 * 剥掉 YAML 前言，返回正文。
 * 只做字符串操作，不解析 YAML —— 属性一律问 metadataCache，避免"自己写一套解析器"。
 */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  // 第一行必须是 `---`（前后可有空白），否则不认（platform-pitfalls #38：
  // `---` 不在第 1 行 → Obsidian 根本不认前言）
  const firstLineEnd = text.indexOf('\n');
  if (firstLineEnd < 0) return text;
  const first = text.slice(0, firstLineEnd).trimEnd();
  if (first !== '---') return text;
  const rest = text.slice(firstLineEnd + 1);
  const close = rest.match(/^---[ \t]*$/m);
  if (!close || close.index === undefined) return text;
  const afterClose = rest.indexOf('\n', close.index);
  return afterClose < 0 ? '' : rest.slice(afterClose + 1);
}

/** 有没有前言（只判形状，不判合法性——合法性归 Obsidian） */
export function hasFrontmatter(text: string): boolean {
  if (!text.startsWith('---')) return false;
  const firstLineEnd = text.indexOf('\n');
  if (firstLineEnd < 0) return false;
  if (text.slice(0, firstLineEnd).trimEnd() !== '---') return false;
  return /^---[ \t]*$/m.test(text.slice(firstLineEnd + 1));
}

/** 剥掉前言后正文是否为空（Templater 的判定点也是这个形状，见 platform-pitfalls #38） */
export function isBodyEmpty(text: string): boolean {
  return stripFrontmatter(text).trim() === '';
}
