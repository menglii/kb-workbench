/**
 * spec：通知与反馈（§1.3 的五场合 × 时长 × 落点）+ 键位解析
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  NOTIFY_MS,
  __resetNotices,
  notify,
  notifyError,
  notifyLight,
  notifyPartial,
} from '../../src/ui/notify';
import { KEY_ACTIONS, KEY_ACTION_BY_ID, Keymap, normalizeKey, prettyKey } from '../../src/core/keymap';

export async function specNotify(
  suite: Suite,
  _app: StubApp,
  plugin: KbWorkbenchPlugin,
  _vaultRoot: string,
): Promise<void> {
  await suite.group('通知', async () => {
    await suite.it('落点在**顶部**，并且挂在 document.body 上（工作台没开着也能弹）', async () => {
      __resetNotices();
      notifyLight('改好了');
      const box = H.q(document.body, '.kbw-notices');
      eq(box.parentElement, document.body, '挂在 body 上');
      eq(box.closest('.kbw-root'), null, '不在工作台里面');
      // 位置由样式表决定（jsdom 不做媒体查询，所以查样式源而不是 computed style）
      const css = H.readNote(H.repoRoot(), 'styles.css');
      ok(/\.kbw-notices\s*\{[^}]*position:\s*fixed/.test(css), '样式表里 .kbw-notices 必须是 fixed');
      ok(/\.kbw-notices\s*\{[^}]*top:\s*var\(--sp-3\)/.test(css), '并且贴顶（落点=顶部）');
      // 落点由 JS 按视图头下沿算出来（固定 top 会压住标签与视图标题）
      ok(/^\d+px$/.test(box.style.top), `通知栈应算出内联 top，实际 "${box.style.top}"`);
      // 任何时候只能有一个容器（重载后旧容器会变孤儿，真机踩过）
      const stale = document.createElement('div');
      stale.className = 'kbw-notices';
      document.body.appendChild(stale);
      __resetNotices();
      notifyLight('再来一条');
      eq(H.qa(document.body, '.kbw-notices').length, 1, '容器必须唯一（旧的该被清掉）');
      __resetNotices();
    });

    await suite.it('四类时长按交互规格 §1.3：轻量 2s / 动库 3s / 部分与失败 6s', async () => {
      eq(NOTIFY_MS.light, 2000, '轻量成功');
      eq(NOTIFY_MS.library, 3000, '动库成功');
      eq(NOTIFY_MS.long, 6000, '部分成功 / 失败');
      __resetNotices();
      notifyLight('a');
      eq(H.textOf(H.q(document.body, '.kbw-notice')).includes('a'), true, '渲染了');
      notify({ kind: 'success', text: 'b', ms: NOTIFY_MS.library });
      notifyPartial('c', '跳过 2 篇');
      notifyError('d', '失败在哪个文件');
      const all = H.qa(document.body, '.kbw-notice');
      eq(all.length, 4, '四条都在');
      ok(all[2].classList.contains('is-partial'), '第三条是部分成功样式');
      ok(all[3].classList.contains('is-error'), '第四条是失败样式');
      contains(H.textOf(all[2]), '跳过 2 篇', '部分成功的 detail 写出来了');
      __resetNotices();
    });

    await suite.it('动作按钮：点一下执行回调并收掉通知', async () => {
      __resetNotices();
      let ran = '';
      notify({
        kind: 'success',
        text: '已移动 3 篇笔记',
        ms: NOTIFY_MS.library,
        actions: [{ label: '查看报告', run: () => void (ran = 'view') }],
      });
      const btn = H.qa(document.body, '.kbw-notice-actions .kbw-btn')[0];
      contains(H.textOf(btn), '查看报告', '按钮文案');
      H.click(btn);
      eq(ran, 'view', '回调跑了');
      await H.tick();
      await H.tick(400);
      __resetNotices();
    });

    await suite.it('同类同文案不重复堆叠；最多同时 3 条', async () => {
      __resetNotices();
      notifyLight('同一句话');
      notifyLight('同一句话');
      eq(H.qa(document.body, '.kbw-notice').length, 1, '重复的不再堆一条');
      for (let i = 0; i < 5; i += 1) notifyLight(`第 ${i} 条`);
      // 退场中的不计入上限（否则数 children 会把正在淡出的一起算上）
      eq(H.qa(document.body, '.kbw-notice:not(.is-leaving)').length, 3, '最多 3 条');
      __resetNotices();
    });
  });

  await suite.group('键位', async () => {
    await suite.it('规范化：字符键用字符本身，命名键带修饰键', () => {
      const ev = (key: string, mods: KeyboardEventInit = {}): KeyboardEvent =>
        new KeyboardEvent('keydown', { key, ...mods });
      eq(normalizeKey(ev('/')), '/', '斜杠');
      eq(normalizeKey(ev('?', { shiftKey: true })), '?', '问号就是问号，不是 shift+/');
      eq(normalizeKey(ev('ArrowUp')), 'arrowup', '命名键小写');
      eq(normalizeKey(ev('ArrowUp', { shiftKey: true })), 'shift+arrowup', '带 shift');
      eq(normalizeKey(ev(' ')  ), 'space', '空格');
      eq(normalizeKey(ev('Escape')), 'escape', 'Esc');
      eq(normalizeKey(ev('A', { shiftKey: true })), 'shift+a', '大写字母带 shift');
      eq(normalizeKey(ev('A', { ctrlKey: true })), 'mod+a', 'Ctrl/Cmd 统一叫 mod');
    });

    await suite.it('14 个动作，默认键位不与 Obsidian 本体冲突', () => {
      eq(KEY_ACTIONS.length, 14, '动作数');
      const all = KEY_ACTIONS.flatMap((a) => a.defaults);
      ok(!all.includes('mod+s'), '不该占 Ctrl+S（本体的保存）');
      ok(!all.includes('mod+p'), '不该占 Ctrl+P（本体的命令面板）');
      ok(!all.includes('mod+o'), '不该占 Ctrl+O（本体的快速切换）');
      /**
       * 第 14 个动作 = 快速切换（e2 期 §4.1）。默认键的**依据是真机枚举**
       *（2026-09-26 把本体全部默认键拉出来比对过），这里钉住结论；
       * 那条"一个都不撞"的断言在真机探针里（它能现读 `app.hotkeyManager`）。
       */
      const qs = KEY_ACTION_BY_ID['quick-switch'];
      ok(qs, '表里有快速切换这个动作');
      eq(qs.defaults.join(','), 'mod+shift+o', '默认键是 Mod+Shift+O');
      ok(!all.includes('mod+shift+o') || qs.defaults.length === 1, '它自己占着这一个键');
      const km = new Keymap(() => ({}));
      eq(km.ownerOf('mod+shift+o', 'quick-switch'), null, '这个键没有被别的动作占用');
    });

    await suite.it('改过的键位覆盖默认值；能查出冲突', () => {
      const overrides: Record<string, string[]> = {};
      const km = new Keymap(() => overrides);
      eq(km.keysFor('focus-search').join(','), '/', '默认值');
      overrides['focus-search'] = ['mod+k'];
      eq(km.keysFor('focus-search').join(','), 'mod+k', '覆盖之后');
      eq(km.ownerOf('mod+a'), 'select-all', 'Ctrl+A 是"全选筛选结果"');
      eq(km.ownerOf('mod+k', 'focus-search'), null, '排除自己之后不冲突');
    });

    await suite.it('处理器绑定与解绑；输入框里打字不抢快捷键', () => {
      const km = plugin.context().keymap;
      let hits = 0;
      const off = km.bind('move-down', () => {
        hits += 1;
        return true;
      });
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'ArrowDown');
      eq(hits, 1, '按一次算一次');

      const input = document.createElement('input');
      root.appendChild(input);
      input.focus();
      H.keydown(input, 'ArrowDown');
      eq(hits, 1, '在输入框里不该被抢');

      off();
      H.keydown(root, 'ArrowDown');
      eq(hits, 1, '解绑之后不再响应');
      input.remove();
    });

    await suite.it('键位表文案好看（prettyKey）', () => {
      eq(prettyKey('mod+a'), 'Ctrl/⌘+A', 'Ctrl/Cmd');
      eq(prettyKey('escape'), 'Esc', 'Esc');
      eq(prettyKey('shift+arrowup'), 'Shift+Arrowup', '组合键');
      eq(prettyKey('?'), '?', '字符原样');
    });
  });
}
