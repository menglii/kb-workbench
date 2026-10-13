/**
 * ui/review-session.ts —— **复习浮层**（P8 期 3）
 *
 * 一屏一张卡：正面 → 翻面 → 三键（记住 / 模糊 / 忘记）→ 自动下一张 → 末尾给本轮小结。
 * 数据推进在 `services/review.ts` 的 `applyGrade`（纯函数）+ `ReviewStore.grade`（落盘），
 * 这里只管**画面与节奏**。
 *
 * ── 三条口径 ────────────────────────────────────────────────
 *  ① **顺序 = 文件里的顺序**（不随机）：复习本身不靠乱序，而"可预期"对判据与排查都值钱。
 *    真想要"打乱"就做成一枚显式开关（期 4 之后，用户说了再加）。
 *  ② **键盘绑在浮层自己身上**（`root`），**不绑 document**；**每次重画之后把焦点收回 `root`**
 *    （`keepFocus()`）—— 两点都必要，理由：
 *    · 模态挂在 `document.body` 上，而工作台的键盘分派只监听 `.kbw-root`（`view/workbench-view.ts`）——
 *      浮层里的键**够不到**模块键盘路由那条链。
 *    · ⚠️ 而"绑根 + 开窗 focus 一次"**不够**（独立审 2026-10-10 指出，且是本批**新引入、无先例、
 *      真机未验**的方案 —— 仓里其他浮层是绑自己的输入框，或像 `confirm.ts` 那样绑 document
 *      带 target 守卫）：被点过的三键在下一张会变成 `disabled`，而**给已聚焦控件设 `disabled`
 *      会把焦点弹走**（Chromium），此后空格/1/2/3 静默失灵。所以每次重画都把焦点收回根上。
 *      真机那条路（焦点到底送不送得到、键会不会中途整段失灵）**离线判据管不住** ——
 *      实测过：拆掉 `keepFocus()`，用例仍然绿（jsdom 不会因为禁用已聚焦控件而失焦，
 *      那是 Chromium 的行为）。所以那条真机判据**归探针**（计划 §5.3 点名要加一组）。
 *    · Esc 不在这儿管 —— 走 `ui/panel.ts` 的逐级退出栈。
 *  ③ **不做 SM-2**（计划 §9 的边界）：固定倍增够用，调参留给"真用起来之后"。
 */
import type { WorkbenchContext } from '../core/context';
import {
  countTally,
  emptyTally,
  noteLabel,
  type ReviewCard,
  type ReviewGrade,
  type ReviewTally,
} from '../services/review';
import { notifyError, notifyLight } from './notify';
import { openModal } from './panel';
import { btn, div } from './primitives';

export interface ReviewSessionHandle {
  /** 浮层收起后 resolve：本轮计数（中途关掉 → 已做的那几张照样计入） */
  closed: Promise<ReviewTally>;
  close(): void;
}

const GRADES: { grade: ReviewGrade; label: string; key: string }[] = [
  { grade: 'remember', label: '记住', key: '1' },
  { grade: 'fuzzy', label: '模糊', key: '2' },
  { grade: 'forgot', label: '忘记', key: '3' },
];

