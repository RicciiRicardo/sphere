import express, { type Express, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { db } from "./db.js";
import { memorySlice } from "./context.js";
import { receiveSent, type ChatSource } from "./imports.js";

// Sphere as a connector inside ChatGPT and Claude (an MCP server). From a chat
// there, Ricardo can say "send this to Sphere" and the conversation is read
// into the team memory by the same rules as an imported export; or the app can
// look up what the team already knows. Only shared memory ever leaves Sphere:
// items locked to the email seats stay inside.
//
// The app connects with OAuth: it registers itself, Ricardo approves it once
// on Sphere's own page (with his Sphere password, unless already signed in),
// and the app gets a token he can revoke from Connections at any time.

const ACCESS_MS = 60 * 60_000;
const REFRESH_MS = 60 * 86_400_000;
const CODE_MS = 5 * 60_000;
const MAX_CLIENTS = 30;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export interface ConnectorDeps {
  // Whether the request carries a signed-in Sphere session.
  signedIn: (req: Request) => boolean;
  // Whether the given text is the Sphere password (true when none is set, locally).
  checkPassword: (given: string) => boolean;
}

export interface ConnectedApp {
  id: string;
  name: string;
  source: ChatSource;
  connected_at: string;
  last_used: string | null;
}

interface Client {
  id: string;
  name: string;
  redirect_uris: string;
  secret_hash: string | null;
}

// Which app a client is, from where it sends Ricardo back after approval.
function sourceOf(redirectUris: string[]): ChatSource {
  const hosts = redirectUris.map((u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  });
  if (hosts.some((h) => /(^|\.)(chatgpt\.com|openai\.com)$/.test(h))) return "chatgpt";
  if (hosts.some((h) => /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(h))) return "claude";
  return "app";
}

const APP_NAMES: Record<ChatSource, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", app: "AI app" };

// Redirects must be https, or back to this computer (desktop apps).
function okRedirect(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const url = new URL(u);
    if (url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

async function getClient(id: unknown): Promise<Client | undefined> {
  if (typeof id !== "string" || !id) return undefined;
  const { rows } = await db.query<Client>("SELECT * FROM oauth_clients WHERE id = $1", [id]);
  return rows[0];
}

const redirectsOf = (c: Client) => JSON.parse(c.redirect_uris) as string[];

export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const { rows } = await db.query<{ id: string; name: string; redirect_uris: string; connected_at: string; last_used: string | null }>(
    `SELECT c.id, c.name, c.redirect_uris, MIN(t.created_at) AS connected_at, MAX(t.last_used) AS last_used
     FROM oauth_clients c JOIN oauth_tokens t ON t.client_id = c.id
     WHERE t.refresh_expires > NOW()
     GROUP BY c.id ORDER BY MIN(t.created_at)`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, source: sourceOf(JSON.parse(r.redirect_uris)), connected_at: r.connected_at, last_used: r.last_used }));
}

export async function disconnectApp(id: string) {
  await db.query("DELETE FROM oauth_tokens WHERE client_id = $1", [id]);
  await db.query("DELETE FROM oauth_codes WHERE client_id = $1", [id]);
  await db.query("DELETE FROM oauth_clients WHERE id = $1", [id]);
}

// "Sign out everywhere" disconnects the apps too.
export async function disconnectAllApps() {
  await db.query("DELETE FROM oauth_tokens");
  await db.query("DELETE FROM oauth_codes");
}

async function issueTokens(clientId: string) {
  const access = token();
  const refresh = token();
  await db.query(
    `INSERT INTO oauth_tokens (client_id, access_hash, refresh_hash, access_expires, refresh_expires)
     VALUES ($1, $2, $3, $4, $5)`,
    [clientId, hash(access), hash(refresh), new Date(Date.now() + ACCESS_MS), new Date(Date.now() + REFRESH_MS)],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: "sphere" };
}

// Which app a request's bearer token belongs to, if it's valid.
async function bearerClient(req: Request): Promise<Client | undefined> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return undefined;
  const { rows } = await db.query<Client & { token_id: number; last_used: string | null }>(
    `SELECT c.*, t.id AS token_id, t.last_used FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
     WHERE t.access_hash = $1 AND t.access_expires > NOW()`,
    [hash(m[1])],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (!row.last_used || Date.now() - new Date(row.last_used).getTime() > 60_000) {
    await db.query("UPDATE oauth_tokens SET last_used = NOW() WHERE id = $1", [row.token_id]);
  }
  return row;
}

