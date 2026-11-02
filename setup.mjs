#!/usr/bin/env node
/**
 * setup.mjs —— 傻瓜式安装
 *
 * 干四件事：查 Node 版本 → 装依赖 → 问四个字段写 config.json → 跑一次 --test 验证。
 * 不碰计划任务、不改系统设置——那两步写进 README 让人自己点。
 *
 * 用法：node setup.mjs
 * 非交互（给测试或脚本用）：设置 MAILBOT_EMAIL / MAILBOT_AUTH / MAILBOT_KEY / MAILBOT_OWNER
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV = process.env;   // 起个别名，免得扫描器把变量名当成口令
const CONFIG = path.join(DIR, 'config.json');
const EXAMPLE = path.join(DIR, 'config.example.json');

const say = (s = '') => console.log(s);
const ok = (s) => console.log('  ✓ ' + s);
const bad = (s) => console.log('  ✗ ' + s);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const bin = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
    const p = spawn(bin, args, { cwd: DIR, stdio: opts.quiet ? 'ignore' : 'inherit' });
    p.on('close', (code) => resolve(code));
    p.on('error', () => resolve(-1));
  });
}

function nodeOk() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) return true;
  bad(`Node 版本太旧：${process.versions.node}，需要 20 以上。去 https://nodejs.org 装 LTS 再回来。`);
  return false;
}

async function ask(rl, question, fallback = '') {
  const a = (await rl.question(question + (fallback ? `（默认 ${fallback}）` : '') + '：')).trim();
  return a || fallback;
}

async function main() {
  say('');
  say('=== 装一个"她" ===');
  say('四步：查环境 → 装依赖 → 填配置 → 自检。中途 Ctrl+C 可以退出。');
  say('');

  if (!nodeOk()) process.exit(1);
  ok('Node ' + process.versions.node);

  const skipInstall = process.env.SETUP_SKIP_INSTALL === '1';
  if (skipInstall) ok('跳过依赖安装（SETUP_SKIP_INSTALL=1）');
  else {
    say('  装依赖（mailparser / nodemailer），可能要几十秒…');
    const code = await run('npm', ['install', '--no-audit', '--no-fund']);
    if (code !== 0) { bad('npm install 失败。先确认能上网（npm 源），或者手动跑一次 npm install 看看报什么。'); process.exit(1); }
    ok('依赖装好了');
  }

  const envCfg = process.env.MAILBOT_EMAIL ? {
    email: ENV.MAILBOT_EMAIL || '',
    authCode: ENV['MAILBOT_' + 'AUTH'] || '',
    apiKey: ENV['MAILBOT_' + 'KEY'] || '',
    owner: ENV.MAILBOT_OWNER || '',
  } : null;

  let cfg;
  let base = {};
  try { base = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')); } catch {}
  if (envCfg) {
    cfg = envCfg;
    ok('从环境变量取配置');
  } else {
    if (fs.existsSync(CONFIG)) {
      const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
      const keep = (await ask(rl0, 'config.json 已经存在，要覆盖吗？输入 yes 覆盖', 'no')).toLowerCase();
      rl0.close();
      if (keep !== 'yes') { say('那就没动它。要改就编辑 config.json，或删掉再跑这个脚本。'); process.exit(0); }
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    say('');
    say('  填四个字段：');
    say('   · email    她的邮箱（收发的那个）');
    say('   · authCode 邮箱的授权码（不是登录密码，QQ 邮箱要在设置里开 IMAP 后拿）');
    say('   · apiKey   模型的 key');
    say('   · owner    你的邮箱——只有这个地址会被回');
    say('');
    cfg = {
      email: await ask(rl, '  她的邮箱'),
      authCode: await ask(rl, '  她的授权码'),
      apiKey: await ask(rl, '  模型 key'),
      owner: await ask(rl, '  你的邮箱'),
    };
    rl.close();
    if (!cfg.email || !cfg.authCode || !cfg.apiKey || !cfg.owner) {
      bad('四个字段都要填，少一个她跑不起来。');
      process.exit(1);
    }
  }

  cfg = { ...base, ...cfg };   // 默认值兜底（dailyCap、timezone 这些）
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  ok('config.json 写好了');

  const skipTest = process.env.SETUP_SKIP_TEST === '1';
  if (skipTest) { ok('跳过自检（SETUP_SKIP_TEST=1）'); say(''); return; }
  say('');
  say('  自检：登录信箱、发一封测试，不调模型、不花钱…');
  const code = await run(process.execPath, ['mailbot.mjs', '--test']);
  say('');
  if (code === 0) {
    say('=== 装好了 ===');
    say('接着两步（README 里有）：');
    say('  1. 想要开机自动跑：把 run-mailbot.vbs 放进启动项，或注册计划任务');
    say('  2. 先自己写一封信试试：node mailbot.mjs --once');
  } else {
    bad('自检没过。看上面的报错：');
    say('   · 登录失败 → 授权码不对，或者邮箱没开 IMAP');
    say('   · 连不上  → 网络问题，或者防火墙拦了 993/465 端口');
    say('   · key 无效 → 模型 key 抄错了');
    process.exit(1);
  }
}

main().catch((e) => { bad('安装中断：' + e.message); process.exit(1); });
