/**
 * modules/board/peek.ts —— **停靠预览窗格（Peek）**（P4.5 e 期 §3.2）
 *
 * §3.2 的原话：
 * ```
 * 右侧常驻一个**只读预览**（跟着光标/当前卡片走），不打断手上的操作。
 * ⚠️ 与 §12 决策 5 的关系：那条否掉的是「Ctrl + 悬停弹小窗」…
 *    这里提的是**另一个形态**（常驻窗格、不是弹窗、不依赖悬停）。不矛盾，但要你确认（§6-Q2）。
 * ```
 * 拍板：**Q2 = 要，默认关**；「当前那篇」怎么定 → **只跟键盘光标**（e 期开工时用户拍的）。
 *
 * ── 三条口径（写在 `看板优化方案.md` §6.15，别在别处再判一次）────────
 *  ① **只跟键盘光标**（方向键 / `[` `]`）。鼠标划过卡片不让预览跟着变 ——
 *    "不打断手上的操作"是它存在的理由，跟着鼠标闪就正好相反。
 *  ② **与编辑面板互斥**：两者是同**一个**宿主的两种占用。开 Peek 收面板、点卡片开面板时收 Peek。
 *    ⚠️ 仲裁**不在这里做**（也不在 `editor.ts`）：`peek.ts` 与 `editor.ts` 互相 import 会成环。
 *    清场那一步由看板模块用 `PeekDeps.onNeedWindow` 注入 —— 与 `ui/dock.ts` 那条
 *    "放 `ui/` 是为了不让 view 与 board 成环"同一个理由。
 *  ③ **它只有窗格形态**：没有浮层那一套（浮起来的预览就是决策 5 否掉的那个东西）。
 *    所以"点外面关 / Esc 关 / 视口 resize 关"在这里全都不存在 —— 关它只有一条路：
 *    菜单里关掉、切走模块（见下面「寿命」）。
 *
 * ── 寿命 ──────────────────────────────────────────────────────
 * **随看板模块走**：切走模块 → 窗格让出来（**配置不删**，`peekEnabled` 仍是 true），
 * 切回来（或下次进看板）自动回来。与面板"钉住就跨模块存活"**不一样** ——
 * 面板里挂着真编辑器（编辑现场值得跨模块留着），Peek 只是一份只读渲染，重建代价为零。
 *
 * ── 与「停靠面板」共用一套宿主 ─────────────────────────────────
 * 宿主、裁决、分隔条、`data-dock` 全走 d2 的 `ui/dock.ts`（**唯一出处**）：
 * 本文件只管"请求哪一边 / 多大"，放不放得下由外壳按容器尺寸裁决（`dockFit`）。
 * 窄档（主区 <640）放不下 ⇒ 外壳不生效 ⇒ **Peek 没有退路**（它没有浮层形态），
 * 所以那一下必须**说出来**，别让菜单点了没反应。
 */
import { Component, MarkdownRenderer } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { Disposer } from '../../core/util';
import { div } from '../../ui/primitives';
import { openFloating, type PanelHandle } from '../../ui/panel';
import { PEEK_OWNER, isPanelOwner, type DockPort } from '../../ui/dock';
import { NOTIFY_MS, notify } from '../../ui/notify';
import { cardBody } from './summary';
import type { BoardConfigStore } from './config';

export interface PeekDeps {
  ctx: WorkbenchContext;
  cfg: BoardConfigStore;
  /**
   * **"我要这个窗格，请把别的占用者收掉"** —— 由看板模块注入（内部调 `closeCardPanel`）。
   * 为什么不在这里直接 import `editor.ts`：那会与 `editor.ts` 成环（本文件是它那一侧
   * 的镜像需求），而项目有一条红线判"不许反向 import"。
   */
  onNeedWindow: () => void;
  onReceipt: (text: string) => void;
}

interface PeekPanel {
  h: PanelHandle;
  /**
   * **建窗格时认下的那一个口子**，此后一直用它。
   * ⚠️ 与面板 `CwPanel.dockPort` 同一条理由（d2 审查抓的）：`ctx.dock` 是**后开的视图胜**，
   * 每次现取会申请到别的视图的窗格上，留一条空走廊。Peek 实际也不可能换视图活。
   */
  port: DockPort | null;
  deps: PeekDeps;
  d: Disposer;
  /** 现在跟着哪一篇（路径；null = 没跟） */
  path: string | null;
  /** 标题/路径那一行 */
  head: HTMLElement;
  /** 正文宿主 */
  body: HTMLElement;
  /** `MarkdownRenderer.render` 的第 5 参（**必须**是 Component） */
  component: Component;
  /** 渲染令牌：读盘期间光标又动了 → 老的那次不许再往宿主里写 */
  token: number;
  /** 窗格此刻真的生效吗（外壳裁决的结果）—— 写配置前要问它，见 `onResize` */
  docked: boolean;
  /** 上一次报的"放不下"状态（别每翻一次就弹一条通知） */
  warnedNoRoom: boolean;
  /** 正在走"申请 → 请人让开 → 再申请"那三步（防重入，见 `applyPeekPlacement`） */
  placing: boolean;
}

