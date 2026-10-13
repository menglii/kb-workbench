/**
 * services/routes.ts —— 库内**路由表**（`标签-目录映射.json`）的唯一读写口
 *
 * 这张表是 `关键词 → 目录` 与 `标签 → 目录` 的**唯一真源**（用户 2026-09-24 拍板，选项 A）：
 *   · 设置面板的「目录映射」栏就是它的编辑器（表格化 + 体检）
 *   · `T_智能新建`（Templater 脚本）读的也是同一路径、同一形状 —— **路径与文件名不许改**，
 *     改了这个脚本就断（它的 `MAP_PATH` 写死在源码里）
 *
 * ⚠️ **v2 口径（P7.12 · 2026-10-06「领域退役」）**：JSON 的键名 `领域` / `领域兜底`
 * **原样保留**（脚本契约），但语义从"「领域」属性值 → 目录"变成
 * **"关键词别名 → 目录"** —— 归位启发层（`services/suggest.ts` 的 `buildKeywordTable`）
 * 拿它当"文件名 / 正文提到这个词就按这条归位"的别名表用；`领域兜底` 还是
 * "没有任何信号"的最后一档落点。
 *
 * 两个口径（混了就搬错地方，P1 记过一次）：
 *   · **表里的值是库内绝对路径**（相对 vault 根，如 `01_新知识库/02_Areas/内容创作`）——
 *     与 `T_智能新建` 同一口径，别改
 *   · **插件内部一律用"相对库根"**（`02_Areas/内容创作`）——转换只在本文件里发生
 *
 * ⚠️ 写盘走 `vault.process` + `markSelfWrite`：真库的同步跑在同一进程里，
 * 裸写会跟它抢；不登记的话索引会把我们自己的写当成「外部改动」（首页多一条紫标）。
 */
import { TFile, type App } from 'obsidian';
import type { SettingsStore } from '../core/settings';
import { markSelfWrite } from '../core/writes';
import { isInside, parentDir, relativeTo } from '../core/paths';

// ────────────────────────────────────────────────────────────────
// 形状
// ────────────────────────────────────────────────────────────────
/**
 * 表本体。**除 `标签` / `领域` / `领域兜底` 之外的键原样保留**
 * （表里有 `_说明` / `_用法` 两段给人看的注释，编辑一次不能把它们弄丢）。
 * ⚠️ `领域` 这个键名是**脚本契约**（v2 起语义 = 关键词别名段），别改名。
 */
export interface RouteTable {
  标签: Record<string, string>;
  领域: Record<string, string>;
  领域兜底?: string;
  [k: string]: unknown;
}

/** 两个可编辑段（`领域兜底` 是单值，单独处理） */
export const ROUTE_SECTIONS = ['标签', '领域'] as const;
export type RouteSection = (typeof ROUTE_SECTIONS)[number];

export const SECTION_LABEL: Record<RouteSection, string> = {
  标签: '标签段（按标签归位 / 按标签新建用）',
  领域: '别名段（关键词 → 目录：文件名 / 正文提到它时按这条归位）',
};

/** 给表加注释键的顺序（写回时保持这个顺序，别把 `_说明` 挤到最后） */
const COMMENT_KEYS = ['_说明', '_用法', '_更新'];

// ────────────────────────────────────────────────────────────────
// 默认值
// ────────────────────────────────────────────────────────────────
/**
 * 表不存在时的默认表（**不是**真源的副本，只是"从零开始"的起点）。
 * 别名段给几个"目录末段名覆盖不到"的中文别名（目录末段名由归位启发层
 * 直接从目录树推，不需要写进表——见 `suggest.ts` 的 `buildKeywordTable`）。
 */
