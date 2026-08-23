<!-- title: Telegram -->
<!-- order: 5 -->
<!-- blurb: Pair a Telegram bot and drive loop from your phone — setup, pairing, commands, and the security you need to understand first. -->

The Telegram gateway bridges a bot to a loop agent running on your machine. You message the bot, the agent works on your computer, and the answers come back to your phone. Same sessions, same models, same tools.

> **Read this before you set it up.** Whoever controls the paired chat runs shell commands as you, on your machine, with your files and your credentials. This is not a sandbox. Only pair a chat you control, on a phone you control, and stop the bridge when you aren't using it.

## What you need

- A Telegram account
- loop installed and signed in to a provider ([Signing in](login.html))
- A machine that stays awake — the bridge runs on your computer, not as a hosted service. Close the lid and it stops answering.

## Step 1 — create a bot with BotFather

Everything Telegram-side happens in one chat.

1. Open Telegram and search for **@BotFather** (the one with the blue verified check).
2. Send `/newbot`.
3. Give it a **display name** — anything, e.g. `my loop`.
4. Give it a **username** — must be unique and end in `bot`, e.g. `shekhar_loop_bot`.
5. BotFather replies with a **token** that looks like `8123456789:AAF...`. That's the credential. Copy it.

> The token is full remote control of the bot. Anyone who has it can talk to your bridge. Don't paste it in a chat, a screenshot, or a repo. If it leaks, send `/revoke` to BotFather and set up again with the new token.

## Step 2 — connect it to loop

On the machine loop runs on:

```
loop
```

Then in the TUI:

```
/gateways
```

Pick **Telegram**, then **connect a bot**, and paste the token when prompted.

loop validates the token against Telegram, stores it in `~/.loop/auth.json` alongside your provider credentials, turns the bridge on, and starts polling — **inside the loop you're sitting in**. It starts with loop and stops with it, so quitting takes the bridge with you. If you want one that outlives the terminal, run `loop gateways` from a shell instead (below).

It then prints a pairing link:

```
https://t.me/your_bot?start=a1b2c3d4
```

## Step 3 — pair your phone

**Open that link on the phone you want to use, and press START.**

That link is the whole security model. It carries a one-time code; the first `/start` that arrives with the correct code claims the bridge, and the code is burned immediately. Every other chat that messages the bot gets `not authorized` — forever, until you re-pair.

This is why **pressing START in the bot by hand doesn't work.** A bare `/start` carries no code, so the bridge rejects it. You need the link.

Lost the link? `/gateways` → Telegram → **show pairing link** prints it again, as long as nothing has claimed it yet.

Once paired, the bot replies:

```
connected. send a message to talk to the agent — it runs with full
shell access on the host machine.
```

Send it something. It's the same agent.

## Using it

Plain text goes to the agent as a prompt. Photos are attached as images — screenshot an error and send it with "fix this".

### The interrupt rule

**A message sent while the agent is working interrupts it.** There is no Esc key on a phone, so the natural gesture — just saying the next thing — cancels the running turn and runs yours instead.

If you want the opposite, say so explicitly:

```
/queue also update the changelog
```

That runs after the current turn finishes. `/queue` with no argument lists what's waiting; `/queue clear` empties it.

### Commands

Every one of these is in Telegram's own command menu (the `/` button), so you don't have to remember them.

| Command         | Does                                                                |
| --------------- | ------------------------------------------------------------------- |
| `/new`          | Start a fresh session (alias `/clear`)                              |
| `/sessions`     | List sessions and switch — tap to resume (alias `/resume`)          |
| `/session`      | What the current session is                                         |
| `/name <text>`  | Rename the session (alias `/rename`)                                |
| `/cancel`       | Stop the running turn and drop the queue (alias `/stop`)            |
| `/queue <text>` | Run it after this turn instead of interrupting                      |
| `/model`        | Pick provider, then model — as tappable buttons (alias `/provider`) |
| `/thinking`     | Reasoning effort (alias `/effort`)                                  |
| `/settings`     | Toggle settings as buttons                                          |
| `/extensions`   | Enable or disable extensions                                        |
| `/cost`         | Cost breakdown for the session                                      |
| `/context`      | Context window usage                                                |
| `/steak`        | Token usage heatmap                                                 |
| `/compact`      | Compact the session context                                         |
| `/export`       | Get the transcript back as a file                                   |
| `/cd <path>`    | Working directory for new sessions (alias `/cwd`)                   |
| `/init`         | Analyze the repo and write `AGENTS.md`                              |
| `/status`       | Bridge status                                                       |
| `/help`         | All of the above, in chat                                           |

