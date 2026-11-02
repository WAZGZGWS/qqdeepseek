#!/usr/bin/env node
/**
 * mailbot —— 用邮箱和"她"聊天：一封一封信，不是聊天窗口。
 *
 * 收：IMAP 轮询，只认主人；太旧的信（>24h）不回。
 * 想：短问候 / 深夜短句 / 超预算 / 余额低 → 本地模板，不花钱；其余调一次模型。
 * 发：排队发。按情境随机延迟（白天十几分钟到两小时、深夜几分钟），像人看到信再回。
 *
 * 像人的地方（都不花钱）：
 *   · 状态词冷却：同一个"刚洗完澡""17度晴着"不会连着几封出现
 *   · 长度随机：三成只回一句，偶尔多说几句
 *   · 口癖降频：最近几封老用"诶/呢/啦"就这次别用
 *   · 允许不逐条答：只接最戳她的一句
 *   · 情绪延续：上一封是烦还是心疼，这一封接着来
 *   · 回声：偶尔拎他说过的一个词再反驳
 *
 * 防乱编：
 *   · 事实入库前校验（必须在他的原信里有依据），防记忆污染
 *   · 数字护栏：回复里出现上下文没有的数字，删掉那句话
 *   · 旧事只许照抄记忆片段，不许补细节
 *
 * 用法：--once / --status / --test / --say <文本> / --proactive
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pkgMail from 'mailparser';
import { remember, memoryHint, memoryStats, tokenize, similarity, recentRaw, listEntries, removeEntry, clearAll, exportMarkdown } from './memory.mjs';

const { simpleParser } = pkgMail;
const DIR = path.dirname(fileURLToPath(import.meta.url));   // 凭据、状态、记忆都放在脚本旁边
const CONFIG = path.join(DIR, 'config.json');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'mailbot.log');
const PERSONA = path.join(DIR, 'persona.md');
const LOCK = path.join(DIR, 'lock');
const HEARTBEAT = path.join(DIR, 'heartbeat');
/** 每轮打个心跳，看门狗靠它判断"还活着" */
const beat = () => { try { fs.writeFileSync(HEARTBEAT, String(Date.now())); } catch {} };
let MAIL_USER = 'you@example.com';   // 真正的值由 config.json 的 mail.user（或 email）填进来   // 可被 config.mail.user 覆盖
let IMAP = { host: 'imap.example.com', port: 993 };   // 换服务商只改 config.mail
let SMTP = { host: 'smtp.example.com', port: 465 };   // 换服务商只改 config.mail
// 节日表：公历的直接写 MM-DD，农历的按年写 YYYY-MM-DD。
// TODO 2031 年起要补除夕/春节/中秋的新日期（每年核一次，别凭记忆填）。
const HOLIDAYS = [
  { key: 'newyear', name: '元旦', dates: ['01-01'] },
  { key: 'eve', name: '除夕', dates: ['2026-02-16', '2027-02-05', '2028-01-25', '2029-02-12', '2030-02-02'] },
  { key: 'spring', name: '春节', dates: ['2026-02-17', '2027-02-06', '2028-01-26', '2029-02-13', '2030-02-03'] },
  { key: 'midautumn', name: '中秋', dates: ['2026-09-25', '2027-09-15', '2028-10-03', '2029-09-22', '2030-09-12'] },
];
const POLL_MS = 100 * 1000;   // 正常轮询间隔；失败会退避，最长 10 分钟
const MAX_HISTORY = 10;   // 折中：8 条时她容易"我啥时候说过"，12 条每封多烧 80 字
const MAX_INCOMING = 1200;
let TZ = 'Asia/Shanghai';   // 由 config.json 的 timezone 覆盖
const PARTICLE_LIST = ['诶', '呢', '啦', '呗', '哼', '嘛'];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rotateLog() {
  try { const s = fs.statSync(LOG); if (s.size > 2 * 1024 * 1024) { const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-800); fs.writeFileSync(LOG, lines.join('\n') + '\n'); } } catch {}
}
const log = (m) => { rotateLog(); const l = `[${new Date().toLocaleString('zh-CN', { timeZone: TZ, hour12: false })}] ${m}`; try { fs.appendFileSync(LOG, l + '\n'); } catch {} console.log(l); };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => {
  // 先写 .tmp 再改名：断电/崩溃时要么旧版要么新版，不会留下半截 JSON
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); const t = p + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 7) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, p); } catch {}
};

const STATE_BAK = path.join(DIR, 'state.bak.json');
/** 状态写盘前先留一份备份：state.json 坏了还能回退 */
export function saveState(s) {
  try {
    if (fs.existsSync(STATE)) fs.copyFileSync(STATE, STATE_BAK);
  } catch {}
  // __ 开头的是运行时开关，不写进状态文件
  const clean = {};
  for (const k of Object.keys(s)) if (!k.startsWith('__')) clean[k] = s[k];
  writeJson(STATE, clean);
}
/** 读状态：主文件坏了就用备份 */
export function loadState(def) {
  const main = readJson(STATE, null);
  if (main) return main;
  const bak = readJson(STATE_BAK, null);
  if (bak) { log('state.json 读坏了，已回退到备份'); return bak; }
  return def;
}

/** 出问题时通知主人（同类两小时只发一封，别刷他信箱） */
let CTX = { auth: null, config: null, state: null };
async function alertOnce(code, text, windowMs = 24 * 3600 * 1000) {   // 同类故障一天最多一封，别轮着发
  try {
    const s = CTX.state;
    const c = CTX.config;
    if (!s || !c || !c.owner || !CTX.auth) return;
    s.alerts = s.alerts || {};
    const now = Date.now();
    if (now - Number(s.alerts[code] || 0) < windowMs) return;
    s.alerts[code] = now;
    saveState(s);
    await sendMail({ to: c.owner, subject: '（她这边出了点问题）', text: `${text}\n\n（自动发的，同类问题两小时内只发一次。详细日志看 mailbot.log。）`, auth: CTX.auth });
    log('已发故障提醒：' + code);
  } catch {}
}


function decrypt(file) {
  if (process.platform !== 'win32') return '';   // DPAPI 只有 Windows 有
  try { return decryptWin(file); } catch { return ''; }
}
function decryptWin(file) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$b=[IO.File]::ReadAllBytes('${file.replace(/\\/g, '\\\\')}')`,
    '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '[Text.Encoding]::UTF8.GetString($p)',
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
}

class Imap {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.tag = 0;
    this.wake = null;
    // 一建立连接就常驻监听：数据先落进 buf，别指望 cmd() 挂监听那一瞬间还能接住
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (this.wake) { const w = this.wake; this.wake = null; w(); }
    });
  }
  static connect() {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host: IMAP.host, port: IMAP.port, servername: IMAP.host });
      const im = new Imap(s);   // 立刻挂监听：招呼可能在 secureConnect 之前就到
      s.setTimeout(25000, () => { try { s.destroy(); } catch {} reject(new Error('IMAP 超时')); });
      s.once('error', reject);
      s.once('secureConnect', () => {
        // 等服务器把招呼说完再发命令。QQ 收到招呼前的命令会直接不回（今天卡了一晚上）
        (async () => {
          const deadline = Date.now() + 10000;
          while (!/^\* OK/m.test(im.buf.toString('utf8'))) {
            if (Date.now() > deadline) { try { s.destroy(); } catch {} reject(new Error('IMAP 招呼超时')); return; }
            try { await im.read(Math.max(200, deadline - Date.now())); } catch (e) { try { s.destroy(); } catch {} reject(e); return; }
          }
          im.buf = Buffer.alloc(0);
          resolve(im);
        })();
      });
    });
  }
  // 数据由构造函数里的常驻监听收进 buf；这里只是等下一次「有数据了」的通知
  read(ms = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.wake = null; rej(new Error('IMAP 读超时')); }, ms);
      this.wake = () => { clearTimeout(t); res(); };
    });
  }
  async cmd(text) {
    this.tag += 1;
    const tag = `a${this.tag}`;
    this.buf = Buffer.alloc(0);
    this.sock.write(`${tag} ${text}\r\n`);
    const deadline = Date.now() + 30000;
    for (;;) {
      if (new RegExp(`${tag} (OK|NO|BAD)`).test(this.buf.toString('utf8'))) break;
      if (Date.now() > deadline) throw new Error('IMAP 命令超时: ' + text.slice(0, 24));
      await this.read();
    }
    return { text: this.buf.toString('utf8'), buf: this.buf };
  }
  quit() { try { this.sock.write('z LOGOUT\r\n'); this.sock.end(); } catch {} }
}

const decodeMime = (s) => String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
  try { return enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1')); }
  catch { return m; }
});
const headerField = (t, n) => { const m = t.match(new RegExp(`^${n}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'im')); return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : ''; };

export async function parseBody(raw, subject) {
  try {
    const mail = await simpleParser(raw);
    let text = String(mail.text || '');
    if (!text.trim() && mail.html) text = String(mail.html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const marks = [/\n-{2,}\s*原始邮件\s*-{2,}/i, /\n-{2,}\s*Original Message\s*-{2,}/i, /\n在\s*\d{4}\s*年[\s\S]{0,80}?写道[:：]/, /\n发件人[:：]/];
    for (const re of marks) { const m = text.match(re); if (m && m.index > 0) text = text.slice(0, m.index); }
    text = text.split('\n')
      .filter((l) => !l.trim().startsWith('>') && !/^(发件人|发送时间|收件人|主题)[:：]/.test(l.trim()))
      .join('\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (!text) text = '（他没写正文，主题是：' + subject + '）';
    // 长信别一刀切掉结尾：留开头 800 + 结尾 400，"你觉得呢"常在最后
    if (text.length > MAX_INCOMING) {
      const head = Math.floor(MAX_INCOMING * 0.66);
      text = text.slice(0, head) + '\n……（中间省略）……\n' + text.slice(-(MAX_INCOMING - head));
    }
    return text;
  } catch { return '（这封信读不出来，主题是：' + subject + '）'; }
}

function nodemailer() {
  try { const req = createRequire(import.meta.url); return req('nodemailer'); } catch { return null; }
}
async function sendMail({ to, subject, text, inReplyTo, references, auth }) {
  const nm = nodemailer();
  if (!nm) throw new Error('没有 nodemailer');
  const t = nm.createTransport({ host: SMTP.host, port: SMTP.port, secure: true, auth: { user: MAIL_USER, pass: auth } });
  const info = await t.sendMail({ from: `"${process.env.MAIL_NAME || '妹妹'}" <${MAIL_USER}>`, to, subject, text, inReplyTo: inReplyTo || undefined, references: references || undefined, headers: { 'X-Mailer': 'mailbot' } });
  return info.messageId;
}

const TEMPLATES = {
  greet: ['在呢，怎么啦？', '诶，我在。你说。', '在的，刚放下手机。', '来啦哥。', '嗯？说。', '在啊，怎么了这是。', '哟，这么主动。', '我在，你说吧。'],
  night: ['这么晚还不睡，明天不上班啦？', '我也困了，你先去睡，明天说。', '快去睡吧，我明天还在。', '睡觉去，别熬了。', '几点了还醒着，快去睡。'],
  bye: ['晚安，睡吧。', '去睡吧，明天见。', '嗯，晚安哥。', '睡吧睡吧，我也困了。', '晚安，做个好梦。'],
  askEat: ['吃了，你呢？别又糊弄一顿。', '刚吃完，你吃没吃？', '还没呢，等你一起啊。', '吃了，别惦记我，你自己吃没吃。'],
  haha: ['笑什么笑，说人话。', '乐啥呢你。', '哼，有什么好笑的。', '你笑点真低。', '行行行，你赢了，别笑了。'],
  // 早上打招呼：短、像她，不客服腔
  morning: ['早啊哥。', '这么早就醒了？', '早，我刚醒，眼睛还没睁开。', '早，今天起得比你还早。', '早啊，饭吃了没。'],
  // "在干嘛 / 忙吗"：别回"在呢"，得说自己在干嘛
  askWhat: ['没干嘛，躺着呢。', '在发呆，你说。', '刚想找你说话。', '忙着呢，但可以听你说。', '也没什么，就等你说点有意思的。'],
  // 他说想她
  miss: ['想了，哪能不想。', '嗯？这会儿才想起来说。', '哼，嘴上说说吧。', '想我就多说两句。'],
  fallback: ['在呢，你说。', '嗯？', '怎么啦。', '你说。', '嗯，然后呢。', '怎么了这是。'],
  // 没钱 / 额度用尽的收尾：不是不理他，是把话留到明天
  outOfCredit: ['没钱了，今天只能到这儿。明天聊哥。', '我这边见底了，说不动话……明天聊。', '行吧，今天就到这儿，明天聊。'],
  // 额度用完（不是没钱）的时候用：别让她说成自己不想理他
  quota: ['今天聊够了，剩下的信我明天再看。', '到量了，明天接着聊。'],
};
function pickTemplate(kind, state) {
  const arr = TEMPLATES[kind] || TEMPLATES.fallback;
  const recent = state.recentTemplates || [];
  const pool = arr.filter((x) => !recent.includes(x));
  const pick = (pool.length ? pool : arr)[Math.floor(Math.random() * (pool.length ? pool.length : arr.length))];
  state.recentTemplates = recent.concat([pick]).slice(-3);   // 最近三句不重复
  return pick;
}
export function templateKind(text) {
  const t = String(text || '').trim();
  if (t.length > 12) return '';
  if (/晚安|睡了|困了|早点睡|早点休息/.test(t)) return 'bye';
  // "吃什么都行""随便"不是问吃了没，别被模板接走；
  // 而且必须是"问句"（吃了吗/吃了没/吃什么），他说"吃饭了，有糖醋排骨"不是在问我
  if (/(吃|饭)[^。！？]{0,5}(吗|没|么)|吃啥|吃什么|吃了没|吃了吗/.test(t) && !/都行|随便|什么都行|不知道/.test(t)) return 'askEat';
  // 早上：必须从"早"开头，免得"早点睡"被当成打招呼
  if (/^(早|早安|早上好|早啊|醒了|起了|起床)/.test(t)) return 'morning';
  if (/想你|想我|想没想|惦记/.test(t)) return 'miss';
  if (/在干嘛|干嘛呢|在忙|忙吗|忙不忙|干啥呢/.test(t)) return 'askWhat';
  if (/在吗|在不在|在么|人呢/.test(t)) return 'greet';
  if (/哈哈|笑死|hhh|233/i.test(t)) return 'haha';
  return '';
}
// 只有 23:00–06:00 才算"深夜"。06:00–08:00 是早上，
// 那时候回"快去睡吧"很怪（这个错真的发生过）。
const isNight = () => { const h = nowHour(); return h >= 23 || h < 6; };
export function nowHour() { return Number(new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })); }

