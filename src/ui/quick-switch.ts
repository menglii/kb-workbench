/**
 * ui/quick-switch.ts —— **快速切换**（P4.5 e2 期 §4.1）
 *
 * §4.1 的原话：「工作台内 `Ctrl+P` 风格：跳笔记 / 跳板块 / 跑命令（看板现在完全没有搜索）」。
 *
 * ── 三条开工时就定下来的口径（`看板优化方案.md` §6.16）──────────
 *  ① 「`Ctrl+P` 风格」说的是**形态**（一个输入框 + 一组结果 + 上下选），**不是键位**：
 *     本体的 `Ctrl+P` 是命令面板、`Ctrl+O` 是快速切换器（真机枚举过），
 *     所以默认定成 **`Mod+Shift+O`**（与本体那个同源记忆），并进 §1.4 的快捷键表（可改绑）。
 *  ② **它只是个浮层**：走 `ui/panel.ts` 的 `openModal`（唯一实现点），别在模块里另起一个。
 *  ③ **选中之后"定位"而不是"打开"**（用户 2026-09-25 拍板）：跳到那一屏、让它**可见**
 *     （板块收起着就展开、卡片滚进视野）；`Ctrl/Cmd+Enter` 才是"在新标签页打开"——
 *     与工作台里既有的键盘语义一致（`Ctrl+Enter` 一直是"新标签打开"）。
 *
 * ── 三类目标（用户拍板的口径）────────────────────────────────
 *  · **笔记**：全库索引（模板除外）
 *  · **板块**：看板配置里的板块（各带自己的数据源说明）
 *  · **命令**：插件自己的命令（`core/commands.ts`，唯一出处）+ 工作台内的动作
 *    （设置面板 / 快捷键表 / 快速捕获）——**不列全平台命令**：那是本体 `Ctrl+P` 的事。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { div, el, span, btn } from './primitives';
import { openModal } from './panel';
import { notifyError } from './notify';
import { COMMANDS, type CommandDeps } from '../core/commands';
import type { BoardConfig, SectionKind } from '../modules/board/config';
import { openNewNoteDialog } from './new-note';
import { openQuickCapture } from './quick-capture';
import { openRebuildPanel } from './rebuild-panel';

/** 一行结果 */
interface Row {
  kind: '笔记' | '板块' | '命令';
  /** 主标题 */
  label: string;
  /** 次标题（路径 / 数据源 / 说明） */
  detail: string;
  /** 匹配用的小写串（fuzzy 的 haystack） */
  hay: string;
  /** 选中之后干什么（返回 Promise 只为"命令可能是异步的"） */
  run: () => void | Promise<void>;
  /** `Ctrl/Cmd+Enter`：**只对笔记有意义**（"在新标签页打开"），其余行没有这一档 */
  openInTab?: () => void | Promise<void>;
}

/** 每个类别最多显示几行（免得"笔记"把板块和命令挤下去） */
const PER_KIND_CAP = 12;
const EMPTY_NOTE_ROWS = 6;

