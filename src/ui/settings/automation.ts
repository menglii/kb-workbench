/**
 * ui/settings/automation.ts —— 设置 · **自动化**栏（交互规格 §7.1）
 *
 * 五项，逐条对应 §7.1 那张表：
 *   新建笔记补全（开关 + 套用规则 + 当前模板 + 占位符）
 *   自动归位（触发条件 + 排除；⚠️ v2 起「启用」开关退役 —— 显式改 = 直接搬）
 *   位置锁定（只读说明）
 *   一键补全存量笔记（§13 的入口就在这一栏）
 *
 * 开关写的是**库内** `06_工作台/自动化.json`（唯一真源）；模块开关是另一层，
 * 关着的时候这一栏顶上会说明白 —— 两层都开才动（见 `services/automation.ts` 的头注释）。
 */
import type { WorkbenchContext } from '../../core/context';
import { isInside, relativeTo } from '../../core/paths';
import {
  DEFAULT_NAMING_TEMPLATE,
  NAMING_TOKENS,
  isNamingTemplateOk,
  namingIssues,
  renderNamingTemplate,
  resolveNamingTemplate,
} from '../../core/naming';
import { PLACEHOLDERS, templateFiles } from '../../services/templates';
import { planBackfillOf, planTodoCount } from '../../services/backfill';
import { multiSelect, btn, div, el } from '../primitives';
import { notifyLight, notify, NOTIFY_MS } from '../notify';
import { openBackfillPanel } from '../backfill-panel';
import { openRebuildPanel } from '../rebuild-panel';
import {
  chip,
  emptyLine,
  ghostBtn,
  group,
  iconTextBtn,
  note,
  readRow,
  row,
  selectCtl,
  setTitle,
  statusLine,
  switchCtl,
  toolbar,
} from './kit';
import type { SectionApi, SettingsSection } from './types';

export function makeAutomationSection(): SettingsSection {
  return {
    id: 'automation',
    label: '自动化',
    icon: 'zap',
    sub: '新建补全 · 自动归位 · 存量补全',
    render(host, api) {
      void paint(host, api);
    },
  };
}

