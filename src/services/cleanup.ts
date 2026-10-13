/**
 * services/cleanup.ts —— 退出清理的**只读扫描与计划**（`交互规格.md` §15 · P7.18 · D3）
 *
 * 给「设置 → 数据 → 退出插件前的清理」面板用：把插件往库里写过的东西分两类列出来，
 * **只读、可反复扫**（真写盘在面板那一条链上：确认流 → 快照 → 执行 → 报告 → 撤销）。
 *
 * 两类清单（`YAML优化方案.md` §3 · P7.18）：
 *   · **笔记键类**：六件套（类型/状态/文件位置/创建日期/tags/收藏）+ 控制字段
 *     （位置锁定/隐藏/来源）—— 逐键勾，删走 `ctx.fm.remove` 批量（守卫照旧：坏前言整篇跳过）。
 *   · **足迹类**：`99_Meta/06_工作台/`（配置）· `99_Meta/05_操作日志/`（日志）·
 *     `99_Meta/02_模板库/标签-目录映射.json`（路由表）· 模板库 `T_样例-*`
 *     （**默认不勾** —— 那是用户资产）。
 *
 * ⚠️ **口径限制**：「插件写过的键」**没法可靠归因**（没做溯源标记）→ 只能**按键名**勾选；
 * 预览里逐键写清"会从 N 篇里删掉这个键"（面板负责这句话，这里给计数与样例）。
 * ⚠️ **范围 = 知识笔记**：库根之下、**排除 `99_Meta`（含模板库）**——与存量补全**同一份口径**
 * （`backfill.inBackfillScope`，别在别处再造第三份）：03_AI指令集是红线文件、
 * 模板文件的 YAML 是"双身份"（改了会改产出，P7.12 坑单）、日志/仪表盘是结构文件。
 * 工具区（`99_Meta`）的痕迹归**足迹类**清。
 * ⚠️ **不删任何非插件产物**：足迹目录里认不出的文件（如 `skills/`）不列不动，
 * 面板只说明"另有 N 项是别的东西"。
 */
import { TFile } from 'obsidian';
import type { NoteEntry } from '../core/vault-index';
import { relativeTo } from '../core/paths';
import { CONFIGS } from '../core/config-files';
import { fragileKeys } from './schema';
import { inBackfillScope } from './backfill';
/**
 * ⚠️ 唯一的 `services/ → core/context` 依赖，而且是 **type-only**（编译后整段消失，不会成环）——
 * 与 `services/backfill.ts` 的同名口同一条理由：面板与（将来的）其它入口必须报同一个数。
 */
import type { WorkbenchContext } from '../core/context';

/**
 * **笔记键类的清单**（顺序 = 面板里的显示顺序）：六件套 + 三控制字段。
 * ⚠️ 与 `schema.ts` 的 `SPECS` **有意分开**：那张表管"值域与行为语义"，
 * 这一份管"退出时要清哪几个键"——将来 schema 加新键时**要来这里想一下**要不要进清理清单
 * （redline 有一条静态判据盯着两者别悄悄漂）。
 */
export const CLEANUP_KEYS = [
  '类型',
  '状态',
  '文件位置',
  '创建日期',
  'tags',
  '收藏',
  '位置锁定',
  '隐藏',
  '来源',
] as const;

/** 认得出的日志文件名（report.ts 的 `uniquePath` 产物：`日志-20260924-122600-动作.md`） */
const LOG_NAME_RE = /^日志-\d{8}-\d{6}-.*\.md$/;

/** 主键类：一个键的扫描结果 */
export interface CleanupKeyRow {
  key: string;
  /** **会从这个键被删掉的**篇数（坏前言篇整篇跳过、**不计**） */
  count: number;
  /** 样例（basename，最多 3 个；面板行里"如：A、B、C…"） */
  samples: string[];
}

/** 足迹里的一个文件（执行时面板按 `path` 现取节点） */
export interface CleanupFile {
  path: string;
  name: string;
  bytes: number;
}

/** 足迹类：一个可清的项 */
export interface CleanupFootprint {
  id: 'workbench' | 'logs' | 'route' | 'samples';
  /** 面板行里的大字（如「工作台配置」） */
  label: string;
  /** 库内绝对路径（执行用） */
  path: string;
  /** 相对库根（展示用；`99_Meta/06_工作台`） */
  rel: string;
  /** 目录（清完可能要摘壳）/ 单个文件 */
  kind: 'dir' | 'file';
  /** **认得出的、会被删的**文件（空数组 = 这一项现在没有可清的 → 不进清单） */
  files: CleanupFile[];
  totalBytes: number;
  /** 目录里**认不出的**项（如 `skills/`）——不列不动，只说明 */
  others: string[];
  /** 行里那句说明 */
  note?: string;
}