export function defaultRouteTable(kbRoot: string): RouteTable {
  const 领域: Record<string, string> = {};
  for (const [kw, dir] of Object.entries(ALIAS_STARTER)) {
    if (dir) 领域[kw] = vaultPathOf(dir, kbRoot);
  }
  return {
    _说明:
      '归档路由表。脚本按「标签段 → 领域段 → 领域兜底」的顺序命中第一条即生效。' +
      '目录值 = 相对库根的路径；改完保存即可，不用动脚本。' +
      '（2026-10 v2：「领域」属性已退役，领域段现在的语义是「关键词别名 → 目录」。）',
    _用法:
      '① 按标签新建：弹出「标签段」里的所有条目供选择；② 按标签归位：读当前笔记的 tags 去匹配' +
      '（领域段 = 关键词别名：文件名 / 正文提到它时按这条归位）。' +
      '本表的「标签」段键名对应笔记 frontmatter 的 tags 值。',
    标签: {
      收件箱: vaultPathOf('00_Inbox', kbRoot),
      Inbox: vaultPathOf('00_Inbox', kbRoot),
      项目: vaultPathOf('01_Projects', kbRoot),
      内容创作: vaultPathOf('02_Areas/内容创作', kbRoot),
      游戏研究: vaultPathOf('02_Areas/游戏研究', kbRoot),
      每日任务: vaultPathOf('02_Areas/每日任务', kbRoot),
      领域: vaultPathOf('02_Areas', kbRoot),
      资源: vaultPathOf('03_Resources', kbRoot),
      归档: vaultPathOf('04_Archives', kbRoot),
    },
    领域,
    领域兜底: vaultPathOf('02_Areas', kbRoot),
  };
}

/** 默认表里那几个"目录末段名推不出来"的中文别名 */
export const ALIAS_STARTER: Record<string, string> = {
  项目: '01_Projects',
  资源: '03_Resources',
  归档: '04_Archives',
  Meta: '99_Meta',
};

// ────────────────────────────────────────────────────────────────
// 路径口径转换（**只在本文件里发生**）
// ────────────────────────────────────────────────────────────────
/** 相对库根 → 库内绝对路径（写进表里的形状） */
export function vaultPathOf(dirRel: string, kbRoot: string): string {
  const d = String(dirRel ?? '').replace(/^\/+|\/+$/g, '');
  const root = String(kbRoot ?? '').replace(/^\/+|\/+$/g, '');
  if (!d) return root;
  if (!root) return d;
  return d === root || d.startsWith(`${root}/`) ? d : `${root}/${d}`;
}

/** 库内绝对路径 → 相对库根（表里可能是绝对、也可能是手写的相对，两种都认） */
export function dirRelOf(vaultPath: string, kbRoot: string): string {
  return relativeTo(String(vaultPath ?? '').replace(/^\/+|\/+$/g, ''), kbRoot);
}

// ────────────────────────────────────────────────────────────────
// 读 / 写
// ────────────────────────────────────────────────────────────────
export interface ReadResult {
  table: RouteTable;
  /** 库里有这个文件吗（false = 返回的是默认表，还没落盘） */
  exists: boolean;
  /** 读到了但解析失败（表坏了） */
  broken?: string;
}

