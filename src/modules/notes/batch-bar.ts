/**
 * 批量操作栏 —— **「全部笔记」与「看板」共用的同一份**（P4.5 c 期 §3.5）。
 *
 * 为什么要抽出来：§3.5 的原话是"批量栏**复用** P1 已有的那一份"。
 * 两屏各写一份的话，迁移/属性/标签/更多的**文案、确认流、边界**（撞名跳过、
 * 位置锁定不拦显式操作、删除的危险分组）迟早会漂 —— 而这几条的判据都写在
 * `交互规格 §3.4` 里，是"两屏必须一致"的硬要求。
 *
 * 调用方负责三件事（两屏的口径不同，所以不在这里猜）：
 *  ① 把选中的路径**解析成 `NoteEntry`**（各屏的可见集合/筛选各不相同）；
 *  ② 把这条栏**放进工具条那一行**（§3.4：整体替换工具条，不占额外垂直空间）；
 *  ③ 给「全选」与「清空」传动作（"全部"在两屏是两回事：一个吃筛选结果、一个吃看板全部卡片）。
 */
import type { NoteEntry } from '../../core/vault-index';
import type { WorkbenchContext } from '../../core/context';
import { btn, div, iconBtn, span } from '../../ui/primitives';
import { showMenu, type MenuItem } from '../../ui/menu';
import { notifyLight } from '../../ui/notify';
import { confirm } from '../../ui/confirm';
import { openTitlePanel } from '../../ui/title-panel';
import { openLinkPanel } from '../../ui/link-panel';
import { openFmRepairPanel } from '../../ui/fm-repair-panel';
import { AI_PANEL_REF_CAP } from '../../ui/ai-panel';
import { migrateItems, showBatchMore, type MenuCtx } from './menus';
import { openPropPanel, openTagPanel } from './panels';
import type { NotesOps } from './ops';

/**
 * **「打开所选」的确认阈值**（P7.23 · Q9 拍板）：≤10 直接开、>10 先弹确认
 *（确认单写清"将打开 N 个标签页"）。数字是拍板值，别就地改 —— 改它 = 改契约。
 */
const OPEN_SELECTED_MAX = 10;

export interface BatchBarOpts {
  ctx: WorkbenchContext;
  ops: NotesOps;
  /**
   * 选中集的**取值函数** —— ⚠️ **是函数不是数组**（c 期独立审查 🔴1）。
   *
   * 为什么：下面那四个按钮的 `run` 闭包会一直活着，直到下一次重画。如果这里收的是数组，
   * 它捕获的就是"**画那一刻**"的那一批 —— 而工具条只在 `selected.length` 变了才重画，
   * 于是"长度不变、内容变了"的变化（`Ctrl+点 B` → `Shift+点 C` → **`Shift+点 D`**，
   * 锚点跟到 C、选段长度仍是 2）**不会重画** → 屏幕上高亮的是 C、D，
   * 点「迁移」搬走的却是 **B、C**（确认流上数量对、身份错）。
   *
   * 改成函数之后，**点击那一刻才解析**，看到什么就操作什么。
   * （另一条路是把整个选择集塞进 Region 的 key —— 那在 `Ctrl+A` 全选上千张时，
   *  每次 store 变化都要拼一个几十 KB 的字符串，不值。）
   */
  selected: () => NoteEntry[];
  /**
   * 「全选 N 篇」：N 与动作都由调用方给（两屏的"全部"口径**不同**）。
   * `title` 也由调用方给（c 期独立审查 🟢15）：看板上没有"筛选结果"这个概念 ——
   * 那边是「看板里的全部卡片」。缺省沿用「全部笔记」那句（别改那屏的文案）。
   */
  all: { count: number; run: () => void; title?: string };
  /** ✕ / Esc：清空选择 */
  onClear: () => void;
  /**
   * **「还原显示」**（A3，用户 2026-09-27 提）：把"跳转带来的那份筛选 + 预选中"一起清掉。
   * 不传就不画 —— 只有「全部笔记」有"跳转"这回事（看板没有 `filters` 那一层）。
   * 它跟「全选 / ✕」是一类（改视图/选择，不动库），所以放在 `tail` 那一头。
   */
  restore?: { label: string; title: string; run: () => void };
  /** 有几篇"已被筛掉但仍选中"（>0 才提示，见 §3.4 最后一行） */
  offscreen?: number;
  /**
   * 那句提示的**文案**（两屏含义不同，c 期独立审查 🟡10 —— 用户 2026-09-25 拍板"按屏说清楚"）。
   *
   * 差别在哪：**「全部笔记」按全库解析**，被筛掉的那些**仍会**跟着一起操作（"仍在选中"是实话）；
   * 而**看板只认看板上的卡**，那些**不会**被操作 —— 沿用"仍在选中"就是一句**空承诺**
   *（用户按文案预期"8 篇全搬"，实际只搬了看板上那 5 篇）。
   * 缺省沿用「全部笔记」那句（别改那屏的行为）。
   */
  offscreenText?: (n: number) => string;
  /**
   * **动库动作被挡住的理由**（看板的「只读模式」，c 期独立审查 🟡7）。
   * 传了就把四个按钮置灰、并在 title 上写原因 —— 与卡片菜单里「移到别的板块…」
   * 在只读下置灰是**同一条**口径（同一批动作，菜单那条路禁了、这条路不能还开着）。
   * 「全部笔记」那一屏没有这个开关，**缺省不传**（别改那边的行为）。
   */
  blocked?: string;
  /**
   * **画不画「打开所选（N 篇）」**（P7.23 · 反馈批 7 ③）。
   *
   * 🔴 **只在「全部笔记」给**（Q9 拍板，看板**如实不给**）：看板点它 = 开 N 扇小窗
   *（看板侧的打点带语义），一炸一串，所以不做。不传就不画 —— 与"不给就不出现那一行"
   * 同一条口径（`MenuCtx.onOpenDir` 那类）。
   */
  openSelected?: true;
}

