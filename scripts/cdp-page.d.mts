/**
 * 给 `cdp-page.mjs` 的最小类型声明（只有被离线用例引用到的那一个函数）。
 *
 * 为什么需要它：`tests/specs/redline.ts`（P2 加的）直接 import 那个 `.mjs` 来**按行为**断言
 * 双保险判据；而 tsconfig 的 include 覆盖 `tests/**`，缺声明就会让 `npm run typecheck`
 * 整条红掉（报 TS7016）。写这一行比在用例里 `@ts-expect-error` 好：
 * 判据的实现改了签名，这里会跟着报错。
 */
export function realTargetAllowed(
  vault: string,
  env?: Record<string, string | undefined>,
): string | null;
