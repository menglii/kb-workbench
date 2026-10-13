/**
 * modules/notes/panels.ts —— 两块浮层面板（**不占导航位**）
 *
 *   · 筛选面板（交互规格 §3.6）：目录 / 标签 / 类型 / 状态 / 创建日期 / 健康标记 + 一键清除
 *   · 批量改属性 / 加标签（§3.4）：面板只负责"选属性 + 设值"，**确认流在后面**
 *     （§9 的原话：批量操作走同一个确认组件，没有例外）
 *
 * 候选值来自两处：`services/schema.ts` 的值域 + `index.valuesOf()` 的全库聚合
 * （自由值属性靠聚合，多选控件自带搜索）。
 */
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { FLAG_META, type HealthFlag } from '../../core/vault-index';
import {
  NOTE_TYPES,
  SPECS,
  SPEC_BY_NAME,
  STATUSES,
  asList,
  asString,
  candidatesFor,
} from '../../services/schema';
import { btn, div, el, span } from '../../ui/primitives';
import { multiSelect } from '../../ui/primitives';
import { debounce } from '../../core/util';
import { openFloating } from '../../ui/panel';
import type { FilterSet } from './filters';
import { describeDateTerm, emptyFilters, hasAnyFilter, parseDateTerm } from './filters';
import type { NotesOps } from './ops';

// ────────────────────────────────────────────────────────────────
// 筛选面板
// ────────────────────────────────────────────────────────────────
export interface FilterPanelOpts {
  filters: FilterSet;
  dir: string;
  /** 目录候选（第一项是「整个知识库」） */
  dirs: string[];
  tags: string[];
  onDirsChange: (dir: string) => void;
  onChange: (f: FilterSet) => void;
  anchor?: HTMLElement;
}

