/**
 * modules/notes/ops.ts —— 全部笔记的**动库动作**（收在一处）
 *
 * 每个动作都是同一条链：**确认流（该走的走）→ 唯一出口（mover / frontmatter）→
 * 撤销条 → 通知 → 日志**。放一处的理由与三条硬规矩同源：两处各写一遍必漂。
 *
 * 走不走确认流（交互规格 §9）：
 *   · 走：批量迁移 / 改属性 / 加标签 / 删除
 *   · 不走：**拖拽搬文件**（即时生效 + 撤销条 + 快照兜底）、单篇轻量改动（改名 / 改属性）
 *   · **单篇「移动到…」也不走确认流**（P1 收尾的独立审查问过这条）：它的输入本身就是
 *     一次显式操作（在菜单里打目录名 + Enter），且有快照 + 撤销条兜底；§9 的"走确认流"
 *     那一栏列的全是**批量**动词。这条口径如果改成要走确认流，改 `menus.ts` 的
 *     「移动到…」一处即可
 */
import { Platform, TFile } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { formatBytes } from '../../core/util';
import { joinPath } from '../../core/paths';
import { ROOT_POS, asList, asString, declaredPositions } from '../../services/schema';
import { lockNotice, type MoveResult, type TrashResult } from '../../services/mover';
import { confirm, type PlanRow } from '../../ui/confirm';
import { NOTIFY_MS, notify, notifyInfo, notifyLight } from '../../ui/notify';
import { showUndo } from '../../ui/undo-bar';
import { restoreNow, showMoveUndo, type UndoMoveDeps } from '../../ui/undo-move';

/**
 * 目录的两种口径，别混：
 *   · 树 / 筛选 / `文件位置` 说的是**相对库根**的目录（`00_Inbox`、`02_Areas/内容创作`）
 *   · `mover` 要的是**库内绝对路径**（`01_新知识库/02_Areas/内容创作`）
 * 混了会真的把文件搬到库根去（P1 用例抓到过：`moveNow(dir)` 直接收了相对路径）。
 */
export function absDir(ctx: WorkbenchContext, dir: string): string {
  // P7.14：走 joinPath —— kbRoot=''（整个库）时产出 `dir` 本身，不再有 `/dir` 前导斜杠
  return joinPath(ctx.settings.kbRoot(), dir);
}

/** 摘要：一批笔记某属性的取值分布（确认流里「从」那一列用） */
function summarize(values: string[]): string {
  const uniq = Array.from(new Set(values.filter((v) => v !== '')));
  if (uniq.length === 0) return '（空）';
  if (uniq.length === 1) return uniq[0];
  if (uniq.length <= 3) return uniq.join(' / ');
  return `${uniq.slice(0, 2).join(' / ')} 等 ${uniq.length} 种`;
}

export class NotesOps {
  constructor(
    private ctx: WorkbenchContext,
    /** 动作之后让模块重画（索引事件也会触发，这里是为了"立刻"） */
    private refresh: () => void,
  ) {}

  // ── 打开与复制（不动库）────────────────────────────────────────
  open(entry: NoteEntry, how: 'current' | 'newTab' | 'newWindow' | 'split' = 'current'): void {
    const ws = this.ctx.app.workspace;
    if (how === 'current') {
      void ws.getLeaf(false).openFile(entry.file);
      return;
    }
    if (how === 'newTab') {
      void ws.getLeaf('tab').openFile(entry.file);
      return;
    }
    /**
     * **分屏**（e 期 §3.3，拍板 Q5「先借平台 `getLeaf('split')`」）。
     *
     * 🔴 **`'vertical'` = 左右并排、新叶落在右边** —— 平台语义已 asar 取证
     *（2026-09-26，1.13.7）：`getLeaf('split', d)` → `splitActiveLeaf(d)` →
     * `createLeafBySplit(leaf, d, before=undefined)` ⇒ **落在后面**；而分屏容器的
     * `direction === 'vertical'` 时**手柄沿 x 走**、`getElSize()` 读 `offsetWidth`
     * ⇒ 是"左右"而不是"上下"。⚠️ 这两个词在 Obsidian 里与直觉相反（`vertical`
     * 说的是**分隔线**竖直），别照字面改成 `'horizontal'`。
     *
     * ⚠️ **分屏的另一半只放笔记**（e 期开工时拍板）—— 工作台**仍然只有一份**，
     * 不会出现第二个工作台标签。理由：整套代码是照"只有一份"写的（`ctx.dock` 单槽 /
     * `activeModule` 全局 / Esc 一份栈 / 面板单例），多开一份要先把六项口径全定掉。
     */
    if (how === 'split') {
      try {
        void ws.getLeaf('split', 'vertical').openFile(entry.file);
      } catch (e) {
        console.error('[经纬] 分屏打开失败，退成新标签', e);
        void ws.getLeaf('tab').openFile(entry.file);
      }
      return;
    }
    // 新窗口：弹不出就退成新标签（交互规格 §8.3 的原话）
    try {
      void ws.getLeaf('window').openFile(entry.file);
    } catch (e) {
      console.error('[经纬] 新窗口打开失败，退成新标签', e);
      void ws.getLeaf('tab').openFile(entry.file);
    }
  }