export interface CleanupPlan {
  /** 只含 count > 0 的键 */
  keys: CleanupKeyRow[];
  /** 只含 files.length > 0 的足迹项 */
  footprints: CleanupFootprint[];
  /** 坏前言篇（**整篇跳过**——删键也过守卫；去「修前言」） */
  fragile: { path: string; basename: string; why: string }[];
  /** 扫过的知识笔记篇数 */
  scanned: number;
}

/** 扫描输入：库根口径 + 文件系统现况（照 `planBackfill` 的纯函数分工） */
export interface CleanupFsView {
  /** 展示相对路径用（`rel` 只是给人看的；执行一律走绝对 `path`） */
  kbRoot: string;
  workbenchDir: string;
  logDir: string;
  routeFile: string;
  templateDir: string;
  /** 目录 → 列目录结果（key = 库内绝对路径；不存在给空） */
  dirs: Record<string, { files: string[]; folders: string[] }>;
  /** 库内绝对路径 → 字节数（查不到给 0） */
  fileSizes: Record<string, number>;
}

/** 纯函数：算计划。**不改任何东西**（幂等：清完再扫 = 全空） */
export function planCleanup(
  entries: NoteEntry[],
  scope: { kbRoot: string; metaRoot: string; templateDir: string },
  fs: CleanupFsView,
): CleanupPlan {
  const hits = new Map<string, { path: string; basename: string }[]>(
    CLEANUP_KEYS.map((k) => [k, []]),
  );
  const fragile: CleanupPlan['fragile'] = [];
  let scanned = 0;
  for (const e of entries) {
    if (!inBackfillScope(e, scope)) continue;
    scanned += 1;
    const bad = fragileKeys(e.props);
    if (bad.length > 0) {
      fragile.push({ path: e.path, basename: e.basename, why: `前言里有嵌套值（${bad.join('、')}）` });
      continue; // 整篇跳过：这些篇的键**不计进计数**（写了也会被守卫拦下）
    }
    for (const k of CLEANUP_KEYS) {
      /**
       * **键存在就计数**（值空也算）——`状态:` 这样的空值键也是插件写下的行，
       * 删它本身安全（往返安全，P7.13a 已钉）；面板会点名这个形状。
       */
      if (Object.prototype.hasOwnProperty.call(e.props, k)) hits.get(k)!.push(e);
    }
  }
  const keys: CleanupKeyRow[] = [];
  for (const k of CLEANUP_KEYS) {
    const list = hits.get(k)!;
    if (list.length === 0) continue;
    keys.push({ key: k, count: list.length, samples: list.slice(0, 3).map((x) => x.basename) });
  }
  return { keys, footprints: footprintRows(fs), fragile, scanned };
}

/**
 * **执行时的现算**（"看了预览、写的是别的"防护 —— 照 `backfill-panel.run()` 的同一条）：
 * 勾中的键 → 每篇**实际要删**的键（路径 → 键数组；一篇一次 `fm.remove` 原子写）。
 * 坏前言篇不在内（写了也会被守卫拦下）；范围与扫描同一份（`inBackfillScope`）。
 */
export function planKeyWrites(
  entries: NoteEntry[],
  scope: { kbRoot: string; metaRoot: string; templateDir: string },
  keys: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    if (!inBackfillScope(e, scope)) continue;
    if (fragileKeys(e.props).length > 0) continue;
    const hit = keys.filter((k) => Object.prototype.hasOwnProperty.call(e.props, k));
    if (hit.length > 0) out.set(e.path, hit);
  }
  return out;
}

