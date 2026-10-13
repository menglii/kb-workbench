/**
 * ui/settings/help.ts —— 设置 · **帮助**栏（P6 第八段新加；**P7.2b 起 = 教程中心**）
 *
 * 用户真机第 4 条："首次使用向导别放外观里"。搬出来的同时给它一个合适的家 ——
 * "带我走一遍 / 讲给我听 / 翻一翻"这一类与"把某个值改成什么"**不是一回事**，
 * 所以新开一栏，而不是塞进某一栏的角落。
 *
 * ## P7.2b 的结构（从上到下）
 *   ① **教程中心**：折叠卡（内容 = `ui/tutorial.ts` 的数据；**P7.10 起 9 篇**，其中
 *      `batch` / `find-notes` 两篇带 `shots` 配图，展开时先图后文）+ 每篇「导出为笔记」；
 *   ② 首次使用向导（原有）；
 *   ③ 看不懂某一栏，让 AI 讲一遍（原有）。
 *
 * ⚠️ **P7.10 起"待消费的意图"搬去了 `ui/tutorial.ts`**（`openTutorialCenter` /
 * `consumePendingArticle`）—— 理由是 `new-note.ts` 也要用它，留在本文件会成模块环。
 *
 * ## ⚠️ 写盘口径（P7.2b **有意识地改的契约**，别照旧注释理解）
 *
 * · 原来那句"这一栏一个字都不许写盘"是 P6 第八段的口径（当时只有"开向导 / 问 AI"
 *   两个动作，两者都只读）。1.6 拍板给教程中心加了「导出为笔记」——**红线随之改写**：
 *   这一栏**不许出现直接写盘 API**（vault.create / processFrontMatter / adapter.mkdir …
 *   一个都不许），导出必须走 `ui/new-note.ts` 的对话框那条**既有链路**
 *   （用户自己选名字与笔记位置、completion.createNote 落盘、通知如实报）。
 *   红线管的是"不许绕过既有通道"，不是"不许有通道"。
 * · **向导本身仍是只读的**（§14.4 照旧，`ui/wizard.ts` 的红线不动）。
 * · 判据在 `tests/specs/redline.ts`（P7.2b 补的**真断言** —— 之前这句话只写在注释里，
 *   全仓没有对应检查，属"文档说修了、代码没修"的反向版本）。
 */
import { btn, div, el } from '../primitives';
import { openNewNoteDialog } from '../new-note';
import { consumePendingArticle, TUTORIAL_ARTICLES } from '../tutorial';
import { group, ghostBtn, note, setTitle, toolbar } from './kit';
import type { SectionApi, SettingsSection } from './types';

export function makeHelpSection(): SettingsSection {
  return {
    id: 'help',
    label: '帮助',
    icon: 'help-circle',
    sub: '教程中心；重新走一遍首次使用向导；某一栏看不懂就让 AI 用大白话讲',
    render(host, api) {
      paint(host, api);
    },
  };
}

