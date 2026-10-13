/**
 * services/link-fix.ts —— **按行改链**（P7.13b · E1 的纯函数半边）
 *
 * 拍定 22b 的原话：「写链要**只改认得出的那一行**（与 `doc-patches` / `migrate`
 * 的按行改同一手法）」。这条纯函数就是那份"认得出"的口径 —— 面板拿它
 * ①在确认前现算"这条链还认不认得出来"（幂等自证），②在 `vault.process`
 * 回调里**拿当刻文本**再算一遍（确认期间被别处改过也不怕，认不出就一处不动）。
 *
 * 口径（三条，都有判据）：
 *   · **只动 `[[…]]` 里的目标那一段**：`#小节` 与 `|别名` **原样保留**；
 *   · 目标比对用**归一化**口径（去 `|别名`、`#小节`、trim —— `normalizeLinkText` 同源）：
 *     写的是 `[[旧名|别名]]`，认的也是 `旧名`；
 *   · 同一目标在一篇里出现多次 → **一处确认、多处全改**（它们是同一条断链）。
 *   · 新旧同名 / 空目标 → 一处都不动（幂等：重复执行 = 盘上零变化）。
 *
 * ⚠️ `![[…]]`（嵌入）也照改（正则命中的是 `[[…]]` 那一段，`!` 留在原地）；
 * 跨行的 / 带嵌套方括号的不认（真链接也不会长成那样）—— **认不出就不动**。
 */
import { normalizeLinkText } from '../core/vault-index';

export interface ReplaceResult {
  /** 换过之后的文本（认不出时与入参逐字节相同） */
  text: string;
  /** 真换掉的处数（0 = 没认出来 / 幂等命中） */
  count: number;
}

export function replaceLinkTarget(body: string, oldTarget: string, newTarget: string): ReplaceResult {
  const old = normalizeLinkText(oldTarget);
  const next = String(newTarget ?? '').trim();
  if (old === '' || next === '' || old === next) return { text: body, count: 0 };
  let count = 0;
  const text = body.replace(/\[\[([^[\]\n]+?)\]\]/g, (whole, inner: string) => {
    const bar = inner.indexOf('|');
    const left = bar >= 0 ? inner.slice(0, bar) : inner;
    const hash = left.indexOf('#');
    const tgt = (hash >= 0 ? left.slice(0, hash) : left).trim();
    if (tgt !== old) return whole;
    count += 1;
    // 目标换成新的；`#小节`（含 `#`）与 `|别名`（含 `|`）原样接回
    const head = hash >= 0 ? left.slice(hash) : '';
    const tail = bar >= 0 ? inner.slice(bar) : '';
    return `[[${next}${head}${tail}]]`;
  });
  return { text, count };
}