/** 足迹四件（认得出的才列；认不出的只记名字） */
function footprintRows(fs: CleanupFsView): CleanupFootprint[] {
  const out: CleanupFootprint[] = [];
  const nameOf = (p: string): string => p.split('/').pop() ?? p;
  const fileOf = (p: string): CleanupFile => ({
    path: p,
    name: nameOf(p),
    bytes: fs.fileSizes[p] ?? 0,
  });
  const sum = (files: CleanupFile[]): number => files.reduce((a, f) => a + f.bytes, 0);

  // ① 工作台配置：**只认 CONFIGS 里的三个文件名**（认不出的留给用户）
  {
    const known = new Set(Object.values(CONFIGS).map((c) => c.file));
    const listing = fs.dirs[fs.workbenchDir] ?? { files: [], folders: [] };
    const files = listing.files.filter((p) => known.has(nameOf(p))).map(fileOf);
    const others = [
      ...listing.files.filter((p) => !known.has(nameOf(p))).map(nameOf),
      ...listing.folders.map(nameOf),
    ];
    if (files.length > 0) {
      out.push({
        id: 'workbench',
        label: '工作台配置',
        path: fs.workbenchDir,
        rel: relativeTo(fs.workbenchDir, fs.kbRoot),
        kind: 'dir',
        files,
        totalBytes: sum(files),
        others,
        note: '自动化 / 看板 / 库结构三个配置（跟着库走的那份）',
      });
    }
  }
  // ② 操作日志
  {
    const listing = fs.dirs[fs.logDir] ?? { files: [], folders: [] };
    const files = listing.files.filter((p) => LOG_NAME_RE.test(nameOf(p))).map(fileOf);
    const others = [
      ...listing.files.filter((p) => !LOG_NAME_RE.test(nameOf(p))).map(nameOf),
      ...listing.folders.map(nameOf),
    ];
    if (files.length > 0) {
      out.push({
        id: 'logs',
        label: '操作日志',
        path: fs.logDir,
        rel: relativeTo(fs.logDir, fs.kbRoot),
        kind: 'dir',
        files,
        totalBytes: sum(files),
        others,
        note: '插件每次动库留下的流水（只认「日志-日期-时间-动作」这种命名）',
      });
    }
  }
  // ③ 路由表（单文件）
  {
    const p = fs.routeFile;
    if ((fs.fileSizes[p] ?? -1) >= 0) {
      const f = fileOf(p);
      out.push({
        id: 'route',
        label: '标签-目录映射',
        path: p,
        rel: relativeTo(p, fs.kbRoot),
        kind: 'file',
        files: [f],
        totalBytes: f.bytes,
        others: [],
        note: '自动化查的那张表（标签 → 目录）',
      });
    }
  }
  // ④ 样例模板（用户资产：默认不勾）
  {
    const listing = fs.dirs[fs.templateDir] ?? { files: [], folders: [] };
    const files = listing.files.filter((p) => nameOf(p).startsWith('T_样例')).map(fileOf);
    if (files.length > 0) {
      out.push({
        id: 'samples',
        label: '样例模板 T_样例-*',
        path: fs.templateDir,
        rel: relativeTo(fs.templateDir, fs.kbRoot),
        kind: 'dir',
        files,
        totalBytes: sum(files),
        others: [],
        note: '示范用的模板 —— 是你的资产，默认不勾',
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 组装侧（读真库现算 —— 照 `planBackfillOf` 的同一分工）
// ────────────────────────────────────────────────────────────────

/**
 * **按当前库拼输入 + 扫描**。只读：读索引、列三个目录、查几个节点，一个字节都不写。
 * 面板「重新扫描」与执行完的自动重扫都走它（幂等靠它兜）。
 */
export async function planCleanupOf(ctx: WorkbenchContext): Promise<CleanupPlan> {
  const app = ctx.app;
  const workbenchDir = ctx.settings.workbenchDir();
  const logDir = ctx.settings.logDir();
  const routeFile = ctx.settings.routeTablePath();
  const templateDir = ctx.settings.templateDir();

  const listOf = async (dir: string): Promise<{ files: string[]; folders: string[] }> => {
    try {
      if (!(await app.vault.adapter.exists(dir))) return { files: [], folders: [] };
      const l = await app.vault.adapter.list(dir);
      return { files: l.files ?? [], folders: l.folders ?? [] };
    } catch {
      return { files: [], folders: [] };
    }
  };
  const [wb, lg, tp] = await Promise.all([listOf(workbenchDir), listOf(logDir), listOf(templateDir)]);
  const dirs: CleanupFsView['dirs'] = {
    [workbenchDir]: wb,
    [logDir]: lg,
    [templateDir]: tp,
  };
  const fileSizes: CleanupFsView['fileSizes'] = {};
  const noteSize = (p: string): void => {
    const f = app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) fileSizes[p] = f.stat?.size ?? 0;
  };
  noteSize(routeFile);
  for (const l of [wb, lg, tp]) for (const p of l.files) noteSize(p);

  return planCleanup(
    ctx.index.getAll(),
    {
      kbRoot: ctx.settings.kbRoot(),
      metaRoot: ctx.settings.metaRoot(),
      templateDir,
    },
    { kbRoot: ctx.settings.kbRoot(), workbenchDir, logDir, routeFile, templateDir, dirs, fileSizes },
  );
}
