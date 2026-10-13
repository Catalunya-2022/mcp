import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { createMcpHandler, LATEST_PROTOCOL_VERSION, type McpServer } from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DOCUMENT_TITLE } from "../data/constants.js";
import { getCorpus } from "./corpus.js";
import {
  DOCS_URL,
  MCP_ENDPOINT_URL,
  REGISTRY_NAME,
  SERVER_DESCRIPTION,
  SERVER_ICONS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./identity.js";
import { getProjectRoot } from "./paths.js";
import { type RateLimitOptions, rateLimit } from "./rate-limit.js";
import { createMcpServer } from "./server.js";

type McpServerFactory = () => McpServer;

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;
const MAX_BODY_BYTES = 100 * 1024;

/** Methods the MCP endpoint (/) actually supports; advertised on every 405. */
const ENDPOINT_ALLOW = "GET, POST, DELETE, OPTIONS";

/** What the Streamable HTTP transport requires a POST to accept. */
const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * RSS ceiling before /health reports "degraded". Memory bands: V8's old space
 * is capped at 80 MB (ecosystem node_args), so GC pressure keeps RSS
 * plateauing under ~140 MB; above 150 MB something is genuinely wrong,
 * and PM2 recycles the process on RSS at 180 MB (max_memory_restart).
 */
const RSS_DEGRADED_MB = 150;

/**
 * When this process started. The deploy gate compares it with the moment the
 * reload began: version and contentHash cannot tell a fresh process from a
 * stale one when a release changes neither.
 */
const PROCESS_STARTED_AT = new Date(performance.timeOrigin).toISOString();

/** Hostnames this server answers for; anything else gets 421 (DNS-rebinding guard). */
const DEFAULT_ALLOWED_HOSTNAMES = [new URL(MCP_ENDPOINT_URL).hostname, "localhost", "127.0.0.1", "[::1]"];

// Discovery documents mirrored from 2022.cat/.well-known so clients that only
// know this host can resolve them: server card + RFC 9727 API catalog. The
// card is the ecosystem's hybrid shape: top-level name/version/description
// where registry-shaped and ora-style scanners require them (they flag the
// nested-only spelling as "missing fields"), serverUrl + remotes for endpoint
// discovery, and the serverInfo/transport/capabilities block kept intact —
// that is the Smithery-documented shape and its metadata-scan fallback.
const SERVER_CARD = {
  name: REGISTRY_NAME,
  title: DOCUMENT_TITLE,
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  websiteUrl: DOCS_URL,
  serverUrl: MCP_ENDPOINT_URL,
  protocolVersion: LATEST_PROTOCOL_VERSION,
  repository: { url: "https://github.com/catalunya-2022/mcp", source: "github" },
  icons: SERVER_ICONS,
  remotes: [{ type: "streamable-http", url: MCP_ENDPOINT_URL }],
  serverInfo: {
    name: SERVER_NAME,
    title: DOCUMENT_TITLE,
    version: SERVER_VERSION,
  },
  transport: {
    type: "streamable-http",
    url: MCP_ENDPOINT_URL,
  },
  capabilities: {
    tools: {},
    resources: {},
    prompts: {},
    completions: {},
  },
} as const;

const API_CATALOG = {
  linkset: [
    {
      anchor: MCP_ENDPOINT_URL,
      "service-doc": [{ href: DOCS_URL, type: "text/html" }],
      "service-meta": [
        {
          href: `${MCP_ENDPOINT_URL}/.well-known/mcp/server-card.json`,
          type: "application/json",
        },
      ],
    },
  ],
} as const;

/** Glama connectors-track claim file; the email must match a Glama account of the maintainer. */
const GLAMA_CONNECTOR = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  maintainers: [{ email: "info@2022.cat" }],
} as const;

/** Default policy: nothing this server returns needs to load or run anything. */
const CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

// The landing page's one stylesheet, admitted by hash: under the default
// policy an inline style attribute is blocked and the page renders unstyled.
const LANDING_STYLE =
  "body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }";
