/**
 * services/snapshot.ts —— 快照 / 还原（**全案的安全网**）
 *
 * 存在插件目录、**不进库**（`.obsidian/plugins/kb-workbench/snapshots/<id>/`）——
 * 避免污染搜索、文件列表和索引（交互规格 §7.6 / §10.2）。
 * 走 `vault.adapter`，**不用 Node `fs`** —— 否则 `isDesktopOnly: false` 下手机端直接崩。
 *
 * 存**四样，不只存内容**（方案设计.md §6.1）：
 *   ① 被改动文件的内容   ② 每条移动的 from → to
 *   ③ 本次新建的目录列表 ④ 删除清单 + 原路径
 * 只存内容的话，"还原"撤不了**移动**和**新建目录**（快照存的是内容，移动存的是路径）。
 *
 * 两条硬约束：
 *   · **写完回读校验** —— `saveData` 那条路会静默吞 ENOENT，多级新目录尤其危险；
 *     快照面板上显示"文件数 / 字节数"是静默失败的唯一现实对策
 *   · **不让路** —— 还原时原位置已存在的、且不在快照里的内容，**一律移到
 *     「还原保留-<时间戳>/」（移动不是删除）**，绝不覆盖、绝不删
 *
 * ⚠️ `.obsidian/**` 不在 Obsidian 的库索引里 → `vault.getAbstractFileByPath` 看不见它们，
 *    所以本文件的落盘/读取全部走 `adapter`。
 */
import { TFile, TFolder, type App } from 'obsidian';
import { joinPath, parentDir, sanitizeFileName } from '../core/paths';
import { markSelfWrite, markSelfWritePair } from '../core/writes';
import { stamp } from '../core/util';
// 与 `mover` 同一条纪律：**服务层自己把"没做到的部分"说出来** ——
// 靠每个调用方记得转达 `RestoreResult.notifications` 的话，一定会漏（P5 实测：
// 真机上"删不掉新建的空目录"整整一期都没人看见，因为没有任何一处显示它）
import { notifyPartial } from '../ui/notify';

export interface SnapshotContent {
  /** 操作**前**该文件的库内路径 */
  path: string;
  bytes: number;
  /** 内容副本在快照目录里的文件名（`contents/0001-xxx.md`） */
  file: string;
}

export interface SnapshotManifest {
  id: string;
  /** 触发这次快照的操作（给人看的） */
  reason: string;
  /** 含 `MoveResult.touched`（被双链修复波及的文件） */
  contents: SnapshotContent[];
  moves: { from: string; to: string }[];
  newDirs: string[];
  /**
   * **本次新建的文件**（P7.2b：种子页 / 示例数据）—— 还原时"删掉本次新建的文件"靠它。
   * ⚠️ 旧快照（本字段出现之前落的盘）读回来是 `undefined` → 还原侧一律
   * `m.newFiles ?? []`（老账本不带这一项，不硬造）。
   */
  newFiles: string[];
  deletions: { path: string; trashed: boolean }[];
  /** 面板显示用——静默失败的唯一对策 */
  totalBytes: number;
  /** 落下时间（P0 补：底部状态区要显示"快照 N 分钟前"） */
  at: number;
  /** 拍快照时的库内根，还原时做路径基准 */
  kbRoot: string;
}

export interface CaptureSpec {
  reason: string;
  /** 将要被改动的文件（内容会被存下来） */
  files: (TFile | string)[];
  /** 额外的"内容也要存"的路径（`touched` 里那些不在 files 里的） */
  extraContents?: string[];
  moves?: { from: string; to: string }[];
  newDirs?: string[];
  /** 本次要**新建**的文件（库内绝对路径）—— 只在清单里记账（还原时删它们），不存内容 */
  newFiles?: string[];
  deletions?: { path: string; trashed: boolean }[];
}

