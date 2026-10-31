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
import { remember, recall, memoryHint, memoryStats, tokenize } from './memory.mjs';

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
let MAIL_USER = 'you@example.com';   // 真正的值由 config.json 的 email 填进来
const IMAP = { host: 'imap.qq.com', port: 993 };
const SMTP = { host: 'smtp.qq.com', port: 465 };
const POLL_MS = 100 * 1000;   // 正常轮询间隔；失败会退避，最长 10 分钟
const MAX_HISTORY = 8;
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
const writeJson = (p, v) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} };

const STATE_BAK = path.join(DIR, 'state.bak.json');
/** 状态写盘前先留一份备份：state.json 坏了还能回退 */
export function saveState(s) {
  try {
    if (fs.existsSync(STATE)) fs.copyFileSync(STATE, STATE_BAK);
  } catch {}
  writeJson(STATE, s);
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
async function alertOnce(code, text) {
  try {
    const s = CTX.state;
    const c = CTX.config;
    if (!s || !c || !c.owner || !CTX.auth) return;
    s.alerts = s.alerts || {};
    const now = Date.now();
    if (now - Number(s.alerts[code] || 0) < 2 * 3600 * 1000) return;
    s.alerts[code] = now;
    saveState(s);
    await sendMail({ to: c.owner, subject: '（她这边出了点问题）', text: `${text}\n\n（自动发的，同类问题两小时内只发一次。详细日志看 mailbot.log。）`, auth: CTX.auth });
    log('已发故障提醒：' + code);
  } catch {}
}

const keepAlive = process.env.MAILBOT_NO_MAIN ? null : setInterval(() => {}, 3600 * 1000);

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
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.tag = 0; }
  static connect() {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host: IMAP.host, port: IMAP.port, servername: IMAP.host }, () => resolve(new Imap(s)));
      s.setTimeout(25000, () => { try { s.destroy(); } catch {} reject(new Error('IMAP 超时')); });
      s.once('error', reject);
    });
  }
  read() { return new Promise((res) => { const h = (d) => { this.buf = Buffer.concat([this.buf, d]); this.sock.off('data', h); res(); }; this.sock.on('data', h); }); }
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
  fallback: ['在呢，你说。', '嗯？', '怎么啦。', '你说。', '嗯，然后呢。', '怎么了这是。'],
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
  if (/晚安|睡了|困了/.test(t)) return 'bye';
  if (/吃了|吃饭|吃啥|吃什么/.test(t)) return 'askEat';
  if (/在吗|在不在|在么|人呢/.test(t)) return 'greet';
  if (/哈哈|笑死|hhh|233/i.test(t)) return 'haha';
  return '';
}
const isNight = () => { const h = nowHour(); return h >= 23 || h < 8; };
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
  for (const l of String(out || '').split('\n')) {
    const m = l.match(/^#?\s*(记忆|记住)[:：]\s*(.+)$/);
    if (m) { for (const f of m[2].split(/[|｜;；]/)) { const s = f.trim().replace(/^[-*•\s]+/, ''); if (s && s !== '无' && s.length <= 30) facts.push(s); } continue; }
    kept.push(l);
  }
  return { text: kept.join('\n').trim(), facts };
}

/** 事实入库前校验：必须能在他的原信里找到依据，否则是模型脑补的，丢掉 */
export function groundFacts(facts, body) {
  const bodySet = new Set(tokenize(body).filter((t) => t.length === 2));
  return facts.filter((f) => {
    const ts = [...new Set(tokenize(f).filter((t) => t.length === 2))];
    if (!ts.length) return false;
    const hit = ts.filter((t) => bodySet.has(t)).length;
    return hit / ts.length >= 0.5;
  });
}

function addFacts(state, facts) {
  if (!Array.isArray(facts) || !facts.length) return 0;
  const norm = (s) => String(s).replace(/[，。！？、,.!?\s]/g, '');
  const have = new Set((state.facts || []).map((f) => norm(f.text)));
  let n = 0;
  for (const f of facts) if (!have.has(norm(f))) { state.facts = (state.facts || []).concat([{ text: f, addedAt: Date.now() }]); have.add(norm(f)); n += 1; }
  state.facts = (state.facts || []).slice(-20);
  return n;
}

