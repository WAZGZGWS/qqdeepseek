/**
 * 自测：只测"逻辑层"——纯函数、不连邮箱、不调模型、不花钱。
 * 跑法：node test/selftest.mjs   或   npm test
 *
 * 这里不测"她像不像人"，那件事没法自动断言。
 * 测的是那些悄悄坏掉、坏起来看不出来的地方：护栏、去重、截断、模板判定、备份回退。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MAILBOT_NO_MAIN = '1';   // 只导入，别启动服务

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..');
const bot = await import('../mailbot.mjs');
const mem = await import('../memory.mjs');

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (e) {
    fail += 1;
    failures.push([name, e]);
    console.log('  ✗', name, '\n      ', e.message.split('\n')[0]);
  }
}

const existed = (f) => fs.existsSync(path.join(DIR, f));
const filesBefore = ['memory.jsonl', 'memory.raw.jsonl', 'state.json', 'state.bak.json'].filter(existed);

console.log('\n[1] 文字后处理');
await t('humanize 去掉 AI 腔和 markdown', () => {
  const out = bot.humanize('作为AI，我没法帮你。\n- 第一条\n**加粗**的话');
  assert.ok(!out.includes('作为AI'), 'AI 腔没去掉');
  assert.ok(!out.includes('**'), 'markdown 没去掉');
  assert.ok(out.length > 0);
});

await t('humanize 会按上限截断', () => {
  const long = '这是一句很长的话，'.repeat(40);
  assert.ok(bot.humanize(long, 40).length <= 41, '没有截断到 40 字左右');
});

console.log('\n[2] 记忆行解析');
await t('能从回信里抠出 #记忆 行', () => {
  const { text, facts } = bot.splitMemory('早点睡吧。\n#记忆: 加班到半夜 | 晚饭没吃');
  assert.strictEqual(text, '早点睡吧。');
  assert.deepStrictEqual(facts, ['加班到半夜', '晚饭没吃']);
});

await t('#记忆: 无 不算事实', () => {
  const { text, facts } = bot.splitMemory('嗯。\n#记忆: 无');
  assert.strictEqual(facts.length, 0);
  assert.strictEqual(text, '嗯。');
});

console.log('\n[3] 事实校验（防脑补进长期记忆）');
await t('有依据的事实留下', () => {
  const kept = bot.groundFacts(['加班到半夜，晚饭没吃'], '今天加班到半夜，晚饭还没吃');
  assert.strictEqual(kept.length, 1);
});

await t('没依据的事实丢掉', () => {
  const kept = bot.groundFacts(['他喜欢打羽毛球'], '今天加班到半夜，晚饭还没吃');
  assert.strictEqual(kept.length, 0);
});

console.log('\n[4] 数字护栏');
await t('信里有的数字放行', () => {
  const out = bot.guardNumbers('涨了 3000 块啊。早点睡。', '工资涨了 3000 块');
  assert.ok(out.includes('3000'), '合法数字被误删');
});

await t('信里没有的数字删掉那句', () => {
  const out = bot.guardNumbers('你今年 28 岁吧。早点睡。', '今天下雨');
  assert.ok(!out.includes('28'), '不该出现的数字还在');
  assert.ok(out.includes('早点睡'), '无辜的句子被一起删了');
});

await t('全被删光时返回空串（交给上层兜底）', () => {
  assert.strictEqual(bot.guardNumbers('28 岁。3000 块。', '今天下雨'), '');
});

console.log('\n[5] 模板判定（省钱的闸门）');
await t('短问候走模板', () => {
  assert.strictEqual(bot.templateKind('在吗'), 'greet');
  assert.strictEqual(bot.templateKind('晚安'), 'bye');
  assert.strictEqual(bot.templateKind('吃了没'), 'askEat');
});

await t('长句必须走模型', () => {
  assert.strictEqual(bot.templateKind('今天项目上线，领导又改需求，累死了'), '');
});

console.log('\n[6] 来信解析');
const mail = (body) => `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

await t('引用块被切掉', async () => {
  const body = await bot.parseBody(mail('早点睡\n\n---原始邮件---\n这是很久以前的对话'), '无题');
  assert.ok(!body.includes('很久以前'), '引用内容没被切掉');
  assert.ok(body.includes('早点睡'));
});

await t('空正文用主题兜底', async () => {
  const body = await bot.parseBody(mail('   '), '我想你了');
  assert.ok(body.includes('我想你了'), '空信没兜底');
});

await t('长信保留首尾，不丢结尾', async () => {
  const long = '头'.repeat(1500) + '结尾的问题你觉得呢';
  const body = await bot.parseBody(mail(long), '长信');
  assert.ok(body.includes('中间省略'), '没有省略标记');
  assert.ok(body.includes('你觉得呢'), '结尾被切掉了');
  assert.ok(body.length < 1300, '截断没生效');
});

console.log('\n[7] 延迟范围');
await t('模板 20~60 秒', () => {
  for (let i = 0; i < 50; i += 1) {
    const d = bot.sendDelayMs(true);
    assert.ok(d >= 20000 && d <= 60000, `模板延迟越界：${d}`);
  }
});

await t('非模板 1~30 分钟', () => {
  for (let i = 0; i < 50; i += 1) {
    const d = bot.sendDelayMs(false);
    assert.ok(d >= 60000 && d <= 30 * 60000, `延迟越界：${d}`);
  }
});

console.log('\n[8] 花费闸门');
await t('余额太低降级', () => {
  assert.strictEqual(bot.budget({ costToday: 0, costDay: '' }, { dailyCostCap: 0.05 }, 0.3), '余额不足');
  assert.strictEqual(bot.budget({ costToday: 0, costDay: '' }, { dailyCostCap: 0.05 }, 5), '');
});

console.log('\n[9] 记忆库去重与检索');
await t('同一件事说两遍合并成一条，权重 +1', () => {
  mem.remember('he', '今天加班到半夜，晚饭没吃', Date.now() - 3 * 86400000);
  mem.remember('he', '今天又加班到半夜，晚饭都没吃', Date.now() - 2 * 86400000);
  const st = mem.memoryStats();
  assert.strictEqual(st.count, 1, `应该合并成 1 条，实际 ${st.count}`);
  assert.strictEqual(st.weight, 2, `权重应该是 2，实际 ${st.weight}`);
});

await t('相关的问题能捞到', () => {
  const hits = mem.recall('又加班了', 3);
  assert.ok(hits.length >= 1, '没捞到加班那条');
});

await t('不相干的问题不硬凑', () => {
  assert.strictEqual(mem.recall('在吗', 3).length, 0, '"在吗" 不该捞回任何旧事');
});

await t('参数写反了也能自动纠正（曾经真出过这个错）', () => {
  mem.remember('这句是正文不是身份', 'he', Date.now() - 3 * 86400000);   // 故意写反
  const raw = fs.readFileSync(path.join(DIR, 'memory.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(raw.every((r) => r.who === 'he' || r.who === 'me'), 'who 字段里混进了正文');
  assert.ok(raw.some((r) => r.text.includes('这句是正文')), '正文没被正确存下来');
});

console.log('\n[10] 状态备份');
await t('写两次后生成 state.bak.json', () => {
  const s = { hello: 1 };
  bot.saveState(s);
  bot.saveState({ hello: 2 });
  assert.ok(existed('state.bak.json'), '没有生成备份');
});

// 清理：只删测试过程中新建的文件，别动已有数据
for (const f of ['memory.jsonl', 'memory.raw.jsonl', 'state.json', 'state.bak.json']) {
  if (!filesBefore.includes(f)) { try { fs.unlinkSync(path.join(DIR, f)); } catch {} }
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`);
if (fail) {
  console.log('\n失败的用例：');
  for (const [name, e] of failures) console.log(' -', name, '\n   ', e.message);
  process.exit(1);
}
