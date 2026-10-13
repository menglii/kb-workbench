/**
 * modules/notes/menus.ts —— 全部笔记的三套菜单（**全部走 `ui/menu.ts`**）
 *
 * 交互规格 §8.2 / §8.3 / §3.4：
 *   · 笔记行菜单：5 组 + 危险项（**组进子菜单**，因为三条硬规矩之二是"一级最多 8 项"，
 *     照抄 §8.3 的表格平铺是 14 项，一定违规）
 *   · 目录节点菜单（P7.23 重排为 7 项）：在此新建笔记 / 在此新建目录 / 展开子目录 /
 *     完全展开（含所有子文件夹与文件）/ 收起此文件夹 / 在系统资源管理器中打开 / 重排库结构…
 *   · 批量栏「更多」：复制路径 / 在系统资源管理器中显示 / 隐藏 / 删除到回收站
 *
 * 两条纪律：
 *  ① **不可用项置灰并写出原因**（Windows 手感），不隐藏、不用 notYet 弹一下了事
 *  ② 值/候选都从 `services/schema.ts` 与索引聚合来，**不在这里抄第二份值域**
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { baseName, joinPath, parentDir, relativeTo } from '../../core/paths';
import { showContextMenu, showMenu, type MenuHandle, type MenuItem, type MenuSpec } from '../../ui/menu';
import type { HeaderMenuInfo } from '../../ui/table';
import { kbDirs, openNewNoteDialog } from '../../ui/new-note';
import { actionOf, captureTargets, noteTargets } from '../board/capture';
import type { BoardConfig } from '../board/config';
import { isHomePinned, toggleHomePin } from '../home/pin';
import { openNewFolderDialog } from '../../ui/new-folder';
import { openRebuildPanel } from '../../ui/rebuild-panel';
import { confirm } from '../../ui/confirm';
import { promptText } from '../../ui/prompt';
import { createReviewCardFlow } from '../../ui/review-create';
import { runReviewGen } from '../../ui/review-gen';
import { sanitize } from '../../services/completion';
import { PROP_ORDER, SPEC_BY_NAME, asBool, asList, asString, declaredPositions } from '../../services/schema';
import { NOTIFY_MS, notify, notifyError, notifyLight } from '../../ui/notify';
import { restoreOrNotify, showUndo } from '../../ui/undo-bar';
import { showMoveUndo, type UndoMoveDeps } from '../../ui/undo-move';
import { openSnapshotPanel } from '../../ui/snapshot-panel';
import { buildTreeFromVault, type TreeNode } from './tree';
import type { NotesOps } from './ops';
import { dateTokenOf } from './filters';

export interface MenuCtx {
  ctx: WorkbenchContext;
  ops: NotesOps;
  /** 表里就地改名（输入的活儿在表格那边，菜单只负责发起） */
  onRename: (entry: NoteEntry) => void;
  /** 目录树：展开**一层**（P7.23「展开子目录」：本目录 + 直接子目录） */
  onExpandOne: (dir: string) => void;
  /** 目录树：**完全展开**（P7.23 升格：递归 + 整棵子树列文件行；原「展开全部子目录」） */
  onExpandAll: (dir: string) => void;
  /** 目录树：**收起此文件夹**（P7.23 · Q3：`open` 只收本节点 + 子树清 `treeShowFiles`） */
  onCollapse: (dir: string) => void;
  /**
   * 目录树：**全部收起**（P7.24 · T3 —— 进目录节点菜单，**只给根画**；空白菜单那条同源）。
   * 口径 = 清 `open`（连 `''` 库根一起收）+ 清 `treeShowFiles`：树只剩「整个知识库」一行。
   */
  onCollapseAll?: () => void;
  /**
   * **进某个目录**（P6b ②：网格文件夹菜单的「进入这个目录」，也是双击的键盘等价物）。
   * 不给就不出现那一行 —— 模块那边的 `openDir` 还会顺带展开目录树到看得见它。
   */
  onOpenDir?: (dir: string) => void;
  /**
   * **看板专用的一组**（P4.5 §4.2）：`上移 / 下移 / 移到别的板块…`。
   * 为什么必须有：WCAG 2.2 的「Dragging Movements」要求**拖拽得有一个非拖拽的等价操作** ——
   * 看板的板块排序早有 ▲▼，卡片排序一直只有拖（~~"拖就行"~~）。
   * 不传这一组就不出现（「全部笔记」那边没有"板块"这个概念，给不了这套语义）。
   */
  board?: BoardMenuHooks;
  /**
   * **把这一篇放进"新的一扇悬浮小窗"**（f 期多悬浮窗）。不传就不出现这一行 ——
   * 只有看板给得了（小窗挂在看板配置上），「全部笔记」那边没有这个概念。
   */
  openFloating?: (entry: NoteEntry) => void;
  /**
   * **"把这一篇所在的窗并进别的窗"**（P6b ③）。
   *
   * 🔴 为什么必须有这一条：合并的**主路径是拖动**（把一扇窗的头拖到另一扇身上），
   * 而 WCAG 2.2 的 Dragging Movements 要求**凡拖动都要有一个非拖动的等价操作** ——
   * 与看板卡片排序的「上移 / 下移」、停靠大小的「窄 / 中 / 宽」是同一批口径。
   * ⚠️ 只有**开着的窗 ≥2 扇**、且这一篇确实在某一扇里时才返回非空（否则不出现这一行）。
   */
  mergeChoices?: (entry: NoteEntry) => { label: string; run: () => void }[];
}

/** 看板卡片的排序/移动钩子（见 `MenuCtx.board` 的说明） */
export interface BoardMenuHooks {
  /** 非空即把两个排序项置灰并显示原因（只读模式那种） */
  sortBlock?: string;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** 候选落点：**除自己所在那块之外**的板块（带不可落的原因） */
  targets: () => { key: string; label: string; disabled?: string }[];
  onMoveTo: (key: string) => void;
  /** 「只排序（不动库）」= `Alt`+拖的等价物（2026-09-25 用户拍板要）：只写顺序表，不搬文件 */
  onSortInto: (key: string) => void;
}

// ────────────────────────────────────────────────────────────────
// 空白处菜单（§8.1 的「全局菜单」—— 在这一屏管的是**整个列表 / 整个目录树**）
// ────────────────────────────────────────────────────────────────
/** 右键发生在哪一块（决定给哪些项） */
export type BlankWhere = 'table' | 'grid' | 'tree';

export interface BlankMenuOpts {
  where: BlankWhere;
  /** 现在的目录（相对库根，'' = 整个知识库）—— 「新建」的落点，也是作用域行写的那句 */
  dir: string;
  /** 「还原显示」：跳转带来的筛选 + 预选中（A3）。不给就不出现这一行 */
  restore?: { run: () => void };
  /** 「清除筛选」：有筛选时才有（与 `restore` 互斥 —— 有跳转筛选就只给"还原"） */
  clearFilters?: () => void;
  /** 目录树：「完全展开（含所有子文件夹与文件）」（P7.23 起 = 递归 + 列文件行） */
  onExpandAll?: (dir: string) => void;
  /** 目录树：「全部收起」 */
  onCollapseAll?: () => void;
  /** 文件夹建好之后（B1）：调用方拿它去"进那个目录"—— 建完就站在里面，是最好的一句回执 */
  onFolderCreated?: (rel: string) => void;
}

/**
 * **空白处右键**（B1，用户 2026-09-27 提："首页和全部笔记中也加入右键菜单，
 * 比如全部笔记里，右键即可新建笔记或文件夹"）。
 *
 * 三条口径：
 *   · 作用域行写清**这次改的是谁**（§8.4 硬规矩 1）：「整个知识库」或那个目录名；
 *   · 一级不超过 8 项（`validateMenuSpec` 会报）；
 *   · 「新建」的落点 = **当前目录**，与工具栏的面包屑一致（别发明第二套导航状态）。
 */