const LANDING_STYLE_HASH = createHash("sha256").update(LANDING_STYLE).digest("base64");
const LANDING_CONTENT_SECURITY_POLICY = `default-src 'none'; style-src 'sha256-${LANDING_STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'`;

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${SERVER_NAME} MCP server</title><style>${LANDING_STYLE}</style></head>
<body>
<h1>Catalunya 2022 MCP server</h1>
<p>This is a Model Context Protocol endpoint, not a website. Point an MCP client at
<code>${MCP_ENDPOINT_URL}/</code> (Streamable HTTP, no authentication).</p>
<p>Documentation and client setup: <a href="${DOCS_URL}">2022.cat/mcp</a></p>
</body>
</html>
`;

// Crawling stays open for everyone: search engines must be able to fetch the
// pages to see the X-Robots-Tag noindex that delists them (a Disallow would
// leave Google showing the bare URL forever), and AI assistants and their
// crawlers are welcome to read everything here.
const ROBOTS_TXT = `# ${MCP_ENDPOINT_URL} is a Model Context Protocol endpoint, not a website.
# Human-facing documentation lives at ${DOCS_URL} (index that instead).
# Search listing is declined via X-Robots-Tag: noindex on every response;
# crawling is open so that directive can be seen, and AI assistants and
# their crawlers may fetch everything.
User-agent: *
Allow: /
`;

const ICON_SVG = fs.readFileSync(path.join(getProjectRoot(), "assets", "icon.svg"));
const ICON_PNG = fs.readFileSync(path.join(getProjectRoot(), "assets", "icon.png"));

/**
 * CORS and security headers shared by every response. The allow list covers
 * every non-safelisted header the reference MCP client sends in either era
 * (session and resume headers included, although the stateless posture never
 * issues them); the expose list covers what a browser client needs to read.
 */
function setSharedHeaders(c: Context): void {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", ENDPOINT_ALLOW);
  c.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Mcp-Method, Mcp-Name, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  );
  c.header("Access-Control-Expose-Headers", "MCP-Protocol-Version, RateLimit, Retry-After");
  c.header("Access-Control-Max-Age", String(ONE_DAY_SECONDS));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  // A route that needs more than the default policy (the landing page) sets
  // its own; every other response gets the default.
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
  // Keep this host out of search results (the searchable face is DOCS_URL);
  // noindex only governs search listings, so AI crawlers still read freely.
  c.header("X-Robots-Tag", "noindex");
}

type AppOptions = {
  /** Override the per-IP rate limit — used by tests to exercise the 429 path with a tiny budget. */
  rateLimit?: RateLimitOptions;
};

/**
 * One bare tools/list against the same handler the endpoint serves, so the
 * card's static tools[] is the live wire shape and can never drift from
 * tools.ts. Ora-style scanners award full credit only when the card carries
 * the definitions statically instead of a "connect and list" indirection.
 */
async function fetchToolList(mcp: { fetch: (request: Request) => Promise<Response> }): Promise<unknown[]> {
  const response = await mcp.fetch(
    new Request(`${MCP_ENDPOINT_URL}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    }),
  );
  if (!response.ok) {
    throw new Error(`tools/list returned ${response.status}`);
  }
  // Stateless responses may arrive as a single-event SSE stream.
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "null",
      )
    : JSON.parse(text);
  const tools: unknown = payload?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("tools/list returned no tools");
  }
  return tools;
}

// A request with no Accept header, or one listing only */* (the default of
// fetch, Python requests and aiohttp), accepts both media types the transport
// needs, so spell them out instead of letting the SDK answer 406. Narrower
// headers pass through untouched: a JSON-only client still gets 406, since
// the legacy era can only answer with an event stream.
function withExplicitAccept(request: Request): Request {
  const accept = request.headers.get("accept")?.trim();
  const wildcardOnly = !accept || accept.split(",").every((range) => range.split(";")[0].trim() === "*/*");
  if (!wildcardOnly) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("Accept", MCP_ACCEPT);
  return new Request(request, { headers });
}

