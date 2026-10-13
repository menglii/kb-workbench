/**
 * core/naming.ts —— 命名模板（1.4 的 ①管理面板 ＋ ③变量帮助，P7.2b）
 *
 * 默认名 `YYYY-MM-DD HHmm` → 渲染成 `2026-10-03 2105`（B5 拍板；冒号是 Windows
 * 文件名禁字，所以时分之间不加分隔符）。
 *
 * **能用的变量是一份最小集**（Q2 2026-10-03 拍）：
 *   `YYYY` 四位年 · `MM` 月 · `DD` 日 · `HH` 时（24 制） · `mm` 分 · `ss` 秒
 * ⚠️ **大小写有意义**（照 moment 的习惯）：`MM` = 月、`mm` = 分；这 6 个之外
 * 一律**原样保留**（不猜测、不替换）—— 是不是"打错了"由 `namingIssues()` 报出来。
 *
 * 纯函数，两个落点：`ui/new-note.ts`（默认名）与 `ui/settings/automation.ts`
 * （实时预览与校验）—— 两处共用同一份渲染，别各写一份（那种抄写迟早会漂）。
 */
import type { WorkbenchSettings } from './settings';

/** 可用变量（顺序 = 面板里 chips 的顺序）*/
export const NAMING_TOKENS: { token: string; label: string; example: string }[] = [
  { token: 'YYYY', label: '四位年份', example: '2026' },
  { token: 'MM', label: '月份（两位）', example: '10' },
  { token: 'DD', label: '日期（两位）', example: '03' },
  { token: 'HH', label: '小时（24 制）', example: '21' },
  { token: 'mm', label: '分钟（两位）', example: '05' },
  { token: 'ss', label: '秒（两位）', example: '07' },
];

export const DEFAULT_NAMING_TEMPLATE = 'YYYY-MM-DD HHmm';

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 从这里往后都是"模板 → 名字"这条链，认的就是这 6 个词 */
function tokenAt(s: string, i: number): string | null {
  if (s.startsWith('YYYY', i)) return 'YYYY';
  const two = s.slice(i, i + 2);
  return two === 'MM' || two === 'DD' || two === 'HH' || two === 'mm' || two === 'ss'
    ? two
    : null;
}

function tokenValue(tok: string, d: Date): string {
  switch (tok) {
    case 'YYYY':
      return String(d.getFullYear());
    case 'MM':
      return pad(d.getMonth() + 1);
    case 'DD':
      return pad(d.getDate());
    case 'HH':
      return pad(d.getHours());
    case 'mm':
      return pad(d.getMinutes());
    case 'ss':
      return pad(d.getSeconds());
    default:
      return tok;
  }
}

/**
 * 渲染模板。**未识别的字母串与非法字符原样保留** —— 面板的预览照实显示
 * （"看得见才好修"，与 §7.1 占位符那条口径同源），是不是合法由 `namingIssues()` 判。
 */
export function renderNamingTemplate(tpl: string, d: Date): string {
  let out = '';
  for (let i = 0; i < tpl.length; ) {
    const tok = tokenAt(tpl, i);
    if (tok) {
      out += tokenValue(tok, d);
      i += tok.length;
    } else {
      out += tpl[i];
      i += 1;
    }
  }
  return out;
}

/**
 * 文件名禁字（Windows：`\ / : * ? " < > |`）—— 与 `services/completion.ts` 的
 * `sanitize()` **同一张表**。模板写了这些字符的话，预览和真正落盘的名字会对不上
 * （sanitize 会把它们换成下划线），所以面板里直接当**非法**挡下来、不落盘。
 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

export interface NamingIssues {
  /** 空模板（全空白）—— 非法：会渲染出一个没有名字的文件 */
  empty: boolean;
  /** 不是变量的字母串（会原样出现在文件名里；多半是打错了） */
  unknown: string[];
  /** 文件名里不能出现的字符（预览与落盘会对不上，所以挡下来） */
  illegal: string[];
}

/**
 * 扫一遍模板里的问题。规则与渲染器**用同一套步进**：
 * 逐个位置先试变量；不是变量且是 ASCII 字母 → 攒进"未知串"（遇到变量或分隔符截断）；
 * 是禁字 → 记进 illegal。
 * ⚠️ 所以 `QQmm` 报的是 `QQ`（`mm` 照常当分钟）—— 报"整串"会误伤
 * 「打错了前缀但后面是正经变量」这种最常见的形态。
 */
export function namingIssues(tpl: string): NamingIssues {
  const unknown: string[] = [];
  const illegal: string[] = [];
  let run = '';
  const flush = (): void => {
    if (run !== '') {
      if (!unknown.includes(run)) unknown.push(run);
      run = '';
    }
  };
  for (let i = 0; i < tpl.length; ) {
    const tok = tokenAt(tpl, i);
    if (tok) {
      flush();
      i += tok.length;
      continue;
    }
    const ch = tpl[i];
    if (ILLEGAL_CHARS.test(ch)) {
      flush();
      if (!illegal.includes(ch)) illegal.push(ch);
      i += 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      run += ch;
      i += 1;
      continue;
    }
    flush();
    i += 1;
  }
  flush();
  return { empty: tpl.trim() === '', unknown, illegal };
}

/** 这个模板能不能存（空 / 未知变量 / 禁字，三者任一都不行）*/
export function isNamingTemplateOk(tpl: string): boolean {
  const issues = namingIssues(tpl);
  return !issues.empty && issues.unknown.length === 0 && issues.illegal.length === 0;
}

/** 设置里存着的模板 → 真正拿来渲染的那一份（`null` = 没改过 → 默认模板）*/
export function resolveNamingTemplate(s: Pick<WorkbenchSettings, 'namingTemplate'>): string {
  return s.namingTemplate ?? DEFAULT_NAMING_TEMPLATE;
}
