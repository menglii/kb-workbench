/**
 * blocks/todo —— 待处理清单（§2.3）
 *
 * **P7.2a 从 `modules/home/index.ts` 原样搬出**（行为一字不改）——包括：
 * · 预演是**异步**的（要读模板正文）→ 世代号保护：期间又重画过就整段作废；
 * · 空态照旧画「库是干净的」（**不**随"空块自动隐藏"隐去——那是新模块的口径，
 *   老五块行为一字不改）；
 * · 「已忽略 N 项 · 恢复」那行的点击（`homeDismissed` 清空）也归这块。
 */
import type { WorkbenchContext } from '../../../core/context';
import { joinPath } from '../../../core/paths';
import type { HomeBlock } from './index';
import { div, el, icon, span } from '../../../ui/primitives';
import { showContextMenu, showMenu, type MenuItem } from '../../../ui/menu';
import { openMigratePanel } from '../../../ui/migrate-panel';
import { AI_NOT_CONFIGURED, openSuggestPanel } from '../../../ui/suggest-panel';
import { openTitlePanel } from '../../../ui/title-panel';
import { NOTIFY_MS, notify, notifyError, notifyLight } from '../../../ui/notify';
import { showInSystemExplorer } from '../../notes/menus';
import { fold, FOLD_AT, type TodoItem } from '../todo';
import { INBOX } from '../tidy';
import {
  computeTodoItems,
  latestMaintenance,
  rowDisabledReason,
  runFullProcess,
  runRowAction as runAutoProcess,
} from '../todo-actions';

/** 每次 paint +1：异步回来时"我这一轮还算不算数" */
let gen = 0;
/**
 * **折叠行展开态**（P7.11 · #10）：**会话态**（同随机漫步的种子 ——
 * 切模块不重置、插件重载复位、**不落盘**；Q7 拍板"不跨会话记"）。
 */
let expanded = false;

/**
 * 行元素 → 数据项（P7.11 · #4：右键菜单要拿到这一行的 `TodoItem`）。
 * WeakMap 而不是塞 dataset（`TodoItem` 里有 intent 对象，序列化不了）。
 */
const itemOfRow = new WeakMap<HTMLElement, TodoItem>();
/** 供 `modules/home/index.ts` 的右键分发用（落在行上 → 「这一项」菜单） */
export function todoItemOf(el: Element | null): TodoItem | null {
  const rowEl = el?.closest?.('.kbw-todo') as HTMLElement | null;
  if (!rowEl) return null;
  return itemOfRow.get(rowEl) ?? null;
}

/** 同行左键动作（「处理这一项」菜单项与行点击共用一份 —— 两处各写必漂） */
function runRowAction(ctx: WorkbenchContext, item: TodoItem, row: HTMLElement): void {
  if (item.action === 'migrate') openMigratePanel(ctx);
  else if (item.action === 'orphans') void openOrphansMenu(ctx, row);
  else if (item.action === 'duplicates') void openDuplicatesMenu(ctx, row);
  else ctx.goNotes(item.intent);
}

/** 同行尾 ✦（行菜单的「✦ AI 处理这一项」共用一份） */
function runAiAction(ctx: WorkbenchContext, item: TodoItem): void {
  if (!ctx.ai.isConfigured()) {
    notifyLight(AI_NOT_CONFIGURED);
    return;
  }
  if (item.ai === 'title') openTitlePanel(ctx);
  else openSuggestPanel(ctx, { scope: item.id === 'inbox' ? INBOX : '', autoAi: true });
}

/** 忽略这一项（行尾 ✕ 与行菜单共用） */
function dismissItem(ctx: WorkbenchContext, item: TodoItem): void {
  const cur = ctx.settings.get().homeDismissed;
  void ctx.settings.save({ homeDismissed: Array.from(new Set([...cur, item.id])) });
}

