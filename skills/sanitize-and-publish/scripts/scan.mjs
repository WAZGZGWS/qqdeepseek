/**
 * scan.mjs —— 开源前扫一遍：邮箱、key、token、本机路径、内网地址、手机号。
 * 用法：node scan.mjs <目录> [--quiet]
 * 退出码：有命中返回 1（便于 && 判断）
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const quiet = process.argv.includes('--quiet');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', 'venv', '__pycache__']);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'LICENSES.chromium.html']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.zip', '.7z', '.exe', '.dll', '.pdf', '.woff', '.woff2', '.mp4', '.mp3', '.asar', '.lock']);
const MAX_BYTES = 1024 * 1024;

const RULES = [
  { name: '模型 key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: '云厂商 key', re: /\b(AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,})\b/g },
  { name: '疑似密码/口令', re: /(?:password|passwd|pwd|authCode|apiKey|secret)\s*[:=]\s*["']?[A-Za-z0-9@#%^&*._-]{8,}/gi },
  { name: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { name: '本机绝对路径', re: /[A-Za-z]:\\[^\s'"`]{3,}/g },
  { name: '内网地址', re: /(?:https?|wss?):\/\/(?:10\.|127\.0|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)[\d.]+/g },
  { name: '手机号', re: /(?:^|[^\d])1[3-9]\d{9}(?![\d])/g },
  { name: '身份证号', re: /\b\d{17}[\dXx]\b/g },
];

const OK_EMAIL = /@(?:example\.(?:com|org)|test\.(?:com|invalid)|your-?domain|qq\.com\b)/i;
const OK_EMAIL_ANY = /@(?:example\.(?:com|org)|test\.|invalid$)/i;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); continue; }
    if (SKIP_FILES.has(e.name)) continue;
    if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    out.push(p);
  }
  return out;
}

const files = walk(dir);
let hits = 0;
const mask = (s) => (s.length <= 8 ? s.slice(0, 2) + '***' : s.slice(0, 4) + '***' + s.slice(-2));

for (const f of files) {
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const rel = path.relative(dir, f);
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      const raw = m[0].trim();
      if (r.name === '邮箱' && OK_EMAIL_ANY.test(raw)) continue;   // 文档里的示例邮箱不算
      if (r.name === '本机绝对路径' && /^[A-Za-z]:\\Windows|^[A-Za-z]:\\Program Files/i.test(raw)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits += 1;
      if (!quiet) console.log(`${rel}:${line}  [${r.name}]  ${mask(raw)}`);
    }
  }
}

console.log(`\n扫描 ${files.length} 个文件，命中 ${hits} 处${hits ? '' : '（干净）'}`);
process.exit(hits ? 1 : 0);