async function callModel(apiKey, messages, maxTokens = 380, temperature = 1.25) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'deepseek-flash', messages, max_tokens: maxTokens, temperature, top_p: 0.95, frequency_penalty: 0.5, presence_penalty: 0.4 }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || ('HTTP ' + r.status));
  return { text: String(j.choices?.[0]?.message?.content || '').trim(), usage: j.usage || {} };
}

function persona() {
  // 有 persona.md 就用它；没有就用示例人格（clone 下来就能跑）
  for (const f of [PERSONA, path.join(DIR, 'persona.example.md')]) {
    try { return fs.readFileSync(f, 'utf8'); } catch {}
  }
  return '你是哥的妹妹，说话短、口语、别客套。';
}

export function splitMemory(out) {
  const facts = [];
  const kept = [];
  const dropped = [];
  for (const l of String(out || '').split('\n')) {
    const m = l.match(/^#?\s*(记忆|记住)[:：]\s*(.+)$/);
    if (m) { for (const f of m[2].split(/[|｜;；]/)) { const s = f.trim().replace(/^[-*•\s]+/, ''); if (!s || s === '无') continue; if (s.length <= 30) facts.push(s); else dropped.push(s.slice(0, 40)); } continue; }
    kept.push(l);
  }
  return { text: kept.join('\n').trim(), facts, dropped };
}

/** 从他的信里挑"还没结论"的话：带问号，或说"看情况/回头再说" */
export function extractLoops(body) {
  const text = String(body || '');
  const hints = /(回头再说|看情况|到时候|再说吧|考虑一下|想想|看天气|不确定|可能要|下周|明天再看)/;
  const sentences = text.split(/(?<=[。！？!?~；;\n])/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    if (s.length < 6) continue;
    if (/[？?]/.test(s) || hints.test(s)) out.push(s.slice(0, 40));
  }
  return out.slice(0, 3);
}

/** body 里是不是又提到 loop 这件事（重叠两个词以上、且覆盖三成） */
export function mentions(loopText, body) {
  const lt = new Set(tokenize(loopText).filter((t) => t.length === 2));
  const bt = new Set(tokenize(body).filter((t) => t.length === 2));
  if (!lt.size) return false;
  let hit = 0;
  for (const t of lt) if (bt.has(t)) hit += 1;
  return hit >= 2 && hit / lt.size >= 0.25;
}

/** 这条事实在给定文字里有没有依据（短的只要一个词，长的要两个以上） */
export function supports(factText, sourceText) {
  const ft = [...new Set(tokenize(factText).filter((t) => t.length === 2))];
  const st = new Set(tokenize(sourceText).filter((t) => t.length === 2));
  if (!ft.length) return false;
  let hit = 0;
  for (const t of ft) if (st.has(t)) hit += 1;
  const need = String(factText).length <= 10 ? 1 : 2;
  return hit >= need;
}

/** 审计长期事实：模棱两可的、出处里找不到依据的，自动清掉（留档可查） */
export function auditFacts(state) {
  const recentText = recentRaw(30, 400).map((r) => r.text).join('\n');
  const keep = [];
  const dropped = [];
  for (const f of state.facts || []) {
    const text = String((f && f.text) || '');
    if (!text) { dropped.push({ text: '(空)', why: '空条目' }); continue; }
    if (/(好像|似乎|大概|应该是|也许|可能)/.test(text)) { dropped.push({ text, why: '模棱两可' }); continue; }
    const base = String((f && f.src) || '') + '\n' + recentText;
    if (!supports(text, base)) { dropped.push({ text, why: '出处里找不到依据' }); continue; }
    keep.push(f);
  }
  state.facts = keep;
  state.factsDropped = (state.factsDropped || []).concat(dropped.map((d) => ({ ...d, at: Date.now() }))).slice(-30);
  state.lastFactsAudit = Date.now();
  return { kept: keep.length, dropped };
}

/** 维护"悬着的事"清单：新出现的加进去，他已经回答过的移出去，最多留 5 条 7 天 */
export function recordLoops(state, body) {
  const now = Date.now();
  state.openLoops = (state.openLoops || [])
    .filter((l) => l && l.text && now - l.at < 7 * 86400000)
    .filter((l) => !mentions(l.text, body));   // 他再次提到这件事，就当已经聊过
  for (const t of extractLoops(body)) {
    if (state.openLoops.some((l) => similarity(l.text, t) >= 0.6)) continue;
    state.openLoops.push({ text: t, at: now });
  }
  state.openLoops = state.openLoops.slice(-5);
  return state.openLoops;
}

/** 挑一件"还没说完的事"提醒她可以追问（别挑跟这封信重复的） */
export function pickLoop(state, body) {
  const loops = state.openLoops || [];
  // 同一件事最多问两次，问过就别再念
  const cand = loops.filter((l) => similarity(l.text, body) < 0.5 && Number(l.asked || 0) < 2);
  return cand.length ? cand[cand.length - 1] : null;
}

/** 认识多少天了（从第一次通信算） */
export function daysTogether(state) {
  if (!state || !state.firstSeen) return 0;
  return Math.floor((Date.now() - state.firstSeen) / 86400000) + 1;
}

/** 两句话题的相似度（0~1）：判断"他是不是又在说同一件事" */
export function splitSelf(out) {
  const self = {};
  const kept = [];
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^#?\s*(我|自我)[:：]\s*(.+)$/);
    if (!m) { kept.push(line); continue; }
    const mm = m[2].match(/生日[^0-9]*(\d{1,2})\s*[-月\/]\s*(\d{1,2})/);
    if (mm) {
      const mo = Number(mm[1]);
      const dd = Number(mm[2]);
      if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) self.birthday = `${mo}-${dd}`;
    }
  }
  return { self, text: kept.join('\n').trim() };
}

/** 陌生人计数：同一地址累计多少封、够不够提醒、够不够拉黑 */
export function bumpStranger(state, addr, at = Date.now()) {
  if (Array.isArray(state.strangers)) state.strangers = {};   // 兼容旧的数组格式
  state.strangers = state.strangers || {};
  const rec = state.strangers[addr] || { count: 0, first: at, last: at, warnedAt: 0, blocked: false };
  rec.count += 1;
  rec.last = at;
  state.strangers[addr] = rec;
  const sinceWarn = rec.warnedAt ? at - rec.warnedAt : Number.POSITIVE_INFINITY;
  const shouldWarn = rec.count >= 3 && sinceWarn > 24 * 3600 * 1000;
  const shouldBlock = rec.count >= 10 && !rec.blocked;
  return { rec, shouldWarn, shouldBlock };
}

/** 只认写死的那个地址：空的 owner 一律不放行（防止"第一封来信自动认主"） */
export function isOwner(fromAddr, config) {
  const owner = String((config && config.owner) || '').trim().toLowerCase();
  return !!owner && String(fromAddr || '').trim().toLowerCase() === owner;
}

/** 事实入库前校验：必须能在他的原信里找到依据，否则是模型脑补的，丢掉 */
export function groundFacts(facts, body) {
  const bodySet = new Set(tokenize(body).filter((t) => t.length === 2));
  return facts.filter((f) => {
    const ts = [...new Set(tokenize(f).filter((t) => t.length === 2))];
    if (!ts.length) return false;
    const hit = ts.filter((t) => bodySet.has(t)).length;
    // 短事实（≤10 字）只要有一个词对得上就收——模型总结时总会改写措辞，
    // "最近总加班" vs "天天加班" 也该算有依据；长事实仍要 35% 以上重合兜底。
    const short = String(f).length <= 10;
    return short ? hit >= 1 : hit / ts.length >= 0.45;   // 长事实收紧到 45%，少让改写的东西混进来
  });
}

function addFacts(state, facts, src = '') {
  if (!Array.isArray(facts) || !facts.length) return 0;
  const norm = (s) => String(s).replace(/[，。！？、,.!?\s]/g, '');
  const have = new Set((state.facts || []).map((f) => norm(f.text)));
  let n = 0;
  for (const f of facts) {
    if (have.has(norm(f))) continue;
    // 每条事实都留一份"当时他原话"的出处，出了问题能对质
    state.facts = (state.facts || []).concat([{ text: f, addedAt: Date.now(), src: String(src || '').slice(0, 120) }]);
    have.add(norm(f));
    n += 1;
  }
  state.facts = (state.facts || []).slice(-20);
  return n;
}

export function humanize(text, cap = 220, maxSentences = 4) {
  let s = String(text || '').trim();
  s = s.replace(/^#{1,6}\s*/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`{1,3}/g, '');
  const BAD = [/希望(对你|能)有(所)?帮助/g, /有(什么|任何)(可以|需要)?(帮|需要)(助|的)?(吗|呢)?/g, /很(高兴|荣幸)(为您|为你)服务/g, /作为(一个)?AI/g, /总结一下/g, /首先[，,]?/g, /其次[，,]?/g, /最后[，,]?/g, /总之[，,]?/g, /总的来说[，,]?/g, /综合来看[，,]?/g, /建议你/g, /需要注意的是/g];
  for (const re of BAD) s = s.replace(re, '');
  s = s.replace(/,\s*/g, '，').replace(/!\s*/g, '！').replace(/\?\s*/g, '？').replace(/\.\s+/g, '。');
  const parts = s.split(/(?<=[。！？…~])/).filter((x) => x.trim());
  const keep = cap <= 60 ? 1 : maxSentences;
  s = (parts.length > keep ? parts.slice(-keep).join('') : s).replace(/\s+/g, ' ').trim();
  if (s.length > cap) s = s.slice(0, cap).replace(/[，。、；：]?$/, '') + '。';
  return s;
}

/** 数字护栏：回复里的数字必须是上下文里出现过的，否则整句删掉 */
function numbersIn(t) { return new Set(String(t || '').match(/\d+(?:\.\d+)?/g) || []); }
export function guardNumbers(reply, allowedText) {
  const allowed = numbersIn(allowedText);
  const parts = String(reply || '').split(/(?<=[。！？!?~])/).filter((x) => x.trim());
  if (!parts.length) return reply;
  const kept = parts.filter((p) => {
    for (const n of numbersIn(p)) if (!allowed.has(n)) return false;
    return true;
  });
  return kept.join('').trim();
}

/** 情绪：从她自己写的话里认，不花钱 */
export function emotionOf(t) {
  const s = String(t || '');
  if (/烦|讨厌|别烦|烦死|又来/.test(s)) return '有点烦';
  if (/心疼|可怜|辛苦|累|歇|别硬扛/.test(s)) return '心疼';
  if (/困|睡|晚安|明天/.test(s)) return '困';
  if (/笑|哈哈|乐|不许/.test(s)) return '被你逗笑';
  if (/哼|才不|不理|谁要/.test(s)) return '赌气';
  return '平静';
}

let wxCache = { at: 0, text: '', min: null, max: null };
async function weather() {
  if (Date.now() - wxCache.at < 3 * 3600 * 1000) return wxCache;
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=29.7136&longitude=120.2364&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai&forecast_days=1', { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const j = await r.json();
      const c = j?.current?.weather_code;
      const map = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 51: '毛毛雨', 53: '小雨', 55: '雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 95: '雷阵雨' };
      const t2 = Number(j?.current?.temperature_2m);
      const min = Number(j?.daily?.temperature_2m_min?.[0]);
      const max = Number(j?.daily?.temperature_2m_max?.[0]);
      wxCache = { at: Date.now(), min, max, text: `外面${map[c] || '阴晴不定'}，${Math.round(t2)}度${Number.isFinite(min) ? `（${Math.round(min)}~${Math.round(max)}度）` : ''}` };
    }
  } catch {}
  return wxCache;
}