function todoRow(ctx: WorkbenchContext, item: TodoItem): HTMLElement {
  const row = div({ cls: ['kbw-todo', 'kbw-hover-1'] });
  itemOfRow.set(row, item);
  row.appendChild(span({ cls: ['kbw-dot', `c-${item.level}`] }));
  const body = div({ cls: 'kbw-todo-body' });
  body.appendChild(div({ cls: 'kbw-todo-t', text: item.text }));
  if (item.meta) body.appendChild(div({ cls: 'kbw-todo-m', text: item.meta }));
  row.appendChild(body);
  const act = div({ cls: 'kbw-todo-act' });
  act.appendChild(span({ text: item.act }));
  act.appendChild(icon('chevron-right', 14));
  row.appendChild(act);
  /**
   * ⚠️ **行尾的 ✦ 已撤**（P7.12 · R5 拍定，用户 12:56 原话："AI 整理功能的入口
   * 已经放在了右键菜单里"）—— AI 入口 = 行菜单的「✦ AI 处理这一项 / ✦ AI 自动处理 ›」。
   * 别再往行上画 ✦（判据：待处理各行无 `.kbw-todo-ai` 节点）。
   */
  row.appendChild(
    span({
      cls: 'kbw-todo-x',
      text: '忽略',
      title: '从首页隐掉这一项（可在下面恢复）',
      attr: { role: 'button', tabindex: '0' },
      on: {
        click: (evt) => {
          evt.stopPropagation();
          dismissItem(ctx, item);
        },
      },
    }),
  );
  row.addEventListener('click', () => runRowAction(ctx, item, row));
  return row;
}

/**
 * **「这一项」菜单**（P7.11 · #4 批注定稿；P7.13b · #6a/#6b 两改）：行上右键的那一扇 ——
 * 「处理这一项（文案随行 = item.act）」·「✦ AI 处理这一项」（仅带 ✦ 的行）·
 * 「忽略这一项」· ── ·「✦ AI 自动处理 ›」（子菜单 = ① 自动处理本条 / ② 一键完全处理）。
 * 与块菜单**两扇不叠**：落在行上开这一扇、落在块上开那一扇（index.ts 分发）。
 *
 * ## P7.13b · #6a 落点（Q19 拍定）
 * **鼠标右键 = 鼠标落点**（`evt.clientX/clientY` 直传）；**键盘呼出**（Shift+F10 / 菜单键）
 * 的 contextmenu 坐标为 0 → 回退"行锚点"（原公式留着当回退支）。
 */
export function openTodoRowMenu(ctx: WorkbenchContext, evt: MouseEvent, item: TodoItem, row: HTMLElement): void {
  const items: MenuItem[] = [
    {
      kind: 'item',
      label: `处理这一项（${item.act}）`,
      icon: 'arrow-right',
      run: () => runRowAction(ctx, item, row),
    },
  ];
  if (item.ai) {
    items.push({ kind: 'item', label: '✦ AI 处理这一项', run: () => runAiAction(ctx, item) });
  }
  items.push(
    { kind: 'item', label: '忽略这一项', icon: 'x', run: () => dismissItem(ctx, item) },
    { kind: 'separator' },
    { kind: 'item', label: '✦ AI 自动处理', submenu: todoActionSubmenu(ctx, item) },
  );
  const spec = { scope: { kind: 'global' as const, label: item.text, icon: 'home' }, items };
  if (evt.clientX === 0 && evt.clientY === 0) {
    // 键盘呼出（坐标为 0）→ 回退行锚点
    const r = row.getBoundingClientRect();
    showMenu({ x: r.left + 24, y: r.top + 8 }, spec);
  } else {
    showContextMenu(evt, spec);
  }
}

/**
 * 行菜单「✦ AI 自动处理」的子菜单（P7.13b · #6b，Q21–Q25 拍定）：**只留 ① / ②**。
 *
 * · **「一键自动整理 ＋ 目录列表」退役**（Q21）—— 范围选择已由「整理收件箱」承担
 *   （P7.13a · #4 给它做了可点的作用域行）；「一键自动整理」的能力保留在
 *   ① 收件箱行 与「整理收件箱」菜单里，这里不再重复一份。
 * · **① 自动处理本条**（Q22 + 22b）：逐类映射到既有出口（动作本体在
 *   `modules/home/todo-actions.ts` 的 `runRowAction`）——文案带上行的量词
 *   （「① 自动处理本条（4 篇位置不一致）」）。
 * · **② 一键完全处理**（Q25）：逐条串行跑完整张清单（`runFullProcess`）。
 * · ① 的置灰原因来自 `rowDisabledReason`（外改 / 一次性标签 / 未配 AI 的修链）。
 */
export function todoActionSubmenu(ctx: WorkbenchContext, item: TodoItem): MenuItem[] {
  const why = rowDisabledReason(ctx, item);
  return [
    {
      kind: 'item',
      label: `① 自动处理本条（${item.text}）`,
      disabled: why !== '' ? why : undefined,
      run: () => {
        void runAutoProcess(ctx, item).catch((e) => {
          notifyError('自动处理没走完', e instanceof Error ? e.message : String(e));
        });
      },
    },
    { kind: 'item', label: '② 一键完全处理', run: () => void runFullProcess(ctx) },
  ];
}