  copyPaths(entries: NoteEntry[]): void {
    void this.copyText(entries.map((e) => e.path).join('\n'), `${entries.length} 条路径`);
  }

  copyLinks(entries: NoteEntry[]): void {
    void this.copyText(entries.map((e) => `[[${e.basename}]]`).join('\n'), `${entries.length} 条双链`);
  }

  private async copyText(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      notifyLight(`已复制${what}`);
    } catch (e) {
      // 剪贴板不可用（WebView 权限/非安全上下文）：别静默失败，说清楚
      console.error('[经纬] 写剪贴板失败', e);
      notify({ kind: 'error', text: '复制失败', detail: '这个环境不允许写剪贴板', ms: NOTIFY_MS.long });
    }
  }

  // ── 在系统里定位 ──────────────────────────────────────────────
  /** 能不能用（不能就置灰并把原因说在菜单里 —— Windows 手感：置灰不隐藏） */
  revealBlockReason(): string | null {
    if (Platform.isMobile) return '手机上没有资源管理器';
    const fn = (this.ctx.app as unknown as { showInFolder?: unknown }).showInFolder;
    if (typeof fn !== 'function') return '这个版本不提供';
    return null;
  }

  async revealInExplorer(entry: NoteEntry): Promise<void> {
    const fn = (this.ctx.app as unknown as { showInFolder?: (p: string) => Promise<void> })
      .showInFolder;
    if (typeof fn !== 'function') {
      notifyInfo('这个版本不提供「在资源管理器中显示」');
      return;
    }
    try {
      await fn.call(this.ctx.app, entry.path);
    } catch (e) {
      console.error('[经纬] 打开资源管理器失败', e);
      notify({ kind: 'error', text: '打开资源管理器失败', ms: NOTIFY_MS.long });
    }
  }

  fileListBlockReason(): string | null {
    return this.fileExplorer() ? null : '需要「文件列表」核心插件';
  }

  /** 在左侧文件列表里定位（走核心插件的内部 API，找不到就置灰） */
  revealInFileList(entry: NoteEntry): void {
    const fe = this.fileExplorer();
    if (!fe) {
      notifyInfo('需要「文件列表」核心插件');
      return;
    }
    try {
      fe.revealInFolder(entry.file);
    } catch (e) {
      console.error('[经纬] 在文件列表中显示失败', e);
    }
  }

  private fileExplorer(): { revealInFolder: (f: TFile) => void } | null {
    const ip = (this.ctx.app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => unknown;
        plugins?: Record<string, unknown>;
      };
    }).internalPlugins;
    const plug = (ip?.getPluginById?.('file-explorer') ??
      ip?.plugins?.['file-explorer']) as
      | { instance?: { revealInFolder?: (f: TFile) => void } }
      | undefined;
    const fn = plug?.instance?.revealInFolder;
    return typeof fn === 'function' ? { revealInFolder: fn.bind(plug?.instance) } : null;
  }

  // ── 改名（单篇轻量改动 → 不走确认流）──────────────────────────
  async rename(entry: NoteEntry, newName: string): Promise<void> {
    const clean = newName.trim();
    if (!clean || clean === entry.basename) return;
    const res = await this.ctx.mover.move({
      targets: [{ newName: clean, files: [entry.file] }],
      source: 'batch',
      reason: `重命名：${entry.basename} → ${clean}`,
      // 撤销条在 → mover 不再弹一条重复的成功通知（P7.0a 批 1⑦，下同）
      quiet: true,
    });
    // 成功之后的事只有"弹撤销条"（mover 的通知被 quiet 压掉了）
    if (res.moved.length > 0) this.undoForMove(res);
    this.refresh();
  }

  // ── 移动 ──────────────────────────────────────────────────────
  /**
   * 批量迁移：**走确认流**。
   * `dir` 传**相对库根**的目录（树/菜单的口径），内部转成 mover 要的库内路径。
   */
  async moveWithConfirm(entries: NoteEntry[], dir: string, reason: string): Promise<void> {
    if (entries.length === 0) return;
    const n = entries.length;
    const preview: PlanRow[] = [
      {
        kind: 'move',
        from: summarize(entries.map((e) => e.effectivePosition || '库根')),
        to: dir || '库根',
        count: n,
      },
    ];
    const res = await confirm({
      title: `即将移动 ${n} 篇笔记`,
      preview,
      // 撞名要 mover 真去读了才知道（它比内容 sha256）→ 这里不预告，
      // 结果通知里会说清"撞名冲突 N 篇"（交互规格 §9：被跳过的要说出来）
      warnings: [],
      notes: lockNotice(entries.map((e) => e.props)),
      primary: { label: `移动 ${n} 篇` },
    });
    if (res.action !== 'primary') return;
    await this.moveNow(entries, dir, 'batch', reason);
  }

  /**
   * **改「文件位置」声明 = 直接搬**（v2 · #12 的口径；P7.15 · #3 把入口做成"选目录"）。
   *
   * ⚠️ **P7.16b 起整条链搬去模块级函数 `runSetPositionByMove`**（"同一条链、不许抄第二份"：
   * 三处编辑面 —— 小窗选择器 / 全部笔记右键 / **原生属性面板那一格**（`ui/native-position.ts`，
   * 在 `ui/` 层、不 import 这个类）—— 都要"完全同一条链"）。这里只是薄壳，行为一字不变。
   */
  async setPositionByMove(entries: NoteEntry[], dir: string, reason?: string): Promise<void> {
    return runSetPositionByMove(this.ctx, entries, dir, reason, this.refresh);
  }

  /**
   * **「就住这儿（写声明，不搬）」**（P7.16 · #2b，拍定 Q2）—— 同 `setPositionByMove`：
   * P7.16b 起实现是模块级函数 `runDeclarePositionHere`（薄壳，行为一字不变）。
   */
  async declarePositionHere(entries: NoteEntry[]): Promise<void> {
    return runDeclarePositionHere(this.ctx, entries, this.refresh);
  }

  /**
   * 拖拽搬文件：**即时生效**（唯一不走确认流的动库动作）。`dir` 同样是相对库根。
   * ⚠️ P7.16b 起实现是模块级函数 `runMoveNow`（薄壳，行为一字不变）——
   * ⚠️ **P7.18b 起**（用户 2026-10-09 拍板）：拖拽搬完**未声明的也写声明** —— 那是
   * `mover` 第 7 步的口径（"任何搬动之后，声明 = 实际落点"），本法不再有例外。
   */
  async moveNow(
    entries: NoteEntry[],
    dir: string,
    /** `board` 是 P4 加的：看板里跨板块拖 = 搬文件，日志要能分清是从哪一屏发起的 */
    source: 'drag' | 'batch' | 'board',
    reason: string,
  ): Promise<MoveResult | null> {
    return runMoveNow(this.ctx, entries, dir, source, reason, this.refresh);
  }

  // ── 改属性 / 标签 / 隐藏 ──────────────────────────────────────
  async setProp(entries: NoteEntry[], prop: string, value: unknown): Promise<void> {
    if (entries.length === 0) return;
    const n = entries.length;
    // P7.14：`null` = 删键（枚举的「（清空）」/ 自由值清空都走它）—— 文案说清是"清空"
    const shown = value === null ? '（清空）' : Array.isArray(value) ? value.join('、') : asString(value);
    if (n > 1) {
      const res = await confirm({
        title: `即将把 ${n} 篇的「${prop}」改成「${shown}」`,
        preview: [
          {
            kind: 'set',
            prop,
            from: summarize(entries.map((e) => asString(e.props[prop]))),
            to: shown,
            count: n,
          },
        ],
        warnings: [],
        notes: [],
        primary: { label: `改 ${n} 篇` },
      });
      if (res.action !== 'primary') return;
    }
    let ok = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const e of entries) {
      try {
        // ⚠️ 守卫跳过（前言里有嵌套映射）**不算改成** —— 否则"已改好 N 篇"与守卫那条
        // "跳过「X」"同屏打架（独立审查 🟡1：承诺与事实不符）
        const r = await this.ctx.fm.setMany(e.file, { [prop]: value });
        if (r.skipped.length === 0) ok += 1;
        else skipped += 1;
      } catch (err) {
        failed.push(`${e.basename}：${String(err)}`);
      }
    }
    if (failed.length > 0 || skipped > 0) {
      const skippedNote = skipped > 0 ? `，${skipped} 篇跳过（前言里有嵌套映射）` : '';
      notify({
        kind: 'partial',
        text: `${ok} 篇已改${skippedNote}${failed.length > 0 ? `，${failed.length} 篇失败` : ''}`,
        detail: failed.slice(0, 3).join('；'),
        ms: NOTIFY_MS.long,
        log: true,
      });
    } else {
      notify({
        kind: 'success',
        text: n === 1 ? `已把「${prop}」改成「${shown}」` : `已改好 ${n} 篇的「${prop}」`,
        ms: NOTIFY_MS.light,
        log: true,
      });
    }
    this.refresh();
  }

  async changeTags(entries: NoteEntry[], add: string[], remove: string[]): Promise<void> {
    if (entries.length === 0 || (add.length === 0 && remove.length === 0)) return;
    const n = entries.length;
    const parts: string[] = [];
    if (add.length > 0) parts.push(`加「${add.join('、')}」`);
    if (remove.length > 0) parts.push(`删「${remove.join('、')}」`);
    if (n > 1) {
      const res = await confirm({
        title: `即将给 ${n} 篇${parts.join('、')}`,
        preview: [{ kind: 'tag', add, remove, count: n }],
        warnings: [],
        notes: [],
        primary: { label: `改 ${n} 篇的标签` },
      });
      if (res.action !== 'primary') return;
    }
    let ok = 0;
    let skipped = 0;
    for (const e of entries) {
      const cur = asList(e.props['tags']).map((t) => t.replace(/^#/, ''));
      const next = Array.from(new Set([...cur.filter((t) => !remove.includes(t)), ...add]));
      try {
        // 守卫跳过不算改成功（同 setProp；独立审查 🟡1）
        const r = await this.ctx.fm.setMany(e.file, { tags: next });
        if (r.skipped.length === 0) ok += 1;
        else skipped += 1;
      } catch (err) {
        console.error('[经纬] 改标签失败', e.path, err);
      }
    }
    notify({
      kind: ok === n ? 'success' : 'partial',
      text:
        ok === n
          ? `已${parts.join('、')}`
          : `${ok}/${n} 篇改成功${skipped > 0 ? `（${skipped} 篇跳过：前言里有嵌套映射）` : ''}`,
      ms: NOTIFY_MS.light,
      log: true,
    });
    this.refresh();
  }

  /** 隐藏 / 取消隐藏（属性 `隐藏: true`；单篇直接改，多篇走确认流） */
  async setHidden(entries: NoteEntry[], hidden: boolean): Promise<void> {
    const n = entries.length;
    if (n === 0) return;
    if (n > 1) {
      const res = await confirm({
        title: `即将${hidden ? '隐藏' : '取消隐藏'} ${n} 篇笔记`,
        preview: [
          { kind: 'set', prop: '隐藏', from: summarize(entries.map(() => hidden ? '否' : '是')), to: hidden ? '是' : '否', count: n },
        ],
        warnings: [],
        notes: [],
        primary: { label: `${hidden ? '隐藏' : '取消隐藏'} ${n} 篇` },
      });
      if (res.action !== 'primary') return;
    }
    let ok = 0;
    let skipped = 0;
    for (const e of entries) {
      try {
        // 守卫跳过不算改成功（独立审查 🟡1）
        const r = await this.ctx.fm.setMany(e.file, { 隐藏: hidden });
        if (r.skipped.length === 0) ok += 1;
        else skipped += 1;
      } catch (err) {
        console.error('[经纬] 改隐藏失败', e.path, err);
      }
    }
    notify({
      kind: skipped > 0 ? 'partial' : 'success',
      text: `已${hidden ? '隐藏' : '取消隐藏'} ${ok} 篇${skipped > 0 ? `，${skipped} 篇跳过（前言里有嵌套映射）` : ''}`,
      ms: skipped > 0 ? NOTIFY_MS.long : NOTIFY_MS.light,
      log: true,
    });
    this.refresh();
  }

  /**
   * 收藏 / 取消收藏（属性 `收藏: true`，P7.2a §1.2 —— 首页「收藏夹」的取数依据）。
   * 形状与 `setHidden` 完全同款（单篇直接改；多篇走确认流、分支留着与它对称）。
   * 当前入口 = 笔记右键「其他」组的第一项。
   */
  async setFav(entries: NoteEntry[], fav: boolean): Promise<void> {
    const n = entries.length;
    if (n === 0) return;
    if (n > 1) {
      const res = await confirm({
        title: `即将${fav ? '收藏' : '取消收藏'} ${n} 篇笔记`,
        preview: [
          {
            kind: 'set',
            prop: '收藏',
            from: summarize(entries.map(() => (fav ? '否' : '是'))),
            to: fav ? '是' : '否',
            count: n,
          },
        ],
        warnings: [],
        notes: [],
        primary: { label: `${fav ? '收藏' : '取消收藏'} ${n} 篇` },
      });
      if (res.action !== 'primary') return;
    }
    let ok = 0;
    let skipped = 0;
    for (const e of entries) {
      try {
        // 守卫跳过不算改成功（与 setProp / setHidden 同口径）
        const r = await this.ctx.fm.setMany(e.file, { 收藏: fav });
        if (r.skipped.length === 0) ok += 1;
        else skipped += 1;
      } catch (err) {
        console.error('[经纬] 改收藏失败', e.path, err);
      }
    }
    notify({
      kind: skipped > 0 ? 'partial' : 'success',
      text: `已${fav ? '收藏' : '取消收藏'} ${ok} 篇${skipped > 0 ? `，${skipped} 篇跳过（前言里有嵌套映射）` : ''}`,
      ms: skipped > 0 ? NOTIFY_MS.long : NOTIFY_MS.light,
      log: true,
    });
    this.refresh();
  }

  // ── 删除到回收站（危险项：两下确认）──────────────────────────
  /**
   * **快速删除**（P7.1c · 2.3 的 `Del` 键；E1 拍：两个档同一入口）。
   *
   * 安全语义（**2.3 已拍板**，别在此处放宽）：
   *   · `trashOption() === 'local'` → **直删**（跳过确认流）——它可还原：库内 `.trash`
   *     可程序化拿回 + 撤销条 + 快照三重兜底（与拖拽搬文件"即时生效"同一档待遇）；
   *   · `system` / `none` → **必须走现有两下确认流**（`none` 会在流里写明
   *     "先去设置里改成移入回收站"）——`system` 进系统回收站，程序化拿不回来。
   *
   * ⚠️ 菜单里两处「删除（移入回收站）」（单篇 / 批量「更多」）**行为不动**（仍走两下确认）。
   */
  async trashQuick(entries: NoteEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (this.ctx.mover.trashOption() !== 'local') {
      await this.trash(entries);
      return;
    }
    const n = entries.length;
    const result = await this.ctx.mover.trash({
      files: entries.map((e) => e.file),
      source: 'batch',
      reason: `删除 ${n} 篇笔记（Del）`,
    });
    if (result.trashed.length > 0) this.undoForTrash(result);
    this.refresh();
  }

  async trash(entries: NoteEntry[]): Promise<void> {
    const n = entries.length;
    if (n === 0) return;
    const option = this.ctx.mover.trashOption();
    const res = await confirm({
      title: `即将删除 ${n} 篇笔记`,
      preview: [{ kind: 'delete', where: option === 'local' ? '库内 .trash' : '回收站', count: n }],
      warnings: [],
      notes: [],
      danger: {
        confirmLabel: '再点一次确认',
        irreversible: option !== 'local',
        disableReason:
          option === 'none'
            ? 'Obsidian 的「删除文件」设置是「不删除」——先去设置里改成移入回收站'
            : undefined,
      },
      primary: { label: `删除 ${n} 篇` },
    });
    if (res.action !== 'primary') return;
    const result = await this.ctx.mover.trash({
      files: entries.map((e) => e.file),
      source: 'batch',
      reason: `删除 ${n} 篇笔记`,
    });
    if (result.trashed.length > 0) this.undoForTrash(result);
    this.refresh();
  }

  // ── 撤销条（动库成功后才出现，5 秒）──────────────────────────
  /**
   * ⚠️ 「搬完弹条 + 撤销走快照还原 + 过期给条出路」这一整套**搬去了
   * `ui/undo-move.ts`**（P6 段⑥）：`editor-menu` 那条（当时的「按规则归位这一篇」）
   * 是第 N 个 "会搬文件"的入口，而 §8.5 要求它"与手工那条**完全同一套**" ——
   * 那就不该是"抄得像"，该是同一份代码。这里只剩"本屏的口径"（`refresh`）。
   */
  private undoDeps(): UndoMoveDeps {
    // P7.16b：实现搬去模块级 `undoDepsOf`（共享链那条撤销条也要它），口径一字不变
    return undoDepsOf(this.ctx, this.refresh);
  }

  private undoForMove(res: MoveResult): void {
    showMoveUndo(this.undoDeps(), res);
  }

  /** 删除那条**不是**搬：文案不同（`每` vs `篇`、进回收站 vs 移动），所以另写一条 */
  private undoForTrash(res: TrashResult): void {
    showUndo({
      text: `已删除 ${res.trashed.length} 篇笔记`,
      detail: res.reversible ? '进了库内 .trash' : '进了系统回收站（快照里还有原文）',
      onUndo: () => void restoreNow(this.undoDeps(), res.snapshotId),
      onView: () => void this.ctx.report.openLatest(),
      onExpire: () => this.expireNotice(res.snapshotId),
    });
  }

  private expireNotice(snapshotId: string): void {
    notify({
      kind: 'info',
      text: '撤销条已过期',
      detail: '仍可在快照面板里还原',
      ms: NOTIFY_MS.long,
      actions: [{ label: '打开快照面板', run: () => this.ctx.openSnapshotPanel() }],
    });
    void snapshotId;
  }
}

/** 一批笔记的总大小（快照面板/确认流里显示占用用） */
export function totalSize(entries: NoteEntry[]): string {
  return formatBytes(entries.reduce((sum, e) => sum + (e.size || 0), 0));
}

// ────────────────────────────────────────────────────────────────
// 模块级共享链（P7.16b）—— 「选目录 = 搬 + 写声明」那一整条的唯一实现
//
// 为什么抽出来：三处编辑面（小窗选择器 / 全部笔记右键 / **原生属性面板那一格**）要求
// "完全同一条链"，而原生面板那个新面在 `ui/` 层 —— 它**不 import 上面那个类**
// （类要 `ctx` + `refresh` 两样它给不出），import 的是这几个函数。
// `NotesOps` 的同名方法改成调它们（薄壳，行为一字不变）。
// ────────────────────────────────────────────────────────────────

/** 撤销条依赖（模块级；类那边 `undoDeps()` 的整段原样搬来，一个字没改） */
function undoDepsOf(ctx: WorkbenchContext, refresh?: () => void): UndoMoveDeps {
  return {
    restore: (id) => ctx.snapshot.restore(id),
    openLatest: () => ctx.report.openLatest(),
    openSnapshotPanel: () => ctx.openSnapshotPanel(),
    onRestored: () => refresh?.(),
  };
}

/** 搬完弹撤销条（模块级薄壳） */
function showMoveUndoFor(ctx: WorkbenchContext, refresh: (() => void) | undefined, res: MoveResult): void {
  showMoveUndo(undoDepsOf(ctx, refresh), res);
}

/**
 * **搬一批（模块级）** = `mover` + 撤销条 + 刷新 —— `NotesOps.moveNow` 的原实现整段搬来。
 * ⚠️ P7.18b 起：搬完的"声明跟随（未声明的也写）"统一由 **`mover` 第 7 步**做 ——
 * 本法与调用方都不再各自补写（旧的 `declareLandingsAfterMove` 已删）。
 */
export async function runMoveNow(
  ctx: WorkbenchContext,
  entries: NoteEntry[],
  dir: string,
  /** `board` 是 P4 加的：看板里跨板块拖 = 搬文件，日志要能分清是从哪一屏发起的 */
  source: 'drag' | 'batch' | 'board',
  reason: string,
  refresh?: () => void,
): Promise<MoveResult | null> {
  const files = entries.map((e) => e.file).filter((f) => f instanceof TFile);
  if (files.length === 0) return null;
  const res = await ctx.mover.move({
    targets: [{ dir: absDir(ctx, dir), files }],
    source,
    reason,
    quiet: true, // 撤销条在（下面 showMoveUndoFor）→ 不弹重复通知
  });
  if (res.error) return res; // mover 已经弹了"操作已中止"
  if (res.moved.length > 0) showMoveUndoFor(ctx, refresh, res);
  refresh?.();
  return res;
}

/**
 * **改「文件位置」声明 = 直接搬**（v2 · #12 的口径；P7.15 · #3 把入口做成"选目录"）。
 *
 * 调用方（小窗属性区的目录选择器 / 右键「属性 › 文件位置」的子菜单 /
 * 原生属性面板那一格的菜单）已经拿到"去哪儿"，这里负责**一次操作、两条后果保持一致**：
 *   · **搬**走确认流 → `mover.move` → 快照 + 撤销条 + 日志（`runMoveNow`）；
 *   · **声明**由 `mover` 第 7 步的「属性跟随」写成**实际落点**（`mover.ts` 那条：
 *     "显式搬动就是改主意"）——所以这里**不需要**另写一次声明，也就没有
 *     "搬成了、声明没改" 的中间态（那是「位置不一致」假红的唯一来源）。
 *
 * 🔴 **补声明（P7.16b · 用户 2026-10-08 晚拍；P7.18b 起并入 `mover`）**：**"选目录"这条路对
 * 未声明的笔记也要写声明**（选中 = 搬 + 「文件位置」写成实际落点）——**2026-10-09 用户拍板把
 * 这条口径上收进 `mover` 第 7 步**（"任何搬动之后，声明 = 实际落点"），本链于是**不再需要
 * 专属收尾**（旧的 `declareLandingsAfterMove` 已删 —— "两处各写一份必漂"，一处写全）。
 *
 * 为什么不去 `setProp` 那条路：`setProp` 只写声明、**不搬**（属性编辑器的通用语义）；
 * 而用户要的是"换了位置就真过去"。两条路的区别写在这儿，别混。
 */
export async function runSetPositionByMove(
  ctx: WorkbenchContext,
  entries: NoteEntry[],
  dir: string,
  reason?: string,
  refresh?: () => void,
): Promise<void> {
  if (entries.length === 0) return;
  const n = entries.length;
  const to = dir || '库根';
  const preview: PlanRow[] = [
    {
      kind: 'move',
      from: summarize(entries.map((e) => e.effectivePosition || '库根')),
      to,
      count: n,
      chip: { text: '文件位置同步为实际落点' },
    },
  ];
  const res = await confirm({
    title: `即将把 ${n} 篇的「文件位置」改成「${to}」并搬过去`,
    preview,
    // 撞名要 mover 真去读了才知道（它比内容 sha256）→ 不预告，结果通知里说清
    warnings: [],
    notes: lockNotice(entries.map((e) => e.props)),
    primary: { label: `搬到「${to}」` },
  });
  if (res.action !== 'primary') return;
  // 声明跟随（含未声明篇补写）都在 mover 第 7 步里 —— 这里不另写（P7.18b）
  await runMoveNow(ctx, entries, dir, 'batch', reason ?? `改「文件位置」→ ${to}`, refresh);
}

/**
 * **「就住这儿（写声明，不搬）」/「现处 X（写回当前位置）」**（P7.16 · #2b 起；
 * **P7.18b 起菜单里两项共用本函数** —— 用户 2026-10-09 拍板并列）——
 * 把「文件位置」写成**实际位置**（库根写 `.`），文件一个字节不动。
 *
 * 菜单里的两个入口（`menus.positionItems`）都落到这里：
 *   · 「就住这儿（写声明，不搬）」—— **未声明**时出现（"安顿"：别让它飘着）；
 *   · 「现处 X（写回当前位置）」—— **任何状态可点**（"恢复/纠偏"：把被删掉的值补回、
 *     或把错位的声明纠回现处——已一致时点是幂等重写）。
 *
 * 两条分工别混：
 *   · `runSetPositionByMove` = "选哪儿搬哪儿"（**改主意**：确认流 → mover → 声明跟随）；
 *   · 本法 = "把我现在待的地方写进声明"（**补声明**：确认流 → `fm.setMany` 一个键）。
 * 都过 `ui/confirm.ts`（硬规矩之三）。⚠️ 写盘走 `fm.setMany`（正常前言路径；
 * 坏前言那族有自己的修前言流程，别混）——没有 mover、也没有撤销条：改错了
 * 再选一次覆盖即可（就一个属性键的轻重）。
 */
export async function runDeclarePositionHere(
  ctx: WorkbenchContext,
  entries: NoteEntry[],
  refresh?: () => void,
): Promise<void> {
  if (entries.length === 0) return;
  const n = entries.length;
  const to = entries[0].effectivePosition || '库根';
  /**
   * 现在声明的是什么（错位/未声明都要如实显示 —— "现处"项不止用来补空值）。
   * ⚠️ **声明在库根要显示「库根」**（独立审 🟡1）：`declaredPositions` 把 `.` 归一成空串，
   * 不能把"声明了库根"误标成"未声明"。
   */
  const ders = declaredPositions(entries[0].props);
  const cur = ders.length > 0 ? ders[0] || '库根' : '';
  const preview: PlanRow[] = [
    {
      kind: 'set',
      prop: '文件位置',
      from: cur !== '' ? cur : '（未声明）',
      to,
      count: n,
    },
  ];
  const res = await confirm({
    title: `把「文件位置」声明在「${to}」（只写声明、不动文件）？`,
    preview,
    warnings: [],
    notes: [
      '只写声明、不动文件 —— 这一篇就留在原处',
      '声明之后：整理建议里"缺文件位置"的候选会少这一篇，归位也不会再问它该去哪',
    ],
    // 一个属性键的轻重，不动文件 —— 不进快照（照 session-actions 那条的自定义文案口径）
    snapshot: '只改一个属性键（不动文件），不进快照',
    primary: { label: '只写声明' },
  });
  if (res.action !== 'primary') return;
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of entries) {
    const rel = e.effectivePosition;
    try {
      // 库根写 `.`（ROOT_POS）—— 与 mover 的属性跟随 / 顶层新建同一表示法（P7.15 口径）
      const r = await ctx.fm.setMany(e.file, { 文件位置: rel ? [rel] : [ROOT_POS] });
      if (r.skipped.length === 0) ok += 1;
      else skipped += 1;
    } catch (err) {
      // 独立审 🟡：这条链原先"全失败也一声不吭"（旧入口在右键菜单上，竞态里那一篇
      // 可能刚被搬走/删掉）——照 `setProp` 的口径计数并报出来，别让用户"点了没反应"
      failed += 1;
      console.error('[经纬] 写「文件位置」声明失败', e.path, err);
    }
  }
  if (ok > 0 || failed > 0) {
    notify({
      kind: ok === n && failed === 0 ? 'success' : 'partial',
      text:
        ok === n && failed === 0
          ? `已把「文件位置」声明在「${to}」`
          : `${ok}/${n} 篇声明成功${skipped > 0 ? `，${skipped} 篇跳过（前言里有嵌套映射）` : ''}${failed > 0 ? `，${failed} 篇失败` : ''}`,
      detail: failed > 0 ? '失败的多半是刚被别处搬走/删掉的篇' : undefined,
      // 有跳过的说明要看得到（§1.3：部分成功 6s —— 与 setProp 同一档）
      ms: ok === n && failed === 0 ? NOTIFY_MS.light : NOTIFY_MS.long,
      log: true,
    });
  }
  /**
   * ⚠️ `ok === 0 && skipped > 0 && failed === 0` 时**不再补通知** —— 守卫
   * （`fm.guardFragile`）自己已经弹过 partial 了，这里再说一句就是同屏打架
   * （独立审查 🟡1 的老口径）。
   */
  refresh?.();
}