export function humanize(text, cap = 220) {
  let s = String(text || '').trim();
  s = s.replace(/^#{1,6}\s*/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`{1,3}/g, '');
  const BAD = [/希望(对你|能)有(所)?帮助/g, /有(什么|任何)(可以|需要)?(帮|需要)(助|的)?(吗|呢)?/g, /很(高兴|荣幸)(为您|为你)服务/g, /作为(一个)?AI/g, /总结一下/g, /首先[，,]?/g, /其次[，,]?/g, /最后[，,]?/g, /总之[，,]?/g];
  for (const re of BAD) s = s.replace(re, '');
  s = s.replace(/,\s*/g, '，').replace(/!\s*/g, '！').replace(/\?\s*/g, '？').replace(/\.\s+/g, '。');
  const parts = s.split(/(?<=[。！？…~])/).filter((x) => x.trim());
  const keep = cap <= 60 ? 1 : 4;
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

const EXTRAS = ['刚睡醒', '在吃饭', '刚洗完澡', '窝在沙发上', '在等外卖', '有点困', '刚刷完手机', '在发呆', '刚晾完衣服'];

/** 此刻的状态 + 冷却：最近三封用过的状态词、连着提过天气，这次就换/别提 */
function situation(state, wx) {
  const recent = state.recentExtras || [];
  const pool = EXTRAS.filter((x) => !recent.includes(x));
  const extra = (pool.length ? pool : EXTRAS)[Math.floor(Math.random() * (pool.length ? pool.length : EXTRAS.length))];
  const wxRecent = state.recentWeather || [];
  const wet = wxRecent.slice(-2).filter(Boolean).length >= 2;
  state.__pendingExtra = extra;
  state.__pendingWeather = !wet && !!wx.text;
  return { extra, weather: wet ? '' : (wx.text || ''), wet };
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
  if (r < 0.3) return 'short';
  if (r < 0.9) return 'normal';
  return 'long';
}

async function askModel({ apiKey, history, body, facts, state }) {
  const wx = await weather();
  const sit = situation(state, wx);
  const mode = lengthMode();
  const ban = bannedParticles(state);
  const fs2 = (facts || []).slice(-20).map((f) => '- ' + (f.text || f)).join('\n');
  const hint = memoryHint(body, 4);
  const part = nowHour() < 6 ? '半夜' : nowHour() < 9 ? '早上' : nowHour() < 12 ? '上午' : nowHour() < 14 ? '中午' : nowHour() < 18 ? '下午' : nowHour() < 23 ? '晚上' : '深夜';
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
  if (mode === 'short') rules.push('这次只写一句，很短，十个字上下，别解释。');
  else if (mode === 'long') rules.push('这次可以写三四句，说点具体的，但别写小作文。');
  else rules.push('一两句，最多三句。');
  rules.push(`现在是${week}${part}${sit.weather ? '，' + sit.weather : ''}，你${sit.extra}。`);
  rules.push(`今天是${dateStr}${gapStr ? '，' + gapStr : ''}。`);
  if (sit.wet) rules.push('你前两封已经提过天气了，这次别再提天气。');
  if (ban.length) rules.push(`最近几封你老用「${ban.join('')}」，这次别用这些字。`);
  if (state.lastEmotion && state.lastEmotion !== '平静') rules.push(`上一封你的语气是「${state.lastEmotion}」，可以接着来，但别每封一个调。`);
  rules.push('他一段话里可能说了好几件事，你只接最戳你的那一件，别的先不管。');
  if (Math.random() < 0.4) rules.push('可以拎他信里用过的一个词重复一下再反驳或追问，像真人抓字眼。');
  rules.push('别用他信里没有的数字、日期、金额、人名地名。');
  rules.push('记忆片段里的事只能照抄，不许给它补时间、补地点、补细节。');
  // 别把刚问过的问题再问一遍
  const asked = (history || []).filter((h) => h.role === 'assistant').slice(-3)
    .flatMap((h) => String(h.text || '').split(/(?<=[。！？!?~])/))
    .filter((s) => /[？?]/.test(s)).map((s) => s.trim()).slice(-3);
  if (asked.length) rules.push(`这些你最近刚问过，别再重复问：${asked.join(' / ')}`);

  const msgs = [
    { role: 'system', content: persona() + (fs2 ? '\n\n# 你记得关于哥的事\n' + fs2 : '') + (hint ? '\n\n' + hint : '') },
    ...(history || []).slice(-MAX_HISTORY).map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: `哥给你发邮件说：\n${body}\n\n（${rules.join('\n')}\n直接写正文，不加称呼、不加落款、不列举。\n最后单独一行写「#记忆: 事实1 | 事实2」，只写这封信里他明确说过的、长期有用的事，没有就写「#记忆: 无」。）` },
  ];
  const out = await callModel(apiKey, msgs, mode === 'short' ? 90 : mode === 'long' ? 520 : 380);
  const { text, facts: raw } = splitMemory(out.text);
  const cap = mode === 'short' ? 40 : mode === 'long' ? 320 : 220;
  let reply = humanize(text, cap);
  const allowed = [body, sit.weather, dateStr, gapStr, week, ...(facts || []).map((f) => f.text || f), ...(history || []).map((h) => h.text)].join('\n');
  reply = guardNumbers(reply, allowed);
  return { reply, facts: raw, usage: out.usage, mode, sit };
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

function addCost(state, usage) {
  const c = ((usage?.prompt_tokens || 0) * 0.5 + (usage?.completion_tokens || 0) * 8) / 1e6;
  if (state.costDay !== today()) { state.costDay = today(); state.costToday = 0; }
  state.costToday = Number(state.costToday || 0) + c;
  return c;
}

export function budget(state, config, bal) {
  if (state.costDay === today() && Number(state.costToday || 0) >= Number(config.dailyCostCap || 0.05)) return '今日到预算上限';
  if (bal >= 0 && bal < 0.5) return '余额不足';
  if (bal >= 0 && bal < 1) return '余额偏低';
  return '';
}

/** 发信延迟：白天压到 30 分钟内（免得"现在"过期），深夜他醒着就快一点 */
export function sendDelayMs(templateUsed) {
  if (templateUsed) return 20000 + Math.floor(Math.random() * 40000);
  const h = nowHour();
  if (h >= 23 || h < 8) return 60000 + Math.floor(Math.random() * 5 * 60000);   // 夜里 1~6 分钟
  const r = Math.random();
  if (r < 0.25) return 2 * 60000 + Math.floor(Math.random() * 6 * 60000);       // 2~8 分钟
  if (r < 0.85) return 8 * 60000 + Math.floor(Math.random() * 12 * 60000);      // 8~20 分钟
  return 20 * 60000 + Math.floor(Math.random() * 10 * 60000);                   // 20~30 分钟
}

function enqueue(state, item) {
  state.outbox = (state.outbox || []).concat([{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...item }]);
  saveState(state);
}

/** 到点了就发。发成功才记历史、记记忆、加计数 */
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
    if (state.day !== today()) { state.day = today(); state.count = 0; }
    state.count = Number(state.count || 0) + 1;
    // 只有真回信才记进历史；自检/主动来信这种没有"他说的"就不塞空条目
    const hisEntry = item.his ? [{ role: 'user', text: String(item.his).slice(0, 600) }] : [];
    state.history = (state.history || []).concat(hisEntry, [{ role: 'assistant', text: item.text.slice(0, 600) }]).slice(-24);
    state.lastExchangeAt = Date.now();
    state.unansweredProactive = 0;
    state.lastEmotion = item.emotion || state.lastEmotion;
    state.recentExtras = (state.recentExtras || []).concat([item.extra].filter(Boolean)).slice(-3);
    state.recentWeather = (state.recentWeather || []).concat([!!item.weatherUsed]).slice(-4);
    state.recentParticles = (state.recentParticles || []).concat([PARTICLE_LIST.filter((p) => item.text.includes(p))]).slice(-5);
    if (item.his) { remember('he', item.his); remember('me', item.text); }
    state.outbox = state.outbox.filter((x) => x.id !== item.id);
    saveState(state);
    sent += 1;
    log(`发出去了：${item.text.slice(0, 36)}${item.text.length > 36 ? '…' : ''}`);
  }
  return sent;
}

