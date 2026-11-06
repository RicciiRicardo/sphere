import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type Provider = "anthropic" | "openai" | "xai" | "meta" | "perplexity" | "google";

// Every non-Anthropic provider speaks the OpenAI Chat Completions format, so
// one client type covers them with a different base URL and key.
const OPENAI_COMPATIBLE: Record<Exclude<Provider, "anthropic">, { baseURL?: string; env: string }> = {
  openai: { env: "OPENAI_API_KEY" },
  xai: { baseURL: "https://api.x.ai/v1", env: "XAI_API_KEY" },
  meta: { baseURL: "https://api.meta.ai/v1", env: "META_API_KEY" },
  perplexity: { baseURL: "https://api.perplexity.ai/v1", env: "PERPLEXITY_API_KEY" },
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", env: "GEMINI_API_KEY" },
};

export const PROVIDERS: Provider[] = ["anthropic", "openai", "xai", "meta", "perplexity", "google"];

export const isMock = () => process.env.SPHERE_MOCK === "1";

export function isProviderReady(provider: Provider): boolean {
  if (isMock()) return true;
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  return Boolean(process.env[OPENAI_COMPATIBLE[provider].env]);
}

let anthropic: Anthropic | undefined;
export function anthropicClient() {
  anthropic ??= new Anthropic({ timeout: 180_000 });
  return anthropic;
}

const openaiClients = new Map<Provider, OpenAI>();
export function openaiClient(provider: Exclude<Provider, "anthropic">) {
  let client = openaiClients.get(provider);
  if (!client) {
    const cfg = OPENAI_COMPATIBLE[provider];
    client = new OpenAI({ apiKey: process.env[cfg.env], baseURL: cfg.baseURL, timeout: 180_000 });
    openaiClients.set(provider, client);
  }
  return client;
}

// Lists the model IDs a provider's key can use, so seats can pick a real one
// instead of a guessed name.
export async function listModels(provider: Provider): Promise<string[]> {
  if (isMock()) return [];
  if (provider === "anthropic") {
    const ids: string[] = [];
    for await (const model of anthropicClient().models.list()) ids.push(model.id);
    return ids;
  }
  if (provider === "perplexity") return [...PERPLEXITY_EFFORTS];
  const ids: string[] = [];
  for await (const model of openaiClient(provider).models.list()) ids.push(model.id.replace(/^models\//, ""));
  return ids.sort();
}

// Models that accept Anthropic's server-side refusal fallback.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export interface CompleteArgs {
  provider: Provider;
  model: string;
  system: string;
  prompt: string;
  // Used only in mock mode, to make canned replies recognisable.
  speaker?: string;
}

export async function complete({ provider, model, system, prompt, speaker }: CompleteArgs): Promise<string> {
  if (isMock()) return mockReply(speaker ?? provider, prompt, system);

  if (provider === "anthropic") {
    const client = anthropicClient();
    const params = {
      model,
      max_tokens: 16000,
      system,
      output_config: { effort: "medium" as const },
      messages: [{ role: "user" as const, content: prompt }],
    };
    const response = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          // "default" lets Anthropic pick the fallback model by refusal category.
          ...({ fallbacks: "default" } as object),
        })
      : await client.messages.create(params);
    if (response.stop_reason === "refusal") {
      return "(Claude declined to answer this one.)";
    }
    return response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  }

  if (provider === "perplexity") return perplexity(model, system, prompt);
  if (provider === "meta") return metaResponses(model, system, prompt);

  const client = openaiClient(provider);
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

// The same reply as complete(), handed over piece by piece as it's written,
// so the app can show it and start reading it aloud before it's finished.
// Providers or models that can't stream (Perplexity, which adds its sources
// at the end, and Claude models using server-side fallback) give it in one
// piece. If a stream fails before any text arrives, it's asked again without.
export async function completeStream(args: CompleteArgs, onText: (delta: string) => void): Promise<string> {
  const { provider, model, system, prompt } = args;
  if (isMock()) {
    const text = await complete(args);
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      onText(piece);
      await new Promise((r) => setTimeout(r, 25));
    }
    return text;
  }
  const whole = async () => {
    const text = await complete(args);
    onText(text);
    return text;
  };
  if (provider === "perplexity" || (provider === "anthropic" && FALLBACK_MODELS.has(model))) return whole();

  let text = "";
  const add = (delta: string | undefined) => {
    if (!delta) return;
    text += delta;
    onText(delta);
  };
  try {
    if (provider === "anthropic") {
      const stream = anthropicClient().messages.stream({
        model,
        max_tokens: 16000,
        system,
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: prompt }],
      });
      stream.on("text", add);
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal" && !text.trim()) add("(Claude declined to answer this one.)");
    } else if (provider === "meta") {
      const stream = await openaiClient("meta").responses.create({
        model,
        instructions: system,
        input: prompt,
        reasoning: { effort: "medium" },
        stream: true,
      });
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") add(event.delta);
      }
    } else {
      const stream = await openaiClient(provider).chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        stream: true,
      });
      for await (const chunk of stream) add(chunk.choices[0]?.delta?.content ?? undefined);
    }
  } catch (err) {
    if (text) throw err;
    console.error(`${provider} streaming failed, asking without streaming`, err);
    return whole();
  }
  if (!text.trim()) return whole();
  return text.trim();
}

