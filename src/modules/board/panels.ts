/**
 * modules/board/panels.ts —— **板块管理面板**（交互规格 §4.1）
 *
 * | 操作 | 触发 | 发生什么 |
 * |---|---|---|
 * | 打开 | 点 ⚙ 板块 | 居中悬浮面板（**再点一次关**；`Esc` 关） |
 * | 拖动排序 | 拖 ⣿ 手柄 | 换序（顺序 = 优先级，配合"允许重复"） |
 * | 改名 | 双击板块名 | 就地输入框 |
 * | 详细设置 | 点 ✎ | 展开：数据源 / **排除** / 上限 / 排序 / 显正文 / 属性列覆盖 |
 * | 删除 | 点 ✕ | **只删配置，绝不碰笔记**；两下确认 |
 * | 添加 | ＋ 添加板块 | 先选数据源类型 → 再选具体值 |
 * | 计数 | — | 每行实时显示命中多少条 |
 *
 * ⚠️ 两条纪律：
 *  ① **面板里的每次改动都当场落盘**（`store.save`），并给顶上一行回执 ——
 *     没有"保存按钮"，所以不能有"改了没生效"的中间态
 *  ② **删除板块只动配置**：笔记一篇都不碰（这条在文案里也写着，避免用户以为会删笔记）
 */
import type { WorkbenchContext } from '../../core/context';
import { div, el, span, btn, clear, icon, iconBtn, multiSelect } from '../../ui/primitives';
import { openFloating, pointFromEl } from '../../ui/panel';
import { startPointerDrag } from '../../ui/dnd';
import { relativeTo } from '../../core/paths';
import { kbDirs } from '../../ui/new-note';
import {
  SECTION_KIND_LABEL,
  newSectionId,
  type BoardConfigStore,
  type BoardSection,
  type CardMode,
  type SectionKind,
} from './config';

export interface PanelCtx {
  ctx: WorkbenchContext;
  store: BoardConfigStore;
  anchor: HTMLElement | null;
  /** 打开时就直接进入"添加板块"（工具条的「＋ 添加板块」） */
  addNew?: boolean;
  /** 每次改动后通知模块重画 */
  onChanged: (receipt?: string) => void;
  /** 需要重画面板自己 */
  onNeedsRender: () => void;
  /** 每个板块当前命中多少条（实时计数） */
  counts?: () => Map<string, number>;
  /** 面板关了 */
  onClose?: () => void;
}

let current: { close: () => void } | null = null;
/**
 * 上一次"被点外面关掉"的时刻。
 * 为什么要它：⚙ 按钮是**开/关**一个悬浮面板，而"点外面关"这条规则会让
 * 「点 ⚙ 想关掉」变成「先被外面关掉、紧接着 click 又把它开回来」——
 * 看起来像没反应。记一个 350ms 的窗口，这次点击就不再重开（用户 2026-09-25 反馈）。
 */
let closedByOutsideAt = 0;

export function isSectionPanelOpen(): boolean {
  return current != null;
}

export function closeSectionPanel(): void {
  current?.close();
  current = null;
}

