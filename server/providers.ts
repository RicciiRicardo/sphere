import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type Provider = "anthropic" | "openai" | "xai" | "meta" | "perplexity";

// Every non-Anthropic provider speaks the OpenAI Chat Completions format, so
// one client type covers them with a different base URL and key.
const OPENAI_COMPATIBLE: Record<Exclude<Provider, "anthropic">, { baseURL?: string; env: string }> = {
  openai: { env: "OPENAI_API_KEY" },
  xai: { baseURL: "https://api.x.ai/v1", env: "XAI_API_KEY" },
  meta: { baseURL: "https://api.meta.ai/v1", env: "META_API_KEY" },
  perplexity: { baseURL: "https://api.perplexity.ai", env: "PERPLEXITY_API_KEY" },
};

export const PROVIDERS: Provider[] = ["anthropic", "openai", "xai", "meta", "perplexity"];

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
function openaiClient(provider: Exclude<Provider, "anthropic">) {
  let client = openaiClients.get(provider);
  if (!client) {
    const cfg = OPENAI_COMPATIBLE[provider];
    client = new OpenAI({ apiKey: process.env[cfg.env], baseURL: cfg.baseURL, timeout: 180_000 });
    openaiClients.set(provider, client);
  }
  return client;
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
  if (isMock()) return mockReply(speaker ?? provider, prompt);

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

  const client = openaiClient(provider);
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
  let text = response.choices[0]?.message?.content?.trim() ?? "";
  // Perplexity returns its sources beside the message rather than inside it.
  const citations = (response as unknown as { citations?: string[] }).citations;
  if (citations?.length) {
    text += "\n\nSources:\n" + citations.map((url, i) => `[${i + 1}] ${url}`).join("\n");
  }
  return text;
}

function mockReply(speaker: string, prompt: string): Promise<string> {
  const ask = prompt.split("\n").filter(Boolean).at(-1)?.slice(0, 120) ?? "";
  const replies: Record<string, string> = {
    Claude: `Here's where I'd land, pulling the team together: start with the item that moves revenue this week, then the follow-ups. (Mock reply to: "${ask}")`,
    Muse: `A second view: I'd sequence this differently and protect time for the investor call first. (Mock reply)`,
    Perplexity: `I checked three sources; the numbers line up. (Mock reply)\n\nSources:\n[1] https://example.com/source`,
    Grok: `Nothing breaking on X that changes this today. (Mock reply)`,
    ChatGPT: `Two holes in the plan: no owner for follow-up, and no date on the proposal. (Mock reply)`,
  };
  const text = replies[speaker] ?? `(${speaker} mock reply)`;
  return new Promise((resolve) => setTimeout(() => resolve(text), 400 + Math.random() * 900));
}
