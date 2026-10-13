/**
 * blocks/hero —— 顶部标识 + 搜索框（§2.1）
 *
 * **P7.2a 从 `modules/home/index.ts` 原样搬出**（拆块不带功能变化）——
 * 文案、类名、事件行为逐字照旧。快捷动作（原来在 hero 里）已拆成独立块。
 *
 * ⚠️ 搜索框**不进任何 Region**（工具条那条经验：一重画就丢焦点）——
 * 它只随块重建；日常的索引变化不碰它。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { HomeBlock } from './index';
import { COMMANDS, fullCommandId } from '../../../core/commands';
import { pushEscapeLayer } from '../../../core/keymap';
import { brandMark, btn, div, el, icon, span } from '../../../ui/primitives';
import { NOTIFY_MS, notify } from '../../../ui/notify';
import { matchesSearch } from '../../notes/filters';
import { recordOnboarding } from '../onboarding';

/** 上次 paint 建出来的东西（块内瞬时状态；cleanup 会清） */
let searchInput: HTMLInputElement | null = null;
let searchMsg: HTMLElement | null = null;
/** Esc 的一层（搜索框有内容时才压）*/
let escPop: (() => void) | null = null;

/** `/` 键聚焦搜索框 —— HomeModule 的 `focus-search` 动作接到这里 */
export function focusHeroSearch(): void {
  searchInput?.focus();
  searchInput?.select?.();
}

function showMsg(children: HTMLElement[]): void {
  if (!searchMsg) return;
  clearMsg();
  for (const c of children) searchMsg.appendChild(c);
}

function clearMsg(): void {
  if (!searchMsg) return;
  while (searchMsg.firstChild) searchMsg.removeChild(searchMsg.firstChild);
  syncEscLayer();
}

/**
 * Esc 的最后一层：**先清搜索框，再退回别的**。
 * Esc 不走 `keymap.bind`（`handle()` 里 escape 只问分层栈）→
 * 有内容可清时才压一层，清干净了就弹掉（免得挡住更外层的退出）。
 */
function syncEscLayer(): void {
  const has = (searchInput?.value ?? '') !== '' || (searchMsg?.childElementCount ?? 0) > 0;
  if (has && !escPop) {
    escPop = pushEscapeLayer(() => {
      if (searchInput) searchInput.value = '';
      clearMsg();
      syncEscLayer();
      return true;
    }, 'home:clear-search', { bottom: true });
  } else if (!has && escPop) {
    escPop();
    escPop = null;
  }
}

/** `>` 开头 → 命令模式（列出那 4 条，点一条就跑） */
function showCommands(ctx: WorkbenchContext, filter: string): void {
  const q = filter.trim().toLowerCase();
  const list = COMMANDS.filter((c) => !q || c.name.toLowerCase().includes(q));
  if (list.length === 0) {
    showMsg([div({ cls: 'kbw-hero-msg-line', text: '没有匹配的命令' })]);
    return;
  }
  showMsg(
    list.map((c) =>
      div(
        {
          cls: ['kbw-hero-cmd', 'kbw-hover-1'],
          attr: { role: 'option', tabindex: '0' },
          on: {
            click: () => {
              clearMsg();
              if (searchInput) searchInput.value = '';
              runCommand(ctx, c.key);
            },
          },
        },
        icon(c.icon, 15),
        span({ text: c.name }),
      ),
    ),
  );
}

/** 走平台的命令注册表（**带插件 id 前缀**，与命令面板同一条路） */
function runCommand(ctx: WorkbenchContext, key: (typeof COMMANDS)[number]['key']): void {
  const commands = (ctx.app as unknown as {
    commands?: { executeCommandById?: (id: string) => boolean };
  }).commands;
  const id = fullCommandId(key);
  if (commands?.executeCommandById?.(id)) return;
  // 命令面板没注册上（模块关着等）→ 退回直接跑，别让按钮点了没反应
  const def = COMMANDS.find((c) => c.key === key);
  if (!def) return;
  notify({ kind: 'info', text: `命令没注册（${id}）`, detail: '可能对应的模块被关掉了', ms: NOTIFY_MS.info });
}