export interface RestoreResult {
  contentsRestored: number;
  movedBack: number;
  /** 删掉的"本次新建的文件"个数（P7.2b：种子页 / 示例数据） */
  filesRemoved: number;
  dirsRemoved: number;
  /** 被挪到「还原保留-<时间戳>/」的（移动不是删除） */
  keptAside: string[];
  /** 不让路而没动的（需要人看一眼） */
  blocked: { path: string; why: string }[];
  /**
   * **没做到**的那些（目录里有东西没删 / 目录删不掉 / 快照内容读不回 / 那位置本来该重建却建不了）。
   * 🔴 与 `notifications` 分开是因为它们是**两种东西**（独立审查 🟡5）：混在一起的话，
   * 一次**完全正常**的还原（只是有几个挡路的文件被挪去了「还原保留」，那本来就是设计）也会被
   * 报成"有 1 项没做到" —— 用户没法判断到底要不要管。
   */
  problems: string[];
  /** 信息类（正常结果）：如"3 个文件被挪到 还原保留-…（移动不是删除）" */
  notifications: string[];
}

export class SnapshotService {
  private app: App;
  private pluginDir: string;
  private kbRootOf: () => string;
  /**
   * "这份文件在快照之后被**别处**改过吗"（由索引接进来，见 `VaultIndex.isExternallyChanged`）。
   * 还原写回内容前必须问这一句：交互规格 §1.5 定的口径是「**不静默覆盖**」——
   * 撤销条的 5 秒窗口里几乎遇不到，但**快照面板的还原可以发生在几天之后**，
   * 那时把用户后来的编辑写回旧内容就是静默吃掉改动（P1 收尾的独立审查指出）。
   */
  private externallyChanged: (path: string) => boolean;
  /** 拍完之后的通知口（main.ts 接上去更新"上次快照时间"） */
  public onCapture: ((manifest: SnapshotManifest) => void) | null = null;

  constructor(
    app: App,
    pluginDir: string,
    kbRootOf: () => string,
    externallyChanged?: (path: string) => boolean,
  ) {
    this.app = app;
    this.pluginDir = pluginDir.replace(/^\/+|\/+$/g, '');
    this.kbRootOf = kbRootOf;
    this.externallyChanged = externallyChanged ?? (() => false);
  }

  // ── 路径 ─────────────────────────────────────────────────────
  rootDir(): string {
    return joinPath(this.pluginDir, 'snapshots');
  }

  dirOf(id: string): string {
    return joinPath(this.rootDir(), id);
  }

