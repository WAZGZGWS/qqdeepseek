/**
 * memory —— 她的记忆库（本地、零成本、不用向量）。
 *
 * 两层：
 *   memory.raw.jsonl  原文档案，写进来不动它，平时不参与检索（要翻全文时用）
 *   memory.jsonl      索引层：每条是压缩过的短句 + 权重（说过的次数）+ 首次/最近时间
 *
 * 写入：先跟已有的比相似度（重合率 ≥0.55 就当同一件事），合并成一条并把权重 +1；
 *       否则新增。这样一件事说二十遍只占一行，但权重高、检索排前面。
 * 取用：中文二元组 + 单字（降权）+ BM25 + 时间衰减 + 权重加成。
 *
 * 为什么这么设计：重复本身就是信号（你反复念叨的才是重要的），所以合并不能简单删，
 * 要把次数留成权重；概括会丢细节，所以原文另存一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'memory.jsonl');
const RAW = path.join(DIR, 'memory.raw.jsonl');
const HALF_LIFE_DAYS = 45;
const MERGE_THRESHOLD = 0.35;
const MAX_BYTES = 8 * 1024 * 1024;

let cache = { mtime: -1, size: -1, entries: [], df: new Map(), idx: new Map(), avgdl: 1 };

/** 高频虚词，检索时滤掉，免得"今天""可以"这种词把不相干的话捞上来 */
const STOP_WORDS = new Set(['今天', '昨天', '明天', '现在', '时候', '什么', '怎么', '可以', '一个', '我们', '你们', '他们', '这个', '那个', '还是', '已经', '就是', '因为', '所以', '但是', '如果', '然后', '有点', '不过', '知道', '觉得', '真的', '其实', '东西', '事情', '问题', '感觉', '地方', '一样', '这样', '那样', '的话', '起来', '出来', '过来', '下来', '上去', '上午', '下午', '晚上', '中午', '还有', '没有', '不是', '不会', '这么', '那么']);
const STOP_CHARS = new Set('的了吗呢啊吧嘛哦嗯呀是我你他她它在有和就都也还很把被对与给让从到说想要会能'.split(''));

export function tokenize(s) {
  const t = String(s || '').toLowerCase();
  const out = [];
  const cjk = t.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i + 1 < seg.length; i += 1) out.push(seg.slice(i, i + 2));
    for (const ch of seg) out.push(ch);   // 单字也进索引，打分时降权
  }
  for (const w of (t.match(/[a-z0-9]{2,}/g) || [])) out.push(w);
  return out.filter((tk) => !STOP_WORDS.has(tk) && !(tk.length === 1 && STOP_CHARS.has(tk)));
}

/** 抽取式概括：删填充词、留两句话以内 60 字，不加一次模型调用 */
export function summarize(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(/^(嗯|呃|那个|那个那个|就是|然后|反正|其实)[，,、\s]+/g, '');
    s = s.replace(/(就是说|然后呢|你知道吧|怎么说呢|对吧)/g, '');
    if (s === before) break;
  }
  s = s.replace(/[，,]{2,}/g, '，').replace(/^[，,、；;\s]+/, '');
  const parts = s.split(/(?<=[。！？!?~])/).filter((x) => x.trim());
  let out = parts.slice(0, 2).join('') || s;
  out = out.replace(/[。！？!?~]$/, '');
  if (out.length > 60) {
    const cut = out.slice(0, 60);
    const m = cut.match(/^[\s\S]*[，,、；;]/);
    out = (m ? m[0] : cut).replace(/[，,、；;]$/, '') + '…';
  }
  return out.trim();
}

function build(entries) {
  let totalLen = 0;
  const df = new Map();
  const idx = new Map();
  entries.forEach((e, i) => {
    if (!e._t) e._t = tokenize(e.text);
    e._tf = new Map();
    for (const tk of e._t) e._tf.set(tk, (e._tf.get(tk) || 0) + 1);
    totalLen += e._t.length;
    for (const tk of e._tf.keys()) {
      df.set(tk, (df.get(tk) || 0) + 1);
      const arr = idx.get(tk);
      if (!arr) idx.set(tk, [i]);
      else if (arr.length < 2000) arr.push(i);
    }
  });
  return { df, idx, avgdl: entries.length ? totalLen / entries.length : 1 };
}

