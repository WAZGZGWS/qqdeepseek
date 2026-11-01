/**
 * push.mjs —— 没有 git 也能往 GitHub 推文件（用 Contents API）。
 *
 * 用法：
 *   node push.mjs --repo owner/name --dir <本地目录> --files a.md,b.mjs [--message "提交信息"]
 *   token 从环境变量 GITHUB_TOKEN 取（别写在命令行里，会被记进历史）
 *
 * 行为：已存在就更新（自动取 sha），不存在就新建；最后列一遍远端文件数。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};

const repo = arg('repo');
const dir = path.resolve(arg('dir', '.'));
const files = String(arg('files', '')).split(',').map((s) => s.trim()).filter(Boolean);
const message = arg('message', 'update');
const token = process.env.GITHUB_TOKEN || '';

if (!repo || !files.length || !token) {
  console.error('用法：GITHUB_TOKEN=xxx node push.mjs --repo owner/name --dir . --files a,b [--message "msg"]');
  process.exit(2);
}
if (repo.split('/').length !== 2) { console.error('--repo 要写成 owner/name'); process.exit(2); }

const H = { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'push-script' };
const api = async (p, opt = {}) => {
  const r = await fetch('https://api.github.com' + p, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { ok: r.ok, status: r.status, j };
};

const me = await api('/user');
if (!me.ok) { console.error('token 无效或没权限：' + me.status); process.exit(2); }
console.log('token 属于：' + me.j.login);

let fail = 0;
for (const f of files) {
  const local = path.join(dir, f);
  if (!fs.existsSync(local)) { console.log('  跳过（本地没有） ' + f); continue; }
  const p = `/repos/${repo}/contents/${f}`;
  const cur = await api(p);
  const body = { message: `${message} —— ${f}`, content: fs.readFileSync(local).toString('base64') };
  if (cur.ok) body.sha = cur.j.sha;
  const r = await api(p, { method: 'PUT', body: JSON.stringify(body) });
  if (r.ok) console.log('  ok   ' + f);
  else { fail += 1; console.log('  FAIL ' + f + ' ' + r.status + ' ' + JSON.stringify(r.j).slice(0, 120)); }
}

const list = await api(`/repos/${repo}/contents`);
if (list.ok && Array.isArray(list.j)) console.log('\n远端文件数：' + list.j.length);
console.log(fail ? `\n失败 ${fail} 个` : '\n全部完成');
process.exit(fail ? 1 : 0);