export function showBlankMenu(evt: MouseEvent, m: MenuCtx, o: BlankMenuOpts): void {
  const { ctx } = m;
  const dirLabel = o.dir === '' ? '整个知识库' : o.dir;
  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '在此新建笔记',
      icon: 'file-plus',
      run: () => openNewNoteDialog(ctx, { dirRel: o.dir }),
    },
    {
      kind: 'item',
      label: '新建文件夹',
      icon: 'folder-plus',
      run: () => {
        void openNewFolderDialog(ctx, o.dir).then((rel) => {
          if (rel) o.onFolderCreated?.(rel);
        });
      },
    },
  ];

  if (o.restore) {
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      label: '还原显示',
      icon: 'undo-2',
      run: () => o.restore?.run(),
    });
  } else if (o.clearFilters) {
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      label: '清除筛选',
      icon: 'filter-x',
      run: () => o.clearFilters?.(),
    });
  }

  if (o.where === 'tree') {
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      // P7.23：跟目录节点菜单的新名字对齐（同一份 `onExpandAll` —— 递归 + 列文件行；
      // 旧名「展开全部子目录」只说了递归那一半）
      label: '完全展开（含所有子文件夹与文件）',
      icon: 'chevrons-down',
      run: () => o.onExpandAll?.(o.dir),
    });
    items.push({
      kind: 'item',
      label: '全部收起',
      icon: 'chevrons-up',
      run: () => o.onCollapseAll?.(),
    });
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      label: '重排库结构…',
      icon: 'folder-tree',
      run: () => openRebuildPanel(ctx),
    });
  } else {
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      label: '重新扫描库',
      icon: 'refresh-cw',
      run: () => {
        ctx.index.rebuild();
        notify({ kind: 'info', text: '已重新扫描库', ms: NOTIFY_MS.light });
      },
    });
  }

  showContextMenu(evt, {
    scope: { kind: 'global', label: `全部笔记 · ${dirLabel}`, icon: 'list' },
    items,
  });
}

// ────────────────────────────────────────────────────────────────
// 笔记行菜单（交互规格 §8.3）
// ────────────────────────────────────────────────────────────────
export function showNoteMenu(entry: NoteEntry, evt: MouseEvent, m: MenuCtx): void {
  const { ops } = m;
  const hidden = asBool(entry.props['隐藏']);
  const fav = asBool(entry.props['收藏']);
  const locked = asBool(entry.props['位置锁定']);
  const revealReason = ops.revealBlockReason();
  const fileListReason = ops.fileListBlockReason();
  /** 「丢进板块」的子菜单（P7.2c；空 = 一个能做/值得做的都没有 → 那一行不画） */
  const castItems = boardCaptureItems(m.ctx, m, entry);

  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '打开',
      icon: 'file-text',
      submenu: [
        { kind: 'item', label: '打开', icon: 'file-text', run: () => ops.open(entry, 'current') },
        {
          kind: 'item',
          label: '在新标签页中打开',
          icon: 'external-link',
          run: () => ops.open(entry, 'newTab'),
        },
        {
          /**
           * **分屏**（e 期 §3.3）：在主区分屏，另一半打开笔记 —— 平台自己管尺寸与记忆。
           * 排在新窗口**之前**：分屏是"并排看"的日常动作，新窗口是"挪到另一块屏"。
           * ⚠️ 工作台**不会**因此多出一份（那半边放的是笔记，不是第二个工作台）——
           * 口径见 `ops.ts` 的 `open()` 与 `看板优化方案.md` §6.15。
           */
          kind: 'item',
          label: '在右侧分屏打开',
          icon: 'columns-2',
          run: () => ops.open(entry, 'split'),
        },
        {
          kind: 'item',
          label: '在新窗口中打开',
          icon: 'picture-in-picture',
          run: () => ops.open(entry, 'newWindow'),
        },
        /**
         * **在新悬浮窗中打开**（f 期多悬浮窗）：看板**给了钩子才有这一行**
         *（`MenuCtx.openFloating`）—— 小窗是看板的东西，「全部笔记」那边没有它，
         * 那边不显示（与 `board` 那组钩子同一套做法：不传就不出现）。
         * 放在最后：上面三条是平台标签页/分屏/新窗口，这一条是"工作台自己的小窗"。
         */
        ...(m.openFloating
          ? [
              {
                kind: 'item' as const,
                label: '在新悬浮窗中打开',
                icon: 'app-window',
                run: () => m.openFloating?.(entry),
              },
            ]
          : []),
        /**
         * **拖窗合并的非拖动等价物**（P6b ③ / WCAG 2.2）：这一篇所在的那一扇并进另一扇。
         * 没有第二扇窗时整条不出现（没得可并）。
         */
        ...(() => {
          const choices = m.mergeChoices?.(entry) ?? [];
          return choices.length === 0
            ? []
            : [
                {
                  kind: 'item' as const,
                  label: '并入别的窗…',
                  icon: 'merge',
                  submenu: choices.map((c) => ({
                    kind: 'item' as const,
                    label: c.label,
                    run: c.run,
                  })),
                },
              ];
        })(),
      ],
    },
    /**
     * **「问 AI（这一篇）」**（P7.3c 5.3）—— 一级项，紧挨「打开」。
     *
     * 🔴 **它不直接动库**（5.3 的红线）：动作只有"打开 AI 面板 + 把这一篇作为 `@` 引用带上"。
     * 面板里真要动库，照旧过待确认卡 → `ui/confirm.ts` → `mover`。
     *
     * 两处入口共用这一份实现（「全部笔记」的 `menuCtx()` 与看板卡片那一处都调
     * `showNoteMenu`）—— 不在 `MenuCtx` 上加钩子：两个屏要的东西**一模一样**，
     * 加钩子只会多一处"某屏忘了传"的可能。
     */
    {
      kind: 'item',
      label: '问 AI（这一篇）',
      icon: 'sparkles',
      run: () =>
        m.ctx.openAi('', [
          // ⚠️ `path` 是库内绝对路径（脚本口径）；显示一律用 title（同 `AiRef` 的约定）。
          // ⚠️ `entry.basename` **已无扩展名**（Obsidian 语义）—— 别再 stripExt：
          // 那会把「9.16」剥成「9」（P7.10 修，全仓同款）
          { kind: 'note', path: entry.path, title: entry.basename },
        ]),
    },
    /**
     * **回顾卡 ›**（P8）：两条入口合成**一个子菜单** —— 手动写 / 让 AI 出稿。
     *
     * 为什么不各占一级：笔记菜单一级有"最多 8 项"的硬规矩（`tests/specs/notes.ts`
     * 数的是 `.kbw-menu-item`）。
     * 仓里的口径写在 `ui/menu.ts` 头注：「一项决定一件事 + **长菜单要有台阶**……
     * 超过软目标就必须有分组（分隔线），**或把同类项收进子菜单**」—— 这两条本来就是
     * 同一件事的两半（给同一篇派生问答卡），收进一个台阶最贴。
     *
     * ⚠️ 子菜单里的项**要点开父项才进 DOM**（探针那步因此要点两下；离线用例同理）。
     */
    {
      kind: 'item',
      label: '回顾卡',
      icon: 'repeat',
      submenu: [
        {
          kind: 'item',
          label: '生成回顾卡',
          icon: 'repeat',
          /**
           * 已有的张数用**同步缓存**读（右键菜单在 contextmenu 那一帧就得画出来，
           * `read()` 异步来不及；缓存没热过 = 不显示这个提示，不硬造一份）。
           * ⚠️ `review` 取不到时同样**不显示**（右键菜单有拿"局部 ctx"直接调的契约用例 ——
           * 画菜单这一步不该因为某个模块的依赖缺席而炸）。
           */
          hint: (() => {
            const rv = m.ctx.review;
            const n = rv ? rv.cardsOf(rv.cached(), entry.path).length : 0;
            return n > 0 ? `已有 ${n} 张` : undefined;
          })(),
          run: () => void createReviewCardFlow(m.ctx, entry.path),
        },
        {
          kind: 'item',
          label: '用 AI 生成',
          icon: 'sparkles',
          run: () => {
            const f = m.ctx.app.vault.getAbstractFileByPath(entry.path);
            if (!(f instanceof TFile)) {
              notifyError('这篇不在库里了', '刷新一下再看');
              return;
            }
            void runReviewGen(m.ctx, f);
          },
        },
      ],
    },
    {
      kind: 'item',
      label: '改',
      icon: 'pencil',
      submenu: [
        { kind: 'item', label: '重命名…', icon: 'text-cursor-input', run: () => m.onRename(entry) },
        {
          kind: 'item',
          label: '移动到…',
          icon: 'folder-input',
          /**
           * **树形子菜单**（2.7 · G1-a 已拍"提前"，P7.1c 落地）：与批量迁移**完全同一份实现**
           *（`migrateItems`）—— 死选项（"选中集全在候选目录"）与树形结构都现成。
           * 换掉了原先的"菜单内文本框"（§8.3 那行已回改）。
           * ⚠️ 口径两条：① 单篇**不走确认流**（§9 的"走确认流"那栏列的全是批量动词，
           * 见 `ops.ts` 头注）；② 树列**真实目录**（P7.15 · #2 起含空目录 —— 与目录树 /
           * 网格文件夹格同源；旧的"只列有笔记的目录"口径已反转）。
           */
          submenu: migrateItems(m, [entry], (dir) =>
            void ops.moveNow([entry], dir, 'batch', `移动到 ${dir || '库根'}`),
          ),
        },
        /**
         * **「丢进板块」**（P7.2c · 1.3-d；Q4 拍板放「改」组、"移动到…"之后 ——
         * 它干的就是"搬到目录 / 加标签 / 改属性"之一）。
         *
         * 三条口径：
         *  · **与快速捕获同一份** `captureTargets`（两处算两遍必漂）；这里的过滤见
         *    `capture.ts` 的 `noteTargets`（shelter / 没取值的属性源 / 对这篇没用的不画）；
         *  · 一个能做的都没有（或配置还没热进缓存）→ **整行不画**（与"并入别的窗…"同款）；
         *  · 三种源各走**既有链路**：folder→`moveNow`（即时生效 + 撤销条，同「移动到…」）、
         *    tag→`changeTags`（并集）、prop→`setProp`（覆盖）——**没有新的写盘路径**。
         */
        ...(castItems.length > 0
          ? [
              {
                kind: 'item' as const,
                label: '丢进板块',
                icon: 'package',
                submenu: castItems,
              },
            ]
          : []),
        { kind: 'item', label: '属性', icon: 'sliders-horizontal', submenu: propertyGroups(entry, m) },
        { kind: 'item', label: '加标签', icon: 'tags', submenu: tagItems(m, entry) },
      ],
    },
    {
      kind: 'item',
      label: '位置',
      icon: 'map-pin',
      submenu: [
        {
          kind: 'item',
          label: '位置锁定',
          icon: 'lock',
          control: { type: 'toggle', checked: locked },
          stay: true,
          run: (c) => void ops.setProp([entry], '位置锁定', Boolean(c.value)),
        },
        {
          kind: 'item',
          label: '在系统资源管理器中显示',
          icon: 'folder-open',
          disabled: revealReason ?? undefined,
          run: () => void ops.revealInExplorer(entry),
        },
        {
          kind: 'item',
          label: '在文件列表中显示',
          icon: 'list-tree',
          disabled: fileListReason ?? undefined,
          run: () => ops.revealInFileList(entry),
        },
      ],
    },
    {
      kind: 'item',
      label: '复制',
      icon: 'copy',
      submenu: [
        { kind: 'item', label: '复制路径', icon: 'link', run: () => ops.copyPaths([entry]) },
        { kind: 'item', label: '复制双链', icon: 'brackets', run: () => ops.copyLinks([entry]) },
      ],
    },
    {
      kind: 'item',
      label: '其他',
      icon: 'more-horizontal',
      submenu: [
        /**
         * P7.2a §1.2（M1 收藏夹的配套入口）：切换 `收藏: true` ——
         * 首页「收藏夹」取的正是它。与「隐藏这篇」同组（都是"标记这类小状态"）。
         */
        {
          kind: 'item',
          label: fav ? '取消收藏' : '收藏',
          icon: 'star',
          run: () => void ops.setFav([entry], !fav),
        },
        /**
         * P7.2d（16.9-b）：钉到首页 / 取消钉 —— 首页「钉住的笔记」块的入口。
         * 与「收藏」同族（都是"标记这类小状态"），落在它旁边（Q2 拍板的位置）。
         * 数据走 `settings.homeCards`（本机偏好，**不动这篇笔记**）；上限 6、
         * 到顶只通知不顶旧的 —— 全在 `toggleHomePin` 里。
         */
        {
          kind: 'item',
          label: isHomePinned(m.ctx, entry.path) ? '取消钉' : '钉到首页',
          icon: 'pin',
          run: () => toggleHomePin(m.ctx, entry.path),
        },
        {
          kind: 'item',
          label: hidden ? '取消隐藏' : '隐藏这篇',
          icon: hidden ? 'eye' : 'eye-off',
          run: () => void ops.setHidden([entry], !hidden),
        },
      ],
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '删除（移入回收站）',
      icon: 'trash',
      danger: true,
      run: () => void ops.trash([entry]),
    },
  ];

  /**
   * 看板那一组插在「打开」后面（§4.2）：它是**拖拽的等价操作**，
   * 藏太深等于没做；但也不是每分钟都用，所以整组收在一个子菜单里。
   */
  if (m.board) {
    const b = m.board;
    const targets = b.targets();
    items.splice(1, 0, {
      kind: 'item',
      label: '在这一块里',
      icon: 'move-vertical',
      submenu: [
        {
          kind: 'item',
          label: '上移一位',
          icon: 'arrow-up',
          disabled: b.sortBlock,
          run: () => b.onMoveUp(),
        },
        {
          kind: 'item',
          label: '下移一位',
          icon: 'arrow-down',
          disabled: b.sortBlock,
          run: () => b.onMoveDown(),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: '移到别的板块',
          icon: 'folder-input',
          submenu:
            targets.length === 0
              ? [{ kind: 'item', label: '（没有别的板块）', disabled: '看板上只有这一块' }]
              : targets.map((t) => ({
                  kind: 'item' as const,
                  label: t.label,
                  disabled: t.disabled,
                  run: () => b.onMoveTo(t.key),
                })),
        },
        {
          // `Alt`+拖的等价物（用户 2026-09-25 拍板）：只排序不搬文件 —— 数据源是标签/属性值时
          // 「移到…」会真的改属性，这一项则**一个字都不动库**
          kind: 'item',
          label: '只排序（不动库）',
          icon: 'arrow-right-left',
          disabled: b.sortBlock,
          submenu:
            targets.length === 0
              ? [{ kind: 'item', label: '（没有别的板块）', disabled: '看板上只有这一块' }]
              : targets.map((t) => ({
                  kind: 'item' as const,
                  label: t.label,
                  disabled: t.disabled,
                  run: () => b.onSortInto(t.key),
                })),
        },
      ],
    });
  }

  showContextMenu(evt, { scope: { kind: 'note', label: entry.basename, icon: 'file-text' }, items });
}

