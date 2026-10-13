/**
 * ui/settings/kit.ts —— 设置面板各栏共用的表单基元
 *
 * 为什么不用平台的 `Setting`：`排查报告.md` §六 记过一条 ——
 * 原生 `.setting-item` 在窄容器下由平台自己触发竖排 + 按钮 100% 宽
 * （`@container (max-width:400px)`），要压回去得写更高特异性。与其跟它打架，
 * 不如用工作台自己的基元（`ui/primitives.ts`），视觉与其余面板天然一致。
 *
 * 每个控件都**只负责"值变了 → 回调"**，不负责存盘：存哪由各栏自己决定
 * （自动化/目录映射 → 库内 JSON；外观/密度 → 插件 data.json）。
 */
import { btn, div, el, icon, span } from '../primitives';

/**
 * 栏顶那一层（`h3` + 一句说明）。
 *
 * ⚠️ P6 第八段起外头还套了一层 `.kbw-set-htxt`：`.kbw-set-h` 现在是一**行** flex
 *（标题在左、「问 AI」在右，由 `settings-panel.ts` 注入）—— 不套这一层的话，
 * h3 与那句说明会**并排**（它们本来该上下叠）。
 */
export function setTitle(text: string, sub?: string): HTMLElement {
  const box = div({ cls: 'kbw-set-h' });
  const wrap = div({ cls: 'kbw-set-htxt' });
  wrap.appendChild(el('h3', { text }));
  if (sub) wrap.appendChild(div({ cls: 'kbw-set-sub', text: sub }));
  box.appendChild(wrap);
  return box;
}

/** 一组（小节）标题 + 说明 */
export function group(text: string, sub?: string): HTMLElement {
  const box = div({ cls: 'kbw-set-group' });
  box.appendChild(span({ cls: 'kbw-set-group-t', text }));
  if (sub) box.appendChild(span({ cls: 'kbw-set-group-s', text: sub }));
  return box;
}

/**
 * 一行：左边标签（可带说明），右边控件。
 * 说明写在标签下面（§7.1 的「只读文字」都是这个位置）。
 *
 * 🔴 **P6 第八段起那句说明默认收起**（用户第 3 条："简化甚至去除各选项的提示小字"）——
 * 收起 ≠ 删掉，所以：
 * · `.kbw-set-hint` 那个元素**照旧画**（探针/用例读得到，摊开时也在原位）；
 * · 同一句话**同时挂在标签的 `title` 上** —— 收起状态下它就是唯一的口径。
 *   少了这一挂，"收起"就真的变成"信息没了"（那正是用户给的两个口子里的另一个）。
 */
export function row(label: string, control: HTMLElement | null, hint?: string, cls?: string): HTMLElement {
  const r = div({ cls: ['kbw-set-row', cls ?? null] });
  const left = div({ cls: 'kbw-set-label' });
  left.appendChild(span({ cls: 'kbw-set-label-t', text: label, attr: hint ? { title: hint } : {} }));
  if (hint) left.appendChild(div({ cls: 'kbw-set-hint', text: hint }));
  r.appendChild(left);
  if (control) {
    const right = div({ cls: 'kbw-set-ctl' });
    right.appendChild(control);
    r.appendChild(right);
  }
  return r;
}

/** 只读的一行（值 + 一句解释）—— §7.1 的「套用规则」「触发条件」都是这类 */
export function readRow(label: string, value: string, hint?: string): HTMLElement {
  const r = div({ cls: 'kbw-set-row is-read' });
  const left = div({ cls: 'kbw-set-label' });
  left.appendChild(span({ cls: 'kbw-set-label-t', text: label, attr: hint ? { title: hint } : {} }));
  if (hint) left.appendChild(div({ cls: 'kbw-set-hint', text: hint }));
  r.appendChild(left);
  const right = div({ cls: 'kbw-set-ctl' });
  right.appendChild(span({ cls: 'kbw-set-read', text: value }));
  r.appendChild(right);
  return r;
}