export function createApp(serverFactory: McpServerFactory = createMcpServer, options: AppOptions = {}) {
  const app = new Hono();
  // Both protocol eras from one factory: modern (2026-07-28) natively, and
  // 2025-era clients through the SDK's stateless legacy posture — the default,
  // kept deliberately: ChatGPT, VS Code, Cursor, and the Claude API connector
  // still speak the legacy era today, and rejecting them saves no code.
  const mcp = createMcpHandler(() => serverFactory(), { legacy: "stateless" });

  // Applied AFTER the downstream handler resolves: Hono only merges headers set
  // before next() into context-built responses, so headers set there would
  // silently vanish from the Responses the MCP handler returns on POST /.
  app.use("*", async (c, next) => {
    await next();
    setSharedHeaders(c);
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    // DNS-rebinding guard: only answer for hostnames we actually serve. A
    // missing Host header passes: rebinding needs a browser, which always
    // sends one, and requiring it would break bare test-harness requests.
    const host = c.req.header("host");
    if (host) {
      let hostname: string;
      try {
        hostname = new URL(`http://${host}`).hostname;
      } catch {
        return c.json({ error: "Invalid Host header" }, 400);
      }
      // A trailing dot is the absolute-FQDN spelling of the same host.
      if (!DEFAULT_ALLOWED_HOSTNAMES.includes(hostname.replace(/\.$/, ""))) {
        return c.json({ error: "Misdirected request" }, 421);
      }
    }

    await next();
  });

  app.use("*", rateLimit(options.rateLimit));

  app.get("/health", (c) => {
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    return c.json({
      status: rssMB > RSS_DEGRADED_MB ? "degraded" : "ok",
      rssMB,
      // Effective V8 ceiling — proves whether the ecosystem node_args heap
      // budget is live on the running process (~92 with it, ~493 without).
      heapLimitMB: Math.round(getHeapStatistics().heap_size_limit / 1024 / 1024),
      version: SERVER_VERSION,
      contentHash: getCorpus().contentHash,
      startedAt: PROCESS_STARTED_AT,
    });
  });

  // Built on first request and cached for the process lifetime (the tool set
  // is frozen once registered); a failed build is not cached, so a transient
  // error degrades to the tool-less card and the next request retries.
  let cardPromise: Promise<Record<string, unknown>> | undefined;

  app.get("/.well-known/mcp/server-card.json", async (c) => {
    c.header("Cache-Control", `public, max-age=${ONE_DAY_SECONDS}`);
    cardPromise ??= fetchToolList(mcp).then((tools) => ({ ...SERVER_CARD, tools }));
    try {
      return c.json(await cardPromise);
    } catch (error) {
      console.error("server card tools/list failed; serving the card without tools[]", error);
      cardPromise = undefined;
      return c.json(SERVER_CARD);
    }
  });

  app.get("/.well-known/api-catalog", (c) => {
    c.header("Cache-Control", `public, max-age=${ONE_DAY_SECONDS}`);
    c.header("Content-Type", "application/linkset+json");
    return c.body(JSON.stringify(API_CATALOG));
  });

  app.get("/.well-known/glama.json", (c) => {
    c.header("Cache-Control", `public, max-age=${ONE_DAY_SECONDS}`);
    return c.json(GLAMA_CONNECTOR);
  });

  app.get("/robots.txt", (c) => {
    c.header("Cache-Control", `public, max-age=${ONE_DAY_SECONDS}`);
    return c.text(ROBOTS_TXT);
  });

  app.get("/icon.svg", (c) => {
    c.header("Cache-Control", `public, max-age=${ONE_WEEK_SECONDS}`);
    c.header("Content-Type", "image/svg+xml");
    return c.body(ICON_SVG);
  });

  app.get("/icon.png", (c) => {
    c.header("Cache-Control", `public, max-age=${ONE_WEEK_SECONDS}`);
    c.header("Content-Type", "image/png");
    return c.body(ICON_PNG);
  });

  app.post(
    "/",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    (c) => mcp.fetch(withExplicitAccept(c.req.raw)),
  );

  // Legacy-era session DELETE: the stateless posture answers it (405 per spec,
  // which requires an Allow header the SDK response omits).
  app.delete("/", async (c) => {
    const response = await mcp.fetch(c.req.raw);
    if (response.status === 405) {
      response.headers.set("Allow", ENDPOINT_ALLOW);
    }
    return response;
  });

  app.get("/", (c) => {
    // The response varies on Accept, and both branches are cacheable.
    c.header("Vary", "Accept");

    // No server-initiated stream exists on this endpoint in either era: the
    // legacy stateless posture has no standalone SSE stream, and the modern
    // era replaced the GET stream with subscriptions/listen over POST. The
    // MCP spec prescribes 405 for a GET the server offers no stream for.
    if (c.req.header("accept")?.includes("text/event-stream")) {
      c.header("Allow", ENDPOINT_ALLOW);
      return c.json({ error: "Method not allowed" }, 405);
    }

    // Humans land here from directory listings; serve a page on THIS host
    // instead of redirecting cross-host, which some clients treated as the
    // MCP endpoint moving.
    c.header("Cache-Control", `public, max-age=${ONE_DAY_SECONDS}`);
    c.header("Content-Security-Policy", LANDING_CONTENT_SECURITY_POLICY);
    return c.html(LANDING_HTML);
  });

  app.on(["PUT", "PATCH"], "/", (c) => {
    c.header("Allow", ENDPOINT_ALLOW);
    return c.json({ error: "Method not allowed" }, 405);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return { app, close: () => mcp.close() };
}