/** 她能说自己正在干嘛的时刻表：允许的小时区间 + 当天最多说几次 + 下一步（用来串成一件事） */
const EXTRA_TABLE = [
  { text: '刚睡醒', hours: [[6, 9]], limit: 1, next: '在刷牙' },
  { text: '在刷牙', hours: [[6, 9], [21, 23]], limit: 2 },
  { text: '在做饭', hours: [[11, 13], [17, 20]], limit: 1, next: '在吃饭' },
  { text: '在等外卖', hours: [[17, 21]], limit: 1, next: '在吃饭' },
  { text: '在吃饭', hours: [[6, 9], [11, 13], [17, 20]], limit: 3, next: '刚吃完' },
  { text: '刚吃完', hours: [[7, 10], [12, 14], [18, 21]], limit: 3 },
  { text: '在洗头', hours: [[8, 22]], limit: 1, next: '在吹头发' },
  { text: '在吹头发', hours: [[8, 22]], limit: 1 },
  { text: '在收快递', hours: [[9, 20]], limit: 1, next: '在拆快递' },
  { text: '在拆快递', hours: [[9, 21]], limit: 1 },
  { text: '刚洗完澡', hours: [[21, 23], [0, 1]], limit: 1 },
  { text: '有点困', hours: [[21, 23], [0, 6]], limit: 2 },
  { text: '窝在沙发上', hours: [[9, 22]], limit: 1 },
  { text: '刚刷完手机', hours: [[9, 23]], limit: 1 },
  { text: '在发呆', hours: [[9, 22]], limit: 2 },
  { text: '刚晾完衣服', hours: [[9, 19]], limit: 1 },
  { text: '在倒垃圾', hours: [[8, 21]], limit: 1 },
  { text: '在泡面', hours: [[11, 14], [17, 22]], limit: 1 },
  { text: '在找钥匙', hours: [[8, 22]], limit: 1 },
  { text: '在看剧', hours: [[19, 23]], limit: 1 },
  { text: '在修电脑', hours: [[9, 22]], limit: 1 },
  { text: '在擦地', hours: [[9, 20]], limit: 1 },
  { text: '在收衣服', hours: [[17, 22]], limit: 1 },
  { text: '在翻冰箱', hours: [[11, 14], [18, 21]], limit: 1 },
];

const inHours = (h, ranges) => ranges.some(([x, y]) => (x <= y ? h >= x && h <= y : h >= x || h <= y));

/** 上一封说了什么，下一封可以"顺下去"的那个状态（比如 在等外卖 → 在吃饭） */
export function nextStep(lastText) {
  const row = EXTRA_TABLE.find((r) => r.text === lastText);
  return row && row.next ? row.next : '';
}

/** 今天的记账本：哪天说过哪些状态、各说了几次 */
function dayRec(state) {
  state.me = state.me || {};
  const d = state.me.day && state.me.day.date === today() ? state.me.day : { date: today(), used: {} };
  if (!d.used) d.used = {};
  state.me.day = d;
  return d;
}

/** 这个点她"可以说自己在干嘛"：既在时段内，也没超过当天次数 */
export function allowedExtras(state, h = nowHour()) {
  const d = (state && state.me && state.me.day && state.me.day.date === today()) ? state.me.day : { used: {} };
  const used = d.used || {};
  const out = [];
  for (const row of EXTRA_TABLE) {
    if (row.text === '刚睡醒' && d.wokeSaid) continue;
    if (!inHours(h, row.hours)) continue;
    if (Number(used[row.text] || 0) >= row.limit) continue;
    out.push(row.text);
  }
  return out;
}

/**
 * 此刻的状态：优先"把上一件事往下推一步"（等外卖 → 在吃饭 → 刚吃完），
 * 这样既不复读，也不显得跳来跳去；实在接不上才随机挑一个。
 */
function situation(state, wx, body = '') {
  const recent = (state.recentExtras || []).slice(-2);
  const last = state.lastSituation;
  const allowed = allowedExtras(state);
  const d = dayRec(state);
  const lastFresh = last && last.extra && Date.now() - last.at < 6 * 3600 * 1000;

  let extra = '';
  let continuing = false;

  // 他在说难受的事（累/病/吵架…）时，这次不谈"你正在干嘛"，先接他的话
  const heavy = /(累|难受|崩溃|撑不住|哭|病|疼|加班|委屈|吵架|分手|医院|失业|辞职)/.test(String(body || ''));

  // 1) 顺下去：上一封说在等外卖，这封就说在吃饭
  const nxt = lastFresh ? nextStep(last.extra) : '';
  if (!heavy && nxt && allowed.includes(nxt) && !recent.includes(nxt) && Math.random() < 0.6) {
    extra = nxt;
    continuing = true;
  }
  // 2) 原地延续：同一件事还没干完
  if (!heavy && !extra && lastFresh && allowed.includes(last.extra) && !recent.includes(last.extra) && Math.random() < 0.35) {
    extra = last.extra;
    continuing = true;
  }
  // 3) 都不行就随机挑（避开最近两封用过的）
  if (!heavy && !extra) {
    const pool = allowed.filter((x) => !recent.includes(x));
    const src = pool.length ? pool : allowed;
    if (src.length) extra = src[Math.floor(Math.random() * src.length)];
  }

  if (extra) {
    d.used = d.used || {};
    d.used[extra] = Number(d.used[extra] || 0) + 1;
    if (extra === '刚睡醒') d.wokeSaid = true;
    state.me.day = d;
  }
  const wxRecent = state.recentWeather || [];
  const wet = wxRecent.slice(-2).filter(Boolean).length >= 2;
  return { extra, weather: wet ? '' : (wx.text || ''), wet, continuing };
}

/** 口癖降频：最近 5 封里出现过 3 次以上的，这次禁掉 */
function bannedParticles(state) {
  const recent = (state.recentParticles || []).slice(-5);
  const out = [];
  for (const p of PARTICLE_LIST) {
    const n = recent.filter((set) => set.includes(p)).length;
    if (n >= 3) out.push(p);
  }
  return out;
}

/** 长度模式：三成短、六成中、一成多 */
function lengthMode() {
  const r = Math.random();
  if (r < 0.25) return 'short';
  if (r < 0.9) return 'normal';
  return 'long';                  // 长信只留 10%，他说太长不看
}