let peek: PeekPanel | null = null;

/** 窗格开着吗（看板与探针据此断言） */
export function peekIsOpen(): boolean {
  return peek != null;
}

/** 现在跟着哪一篇（探针据此断言"预览真的换了"） */
export function peekPath(): string | null {
  return peek?.path ?? null;
}

/**
 * 让窗格跟上**配置**：开 / 关 / 换边 / 改大小。**进出窗格的唯一落点**
 * （与面板那边 `syncDock()` 对称：配置变了、建模块时、都走这一条）。
 *
 * ⚠️ 配置还没读出来（`cfg.isLoaded()` 为假）时**只接线不动手**：`BoardConfigStore.load()`
 * 是异步的、且**读完不 emit**，照一份默认值（`peekEnabled: false`）去重排会把刚停好的窗格
 * 卸掉，此后没人再纠正它（d2 在面板上踩过一模一样的坑 —— 见 `rebindCardPanel`）。
 */
export function syncPeek(deps: PeekDeps): void {
  if (!deps.cfg.isLoaded()) {
    // 还没读到配置：只把依赖刷新一遍（切模块之后 deps 指向的是新模块那一个 store）
    if (peek) peek.deps = deps;
    return;
  }
  const v = deps.cfg.get().view;
  if (!v.peekEnabled) {
    if (peek) closePeek({ reason: 'config-off' });
    return;
  }
  const p = ensurePeek(deps);
  p.deps = deps;
  applyPeekPlacement(p);
}

/**
 * 光标动到别处了 —— 换预览内容。`target` 为 null = 没有光标（空态）。
 *
 * ⚠️ 调用方（看板模块）只在**自己的光标真的变了**时调；这里再挡一道"路径没变就什么都不做"，
 * 免得每次 store 变动都白读一次文件。
 */
export function followPeek(target: NoteEntry | null): void {
  const p = peek;
  if (!p) return;
  const next = target?.path ?? null;
  if (next === p.path) return;
  p.path = next;
  paintPeek(p, target);
}

/**
 * 关掉窗格。
 *
 * `keepConfig` 永远是 true（配置里那个开关是"用户的偏好"，不是"这一刻开着"）——
 * 参数留着只是为了让调用点把话说清楚，别以为它会把配置改掉。
 */
export function closePeek(opts: { reason?: string } = {}): void {
  const p = peek;
  if (!p) return;
  // 先摘单例（`onClose` 会回来读它，别让它拿到正在拆的这一个 —— 与 `destroyPanel` 同一条）
  peek = null;
  /**
   * 把窗格**让出来**。两条：
   *  · ⚠️ 顺序：先 request(null) 再 close —— 反过来的话 `h.close()` 里 `root.remove()`
   *    已经把它从宿主里摘掉了，外壳那边 `dockApplied` 还是 true ⇒ 边上留一条空窗格
   *    （d2 审查抓过这条）。
   *  · 🔴 **只有"我是占用者"时才让**（与面板 `onClose` 那半句对称）：窗格只有一个，
   *    而 `request(null)` 不认人 —— Peek 没能生效（容器挤不下）时报的"放不下"状态下来关它，
   *    会把别人（编辑面板）正占着的窗格收掉。
   */
  try {
    /**
     * 🔴 **只有"此刻真的是我占着"才撤窗格**（独立审查抓的）：
     * `request(null)` 那个口子**不认人** —— 被别人抢走之后再关 Peek，这一句会把
     * **别人**刚占上的窗格一起撤掉（症状：面板刚停靠好，边上的窗格却空着一条）。
     * 问的是口子的占用者身份，不是自己的 `docked` 布尔（那个只说明"我申请过"）。
     */
    if (p.port?.owner() === PEEK_OWNER) {
      p.port.request(null, p.deps.cfg.get().view.peek.size, PEEK_OWNER);
    }
  } catch (e) {
    console.error('[经纬] 让出预览窗格失败', e);
  }
  p.d.dispose();
  p.h.close(opts.reason ?? 'close');
  try {
    p.component.unload?.();
  } catch (e) {
    console.error('[经纬] 收预览窗格组件出错', e);
  }
}