// ────────────────────────────────────────────────────────────────
// 「丢进板块」（P7.2c · 1.3-d）—— 与快速捕获同一份落点解析
// ────────────────────────────────────────────────────────────────
/** 三种源各走哪个动作（与 `capture.ts` 的 `actionOf` 一一对应；右侧那行小字） */
const CAPTURE_HINT: Record<'move' | 'tag' | 'prop', string> = {
  move: '搬过去',
  tag: '加标签',
  prop: '改属性',
};

/**
 * 笔记右键「丢进板块 ›」的子菜单项。
 *
 * ⚠️ **读的是配置的同步缓存**（`configs.cached`）：右键菜单在 `contextmenu` 那一帧
 * 就得画出来，`read()` 那点异步来不及；没热过就 `null` → 返回空 → 那一行不画
 * （插件 onload 那一句预热之后基本不可能走到这 —— 详见 `main.ts` 与 `configs.cached`）。
 */
function boardCaptureItems(ctx: WorkbenchContext, m: MenuCtx, entry: NoteEntry): MenuItem[] {
  const cfg = ctx.configs.cached<BoardConfig>('board');
  if (!cfg) return [];
  const dirs = kbDirs(ctx);
  const inbox = dirs.includes('00_Inbox') ? '00_Inbox' : '';
  const targets = captureTargets(cfg, { inbox, valuesOf: (p) => ctx.index.valuesOf(p) });
  const usable = noteTargets(targets, {
    dirRel: entry.effectivePosition,
    tags: asList(entry.props['tags']).map((t) => String(t)),
    props: entry.props,
  });
  return usable.map((t) => {
    const act = actionOf(t.kind);
    return {
      kind: 'item' as const,
      label: t.label,
      hint: act ? CAPTURE_HINT[act] : undefined,
      run: () => {
        if (act === 'move') void m.ops.moveNow([entry], t.dirRel, 'batch', `丢进「${t.label}」`);
        else if (act === 'tag') void m.ops.changeTags([entry], t.tags, []);
        else if (act === 'prop') {
          for (const [k, v] of Object.entries(t.props)) void m.ops.setProp([entry], k, v);
        }
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────
// 属性 ›（值域来自 schema；列表型给多选、只读项置灰）
// ────────────────────────────────────────────────────────────────
const PROP_GROUPS: { label: string; props: string[] }[] = [
  { label: '核心', props: ['类型', '状态'] },
  { label: '定位', props: ['文件位置', '位置锁定', '隐藏'] },
];

function propertyGroups(entry: NoteEntry, m: MenuCtx): MenuItem[] {
  const out: MenuItem[] = [];
  const others = PROP_ORDER.filter(
    (n) => !PROP_GROUPS.some((g) => g.props.includes(n)) && n !== 'tags' && n !== '创建日期',
  );
  const groups = [...PROP_GROUPS];
  if (others.length > 0) groups.push({ label: '其他', props: others });
  groups.push({ label: '只读', props: ['创建日期'] });

  for (const g of groups) {
    out.push({
      kind: 'item',
      label: g.label,
      submenu: g.props.map((name) => {
        const spec = SPEC_BY_NAME[name];
        if (spec?.readOnly) {
          return {
            kind: 'item' as const,
            label: name,
            icon: 'lock',
            disabled: '只读（不允许手改）',
          };
        }
        const current = entry.props[name];
        const label = `${name}：${currentLabel(name, current)}`;
        /**
         * 🔴 **「文件位置」那一格换"目录选择器"**（P7.15 · #3，与 Q3 拍定一致：
         * 小窗属性区 + 右键这两处**同一份口径**，免得两处两制）。
         *
         * 与别的属性的区别：它是**声明**，改它就是"改主意去哪"——选中 = 真搬过去
         * （确认流 → mover → 快照 + 撤销条；声明由 mover 的属性跟随同步）。
         * 旧实现在这儿给的是**当前值本身**（点了只能再选它自己，等于空操作）。
         */
        if (name === '文件位置') {
          return {
            kind: 'item' as const,
            label,
            submenu: positionItems(
              m.ctx,
              entry,
              (dir) => void m.ops.setPositionByMove([entry], dir),
              // 「就住这儿（写声明，不搬）」（P7.16 · #2b）——与选择器那条同一份口径
              () => void m.ops.declarePositionHere([entry]),
            ),
          };
        }
        return {
          kind: 'item' as const,
          label,
          submenu: valueItems(name, current, (v) => void m.ops.setProp([entry], name, v)),
        };
      }),
    });
  }
  return out;
}

/**
 * **「文件位置」的取值子菜单 = 目录选择器**（P7.15 · #3）。
 *
 * 与 `valueItems` 的区别是**语义**：那一份是"写个值"（`setProp`，只写声明）；
 * 这一份是"选哪儿就搬哪儿"（`onPick` → `ops.setPositionByMove` —— 确认流 + mover +
 * 声明同步）。候选 = **现算的真实目录**（`kbDirs`，与落点下拉/目录树同一份口径，
 * 新建目录立刻在列、不缓存）。
 *
 * 三条边界：
 *   · 现在待的地方 → **P7.18b 起并列两项**（用户 2026-10-09 拍板）：
 *     ①「就住这儿（写声明，不搬）」—— **未声明**时出现（"安顿"入口）；
 *     ②「现处 X（写回当前位置）」—— **任何状态可点**（"恢复"入口：补上被删掉的值 /
 *     把错位的声明纠回现处；已一致时点是幂等重写）。两项都落到 `onDeclare`
 *     （`runDeclarePositionHere` —— 写声明不搬文件）。旧行为（一律置灰"它就在这儿"）
 *     只在 `onDeclare` 没传时兜底（防御性旧调用方兼容）；
 *   · 库根 → 第一项（`dir=''`），显示名「库根」；
 *   · 一级最多 8 项那条**不适用于子菜单**（子菜单本来就长，批量迁移那份也是全列）。
 */
export function positionItems(
  ctx: WorkbenchContext,
  entry: NoteEntry,
  onPick: (dir: string) => void,
  /** 「就住这儿」/「现处」那两项的去向（P7.16 · #2b）。不传就退回旧的置灰样（防御性旧调用方兼容） */
  onDeclare?: () => void,
): MenuItem[] {
  const out: MenuItem[] = [];
  const declared = declaredPositions(entry.props);
  const undeclared = declared.length === 0;
  const cur = declared[0] ?? '';
  const here = entry.effectivePosition;
  const mk = (dir: string, label: string): MenuItem[] => {
    if (dir === here) {
      /**
       * **"现处"槽位**（P7.16 · #2b 起叫「就住这儿」；**P7.18b 起并列两项**）：
       * 两个入口两种说法、**同一个动作**（写声明不搬文件）——用户原话：
       * "前者用来声明文件不自动搬，后者用以通过选项来补上删掉的文件位置属性"。
       */
      if (!onDeclare) {
        // 旧样兜底（§8.4 之二：不隐藏、写原因）
        return [{ kind: 'item', label, disabled: '它就在这儿' }];
      }
      const at: MenuItem[] = [];
      if (undeclared) {
        at.push({
          kind: 'item',
          label: '就住这儿（写声明，不搬）',
          hint: `现处 ${here || '库根'}`,
          run: () => onDeclare(),
        });
      }
      at.push({
        kind: 'item',
        label: `现处 ${here || '库根'}`,
        hint: '写回当前位置（不搬文件）',
        run: () => onDeclare(),
      });
      return at;
    }
    return [{ kind: 'item', label, run: () => onPick(dir) }];
  };
  out.push(...mk('', '库根'));
  /**
   * ⚠️ **长菜单要有台阶**（`ui/menu.ts` 的硬规矩之二；`MENU_TOP_COMFORT=8`）：
   * 目录一多就是一坨平铺 → 分隔线是必须的（真机探针还有一条"不超出视口"盯着长度）。
   * ⚠️ `dirs` **现算一次、本函数里复用**（下面那条"不在库里"的判据也要它）——
   * `kbDirs` 每次都遍历 `getAllLoadedFiles`，别为了省一行多扫一遍。
   */
  out.push({ kind: 'separator' });
  const dirs = kbDirs(ctx);
  for (const d of dirs) {
    if (!d) continue;
    out.push(...mk(d, d));
  }
  /**
   * 声明值指向一个**已不存在的目录**时（错位那族）也画出来 —— 与选择器同一条口径，
   * 别让"菜单里看不见当前值"变成"我以为它没声明过"。点了才走那条错位的正常链。
   */
  if (cur && cur !== '' && !dirs.includes(cur)) {
    out.push({ kind: 'separator' });
    out.push({ kind: 'item', label: `${cur}（不在库里）`, disabled: '声明指向的目录不存在' });
  }
  return out;
}

function currentLabel(name: string, v: unknown): string {
  const spec = SPEC_BY_NAME[name];
  if (spec?.kind === 'bool') return asBool(v) ? '是' : '否';
  if (spec?.multi || Array.isArray(v)) {
    const list = asList(v);
    return list.length > 0 ? list.join('、') : '（空）';
  }
  const s = asString(v);
  return s === '' ? '（空）' : s;
}

/** 一个属性的取值子菜单（枚举给单选、列表型给多选、自由值给输入框） */
export function valueItems(
  name: string,
  current: unknown,
  apply: (v: unknown) => void,
): MenuItem[] {
  const spec = SPEC_BY_NAME[name];
  const asArr = asList(current);

  if (spec?.kind === 'bool') {
    return (['是', '否'] as const).map<MenuItem>((label) => ({
      kind: 'item',
      label,
      control: { type: 'radio', checked: asBool(current) === (label === '是'), group: name },
      run: () => apply(label === '是'),
    }));
  }

  if (spec?.multi) {
    const candidates = SPEC_BY_NAME[name]?.values ?? [];
    const list = candidates.length > 0 ? candidates : asArr;
    return list.map<MenuItem>((v) => ({
      kind: 'item',
      label: v,
      control: { type: 'multi', checked: asArr.includes(v) },
      stay: true,
      run: (c) => {
        const on = Boolean(c.value);
        const next = on ? Array.from(new Set([...asArr, v])) : asArr.filter((x) => x !== v);
        apply(next);
      },
    }));
  }

  if (spec?.values && spec.values.length > 0) {
    const items = spec.values.map<MenuItem>((v) => ({
      kind: 'item',
      label: v,
      control: { type: 'radio', checked: asString(current) === v, group: name },
      run: () => apply(v),
    }));
    /**
     * P7.14（真机反馈修正）：**「（清空）」= 删键** —— 此前枚举属性（类型/状态…）
     * 设了值之后没有任何出口能删，用户原话"添加笔记属性后，无法手动删除"。
     * `fm.setMany` 里 `null` 就是 `delete fm[k]`（见 frontmatter.ts:96）。
     * 只在当前有值时画（空值点了没意义）。
     */
    if (asString(current) !== '') {
      items.push({ kind: 'item', label: '（清空）', icon: 'eraser', run: () => apply(null) });
    }
    return items;
  }

  // 自由值 / 日期：给输入框（Enter 确认）；**空了 = 删键**（P7.14：与枚举清空同语义）
  return [
    {
      kind: 'item',
      label: name,
      control: { type: 'text', value: asString(current) },
      run: (c) => {
        const s = String(c.value ?? '').trim();
        apply(s === '' ? null : s);
      },
    },
  ];
}

// ────────────────────────────────────────────────────────────────
// 加标签 ›（全库标签聚合 + 新标签输入）
// ────────────────────────────────────────────────────────────────
function tagItems(m: MenuCtx, entry: NoteEntry): MenuItem[] {
  const cur = asList(entry.props['tags']).map((t) => t.replace(/^#/, ''));
  const all = m.ctx.index.tags();
  const out: MenuItem[] = [];
  if (all.length === 0) {
    out.push({ kind: 'item', label: '库里还没有标签', disabled: '先给别的笔记加一个' });
  }
  for (const t of all.slice(0, 24)) {
    out.push({
      kind: 'item',
      label: t,
      control: { type: 'multi', checked: cur.includes(t) },
      stay: true,
      run: (c) => {
        const on = Boolean(c.value);
        void m.ops.changeTags([entry], on ? [t] : [], on ? [] : [t]);
      },
    });
  }
  out.push({ kind: 'separator' });
  out.push({
    kind: 'item',
    label: '新标签…',
    control: { type: 'text', value: '' },
    run: (c) => {
      const v = String(c.value ?? '').trim().replace(/^#/, '');
      if (v) void m.ops.changeTags([entry], [v], []);
    },
  });
  return out;
}

// ────────────────────────────────────────────────────────────────
// 目录节点菜单（交互规格 §8.2）
// ────────────────────────────────────────────────────────────────
/**
 * **目录节点右键**（P7.23 重排为 7 项；P7.24 · T2/T3 后满配 8 项 —— 树收口三件）：
 *
 *   在此新建笔记 / 在此新建目录 / ──── / 展开子目录 / 完全展开（含所有子文件夹与文件）/
 *   收起此文件夹 ［根多一条：全部收起］ / ──── / 在系统资源管理器中打开 / ──── / 重排库结构…
 *
 * 口径：
 *   · **原「展开全部子目录」被「完全展开」取代**（同一个递归动作 + 整棵子树列文件行，
 *     见 `index.ts` 的 `expandAll`）——文案与语义一起升格，别再留旧名；
 *   · **P7.24 · T2 反转**（2026-10-11 用户真机点名）：根**不再恒开** ——
 *     「收起此文件夹」对根也画（`dir === ''` = 收库根，与行尾「收起」按钮、根 caret
 *     同一条 `collapseDir`）；
 *   · **「全部收起」（T3）只给根画**：全局动作放根/空白两处已够（空白菜单那条
 *     **同一实现** —— 都调 `index.ts` 的 `collapseAll`）；根菜单满配 8 项 / 非根 7 项；
 *   · 一级 ≤ 8 项（`validateMenuSpec` 硬规矩）：满配 8 项 ✓（带分隔线）。
 */
export function showFolderMenu(dir: string, evt: MouseEvent, m: MenuCtx): void {
  const reason = m.ops.revealBlockReason();
  const full = joinPath(m.ctx.settings.kbRoot(), dir);
  const label = dir || '整个知识库';
  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '在此新建笔记',
      icon: 'file-plus',
      // 落点预填这个目录；模板与文件名在对话框里定（P3 实做）
      run: () => openNewNoteDialog(m.ctx, { dirRel: dir }),
    },
    {
      kind: 'item',
      label: '在此新建目录',
      icon: 'folder-plus',
      /**
       * 与网格文件夹菜单的「新建子文件夹」**同一份实现**（P7.15 独立审查 🟡4 的
       * `onOpenDir` 链：建完进得去 + 树当场刷新 —— `createFolder` 不产 `.md`，
       * 不给这一步树一次都不重画）。
       */
      run: () => {
        void openNewFolderDialog(m.ctx, dir).then((rel) => {
          if (rel) m.onOpenDir?.(rel);
        });
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '展开子目录',
      icon: 'chevron-down',
      // 只展开**直接子目录**（一层）—— 与「完全展开」的差别就是"递归不递归 + 不和文件行"
      run: () => m.onExpandOne(dir),
    },
    {
      kind: 'item',
      label: '完全展开（含所有子文件夹与文件）',
      icon: 'chevrons-down',
      run: () => m.onExpandAll(dir),
    },
    // P7.24 · T2：根也画「收起」（根不再恒开 —— 决策反转，2026-10-11 用户真机点名）
    {
      kind: 'item',
      label: '收起此文件夹',
      icon: 'chevron-right',
      run: () => m.onCollapse(dir),
    },
    // P7.24 · T3：只给根画「全部收起」；非根不给（全局动作放根/空白两处已够）
    ...(dir === ''
      ? [
          {
            kind: 'item',
            label: '全部收起',
            icon: 'chevrons-up',
            run: () => m.onCollapseAll?.(),
          } as MenuItem,
        ]
      : []),
    { kind: 'separator' },
    {
      kind: 'item',
      label: '在系统资源管理器中打开',
      icon: 'folder-open',
      disabled: reason ?? undefined,
      // 与网格文件夹菜单共用同一份实现（两处各写一遍迟早漂）
      run: () => showInSystemExplorer(m.ctx, full),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '重排库结构…',
      icon: 'folder-tree',
      // 目录树 ⋯ / 目录节点右键都在这一条菜单里 —— 重排是"整库"的动作，
      // 不针对你右键的那个目录（面板里会写清它按 `库结构.json` 算）
      run: () => openRebuildPanel(m.ctx),
    },
  ];
  showContextMenu(evt, { scope: { kind: 'folder', label, icon: 'folder' }, items });
}

// ────────────────────────────────────────────────────────────────
// 批量栏「更多」（交互规格 §3.4）
// ────────────────────────────────────────────────────────────────
export function showBatchMore(entries: NoteEntry[], evt: MouseEvent, m: MenuCtx): void {
  const n = entries.length;
  const revealReason = m.ops.revealBlockReason();
  const anyHidden = entries.some((e) => asBool(e.props['隐藏']));
  const items: MenuItem[] = [
    { kind: 'item', label: '复制路径', icon: 'link', run: () => m.ops.copyPaths(entries) },
    { kind: 'item', label: '复制双链', icon: 'brackets', run: () => m.ops.copyLinks(entries) },
    {
      kind: 'item',
      label: '在系统资源管理器中显示',
      icon: 'folder-open',
      disabled: revealReason ?? undefined,
      run: () => void m.ops.revealInExplorer(entries[0]),
    },
    {
      kind: 'item',
      label: anyHidden ? '取消隐藏' : `隐藏这 ${n} 篇`,
      icon: anyHidden ? 'eye' : 'eye-off',
      run: () => void m.ops.setHidden(entries, !anyHidden),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: `删除（移入回收站）`,
      icon: 'trash',
      danger: true,
      run: () => void m.ops.trash(entries),
    },
  ];
  showContextMenu(evt, {
    scope: { kind: 'section', label: `已选 ${n} 篇`, icon: 'check-square' },
    items,
  });
}

// ────────────────────────────────────────────────────────────────
// 批量迁移：选目标目录（树形子菜单）
// ────────────────────────────────────────────────────────────────
/**
 * @param entries 选中集 —— 判「死选项」要用（P7.0a 批 1⑨）。**不是**全库。
 */
export function migrateItems(m: MenuCtx, entries: NoteEntry[], onPick: (dir: string) => void): MenuItem[] {
  /**
   * P7.15 · #2：树的数据源换成「真实目录」（空目录也画）—— 与左侧目录树、网格同源。
   * 空目录在这里是**有用的选项**（"文档还没写，先建了夹子"就是它要服务的场景）。
   */
  const tree = buildTreeFromVault(m.ctx.app, m.ctx.settings.kbRoot(), m.ctx.index.notes());
  /**
   * 「移到当前所在目录」= **死选项**：mover 会判 already、一个都不动，用户白走一趟
   * 确认流（真机上写过「00_Inbox → 00_Inbox」）。判据 = **选中集里每一篇都已在候选目录**；
   * 部分"已在"的候选保留 —— 那是有用的操作（其余几篇照搬）。
   */
  const dead = (dir: string): boolean => entries.every((e) => e.effectivePosition === dir);

  const nodeItem = (node: TreeNode): MenuItem | null => {
    const kids = node.children
      .map(nodeItem)
      .filter((x): x is MenuItem => x !== null);
    const self: MenuItem[] = dead(node.dir)
      ? []
      : [{ kind: 'item', label: `移到「${node.name}」`, icon: 'corner-down-right', run: () => onPick(node.dir) }];
    const submenu: MenuItem[] = [...self];
    if (self.length > 0 && kids.length > 0) submenu.push({ kind: 'separator' });
    submenu.push(...kids);
    // 过滤后空了的节点（叶子目录且它是"当前目录"）整个不画 —— 空子菜单是违规的
    if (submenu.length === 0) return null;
    return { kind: 'item', label: `${node.name}（${node.count}）`, submenu };
  };

  const rootSelf: MenuItem[] = dead('')
    ? []
    : [{ kind: 'item', label: '移到库根', icon: 'home', run: () => onPick('') }];
  const roots = tree.children
    .map(nodeItem)
    .filter((x): x is MenuItem => x !== null);
  const out: MenuItem[] = [...rootSelf];
  if (rootSelf.length > 0 && roots.length > 0) out.push({ kind: 'separator' });
  out.push(...roots);
  return out;
}

// ────────────────────────────────────────────────────────────────
// 显隐列（交互规格 §3.3：「名称」列不可隐藏）
//
// ⚠️ 一级最多 8 项是**硬规矩**（§8.4 之二），而列有 20+ 个 ——
// 平铺会当场违反它（每次打开都 console.warn；独立审查抓到过）。所以按用途分组，
// 没登记的自定义属性列收进「自定义属性」子菜单。
// ────────────────────────────────────────────────────────────────
const COLUMN_GROUPS: { label: string; ids: string[] }[] = [
  { label: '常用', ids: ['flags', 'name', 'prop:类型', 'prop:状态', 'mtime'] },
  { label: '定位', ids: ['prop:文件位置', 'prop:位置锁定', 'prop:隐藏'] },
  { label: '其他', ids: ['prop:创建日期', 'prop:tags', 'size'] },
];

/**
 * 「列设置」那份 spec（P7.1 起独立成函数）：**两个入口共用同一份内容** ——
 * ① 工具条「列」按钮（触屏/网格档之外的主入口）· ② 表头右键的「打开列设置…」
 *（后者是 `MenuHandle.refresh()` 就地换内容，见 `showHeaderMenu`）。
 */
export function columnsMenuSpec(
  cols: { id: string; label: string; fixed?: boolean }[],
  hidden: string[],
  onToggle: (id: string, visible: boolean) => void,
): MenuSpec {
  const byId = new Map(cols.map((c) => [c.id, c]));
  const itemFor = (id: string): MenuItem | null => {
    const c = byId.get(id);
    // 复选框列是结构列（不是数据列）→ 不进菜单；空标签列也没法勾
    if (!c || c.id === 'check') return null;
    return {
      kind: 'item',
      label: c.label,
      control: { type: 'multi', checked: !hidden.includes(c.id) },
      disabled: c.fixed ? '名称列不可隐藏' : undefined,
      stay: true,
      run: (runCtx) => {
        if (c.fixed) return;
        onToggle(c.id, Boolean(runCtx.value));
      },
    };
  };

  const used = new Set(COLUMN_GROUPS.flatMap((g) => g.ids));
  const custom = cols.filter((c) => !used.has(c.id) && c.id !== 'check' && !c.fixed);

  const items: MenuItem[] = [];
  for (const g of COLUMN_GROUPS) {
    const sub = g.ids.map((id) => itemFor(id)).filter((x): x is MenuItem => x !== null);
    if (sub.length === 0) continue;
    items.push({ kind: 'item', label: g.label, submenu: sub });
  }
  if (custom.length > 0) {
    items.push({
      kind: 'item',
      label: '自定义属性',
      submenu: custom.map((c) => itemFor(c.id)).filter((x): x is MenuItem => x !== null),
    });
  }

  return {
    scope: { kind: 'section', label: '表格的列', icon: 'columns' },
    items,
  };
}

export function showColumnsMenu(
  anchor: HTMLElement,
  cols: { id: string; label: string; fixed?: boolean }[],
  hidden: string[],
  onToggle: (id: string, visible: boolean) => void,
): void {
  const r = anchor.getBoundingClientRect();
  // 从按钮的下沿展开（`showMenu` 的坐标语义：给点，不给事件对象）
  showMenu({ x: r.left, y: r.bottom }, columnsMenuSpec(cols, hidden, onToggle));
}

// ────────────────────────────────────────────────────────────────
// 表头右键（P7.1 · 2.1 / D2）：排序 › / 隐藏这一列 / 打开列设置…
//
// 为什么要有它（用户 2026-10-02 原话）："用户可以在顶部属性名称一栏勾选要显示或隐藏的
// 笔记属性" —— 「列」按钮之外的第二条路，Windows 文件管理器的表头右键就是这个形状。
// 三条口径：
//   · **不可用项置灰并写明原因**（硬规矩），不隐藏 —— 「排序」在不能排序的列（标记）上灰、
//     「隐藏这一列」在不可隐藏的列（名称 / 复选框）上灰；
//   · **隐藏与「列」菜单同一条数据**（`effectiveHidden()`）—— 这里只说"做什么"，状态在模块那边；
//   · 「打开列设置…」用 `MenuHandle.refresh()` **就地换内容**（不关窗重开）——
//     别改成 `run` 里 `showMenu` 新开一扇：点击处理器在 `run` 之后还会 `closeAllMenus()`，
//     新开的那扇会被**紧接着关掉**（`ui/menu.ts` 的点击序列）。
// ────────────────────────────────────────────────────────────────
export interface HeaderMenuOpts {
  col: HeaderMenuInfo;
  /** 当前排序（用来给升/降标 ✓）；null = 没排序 */
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  /** 点升/降 —— **明确方向**（不是 toggle：菜单里点了哪条就是哪条） */
  onSortDir: (dir: 'asc' | 'desc') => void;
  onHide: () => void;
  /** 「打开列设置…」要换上的那份 spec（由模块侧用 `columnsMenuSpec` 现算） */
  columnsSpec: () => MenuSpec;
  /**
   * **日期列的「按…筛」快捷入口**（P7.12 · 21.5「列头也给同粒度入口」）：
   * 传了才画那一组（只有日期列传）—— 四个粒度各一枚：今天 / 本周 / 本月 / 今年。
   * 点某枚 = 把对应的**裸写词**（`dateTokenOf` 现算，本地时区）交给回调；
   * 落进 `filters.created` 还是别的什么，由调用方定（这里不认识 FilterSet）。
   */
  dateFilter?: { onPick: (token: string) => void };
}

export function showHeaderMenu(evt: MouseEvent, o: HeaderMenuOpts): void {
  const { col, sort } = o;
  const sorted = sort?.key === col.id ? sort.dir : null;
  /** `run` 在点击那一刻才跑，此时 handle 已就位（下面那句赋值先于任何点击） */
  let handle: MenuHandle | null = null;
  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '排序',
      icon: 'arrow-up-down',
      disabled: col.sortable ? undefined : '这一列不参与排序',
      submenu: [
        { kind: 'item', label: '升序', checked: sorted === 'asc', run: () => o.onSortDir('asc') },
        { kind: 'item', label: '降序', checked: sorted === 'desc', run: () => o.onSortDir('desc') },
      ],
    },
    /**
     * 日期列专属：**同粒度入口**（今天 / 本周 / 本月 / 今年 —— 日 / 周 / 月 / 年各一枚）。
     * ⚠️ 排在「排序」之后、「隐藏」之前：它是一次**视野动作**（和排序同族），
     * 不是列设置那类维护动作。`run` 现算词 = 打开菜单那一刻的"今天"（跨零点打开的
     * 菜单点下去仍按当刻算，不会用到菜单构建时的旧值 —— 但也别故意跨零点用）。
     */
    ...(o.dateFilter
      ? ([
          {
            kind: 'item',
            label: '按日期筛',
            icon: 'calendar-days',
            submenu: [
              { kind: 'item', label: '今天', run: () => o.dateFilter?.onPick(dateTokenOf(new Date(), 'day')) },
              { kind: 'item', label: '本周', run: () => o.dateFilter?.onPick(dateTokenOf(new Date(), 'week')) },
              { kind: 'item', label: '本月', run: () => o.dateFilter?.onPick(dateTokenOf(new Date(), 'month')) },
              { kind: 'item', label: '今年', run: () => o.dateFilter?.onPick(dateTokenOf(new Date(), 'year')) },
            ],
          },
        ] as MenuItem[])
      : []),
    {
      kind: 'item',
      label: '隐藏这一列',
      icon: 'eye-off',
      disabled: col.hideable ? undefined : col.id === 'name' ? '名称列不可隐藏' : '这一列不可隐藏',
      run: () => o.onHide(),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '打开列设置…',
      icon: 'columns',
      // ⚠️ `stay`：点击处理器在 `run` 之后会对"没 stay 的"菜单 `closeAllMenus()` ——
      // refresh 换上来的那扇会被当场关掉（见上面那段注释）
      stay: true,
      run: () => handle?.refresh(o.columnsSpec()),
    },
  ];
  const spec: MenuSpec = {
    scope: { kind: 'section', label: `列「${col.label || '选择'}」`, icon: 'columns' },
    items,
  };
  handle = showContextMenu(evt, spec);
}

// ────────────────────────────────────────────────────────────────
// 网格里的文件夹格子：右键菜单（P6b ②，用户 2026-09-27 提："参考 windows"）
// ────────────────────────────────────────────────────────────────
/**
 * 目录树收集（**磁盘真源**：`adapter.list` 递归 —— 缓存树可能旧，不能当"空不空 / 有几个文件"
 * 的判据）。返回 `files`（含子目录里的全部文件）与 `dirs`（全部**子目录**、不含根自己），
 * 都是 **vault 绝对路径**。
 */
async function collectTree(
  ctx: WorkbenchContext,
  rootAbs: string,
): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const queue = [rootAbs];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await ctx.app.vault.adapter.list(dir);
    } catch {
      continue; // 读不到（竞态）——收集到什么算什么
    }
    for (const f of listing.files) files.push(f);
    for (const d of listing.folders) {
      dirs.push(d);
      queue.push(d);
    }
  }
  return { files, dirs };
}

/** 深 → 浅（删目录壳要从最深的先删） */
function byDepthDesc(dirs: string[]): string[] {
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
}

/**
 * **网格里的文件夹格子右键菜单**（P6b ②）。
 *
 * Windows 语义里目录能做的事：
 *  · **进入这个目录** —— 双击的键盘/触屏等价物（WCAG：双击必须有非双击的路）；
 *  · **在此新建笔记 / 新建子文件夹** —— 与空白处菜单同一份实现（`openNewNoteDialog` / `openNewFolderDialog`）；
 *  · **在系统资源管理器中打开** —— 与目录节点菜单同一份实现；
 *  · **重命名… / 删除…** —— **P7.14 起对非空目录也开放**（此前只对空目录开放、非空置灰）。
 *
 * 🔴 **P7.14 · 有意识改契约（做窄 → 放开）**：此前"只对空目录"的两条硬理由，现在都有了正当出口：
 *  ① **删非空目录**不再"跳过 mover 直接毁数据"—— 文件先走 `mover.trash`（**快照 + 回收站语义 +
 *     撤销条**，与 E2「重复保最新」同一条链），最后才把**已经空掉的目录壳**（深→浅）删掉；
 *     撤销 = 快照还原（文件按旧路径写回，父目录随内容链重建）。⚠️ 代价一处：**原本就空的子目录**
 *     撤销后不回来（快照没有目录反演）。
 *  ② **重命名非空目录**走 `mover.move` **整组搬**（硬规矩一不破：每个文件都过 mover），双链由
 *     mover 内部的平台 `renameFile` 跟着改；一次调用 = 一个快照 = 一个撤销句柄。空目录（没有
 *     文件可搬）才走平台的 `vault.rename` —— 一个空壳、无数据可损，与「新建文件夹」同级。
 *  ③ 空目录**删除**维持原档（单确认、不进快照：没有内容可还原）。
 * ⚠️ 两项都**不画在库根本身**（`dir === ''`）—— 库根不能改名/删除。
 * ⚠️ 判据"空不空"一律**现问磁盘**（`adapter.list`），不信渲染那一刻的缓存。
 */
export function showGridFolderMenu(dir: string, evt: MouseEvent, m: MenuCtx): void {
  const { ctx } = m;
  const abs = dir ? joinPath(ctx.settings.kbRoot(), dir) : ctx.settings.kbRoot();
  const label = dir || '整个知识库';

  /**
   * 「在目录树中 ›」（P7.23 · Q4 拍板同步）：展开三件与**目录节点菜单同一份实现**
   *（`MenuCtx.onExpandOne/onExpandAll/onCollapse`）——"在树上展开这个目录"在格子右键
   * 同样自然（侧栏树常驻）。
   *
   * P7.24 · T2：删掉了原来的 `dir === ''` 排除（那写的是"根恒开，收起无意义"——
   * 反转后根也吃收起，`collapseDir('')` 正常收）。网格/表格的文件夹格本来只代表
   * 真实目录，这条分支是镜像口径，跟着目录节点菜单一起对齐。
   */
  const treeSubmenu: MenuItem[] = [
    {
      kind: 'item',
      label: '展开子目录',
      icon: 'chevron-down',
      run: () => m.onExpandOne(dir),
    },
    {
      kind: 'item',
      label: '完全展开（含所有子文件夹与文件）',
      icon: 'chevrons-down',
      run: () => m.onExpandAll(dir),
    },
    {
      kind: 'item',
      label: '收起此文件夹',
      icon: 'chevron-right',
      run: () => m.onCollapse(dir),
    },
  ];

  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '进入这个目录',
      icon: 'folder-open',
      run: () => m.onOpenDir?.(dir),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '在此新建笔记',
      icon: 'file-plus',
      run: () => openNewNoteDialog(ctx, { dirRel: dir }),
    },
    {
      kind: 'item',
      label: '新建子文件夹',
      icon: 'folder-plus',
      run: () => {
        /**
         * 🔴 **建完要进那个目录（也是"重画一次"的由头）**（P7.15 独立审查 🟡4）：
         * `createFolder` 不产 `.md` → 索引的 `create` 事件过滤掉它 → 不 bump `revision`
         * → 树**一次都不重画**。原先这里连回调都不传：成功通知弹了、树里看不见新节点
         *（"新建空文件夹立即可见于树"这条判据在离线/探针里都靠显式 `index.rebuild()`，
         *  把这条产品路径整个绕过去了 —— 真机症状 = "要再点一下才出现"）。
         * `onOpenDir` = `index.ts` 的 `openDir`：它会展开树到看得见它 + `repaint()`。
         * 顺带与"空白处右键 → 新建文件夹"那条口径对齐（那条一直传了 `onFolderCreated`）。
         */
        void openNewFolderDialog(ctx, dir).then((rel) => {
          if (rel) m.onOpenDir?.(rel);
        });
      },
    },
    { kind: 'item', label: '在目录树中', icon: 'list-tree', submenu: treeSubmenu },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '在系统资源管理器中打开',
      icon: 'external-link',
      run: () => showInSystemExplorer(ctx, abs),
    },
    {
      kind: 'item',
      label: '重排库结构…',
      icon: 'folder-tree',
      // 与目录节点菜单那条同一份实现（整库动作，面板里写清它按 `库结构.json` 算）
      run: () => openRebuildPanel(ctx),
    },
  ];
  /** 重命名 / 删除（P7.14 起对非空目录也开放；不加在库根本身上 —— 见顶上那段） */
  if (dir !== '') {
    items.push(
      {
        kind: 'item',
        label: '重命名…',
        icon: 'pencil',
        run: () => void openRenameDirPrompt(ctx, dir),
      },
      {
        kind: 'item',
        label: '删除…',
        icon: 'trash-2',
        danger: true,
        run: () => void deleteDirTree(ctx, dir),
      },
    );
  }

  showContextMenu(evt, { scope: { kind: 'folder', label, icon: 'folder' }, items });
}

