/**
 * ui/prompt.ts —— 「问一句话」的小模态（唯一实现点）
 *
 * 平台没有 `prompt()`（在 Electron 里被禁用），而设置面板里要问名字的地方有好几处：
 * 模板另存为 / 新建模板 / 目录映射加一行 —— 各写一遍就会出现"有的能回车、有的不能"。
 * 返回 `Promise<string | null>`（null = 取消，**不靠异常**，与 `ui/confirm.ts` 同一口径）。
 */
import { btn, div, el, span } from './primitives';
import { openModal } from './panel';

export interface PromptOptions {
  title: string;
  label?: string;
  hint?: string;
  /** 初始值 */
  value?: string;
  placeholder?: string;
  primary?: string;
  /** 校验：返回非空字符串 = 不通过（那句话会显示出来） */
  validate?: (v: string) => string | null;
  /**
   * **左下角一个可选的小按钮**（P7.10 · #7：「新建模板」对话框背后的「如何新建模板」）。
   * 点它 = **先按取消关掉本框**（`finish(null)` —— 老调用方的语法一个字不用改），再跑 `run`。
   * 不传 = 一切都与从前一样（没有任何按钮多出来）。
   */
  link?: { label: string; run: () => void };
}

export function promptText(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      h.close(v == null ? 'cancel' : 'ok');
      resolve(v);
    };
    const h = openModal({
      title: opts.title,
      width: 'narrow',
      onClose: () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      },
    });

    const box = div({ cls: 'kbw-form-row is-plain' });
    if (opts.label) box.appendChild(span({ cls: 'kbw-form-label', text: opts.label }));
    const input = el('input', {
      cls: 'kbw-input',
      attr: { type: 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '' },
    });
    input.style.width = '100%';
    box.appendChild(input);
    h.body.appendChild(box);
    const msg = div({ cls: 'kbw-set-note is-error' });
    msg.style.display = 'none';
    if (opts.hint) h.body.appendChild(div({ cls: 'kbw-form-hint', text: opts.hint }));
    h.body.appendChild(msg);

    const submit = (): void => {
      const v = input.value.trim();
      const bad = opts.validate?.(v) ?? (v === '' ? '不能是空的' : null);
      if (bad) {
        msg.textContent = bad;
        msg.style.display = '';
        input.focus();
        return;
      }
      finish(v);
    };

    h.foot.style.display = '';
    // 可选的左下小按钮（P7.10 · #7）：先按取消关框（老调用方拿到的还是 null），再跑 run
    if (opts.link) {
      const link = opts.link;
      h.foot.appendChild(
        btn({
          cls: 'kbw-btn is-ghost',
          text: link.label,
          on: {
            click: () => {
              finish(null);
              link.run();
            },
          },
        }),
      );
    }
    h.foot.appendChild(div({ cls: 'kbw-spacer' }));
    h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => finish(null) } }));
    h.foot.appendChild(btn({ cls: 'kbw-btn is-primary', text: opts.primary ?? '确定', on: { click: submit } }));
    input.addEventListener('keydown', (evt) => {
      if ((evt as KeyboardEvent).key === 'Enter') {
        evt.preventDefault();
        submit();
      }
    });
    input.focus();
    input.select();
  });
}

export interface PickOptions<T> {
  title: string;
  sub?: string;
  items: T[];
  /** 列表里显示什么 */
  label: (item: T) => string;
  /** 次要一行（路径之类） */
  detail?: (item: T) => string;
  /** 搜索用：把 item 变成可搜索的文本 */
  searchOf?: (item: T) => string;
  placeholder?: string;
  empty?: string;
}

/** 「从一堆东西里挑一个」的模态（从笔记提取模板、选目录这类） */
export function pickOne<T>(opts: PickOptions<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let done = false;
    const finish = (v: T | null): void => {
      if (done) return;
      done = true;
      h.close(v == null ? 'cancel' : 'ok');
      resolve(v);
    };
    const h = openModal({ title: opts.title, sub: opts.sub, width: 'normal', onClose: () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    } });

    const search = el('input', {
      cls: 'kbw-input',
      attr: { type: 'text', placeholder: opts.placeholder ?? '搜索…' },
    });
    search.style.width = '100%';
    h.body.appendChild(search);

    const list = div({ cls: 'kbw-pick-list' });
    h.body.appendChild(list);

    const paint = (q: string): void => {
      while (list.firstChild) list.removeChild(list.firstChild);
      const query = q.trim().toLowerCase();
      const hit = opts.items.filter((it) => {
        if (!query) return true;
        const hay = (opts.searchOf?.(it) ?? opts.label(it)).toLowerCase();
        return hay.includes(query);
      });
      if (hit.length === 0) {
        list.appendChild(div({ cls: 'kbw-set-empty', text: opts.empty ?? '没有匹配项' }));
        return;
      }
      for (const it of hit.slice(0, 300)) {
        const item = div({
          cls: ['kbw-pick-item', 'kbw-hover-1'],
          attr: { role: 'button', tabindex: '0' },
          on: { click: () => finish(it) },
        });
        item.appendChild(div({ cls: 'kbw-pick-t', text: opts.label(it) }));
        if (opts.detail) item.appendChild(div({ cls: 'kbw-pick-d', text: opts.detail(it) }));
        list.appendChild(item);
      }
    };
    search.addEventListener('input', () => paint(search.value));
    paint('');
    search.focus();

    h.foot.style.display = '';
    h.foot.appendChild(div({ cls: 'kbw-spacer' }));
    h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => finish(null) } }));
  });
}
