/**
 * services/mover.ts —— 移动 / 重命名的**唯一出口**（三条架构硬规矩之一）
 *
 * 旧实现里散在多处的 `handleManualMove` 是 bug 温床，所以这里把整条链收进一个函数：
 *
 *   快照 → 撞名自查 → 捕获旧路径 → renameFile → 属性跟随 → 写日志 → 返回撤销句柄
 *
 * 四条来自 P-1 实测的约束（都不是推测）：
 *  ① **撞名自查不是"防覆盖"** —— S2 实测平台自己会抛 `Destination file already exists!`
 *     拦住且不覆盖。自查的真正理由是三条：区分「已搬过（内容相同）」和「真冲突」、
 *     逐篇 skip 不中断整批、以及不拿平台文案做逻辑判断。
 *  ② **双链是平台同步自动改的**（`renameFile` 返回那一刻已完成）→ 不写修复逻辑；
 *     但**必须在 rename 之前**用 `metadataCache.resolvedLinks` 反查引用者、存进快照
 *     （事后拿不到原文），作为 `MoveResult.touched` 返回。
 *  ③ **`renameFile` 就地改 `file.path`** → 旧路径必须在调用前抄下来。
 *  ④ **目标目录不存在会抛 ENOENT** → 先 `mkdir`（S3 实测一次能建多级）。
 */
import { TFile, type App } from 'obsidian';
import { SettingsStore } from '../core/settings';
import { joinPath, parentDir, relativeTo } from '../core/paths';
import { markSelfWrite, markSelfWritePair } from '../core/writes';
import { ROOT_POS, asList, declaredPositions, fragileKeys, isPositionLocked } from './schema';
import type { FrontmatterService } from './frontmatter';
import type { ReportService } from './report';
import type { SnapshotService } from './snapshot';
import { NOTIFY_MS, notify, notifyError, notifyPartial, type NoticeAction } from '../ui/notify';

/**
 * 操作来源（写进操作日志，§7.7 的「按来源筛」靠它）。
 * P3 加了 `'template'`（模板库的删除也走 mover —— 三条硬规矩是"**动文件**只能过 mover"，
 * 删除同样是动文件）。
 */
/**
 * 谁发起的这次移动（写进操作日志的来源；「学过往」也只学其中几个手动来源）。
 *
 * ⚠️ v2（P7.12 · #12）：mover 里原先那条
 * `req.source === 'reconcile' && isPositionLocked(...)` 的跳过**已删除** ——
 * 自动归位唯一的触发就是"用户显式改「文件位置」"（显式=手动语义），
 * 与菜单那几条（`'menu'`：R8 的「重命名」）同一待遇：**位置锁定不拦**。
 */
export type MoveSource =
  | 'drag'
  | 'batch'
  | 'ai'
  | 'board'
  | 'rebuild'
  | 'reconcile'
  | 'menu'
  | 'template'
  /** P7.6：整理建议面板里确认过的搬动（用户勾选 → 确认流 → 这里） */
  | 'suggest'
  /**
   * P7.13b：**首页待处理的 ①/② 动作**（重复文件保一份 → 回收站；孤儿附件 → 挪待清理）。
   * ⚠️ **不在 `LEARN_SOURCES` 里**（有意的）：这两条搬的都不是"笔记该住哪"的偏好
   * —— 孤儿附件挪去 `05_待清理` 若被学进去，会教出"某某目录 → 05_待清理"这种垃圾习惯。
   */
  | 'todo';

/** ⚠️ 支持多目标：P5 要把 43 篇分送到不同目录 */
export interface MoveTarget {
  dir?: string;
  /** 仅单文件时可用 */
  newName?: string;
  files: TFile[];
}