export function openQuickSwitch(ctx: WorkbenchContext): void {
  const h = openModal({
    title: '快速切换',
    sub: '跳笔记 / 跳板块 / 跑命令 · 回车去那儿，Ctrl+回车在新标签页打开',
    width: 'normal',
  });

  const input = el('input', {
    cls: 'kbw-input',
    attr: { type: 'text', placeholder: '输入以筛选…（笔记名 / 板块名 / 命令）' },
  });
  input.style.width = '100%';
  input.setAttribute('data-quick', 'input');
  h.body.appendChild(input);

  const hint = div({ cls: 'kbw-modal-sub', text: '读目标…' });
  h.body.appendChild(hint);
  const list = div({ cls: 'kbw-pick-list' });
  h.body.appendChild(list);

  let rows: Row[] = [];
  let shown: Row[] = [];
  let at = 0;

  const paint = (): void => {
    while (list.firstChild) list.removeChild(list.firstChild);
    if (shown.length === 0) {
      list.appendChild(div({ cls: 'kbw-set-empty', text: '没有匹配项' }));
      return;
    }
    shown.forEach((r, i) => {
      const item = div({
        cls: ['kbw-pick-item', 'kbw-hover-1', i === at ? 'is-cursor' : null],
        attr: { role: 'button', tabindex: '-1', 'data-kind': r.kind },
        on: {
          click: () => {
            at = i;
            void commit(false);
          },
        },
      });
      const top = div({ cls: 'kbw-pick-t' });
      top.appendChild(span({ cls: 'kbw-qs-kind', text: r.kind }));
      top.appendChild(span({ text: r.label }));
      item.appendChild(top);
      if (r.detail) item.appendChild(div({ cls: 'kbw-pick-d', text: r.detail }));
      list.appendChild(item);
    });
    /**
     * 选中行滚进视野 —— **取左侧可见区域的中点并夹进视口**那条规矩在这里用不上
     *（这个列表不宽），但 `scrollIntoView` 仍然只给 `nearest`：整页滚一下会很突兀。
     */
    const cur = list.children[at] as HTMLElement | undefined;
    cur?.scrollIntoView?.({ block: 'nearest' });
  };

  const repaint = (): void => {
    shown = rankQuickRows(rows, input.value);
    at = 0;
    paint();
    const cur = shown[0];
    hint.textContent = cur ? cur.detail || ' ' : '没有匹配项';
  };

  const move = (d: number): void => {
    if (shown.length === 0) return;
    at = (at + d + shown.length) % shown.length;
    paint();
    hint.textContent = shown[at]?.detail ?? '';
  };

  /** 选中之后：`openInTab` = Ctrl/Cmd+Enter（只有笔记行有这一档，其余照常执行） */
  async function commit(openInTab: boolean): Promise<void> {
    const row = shown[at];
    if (!row) return;
    h.close('run');
    try {
      const fn = openInTab && row.openInTab ? row.openInTab : row.run;
      await fn();
    } catch (e) {
      notifyError('这一步没做成', e instanceof Error ? e.message : String(e));
    }
  }

  input.addEventListener('input', repaint);
  input.addEventListener('keydown', (evt) => {
    const kev = evt as KeyboardEvent;
    if (kev.key === 'ArrowDown') {
      kev.preventDefault();
      move(1);
      return;
    }
    if (kev.key === 'ArrowUp') {
      kev.preventDefault();
      move(-1);
      return;
    }
    if (kev.key === 'Enter') {
      kev.preventDefault();
      void commit(kev.ctrlKey || kev.metaKey);
    }
  });

  h.foot.style.display = '';
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => h.close('cancel') } }));

  void (async () => {
    rows = await collect(ctx);
    repaint();
    input.focus();
  })();
}

/**
 * 收集三类候选。
 *
 * ⚠️ 是异步的（要看板配置）→ 先开窗、后填表（别让按键等 IO）。
 * 索引/配置都还没就绪时**如实说**（空列表 + 一句提示），不是一片空白。
 */