// ────────────────────────────────────────────────────────────────
// 内部
// ────────────────────────────────────────────────────────────────
function ensurePeek(deps: PeekDeps): PeekPanel {
  if (peek) return peek;
  const component = new Component();
  component.load();
  const d = new Disposer();

  const head = div({ cls: 'kbw-peek-head' });
  const body = div({ cls: 'kbw-peek-body' });

  const h = openFloating({
    title: '预览',
    width: 'normal',
    // ⚠️ 给个**永远不会用到**的锚点：Peek 一建出来就 `setDocked(host)` 搬进窗格，
    //    浮层那套定位随之整体失效（见 `ui/panel.ts` 的 `setDocked`）。给 0,0 是为了
    //    "万一没搬成"时它老老实实待在左上角，而不是从屏幕中间弹一下。
    origin: { x: 0, y: 0 },
    closeOnOutside: false,
    onClose: () => {
      // 所有关闭路径的必经之地（与面板 `onClose` 同一条：dispose 放这儿，漏一次就是一对泄漏）
      try {
        d.dispose();
      } catch (e) {
        console.error('[经纬] 收预览窗格的监听失败', e);
      }
      component.unload?.();
    },
  });
  h.root.classList.add('kbw-peek');
  /**
   * 换掉浮层的头/身体结构：Peek 要的是"标题那一行 + 一整块正文"，
   * 而不是面板那套「标题栏 + 底部按钮区」。⚠️ 走**公开的那几个容器**（`body`/`foot`），
   * 别去 `querySelector` 猜内部节点。
   */
  h.body.appendChild(head);
  h.body.appendChild(body);
  h.foot.style.display = 'none';

  const p: PeekPanel = {
    h,
    port: deps.ctx.dock ?? null,
    deps,
    d,
    path: null,
    head,
    body,
    component,
    token: 0,
    docked: false,
    warnedNoRoom: false,
    placing: false,
  };

  /**
   * 外壳那边"放得下 / 放不下"翻了 → 记下来。
   * ⚠️ 这里**不搬进搬出**（Peek 没有浮层形态）：宿主显不显示是外壳的事，
   *    我们只关心"要不要告诉用户它现在看不见"。
   */
  if (p.port) {
    d.add(
      p.port.onChange((s) => {
        p.docked = s.applied && s.owner === PEEK_OWNER;
        /**
         * 🔴 **别人把窗格要走了 → 我让位**（e 期独立审查抓的真缺陷）：
         * 编辑面板申请停靠时 `owner` 会变成 `panel`，而那一下**没有任何人通知 Peek** ——
         * 于是两个根同时挂在一个宿主里（各自 100%×100%）、两个占用者都以为自己占着。
         * 放在这条通知里最省事：谁占了窗格，口子最清楚。
         * ⚠️ 让位**不撤窗格**（`closePeek` 里那句问过 `owner()`）—— 撤了就等于把别人刚
         * 要来的窗格又收掉。
         * ⚠️ f 期：占用者名从 `'panel'` 变成 `panel#<n>`（多窗之后一扇一个名）——
         * 判据走 `isPanelOwner()`，**别再比字面量**（比 `'panel'` 的话多窗之后这一整段
         * 永远不触发 = 两个根同时挂在一个宿主里，正是这条当初要挡的事）。
         */
        if (isPanelOwner(s.owner)) {
          closePeek({ reason: 'panel-took-window' });
          return;
        }
        if (p.docked) {
          p.warnedNoRoom = false;
          return;
        }
        // 没人占着而我该在窗格里 → 只可能是**容器放不下**（`warnNoRoom` 自己会再确认一遍）
        if (p.deps.cfg.get().view.peekEnabled) warnNoRoom(p);
      }),
    );
    d.add(
      p.port.onResize((size) => {
        // ⚠️ 只有**窗格真的是我在用**时才由我写配置（d2 那条 🟡 的同款：
        //    拖分隔条时两个占用者都收到广播，不问一句就会把对方的尺寸改掉）
        if (p.port?.owner() !== PEEK_OWNER) return;
        const cur = p.deps.cfg.get().view.peek;
        void p.deps.cfg
          .patchView({ peek: { where: cur.where, size } })
          .then(() => p.deps.onReceipt(`预览窗格：${size}px`));
      }),
    );
  }
  /**
   * 🔴 **建完立刻搬进停靠宿主**（e 期独立审查抓的）：`openFloating` 会把根先挂到
   * `document.body` 上 —— 而 Peek **没有浮层形态**（"常驻"才是它的价值，§12 决策 5 否掉的
   * 正是"飘着的预览"）。不搬的话，"容器放不下"那一刻它会**以真浮层的样子出现在左上角**
   *（实测：`parentElement = body`、`left/top = 4px`），而且拉宽之后也没人把它搬回去
   *（那时 `setDocked` 那一句在 `!applied` 分支里永远走不到）。
   * 搬进去之后：**宿主是外壳的**，它 `display:none` 时 Peek 就是隐形的 ✓
   * 拉宽之后宿主自己显示出来，什么都不用做 ✓。
   */
  if (p.port) p.h.setDocked(p.port.host);
  peek = p;
  paintPlaceholder(p, '用方向键在卡片间走一格，这里就跟着显示那一篇');
  return p;
}

