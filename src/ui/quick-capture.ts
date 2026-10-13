/**
 * ui/quick-capture.ts —— **快速捕获 + 剪藏**（P4.5 e2 期 §4.3；P7.2c 改版）
 *
 * §4.3 的原话：「全局快捷键（平台级）→ 直接往**指定板块**丢一条，**不离开当前工作**」。
 *
 * 三件事按这个"不离开"来定：
 *  ① 只是个**小浮层**（走 `ui/panel.ts` 的 `openModal`）：标题 + 链接 + 落点；
 *  ② 落盘**走既有链路**（`services/completion.createNote`）—— 同一套"落空文件 →
 *     Templater 判定点 → 不接管才补"；**不自己 `vault.create` 一串**；
 *  ③ 落完**不打开它**（打开就"离开了当前工作"）—— 只给一句通知，写清落在哪、补了什么。
 *
 * ── P7.2c 加的两件（拍板见 `P7.2c开工提示词.md` Q1/Q2）──────────
 *  · **落点第五类「直接选目录」**：下拉分两组（丢进板块 / 直接选目录）；
 *  · **剪藏**：多一行「链接」—— 粘上即抓（`services/clip.ts`，`requestUrl` 绕 CORS），
 *    标题自动改成网页标题、正文存正文、`来源` 记 URL；**粘到面板哪儿都算**
 *    （防"标题框里正选着日期，一 Ctrl+V 把 URL 粘进标题"）；
 *    抓不到（超时 ~8s / 打不开 / 非网页 / 剥出来是空）→ 降级成"标题+链接"一条，
 *    通知里如实说。**零板块不再拦**：可丢的永远 ≥1（目录那条组），面板照开。
 *
 * 目标 = 看板板块（四种源都能选）+ 直接选目录，落点解析在 `modules/board/capture.ts`
 * （那边是纯函数，两种落点同一份）。
 */
import type { WorkbenchContext } from '../core/context';
import { div, el, span, btn } from './primitives';
import { openModal } from './panel';
import { notify, notifyError, NOTIFY_MS } from './notify';
import { recordOnboarding } from '../modules/home/onboarding';
import { todayISO } from '../core/util';
import { kbDirs } from './new-note';
import { captureTargets, describeTarget, dirTargets, firstUsable, type CaptureTarget } from '../modules/board/capture';
import { clipUrl, looksLikeUrl, type ClipResult } from '../services/clip';
import type { BoardConfig } from '../modules/board/config';

export function openQuickCapture(ctx: WorkbenchContext): void {
  void (async () => {
    const { board, dirs, inbox } = await readTargets(ctx);
    /**
     * ⚠️ P7.2c 起**不再有"看板上还没有板块 → 不弹窗"**那条：目录那一组永远 ≥1
     * （`kbDirs` 至少含库根）→ 面板照开，只是下拉里少一组。
     */
    if (board.length === 0 && dirs.length === 0) {
      notifyError('没有可以丢的地方', '先在工作台里建一个板块，或者确认工作文件夹在');
      return;
    }
    show(ctx, [...board, ...dirs], inbox);
  })();
}

/** 读看板配置 → 落点候选（板块四种源 + 直接选目录；收件箱 / 属性取值都从索引现取） */
async function readTargets(
  ctx: WorkbenchContext,
): Promise<{ board: CaptureTarget[]; dirs: CaptureTarget[]; inbox: string }> {
  let cfg: BoardConfig | null = null;
  try {
    cfg = (await ctx.configs.read('board')) as BoardConfig;
  } catch (e) {
    console.error('[经纬] 快速捕获：读看板配置失败', e);
  }
  const dirList = kbDirs(ctx);
  const inbox = dirList.includes('00_Inbox') ? '00_Inbox' : '';
  return {
    board: cfg ? captureTargets(cfg, { inbox, valuesOf: (prop) => ctx.index.valuesOf(prop) }) : [],
    dirs: dirTargets(dirList),
    inbox,
  };
}

/** 链接那一行下面是"抓取到哪一步"的状态（'' = 不显示） */
type ClipPhase = 'idle' | 'fetching' | 'ok' | 'bad';

