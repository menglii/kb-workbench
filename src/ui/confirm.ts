/**
 * ui/confirm.ts —— 动库操作前确认的**唯一出口**（三条架构硬规矩之三）
 *
 * 唯一例外是**拖拽**（即时生效 + 撤销条 + 快照兜底，交互规格 §9）——
 * 直接操纵求的就是"直接"，弹窗会把手感全毁；手机端长按拖动本来就慢，
 * 再加一步确认会让人不想用。
 *
 * 文案规则（§9）：
 *   · 标题说清**数量 + 动作**：「即将移动 12 篇笔记」，不是「确认操作」
 *   · 主按钮**重复数量**：「移动 12 篇」，不是「确定」
 *   · **被跳过的要说出来**：撞名几篇、锁定几篇
 *
 * 取消也走返回值，不靠异常 —— `Promise<ConfirmResult>`。
 */
import { btn, div, el, icon, span, type Child } from './primitives';
import { openModal, type Point } from './panel';

export type ConfirmResult =
  | { action: 'primary' }
  | { action: 'secondary'; value: string } // 「改一下」「只看不动」
  | { action: 'cancel' };

/**
 * **管线跑法给人的结算**（P7.24 · L2 服务族）：面板里的"一键"与 agent 驱动**共用**这一份形状
 * —— 跑完/取消/没得跑/跑不动，四态如实（`ai-tools.ts` 的 `runPanelTool` 靠它回传模型）。
 */
export interface PipeSettle {
  action: 'executed' | 'cancelled' | 'empty' | 'blocked';
  /** executed = 如实摘要（「搬 3 篇 / 挂链 1 篇」）；其它档 = 一句话原因 */
  summary: string;
}

/** ⚠️ 形状由操作决定，不是固定 from/to（开发计划 §5.2） */
export type PlanRow =
  /**
   * `chip`（P7.12 · #9/#11）：行尾小徽标 —— 「一键整理」的 AI 预整理在确认单上
   * **明写自己的动作**（"AI 补「文件位置」：X" / "AI 改声明"，`warn` 那档换警示色）。
   */
  | { kind: 'move'; from: string; to: string; count: number; chip?: { text: string; warn?: boolean } }
  | { kind: 'set'; prop: string; from: string; to: string; count: number }
  | { kind: 'tag'; add?: string[]; remove?: string[]; count: number }
  | { kind: 'delete'; where: string; count: number }
  /** 新建（P7.3b agent 的 create 工具；`title` 是文件名，`to` 是落点目录） */
  | { kind: 'create'; title: string; to: string; count: number }
  /** 挂链（P7.6 整理建议的面板：把笔记挂进 MOC 的某一节；`from`/`to` 都是给人看的短句） */
  | { kind: 'link'; from: string; to: string; count: number }
  /** 改名（P7.8「AI 起标题」的确认流；`from`/`to` = 旧/新**文件名**。16.3 批量改名也用这一档） */
  | { kind: 'rename'; from: string; to: string; count: number }
  /**
   * 清理（P7.18 退出清理：删属性键 / 清足迹 —— 两类目标共用）。
   * `target` 是一整句人话（如「属性键「状态」（从这些笔记里删掉）」）；
   * `unit` 默认「项」（键删除那类传「篇」）。
   */
  | { kind: 'purge'; target: string; count: number; unit?: string }
  /**
   * **改正文**（P7.22a agent 的 `patch_text` / `append`）：`where` = 篇名，
   * `change` = 一行改动摘要（如「替换 1 处：旧 → 新」/「末尾追加 12 字」）。
   */
  | { kind: 'text'; where: string; change: string; count: number }
  /**
   * **打开（只开标签页、不动库）**（P7.23 · Q9「打开所选」>10 的确认）：
   * `where` = 一行说明（如「每篇各开一个标签页」）。它**不改任何文件** ——
   * 调用方要把 `snapshot` 覆写成"不改动任何文件"，别让"自动快照"那句误导。
   * ⚠️ 本行种类是**有意识给确认流开的第二个口子**（头一个 = `attach`，P7.12 R8）：
   * 确认流的展示语义从此多了"非动库动作"这一类，红线不变（动库照样只能过 confirm）。
   */
  | { kind: 'open'; where: string; count: number };

