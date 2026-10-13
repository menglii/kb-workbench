/**
 * ui/fm-repair-panel.ts —— **「修前言」面板**（P7.16 · #3，拍定 D5/Q3）
 *
 * 为什么有它：前言里有嵌套映射（多半是没加引号的占位符）的篇，被写口守卫整篇拦下
 * ——属性改不了 / 补全补不了 / 迁移跳过 / 声明跟随写不进，而报告面原先没有旗标。
 * P7.16 起这类篇带 `fragile-fm` 旗标（首页「坏前言」那行 ① 也开这个面板）。
 *
 * 两条修法（一张卡一篇）：
 *   · **确定性**（底栏「修能修的 N 篇」）：按行改 —— 整行裸占位符（`创建日期: {{date}}`）
 *     → 加引号存。批量一次确认；写盘在 `vault.process` 回调里**拿当刻文本重算**（幂等，
 *     照 `migrate` / 修链的口径）；正文一个字节不动。
 *   · **AI 档**（卡上的「✦ AI 修这一篇」，只在该篇有"认不得"的键时画）：
 *     `ctx.ai.fixFrontmatter`（材料 = 前言原文 + 键名清单）→ **预览对比**（坏稿 → 修稿）
 *     → 确认 → 快照 → 整段换前言。AI 没有直写权（§11）：只出文本，落盘在你确认之后的链里。
 *
 * 一律**不走 `fm.setMany` / `processFrontMatter`**（守卫就是为这类前言设的、往返还会
 * 把形状弄坏）——读原文 → 改文本 → `vault.process` 写回，前后文一个字节不动
 *（成对判据在 `tests/specs/p716.ts`：正文逐字节比对）。
 *
 * ⚠️ 卡片视觉**有意复用 `.kbw-title-*` 那组类**（styles/suggest.css）：与修链/起标题
 * 同属"逐卡片"族、样式要求一致 —— 各写一份 CSS 必漂（"两处各写一份"的老教训）。
 * 面板给的是 `openModal`（不是浮层小窗）：它是"逐篇过一遍"的工作面板，与修链同款。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { joinPath, relativeTo } from '../core/paths';
import { markSelfWrite } from '../core/writes';
import { fragileKeys } from '../services/schema';
import { fixBarePlaceholders, frontmatterInnerOf, replaceFmInner, type FmLineFix } from '../services/fm-repair';
import { AiError, AI_PROTECTED_WHY, isAiProtected, usageLineFor } from '../services/ai';
import { btn, div, span } from './primitives';
import { openModal, type PanelHandle } from './panel';
import { confirm, type PlanRow } from './confirm';
import { diffBox } from './diff-box';
import { restoreOrNotify, showUndo } from './undo-bar';
import { AI_NOT_CONFIGURED } from './suggest-panel';
import { NOTIFY_MS, notify, notifyError, notifyLight } from './notify';

interface FmRow {
  /** 相对库根 */
  rel: string;
  title: string;
  /** 坏在哪些键（`fragileKeys` 口径，与守卫同一份判据） */
  keys: string[];
  /** 文本层认得出的确定性修（改完这一批为空 = 幂等） */
  fixes: FmLineFix[];
  /** 读时刻的全文（AI 挡的预览与写入比对锚） */
  text: string;
  /** AI 硬拦（保护目录；旗标本就不会给它亮，这里只是防御） */
  blockedWhy: string;
}

/**
 * @param opts.only **只服务这几篇**（库内绝对路径；P7.23 批量栏「AI 处理 › → 修前言」——
 *   与「AI 起标题」的 `only` 同一条通道）。不给 = 老路一个字不变（全库按旗标收篇）。
 * ⚠️ 名单只当**收窄**用：这 N 篇里没带 `fragile-fm` 旗标的照旧不进（旗标是唯一判据）。
 */