async function maybeProactive(apiKey, config, state, auth) {
  const cfg = config.proactive || {};
  if (cfg.enabled === false) return;
  const now = new Date();
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5);
  const at = cfg.time || '20:30';
  if (hhmm < at) return;
  const quietFrom = cfg.quietFrom || '23:00';
  const quietTo = cfg.quietTo || '08:00';
  const inQuiet = quietFrom <= quietTo ? (hhmm >= quietFrom && hhmm < quietTo) : (hhmm >= quietFrom || hhmm < quietTo);
  if (inQuiet) { log('安静时段（' + quietFrom + '–' + quietTo + '），不主动发信'); return; }
  if (state.lastProactiveDay === today()) return;
  if (Number(state.unansweredProactive || 0) >= Number(cfg.maxUnanswered || 2)) { log('连着两封没回，先不主动了'); return; }
  const gapH = Number.isFinite(Number(cfg.minGapHours)) ? Number(cfg.minGapHours) : 6;
  if (state.lastExchangeAt && Date.now() - state.lastExchangeAt < gapH * 3600 * 1000) return;

  const wx = await weather();
  const reasons = [];
  if (!state.lastExchangeAt || Date.now() - state.lastExchangeAt > 36 * 3600 * 1000) reasons.push('好久没聊');
  if (Number.isFinite(wx.min) && Number.isFinite(wx.max) && wx.max - wx.min >= 8) reasons.push('温差大');
  if ([5, 6, 0].includes(now.getDay()) && Number(hhmm.slice(0, 2)) >= 20) reasons.push('周末晚上');
  if (!reasons.length) { log('今天没什么由头，不主动发'); return; }

  try {
    const facts = (state.facts || []).slice(-20).map((f) => '- ' + f.text).join('\n');
    const msg = `现在是 ${hhmm}，${wx.text || ''}（由头：${reasons.join('、')}）。哥今天还没跟你说话。你主动写封邮件：用你平时的口吻，一两句话，别客套，别问"在吗"，别问"最近怎么样"，别用他信里没有的数字。\n输出格式：第一行"主题：xxx"（6 字以内），空一行，正文。`;
    const out = await callModel(apiKey, [{ role: 'system', content: persona() + (facts ? '\n\n# 你记得关于哥的事\n' + facts : '') }, { role: 'user', content: msg }], 220);
    const cost = addCost(state, out.usage);
    const m = out.text.match(/^主题[:：]\s*(.+)\n+([\s\S]+)$/);
    const subject = (m ? m[1] : '随口问一句').trim().slice(0, 20);
    let body = humanize((m ? m[2] : out.text).trim(), 220);
    body = guardNumbers(body, wx.text || '');
    if (!body) return;
    await sendMail({ to: config.owner || MAIL_USER, subject, text: body, auth });
    state.lastProactiveDay = today();
    state.unansweredProactive = Number(state.unansweredProactive || 0) + 1;
    saveState(state);
    log(`主动写了一封：${subject}｜${body.slice(0, 40)}（约 ${cost.toFixed(5)} 元）`);
  } catch (e) { log('主动来信失败：' + e.message); }
}