export interface MoveRequest {
  /** 一次操作 = 一个快照 = 一个撤销句柄 */
  targets: MoveTarget[];
  source: MoveSource;
  reason: string;
  /**
   * **额外写进操作日志的几行**（可选）。
   * P5 的重排用它记"新建 N 个目录 / 待定 N 篇"这类**不属于移动本身**的事实 ——
   * 不这么开一个口子的话，要么日志里缺一块（用户事后看报告不知道建了哪些目录），
   * 要么调用方再写第二条日志（同一次操作两条记录，比缺一块更糟）。
   */
  extraRows?: { label: string; detail?: string }[];
  /**
   * **本次操作还要建这些目录**（P5 重排：骨架里缺的那些 —— 里面不一定马上就有文件搬进去）。
   *
   * ⚠️ 为什么必须过 mover，而不是调用方自己 `adapter.mkdir`：
   * "本次新建的目录"是**快照的第 ③ 项**（`CaptureSpec.newDirs`），还原时"删掉本次新建的目录"
   * 全靠它。调用方自己建 = 那批目录不进 mover 的快照 → **还不了原**（库里留一副空骨架）；
   * 想补的话又得再拍一张快照 —— 那就成了同一次操作两张快照，撤销条只认最后一张。
   */
  extraDirs?: string[];
  /**
   * **本次操作还要新建这些文件**（内容随请求带上；P7.2b 初始化模式的种子页 / 示例数据）。
   *
   * ⚠️ 与 `extraDirs` 同一条理由必须过 mover：**"本次新建的文件"是快照的
   * `newFiles` 项**，还原时"删掉本次新建的文件"全靠它。直接 `vault.create` 的话
   * ——不进快照 → **还不了原**（P5 的 extraDirs 教训换个形态复发：库里留一堆种子页，还原只能删目录）。
   *
   * 路径是 **库内绝对路径**（与 `targets` 同口径）；**父目录不在时会一并建**
   * （与移动目标同一条 missingAncestors 链）；目标已存在 → 跳过不动（幂等，
   * 第二次执行 = 盘上零变化）。
   */
  extraFiles?: { path: string; content: string }[];
  /**
   * **调用方要给这条通知再挂几个动作**（P7.11 · #13 加）。
   *
   * 为什么开这个口子：一键整理的"部分搬成"（撞名 / 跳过）通知由 **mover 这一层弹**
   *（`partial` 支必须留 —— §9 的契约点），而"给搬不动的出落点建议"那枚 ✦ 按钮
   * 是**首页域**的东西（开整理建议面板）—— mover 不该认识它。调用方把动作传进来，
   * 这里只负责挂上（与 `extraRows` 同一条"别让调用方另发一条通知"的纪律）。
   * ⚠️ 只挂在**弹得出来的两支**（partial / 非 quiet 的成功支）—— quiet 压掉的那支
   * 没有通知可挂，传了也是无声的（调用方自己清楚这条）。
   */
  extraActions?: NoticeAction[];
  /**
   * **这一趟由调用方自己报**（它紧接着弹撤销条，`ui/undo-move.ts`）→
   * **纯成功的汇总通知不弹**（P7.0a 批 1⑦：原先顶部通知与撤销条播同一件事，
   * 用户截图里「已移动 1 篇笔记」两处同时出现）。
   *
   * ⚠️ 只压"成功"那一支，别的照旧弹：
   *  · **partial（撞名冲突 / 跳过）必须留** ——「被跳过的要说出来」是 §9 的契约点，
   *    而撤销条只报"已移动 N 篇"，不承载它；
   *  · 「本来就在目标位置」那条也留（那时 `moved` 为空 → 撤销条根本不出现）；
   *  · **建了目录 / 文件也算"有可见回执"**（重排面板三个档只要落了快照就弹撤销条 ——
   *    初始化档 `movedN=0` 也有条，所以这类**同样压**；P7.2b 独立审查 🟡3 订正了
   *    原来"只认 movedN"的口径）。
   *  · ⚠️ **"已搬过（内容相同）N 篇"的计数会跟着成功通知一起被静默**（独立审查 🟡3 点过）：
   *    它住在那条通知的 detail 里，quiet 时只剩撤销条的"已移动 N 篇"。**这是接受的行为**
   *    （目标状态已达成、操作日志里查得到），记在这儿免得以后被当 bug 查。
   */
  quiet?: true;
}

export type SkipWhy = 'collision' | 'notfound' | 'locked' | 'invalid';

export interface MoveResult {
  moved: { path: string; from: string; to: string }[];
  skipped: { path: string; why: SkipWhy; note?: string }[];
  /** 「已搬过」：撞名且内容相同 → 静默跳过（幂等的第 2 条机制） */
  already: { path: string }[];
  /** 撞名且内容不同 = 真冲突 */
  blocked: { path: string; why: 'content-conflict'; note?: string }[];
  /** 被平台改掉双链的**其他文件**（不在 targets.files 里） */
  touched: { path: string }[];
  /** 本次**真建出来**的目录（含 `extraDirs` 与"目标目录缺失"两种来源） */
  newDirs: string[];
  /** 本次**真建出来**的文件（`extraFiles` 里"原来不存在"的那几个；已存在的不算） */
  newFiles: { path: string }[];
  snapshotId: string;
  /** 扩展：快照失败等硬错误（此时 moved 为空，什么都没动） */
  error?: string;
}

interface PlanEntry {
  file: TFile;
  from: string;
  to: string;
}

/**
 * **搬完之后的那一通回话**（P7.6）：只报事实，听不听由回调方决定 ——
 * 「学你过往的修正」（`suggest-learned`）是它的第一个消费者（main.ts 装配）。
 *
 * ⚠️ `tagsOf` 是**搬运前**那份标签的快照（计划期就抓好）：搬完再按路径读就晚了
 *（旧路径已经没了），而标签不随搬动改变，抓早不抓晚。
 * ⚠️ 回调放在**成功收尾之后**、用 try/catch 包着：学习出问题不许影响已完成的搬动。
 */
export interface MovedCall {
  moved: { from: string; to: string }[];
  source: MoveSource;
  tagsOf: (fromPath: string) => string[];
}

