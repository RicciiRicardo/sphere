# Sphere

Sphere by MI Group: talk to a team of AI models (Claude, Muse, Perplexity, Grok, ChatGPT, Gemini) in one place, by voice or text, working from one shared context.

Phase 1 of the [Sphere concept](https://claude.ai/artifact/WivxvxcFcNA8GFqFLiS2cK):

- **Routed conversation.** A coordinator (Claude Haiku) sends each message to the seats it needs; the chair merges their answers into one reply.
- **Talk to one seat by name.** "Grok, what's happening on X?" goes only to Grok, and Grok answers directly.
- **Reassignable chair.** Claude chairs by default. Say "Muse, take the chair", or use Make chair in a seat's settings.
- **Shared team memory (the context engine).** People, projects, commitments, decisions, preferences and notes. The team adds to it after each exchange; you can add, edit or remove anything in the memory panel.
- **Voice.** Tap Talk to speak and the team's reply is read aloud, with a different voice per seat. This uses the browser's built-in speech (Chrome or Safari), so no voice provider is needed yet.
- **Roundtable.** "Team, debate this" (or the Roundtable button): every seat gives an opening view, then responds to the others by name; the chair closes with where the team agrees, where it splits, and a recommendation.
- **Pitch.** "Who wants this?" (or the Pitch button): every seat bids with a plan, why it fits, and a confidence score. The coordinator awards the task on fit, plan, teammates' views and track record (self-reported confidence counts least), the winner does it, and "Give it to…" hands it to another seat instead.
- **Track record.** 👍/👎 on answers. Each seat's approval rate (smoothed, starting at 50%) shows in the team list and weighs its Pitch bids.
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