export function openFilterPanel(o: FilterPanelOpts): void {
  const h = openFloating({
    title: '筛选',
    sub: '多条件同时生效（AND）',
    anchor: o.anchor,
    width: 'normal',
  });
  let f = o.filters;
  /** 每个 chip 记住"它代表什么、现在选没选" —— 勾选态要就地刷（面板不属于任何 Region） */
  const chips: { el: HTMLElement; isOn: () => boolean }[] = [];
  const paintChips = (): void => {
    for (const c of chips) {
      const on = c.isOn();
      c.el.classList.toggle('is-on', on);
      c.el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  const push = (patch: Partial<FilterSet>): void => {
    f = { ...f, ...patch };
    paintChips();
    o.onChange(f);
  };
  const pushDir = (dir: string): void => {
    paintChips();
    o.onDirsChange(dir);
  };

  // 目录（与左侧目录树是同一份状态，选哪儿都一样）
  h.body.appendChild(group('目录'));
  const dirBox = div({ cls: 'kbw-panel-chips' });
  for (const d of ['', ...o.dirs]) {
    const label = d || '整个知识库';
    dirBox.appendChild(chip(label, o.dir === d, () => pushDir(d), chips, () => o.dir === d));
  }
  h.body.appendChild(dirBox);

  h.body.appendChild(group('标签'));
  if (o.tags.length === 0) {
    h.body.appendChild(hint('库里还没有标签'));
  } else {
    h.body.appendChild(
      chipsWrap(
        o.tags.slice(0, 30).map((t) =>
          chip(t, f.tags.includes(t), () => push({ tags: toggle(f.tags, t) }), chips, () =>
            f.tags.includes(t),
          ),
        ),
      ),
    );
    if (o.tags.length > 30) h.body.appendChild(hint(`还有 ${o.tags.length - 30} 个标签，用搜索框找`));
  }

  h.body.appendChild(group('类型'));
  h.body.appendChild(
    chipsWrap(
      NOTE_TYPES.map((t) =>
        chip(t, f.types.includes(t), () => push({ types: toggle(f.types, t) }), chips, () =>
          f.types.includes(t),
        ),
      ),
    ),
  );

  h.body.appendChild(group('状态'));
  h.body.appendChild(
    chipsWrap(
      STATUSES.map((st) =>
        chip(st, f.statuses.includes(st), () => push({ statuses: toggle(f.statuses, st) }), chips, () =>
          f.statuses.includes(st),
        ),
      ),
    ),
  );

  /**
   * **创建日期**（P7.12 · 21.5「筛选器也给同粒度入口」）：与搜索框**同一套裸写**——
   * 粒度由写法承载（`2026` / `2026-10` / `2026-W41` / `2026-10-06`）。
   * 合法才落进 filters（非法就地给一句提示、不制造"滤成一片空白"的迷惑）；
   * 输入防抖 250ms 再推送（逐字符推送会让下面的列表一路闪）。
   */
  h.body.appendChild(group('创建日期'));
  {
    const row = div({ cls: 'kbw-panel-field' });
    row.appendChild(span({ cls: 'kbw-panel-label', text: '按创建日期' }));
    const box = div({ cls: 'kbw-panel-control' });
    const input = el('input', {
      cls: 'kbw-input',
      attr: {
        type: 'text',
        spellcheck: 'false',
        placeholder: '2026 / 2026-10 / 2026-W41 / 2026-10-06',
        'aria-label': '按创建日期筛选（裸写：年 / 年-月 / 年-W周 / 年-月-日）',
        value: f.created,
      },
    }) as HTMLInputElement;
    box.appendChild(input);
    row.appendChild(box);
    h.body.appendChild(row);
    const hint = div({ cls: 'kbw-panel-hint' });
    h.body.appendChild(hint);
    const paintHint = (): void => {
      const v = input.value.trim();
      if (v === '') {
        hint.textContent = '不填就不按日期筛；写法与搜索框一套';
        hint.classList.remove('is-warn');
        return;
      }
      const term = parseDateTerm(v);
      if (term === null) {
        hint.textContent = '这个写法看不懂 —— 试试 2026 / 2026-10 / 2026-W41 / 2026-10-06';
        hint.classList.add('is-warn');
        return;
      }
      hint.textContent = `= ${describeDateTerm(term)}`;
      hint.classList.remove('is-warn');
    };
    const commit = debounce((): void => {
      const v = input.value.trim();
      if (v === '' || parseDateTerm(v) !== null) push({ created: v });
    }, 250);
    input.addEventListener('input', () => {
      paintHint();
      commit();
    });
    paintHint();
  }

  h.body.appendChild(group('健康标记'));
  h.body.appendChild(
    chipsWrap(
      (Object.keys(FLAG_META) as HealthFlag[]).map((flag) =>
        chip(
          FLAG_META[flag].label,
          f.health.includes(flag),
          () => push({ health: toggle(f.health, flag) }),
          chips,
          () => f.health.includes(flag),
        ),
      ),
    ),
  );

  h.body.appendChild(group('隐藏的笔记'));
  h.body.appendChild(
    chipsWrap(
      ([
        ['show', '照常显示'],
        ['exclude', '排除隐藏'],
        ['only', '只看隐藏'],
      ] as const).map(([v, label]) =>
        chip(label, f.hidden === v, () => push({ hidden: v }), chips, () => f.hidden === v),
      ),
    ),
  );

  h.foot.appendChild(
    btn({
      cls: 'kbw-btn is-ghost',
      text: '清除全部筛选',
      on: {
        click: () => {
          f = emptyFilters();
          paintChips();
          o.onChange(f);
          /**
           * ⚠️ **这里不再顺手 `onDirsChange('')`**（P6b ② 改口径）。
           *
           * 旧口径下"目录"是**筛选的一条**（递归：选了哪个目录都是"全库的一个子集"），
           * 所以"清除全部筛选"把它一起清掉是合理的。新口径下（Windows 式，只看本层）
           * 目录是**浏览位置**、不是筛选条件：清一次筛选却把用户传送回整个知识库、
           * 落在**库根那一层**（只有根层那几篇），看着像"清完筛选列表空了"。
           * 想换目录：点上面的目录组、点目录树、点面包屑 —— 那三条都是显式动作。
           */
          h.close('clear');
        },
      },
    }),
  );
  if (f.paths != null) {
    h.body.appendChild(hint('当前还有一条「只看这几篇」的预筛选（从首页跳过来时带的）'));
  }
  h.foot.appendChild(btn({ cls: 'kbw-btn is-primary', text: '完成', on: { click: () => h.close('done') } }));
  void hasAnyFilter;
}

// ────────────────────────────────────────────────────────────────
// 批量改属性（选属性 + 设值 → 交给确认流）
// ────────────────────────────────────────────────────────────────
export function openPropPanel(
  ctx: WorkbenchContext,
  entries: NoteEntry[],
  ops: NotesOps,
  anchor?: HTMLElement,
): void {
  const h = openFloating({ title: `改 ${entries.length} 篇的属性`, anchor, width: 'normal' });
  let prop = '状态';
  let value: string[] = [];

  const propRow = el('select', { cls: 'kbw-select' });
  for (const spec of SPECS) {
    if (spec.readOnly) continue;
    const opt = el('option', { attr: { value: spec.name }, text: spec.name });
    propRow.appendChild(opt);
  }
  // ⚠️ 必须把 value 同步成 `prop`：不然下拉框停在第一项（类型）而实际改的是状态 ——
  // 「显示什么就写什么」不成立，而且用户再点「类型」不触发 change，等于改不了它
  propRow.value = prop;
  propRow.addEventListener('change', () => {
    prop = propRow.value;
    paintValue();
  });
  h.body.appendChild(field('属性', propRow));

  const valueHost = div({ cls: 'kbw-panel-field' });
  h.body.appendChild(valueHost);

  function paintValue(): void {
    while (valueHost.firstChild) valueHost.removeChild(valueHost.firstChild);
    const spec = SPEC_BY_NAME[prop];
    const label = span({ cls: 'kbw-panel-label', text: spec?.multi ? '值（可多选）' : '值' });
    valueHost.appendChild(label);
    const box = div({ cls: 'kbw-panel-control' });
    valueHost.appendChild(box);

    if (spec?.kind === 'bool') {
      const sel = el('select', { cls: 'kbw-select' });
      sel.appendChild(el('option', { attr: { value: 'true' }, text: '是' }));
      sel.appendChild(el('option', { attr: { value: 'false' }, text: '否' }));
      sel.addEventListener('change', () => {
        value = [sel.value];
      });
      box.appendChild(sel);
      value = ['true'];
      return;
    }

    const ms = multiSelect({
      value,
      candidates: () => candidatesFor(prop, ctx.index.valuesOf(prop)),
      placeholder: spec?.values ? '从候选里选' : '输入或从库里已有的值里选',
      allowCustom: spec?.kind !== 'single' || !spec?.values,
      onChange: (next) => {
        value = next;
      },
    });
    box.appendChild(ms.el);
  }
  paintValue();

  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => h.close('cancel') } }));
  h.foot.appendChild(
    btn({
      cls: 'kbw-btn is-primary',
      text: '下一步',
      on: {
        click: () => {
          h.close('apply');
          const spec = SPEC_BY_NAME[prop];
          let out: unknown = value;
          if (spec?.kind === 'bool') out = value[0] === 'true';
          else if (spec?.kind === 'single') out = value[0] ?? '';
          else if (spec?.kind !== 'list' && !spec?.multi) out = value[0] ?? '';
          void ops.setProp(entries, prop, out);
        },
      },
    }),
  );
}

