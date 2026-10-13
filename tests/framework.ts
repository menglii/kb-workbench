/**
 * tests/framework.ts —— 极简断言框架（不引任何测试库）
 *
 * 目标不是覆盖率，是**把 P0 的完成定义变成可断言的东西**：
 * 每一条都能在输出里看到名字，失败了能一眼看出是哪条、期望什么、实际什么。
 */

export interface TestResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export class Suite {
  results: TestResult[] = [];
  private stack: string[] = [];

  /**
   * **进度心跳**（P7.19 加）—— 每往前走一步 +1：进一条用例（含被 skip 的）、进一个分组、
   * 造夹具、boot 库（后三者由 `tests/heartbeat.ts` 的 `beat()` 敲）。
   *
   * 🔴 `scripts/test.mjs` 的卡住看门狗**只许盯它**，不许盯 `results.length` —— 原因见
   * `tests/heartbeat.ts` 的头注释（窄过滤下"在 boot 二十来个库"会被当成"卡住了"，
   * 实测骨架 87.1s，而 60s 阈值会误报红）。
   */
  ticks = 0;

  async group<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    this.ticks += 1;
    this.stack.push(name);
    try {
      return await fn();
    } finally {
      this.stack.pop();
    }
  }

  /** 只跑名字里含这个子串的用例（`KBW_TEST_ONLY=抢键 npm test`），调一条时省时间 */
  private only = process.env.KBW_TEST_ONLY ?? '';
  skipped = 0;

  /**
   * **只列命中用例名、不跑本体**（`KBW_TEST_LIST=1`）—— 治"过滤词不是唯一命中"那条老账：
   * 以前想知道 `KBW_TEST_ONLY='搬到'` 到底选中了哪几条，只能靠跑完看 `通过 N / N` 反推，
   * 拼错一个词就得等整个子集跑完才发现"0 条"。
   * 这一档把"选中了谁"**先看一眼**（几秒钟），确认过滤词对了再真跑。
   * ⚠️ 退出码照 `skipped` 口径走 **2**（"只列了"当然不算通过）。
   */
  readonly listMode = process.env.KBW_TEST_LIST === '1';
  /** listMode 下命中的用例名（`index.ts` 用它打汇总与判退出码） */
  listed: string[] = [];

  async it(name: string, fn: () => void | Promise<void>): Promise<void> {
    this.ticks += 1; // 心跳：**在 skip 判定之前** —— 被跳过的用例也是"往前走了一步"
    const full = [...this.stack, name].join(' › ');
    if (this.only && !full.includes(this.only)) {
      this.skipped += 1;
      return;
    }
    if (this.listMode) {
      this.listed.push(full);
      console.log(`  · ${full}`);
      return;
    }
    const start = Date.now();
    this.running = name;
    if (process.env.KBW_TEST_VERBOSE) console.log(`  → ${full}`);
    try {
      await fn();
      this.results.push({ name: full, ok: true, ms: Date.now() - start });
    } catch (e) {
      this.results.push({
        name: full,
        ok: false,
        error: e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(e),
        ms: Date.now() - start,
      });
    }
  }

  /** 卡住时用来定位：跑到哪一条了 */
  get current(): string {
    return [...this.stack, this.running ?? ''].join(' › ');
  }

  running: string | null = null;

  get passed(): number {
    return this.results.filter((r) => r.ok).length;
  }

  get failed(): TestResult[] {
    return this.results.filter((r) => !r.ok);
  }
}

// ── 断言 ───────────────────────────────────────────────────────
export function fail(msg: string): never {
  throw new Error(msg);
}

/** 断言函数（`asserts cond` 让 TS 在断言之后收窄类型，省掉一堆非空断言） */
export function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

export function eq<T>(actual: T, expected: T, msg = ''): void {
  if (!Object.is(actual, expected)) {
    fail(`${msg || '值不相等'}：期望 ${format(expected)}，实际 ${format(actual)}`);
  }
}

export function deepEq(actual: unknown, expected: unknown, msg = ''): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${msg || '深比较不相等'}：\n  期望 ${b}\n  实际 ${a}`);
}

export function contains(haystack: string, needle: string, msg = ''): void {
  if (!haystack.includes(needle)) {
    fail(`${msg || '没找到子串'}：期望包含 ${format(needle)}，实际是 ${format(haystack)}`);
  }
}

export function notContains(haystack: string, needle: string, msg = ''): void {
  if (haystack.includes(needle)) {
    fail(`${msg || '不该出现却出现了'}：${format(needle)} ∈ ${format(haystack)}`);
  }
}

export function between(actual: number, min: number, max: number, msg = ''): void {
  if (!(actual >= min && actual <= max)) {
    fail(`${msg || '超范围'}：期望 ${min}..${max}，实际 ${actual}`);
  }
}

function format(v: unknown): string {
  if (typeof v === 'string') return v.length > 240 ? `${v.slice(0, 240)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s && s.length > 240 ? `${s.slice(0, 240)}…` : String(s);
  } catch {
    return String(v);
  }
}