const MENU_CAP = 10;

/**
 * 孤儿附件：轻菜单列文件（**附件不在笔记索引里**，跳「全部笔记」选不到它们）——
 * 点一项 = 在系统资源管理器中显示（与目录树/网格文件夹菜单同一个口）。
 */
async function openOrphansMenu(ctx: WorkbenchContext, anchor: HTMLElement): Promise<void> {
  const f = await latestMaintenance(ctx);
  const kbRoot = ctx.settings.kbRoot();
  const rels = f.orphans.rels;
  if (rels.length === 0) return; // 竞态：算完到现在被清了
  const r = anchor.getBoundingClientRect();
  showMenu(
    { x: r.left, y: r.bottom },
    {
      scope: { kind: 'global', label: `${rels.length} 件没人引用的附件`, icon: 'file-question' },
      items: [
        ...rels.slice(0, MENU_CAP).map((rel) => ({
          kind: 'item' as const,
          label: rel.split('/').pop() ?? rel,
          icon: 'file',
          hint: parentOf(rel),
          run: () => showInSystemExplorer(ctx, joinPath(kbRoot, rel)),
        })),
        ...(rels.length > MENU_CAP
          ? [
              {
                kind: 'item' as const,
                label: `还有 ${rels.length - MENU_CAP} 件…`,
                disabled: '一次只列前 10 件，先看看这些是不是真不要了',
              },
            ]
          : []),
      ],
    },
  );
}

/**
 * 重复文件：按组列（每组一个子菜单；同名的两件靠右侧的目录提示区分）。
 * 点一项 = 在系统资源管理器中显示 —— 删哪件由用户自己定（本轮**只报数**，见设计对表 §3）。
 */
async function openDuplicatesMenu(ctx: WorkbenchContext, anchor: HTMLElement): Promise<void> {
  const f = await latestMaintenance(ctx);
  const kbRoot = ctx.settings.kbRoot();
  const groups = f.dups.groups;
  if (groups.length === 0) return;
  const r = anchor.getBoundingClientRect();
  showMenu(
    { x: r.left, y: r.bottom },
    {
      scope: { kind: 'global', label: `${groups.length} 组重复文件`, icon: 'copy' },
      items: [
        ...groups.slice(0, 6).map((g, i) => ({
          kind: 'item' as const,
          label: `第 ${i + 1} 组 · ${g.length} 件`,
          icon: 'files',
          submenu: g.map((rel) => ({
            kind: 'item' as const,
            label: rel.split('/').pop() ?? rel,
            icon: 'file',
            hint: parentOf(rel),
            run: () => showInSystemExplorer(ctx, joinPath(kbRoot, rel)),
          })),
        })),
        ...(groups.length > 6
          ? [
              {
                kind: 'item' as const,
                label: `还有 ${groups.length - 6} 组…`,
                disabled: '一次只列前 6 组',
              },
            ]
          : []),
      ],
    },
  );
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i > 0 ? rel.slice(0, i) : '';
}

export const todoBlock: HomeBlock = {
  id: 'todo',
  title: '待处理',
  hint: '收件箱 / 缺属性 / 失效双链等六条规则的清单（可逐条忽略）',
  defaultOn: true,
  paint(ctx, host) {
    const myGen = ++gen;
    // ⚠️ 预演要读模板正文（模板自身没有前言）→ 异步；期间又重画过就整段作废（世代号）
    void paintTodo(ctx, host, myGen).catch((err) => {
      // 防御：真抛出来也别让首页整块空白（读模板的错已在 previewMigration 里兜了，这是最后一道）
      console.error('[经纬] 预演失败（首页待处理可能不全）', err);
      if (myGen !== gen) return;
      host.appendChild(div({ cls: 'kbw-home-clean', text: '待处理清单算不出来（见控制台）' }));
    });
    return true;
  },
  cleanup() {
    gen += 1;
  },
};