async function askModel({ apiKey, history, body, facts, state, hasAttach = false }) {
  const wx = await weather();
  const sit = situation(state, wx, body);
  const sleepy = nowHour() >= 2 && nowHour() < 5 && String(body || '').length <= 40;   // 凌晨迷糊，但你写长了照常回
  const mode = sleepy ? 'short' : lengthMode();
  const ban = bannedParticles(state);
  // 自适应温度：正经/难受的时候压低（少编），玩笑的时候抬高（活得起来），凌晨收着点
  const heavyMail = /(累|难受|崩溃|撑不住|哭|病|疼|委屈|吵架|分手|医院|失业|辞职|压力)/.test(String(body || ''));
  const playfulMail = /(哈哈|笑死|hhh|233|嘿嘿|笨蛋|傻)/i.test(String(body || ''));
  let temp = 1.25;
  if (heavyMail) temp = 1.05;
  else if (playfulMail) temp = 1.35;
  if (sleepy) temp = Math.min(temp, 1.15);
  const fs2 = (facts || []).slice(-20).map((f) => '- ' + (f.text || f)).join('\n');
  const hint = (state && state.__memoryOff) ? '' : memoryHint(body, 3);
  // 时段只认 timePolicy 一个口径：原来这里另算一套边界，5 点会同时出现"半夜"和"早上"
  const tp = timePolicy(nowHour());
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
  // 今天几号 + 距上一封信多久：让她能说"都 11 月了""你三天没理我"
  const dp = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const dateStr = `${dp.month} 月 ${dp.day} 日`;
  const gapMs = state && state.lastExchangeAt ? Date.now() - state.lastExchangeAt : 0;
  const gapStr = !gapMs ? ''
    : gapMs < 3600000 ? `距上一封信才 ${Math.max(1, Math.round(gapMs / 60000))} 分钟`
      : gapMs < 86400000 ? `距上一封信 ${Math.round(gapMs / 3600000)} 小时`
        : `距上一封信 ${Math.round(gapMs / 86400000)} 天`;

  const rules = [];
  {
    const sb = selfBlock(state && state.me);
    if (sb) rules.push(sb);
    rules.push('这些是底线，不是台词本：可以有态度、情绪、玩笑，可以拒绝回答、可以反问，只要别跟设定打架。');
    rules.push('档案之外可以说此刻的小动作（"懒得动""刚扎了头发"），但别编同事、亲戚、宠物这类来历。');
  }
  if (sleepy) rules.push('现在是凌晨，你困得不行：句子短、断断续续、别讲道理，可以直接说困、说明天说。');
  else if (mode === 'short') rules.push('这次只写一句，越短越好，两三个字也行（"啊？""行吧。""你管我呢。""服了。"），别解释。');
  else if (mode === 'long') rules.push('这次可以写三四句，说点具体的，但别写小作文。');
  else rules.push('一两句，最多三句。');
  rules.push(`现在是${week}${tp.slot}${sit.weather ? '，' + sit.weather : ''}${sit.extra ? '，你' + sit.extra : ''}。这个点适合聊：${tp.ok}；别说：${tp.avoid}。`);
  if (sit.continuing) rules.push(`你上一封说自己在干嘛，这次顺着往下推一步（比如等外卖→在吃饭→刚吃完），别跳去不相干的事。`);
  if (/(累|难受|崩溃|撑不住|哭|病|疼|委屈|吵架|分手)/.test(String(body || ''))) rules.push('他这封在说难受的事：先接他的话，别急着说自己刚在干嘛。');
  rules.push(`今天是${dateStr}${gapStr ? '，' + gapStr : ''}。`);
  rules.push('今天说过的状态别反口：说在等外卖就不能说刚睡醒，说刚睡醒就别提着出门。');
  {
    // 她自己说过的话要有账本：最近三封说过在干嘛 + 上一封的状态，免得她反问"我啥时候说过了"
    const said = (state.recentExtras || []).slice(-3).join('、');
    const last = state.lastSituation && state.lastSituation.extra ? `，上一封是「${state.lastSituation.extra}」` : '';
    if (said || last) rules.push(`最近说过自己在：${said || '没说'}${last}。说过就是说过，别否认。`);
  }
  if (sit.wet) rules.push('你前两封已经提过天气了，这次别再提天气。');
  if (hasAttach) rules.push('他这封带了附件（可能是照片），你看不到里面的内容——别装看得见，可以直说"图我看不到"。');
  if (ban.length) rules.push(`最近几封你老用「${ban.join('')}」，这次别用这些字。`);
  if (state.lastEmotion && state.lastEmotion !== '平静') rules.push(`上一封你的语气是「${state.lastEmotion}」，可以接着来，但别每封一个调。`);
  // 她自己的日记：最近两封的心情，让她有连续的状态，不是每封重启
  {
    const diary = (state.meDiary || []).slice(-2);
    if (diary.length) {
      const d = new Date(diary[diary.length - 1].at);
      const when = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
      rules.push(`你自己的状态：${when}那封是「${diary[diary.length - 1].mood}」${diary.length > 1 ? '，再上一封是「' + diary[0].mood + '」' : ''}。语气可以有起伏，但别突然换个人。`);
    }
  }
  // 抓字眼：从他这封信里截一句原话（4~12 字，不带标点），四成的信用上
  if (Math.random() < 0.4) {
    const phrase = (String(body || '').match(/[^。！？，,\n\s]{4,12}/) || [''])[0];
    if (phrase) rules.push(`他信里有句「${phrase}」——可以拎这句说一句（反驳、追问、或者学他口气），像人抓字眼；不自然就别用。`);
  }
  // 她自己的日程：只做一致性校验，不让她天天播报
  {
    const plan = state.mePlan;
    if (plan && plan.text && Date.now() - plan.at < 3 * 86400000) {
      rules.push(`你前几天说过「${plan.text}」。这封要是正好提到那天的事，别跟它对不上；不用特意提。`);
    }
  }
  // 她答应过的事：有就提一句，超过 7 天没兑现就当忘了（别一直念）
  {
    const ps = (state.promises || []).filter((p) => Date.now() - p.at < 7 * 86400000);
    const hit = ps.find((p) => similarity(p.text, body) >= 0.45);
    if (hit) state.promises = (state.promises || []).filter((p) => p !== hit);   // 他已经问到这件事，算兑现
    const left = (state.promises || []).filter((p) => Date.now() - p.at < 7 * 86400000).slice(-1)[0];
    if (left) rules.push(`你前几封说过「${left.text}」。这封要是自然，就兑现一句或者提一下；不自然就别硬扯。`);
  }
  // 旧事重提：四封里有一封，能想起一件 20 天前的事
  if (Math.random() < 0.25) {
    try {
      const old = recentRaw(400, 60).filter((e) => Date.now() - e.at > 20 * 86400000);
      if (old.length) {
        const e = old[Math.floor(Math.random() * old.length)];
        rules.push(`有件旧事：${String(e.text).slice(0, 40)}（${e.who === 'he' ? '他说的' : '你说的'}）。自然就顺口提一句，不自然就当没想起来，别硬扯。`);
      }
    } catch {}
  }
  rules.push('他一段话里可能说了好几件事，你只接最戳你的那一件，别的先不管。');
  // 同一件事反复说：别再安慰，别再重复上次的说法
  const prevBodies = (history || []).filter((h) => h.role === 'user').slice(-4).map((h) => String(h.text || ''));
  if (prevBodies.some((p) => similarity(body, p) >= 0.5)) {
    rules.push('这件事他已经说过好几遍了。别再安慰他，也别重复上次的说法——可以直接吐槽、点破他，或者干脆问别的。');
  }
  rules.push('别用他信里没有的数字、日期、金额、人名地名。');
  rules.push('记忆片段里的事只能照抄，不许给它补时间、补地点、补细节。');
  if (state && state.me && state.me.birthday) rules.push('生日照档案说，别改口。');   // selfBlock 已经写了具体日子，这里只留一句约束
  // 别把刚问过的问题再问一遍
  {
    const loop = pickLoop(state || {}, body);
    if (loop) {
      loop.asked = Number(loop.asked || 0) + 1;
      rules.push(`他有件事还悬着没结论："${loop.text}"。可以问一句（这件事你最多问两次，这是第 ${loop.asked} 次）。`);
    }
    const days = daysTogether(state || {});
    if (days >= 100 && days % 100 === 0 && state && state.milestone !== days) {
      state.milestone = days;
      rules.push(`今天是你们认识的第 ${days} 天。可以顺口提一句，别煽情。`);
    }
  }
  const asked = (history || []).filter((h) => h.role === 'assistant').slice(-3)
    .flatMap((h) => String(h.text || '').split(/(?<=[。！？!?~])/))
    .filter((s) => /[？?]/.test(s)).map((s) => s.trim()).slice(-3);
  if (asked.length) rules.push(`这些你最近刚问过，别再重复问：${asked.join(' / ')}`);

  // 历史分两段：最近 3 轮给全文，更早的压成一行摘要（放 system 里，不占对话轮次）
  const histAll = (history || []).slice(-MAX_HISTORY);
  const histFull = histAll.slice(-6);
  const olderBrief = histAll.slice(0, Math.max(0, histAll.length - 6))
    .map((h) => (h.role === 'user' ? '他：' : '我：') + String(h.text || '').slice(0, 30)).join('\n');

  const msgs = [
    {
      role: 'system',
      // 顺序有讲究：人设 + 例子永远不变，放最前面（DeepSeek 的前缀缓存能命中，输入更便宜）；
      // 记忆、事实、更早的摘要每次都不一样，放后面，不破坏缓存。
      content: persona() + `

# 她说话的样子（例子，别照抄句式）
他：今天加班到现在才回来，累死了
她：几点才下班啊？吃了没。

他：我今天有点难受
她：哪儿难受？别自己扛着。
` + (fs2 ? '\n\n# 你记得关于哥的事\n' + fs2 : '') + (hint ? '\n\n' + hint : '') + (olderBrief ? '\n\n# 更早聊过的（只留要点）\n' + olderBrief : ''),
    },
    ...histFull.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: `哥给你发邮件说：\n${body}\n\n（${rules.join('\n')}\n先回他这封信里说的那件事——记忆、天气、"你在干嘛"都只能顺口带一句，不能盖过他的话题，更别答非所问。直接写正文，不加称呼、不加落款、不列举。\n最后单独一行写「#记忆: 事实1 | 事实2」，每条不超过 20 字、最多三条；只写这封信里他明确说过的、长期有用的事，没有就写「#记忆: 无」。
如果这封信里提到了你的生日（不管是他在问，还是你自己顺嘴说到"我几月几号生日"），而你还没有生日，就再单独写一行「#我: 生日 M-D」把它定下来——只定这一次，之后不许改口。）` },
  ];
  // short 也要装得下「正文 + #记忆 行」：160 不够，正文写满就把记忆行挤掉了
  const budget = mode === 'short' ? 240 : mode === 'long' ? 520 : 380;
  let out = await callModel(apiKey, msgs, budget, temp);
  let parsed0 = splitSelf(out.text);
  let parsed = splitMemory(parsed0.text);
  if (parsed0.self.birthday && state && (!state.me || !state.me.birthday)) {
    state.me = { ...(state.me || {}), birthday: parsed0.self.birthday, setAt: Date.now() };
    saveState(state);
    log('她给自己定下了生日：' + parsed0.self.birthday);
  }
  let usage = out.usage;
  if (!parsed.text.trim()) {
    // 极短模式偶尔把预算全用在「#记忆」那行上，正文是空的。
    // 这时候再要一次，明确只要正文——比发一句模板话给她强。
    const again = await callModel(apiKey, [
      ...msgs,
      { role: 'assistant', content: out.text || '（空）' },   // 补上他刚才那条，不然上下文里没有「刚才那条」
      { role: 'user', content: '刚才那条只有记忆行没有正文。这次只写回信，不要写记忆行。' },
    ], Math.max(budget, 240), temp);
    parsed = splitMemory(splitSelf(again.text).text);   // 重试也要认「#我: 生日」，别把它丢了
    usage = { prompt_tokens: (usage.prompt_tokens || 0) + (again.usage.prompt_tokens || 0), completion_tokens: (usage.completion_tokens || 0) + (again.usage.completion_tokens || 0) };
  }
  const { text, facts: raw } = parsed;
  // 诊断（确认事实链路后可以删）：分清楚"模型没写记忆行"和"写了但被 30 字上限丢掉"
  if (parsed.dropped && parsed.dropped.length) log('事实被丢弃 ' + parsed.dropped.length + ' 条（超过 30 字）：' + parsed.dropped.join(' / '));
  else if (!raw.length && /(记忆|记住)[:：]/.test(out.text)) log('模型写了记忆行，但没有可用事实');
  const cap = mode === 'short' ? (sleepy ? 30 : 24) : mode === 'long' ? 220 : 220;
  let reply = humanize(text, cap);
  // 她自己的生日也算"允许的数字"——不然她说"6 月 17 日"会被护栏当成乱编删掉
  const selfNums = state && state.me && state.me.birthday ? state.me.birthday.replace('-', ' ') + ' ' + state.me.birthday.split('-').join(' 月 ') : '';
  // 只放行这几处的数字：他这封、天气、日期、间隔、星期、她的生日、长期事实、最近两条历史
  // （原来放行全部历史，等于只要历史上出现过"3"，她就能编"3 斤"）
  const allowed = [body, sit.weather, dateStr, gapStr, week, selfNums, ...(facts || []).map((f) => f.text || f), ...(history || []).slice(-2).map((h) => h.text)].join('\n');
  reply = guardNumbers(reply, allowed);
  reply = guardTime(reply, nowHour());   // 早上别道晚安，深夜别问早安
  reply = guardSelf(reply);              // 不许编"我同事"这类来历
  // 跑题检测：只记账不重写。跑题率高了再去调提示词，别凭感觉改
  try {
    if (reply && similarity(body, reply) < 0.12 && !/[？?]/.test(reply)) {
      log(`可能跑题：他说「${String(body).slice(0, 18)}」她回「${String(reply).slice(0, 18)}」`);
    }
  } catch {}
  return { reply, facts: raw, usage, mode, sit, temp };
}

let balCache = { at: 0, val: -1 };
let BAL_OVERRIDE = null;   // 仅调试用：--lowbal 1.5 假装余额只剩 1.5
async function balanceOf(apiKey, force = false) {
  if (BAL_OVERRIDE !== null) return BAL_OVERRIDE;
  if (!force && Date.now() - balCache.at < 10 * 60000) return balCache.val;   // 十分钟查一次就够
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const b = (j.balance_infos || [])[0];
    const v = b ? Number(b.total_balance) : 0;
    balCache = { at: Date.now(), val: v };
    return v;
  } catch { balCache = { at: Date.now(), val: -1 }; return -1; }
}

const costOf = (usage) => ((usage?.prompt_tokens || 0) * 0.5 + (usage?.completion_tokens || 0) * 8) / 1e6;   // 单价：输入 0.5 元/M、输出 8 元/M

function addCost(state, usage) {
  const c = costOf(usage);
  if (state.costDay !== today()) { state.costDay = today(); state.costToday = 0; }
  state.costToday = Number(state.costToday || 0) + c;
  return c;
}

/** 按真实钟点给她一份"现在该干嘛"的说明 */
/** 她固定的"自己"：写在这里的才许说，别的一律不编 */
export const SELF_DEFAULTS = {
  likes: ['辣', '下雨天', '半夜刷手机'],
  dislikes: ['被叫大肥鱼', '别人熬夜', '听到"随便"'],
  habits: ['爱把头发扎起来', '睡前刷手机', '吃饭挑食，先吃菜'],
};

/** 不许她编"我同事/我朋友"这类来历（第二人称照常，说"你同事"没问题） */
export function guardSelf(reply) {
  const banned = ['我同事', '我朋友', '我同学', '我闺蜜', '我室友', '我老板', '我领导', '我男朋友', '我女朋友', '我家猫', '我家狗', '我宠物', '我亲戚', '我表哥', '我堂哥'];
  const parts = String(reply || '').split(/(?<=[。！？!?~])/).filter((x) => x.trim());
  if (!parts.length) return reply;
  const kept = parts.filter((x) => !banned.some((b) => x.includes(b)));
  return kept.join('').trim();
}

/** 把档案拼成提示词用的一段 */
export function selfBlock(me) {
  const m = me || {};
  const line = (label, arr) => (Array.isArray(arr) && arr.length ? `- ${label}：${arr.join('、')}` : '');
  const rows = [
    m.birthday ? `- 生日：${m.birthday.split('-')[0]} 月 ${m.birthday.split('-')[1]} 日` : '',
    line('喜欢', m.likes),
    line('受不了', m.dislikes),
    line('小习惯', m.habits),
  ].filter(Boolean);
  if (!rows.length) return '';
  return ['# 关于你自己（固定的，不许改口）', ...rows].join('\n');
}

export function timePolicy(h = nowHour()) {
  if (h >= 5 && h < 9) return { slot: '早上', ok: '刚醒、洗漱、早饭、今天要干嘛', avoid: '晚安、早点睡、该睡了' };
  if (h >= 9 && h < 11) return { slot: '上午', ok: '上班、路上、正经事', avoid: '晚安、早点睡、刚睡醒' };
  if (h >= 11 && h < 14) return { slot: '中午', ok: '吃饭、午休、歇一会儿', avoid: '晚安、早上好、该睡了' };
  if (h >= 14 && h < 18) return { slot: '下午', ok: '上班、犯困、熬到下班', avoid: '晚安、早安、早上好' };
  if (h >= 18 && h < 23) return { slot: '晚上', ok: '吃饭、下班、放松、洗澡', avoid: '早上好、早安、中午好' };
  return { slot: '深夜', ok: '困、睡不着、别熬夜', avoid: '早上好、早安、中午好、下午好' };
}

/** 时间打架的句子直接删掉（跟数字护栏一个思路） */
export function guardTime(reply, h = nowHour()) {
  const p = timePolicy(h);
  const bads = p.avoid.split('、').filter(Boolean);
  const parts = String(reply || '').split(/(?<=[。！？!?~])/).filter((x) => x.trim());
  if (!parts.length) return reply;
  const kept = parts.filter((s) => !bads.some((b) => s.includes(b)));
  return kept.join('').trim();
}

/** 这一封能不能花钱；不能就回原因（用来降级成模板） */
export function budget(state, config, bal) {
  if (state.costDay === today() && Number(state.costToday || 0) >= Number(config.dailyCostCap || 0.05)) return '今日到预算上限';
  if (bal >= 0 && bal < 0.5) return '余额不足';
  if (bal >= 0 && bal < 1) return '余额偏低';
  return '';
}

/** 发信延迟：白天压到 30 分钟内（免得"现在"过期），深夜他醒着就快一点 */
export function sendDelayMs(templateUsed, style = 'human') {
  // 节奏可调：instant（2~8 秒）/ fast（20~90 秒）/ human（白天 2~30 分钟，夜里 1~6 分钟）
  const hh = nowHour();
  if (hh >= 2 && hh < 5) return 5 * 60000 + Math.floor(Math.random() * 10 * 60000);   // 凌晨她睡着了，5~15 分钟才回
  if (style === 'instant') return 2000 + Math.floor(Math.random() * 6000);
  if (style === 'fast') return 20000 + Math.floor(Math.random() * 70000);
  if (templateUsed) return 20000 + Math.floor(Math.random() * 40000);
  const h = nowHour();
  if (h >= 23 || h < 8) return 60000 + Math.floor(Math.random() * 5 * 60000);   // 夜里 1~6 分钟
  const r = Math.random();
  if (r < 0.25) return 2 * 60000 + Math.floor(Math.random() * 6 * 60000);       // 2~8 分钟
  if (r < 0.85) return 8 * 60000 + Math.floor(Math.random() * 12 * 60000);      // 8~20 分钟
  return 20 * 60000 + Math.floor(Math.random() * 10 * 60000);                   // 20~30 分钟
}

function enqueue(state, item) {
  // 不在这里落盘：唯一的调用方 processOne 紧接着就 saveState，省一次 5KB 备份+写入
  state.outbox = (state.outbox || []).concat([{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...item }]);
}