  // ── 拍快照 ───────────────────────────────────────────────────
  /**
   * 拍一份快照。**失败会抛** —— 调用方（mover）必须因此中止操作：
   * 全案的安全论证建立在"操作前一定有一份完整快照"上。
   */
  async capture(spec: CaptureSpec): Promise<SnapshotManifest> {
    const id = await this.uniqueId();
    const dir = this.dirOf(id);
    const contentsDir = joinPath(dir, 'contents');
    await this.app.vault.adapter.mkdir(contentsDir); // S3 实测：一次建多级

    // ① 内容：目标文件 + touched（去重、保序）
    const paths: string[] = [];
    const seen = new Set<string>();
    const push = (p: TFile | string): void => {
      const path = typeof p === 'string' ? p : p.path;
      if (!path || seen.has(path)) return;
      seen.add(path);
      paths.push(path);
    };
    for (const f of spec.files) push(f);
    for (const p of spec.extraContents ?? []) push(p);

    const contents: SnapshotContent[] = [];
    const unreadable: string[] = [];
    let totalBytes = 0;
    let index = 0;
    for (const path of paths) {
      let text: string;
      try {
        text = await this.app.vault.adapter.read(path);
      } catch (e) {
        // ⚠️ 读不到**绝不能记成 0 字节空内容** —— 那等于给"还原"埋一颗雷：
        // 日后还原会把一个真有内容的笔记清成 0 字节（独立审查指出的内容丢失路径）。
        // 记下路径，整次快照判失败（"失败即停"是本模块的安全前提）。
        console.error(`[经纬] 快照读不到 ${path}`, e);
        unreadable.push(path);
        text = '';
      }
      index += 1;
      const name = `${String(index).padStart(4, '0')}-${sanitizeFileName(path.split('/').pop() ?? 'x')}`;
      const rel = joinPath('contents', name);
      const bytes = new TextEncoder().encode(text).length;
      await this.app.vault.adapter.write(joinPath(dir, rel), text);
      contents.push({ path, bytes, file: rel });
      totalBytes += bytes;
    }

    if (unreadable.length > 0) {
      throw new Error(
        `快照读不到这些文件，不敢继续（怕还原时把它们清空）：${unreadable.join('、')}`,
      );
    }

    const manifest: SnapshotManifest = {
      id,
      reason: spec.reason,
      contents,
      moves: spec.moves ?? [],
      newDirs: spec.newDirs ?? [],
      newFiles: spec.newFiles ?? [],
      deletions: spec.deletions ?? [],
      totalBytes,
      at: Date.now(),
      kbRoot: this.kbRootOf(),
    };

    await this.app.vault.adapter.write(
      joinPath(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // ── 回读校验（静默失败的唯一对策）──
    const problems = await this.verify(manifest);
    if (problems.length > 0) {
      throw new Error(`快照写盘校验失败：${problems.join('；')}`);
    }
    try {
      this.onCapture?.(manifest);
    } catch (e) {
      console.error('[经纬] 快照回调出错', e);
    }
    return manifest;
  }

  /** 逐份回读，比对字节数。返回不一致的清单（空 = 全对） */
  private async verify(manifest: SnapshotManifest): Promise<string[]> {
    const problems: string[] = [];
    const dir = this.dirOf(manifest.id);
    let manifestBack: SnapshotManifest | null = null;
    try {
      const raw = await this.app.vault.adapter.read(joinPath(dir, 'manifest.json'));
      manifestBack = JSON.parse(raw) as SnapshotManifest;
    } catch (e) {
      problems.push(`manifest.json 读不回（${String(e)}）`);
    }
    if (manifestBack && manifestBack.contents.length !== manifest.contents.length) {
      problems.push(
        `manifest 条目数不一致（写 ${manifest.contents.length} / 读 ${manifestBack.contents.length}）`,
      );
    }
    for (const entry of manifest.contents) {
      try {
        const back = await this.app.vault.adapter.read(joinPath(dir, entry.file));
        const bytes = new TextEncoder().encode(back).length;
        if (bytes !== entry.bytes) {
          problems.push(`${entry.file} 字节数不一致（写 ${entry.bytes} / 读 ${bytes}）`);
        }
      } catch (e) {
        problems.push(`${entry.file} 读不回（${String(e)}）`);
      }
    }
    return problems;
  }

  /** 同一秒内的第几次 capture（避免两次并发 capture 撞进同一个目录、后者覆盖前者的账本） */
  private lastBase = '';
  private seqInSecond = 0;
  private async uniqueId(): Promise<string> {
    const base = stamp();
    if (base === this.lastBase) {
      this.seqInSecond += 1;
      return `${base}-${this.seqInSecond + 1}`;
    }
    this.lastBase = base;
    this.seqInSecond = 0;
    let id = base;
    let n = 2;
    while (await this.app.vault.adapter.exists(this.dirOf(id))) {
      id = `${base}-${n}`;
      n += 1;
    }
    return id;
  }

  // ── 读 / 列 / 清理 ───────────────────────────────────────────
  async read(id: string): Promise<SnapshotManifest | null> {
    try {
      const raw = await this.app.vault.adapter.read(joinPath(this.dirOf(id), 'manifest.json'));
      return JSON.parse(raw) as SnapshotManifest;
    } catch {
      return null;
    }
  }

  /** 全部快照，最新在前 */
  async list(): Promise<SnapshotManifest[]> {
    const root = this.rootDir();
    if (!(await this.app.vault.adapter.exists(root))) return [];
    let folders: string[] = [];
    try {
      const listing = await this.app.vault.adapter.list(root);
      folders = listing.folders ?? [];
    } catch {
      return [];
    }
    const out: SnapshotManifest[] = [];
    for (const f of folders) {
      const id = f.split('/').pop() ?? f;
      const m = await this.read(id);
      if (m) out.push(m);
    }
    out.sort((a, b) => b.id.localeCompare(a.id));
    return out;
  }

  async lastAt(): Promise<number | null> {
    const all = await this.list();
    return all.length > 0 ? all[0].at : null;
  }

  async totalBytes(): Promise<number> {
    const all = await this.list();
    return all.reduce((sum, m) => sum + m.totalBytes, 0);
  }

  /**
   * 保留策略：最近 `keepCount` 个 + 不超过 `keepDays` 天。
   * ⚠️ 交互规格 §7.6 的值（20 个 / 30 天）标着 ❓待定 —— P1 做面板时向用户确认后再接线。
   */
  async prune(keepCount = 20, keepDays = 30): Promise<number> {
    const all = await this.list();
    const cutoff = Date.now() - keepDays * 86_400_000;
    let removed = 0;
    for (let i = 0; i < all.length; i += 1) {
      const m = all[i];
      const expired = i >= keepCount || m.at < cutoff;
      if (!expired) continue;
      await this.remove(m.id);
      removed += 1;
    }
    return removed;
  }

  async remove(id: string): Promise<void> {
    const dir = this.dirOf(id);
    try {
      await this.app.vault.adapter.rmdir(dir, true);
    } catch (e) {
      console.error(`[经纬] 删快照 ${id} 失败`, e);
    }
  }

  // ── 还原 ─────────────────────────────────────────────────────
  async restore(id: string): Promise<RestoreResult> {
    const m = await this.read(id);
    if (!m) throw new Error(`快照不存在或读不了：${id}`);
    const result: RestoreResult = {
      contentsRestored: 0,
      movedBack: 0,
      filesRemoved: 0,
      dirsRemoved: 0,
      keptAside: [],
      blocked: [],
      problems: [],
      notifications: [],
    };

    /**
     * 还原时"该保护"的是**这次快照里正在搬的那些文件**（它们才是被搬动过的实体）。
     * 不能拿"路径在快照里出现过"当保护条件 —— `mv.from` 这个位置现在蹲着的
     * 很可能是一个**快照之后才建的文件**，那正是该挪去「还原保留」的。
     */
    const moveTargets = new Set(m.moves.map((mv) => mv.to));
    /** 本次要"搬回原处"的那些位置 —— 只有这些位置的缺失文件才允许重建 */
    const moveFroms = new Set(m.moves.map((mv) => mv.from));
    // ⚠️ P7.14：用 `??` 不能用 `||` —— `kbRoot: ''`（整个库）是有效值，`||` 会把它当"没记"
  const apartDir = joinPath(m.kbRoot ?? this.kbRootOf(), `还原保留-${stamp()}`);

    /** 把挡住路的"不在快照里的"文件挪到还原保留（移动不是删除） */
    const moveAside = async (path: string): Promise<string | null> => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return null;
      const target = joinPath(apartDir, path);
      await this.ensureDir(parentDir(target));
      markSelfWritePair(path, target);
      await this.app.fileManager.renameFile(file, target);
      result.keptAside.push(target);
      return target;
    };

    /**
     * ⓪ 删掉**本次新建的文件**（种子页 / 示例数据；P7.2b）——**必须排在最前**：
     *  · 排在"删新建目录"（③）之前 → 文件删掉后那些目录才空得下来；
     *  · **更要排在"逆 rename"（①）之前** —— 否则有一类误删：新文件与"要被搬回的老文件"
     *    占同一路径时（收拢把老 `_收件箱.md` 收进归集夹 → 初始化又在原位建了一份新的），
     *    ① 先把老文件让路/搬回原位、删除循环再来删"这个路径上的文件"，删掉的其实是**刚搬回的老文件**
     *    （真数据进了回收站；之后②还会拿快照内容原地重建，内容看着对、盘上却白绕一圈 ——
     *    判据 `keptAside === 0` 就是钉这个的）。先删新建的：路径空出来，① 的 rename 直接落位、无让路。
     *
     * 两条守卫：
     *  · **快照之后被别处改过的 → 不删，挪去「还原保留」**（P7.2b 独立审查 🟡4）：
     *    与 ② 写回前那道 `externallyChanged` 同一条"不静默吃掉改动" —— 用户在种子页上
     *    写满了自己的内容，还原初始化不该把它一键进回收站；
     *  · 删走 `trashFile`（不是 adapter 直删）—— 与 `mover.trash` 同一条纪律：
     *    可回收、且**删完复查**（trashOption: none 时平台静默什么都不做，S2 实测）。
     * 已不在原位的不硬来（用户自己删了/搬了 → 无事可做），路径被目录占了如实报。
     */
    for (const path of m.newFiles ?? []) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!f) continue;
      if (!(f instanceof TFile)) {
        result.problems.push(`新建的 ${path} 现在不是文件，没动`);
        continue;
      }
      if (this.externallyChanged(path)) {
        const moved = await moveAside(path);
        if (!moved) result.problems.push(`新建的 ${path} 后来改过、又挪不动，没动`);
        continue; // 让路是"移动不是删除"，不计 filesRemoved
      }
      try {
        await this.app.fileManager.trashFile(f);
      } catch (e) {
        result.problems.push(`新建的文件 ${path} 删不掉：${String(e)}`);
        continue;
      }
      if (this.app.vault.getAbstractFileByPath(path)) {
        result.problems.push(
          `新建的文件 ${path} 还在（Obsidian 的「删除文件」设置可能是「不删除」）`,
        );
        continue;
      }
      result.filesRemoved += 1;
    }