async function paintTodo(ctx: WorkbenchContext, host: HTMLElement, myGen: number): Promise<void> {
  /**
   * 段头与发丝线**先画**（同步、不等数据）—— P7.11 · #6/#7：工具条"入首行"靠
   * `paintInto` 画完就挂，而这一块的清单是异步算的（要读模板）——段头若还在
   * await 之后才画，入行那一步就找不到首行（工具会一直留在容器上、对不齐）。
   * 计数格先摆「…」，数据回来再填（观感与"先画骨架"一致）。
   * ⚠️ 清单体要**住在自己的容器**里（下面 `bodyHost`）：展开/收起只重画它 ——
   * 清整个 host 会把首行（连同里面的工具条）一起清掉（"Region 清宿主"的同款教训）。
   */
  const head = div({ cls: 'kbw-sec-head' });
  head.appendChild(el('h3', { text: '待处理' }));
  const cntEl = div({ cls: 'kbw-sec-cnt', text: '…' });
  head.appendChild(cntEl);
  host.appendChild(head);
  host.appendChild(div({ cls: 'kbw-rule' }));
  const bodyHost = div({ cls: 'kbw-todo-body-host' });
  host.appendChild(bodyHost);

  /**
   * 清单 = `todo-actions` 的 `computeTodoItems`（P7.13b 起**渲染与动作读同一份**：
   * 预演 + 维护三件 + `buildTodos` + 忽略过滤；"跳过的篇也算还没迁完"那条口径
   * 跟着搬去了那边）。异步要读模板正文 → 回来时先验世代号。
   */
  const items = await computeTodoItems(ctx);
  const dismissed = ctx.settings.get().homeDismissed;
  if (myGen !== gen) return;

  // 段头已在函数开头同步画好 —— 这里只把计数填上（P7.11 · #6/#7 的连带）
  cntEl.textContent = items.length === 0 ? '0 项' : `${items.length} 项`;

  /**
   * **只重画清单体**（P7.11 · #10）：展开/收起是纯前端状态切换 ——
   * 照 walk「换一批」的口径"只重画该重画的那一段"，不清首行（清了就丢工具条）。
   */
  const renderBody = (): void => {
    bodyHost.textContent = '';
    const folded = fold(items);
    const shown = expanded ? items : folded.shown;
    const rest = expanded ? 0 : folded.rest;
    if (items.length === 0) {
      bodyHost.appendChild(
        div({
          cls: 'kbw-home-clean',
          text: dismissed.length > 0 ? '眼下没有待处理的事（有些项被你忽略了）' : '库是干净的',
        }),
      );
    }
    for (const item of shown) bodyHost.appendChild(todoRow(ctx, item));
    if (rest > 0) {
      // 展开行（P7.11 · #10）：**可点**（role=button + hover 高亮）—— 展开全部
      const row = div({
        cls: ['kbw-todo-rest', 'is-act', 'kbw-hover-1'],
        attr: { role: 'button', tabindex: '0' },
        on: {
          click: () => {
            expanded = true;
            renderBody();
          },
          keydown: (evt) => {
            const k = (evt as KeyboardEvent).key;
            if (k === 'Enter' || k === ' ') {
              evt.preventDefault();
              expanded = true;
              renderBody();
            }
          },
        },
      });
      row.appendChild(span({ text: `还有 ${rest} 项` }));
      row.appendChild(span({ cls: 'kbw-todo-rest-act', text: '▸ 展开' }));
      bodyHost.appendChild(row);
    } else if (expanded && items.length > FOLD_AT) {
      // 展开态下的「收起」行（折回前 5 条）
      const row = div({
        cls: ['kbw-todo-rest', 'is-act', 'kbw-hover-1'],
        attr: { role: 'button', tabindex: '0' },
        on: {
          click: () => {
            expanded = false;
            renderBody();
          },
          keydown: (evt) => {
            const k = (evt as KeyboardEvent).key;
            if (k === 'Enter' || k === ' ') {
              evt.preventDefault();
              expanded = false;
              renderBody();
            }
          },
        },
      });
      row.appendChild(span({ text: '收起' }));
      row.appendChild(span({ cls: 'kbw-todo-rest-act', text: '▾' }));
      bodyHost.appendChild(row);
    }
    if (dismissed.length > 0) {
      bodyHost.appendChild(
        div(
          {
            cls: ['kbw-todo-rest', 'is-act', 'kbw-hover-1'],
            attr: { role: 'button', tabindex: '0' },
            on: {
              click: () => {
                void ctx.settings.save({ homeDismissed: [] });
                notify({ kind: 'info', text: '已恢复被忽略的待处理项', ms: NOTIFY_MS.info });
              },
            },
          },
          `已忽略 ${dismissed.length} 项 · 恢复`,
        ),
      );
    }
  };
  renderBody();
}