/** 到点了就发。发成功才记历史、记记忆、加计数 */
/** 从她自己的话里抓"我答应过的事"：我明天… / 回头给你… / 下次再聊… */
function extractPromises(text) {
  const t = String(text || '');
  const out = [];
  const re = /我(?:明天|后天|回头|下次|改天|过两天|晚点)[^。！？\n]{2,18}|(?:明天|回头|下次|改天)[^。！？\n]{0,10}(?:给你|跟你说|再聊|告诉你|讲给你)/g;
  for (const m of t.matchAll(re)) out.push(String(m[0]).trim().slice(0, 30));
  return out.slice(0, 2);
}

async function flushOutbox(config, state, auth) {
  const box = state.outbox || [];
  if (!box.length) return 0;
  const now = Date.now();
  let sent = 0;
  for (const item of box.slice()) {
    if (item.dueAt > now) continue;
    try {
      await sendMail({ to: item.to, subject: item.subject, text: item.text, inReplyTo: item.inReplyTo, references: item.references, auth });
    } catch (e) {
      item.tries = Number(item.tries || 0) + 1;
      log(`发送失败（第 ${item.tries} 次）：${e.message}`);
      if (item.tries >= 3) {
        state.outbox = state.outbox.filter((x) => x.id !== item.id);
        await alertOnce('drop', `有封回信试了三次都没发出去，先丢了：\n\n${String(item.text || '').slice(0, 200)}`);
      }
      saveState(state);
      continue;
    }
    if (state.day !== today()) { state.day = today(); state.count = 0; state.usedToday = 0; }
    state.count = Number(state.count || 0) + 1;
    state.usedToday = Number(state.usedToday || 0) + 1;   // 她这一封也算一次互动
    // 只有真回信才记进历史；自检/主动来信这种没有"他说的"就不塞空条目
    const hisEntry = item.his ? [{ role: 'user', text: String(item.his).slice(0, 600) }] : [];
    state.history = (state.history || []).concat(hisEntry, [{ role: 'assistant', text: item.text.slice(0, 600) }]).slice(-24);
    state.lastExchangeAt = Date.now();
    if (!state.firstSeen) state.firstSeen = Date.now();
    if (!state.__memoryOff) recordLoops(state, item.his || '');
    state.unansweredProactive = 0;
    state.lastEmotion = item.emotion || state.lastEmotion;
    // 她自己的日记：一封一条，只留最近 6 条（不发出去，只给她自己下次看）
    state.meDiary = (state.meDiary || []).concat([{ at: Date.now(), mood: item.emotion || emotionOf(item.text) }]).slice(-6);
    // 她随口说的"今天/明天要干嘛"：只留最新一条，用来防上下封信互相打架
    {
      const pm = String(item.text || '').match(/(今天|明天|后天)(要|得|准备|打算)?[^。！？\n]{2,12}/);
      if (pm) state.mePlan = { at: Date.now(), text: pm[0].trim().slice(0, 24) };
    }
    // 她自己答应过的事：只记 7 天内的，最多 3 条
    {
      const fresh = extractPromises(item.text);
      if (fresh.length) {
        const keep = (state.promises || []).filter((p) => Date.now() - p.at < 7 * 86400000).slice(-3);
        state.promises = keep.concat(fresh.map((t) => ({ at: Date.now(), text: t }))).slice(-4);
        log('她答应了：' + fresh.join(' / '));
      }
    }
    state.recentExtras = (state.recentExtras || []).concat([item.extra].filter(Boolean)).slice(-3);
    if (item.extra) state.lastSituation = { extra: item.extra, at: Date.now() };   // 下一封可以接着这个状态
    state.recentWeather = (state.recentWeather || []).concat([!!item.weatherUsed]).slice(-4);
    state.recentParticles = (state.recentParticles || []).concat([PARTICLE_LIST.filter((p) => item.text.includes(p))]).slice(-5);
    if (item.his && !state.__memoryOff) { remember('he', item.his); remember('me', item.text); }
    state.outbox = state.outbox.filter((x) => x.id !== item.id);
    if (state.alerts && state.alerts.send) delete state.alerts.send;   // 发信恢复正常，下次坏了再提醒
    saveState(state);
    sent += 1;
    log(`发出去了：${item.text.slice(0, 36)}${item.text.length > 36 ? '…' : ''}`);
  }
  return sent;
}

