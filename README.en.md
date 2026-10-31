# The Poor Man's Way: Email With Her

> **A one-person AI companion that lives in an email thread. ~$0.0002 per letter — about $0.7 a year.**

Send a mail from your inbox to hers. She (an LLM) writes back. That's the whole product.

## What makes it different from a chat window

- **Asynchronous by design.** Letters can wait; she does not answer in two seconds.
- **She remembers.** A local keyword memory store (no vectors, no extra API calls) keeps what you said about your work, your habits, your bad weeks, and can pick it up later.
- **She has a state.** Time of day, weather, being hungry or sleepy — injected into the prompt, with cooldowns so she doesn't repeat herself.
- **Cheap by construction.** Short greetings never hit the model. Night-time one-liners use local templates. Low balance degrades gracefully instead of dying.

## Cost (measured, not guessed)

| Case | Cost |
|---|---|
| Short greeting ("you there?") | **0** — local template |
| A normal letter | ~0.0005–0.0016 CNY |
| 10 letters/day | ≈ 4.7 CNY / year |

## Anti-hallucination guards

1. **Fact grounding** — anything the model wants to remember about you must overlap your letter by ≥50% keywords, or it is dropped.
2. **Number guard** — any number in her reply that is not present in the context deletes that sentence.
3. **Old memories may be quoted, never embellished** — no invented times, places or details.

## Quick start

Requires Node.js ≥ 20.

```bash
npm install
cp config.example.json config.json   # fill email / authCode / apiKey / owner
node mailbot.mjs --test              # IMAP + SMTP + balance
node mailbot.mjs --say hello          # dry run, sends nothing
node mailbot.mjs                      # run forever
```

On Windows use `run-loop.cmd`; on macOS/Linux `./run.sh`. Optional `watchdog.ps1` restarts it if the process ever hangs.

`authCode` is an app password / authorization code (QQ Mail: Settings → Account → enable IMAP/SMTP), **not** your login password.

## What it cannot do

No images, voice, attachments or links. No web search. No reminders. Requires your machine to be on. Mails older than 24h are ignored. Memory is literal keyword matching — paraphrase and she may miss it.

## Privacy

Everything lives locally; only the prompt text leaves your machine. `config.json`, `state.json` and `memory*.jsonl` are gitignored. `node mailbot.mjs --purge --yes` wipes all of it.

## License

MIT.
