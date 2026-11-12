import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropicClient, currentModel, isMock, isProviderReady, openaiClient, withRepair } from "./providers.js";

// The engine: the behind-the-scenes model that routes messages, judges Pitch
// bids and keeps the shared memory. It runs on Meta's Muse Spark when the Meta
// key is set (SPHERE_ENGINE=anthropic switches back), with Claude Haiku as the
// fallback whenever Muse fails or returns something that doesn't fit.
const MUSE_ENGINE_MODEL = process.env.SPHERE_ENGINE_MODEL?.trim() || "muse-spark-1.3";
const CLAUDE_ENGINE_MODEL = "claude-haiku-5-5";

function primary(): "meta" | "anthropic" {
  const choice = process.env.SPHERE_ENGINE?.trim();
  if (choice === "anthropic" || choice === "meta") return choice;
  return isProviderReady("meta") ? "meta" : "anthropic";
}

export function engineInfo() {
  const p = primary();
  return {
    provider: p,
    model: p === "meta" ? currentModel("meta", MUSE_ENGINE_MODEL) : CLAUDE_ENGINE_MODEL,
    label: p === "meta" ? "Muse Spark (Meta)" : "Claude Haiku (Anthropic)",
  };
}

// Pulls the JSON object out of a reply that may wrap it in prose or a code fence.
function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

async function viaMuse<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T | undefined> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const response = await withRepair("meta", MUSE_ENGINE_MODEL, (model) =>
    openaiClient("meta").responses.create({
      model,
      instructions: `${system}\n\nReply with only one JSON object, no prose and no code fence, matching this JSON Schema:\n${jsonSchema}`,
      input: user,
      reasoning: { effort: "low" },
    }),
  );
  const parsed = schema.safeParse(parseJsonObject(response.output_text ?? ""));
  if (!parsed.success) {
    console.error("Muse engine reply didn't fit the schema", parsed.error.message.slice(0, 300));
    return undefined;
  }
  return parsed.data;
}

async function viaClaude<T>(schema: z.ZodType<T>, system: string, user: string, maxTokens: number): Promise<T | undefined> {
  const response = await anthropicClient().messages.parse({
    model: CLAUDE_ENGINE_MODEL,
    max_tokens: maxTokens,
    output_config: { format: zodOutputFormat(schema), effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  });
  return response.parsed_output ?? undefined;
}

// One structured decision from the engine. Returns undefined when neither
// model is available or both fail, so callers fall back to simple rules.
export async function engineJSON<T>(
  schema: z.ZodType<T>,
  system: string,
  user: string,
  maxTokens = 2000,
): Promise<{ data: T; by: "meta" | "anthropic" } | undefined> {
  if (isMock()) return undefined;
  const order: ("meta" | "anthropic")[] = primary() === "meta" ? ["meta", "anthropic"] : ["anthropic"];
  for (const p of order) {
    if (!isProviderReady(p)) continue;
    try {
      const data = p === "meta" ? await viaMuse(schema, system, user) : await viaClaude(schema, system, user, maxTokens);
      if (data !== undefined) return { data, by: p };
    } catch (err) {
      console.error(`engine call via ${p} failed`, err);
    }
  }
  return undefined;
}
