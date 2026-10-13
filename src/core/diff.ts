/**
 * core/diff.ts —— **行级差异**（P7.12 · R8「美化笔记」的"预览对比"用）
 *
 * 一条纯函数、一份实现：把「原文 × 美化稿」按行对上，标出 `same / del / add`。
 * 只服务一件展示用途（确认流里的对比框）——**不做**字符级 diff、不做并排视图、
 * 不管 hunk 折叠：改动量先让人"一眼看见哪里有变化"，细节他本来就会自己读稿。
 *
 * 算法 = 教科书 LCS（动态规划），确定性（同一对输入永远同一份输出）。
 * 规模上限：美化档的正文本来就 ≤ `AI_LIMITS.beautifyChars`（8000 字 ≈ 数百行），
 * O(n×m) 在这个量级毫无压力；真有两万行的文件也轮不到它（服务层先拒了）。
 */

export interface DiffLine {
  kind: 'same' | 'del' | 'add';
  text: string;
}

/**
 * 按行做 LCS 对齐。空行也算行（"改了个空行"也是改动，别吞）。
 * `del` 的行来自 before，`add` 的行来自 after；`same` 两边同文同序。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  /**
   * dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（从后往前填）。
   * ⚠️ 用 `Uint16Array` 铺平：8000 字的稿也到不了 65535 行，省内存又够快。
   */
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      out.push({ kind: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j] });
    j += 1;
  }
  return out;
}

/** 差异摘要（确认流的预览行文案：「原 N 行 → 新 M 行，改动 X 处」） */
export function diffSummary(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added += 1;
    else if (l.kind === 'del') removed += 1;
  }
  return { added, removed };
}
