/**
 * tests/fixture/common.ts —— 合成夹具的写盘小工具
 *
 * 为什么要有"合成夹具"：离线套件的两块数据源（`P4-基线` / `属性统一`）都是**真库副本** ——
 * 它们不能进仓库（隐私）、也不能上 CI（本机路径）。所以由本目录的生成器按
 * 「夹具形状契约」（见各 spec 的断言与 2026-10-02 侦察报告）**现造**一份等价形状的假数据，
 * 产物落在 `tests/.fixture/`（已 gitignore，每次 `npm test` 前全量重建）。
 * `KBW_FIXTURE_KB` / `KBW_BACKUP_KB` 两个环境变量仍可指回真备份（本机调试用）。
 */
import fs from 'node:fs';
import path from 'node:path';

export function put(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

export type PropValue = string | number | boolean | string[];

/** 序列化一份"桩能解析"的前言（YAML 子集：标量 / `[a, b]` 行内数组 / 布尔） */
export function fm(props: Record<string, PropValue | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** 「关联笔记」尾链（v2 新序 + 新标签；链接目标都真实存在，别造出意外的失效双链） */
export function tail(center: string, moc = 'MOC_知识地图'): string[] {
  return ['', '## 关联笔记', '- 相关笔记：[[]]', `- 所属中心：[[${center}]]`, `- 返回大地图 [[${moc}]]`];
}

/**
 * 一篇普通笔记：前言 + `# 名字` + 正文（+ 可选尾链）。
 * ⚠️ 正文**首行必须是 `# 名字`** —— board 的摘要偏移与勾选框直写依赖这个形状。
 */
export function note(
  name: string,
  props: Record<string, PropValue | undefined>,
  body: string[] = [],
  center?: string,
): string {
  const lines = [fm(props), '', `# ${name}`, '', ...body];
  if (center) lines.push(...tail(center));
  return lines.join('\n');
}

/** 操作日志（`日志-YYYYMMDD-HHMMSS-动作` 是日志识别的命名形状）——v2：不写「领域」 */
export function logNote(stamp: string, action: string, props: Record<string, PropValue | undefined>, body: string[]): string {
  return note(`日志-${stamp}-${action}`, { 类型: '日志', 状态: '已完成', 创建日期: '2026-09-24', tags: ['操作日志'], ...props }, body);
}
