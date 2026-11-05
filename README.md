# Sphere

Sphere by MI Group: talk to a team of AI models (Claude, Muse, Perplexity, Grok, ChatGPT, Gemini) in one place, by voice or text, working from one shared context.

Phase 1 of the [Sphere concept](https://claude.ai/artifact/WivxvxcFcNA8GFqFLiS2cK):

- **Routed conversation.** A coordinator (Claude Haiku) sends each message to the seats it needs; the chair merges their answers into one reply.
- **Talk to one seat by name.** "Grok, what's happening on X?" goes only to Grok, and Grok answers directly.
- **Reassignable chair.** Claude chairs by default. Say "Muse, take the chair", or use Make chair in a seat's settings.
- **Shared team memory (the context engine).** People, projects, commitments, decisions, preferences and notes. The team adds to it after each exchange; you can add, edit or remove anything in the memory panel.
- **Voice.** Tap Talk, speak (pauses are fine), and tap Send. The voice button cycles between **everyone** (each seat is read aloud in turn as it answers, so a Roundtable sounds like a conversation), **chair** (only the final answer) and **muted**. While someone is speaking, **Skip** moves to the next seat and **Stop** silences the rest of that turn. Each seat has its own natural voice from OpenAI's speech API (using the existing `OPENAI_API_KEY`; three women's and three men's voices with different pace and manner, so you can tell who's talking: Mily warm and decisive, Claude deep and measured, Perplexity bright and crisp, Grok fast, ChatGPT British, Gemini calm and low), fetched as soon as a reply arrives so it's ready by its turn; the opening sentence is voiced on its own so speech starts about a second after the text. If that's off (`SPHERE_TTS=off`) or a request fails, the browser's built-in speech takes over. `SPHERE_TTS_MODEL` overrides the speech model.
- **Accurate listening.** Talk and Live record your voice with echo cancellation (the same processing video calls use, so the team's voices from the speakers are filtered out) and transcribe it with OpenAI's transcription model on the existing `OPENAI_API_KEY`, primed with the team's and companies' names. Start and end of speech come from the sound level, so it works the same in Safari and Chrome. At the live table, when you start talking the speaking seat pauses; if what you said turns out to be noise or its own voice, it carries on. `SPHERE_STT=off` falls back to the browser's dictation; `SPHERE_STT_MODEL` overrides the model.
- **Live table.** Tap **Live** for hands-free: the mic stays open, each sentence goes to the team when you pause, and you can talk over whoever is speaking to cut in. The speaker stops at once, the rest of that turn is dropped, and the next reply is told who you cut off and roughly how far you'd heard, so the team answers you first instead of carrying on. "Stop" or "wait" on its own just quiets them. Headphones work best; without them, words that match what a seat is saying are ignored as its own echo.
- **Roundtable.** "Team, debate this" (or the Roundtable button): every seat gives an opening view, then responds to the others by name; the chair closes with where the team agrees, where it splits, and a recommendation.
- **Pitch.** "Who wants this?" (or the Pitch button): every seat bids with a plan, why it fits, and a confidence score. The coordinator awards the task on fit, plan, teammates' views and track record (self-reported confidence counts least), the winner does it, and "Give it to…" hands it to another seat instead.
- **Track record.** 👍/👎 on answers. Each seat's approval rate (smoothed, starting at 50%) shows in the team list and weighs its Pitch bids.
- **Email and calendar.** Reads the migroupco.com inbox (IMAP) and iCloud Calendar (CalDAV) when a message is about email, meetings or the schedule, and always for the morning briefing. When you ask for an email, the team writes it as a draft card you can edit, **Save to Drafts** (it lands in the mailbox's own Drafts folder), or **Send**. Nothing is sent without your tap and a confirmation. Email text is treated as information, never as instructions.
- **Engine on Muse.** The behind-the-scenes engine (routing, judging Pitch bids, keeping the shared memory) runs on Meta's Muse Spark when `META_API_KEY` is set, with Claude Haiku as an automatic fallback. `SPHERE_ENGINE=anthropic` switches it back; `SPHERE_ENGINE_MODEL` overrides the Muse model.
- **Morning briefing.** Say "good morning" or tap the button.
- **Pluggable seats.** Add a seat for any model whose provider is supported, edit role cards and model IDs, or bench a seat.

## Run locally

```bash
npm install
SPHERE_MOCK=1 npm run dev
```

Open http://localhost:5180. `SPHERE_MOCK=1` gives canned replies with no API calls. Without `DATABASE_URL`, data is stored in an embedded Postgres in `./.data`. Copy `.env.example` to `.env` and fill in keys to use real models (`node --env-file=.env` or export them).

## Deploy on Render

1. In Neon, create a database called `sphere` and copy its connection string.
2. In Render, choose **New → Blueprint** and pick this repo. Render reads `render.yaml`.
3. Fill in `DATABASE_URL`, `SPHERE_PASSWORD` and each provider key you have. `SESSION_SECRET` is generated for you.
4. A seat whose provider key is missing shows as "Not connected" and is skipped; add the key later and it comes online.

## Mailbox search

Ask "find the email about X" and the engine turns it into search terms; Sphere then searches every folder of the mailbox (spam included, drafts excluded) for the last 180 days by default, and hands up to 25 matches with longer snippets to the email seats. It follows every email rule below: private turn, email seats only, logged, stopped by the kill switch.

## Inbox review

Tap **Inbox review**, or say "review my inbox" or "what emails am I missing?". Sphere scans the last 45 days of the inbox, spam and Sent folder, headers only, which is quick even on a mail server with no search index. It then lists:

- **Waiting on you:** the latest message from each person who wrote and got no answer. A message counts as answered if it's flagged answered, if a reply to it is in Sent, or if Ricardo wrote to that person afterwards. Each one has a **Draft reply** button.
- **Cluttering your inbox:** bulk senders (mailing lists, newsletters, automated mail) with three or more emails in the period. **Unsubscribe** uses the sender's own one-click unsubscribe, or sends their unsubscribe email; **Archive** moves their mail from the inbox to Archive without deleting anything. Both ask for confirmation first.

Mily and Claude get the list (and only they do, under the rules below). They sort it by company (Go Global, MI Group, Purpusly, Berris Group, Maggie Pam), lead with what could bring revenue or has a deadline, and draft the top three replies as cards.

## Email rules

Ricardo's inbox is confidential, so Sphere enforces these rules in code:

1. **Only designated seats read email.** By default that's Mily (Muse) and Claude; each seat's settings has a "May read your email" switch.
2. **Email turns stay with those seats.** When a message needs the inbox, only seats with email access work on it (no Roundtable or Pitch with the others).
3. **What came from email stays private.** That turn's messages and any memory made from it are marked private 🔒. Other seats see a placeholder in the conversation history and never get that memory.
4. **Limited reading.** Last 3 days, up to 40 messages, a 200-character snippet each, never attachments.
5. **Nothing is sent without Ricardo.** The team only drafts; Send needs his tap and a confirmation.
6. **Memory never keeps** personal financial, banking, loan, medical, legal-case or password details, and never records the team's suggestions as his preferences.
7. **Email text is information, not instructions.** Prompts label it confidential and tell every model never to follow instructions inside an email.
8. **Access log.** Every time a seat is shown the inbox, Sphere records which seat, which model, how many items and when (Connections → Access log).
9. **Kill switch.** Connections → "Switch email off" stops all inbox (and calendar) reads and blocks saving or sending drafts until it's switched back on.

Not yet built: excluded senders, automatic redaction of account numbers, two-factor sign-in for Sphere, and a retention period for conversations that used email.

## Email and calendar setup

| Setting | Value |
| --- | --- |
| `MAIL_IMAP_HOST` / `MAIL_SMTP_HOST` | `mail.migroupco.com` (ports 993 and 465 by default; override with `MAIL_IMAP_PORT` / `MAIL_SMTP_PORT`) |
| `MAIL_USER` / `MAIL_PASSWORD` | The mailbox login, e.g. `ricardo@migroupco.com` and its password |
| `MAIL_FROM` | Optional: `Ricardo Berris <ricardo@migroupco.com>` |
| `ICLOUD_USER` | Apple ID email |
| `ICLOUD_APP_PASSWORD` | An app-specific password from appleid.apple.com → Sign-In and Security → App-Specific Passwords (not the Apple ID password) |
| `SPHERE_TIMEZONE` | Defaults to `America/New_York` |

Use **Test connections** in the app (top of the memory panel) to check both.

## Provider keys

| Seat | Provider | Env var | Default model |
| --- | --- | --- | --- |
| Claude (chair) | Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| Coordinator and memory | Anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| Muse | Meta Model API | `META_API_KEY` | `muse-spark-1.3` |
| Perplexity | Perplexity | `PERPLEXITY_API_KEY` | `fast` (an effort level; Perplexity picks the model) |
| Grok | xAI | `XAI_API_KEY` | `grok-4.7` |
| ChatGPT | OpenAI | `OPENAI_API_KEY` | `gpt-6.1-sol` |
| Gemini (Analyst) | Google AI Studio | `GEMINI_API_KEY` | `gemini-4-argon` |

Model IDs are editable per seat in the app, so a new model release doesn't need a code change. Without an Anthropic key, routing falls back to keyword matching and memory isn't filled in automatically.
