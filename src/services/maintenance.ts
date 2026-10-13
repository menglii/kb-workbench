/**
 * services/maintenance.ts —— **库维护三件**（P7.6 · 16.4）的计算与缓存
 *
 * 三件的判据口径（设计对表 §3，先定死再实现）：
 *
 * | 件 | 算它 | 不算 |
 * |---|---|---|
 * | 孤儿附件 | 库根下**非 `.md`** 文件、**全库**（整个 vault）的链接与嵌入都指不到 | 排除表里的整棵（默认含 `99_Meta` —— 模板配图天然不算）、`.开头`（`vaultShapeOf` 已跳过） |
 * | 重复文件 | 内容 **sha256 相同**（按**字节**哈希，不走 utf8 往返）的组 | 0 字节文件；**空壳笔记**（剥前言/尾链后正文空白 —— P7.14：它们走「还没写内容」，不算重复）；>20MB 的大件（不拖垮一次重绘） |
 * | 未使用标签 | 全库（非模板）笔记 `tags` 聚合里**出现次数 = 1** 的标签 | 模板里的标签 |
 *
 * ⚠️ **开销口径**：整块结果按 **索引修订号 + 库根 + 排除表** 失效重算；sha256 按
 * `(size, mtime)` 指纹缓存（文件没动过就不重算）。43 篇规模毫秒级；上千篇也只随索引
 * 变化重算一次，不进每次重绘。
 *
 * ⚠️ **枚举走 `vaultShapeOf`（adapter.list）**，不走 `getAllLoadedFiles()` —— 与 rebuild
 * 同一条理由：缓存树看不到刚分出来的目录/文件；顺带 `.开头` 的目录天然不进。
 */
import { createHash } from 'node:crypto';
import type { App } from 'obsidian';
import type { SettingsStore } from '../core/settings';
import type { VaultIndex } from '../core/vault-index';
import { joinPath } from '../core/paths';
import { asList } from './schema';
import { isExcluded } from './reconcile';
import { vaultShapeOf } from './rebuild';
import { stripFrontmatter } from './frontmatter';
import { stripTailSection } from './templates';

/** 单个文件超过这个大小不参与哈希（护住一次重绘；真实附件远小于它） */
export const MAX_HASH_BYTES = 20 * 1024 * 1024;

export interface MaintenanceFindings {
  /** 孤儿附件（**相对库根**，按名字排序） */
  orphans: { rels: string[] };
  /** 重复组（组内 = 相对库根；≥2 件一组；组间按首件排序） */
  dups: { groups: string[][] };
  /** 只用过一次的标签 + 带这些标签的笔记（**库内绝对路径** —— 喂 NotesIntent 的口径） */
  unusedTags: { tags: string[]; notePaths: string[] };
  /**
   * **还没写内容的笔记**（P7.14；**相对库根**）：`.md` 且 0 字节，**或**
   * 剥掉前言/尾链后正文空白（"空壳" —— 新建出来只有自动前言的那种）。
   * 待处理「N 篇还没写内容」行读它；**空壳不进重复候选**（两篇空壳逐字相同，
   * 但它们不是"重复内容"，是"都还没写"—— 真机反馈修正）。
   */
  emptyNotes: string[];
}

