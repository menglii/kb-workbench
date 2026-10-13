/**
 * tests/heartbeat.ts —— **进度心跳**（P7.19 加 · 看门狗误报的修复）
 *
 * 🔴 为什么要有它（2026-10-10 实测，值一整个"间歇卡住"之谜）：
 * `scripts/test.mjs` 的卡住看门狗原先只盯 `suite.results.length` ——「完成了多少条用例」。
 * 这条口径在**窄过滤**下是错的：`KBW_TEST_ONLY='搬到'` 只选中十条，其余**
 * 全被 skip（不产结果）**，而"把二十来个库 boot 起来"这件事照样要做完。
 * 实测：一个**永不命中**的过滤词，骨架本身 **87.1s**、`results.length` 全程为 0
 * → 看门狗在 60s 处判"没有新结果" → 打印 `✗ 没有新结果已 Ns —— 卡在：<某条用例>`
 * → 整轮按红退出。
 *
 * 这就是那个"**间歇**卡住、卡点在各用例间游走"的真身：骨架时长随机器负载漂，
 * 60s 阈值正好骑在它上面 —— 负载轻就过、负载重就"卡住"。
 * （它同时解释了为什么"分片单独跑全绿、全量偶发卡"和"某条用例看起来挂了其实只跑了 20 秒"。）
 *
 * 口径修成：**"有没有在动"要按"进度事件"算，不能按"完成了多少条"算。**
 * 所以凡是"往前走了一步"的地方都敲一下：进一条用例（含被 skip 的）、进一个分组、
 * 造一次夹具、boot 一次库。真正的"卡住"（某条用例内部 await 永不 resolve）会让心跳
 * **彻底停住** —— 那才是看门狗该抓的形态。
 *
 * ⚠️ 心跳数由 `Suite.ticks` 承载（`tests/framework.ts`），这里只做"隔着全局拿到就 +1"，
 *    免得在 helpers / fixture 里为了一个计数器绕出一圈 import。
 */
interface HeartbeatTarget {
  ticks: number;
}

/** 敲一下心跳（没有 Suite 时静默 —— 纯函数测试、单跑脚本里不该因此炸） */
export function beat(): void {
  const s = (globalThis as unknown as { __kbwSuite?: HeartbeatTarget }).__kbwSuite;
  if (s && typeof s.ticks === 'number') s.ticks += 1;
}
