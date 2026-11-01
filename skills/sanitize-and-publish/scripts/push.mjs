/**
 * push.mjs —— 没有 git 也能往 GitHub 推文件（用 Contents API）。
 *
 * 用法：
 *   node push.mjs --repo owner/name --dir <本地目录> --files a.md,b.mjs [--message "提交信息"]
 *   token 从环境变量 GITHUB_TOKEN 取（别写在命令行里，会被记进历史）
 *
 * 行为：已存在就更新（自动取 sha），不存在就新建；最后列一遍远端文件数。
 *
 * v2（2026-11-01）：加了重试。GitHub 偶尔会对 PUT 回一个没道理的 404/5xx，
 * 重试一次就好；网络直接断的情况也会重试。409（sha 变了）会重新取一次 sha 再传。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, opt = {}) => {
  try {
    const r = await fetch('https://api.github.com' + p, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { ok: r.ok, status: r.status, j };
  } catch (e) {
    return { ok: false, status: 0, j: String((e && e.message) || e) };   // 连都连不上，当 0 处理，一样重试
  }
};

// 这些状态值得重试：0=网络断、404=GitHub 偶发（文件明明在）、429=限流、5xx=服务器抽风
const RETRY_STATUS = new Set([0, 404, 429, 500, 502, 503, 504]);
async function attempt(label, fn, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    last = await fn();
    if (last.ok || !RETRY_STATUS.has(last.status)) return last;
    if (i < tries) {
      const wait = 500 * i;
      console.log(`  …${label} 第 ${i} 次失败（${last.status}），${wait}ms 后重试`);
      await sleep(wait);
    }
  }
  return last;
}

const me = await attempt('/user', () => api('/user'), 3);
if (!me.ok) { console.error('token 无效或没权限：' + me.status); process.exit(2); }
console.log('token 属于：' + me.j.login);

let fail = 0;
for (const f of files) {
  const local = path.join(dir, f);
  if (!fs.existsSync(local)) { console.log('  跳过（本地没有） ' + f); continue; }
  const p = `/repos/${repo}/contents/${f}`;
  const content = fs.readFileSync(local).toString('base64');

  const cur = await attempt(f + '（取 sha）', () => api(p), 3);
  const body = { message: `${message} —— ${f}`, content };
  if (cur.ok) body.sha = cur.j.sha;

  let r = await attempt(f + '（上传）', () => api(p, { method: 'PUT', body: JSON.stringify(body) }));
  if (!r.ok && r.status === 409) {
    // 别人刚改过这个文件，或者上一次其实传上去了只是没收到回应：重新取 sha 再传一遍
    console.log('  …' + f + ' sha 对不上（409），重新取 sha 再传');
    const again = await api(p);
    if (again.ok) {
      body.sha = again.j.sha;
      r = await attempt(f + '（上传·重取 sha）', () => api(p, { method: 'PUT', body: JSON.stringify(body) }));
    }
  }

  if (r.ok) console.log('  ok   ' + f);
  else { fail += 1; console.log('  FAIL ' + f + ' ' + r.status + ' ' + JSON.stringify(r.j).slice(0, 120)); }
}

const list = await attempt('列目录', () => api(`/repos/${repo}/contents`), 2);
if (list.ok && Array.isArray(list.j)) console.log('\n远端文件数：' + list.j.length);
console.log(fail ? `\n失败 ${fail} 个` : '\n全部完成');
process.exit(fail ? 1 : 0);