async function processOne({ body, subject, fromAddr, msgId, refs, config, state, auth, apiKey, bal }) {
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
    text = pickTemplate(kind || (nightTpl ? 'night' : 'fallback'), state);
    log(`用模板回（${kind || (nightTpl ? '深夜短句' : why)}）：${text}`);
  } else {
    const out = await askModel({ apiKey, history: state.history || [], body, facts: state.facts || [], state });
    text = out.reply; facts = out.facts; usage = out.usage; mode = out.mode; sit = out.sit || {};
    if (!text) { log('回信被数字护栏清空了，退回模板'); text = pickTemplate('fallback', state); mode = 'template'; }
    const cost = addCost(state, usage);
    log(`这封约 ${cost.toFixed(5)} 元（${mode}），今日 ${Number(state.costToday || 0).toFixed(4)} 元`);
  }
  if (!text) { log('没生成内容，跳过'); return false; }

  const grounded = groundFacts(facts, body);
  if (grounded.length) {
    const n = addFacts(state, grounded);
    if (n) log(`顺手记住 ${n} 条：` + grounded.slice(0, 3).join(' / '));
  }
  if (facts.length > grounded.length) log(`过滤掉 ${facts.length - grounded.length} 条没有依据的"事实"`);

  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const dueAt = Date.now() + sendDelayMs(mode === 'template');
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