/** 周记 / 年记：从原文档案里翻这段时间的记录，写一封回顾 */
async function writeDigest({ apiKey, config, state, auth, kind, dry = false, holiday = '' }) {
  const cfg = config.summary || {};
  const isHisBday = kind === 'birthday';
  const isHerBday = kind === 'herBirthday';
  const days = kind === 'yearly' ? 365 : kind === 'monthly' ? 31 : 1;
  const rows = recentRaw(days, kind === 'yearly' ? 300 : 160);
  if (!rows.length && !isHisBday && !isHerBday) { log('没有记录，这次不写回顾'); return false; }
  const lines = rows.slice().reverse().map((e) => {
    const d = new Date(e.at);
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${md} ${e.who === 'he' ? '哥' : '我'}：${String(e.text).slice(0, 60)}`;
  }).join('\n');
  const facts = (state.facts || []).slice(-20).map((f) => '- ' + f.text).join('\n');

  // 五种回顾共用一套逻辑，只是长度、语气候选、题头不同
  const spec = kind === 'yearly'
    ? { what: '这一年', title: '年记', chars: '120~180 字', tokens: 550, cap: 450,
        styles: ['按季节过一遍，只写你记得最清楚的那几件', '像给一年做个了断，带点感慨但别煽情', '挑三件今年最想说的事，其余略过'] }
    : kind === 'monthly'
      ? { what: '这个月', title: '月记', chars: '80~120 字', tokens: 400, cap: 300,
          styles: ['挑两件事说说，别的略过', '带点吐槽，把他这个月让你无语的地方写进去', '只讲一件这个月你最记得的事，其它不提'] }
      : kind === 'holiday'
        ? { what: '节日', title: '节日信', chars: '60~120 字', tokens: 400, cap: 300,
            styles: ['说说你今天怎么过的，别写祝福套话', '带点吐槽（月饼难吃、亲戚太多、外面太挤）', '只提一件今天发生的小事，再问一句他那边'] }
        : isHisBday
        ? { what: '生日', title: '生日贺报', chars: '50~90 字', tokens: 350, cap: 260,
            styles: ['像随口说一句生日快乐，别煽情', '带点小吐槽，别肉麻', '说一件你记得的他的小事，再祝一句'] }
        : { what: '我的生日', title: '我的生日', chars: '60~90 字', tokens: 350, cap: 260,
            styles: ['像随口提一句今天是我生日，可以跟他要点什么', '带点小得意，让他说句好听的', '平平淡淡说一句，别撒娇过头'] };
  const style = spec.styles[Math.floor(Math.random() * spec.styles.length)];
  const intro = kind === 'holiday'
    ? `今天是${holiday || '节日'}。你给哥写封短信，说你今天怎么过的——用你自己的角度，别写拜年话、别群发式祝福。你记得关于他的事：\n${facts || '（没什么特别的）'}`
    : isHisBday
    ? `今天是哥的生日。你给他写一封短贺报，不用回顾聊天记录。你记得关于他的事：\n${facts || '（没什么特别的）'}`
    : isHerBday
      ? `今天是你的生日（${state.me && state.me.birthday ? state.me.birthday : ''}）。你给哥写封短信告诉他今天是你的生日，不用回顾聊天记录。你记得关于他的事：\n${facts || '（没什么特别的）'}`
      : `下面是${spec.what}你们写信的记录（新的在上）：\n\n${lines}\n${facts ? '\n你记得关于哥的事：\n' + facts : ''}`;
  const msg = `${intro}\n\n写一封${spec.title}给他：用你平时的口吻，${spec.chars}，只写记录里有的，不许编。\n风格：${style}。\n别写成报告：不要分条列举，不要"总结""回顾"这种标题，不要开头排比。主题名你自己起，越随意越好。\n输出格式：第一行"主题：xxx"（8 字以内），空一行，正文。`;
  try {
    const out = await callModel(apiKey, [{ role: 'system', content: persona() }, { role: 'user', content: msg }], spec.tokens);
    const cost = addCost(state, out.usage);
    const mm = out.text.match(/^主题[:：]\s*(.+)\n+([\s\S]+)$/);
    const subject = (mm ? mm[1] : spec.title).trim().slice(0, 20);
    const body = humanize((mm ? mm[2] : out.text).trim(), spec.cap, Infinity);
    if (!body) return false;
    if (dry) { log(`[dry] 主题：${subject}\n[dry] 正文：${body}`); return true; }
    await sendMail({ to: config.owner || MAIL_USER, subject, text: body, auth });
    if (kind === 'yearly') state.lastYearlyYear = new Date().getFullYear();
    if (kind === 'monthly') state.lastMonthDigest = monthKey(-1);
    if (kind === 'birthday') state.lastBirthdayYear = new Date().getFullYear();
    if (kind === 'herBirthday') state.lastHerBirthdayYear = new Date().getFullYear();
    saveState(state);
    log(`写了${spec.title}：${subject}（约 ${cost.toFixed(5)} 元）`);
    return true;
  } catch (e) { log('写回顾失败：' + e.message); return false; }
}

/** 某个月的年月键，比如 2026-10 */
function monthKey(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d);
}

/** 每隔一阵子，她给未来的他留一封短信，排到几天后再寄 */
async function maybeFutureLetter({ apiKey, config, state, auth }) {
  const cfg = config.future || {};
  if (cfg.enabled === false) return;
  const gapDays = Number(cfg.gapDays || 12);
  if (state.lastFutureAt && Date.now() - state.lastFutureAt < gapDays * 86400000) return;
  if ((state.outbox || []).some((o) => o && o.future)) return;   // 已经有一封在路上
  try {
    const delayDays = 3 + Math.floor(Math.random() * 8);   // 3~10 天后寄
    const msg = `你给哥写一封短消息，现在不寄，${delayDays} 天后才寄出去。就当留给未来的他一句：说说你现在在想什么，或者到时候想问问他什么。用你平时的口吻，一两句，别煽情、别写祝福。\n输出格式：第一行"主题：xxx"（8 字以内），空一行，正文。`;
    const out = await callModel(apiKey, [{ role: 'system', content: persona() }, { role: 'user', content: msg }], 260);
    const cost = addCost(state, out.usage);
    const m = out.text.match(/^主题[:：]\s*(.+)\n+([\s\S]+)$/);
    const subject = (m ? m[1] : '留着').trim().slice(0, 20);
    let body = humanize((m ? m[2] : out.text).trim(), 220);
    body = guardNumbers(body, '');          // 未来的信没有上下文，数字一律不许
    body = guardTime(body, nowHour());      // 也别在早上写"晚安"
    if (!body) return;
    enqueue(state, { dueAt: Date.now() + delayDays * 86400000 + 3600 * 1000, to: config.owner || MAIL_USER, subject, text: body, future: true, createdAt: Date.now() });
    state.lastFutureAt = Date.now();
    saveState(state);
    log(`给未来留了一封（${delayDays} 天后寄）：${subject}（约 ${cost.toFixed(5)} 元）`);
  } catch (e) { log('写未来信失败：' + e.message); }
}

/** 到点了没：月记（每月 1 号早上）、年记（12-31 晚）、他生日（当天早 8 点）、她生日（当天早 9 点） */
async function maybeSummaries(apiKey, config, state, auth) {
  const cfg = config.summary || {};
  const now = new Date();
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5);
  const ymd = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const md = ymd.slice(5);
  const day = Number(ymd.slice(8, 10));

  if (cfg.monthly !== false && day === 1 && hhmm >= (cfg.monthlyTime || '09:00') && state.lastMonthDigest !== monthKey(-1)) {
    await writeDigest({ apiKey, config, state, auth, kind: 'monthly' });
  }
  if (cfg.yearly !== false && md === '12-31' && hhmm >= (cfg.yearlyTime || '21:00') && Number(state.lastYearlyYear) !== now.getFullYear()) {
    await writeDigest({ apiKey, config, state, auth, kind: 'yearly' });
  }
  // 他的生日：那天早上发，别凌晨
  const bd = String(config.birthday || cfg.birthday || '').trim();
  if (cfg.birthday !== false && /^\d{2}-\d{2}$/.test(bd) && bd === md && hhmm >= (cfg.birthdayTime || '08:00') && Number(state.lastBirthdayYear) !== now.getFullYear()) {
    await writeDigest({ apiKey, config, state, auth, kind: 'birthday' });
  }
  // 节日：元旦/除夕/春节/中秋，当天早上发，同一天只发一次
  const hol = HOLIDAYS.find((h) => h.dates.includes(ymd) || h.dates.includes(md));
  const holKey = hol ? hol.key + '-' + ymd.slice(0, 4) : '';
  if (cfg.holiday !== false && hol && hhmm >= (cfg.holidayTime || '09:00') && state.lastHolidayKey !== holKey) {
    state.lastHolidayKey = holKey;
    await writeDigest({ apiKey, config, state, auth, kind: 'holiday', holiday: hol.name });
  }
  // 她自己的生日：她自己定下来的那天（state.me.birthday），早上发一封告诉他
  const herBd = state.me && state.me.birthday ? String(state.me.birthday) : '';
  if (cfg.herBirthday !== false && /^\d{1,2}-\d{1,2}$/.test(herBd) && herBd.padStart(5, '0') === md && hhmm >= (cfg.herBirthdayTime || '09:00') && Number(state.lastHerBirthdayYear) !== now.getFullYear()) {
    await writeDigest({ apiKey, config, state, auth, kind: 'herBirthday' });
  }
}

export function proactivePlan(state, cfg) {
  const day = today();
  if (state.proactivePlan && state.proactivePlan.day === day) return state.proactivePlan;
  const wins = Array.isArray(cfg.windows) && cfg.windows.length ? cfg.windows : [String(cfg.time || '20:30') + '-' + String(cfg.time || '20:30')];
  const max = Number(cfg.maxPerDay || wins.length);
  const items = [];
  for (const w of wins.slice(0, max)) {
    const m = String(w).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s*\*\s*([\d.]+))?$/);
    if (!m) continue;
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    if (to <= from) continue;
    // *0.35 这种后缀：只有这么多比例的日子会写，其余天她睡了
    const chance = m[5] == null ? 1 : Math.max(0, Math.min(1, Number(m[5])));
    if (chance < 1 && Math.random() > chance) continue;   // 今天这一格她不写了
    const pick = from + Math.floor(Math.random() * (to - from));   // 窗口里随机一分钟，别每天同一时刻
    const d = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    // TZ 默认 Asia/Shanghai（+08:00）；换时区要一起改这里
    const at = new Date(`${d.year}-${d.month}-${d.day}T${String(Math.floor(pick / 60)).padStart(2, '0')}:${String(pick % 60).padStart(2, '0')}:00+08:00`).getTime();
    // 已经过去超过 5 分钟的窗口算"错过"，标成 sent，免得一重启就补发一串
    items.push({ at, sent: at < Date.now() - 5 * 60 * 1000 });
  }
  items.sort((a, b) => a.at - b.at);
  state.proactivePlan = { day, items };
  saveState(state);   // 落盘：重启不会重抽，也方便在状态里查
  return state.proactivePlan;
}

async function maybeProactive(apiKey, config, state, auth) {
  const cfg = config.proactive || {};
  if (cfg.enabled === false) return;
  const now = new Date();
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5);
  const quietFrom = cfg.quietFrom || '23:00';
  const quietTo = cfg.quietTo || '07:00';
  const inQuiet = quietFrom <= quietTo ? (hhmm >= quietFrom && hhmm < quietTo) : (hhmm >= quietFrom || hhmm < quietTo);
  if (inQuiet) return;
  // 先过闸门，再看窗口——否则被挡掉时这一格会被标成已用，白丢了
  if (Number(state.unansweredProactive || 0) >= Number(cfg.maxUnanswered || 2)) { log('连着两封没回，先不主动了'); return; }
  const gapH = Number.isFinite(Number(cfg.minGapHours)) ? Number(cfg.minGapHours) : 6;
  if (state.lastExchangeAt && Date.now() - state.lastExchangeAt < gapH * 3600 * 1000) return;
  // 到点了没有：窗口里随机挑的那一分钟
  const plan = proactivePlan(state, cfg);
  const due = plan.items.find((it) => !it.sent && Date.now() >= it.at);
  if (!due) return;
  due.sent = true;   // 过了闸门才标，免得每 100 秒重复触发
  saveState(state);

  const wx = await weather();
  const reasons = [];
  if (!state.lastExchangeAt || Date.now() - state.lastExchangeAt > 36 * 3600 * 1000) reasons.push('好久没聊');
  if (Number.isFinite(wx.min) && Number.isFinite(wx.max) && wx.max - wx.min >= 8) reasons.push('温差大');
  if ([5, 6, 0].includes(now.getDay()) && Number(hhmm.slice(0, 2)) >= 20) reasons.push('周末晚上');
  if (!reasons.length) reasons.push('就是想跟你说句话');   // 窗口是他挑的，不用再等由头

  try {
    const facts = (state.facts || []).slice(-20).map((f) => '- ' + f.text).join('\n');
    const msg = `现在是 ${hhmm}，${wx.text || ''}（由头：${reasons.join('、')}）。哥今天还没跟你说话。你主动写封邮件：用你平时的口吻，一两句话，别客套，别问"在吗"，别问"最近怎么样"，别用他信里没有的数字。\n输出格式：第一行"主题：xxx"（6 字以内），空一行，正文。`;
    const out = await callModel(apiKey, [{ role: 'system', content: persona() + (facts ? '\n\n# 你记得关于哥的事\n' + facts : '') }, { role: 'user', content: msg }], 220);
    const cost = addCost(state, out.usage);
    const m = out.text.match(/^主题[:：]\s*(.+)\n+([\s\S]+)$/);
    const subject = (m ? m[1] : '随口问一句').trim().slice(0, 20);
    let body = humanize((m ? m[2] : out.text).trim(), 220);
    body = guardNumbers(body, [wx.text || '', hhmm, reasons.join('、')].join('\n'));
    body = guardTime(body, nowHour());
    body = guardSelf(body);
    if (!body) return;
    await sendMail({ to: config.owner || MAIL_USER, subject, text: body, auth });
    state.lastProactiveDay = today();   // 只作统计
    state.unansweredProactive = Number(state.unansweredProactive || 0) + 1;
    saveState(state);
    log(`主动写了一封：${subject}｜${body.slice(0, 40)}（约 ${cost.toFixed(5)} 元）`);
  } catch (e) { log('主动来信失败：' + e.message); }
}

async function processOne({ body, subject, fromAddr, msgId, refs, hasAttach, config, state, auth, apiKey, bal }) {
  const secret = String(config.secret || '').trim();
  const everyTime = config.secretEveryTime === true;
  const needSecret = secret && (everyTime || !state.secretOkAt);
  const hasSecret = secret && String(body || '').includes(secret);
  if (needSecret && !hasSecret) {
    log('还没认过门（或要求每封都验），这封没带口令，不回');
    return false;
  }
  if (hasSecret) {
    if (!state.secretOkAt) { state.secretOkAt = Date.now(); saveState(state); log('口令验证通过，以后不用再带了'); }
    // 不管验没验过，都把口令从正文里摘掉：她不该看到，也不会复述
    body = String(body).split(secret).join('').replace(/^[\s，,。:：]+/, '').trim();
  }
  // 上一封还没发出去，他又补了一封：合成一封回，别回两遍
  const pending = (state.outbox || []).find((o) => o.fromMail && Number(o.createdAt || 0) && Date.now() - o.createdAt < 10 * 60000);
  if (pending && pending.his) {
    body = `${pending.his}\n\n（他紧接着又发了一封）\n${body}`;
    state.outbox = state.outbox.filter((o) => o.id !== pending.id);
    saveState(state);
    log('上一封还没发出去，他补了一封，合成一封回');
  }
  const kind = templateKind(body);
  const why = budget(state, config, bal);
  const nightTpl = isNight() && body.length <= 10;
  let text = '';
  let facts = [];
  let usage = null;
  let mode = 'template';
  let sit = { extra: '', weather: '' };

  if (kind || nightTpl || why) {
    // 余额低于 1 元 = 告别模式：用自己的语气说「明天聊」；额度用完另用 quota
    const broke = why && why.indexOf('余额') === 0 && Number.isFinite(bal) && bal >= 0 && bal < 1;
    const tpl = kind || (nightTpl ? 'night' : (broke ? 'outOfCredit' : (why ? 'quota' : 'fallback')));
    text = pickTemplate(tpl, state);
    if (broke) state.byeSentDay = today();   // 今天只道别这一次，后面的信先不回
    log(`用模板回（${kind || (nightTpl ? '深夜短句' : why)}）：${text}`);
  } else {
    try {
      const out = await askModel({ apiKey, history: state.history || [], body, facts: state.facts || [], state, hasAttach });
      text = out.reply; facts = out.facts; usage = out.usage; mode = out.mode; sit = out.sit || {};
      if (!text) { log('回信被数字护栏清空了，退回模板'); text = pickTemplate('fallback', state); mode = 'template'; }
      const cost = addCost(state, usage);
      log(`这封约 ${cost.toFixed(5)} 元（${mode}，温度 ${out.temp ?? '-'}，in ${usage?.prompt_tokens || 0} / out ${usage?.completion_tokens || 0}），今日 ${Number(state.costToday || 0).toFixed(4)} 元`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 不是欠费就照常抛给外层，别把网络抖一下当成没钱
      if (!/balance|余额|402|insufficient|payment|quota/i.test(msg)) throw e;
      state.noMoney = true;
      log('模型回话失败（余额）：' + msg + '，这封改成「明天聊」');
      text = pickTemplate('outOfCredit', state);
      mode = 'no-money';
      await alertOnce('nomoney', '她这边额度见底了，模型不再回话。\n\n报错：' + msg + '\n\n充值：https://platform.deepseek.com/\n\n充好之后她会自己接着说，不用重启。这封大概就是今天最后一句像样的话了——明天聊。', 12 * 3600 * 1000);
    }
  }
  if (!text) { log('没生成内容，跳过'); return false; }

  const grounded = state.__factsOff ? [] : groundFacts(facts, body);
  if (grounded.length) {
    const n = addFacts(state, grounded, body);
    if (n) log(`顺手记住 ${n} 条：` + grounded.slice(0, 3).join(' / '));
  }
  if (facts.length > grounded.length) log(`过滤掉 ${facts.length - grounded.length} 条没有依据的"事实"`);

  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  // 偶尔她也在忙：5% 的信拖 3~15 小时才发（不额外发通知，本来就是她自己写的）
  const rareBusy = mode !== 'template' && Math.random() < 0.05;
  const busyMs = rareBusy ? (3 + Math.random() * 12) * 3600 * 1000 : 0;
  if (rareBusy) log('她这会儿忙，这封压到 ' + Math.round(busyMs / 3600000) + ' 小时后再发');
  const dueAt = Date.now() + busyMs + sendDelayMs(mode === 'template', String(config.replyDelay || 'human'));
  enqueue(state, {
    dueAt, to: config.owner || fromAddr, subject: subj, text,
    inReplyTo: msgId || undefined,
    references: (refs ? refs + ' ' : '') + (msgId || ''),
    his: body, emotion: emotionOf(text), extra: sit.extra, weatherUsed: !!sit.weather,
    fromMail: true, createdAt: Date.now(),
  });
  log(`排好了，${Math.round((dueAt - Date.now()) / 60000)} 分钟后发（${mode}）`);
  saveState(state);
  return true;
}

/** 桌面弹一个窗：点"确定"去充值，60 秒自动关，不卡服务 */
function popupTopUp(bal) {
  if (process.platform !== 'win32') return;   // 只有 Windows 有桌面弹窗
  const ps = [
    '$s = New-Object -ComObject WScript.Shell',
    `$r = $s.Popup('她的余额只剩 ${bal.toFixed(2)} 元，点"确定"去充值', 60, '邮件机器人', 1)`,
    'if ($r -eq 1) { Start-Process "https://platform.deepseek.com/" }',
  ].join('; ');
  try {
    const p = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    p.unref();
  } catch {}
}

let mailSession = null;   // 常驻的 IMAP 会话：别每 100 秒重登一次（一天 864 次登录，QQ 会当异常）
async function ensureImap(auth, state) {
  if (mailSession) {
    try { await mailSession.cmd('NOOP'); return mailSession; }
    catch { try { mailSession.quit(); } catch {} mailSession = null; }   // 断了就重连
  }
  const im = await Imap.connect();
  await im.cmd(`LOGIN "${MAIL_USER}" "${auth}"`);
  state.lastImapOk = Date.now();
  await im.cmd('SELECT INBOX');
  mailSession = im;
  log('信箱连上了，接下来保持连接（用 NOOP 探活）');
  return im;
}

async function tick(config, state, auth, apiKey) {
  const bal = await balanceOf(apiKey);
  state.bal = bal;
  // 余额提醒带迟滞：掉到 2 元以下只提醒一次；等充回 3 元以上才重新"装弹"，
  // 这样充值之后她绝不会再念叨，直到下次真没钱。
  const LOW = 2;
  const REARM = 3;
  if (bal >= REARM && state.lowWarned) { state.lowWarned = false; saveState(state); }
  if (bal >= 1 && state.noMoney) { state.noMoney = false; saveState(state); log('余额回来了，她能正常说话了'); }
  if (bal >= 0 && bal < LOW && !state.lowWarned && config.owner) {
    state.lowWarned = true;
    state.balanceWarnDay = today();
    saveState(state);
    try {
      await sendMail({ to: config.owner, subject: `（提醒）我这边余额只剩 ${bal.toFixed(2)} 元`, text: `还剩 ${bal.toFixed(2)} 元。再聊几封我就只能用几句现成的话应付你了，不是我不想说话。\n\n充值：https://platform.deepseek.com/ （登录后点右上角余额）\n\n充完就不会再提了；没充的话，最后一封我会跟你说「明天聊」。`, auth });
      log('余额提醒已发（' + bal.toFixed(2) + ' 元）');
    } catch (e) { log('余额提醒没发出去：' + e.message); }
    popupTopUp(bal);
  }
  // 余额不到 1 元、今天已经道过别：信箱先不动，等他充值（充值后自动恢复）
  if (bal >= 0 && bal < 1 && state.byeSentDay === today()) {
    log('余额不到 1 元，今天已经说过明天聊了，信箱先不动');
    return { handled: 0 };
  }
  const imap = await ensureImap(auth, state);
  try {
    // 不再依赖"未读"标记（别的客户端预览一下就会把信标已读，她就不回了）：
    // 每次扫最近 20 封，靠 UID + Message-ID 去重
    const search = await imap.cmd('UID SEARCH ALL');
    const allUids = [...search.text.matchAll(/^\* SEARCH ([0-9 ]+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)).filter(Boolean);
    const uids = allUids.slice(-20);
    if (!uids.length) return { handled: 0 };

    /** 从 IMAP 响应里抠出 {n} 后面那段字面量 */
    const literal = (res) => {
      const mm = res.buf.toString('utf8').match(/\{(\d+)\}\r?\n/);
      if (!mm) return res.text;
      const mark = `{${mm[1]}}\r\n`;
      const at = res.buf.indexOf(Buffer.from(mark)) + mark.length;
      return res.buf.slice(at, at + Number(mm[1])).toString('utf8');
    };

    const batch = [];
    for (const uid of uids) {
      // 先看大小：带大附件的信只拉头部+正文，别为了一个 20MB 的照片把整轮卡死
      const sizeRes = await imap.cmd(`UID FETCH ${uid} (RFC822.SIZE)`);
      const sm = sizeRes.text.match(/RFC822\.SIZE (\d+)/i);
      const size = sm ? Number(sm[1]) : 0;
      let raw = '';
      if (size > 2 * 1024 * 1024) {
        const hres = await imap.cmd(`UID FETCH ${uid} BODY.PEEK[HEADER]`);
        const tres = await imap.cmd(`UID FETCH ${uid} BODY.PEEK[TEXT]`);
        raw = literal(hres) + '\r\n\r\n' + literal(tres);
        log(`这封 ${Math.round(size / 1024 / 1024)} MB，只读正文，不拉附件`);
      } else {
        raw = literal(await imap.cmd(`UID FETCH ${uid} BODY.PEEK[]`));
      }
      const head = raw.split(/\r?\n\r?\n/)[0] || '';
      const fromRaw = decodeMime(headerField(head, 'From'));
      const fromAddr = ((fromRaw.match(/[^<>\s]+@[^<>\s]+/) || [''])[0]).toLowerCase();
      const subject = decodeMime(headerField(head, 'Subject'));
      const msgId = headerField(head, 'Message-ID');
      const refs = headerField(head, 'References');

      if (fromAddr === MAIL_USER.toLowerCase()) { await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); continue; }
      state.seenUids = state.seenUids || [];
      if (state.seenUids.includes(String(uid)) || (msgId && (state.seen || []).includes(msgId))) { await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); continue; }

      // 只认 config.owner 里写死的那个地址。陌生人来信：标记已读、记一行日志、这辈子不回，
      // 内容也不会进记忆库。绝不"自动认主"——否则谁先发信谁就成了主人。
      if (!String(config.owner || '').trim()) { log('config.owner 没填，拒收所有来信'); await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); continue; }
      if (!isOwner(fromAddr, config)) {
        const { rec, shouldWarn, shouldBlock } = bumpStranger(state, fromAddr);
        saveState(state);
        await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`);
        if (rec.blocked) { log('已拉黑的地址又来了一封，静默丢弃：' + fromAddr); continue; }
        log(`陌生人来信，忽略（第 ${rec.count} 封）：` + fromAddr);
        if (shouldBlock) { rec.blocked = true; saveState(state); log(`把 ${fromAddr} 拉黑了（累计 ${rec.count} 封）`); }
        if (shouldWarn) {
          rec.warnedAt = Date.now();
          saveState(state);
          try {
            await sendMail({
              to: config.owner,
              subject: '（提醒）有人在敲她的信箱',
              text: `有个地址在这段时间里发了 ${rec.count} 封：${fromAddr}\n最近一封的主题："${subject}"\n\n都被挡掉了，她没看到，也不会回。\n\n想彻底清净：QQ 邮箱 → 设置 → 收信规则，把"发件人不是你就移走"。`,
              auth,
            });
            log('已发陌生人提醒：' + fromAddr);
          } catch (e) { log('陌生人提醒没发出去：' + e.message); }
        }
        continue;
      }

      const dateRaw = headerField(head, 'Date');
      const ageH = dateRaw ? (Date.now() - Date.parse(dateRaw)) / 3600000 : 0;
      if (ageH > Number(config.mailMaxAgeHours || 24)) {
        log('这封信 ' + Math.round(ageH) + ' 小时前发的，太旧了，不回');
        state.seenUids = state.seenUids.concat([String(uid)]).slice(-500); saveState(state);
        await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); continue;
      }

      // 每天回信上限：到顶了别把这封信"吃掉"，留着明天看
      if (state.day !== today()) { state.day = today(); state.count = 0; state.usedToday = 0; }
      const used = Number(state.usedToday == null ? (state.count || 0) : state.usedToday);
      const capDay = Number(config.dailyCap || 35);
      if (used >= capDay) {
        if (state.quotaLoggedDay !== today()) {
          state.quotaLoggedDay = today();
          log(`今天的额度用完了（${used}/${capDay}，一来一回都算），剩下的信留到明天（不标记已读）`);
        }
        if (state.quotaNotifiedDay !== today()) {
          state.quotaNotifiedDay = today();
          saveState(state);
          try {
            await sendMail({ to: config.owner || fromAddr, subject: '（今天聊够了）', text: '今天的额度用完了（我发一封、你发一封都算）。剩下的信先留着，我明天再看——不是不理你。', auth });
          } catch (e) { log('额度提醒没发出去：' + e.message); }
        }
        break;
      }

      state.seenUids = state.seenUids.concat([String(uid)]).slice(-500);
      state.usedToday = used + 1;   // 他这一封也算一次互动
      saveState(state);
      await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`);

      const body = await parseBody(raw, subject);
      log('收到来信正文：' + body.slice(0, 30));
      const hasAttach = /Content-Disposition:[ \t]*attachment/i.test(raw) || /filename=/i.test(head);
      batch.push({ body, subject, fromAddr, msgId, refs, hasAttach });
    }

    if (batch.length) {
      // 首次运行或状态丢失（seenUids 空）时，收件箱里可能躺着一堆老信。
      // 这时候只回最新一封，其余的标已读跳过——宁可漏，也不批量重回。
      if (!(state.seenUids || []).length && batch.length > 1) {
        log(`第一次跑（或状态丢了），收件箱里有 ${batch.length} 封，只回最新一封，其余跳过`);
        batch.splice(0, batch.length - 1);
      }
      // 一口气发了几封：合成一封回，别刷屏
      const merged = {
        body: batch.length === 1 ? batch[0].body : batch.map((b, i) => `（第 ${i + 1} 封）\n${b.body}`).join('\n\n'),
        subject: batch[0].subject,
        fromAddr: batch[0].fromAddr,
        msgId: batch[batch.length - 1].msgId,
        refs: batch[batch.length - 1].refs,
        hasAttach: batch.some((b) => b.hasAttach),
      };
      if (batch.length > 1) log(`他一口气发了 ${batch.length} 封，合成一封回`);
      try { await processOne({ ...merged, config, state, auth, apiKey, bal }); }
      catch (e) { log('处理来信出错：' + e.message); await alertOnce('generate', '生成回信时出错：' + e.message); }
    }
    return { handled: 1 };
  } finally { /* 不 quit：连接留着，下次用 NOOP 探活 */ }
}