function load() {
  let st;
  try { st = fs.statSync(FILE); } catch { return { entries: [], df: new Map(), idx: new Map(), avgdl: 1 }; }
  if (cache.mtime === st.mtimeMs && cache.size === st.size) return cache;
  const entries = [];
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e || !e.text || !e.at) continue;
      if (!e.lastAt) e.lastAt = e.at;
      if (!e.weight) e.weight = 1;
      entries.push(e);
    } catch {}
  }
  const { df, idx, avgdl } = build(entries);
  cache = { mtime: st.mtimeMs, size: st.size, entries, df, idx, avgdl };
  return cache;
}

const strip = (e) => ({ at: e.at, lastAt: e.lastAt, who: e.who, text: e.text, weight: e.weight });

function appendRaw(who, text, at) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    let st = null;
    try { st = fs.statSync(RAW); } catch {}
    if (st && st.size > MAX_BYTES) {
      const old = path.join(DIR, `memory.raw.${new Date().toISOString().slice(0, 10)}.old.jsonl`);
      try { fs.renameSync(RAW, old); } catch {}
    }
    fs.appendFileSync(RAW, JSON.stringify({ at, who, text }) + '\n');
  } catch {}
}

function rewrite(entries) {
  try {
    fs.writeFileSync(FILE, entries.map((e) => JSON.stringify(strip(e))).join('\n') + '\n');
    cache.mtime = -1;   // 让下次 load 重算
  } catch {}
}

const setOf = (tokens) => new Set(tokens);
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
};

/** 只留两字词做"话题指纹"：单字太吵，虚词已滤掉 */
function bigramTf(text) {
  const tf = new Map();
  for (const tk of tokenize(text)) if (tk.length === 2) tf.set(tk, (tf.get(tk) || 0) + 1);
  return tf;
}

/** idf 加权余弦：判断两句话是不是"同一件事" */
function cosine(a, b, df, n) {
  const idf = (t) => Math.log(1 + n / (1 + (df.get(t) || 0)));
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, f] of a) {
    const w = f * idf(t);
    na += w * w;
    const g = b.get(t);
    if (g) dot += w * (g * idf(t));
  }
  for (const [t, f] of b) {
    const w = f * idf(t);
    nb += w * w;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 记一条。who: 'he' | 'me' */
export function remember(who, text, at = Date.now()) {
  // 防御：调用方把参数写反（remember(正文, 'he')）时自动纠正。
  // 这个错真的发生过：条目里 who 变成一整段话，检索从此一条都命中不了。
  if (text === 'he' || text === 'me') { const tmp = who; who = text; text = tmp; }
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!clean) return;
  appendRaw(who, clean, at);

  const brief = summarize(clean) || clean.slice(0, 60);
  const tfNew = bigramTf(brief);
  if (!tfNew.size) return;
  const { entries, idx, df } = load();

  // 只在"至少共用一个话题词"的旧记录里找相似项，别全表比对
  const cands = new Set();
  for (const tk of tfNew.keys()) {
    const arr = idx.get(tk);
    if (!arr) continue;
    for (const i of arr) cands.add(i);
  }
  const n = entries.length + 1;
  let best = -1;
  let bestScore = 0;
  for (const i of cands) {
    const e = entries[i];
    if (e.who !== who) continue;               // 你一句我一句不算重复
    if (!e._btf) e._btf = bigramTf(e.text);
    const s = cosine(tfNew, e._btf, df, n);
    if (s > bestScore) { bestScore = s; best = i; }
  }

  if (best >= 0 && bestScore >= MERGE_THRESHOLD) {
    const e = entries[best];
    e.weight = Number(e.weight || 1) + 1;
    e.lastAt = at;
    // 保留信息量更大的那句（更长、更像"完整说法"）
    if (brief.length > String(e.text).length + 6) e.text = brief;
    rewrite(entries);
    return;
  }

  if (entries.length >= 20000) entries.shift();   // 兜底，别无限长
  entries.push({ at, lastAt: at, who, text: brief, weight: 1 });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(strip(entries[entries.length - 1])) + '\n');
    cache.mtime = -1;
  } catch {}
}

