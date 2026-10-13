/**
 * ui/keys-help.ts —— 快捷键表（交互规格 §1.4 的 `?`，也是外壳上的 `⌨`）
 *
 * 「全部可配置」——点一下键位胶囊就进入录制态，按下新组合即可改。
 * 存进插件 `data.json` 的 `keymap`（界面偏好，不是知识库配置）。
 *
 * ⚠️ 冲突不拦、只提示：真拦下来会在"想先把 A 让开再绑 B"这种操作里把人卡死。
 */
import { btn, div, el, span } from './primitives';
import { openModal } from './panel';
import { pushEscapeLayer } from '../core/keymap';
import { confirm } from './confirm';
import { KEY_ACTIONS, KEY_ACTION_BY_ID, normalizeKey, prettyKey, type KeyActionId } from '../core/keymap';
import type { Keymap } from '../core/keymap';
import { notifyInfo } from './notify';

/** 保存操作：`reset` = 恢复默认（删掉覆盖）；`set` = 设成这些键 */
export interface KeysHelpOps {
  reset?: KeyActionId[];
  set?: Partial<Record<KeyActionId, string[]>>;
}

export interface KeysHelpOptions {
  keymap: Keymap;
  onSave: (ops: KeysHelpOps) => void | Promise<void>;
  /** 当前存着的覆盖（用来区分"这是默认键"还是"你改过"） */
  overrides: () => Record<string, string[]>;
}

const DEFAULT_HINT = '点击后按下新组合';