function single() {
  try { const old = Number(fs.readFileSync(LOCK, 'utf8').trim()) || 0; if (old && old !== process.pid) { try { process.kill(old, 0); console.log('已有实例在跑 pid ' + old); process.exit(3); } catch {} } } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} });
}

/** 锁文件被别的命令顺手删掉时自己补回来：不然第二个实例就拦不住了 */
function ensureLock() {
  try {
    const raw = fs.readFileSync(LOCK, 'utf8').trim();
    if (raw === String(process.pid)) return;
    const old = Number(raw) || 0;
    if (old && old !== process.pid) {
      try { process.kill(old, 0); log('发现另一个实例在跑（pid ' + old + '），我这个退出'); process.exit(1); } catch {}
    }   // 锁被别人占了且对方还活着 → 我退出，别制造两个实例抢信箱
  } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  fs.mkdirSync(DIR, { recursive: true });
  single();
  const config = readJson(CONFIG, { email: '', owner: '', dailyCap: 35, dailyCostCap: 0.05 });
  // 邮箱服务器可配：QQ 要是改了协议或者你想换服务商，只改 config.mail，不用动代码
  if (config.mail && typeof config.mail === 'object') {
    const mc = config.mail;
    if (mc.imapHost) IMAP = { host: String(mc.imapHost), port: Number(mc.imapPort || 993) };
    if (mc.smtpHost) SMTP = { host: String(mc.smtpHost), port: Number(mc.smtpPort || 465) };
    if (mc.user) MAIL_USER = String(mc.user);
  }
  const li = args.indexOf('--lowbal');
  if (li >= 0) BAL_OVERRIDE = Number(args[li + 1]);
  TZ = String(config.timezone || 'Asia/Shanghai');
  if (!String(config.owner || '').trim()) {
    console.error('config.json 里的 owner 必须填：写你自己的邮箱。为了安全，程序不会替你"自动认主"。');
    process.exit(1);
  }
  const state = loadState({ history: [], seen: [], facts: [], count: 0, day: '' });
  state.me = state.me || {};
  if (!Array.isArray(state.me.likes)) state.me.likes = SELF_DEFAULTS.likes.slice();
  if (!Array.isArray(state.me.dislikes)) state.me.dislikes = SELF_DEFAULTS.dislikes.slice();
  if (!Array.isArray(state.me.habits)) state.me.habits = SELF_DEFAULTS.habits.slice();
  if (!state.firstSeen) { const rows = listEntries(); if (rows.length) state.firstSeen = rows[0].at; }
  state.__memoryOff = config.memory === false;   // "memory": false → 不记、不检索
  state.__factsOff = config.facts === false;     // "facts": false → 不产长期事实
  if (state.__memoryOff) log('记忆功能已关闭（config.memory = false）');
  if (state.__factsOff) log('长期事实已关闭（config.facts = false）');
  saveState(state);   // 立刻落盘，别只在内存里
  MAIL_USER = String(config.email || process.env.MAILBOT_EMAIL || MAIL_USER).trim();
  const tryDat = (f) => { try { return fs.existsSync(f) ? decrypt(f) : ''; } catch { return ''; } };
  const auth = String(config.authCode || process.env.MAILBOT_AUTH || tryDat(path.join(DIR, 'mail-auth.dat'))).trim();
  const apiKey = String(config.apiKey || process.env.MAILBOT_KEY || tryDat(path.join(DIR, 'api-key.dat'))).trim();
  if (!auth || !apiKey) {
    console.error('缺凭据：把 config.example.json 复制成 config.json，填好 email / authCode / apiKey；或者用环境变量 MAILBOT_EMAIL / MAILBOT_AUTH / MAILBOT_KEY。');
    process.exit(1);
  }
  CTX = { auth, config, state };

  if (args.includes('--purge')) {
    if (!args.includes('--yes')) {
      console.log('这会清空：记忆库、记得的事、对话历史、待发队列。确认请在命令后面加 --yes');
      process.exit(0);
    }
    for (const f of [path.join(DIR, 'memory.jsonl'), path.join(DIR, 'memory.raw.jsonl')]) { try { fs.unlinkSync(f); } catch {} }
    for (const k of ['history', 'facts', 'seen', 'seenUids', 'outbox', 'recentExtras', 'recentWeather', 'recentParticles', 'lastEmotion', 'alerts', 'lastProactiveDay', 'unansweredProactive', 'lowWarned', 'balanceWarnDay', 'secretOkAt', 'strangers', 'openLoops', 'firstSeen', 'milestone']) delete state[k];
    saveState(state);
    console.log('清空了：记忆库、事实、历史、队列。从现在起她什么都不记得。');
    process.exit(0);
  }
  if (args.includes('--status')) {
    console.log(`主人: ${config.owner || '（等第一封来信）'}`);
    const sentToday = state.day === today() ? (state.count || 0) : 0;
    const usedToday = state.day === today() ? Number(state.usedToday == null ? sentToday : state.usedToday) : 0;
    console.log(`今天互动: ${usedToday} / ${config.dailyCap}（她发了 ${sentToday} 封），今天花费 ${Number(state.costToday || 0).toFixed(4)} / ${config.dailyCostCap || 0.05} 元`);
    const ms = memoryStats();
    console.log(`记忆库: ${ms.count} 条（权重合计 ${ms.weight}），${(ms.bytes / 1024).toFixed(1)} KB，原文 ${(ms.rawBytes / 1024).toFixed(1)} KB`);
    console.log(`记得的事: ${(state.facts || []).length} 条`);
    (state.facts || []).slice(-10).forEach((f) => console.log('  - ' + f.text));
    console.log(`待发队列: ${(state.outbox || []).length} 封`);
    (state.outbox || []).forEach((o) => console.log(`  - ${new Date(o.dueAt).toLocaleTimeString('zh-CN', { hour12: false })}：${o.text.slice(0, 24)}`));
    const sec = String(config.secret || '').trim();
    console.log(`口令: ${!sec ? '未设置' : (config.secretEveryTime === true ? '每封都要带' : (state.secretOkAt ? '已认过门（以后不用带）' : '还没认过门（下一封要带一次）'))}`);
    console.log(`上一封语气: ${state.lastEmotion || '（无）'}`);
    console.log(`余额提醒: ${state.lowWarned ? '已提醒过（充值回 3 元以上会自动解除）' : '待命（低于 2 元会提醒一次）'}`);
    const strangers = state.strangers && !Array.isArray(state.strangers) ? Object.entries(state.strangers) : [];
    if (strangers.length) {
      console.log(`陌生人来信: ${strangers.length} 个地址`);
      for (const [addr, r] of strangers.slice(0, 5)) console.log(`  - ${addr}  ${r.count} 封${r.blocked ? '（已拉黑）' : ''}`);
    } else {
      console.log('陌生人来信: 没有');
    }
    console.log(`余额: ${await balanceOf(apiKey)} 元`);
    process.exit(0);
  }
  if (args.includes('--say')) {
    const text = args[args.indexOf('--say') + 1] || '在吗';
    const kind = templateKind(text);
    if (kind || (isNight() && text.length <= 10)) { console.log('（模板，不花钱）她回：', pickTemplate(kind || 'night', state)); process.exit(0); }
    const out = await askModel({ apiKey, history: state.history || [], body: text, facts: state.facts || [], state });
    const cost = costOf(out.usage);
    const g = groundFacts(out.facts, text);
    console.log('他说：', text);
    console.log(`她回（${out.mode}）：`, out.reply);
    console.log('状态：', (out.sit && out.sit.extra) || '（没说自己的状态）', out.sit && out.sit.weather ? '／提了天气' : '／没提天气');
    console.log('情绪：', emotionOf(out.reply));
    if (out.facts.length) console.log(`记忆：${out.facts.length} 条候选，通过校验 ${g.length} 条${g.length ? '（' + g.join(' / ') + '）' : ''}`);
    console.log(`这次约 ${cost.toFixed(5)} 元（input ${out.usage.prompt_tokens || 0} / output ${out.usage.completion_tokens || 0}）`);
    process.exit(0);
  }
  if (args.includes('--test')) {
    const imap = await Imap.connect();
    await imap.cmd(`LOGIN "${MAIL_USER}" "${auth}"`);
    await imap.cmd('SELECT INBOX');
    console.log('IMAP 登录 OK');
    imap.quit();
    const t = nodemailer().createTransport({ host: SMTP.host, port: SMTP.port, secure: true, auth: { user: MAIL_USER, pass: auth } });
    await t.verify();
    console.log('SMTP 登录 OK');
    console.log('模型 key 余额:', await balanceOf(apiKey), '元');
    process.exit(0);
  }
  if (args.includes('--proactive')) { await maybeProactive(apiKey, config, state, auth); console.log('主动来信已尝试，看日志'); process.exit(0); }
  const dry = args.includes('--dry');
  if (args.includes('--monthly')) { console.log(await writeDigest({ apiKey, config, state, auth, kind: 'monthly', dry }) ? (dry ? '月记已生成（未发送）' : '月记已发') : '没写成'); process.exit(0); }
  if (args.includes('--yearly')) { console.log(await writeDigest({ apiKey, config, state, auth, kind: 'yearly', dry }) ? (dry ? '年记已生成（未发送）' : '年记已发') : '没写成'); process.exit(0); }
  if (args.includes('--her-birthday')) { console.log(await writeDigest({ apiKey, config, state, auth, kind: 'herBirthday', dry }) ? (dry ? '她的生日信已生成（未发送）' : '她的生日信已发') : '没写成'); process.exit(0); }
  if (args.includes('--birthday')) { console.log(await writeDigest({ apiKey, config, state, auth, kind: 'birthday', dry }) ? (dry ? '生日贺报已生成（未发送）' : '生日贺报已发') : '没写成'); process.exit(0); }
  if (args.includes('--facts-audit')) {
    const r = auditFacts(state);
    saveState(state);
    console.log('审计完成：留 ' + r.kept + ' 条，清掉 ' + r.dropped.length + ' 条');
    for (const d of r.dropped) console.log('  清掉：' + d.text + '（' + d.why + '）');
    const hist = state.factsDropped || [];
    if (hist.length) console.log('历史清理记录 ' + hist.length + ' 条（state.json 的 factsDropped）');
    process.exit(0);
  }
  if (args.includes('--facts') || args.includes('--facts-del')) {
    const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
    const di = args.indexOf('--facts-del');
    if (di >= 0) {
      const no = Number(args[di + 1]);
      const list = state.facts || [];
      if (!Number.isInteger(no) || no < 1 || no > list.length) { console.log('没有第 ' + no + ' 条'); process.exit(0); }
      const removed = list.splice(no - 1, 1)[0];
      state.facts = list;
      saveState(state);
      console.log('已删除：' + removed.text);
      process.exit(0);
    }
    const list = state.facts || [];
    if (!list.length) { console.log('还没有记住的长期事实。'); process.exit(0); }
    console.log('长期事实 ' + list.length + ' 条（带出处，可核对）：');
    list.forEach((f, i) => {
      console.log(`  ${String(i + 1).padStart(2)}  ${fmt(f.addedAt)}  ${f.text}`);
      if (f.src) console.log(`      出处：${f.src}`);
    });
    console.log('\n删某条：--facts-del 编号');
    process.exit(0);
  }
  if (args.includes('--memory') || args.includes('--memory-del') || args.includes('--memory-clear') || args.includes('--memory-export')) {
    const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
    if (args.includes('--memory-clear')) {
      if (!args.includes('--yes')) { console.log('这会删掉全部记忆。确认请在后面加 --yes'); process.exit(0); }
      clearAll();
      console.log('记忆库已清空。');
      process.exit(0);
    }
    const di = args.indexOf('--memory-del');
    if (di >= 0) {
      const no = Number(args[di + 1]);
      console.log(removeEntry(no) ? '已删除第 ' + no + ' 条' : '没有第 ' + no + ' 条');
      process.exit(0);
    }
    if (args.includes('--memory-export')) {
      const file = path.join(DIR, 'memory.md');
      const n = exportMarkdown(file);
      console.log('已导出 ' + file + '（' + n + ' 条）');
      process.exit(0);
    }
    const rows = listEntries();
    console.log('记忆库共 ' + rows.length + ' 条：');
    for (const r of rows) console.log(`  ${String(r.no).padStart(3)}  ${fmt(r.at)}  ${r.who === 'he' ? '你说' : '她说'}  ×${r.weight}  ${r.text}`);
    console.log('\n删某条：--memory-del 编号　　全清：--memory-clear --yes　　导出：--memory-export');
    process.exit(0);
  }
  if (args.includes('--once')) {
    const r = await tick(config, state, auth, apiKey);
    const n = await flushOutbox(config, state, auth);
    console.log('本轮:', r, '发出', n);
    process.exit(0);
  }

  // 安全阀：带了参数却一个都没匹配上（比如拼错 --weekly），不要傻傻地启动守护进程，
  // 否则会变成"第二个实例"跟正式服务抢同一个邮箱——这个坑真的踩过。
  if (args.length) {
    console.error('没认出的参数：' + args.join(' ') + '\n可用：--once / --status / --test / --say <文本> / --proactive / --weekly / --yearly / --purge [--yes]');
    process.exit(2);
  }

  log(`邮件服务启动（${MAIL_USER}），时区 ${TZ}，正常每 ${POLL_MS / 1000} 秒看一次（出错会退避）`);
  beat();
  let poll = POLL_MS;
  let lastBeatLog = 0;
  let fails = 0;   // 连续失败轮数：僵死了就退出，让 run-loop 起个新的
  let nextPollAt = Date.now();   // 下一次收信的时间点
  for (;;) {
    ensureLock();   // 锁要是被别人删了，这一轮补回来
    let failed = false;
    const pollDue = Date.now() >= nextPollAt;
    if (!pollDue) {
      // 还没到收信的点，只是来发信的：只冲队列，不登录信箱（登录次数一天还是那么多次）
      try { await flushOutbox(config, state, auth); } catch (e) { log('发送队列出错：' + e.message); }
    } else {
    try { await Promise.race([tick(config, state, auth, apiKey), sleep(150000).then(() => { throw new Error('这一轮超过 150 秒，放弃'); })]); }
    catch (e) {
      failed = true;
      fails += 1;
      try { if (mailSession) { mailSession.quit(); } } catch {}
      mailSession = null;   // 这一轮坏了，八成是连接，丢掉重连
      const msg = String((e && e.message) || e);
      log('这一轮出错：' + msg);
      // 认证失败跟"网络抖一下"不是一回事：授权码废了就只能他去重新生成，所以单独说清楚
      if (/LOGIN|AUTHENTICATIONFAILED|AUTHENTICATE|\bAUTH\b|invalid credentials/i.test(msg)) {
        const last = state.lastImapOk ? new Date(state.lastImapOk).toLocaleString('zh-CN', { timeZone: TZ, hour12: false }) : '（没有记录）';
        await alertOnce('auth', '她的邮箱登录不上了。\n\n报错：' + msg + '\n上次登录成功：' + last + '\n\n多半是授权码失效了——改过 QQ 密码、关过 IMAP 服务、或者在邮箱设置里删过授权码，都会这样。\n\n重新生成：mail.qq.com → 设置 → 账号 → POP3/IMAP/SMTP 服务 → 生成授权码；拿到后替换 mailbot 目录下的 mail-auth.dat（或者告诉我，我来换）。\n\n在授权码修好之前，她收不到信、也回不了。', 12 * 3600 * 1000);
      } else {
        await alertOnce('tick', '收信这一轮连续出错：' + msg);
      }
    }
    beat();
    try { await flushOutbox(config, state, auth); }
    catch (e) { log('发送队列出错：' + e.message); await alertOnce('send', '发信出错了：' + e.message); }
    beat();
    try { await maybeProactive(apiKey, config, state, auth); } catch (e) { log('主动来信出错：' + e.message); }
    try { await maybeSummaries(apiKey, config, state, auth); } catch (e) { log('写回顾出错：' + e.message); }
    try { await maybeFutureLetter({ apiKey, config, state, auth }); } catch (e) { log('未来信出错：' + e.message); }
    // 每天审计一次长期事实，把没依据的自动清掉（清掉的会留档）
    try {
      if (!state.__factsOff && (!state.lastFactsAudit || Date.now() - state.lastFactsAudit > 24 * 3600 * 1000)) {
        const r = auditFacts(state);
        if (r.dropped.length) log('事实审计：留下 ' + r.kept + ' 条，清掉 ' + r.dropped.length + ' 条（' + r.dropped.map((d) => d.why).join('、') + '）');
        saveState(state);
      }
    } catch (e) { log('事实审计出错：' + e.message); }
    }   // 收信这一支结束
    // 出错就退避，别每 100 秒猛撞同一个接口；成功就恢复正常节奏
    if (!failed) {
      fails = 0;
      if (state.alerts && (state.alerts.tick || state.alerts.crash)) { delete state.alerts.tick; delete state.alerts.crash; saveState(state); }
    }
    if (fails >= 3) { log('连续 ' + fails + ' 轮出错，退出让守护进程重启（僵死只能这样清）'); process.exit(1); }
    poll = failed ? Math.min(poll * 2, 10 * 60000) : POLL_MS;
    nextPollAt = Date.now() + poll;   // 退避也算进去
    if (Date.now() - lastBeatLog > 25 * 60000) {
      lastBeatLog = Date.now();
      log(`在跑（上次${failed ? '出错' : '正常'}，下次 ${Math.round(poll / 1000)} 秒后，今天已回 ${state.count || 0} 封）`);
    }
    // 下一次醒：收信点 和 队列里最早一封到点 里更早的那个；最长睡 60 秒，保证心跳一直在跳
    const nextDue = (state.outbox || []).reduce((m, o) => (o && o.dueAt ? Math.min(m, o.dueAt) : m), Infinity);
    const waitMs = Math.max(2000, Math.min(60000, nextPollAt - Date.now(), Number.isFinite(nextDue) ? nextDue - Date.now() : 60000));
    beat();
    await sleep(waitMs);
  }
}

process.on('exit', (code) => log('进程退出 code=' + code));
process.on('uncaughtException', (e) => { log('未捕获异常（继续跑）：' + (e && e.message ? e.message : e)); alertOnce('crash', '进程里出了个异常：' + (e && e.message ? e.message : String(e))); });
process.on('unhandledRejection', (e) => log('未处理拒绝（继续跑）：' + (e && e.message ? e.message : e)));

if (!process.env.MAILBOT_NO_MAIN) main().catch((e) => { log('启动失败：' + e.message); process.exit(1); });
