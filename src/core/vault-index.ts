/**
 * core/vault-index.ts —— 全库索引 + **健康标记计算**
 *
 * 范围：知识库根目录（默认 `01_新知识库`）下的全部 `.md`，**含 7 个模板文件**。
 * 实验库实测：43 篇 = 36 篇笔记 + 7 个模板；模板自身不含前言（这是对的，
 * 模板带前言会在套用时重复），所以模板**不参与健康标记**，只被列出来。
 *
 * ⚠️ 本文件是 core 里唯一依赖 services/ 的地方（`services/schema.ts`）——
 * 因为「健康标记」本身就是属性规范的应用（必填矩阵、占位名、位置声明）。
 *
 * 两个容易搞错的平台事实：
 *   · `renameFile` **就地改** `file.path`（platform-pitfalls #18）→ 条目按路径索引，
 *     rename 事件里必须用回调给的 `oldPath` 去删旧键
 *   · `metadataCache` 比写盘**慢 ~300ms**（P-1 S3 实测）→ 属性刷新挂 metadataCache
 *     的 `changed` 事件（它才是"缓存已更新"的正确信号），而不是写盘那一刻
 */
import type { App, CachedMetadata, EventRef, TFile } from 'obsidian';
import { SettingsStore } from './settings';
import { consumeSelfWrite, consumeUserEdit, markUserEdit } from './writes';
import { inKbScope, isInside, joinPath, relativeTo } from './paths';
import { debounce } from './util';
import {
  declaredPositions,
  fragileKeys,
  isPlaceholderTitle,
} from '../services/schema';

/**
 * ⚠️ **`missing-required`（缺必填）已于 v2 退休**（P7.12 · 2026-10-06：
 * "v2 无必填概念"）。别再把它加回来 —— 五件套的完整性由"新建即配置"（#4）保证，
 * 存量由迁移收拾，不再挂旗标。
 */
export type HealthFlag =
  | 'position-mismatch' // 文件位置 ≠ 实际目录        → 红
  | 'placeholder-title' // 标题是「未命名」            → 黄
  | 'broken-link' // 失效双链（**必须排除 .base**）    → 红
  | 'external-change' // 外部改动未合并                → 紫
  | 'empty-file' // 0 字节                           → 黄
  /**
   * **坏前言**（P7.16 · #3）：前言里有嵌套映射值（`fragileKeys` 命中）——
   * 这类篇"插件要写它"时会被守卫整篇拦下（属性改不了 / 补全补不了 / 迁移跳过 /
   * 声明跟随写不进），原先**报告面没有任何旗标**，用户不知道哪些篇坏了。
   * 修法是 `ui/fm-repair-panel.ts`（确定性修 + AI 辅助，一律按行改、不走 fm 写口）。
   */
  | 'fragile-fm';

export const FLAG_META: Record<HealthFlag, { level: 'red' | 'yellow' | 'purple'; label: string }> = {
  'position-mismatch': { level: 'red', label: '位置不一致' },
  'broken-link': { level: 'red', label: '失效双链' },
  'placeholder-title': { level: 'yellow', label: '标题是占位名' },
  'empty-file': { level: 'yellow', label: '空文件' },
  'external-change': { level: 'purple', label: '外部改动未合并' },
  /**
   * 黄档（拍定：与"未名 / 空文"同档）—— 它**不是**"内容坏了"，是"这篇插件动不了"，
   * 而用户手上多半有对应的修法（见修前言面板）。
   */
  'fragile-fm': { level: 'yellow', label: '前言里有嵌套映射' },
};

export interface NoteEntry {
  file: TFile;
  props: Record<string, unknown>;
  flags: HealthFlag[];
  /** 实际目录（相对库根的路径；直接躺在库根下时为 ''） */
  effectivePosition: string;
  // ── 契约之外的补充（P0 实现需要）──
  /** 缓一份路径：`renameFile` 会就地改 `file.path`，事件里要拿旧值 */
  path: string;
  basename: string;
  isTemplate: boolean;
  mtime: number;
  size: number;
}

