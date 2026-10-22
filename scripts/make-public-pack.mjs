// 从已经脱敏的公开仓库生成可构建的源码分享包。
// 用法：node scripts/make-public-pack.mjs --out <输出父目录>
// 输出 <父目录>/kb-workbench；已有目标拒绝覆盖，避免误删用户资料。
// 这里只做明确清单复制和常见凭据检查，不代替分享前的人工隐私审查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), index = args.indexOf('--out');
if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
  throw new Error('请通过 --out 指定输出父目录，目标 kb-workbench 必须尚不存在');
}
const target = path.resolve(args[index + 1], 'kb-workbench');
if (fs.existsSync(target)) throw new Error('输出目标已存在，拒绝覆盖');
const entries = ['src', 'styles', 'assets', 'tests', 'scripts', '.github', 'docs', '坑',
  'package.json', 'package-lock.json', 'tsconfig.json', 'esbuild.config.mjs', 'manifest.json',
  '.nvmrc', '.gitignore', '.gitattributes', 'versions.json', 'README.md', 'CHANGELOG.md',
  '参赛-设计文档.md', '参赛-效果佐证.md', '交互规格.md', '方案设计.md', '属性规范.md',
  '开发计划.md', '排查报告.md', '看板优化方案.md', '界面设计.html',
  'AI接口冻结-P7.3c.md', 'skill-模板-收件箱速理.md', 'CLAUDE.md'];
const skip = new Set(['.git', 'node_modules', '.tmp', '.fixture', '.pack-cache', '.obsidian']);
const files = [];
function collect(rel) {
  const source = path.join(ROOT, rel);
  if (!fs.existsSync(source)) throw new Error(`分享包缺少必需文件：${rel}`);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`不复制符号链接：${rel}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source)) {
      if (!skip.has(name) && !/^\.tmp|\.log$|^\.DS_Store$|^Thumbs\.db$|^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(name)) collect(path.join(rel, name));
    }
  } else files.push(rel);
}
for (const entry of entries) collect(entry);
const credentials = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/;
// 所有预检查先完成，任何可疑凭据只报告文件名，不输出内容。
for (const rel of files) {
  if (!/\.(?:png|jpe?g|gif|webp|ico)$/i.test(rel) &&
      credentials.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
    throw new Error(`发现疑似凭据，请人工检查：${rel}`);
  }
}
for (const rel of files) {
  const destination = path.join(target, rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), destination);
}
console.log(`源码分享包已生成：${target}（${files.length} 个文件，含配图、更新日志及公开文档）`);
