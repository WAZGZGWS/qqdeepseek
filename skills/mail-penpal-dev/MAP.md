# mailbot 函数地图（自动生成；改完代码跑 node scripts/map.mjs 刷新）

先读这个定位，再按行号局部读 30~60 行。不要整文件读（1300+ 行约 2 万 token）。

## mailbot.mjs（共 1347 行）

| 行 | 函数 | 作用 |
|---|---|---|
| 54 | `rotateLog` |  |
| 63 | `saveState` | 状态写盘前先留一份备份：state.json 坏了还能回退 |
| 73 | `loadState` | 读状态：主文件坏了就用备份 |
| 83 | `alertOnce` |  |
| 100 | `decrypt` |  |
| 143 | `parseBody` |  |
| 163 | `nodemailer` |  |
| 166 | `sendMail` |  |
| 182 | `pickTemplate` |  |
| 190 | `templateKind` |  |
| 203 | `nowHour` |  |
| 205 | `callModel` |  |
| 217 | `persona` |  |
| 219 | `splitMemory` |  |
| 231 | `extractLoops` | 从他的信里挑"还没结论"的话：带问号，或说"看情况/回头再说" |
| 244 | `mentions` | body 里是不是又提到 loop 这件事（重叠两个词以上、且覆盖三成） |
| 254 | `supports` | 这条事实在给定文字里有没有依据（短的只要一个词，长的要两个以上） |
| 265 | `auditFacts` | 审计长期事实：模棱两可的、出处里找不到依据的，自动清掉（留档可查） |
| 284 | `recordLoops` | 维护"悬着的事"清单：新出现的加进去，他已经回答过的移出去，最多留 5 条 7 天 |
| 298 | `pickLoop` | 挑一件"还没说完的事"提醒她可以追问（别挑跟这封信重复的） |
| 306 | `daysTogether` | 认识多少天了（从第一次通信算） |
| 312 | `splitSelf` | 两句话题的相似度（0~1）：判断"他是不是又在说同一件事" |
| 329 | `bumpStranger` | 陌生人计数：同一地址累计多少封、够不够提醒、够不够拉黑 |
| 343 | `isOwner` | 只认写死的那个地址：空的 owner 一律不放行（防止"第一封来信自动认主"） |
| 349 | `groundFacts` | 事实入库前校验：必须能在他的原信里找到依据，否则是模型脑补的，丢掉 |
| 362 | `addFacts` |  |
| 378 | `humanize` |  |
| 392 | `numbersIn` | 数字护栏：回复里的数字必须是上下文里出现过的，否则整句删掉 |
| 393 | `guardNumbers` |  |
| 405 | `emotionOf` | 情绪：从她自己写的话里认，不花钱 |
| 416 | `weather` |  |
| 464 | `nextStep` | 上一封说了什么，下一封可以"顺下去"的那个状态（比如 在等外卖 → 在吃饭） |
| 470 | `dayRec` | 今天的记账本：哪天说过哪些状态、各说了几次 |
| 479 | `allowedExtras` | 这个点她"可以说自己在干嘛"：既在时段内，也没超过当天次数 |
| 496 | `situation` |  |
| 538 | `bannedParticles` | 口癖降频：最近 5 封里出现过 3 次以上的，这次禁掉 |
| 549 | `lengthMode` | 长度模式：三成短、六成中、一成多 |
| 556 | `askModel` |  |
| 685 | `balanceOf` |  |
| 698 | `addCost` |  |
| 714 | `guardSelf` | 不许她编"我同事/我朋友"这类来历（第二人称照常，说"你同事"没问题） |
| 723 | `selfBlock` | 把档案拼成提示词用的一段 |
| 736 | `timePolicy` |  |
| 746 | `guardTime` | 时间打架的句子直接删掉（跟数字护栏一个思路） |
| 756 | `budget` | 这一封能不能花钱；不能就回原因（用来降级成模板） |
| 764 | `sendDelayMs` | 发信延迟：白天压到 30 分钟内（免得"现在"过期），深夜他醒着就快一点 |
| 779 | `enqueue` |  |
| 785 | `flushOutbox` | 到点了就发。发成功才记历史、记记忆、加计数 |
| 828 | `writeDigest` | 周记 / 年记：从原文档案里翻这段时间的记录，写一封回顾 |
| 863 | `maybeSummaries` | 到点了吗：周记按周几+时间，年记按 12-31 |
| 878 | `maybeProactive` | 每天最多一封主动来信：有由头才发；安静时段、连发超限、刚聊过都不发 |
| 919 | `processOne` |  |
| 984 | `popupTopUp` | 桌面弹一个窗：点"确定"去充值，60 秒自动关，不卡服务 |
| 996 | `tick` |  |
| 1140 | `single` |  |
| 1146 | `main` |  |

## memory.mjs（共 385 行）

| 行 | 函数 | 作用 |
|---|---|---|
| 31 | `tokenize` |  |
| 46 | `summarize` | 抽取式概括：删填充词、留两句话以内 60 字，不加一次模型调用 |
| 66 | `build` |  |
| 85 | `load` |  |
| 107 | `appendRaw` |  |
| 120 | `rewrite` |  |
| 136 | `bigramTf` | 只留两字词做"话题指纹"：单字太吵，虚词已滤掉 |
| 143 | `cosine` | idf 加权余弦：判断两句话是不是"同一件事" |
| 163 | `remember` | 记一条。who: 'he' | 'me' |
| 216 | `recall` | 从旧记录里捞最相关的 k 条（不含近 6 小时的，避免和上下文重复） |
| 273 | `expandQuery` | 把查询里出现的词，扩成同义的一组 |
| 284 | `similarity` | 两句话题的相似度（0~1）：判断"他是不是又在说同一件事" |
| 292 | `recentRaw` | 取最近 days 天的原文记录（新的在前，最多 limit 条），给"周记/年记"用 |
| 308 | `memoryHint` | 给提示词用的一段"旧事背景"；没有相关记录就返回空串 |
| 326 | `listEntries` | 列出所有记忆（带序号，给 --memory 用） |
| 332 | `removeEntry` | 删掉第 n 条（1 开始） |
| 342 | `clearAll` | 清空记忆库（索引 + 原文） |
| 349 | `exportMarkdown` | 导出一份人能读的 memory.md |
| 372 | `memoryStats` | 统计，给 --status 看 |

## 改代码常去的几处

| 想改 | 找哪个 |
|---|---|
| 状态池 / 时段 / 配额 / 状态链 | `EXTRA_TABLE`、`allowedExtras`、`situation` |
| 说话风格 | `askModel` 里的 rules 和 few-shot 块 |
| 人格 | `persona.md`（不用改代码）|
| 时间禁语 | `timePolicy`、`guardTime` |
| 自相矛盾拦截 | `guardSelf`、`guardNumbers` |
| 记忆检索权重 | `memory.mjs` 的 `recall`、`SYNONYMS` |
| 事实入库/审计 | `groundFacts`、`addFacts`、`auditFacts` |
| 回信快慢 | `sendDelayMs`、`replyDelay` |
| 主动来信 / 周记 | `maybeProactive`、`writeDigest`、`maybeSummaries` |
| 收信主循环 | `tick`、`processOne`、`flushOutbox` |