    // ① 逆 rename（深路径先处理，避免父子目录互相干扰）
    const moves = [...m.moves].sort((a, b) => depthOf(b.to) - depthOf(a.to));
    for (const mv of moves) {
      const cur = this.app.vault.getAbstractFileByPath(mv.to);
      if (!cur) continue; // 已经不在了（可能被手动搬走）→ 不硬来
      if (mv.from === mv.to) continue;
      // ⚠️ **to 位蹲着的可能不是我们搬走的那份**：用户可能把它删了/改名了，
      // 又在同一路径新建了一篇同名的（Obsidian 里"新建同名笔记"很常见）。
      // 用创建时间判：快照之后才出现在 to 位的文件，一定不是本次操作搬过去的
      // —— 那样既不能搬回去、更不能拿旧内容覆盖它（独立审查指出的一条静默内容丢失）。
      const stat = (cur as TFile).stat;
      const born = stat?.ctime ?? 0;
      if (born > 0 && m.at > 0 && born > m.at + 1000) {
        result.blocked.push({
          path: mv.to,
          why: '快照之后这里出现了新文件，没动它（原来那篇已不在此处）',
        });
        continue;
      }
      const occupant = this.app.vault.getAbstractFileByPath(mv.from);
      if (occupant && occupant.path !== cur.path) {
        if (moveTargets.has(mv.from)) {
          // 原位蹲着的是"这次也要被搬过来的另一个文件"→ 不硬来
          result.blocked.push({ path: mv.from, why: '原位是本次要搬过来的另一个文件，未覆盖' });
          continue;
        }
        const moved = await moveAside(mv.from);
        if (!moved) {
          result.blocked.push({ path: mv.from, why: '原位被占用且挪不动，未覆盖' });
          continue;
        }
      }
      try {
        await this.ensureDir(parentDir(mv.from));
        markSelfWritePair(cur.path, mv.from);
        await this.app.fileManager.renameFile(cur, mv.from);
        result.movedBack += 1;
      } catch (e) {
        result.blocked.push({ path: mv.to, why: `搬回原位失败：${String(e)}` });
      }
    }