async function paint(host: HTMLElement, api: SectionApi): Promise<void> {
  const ctx = api.ctx;
  /**
   * ⚠️ **给用户看的文案一律不解析 Markdown**：不许出现反引号、也不许拿 `` 当加粗
   *（P6⑤ 把七栏的用户可见文案过了一遍，一共去掉 12 处 —— 独立审查 A4 指出
   * 第一版只改了本行这一处、还写了句「全仓库唯一一处」的错话）。
   */
  host.appendChild(setTitle('自动化', '库内配置：99_Meta/06_工作台/自动化.json（跟着库走，可手改）'));

  /**
   * 模块开关（粗粒度那一层）—— ⚠️ **两项各归自己的那个**：
   * 「自动归位」看 `modules.automation`（默认关）·「新建笔记补全」看 `modules.completion`（默认开）。
   * 原来这里写的是"整个自动化模块关着 → 下面两项都不会动"，与代码不符
   * （补全照样生效）—— 独立审查指出后按代码口径改了文案。
   */
  if (!ctx.gate.isOn('automation')) {
    host.appendChild(
      note('「自动归位」的模块开关关着 —— 它不会动；下面「新建笔记补全」那组不受影响。', 'warn'),
    );
    host.appendChild(
      toolbar(
        btn({
          cls: 'kbw-btn is-small',
          text: '打开模块开关',
          on: { click: () => ctx.openNativeSettings() },
        }),
      ),
    );
  }
  if (!ctx.gate.isOn('completion')) {
    host.appendChild(note('「新建笔记补全」的模块开关关着 —— 新笔记不会被补。', 'warn'));
  }

  // 读不出来时提示一句：文件可能被手改坏了，改一下开关就会**覆盖**它（照「目录映射」栏那句）
  let autoBroken: string | null = null;
  try {
    const raw = await ctx.configs.read('automation');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const c = (raw as { completion?: unknown }).completion;
      if (c !== undefined && (typeof c !== 'object' || c === null)) {
        autoBroken = '「completion」段不是对象';
      }
    }
  } catch (e) {
    autoBroken = e instanceof Error ? e.message : String(e);
  }
  const auto = await ctx.automation.get();
  if (autoBroken) {
    host.appendChild(
      note(`读自动化.json 时有问题（${autoBroken}）—— 下面显示的是默认值，改一下就会覆盖文件。`, 'warn'),
    );
  }

  // ── 新建笔记补全 ───────────────────────────────────────────
  host.appendChild(group('新建笔记补全', '新建空白笔记时按模板补前言与尾部双链'));
  host.appendChild(
    row(
      // E2：组标题已经写着"新建笔记补全"，这一行只负责那个开关（同名并排 = 层次看着重复）
      '启用',
      switchCtl(auto.completion.enabled, (v) => {
        void ctx.automation.patch({ completion: { enabled: v } }).then(() => {
          notifyLight(v ? '新建补全已开' : '新建补全已关');
          api.rerender();
        });
      }),
      '默认开。关掉之后新建笔记不再补任何东西',
    ),
  );
  host.appendChild(
    readRow(
      '套用规则',
      '标签规则 → 文件夹规则（最长前缀优先）→ 当前模板兜底',
      '「文件夹规则」读的是 Templater 的目录模板配置（同一个来源，不会漂）',
    ),
  );

  const tpls = templateFiles(ctx.app, ctx.settings);
  const tplOptions = tpls.map((f) => ({ value: f.basename, label: f.basename }));
  const curTpl = auto.completion.defaultTemplate;
  if (tplOptions.length === 0) {
    host.appendChild(row('当前模板', null, '模板库目录里一个模板都没有'));
    host.appendChild(emptyLine(`模板库目录：${ctx.settings.templateDir()}`));
  } else {
    if (!tplOptions.some((o) => o.value === curTpl)) {
      tplOptions.unshift({ value: curTpl, label: `${curTpl}（不在模板库里）` });
    }
    host.appendChild(
      row(
        '当前模板',
        selectCtl(curTpl, tplOptions, (v) => {
          void ctx.automation.patch({ completion: { defaultTemplate: v } }).then(() => {
            notifyLight(`当前模板改为 ${v}`);
          });
        }),
        '兜底用的那一个：前两条规则都没命中时用它',
      ),
    );
  }

  const phBox = div({ cls: 'kbw-set-chips' });
  for (const ph of PLACEHOLDERS) {
    phBox.appendChild(
      chip(ph, false, () => {
        void copyText(ph).then((ok) => {
          notify({ kind: ok ? 'success' : 'info', text: ok ? `已复制 ${ph}` : `复制失败，手动抄一下：${ph}`, ms: NOTIFY_MS.light });
        });
      }, '点一下复制'),
    );
  }
  host.appendChild(row('占位符', phBox, '写进模板的正文会按它替换；求不到值的原样留着（看得见才好修）'));
  host.appendChild(
    toolbar(
      iconTextBtn('clipboard', '复制全部', () => {
        void copyText(PLACEHOLDERS.join(' ')).then((ok) => {
          if (ok) notifyLight('已复制 6 个占位符');
        });
      }),
    ),
  );

  // ── 新建笔记的命名（1.4 的 ①管理面板 + ③变量帮助，P7.2b）──────
  /**
   * ⚠️ **这一组落的是插件 `data.json`**（本机界面偏好），而这一栏其余部分落**库内** JSON ——
   * 分组说明里把这点写明，免得用户以为它跟库走（2b 开工提示词拍的口径）。
   */
  host.appendChild(
    group('新建笔记的命名', '只影响「新建笔记」对话框的默认名 —— 本机偏好（不进库、不跟同步）'),
  );
  {
    const input = el('input', {
      cls: 'kbw-input',
      attr: {
        type: 'text',
        spellcheck: 'false',
        placeholder: DEFAULT_NAMING_TEMPLATE,
        value: resolveNamingTemplate(ctx.settings.get()),
      },
    });
    const prev = div({ cls: 'kbw-name-prev' });
    const warn = div({ cls: 'kbw-name-warn' });
    const chips = div({ cls: 'kbw-name-chips' });
    const explain = div({ cls: 'kbw-name-explain' });
    explain.style.display = 'none';

    /**
     * 现读现算：预览 + 三类问题（空 / 未知变量 / Windows 禁字）一起刷新。
     * ⚠️ 用 **trim 过的值**算（与落盘那一侧同口径，独立审 2026-10-03 🟢7）——
     * 否则"前后带空格"时预览与真正的默认名差一个空格。
     */
    const refresh = (): void => {
      const tpl = input.value.trim();
      const issues = namingIssues(tpl);
      prev.textContent = issues.empty ? '预览：—' : `预览：${renderNamingTemplate(tpl, new Date())}`;
      const msgs: string[] = [];
      if (issues.empty) msgs.push('不能为空 —— 想回默认就点「恢复默认」');
      if (issues.unknown.length > 0) {
        msgs.push(`「${issues.unknown.join('」「')}」不是变量，会原样保留 —— 修好之前不会保存`);
      }
      if (issues.illegal.length > 0) {
        msgs.push(`文件名里不能有「${issues.illegal.join('」「')}」（Windows 禁字）—— 修好之前不会保存`);
      }
      warn.textContent = msgs.join('；');
      warn.classList.toggle('is-on', msgs.length > 0);
      input.classList.toggle('is-warn', msgs.length > 0);
      prev.classList.toggle('is-warn', msgs.length > 0);
    };

    input.addEventListener('input', refresh);
    /**
     * ⚠️ **落盘只在 `change`（失焦 / 回车）这条路上**，而且**非法就不落** ——
     * `data.json` 保持上一个有效值（判据："非法 token 不改盘"）。输入框不回滚，
     * 用户看得见自己打到哪了、接着改就行。
     */
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!isNamingTemplateOk(v)) {
        refresh();
        return;
      }
      // 改回默认模板 = 存 null（"没改过"那个哨兵，与渲染结果等价）
      const next = v === DEFAULT_NAMING_TEMPLATE ? null : v;
      if (ctx.settings.get().namingTemplate === next) {
        refresh();
        return;
      }
      void ctx.settings
        .save({ namingTemplate: next })
        .then(() => notifyLight(next === null ? '命名模板已恢复默认' : `命名模板已保存：${v}`));
    });

    for (const t of NAMING_TOKENS) {
      chips.appendChild(
        chip(
          t.token,
          false,
          () => {
            const same = explain.dataset.token === t.token && explain.style.display !== 'none';
            explain.dataset.token = t.token;
            explain.textContent = `${t.token} = ${t.label}，如 ${t.example}`;
            explain.style.display = same ? 'none' : '';
          },
          `点一下看释义：${t.label}`,
        ),
      );
    }

    const box = div({ cls: 'kbw-name' });
    box.appendChild(input);
    box.appendChild(prev);
    box.appendChild(chips);
    box.appendChild(explain);
    box.appendChild(warn);
    box.appendChild(
      toolbar(
        ghostBtn('恢复默认', () => {
          input.value = DEFAULT_NAMING_TEMPLATE;
          refresh();
          void ctx.settings
            .save({ namingTemplate: null })
            .then(() => notifyLight('命名模板已恢复默认'));
        }),
      ),
    );
    refresh();
    host.appendChild(
      row(
        '默认名模板',
        box,
        '模板里能用的变量：YYYY MM DD HH mm ss —— 大小写有意义（MM 月、mm 分）；点变量看释义。' +
          '重名仍自动加序号；模板只影响默认名，不改已存在的文件',
      ),
    );
  }

  // ── 自动归位 ───────────────────────────────────────────────
  // ⚠️ v2（P7.12 · #12 拍定）：「启用」开关**退役** —— 显式改「文件位置」= 直接搬，
  // 不看开关（没有"关着的自动归位"这个概念了）。模块开关仍是总闸。
  host.appendChild(
    group('自动归位', '显式改「文件位置」= 直接搬（快照 + 撤销条）—— 改标签、改别的都不搬'),
  );
  host.appendChild(
    readRow('触发条件', '只有显式改「文件位置」属性才搬', '改它 = "改主意"；第一次见到只登记、再改一次才搬'),
  );
  host.appendChild(readRow('目标目录不存在时', '不自动建目录，只报一条说明', '一个错字就会在库里长出没人要的目录 —— 自动动作没有确认流这道闸'));

  const excl = multiSelect({
    value: auto.reconcile.exclude,
    candidates: () => topLevelDirs(ctx),
    placeholder: '加一个排除项…',
    emptyHint: '没有更多候选（直接打字新建）',
    onChange: (next) => {
      void ctx.automation.patch({ reconcile: { exclude: next } }).then(() => {
        notifyLight(`排除项已更新（${next.length} 项）`);
      });
    },
  });
  host.appendChild(
    row('排除', excl.el, '库根下的目录名 / 路径前缀；「.开头」是特例（排除所有点开头的路径）'),
  );

  const plan = ctx.reconcile.lastPlan;
  const statusText = plan
    ? `上次检查：要搬 ${plan.moves.length} 篇 · 跳过 ${plan.skips.length} 篇`
    : '还没检查过（库里有改动时会自动看一遍）';
  host.appendChild(
    toolbar(
      ghostBtn(
        '立即检查一次（有要搬的就搬）',
        () => {
          void ctx.reconcile.tick().then((p) => {
            notify({
              kind: 'info',
              text: `跑完一轮：搬了 ${p.moves.length} 篇，跳过 ${p.skips.length} 篇`,
              detail: '只有"你显式改过文件位置"的笔记才会被排进来',
              ms: NOTIFY_MS.long,
            });
            api.rerender();
          });
        },
        '按当前状态算一遍并真的搬（走 mover：快照 + 日志 + 撤销条）',
      ),
      statusLine(statusText),
    ),
  );

  host.appendChild(
    readRow(
      '位置锁定',
      '属性级',
      '「位置锁定: true」的笔记：v2 起自动归位也不拦它（归位只由你显式改声明触发，= 手动语义）—— 这个字段先保留，将来的自动动作仍以它为准',
    ),
  );

  // ── 库体检（P7.12 · R6）────────────────────────────────────
  /**
   * R6（2026-10-06 批注）：这台机器原先只有"出事时才弹出来"的情境入口
   * （整理通知里的按钮 / 笔记、待处理菜单里一条 / 快速切换里一条），设置里没有、
   * 面板里也没一句"它是干嘛的"。这里补一个**常驻入口**；
   * 命令面板**不加**（5 条契约，B5）。
   */
  host.appendChild(group('库体检', '按 库结构.json 把笔记搬回该去的位置（低频工具，出事才来）'));
  host.appendChild(
    row(
      '库体检',
      btn({
        cls: 'kbw-btn is-small',
        text: '打开',
        on: { click: () => openRebuildPanel(ctx) },
      }),
      '拿图纸（库结构.json）对照实际：只读预览 → 确认 → 快照后纠偏；空库也能一键建骨架',
    ),
  );

  // ── 存量补全（§13）─────────────────────────────────────────
  host.appendChild(group('存量笔记', '一次性维护：把缺前言 / 缺键的老笔记补齐，值不在规范里的可以覆盖'));
  host.appendChild(
    row(
      '一键补全存量笔记',
      btn({
        cls: 'kbw-btn is-small',
        text: '扫描…',
        on: { click: () => openBackfillPanel(ctx) },
      }),
      '先只读扫描（可反复点），确认后才写 —— 只加不删，补过再扫是 0 篇',
    ),
  );
  /**
   * **动态提示**（P7.17 · 用户第 1 条的次入口）：「当前 N 篇可补」——
   * N = "会改到的"（补 / 覆盖；纯跳过不计），与向导询问卡、补全面板**同一个数**
   *（`backfill.planTodoCount`）。异步现算；算不出来就静默撤掉这一行
   *（锦上添花的提示，不能因为它把整栏渲染搞坏）。
   */
  const backlogLine = statusLine('正在清点存量笔记…');
  host.appendChild(backlogLine);
  void planBackfillOf(ctx)
    .then((p) => {
      const n = planTodoCount(p);
      backlogLine.textContent = n > 0 ? `当前 ${n} 篇可补` : '当前没有要补的 ✓';
    })
    .catch((e) => {
      console.warn('[经纬] 清点存量笔记失败（撤掉这行提示）', e);
      backlogLine.remove();
    });
}

/** 排除项的候选：库根下的一级目录（外加一个 `.开头` 的说明项） */
function topLevelDirs(ctx: WorkbenchContext): string[] {
  const kbRoot = ctx.settings.kbRoot();
  const out: string[] = ['.开头'];
  for (const f of ctx.app.vault.getAllLoadedFiles()) {
    const node = f as { children?: unknown[]; path: string };
    if (!node.children) continue;
    // P7.14：isInside/relativeTo —— 手拼前缀在空串根（整个库）下会让候选恒空
    if (!isInside(f.path, kbRoot) || f.path === kbRoot) continue;
    const rel = relativeTo(f.path, kbRoot);
    if (rel === '' || rel.includes('/')) continue;
    out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh'));
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
