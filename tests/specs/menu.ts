/**
 * spec：三级菜单 + 确认流 + Esc 逐级退出
 * 对应完成定义：三条硬规矩在代码里各有唯一实现点（菜单部分）
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  closeAllMenus,
  normalizeSpec,
  showContextMenu,
  showMenu,
  validateMenuSpec,
  type MenuSpec,
} from '../../src/ui/menu';
import { confirm } from '../../src/ui/confirm';
import { escapeDepth, __clearEscapeLayers } from '../../src/core/keymap';
// P7.14：属性子菜单的取值项（「（清空）」= 删键那条的纯逻辑判据）
import { valueItems } from '../../src/modules/notes/menus';

function specNote(): MenuSpec {
  return {
    scope: { kind: 'note', label: '未锈铠.md' },
    items: [
      { kind: 'item', label: '打开', icon: 'file-text', run: () => {} },
      { kind: 'item', label: '在新标签页中打开', icon: 'external-link', run: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: '重命名', icon: 'pencil', run: () => {} },
      { kind: 'item', label: '移动到…', icon: 'folder-input', disabled: '目录不存在', run: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: '删除（移入回收站）', danger: true, icon: 'trash', run: () => {} },
    ],
  };
}

function specGlobal(): MenuSpec {
  return {
    scope: { kind: 'global', label: '全部板块' },
    items: [
      {
        kind: 'item',
        label: '卡片显示',
        submenu: [
          { kind: 'item', label: '只内容', control: { type: 'radio', checked: true, group: 'cardMode' }, run: () => {} },
          { kind: 'item', label: '只属性', control: { type: 'radio', checked: false, group: 'cardMode' }, run: () => {} },
        ],
      },
      { kind: 'item', label: '卡片宽度', control: { type: 'slider', value: 240, min: 160, max: 480, step: 20 }, run: () => {} },
      { kind: 'item', label: '允许重复', control: { type: 'toggle', checked: true }, run: () => {} },
      { kind: 'item', label: '只看某一列', control: { type: 'multi', checked: false }, run: () => {} },
      { kind: 'item', label: '筛选词', control: { type: 'text', value: 'abc' }, run: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: '重载', icon: 'refresh-cw', run: () => {} },
      { kind: 'item', label: '恢复本视图默认设置', danger: true, disabled: '无改动', run: () => {} },
    ],
  };
}

function specBad(): MenuSpec {
  const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'item' as const, label: `项 ${i + 1}`, run: () => {} }));
  return {
    scope: { kind: 'global', label: '' },
    items: [...many, { kind: 'item', label: '删除', danger: true }, { kind: 'item', label: '普通项在危险项后面' }],
  };
}

export async function specMenu(
  suite: Suite,
  _app: StubApp,
  _plugin: KbWorkbenchPlugin,
  _vaultRoot: string,
): Promise<void> {
  await suite.group('菜单 · 三条硬规矩', async () => {
    await suite.it('作用域行常驻：第一行永远是"作用范围：…"', async () => {
      const h = showMenu({ x: 100, y: 100 }, specNote());
      await H.tick();
      const first = h.el.children[0] as HTMLElement;
      ok(first.classList.contains('kbw-menu-scope'), '第一行应该是作用域行');
      contains(H.textOf(first), '作用范围：未锈铠.md', '作用域文案');
      h.close();
    });

    await suite.it('危险项排末位、上方有分隔线（规范化自动做到）', async () => {
      const messy: MenuSpec = {
        scope: { kind: 'global', label: '全部板块' },
        items: [
          { kind: 'separator' },
          { kind: 'item', label: '普通一' },
          { kind: 'separator' },
          { kind: 'separator' },
          { kind: 'item', label: '普通二' },
          { kind: 'item', label: '删除', danger: true },
          { kind: 'separator' },
        ],
      };
      const norm = normalizeSpec(messy);
      eq(validateMenuSpec(norm).length, 0, '规范化之后不该再有违规');
      const kinds = norm.items.map((i) => (i.kind === 'separator' ? 'sep' : i.danger ? 'danger' : 'item'));
      // 输入是 [sep, item1, sep, sep, item2, danger, sep]：
      // 开头的 sep 去掉、重复的 sep 去掉、末尾的 sep 去掉 —— 但**中间那条要留着**（人工分组）
      eq(kinds.join(','), 'item,sep,item,sep,danger', '清掉多余的，留住人工分组线');
    });

    await suite.it('校验器能查出三类违规（唯一实现点）', async () => {
      const v = validateMenuSpec(specBad());
      const rules = [...new Set(v.map((x) => x.rule))].sort();
      eq(rules.join(','), 'clarity,danger,scope', '三类都该报');
    });

    /**
     * 硬规矩 2 的**两个方向**（2026-10-02 放宽后的口径："一眼扫得完"而不是"≤ 8 项"）：
     * 长且**一坨平铺** → 报；长但**分了组** → 不报。少任何一边，
     * "永远不报"或"永远报"都照样绿（本项目最怕的那种）。
     */
    await suite.it('长菜单的清晰性：一坨平铺要报、有分组就不报（两个方向都判）', async () => {
      const flat: MenuSpec = {
        scope: { kind: 'global', label: '平铺' },
        items: Array.from({ length: 12 }, (_, i) => ({ kind: 'item' as const, label: `项 ${i + 1}` })),
      };
      eq(validateMenuSpec(flat).map((x) => x.rule).join(','), 'clarity', '12 项且一条分隔线都没有 → 报');
      const grouped: MenuSpec = {
        scope: { kind: 'global', label: '有分组' },
        items: [
          ...Array.from({ length: 6 }, (_, i) => ({ kind: 'item' as const, label: `甲 ${i + 1}` })),
          { kind: 'separator' as const },
          ...Array.from({ length: 6 }, (_, i) => ({ kind: 'item' as const, label: `乙 ${i + 1}` })),
        ],
      };
      eq(validateMenuSpec(grouped).length, 0, '12 项但有视觉台阶 → 不算违规（这正是放宽的那一半）');
      // 边界：正好软目标（8 项）且平铺 → 也不报（数字本身不是判据）
      const eight: MenuSpec = {
        scope: { kind: 'global', label: '八项' },
        items: Array.from({ length: 8 }, (_, i) => ({ kind: 'item' as const, label: `项 ${i + 1}` })),
      };
      eq(validateMenuSpec(eight).length, 0, '8 项平铺不报（软目标是"超过它才要求分组"）');
    });

    await suite.it('长且平铺：console.warn 但不崩（接线真的在）', async () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '));
      try {
        const flat: MenuSpec = {
          scope: { kind: 'global', label: '平铺' },
          items: Array.from({ length: 12 }, (_, i) => ({ kind: 'item' as const, label: `项 ${i + 1}` })),
        };
        const h = showMenu({ x: 10, y: 10 }, flat);
        await H.tick();
        h.close();
      } finally {
        console.warn = orig;
      }
      ok(warns.some((w) => w.includes('违反硬规矩')), '应该有告警');
    });

    await suite.it('不可用项置灰并写出原因（位置不跳动）', async () => {
      const h = showMenu({ x: 10, y: 10 }, specNote());
      await H.tick();
      const rows = H.qa(h.el, '.kbw-menu-item');
      const disabled = rows.find((r) => H.textOf(r).includes('移动到…'));
      ok(disabled, '找到那一项');
      ok(disabled?.classList.contains('is-disabled'), '应该置灰');
      contains(H.textOf(disabled), '目录不存在', '把原因写出来');
      eq(disabled?.getAttribute('aria-disabled'), 'true', 'aria 也对');
      h.close();
    });

    await suite.it('四种控件都渲染得出来（开关 / 单选 / 多选 / 拉杆）', async () => {
      const h = showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      ok(h.el.querySelector('.kbw-switch'), '开关');
      ok(h.el.querySelector('input[type="checkbox"]'), '多选');
      ok(h.el.querySelector('input[type="range"]'), '拉杆');
      ok(h.el.querySelector('input[type="text"]'), '文本框');
      h.close();
    });

    await suite.it('点整行 = 切控件 + 把新值写回控件本身（勾选框视觉翻 · 连点两次是「开→关」）', async () => {
      /**
       * 🔴 P7.1a 补的老账（真机截图抓到的）：以前点整行只 `fire(next)` 出去，
       * 控件自己的 `checked` 停在旧值 → ① 框视觉不翻转（"勾了没反应"）；
       * ② 再点一次又送出**同一个值**（multi 永远开）。
       * 这条用 `stay: true`（列菜单就是这种）从**可见的 DOM** 上判两次点击的结果 ——
       * 只断言"回调收到过什么"会漏掉①（框本身没动）。
       */
      const got: boolean[] = [];
      const spec: MenuSpec = {
        scope: { kind: 'global', label: '测试' },
        items: [
          {
            kind: 'item',
            label: '只看某一列',
            control: { type: 'multi', checked: false },
            stay: true,
            run: (c) => got.push(Boolean(c.value)),
          },
        ],
      };
      const h = showMenu({ x: 10, y: 10 }, spec);
      await H.tick();
      /** 每次都重新取可见的那一行 / 那个框（`stay` 会就地重画，旧引用会变成游离节点） */
      const rowNow = (): HTMLElement => H.q(document.body, '.kbw-menu-item');
      const boxNow = (): HTMLInputElement | null =>
        document.querySelector<HTMLInputElement>('.kbw-menu input.kbw-check');
      eq(boxNow()?.checked, false, '初始没勾');

      H.click(rowNow());
      await H.tick();
      eq(boxNow()?.checked, true, '点整行 → 框当场翻到勾上（不许停在旧值）');
      H.click(rowNow());
      await H.tick();
      eq(boxNow()?.checked, false, '再点一次 → 翻回没勾（旧写法这里会又送一次 true）');
      eq(got.join(','), 'true,false', `两次交出去的值是 开→关（实际 ${got.join(',')}）`);

      /**
       * **混用两条路**（独立审查 R2）：点**框本身**（原生 change）→ 点整行。
       * 少了 `change` 里那句 `c.checked = box.checked`，整行那下就会按旧值取反、
       * 把刚点框那一下**吞掉**（值序列错成 开→关→开→开）。
       */
      H.click(boxNow() as Element);
      await H.tick();
      eq(boxNow()?.checked, true, '点框 → 勾上（原生 change 这条路）');
      H.click(rowNow());
      await H.tick();
      eq(boxNow()?.checked, false, '再点整行 → 翻回（两条路共享同一份当前值）');
      eq(got.join(','), 'true,false,true,false', `混用后总序列（实际 ${got.join(',')}）`);
      h.close();
    });

    await suite.it('子菜单悬停飞出；Esc 先收子菜单、再收父菜单', async () => {
      __clearEscapeLayers();
      const h = showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      const row = H.qa(h.el, '.kbw-menu-item').find((r) => H.textOf(r).includes('卡片显示'));
      ok(row, '找到带子菜单的那一项');
      row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await H.tick();
      const menus = H.qa(document.body, '.kbw-menu');
      eq(menus.length, 2, '应该有两个菜单（父 + 子）');
      contains(H.textOf(menus[1]), '只内容', '子菜单内容');
      eq(escapeDepth(), 2, '两层都压在 Esc 栈上');

      H.keydown(document.body, 'Escape');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '先收子菜单');
      H.keydown(document.body, 'Escape');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 0, '再收父菜单');
      eq(escapeDepth(), 0, '栈清空');
    });

    /**
     * P7.13a · #4 · Q13：**可点作用域行**（可选能力）——
     *   ① 传了 `scope.submenu`：作用域行带 is-pick + ›，**点**它飞出一份子菜单；
     *   ② 没传：作用域行与从前一字不差（没有 is-pick、点了什么都不发生）。
     * "其它菜单零变化"与"传了才生效"两个方向都判（本项目最怕单边恒真的断言）。
     */
    await suite.it('可点作用域行（P7.13a · #4）：传了才生效；点它展开、Esc 逐级退出、子级不套娃', async () => {
      __clearEscapeLayers();
      const spec: MenuSpec = {
        scope: {
          kind: 'global',
          label: '00_Inbox · 1 篇',
          submenu: [
            { kind: 'item', label: '00_Inbox · 1 篇', checked: true, stay: true, run: () => {} },
            { kind: 'item', label: '02_Areas · 27 篇', stay: true, run: () => {} },
          ],
        },
        items: [{ kind: 'item', label: '一键自动整理', icon: 'wand-2' }],
      };
      const h = showMenu({ x: 10, y: 10 }, spec);
      await H.tick();
      const scopeRow = H.q(h.el, '.kbw-menu-scope');
      ok(scopeRow.classList.contains('is-pick'), '传了 submenu：作用域行成了可点行');
      contains(H.textOf(scopeRow), '›', '带 ›（可点的入口暗示）');
      eq(H.qa(document.body, '.kbw-menu').length, 1, '点之前只有一扇');
      H.click(scopeRow);
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 2, '**点**它飞出一份子菜单（不挂悬停 —— 右键常开在光标底下）');
      const sub = H.qa(document.body, '.kbw-menu')[1];
      contains(H.textOf(sub), '02_Areas · 27 篇', '子菜单 = 选择列表（含现算的篇数）');
      eq(
        H.qa(sub, '.kbw-menu-scope.is-pick').length,
        0,
        '子菜单自己的作用域行**不带**可点能力（剥掉 —— 否则无限套娃）',
      );
      eq(escapeDepth(), 2, '两层都压在 Esc 栈上');
      H.keydown(document.body, 'Escape');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, 'Esc 先收子菜单');
      H.keydown(document.body, 'Escape');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 0, '再收父菜单');
      eq(escapeDepth(), 0, '栈清空');

      // 对照：没传 submenu 的菜单 —— 作用域行与从前一字不差
      const h2 = showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      const row2 = H.q(h2.el, '.kbw-menu-scope');
      ok(!row2.classList.contains('is-pick'), '没传的菜单：没有 is-pick');
      H.click(row2);
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '点它什么都不发生');
      h2.close();
    });

    /**
     * 用户 2026-09-25 真机反馈：「右键菜单打开后，点击别处空白没法让菜单关闭」。
     * 这条从 P0 起就漏了（菜单只认 Esc / 选中项 / 换一个触发点）—— 补上并钉住。
     */
    await suite.it('点菜单外面就关掉（空白处 / 另一个元素都算外面）', async () => {
      __clearEscapeLayers();
      const h = showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '先开一个');

      // ① 点菜单**里面**不该关（否则整条菜单点不动）
      const inside = H.q(h.el, '.kbw-menu-item');
      inside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '点菜单里面不该关');

      // ② 点外面（空白）→ 关
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 0, '点空白关掉');

      // ③ 触屏路径：只派 pointerdown 也要关（触屏不一定合成 mousedown）
      showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '再开一个');
      H.pointerDown(document.body, { x: 5, y: 5 });
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 0, 'pointerdown 也要能关（触屏）');

      // ④ 子菜单也算"里面"：鼠标从父菜单移到飞出去的子菜单上不该关
      const h3 = showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      const row = H.qa(h3.el, '.kbw-menu-item').find((r) => H.textOf(r).includes('卡片显示'));
      row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await H.tick();
      const menus = H.qa(document.body, '.kbw-menu');
      eq(menus.length, 2, '父 + 子');
      menus[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 2, '点子菜单上不该关');
      closeAllMenus();
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 0, '收尾');
    });

    await suite.it('键盘走完：↓ 移动高亮、→ 进子菜单、← 退回', async () => {
      __clearEscapeLayers();
      const h = showMenu({ x: 10, y: 10 }, specGlobal());
      await H.tick();
      H.keydown(h.el, 'ArrowDown');
      eq(H.qa(h.el, '.kbw-menu-item.is-active').length, 1, '有一个高亮项');
      const active = H.q(h.el, '.kbw-menu-item.is-active');
      contains(H.textOf(active), '卡片显示', '第一项就是带子菜单的那个');
      H.keydown(h.el, 'ArrowRight');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 2, '→ 进了子菜单');
      H.keydown(H.qa(document.body, '.kbw-menu')[1], 'ArrowLeft');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '← 退回父菜单');
      closeAllMenus();
    });

    await suite.it('右键入口会 preventDefault，并且从触发点展开', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);
      // ⚠️ 必须**同一个事件对象**：派发它、再把它交给 showContextMenu，
      // 否则断言的是另一个"从未被派发过"的对象（旧写法就是这个自证）
      const evt = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 321,
        clientY: 111,
      });
      target.dispatchEvent(evt);
      const h = showContextMenu(evt, specNote());
      await H.tick();
      ok(evt.defaultPrevented, '右键入口必须 preventDefault（否则原生菜单会一起弹出来）');
      // 位置要真的按触发点算：jsdom 被覆盖成 200×100，窗口 1024×768 → 不翻边 →
      // 期望 left = 321+4, top = 111+4
      eq(h.el.style.left, '325px', '菜单 left 应按触发点算');
      eq(h.el.style.top, '115px', '菜单 top 应按触发点算');
      const origin = h.el.style.getPropertyValue('--kbw-origin');
      eq(origin, '0px 0px', `展开原点应在触发点（元素左上），实际 ${origin}`);
      h.close();
      target.remove();
    });
  });

  await suite.group('确认流', async () => {
    await suite.it('主按钮 → primary，且按钮文案重复数量（不是"确定"）', async () => {
      const p = confirm({
        title: '即将移动 2 篇笔记',
        preview: [{ kind: 'move', from: '00_Inbox/a.md', to: '02_Areas/内容创作', count: 2 }],
        warnings: ['2 篇目标目录已有同名文件'],
        notes: ['1 篇设了「位置锁定」，将一并移动'],
        primary: { label: '移动 2 篇' },
      });
      await H.tick();
      const modal = H.q(document.body, '.kbw-modal');
      contains(H.textOf(modal), '即将移动 2 篇笔记', '标题说清数量+动作');
      contains(H.textOf(modal), '位置锁定', '位置锁定的提示在');
      contains(H.textOf(modal), '会自动快照', '快照承诺在');
      const primary = H.qa(modal, '.kbw-btn.is-primary')[0];
      eq(H.textOf(primary), '移动 2 篇', '主按钮重复数量');
      H.click(primary);
      const r = await p;
      eq(r.action, 'primary', '返回值');
    });

    await suite.it('次按钮 → secondary + value', async () => {
      const p = confirm({
        title: '即将移动 1 篇',
        preview: [],
        warnings: [],
        notes: [],
        primary: { label: '移动 1 篇' },
        secondary: [{ label: '只看不动', value: 'readonly' }],
      });
      await H.tick();
      const modal = H.q(document.body, '.kbw-modal');
      const sec = H.qa(modal, '.kbw-btn').find((b) => H.textOf(b) === '只看不动');
      ok(sec, '找到次按钮');
      H.click(sec as Element);
      const r = await p;
      eq(r.action, 'secondary', '动作');
      eq(r.action === 'secondary' ? r.value : '', 'readonly', '返回值带上 value');
    });

    await suite.it('取消 / Esc → cancel（取消也走返回值，不靠异常）', async () => {
      const p1 = confirm({ title: '测取消', preview: [], warnings: [], notes: [], primary: { label: '执行' } });
      await H.tick();
      H.click(H.qa(document.body, '.kbw-modal-foot .kbw-btn')[0]);
      eq((await p1).action, 'cancel', '点取消');

      const p2 = confirm({ title: '测 Esc', preview: [], warnings: [], notes: [], primary: { label: '执行' } });
      await H.tick();
      H.keydown(document.body, 'Escape');
      eq((await p2).action, 'cancel', '按 Esc');
      await H.tick();
      eq(H.maybe(document.body, '.kbw-modal'), null, '模态收掉了');
    });

    await suite.it('危险态两下确认：第一下只上膛，第二下才执行', async () => {
      let resolved = false;
      const p = confirm({
        title: '即将删除 1 篇笔记',
        preview: [{ kind: 'delete', where: '00_Inbox/未命名.md', count: 1 }],
        warnings: [],
        notes: [],
        danger: { confirmLabel: '再点一次确认', irreversible: true },
        primary: { label: '删除 1 篇' },
      });
      void p.then(() => {
        resolved = true;
      });
      await H.tick();
      const modal = H.q(document.body, '.kbw-modal');
      contains(H.textOf(modal), '只能靠快照还原', '不可逆的说明在');
      const btn = H.q(modal, '.kbw-modal-foot .kbw-btn.is-danger');
      H.click(btn);
      await H.tick();
      eq(resolved, false, '第一下不该执行');
      contains(H.textOf(btn), '再点一次确认', '按钮文案变了');
      H.click(btn);
      const r = await p;
      eq(r.action, 'primary', '第二下才执行');
    });

    await suite.it('danger.disableReason → 主按钮置灰并显示原因', async () => {
      const p = confirm({
        title: '即将删除板块',
        preview: [],
        warnings: [],
        notes: [],
        danger: { confirmLabel: '再点一次确认', disableReason: '默认视图不能删' },
        primary: { label: '删除' },
      });
      await H.tick();
      const btn = H.q(document.body, '.kbw-modal-foot .kbw-btn.is-danger');
      contains(H.textOf(btn), '默认视图不能删', '原因写在按钮上');
      ok(btn.hasAttribute('disabled'), '被禁用');
      H.keydown(document.body, 'Escape');
      await p;
    });
  });

  await suite.group('Esc 分层', async () => {
    await suite.it('菜单 + 模态同时在 → Esc 先收后开的那一层', async () => {
      __clearEscapeLayers();
      const h = showMenu({ x: 5, y: 5 }, specNote());
      await H.tick();
      const p = confirm({ title: '叠一层模态', preview: [], warnings: [], notes: [], primary: { label: '执行' } });
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 1, '菜单在');
      eq(H.qa(document.body, '.kbw-modal').length, 1, '模态在');
      eq(escapeDepth(), 2, '两层');

      H.keydown(document.body, 'Escape');
      await H.tick();
      eq(H.maybe(document.body, '.kbw-modal'), null, '先收模态');
      eq(H.qa(document.body, '.kbw-menu').length, 1, '菜单还在');
      eq((await p).action, 'cancel', '模态返回 cancel');
      H.keydown(document.body, 'Escape');
      await H.tick();
      eq(H.qa(document.body, '.kbw-menu').length, 0, '再收菜单');
      h.close();
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.14 · 属性子菜单的「（清空）」（真机反馈："添加笔记属性后，无法手动删除"）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.14 · 属性菜单「（清空）」= 删键', async () => {
    await suite.it('枚举有值 → 多一项「（清空）」，run 送 null（fm 口径 = delete 键）；空值不画', () => {
      const applied: unknown[] = [];
      const items = valueItems('类型', '笔记', (v) => applied.push(v));
      ok(
        items.some((i) => 'label' in i && i.label === '笔记'),
        '前提：值域项还在',
      );
      const clear = items.find((i) => 'label' in i && i.label === '（清空）');
      ok(clear, '「（清空）」项在');
      (clear as { run?: (c: { value: unknown }) => void }).run?.({ value: true });
      eq(applied[0], null, 'run 送的是 null（frontmatter.setMany 里 null = delete 键）');

      const none = valueItems('类型', '', () => {});
      ok(!none.some((i) => 'label' in i && i.label === '（清空）'), '当前为空时不画「（清空）」');
    });

    await suite.it('自由值输入框：空白 → null（删键）；有值 → trim 后原样送', () => {
      const applied: unknown[] = [];
      const items = valueItems('来源', 'https://a', (v) => applied.push(v));
      const it = items[0] as { run?: (c: { value: unknown }) => void };
      it.run?.({ value: '   ' });
      eq(applied[0], null, '空白输入 → null');
      it.run?.({ value: ' https://b ' });
      eq(applied[1], 'https://b', '有值 → trim 后送');
    });
  });
}
