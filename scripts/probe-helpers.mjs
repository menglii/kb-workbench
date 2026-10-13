// 真机探针的页面小工具（`HELPERS`）—— **单独一个模块**，好让 `peek.mjs` 也能拿到同一份，
// 而不必 `import probe.mjs`（那会**顺手把整套步骤跑一遍**）。
//
// ⚠️ 它是 `String.raw` 模板：注释里**不许出现反引号**（会提前结束模板）。
//    这类错 `node --check` 多数情况下能抓；另外红线里有一条静态断言专门扫步骤模板（这里靠解析守卫）。
export const HELPERS = String.raw`
window.__kbwProbe = {
  /**
   * 等一会儿。**每拍校验 run token**（P7.20-8）。
   *
   * 为什么要它：探针被中断（Ctrl-C / 掐后台任务 / 用户关窗口）之后，**页面里半路注入的异步步
   * 还在跑** —— 下一轮起手就与它抢页面（P7.18b 记的"三连坑"：不清页面直接重跑 = 从头红到尾）。
   * 纪律（"中断后先手工清页面"）靠不住，这里做成**机器解**：
   *   · runner 起手把 window.__kbwProbeRun 换成新 token → 上一轮残留的 wait 发现"我的 token 过时了"
   *     → 立刻 reject 停下（它的 runner 早退了，没人看这条失败）；
   *   · runner 收到 SIGINT 也换 token → 本轮在跑的 wait 立刻停，干净退出。
   *
   * ⚠️ **token 缺省时行为与从前完全一样**（两边都是 undefined → 不 stale）——
   *    手动跑 / 老 runner / peek.mjs 都不受影响。
   * ⚠️ 分段等待（50ms 一拍）会让出更多次事件循环，这**更像真机**（原本那一段里别的 timer 也照跑）。
   * ⚠️ 这段在 String.raw 模板里：注释里**不许出现反引号**（会提前结束模板）。
   */
  wait: (ms) => new Promise((resolve, reject) => {
    const tok = window.__kbwProbeRun;
    if (!(ms > 0)) { resolve(); return; }
    const t0 = Date.now();
    const tick = () => {
      if (window.__kbwProbeRun !== tok) {
        const e = new Error('__kbwProbeStale');
        e.kbwStale = true;
        reject(e);
        return;
      }
      if (Date.now() - t0 >= ms) { resolve(); return; }
      setTimeout(tick, Math.min(50, ms));
    };
    tick();
  }),
  q: (s) => document.querySelector(s),
  /**
   * 取**最后一个**模态。多个模态可以叠（设置面板 + 它上面弹的确认流 / 问一句）——
   * 用 q('.kbw-modal') 拿的是**最先**那个，于是"确认流断言抓到了面板自己"（P2 就踩过一次）。
   * ⚠️ 这段在 String.raw 模板里：注释里**不许出现反引号**（会提前结束模板 → 语法错）。
   */
  /** 取**最后一个**浮层面板（.kbw-panel）—— 与 lastModal 同一条理由 */
  lastPanel: () => {
    const all = Array.from(document.querySelectorAll('.kbw-panel'));
    return all.length > 0 ? all[all.length - 1] : null;
  },
  lastModal: () => {
    const all = Array.from(document.querySelectorAll('.kbw-modal'));
    return all.length > 0 ? all[all.length - 1] : null;
  },
  qa: (s, root) => Array.from((root ?? document).querySelectorAll(s)),
  text: (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  btnByText: (needle, root) => Array.from((root ?? document).querySelectorAll('button, .kbw-btn')).find((b) => (b.textContent ?? '').includes(needle)),
  click: (el) => {
    // 走完整鼠标序列：真实点击会先 mousedown（焦点交接挂在那儿）
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  },
  clickByText: (needle, root) => { const b = window.__kbwProbe.btnByText(needle, root); if (!b) return false; window.__kbwProbe.click(b); return true; },
  /**
   * 工具条上那个「板块管理」按钮。⚠️ 用**全等**认它，不能用 includes ——
   * 它旁边的「＋ 添加板块」也含"板块"两个字，谁在前面纯看 DOM 顺序。
   * 图标是 lucide settings 的 SVG：早先写的是 emoji 字形「⚙」，那种字形的长相由**字体**决定
   * （用户 2026-09-25 第二波反馈："时不时变成灰色上色的版本"）——
   * 所以认它要认**节点**，别认表情符号。
   */
  sectMgr: () => window.__kbwProbe.qa('.kbw-board-toolbar .kbw-btn').find((b) => window.__kbwProbe.text(b) === '板块'),
  /**
   * 点**菜单项**。⚠️ 菜单项是 div.kbw-menu-item，不是 button —— 用 clickByText 点菜单
   * 会静默点空（P4 探针第一轮：卡片显示的切换、重载都没生效，报的却是别处的症状）。
   * 子菜单里也找（.kbw-menu.is-sub 是飞出去的那一层）。
   */
  clickMenu: (needle, root) => {
    const items = Array.from((root ?? document).querySelectorAll('.kbw-menu-item'));
    const hit = items.find((i) => (i.textContent ?? '').includes(needle) && i.getAttribute('aria-disabled') !== 'true');
    if (!hit) return false;
    window.__kbwProbe.click(hit);
    return true;
  },
  /** 取最后一条菜单（子菜单会叠在上面；q('.kbw-menu') 拿的是最先那个） */
  lastMenu: () => {
    const all = Array.from(document.querySelectorAll('.kbw-menu'));
    return all.length > 0 ? all[all.length - 1] : null;
  },
  /**
   * 走**「更多显示 ›」里的那一项**（f 期起「重载」收进了这个子菜单：
   * 看板全局菜单一级原来 9 项、硬规矩写的是 8）。
   *
   * ⚠️ 两步都要判：第一步没点开（菜单没弹/项被置灰）时**第二步会静默点空** ——
   * 而那正是最坑的症状（菜单留在屏幕上挡着后面的步骤，真正报错的是"拖不动"）。
   * 所以返回值是「a && b」，调用点可以据此早退（别只看第二步）。
   */
  clickMore: async (label) => {
    const P = window.__kbwProbe;
    const menus = () => document.querySelectorAll('.kbw-menu').length;
    /**
     * 🔴 找**真正装着这一项**的那一层菜单，别用 lastMenu()。
     *
     * 真机实测（2026-09-26，f 期）：点开「更多显示」之后屏幕上可能有**三**层菜单
     * （曾经展开过的兄弟子菜单**留在 DOM 里**），lastMenu() 拿到的是**别的**那一层 ——
     * 于是第二下静默点空、菜单留在屏幕上挡着后面所有步骤
     *（症状：跨板块拖动那几步报"两个点打不到实体"，压在上面的是 kbw-menu-item）。
     * 从后往前找"含这一项的那一层"才稳（越晚出现的越可能是刚展开的那层）。
     */
    const menuWith = (txt) => {
      const all = Array.from(document.querySelectorAll('.kbw-menu'));
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const hit = Array.from(all[i].querySelectorAll('.kbw-menu-item')).some(
          (x) => (x.textContent ?? '').includes(txt) && x.getAttribute('aria-disabled') !== 'true',
        );
        if (hit) return all[i];
      }
      return null;
    };
    let a = false;
    let b = false;
    for (let i = 0; i < 3; i += 1) {
      a = P.clickMenu('更多显示');
      await P.wait(280);
      const box = menuWith(label);
      b = box ? P.clickMenu(label, box) : false;
      await P.wait(260);
      if (b && menus() === 0) return true;
    }
    console.error('[探针] 更多显示 › ' + label + ' 没点成（a=' + a + ' b=' + b + ' 剩菜单=' + menus() + '）');
    // 收尾：把没关掉的菜单按掉，别让它挡住后面的步骤（判据仍然算失败）
    if (menus() > 0) {
      P.key('Escape');
      await P.wait(200);
    }
    return false;
  },
  /**
   * 点**任意一层**菜单里的某一项：从**最后**一层往前找「装着这一项的那一层」再点。
   *
   * 🔴 为什么不直接用 lastMenu()：菜单是**叠着**的，而且曾经展开过的兄弟子菜单会**留在 DOM 里** ——
   * lastMenu() 经常拿到**别的**那一层，于是静默点空（f 期真机实测：一次操作里屏幕上三层菜单，
   * 点「只排序（不动库）」的那两下全空，报出来的却是"顺序表里没有"）。
   */
  clickAny: (label) => {
    const P = window.__kbwProbe;
    const all = Array.from(document.querySelectorAll('.kbw-menu'));
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (P.clickMenu(label, all[i])) return true;
    }
    return false;
  },
  /** 在某个坐标上发一次真右键（用 elementFromPoint 找目标） */
  rightClickAt: (x, y) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    return target.className;
  },
  /** 按键：投递给**当前焦点元素**（真实键盘就是这样），让事件沿 DOM 冒泡上去 */
  key: (k, opts = {}) => {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
    return target.className || target.tagName;
  },
  /** 解析成 [r,g,b]（只吃 rgb() 形态，其它返回 null） */
  rgb: (color) => {
    const m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((s) => parseFloat(s));
    return p.length >= 3 ? [p[0], p[1], p[2]] : null;
  },
  /** WCAG 相对亮度 */
  lum: (rgb) => {
    const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  },
  /** WCAG 对比度，1..21 */
  contrast: (fg, bg) => {
    const a = window.__kbwProbe.lum(window.__kbwProbe.rgb(fg));
    const b = window.__kbwProbe.lum(window.__kbwProbe.rgb(bg));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  },
  /** 颜色的 alpha：'rgba(0,0,0,0)' → 0；不透明色 → 1 */
  alpha: (color) => {
    if (!color || color === 'transparent') return 0;
    const s = String(color);
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const body = m[1];
    // 现代语法 rgb(1 2 3 / .5) 与老语法 rgba(1,2,3,.5) 都要认
    const slash = body.split('/');
    if (slash.length === 2) return parseFloat(slash[1]);
    const parts = body.split(',').map((x) => parseFloat(x));
    return parts.length === 4 ? parts[3] : 1;
  },
  /**
   * 元素**实际**的背景色：沿祖先链找第一个不透明的。
   * ⚠️ 为什么不直接用 getComputedStyle(el).backgroundColor：面板里很多容器是**透明**的，
   * 而 rgb() 解析会把 rgba(0,0,0,0) 当黑色 → 浅色主题下对比度算成 1.3 那种假红
   * （这段在 String.raw 里，注释里一律用「」不用反引号）
   * （P4 收尾全量探针实测：同一条在深色主题下 15.91，浅色下 1.32 —— 量的对象不对）。
   */
  bgOf: (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (window.__kbwProbe.alpha(bg) > 0.5) return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  },
  styleOf: (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, shadow: cs.boxShadow, backdrop: cs.backdropFilter, color: cs.color, radius: cs.borderRadius };
  },
  /** 指针序列 helper：down → move×N → up（真机有命中测试，每一步都打到指针下面的元素） */
  mkPointer: (type, x, y, pointerType) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, pointerId: 1, pointerType: pointerType ?? 'mouse', isPrimary: true,
    button: type === 'pointerup' || type === 'pointercancel' ? -1 : 0,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
  }),
  elAt: (x, y) => document.elementFromPoint(x, y) ?? document.body,
  /** 按下（不松手）—— 后面自己决定是拖还是长按 */
  pointerDownAt: (x, y, pointerType) => {
    const el = window.__kbwProbe.elAt(x, y);
    el.dispatchEvent(window.__kbwProbe.mkPointer('pointerdown', x, y, pointerType));
    return el.className;
  },
  pointerMoveTo: (x, y, pointerType) => {
    const el = window.__kbwProbe.elAt(x, y);
    el.dispatchEvent(window.__kbwProbe.mkPointer('pointermove', x, y, pointerType));
    return el.className;
  },
  pointerUpAt: (x, y, pointerType) => {
    const el = window.__kbwProbe.elAt(x, y);
    el.dispatchEvent(window.__kbwProbe.mkPointer('pointerup', x, y, pointerType));
    return el.className;
  },
  pointerCancelAt: (x, y, pointerType) => {
    const el = window.__kbwProbe.elAt(x, y);
    el.dispatchEvent(window.__kbwProbe.mkPointer('pointercancel', x, y, pointerType));
    return el.className;
  },
  /** 一条完整的鼠标拖拽：down → move×steps → up，返回每一步的落点类名 */
  dragMouse: async (from, to, steps = 6) => {
    const P = window.__kbwProbe;
    const trail = [P.pointerDownAt(from.x, from.y)];
    await P.wait(30);
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      trail.push(P.pointerMoveTo(x, y));
      await P.wait(25);
    }
    trail.push(P.pointerUpAt(to.x, to.y));
    return trail;
  },
  /** 触屏长按拖动：按住 450ms（不动）→ 拖 → 松手 */
  dragTouch: async (from, to, steps = 4) => {
    const P = window.__kbwProbe;
    P.pointerDownAt(from.x, from.y, 'touch');
    await P.wait(450);
    const held = !!document.querySelector('.kbw-dragghost');
    const trail = [];
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      trail.push(P.pointerMoveTo(x, y, 'touch'));
      await P.wait(25);
    }
    P.pointerUpAt(to.x, to.y, 'touch');
    return { held, trail };
  },
  /**
   * 抓取点（给拖拽 / 右键用）。
   * ⚠️ **不能取几何中心**：表格行可能是 3000px 宽（列多了要横向滚动），
   * 中心点在视口外 → elementFromPoint 返回 null → 拖拽与右键全失效
   * （真机实测："右键没弹出菜单"就是这个）。取左侧可见区域的中点，并夹到视口内。
   */
  center: (el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const grabW = Math.min(r.width, 160);
    const x = Math.round(Math.max(8, Math.min(vw - 8, r.left + grabW / 2)));
    const y = Math.round(Math.max(8, Math.min(vh - 8, r.top + r.height / 2)));
    return { x, y };
  },
  rowByPath: (path) => document.querySelector('.kbw-trow[data-path="' + path + '"]'),
  /**
   * 把「全部笔记」这一屏的**视野**摆成确定的：全库 + 无搜索 + 无筛选 + 网格档。
   *
   * 为什么要它（P6 全量跑时踩到的）：这些东西都是**会话态 / 落盘的**，前面的步骤会把它们
   * 留在半路 —— 目录树选择落盘、搜索框有词、filters.paths 被快速切换设过
   *（而且切模块回来还会被「待消费的意图」重新应用一次）。症状是列表只剩**一篇**，
   * 于是"网格只有一格/一行"，框选与换位两条判据连前提都不成立，
   * 而报出来的却是"窗口太窄？" —— 真正的起因在十几步之前。
   */
  /**
   * **造一篇"注定要被搬"的笔记**（P5 重排预览/执行那三步的夹具）。
   *
   * 为什么需要：重排的计划 = "实际目录 vs 规则算出来的目录"**不一致的那些** ——
   * 实验库被前几轮探针整理过之后，**计划是空的**（实测：徽标全是 0、执行按钮根本不画），
   * 那三步就整片假红（红的原因是"没东西可做"，不是功能坏了）。
   * 这一篇故意放在 00_Inbox 而类型是**内容作品** → 规则要它去 02_Areas/内容创作 ✓。
   */
  seedMisplacedNote: async () => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const NL = String.fromCharCode(10);
    const rel = kb + '/00_Inbox/__探针重排.md';
    const old = app.vault.getAbstractFileByPath(rel);
    if (old) await app.vault.delete(old, true);
    await app.vault.create(rel, ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中',
      '创建日期: 2026-09-27', 'tags: []', '---', '# 探针重排'].join(NL) + NL);
    await P.wait(1200);
    return '__探针重排';
  },
  /** 删掉那篇（**它可能已经被搬走** → 两个可能的位置都找） */
  dropMisplacedNote: async () => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const dirs = ['00_Inbox', '02_Areas/内容创作', '02_Areas', ''];
    for (const d of dirs) {
      const rel = kb + '/' + (d ? d + '/' : '') + '__探针重排.md';
      const f = app.vault.getAbstractFileByPath(rel);
      if (f) await app.vault.delete(f, true);
    }
    await P.wait(900);
  },
  /**
   * **给属性迁移造一篇旧规范的笔记**（P6 段⑥ 顺手项；照 P6③ 的"播种"做法）。
   *
   * 为什么需要：实验库早就迁完了 —— 面板自己报「0 处改动」→ 点「执行」当然不弹确认流，
   * 那一步整片红（而红的原因是"没东西可做"，不是功能坏了）。库里没有旧数据时，
   * 唯一能验"执行"的办法就是**造一篇旧规范的**出来。
   *
   * 三条都取的是 services/migrate.ts 里真有的规则（改完必产生改动）：
   *  · 类型「学习笔记」→ 收拢进「资料」
   *  · 中文键 标签 → 并进 tags
   *  · 旧键「主题」→ 删（它是标题的副本）
   */
  seedLegacyNote: async () => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const NL = String.fromCharCode(10);
    const rel = kb + '/00_Inbox/__探针旧规范.md';
    const old = app.vault.getAbstractFileByPath(rel);
    if (old) await app.vault.delete(old, true);
    await app.vault.create(rel, ['---', '类型: 学习笔记', '主题: __探针旧规范',
      '标签: [探针迁移]', '创建日期: 2026-09-28', '状态: 已完成', '---',
      '# 探针旧规范', '', '正文'].join(NL) + NL);
    await P.wait(1500);
    return '__探针旧规范';
  },
  /** 删掉那一篇（迁移可能已经改过它的前言，按路径删就行） */
  dropLegacyNote: async () => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const f = app.vault.getAbstractFileByPath(kb + '/00_Inbox/__探针旧规范.md');
    if (f) await app.vault.delete(f, true);
    await P.wait(900);
  },
  /**
   * 给「经纬AI › 自动整理」造一篇**声明与实际不符**的笔记（P6 段⑥ ⑥ 起用；R8 改挂新菜单）。
   *
   * 为什么单造一篇、不复用 seedMisplacedNote：那一篇是给**重排**用的（按「类型」推目录），
   * 而编辑器菜单那条路读的是**属性「文件位置」**（声明优先的判据）——
   * 两者不是一回事，混用会得到一个"文件没被搬"的假红。
   * 放 00_Inbox、声明 02_Areas/内容创作（那个目录在实验库里恒存在）。
   */
  seedMenuMisplaced: async () => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const NL = String.fromCharCode(10);
    const rel = kb + '/00_Inbox/__探针菜单归位.md';
    const old = app.vault.getAbstractFileByPath(rel);
    if (old) await app.vault.delete(old, true);
    await app.vault.create(rel, ['---', '文件位置: 02_Areas/内容创作', '创建日期: 2026-09-28',
      'tags: []', '---', '# 探针菜单归位'].join(NL) + NL);
    await P.wait(1200);
    return rel;
  },
  /** 删掉那一篇（**它可能已经被搬走** → 两个可能的位置都找） */
  dropMenuMisplaced: async () => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    for (const d of ['00_Inbox', '02_Areas/内容创作']) {
      const f = app.vault.getAbstractFileByPath(kb + '/' + d + '/__探针菜单归位.md');
      if (f) await app.vault.delete(f, true);
    }
    await P.wait(900);
  },
  /**
   * **造一个探针自己的目录**（__探针<tag>/：n 篇笔记 + 一个子目录「子」1 篇）。
   *
   * 为什么要它：P6b ② 起列表**只画本层**，而"本层有 4 篇 + 有子目录"这种形态
   * **不是每时每刻都成立**（前面几十步会搬文件/删目录）—— 靠实验库当时的形态去挑，
   * 就是在"依赖环境状态"（本轮实测：同一份脚本，前一轮挑得到、后一轮挑不到）。
   * 自造 + 自清（名字带 __探针 双下划线，符合本项目的临时文件约定）。
   */
  seedGridDir: async (tag, n) => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const dir = '__探针' + tag;
    const sub = dir + '/子';
    const body = function (name) {
      const NL = String.fromCharCode(10);
      return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-09-27',
        'tags: []', '---', '# ' + name].join(NL) + NL;
    };
    try { await app.vault.createFolder(kb + '/' + dir); } catch (e) { /* 已存在 */ }
    try { await app.vault.createFolder(kb + '/' + sub); } catch (e) { /* 已存在 */ }
    for (let i = 1; i <= n; i += 1) {
      const rel = kb + '/' + dir + '/笔记' + i + '.md';
      if (!app.vault.getAbstractFileByPath(rel)) await app.vault.create(rel, body('笔记' + i));
    }
    const subRel = kb + '/' + sub + '/子笔记.md';
    if (!app.vault.getAbstractFileByPath(subRel)) await app.vault.create(subRel, body('子笔记'));
    /**
     * ⚠️ **等索引真的看见它**（不是固定等 1 秒就往下走）：平台的 watcher → 缓存 →
     * 索引 → 区域重绘是一条链，真机上这块有时要 1.5–2 秒（实测：早一步取树节点会取空）。
     */
    for (let i = 0; i < 20; i += 1) {
      await P.wait(200);
      const seen = P.ctx().index.notes().filter(function (e) {
        return e.effectivePosition === dir || e.effectivePosition.indexOf(dir + '/') === 0;
      }).length;
      if (seen >= n + 1) break;
    }
    return dir;
  },
  /** 删掉 seedGridDir 造的那一整套（**早退之前也要调**）。上限 60 = 给"撑出滚余量"那种大种子留的 */
  dropGridDir: async (tag) => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const dir = kb + '/__探针' + tag;
    const sub = dir + '/子/子笔记.md';
    const f1 = app.vault.getAbstractFileByPath(sub);
    if (f1) await app.vault.delete(f1, true);
    for (let i = 1; i <= 60; i += 1) {
      const f = app.vault.getAbstractFileByPath(dir + '/笔记' + i + '.md');
      if (f) await app.vault.delete(f, true);
    }
    for (const p2 of [dir + '/子', dir]) {
      const f = app.vault.getAbstractFileByPath(p2);
      if (f) await app.vault.delete(f, true);
    }
    await P.wait(800);
  },
  /**
   * **往骨架里塞一条"库里还没有的目录"**（P5 重排预览 / 执行那两步的夹具）。
   *
   * 为什么要它：计划里的「新建 N 目录」= 骨架（库内 库结构.json 的 dirs）声明了、
   * 盘上还没有的目录。实验库被前几轮整理过之后**一个不缺**（实测 missingBefore=0、
   * 徽标「新建 0」）→ 重排预览那一步的"新建"子条件、执行那一步的"骨架补齐"
   * 整片假红，而红的原因是"没东西可做"，不是功能坏了（交接 §4.5 记的就是这条）。
   *
   * ⚠️ **只改配置里的那一条，不碰盘上的目录**：执行那一步由 mover 真建出来之后，
   * "还原时删掉新建的目录"那条判据才算真的验过 —— drop 顺手把目录删掉的话，
   * 它就成了恒真（那一整套判据的价值全在"删得掉吗"上）。
   */
  seedSkeletonDir: async () => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    const SEED = '02_Areas/__探针新骨架';
    const abs = ctx.settings.kbRoot() + '/' + SEED;
    /**
     * 先**把状态拨回基线**：上一轮要是死在"执行"与"还原"之间，盘上会留着那个空目录 ——
     * 它一在，"库里还没有这个目录"这条前提就不成立（判据又会变成"没东西可做"）。
     * 只删**空目录**（里面有东西就不是这套夹具造的了，交给兜底清场）。
     */
    const onDisk = app.vault.getAbstractFileByPath(abs);
    if (onDisk) {
      let empty = true;
      try { const l = await app.vault.adapter.list(abs); empty = (l.files || []).length === 0 && (l.folders || []).length === 0; } catch (e) { empty = false; }
      if (empty) { await app.vault.delete(onDisk, true); await P.wait(500); }
    }
    const cfg = await ctx.configs.read('rebuild');
    const dirs = Array.isArray(cfg.dirs) ? cfg.dirs.slice() : [];
    if (dirs.indexOf(SEED) < 0) {
      dirs.push(SEED);
      await ctx.configs.write('rebuild', Object.assign({}, cfg, { dirs: dirs }));
      await P.wait(700);
    }
    return SEED;
  },
  /** 把上面那一条从骨架里抹掉（**不碰盘上那个目录** —— 那是还原那一步的活） */
  dropSkeletonDir: async () => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    const cfg = await ctx.configs.read('rebuild');
    const all = Array.isArray(cfg.dirs) ? cfg.dirs : [];
    const kept = all.filter(function (d) { return d.indexOf('__探针') < 0; });
    if (kept.length !== all.length) {
      await ctx.configs.write('rebuild', Object.assign({}, cfg, { dirs: kept }));
      await P.wait(600);
    }
    return all.length - kept.length;
  },
  /**
   * **几何量到 0 时，一次把"为什么"问清**（这个项目里"0 宽/0 高"是最常见的谜面，
   * 而谜底每次都不同：窗口被最小化或遮住 / 工作台被切成后台标签 / 祖先 display:none）。
   * 返回一行诊断，**直接塞进判据的 info** —— 别只报一个「rect [0,0,0,0]」。
   * （注释里不许出现反引号：本段在 String.raw 模板里。）
   */
  zeroGeoWhy: (el) => {
    const P = window.__kbwProbe;
    const parts = [];
    parts.push('vis=' + document.visibilityState + ' focus=' + document.hasFocus() +
      ' 视口=' + window.innerWidth + 'x' + window.innerHeight);
    if (!el) return parts.join('｜') + '｜元素不存在';
    let node = el;
    let hidden = '';
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none') { hidden = 'display:none@' + (node.className || node.tagName); break; }
      node = node.parentElement;
    }
    parts.push('藏它的是=' + (hidden || '（没有 display:none —— 那就落在"窗口/标签不可见"那一档）'));
    const r = el.getBoundingClientRect();
    parts.push('rect=' + [r.left, r.top, r.width, r.height].map(function (n) { return Math.round(n); }).join(','));
    const wb = app.workspace.getLeavesOfType('kb-workbench-view');
    parts.push('工作台叶=' + wb.length + ' 活动叶=' + (app.workspace.activeLeaf ? app.workspace.activeLeaf.view.getViewType() : '?'));
    return parts.join('｜');
  },
  /**
   * **确保工作台这一页真的可见**（几何判据的前提）。返回 true = 这一次是它救回来的。
   *
   * 为什么需要（f 期记过、P6b 收尾又撞上）：工作台是**平台层的一个标签**，
   * 而 runner 的每步前置只做一次 revealLeaf —— 实测有步骤拿到「rect [0,0,0,0]」，
   * 报出来的是"第一张卡片不在视野里"（谜面看着像看板坏了，谜底是标签在后台）。
   * 判据量不到几何时**先救一次再判**，别把"环境态"当成"功能坏了"。
   */
  ensureWorkbench: async () => {
    const P = window.__kbwProbe;
    const root = P.q('.kbw-root');
    if (root) { const r = root.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return false; }
    const wb = app.workspace.getLeavesOfType('kb-workbench-view');
    if (wb.length === 0) return false;
    try { await app.workspace.revealLeaf(wb[0]); } catch (e) { return false; }
    await P.wait(700);
    const root2 = P.q('.kbw-root');
    return !!root2 && root2.getBoundingClientRect().width > 0;
  },
  /**
   * **切到某个视图档**（按按钮文字）。表格类步骤开头调它 —— 别指望上一轮的残留：
   * scopeAll() 会把档切到网格，而视图档是**落盘**的（P6② 起就有这条坑）。
   */
  useView: async (label) => {
    const P = window.__kbwProbe;
    const seg = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === label; });
    if (seg) { P.click(seg); await P.wait(700); }
    return !!seg;
  },
  /**
   * **库根之下的目录清单**（相对库根，含空串）—— 与产品侧 core/vault-index.ts 的
   * kbDirsOf() **同一口径**（排除库根之外、排除任何一段以点开头的）。
   * 探针在页面另一侧、import 不到那份代码 —— 口径若变（比如多一条排除规则），
   * 两边都要改；不一致的症状是这里说"目录不存在"、产品那边认得（或反过来）。
   */
  dirsUnder: (kbRoot) => {
    const root = String(kbRoot || '').replace(/^\/+|\/+$/g, '');
    const out = [''];
    const files = window.app.vault.getAllLoadedFiles();
    for (const f of files) {
      if (!f.children) continue;
      if (root !== '' && f.path.indexOf(root + '/') !== 0) continue;
      if (f.path.split('/').some(function (s) { return s.charAt(0) === '.'; })) continue;
      out.push(root === '' ? f.path : f.path.slice(root.length + 1));
    }
    return out;
  },
  /** 这个目录**盘上真有吗**（14.8a：传 dir 给 goNotes 之前先验；空串恒真） */
  dirExists: (dir) => {
    const P = window.__kbwProbe;
    const d = String(dir ?? '').replace(/^\/+|\/+$/g, '');
    if (d === '') return true;
    return P.dirsUnder(P.ctx()?.settings?.kbRoot?.() ?? '').indexOf(d) >= 0;
  },
  /**
   * **站进一个"本层有笔记"的顶层目录**（P6b ② 起列表只画本层：库根那一层常常一篇都没有）。
   * 表格类步骤在 scopeAll() **之后**调它，再配 useView('详细信息') 就有行可量了。
   *
   * 🔴 **挑完之后还要验"盘上真有这个目录"**（P7.0b / 14.8a）：这里挑的依据是
   * **索引里的 effectivePosition**，而它可能是「文件位置」属性声明的落点 ——
   * 那个目录早就不在盘上了。传这种 dir 给 goNotes 会被产品侧的守卫判成坏目录
   *（console.warn + **丢掉 dir**）→ 列表停在原地 → 后面的判据集体假红，
   * 而报出来的会是一句"表格里没有行"（看着与目录毫无关系）。
   * 所以：挑**同时满足"索引里有笔记 + 盘上真有"**的那个；一个都没有就返回 ''，
   * **调用方要 note() 出来**（返回空串 = 这一步的视野没摆好，不是"不用管"）。
   */
  enterDirWithNotes: async (min) => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    const byDir = {};
    ctx.index.notes().forEach(function (e) {
      const d = e.effectivePosition;
      if (!d || d.indexOf('/') >= 0) return;
      byDir[d] = (byDir[d] || 0) + 1;
    });
    /** 优先挑"本层篇数 >= min"的（没有就退而求其次取最多的那个） */
    const sorted = Object.keys(byDir).sort(function (a, b) { return byDir[b] - byDir[a]; });
    const top = sorted.find(function (d) {
      return byDir[d] >= (min || 1) && P.dirExists(d);
    });
    if (!top) return '';
    let node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === top; });
    if (node) {
      P.click(node);
      await P.wait(900);
    } else {
      ctx.goNotes({ dir: top });
      await P.wait(900);
    }
    return top;
  },
  scopeAll: async () => {
    const P = window.__kbwProbe;
    const search = P.q('.kbw-search');
    if (search && search.value) {
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await P.wait(400);
    }
    const fb = P.qa('.kbw-notes-tools .kbw-btn').find(function (b) { return P.text(b).indexOf('筛选') >= 0; });
    if (fb && /筛选\s*\d/.test(P.text(fb))) {
      P.click(fb);
      await P.wait(400);
      const clearF = P.qa('.kbw-panel button, .kbw-modal button').find(function (b) { return P.text(b).indexOf('清除全部筛选') >= 0; });
      if (clearF) { P.click(clearF); await P.wait(300); }
      P.key('Escape');
      await P.wait(300);
    }
    // 目录树点「整个知识库」（root 的 data-dir 是空串）
    const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir ?? '') === ''; });
    if (rootNode) { P.click(rootNode); await P.wait(600); }
    // 网格档
    const seg = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '网格'; });
    if (seg) { P.click(seg); await P.wait(500); }
    return P.qa('.kbw-gcell').length;
  },
  /**
   * 把元素滚进视野再取一个可用点，并**回报它到底可不可见**。
   * ⚠️ 与 center() 的区别：center() 每次都 scrollIntoView —— 于是"先取目标点、再取源点"
   * 会把**源点**的坐标做废（第二次滚动把源滚出了视野，第一段坐标却已经算好了）。
   * 拖动这种"要两个点同时在视野里"的场景必须用这个：先 aim 目标，再 aim 源，各自回报 visible。
   */
  /** 取点但**不滚动**（rect 原样）——配合 aimAt 用：最后一次滚动之后才用它取两点 */
  rectAt: (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const w = Math.min(r.width, 140);
    const x = Math.round(Math.max(8, Math.min(vw - 8, r.left + (w > 0 ? w / 2 : 40))));
    const y = Math.round(Math.max(8, Math.min(vh - 8, r.top + (r.height > 0 ? r.height / 2 : 12))));
    const visible = r.top >= 0 && r.bottom <= vh && r.height > 0;
    return { x, y, visible, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  },
  aimAt: (el) => {
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const w = Math.min(r.width, 140);
    const x = Math.round(Math.max(8, Math.min(vw - 8, r.left + (w > 0 ? w / 2 : 40))));
    const y = Math.round(Math.max(8, Math.min(vh - 8, r.top + (r.height > 0 ? r.height / 2 : 12))));
    const visible = r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw && r.height > 0;
    return { x, y, visible, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  },
  /**
   * 自清理（**只删我认得的，绝不用"与开工前 diff"**）：
   *   · 快照：UI 动库之后立刻 snapTop() 取那一份的 id —— 只删它
   *     （diff 语义等于"凡是我没见过的都归我删"，用户在窗口期自己造的存档会被误删）
   *   · 日志：只删**正文里含探针标记**的（探针造的临时文件都叫 __探针*，
   *     日志的明细/移动表里会带上它们的路径）
   */
  snapTop: async () => {
    const list = await window.__kbwProbe.ctx().snapshot.list(); // 最新在前
    return list.length > 0 ? list[0].id : null;
  },
  /** 删掉这些快照 id（只删点名的）+ 含探针标记的日志 */
  sweep: async (snapIds, marker) => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    const tag = marker ?? '__探针';
    let snaps = 0;
    for (const id of snapIds ?? []) {
      if (!id) continue;
      await ctx.snapshot.remove(id);
      snaps += 1;
    }
    let logs = 0;
    for (const f of await ctx.report.recent(200)) {
      try {
        const text = await app.vault.read(f);
        if (!text.includes(tag)) continue;
        await app.vault.delete(f, true);
        logs += 1;
      } catch (e) {
        /* 忽略 */
      }
    }
    return { snaps, logs };
  },
  /** 拿插件实例 */
  plugin: () => window.app?.plugins?.plugins?.['kb-workbench'],
  ctx: () => window.__kbwProbe.plugin()?.context?.(),
  vaultRoot: () => window.app?.vault?.adapter?.getBasePath?.() ?? window.app?.vault?.adapter?.basePath ?? '',
  /**
   * 把还开着的浮层全收掉（每步开始前调用）。
   *
   * 为什么必须有：模态/菜单挂在 body 上，**一步没关干净就会盖住后面所有步骤** ——
   * 症状是"某一步莫名其妙失败"，而真因是上一步的面板还开着
   * （P3 实测：设置面板没关，导致后面 P1 的拖拽步骤指针全打在面板上 → 拖不动）。
   * 这里反复按 Esc（走的是插件自己的分层栈），不够就再按几次；菜单一并收。
   */
  closeAll: (rounds = 4) => {
    const P = window.__kbwProbe;
    /**
     * 🔴 **先把首次使用向导按「完成」收掉，再按 Esc**（P6 段④）。
     *
     * 为什么顺序不能反：向导是**模态**，Esc 会让它走 「onClose「 → 「wizardDone: false「
     * → **下一次打开工作台又弹**（"稍后"的语义就是"下次还来"）。
     * 而按「完成」把它变成 「true「（"这台机器配过了"）—— 那正是这一轮跑完之后该有的稳态。
     * 这件事只在 「wizardDone「 不是 true 时发生**一次**（「wizardShownThisSession「 去重）。
     */
    const wiz = document.querySelector('.kbw-wiz-steps');
    if (wiz) {
      const done = Array.from(document.querySelectorAll('.kbw-modal-foot .kbw-btn'))
        .find((b) => (b.textContent ?? '').includes('完成'));
      if (done) done.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    for (let i = 0; i < rounds; i += 1) {
      P.key('Escape');
    }
    const left = document.querySelectorAll('.kbw-modal, .kbw-panel, .kbw-backdrop, .kbw-menu').length;
    /**
     * 🔴 **按完 Esc 要把工作台带回前台**（P6b 收尾实测出来的机制，已逐帧验过）：
     * 按下的 Esc 会落到**平台层** → 平台把另一个标签（常常是一个多余的 markdown 页）切成活动叶
     * → 工作台当场 display:none → 之后量的几何**全是 0**；而"点一下工作台里的东西"
     * 又能把它切回来（实测：点看板后 root=1463、再 Esc×3 又变 0）。
     * 于是"closeAll 之后立刻量几何"在所有步骤里都不可靠 —— 历史上那一串"量到 0"的怪现象，
     * 根因多半就在这儿。**在这里就地修**（revealLeaf 是异步的，调用方后面都有自己的 wait）。
     */
    const wbOne = app.workspace.getLeavesOfType('kb-workbench-view')[0];
    if (wbOne) {
      try { void app.workspace.revealLeaf(wbOne); } catch (e) { /* 老版本没这个 API 就算了 */ }
    }
    return left;
  },

  /* ── 主题（⑧ 非文字对比要"明暗各量一次"）────────────────────────
   *
   * 真机取证（2026-09-28，本机 1.13.7）：切主题**只有** app.changeTheme 这一条路走得通 ——
   *   · app.changeTheme('obsidian'|'moonstone'|'system') 真的生效（body 上的
   *     theme-dark / theme-light 当场跟着变，实测三次都变对了）；
   *   · 类型定义里**没有**这个 API（所以只能这么叫，别去找 d.ts）；
   *   · ⚠️ 它写进库的 appearance.json —— 所以用完**必须切回原值**
   *     （原值从 app.vault.getConfig('theme') 读，通常是 'system'）。
   *
   * ⚠️ 另一条**试过但不行**的路，记在这儿免得下一轮再试一遍：
   *   Emulation.setEmulatedMedia({media:'screen', features:[{name:'hover',value:'none'}]})
   *   —— CDP 收下了参数，但页面里 matchMedia('(hover: hover)') 照样是 true
   *   （带不带 media 字段都试了）。所以「触屏 hover 残留」这条**真机验不了**，
   *   它只有离线那条静态断言管（styles 里顶层 :hover 必须包在 @media (hover:hover) 里）。
   */
  theme: () => {
    try { return app.vault.getConfig?.('theme') ?? 'system'; } catch (e) { return 'system'; }
  },

  /* ── AI 助手（P6 段④ · 交互规格 §11）──────────────────────────
   *
   * 🔴 **探针默认不联网**：装上假传输层（「stubAi「），想验真连接必须**显式**
   * 调 「realAi()「 把那一条换回来。理由是坑单记过的那类账（真调模型只留一条判据）——
   * 90 多步每轮都真调模型 = 花钱 + 输出还会变（失败集合每轮不一样那类坑）。
   * 真连接单独一条判据（这一步就是 「真连接「 那一步）。
   *
   * ⚠️ 「stubAi「 里的 advice 是**模型回话的原文**（JSON 字符串），不是对象 ——
   * 这样连"模型爱加围栏/加废话"那种真实形态也能在探针里造出来。
   */
  /** 轮询一个页面内条件；返回是否在超时前满足（探针里别用固定 sleep 赌动画/异步） */
  waitFor: async (fn, timeoutMs, stepMs) => {
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try { hit = !!fn(); } catch (e) { hit = false; }
      if (hit) return true;
      if (Date.now() - t0 > (timeoutMs || 5000)) return false;
      await new Promise(function (r) { setTimeout(r, stepMs || 50); });
    }
  },
  stubAi: (advice) => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    if (!ctx || !ctx.ai) return false;
    // ⚠️ P7.3c 起 chat / stream 的返回形状是 { text, usage? }（原先是裸字符串）
    ctx.ai.transport = { chat: async function () { return { text: advice }; } };
    return true;
  },
  /**
   * **按顺序回话**的假模型（P7.3b：agent 的一轮 = 多次模型调用 —— 提动作 → 执行 → 收尾）。
   * 与离线 「H.stubAiSeq「 同形状；条数不够时重复最后一条（跑飞了也不会炸在"没准备"）。
   */
  stubAiSeq: (list) => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    if (!ctx || !ctx.ai) return false;
    let i = 0;
    ctx.ai.transport = {
      chat: async function () {
        const r = list[Math.min(i, list.length - 1)];
        i += 1;
        // ⚠️ 返回 { text }（P7.3c 的 AiReply）；usage 不给 = 走本地估算那条路
        return { text: typeof r === 'string' ? r : JSON.stringify(r) };
      },
    };
    return true;
  },
  /**
   * **探针自己装的那把假 key**。
   *
   * 为什么要有：面板在 「isConfigured()「 为假时**根本不让问**（显示"还没配置"），
   * 而用假传输层的那几步**不需要真 key** —— 没有它，那几步会卡在"还没配置"上，
   * 报出来是"计划表 0 行"，看着像功能坏了，其实是没配 key。
   * ⚠️ **带 「__探针「 标记**：真连接那一步靠它区分"真 key"与"探针装的假 key"，
   * 不然一把假 key 会让那条判据变成一个永远失败的真调用。
   */
  AI_FAKE_KEY: '__探针-假key-不算配置__',
  setAiKey: async (key) => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    const prev = ctx.settings.get().ai.apiKey;
    await ctx.settings.save({ ai: Object.assign({}, ctx.settings.get().ai, { apiKey: key }) });
    await P.wait(300);
    return prev;
  },
  realAi: () => {
    const P = window.__kbwProbe;
    const ctx = P.ctx();
    if (!ctx || !ctx.ai) return false;
    ctx.ai.transport = ctx.ai.http;
    return true;
  },
  /**
   * **当前那一条撤销条上的按钮**。
   *
   * 🔴 为什么不直接 「q('.kbw-undobar-actions .kbw-btn')「：「showUndo()「 换条时
   * **不是立刻删旧的**（「dismiss()「 给它打 「is-leaving「，等 animationend 或 400ms 兜底）——
   * 那最多 400ms 里容器上有**两条**，而 「querySelector「 按文档顺序拿的是**旧的那条**。
   * P6④ 离线用例实测：点「撤销」撤的是上一轮那次操作，文件确实动了一个，但不是这一个
   *（读了三次才看破）。口径与 「lastModal「 / 「clickAny「 完全一样：认"最后出现的那一条"。
   */
  lastUndo: (match) => {
    const all = Array.from(document.querySelectorAll('.kbw-undobar'))
      .filter(function (b) { return b.dataset.leaving !== '1'; });
    const bar = all.length > 0 ? all[all.length - 1] : null;
    if (!bar) return null;
    const btns = Array.from(bar.querySelectorAll('.kbw-undobar-actions .kbw-btn'));
    if (!match) return btns[btns.length - 1] ?? null;
    return btns.find(function (b) { return (b.textContent ?? '').includes(match); }) ?? null;
  },
  /** 造两篇给 AI 那几步用的笔记（放 00_Inbox，名字带 __探针） */
  seedAiNotes: async (names) => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    const NL = String.fromCharCode(10);
    const out = [];
    for (const n of names) {
      const rel = kb + '/00_Inbox/' + n + '.md';
      const old = app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中',
        '创建日期: 2026-09-28', 'tags: []', '---', '# ' + n].join(NL) + NL);
      out.push(rel);
    }
    /** 等索引真的看见它们（AI 的建议要过 「hasNote「 那道闸 —— 索引没跟上会判成"库里找不到"） */
    for (let i = 0; i < 16; i += 1) {
      await P.wait(200);
      const seen = P.ctx().index.notes().filter(function (e) { return e.basename.indexOf('__探针AI') === 0; }).length;
      if (seen >= names.length) break;
    }
    return out;
  },
  /**
   * 当前会话 id 列表（P7.3a：面板每问一轮就会往插件目录存一份会话）。
   * 探针自清理用 —— 会话是**我们造的**，跑完要收走；认 diff 不认时间，别动用户已有的。
   */
  sessionIds: async () => {
    const P = window.__kbwProbe;
    const list = await P.ctx().ai.sessions.list();
    return list.map(function (m) { return m.id; });
  },
  /** 删掉比 before 多出来的会话（**认 diff**：探针跑之前就有的那几份一律不动） */
  dropNewSessions: async (before) => {
    const P = window.__kbwProbe;
    // 面板的 persist 是 fire-and-forget —— 给最后那一笔落盘留一拍，否则 diff 跑在它前面（独立审查 🟢6）
    await P.wait(600);
    const store = P.ctx().ai.sessions;
    const now = await store.list();
    for (const m of now) {
      if (before.indexOf(m.id) < 0) await store.remove(m.id);
    }
  },
  /** 删掉上面那两篇（**它们可能已经被搬走** → 三个可能的位置都找） */
  dropAiNotes: async (names) => {
    const P = window.__kbwProbe;
    const kb = P.ctx().settings.kbRoot();
    for (const n of names) {
      for (const d of ['00_Inbox', '01_Projects', '02_Areas/灵感杂记']) {
        const f = app.vault.getAbstractFileByPath(kb + '/' + d + '/' + n + '.md');
        if (f) await app.vault.delete(f, true);
      }
    }
    await P.wait(700);
  },
  /**
   * 打开 AI 面板（**走首页那个真入口**：首页 → 「问 AI」快捷动作）。
   * 返回 '' 表示成功了，否则是失败原因。
   */
  openAiPanel: async () => {
    const P = window.__kbwProbe;
    const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).includes('首页'); });
    if (nav) { P.click(nav); await P.wait(900); }
    const btn = P.qa('.kbw-qbtn').find(function (b) { return P.text(b).includes('问 AI'); });
    if (!btn) return '首页上没有「问 AI」这个快捷动作';
    P.click(btn);
    await P.wait(700);
    return P.q('.kbw-ai-input') ? '' : '点了「问 AI」但面板没开';
  },
  /** 在 AI 面板里问一句（「withConfirm「 见下）；返回面板里那一屏的文字 */
  askAi: async (question) => {
    const P = window.__kbwProbe;
    const input = P.q('.kbw-ai-input');
    if (!input) return 'AI 面板没开';
    const doneCount = function () {
      return document.querySelectorAll('.kbw-ai-ops').length +
        document.querySelectorAll('.kbw-ai-bubble.is-error').length;
    };
    const before = doneCount();
    input.value = question;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const send = P.q('.kbw-ai-send .kbw-btn');
    if (!send) return '找不到「问一下」';
    P.click(send);
    /**
     * 🔴 **轮询「这一轮画完」，别赌固定 1400ms**（P7.3a 探针第二轮实测翻车：
     * 打字机回放的墙钟长度随机器/窗口状态变，固定等待里采样到的是半截回放 ——
     * 「建议表 0 行」的红看着像功能坏了）。收尾信号 = 「.kbw-ai-ops」（每轮画完都挂）或红框。
     * ⚠️ P7.3b 起还多两种"可以往下走了"的时刻：**待确认卡挂出来**（.kbw-ai-acts，
     * 轮次停在等你点）或「自动」档直接弹了确认框（第二个模态）—— 都不该干等 12 秒。
     */
    const okWait = await P.waitFor(function () {
      return (
        doneCount() > before ||
        !!document.querySelector('.kbw-ai-acts') ||
        /**
         * P7.21 · #3：ask_user 的轻弹层挂着 = 这一轮**在等你回答**（不是没画完）——
         * 不给这个信号的话调 ask_user 的那一步要干等到超时（12s）。
         */
        !!document.querySelector('.kbw-ai-ask') ||
        document.querySelectorAll('.kbw-modal').length > 1
      );
    }, 12000);
    await P.wait(okWait ? 250 : 1400);
    return '';
  },

  /* ── 首次使用向导（P6 段④ · §14）──────────────────────────── */
  /**
   * 把 「wizardDone「 拨到指定值（「null「 = 抹掉这个键，演"存量用户"）。
   * ⚠️ **只改这一个键**，不动别的设置（「SettingsStore.save「 是合并写 + 回读校验）。
   */
  setWizardDone: async (v) => {
    const P = window.__kbwProbe;
    await P.ctx().settings.save({ wizardDone: v });
    await P.wait(400);
    return P.ctx().settings.get().wizardDone;
  },
  /** 重载插件（「wizardShownThisSession「 与视图一起重置 —— 向导"这一次会话弹过没有"靠它） */
  reloadPlugin: async () => {
    const P = window.__kbwProbe;
    await app.plugins.disablePlugin('kb-workbench');
    await P.wait(500);
    await app.plugins.enablePlugin('kb-workbench');
    await P.wait(1000);
    return !!P.plugin();
  },
  /** 向导模态（没开就 null） */
  wizard: () => {
    const all = Array.from(document.querySelectorAll('.kbw-modal'));
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].querySelector('.kbw-wiz-steps')) return all[i];
    }
    return null;
  },
  /** 点向导底部某个按钮（返回是否点到） */
  wizardFoot: (label) => {
    const P = window.__kbwProbe;
    const w = P.wizard();
    if (!w) return false;
    const b = Array.from(w.querySelectorAll('.kbw-modal-foot .kbw-btn'))
      .find(function (x) { return P.text(x).includes(label); });
    if (!b) return false;
    P.click(b);
    return true;
  },
  setTheme: (t) => {
    try { app.changeTheme(t); return true; } catch (e) { return false; }
  },
  isDark: () => document.body.classList.contains('theme-dark'),

  /* ── 现代颜色序列化（⑧ 非文字对比要它）──────────────────────────
   *
   * 🔴 **为什么不能直接用上面那个 rgb()**：本机实测（2026-09-28），
   * color-mix(in srgb, …) 与 oklch(…) 的**计算值**会序列化成
   *   · color(srgb 0.581961 0.581961 0.581961)（我们那条 --kbw-nontext 就是它）
   *   · oklch(0.999994 0.0000497986 none / 0.15)
   * 而老的 rgb() 只认 rgb()/rgba() 形态 → 返回 null → lum(null) **当场抛**
   * （⑧ 那一步第一次跑就是这条：TypeError: Cannot read properties of null (reading '0')）。
   * 老的 alpha() 更阴：认不出的形态**当成不透明**，于是"半透明的底"会被当成实色。
   *
   * 这里把三件事补齐：oklch/oklab → sRGB 的换算（Ottosson 那套公式）、
   * color(srgb …)、以及 none 分量当 0。**不改老的 rgb()/alpha()/bgOf()** ——
   * 动它们等于悄悄改掉既有的文字对比判据，那一笔留到下一轮单独做（已记进交接）。
   */
  colorRgb: (color) => {
    const s = String(color ?? '').trim();
    if (!s || s === 'transparent' || s === 'none') return null;
    let m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      const h = m[1];
      const step = h.length <= 4 ? 1 : 2;
      const get = (i) => {
        const part = step === 1 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2);
        return parseInt(part, 16);
      };
      return [get(0), get(1), get(2)];
    }
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      return p.length >= 3 ? [p[0], p[1], p[2]] : null;
    }
    m = s.match(/^color\(srgb\s+([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean);
      const num = (x) => (x === 'none' ? 0 : parseFloat(x));
      return [num(p[0]) * 255, num(p[1]) * 255, num(p[2]) * 255].map((v) => Math.round(v));
    }
    m = s.match(/^okl(ch|ab)\(([^)]+)\)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const p = m[2].split(/[\s\/]+/).filter(Boolean);
      const num = (x, d) => (x === undefined || x === 'none' ? d : parseFloat(x));
      const L = num(p[0], 0);
      let a;
      let bb;
      if (kind === 'ch') {
        const C = num(p[1], 0);
        const H = (num(p[2], 0) * Math.PI) / 180;
        a = C * Math.cos(H);
        bb = C * Math.sin(H);
      } else {
        a = num(p[1], 0);
        bb = num(p[2], 0);
      }
      const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
      const s_ = L - 0.0894841775 * a - 1.291485548 * bb;
      const l3 = l_ * l_ * l_;
      const m3 = m_ * m_ * m_;
      const s3 = s_ * s_ * s_;
      const lin = [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
      ];
      const gam = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
      return lin.map((v) => Math.round(Math.min(255, Math.max(0, gam(v) * 255))));
    }
    return null;
  },
  /**
   * 任意形态的对比度（内部走 colorRgb）。
   * ⚠️ **前景带 alpha 时要先按背景合成**（独立审查 B5：第一版直接拿 RGB 算，
   * 于是"30% 透明的灰"与不透明同分 —— 那是把半透明的字当成实心的量）。
   */
  contrastAny: (fg, bg) => {
    const P = window.__kbwProbe;
    const b = P.colorRgb(bg);
    let a = P.colorRgb(fg);
    if (!a || !b) return null;
    const af = P.alphaAny(fg);
    if (af < 1) a = a.map((v, i) => Math.round(v * af + b[i] * (1 - af)));
    const la = P.lum(a);
    const lb = P.lum(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  },
  /** 任意形态的 alpha（/ .15 与 none 都要认 —— 老的 alpha() 会把它们当 1） */
  alphaAny: (color) => {
    const s = String(color ?? '').trim();
    if (!s || s === 'transparent') return 0;
    const slash = s.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (slash) {
      const v = slash[1];
      return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
    }
    const m = s.match(/^rgba\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return p.length === 4 ? p[3] : 1;
    }
    return 1;
  },
  /** 沿祖先链找第一个**不透明**的背景，并把它归一化成 rgb() 形态（⑧ 用它） */
  bgSolid: (el) => {
    const P = window.__kbwProbe;
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && P.alphaAny(bg) > 0.5) {
        const rgb = P.colorRgb(bg);
        if (rgb) return 'rgb(' + rgb.join(',') + ')';
      }
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  },
  /*
   * ── P7.13b：待处理行的助手（右键新形态 · ①/② · 撤离辅助）────────
   * ⚠️ 这段在 String.raw 模板里：注释里**不许出现反引号**。
   */
  /** 找一行待处理（按文案含 needle）；没有就 null */
  todoRow: (needle) => Array.from(document.querySelectorAll('.kbw-todo')).find((r) => (r.textContent ?? '').indexOf(needle) >= 0) ?? null,
  /** 那一行开头的数字（篇/件/组）；没有行就 null */
  todoRowN: (needle) => {
    const P = window.__kbwProbe;
    const r = P.todoRow(needle);
    if (!r) return null;
    const m = P.text(r).match(/(\d+)/);
    return m ? Number(m[1]) : null;
  },
  /*
   * 把含这些措辞的行挤进可见区：先点「还有 N 项」展开（折叠只画前 5 条），
   * 再把挡路的行逐个「忽略」。homeDismissed 是用户设置 —— 调用方 finally 里原值归还。
   */
  revealTodoRows: async (needles) => {
    const P = window.__kbwProbe;
    const has = () => needles.every((n) => P.qa('.kbw-todo').some((r) => P.text(r).indexOf(n) >= 0));
    for (let i = 0; i < 80 && !has(); i += 1) {
      await P.wait(220);
      const more = P.qa('.kbw-todo-rest').find((r) => P.text(r).indexOf('还有') >= 0);
      if (more) { P.click(more); await P.wait(220); continue; }
      const rows = P.qa('.kbw-todo');
      if (rows.length === 0) continue;
      const victim = rows.find((r) => !needles.some((n) => P.text(r).indexOf(n) >= 0));
      if (!victim) return has();
      const x = victim.querySelector('.kbw-todo-x');
      if (!x) return has();
      P.click(x);
      await P.wait(240);
    }
    return has();
  },
  /*
   * 行右键 → 悬停「✦ AI 自动处理」→ 点 ① 或 ②（P7.13b 的新子菜单）。
   * 返回 true / false（点不到）/ 'disabled'（那一项置灰）。
   * ⚠️ 坐标走 aimAt（真鼠标落点 —— #6a 起菜单就开在鼠标处）。
   */
  clickTodoAi: async (row, which) => {
    const P = window.__kbwProbe;
    const pt = P.aimAt(row.querySelector('.kbw-todo-t') || row);
    if (!pt || !pt.visible) return false;
    P.rightClickAt(pt.x, pt.y);
    await P.wait(450);
    const menu = P.lastMenu();
    if (!menu || P.text(menu).indexOf('处理这一项') < 0) return false;
    const ai = Array.from(menu.querySelectorAll('.kbw-menu-item')).find((i) => P.text(i).indexOf('✦ AI 自动处理') >= 0);
    if (!ai) return false;
    ai.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await P.wait(400);
    const all = P.qa('.kbw-menu');
    let layer = null;
    for (let i = all.length - 1; i >= 0 && !layer; i -= 1) {
      if (P.text(all[i]).indexOf('自动处理本条') >= 0) layer = all[i];
    }
    if (!layer) return false;
    const item = Array.from(layer.querySelectorAll('.kbw-menu-item')).find((i) => P.text(i).indexOf(which) === 0);
    if (!item) return false;
    if (item.getAttribute('aria-disabled') === 'true') return 'disabled';
    P.click(item);
    await P.wait(400);
    return true;
  },
  /** 在**最后一个**模态的底栏里点按钮（按文案）；找不到返回 false */
  clickLastModalBtn: (needle) => {
    const P = window.__kbwProbe;
    const m = P.lastModal();
    if (!m) return false;
    return P.clickByText(needle, m);
  },
  /** 轮询谓词成真（**fn 可以是异步的** —— await 它的结果；到时再问一次） */
  until: async (fn, ms) => {
    const P = window.__kbwProbe;
    const step = 200;
    for (let t = 0; t < ms; t += step) {
      if (await fn()) return true;
      await P.wait(step);
    }
    return await fn();
  },
  /*
   * 把**除这些措辞之外**的可见行全部忽略掉（含先展开折叠）——留给 ② 那种
   * "清单只剩我控制的行"的编排用；homeDismissed 由调用方原值归还。
   */
  dismissAllExcept: async (needles) => {
    const P = window.__kbwProbe;
    for (let i = 0; i < 120; i += 1) {
      const rows = P.qa('.kbw-todo');
      const extra = rows.find((r) => !needles.some((n) => P.text(r).indexOf(n) >= 0));
      if (!extra) {
        const more = P.qa('.kbw-todo-rest').find((r) => P.text(r).indexOf('还有') >= 0);
        if (!more) return rows.length > 0;
        P.click(more);
        await P.wait(240);
        continue;
      }
      const x = extra.querySelector('.kbw-todo-x');
      if (!x) return false;
      P.click(x);
      await P.wait(240);
    }
    return false;
  },
};
true;
`;