// Meta's playground calls Muse through the Responses endpoint, and on our
// account Chat Completions answers 404 "model not found" for the same model,
// so Muse goes through Responses too.
async function metaResponses(model: string, system: string, prompt: string): Promise<string> {
  const response = await openaiClient("meta").responses.create({
    model,
    instructions: system,
    input: prompt,
    reasoning: { effort: "medium" },
  });
  return response.output_text?.trim() ?? "";
}

// Perplexity retired Sonar chat completions on Sept 27, 2026 for its Agent
// API (the Responses format). A seat's "model" is either an effort level,
// which picks Perplexity's own search setup, or a specific model ID, which
// then needs web search switched on explicitly.
export const PERPLEXITY_EFFORTS = ["fast", "low", "medium", "high"] as const;
const LEGACY_SONAR: Record<string, string> = { sonar: "fast", "sonar-pro": "fast", "sonar-reasoning-pro": "low" };

interface SearchResults {
  type: "search_results";
  results?: { id?: number | string; url?: string; title?: string }[];
}

async function perplexity(model: string, system: string, prompt: string): Promise<string> {
  const choice = LEGACY_SONAR[model] ?? model;
  const isEffort = (PERPLEXITY_EFFORTS as readonly string[]).includes(choice);
  const body = {
    instructions: system,
    input: prompt,
    ...(isEffort ? { effort: choice } : { model: choice, tools: [{ type: "web_search" }] }),
  };
  const response = await openaiClient("perplexity").responses.create(
    body as unknown as Parameters<OpenAI["responses"]["create"]>[0],
  );
  let text = (response as { output_text?: string }).output_text?.trim() ?? "";
  const output = (response as { output?: unknown[] }).output ?? [];
  const sources = output
    .filter((o): o is SearchResults => (o as { type?: string }).type === "search_results")
    .flatMap((o) => o.results ?? [])
    .filter((r) => r.url);
  if (sources.length) {
    text += "\n\nSources:\n" + sources.map((r) => `[${r.id ?? "?"}] ${r.title ? r.title + " - " : ""}${r.url}`).join("\n");
  }
  return text;
}

function mockReply(speaker: string, prompt: string, system: string): Promise<string> {
  const ask = prompt.split("\n").filter(Boolean).at(-1)?.slice(0, 120) ?? "";
  const wait = (text: string) => new Promise<string>((r) => setTimeout(() => r(text), 400 + Math.random() * 900));
  if (system.includes("CONFIDENCE:")) {
    const confidence = 40 + ((speaker.length * 17) % 55);
    return wait(`PLAN: ${speaker} would break the task into steps and deliver a first draft today.\nWHY ME: It fits my role on the team.\nCONFIDENCE: ${confidence}`);
  }
  const said = prompt.split("RICARDO NOW SAYS\n")[1]?.split("\n")[0] ?? ask;
  if (system.includes("EMAIL DRAFTS") && /\b(draft|reply|email|write to)\b/i.test(said)) {
    return wait(
      `I've drafted a reply to Dana with the landed-cost numbers. (${speaker}, mock)\n\n[[DRAFT]]\nTo: Dana Reyes <dana@example.com>\nSubject: Re: Salon dryer shipment to Kingston\nIn-Reply-To: <mock-3@example.com>\n---\nHi Dana,\n\nLanded cost for 200 units comes to about $X per unit including duty and freight. I'll confirm the final figure by Thursday.\n\nBest,\nRicardo\n[[/DRAFT]]`,
    );
  }
  if (system.includes("round two")) {
    return wait(`I agree with most of that, but I'd push back on the timeline: it's too tight. (${speaker}, mock response)`);
  }
  const replies: Record<string, string> = {
    Claude: `Here's where I'd land, pulling the team together: start with the item that moves revenue this week, then the follow-ups. (Mock reply to: "${ask}")`,
    Muse: `A second view: I'd sequence this differently and protect time for the investor call first. (Mock reply)`,
    Perplexity: `I checked three sources; the numbers line up. (Mock reply)\n\nSources:\n[1] https://example.com/source`,
    Grok: `Nothing breaking on X that changes this today. (Mock reply)`,
    Gemini: `I read through the material: the key numbers hold, but the timeline on page 3 is tight. (Mock reply)`,
    ChatGPT: `Two holes in the plan: no owner for follow-up, and no date on the proposal. (Mock reply)`,
  };
  const text = replies[speaker] ?? `(${speaker} mock reply)`;
  return new Promise((resolve) => setTimeout(() => resolve(text), 400 + Math.random() * 900));
}