export function openFmRepairPanel(
  ctx: WorkbenchContext,
  opts: { only?: string[] } = {},
): PanelHandle {
  const h = openModal({ title: '修前言', width: 'wide' });
  const kbRoot = ctx.settings.kbRoot();
  const protectedAbs = ctx.ai.protectedDir();
  const onlySet = opts.only ? new Set(opts.only) : null;

  let rows: FmRow[] = [];
  let busy: '' | 'scan' | 'run' | 'ai' = '';
  /** 出错 / 未配置（**必须可见**的一句，红字 —— §11 安全例外） */
  let errNote = '';
  /** AI 用量的展示串（底栏右端；空 = 不占位） */
  let usageText = '';
  /** 出稿中/修中时，卡上那句状态提示（只贴在做 AI 的那张卡上） */
  let statusHint = '';
  let activeAiRel = '';

  const body = h.body;
  body.classList.add('kbw-title');
  const noteEl = div({ cls: 'kbw-title-note' });
  body.appendChild(noteEl);
  const listHost = div({ cls: 'kbw-title-list' });
  body.appendChild(listHost);
  const bar = div({ cls: 'kbw-title-bar' });
  body.appendChild(bar);
  const usageEl = span({ cls: 'kbw-title-usage' });

  function paintUsage(): void {
    usageEl.textContent = usageText;
    usageEl.classList.toggle('is-hidden', usageText === '');
  }

  function renderStatus(): void {
    noteEl.textContent = errNote;
    noteEl.classList.toggle('is-hidden', errNote === '');
    noteEl.classList.toggle('is-bad', errNote !== '');
  }

  const relOf = (e: { path: string }): string => relativeTo(e.path, kbRoot);
  const fileOf = (rel: string): TFile | null => {
    const f = ctx.app.vault.getAbstractFileByPath(joinPath(kbRoot, rel));
    return f instanceof TFile ? f : null;
  };

  /** 面板按旗标收篇（非模板 / 非保护目录由旗标判定保证）＋ 现读文本算确定性修 */
  async function scan(): Promise<FmRow[]> {
    const entries = ctx.index
      .notes()
      .filter((e) => e.flags.includes('fragile-fm') && (!onlySet || onlySet.has(e.path)))
      .sort((a, b) => b.mtime - a.mtime);
    const out: FmRow[] = [];
    for (const e of entries) {
      const rel = relOf(e);
      if (!rel || rel === e.path) continue;
      let text = '';
      try {
        text = await ctx.app.vault.cachedRead(e.file);
      } catch {
        continue; // 读不到（刚被搬走/删）→ 跳过；旗标下次重扫自会摘
      }
      out.push({
        rel,
        title: e.basename,
        keys: fragileKeys(e.props),
        fixes: fixBarePlaceholders(text).fixes,
        text,
        blockedWhy: isAiProtected(e.path, protectedAbs) ? AI_PROTECTED_WHY : '',
      });
    }
    return out;
  }

  function renderList(): void {
    listHost.textContent = '';
    if (busy === 'scan') {
      listHost.appendChild(div({ cls: 'kbw-title-muted', text: '扫前言中…' }));
      return;
    }
    if (rows.length === 0) {
      listHost.appendChild(
        div({ cls: 'kbw-suggest-empty', text: '没有坏前言了（可能刚被别处修过）' }),
      );
      return;
    }
    for (const row of rows) {
      const rowEl = div({ cls: ['kbw-title-row', row.blockedWhy !== '' ? 'is-blocked' : null] });
      const head = div({ cls: 'kbw-title-rowhead' });
      head.appendChild(span({ cls: 'kbw-title-cur', text: `《${row.title}》` }));
      head.appendChild(span({ cls: 'kbw-title-rel', text: row.rel, attr: { title: row.rel } }));
      rowEl.appendChild(head);
      rowEl.appendChild(
        div({ cls: 'kbw-fmrep-bad', text: `坏在：${row.keys.join('、') || '整份前言'}` }),
      );
      if (row.fixes.length > 0) {
        const lines = row.fixes.slice(0, 2).map((f) => `${f.from} → ${f.to}`).join('；');
        const more = row.fixes.length > 2 ? `（等 ${row.fixes.length} 处）` : '';
        rowEl.appendChild(div({ cls: 'kbw-fmrep-plan', text: `能当场修：${lines}${more}` }));
      }
      /** 「认不得」= 坏的键里没被确定性修覆盖的那些（它们的形状只能交给 AI） */
      const unresolved = row.keys.filter((k) => !row.fixes.some((f) => f.key === k));
      if (unresolved.length > 0) {
        rowEl.appendChild(
          div({ cls: ['kbw-fmrep-plan', 'is-ai'], text: `认不得：${unresolved.join('、')}` }),
        );
        const acts = div({ cls: 'kbw-fmrep-acts' });
        const aiBtn = btn({
          cls: ['kbw-btn', 'is-small', busy !== '' ? 'is-disabled' : null],
          text: busy === 'ai' ? 'AI 出稿中…' : '✦ AI 修这一篇',
          on: { click: () => void runAiFix(row) },
        });
        if (busy !== '' || !ctx.ai.isConfigured() || row.blockedWhy !== '') {
          aiBtn.setAttribute('disabled', 'true');
        }
        if (row.blockedWhy !== '') aiBtn.title = row.blockedWhy;
        else if (!ctx.ai.isConfigured()) aiBtn.title = AI_NOT_CONFIGURED;
        else aiBtn.title = '让 AI 把这段前言修回扁平形状（出稿 → 预览对比 → 你确认才写）';
        acts.appendChild(aiBtn);
        rowEl.appendChild(acts);
      }
      if (statusHint !== '' && busy === 'ai' && row.rel === activeAiRel) {
        rowEl.appendChild(div({ cls: 'kbw-title-muted', text: statusHint }));
      }
      listHost.appendChild(rowEl);
    }
  }

  /** 底栏 = 「修能修的 N 篇」（确定性批量；N = 有 fixes 的篇数） */
  function updateBar(): void {
    bar.textContent = '';
    const fixable = rows.filter((r) => r.fixes.length > 0);
    const run = btn({
      cls: ['kbw-btn', 'is-primary', fixable.length === 0 ? 'is-disabled' : null],
      text: busy === 'run' ? '修中…' : `修能修的 ${fixable.length} 篇`,
      on: { click: () => void runDeterministic() },
    });
    if (fixable.length === 0 || busy !== '') run.setAttribute('disabled', 'true');
    run.title = '把认得出形状的裸占位符加引号存（只加引号、不动正文）';
    bar.appendChild(run);
    paintUsage();
    bar.appendChild(usageEl);
  }

  async function captureSnapshot(reason: string, files: TFile[]): Promise<string> {
    const snap = await ctx.snapshot.capture({ reason, files });
    return snap.id;
  }

  // ── 确定性批量：确认流 → 快照 → 逐篇 vault.process（回调里重算，幂等）──
  async function runDeterministic(): Promise<void> {
    if (busy !== '') return;
    const planned = rows.filter((r) => r.fixes.length > 0);
    if (planned.length === 0) return;
    try {
      const preview: PlanRow[] = planned.map((r) => ({
        kind: 'set' as const,
        prop: `《${r.title}》前言`,
        from: `${r.fixes.map((f) => f.key).join('、')}：裸占位符`,
        to: '加引号存',
        count: 1,
      }));
      const res = await confirm({
        title: `修 ${planned.length} 篇的前言（只加引号，不动正文）？`,
        preview,
        warnings: [],
        notes: [
          '只动认得出形状的那几行：把裸占位符（没加引号的 {{…}}）加引号存 —— YAML 才不会把它解析成嵌套映射',
          '正文一个字符不动；执行前自动快照，可一键还原',
        ],
        primary: { label: `修这 ${planned.length} 篇` },
      });
      if (res.action !== 'primary') return;

      let snapId = '';
      try {
        const files = planned
          .map((r) => fileOf(r.rel))
          .filter((f): f is TFile => f !== null);
        if (files.length === 0) {
          notifyLight('这些篇都不在原位了', '重开面板再扫一次');
          return;
        }
        snapId = await captureSnapshot(`修前言：${planned.length} 篇（裸占位符加引号）`, files);
      } catch (e) {
        notifyError('快照失败，已中止（一个字节都没写）', e instanceof Error ? e.message : String(e));
        return;
      }

      busy = 'run';
      renderList();
      updateBar();
      /** 每篇真改掉几处（process 回调里现算；0 = 这段时间里已经不在/已被改过 → 跳过） */
      const applied = new Map<string, number>();
      /**
       * 每篇**写时实际引用起来的键**（收尾摘卡用它，不用"扫描时刻的计划键"）——
       * 独立审 🟡：并发改过时"计划里没列、写时才冒出来"的键也算真修掉了，
       * 而计划里列了、写时已经不匹配的键不该被当成修好。
       */
      const writtenKeys = new Map<string, string[]>();
      for (const r of planned) {
        const f = fileOf(r.rel);
        if (!f) continue;
        markSelfWrite(f.path);
        try {
          await ctx.app.vault.process(f, (cur) => {
            /**
             * ⚠️ **回调里拿当刻文本重算**（与 `migrate` / 修链同一条：幂等）——
             * 只认得出形状的行会被引用起来，认不出的一处不动。
             */
            const { text: next, fixes } = fixBarePlaceholders(cur);
            applied.set(r.rel, fixes.length);
            writtenKeys.set(
              r.rel,
              fixes.map((x) => x.key),
            );
            return next;
          });
        } catch (e) {
          applied.set(r.rel, 0);
          console.error('[经纬] 修前言写盘失败（这一篇跳过，其余继续）', r.rel, e);
        }
      }
      const done = planned.filter((r) => (applied.get(r.rel) ?? 0) > 0);
      const goneRows = planned.filter((r) => (applied.get(r.rel) ?? 0) === 0);
      if (goneRows.length > 0) {
        notifyLight(
          `${goneRows.length} 篇执行时已经不在原位（或已被修过）`,
          goneRows[0] ? `《${goneRows[0].title}》` : '',
        );
      }
      if (done.length > 0) {
        const logged = await ctx.report.log({
          action: '修前言',
          result: goneRows.length > 0 ? 'partial' : 'ok',
          source: 'batch',
          summary: `修前言：${done.length} 篇（裸占位符加引号存）`,
          snapshotId: snapId,
          extra: '不走属性写口：读原文 → 按行改 → vault.process（正文不动）',
        });
        if (!logged) notifyLight('这次的修前言日志没写进库', '（操作本身已完成，见控制台）');
        showUndo({
          text: `已修 ${done.length} 篇的前言`,
          detail: '撤销 = 从操作前的快照还原（引号改回原样）',
          onUndo: () => {
            void restoreOrNotify(ctx.snapshot, snapId).then((r) => {
              if (r) notifyLight('已还原这次修前言');
            });
          },
          onView: () => void ctx.report.openLatest(),
          onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
        });
      }
      /**
       * 收尾：把"**写时实际改掉**的那几处"从卡上摘掉（用 `writtenKeys`，不是扫描时刻的
       * 计划键）——还剩"认不得"的键 → 卡片留在清单里（卡上是 AI 按钮）；全清 → 摘卡。
       * ⚠️ **别去重读文本再算**：索引/缓存此刻还没跟上（~300ms 滞后），
       * 拿旧 props 会把刚修好的键又算成"认不得" —— 以"我们改了什么"为准最诚实。
       */
      for (const r of done) {
        const covered = new Set(writtenKeys.get(r.rel) ?? []);
        r.keys = r.keys.filter((k) => !covered.has(k));
        r.fixes = [];
        r.text = '';
      }
      rows = rows.filter((r) => r.keys.length > 0);
      notify({ kind: 'info', text: `${done.length} 篇的前言已修`, ms: NOTIFY_MS.light });
    } catch (e) {
      // 顶层兜底：任一步真抛出都不许"点了没反应"（与 beautify A3 / 修链 🟢4 同款）
      notifyError('修前言没走完', `${e instanceof Error ? e.message : String(e)}（已写入的部分可在快照面板还原）`);
    } finally {
      busy = '';
      renderList();
      updateBar();
    }
  }

  // ── AI 档（逐篇）：出稿 → 预览对比 → 确认 → 快照 → 替这整段前言 ──
  async function runAiFix(row: FmRow): Promise<void> {
    if (busy !== '') return;
    if (row.blockedWhy !== '') {
      notifyLight(row.blockedWhy);
      return;
    }
    if (!ctx.ai.isConfigured()) {
      errNote = AI_NOT_CONFIGURED;
      renderStatus();
      return;
    }
    busy = 'ai';
    statusHint = 'AI 出稿中…';
    activeAiRel = row.rel;
    errNote = '';
    renderStatus();
    renderList();
    updateBar();
    try {
      const f = fileOf(row.rel);
      if (!f) {
        notifyLight('这一篇不在原位了', '重开面板再扫一次');
        return;
      }
      /**
       * 出稿 + 预览 + 写盘**都以服务层那次读为准**（`out.innerBefore`）——
       * 独立审 🟡：面板自己再读一份的话，"校验过的稿子"与"写时认的原文"会不同源
       * （两次读之间被改过又改回，理论上可以丢一个键）。口径只有一处：服务层。
       */
      const out = await ctx.ai.fixFrontmatter({ rel: row.rel });
      const cfg = ctx.settings.get().ai;
      usageText = out.usage ? usageLineFor(cfg, 'fix-fm', out.usage) : '';
      const res = await confirm({
        title: `用 AI 的修复稿替换「${row.title}」的前言？`,
        preview: [
          {
            kind: 'set',
            prop: '前言',
            from: `${row.keys.join('、')}（嵌套映射）`,
            to: '修好的前言',
            count: 1,
          },
        ],
        warnings: [],
        notes: ['只换前言这一段；正文一个字节不动', '执行前自动快照，可一键还原'],
        primary: { label: '替换前言' },
        attach: (host) => host.appendChild(diffBox(out.innerBefore, out.inner)),
      });
      if (res.action !== 'primary') return;

      let snapId = '';
      try {
        snapId = await captureSnapshot(`修前言（AI）：${row.title}`, [f]);
      } catch (e) {
        notifyError('快照失败，已中止（一个字节都没写）', e instanceof Error ? e.message : String(e));
        return;
      }
      let wrote = false;
      let headChanged = false;
      markSelfWrite(f.path);
      await ctx.app.vault.process(f, (cur) => {
        /**
         * 防呆（照「美化笔记」的②）：确认期间前言又被别处改过 → **不覆盖**，
         * 原文原样返回；出来给一句"重看一眼"。比对锚 = 服务层出稿依据那一版
         * （`out.innerBefore`），与校验、与预览**同源**。
         */
        // 走 splitFrontmatter 的同一判据（与 innerBefore 的口径一致）
        const curInner = frontmatterInnerOf(cur);
        if (curInner == null || curInner !== out.innerBefore) {
          headChanged = true;
          return cur;
        }
        const r = replaceFmInner(cur, out.inner);
        if (r.ok) wrote = true;
        return r.ok ? r.text : cur;
      });
      if (headChanged) {
        notifyLight('前言刚被别处改过，没有覆盖', '再看一眼原文，重新发起一次修复');
        return;
      }
      if (!wrote) {
        notifyError('替换没成功（原件没动）', '前言段没认出来，或新稿混进了围栏行');
        return;
      }
      const logged = await ctx.report.log({
        action: '修前言',
        result: 'ok',
        source: 'ai',
        /**
         * ⚠️ `ai: true` 要**自己传**（与修链同款）：漏了的话日志里少一行
         * 「这条是 AI 建议的」（§11.1 边界④的留痕）。
         */
        ai: true,
        summary: `修前言（AI）：《${row.title}》前言整段替换`,
        snapshotId: snapId,
        extra: 'AI 出文本、确认后整段换（不走属性写口；正文不动）',
      });
      if (!logged) notifyLight('这次的修前言日志没写进库', '（操作本身已完成，见控制台）');
      showUndo({
        text: `已修《${row.title}》的前言`,
        detail: '撤销 = 从操作前的快照还原（前言换回原样）',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, snapId).then((r) => {
            if (r) notifyLight('已还原这次修前言');
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
      /** 修完摘卡（校验已过：键一个不少、坏形状没了；真没修干净的话旗标会留着） */
      rows = rows.filter((r) => r !== row);
    } catch (e) {
      const why = e instanceof AiError ? e.hint : e instanceof Error ? e.message : String(e);
      errNote = `没修出来（原件没动）：${why}`;
      renderStatus();
    } finally {
      busy = '';
      statusHint = '';
      activeAiRel = '';
      renderList();
      updateBar();
    }
  }

  // 首屏：异步扫（读每篇文本算确定性修）——期间画"扫前言中…"
  busy = 'scan';
  renderStatus();
  renderList();
  updateBar();
  void scan()
    .then((out) => {
      rows = out;
    })
    .catch((e) => {
      errNote = `扫前言失败：${e instanceof Error ? e.message : String(e)}`;
      renderStatus();
    })
    .finally(() => {
      busy = '';
      renderList();
      updateBar();
    });
  return h;
}