async function submit(ctx: WorkbenchContext, raw: string): Promise<void> {
  const q = raw.trim();
  if (!q) return;
  if (q.startsWith('>')) {
    showCommands(ctx, q.slice(1));
    return;
  }
  // 16.13（P7.2d）：用过搜索（提交了一次真搜索就是用过 —— 含"没搜到"那支）
  recordOnboarding(ctx, 'search');
  const hits = ctx.index.notes().filter((e) => matchesSearch(e, q, 'all'));
  if (hits.length > 0) {
    // 有匹配 → 跳「全部笔记」，预填搜索词（§2.1）
    ctx.goNotes({ search: q });
    return;
  }
  // 无匹配 → **原地**给空态，不跳；同时只提议交给 AI（决策 15：不猜语义）
  showMsg([
    div({ cls: 'kbw-hero-msg-line', text: `没有匹配「${q}」的笔记` }),
    btn({
      cls: 'kbw-btn is-small',
      text: '要交给 AI 处理吗？',
      title: '把这句话带进 AI 助手 —— 它给方案，你勾了才执行',
      on: {
        /**
         * P6 段④：这条提议**接上了**。
         *
         * 「只提议、不自动执行」（决策 15）一个字没变 —— 带过去的是**那句话本身**
         *（用户刚才打的那串字），不是"替他决定"的意图。AI 面板不会自动发问，
         * 光标落在输入框里等他确认或改口。
         */
        click: () => ctx.openAi(q),
      },
    }),
  ]);
}

function searchBox(ctx: WorkbenchContext): HTMLElement {
  const wrap = div({ cls: 'kbw-gsearch' });
  wrap.appendChild(icon('search', 16, 'kbw-gsearch-ico'));
  const input = el('input', {
    cls: 'kbw-gsearch-input',
    attr: { type: 'text', placeholder: '搜索笔记，或直接说你要做什么…', 'aria-label': '搜索笔记' },
  });
  searchInput = input;
  input.addEventListener('keydown', (evt) => {
    const k = evt as KeyboardEvent;
    if (k.key === 'Escape') {
      k.stopPropagation();
      input.value = '';
      clearMsg();
      syncEscLayer();
      return;
    }
    if (k.key !== 'Enter') return;
    k.preventDefault();
    void submit(ctx, input.value);
  });
  input.addEventListener('input', () => {
    if (input.value.startsWith('>')) showCommands(ctx, input.value.slice(1));
    else clearMsg();
    syncEscLayer();
  });
  wrap.appendChild(input);
  wrap.appendChild(span({ cls: 'kbw-key', text: '/', title: '按 / 聚焦搜索框' }));
  return wrap;
}

export const heroBlock: HomeBlock = {
  id: 'hero',
  title: '顶部标识与搜索',
  hint: '品牌标 + 大搜索框（搜不到会提议交给 AI；「>」开头列命令）',
  defaultOn: true,
  width: 'narrow',
  paint(ctx, host) {
    const hero = div({ cls: 'kbw-hero' });
    const mark = brandMark(56, 'kbw-hero-mark');
    mark.style.margin = '0 auto var(--sp-3)';
    hero.appendChild(mark);
    hero.appendChild(el('h1', { cls: 'kbw-hero-name', text: '经纬' }));
    hero.appendChild(div({ cls: 'kbw-hero-sub', text: '知识工作台' }));
    hero.appendChild(searchBox(ctx));
    searchMsg = div({ cls: 'kbw-hero-msg' });
    hero.appendChild(searchMsg);
    host.appendChild(hero);
    return true;
  },
  cleanup() {
    escPop?.();
    escPop = null;
    searchInput = null;
    searchMsg = null;
  },
};