export function openSectionPanel(p: PanelCtx): void {
  if (current) {
    closeSectionPanel();
    return; // 「再点一次关」
  }
  if (Date.now() - closedByOutsideAt < 350) return; // 刚被这次点击关掉 → 别再开回来
  const h = openFloating({
    title: '板块管理',
    sub: '顺序 = 优先级（配合「允许重复」）；删除板块只删配置，笔记一篇都不动',
    width: 'normal',
    // 点外面就关（用户 2026-09-25 反馈：原先要按 Esc 或再点一次 ⚙ 才关得掉）
    closeOnOutside: true,
    ...(p.anchor ? { origin: pointFromEl(p.anchor) } : {}),
    onClose: (reason) => {
      if (reason === 'outside') closedByOutsideAt = Date.now();
      current = null;
      p.onClose?.();
    },
  });
  current = { close: () => h.close('toggle') };

  /** 展开着详细设置的行（重画面板时要保留） */
  const openRows = new Set<string>();
  /** 待确认删除的行（两下确认） */
  const armedDelete = new Set<string>();
  /** 正在就地改名的行 */
  let renaming: string | null = null;

  const rerender = (): void => {
    clear(h.body);
    h.body.appendChild(buildAll());
    p.onNeedsRender();
  };

  const save = async (sections: BoardSection[], receipt: string): Promise<void> => {
    await p.store.save({ sections });
    p.onChanged(receipt);
    rerender();
  };

  function buildAll(): HTMLElement {
    const wrap = div({ cls: 'kbw-bp' });
    const cfg = p.store.get();
    const counts = p.counts?.() ?? new Map<string, number>();

    if (p.addNew === true) {
      openRows.add('__new__');
      p.addNew = false;
    }

    wrap.appendChild(
      div({
        cls: 'kbw-bp-hint',
        text: '拖动 ⣿ 换序 · 双击名字改名 · ✎ 详细设置 · ✕ 删除（只删配置）',
      }),
    );

    cfg.sections.forEach((sec, i) => {
      wrap.appendChild(buildRow(sec, i, counts.get(sec.id) ?? 0));
    });

    if (openRows.has('__new__')) wrap.appendChild(buildAddRow());

    wrap.appendChild(
      div({ cls: 'kbw-bp-foot' },
        btn({
          cls: 'kbw-btn is-small is-primary',
          text: '＋ 添加板块',
          on: { click: () => { openRows.add('__new__'); rerender(); } },
        }),
      ),
    );
    return wrap;
  }

  // ── 一行 ─────────────────────────────────────────────────────
  function buildRow(sec: BoardSection, index: number, hits: number): HTMLElement {
    const cfg = p.store.get();
    const row = div({ cls: 'kbw-bp-row' });
    row.dataset.id = sec.id;

    const head = div({ cls: 'kbw-bp-head' });

    // ⣿ 拖排序手柄
    const grip = span({
      cls: 'kbw-bp-grip',
      attr: { role: 'button', tabindex: '0', 'aria-label': '拖动排序' },
    });
    grip.appendChild(icon('grip-vertical', 15));
    grip.addEventListener('pointerdown', (evt) => {
      const down = evt as PointerEvent;
      if (down.button !== 0) return;
      const rowEl = row;
      let last = document.elementFromPoint(down.clientX, down.clientY) as HTMLElement | null;
      startPointerDrag(down, sec.id, {
        onStart: () => {
          document.documentElement.classList.add('kbw-bp-dragging');
          rowEl.classList.add('is-dragging');
        },
        onOver: (t) => {
          if (t) last = t;
        },
        onDrop: () => {
          document.documentElement.classList.remove('kbw-bp-dragging');
          rowEl.classList.remove('is-dragging');
          const targetRow = last?.closest?.('[data-id]') as HTMLElement | null;
          const targetId = targetRow?.dataset.id;
          if (!targetId || targetId === sec.id) return;
          void moveTo(sec.id, targetId);
        },
        onCancel: () => {
          document.documentElement.classList.remove('kbw-bp-dragging');
          rowEl.classList.remove('is-dragging');
        },
      });
    });
    head.appendChild(grip);

    // 名字（双击改名）
    if (renaming === sec.id) {
      const input = el('input', {
        cls: 'kbw-inline-input',
        attr: { type: 'text', value: sec.name, 'aria-label': '板块名' },
      });
      let done = false;
      const finish = (commit: boolean): void => {
        if (done) return;
        done = true;
        renaming = null;
        const next = input.value.trim();
        if (commit && next && next !== sec.name) {
          void save(
            cfg.sections.map((s) => (s.id === sec.id ? { ...s, name: next } : s)),
            `板块改名：${sec.name} → ${next}`,
          );
        } else {
          rerender();
        }
      };
      input.addEventListener('keydown', (evt) => {
        const k = evt as KeyboardEvent;
        if (k.key === 'Enter') { k.preventDefault(); finish(true); }
        else if (k.key === 'Escape') { k.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      window.setTimeout(() => { input.focus(); input.select?.(); }, 0);
      head.appendChild(input);
    } else {
      head.appendChild(
        span({
          cls: 'kbw-bp-nm',
          text: sec.name,
          attr: { role: 'button', tabindex: '0', title: '双击改名' },
          on: { dblclick: () => { renaming = sec.id; rerender(); } },
        }),
      );
    }

    // 实时命中计数
    head.appendChild(
      span({
        cls: ['kbw-bp-count', hits === 0 ? 'is-zero' : null],
        text: hits === 0 ? '没有命中' : `${hits} 篇`,
        title: '当前命中的笔记数（改一下数据源/排除就跟着变）',
      }),
    );
    head.appendChild(div({ cls: 'kbw-bp-kind', text: SECTION_KIND_LABEL[sec.kind] }));
    head.appendChild(div({ cls: 'kbw-board-sp' }));

    // ▲▼（拖不动时的等价手段：触屏与键盘用户也能排序 —— §4.1 明写要有）
    const up = iconBtn('chevron-up', '上移', () => void swap(index, index - 1), {
      size: 14,
      cls: index === 0 ? 'is-disabled' : '',
    });
    const down = iconBtn('chevron-down', '下移', () => void swap(index, index + 1), {
      size: 14,
      cls: index === cfg.sections.length - 1 ? 'is-disabled' : '',
    });
    head.appendChild(up);
    head.appendChild(down);
    head.appendChild(
      // 用与全局设置同一个简笔齿轮（用户 2026-09-25：别用 settings-2 那个花哨变体）
      iconBtn('settings', '详细设置', () => {
        if (openRows.has(sec.id)) openRows.delete(sec.id);
        else openRows.add(sec.id);
        rerender();
      }),
    );
    const del = iconBtn(
      'x',
      armedDelete.has(sec.id) ? '再点一次确认删除' : '删除这个板块（只删配置，不碰笔记）',
      () => {
        if (!armedDelete.has(sec.id)) {
          armedDelete.add(sec.id);
          rerender();
          return;
        }
        armedDelete.delete(sec.id);
        void save(
          cfg.sections.filter((s) => s.id !== sec.id),
          `已删除板块「${sec.name}」（笔记一篇都没动）`,
        );
      },
    );
    if (armedDelete.has(sec.id)) {
      del.classList.add('is-armed');
      del.textContent = '再点一次';
    }
    head.appendChild(del);
    row.appendChild(head);

    if (openRows.has(sec.id)) row.appendChild(buildDetails(sec));
    return row;
  }

  // ── ✎ 详细设置 ───────────────────────────────────────────────
  function buildDetails(sec: BoardSection): HTMLElement {
    const cfg = p.store.get();
    const box = div({ cls: 'kbw-bp-detail' });

    // 数据源类型
    const kinds: SectionKind[] = ['folder', 'tag', 'prop', 'shelter'];
    const kindRow = div({ cls: 'kbw-bp-field' });
    kindRow.appendChild(bpLabel('数据源'));
    const seg = div({ cls: 'kbw-seg' });
    for (const k of kinds) {
      seg.appendChild(
        btn({
          cls: ['kbw-segbtn', sec.kind === k ? 'is-on' : null],
          text: SECTION_KIND_LABEL[k],
          on: {
            click: () => {
              if (sec.kind === k) return;
              const first = candidatesOf(k)[0] ?? '';
              /**
               * ⚠️ 换数据源类型会**清掉「排除」**（那是按旧源的路径配的，留着多半是错的）
               * —— 但**要在回执里说出来**，别让用户以为那条清单还在（独立审查 10e）。
               */
              const dropped = sec.exclude.length > 0 ? `（原「排除」里的 ${sec.exclude.length} 条已清掉）` : '';
              void save(
                cfg.sections.map((s) =>
                  s.id === sec.id ? { ...s, kind: k, value: k === 'shelter' ? '' : first, exclude: [] } : s,
                ),
                `「${sec.name}」数据源改成${SECTION_KIND_LABEL[k]}${
                  k === 'shelter' ? '' : `：${first || '（整个库）'}`
                }${dropped}`,
              );
            },
          },
        }),
      );
    }
    kindRow.appendChild(seg);
    box.appendChild(kindRow);

    if (sec.kind !== 'shelter') {
      const vRow = div({ cls: 'kbw-bp-field' });
      vRow.appendChild(bpLabel(sec.kind === 'folder' ? '目录' : sec.kind === 'tag' ? '标签' : '属性'));
      const sel = el('select', { cls: 'kbw-select is-small' });
      const cands = candidatesOf(sec.kind);
      if (!cands.includes(sec.value) && sec.value) cands.unshift(sec.value);
      for (const c of cands) sel.appendChild(el('option', { attr: { value: c }, text: c || '（整个库）' }));
      sel.value = sec.value;
      sel.addEventListener('change', () => {
        void save(
          cfg.sections.map((s) => (s.id === sec.id ? { ...s, value: sel.value } : s)),
          `「${sec.name}」的数据源：${sel.value || '库根'}`,
        );
      });
      vRow.appendChild(sel);
      box.appendChild(vRow);
    }

    // 排除（自研多选控件：初始值非空 + Backspace 删下拉两个 bug 都在 P3 修过）
    const eRow = div({ cls: 'kbw-bp-field is-col' });
    eRow.appendChild(bpLabel('排除'));
    eRow.appendChild(
      multiSelect({
        value: sec.exclude,
        candidates: () => excludeCandidates(p.ctx),
        placeholder: '排除的目录或笔记（回车加一条）',
        allowCustom: true,
        emptyHint: '库里能排除的目录都在上面',
        onChange: (next) => {
          void save(
            cfg.sections.map((s) => (s.id === sec.id ? { ...s, exclude: next } : s)),
            next.length > 0 ? `「${sec.name}」排除：${next.join('、')}` : `「${sec.name}」不再排除任何东西`,
          );
        },
      }).el,
    );
    eRow.appendChild(
      div({ cls: 'kbw-bp-note', text: '在数据源的命中结果上做减法；「.开头」表示"排除所有点开头的路径"' }),
    );
    box.appendChild(eRow);

    // 显示上限
    const lRow = div({ cls: 'kbw-bp-field' });
    lRow.appendChild(bpLabel('显示上限'));
    const lim = el('input', {
      cls: 'kbw-input is-small',
      attr: { type: 'number', min: '0', value: sec.limit == null ? '' : String(sec.limit), placeholder: '不限' },
    });
    lim.addEventListener('change', () => {
      const n = Number(lim.value);
      const limit = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      void save(
        cfg.sections.map((s) => (s.id === sec.id ? { ...s, limit } : s)),
        limit == null ? `「${sec.name}」不限条数` : `「${sec.name}」只显示前 ${limit} 篇`,
      );
    });
    lRow.appendChild(lim);
    lRow.appendChild(span({ cls: 'kbw-bp-note', text: '默认不限 —— 它不是性能护栏' }));
    box.appendChild(lRow);

    // 卡片显示（三态）
    const cRow = div({ cls: 'kbw-bp-field' });
    cRow.appendChild(bpLabel('卡片显示'));
    const cseg = div({ cls: 'kbw-seg' });
    const opts: [CardMode | null, string][] = [
      [null, '继承'],
      ['content', '只内容'],
      ['props', '只属性'],
      ['both', '两者'],
    ];
    for (const [v, lab] of opts) {
      cseg.appendChild(
        btn({
          cls: ['kbw-segbtn', (sec.cardMode ?? null) === v ? 'is-on' : null],
          text: lab,
          on: {
            click: () =>
              void save(
                cfg.sections.map((s) => (s.id === sec.id ? { ...s, cardMode: v } : s)),
                `「${sec.name}」卡片显示：${lab}`,
              ),
          },
        }),
      );
    }
    cRow.appendChild(cseg);
    box.appendChild(cRow);

    // 卡片尺寸（留空 = 继承看板；高度 0 = 自动）
    const sizeRow = div({ cls: 'kbw-bp-field' });
    sizeRow.appendChild(bpLabel('卡片尺寸'));
    const wIn = el('input', {
      cls: 'kbw-input is-small',
      attr: { type: 'number', min: '160', max: '720', placeholder: '宽（继承）', value: sec.width == null ? '' : String(sec.width) },
    });
    wIn.addEventListener('change', () => {
      const n = Number(wIn.value);
      const width = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      void save(
        cfg.sections.map((s2) => (s2.id === sec.id ? { ...s2, width } : s2)),
        width == null ? `「${sec.name}」卡片宽度：继承看板` : `「${sec.name}」卡片宽度：${width}px`,
      );
    });
    sizeRow.appendChild(wIn);
    const hIn = el('input', {
      cls: 'kbw-input is-small',
      attr: { type: 'number', min: '160', max: '900', placeholder: '高（继承）', value: sec.height == null ? '' : String(sec.height) },
    });
    hIn.addEventListener('change', () => {
      const n = Number(hIn.value);
      const height = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      void save(
        cfg.sections.map((s2) => (s2.id === sec.id ? { ...s2, height } : s2)),
        height == null ? `「${sec.name}」卡片高度：继承看板` : `「${sec.name}」卡片高度：${height}px`,
      );
    });
    sizeRow.appendChild(hIn);
    sizeRow.appendChild(span({ cls: 'kbw-bp-note', text: 'px；留空 = 继承看板' }));
    box.appendChild(sizeRow);

    // 属性列覆盖（留空 = 继承看板）
    const pRow = div({ cls: 'kbw-bp-field is-col' });
    pRow.appendChild(bpLabel('属性列覆盖'));
    pRow.appendChild(
      multiSelect({
        value: sec.props ?? [],
        candidates: () => propCandidates(p.ctx),
        placeholder: '本板块显示哪几个属性（留空 = 继承看板）',
        allowCustom: true,
        emptyHint: '库里真有的属性都在上面',
        onChange: (next) => {
          void save(
            cfg.sections.map((s) => (s.id === sec.id ? { ...s, props: next.length > 0 ? next : null } : s)),
            next.length > 0 ? `「${sec.name}」属性列：${next.join('、')}` : `「${sec.name}」属性列：继承看板`,
          );
        },
      }).el,
    );
    box.appendChild(pRow);

    box.appendChild(
      div({ cls: 'kbw-bp-note', text: '排序也在这一行：板块标题右键 → 排序；同板块拖动排序会自动切到「手动」档。' }),
    );
    return box;
  }

  // ── 添加板块 ─────────────────────────────────────────────────
  function buildAddRow(): HTMLElement {
    const cfg = p.store.get();
    const box = div({ cls: 'kbw-bp-add' });
    box.appendChild(div({ cls: 'kbw-bp-add-t', text: '先选数据源类型，再选具体值：' }));

    const kinds: SectionKind[] = ['folder', 'tag', 'prop', 'shelter'];
    for (const k of kinds) {
      const cands = candidatesOf(k);
      const row = div({ cls: 'kbw-bp-add-row' });
      row.appendChild(div({ cls: 'kbw-bp-add-k', text: SECTION_KIND_LABEL[k] }));

      if (k === 'shelter') {
        row.appendChild(
          btn({
            cls: 'kbw-btn is-small',
            text: '建一个收容所',
            title: '哪条规则都没命中的笔记会落在这儿（固定排最后）',
            on: {
              click: () => {
                openRows.delete('__new__');
                void save(
                  [
                    ...cfg.sections,
                    {
                      id: newSectionId(),
                      name: '收容所',
                      kind: 'shelter',
                      value: '',
                      exclude: [],
                      limit: null,
                      sort: null,
                      cardMode: null,
                      props: null,
                      width: null,
                      height: null,
                    },
                  ],
                  '已添加「收容所」板块',
                );
              },
            },
          }),
        );
      } else if (cands.length === 0) {
        row.appendChild(span({ cls: 'kbw-bp-note', text: k === 'tag' ? '库里还没有标签' : '没得可选' }));
      } else {
        const sel = el('select', { cls: 'kbw-select is-small' });
        for (const c of cands) sel.appendChild(el('option', { attr: { value: c }, text: c || '（整个库）' }));
        row.appendChild(sel);
        row.appendChild(
          btn({
            cls: 'kbw-btn is-small is-primary',
            text: '建',
            on: {
              click: () => {
                const value = sel.value;
                openRows.delete('__new__');
                void save(
                  [
                    ...cfg.sections,
                    {
                      id: newSectionId(),
                      // 文件夹源的默认名取**最后一段**（`02_Areas/内容创作` → `内容创作`）：
                      // 拿整条路径当板块名，板块头上会挂一长串没意义的父目录
                      name: k === 'folder' ? (value.split('/').pop() || value || '库根') : value,
                      kind: k,
                      value,
                      exclude: [],
                      limit: null,
                      sort: null,
                      cardMode: null,
                      props: null,
                      width: null,
                      height: null,
                    },
                  ],
                  `已添加板块「${value}」（${SECTION_KIND_LABEL[k]}）`,
                );
              },
            },
          }),
        );
      }
      box.appendChild(row);
    }
    box.appendChild(
      btn({
        cls: 'kbw-btn is-small is-ghost',
        text: '取消',
        on: { click: () => { openRows.delete('__new__'); rerender(); } },
      }),
    );
    return box;
  }

  // ── 排序与换序 ───────────────────────────────────────────────
  async function swap(a: number, b: number): Promise<void> {
    const list = [...p.store.get().sections];
    if (a < 0 || b < 0 || a >= list.length || b >= list.length) return;
    const [x] = list.splice(a, 1);
    list.splice(b, 0, x);
    await save(list, `板块顺序：${list.map((s) => s.name).join(' › ')}`);
  }

  /** 把 `id` 拖到 `targetId` 那个位置（前/后按上下半区判） */
  async function moveTo(id: string, targetId: string): Promise<void> {
    const list = [...p.store.get().sections];
    const from = list.findIndex((s) => s.id === id);
    const to = list.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) return;
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    await save(list, `板块顺序：${list.map((s) => s.name).join(' › ')}`);
  }

  function candidatesOf(kind: SectionKind): string[] {
    if (kind === 'folder') return ['', ...kbDirs(p.ctx)];
    if (kind === 'tag') return p.ctx.index.tags();
    if (kind === 'prop') return propCandidates(p.ctx);
    return [];
  }

  rerender();
}

/** 面板里的字段名（与设置面板的 `.kbw-bp-label` 同一套视觉） */
function bpLabel(text: string): HTMLElement {
  return span({ cls: 'kbw-bp-label', text });
}

/** 「排除」的候选：库内目录 + 笔记路径 + `.开头` 这个特殊记号 */
export function excludeCandidates(ctx: WorkbenchContext): string[] {
  const out = ['.开头', ...kbDirs(ctx).filter(Boolean)];
  for (const e of ctx.index.notes()) out.push(relativeTo(e.path, ctx.settings.kbRoot()));
  return out;
}

/** 属性候选：库里真有的（按规范顺序） */
export function propCandidates(ctx: WorkbenchContext): string[] {
  const present = new Set<string>();
  for (const e of ctx.index.notes()) for (const k of Object.keys(e.props)) present.add(k);
  return Array.from(present);
}