/** 把任意来源的对象收敛成合法表（缺段补空、非字符串值丢弃、注释键原样留） */
export function normalizeRouteTable(raw: unknown): RouteTable {
  const out: RouteTable = { 标签: {}, 领域: {} };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of COMMENT_KEYS) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v;
  }
  for (const section of ROUTE_SECTIONS) {
    const sec = src[section];
    if (!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    const dst: Record<string, string> = {};
    for (const [k, v] of Object.entries(sec as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const key = k.trim();
      if (!key) continue;
      const dir = String(v).replace(/^\/+|\/+$/g, '').trim();
      if (!dir) continue; // 空串/全空白 = 这一条没填完，别当成"落到库根"
      dst[key] = dir;
    }
    out[section] = dst;
  }
  const fb = src['领域兜底'];
  if (typeof fb === 'string' && fb.trim()) out['领域兜底'] = fb.trim().replace(/^\/+|\/+$/g, '');
  return out;
}

export async function readRouteTable(app: App, settings: SettingsStore): Promise<ReadResult> {
  const path = settings.routeTablePath();
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) {
    return { table: defaultRouteTable(settings.kbRoot()), exists: false };
  }
  try {
    const text = await app.vault.cachedRead(f);
    // 空文件 / 全是空白 → 当"还没有内容"，给默认表但**不覆盖**（用户可能正在编辑）
    if (text.trim() === '') {
      return { table: defaultRouteTable(settings.kbRoot()), exists: true, broken: '文件是空的' };
    }
    return { table: normalizeRouteTable(JSON.parse(text)), exists: true };
  } catch (e) {
    return {
      table: defaultRouteTable(settings.kbRoot()),
      exists: true,
      broken: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 写回（**唯一写点**）。表里的注释键原样保留，但顺序按 `_说明 → _用法 → 标签 → 领域 → 领域兜底` 排 */
export async function writeRouteTable(
  app: App,
  settings: SettingsStore,
  table: RouteTable,
): Promise<void> {
  const path = settings.routeTablePath();
  const ordered: Record<string, unknown> = {};
  for (const key of COMMENT_KEYS) if (table[key] != null) ordered[key] = table[key];
  for (const section of ROUTE_SECTIONS) ordered[section] = table[section] ?? {};
  if (table['领域兜底']) ordered['领域兜底'] = table['领域兜底'];
  for (const [k, v] of Object.entries(table)) {
    if (k in ordered) continue;
    ordered[k] = v; // 用户自己加的其他段，别丢
  }
  const text = `${JSON.stringify(ordered, null, 2)}\n`;
  markSelfWrite(path);
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) {
    await app.vault.process(f, () => text);
    return;
  }
  const dir = parentDir(path);
  if (dir && !(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  markSelfWrite(path);
  await app.vault.create(path, text);
}

// ────────────────────────────────────────────────────────────────
// 查询
// ────────────────────────────────────────────────────────────────
/**
 * 别名段 → 相对库根的落点目录（归位的启发层查这个：
 * 文件名 / 正文提到某个别名词时，按这里的目录走）。
 * v2：不再有 `DEFAULT_AREA_DIRS` 铺底 —— 表就是唯一来源（目录末段名由启发层另推）。
 */
export function aliasDirs(table: RouteTable, kbRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kw, path] of Object.entries(table.领域 ?? {})) {
    out[kw] = dirRelOf(path, kbRoot);
  }
  return out;
}

/** 兜底目录（相对库根；表里没有就不返回）——"没有任何信号"的最后一档落点 */
export function fallbackDir(table: RouteTable, kbRoot: string): string | null {
  const p = table['领域兜底'];
  return typeof p === 'string' && p ? dirRelOf(p, kbRoot) : null;
}

/** 标签段：标签 → 相对库根的目录 */
export function tagDirs(table: RouteTable, kbRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag, path] of Object.entries(table.标签 ?? {})) out[tag] = dirRelOf(path, kbRoot);
  return out;
}

// ────────────────────────────────────────────────────────────────
// 体检
// ────────────────────────────────────────────────────────────────
export interface RouteIssue {
  level: 'error' | 'warn' | 'info';
  msg: string;
  section?: RouteSection;
  key?: string;
}

export interface CheckupOptions {
  /** 库内绝对路径存在吗（目录或文件都算） */
  exists: (vaultPath: string) => boolean;
  /** 当前库根（判"这个落点还在不在库根之下"） */
  kbRoot: string;
}

/**
 * 体检（`开发计划.md` §8 的「目录映射」栏）。
 * 三类（v2：值域检查随「领域」退役删除 —— 别名段的键现在是自由词）：
 *   ① 目录不存在（error）
 *   ② 落点不在当前库根之下（warn）
 *   ③ 重复落点（warn）—— 同一段里两个键指向同一个目录
 *   ④ 兜底目录没配 / 不存在
 */
export function checkRoutes(table: RouteTable, opts: CheckupOptions): RouteIssue[] {
  const out: RouteIssue[] = [];
  const { exists, kbRoot } = opts;

  for (const section of ROUTE_SECTIONS) {
    const sec = table[section] ?? {};
    const byDir = new Map<string, string[]>();
    for (const [key, path] of Object.entries(sec)) {
      if (!exists(path)) {
        out.push({
          level: 'error',
          section,
          key,
          msg: `「${key}」的落点目录不存在：${path}`,
        });
      } else if (kbRoot && !isInside(path, kbRoot)) {
        out.push({
          level: 'warn',
          section,
          key,
          msg: `「${key}」的落点不在当前库根（${kbRoot}）之下：${path}`,
        });
      }
      const list = byDir.get(path) ?? [];
      list.push(key);
      byDir.set(path, list);
    }
    for (const [dir, keys] of byDir) {
      if (keys.length > 1) {
        out.push({
          level: 'warn',
          section,
          msg: `重复落点：${keys.join(' / ')} 都指向 ${dir}`,
        });
      }
    }
  }

  const 兜底 = table['领域兜底'];
  if (!兜底) {
    out.push({ level: 'warn', msg: '没有配「兜底目录」—— 没有任何信号的笔记没有最后去处' });
  } else if (!exists(兜底)) {
    out.push({ level: 'error', msg: `「兜底目录」（领域兜底）不存在：${兜底}` });
  }

  return out;
}