    // ② 内容写回原文
    //    内容条目的路径**必然**是快照自己提到的路径 → 这里写回就是"读档"的本意，
    //    不存在"外面的文件"抢位问题（那种情况出现在 ① 和 ④，那两处才让路）
    for (const entry of m.contents) {
      let text: string;
      try {
        text = await this.app.vault.adapter.read(joinPath(this.dirOf(m.id), entry.file));
      } catch (e) {
        result.blocked.push({ path: entry.path, why: `快照内容读不回：${String(e)}` });
        continue;
      }
      try {
        const now = this.app.vault.getAbstractFileByPath(entry.path);
        if (now instanceof TFile) {
          // ⚠️ 写回前问一句"快照之后别处改过吗"：改过就**不让路也不覆盖**
          //（口径见 §1.5「不静默覆盖」；这一步缺失时，几天后点还原会吃掉用户的编辑）
          if (this.externallyChanged(entry.path)) {
            result.blocked.push({
              path: entry.path,
              why: '快照之后别处改过，没写回（怕吃掉你的改动）',
            });
            continue;
          }
          markSelfWrite(entry.path);
          await this.app.vault.process(now, () => text);
        } else if (now instanceof TFolder) {
          result.blocked.push({ path: entry.path, why: '该路径现在是个目录，未动' });
          continue;
        } else if (moveFroms.has(entry.path)) {
          // 这个位置本来就是本次要搬回去的 → 文件不在就重建（逆 rename 没成功的情况）
          await this.ensureDir(parentDir(entry.path));
          markSelfWrite(entry.path);
          await this.app.vault.create(entry.path, text);
        } else if (m.deletions.some((d) => d.path === entry.path)) {
          /**
           * 🔴 **被本次删除的文件不在这里报「已不在原位」**（P7.18 独立审 🔴3 修）：
           * 它 "不在原位" 是本轮删除的**正因**，重建归**第 ④ 步**（deletions）管 ——
           * 这里原先落到下面的 else、推一条 problems → 服务层弹
           * 「还原完成，但有 N 项没做到」，把一次**完全正常**的还原报成半失败
           *（与紧随其后的"已还原"互相打架；`mover.trash` 的撤销路径也一直带着这条假警报）。
           */
          continue;
        } else {
          // ⚠️ **不要在这里凭内容新建文件**。
          // `contents` 里除了被搬的文件，还有"双链被平台改写波及到的其他文件"（touched），
          // 它们的内容是按**当时所在路径**记的；如果那个文件后来被合法地搬到别处，
          // 在这里新建就等于**凭空复制一份**（真机还原 Inbox 时就是这么冒出一份同哈希的副本）。
          // 删掉的文件由第 ④ 步（deletions）负责重建，不走这条。
          result.problems.push(
            `${entry.path} 已不在原位，内容未写回（可能后来被移动或删除了）`,
          );
          continue;
        }
        result.contentsRestored += 1;
      } catch (e) {
        result.blocked.push({ path: entry.path, why: `写回失败：${String(e)}` });
      }
    }