export function note(text: string, kind: 'info' | 'warn' | 'error' = 'info'): HTMLElement {
  return div({ cls: ['kbw-set-note', `is-${kind}`], text });
}

/**
 * **状态 / 动态行**（P7.5 · 8.3 拆类名）。
 *
 * 与"行内说明"（`.kbw-set-hint`，吃「显示说明」开关）**不是一类东西**：
 * 「已同步 / 有未保存的改动」·「统计中…」·「上次检查：…」·「（插件内部用：…）」都是
 * **眼前的运行状态** —— 点了之后有没有生效，全看它们。开关收起的是"解释"，
 * 它们必须照常显示（`styles/settings.css` 里 `.kbw-set-status` 绝不进 `display:none`，
 * 红线钉着）。P7.5 之前这两类共用一个类名、靠"在不在行标签里"区分 —— 脆，故拆开。
 *
 * ⚠️ **本文件是 `kbw-set-hint` / `kbw-set-status` 两个字面量的唯一出处**（红线钉着）：
 * 各栏要"一段灰字状态"就调这里的工厂，别自己拼类名 —— 拼法一多，"谁吃开关"就又说不清了。
 */
export function statusLine(text = ''): HTMLElement {
  return span({ cls: 'kbw-set-status', text });
}

/**
 * 「说明行」的**读法**（唯一出处）：搜索索引与「问 AI」都按它取"行里那句解释"。
 * 拆类名之后 `.kbw-set-hint` 只剩 kit 产出的行内说明（独立说明已归并进行 hint /
 * 小节说明），但选择器保持收窄到 `.kbw-set-label` 内 —— 语义上它就是"行标签下那句"。
 */
export const HINT_SEL = '.kbw-set-label .kbw-set-hint';

/** 开关（平台没有开关控件；`.kbw-switch` 与菜单里的那个是同一个视觉） */
export function switchCtl(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const sw = div({
    cls: ['kbw-switch', value ? 'is-on' : null],
    attr: { role: 'switch', tabindex: '0', 'aria-checked': value ? 'true' : 'false' },
  });
  let on = value;
  const flip = (): void => {
    on = !on;
    sw.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    onChange(on);
  };
  sw.addEventListener('click', flip);
  sw.addEventListener('keydown', (evt) => {
    const k = (evt as KeyboardEvent).key;
    if (k === ' ' || k === 'Enter') {
      evt.preventDefault();
      flip();
    }
  });
  return sw;
}

export interface Option {
  value: string;
  label: string;
}

