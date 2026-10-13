/**
 * `styles.mjs` 的类型声明（模块本身是纯 JS —— 构建脚本与测试都要能直接 import）
 */
/** styles/*.css 的拼接顺序 = 层叠顺序（tests/specs/redline.ts 的动效审计也读它） */
export declare const STYLE_ORDER: string[];
/** 把 styles/ 拼成根目录的 styles.css，返回拼进去的文件数 */
export declare function buildStyles(root: string): number;