const norm = (s) => String(s || '').replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');

/** 从旧记录里捞最相关的 k 条（不含近 6 小时的，避免和上下文重复） */
export function recall(query, k = 4, opts = {}) {
  const { minScore = 0, excludeRecentMs = 6 * 3600 * 1000 } = opts;   // 0 = 自动按最高分取
  const { entries, df, avgdl } = load();
  if (!entries.length) return [];
  const qTokens = [...new Set(tokenize(query))].slice(0, 60);
  if (!qTokens.length) return [];
  const n = entries.length;
  const now = Date.now();
  const scored = [];
  for (const e of entries) {
    if (now - (e.lastAt || e.at) < excludeRecentMs) continue;
    const dl = (e._t || tokenize(e.text)).length || 1;
    let s = 0;
    for (const tk of qTokens) {
      const f = (e._tf && e._tf.get(tk)) || 0;
      if (!f) continue;
      const idf = Math.log(1 + n / (1 + (df.get(tk) || 0)));
      const w = tk.length === 1 ? 0.35 : 1;   // 单字降权，防噪声
      s += w * idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * dl / avgdl)));
    }
    if (s <= 0) continue;
    const days = (now - (e.lastAt || e.at)) / 86400000;
    s *= Math.exp(-days / HALF_LIFE_DAYS);
    s *= Math.min(1.6, 1 + 0.2 * Math.log2(Number(e.weight || 1)));  // 说过越多次越优先
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s);
  // 相对阈值：只留分数接近最高的那些（语料大时自然就严，小时也不会全灭）
  if (scored.length) {
    const cutoff = Math.max(minScore || 0.15, scored[0].s * 0.45);
    for (let i = scored.length - 1; i >= 0; i -= 1) if (scored[i].s < cutoff) scored.splice(i, 1);
  }
  const picked = [];
  const seen = new Set();
  for (const { e } of scored) {
    const key = norm(e.text).slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(e);
    if (picked.length >= k) break;
  }
  return picked;
}

/** 两句话题的相似度（0~1）：判断"他是不是又在说同一件事" */
export function similarity(a, b) {
  const A = bigramTf(String(a || ''));
  const B = bigramTf(String(b || ''));
  if (!A.size || !B.size) return 0;
  return cosine(A, B, new Map(), 1);
}

/** 取最近 days 天的原文记录（新的在前，最多 limit 条），给"周记/年记"用 */
export function recentRaw(days, limit = 200) {
  let lines = [];
  try { lines = fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const since = Date.now() - days * 86400000;
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const e = JSON.parse(lines[i]);
      if (!e || !e.at || e.at < since || !e.text) continue;
      out.push(e);
    } catch {}
  }
  return out;
}

/** 给提示词用的一段"旧事背景"；没有相关记录就返回空串 */
export function memoryHint(query, k = 4) {
  const hits = recall(query, k);
  if (!hits.length) return '';
  const lines = hits.map((e) => {
    const d = new Date(e.lastAt || e.at);
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const who = e.who === 'he' ? '哥' : '你';
    return `- ${md} ${who}：${String(e.text).slice(0, 120)}`;
  });
  return [
    '# 你们以前聊到过的',
    '下面是你和哥以前信件里的片段，跟你现在要回的话**可能有关，也可能无关**。',
    '只在自然的时候顺口带一句（比如他说"还是老样子"你能接上），别硬扯、别复述、别说"我记得你上次说过"。',
    ...lines,
  ].join('\n');
}

/** 统计，给 --status 看 */
export function memoryStats() {
  const { entries } = load();
  const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  return {
    count: entries.length,
    weight: entries.reduce((a, e) => a + Number(e.weight || 1), 0),
    bytes: size(FILE),
    rawBytes: size(RAW),
    first: entries[0]?.at || 0,
    last: entries[entries.length - 1]?.lastAt || 0,
  };
}