/** 在系统资源管理器中打开（目录节点菜单与网格文件夹菜单**共用一份**） */
export function showInSystemExplorer(ctx: WorkbenchContext, abs: string): void {
  const fn = (ctx.app as unknown as { showInFolder?: (p: string) => Promise<void> }).showInFolder;
  if (typeof fn === 'function') void fn.call(ctx.app, abs).catch(() => undefined);
}

/**
 * 删目录壳（深→浅，整棵 `recursive`）。
 * ⚠️ 前面已经把文件都搬走/删掉了，壳里理论上已空 —— 若同步/别的程序又塞了东西进来，
 * `rmdir` 会把它**一起带走**吗？不会：我们一路都是 `recursive: true`，所以这里**先复查**
 * （`collectTree` 一遍）再删；复查发现还有东西就留着并报出来。
 */
async function rmdirShells(ctx: WorkbenchContext, deepestFirst: string[], label: string): Promise<void> {
  for (const d of deepestFirst) {
    try {
      const left = await collectTree(ctx, d);
      if (left.files.length > 0) {
        notifyLight(`目录「${label}」没删干净`, `${d} 里又出现了文件，留着它`);
        continue;
      }
      await ctx.app.vault.adapter.rmdir(d, true);
    } catch {
      notifyLight(`目录「${label}」没删干净`, `${d} 还留着（多半有东西刚被放进来）`);
    }
  }
}