export function openReviewSession(
  ctx: WorkbenchContext,
  queue: readonly ReviewCard[],
): ReviewSessionHandle {
  const cards = [...queue];
  let idx = 0;
  let flipped = false;
  let tally = emptyTally();
  let finished = false;
  let closing = false;
  let resolveClosed: (t: ReviewTally) => void = () => undefined;
  const closed = new Promise<ReviewTally>((res) => {
    resolveClosed = res;
  });

  const h = openModal({
    title: '复习',
    width: 'wide',
    onClose: () => {
      // Esc / 头部关闭都走这里：把已经做的那几张报出去（`close()` 自己也会触发它，加个闸）
      if (!closing) {
        closing = true;
        resolveClosed(tally);
      }
    },
  });
  h.root.classList.add('kbw-review-session');

  const progress = div({ cls: 'kbw-rs-progress' });
  const face = div({ cls: 'kbw-rs-face' });
  const hint = div({ cls: 'kbw-rs-hint' });
  const actions = div({ cls: 'kbw-rs-actions' });
  h.body.appendChild(progress);
  h.body.appendChild(face);
  h.body.appendChild(hint);
  h.body.appendChild(actions);

  h.foot.style.display = '';
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  const endBtn = btn({
    cls: 'kbw-btn',
    text: '结束本轮',
    attr: { title: '已复习的那几张已经记下了' },
    on: { click: () => h.close('end') },
  });
  h.foot.appendChild(endBtn);

  const gradeButtons = new Map<ReviewGrade, HTMLElement>();

  /** 三键：**没翻面时置灰并写明原因**（仓里口径：灰着的东西，为什么灰比会做什么要紧） */
  function paintActions(): void {
    for (const g of GRADES) {
      const b = gradeButtons.get(g.grade) as HTMLElement;
      const disabled = !flipped;
      b.toggleAttribute('disabled', disabled);
      b.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      b.setAttribute('title', disabled ? '先翻面看看答案（空格 / 点一下卡面）' : `间隔推进：${g.label}`);
    }
  }

  function paintCard(): void {
    const card = cards[idx];
    progress.textContent = `第 ${idx + 1} / ${cards.length} 张 · 今日到期 ${cards.length}`;
    face.classList.toggle('is-back', flipped);
    face.textContent = flipped ? card.back : card.front;
    // 来源写在卡下面一行（复习时不必点开，但得知道这话从哪来）
    hint.textContent = flipped
      ? `来源：${noteLabel(card.note)} · 1 记住 · 2 模糊 · 3 忘记`
      : '想想答案，然后按空格翻面（也可以点卡面）';
    paintActions();
    keepFocus();
  }

  function paintSummary(): void {
    progress.textContent = '本轮完成';
    face.classList.remove('is-back');
    face.textContent = `复习了 ${tally.total} 张`;
    hint.textContent = tallyText(tally);
    actions.replaceChildren();
    actions.appendChild(
      btn({
        cls: 'kbw-btn is-primary',
        text: '完成',
        on: { click: () => h.close('done') },
      }),
    );
    /**
     * **底栏整个清空**（不是把按钮藏起来）：`.kbw-modal-foot:empty{display:none}` 是仓里
     * "空的不占位"那条规矩（P6 ⑧-A）—— 留着一个 `.kbw-spacer` 或一个 `display:none` 的按钮，
     * 底栏就非空，小结那一屏下面会挂着一条空白带（独立审 2026-10-10 🟢）。
     */
    h.foot.replaceChildren();
    keepFocus();
  }

  /** 每次重画之后把焦点收回浮层根上（理由见文件头 ②：禁用一个已聚焦的按钮会把焦点弹走） */
  function keepFocus(): void {
    try {
      h.root.focus();
    } catch {
      /* 桩环境里 focus 可能没有意义；不影响判据 */
    }
  }

  for (const g of GRADES) {
    const b = btn({
      cls: 'kbw-btn',
      text: `${g.key} ${g.label}`,
      on: { click: () => void submit(g.grade) },
    });
    b.dataset.grade = g.grade;
    gradeButtons.set(g.grade, b);
    actions.appendChild(b);
  }

  /** 翻面（等价入口：空格 / Enter / 点卡面） */
  function flip(): void {
    if (finished || flipped) return;
    flipped = true;
    paintCard();
  }

  async function submit(grade: ReviewGrade): Promise<void> {
    if (finished || !flipped) return;
    const card = cards[idx];
    let applied: ReviewCard | null = null;
    try {
      applied = await ctx.review.grade(card.id, grade);
    } catch (e) {
      /**
       * 落盘失败（`复习.json` 读不动 / 写不进去）→ **别让用户继续做无用功**：
       * 这一轮再怎么点也存不下来，明说原因、关掉浮层（面板那边会画出"读不出来"那行）。
       */
      notifyError('这一轮没能记下来', e instanceof Error ? e.message : String(e));
      h.close('error');
      return;
    }
    /**
     * `null` = **这张卡已经不在了**（`grade` 找不到 id 就不写盘；真库同步在同一进程里跑，
     * 会话中途被删/被剪枝是真的会发生的）。这种时候**不计入小结** —— 记一笔"没做的"会让
     * 小结骗人（独立审 2026-10-10 🟡）。
     */
    if (!applied) {
      notifyLight('这张已经不在了', '可能刚被删掉 —— 跳过，不计入本轮');
    } else {
      tally = countTally(tally, grade);
    }
    idx += 1;
    flipped = false;
    if (idx >= cards.length) {
      finished = true;
      paintSummary();
      return;
    }
    paintCard();
  }

  /** 本地键：够不到模块键盘路由（见文件头 ②），所以在浮层自己的根上听 */
  const onKey = (evt: KeyboardEvent): void => {
    if (evt.key === ' ' || evt.key === 'Enter') {
      evt.preventDefault();
      if (finished) h.close('done');
      else flip();
      return;
    }
    const hit = GRADES.find((g) => g.key === evt.key);
    if (hit) {
      evt.preventDefault();
      void submit(hit.grade);
    }
  };
  h.root.addEventListener('keydown', onKey);
  h.disposer.add(() => h.root.removeEventListener('keydown', onKey));
  face.addEventListener('click', () => flip());

  paintCard();
  /** 焦点落在浮层根上，键才进得来（模态挂在 body 上，不在 `.kbw-root` 里 —— 文件头 ②） */
  (h.root as HTMLElement).tabIndex = -1;
  keepFocus();

  return {
    closed,
    close: () => h.close('manual'),
  };
}

/**
 * 三档计数的**唯一文案出处**（小结那一屏与收尾通知共用；总数那句由调用方自己加，
 * 因为两边的总数写法不同：小结是「复习了 N 张」、通知是「本轮复习结束（N 张）」）。
 */
export function tallyText(tally: ReviewTally): string {
  return `记住 ${tally.remember} · 模糊 ${tally.fuzzy} · 忘记 ${tally.forgot}`;
}
