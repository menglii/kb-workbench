/**
 * services/ai/cost.ts —— **成本可见**（17.10② · P7.3c）的纯算法
 *
 * 两条口径（用户 2026-10-02 拍板）：
 *  ① **优先用服务端报的 `usage`**（真数字）；认不出（本地模型 / 网关不吐）就
 *     **回落到本地字符估算**，并且**必须把"估算"这件事标出来** —— 悄悄拿估算
 *     当实数，比不显示更坏；
 *  ② **只本地做乘法，不联网**：单价来自设置（每百万 token 多少钱），
 *     界面显示 `≈ 单位+数字`。汇率、分时段价、缓存折扣**一概不掺和**
 *     （默认单价填的已经是偏保守的高峰价，文案里写了"以你家的价为准"）。
 *
 * 本文件是**纯函数**（无 obsidian、无 DOM、无网络）——
 * `tests/specs/p73c.ts` 直接拿数字断言，不需要桩。
 */
import type { AiSettings } from '../../core/settings';
import type { AiUsage } from './transport';

/**
 * 字符 → token 的估算比例。
 *
 * 依据：DeepSeek 文档给的经验值是「1 个中文字 ≈ 0.6 token、1 个英文字符 ≈ 0.3 token」，
 * 而我们的提示词是中文夹英文路径/属性的混合体 —— 取 **0.5**（`ceil(chars / 2)`）
 * 是这两档的中间，**刻意不是一个精确值**：它只在"服务端不报 usage"时兜底，
 * 界面上那一条也写着"估算"。别把它当准确率指标去调。
 */
export const CHARS_PER_TOKEN = 2;

/** 一段文本的 token 估算（向上取整；空串 = 0） */
export function estimateTokens(text: string): number {
  const n = String(text ?? '').length;
  return n === 0 ? 0 : Math.ceil(n / CHARS_PER_TOKEN);
}

/**
 * 一轮（一次提问）的用量汇总。
 *
 * ⚠️ agent 一轮 = **多次模型调用**（一步一次），所以这里是**累加**的；
 * `calls` 记"这一轮调了几次"，界面上那句"3 步"与它同源。
 */
export interface AiTurnUsage {
  promptTokens: number;
  completionTokens: number;
  /** 至少有一次是靠字符估算补的（真 usage 与估算**可以混在一轮里**：第 1 步报了、第 2 步没报） */
  estimated: boolean;
  calls: number;
}

export function emptyUsage(): AiTurnUsage {
  return { promptTokens: 0, completionTokens: 0, estimated: false, calls: 0 };
}

/**
 * 把一次调用的用量并进累计值（**纯函数**：返回新对象，不改传入的那个）。
 *
 * `usage` 缺席时按 `fallback` 估算（调用方给"这次发出去的消息 + 回来的正文"）。
 * 两件事都要做对：
 *  · **估算与真实可以混用**（有的步报了 usage、有的没报）；
 *  · 只要估算过一次，`estimated` 就置位（界面据此写"估算"二字）。
 */
export function addUsage(
  acc: AiTurnUsage,
  usage: AiUsage | undefined,
  fallback?: { promptText?: string; completionText?: string },
): AiTurnUsage {
  const next: AiTurnUsage = { ...acc, calls: acc.calls + 1 };
  if (usage) {
    next.promptTokens += Math.max(0, Math.round(usage.promptTokens));
    next.completionTokens += Math.max(0, Math.round(usage.completionTokens));
    return next;
  }
  next.estimated = true;
  next.promptTokens += estimateTokens(fallback?.promptText ?? '');
  next.completionTokens += estimateTokens(fallback?.completionText ?? '');
  return next;
}

/**
 * 这一次会话加起来几毛钱（**只做乘法**）。单价是"每百万 token"。
 * `priceIn` / `priceOut` 都为 0（用户没填）时返回 0 —— 调用方据此决定显不显示费用。
 */
export function costOf(
  u: Pick<AiTurnUsage, 'promptTokens' | 'completionTokens'>,
  priceIn: number,
  priceOut: number,
): number {
  const a = Number.isFinite(priceIn) ? Math.max(0, priceIn) : 0;
  const b = Number.isFinite(priceOut) ? Math.max(0, priceOut) : 0;
  return (u.promptTokens * a + u.completionTokens * b) / 1_000_000;
}

/** token 数的短写法（界面用）：`945` / `1.2k` / `12k` */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const k = v / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/**
 * 金额的短写法：分位以下不给假精度（`≈ ¥0.004` / `≈ ¥0.12` / `≈ ¥1.2`）。
 * **不给三位以上小数** —— 估算出来的第四位小数没有意义，写出来只会显得精确。
 */
export function fmtCost(v: number, unit: string): string {
  const u = String(unit ?? '');
  const n = Math.max(0, v);
  const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  const s = n.toFixed(digits).replace(/\.?0+$/, '');
  return `${u}${s === '' ? '0' : s}`;
}

/** 一行给用户看的用量说明：`输入 1.2k / 输出 312 token ≈ ¥0.005（估算）` */
export function usageLine(u: AiTurnUsage, priceIn: number, priceOut: number, unit: string): string {
  const parts = [`输入 ${fmtTokens(u.promptTokens)} / 输出 ${fmtTokens(u.completionTokens)} token`];
  if (priceIn > 0 || priceOut > 0) parts.push(`≈ ${fmtCost(costOf(u, priceIn, priceOut), unit)}`);
  if (u.estimated) parts.push('（估算）');
  return parts.join(' · ');
}

// ────────────────────────────────────────────────────────────────
// P7.22b · #5：任务级模型 + 单价表多条（纯函数，界面与服务层共用同一份口径）
// ────────────────────────────────────────────────────────────────
/**
 * **这条任务用哪个模型**：任务级映射命中就用它，否则主模型。
 * 分派的执行点在 `services/ai/index.ts` 的 `runTask` 接线处（只此一处）。
 */
export function modelOf(cfg: Pick<AiSettings, 'taskModels' | 'model'>, taskId: string): string {
  const m = cfg.taskModels?.[taskId]?.trim();
  return m ? m : cfg.model;
}

/**
 * **这次算钱用哪一档单价**：按模型命中 `modelPrices` 就用它，
 * 否则回落默认的 `priceIn` / `priceOut`（"回落现值"）。匹配 = 模型名逐字相等。
 */
export function priceFor(
  cfg: Pick<AiSettings, 'modelPrices' | 'priceIn' | 'priceOut'>,
  model: string,
): { priceIn: number; priceOut: number } {
  const m = String(model ?? '').trim();
  if (m !== '') {
    const hit = (cfg.modelPrices ?? []).find((x) => x.model === m);
    if (hit) return { priceIn: hit.priceIn, priceOut: hit.priceOut };
  }
  return { priceIn: cfg.priceIn, priceOut: cfg.priceOut };
}

/**
 * 一行用量说明（**任务级口径**，P7.22b 起界面统一走它）：按"这条任务实际用的模型"
 * 取单价（`modelOf` + `priceFor`）—— 一条任务配了贵模型，费用那一行才说得对。
 */
export function usageLineFor(
  cfg: Pick<AiSettings, 'taskModels' | 'model' | 'modelPrices' | 'priceIn' | 'priceOut' | 'priceUnit'>,
  taskId: string,
  u: AiTurnUsage,
): string {
  const p = priceFor(cfg, modelOf(cfg, taskId));
  return usageLine(u, p.priceIn, p.priceOut, cfg.priceUnit);
}