    // ③ 删掉本次新建的空目录（从深到浅；非空就留着并说明）
    const dirs = [...m.newDirs].sort((a, b) => depthOf(b) - depthOf(a));
    for (const dir of dirs) {
      if (!(await this.app.vault.adapter.exists(dir))) continue;
      const list = (): Promise<{ files?: string[]; folders?: string[] }> =>
        this.app.vault.adapter.list(dir);
      try {
        const listing = await list();
        if ((listing.files ?? []).length > 0 || (listing.folders ?? []).length > 0) {
          result.problems.push(`目录 ${dir} 里有东西，没删`);
          continue;
        }
        try {
          await this.app.vault.adapter.rmdir(dir, false);
        } catch (e) {
          /**
           * 🔴 **桌面端 `adapter.rmdir(dir, false)` 对目录一律抛 `ERR_FS_EISDIR`**
           * （P5 真机探针实测 + 报错原文取证：`Path is a directory: rm returned EISDIR`）——
           * 平台的 `FileSystemAdapter.rmdir` 走的是 **`fs.rm`**，而 `fs.rm` 删目录**必须**
           * 带 `recursive: true`（`fs.rmdir` 才是"删空目录"那个 API）。
           * ⇒ "**删掉本次新建的空目录**"这条在真机上**从来没成过**：还原之后库里留一副空骨架
           *（离线桩原先用 `fs.rmdirSync`，行为比真机宽松 → 这条判据离线恒绿。桩已对齐）。
           *
           * 退路：**再查一次还是空的**才用 recursive（把"查完到删之间被塞进东西"的窗口压到最小；
           * 不查就直接 recursive 的话，等于"顺手删掉用户刚拖进去的东西"）。
           */
          const again = await list();
          if ((again.files ?? []).length > 0 || (again.folders ?? []).length > 0) {
            result.problems.push(`目录 ${dir} 刚被塞进东西，没删`);
            continue;
          }
          void e;
          await this.app.vault.adapter.rmdir(dir, true);
        }
        /**
         * ⚠️ **删完要复查**（与 `mover.trash()` 同一条纪律）：平台的 `rmdir` 有"静默什么都不做"
         * 的先例（`trashOption: none` 那次），**凭返回值记 `dirsRemoved` 就是报假账**。
         */
        if (await this.app.vault.adapter.exists(dir)) {
          result.problems.push(`目录 ${dir} 还在（删了但没删掉）`);
          continue;
        }
        result.dirsRemoved += 1;
      } catch (e) {
        result.problems.push(`目录 ${dir} 删不掉：${String(e)}`);
      }
    }