/**
 * 删除一个目录：**空目录**走轻档（单确认、不进快照）；**非空**先 `mover.trash`
 * （快照 + 回收站语义 + 撤销条，与 E2 同一条链）再清目录壳。口径见菜单顶上那段。
 */
export async function deleteDirTree(ctx: WorkbenchContext, rel: string): Promise<void> {
  const abs = joinPath(ctx.settings.kbRoot(), rel);
  const { files, dirs } = await collectTree(ctx, abs);
  const mdN = files.filter((f) => f.toLowerCase().endsWith('.md')).length;
  const option = ctx.mover.trashOption();
  /** 删的正是库配置目录 → 确认单里补一句"会自动重建"（用户真机问过这件事） */
  const isMeta = rel !== '' && rel === ctx.settings.metaRoot();

  if (files.length === 0) {
    const res = await confirm({
      title: `删除空目录「${rel}」`,
      preview: [{ kind: 'delete', where: rel || '库根', count: 0 }],
      warnings: [],
      // 空目录里没有笔记 → 没有数据损失，不需要"再点一次"那两下确认（§9 的分档）
      notes: ['这个目录里没有任何笔记，删除只影响目录本身（不进快照：没有内容可还原）'],
      primary: { label: '删除这个目录' },
      secondary: [{ label: '不删了', value: 'cancel' }],
    });
    if (res.action !== 'primary') return;
    await rmdirShells(ctx, [...byDepthDesc(dirs), abs], rel);
    ctx.index.rebuild();
    notify({ kind: 'success', text: `已删除空目录「${rel}」`, ms: NOTIFY_MS.light });
    return;
  }

  const where = option === 'local' ? '库回收站' : option === 'system' ? '系统回收站' : '';
  const res = await confirm({
    title: `删除「${rel}」（含 ${files.length} 个文件）`,
    preview: [{ kind: 'delete', where: rel || '库根', count: files.length }],
    warnings:
      option === 'none'
        ? ['Obsidian 的「删除文件」设置是"不删除"——文件会直接消失，无法找回']
        : [],
    notes: [
      `共 ${files.length} 个文件（${mdN} 篇笔记）全部进${where || '（不可恢复）'}；删除前自动拍快照，撤销条里可整批还原`,
      ...(isMeta
        ? ['这是工作台的**库配置目录**：删掉后配置会以默认值在下次用到时自动重建，笔记不受影响']
        : []),
    ],
    danger: option === 'none' ? { confirmLabel: '仍然删除', irreversible: true } : undefined,
    primary: { label: `删除这 ${files.length} 个文件` },
    secondary: [{ label: '不删了', value: 'cancel' }],
  });
  if (res.action !== 'primary') return;

  const tfs = files
    .map((p) => ctx.app.vault.getAbstractFileByPath(p))
    .filter((f): f is TFile => f != null && (f as { extension?: unknown }).extension != null);
  const t = await ctx.mover.trash({ files: tfs, source: 'menu', reason: `删除目录 ${rel}` });
  await rmdirShells(ctx, [...byDepthDesc(dirs), abs], rel);
  ctx.index.rebuild();
  if (t.trashed.length > 0 && t.snapshotId) {
    showUndo({
      text: `已删除「${rel}」（${t.trashed.length} 个文件进回收站）`,
      detail: t.reversible ? '撤销 = 从操作前的快照还原' : '这些文件进了系统回收站，可从系统回收站找回',
      onUndo: () => {
        void restoreOrNotify(ctx.snapshot, t.snapshotId).then((back) => {
          // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：只判空，不播成功文案
          if (!back) return;
          notifyLight(`已还原这次删除：写回 ${back.contentsRestored} 件`);
        });
      },
      onView: () => void ctx.report.openLatest(),
      onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
    });
  } else if (t.skipped.length > 0) {
    notify({
      kind: 'partial',
      text: `删除没做完（${t.skipped.length} 个跳过）`,
      detail: t.skipped[0]?.note ?? '',
      ms: NOTIFY_MS.long,
    });
  } else {
    notify({ kind: 'success', text: `已删除「${rel}」`, ms: NOTIFY_MS.light });
  }
}