/**
 * 按配置请求窗格、把别的占用者请走、再把它搬进宿主。
 *
 * 🔴 **这三步的顺序是被逼出来的，别顺手合并成两步**：
 *  ① **先申请**：只有外壳知道容器多大（裁决在 `ui/dock.ts` 的 `dockFit`，量的是**根元素**），
 *     申请之后 `applied()` 才有准话。
 *  ② **放得下才请别人让开**：放不下就一个字都不说 —— 否则在挤窄的工作台上"开一下 Peek"
 *     会把用户停靠着的编辑面板收掉、然后显示一片空白（收编辑面板是有代价的：那几篇的
 *     真编辑器要逐个 `save()` + `detach()`）。
 *  ③ **让开之后必须再申请一遍**：面板收尾那句 `request(null)`（它在 `ui/panel.ts` 的 `onClose` 里）
 *     会盖掉第 ① 步。好在面板的收尾是**同步**的（`h.close()` 直接走到 onClose 那两句），
 *     所以这里写完就是最终态，不需要再等一拍。
 *     ⚠️ 面板没开着时 `onNeedWindow()` 是个空操作，第 ③ 步只是一次无害的重复申请。
 */
function applyPeekPlacement(p: PeekPanel): void {
  const v = p.deps.cfg.get().view;
  const port = p.port;
  if (!port) {
    // 外壳还没起来（离线单测直接渲染看板模块）：安静地当"这次没生效"
    p.docked = false;
    return;
  }
  /**
   * ⚠️ **防重入**：第 ② 步请人让开时会一路绕回来（面板收尾 → 喊"窗格让出来了" →
   * 模块的听者 → `syncPeek` → 本函数）。没有这个闸门就是一次递归。
   */
  if (p.placing) return;
  p.placing = true;
  try {
    /**
     * ① **先申请**（带上自己的身份）：只有外壳知道容器多大（裁决在 `ui/dock.ts` 的
     * `dockFit`，量的是**根元素**），申请之后 `applied()` / `owner()` 才有准话。
     */
    port.request(v.peek.where, v.peek.size, PEEK_OWNER);    /**
     * ② **放不下就到此为止**：注意判据是 `owner()` 而不是只有 `applied()` ——
     * 这一步刚申请过，`applied` 为真就说明窗格是我的；为假就只有两种可能：
     * 容器真的放不下（要说出来），或者恰好被别人抢了（那条路走 `onChange`）。
     * ⚠️ 这里**不再重申请第二遍**：曾经需要是因为面板收尾那句 `request(null)` 不认人、
     * 会把我们刚申请到的窗格盖掉 —— 现在 `request` 带身份、那句话只由**当前占用者**
     * 发得出来（见 `ui/dock.ts` 的 `DockOwner`），盖不掉了。
     */
    if (!port.applied() || port.owner() !== PEEK_OWNER) {
      p.docked = false;
      warnNoRoom(p);
      return;
    }
    /**
     * ③ **请别的占用者让开**（停靠着的编辑面板）：它会走正常收尾（save + detach 每篇），
     * 而收尾里那句 `request(null)` 因为"占用者已经是我"而**不会**发生 —— 正是靠这个，
     * 这一步之后窗格稳稳是我的。
     */
    p.deps.onNeedWindow();    p.docked = true;
  } finally {
    p.placing = false;
  }
}

/**
 * "窗格放不下"要说出来。
 *
 * 🔴 为什么别的浮层不需要这一句：面板放不下会**退回浮层**（看得见），
 * 而 Peek **没有退路** —— 不说的话，用户点了菜单、配置也写进去了，屏幕上**什么都没发生**。
 * ⚠️ 去重：拖窗口变窄的过程里 `onChange` 会来回翻，每次都弹一条会很吵。
 */