export function selectCtl(value: string, options: Option[], onChange: (v: string) => void): HTMLSelectElement {
  const sel = el('select', { cls: 'kbw-select' });
  for (const o of options) sel.appendChild(el('option', { attr: { value: o.value }, text: o.label }));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function inputCtl(
  value: string,
  onChange: (v: string) => void,
  opts: { placeholder?: string; width?: string } = {},
): HTMLInputElement {
  const input = el('input', {
    cls: 'kbw-input',
    attr: { type: 'text', placeholder: opts.placeholder ?? '', value },
  });
  if (opts.width) input.style.width = opts.width;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

/** 数字输入（不改就回车/失焦才回调 —— 别每敲一个键存一次盘） */
export function numberCtl(
  value: number,
  onChange: (v: number) => void,
  opts: {
    min?: number;
    max?: number;
    step?: number;
    width?: string;
    /**
     * **这个值在语义上是"没设过"的哨兵**（如 `panelFont: 0`）→ 输入框**留空**显示、
     * 只把 `placeholder` 亮出来（P7.0a 批 1⑧：原先把哨兵 0 直接画给用户看，
     * 控件本身看上去就是个坏值）；清空提交 = 写回哨兵。
     * ⚠️ **没传 `emptyAt` 的控件行为一个字不改**（`Number('')` = 0 照旧）——
     * gap / summaryLines 那些字段的 0 是"真的 0"，不是哨兵，别顺手统一。
     */
    emptyAt?: number;
    placeholder?: string;
  } = {},
): HTMLInputElement {
  const isUnset = opts.emptyAt != null && value === opts.emptyAt;
  const input = el('input', {
    cls: 'kbw-input',
    attr: {
      type: 'number',
      value: isUnset ? '' : String(value),
      min: opts.min != null ? String(opts.min) : null,
      max: opts.max != null ? String(opts.max) : null,
      step: opts.step != null ? String(opts.step) : null,
      placeholder: opts.placeholder ?? null,
    },
  });
  input.style.width = opts.width ?? '76px';
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    /**
     * **空输入只有声明了哨兵语义（`emptyAt`）才特殊**：写回哨兵、输入框保持留空显示。
     * ⚠️ 没声明 `emptyAt` 的控件**走下面的老路径**（独立审查 🔴2 抓的第一版：这里直接
     * `return` —— 等于把"卡片高度清空 = 回自动(0)"这类既有行为**悄悄改没了**：
     * 框空着、配置不动、还不报错。旧行为是 `Number('') = 0` 走夹取后落盘）。
     */
    if (raw === '' && opts.emptyAt != null) {
      input.value = '';
      onChange(opts.emptyAt);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(opts.max ?? Number.MAX_SAFE_INTEGER, Math.max(opts.min ?? -Number.MAX_SAFE_INTEGER, n));
    input.value = String(clamped);
    onChange(clamped);
  });
  return input;
}

/** 拉杆（§7.4 卡片宽度 160–480 这类） */
export function sliderCtl(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = div({ cls: 'kbw-slider' });
  const input = el('input', { cls: 'kbw-range', attr: { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) } });
  const label = span({ cls: 'kbw-slider-val', text: String(value) });
  input.addEventListener('input', () => {
    label.textContent = input.value;
  });
  input.addEventListener('change', () => onChange(Number(input.value)));
  wrap.appendChild(input);
  wrap.appendChild(label);
  return wrap;
}

/** 分段控件（三档视图那种） */
export function segCtl<T extends string>(
  value: T,
  options: { value: T; label: string }[],
  onChange: (v: T) => void,
): HTMLElement {
  const seg = div({ cls: 'kbw-seg' });
  for (const o of options) {
    const b = el('button', {
      cls: ['kbw-segbtn', o.value === value ? 'is-on' : null],
      attr: { type: 'button' },
      text: o.label,
      on: { click: () => onChange(o.value) },
    });
    seg.appendChild(b);
  }
  return seg;
}

/** 可点的胶囊（多选/排除项那种） */
export function chip(text: string, on: boolean, onClick: () => void, title?: string): HTMLElement {
  return el('button', {
    cls: ['kbw-chip', 'is-pickable', on ? 'is-on' : null],
    attr: { type: 'button', title: title ?? text },
    text,
    on: { click: onClick },
  });
}

/** 一行小工具条（一组按钮靠左、说明靠右） */
export function toolbar(...children: (HTMLElement | null)[]): HTMLElement {
  const bar = div({ cls: 'kbw-set-bar' });
  for (const c of children) if (c) bar.appendChild(c);
  return bar;
}

export function ghostBtn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  return btn({
    cls: 'kbw-btn is-small is-ghost',
    text,
    attr: title ? { title } : {},
    on: { click: onClick },
  });
}

export function smallBtn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  return btn({
    cls: 'kbw-btn is-small',
    text,
    attr: title ? { title } : {},
    on: { click: onClick },
  });
}

/** 空态一句（列表没内容时） */
export function emptyLine(text: string): HTMLElement {
  return div({ cls: 'kbw-set-empty', text });
}

/** 带图标的动作按钮（复制占位符那种） */
export function iconTextBtn(iconName: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = btn({ cls: 'kbw-btn is-small is-ghost', on: { click: onClick } });
  b.appendChild(icon(iconName, 14));
  b.appendChild(span({ text }));
  return b;
}