Panel commands render as inline keyboards — `/model` gives you provider buttons, then model buttons, and the tap applies immediately.

`/cd` matters more than it looks: the bridge has one working directory, and `/cd` changes where **new** sessions start. Switch projects with `/cd ~/code/other-project` then `/new`.

## Running it

By default the bridge lives inside your loop session: it comes up with loop and goes down with it. Nothing is left running after you quit.

| What                                       | How                                                |
| ------------------------------------------ | -------------------------------------------------- |
| Start / stop                               | `/gateways` → Telegram → toggle **bridge: on/off** |
| Restart                                    | `/gateways` → Telegram → **restart bridge**        |
| Status from the shell                      | `loop gateways status`                             |
| Run detached, outliving the terminal       | `loop gateways`                                    |
| Stop a detached one                        | `loop gateways stop`                               |
| Run in the foreground (see the log live)   | `loop gateways telegram`                           |

`loop gateways status` tells you which of the two you have — `inside loop` or `daemon` — and the pid serving it.

If you want a bridge that keeps answering after you close the terminal, that's what `loop gateways` is for: it backgrounds every enabled gateway and hands the shell back, and `loop gateways stop` ends it. `loop gateways stop` will not touch a bridge running inside a loop session — that pid is your whole editor — so turn those off with `/gateways` or by quitting.

`loop gateways telegram` runs the bridge attached to your terminal — the fastest way to see what's actually happening when something misbehaves. `Ctrl+C` stops it.

Only **one** poller can consume a bot at a time. Whichever loop claims it first keeps it, and any other is told so rather than fighting for it; two machines on one token get a 409 from Telegram — use a second bot for the second machine.

## Managing the pairing

| You want to               | Do this                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Move to a different phone | `/gateways` → Telegram → **re-pair (new device)**. Drops the current chat, mints a fresh code, prints a new link. |
| Swap in a different bot   | **replace token**. Re-pairs from scratch.                                                                         |
| Turn it off for now       | Toggle **bridge: off**. Token stays, polling stops.                                                               |
| Remove it entirely        | **disconnect**. Stops the bridge and deletes the token.                                                           |

Re-pairing is also your kill switch: if a phone is lost, re-pair from the TUI and the old chat loses access immediately.

## Security, stated plainly

The bridge gives a chat the same power your terminal has.

- **One chat, ever.** Pairing locks to a single chat id. Group chats, forwarded messages, and anyone else who finds the bot get `not authorized`.
- **The code is one-time.** It's minted at setup, burned on first successful pair, and never echoed into the chat — so someone who finds your bot can't ask for it.
- **The token is the real secret.** Chat pairing protects the bridge; the token protects the bot. Treat it like an API key. `/revoke` in BotFather if it ever leaks.
- **Telegram sees your messages.** Cloud chats aren't end-to-end encrypted. Prompts, file contents the agent quotes back, and diffs all pass through Telegram's servers. Don't drive work you couldn't paste into a normal cloud chat.
- **No sandbox by default.** The agent runs commands as your user. `/bashdeny` and the bash sandbox settings apply here exactly as they do in the TUI — see [Configuration](configuration.html) — and are worth turning on before you leave a bridge running.
- **Stop it when you're done.** Quitting loop stops a bridge running inside it. A detached one needs `loop gateways stop`.

## When it isn't working

| Symptom                            | Cause                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Bot says `not authorized`          | You're messaging from a chat that isn't the paired one. Re-pair, or use the paired phone.      |
| Pressing START does nothing useful | A bare `/start` has no code. Open the pairing link instead.                                    |
| `this bot isn't ready to pair`     | Setup isn't finished, or the code was already claimed. Re-pair from `/gateways`.               |
| Bot doesn't answer at all          | The bridge isn't running. `loop gateways status` says whether anything is serving it.          |
| Log shows 409                      | Two bridges on one token. Stop one.                                                            |
| `token rejected` at setup          | Wrong or revoked token. Get a fresh one from BotFather.                                        |
| Answers stop mid-turn              | The host machine slept or lost network. The bridge reconnects; the turn doesn't.               |

More in [Troubleshooting](troubleshooting.html).