/**
 * 用户给的新名字 → **落盘文件名**（含扩展名；不含目录）。
 *
 * 🔴 **只去掉"用户顺手带上的原扩展名"，名字里本来就有的点一个都不许动**。
 * 原来这里用的是 `stripExt()`（切掉最后一个 `.xxx`）—— 那个函数对**路径**是对的
 *（`templates.ts` 生成 `[[双链]]` 就该那么切），对**用户手打的名字**是错的：
 * 把 `9.16.md` 改名成 `9.16-改`，`stripExt` 会把 `.16-改` 当扩展名切掉、
 * 剩 `9` → 文件**静默**变成 `9.md`（真数据、真改名，全程不报错）。
 * P6 的网格用例逮到的就是这个（夹具里恰好有一篇 `9.16.md`）——
 * 只有名字**带点**的时候才现形，所以一直在那儿。
 *
 * ⚠️ P7.8 从 `Mover.move` 里抽出来（**唯一一份**）：改名执行的落点与
 * 「AI 起标题」确认流的预览必须同源 —— 预览自己写一份清洗，两边迟早漂。
 */
export function cleanNewName(from: string, typed: string): string {
  const ext = from.match(/\.[^.]+$/)?.[0] ?? '.md';
  let base = typed;
  if (base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
  base = base.replace(/[\\/:*?"<>|]/g, '');
  return base + ext;
}

export class Mover {
  private app: App;
  private settings: SettingsStore;
  private fm: FrontmatterService;
  private snapshot: SnapshotService;
  private report: ReportService;
  /** 可选回调（装配处：main.ts）—— 缺席时零开销 */
  private onMoved: ((info: MovedCall) => void) | undefined;

  constructor(
    app: App,
    settings: SettingsStore,
    fm: FrontmatterService,
    snapshot: SnapshotService,
    report: ReportService,
    onMoved?: (info: MovedCall) => void,
  ) {
    this.app = app;
    this.settings = settings;
    this.fm = fm;
    this.snapshot = snapshot;
    this.report = report;
    this.onMoved = onMoved;
  }

  async move(req: MoveRequest): Promise<MoveResult> {
    const result: MoveResult = {
      moved: [],
      skipped: [],
      already: [],
      blocked: [],
      touched: [],
      newDirs: [],
      newFiles: [],
      snapshotId: '',
    };

    // ── 1. 展开计划（不碰任何文件）─────────────────────────────
    const plan: PlanEntry[] = [];
    const seen = new Set<string>();
    for (const target of req.targets) {
      const dir = target.dir != null ? target.dir.replace(/^\/+|\/+$/g, '') : undefined;
      for (const file of target.files) {
        if (!file) continue;
        const from = file.path; // ③ renameFile 会就地改 file.path，先抄下来
        if (seen.has(from)) continue;
        seen.add(from);
        let to: string;
        if (target.newName && target.files.length === 1) {
          to = joinPath(dir ?? parentDir(from), cleanNewName(from, target.newName));
        } else if (dir != null) {
          to = joinPath(dir, from.split('/').pop() ?? from);
        } else {
          result.skipped.push({ path: from, why: 'invalid', note: '既没给目录也没给新名字' });
          continue;
        }
        plan.push({ file, from, to });
      }
    }

    // ── 2. 撞名自查 + 收集要建的目录（只读）────────────────────
    const toCreate = new Set<string>();
    // 先收**调用方点名要建的**（P5 重排的骨架：里面不一定马上就有文件搬进去）
    for (const want of req.extraDirs ?? []) {
      const dir = String(want ?? '').replace(/^\/+|\/+$/g, '');
      if (!dir) continue;
      for (const missing of await this.missingAncestors(dir)) toCreate.add(missing);
    }
    const dirFailures: string[] = [];
    const finalPlan: PlanEntry[] = [];
    for (const entry of plan) {
      const { file, from, to } = entry;
      if (from === to) {
        // S2 实测：改到同一路径不抛，是 no-op → 当幂等处理
        result.already.push({ path: from });
        continue;
      }
      /**
       * ⚠️ v2（P7.12 · #12）：这里原先有一条 `source === 'reconcile' && isPositionLocked`
       * 的跳过 —— 拍定"显式改 = 直接搬（位置锁定不拦，显式=手动语义）"后**已删除**。
       * 详见 `MoveSource` 的注释与 `services/reconcile.ts` 的文件头。
       */
      const existing = this.app.vault.getAbstractFileByPath(to);
      if (existing && existing.path !== from) {
        let same = false;
        try {
          const [a, b] = await Promise.all([
            this.app.vault.read(file),
            existing instanceof TFile ? this.app.vault.read(existing) : Promise.resolve(null),
          ]);
          same = b != null && a === b;
        } catch {
          same = false;
        }
        if (same) {
          // 已搬过：幂等的第 2 条机制
          result.already.push({ path: from });
        } else {
          result.blocked.push({
            path: from,
            why: 'content-conflict',
            note: `目标已有 ${to}，内容不同`,
          });
        }
        continue;
      }
      // 记下**所有**要新建的目录（含中间层）：还原时"删掉本次新建的目录"
      // 才知道该删哪几层，而不是只删最里面那一层、把空壳留在库里
      for (const missing of await this.missingAncestors(parentDir(to))) toCreate.add(missing);
      finalPlan.push(entry);
    }

    /**
     * **本次要新建的文件**（`extraFiles`，P7.2b 的种子页 / 示例数据）：归一化（去空、去重），
     * 已存在的**静默跳过**（幂等：第二次执行 = 盘上零变化）。
     *
     * 🔴 **"已存在"要认"将被搬空的路径"**（P7.2b 收拢实测抓到的真缺陷）：
     * 收拢会把老 `00_Inbox/_收件箱.md` 收进归集夹，而初始化又想在同名位置建新种子 ——
     * 判定必须发生在**计划层面**：这个路径是 `finalPlan` 里某条的 **from**（马上要空出来）
     * 就不算"已存在"（照建；真正的创建排在改名之后 —— 见 6.5，那时它已经空出来了）。
     * 不这么认的话：老种子被收走、新种子被"幂等"静默跳过 → 原位反而空了。
     *
     * ⚠️ 与移动目标同一条"父目录缺失一并建"的链 —— 种子页的父目录可能不在
     * `extraDirs` 里（骨架清单允许只列种子不列子目录，normalize 会补，
     * 但 mover 不假设调用方已经补过）。
     */
    const vacated = new Set(finalPlan.map((e) => e.from));
    const extraFilePlan: { path: string; content: string }[] = [];
    const extraSeen = new Set<string>();
    for (const f of req.extraFiles ?? []) {
      const path = String(f?.path ?? '').replace(/^\/+|\/+$/g, '');
      if (!path || extraSeen.has(path)) continue;
      extraSeen.add(path);
      if (this.app.vault.getAbstractFileByPath(path) && !vacated.has(path)) continue; // 已存在 → 幂等跳过
      extraFilePlan.push({ path, content: String(f?.content ?? '') });
    }
    // 新建文件的父目录也进"要建"清单（快照的 newDirs / 还原删空目录都靠它）
    for (const f of extraFilePlan) {
      for (const missing of await this.missingAncestors(parentDir(f.path))) toCreate.add(missing);
    }

    // 没有文件要动、也没有目录/文件要建 → 真的没事可做（收尾只写日志）
    if (finalPlan.length === 0 && toCreate.size === 0 && extraFilePlan.length === 0) {
      this.finish(req, result);
      return result;
    }

    /**
     * **搬运前的标签快照**（P7.6 · onMoved 的唯一数据来源）：只给"真的要搬"的抓，
     * 且只在回调在的时候抓。抓在这里 = 改名循环之前（旧路径还都有效）。
     */
    const tagsAtPlan = new Map<string, string[]>();
    if (this.onMoved) {
      for (const e of finalPlan) {
        try {
          tagsAtPlan.set(e.from, asList(this.fm.props(e.file)['tags']));
        } catch {
          tagsAtPlan.set(e.from, []);
        }
      }
    }

    // ── 3. 反查引用者（**必须在 rename 之前**；双链由平台同步改）──
    const oldPaths = new Set(finalPlan.map((e) => e.from));
    const touched = this.reverseLinkSources(oldPaths);
    result.touched = Array.from(touched).map((path) => ({ path }));
    // 平台在 rename 时会改写这些文件的双链 —— 那是**我们这次操作造成的写**，
    // 必须先登记，否则它们会被判成「外部改动」（紫 ⚠ + 首页多一条待处理），
    // 而且还原时会被"别处改过就不写回"那道守卫挡住（双链就回不去了）
    for (const p of touched) markSelfWrite(p);

    // ── 4. 快照（失败即停：安全论证建立在"操作前一定有完整快照"上）──
    let snapshotId: string;
    try {
      const manifest = await this.snapshot.capture({
        reason: req.reason,
        files: finalPlan.map((e) => e.file),
        extraContents: Array.from(touched),
        moves: finalPlan.map((e) => ({ from: e.from, to: e.to })),
        newDirs: Array.from(toCreate),
        // 「本次新建的文件」进快照 —— 还原"删掉本次新建的文件"全靠它（P7.2b）
        newFiles: extraFilePlan.map((f) => f.path),
      });
      snapshotId = manifest.id;
      result.snapshotId = snapshotId;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      notifyError('操作已中止：快照没能写成', result.error);
      await this.report.log({
        action: '中止',
        result: 'error',
        source: req.source,
        // 中止的那一次也要能看出"是 AI 提的"：失败记录里丢掉这个信息，
        // 事后回看就分不清"AI 总在提同一批烂建议"与"用户在反复手搬同一批"
        ai: req.source === 'ai',
        summary: `快照失败，未动任何文件：${result.error}`,
        rows: finalPlan.map((x) => ({ label: `${x.from} → ${x.to}` })),
      });
      return result;
    }

    // ── 5. 建目录（多级一次可建，S3 已验）──────────────────────
    for (const dir of toCreate) {
      try {
        await this.app.vault.adapter.mkdir(dir);
        result.newDirs.push(dir);
      } catch (e) {
        // ⚠️ 这里塞进 skipped 的是**目录**，而 skipped 在契约里是"文件"、
        // 下游会算成"跳过 N 篇"。所以单独记，不混进文件计数（独立审查指出）。
        dirFailures.push(`目录建不出来：${dir} —— ${String(e)}`);
      }
    }

    // 建目录失败：单独记（它们是目录，不能混进"跳过 N 篇"的文件计数）
    for (const d of dirFailures) {
      result.skipped.push({ path: d, why: 'notfound', note: '目录建不出来（不计入篇数）' });
    }

    // ── 6. 执行（逐篇 skip，不中断整批）─────────────────────────
    for (const entry of finalPlan) {
      if (toCreate.has(parentDir(entry.to)) && !(await this.app.vault.adapter.exists(parentDir(entry.to)))) {
        result.skipped.push({ path: entry.from, why: 'notfound', note: '目标目录不存在' });
        continue;
      }
      const current = this.app.vault.getAbstractFileByPath(entry.from);
      if (!current) {
        result.skipped.push({ path: entry.from, why: 'notfound', note: '源文件不在' });
        continue;
      }
      markSelfWritePair(entry.from, entry.to);
      try {
        await this.app.fileManager.renameFile(current, entry.to);
        result.moved.push({ path: entry.to, from: entry.from, to: entry.to });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.skipped.push({
          path: entry.from,
          why: /exist/i.test(msg) ? 'collision' : 'notfound',
          note: msg,
        });
      }
    }

    // ── 6.5 建文件（种子页 / 示例数据）——**排在改名之后** 🔴
    //   顺序是"被搬空的路径"能落新文件的关键：收拢把老 `_收件箱.md` 搬进归集夹、
    //   这里再在原位建新种子（改名之前建会撞名抛错；判定"已存在"要认 vacated，
    //   见上面 extraFilePlan 的注释）。父目录在第 5 步已建好。
    for (const f of extraFilePlan) {
      const parent = parentDir(f.path);
      if (parent && !(await this.app.vault.adapter.exists(parent))) {
        result.skipped.push({
          path: f.path,
          why: 'notfound',
          note: '父目录不存在（没建出来），文件没建',
        });
        continue;
      }
      try {
        markSelfWrite(f.path);
        await this.app.vault.create(f.path, f.content);
        result.newFiles.push({ path: f.path });
      } catch (e) {
        result.skipped.push({
          path: f.path,
          why: 'invalid',
          note: `新建失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // ── 7. 属性跟随（**P7.18b：未声明的也写** —— 口径收敛成一条）────
    // 显式操作搬家时，让「文件位置」跟着走：它是"这篇该在哪"的声明，
    // 而**显式搬动就是改主意**。不跟的话每搬一次就留一个「位置不一致」警告，
    // 那正是"别处偷偷搬走"才该报的错。
    // 🔴 **P7.18b（用户 2026-10-09 真机反馈拍板）**：**"从没声明过"的也写**（= 新落点；库根写 `.`）——
    // 旧口径"留空的保持留空"已废：文件被搬动过却"没声明"，在用户眼里就是"位置属性丢了/没跟上"
    //（"把值叉掉 + 拖拽"场景的负反馈原话："通过拖动文件的方式改变文件位置，也不会把位置属性补回来"）。
    // 口径由此统一：**任何搬动之后，「文件位置」= 实际落点**（拖拽 / 批量迁移 / 看板拖卡 / AI 搬动
    // 全走这一处）。想"不让它被自动搬"的语义归「位置锁定」；想清空值的仍可手删（删完不被搬就不回写）。
    for (const moved of result.moved) {
      try {
        const file = this.app.vault.getAbstractFileByPath(moved.to);
        if (!(file instanceof TFile)) continue;
        /**
         * 🔴 **附件没有前言**（P7.18b 独立审 🔴1）：非 `.md`（收拢 / 目录改名 / 孤儿挪待清理链
         * 会把附件也搬过来）**一律不碰** —— `processFrontMatter` 对二进制文件是灾难
         *（会把「YAML 头 + UTF-8 乱码正文」写回去）。守卫与 `rebuild.ts` 的 collect 那条同款。
         */
        if (!moved.to.toLowerCase().endsWith('.md')) continue;
        const props = this.fm.props(file);
        const declared = declaredPositions(props);
        /**
         * 🔴 **纯改名（同目录）不算"搬动"**（P7.18b 独立审 🔴2）：旧口径下未声明的改名不写；
         * 若跟着 A 一起写，Inbox 里改过名（或 AI 起过标题）的笔记会**凭空获得"已声明"戳** ——
         * 而"有哪些声明 = 用户表过态"是「一键整理收件箱」兜底与 AI 分诊的判据 →
         * 一整条整理链对它永久失效（首页还挂着"N 篇待整理"、动作却 0 篇）。
         */
        if (declared.length === 0 && parentDir(moved.from) === parentDir(moved.to)) continue;
        /**
         * 未声明 + **坏前言**（嵌套映射）：本来就不该写（写口守卫会整篇拦下）——
         * 静默跳过，别给"只是搬了一下"的用户弹一条 partial「跳过：前言里有嵌套映射」
         *（独立审 🟡4；已声明的坏前言篇照旧走下面 —— 那种"声明没跟上"是真事项，该报）。
         */
        if (declared.length === 0 && fragileKeys(props).length > 0) continue;
        const rel = relativeTo(parentDir(moved.to), this.settings.kbRoot());
        if (declared.length === 1 && declared[0] === rel) continue; // 已声明且已一致 → 不重写（省一次写盘）
        /**
         * 🔴 **搬到库根要写 `.`（`ROOT_POS`），不是空数组**（P7.15 独立审查 🔴1）：
         * 空数组 = "从没声明过"（`declaredPositions` 为空）→ 这一篇会**立刻**落进
         * 「整理建议 · 缺文件位置」与 AI 补声明候选 —— 而它明明刚被声明过。
         * 也与新建路的口径对齐（顶层新建写 `.`）：两种同义表示同态。
         * ⚠️ P7.18b 起**未声明的也走这里**（上面不再 continue）——"搬了就该有声明"，
         * 与"声明 = 已安顿"（D1）同一条精神。
         */
        const r = await this.fm.setMany(file, { 文件位置: rel ? [rel] : [ROOT_POS] });
        /**
         * ⚠️ 守卫跳过（前言里有嵌套映射）：文件**搬好了**，但「文件位置」停在旧值 ——
         * 守卫自己会弹 partial 通知（用户看得到）；这里再落一条控制台痕迹，
         * 方便排查"下一次 reconcile 为什么报位置不一致"（独立审查 🟡1 的尾巴）。
         * 不进 `result.skipped`：那是"整篇没搬"的清单，语义不同。
         */
        if (r.skipped.length > 0) {
          console.warn('[经纬] 属性跟随被守卫跳过（文件已搬好）', moved.to, r.skipped.join('、'));
        }
      } catch (e) {
        console.error('[经纬] 属性跟随失败（文件已搬好）', e);
      }
    }

    /**
     * **回调（P7.6）**：只报**真的搬成功**的那几篇（`result.moved`），
     * 且用 try/catch 兜着 —— 学习是旁路，不许反向影响搬动本身。
     */
    if (this.onMoved && result.moved.length > 0) {
      try {
        this.onMoved({
          moved: result.moved.map((m) => ({ from: m.from, to: m.to })),
          source: req.source,
          tagsOf: (p) => tagsAtPlan.get(p) ?? [],
        });
      } catch (e) {
        console.error('[经纬] onMoved 回调出错（搬动已完成，不受影响）', e);
      }
    }

    this.finish(req, result);
    return result;
  }

  /**
   * 目标目录里"还不存在"的那几段（从最深往上，遇到已存在的就停）。
   * 库根自己不建 —— 库根都没了就轮不到 mover 管。
   */
  private async missingAncestors(dir: string): Promise<string[]> {
    const out: string[] = [];
    let cur = dir;
    const stop = this.settings.kbRoot();
    while (cur && cur !== stop && !(await this.app.vault.adapter.exists(cur))) {
      out.push(cur);
      const parent = parentDir(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    return out;
  }

  /**
   * 反查"谁在引用这些文件"。
   * 双链由平台在 rename 时同步改写 → 那一刻之前必须把引用者的内容存进快照，
   * 否则还原之后引用者还指着旧路径。
   */
  private reverseLinkSources(paths: Set<string>): Set<string> {
    const out = new Set<string>();
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const [src, dests] of Object.entries(resolved)) {
      if (paths.has(src)) continue; // 被搬的文件自己不算
      /**
       * ⚠️ **陈旧键过滤**（P7.17 · 快照 ENOENT 排查的修法，2026-10-09 真机取证）：
       * `resolvedLinks` 的键是 **source 路径** —— 重命名风暴（收拢 / 还原这类整库搬动）
       * 之后，平台缓存里可能残留**已经不在库里的路径**。旧代码把这种键当"引用者"塞进
       * 快照的 `extraContents`，`snapshot.capture` 读不到就**整批中止**（"失败即停"是好
       * 纪律 —— 但为此中止一拍本来无事可做的自动归位不值当；真机症状 = 一条吞掉的
       * 内部报错 + 那拍归位被安全取消）。**盘上都没有这个文件 = 没有内容需要保护**，
       * 直接不当引用者。
       * （真·幽灵节点（注册表说在、盘上没有）不在此列 —— 那种仍走"失败即停"，
       * 那条护栏一个字没动。）
       * ⚠️ 独立审 🟢6：还要是 **TFile** —— 陈旧键的路径上现在蹲着一个**目录**时，
       * `capture` 的 `adapter.read` 也会抛（目录读成字符串）→ 同样会把整批中止。
       */
      if (!(this.app.vault.getAbstractFileByPath(src) instanceof TFile)) continue;
      if (!dests) continue;
      for (const dest of Object.keys(dests)) {
        if (paths.has(dest)) {
          out.add(src);
          break;
        }
      }
    }
    return out;
  }

  /** 收尾：写日志 + 通知（成功 / 部分成功 / 失败三档） */
  private finish(req: MoveRequest, result: MoveResult): void {
    const movedN = result.moved.length;
    const alreadyN = result.already.length;
    const blockedN = result.blocked.length;
    const skippedN = result.skipped.length;
    const total = movedN + alreadyN + blockedN + skippedN;

    const rows: { label: string; detail?: string }[] = result.moved.map((m) => ({
      label: `${m.from} → ${m.to}`,
    }));
    // 新建的文件（种子页 / 示例数据）紧跟在移动明细后面（都对账用）
    for (const f of result.newFiles) rows.push({ label: `新建 ${f.path}` });
    // 调用方带来的额外行（P5 重排的"新建目录/待定"）排在移动明细之后、跳过之前
    for (const r of req.extraRows ?? []) rows.push({ label: r.label, detail: r.detail });
    if (alreadyN > 0) rows.push({ label: `已搬过（内容相同，跳过）${alreadyN} 篇` });
    for (const s of result.skipped) rows.push({ label: `跳过 ${s.path}`, detail: s.note ?? s.why });
    for (const b of result.blocked) rows.push({ label: `真冲突 ${b.path}`, detail: b.note ?? '' });

    const newDirN = result.newDirs.length;
    const newFileN = result.newFiles.length;
    const summary =
      movedN > 0
        ? `已移动 ${movedN} 篇笔记`
        : (newDirN > 0 || newFileN > 0) && blockedN === 0
          ? `新建了 ${[
              newDirN > 0 ? `${newDirN} 个目录` : '',
              newFileN > 0 ? `${newFileN} 个文件` : '',
            ]
              .filter(Boolean)
              .join('、')}`
          : blockedN > 0
            ? `没有文件被移动：${blockedN} 篇撞名冲突`
            : `没有文件需要移动`;

    const detailParts: string[] = [];
    if (alreadyN > 0) detailParts.push(`已搬过 ${alreadyN} 篇`);
    if (blockedN > 0) detailParts.push(`撞名冲突 ${blockedN} 篇`);
    if (skippedN > 0) detailParts.push(`跳过 ${skippedN} 篇`);
    if (movedN > 0 && newDirN > 0) detailParts.push(`新建 ${newDirN} 个目录`);
    if (movedN > 0 && newFileN > 0) detailParts.push(`新建 ${newFileN} 个文件`);

    // 日志（不看结果都写：失败也要留痕）
    void this.report.log({
      action: '移动',
      result: blockedN + skippedN > 0 ? 'partial' : 'ok',
      source: req.source,
      /**
       * **§11 边界 ④「每次动库都留痕」的接线点**（P6 段④）。
       * 判据只有一个来源：`source === 'ai'` —— 调用方**不需要**自己记得传 `ai`，
       * 也就没有"某个入口忘了标"这种可能（`source` 本来就必须传，是类型要求的）。
       * `report.render` 据此写出「**这条是 AI 建议的**」那行。
       */
      ai: req.source === 'ai',
      summary,
      moves: result.moved.map((m) => ({ from: m.from, to: m.to })),
      rows,
      skipped: result.skipped.map((s) => ({ path: s.path, why: s.note ?? s.why })),
      blocked: result.blocked.map((b) => ({ path: b.path, why: b.note ?? '' })),
      already: result.already.map((a) => a.path),
      touched: result.touched.map((t) => t.path),
      snapshotId: result.snapshotId,
    });

    // 无事发生就彻底不吵（**建了目录/文件也算"有事"**：P5 重排可能只补骨架、P7.2b 初始化只建种子页）
    if (total === 0 && newDirN === 0 && newFileN === 0) return;
    if (movedN === 0 && blockedN === 0 && alreadyN === total && newDirN === 0 && newFileN === 0) {
      notify({ kind: 'info', text: '这些笔记本来就在目标位置', ms: NOTIFY_MS.info });
      return;
    }
    const actions: NoticeAction[] = [];
    if (blockedN + skippedN > 0) {
      actions.push({ label: '查看报告', run: () => this.openLatestReport() });
    }
    // 调用方自带的动作（见 `MoveRequest.extraActions`）——挂在两条出口的最后
    if (req.extraActions && req.extraActions.length > 0) actions.push(...req.extraActions);
    /**
     * `quiet` 只压"成功"那一支，**且要有撤销条兜底才压**。
     *
     * ⚠️ 兜底面是"**这一趟有没有可见回执**"，不是只看 `movedN`（P7.2b 独立审查 🟡3）：
     * 重排面板三个档（重排 / 初始化 / 收拢）只要 `snapshotId` 非空就弹撤销条 ——
     * 初始化档 `movedN=0` 但建了目录/文件，撤销条照样在；原来只认 `movedN>0` 时，
     * 初始化会"mover 弹一条 + 撤销条再弹一条"（P7.0a 批 1⑦ 想消的重复回执原地复发）。
     */
    const quietCovered = req.quiet === true && (movedN > 0 || newDirN > 0 || newFileN > 0);
    if (blockedN + skippedN > 0) {
      notifyPartial(summary, detailParts.join(' · '), actions);
    } else if (!quietCovered) {
      notify({
        kind: 'success',
        text: summary,
        detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
        ms: NOTIFY_MS.library, // 动库成功 = 3s
        actions: actions.length > 0 ? actions : undefined,
      });
    }
  }

  /** 「查看报告」：打开最近一条操作日志（唯一实现点在 `report.openLatest()`） */
  private async openLatestReport(): Promise<void> {
    await this.report.openLatest();
  }

  // ────────────────────────────────────────────────────────────────
  // 删除到回收站
  //
  // 为什么也在这里：三条硬规矩说的是"**动文件**只能过 mover" —— 删除同样是动文件，
  // 而且它比移动更需要"操作前一定有一份完整快照"（快照的 `deletions` 清单就是为它存的，
  // 还原时按内容在旧路径重建）。放别处 = 安全网被绕开。
  // ────────────────────────────────────────────────────────────────

  /** 平台的真值只有这三个（S2 从 asar 取证）；读不到就按最保守的 system 算 */
  trashOption(): 'system' | 'local' | 'none' {
    try {
      const v = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.(
        'trashOption',
      );
      if (v === 'local' || v === 'none') return v;
    } catch {
      /* 版本差异：当 system 处理 */
    }
    return 'system';
  }

  async trash(req: TrashRequest): Promise<TrashResult> {
    const option = this.trashOption();
    const files = req.files.filter((f): f is TFile => Boolean(f));
    const result: TrashResult = {
      trashed: [],
      skipped: [],
      snapshotId: '',
      // 只有"本地 .trash"是程序化拿得回来的（platform-pitfalls：system 进系统回收站）
      reversible: option === 'local',
      trashOption: option,
    };
    if (files.length === 0) return result;

    try {
      const manifest = await this.snapshot.capture({
        reason: req.reason,
        files,
        deletions: files.map((f) => ({ path: f.path, trashed: option === 'local' })),
      });
      result.snapshotId = manifest.id;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      notifyError('删除已中止：快照没能写成', result.error);
      await this.report.log({
        action: '中止',
        result: 'error',
        source: req.source,
        summary: `快照失败，没有删任何文件：${result.error}`,
        rows: files.map((f) => ({ label: `将删除 ${f.path}` })),
      });
      return result;
    }

    for (const f of files) {
      const cur = this.app.vault.getAbstractFileByPath(f.path);
      if (!cur) {
        result.skipped.push({ path: f.path, note: '文件不在了' });
        continue;
      }
      try {
        await this.app.fileManager.trashFile(cur);
      } catch (e) {
        result.skipped.push({ path: f.path, note: e instanceof Error ? e.message : String(e) });
        continue;
      }
      // ⚠️ `trashOption: none` 时平台**静默什么都不做**（S2 实测）——
      // 不复查就会报"已删除 N 篇"而文件还在，那是最坏的一种谎
      if (this.app.vault.getAbstractFileByPath(f.path)) {
        result.skipped.push({
          path: f.path,
          note: '还没删掉（Obsidian 的「删除文件」设置可能是「不删除」）',
        });
        continue;
      }
      result.trashed.push({ path: f.path });
    }

    const n = result.trashed.length;
    const summary = n > 0 ? `已删除 ${n} 篇笔记` : '没有文件被删除';
    void this.report.log({
      action: '删除',
      result: result.skipped.length > 0 ? 'partial' : 'ok',
      source: req.source,
      summary,
      rows: [
        ...result.trashed.map((t) => ({ label: `删除 ${t.path}` })),
        ...result.skipped.map((s) => ({ label: `跳过 ${s.path}`, detail: s.note })),
      ],
      skipped: result.skipped.map((s) => ({ path: s.path, why: s.note })),
      snapshotId: result.snapshotId,
    });

    if (n === 0 && result.skipped.length > 0) {
      notifyPartial(summary, `${result.skipped.length} 篇没删掉`, [
        { label: '查看报告', run: () => void this.openLatestReport() },
      ]);
    } else if (result.skipped.length > 0) {
      notifyPartial(summary, `${result.skipped.length} 篇没删掉`, [
        { label: '查看报告', run: () => void this.openLatestReport() },
      ]);
    } else if (n > 0) {
      notify({
        kind: 'success',
        text: summary,
        detail: result.reversible ? '进了库内 .trash，可以还原' : '进了系统回收站',
        ms: NOTIFY_MS.library,
      });
    }
    return result;
  }
}

export interface TrashRequest {
  files: TFile[];
  source: MoveSource;
  reason: string;
}

export interface TrashResult {
  trashed: { path: string }[];
  skipped: { path: string; note: string }[];
  snapshotId: string;
  /** 程序化拿得回来吗（只有 `trashOption: local` 是） */
  reversible: boolean;
  trashOption: 'system' | 'local' | 'none';
  /** 快照失败等硬错误（此时一个文件都没删） */
  error?: string;
}

/**
 * 确认流里的「位置锁定」提示行（属性规范 §3.2 定的文案）。
 * 锁只挡后台自动行为，**不挡你自己的手** → 所以是"将一并移动"，不是"已跳过"。
 */
export function lockNotice(propsList: Record<string, unknown>[]): string[] {
  const locked = propsList.filter((props) => isPositionLocked(props));
  return locked.length > 0 ? [`${locked.length} 篇设了「位置锁定」，将一并移动`] : [];
}
