/**
 * map.mjs —— 生成 mailbot 的函数地图，让 agent 不用整文件读。
 * 用法：node map.mjs            （写到 skill 目录的 MAP.md）
 *       node map.mjs --print    （只打印）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MAILBOT_DIR || 'mailbot';   // 也可传入源码目录
const FILES = ['mailbot.mjs', 'memory.mjs'];

function docAbove(lines, i) {
  for (let j = i - 1; j >= 0 && j >= i - 3; j -= 1) {
    const line = lines[j].trim();
    if (!line) continue;
    if (line.startsWith('//')) return line.replace(/^\/\/\s*/, '');
    if (line.startsWith('*') || line.startsWith('/*')) {
      const t = line.replace(/^\/\*+/, '').replace(/\*+\/$/, '').replace(/^\*+\s*/, '').trim();
      if (t) return t;
    }
    break;
  }
  return '';
}

function scan(file) {
  const p = path.join(SRC, file);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const rows = [];
  const fnRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  lines.forEach((line, i) => {
    const m = line.match(fnRe);
    if (!m) return;
    rows.push({ name: m[1], line: i + 1, doc: docAbove(lines, i).slice(0, 64) });
  });
  return { file, total: lines.length, rows };
}

const out = [];
out.push('# mailbot 函数地图（自动生成；改完代码跑 node scripts/map.mjs 刷新）');
out.push('');
out.push('先读这个定位，再按行号局部读 30~60 行。不要整文件读（1300+ 行约 2 万 token）。');
out.push('');
for (const f of FILES) {
  const r = scan(f);
  out.push('## ' + r.file + '（共 ' + r.total + ' 行）');
  out.push('');
  out.push('| 行 | 函数 | 作用 |');
  out.push('|---|---|---|');
  for (const row of r.rows) out.push('| ' + row.line + ' | `' + row.name + '` | ' + (row.doc || '') + ' |');
  out.push('');
}
out.push('## 改代码常去的几处');
out.push('');
out.push('| 想改 | 找哪个 |');
out.push('|---|---|');
out.push('| 状态池 / 时段 / 配额 / 状态链 | `EXTRA_TABLE`、`allowedExtras`、`situation` |');
out.push('| 说话风格 | `askModel` 里的 rules 和 few-shot 块 |');
out.push('| 人格 | `persona.md`（不用改代码）|');
out.push('| 时间禁语 | `timePolicy`、`guardTime` |');
out.push('| 自相矛盾拦截 | `guardSelf`、`guardNumbers` |');
out.push('| 记忆检索权重 | `memory.mjs` 的 `recall`、`SYNONYMS` |');
out.push('| 事实入库/审计 | `groundFacts`、`addFacts`、`auditFacts` |');
out.push('| 回信快慢 | `sendDelayMs`、`replyDelay` |');
out.push('| 主动来信 / 周记 | `maybeProactive`、`writeDigest`、`maybeSummaries` |');
out.push('| 收信主循环 | `tick`、`processOne`、`flushOutbox` |');

const text = out.join('\n') + '\n';
if (process.argv.includes('--print')) console.log(text);
else {
  fs.writeFileSync(path.join(HERE, '..', 'MAP.md'), text);
  console.log('已刷新 MAP.md：' + text.length + ' 字符');
}