export interface ConfirmSpec {
  /** 「即将移动 12 篇笔记」 */
  title: string;
  preview: PlanRow[];
  /** 撞名等（黄色） */
  warnings: string[];
  /** ⚠️ 位置锁定走这里，文案是「将一并移动（设了位置锁定）」不是「已跳过」 */
  notes: string[];
  /** 自定义快照文案；不传则显示默认那句 */
  snapshot?: string;
  danger?: {
    /** 「再点一次确认」 */
    confirmLabel: string;
    /** trashOption 非本地 .trash 时 true */
    irreversible?: boolean;
    /** 置灰原因 */
    disableReason?: string;
  };
  /** 「移动 12 篇」 */
  primary: { label: string };
  /** 「改一下」「只看不动」 */
  secondary?: { label: string; value: string }[];
  /**
   * 预览折行那句「…还有 N ？ 」的量词（P7.10 · #9 加）。
   * 默认 `'组'` —— 多数调用方的预览行是**分组行**（按目录/节/属性键，行内各自标了"N 篇"）；
   * `modules/home/tidy.ts` 改成**逐篇**预览后每行 = 1 篇，显式传 `'篇'`
   *（独立审 2026-10-05 🟡2：混用会让"还有 5 篇"实际指"5 个目录"）。
   */
  foldUnit?: '篇' | '组';
  /**
   * **自定义内容块**（P7.12 · R8「美化笔记」开的第一个口子）：插在预览行之后、
   * 警告/说明之前。**这是 `ui/confirm.ts` 唯一一处"调用方自己画 DOM"的地方** ——
   * 只放**只读的展示物**（如正文对比框），回调和状态不许挂进来：
   * 确认流的行为（按钮/Enter/Esc/取消语义）必须继续由本组件独家说了算，
   * 否则"动库前确认只能过 confirm"这条硬规矩会从这一个口子漏掉。
   */
  attach?: (host: HTMLElement) => void;
}

export interface ConfirmOptions {
  /** 触发点（从那儿展开） */
  origin?: Point;
  width?: 'narrow' | 'normal' | 'wide';
}

const DEFAULT_SNAPSHOT = '执行前会自动快照，可一键还原';

export function confirm(spec: ConfirmSpec, opts: ConfirmOptions = {}): Promise<ConfirmResult> {
  return new Promise<ConfirmResult>((resolve) => {
    let done = false;
    const finish = (r: ConfirmResult): void => {
      if (done) return;
      done = true;
      handle.close(r.action);
      resolve(r);
    };

    const handle = openModal({
      title: spec.title,
      origin: opts.origin,
      width: opts.width ?? 'normal',
      onClose: (reason) => {
        if (!done) {
          done = true;
          resolve({ action: 'cancel' });
        }
        void reason;
      },
    });

    const body = handle.body;

    /**
     * ── 预览（有多少说多少，超过 12 行折叠成一句）──
     *
     * 🔴 **P7.10 · #9 有意识的修改：折 6 → 12**（12 与 `modules/home/tidy.ts` 那条
     * "确认流里不摊 40 行"的旧上限同值）。折叠**单位**由 `spec.foldUnit` 指定
     *（默认「组」= 分组行；tidy 的逐篇预览传「篇」—— 独立审 🟡2 抓的单位混用）。
     */
    const list = div({ cls: 'kbw-confirm-preview' });
    const shown = spec.preview.slice(0, 12);
    for (const row of shown) list.appendChild(renderPlanRow(row));
    if (spec.preview.length > shown.length) {
      list.appendChild(
        div({
          cls: 'kbw-plan-row is-more',
          text: `…还有 ${spec.preview.length - shown.length} ${spec.foldUnit ?? '组'}`,
        }),
      );
    }
    body.appendChild(list);

    /**
     * 自定义内容块（`spec.attach`）：只读展示物（目前的唯一用户 = 「美化笔记」的对比框）。
     * ⚠️ 插在预览行之后、警告/说明之前 —— "先说改什么、再看长什么样、最后说注意什么"。
     */
    if (spec.attach) spec.attach(body);

    // ── 警告与说明 ──
    if (spec.warnings.length > 0) body.appendChild(msgBlock('is-warn', spec.warnings));
    if (spec.notes.length > 0) body.appendChild(msgBlock('is-info', spec.notes));

    // ── 快照承诺 ──（相机图标走 lucide —— P7.7c 图标纪律：原来写的是 📸 emoji，
    // 长相由字体决定；稿子（s-confirm 的 snap-strip）画的就是 lucide 相机 + accent）
    const snapLine = div({ cls: 'kbw-confirm-snapshot' });
    snapLine.appendChild(icon('camera', 14, 'kbw-ico kbw-confirm-snap-ic'));
    snapLine.appendChild(span({ text: spec.snapshot ?? DEFAULT_SNAPSHOT }));
    body.appendChild(snapLine);

    // ── 底部 ──
    handle.foot.style.display = '';
    const cancelBtn = btn({
      cls: 'kbw-btn kbw-hover-1',
      text: '取消',
      on: { click: () => finish({ action: 'cancel' }) },
    });

    const primaryDisabled = Boolean(spec.danger?.disableReason);
    const primaryBtn = btn({
      cls: ['kbw-btn', spec.danger ? 'is-danger' : 'is-primary', primaryDisabled ? 'is-disabled' : null],
      text: spec.danger?.disableReason ? spec.danger.disableReason : spec.primary.label,
      attr: primaryDisabled ? { disabled: true, title: spec.danger?.disableReason ?? '' } : {},
    });

    let armed = false;
    primaryBtn.addEventListener('click', () => {
      if (primaryDisabled) return;
      if (spec.danger && !armed) {
        // 两下确认：第一下变文案（§8.2 删板块）
        armed = true;
        primaryBtn.textContent = spec.danger.confirmLabel;
        primaryBtn.classList.add('is-armed');
        const note = div({
          cls: 'kbw-danger-note',
          text: spec.danger.irreversible
            ? '删除后只能靠快照还原；快照失败则不可逆'
            : '再点一次就执行',
        });
        note.dataset.role = 'danger-note';
        handle.foot.insertBefore(note, handle.foot.firstChild);
        return;
      }
      finish({ action: 'primary' });
    });

    const secondaryBtns: Child[] = [];
    for (const sec of spec.secondary ?? []) {
      secondaryBtns.push(
        btn({
          cls: 'kbw-btn kbw-hover-1',
          text: sec.label,
          on: { click: () => finish({ action: 'secondary', value: sec.value }) },
        }),
      );
    }
    if (spec.danger?.irreversible) {
      const warn = div({
        cls: 'kbw-danger-note',
        text: '注意：这次操作的删除项不进本地回收站，只能靠快照还原',
      });
      body.appendChild(warn);
    }

    for (const b of secondaryBtns) handle.foot.appendChild(b as Node);
    handle.foot.appendChild(div({ cls: 'kbw-spacer' }));
    handle.foot.appendChild(cancelBtn);
    handle.foot.appendChild(primaryBtn);

    // Enter = 主按钮（危险态第一次 Enter 只负责"上膛"）
    handle.disposer.add(
      (() => {
        const h = (evt: Event): void => {
          const kev = evt as KeyboardEvent;
          if (kev.key !== 'Enter') return;
          if (kev.target instanceof HTMLInputElement || kev.target instanceof HTMLTextAreaElement) return;
          kev.preventDefault();
          primaryBtn.click();
        };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
      })(),
    );

    primaryBtn.focus();
  });
}