// ────────────────────────────────────────────────────────────────
// 纯函数（离线可断言）
// ────────────────────────────────────────────────────────────────
/** 孤儿 = 候选附件里"全库引用集"指不到的（引用集是**库内绝对路径**） */
export function pickOrphans(
  attachmentRels: string[],
  referencedAbs: Set<string>,
  kbRoot: string,
): string[] {
  const out: string[] = [];
  for (const rel of attachmentRels) {
    if (referencedAbs.has(joinPath(kbRoot, rel))) continue;
    out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 按哈希分组，只留 ≥2 件的组（组间按首件排序，组内按路径排序 —— 全部确定性） */
export function groupDuplicates(entries: { rel: string; hash: string }[]): string[][] {
  const byHash = new Map<string, string[]>();
  for (const e of entries) {
    const list = byHash.get(e.hash) ?? [];
    list.push(e.rel);
    byHash.set(e.hash, list);
  }
  const groups = Array.from(byHash.values())
    .filter((g) => g.length >= 2)
    .map((g) => g.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return groups;
}

/** 出现次数 = 1 的标签 + 带它们的笔记（`notes` 已由调用方剔过模板） */
export function pickUnusedTags(notes: { path: string; tags: string[] }[]): {
  tags: string[];
  notePaths: string[];
} {
  const counts = new Map<string, number>();
  const byTag = new Map<string, Set<string>>();
  for (const n of notes) {
    for (const raw of n.tags) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
      const set = byTag.get(t) ?? new Set<string>();
      set.add(n.path);
      byTag.set(t, set);
    }
  }
  const tags = Array.from(counts.entries())
    .filter(([, c]) => c === 1)
    .map(([t]) => t)
    .sort();
  const paths = new Set<string>();
  for (const t of tags) for (const p of byTag.get(t) ?? []) paths.add(p);
  return { tags, notePaths: Array.from(paths).sort() };
}

// ────────────────────────────────────────────────────────────────
// 收集（异步）+ 缓存
// ────────────────────────────────────────────────────────────────
interface StatInfo {
  size: number;
  mtime: number;
}

/** sha256 缓存：路径 → { size, mtime, hash }（文件没动过就不重算） */
const hashCache = new Map<string, StatInfo & { hash: string }>();
/** 整块结果缓存 */
let cache: { key: string; value: MaintenanceFindings } | null = null;

/** 测试用：清干净（真机不需要 —— 缓存跟着索引修订号自然失效） */
export function __resetMaintenance(): void {
  hashCache.clear();
  cache = null;
}

export async function computeMaintenance(deps: {
  app: App;
  settings: SettingsStore;
  index: VaultIndex;
  /** 自动化那份「排除」（`automation.get().reconcile.exclude`）—— 由调用方带进来 */
  exclude: string[];
  /** 索引修订号（`ctx.store.get().indexRevision`）—— 缓存失效键 */
  revision: number;
}): Promise<MaintenanceFindings> {
  const kbRoot = deps.settings.kbRoot();
  const key = `${kbRoot}|${deps.revision}|${deps.exclude.join('\u0001')}`;
  if (cache && cache.key === key) return cache.value;

  const shape = await vaultShapeOf(deps.app, kbRoot);
  /** 库内绝对路径 → stat（一次拿齐；后面的过滤 / 哈希指纹都用它） */
  const stats = new Map<string, StatInfo>();
  await Promise.all(
    Array.from(shape.files).map(async (rel) => {
      const abs = joinPath(kbRoot, rel);
      try {
        const st = await deps.app.vault.adapter.stat(abs);
        if (st && st.type === 'file') stats.set(rel, { size: st.size, mtime: st.mtime });
      } catch {
        // 读不到就不参与（竞态删掉的）
      }
    }),
  );

  // ── ① 孤儿附件：候选 = 非 md、非排除；引用集 = resolvedLinks ∪ 逐篇 embeds 解析 ──
  const attachments: string[] = [];
  for (const rel of shape.files) {
    if (rel.toLowerCase().endsWith('.md')) continue;
    if (isExcluded(rel, deps.exclude)) continue;
    attachments.push(rel);
  }
  attachments.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const referenced = new Set<string>();
  const resolved = deps.app.metadataCache.resolvedLinks ?? {};
  for (const dests of Object.values(resolved)) {
    for (const dest of Object.keys(dests ?? {})) referenced.add(dest);
  }
  for (const f of deps.app.vault.getMarkdownFiles()) {
    const c = deps.app.metadataCache.getFileCache(f);
    for (const emb of c?.embeds ?? []) {
      const dest = deps.app.metadataCache.getFirstLinkpathDest(emb.link, f.path);
      if (dest) referenced.add(dest.path);
    }
  }
  const orphans = pickOrphans(attachments, referenced, kbRoot);

  // ── ② 重复文件：sha256（字节口径；0 字节与大件不参与）+ 顺路认「空壳笔记」──
  const hashEntries: { rel: string; hash: string }[] = [];
  /** 「还没写内容」的笔记（**相对库根**；0 字节 md ∪ 剥前言/尾链后正文空白）—— P7.14 */
  const emptyNotes: string[] = [];
  for (const rel of shape.files) {
    if (isExcluded(rel, deps.exclude)) continue;
    const st = stats.get(rel);
    if (!st) continue;
    const isMd = rel.toLowerCase().endsWith('.md');
    if (st.size <= 0) {
      if (isMd) emptyNotes.push(rel); // 0 字节的 md 也是"还没写内容"
      continue; // 0 字节文件照旧不进重复候选（空文件有自己的规则）
    }
    if (st.size > MAX_HASH_BYTES) continue;
    const abs = joinPath(kbRoot, rel);
    const hit = hashCache.get(abs);
    const cachedHash = hit && hit.size === st.size && hit.mtime === st.mtime ? hit.hash : null;
    try {
      const buf = await deps.app.vault.adapter.readBinary(abs);
      const bytes = new Uint8Array(buf);
      if (isMd) {
        /**
         * P7.14（真机反馈修正）：**「空壳笔记」不算"内容重复"** —— 两篇刚建出来的
         * 空笔记（自动前言逐字相同）会被判成"一组内容重复"，而它们明明是"都还没写"。
         * 判定 = 剥前言/尾链后正文空白（与「清空流」/ 待处理「还没写内容」同一份判据）。
         * ⚠️ md 要**原文**才能判空壳，而哈希缓存里只有 hash → md 一律重读（都很小，成本可忽略）。
         */
        const text = new TextDecoder().decode(bytes);
        if (stripTailSection(stripFrontmatter(text)).trim() === '') {
          emptyNotes.push(rel);
          continue; // 改走「还没写内容」，不进重复候选
        }
      }
      const hash = cachedHash ?? createHash('sha256').update(bytes).digest('hex');
      hashCache.set(abs, { ...st, hash });
      hashEntries.push({ rel, hash });
    } catch {
      // 读不到跳过（竞态）
    }
  }
  const groups = groupDuplicates(hashEntries);

  // ── ③ 未使用标签：非模板笔记的 tags 聚合 ──
  const tagNotes = deps.index
    .getAll()
    .filter((e) => !e.isTemplate)
    .map((e) => ({ path: e.path, tags: asList(e.props?.['tags']) }));
  const unusedTags = pickUnusedTags(tagNotes);

  const value: MaintenanceFindings = {
    orphans: { rels: orphans },
    dups: { groups },
    unusedTags,
    emptyNotes,
  };
  cache = { key, value };
  return value;
}
