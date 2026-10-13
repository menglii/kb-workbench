/**
 * tests/fixture/build.ts —— 合成夹具的构建入口（`tests/index.ts` 开跑前调用一次）
 *
 * 产物：`tests/.fixture/base/01_新知识库`（迁移后基线，喂 A/B/C/E 库）
 *       `tests/.fixture/pre/01_新知识库`（迁移前，喂 D 库）
 * 每次**全量重建**（确定性；几十毫秒，不值得做增量）。
 */
import path from 'node:path';
import { fixtureRoot, rmrf } from '../helpers';
import { beat } from '../heartbeat';
import { buildBase } from './base';
import { buildPre } from './pre';

export function ensureFixtures(): void {
  beat(); // 心跳：重建夹具也是"往前走了一步"（看门狗口径见 tests/heartbeat.ts）
  const root = fixtureRoot();
  rmrf(root); // ⚠️ 别换回裸 `fs.rmSync` —— OneDrive 句柄抖动会抛 ENOTEMPTY，见 helpers.rmrf
  buildBase(path.join(root, 'base', '01_新知识库'));
  buildPre(path.join(root, 'pre', '01_新知识库'));
  beat();
}