function msgBlock(cls: string, lines: string[]): HTMLElement {
  const box = div({ cls: ['kbw-msg', cls] });
  const ul = el('ul', { cls: 'kbw-msg-list' });
  for (const line of lines) ul.appendChild(el('li', { text: line }));
  box.appendChild(ul);
  return box;
}

function renderPlanRow(row: PlanRow): HTMLElement {
  const root = div({ cls: 'kbw-plan-row' });
  const path = (t: string): HTMLElement => span({ cls: 'kbw-plan-path', text: t, title: t });
  const arrow = (): HTMLElement => span({ cls: 'kbw-plan-arrow', text: '→' });

  if (row.kind === 'move') {
    root.appendChild(path(row.from));
    root.appendChild(arrow());
    root.appendChild(path(row.to));
    if (row.chip) {
      root.appendChild(span({ cls: ['kbw-plan-chip', row.chip.warn ? 'is-warn' : null], text: row.chip.text }));
    }
  } else if (row.kind === 'set') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: row.prop }));
    root.appendChild(path(row.from || '（空）'));
    root.appendChild(arrow());
    root.appendChild(path(row.to || '（空）'));
  } else if (row.kind === 'tag') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '标签' }));
    if (row.add && row.add.length > 0) root.appendChild(path(`+${row.add.join(' +')}`));
    if (row.remove && row.remove.length > 0) root.appendChild(path(`−${row.remove.join(' −')}`));
  } else if (row.kind === 'create') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '新建' }));
    root.appendChild(path(row.title || '（没写标题）'));
    root.appendChild(arrow());
    root.appendChild(path(row.to));
  } else if (row.kind === 'link') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '挂链' }));
    root.appendChild(path(row.from));
    root.appendChild(arrow());
    root.appendChild(path(row.to));
  } else if (row.kind === 'rename') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '改名' }));
    root.appendChild(path(row.from));
    root.appendChild(arrow());
    root.appendChild(path(row.to));
  } else if (row.kind === 'purge') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '清理' }));
    root.appendChild(path(row.target));
  } else if (row.kind === 'text') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '改正文' }));
    root.appendChild(path(row.where));
    root.appendChild(span({ cls: 'kbw-plan-path', text: row.change, title: row.change }));
  } else if (row.kind === 'open') {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '打开' }));
    root.appendChild(path(row.where));
  } else {
    root.appendChild(span({ cls: 'kbw-plan-kind', text: '删除' }));
    root.appendChild(path(row.where));
  }
  root.appendChild(
    span({ cls: 'kbw-plan-count', text: `${row.count} ${row.kind === 'purge' ? (row.unit ?? '项') : '篇'}` }),
  );
  return root;
}