function warnNoRoom(p: PeekPanel): void {
  if (p.warnedNoRoom) return;
  /**
   * 🔴 **先确认"真的放不下"**（独立审查抓的假通知）：`applied === false` 有两种原因 ——
   * ① 容器放不下；② 此刻被**别人**占着（让位那一下就是②）。不确认就报，
   * 用户会在一个 **1400px 宽的工作台**上看到「预览窗格现在放不下」（实测就是这样）。
   * 判据用 `port.canHold()`（纯几何，与谁占着无关）。
   */
  const v = p.deps.cfg.get().view;
  if (p.port?.canHold(v.peek.where, v.peek.size)) return;
  p.warnedNoRoom = true;
  notify({
    kind: 'info',
    text: '预览窗格现在放不下',
    detail: '主区要留够 640px 才显示窗格 —— 把工作台拉宽，或先取消停靠的编辑面板',
    ms: NOTIFY_MS.long,
  });
}

function paintPlaceholder(p: PeekPanel, text: string): void {
  p.token += 1; // 作废在飞的渲染
  p.path = null;
  paintHead(p, null);
  while (p.body.firstChild) p.body.removeChild(p.body.firstChild);
  p.body.appendChild(div({ cls: 'kbw-peek-empty', text }));
}

function paintHead(p: PeekPanel, entry: NoteEntry | null): void {
  while (p.head.firstChild) p.head.removeChild(p.head.firstChild);
  if (!entry) {
    p.head.appendChild(div({ cls: 'kbw-peek-empty', text: '没有选中任何卡片' }));
    return;
  }
  p.head.appendChild(div({ cls: 'kbw-peek-nm', text: entry.basename }));
  p.head.appendChild(div({ cls: 'kbw-peek-path', text: entry.path }));
}

/**
 * 画一篇。**令牌挡住并发**（与 `paintBoard` 同一条）：读盘是异步的，
 * 期间光标可能已经走到下一篇了 —— 老的那次读回来时不许再往宿主里写
 *（症状是"预览里显示的是上一篇，而标题已经是下一篇"）。
 */
function paintPeek(p: PeekPanel, entry: NoteEntry | null): void {
  p.token += 1;
  const my = p.token;
  paintHead(p, entry);
  while (p.body.firstChild) p.body.removeChild(p.body.firstChild);
  if (!entry) {
    paintPlaceholder(p, '用方向键在卡片间走一格，这里就跟着显示那一篇');
    return;
  }
  p.body.appendChild(div({ cls: 'kbw-peek-note', text: '读正文中…' }));
  void (async () => {
    try {
      const raw = await p.deps.ctx.app.vault.cachedRead(entry.file);
      if (my !== p.token) return;
      const v = p.deps.cfg.get().view;
      /**
       * ⚠️ 剥离口径**复用卡片摘要那一份**（`cardBody`）—— 与面板的 `preview` 档、
       * 卡片正文三处同源。自己再写一遍必然漂（"卡片里看不到前言、预览里却看得到"）。
       */
      const cut = cardBody(raw, {
        stripFrontmatter: v.stripFrontmatter,
        stripTail: v.stripTail,
        markers: v.stripMarkers,
        title: entry.basename,
      });
      while (p.body.firstChild) p.body.removeChild(p.body.firstChild);
      if (cut.text.trim() === '') {
        p.body.appendChild(div({ cls: 'kbw-peek-empty', text: '（这一篇没有正文）' }));
        return;
      }
      const host = div({ cls: 'kbw-peek-md' });
      // 路径标记：探针据此断言"窗格里显示的就是光标那一篇"（与卡片/面板页同一套认人方式）
      host.setAttribute(PEEK_PATH_ATTR, entry.path);
      p.body.appendChild(host);
      await MarkdownRenderer.render(p.deps.ctx.app, cut.text, host, entry.path, p.component);
    } catch (e) {
      if (my !== p.token) return;
      while (p.body.firstChild) p.body.removeChild(p.body.firstChild);
      p.body.appendChild(
        div({ cls: 'kbw-peek-empty is-warn', text: `读正文失败：${e instanceof Error ? e.message : String(e)}` }),
      );
    }
  })();
}

/** 探针/用例认人的锚（全项目找 Peek 都靠它，别在别处再写一份类名） */
export const PEEK_CLASS = 'kbw-peek';
/** 预览内容那一块（探针据此读"显示的是哪一篇"） */
export const PEEK_MD_CLASS = 'kbw-peek-md';
/** 正文宿主上的路径标记（与卡片 / 面板页同一套认人方式） */
export const PEEK_PATH_ATTR = 'data-path';