async function collect(ctx: WorkbenchContext): Promise<Row[]> {
  const out: Row[] = [];
  const deps = commandDeps(ctx);

  /** 板块：数据源 + 取值一句人话（与 §4.1 的板块头口径一致） */
  let cfg: BoardConfig | null = null;
  try {
    cfg = (await ctx.configs.read('board')) as BoardConfig;
  } catch (e) {
    console.error('[经纬] 快速切换：读看板配置失败', e);
  }
  for (const sec of cfg?.sections ?? []) {
    out.push({
      kind: '板块',
      label: sec.name,
      detail: `${sourceWord(sec.kind)}${sec.kind === 'shelter' ? '' : `：${sec.value}`}`,
      hay: `${sec.name} ${sec.value}`.toLowerCase(),
      run: () => ctx.goBoard({ sectionId: sec.id }),
    });
  }

  for (const cmd of COMMANDS) {
    out.push({
      kind: '命令',
      label: cmd.name,
      detail: '插件命令',
      hay: cmd.name.toLowerCase(),
      run: () => cmd.run(deps),
    });
  }
  out.push({
    kind: '命令',
    label: '工作台设置',
    detail: '打开内置设置面板',
    hay: '工作台设置 设置面板 setting',
    run: () => ctx.openWorkbenchSettings(),
  });
  out.push({
    kind: '命令',
    label: '快捷键表',
    detail: '看与改全部键位',
    hay: '快捷键表 键位 keymap',
    run: () => ctx.openKeysHelp(),
  });

  /**
   * 笔记：**最近改动的排前面**（空查询时那几行才有意义 —— 按路径排会全是
   * "00_Inbox/…"，一条也不像"我最近在写的东西"）。
   */
  const notes = ctx.index
    .notes()
    .slice()
    .sort((a, b) => b.mtime - a.mtime);
  for (const e of notes) {
    out.push({
      kind: '笔记',
      label: e.basename,
      detail: e.path,
      hay: `${e.basename} ${e.path}`.toLowerCase(),
      run: () => {
        /**
         * 「跳笔记」走**现有的意图机制**（`goNotes`）：切到那一屏 + 只列这一篇 + 选中它 +
         * 滚进视野。⚠️ **新开一个纯跳转是不必要的第二套实现** —— 意图是**一次性**的
         *（`notesIntentSeq` 判新旧），不会把用户的筛选态永久改掉。
         */
        ctx.goNotes({ paths: [e.path], selectPaths: [e.path] });
      },
      openInTab: () => {
        /**
         * `Ctrl/Cmd+Enter` = 在新标签页打开（与工作台里既有的键位语义一致）。
         * ⚠️ 一律 `getLeaf('tab')`：`getLeaf(false)` 会**替换当前叶子** ——
         * 而当前叶子常常就是工作台那一页（坑/平台.md 记过：一开笔记工作台就没了）。
         */
        const f = ctx.app.vault.getAbstractFileByPath(e.path);
        if (!f) {
          notifyError('这篇不在了', e.path);
          return;
        }
        return ctx.app.workspace.getLeaf('tab').openFile(f as TFile).then(() => undefined);
      },
    });
  }
  return out;
}

/** 命令那一类要的那束依赖（`core/commands.ts` 是唯一出处，这里只是把 ctx 掰成它要的形状） */
function commandDeps(ctx: WorkbenchContext): CommandDeps {
  return {
    activate: () => ctx.activate(),
    newNote: () => openNewNoteDialog(ctx),
    rebuild: () => openRebuildPanel(ctx),
    snapshotPanel: () => ctx.openSnapshotPanel(),
    quickCapture: () => openQuickCapture(ctx),
  };
}

function sourceWord(kind: SectionKind): string {
  if (kind === 'folder') return '文件夹源';
  if (kind === 'tag') return '标签源';
  if (kind === 'prop') return '属性值源';
  return '收容所';
}

/**
 * **筛选与排序**（纯函数，可离线钉住）。
 *
 * 口径（用户拍板 + 开工时定的）：
 *  · 空查询：**板块与命令全列**（它们本来就没几行），笔记只给**最近改动的几条** ——
 *    一进来就摊开几百篇笔记，反而找不到"板块/命令"这两类。
 *  · 有查询：按**命中位置**排（越靠前越相关），每个类别封顶 `PER_KIND_CAP` 行
 *    （否则"笔记"会把板块与命令整批挤下去 —— 那两类一行只有一条，挤掉就没了）。
 *
 * 契约：`hay` **由调用方预先小写化**（构建候选时做一次，别每次按键都重算几百行）；
 * 这里只负责把查询词也小写化再比。
 */
export function rankQuickRows<T extends { kind: string; hay: string }>(
  rows: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return rows
      .filter((r) => r.kind !== '笔记')
      .concat(rows.filter((r) => r.kind === '笔记').slice(0, EMPTY_NOTE_ROWS));
  }
  const scored = rows
    .map((r) => {
      const i = r.hay.indexOf(q);
      return i < 0 ? null : { r, score: i };
    })
    .filter((x): x is { r: T; score: number } => x != null)
    // 稳定排序：同分保持原顺序（笔记已按"最近改动"排好，别被这一步打乱）
    .sort((a, b) => a.score - b.score);
  const perKind: Record<string, number> = {};
  const out: T[] = [];
  for (const { r } of scored) {
    perKind[r.kind] = (perKind[r.kind] ?? 0) + 1;
    if (perKind[r.kind] > PER_KIND_CAP) continue;
    out.push(r);
  }
  return out;
}