function show(ctx: WorkbenchContext, targets: CaptureTarget[], inbox: string): void {
  const h = openModal({
    title: '快速捕获',
    // 2b 起的语气：一句人话，工程细节（落点/补什么）跟着下面那行与通知走
    sub: '回车丢一条 —— 不打开它，不离开你手头的事',
    width: 'narrow',
  });

  const byKey = new Map(targets.map((t) => [t.key, t]));
  const last = ctx.settings.get().lastCapture ?? null;
  /**
   * ⚠️ 默认落点**只在"能用的那些"里挑**：属性值源还没有取值时那一行是置灰的，
   * 把它选成默认值，用户一按回车只会收到"这个落点现在用不了"（白按一次）。
   */
  const first = firstUsable(targets, last);

  // ── 标题 ─────────────────────────────────────────────────────
  const title = el('input', {
    cls: 'kbw-input',
    attr: { type: 'text', placeholder: '给这一条起个名', value: todayISO() },
  });
  title.style.width = '100%';
  title.setAttribute('data-capture', 'title');
  /** 用户自己动过标题就不许自动覆盖（剪藏抓到网页标题时只填"没动过"的） */
  let titleTouched = false;
  title.addEventListener('input', () => {
    titleTouched = true;
  });

  // ── 链接（剪藏）─────────────────────────────────────────────
  const link = el('input', {
    cls: 'kbw-input',
    attr: { type: 'text', placeholder: '粘贴链接 = 剪藏这篇网页（粘到哪儿都行）' },
  });
  link.style.width = '100%';
  link.setAttribute('data-capture', 'link');
  const linkStatus = div({ cls: 'kbw-form-hint' });
  linkStatus.setAttribute('data-capture', 'status');

  // ── 落点 ─────────────────────────────────────────────────────
  const sel = el('select', { cls: 'kbw-select' });
  sel.setAttribute('data-capture', 'target');
  const boardTargets = targets.filter((t) => !t.key.startsWith('dir:'));
  const dirTargetList = targets.filter((t) => t.key.startsWith('dir:'));
  const addGroup = (label: string, list: CaptureTarget[]): void => {
    if (list.length === 0) return;
    const g = el('optgroup', { attr: { label } });
    for (const t of list) {
      g.appendChild(
        el('option', {
          attr: { value: t.key, disabled: t.disabled ? 'disabled' : null },
          text: t.label,
        }),
      );
    }
    sel.appendChild(g);
  };
  addGroup('丢进板块', boardTargets);
  addGroup('直接选目录', dirTargetList);
  sel.value = first?.key ?? '';

  const detail = div({ cls: 'kbw-form-hint' });
  const paintDetail = (): void => {
    const t = byKey.get(sel.value);
    detail.textContent = t ? t.detail : '';
  };
  sel.addEventListener('change', paintDetail);
  paintDetail();

  // ── 组装 ─────────────────────────────────────────────────────
  const form = div({ cls: 'kbw-form' });
  const row1 = div({ cls: 'kbw-form-row is-plain' });
  row1.appendChild(span({ cls: 'kbw-form-label', text: '标题' }));
  const c1 = div({ cls: 'kbw-form-ctl' });
  c1.appendChild(title);
  row1.appendChild(c1);

  const row2 = div({ cls: 'kbw-form-row is-plain' });
  row2.appendChild(span({ cls: 'kbw-form-label', text: '链接' }));
  const c2 = div({ cls: 'kbw-form-ctl' });
  c2.appendChild(link);
  c2.appendChild(linkStatus);
  row2.appendChild(c2);

  const row3 = div({ cls: 'kbw-form-row is-plain' });
  const targetLabel = span({ cls: 'kbw-form-label', text: '丢给' });
  row3.appendChild(targetLabel);
  const c3 = div({ cls: 'kbw-form-ctl' });
  const pick = div({});
  pick.appendChild(sel);
  pick.appendChild(detail);
  /**
   * 剪藏态的静态落点行（拍板 Q1：**剪藏固定落收件箱**）——
   * 与下拉**同一格互换**：位置不跳动，"丢给谁"这个格子一直在。
   */
  const clipInfo = div({
    cls: 'kbw-form-hint',
    text: `收件箱（${inbox || '库根'}）—— 剪藏固定：先收进来，归类以后再说`,
  });
  clipInfo.style.display = 'none';
  c3.appendChild(pick);
  c3.appendChild(clipInfo);
  row3.appendChild(c3);

  form.appendChild(row1);
  form.appendChild(row2);
  form.appendChild(row3);
  h.body.appendChild(form);

  h.foot.style.display = '';
  let busy = false;
  const go = btn({
    cls: 'kbw-btn is-primary',
    text: '丢一条',
    on: { click: () => void run() },
  });
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn', text: '取消', on: { click: () => h.close('cancel') } }));
  h.foot.appendChild(go);

  // ── 剪藏状态机（面板内的那一小份）────────────────────────────
  let phase: ClipPhase = 'idle';
  let lastResult: { url: string; r: ClipResult } | null = null;
  let inflight: { url: string; p: Promise<ClipResult> } | null = null;
  let seq = 0;

  const clipping = (): boolean => looksLikeUrl(link.value);
  /** 落点行切静态信息 + 主按钮跟着档位改名（拍板稿里的「剪藏 / 只存链接」） */
  const applyMode = (): void => {
    const on = clipping();
    targetLabel.textContent = on ? '落点' : '丢给';
    pick.style.display = on ? 'none' : '';
    clipInfo.style.display = on ? '' : 'none';
    go.textContent = !on ? '丢一条' : phase === 'bad' ? '只存链接' : '剪藏';
  };

  const paintStatus = (url: string, r: ClipResult): void => {
    if (!clipping() || lastResult?.url !== url) return; // 链接已经又变了 → 这次结果不画
    if (r.kind === 'ok') {
      linkStatus.textContent = r.title
        ? '✓ 已抓到正文；标题用的是网页的（要改就改）'
        : '✓ 已抓到正文（网页没给标题，名字保留你填的）';
      linkStatus.className = 'kbw-form-hint is-ok';
    } else {
      linkStatus.textContent = `⚠ 没抓到正文（${r.reason}）—— 会只存标题和链接`;
      linkStatus.className = 'kbw-form-hint is-warn';
    }
  };

  /** 抓一次（同 URL 的在飞请求复用；回来后只有"还是当前 URL"才画状态） */
  async function fetchClip(url: string): Promise<ClipResult> {
    if (inflight?.url === url) return inflight.p;
    const my = ++seq;
    phase = 'fetching';
    applyMode();
    linkStatus.textContent = '正在抓取页面…（最多等 8 秒）';
    linkStatus.className = 'kbw-form-hint';
    const p = clipUrl(url);
    inflight = { url, p };
    const r = await p;
    if (inflight?.p === p) inflight = null;
    if (my === seq) {
      lastResult = { url, r };
      phase = r.kind === 'ok' ? 'ok' : 'bad';
      // 抓到了就顺手把标题填上 —— 只填"用户没动过"的
      if (r.kind === 'ok' && !titleTouched && r.title) title.value = r.title;
    }
    applyMode();
    paintStatus(url, r);
    return r;
  }

  /** 链接一变就（防抖后）抓：不是网址就整段收起（回普通捕获态） */
  let dbTimer: number | null = null;
  const onUrlChanged = (immediate: boolean): void => {
    if (dbTimer != null) {
      window.clearTimeout(dbTimer);
      dbTimer = null;
    }
    const url = link.value.trim();
    if (!looksLikeUrl(url)) {
      lastResult = null;
      inflight = null;
      seq += 1; // 让在飞的结果回来也不画
      phase = 'idle';
      linkStatus.textContent = '';
      linkStatus.className = 'kbw-form-hint';
      applyMode();
      return;
    }
    applyMode();
    if (lastResult?.url === url) return; // 这个地址已经抓过了
    const fire = (): void => void fetchClip(url);
    if (immediate) fire();
    else dbTimer = window.setTimeout(fire, 400);
  };
  link.addEventListener('input', () => onUrlChanged(false));
  /**
   * **粘到面板哪儿都算**：认出整串是网址就把它路由到链接行（防"标题框里选着日期，
   * 一 Ctrl+V 把 URL 粘进标题"）。面板内的粘贴都要过这里 —— 所以挂在模态根上。
   */
  h.root.addEventListener('paste', (evt) => {
    const text = (evt as ClipboardEvent).clipboardData?.getData('text') ?? '';
    if (!looksLikeUrl(text)) return;
    evt.preventDefault();
    link.value = text.trim();
    onUrlChanged(true);
  });
  h.disposer.add(() => {
    if (dbTimer != null) window.clearTimeout(dbTimer);
  });

  // ── 落盘 ─────────────────────────────────────────────────────
  /** 剪藏的正文：首行留原链接（拍板稿），抓到了再接正文 */
  const clipBody = (url: string, name: string, r: ClipResult): string => {
    const label = r.kind === 'ok' && r.title ? r.title : name;
    const lead = `[${label}](${url})`;
    return r.kind === 'ok' && r.text ? `${lead}\n\n${r.text}` : lead;
  };

  async function run(): Promise<void> {
    if (busy) return;
    const name = title.value.trim();
    if (!name) {
      notifyError('先给它起个名字');
      title.focus();
      return;
    }
    busy = true;
    go.toggleAttribute('disabled', true);
    try {
      if (clipping()) {
        const url = link.value.trim();
        /**
         * 没抓过 / 还在飞 → **现场等这一次**（按钮永远管用，不必先等状态行转完）。
         * ⚠️ 剪藏**不写 `lastCapture`**：落点是固定的收件箱，记下来只会把
         * 用户常用的板块落点顶掉。
         */
        const r = lastResult?.url === url ? lastResult.r : await fetchClip(url);
        /**
         * 🔴 **名字要"现读"，别用进门前抄的那份**（独立审 2026-10-04 🔴1）：
         * "粘贴 → 立刻回车"是主路径（面板自己的提示语就是"回车丢一条"），而抓取
         * 可能刚在这段等待里把标题改成网页标题 —— 用旧值的话文件名会是默认日期，
         * 而正文首行却用网页标题，自相矛盾。`fetchClip` 只在"用户没动过标题"时才写
         * 标题框，所以**以框里的现值为准**两边就一致了。
         */
        const finalName = title.value.trim() || name;
        const res = await ctx.completion.createNote({
          title: finalName,
          dirRel: inbox,
          noTemplate: true,
          body: clipBody(url, finalName, r),
          bodyFrom: '剪藏',
          extraProps: { props: { 来源: url } },
        });
        // 16.13（P7.2d）：剪藏成功 = 建过第一篇笔记（降级成"只存链接"也算 —— 笔记真建了）
        recordOnboarding(ctx, 'created');
        if (r.kind === 'ok') {
          notify({
            kind: 'success',
            text: `已剪藏「${finalName}」`,
            detail: `${res.path} · 抓到了正文，来源记在属性里`,
            ms: NOTIFY_MS.library,
          });
        } else {
          notify({
            kind: 'info',
            text: '已存进收件箱（没抓到正文）',
            detail: `${res.path} · 只存了标题和链接：${r.reason}`,
            ms: NOTIFY_MS.library,
          });
        }
        h.close('created');
        return;
      }
      const t = byKey.get(sel.value);
      if (!t || t.disabled) {
        notifyError('这个落点现在用不了', t?.detail ?? '选一个别的');
        busy = false;
        go.toggleAttribute('disabled', false);
        return;
      }
      const res = await ctx.completion.createNote({
        title: name,
        dirRel: t.dirRel,
        /** ⚠️ 属性/标签在**补全流程末尾**才写（先写前言会让 Templater 不触发） */
        extraProps: { props: t.props, tags: t.tags },
      });
      // 16.13（P7.2d）：快捕成功 = 建过第一篇笔记（与新建对话框 / 剪藏同一件事）
      recordOnboarding(ctx, 'created');
      void ctx.settings.save({ lastCapture: t.key });
      notify({
        kind: 'success',
        text: `已丢进「${t.label}」`,
        detail: `${res.path} · ${describeTarget(t)}`,
        ms: NOTIFY_MS.library, // 动库成功 = 3s
      });
      h.close('created');
    } catch (e) {
      notifyError(clipping() ? '剪藏没落下去' : '丢不进去', e instanceof Error ? e.message : String(e));
      busy = false;
      go.toggleAttribute('disabled', false);
    }
  }

  const onEnter = (evt: Event): void => {
    if ((evt as KeyboardEvent).key === 'Enter') {
      evt.preventDefault();
      void run();
    }
  };
  title.addEventListener('keydown', onEnter);
  link.addEventListener('keydown', onEnter);

  applyMode();
  title.focus();
  title.select();
}