// ────────────────────────────────────────────────────────────────
// 批量加标签
// ────────────────────────────────────────────────────────────────
export function openTagPanel(
  ctx: WorkbenchContext,
  entries: NoteEntry[],
  ops: NotesOps,
  anchor?: HTMLElement,
): void {
  const h = openFloating({ title: `改 ${entries.length} 篇的标签`, anchor, width: 'normal' });
  let add: string[] = [];
  let remove: string[] = [];

  const common = commonTags(entries);
  h.body.appendChild(
    hint(
      common.length > 0
        ? `这些笔记已经有了：${common.join('、')}`
        : '这些笔记目前没有共同标签',
    ),
  );

  const addBox = multiSelect({
    value: [],
    candidates: () => ctx.index.tags(),
    placeholder: '要加的标签（可搜、可新建）',
    onChange: (v) => {
      add = v;
    },
  });
  h.body.appendChild(field('加标签', addBox.el));

  const rmBox = multiSelect({
    value: [],
    candidates: () => common,
    placeholder: '要删的标签（只给它们的共同标签）',
    allowCustom: false,
    onChange: (v) => {
      remove = v;
    },
  });
  h.body.appendChild(field('删标签', rmBox.el));

  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => h.close('cancel') } }));
  h.foot.appendChild(
    btn({
      cls: 'kbw-btn is-primary',
      text: '下一步',
      on: {
        click: () => {
          h.close('apply');
          void ops.changeTags(entries, add, remove);
        },
      },
    }),
  );
}

function commonTags(entries: NoteEntry[]): string[] {
  if (entries.length === 0) return [];
  let acc: string[] | null = null;
  for (const e of entries) {
    const tags = asList(e.props['tags']).map((t) => t.replace(/^#/, ''));
    acc = acc == null ? tags : acc.filter((t) => tags.includes(t));
  }
  return acc ?? [];
}

// ── 小件 ──────────────────────────────────────────────────────
function group(text: string): HTMLElement {
  return div({ cls: 'kbw-panel-group', text });
}

function chipsWrap(children: HTMLElement[]): HTMLElement {
  const box = div({ cls: 'kbw-panel-chips' });
  for (const c of children) box.appendChild(c);
  return box;
}

/**
 * 可点的条件 chip。
 * ⚠️ `isOn` 与 `chips` 都要传：面板挂在 body 上、不属于任何 Region，
 * 勾选态必须**就地刷**（只按构建那一刻算 `is-on` 的话，点了像没点 —— 独立审查指出）
 */
function chip(
  text: string,
  on: boolean,
  onClick: () => void,
  registry: { el: HTMLElement; isOn: () => boolean }[],
  isOn: () => boolean,
): HTMLElement {
  const node = div({
    cls: ['kbw-chip', 'is-pickable', 'kbw-hover-1', on ? 'is-on' : null],
    text,
    attr: { role: 'checkbox', 'aria-checked': on ? 'true' : 'false', tabindex: '0' },
    on: {
      click: onClick,
      keydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') onClick();
      },
    },
  });
  registry.push({ el: node, isOn });
  return node;
}

function hint(text: string): HTMLElement {
  return div({ cls: 'kbw-panel-hint', text });
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = div({ cls: 'kbw-panel-field' });
  row.appendChild(span({ cls: 'kbw-panel-label', text: label }));
  const box = div({ cls: 'kbw-panel-control' });
  box.appendChild(control);
  row.appendChild(box);
  return row;
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

void asString;
