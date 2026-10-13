/**
 * `vault-guard.mjs` 的类型声明（模块本身是纯 JS —— 构建脚本与测试都要能直接 import）
 * 三条规矩再写一遍：路径比对优先于 flag · 正向与反向双判 · 空串不算给了值
 */
export declare function realVault(): string;
export declare function sandboxVault(): string;
export declare function normalizeVaultPath(p: string): string;
export declare function isRealVault(p: string): boolean;
export declare function assertWritableSandbox(
  p: string,
  what?: string,
): { ok: boolean; reason: string };
export declare function resolveDeployTarget(useReal: boolean): { target: string; isReal: boolean };
/** 备份目的地判据（`vault-backup.mjs` 用）—— 行为判据，离线用例直接断言它 */
export declare function assertBackupTarget(
  out: string,
  opts?: { allowReal?: boolean; env?: Record<string, string | undefined> },
): { ok: boolean; reason: string };