function paint(host: HTMLElement, api: Pick<SectionApi, 'ctx' | 'rerender' | 'close' | 'md'>): void {
  host.appendChild(setTitle('帮助', '这一栏不改任何值 —— 都是"翻一翻 / 带我走一遍 / 讲给我听"'));

  // ── ① 教程中心 ────────────────────────────────────────────────
  // 待消费意图（P7.10 起寄存/消费都在 `ui/tutorial.ts` —— 见那份文件里的搬家注释）
  const pending = consumePendingArticle();
  const cards = new Map<string, { card: HTMLElement; expand: (on: boolean) => void }>();
  host.appendChild(
    group('教程中心', `${TUTORIAL_ARTICLES.length} 篇 · 遇到不熟的地方先翻这里；每篇都能「导出为笔记」存进库里`),
  );
  for (const a of TUTORIAL_ARTICLES) {
    const card = div({ cls: 'kbw-tut-card' });
    const head = div({
      cls: 'kbw-tut-head',
      attr: { role: 'button', tabindex: '0', 'aria-expanded': 'false' },
    });
    const chev = div({ cls: 'kbw-tut-chev', text: '▸' });
    head.appendChild(chev);
    const tbox = div({ cls: 'kbw-tut-tbox' });
    tbox.appendChild(div({ cls: 'kbw-tut-title', text: a.title }));
    if (a.sub) tbox.appendChild(div({ cls: 'kbw-tut-sub', text: a.sub }));
    head.appendChild(tbox);
    head.appendChild(div({ cls: 'kbw-tut-sp' }));
    /**
     * 「导出为笔记」= 打开**新建笔记对话框**（正文预填）—— 与 AI 面板导出的**同一条链路**，
     * 名字 / 笔记位置由用户当场选，通知如实报。别在这里直接写盘（红线见文件头）。
     */
    head.appendChild(
      btn({
        cls: 'kbw-btn is-small is-ghost kbw-tut-export',
        text: '导出为笔记',
        title: '打开新建笔记对话框，这篇教程的正文已预填 —— 你选名字与笔记位置',
        on: {
          click: (evt) => {
            evt.stopPropagation(); // 别顺手把折叠翻一下
            openNewNoteDialog(api.ctx, { presetTitle: a.title, bodyText: `${a.md.trim()}\n` });
          },
        },
      }),
    );
    card.appendChild(head);
    const body = div({ cls: 'kbw-tut-body' });
    body.style.display = 'none';
    card.appendChild(body);
    /** 正文**第一次展开才渲染**（Markdown 渲染是异步的；折叠着就没必要过一遍） */
    let rendered = false;
    const expand = (on: boolean): void => {
      card.classList.toggle('is-open', on);
      body.style.display = on ? '' : 'none';
      chev.textContent = on ? '▾' : '▸';
      head.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on && !rendered) {
        rendered = true;
        // P7.10 · #8：配图排在正文**之前**（先图后文）；加载失败整块隐藏（不摆破图）
        for (const s of a.shots ?? []) body.appendChild(shotBox(api.ctx, s));
        void api.md(body, a.md);
      }
    };
    head.addEventListener('click', () => expand(!card.classList.contains('is-open')));
    head.addEventListener('keydown', (evt) => {
      /**
       * 🔴 **焦点在卡头里面的控件上时不接**（独立审 2026-10-03 🟡）：事件从
       * 「导出为笔记」按钮冒泡上来，`preventDefault()` 会把按钮自己的
       * Enter/Space 激活**取消掉** —— 症状是"Tab 到导出按钮按 Enter，对话框不开、
       * 卡片翻一下"（鼠标点没事，所以肉眼容易漏）。只认焦点就在卡头本身的那一发。
       */
      if (evt.target !== head) return;
      const k = (evt as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        evt.preventDefault();
        expand(!card.classList.contains('is-open'));
      }
    });
    cards.set(a.id, { card, expand });
    host.appendChild(card);
  }
  // 消费"落到某一篇"的意图（消费一次即清 —— 见 pendingArticle 的注释）
  if (pending) {
    const entry = cards.get(pending);
    if (entry) {
      entry.expand(true);
      // ⚠️ 面板刚挂上，等一帧再滚（此刻布局还没跑完）；`?.` 是因为 jsdom 里它不存在
      requestAnimationFrame(() => entry.card.scrollIntoView?.({ block: 'nearest' }));
    }
  }

  // ── ② 首次使用向导（P7.9 · ①：检测屏退役 —— 三步改两步）────────
  host.appendChild(group('首次使用向导', '两步：工作文件夹 / 模块开关'));
  host.appendChild(
    toolbar(
      ghostBtn('重新运行首次向导', () => {
        // 先收面板再开向导：两个模态叠着时 Esc 只关最上面那个，下面的会留在屏幕上
        api.close();
        api.ctx.openWizard();
      }),
    ),
  );
  host.appendChild(
    note(
      '向导只在「从未配置过」时自动出现一次；想再看一遍点上面那个按钮。' +
        '它只写设置（工作文件夹 / 开关这类）；「新建」模式会顺手建出那个空文件夹，其余不碰库里的文件 —— 库缺什么，首页「待处理」里都有。',
    ),
  );

  // ── ③ 看不懂某一栏，让 AI 讲一遍（原有）─────────────────────
  host.appendChild(group('看不懂某一栏，让 AI 讲一遍', '走的是与 AI 助手同一条链路，默认只读'));
  // ⚠️ 说人话、一件事一段：三块便签叠在一起会变成噪音（真机截图看过）
  host.appendChild(
    note(
      '每一栏标题右边都有一枚「问 AI」：点它会把这一栏的项目喂给模型，用人话讲一遍。' +
        '它只回答、不动库；还没配模型的话，先去「AI 助手」那一栏填 baseURL / 模型 / key。',
    ),
  );
}

/**
 * 教程配图（P7.10 · #8）：与向导同款的 `<img>`（`getResourcePath` + **加载失败整块隐藏**）。
 * ⚠️ 与 `ui/wizard.ts` 的 `.kbw-wiz-img` 是**同一份图片呈现规矩**（1px 边框 + 暗色压一点
 * 亮度）——两处类名各自独立、样式要成对改（见 `styles/settings.css` 那段注释）。
 */
function shotBox(ctx: SectionApi['ctx'], name: string): HTMLElement {
  const box = div({ cls: 'kbw-tut-shot' });
  const img = el('img', {
    cls: 'kbw-tut-img',
    attr: {
      src: ctx.app.vault.adapter.getResourcePath(`${ctx.pluginDir}/assets/tutorial/${name}`),
      alt: '教程配图',
      draggable: 'false',
    },
  }) as HTMLImageElement;
  img.addEventListener('error', () => box.classList.add('is-missing'));
  box.appendChild(img);
  return box;
}