/** 造一条批量栏；**放进工具条**是调用方的事 */
export function batchBar(o: BatchBarOpts): HTMLElement {
  /** 画这一帧用的快照（**只在显示上用**；按钮一律走 `o.selected()` 现取） */
  const sel = o.selected();
  const bar = div({ cls: 'kbw-notes-bar is-batch' });

  bar.appendChild(div({ cls: 'kbw-batch-count', text: `已选 ${sel.length} 篇` }));
  // 「被筛掉仍选中」要说出来（交互规格 §3.4）—— 不说的话，用户会以为"怎么只搬了 3 篇"
  if ((o.offscreen ?? 0) > 0) {
    const n = o.offscreen ?? 0;
    bar.appendChild(
      span({
        cls: 'kbw-batch-warn',
        text: (o.offscreenText ?? ((k) => `${k} 篇被筛掉，仍在选中`))(n),
      }),
    );
  }
  /**
   * **「还原」在左边也放一份**（P6b ①，用户 2026-09-27 提）。
   *
   * 为什么非放不可：跳转过来的那一刻常常是"已选中几篇"的状态（首页「去看看」带预选中），
   * 而批量栏**整条顶掉了工具条** —— 原先那个按钮在栏**最右**，左半边是「已选 3 篇」，
   * 视线不往右扫就看不到（用户截图 2 里正是这个状态：他找不到回头路）。
   * 紧跟「已选 N 篇」放一枚，「我刚跳过来的」和「怎么回去」就在同一个视线落点上。
   * ⚠️ **只加不删**：栏尾那一枚照旧（那一头是"全选 / ✕"那组视图动作，位置也是对的）。
   */
  if (o.restore) {
    bar.appendChild(
      btn({
        cls: ['kbw-btn', 'is-small', 'is-on'],
        text: o.restore.label,
        title: o.restore.title,
        on: { click: () => o.restore?.run() },
      }),
    );
  }

  const menuCtx: MenuCtx = {
    ctx: o.ctx,
    ops: o.ops,
    // 批量栏里没有"就地改名/展开"的入口，这几个回调只是 MenuCtx 的形状要求
    onRename: () => undefined,
    onExpandOne: () => undefined,
    onExpandAll: () => undefined,
    onCollapse: () => undefined,
  };

  /**
   * **点击那一刻**的选中（不是画那一刻）—— 空数组 = 选择刚被别处清掉，
   * 这一下就当没点（工具条马上会重画成普通工具条，按钮也没了）。
   */
  const curSel = (): NoteEntry[] | null => {
    if (o.blocked) return null; // 只读：四个动作一个都不动（按钮也置灰了，这只是第二道闸）
    const cur = o.selected();
    return cur.length > 0 ? cur : null;
  };

  const tools = div({ cls: 'kbw-notes-tools' });
  tools.appendChild(
    btn({
      cls: 'kbw-btn is-small',
      text: '迁移',
      attr: { 'aria-haspopup': 'true' },
      on: {
        click: (evt) => {
          const cur = curSel();
          if (!cur) return;
          const anchor = evt.currentTarget as HTMLElement;
          const r = anchor.getBoundingClientRect();
          showMenu(
            { x: r.left, y: r.bottom },
            {
              scope: { kind: 'section', label: `已选 ${cur.length} 篇`, icon: 'folder-input' },
              items: migrateItems(menuCtx, cur, (dir) => {
                void o.ops.moveWithConfirm(cur, dir, `批量迁移到 ${dir || '库根'}`);
              }),
            },
          );
        },
      },
    }),
  );
  tools.appendChild(
    btn({
      cls: 'kbw-btn is-small',
      text: '属性',
      on: {
        click: (evt) => {
          const cur = curSel();
          if (cur) openPropPanel(o.ctx, cur, o.ops, evt.currentTarget as HTMLElement);
        },
      },
    }),
  );
  tools.appendChild(
    btn({
      cls: 'kbw-btn is-small',
      text: '标签',
      on: {
        click: (evt) => {
          const cur = curSel();
          if (cur) openTagPanel(o.ctx, cur, o.ops, evt.currentTarget as HTMLElement);
        },
      },
    }),
  );
  /**
   * **「AI 处理 ›」**（P7.23 · 反馈批 7 ③，§7.3）。
   *
   * 四条既有面板 + 问 AI，**全部走"只服务这 N 篇"的名单通道**（不新开任何写盘路径）：
   *   · 起标题 / 修链 / 修前言 = 三个面板的 `only`（与 P7.12 编辑器右键「自动命名」同一条通道；
   *     修链与修前言是本轮给面板补的 `only` —— 它们原先只按旗标收全库）；
   *   · 补声明 = `ops.declarePositionHere`（既有确认流：确认 → `fm.setMany` 一个键）；
   *   · 问 AI（这 N 篇）= 打开 AI 面板、N 篇作 `@` 引用 —— **refs 上限 10 如实截断并说出来**。
   *
   * ⚠️ **两屏都给**（与「打开所选」相反，那是刻意不看的）：这批动作吃的是 notes 名单，
   * 看板卡片与「全部笔记」的行没有口径差别。
   */
  tools.appendChild(
    btn({
      cls: 'kbw-btn is-small',
      text: 'AI 处理',
      attr: { 'aria-haspopup': 'true' },
      on: {
        click: (evt) => {
          const cur = curSel();
          if (!cur) return;
          const r = (evt.currentTarget as HTMLElement).getBoundingClientRect();
          const n = cur.length;
          const paths = cur.map((e) => e.path);
          const items: MenuItem[] = [
            {
              kind: 'item',
              label: '起标题',
              icon: 'sparkles',
              run: () => void openTitlePanel(o.ctx, { only: paths }),
            },
            {
              kind: 'item',
              label: '修链',
              icon: 'link',
              run: () => void openLinkPanel(o.ctx, { only: paths }),
            },
            {
              kind: 'item',
              label: '修前言',
              icon: 'file-warning',
              run: () => void openFmRepairPanel(o.ctx, { only: paths }),
            },
            {
              kind: 'item',
              label: '补声明',
              icon: 'map-pin',
              run: () => void o.ops.declarePositionHere(cur),
            },
            { kind: 'separator' },
            {
              kind: 'item',
              label: `问 AI（这 ${n} 篇）`,
              icon: 'sparkles',
              run: () => {
                /**
                 * 🔴 截断按**面板的真实容量**（`AI_PANEL_REF_CAP` = 5），不是 `AI_LIMITS.refs`（10）——
                 * 后者是提示词层上限，面板自己的交互上限一直是 5（独立审 🔴1 逮到的口径错位：
                 * 第一版写"上限 10/已带上前 10 篇"，而面板 `slice(0,5)` 静默再砍一刀，
                 * 6~10 篇连通知都没有）。**断言"上限"之前先找到真正的闸门**。
                 */
                const capped = cur.slice(0, AI_PANEL_REF_CAP);
                if (capped.length < n) {
                  // 如实说：超上限的按上限带（与面板 `addRef` 的提示同一句口径）
                  notifyLight(`一次最多带 ${AI_PANEL_REF_CAP} 篇引用 —— 已带上前 ${AI_PANEL_REF_CAP} 篇`);
                }
                o.ctx.openAi(
                  '',
                  capped.map((e) => ({ kind: 'note', path: e.path, title: e.basename })),
                );
              },
            },
          ];
          showMenu(
            { x: r.left, y: r.bottom },
            { scope: { kind: 'section', label: `AI 处理（已选 ${n} 篇）`, icon: 'sparkles' }, items },
          );
        },
      },
    }),
  );
  /**
   * **「打开所选（N 篇）」**（P7.23 · Q9）：每篇各开一个标签页；≤10 直接开、>10 先弹确认。
   * ⚠️ 确认的落点是 `ui/confirm.ts`（**即便它不动库** —— 全项目"要你确认"的对话框只有这一份，
   * 差一个口子就会长出第二套按钮/Esc 语义）；`open` 那个计划行种类就是为它开的。
   */
  if (o.openSelected) {
    tools.appendChild(
      btn({
        cls: 'kbw-btn is-small',
        text: `打开所选（${sel.length} 篇）`,
        on: {
          click: () => {
            const cur = curSel();
            if (!cur) return;
            void (async () => {
              if (cur.length > OPEN_SELECTED_MAX) {
                const res = await confirm({
                  title: `打开这 ${cur.length} 篇？`,
                  preview: [{ kind: 'open', where: '每篇各开一个标签页', count: cur.length }],
                  warnings: [],
                  notes: [],
                  // 它**不改任何文件** —— 别让默认那句"执行前会自动快照"误导
                  snapshot: '只是打开标签页，不改动任何文件',
                  primary: { label: `打开 ${cur.length} 个标签页` },
                });
                if (res.action !== 'primary') return;
              }
              for (const e of cur) {
                try {
                  // 走 ops.open('newTab')（独立审 🟢4）：与笔记菜单「在新标签页中打开」
                  // 同一条实现 —— 别在这儿手抄 getLeaf('tab')（"两处各写一份必漂"的老账）
                  o.ops.open(e, 'newTab');
                } catch (err) {
                  console.error('[经纬] 打开所选失败', err);
                }
              }
            })();
          },
        },
      }),
    );
  }
  tools.appendChild(
    btn({
      cls: 'kbw-btn is-small',
      text: '更多',
      attr: { 'aria-haspopup': 'true' },
      on: {
        click: (evt) => {
          const cur = curSel();
          if (cur) showBatchMore(cur, evt, menuCtx);
        },
      },
    }),
  );
  bar.appendChild(tools);

  const tail = div({ cls: 'kbw-batch-tail' });
  if (o.restore) {
    const spec = o.restore;
    // `is-on` = 主题色的"这里有个状态"的既有用法（筛选徽标也是它）——
    // 这条要**显眼**：用户跳过来之后最常问的就是"我怎么回去"
    tail.appendChild(
      btn({
        cls: ['kbw-btn', 'is-small', 'is-on'],
        text: spec.label,
        title: spec.title,
        on: { click: () => spec.run() },
      }),
    );
  }
  tail.appendChild(
    btn({
      cls: 'kbw-btn is-small is-ghost',
      text: `全选 ${o.all.count} 篇`,
      title: o.all.title ?? '选中当前筛选结果的全部（不是"当前页"）',
      on: { click: () => o.all.run() },
    }),
  );
  tail.appendChild(iconBtn('x', '清空选择（Esc）', () => o.onClear()));
  bar.appendChild(tail);

  /**
   * **只读时把四个动库按钮置灰**（c 期独立审查 🟡7）：一处收口，免得将来加第五个按钮忘了挡。
   * 只灰 `tools` 里的（「全选 / ✕」不碰库，照常可用）。
   */
  if (o.blocked) {
    for (const b of Array.from(tools.querySelectorAll('button'))) {
      b.disabled = true;
      b.title = o.blocked;
    }
  }

  return bar;
}