/**
 * 这一篇里**认得出的失效双链**（P7.13b · E1「AI 修链」与 `broken-link` 旗标**同源**、
 * 原先是 `VaultIndex` 的私有方法）。
 *
 * 返回**归一化后的链接目标**（去 `|别名`、去 `#小标题`、trim；同目标只留一条、按出现序）——
 * 面板的"一条链一张卡"与写链时"认得出才改"都用这一份口径。
 *
 * ⚠️ 两处平台事实（照抄原实现的理由）：
 *   · `.base` 文件的链接会被平台的 `.md` 索引漏掉（platform-pitfalls #22）→ 必须排除；
 *   · 其它带扩展名的（图片等附件）解析不到也不当断链（它们不进 md 索引）。
 */
export function brokenLinkTexts(app: App, file: TFile, cache: CachedMetadata | null): string[] {
  if (!cache) return [];
  const out: string[] = [];
  for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
    const dest = app.metadataCache.getFirstLinkpathDest(ref.link, file.path);
    if (dest) continue;
    const t = normalizeLinkText(ref.link);
    if (t === '') continue;
    if (isFalsePositiveLink(app, t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 链接文本 → 目标（`[[目标#节|别名]]` 里那一段「目标」）。空串 = 认不出，不当断链。 */
export function normalizeLinkText(linktext: string): string {
  return String(linktext ?? '').split('|')[0].split('#')[0].trim();
}

function isFalsePositiveLink(app: App, target: string): boolean {
  if (target === '') return true;
  if (/\.base$/i.test(target)) return true;
  if (target.includes('.')) {
    // 带扩展名：库里存在就当它是对的（非 md 附件不进 md 索引）
    if (app.vault.getAbstractFileByPath(target)) return true;
  }
  if (app.vault.getAbstractFileByPath(target + '.base')) return true;
  return false;
}

/**
 * **库根之下的目录清单**（相对库根；含 `''` 这个"库根本身"）。
 *
 * 三处要用它，而"哪些目录算数"必须只有一份口径：
 * `main.ts` 的自动归位（"目标目录必须已存在"）、`services/ai/index.ts` 的提示词
 * （"落点只能从这些里选"）、以及 AI 计划的落点校验。
 *
 * ⚠️ **返回的是相对库根的口径**（`02_Areas/内容创作`）—— 与树/筛选/属性 `文件位置` 一致。
 * 要喂给 `mover` 的调用方自己 `joinPath(kbRoot, …)`（那是本项目栽过两次的坑：
 * 两种口径混了会把文件搬到 vault 根目录下）。
 *
 * 排除规则：库根之外的一律不算；路径里**任何一段以 `.` 开头**的也不算
 * （`.obsidian` / `.trash` / `.tooling` 这些不是知识库的目录）。
 */
export function kbDirsOf(app: App, kbRoot: string): Set<string> {
  const root = kbRoot.replace(/^\/+|\/+$/g, '');
  const out = new Set<string>(['']);
  for (const f of app.vault.getAllLoadedFiles()) {
    const node = f as unknown as { children?: unknown[]; path: string };
    if (!node.children) continue;
    if (root !== '' && !node.path.startsWith(`${root}/`)) continue;
    if (node.path.split('/').some((seg) => seg.startsWith('.'))) continue;
    out.add(root === '' ? node.path : node.path.slice(root.length + 1));
  }
  return out;
}

export interface IndexChange {
  changed: string[];
  removed: string[];
}

export type IndexListener = (change: IndexChange) => void;

export class VaultIndex {
  private app: App;
  private settings: SettingsStore;
  private entries = new Map<string, NoteEntry>();
  /** 被判定为"外部改动"的路径 → 首次发现时间（我们自己写一次就清掉） */
  private external = new Map<string, number>();
  private listeners = new Set<IndexListener>();
  private refs: EventRef[] = [];
  private started = false;
  private ready = false;
  /** 每次变更 +1 —— 区域重绘的 key（没变就不重画） */
  public revision = 0;

  private pending = new Set<string>();
  private removedPending = new Set<string>();
  private flush = debounce(() => this.applyPending(), 120);
  /** 兜底刷新：万一同一个文件没收到 metadataCache 的 changed */
  private fallback = debounce((path?: string) => {
    if (path) {
      this.pending.add(path);
      this.applyPending();
    }
  }, 450);

  constructor(app: App, settings: SettingsStore) {
    this.app = app;
    this.settings = settings;
  }

  // ── 生命周期 ─────────────────────────────────────────────────
  /** 首次构建等 `onLayoutReady`（那时 metadataCache 已经建好） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.app.workspace.onLayoutReady(() => {
      this.build();
      this.attach();
      this.ready = true;
      this.emit({ changed: this.paths(), removed: [] });
    });
  }

  stop(): void {
    for (const ref of this.refs) this.app.vault.offref(ref);
    this.refs = [];
    this.listeners.clear();
    this.flush.cancel();
    this.fallback.cancel();
    this.started = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * **测试缝：把索引的 debounce 当场排干**（P8 · 测试基建）。
   *
   * ⚠️ **真机没有这个口子** —— 与 `StubMetadataCache.settle()` 同一套路、同一理由：
   * 真机上这条链要等 120ms，离线用例若拿**固定的墙钟毫秒**去赌它跑完，赌的其实是机器负载
   *（本项目三条固有 flake —— `P7.1c · 移动到` / `P7.1c · F2 就地改名` / `网格 · 拖到目录树`
   * —— 都是这个形态：写完之后"立刻读"）。所以测试改成**排干**，不猜时长；
   * `tests/helpers.ts` 的 `settleIndex()` 是唯一调用点。
   *
   * 🔴 **顺序要紧**：先 `metadataCache.settle()`（那次重解析的 `changed` 才会**同步**
   * 把路径记进 `pending` 并挂上 `flush`），再调这里。反过来调 = 排了个空。
   *
   * 🔴 **`fallback`（450ms 那条）刻意不排** —— 它不是"同一件事晚一点"，而是
   * `onWrite` 里的**兜底**：「万一同一个文件没收到 metadataCache 的 `changed`，
   * 兜底一次」，实现是 `pending.add(path)` + `applyPending()`，即**再发一次索引变更**。
   * 把它提前点火的后果实测到了：`P4.5 e2 · **改名之后**位置也还在` 变红 ——
   * 索引变更比该来的时候多一轮 → 区域重绘多一次 → 滚动位置快照那族判据的校准基准被扰
   *（"桩有自己一套时间剖面，测试是照着它校准的"）。而且 `settleIndex` 后面那点 200ms
   * 本来就够不着 450ms —— 它从来不是欠确定性的来源。
   */
  settle(): void {
    this.flush.flush();
  }

  private build(): void {
    this.entries.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.inScope(file.path)) continue;
      this.entries.set(file.path, this.makeEntry(file));
    }
    this.revision += 1;
  }

  /** 强制重建（开发面板/设置改库根后） */
  rebuild(): void {
    this.build();
    this.emit({ changed: this.paths(), removed: [] });
  }

  /**
   * 在范围内：知识库根之下（`''` = 整个库）、且没有以 `.` 开头的路径段。
   * P7.14：范围谓词收编到 `inKbScope`（全项目唯一一份）。
   */
  private inScope(path: string): boolean {
    if (!inKbScope(path, this.settings.kbRoot())) return false;
    return path.toLowerCase().endsWith('.md');
  }

  // ── 事件 ─────────────────────────────────────────────────────
  private attach(): void {
    const vault = this.app.vault;
    this.refs.push(
      vault.on('create', (f) => {
        if (!f || !this.inScope(f.path)) return;
        this.pending.add(f.path);
        this.flush();
      }),
      vault.on('modify', (f) => {
        if (f) this.onWrite(f.path);
      }),
      vault.on('delete', (f) => {
        if (!f || !this.entries.has(f.path)) return;
        this.entries.delete(f.path);
        this.external.delete(f.path);
        this.removedPending.add(f.path);
        this.revision += 1;
        this.flush();
      }),
      vault.on('rename', (f, oldPath) => {
        if (!f) return;
        // renameFile 就地改了 f.path → 用回调给的 oldPath 处理旧键
        const had = this.entries.delete(oldPath);
        const ext = this.external.get(oldPath);
        if (ext != null) {
          this.external.delete(oldPath);
          this.external.set(f.path, ext);
        }
        if (this.inScope(f.path)) {
          this.pending.add(f.path);
        } else if (had) {
          this.removedPending.add(oldPath);
        }
        this.flush();
      }),
      // 属性刷新的正确时机：缓存已更新
      this.app.metadataCache.on('changed', (f) => {
        if (!f || !this.inScope(f.path)) return;
        this.pending.add(f.path);
        this.flush();
      }),
      /**
       * P7.14：**用户在编辑器里打字**先记账 —— 随后平台自动保存触发的 modify 到达
       * `onWrite` 时在账上，就不算"外部改动"（原先用户在 Obsidian 里编辑自己的笔记
       * 也会吃紫标 + 那条撤不掉的「外部改动没合并」行）。同步/别的程序不会发这个
       * 事件 → 照旧标（那是这枚旗标要保的价值）。
       */
      this.app.workspace.on('editor-change', (_editor, info) => {
        const file = (info as { file?: { path?: string } | null } | null)?.file;
        if (file?.path) markUserEdit(file.path);
      }),
    );
  }

  /** 写盘事件：分辨"自己写的" / "用户在编辑器里写的"和"别处改的" */
  private onWrite(path: string): void {
    if (!this.inScope(path)) return;
    if (consumeSelfWrite(path) || consumeUserEdit(path)) {
      // 自己写的 / 用户正在编辑器里写的（P7.14）：清掉外部改动标记
      this.external.delete(path);
    } else if (this.entries.has(path)) {
      if (!this.external.has(path)) this.external.set(path, Date.now());
    }
    this.pending.add(path);
    this.fallback(path); // metadataCache 万一没发 changed，兜底一次
    this.flush();
  }

  private applyPending(): void {
    const changed: string[] = [];
    for (const path of Array.from(this.pending)) {
      this.pending.delete(path);
      const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
      if (!file || !('stat' in file)) {
        if (this.entries.delete(path)) this.removedPending.add(path);
        continue;
      }
      this.entries.set(path, this.makeEntry(file as TFile));
      changed.push(path);
    }
    const removed = Array.from(this.removedPending);
    this.removedPending.clear();
    if (changed.length === 0 && removed.length === 0) return;
    this.revision += 1;
    this.emit({ changed, removed });
  }

  // ── 条目与健康标记 ───────────────────────────────────────────
  private makeEntry(file: TFile): NoteEntry {
    const cache = this.app.metadataCache.getFileCache(file);
    const props = this.propsOf(cache);
    const isTemplate = this.isTemplate(file.path, file.basename);
    // 实际目录（相对库根）：「文件位置」的断言就是拿它比
    const rel = relativeTo(file.path, this.settings.kbRoot());
    const effectivePosition = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const entry: NoteEntry = {
      file,
      props,
      flags: [],
      effectivePosition,
      path: file.path,
      basename: file.basename,
      isTemplate,
      mtime: file.stat?.mtime ?? 0,
      size: file.stat?.size ?? 0,
    };
    entry.flags = this.computeFlags(entry, cache);
    return entry;
  }

  private propsOf(cache: CachedMetadata | null): Record<string, unknown> {
    const fm = cache?.frontmatter;
    if (!fm || typeof fm !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (k === 'position') continue; // Obsidian 内部塞的键，不是用户属性
      out[k] = v;
    }
    return out;
  }

  private isTemplate(path: string, basename: string): boolean {
    if (basename.startsWith('T_')) return true;
    return isInside(path, this.settings.templateDir());
  }

  private computeFlags(entry: NoteEntry, cache: CachedMetadata | null): HealthFlag[] {
    const flags: HealthFlag[] = [];
    if (entry.size === 0) flags.push('empty-file');
    if (isPlaceholderTitle(entry.basename)) flags.push('placeholder-title');

    if (!entry.isTemplate) {
      const declared = declaredPositions(entry.props);
      if (declared.length > 0 && !declared.includes(entry.effectivePosition)) {
        flags.push('position-mismatch');
      }

      if (this.hasBrokenLink(entry.file, cache)) flags.push('broken-link');

      /**
       * **坏前言**（P7.16 · #3，拍定）：判据 = `fragileKeys(props).length > 0` ——
       * 与写口守卫（`frontmatter.ts` 的四条写路径）**同一份实现**（判据搬进了 schema）。
       * ⚠️ **保护目录（`03_AI指令集`）排除**（拍定点名"非模板、非保护目录"）：
       * 那儿的文件只有用户能改 —— 修前言面板按旗标收篇，旗标不亮 = 面板不碰它。
       */
      if (fragileKeys(entry.props).length > 0 && !this.inProtectedDir(entry.path)) {
        flags.push('fragile-fm');
      }
    }

    if (this.external.has(entry.path)) flags.push('external-change');
    return flags;
  }

  /**
   * 在 AI 指令集（保护目录）之下 —— 取值口径与 `services/ai` 的 `isAiProtected`
   * 同一套（`metaRoot/03_AI指令集`，`isInside` 判）。core 不能 import `services/ai`
   * （那是一条重链），所以这里按同样两个设置项现拼，改目录名时两处一起改。
   */
  private inProtectedDir(path: string): boolean {
    const meta = this.settings.metaRoot();
    if (!meta) return false;
    return isInside(path, joinPath(meta, '03_AI指令集'));
  }

  /** 判定与实际取"认得出的失效链"共用一份实现（`brokenLinkTexts`，模块级函数） */
  private hasBrokenLink(file: TFile, cache: CachedMetadata | null): boolean {
    return brokenLinkTexts(this.app, file, cache).length > 0;
  }

  // ── 查询 ─────────────────────────────────────────────────────
  getAll(): NoteEntry[] {
    return Array.from(this.entries.values());
  }

  /** 笔记数（**不含模板** —— 完成定义里的"43 篇"是 getAll().length） */
  notes(): NoteEntry[] {
    return this.getAll().filter((e) => !e.isTemplate);
  }

  get(path: string): NoteEntry | undefined {
    return this.entries.get(path);
  }

  size(): number {
    return this.entries.size;
  }

  private paths(): string[] {
    return Array.from(this.entries.keys());
  }

  flagCounts(): Record<HealthFlag, number> {
    const out = {
      'position-mismatch': 0,
      'placeholder-title': 0,
      'broken-link': 0,
      'external-change': 0,
      'empty-file': 0,
      'fragile-fm': 0,
    } as Record<HealthFlag, number>;
    for (const e of this.entries.values()) {
      for (const f of e.flags) out[f] += 1;
    }
    return out;
  }

  /** 全库某属性的取值聚合（属性编辑器的候选值；`平台` 这类自由值全靠它） */
  valuesOf(prop: string): string[] {
    const set = new Set<string>();
    for (const e of this.notes()) {
      const v = e.props[prop];
      if (v == null || v === '') continue;
      // ⚠️ 必须带花括号：写成 `if (A) for (…) if (B) …; else …;`
      // 那个 else 会**绑到内层 if** 上（悬垂 else），单值属性就一个都收不进来
      if (Array.isArray(v)) {
        for (const x of v) if (x != null && x !== '') set.add(String(x));
      } else {
        set.add(String(v));
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }

  /** 全库标签聚合（前言 tags + 正文 #tag） */
  tags(): string[] {
    const set = new Set<string>();
    for (const e of this.notes()) {
      const v = e.props['tags'];
      const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
      for (const t of list) if (t != null && t !== '') set.add(String(t).replace(/^#/, ''));
      const cache = this.app.metadataCache.getFileCache(e.file);
      for (const t of cache?.tags ?? []) set.add(t.tag.replace(/^#/, ''));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }

  /**
   * 这份文件是不是被**别处**改过（不是我们自己写的）。
   * 给快照还原用：写回内容前要拿它挡一下（`snapshot.ts` 的 externallyChanged）。
   */
  isExternallyChanged(path: string): boolean {
    return this.external.has(path);
  }

  /** 用户主动"确认过"外部改动（写前重读）后清标记 */
  clearExternal(path: string): void {
    if (this.external.delete(path)) {
      this.pending.add(path);
      this.flush.flush();
    }
  }

  onChange(fn: IndexListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(change: IndexChange): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(change);
      } catch (e) {
        console.error('[经纬] 索引订阅者出错', e);
      }
    }
  }
}