/**
 * 重命名一个目录：**空目录**（没有文件可搬）走平台的 `vault.rename`；
 * **非空**走 `mover.move` 整组搬 + 清旧空壳（快照 + 撤销 + 双链修复都在 mover 里）。
 * 口径见菜单顶上那段。
 */
export async function openRenameDirPrompt(ctx: WorkbenchContext, rel: string): Promise<void> {
  const cur = baseName(rel);
  const name = await promptText({
    title: '重命名文件夹',
    label: `在 ${parentDir(rel) || '库根'} 下`,
    value: cur,
    placeholder: '文件夹名',
    primary: '改名',
    hint: '目录里的笔记会整组搬过去（进快照，可撤销）；双链由 Obsidian 跟着改',
    validate: (v) => {
      if (v === '') return '名字不能为空';
      if (v === cur) return null;
      if (v.startsWith('.')) return '点开头的目录不会出现在工作台里（插件看不见它）';
      if (v !== sanitize(v)) return '名字里不能有 \\ / : * ? " < > |';
      return null;
    },
  });
  if (name == null || name === cur) return;

  const kbRoot = ctx.settings.kbRoot();
  const parentRel = parentDir(rel);
  const newRel = parentRel ? `${parentRel}/${name}` : name;
  const fromAbs = joinPath(kbRoot, rel);
  const toAbs = joinPath(kbRoot, newRel);
  if (await ctx.app.vault.adapter.exists(toAbs)) {
    notify({ kind: 'partial', text: '已经有同名的了', detail: `${name} 已存在，没有动它`, ms: NOTIFY_MS.info });
    return;
  }

  const { files, dirs } = await collectTree(ctx, fromAbs);
  if (files.length === 0) {
    // 空目录：没有文件可搬 —— 平台整棵改名（一个空壳、无数据可损；与「新建文件夹」同级）
    const folder = ctx.app.vault.getAbstractFileByPath(fromAbs);
    try {
      if (folder) await ctx.app.vault.rename(folder, toAbs);
      else await ctx.app.vault.adapter.rename(fromAbs, toAbs); // 缓存没跟上的退路
    } catch (e) {
      notifyError('重命名失败', e instanceof Error ? e.message : String(e));
      return;
    }
    ctx.index.rebuild();
    notify({ kind: 'success', text: `已改名：${cur} → ${name}`, ms: NOTIFY_MS.light });
    return;
  }

  // 非空：整组搬（每个文件都过 mover → 快照 / 撤销句柄 / 双链修复都在 mover 里）
  const byDir = new Map<string, TFile[]>();
  for (const p of files) {
    const tf = ctx.app.vault.getAbstractFileByPath(p);
    if (tf == null || (tf as { extension?: unknown }).extension == null) continue;
    const targetDir = joinPath(toAbs, parentDir(relativeTo(p, fromAbs)));
    const list = byDir.get(targetDir) ?? [];
    list.push(tf as TFile);
    byDir.set(targetDir, list);
  }
  const want = Array.from(byDir.values()).reduce((n, l) => n + l.length, 0);
  if (want === 0) {
    notifyError('重命名没做成', '这些文件在缓存里一个都找不到（试试顶部 ⟳ 重新扫描库）');
    return;
  }
  const moveRes = await ctx.mover.move({
    targets: Array.from(byDir, ([dir, fs]) => ({ dir, files: fs })),
    source: 'menu',
    reason: `重命名目录：${rel} → ${newRel}`,
    // 空子目录也搬过去（mover 按 extraDirs 建）；新根目录本身由 targets 的落点自建
    extraDirs: dirs.map((d) => joinPath(toAbs, relativeTo(d, fromAbs))),
  });
  if (moveRes.error != null || moveRes.moved.length < want) {
    /**
     * 部分搬 / 撞名被拦：**旧目录残留一律留着**（留着能照出"哪几篇没走成"；清了那才是真丢）——
     * 报告与操作日志里有逐条明细。
     */
    notify({
      kind: 'partial',
      text: `改名没做完（${moveRes.moved.length}/${want} 篇搬过去了）`,
      detail: '旧目录先留着；查完再重试（详情见操作日志）',
      ms: NOTIFY_MS.long,
    });
    ctx.index.rebuild();
    return;
  }
  await rmdirShells(ctx, [...byDepthDesc(dirs), fromAbs], rel);
  ctx.index.rebuild();
  const deps: UndoMoveDeps = {
    restore: (id) => ctx.snapshot.restore(id),
    openLatest: () => ctx.report.openLatest(),
    openSnapshotPanel: () => openSnapshotPanel(ctx),
  };
  showMoveUndo(deps, moveRes);
}