    // ④ 删除清单：快照里有内容就能在旧路径重建
    for (const d of m.deletions) {
      const entry = m.contents.find((c) => c.path === d.path);
      if (!entry) {
        result.problems.push(`删除项 ${d.path} 没有内容副本，还原不了`);
        continue;
      }
      if (this.app.vault.getAbstractFileByPath(d.path)) {
        if (moveTargets.has(d.path)) {
          result.blocked.push({ path: d.path, why: '原位是本次要搬过来的另一个文件，未重建' });
          continue;
        }
        const moved = await moveAside(d.path);
        if (!moved) {
          result.blocked.push({ path: d.path, why: '原位被占用且挪不动，未重建' });
          continue;
        }
      }
      try {
        const text = await this.app.vault.adapter.read(joinPath(this.dirOf(m.id), entry.file));
        await this.ensureDir(parentDir(d.path));
        markSelfWrite(d.path);
        await this.app.vault.create(d.path, text);
        result.contentsRestored += 1;
      } catch (e) {
        result.blocked.push({ path: d.path, why: `重建失败：${String(e)}` });
      }
    }

    if (result.keptAside.length > 0) {
      result.notifications.push(
        `${result.keptAside.length} 个文件被挪到 ${apartDir}（移动不是删除）`,
      );
    }

    /**
     * 🔴 **"没做到的部分"必须弹出来**（P5 补）。
     * `notifications` 里装的全是"还原没能完全做到原位"的事实（目录里有东西没删、
     * 目录删不掉、原位被占、快照内容读不回…）—— 它们是**唯一**能让人察觉"还原不干净"的信号。
     * 原先**一处都没显示**（`ui/snapshot-panel.ts` / 重建面板 / 迁移面板都没读它），
     * 于是 P5 真机上"新建的空目录删不掉"这事**静默了一整期**。
     * 放在服务层是为了"一处写、处处有"——调用方不必各自记得转达。
     */
    if (result.problems.length > 0) {
      notifyPartial(
        `还原完成，但有 ${result.problems.length} 项没做到`,
        result.problems.slice(0, 2).join('；'),
      );
    }
    return result;
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!dir) return;
    if (await this.app.vault.adapter.exists(dir)) return;
    await this.app.vault.adapter.mkdir(dir);
  }
}

function depthOf(path: string): number {
  return path.split('/').filter(Boolean).length;
}
