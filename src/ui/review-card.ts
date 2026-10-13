/**
 * ui/review-card.ts —— 「新建回顾卡」的两栏小模态（P8 期 2）
 *
 * 为什么不套 `ui/prompt.ts`：那个是**一次问一句**（另存模板 / 新建目录那种），
 * 而一张卡有正反两面、要一起校验、还要能从正面 Enter 跳到背面 —— 一问一答的框做不出来。
 * 返回 `{ front, back } | null`（null = 取消，**不靠异常**，与 `prompt.ts` / `confirm.ts` 同一口径）。
 */
import { btn, div, el, span } from './primitives';
import { openModal } from './panel';

export interface ReviewCardInput {
  front: string;
  back: string;
}

export interface ReviewCardDialogOpts {
  /** 来源笔记的短名（显示在标题里 —— 让用户知道这张卡挂在谁身上） */
  noteLabel: string;
  /** 预填（P8 期 4「从笔记生成」会用到；手动建卡时不传） */
  front?: string;
  back?: string;
  /** 标题（默认「新建回顾卡」；期 4 的生成面板会改成「确认这张卡」） */
  title?: string;
  /** 主按钮文案（默认「下一步」） */
  primary?: string;
}

export function openReviewCardDialog(opts: ReviewCardDialogOpts): Promise<ReviewCardInput | null> {
  return new Promise<ReviewCardInput | null>((resolve) => {
    let done = false;
    const finish = (v: ReviewCardInput | null): void => {
      if (done) return;
      done = true;
      h.close(v == null ? 'cancel' : 'ok');
      resolve(v);
    };
    const h = openModal({
      title: opts.title ?? '新建回顾卡',
      width: 'narrow',
      onClose: () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      },
    });

    h.body.appendChild(
      div({
        cls: 'kbw-form-hint',
        text: `挂在「${opts.noteLabel}」上。只写库内「复习」那张表，不改这篇笔记的一个字节。`,
      }),
    );

    /** 一栏一行：标签 + 多行输入（正面短、背面长） */
    const field = (label: string, rows: number, value: string, placeholder: string) => {
      const box = div({ cls: 'kbw-form-row is-plain' });
      box.appendChild(span({ cls: 'kbw-form-label', text: label }));
      const ta = el('textarea', {
        cls: 'kbw-input kbw-review-input',
        attr: { rows: String(rows), placeholder },
      }) as HTMLTextAreaElement;
      ta.value = value;
      box.appendChild(ta);
      h.body.appendChild(box);
      return ta;
    };

    const frontEl = field('正面（问题）', 2, opts.front ?? '', '这一条要问自己什么？');
    const backEl = field('背面（答案）', 3, opts.back ?? '', '答案。翻面之前不看这里。');

    const msg = div({ cls: 'kbw-set-note is-error' });
    msg.style.display = 'none';
    h.body.appendChild(msg);

    const submit = (): void => {
      const front = frontEl.value.trim();
      const back = backEl.value.trim();
      if (front === '' && back === '') {
        msg.textContent = '正反面都还空着';
        msg.style.display = '';
        frontEl.focus();
        return;
      }
      if (front === '') {
        msg.textContent = '正面（问题）不能是空的';
        msg.style.display = '';
        frontEl.focus();
        return;
      }
      if (back === '') {
        msg.textContent = '背面（答案）不能是空的 —— 只有问题的话翻面之后没东西看';
        msg.style.display = '';
        backEl.focus();
        return;
      }
      finish({ front, back });
    };

    h.foot.style.display = '';
    h.foot.appendChild(div({ cls: 'kbw-spacer' }));
    h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => finish(null) } }));
    h.foot.appendChild(
      btn({ cls: 'kbw-btn is-primary', text: opts.primary ?? '下一步', on: { click: submit } }),
    );

    /**
     * 键盘：正面 Enter **跳背面**（不是提交 —— 正面常常一口气写不顺，误提交最烦）；
     * 背面 Enter 提交；哪里都认 `Ctrl/⌘+Enter`（一次性写完两条的那种用法）。
     */
    const onKey = (which: 'front' | 'back') => (evt: KeyboardEvent) => {
      if (evt.key !== 'Enter') return;
      const mod = evt.ctrlKey || evt.metaKey;
      if (mod) {
        evt.preventDefault();
        submit();
        return;
      }
      if (which === 'front') {
        evt.preventDefault();
        backEl.focus();
        return;
      }
      // 背面：Enter 直接提交（多行要换行时用 Shift+Enter）
      if (!evt.shiftKey) {
        evt.preventDefault();
        submit();
      }
    };
    frontEl.addEventListener('keydown', onKey('front'));
    backEl.addEventListener('keydown', onKey('back'));

    frontEl.focus();
  });
}