async function tick(config, state, auth, apiKey) {
  const bal = await balanceOf(apiKey);
  state.bal = bal;
  // 余额提醒带迟滞：掉到 2 元以下只提醒一次；等充回 3 元以上才重新"装弹"，
  // 这样充值之后她绝不会再念叨，直到下次真没钱。
  const LOW = 2;
  const REARM = 3;
  if (bal >= REARM && state.lowWarned) { state.lowWarned = false; saveState(state); }
  if (bal >= 0 && bal < LOW && !state.lowWarned && config.owner) {
    state.lowWarned = true;
    state.balanceWarnDay = today();
    saveState(state);
    try {
      await sendMail({ to: config.owner, subject: `（提醒）我这边余额只剩 ${bal.toFixed(2)} 元`, text: `还剩 ${bal.toFixed(2)} 元。充值前我只能用几句现成的话应付你，不是我不想说话。\n\n充值：https://platform.deepseek.com/ （登录后点右上角余额）\n\n充完就不会再提了。`, auth });
      log('余额提醒已发（' + bal.toFixed(2) + ' 元）');
    } catch (e) { log('余额提醒没发出去：' + e.message); }
    popupTopUp(bal);
  }
  const imap = await Imap.connect();
  try {
    await imap.cmd(`LOGIN "${MAIL_USER}" "${auth}"`);
    await imap.cmd('SELECT INBOX');
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

      const owner = String(config.owner || '').toLowerCase();
      if (!owner) { config.owner = fromAddr; writeJson(CONFIG, config); log(`第一封来信来自 ${fromRaw}，已记为主人`); }
      else if (fromAddr !== owner) { log('忽略非主人来信：' + fromRaw); await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); continue; }

      const dateRaw = headerField(head, 'Date');
      const ageH = dateRaw ? (Date.now() - Date.parse(dateRaw)) / 3600000 : 0;
      if (ageH > Number(config.mailMaxAgeHours || 24)) {
        log('这封信 ' + Math.round(ageH) + ' 小时前发的，太旧了，不回');
        state.seenUids = state.seenUids.concat([String(uid)]).slice(-500); saveState(state);
        await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); continue;
      }

      // 每天回信上限：到顶了别把这封信"吃掉"，留着明天看
      if (state.day !== today()) { state.day = today(); state.count = 0; }
      if (Number(state.count || 0) >= Number(config.dailyCap || 20)) {
        log('今天的回信额度用完了，剩下的信留到明天（不标记已读）');
        if (state.quotaNotifiedDay !== today()) {
          state.quotaNotifiedDay = today();
          saveState(state);
          try {
            await sendMail({ to: config.owner || fromAddr, subject: '（今天聊够了）', text: '今天的额度用完了。剩下的信先留着，我明天再看——不是不理你。', auth });
          } catch (e) { log('额度提醒没发出去：' + e.message); }
        }
        break;
      }

      state.seenUids = state.seenUids.concat([String(uid)]).slice(-500);
      saveState(state);
      await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`);

      const body = await parseBody(raw, subject);
      log('收到来信正文：' + body.slice(0, 30));
      batch.push({ body, subject, fromAddr, msgId, refs });
    }

    if (batch.length) {
      // 一口气发了几封：合成一封回，别刷屏
      const merged = {
        body: batch.length === 1 ? batch[0].body : batch.map((b, i) => `（第 ${i + 1} 封）\n${b.body}`).join('\n\n'),
        subject: batch[0].subject,
        fromAddr: batch[0].fromAddr,
        msgId: batch[batch.length - 1].msgId,
        refs: batch[batch.length - 1].refs,
      };
      if (batch.length > 1) log(`他一口气发了 ${batch.length} 封，合成一封回`);
      try { await processOne({ ...merged, config, state, auth, apiKey, bal }); }
      catch (e) { log('处理来信出错：' + e.message); await alertOnce('generate', '生成回信时出错：' + e.message); }
    }
    return { handled: 1 };
  } finally { imap.quit(); }
}

function single() {
  try { const old = Number(fs.readFileSync(LOCK, 'utf8').trim()) || 0; if (old && old !== process.pid) { try { process.kill(old, 0); console.log('已有实例在跑 pid ' + old); process.exit(3); } catch {} } } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
  process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} });
}

async function main() {
  const args = process.argv.slice(2);
  fs.mkdirSync(DIR, { recursive: true });
  single();
  const config = readJson(CONFIG, { email: '', owner: '', dailyCap: 20, dailyCostCap: 0.05 });
  const li = args.indexOf('--lowbal');
  if (li >= 0) BAL_OVERRIDE = Number(args[li + 1]);
  TZ = String(config.timezone || 'Asia/Shanghai');
  const state = loadState({ history: [], seen: [], facts: [], count: 0, day: '' });
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
    for (const k of ['history', 'facts', 'seen', 'seenUids', 'outbox', 'recentExtras', 'recentWeather', 'recentParticles', 'lastEmotion', 'alerts', 'lastProactiveDay', 'unansweredProactive', 'lowWarned', 'balanceWarnDay']) delete state[k];
    saveState(state);
    console.log('清空了：记忆库、事实、历史、队列。从现在起她什么都不记得。');
    process.exit(0);
  }
  if (args.includes('--status')) {
    console.log(`主人: ${config.owner || '（等第一封来信）'}`);
    console.log(`今天已回: ${state.day === today() ? (state.count || 0) : 0} / ${config.dailyCap}，今天花费 ${Number(state.costToday || 0).toFixed(4)} / ${config.dailyCostCap || 0.05} 元`);
    const ms = memoryStats();
    console.log(`记忆库: ${ms.count} 条（权重合计 ${ms.weight}），${(ms.bytes / 1024).toFixed(1)} KB，原文 ${(ms.rawBytes / 1024).toFixed(1)} KB`);
    console.log(`记得的事: ${(state.facts || []).length} 条`);
    (state.facts || []).slice(-10).forEach((f) => console.log('  - ' + f.text));
    console.log(`待发队列: ${(state.outbox || []).length} 封`);
    (state.outbox || []).forEach((o) => console.log(`  - ${new Date(o.dueAt).toLocaleTimeString('zh-CN', { hour12: false })}：${o.text.slice(0, 24)}`));
    console.log(`上一封语气: ${state.lastEmotion || '（无）'}`);
    console.log(`余额提醒: ${state.lowWarned ? '已提醒过（充值回 3 元以上会自动解除）' : '待命（低于 2 元会提醒一次）'}`);
    console.log(`余额: ${await balanceOf(apiKey)} 元`);
    process.exit(0);
  }
  if (args.includes('--say')) {
    const text = args[args.indexOf('--say') + 1] || '在吗';
    const kind = templateKind(text);
    if (kind || (isNight() && text.length <= 10)) { console.log('（模板，不花钱）她回：', pickTemplate(kind || 'night', state)); process.exit(0); }
    const out = await askModel({ apiKey, history: state.history || [], body: text, facts: state.facts || [], state });
    const cost = ((out.usage.prompt_tokens || 0) * 0.5 + (out.usage.completion_tokens || 0) * 8) / 1e6;
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
  if (args.includes('--once')) {
    const r = await tick(config, state, auth, apiKey);
    const n = await flushOutbox(config, state, auth);
    console.log('本轮:', r, '发出', n);
    process.exit(0);
  }

  log(`邮件服务启动（${MAIL_USER}），时区 ${TZ}，正常每 ${POLL_MS / 1000} 秒看一次（出错会退避）`);
  beat();
  let poll = POLL_MS;
  let lastBeatLog = 0;
  for (;;) {
    let failed = false;
    try { await Promise.race([tick(config, state, auth, apiKey), sleep(150000).then(() => { throw new Error('这一轮超过 150 秒，放弃'); })]); }
    catch (e) { failed = true; log('这一轮出错：' + e.message); await alertOnce('tick', '收信这一轮连续出错：' + e.message); }
    beat();
    try { await flushOutbox(config, state, auth); }
    catch (e) { log('发送队列出错：' + e.message); await alertOnce('send', '发信出错了：' + e.message); }
    beat();
    try { await maybeProactive(apiKey, config, state, auth); } catch (e) { log('主动来信出错：' + e.message); }
    // 出错就退避，别每 100 秒猛撞同一个接口；成功就恢复正常节奏
    poll = failed ? Math.min(poll * 2, 10 * 60000) : POLL_MS;
    if (Date.now() - lastBeatLog > 25 * 60000) {
      lastBeatLog = Date.now();
      log(`在跑（上次${failed ? '出错' : '正常'}，下次 ${Math.round(poll / 1000)} 秒后，今天已回 ${state.count || 0} 封）`);
    }
    await sleep(poll);
  }
}

process.on('exit', (code) => log('进程退出 code=' + code));
process.on('uncaughtException', (e) => { log('未捕获异常（继续跑）：' + (e && e.message ? e.message : e)); alertOnce('crash', '进程里出了个异常：' + (e && e.message ? e.message : String(e))); });
process.on('unhandledRejection', (e) => log('未处理拒绝（继续跑）：' + (e && e.message ? e.message : e)));

if (!process.env.MAILBOT_NO_MAIN) main().catch((e) => { log('启动失败：' + e.message); process.exit(1); });