// Too many wrong passwords on the approval page pause it for a while.
const failures: number[] = [];
const tooManyFailures = () => {
  const since = Date.now() - 15 * 60_000;
  while (failures.length && failures[0] < since) failures.shift();
  return failures.length >= 5;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: Response, status: number, body: string) {
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .set("X-Frame-Options", "DENY")
    .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'")
    .type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Sphere</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #fff; --text: #1d1d1f; --muted: #6b6b70; --accent: #2f5bd3; --line: #dddbd5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151517; --card: #1f1f22; --text: #f2f2f4; --muted: #a0a0a8; --accent: #7d9cff; --line: #35353a; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 420px; margin: 8vh auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p, li { color: var(--muted); }
  ul { padding-left: 20px; }
  b { color: var(--text); }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); }
  .row { display: flex; gap: 10px; margin-top: 16px; }
  button { flex: 1; padding: 11px; font-size: 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
  button.allow { background: var(--accent); border-color: var(--accent); color: #fff; }
  .error { color: #c62828; }
</style></head><body><main><div class="card">${body}</div></main></body></html>`);
}

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
}

// Checks an approval request. Problems with the app or where it would send
// Ricardo are shown on the page (never redirected to); others go back to the app.
async function checkAuthorize(q: Record<string, unknown>): Promise<{ client: Client; p: AuthorizeParams } | { page: string } | { redirect: string }> {
  const client = await getClient(q.client_id);
  if (!client) return { page: "This app isn't registered with Sphere. Remove the connector in the app and add it again." };
  const redirect = String(q.redirect_uri ?? "");
  if (!redirectsOf(client).includes(redirect)) return { page: "This app asked to return to an address it didn't register, so Sphere stopped here." };
  const state = typeof q.state === "string" ? q.state : "";
  const back = (error: string) => {
    const url = new URL(redirect);
    url.searchParams.set("error", error);
    if (state) url.searchParams.set("state", state);
    return { redirect: url.toString() };
  };
  if (q.response_type !== "code") return back("unsupported_response_type");
  if (q.code_challenge_method !== "S256" || typeof q.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
    return back("invalid_request");
  }
  return { client, p: { client_id: client.id, redirect_uri: redirect, state, code_challenge: q.code_challenge } };
}

function approvalPage(res: Response, client: Client, p: AuthorizeParams, signedIn: boolean, error = "") {
  const app = APP_NAMES[sourceOf(redirectsOf(client))];
  const host = new URL(p.redirect_uri).host;
  const hidden = Object.entries(p)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  page(
    res,
    error ? 401 : 200,
    `<h1>Connect ${esc(client.name)} to Sphere?</h1>
<p>${esc(client.name)} (returning to <b>${esc(host)}</b>) will be able to:</p>
<ul>
  <li><b>Send conversations to Sphere</b>, which Mily reads into the team memory by the usual rules.</li>
  <li><b>Look up the team's shared memory.</b> Items locked 🔒 to the email seats are never shared with ${esc(app === "AI app" ? "it" : app)}.</li>
</ul>
<p>It can't read your email or calendar, and you can disconnect it anytime in Sphere, under Memory → Use Sphere inside ChatGPT and Claude.</p>
<form method="post" action="/oauth/authorize">${hidden}
${signedIn ? "" : `<p><label for="pw">Your Sphere password</label></p><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>`}
${error ? `<p class="error">${esc(error)}</p>` : ""}
<div class="row"><button name="decision" value="deny" formnovalidate>Cancel</button><button class="allow" name="decision" value="allow">Connect</button></div>
</form>`,
  );
}

function mcpServer(client: Client) {
  const source = sourceOf(redirectsOf(client));
  const server = new McpServer({ name: "sphere", title: "Sphere", version: "1.0.0" });
  server.registerTool(
    "send_to_sphere",
    {
      title: "Send to Sphere",
      description:
        "Send this conversation to Sphere, Ricardo Berris's AI team (MI Group), so the team remembers it. Use when Ricardo asks to send, save or share something with Sphere or \"the team\". Include what Ricardo himself said, asked for and decided, in his words where you can, plus the key facts, names, numbers and next steps; leave out long passages of your own writing. Sphere's chair reads it and adds the lasting facts to the team memory; sensitive details are kept to the seats allowed to read his email.",
      inputSchema: {
        title: z.string().max(200).describe("A short title for what this conversation was about."),
        content: z.string().min(1).max(60_000).describe("The conversation, or a faithful summary of it, as described above."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, content }) => {
      await receiveSent(source, title, content);
      return {
        content: [
          {
            type: "text",
            text: "Sent to Sphere. Mily will read it in the next few minutes and add what matters to the team memory; Ricardo can see it under Memory in Sphere.",
          },
        ],
      };
    },
  );
  server.registerTool(
    "search_sphere_memory",
    {
      title: "Search Sphere's memory",
      description:
        "Look up what Ricardo Berris's AI team (Sphere) already knows: people and organizations, his companies (Go Global, MI Group, Purpusly, Berris Group, Maggie Pam), projects, commitments, decisions and his preferences. Use it before answering questions about his work, people or plans.",
      inputSchema: { query: z.string().max(500).describe("What to look up, in a few words.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      // Never locked items: those stay with the seats allowed to read email.
      const items = await memorySlice(query, false, 25);
      const text = items.length
        ? items.map((m) => `- (${m.kind}) ${m.content} [from: ${m.source}]`).join("\n")
        : "Sphere's shared memory has nothing yet.";
      return { content: [{ type: "text", text }] };
    },
  );
  return server;
}

export function mountConnector(app: Express, deps: ConnectorDeps) {
  // Behind Render's proxy, so the address apps see is https.
  app.set("trust proxy", 1);
  const base = (req: Request) => (process.env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const form = express.urlencoded({ extended: false, limit: "20kb" });

  const resourceMetadata = (req: Request, res: Response) => {
    res.json({
      resource: `${base(req)}/mcp`,
      authorization_servers: [base(req)],
      scopes_supported: ["sphere"],
      bearer_methods_supported: ["header"],
      resource_name: "Sphere",
    });
  };
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const b = base(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["sphere"],
    });
  });

  // Apps register themselves. Registering grants nothing: Ricardo still has
  // to approve the app on the page below.
  app.post("/oauth/register", async (req, res) => {
    const body = req.body ?? {};
    const uris: unknown[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https (or localhost) URLs." });
      return;
    }
    // Registrations that were never approved don't pile up.
    await db.query(
      `DELETE FROM oauth_clients c WHERE created_at < NOW() - INTERVAL '1 day'
       AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.id)`,
    );
    const { rows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM oauth_clients");
    if (rows[0].n >= MAX_CLIENTS) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Too many apps registered. Disconnect some in Sphere (Memory → Use Sphere inside ChatGPT and Claude) first." });
      return;
    }
    const method = ["client_secret_post", "client_secret_basic"].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : "none";
    const id = `app_${token()}`;
    const secret = method === "none" ? undefined : token();
    const name = String(body.client_name || APP_NAMES[sourceOf(uris as string[])]).slice(0, 80);
    await db.query("INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash) VALUES ($1, $2, $3, $4)", [
      id,
      name,
      JSON.stringify(uris),
      secret ? hash(secret) : null,
    ]);
    res.status(201).json({
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "sphere",
    });
  });

  app.get("/oauth/authorize", async (req, res) => {
    const checked = await checkAuthorize(req.query as Record<string, unknown>);
    if ("page" in checked) return page(res, 400, `<h1>Couldn't connect</h1><p>${esc(checked.page)}</p>`);
    if ("redirect" in checked) return res.redirect(checked.redirect);
    approvalPage(res, checked.client, checked.p, deps.signedIn(req));
  });

  app.post("/oauth/authorize", form, async (req, res) => {
    const checked = await checkAuthorize({ ...req.body, response_type: "code", code_challenge_method: "S256" });
    if ("page" in checked) return page(res, 400, `<h1>Couldn't connect</h1><p>${esc(checked.page)}</p>`);
    if ("redirect" in checked) return res.redirect(303, checked.redirect);
    const { client, p } = checked;
    const back = new URL(p.redirect_uri);
    if (p.state) back.searchParams.set("state", p.state);
    if (req.body?.decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      return res.redirect(303, back.toString());
    }
    // The session cookie is sent only on Sphere's own pages (SameSite), so a
    // signed-in approval can't be triggered from another site.
    if (!deps.signedIn(req)) {
      if (tooManyFailures()) return approvalPage(res, client, p, false, "Too many wrong passwords. Try again in 15 minutes.");
      if (!deps.checkPassword(String(req.body?.password ?? ""))) {
        failures.push(Date.now());
        return approvalPage(res, client, p, false, "Wrong password.");
      }
    }
    const code = token();
    await db.query("DELETE FROM oauth_codes WHERE expires_at < NOW()");
    await db.query("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, expires_at) VALUES ($1, $2, $3, $4, $5)", [
      hash(code),
      client.id,
      p.redirect_uri,
      p.code_challenge,
      new Date(Date.now() + CODE_MS),
    ]);
    back.searchParams.set("code", code);
    res.redirect(303, back.toString());
  });

  app.post("/oauth/token", form, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, string>;
    const fail = (error: string, status = 400) => res.status(status).json({ error });
    // The app identifies itself in the body, or with Basic auth if it has a secret.
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const [id, sec] = Buffer.from(basic[1], "base64").toString().split(":");
      clientId = decodeURIComponent(id ?? "");
      secret = decodeURIComponent(sec ?? "");
    }
    const client = await getClient(clientId);
    if (!client) return fail("invalid_client", 401);
    if (client.secret_hash) {
      const given = Buffer.from(hash(String(secret ?? "")));
      if (!timingSafeEqual(given, Buffer.from(client.secret_hash))) return fail("invalid_client", 401);
    }

    if (body.grant_type === "authorization_code") {
      const { rows } = await db.query<{ client_id: string; redirect_uri: string; challenge: string; expires_at: string }>(
        "DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *",
        [hash(String(body.code ?? ""))],
      );
      const code = rows[0];
      if (!code || code.client_id !== client.id || new Date(code.expires_at).getTime() < Date.now()) return fail("invalid_grant");
      if (body.redirect_uri && body.redirect_uri !== code.redirect_uri) return fail("invalid_grant");
      const verifier = String(body.code_verifier ?? "");
      if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return fail("invalid_grant");
      return res.json(await issueTokens(client.id));
    }

    if (body.grant_type === "refresh_token") {
      // Each refresh token works once; a new pair replaces it.
      const { rows } = await db.query<{ id: number }>(
        "DELETE FROM oauth_tokens WHERE refresh_hash = $1 AND client_id = $2 AND refresh_expires > NOW() RETURNING id",
        [hash(String(body.refresh_token ?? "")), client.id],
      );
      if (!rows.length) return fail("invalid_grant");
      return res.json(await issueTokens(client.id));
    }

    fail("unsupported_grant_type");
  });

  // The connector itself (MCP over HTTP), one short-lived server per request.
  app.post("/mcp", async (req, res) => {
    const client = await bearerClient(req);
    if (!client) {
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"`)
        .json({ error: "invalid_token" });
      return;
    }
    const server = mcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ error: "Method not allowed." });
  };
  // Opened in a browser, the address explains itself instead of erroring.
  app.get("/mcp", (req, res) => {
    if (!req.accepts("html") || req.accepts(["text/event-stream", "html"]) === "text/event-stream") return notAllowed(req, res);
    page(
      res,
      200,
      `<h1>This is Sphere's connector address</h1>
<p>It isn't a page to open. Copy this address and paste it into the app instead:</p>
<p><b>${esc(`${base(req)}/mcp`)}</b></p>
<ul>
  <li><b>Claude:</b> Settings → Connectors → Add custom connector. Name it Sphere, paste the address and tap Connect.</li>
  <li><b>ChatGPT:</b> Settings → Apps &amp; Connectors → Advanced settings → turn on Developer mode, then create a connector with this address.</li>
</ul>
<p>The app then opens Sphere's approval page, where you enter your Sphere password.</p>`,
    );
  });
  app.delete("/mcp", notAllowed);
}
