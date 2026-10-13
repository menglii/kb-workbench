// 库判据 —— 「真库不许动」这条红线的**唯一判据来源**
//
// 为什么单独一个文件：判据散在 5 个脚本里必然漂（P0 收尾的独立审查实测到两处：
// `deploy.mjs` 的 KBW_VAULT_SANDBOX 能被指向真库却仍打印"实验库"、
// `probe.mjs` 的守卫用 `??` 导致空串就能关掉它）。
//
// 三条规矩：
//  ① **路径比对优先于 flag** —— "是不是真库"永远按 realpath 判，不看命令行
//  ② **正向 + 反向双判** —— 既要"像实验库"，也要"不像真库"；两者都过了才放行
//  ③ **空串不算给了值** —— 环境变量一律 `||`，不用 `??`
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  sandbox: 'C:/Users/<你的用户名>/OneDrive/Desktop/sandbox-vault',
  real: 'C:/Users/<你的用户名>/OneDrive/Desktop/real-vault',
};

/** 真库路径（本机唯一不许写的那一个） */
export function realVault() {
  return path.resolve(process.env.KBW_VAULT_REAL || DEFAULTS.real);
}

/** 实验库路径 */
export function sandboxVault() {
  return path.resolve(process.env.KBW_VAULT_SANDBOX || DEFAULTS.sandbox);
}

/** 归一化：解析符号链接 + 去尾斜杠 + Windows 大小写不敏感 */
export function normalizeVaultPath(p) {
  if (!p) return '';
  let out = path.resolve(p);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    /* 库不存在时退回原样（下面的判据会自己失效） */
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/**
 * 这个路径是不是真库？
 * **按路径判，不看命令行标志。**
 */
export function isRealVault(p) {
  const target = normalizeVaultPath(p);
  if (!target) return false;
  const real = normalizeVaultPath(realVault());
  return target === real || target.startsWith(`${real}${path.sep}`);
}

/**
 * 校验一个库根是不是"可以写"的实验库。
 * 返回 `{ok, reason}` —— 调用方必须显式处理不 ok 的情况。
 *
 * @param {string} p 库根（或库根下的路径）
 * @param {string} [what] 用途，写进报错文案
 */
export function assertWritableSandbox(p, what = '这个操作') {
  if (!p) return { ok: false, reason: '拿不到库根路径' };
  if (isRealVault(p)) {
    return { ok: false, reason: `这是**真库**（${realVault()}）—— ${what}一律拒绝` };
  }
  const sb = normalizeVaultPath(sandboxVault());
  const target = normalizeVaultPath(p);
  if (!target.startsWith(sb)) {
    return {
      ok: false,
      reason: `不是实验库（配置的实验库是 ${sandboxVault()}，当前是 ${p}）。` +
        `要换库就设 KBW_VAULT_SANDBOX，别直接跑`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * 备份目的地判据：给 `vault-backup.mjs` 用。
 * **行为判据**（不是源码子串）—— 独立审查实测过：源码里注释提到 `KBW_ALLOW_REAL`
 * 就足以让"子串断言"通过，于是把双保险整块删掉也照样绿（单标志后门就回来了）。
 *
 * @param {string} out 备份目的地
 * @param {{allowReal?: boolean, env?: Record<string,string|undefined>}} [opts]
 */
export function assertBackupTarget(out, opts = {}) {
  const allowReal = opts.allowReal === true;
  const env = opts.env ?? process.env;
  if (isRealVault(out) && !(allowReal && env.KBW_ALLOW_REAL === '1')) {
    return {
      ok: false,
      reason: '备份目的地落在**真库**里 —— 拒绝写入（要写必须同时给 --allow-real 与 KBW_ALLOW_REAL=1）',
    };
  }
  return { ok: true, reason: '' };
}

/** 部署目标判据：给 deploy.mjs 用（它允许真库，但必须显式） */
export function resolveDeployTarget(useReal) {
  const target = useReal ? realVault() : sandboxVault();
  return {
    target,
    // ⚠️ 关键：真库判定按**路径**，不是按 --real —— 否则把 KBW_VAULT_SANDBOX
    // 指向真库时，脚本会一路无确认地写下去、还打印"【实验库】"
    isReal: isRealVault(target),
  };
}