export function openKeysHelp(opts: KeysHelpOptions): void {
  const handle = openModal({
    title: '快捷键',
    sub: '点键位胶囊可以改；改过的存进插件设置，改完立即生效',
    width: 'normal',
  });

  let recording: { id: KeyActionId; chip: HTMLElement } | null = null;
  /** 录制态压在 Esc 栈顶：Esc 只取消这次录制，不该把整张表关掉 */
  let popRecordLayer: (() => void) | null = null;

  const stopRecording = (): void => {
    if (popRecordLayer) {
      popRecordLayer();
      popRecordLayer = null;
    }
    if (!recording) return;
    const chip = recording.chip;
    const keys = opts.keymap.keysFor(recording.id);
    chip.classList.remove('is-recording');
    chip.textContent = keys.map(prettyKey).join('  ');
    chip.setAttribute('title', DEFAULT_HINT);
    recording = null;
  };

  const paintKeys = (keysBox: HTMLElement, id: KeyActionId): void => {
    while (keysBox.firstChild) keysBox.removeChild(keysBox.firstChild);
    for (const key of opts.keymap.keysFor(id)) {
      const chip = makeChip(id, key);
      // 撞车要**长期看得见**：否则改完当时弹个通知，关掉就忘了，
      // 之后只会觉得"这个键怎么不灵"（真机第一轮用户就踩了：/ 被两个动作占着）
      const owner = opts.keymap.ownerOf(key, id);
      if (owner) {
        chip.classList.add('is-conflict');
        chip.setAttribute('title', `与「${KEY_ACTION_BY_ID[owner]?.label ?? owner}」冲突：那个动作排在前面，会先响应`);
        chip.style.textDecoration = 'underline dotted';
        chip.style.color = 'var(--color-yellow)';
        keysBox.appendChild(chip);
        keysBox.appendChild(
          el('span', {
            cls: 'kbw-faint',
            text: `⚠ 与「${KEY_ACTION_BY_ID[owner]?.label ?? owner}」冲突`,
            attr: { title: '两个动作抢同一个键时，**上面那个**先响应' },
          }),
        );
        continue;
      }
      keysBox.appendChild(chip);
    }
  };

  const makeChip = (id: KeyActionId, key: string): HTMLElement => {
    const custom = Array.isArray(opts.overrides()[id]);
    const chip = el('span', {
      /**
       * 🔴 **类名不再叫 `kbw-kbd`**（真机实测抓的真 bug）：工作台**根元素**在键盘模式下
       * 也带 `kbw-kbd`（那是"键盘高亮"的旗标，见 `workbench-view.ts`），
       * 而 `styles/components.css` 里那条键帽规则是**裸选择器** —— 于是用户一按键盘，
       * 整棵工作台就被套上键帽的样式（实测：根元素变成 `font-size 11px / 等宽字 /
       * 1px 边框 / padding 12px / white-space: nowrap`）。
       * 最刺眼的一处是 nowrap **被后代继承** → 卡片摘要与小窗预览**再也不折行**
       *（用户 ⑥ 那条"预览要换行"的真根因）。
       * 两个用途撞一个类名 → 换掉组件那一个（旗标那个名字是公开约定，别动）。
       */
      cls: ['kbw-keycap', custom ? 'is-custom' : null],
      text: prettyKey(key),
      title: custom ? '你改过这个键（点它可再改，点 × 恢复默认）' : DEFAULT_HINT,
      attr: { role: 'button', tabindex: '0' },
    });
    if (custom) {
      // 单独恢复默认 —— 只改错一个键时不用把整张表都重置
      chip.appendChild(
        el('span', {
          cls: 'kbw-x',
          text: '×',
          attr: { role: 'button', 'aria-label': '这一个恢复默认', title: '这一个恢复默认' },
          css: { marginLeft: '4px', color: 'var(--text-faint)' },
          on: {
            click: (evt) => {
              evt.stopPropagation();
              const keysBox = chip.parentElement;
              void opts.onSave({ reset: [id] });
              if (keysBox) paintKeys(keysBox as HTMLElement, id);
            },
          },
        }),
      );
    }
    const begin = (): void => {
      stopRecording();
      recording = { id, chip };
      popRecordLayer = pushEscapeLayer(() => {
        stopRecording();
        return true;
      }, 'keys-help-recording');
      chip.classList.add('is-recording');
      chip.textContent = '按下新组合…';
    };
    chip.addEventListener('click', begin);
    chip.addEventListener('keydown', (evt) => {
      if (!recording && (evt.key === 'Enter' || evt.key === ' ')) {
        evt.preventDefault();
        begin();
      }
    });
    return chip;
  };

  // 录制：全局捕获，避免按键漏到工作台里去
  const onCapture = (evt: Event): void => {
    if (!recording) return;
    const kev = evt as KeyboardEvent;
    evt.preventDefault();
    evt.stopPropagation();
    const id = recording.id;
    if (kev.key === 'Escape') {
      stopRecording();
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(kev.key)) return; // 等真正的键
    const key = normalizeKey(kev);
    stopRecording();
    void applyKey(id, key, true);
  };
  handle.disposer.add(() => document.removeEventListener('keydown', onCapture, true));
  document.addEventListener('keydown', onCapture, true);

  /**
   * 应用一个键位。
   * **撞车先拦住**：问清楚要不要把旧的那个解绑；确认了才绑 + 解绑旧的 + 明确提醒。
   * 理由：默默绑上去等于埋雷 —— 用户之后只会觉得"这个键怎么不灵"。
   */
  async function applyKey(id: KeyActionId, key: string, ask = false): Promise<void> {
    const owner = opts.keymap.ownerOf(key, id);
    if (owner && ask) {
      const ownerLabel = KEY_ACTION_BY_ID[owner]?.label ?? owner;
      const mineLabel = KEY_ACTION_BY_ID[id]?.label ?? id;
      const r = await confirm({
        title: `「${prettyKey(key)}」已经被「${ownerLabel}」占用`,
        preview: [],
        warnings: [`要把它从「${ownerLabel}」那边解绑吗？那个动作用这个键就再也触发不了，得回这张表重新设`],
        notes: [`点了主按钮之后：「${mineLabel}」用这个键；「${ownerLabel}」变成未绑定`],
        // 不再叠一层"两下确认"：这里已经是一次显式确认了，再点两下太啰嗦
        primary: { label: '抢过来并解绑旧的' },
        secondary: [{ label: '算了', value: 'cancel' }],
      });
      if (r.action !== 'primary') {
        const row0 = handle.body.querySelector<HTMLElement>(`[data-keys-for="${id}"]`);
        if (row0) paintKeys(row0, id);
        return;
      }
      notifyInfo(
        `「${ownerLabel}」的「${prettyKey(key)}」已解绑`,
        `「${mineLabel}」现在用它；想给「${ownerLabel}」重新设键，点它的键位胶囊`,
      );
      // ⚠️ 抢键 = 把旧动作**设成空数组（显式解绑）**，不是删覆盖 ——
      // 删了会回落默认值，那个键等于没抢走
      void opts.onSave({ set: { [id]: [key], [owner]: [] } });
    } else {
      void opts.onSave({ set: { [id]: [key] } });
    }
    const row = handle.body.querySelector<HTMLElement>(`[data-keys-for="${id}"]`);
    if (row) paintKeys(row, id);
  }

  // ── 帮助（D1：底部那行"键位写法"收进这里，点「帮助」才展开）──
  const helpBox = div({ cls: 'kbw-keys-help' });
  helpBox.style.display = 'none';
  {
    const add = (title: string, lines: string[]): void => {
      helpBox.appendChild(div({ cls: 'kbw-keys-help-t', text: title }));
      for (const line of lines) helpBox.appendChild(div({ cls: 'kbw-keys-help-p', text: line }));
    };
    add('键位写法', [
      '普通字符就是字符本身（/ ?）；命名键写 arrowup / escape / space / f10；',
      '修饰键写 mod（Mac 上是 ⌘）shift alt，中间用 + 连起来。',
    ]);
    add('怎么改', [
      '点键位胶囊 → 按下新组合。录制期间按 Esc 只取消这一次录制（不会关掉这张表）。',
      '改过的键用主题色标出，点它旁边的 × 只恢复这一个。',
    ]);
    add('撞车怎么办', [
      '两个动作抢同一个键时，表里靠上的那个先响应（冲突会长期用 ⚠ 标出来）。',
      '把键改到一个已被占用的动作上 → 先弹确认；确认后旧动作被显式解绑（不是回落默认值），',
      '想给旧动作重新设键，点它自己的胶囊。',
    ]);
  }

  // ── 表（D2：按 `scope` 分组）──
  /**
   * 分组口径**直接取 `KEY_ACTIONS` 每一项自带的 `scope`**（`core/keymap.ts`）——
   * 不新增字段、也不在这里另抄一份"哪些动作属于哪一组"（那种抄写迟早与键表漂）。
   * 组标题带条数；每行标 `data-keys-row`（判据按**身份**认行，别数 `tbody tr`
   * —— 组标题行也在 tbody 里，数出来的数会被排版改动带跑偏）。
   */
  const scopes: string[] = [];
  for (const a of KEY_ACTIONS) if (!scopes.includes(a.scope)) scopes.push(a.scope);

  const table = el('table', { cls: 'kbw-table' });
  const tbody = el('tbody', {});
  for (const scope of scopes) {
    const actions = KEY_ACTIONS.filter((a) => a.scope === scope);
    const head = el('tr', { cls: 'kbw-keys-group' });
    head.appendChild(
      el('td', { attr: { colspan: '2' }, text: `${scope} · ${actions.length} 个动作` }),
    );
    tbody.appendChild(head);
    for (const action of actions) {
      const tr = el('tr', { attr: { 'data-keys-row': action.id } });
      /**
       * **P7.2b（1.6a）：每个动作补「一句人话」** —— 表里原来只有动作名。
       * 说明从 `KEY_ACTIONS[].note` 取（键表自己的字段，别在这儿另抄一份）；
       * 判据按身份认 `.kbw-keys-desc`（每行都得有、且非空）。
       */
      const nameTd = el('td', {});
      nameTd.appendChild(div({ cls: 'kbw-keys-name', text: action.label }));
      if (action.note) nameTd.appendChild(div({ cls: 'kbw-keys-desc', text: action.note }));
      tr.appendChild(nameTd);
      const cell = el('td', {});
      const keysBox = div({ attr: { 'data-keys-for': action.id } });
      keysBox.style.display = 'flex';
      keysBox.style.gap = 'var(--sp-1)';
      keysBox.style.flexWrap = 'wrap';
      paintKeys(keysBox, action.id);
      cell.appendChild(keysBox);
      tr.appendChild(cell);
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  handle.body.appendChild(helpBox);
  handle.body.appendChild(table);

  /**
   * **模块内固定键**（a 期 §4.2 补的五组；2026-09-25 用户拍板进表）。
   * ⚠️ 故意**不放进上面那个 `<tbody>`**：那里是"可改绑动作"（每行带 `data-keys-row`），
   * 固定键不能改绑 —— 混进去早晚有人当成能点的（判据也按身份认，见上）。
   */
  const fixedHead = div({ cls: 'kbw-modal-sub', text: '模块内固定键（不参与改绑，走到哪个模块就管哪一片）' });
  fixedHead.style.marginTop = 'var(--sp-4)';
  handle.body.appendChild(fixedHead);
  const fixedBox = div({ cls: 'kbw-keys-fixed' });
  for (const row of [
    { label: '就地改名', scope: '看板卡片 / 全部笔记行', keys: 'F2' },
    { label: '在新标签页中打开', scope: '看板卡片 / 全部笔记行', keys: 'Ctrl/⌘ + Enter' },
    { label: '上一张 / 下一张卡', scope: '看板', keys: '[  /  ]' },
    { label: '在板块之间跳', scope: '看板', keys: 'Ctrl/⌘ + ↑ / ↓' },
  ]) {
    const line = div({ cls: 'kbw-keys-fixed-row' });
    line.appendChild(span({ cls: 'kbw-keys-fixed-name', text: row.label }));
    line.appendChild(span({ cls: 'kbw-faint', text: row.scope }));
    line.appendChild(span({ cls: 'kbw-keys-fixed-key', text: row.keys }));
    fixedBox.appendChild(line);
  }
  handle.body.appendChild(fixedBox);

  handle.foot.style.display = '';
  /** 「帮助」（D1）：底部那行"键位写法"收进这里 —— 点一下展开，再点收起 */
  const helpBtn = btn({
    cls: 'kbw-btn kbw-hover-1',
    text: '帮助',
    attr: { 'aria-expanded': 'false', title: '键位写法 / 怎么改 / 撞车怎么办' },
    on: {
      click: () => {
        const open = helpBox.style.display === 'none';
        helpBox.style.display = open ? '' : 'none';
        helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        helpBtn.classList.toggle('is-on', open);
      },
    },
  });
  handle.foot.appendChild(helpBtn);
  handle.foot.appendChild(
    btn({
      cls: 'kbw-btn kbw-hover-1',
      text: '恢复默认',
      on: {
        click: () => {
          stopRecording();
          const ids = KEY_ACTIONS.map((a) => a.id);
          void (async () => {
            /**
             * ⚠️ **先落盘再重画**（D 期顺手修的）：`paintKeys` 靠 `opts.overrides()` 判断
             * "这个键是你改过的吗"，而它是从设置里现读的 —— 顺序反了的话，
             * 重画那一刻覆盖还没写回去，**胶囊上那些"你改过"的标记会赖着不走**
             * （键位已经回默认了，颜色还标着改过；正是本项目最烦的"点了没反应"那一类）。
             */
            await opts.onSave({ reset: ids });
            const all = handle.body.querySelectorAll<HTMLElement>('[data-keys-for]');
            all.forEach((box) => paintKeys(box, box.dataset.keysFor as KeyActionId));
          })();
        },
      },
    }),
  );
  handle.foot.appendChild(div({ cls: 'kbw-spacer' }));
  handle.foot.appendChild(
    btn({ cls: 'kbw-btn is-primary', text: '完成', on: { click: () => handle.close('done') } }),
  );
}
