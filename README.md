# Chat Bot Scheduler

Telegram-style scheduled messages for the built-in VS Code Copilot Chat.
Type a message, hit the ⏱ clock button, pick a delay — and your message is
delivered into **the same conversation** hours later, exactly like
scheduling a message in Telegram.

## Features

| Feature | Where |
|---|---|
| ⏱ **Clock shortcut** — pick a delay, schedule the current draft in one click | Toolbar beneath the chat input |
| `@bot` chat participant — talk to it, or use `/schedule` and `/list` slash commands | Native chat panel |
| Command Palette entries for scheduling without touching the chat | `Chat Bot Scheduler: Schedule Message` |
| Delivery into the originating chat (matched by conversation snapshot) | Automatic on fire |
| Persistent, catch-up-safe scheduler — schedules survive window reloads and app restarts | Storage-backed |

## Quick start

1. Open the Copilot Chat panel.
2. Type a message in the input box.
3. Click the ⏱ button beneath the input → pick `15 minutes … 3 hours`
   → the message is scheduled immediately (the bot confirms with ⏰).
4. If the input was empty, the command template
   `@bot /schedule in 2h :: ` is pre-filled instead — type the message
   after `::` and press Enter.

Manual form, in chat:

```
@bot /schedule in 2h :: summarize what changed in the workspace
@bot /list
```

## Time syntax

| Format | Example | Meaning |
|---|---|---|
| `in <duration>` | `in 2h`, `in 1h 30m`, `in 2d` | delay from now |
| `at HH:MM` | `at 17:30`, `at 5:30pm` | today (or tomorrow if already past) |
| `at HH:MM tomorrow` | `at 17:30 tomorrow` | tomorrow at the given time |
| `at <date> HH:MM` | `at 2026-09-05 10:00` | exact date and time |
| `daily HH:MM` | `daily 09:30` | recurring every day |
| ISO timestamp | `2026-09-05T10:00:00` | anything `Date.parse` understands |

## Where a scheduled message lands

The core promise: the message goes to **the chat it was scheduled from** —
even if you have moved to another chat by then.

- On scheduling, the extension takes a conversation snapshot. On fire it finds
  the stored chat session matching that snapshot and delivers there.
- If that chat is already open and in front, delivery is silent — nothing
  moves, and any draft you were typing stays intact.
- Otherwise the target chat is revealed (its existing tab is reused, no
  duplicates) and the message is submitted there — that is the point of the
  feature.
- If the original chat was deleted, a new chat is opened seeded with the
  captured history, so the dialogue continues instead of landing in a void.

## Limitations (honest ones)

- **Session matching reads VS Code's internal chat storage**
  (`workspaceStorage/<ws>/chatSessions/`). This is not a public API and can
  break on VS Code updates — in the worst case the extension falls back to
  tier 2 or 3 above.
- **Reading the input draft uses the clipboard.** There is no public API to
  read the chat input box, so the clock button borrows the clipboard for a
  moment (save → probe marker → select-all → copy → read → restore). If the
  clipboard held a **non-text payload (e.g. a screenshot), it is lost** —
  the clipboard API is text-only.
- **Attachments are not part of a draft.** Files, screenshots and tool chips
  attached to the input are not captured; only the text of the message is
  scheduled.
- The clock button lives in the chat input status area (rightmost end of the
  toolbar beneath the input). VS Code does not offer a stable menu inside
  the input row itself.

## Troubleshooting

- After installing a new VSIX, **reload the window** (`Developer: Reload
  Window`) — re-installing an extension with the same version does not swap
  the running code.
- Every action is logged to the **Output → Chat Bot** channel (and to the
  extension host console log): `insertSchedule invoked`, picked delay,
  captured draft, delivery result.
- Check the installed version in the Extensions panel; each build here
  bumps the version on purpose.

## Development

```bash
npm install
npm run compile            # or: npm run watch
node scripts/make-icon.js  # regenerate media/icon.png (256×256, zero deps)

```

### Architecture

```
src/
  types.ts          Schedule, Delivery, RepeatRule, SnapshotTurn
  parser.ts         "in 2h" / "at 17:30" / "daily 09:00" time parser
  scheduler.ts      persistent timer manager: restore, catch-up, re-arm
  sessionFinder.ts  finds a stored chat session by conversation snapshot
  participant.ts    @bot chat participant (chat, /schedule, /list)
  copilot.ts        default Copilot model lookup (vscode.lm)
  extension.ts      commands, clock button, delivery tiers, diagnostics
scripts/
  make-icon.js      generates the extension icon (pure Node, no deps)
```

Scheduler hardening details (why it survives reloads):

- schedules are persisted in `globalState` and re-armed on activation;
- a one-shot schedule that became due while VS Code was closed fires
  immediately on next start (like a queued Telegram message);
- recurring schedules jump to the next occurrence (no backfill spam);
- timers are re-checked when the window regains focus (background windows
  throttle timers);
- delays beyond `2^31 − 1` ms (~24.8 days) are clamped and re-armed.
