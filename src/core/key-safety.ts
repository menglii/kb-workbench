/**
 * core/key-safety.ts —— **AI key 与"这个库在同步"撞车**（C7 核查 · P8 收尾）
 *
 * 背景（`docs/external/p7-action-checklist.md` 的**决策门 G0/C7**，原文：
 * 「核查：真库 `data.json` 是否随云盘同步（key 安全）」—— 它是那张表上**唯一一条非开发类的未决项**）：
 *
 *   · key 存**插件目录** `<库>/.obsidian/plugins/kb-workbench/data.json`（P7.3c 拍定，本模块不改这个位置）；
 *   · 而插件目录**在库里面** —— 只要这个库挂着任何一种同步（库内同步插件、云盘客户端、
 *     git、Syncthing…），`data.json` 就会跟着上云，**key 是明文**。
 *
 * 本模块只做一件事：**把这件事说出来**。不改 key 的存放位置（那会推翻既有产品决策、还要迁存量），
 * 也不打算猜"某个云盘客户端在不在跑"（库内看不见进程）——
 * 只探**库里的落盘痕迹**，探到就提一句，让用户自己决定。
 *
 * ⚠️ 探测是按**已知痕迹**做的（下面那张表），不是穷举：探不到 ≠ 一定安全。
 * 所以那句提示的措辞是"这个库看起来在同步"，不是"你的 key 安全"。
 */
import type { App } from 'obsidian';

/**
 * 已知会把"库内文件"带出本机的**落盘痕迹**（相对**库根**）。
 * 表要短、要认得出 —— 每加一条就等于多一种"看着像在同步"的说法，
 * 假警报多了这句提示就没人看了。
 */
export const SYNC_MARKERS: string[] = [
  // 库内同步插件（本仓红线点名的那个通道，见 CLAUDE.md）
  '.obsidian/plugins/nutstore-sync',
  // 另外三个常见的库内同步/版本控制插件
  '.obsidian/plugins/remotely-save',
  '.obsidian/plugins/obsidian-livesync',
  '.obsidian/plugins/obsidian-git',
  // 目录级同步器的标记：Syncthing
  '.stfolder',
  // ⚠️ 库根有 git 仓库本身就是**本仓红线禁止**的（构建噪声会进版本流）——
  // 顺带在这里露出来，一举两得
  '.git',
];

export interface KeySafetyInput {
  /** 当前配着的 AI key（空串 / 全空白 = 没配） */
  apiKey: string;
  /** `findSyncMarkers()` 探到的那些痕迹 */
  markers: string[];
}

/**
 * 该不该提这一句？**纯函数**（好断言、好突变）。
 * 两个条件缺一不可：**配了 key** × **库里有同步痕迹** —— 没配 key 时同步什么都没关系。
 */
export function shouldWarnKeySync(input: KeySafetyInput): boolean {
  return String(input.apiKey ?? '').trim() !== '' && input.markers.length > 0;
}

/**
 * 探库根下有哪些同步痕迹（走 `vault.adapter` —— 手机端也成立，别用 Node `fs`）。
 * 一条都不在就返回空数组（**正常情况**：多数库没挂同步）。
 */
export async function findSyncMarkers(app: App, markers: string[] = SYNC_MARKERS): Promise<string[]> {
  const adapter = app.vault.adapter;
  const found: string[] = [];
  for (const m of markers) {
    try {
      if (await adapter.exists(m)) found.push(m);
    } catch {
      /* 探不动就当没有 —— 这句提示是**附带**的，不该因为它自己抛错而炸掉加载 */
    }
  }
  return found;
}

/**
 * 提示文案的唯一出处（离线断言与真机都读它，别在两处各写一遍措辞）。
 * ⚠️ 措辞是"看起来在同步"，**不是**"你的 key 泄露了" —— 痕迹只是痕迹。
 */
export function keySyncNotice(markers: string[]): { text: string; detail: string } {
  return {
    text: 'AI key 存在库里的 data.json，而这个库看起来在同步',
    detail:
      `探到：${markers.join(' · ')} —— 同步会把插件目录一起带上云（key 是明文）。` +
      '要么别把这个库交给同步，要么把 key 挪出库（换存放位置是既有决策，需另行拍板）',
  };
}
