import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createApp } from "../dist/src/app.js";
import { getCorpus } from "../dist/src/corpus.js";
import { SERVER_VERSION } from "../dist/src/identity.js";

/**
 * Run a test body against a fresh app, always closing the MCP handler —
 * leaked handlers are how `node --test` hangs surface after an SDK bump.
 */
async function withApp(run, serverFactory, options) {
  const { app, close } = createApp(serverFactory, options);
  try {
    return await run(app);
  } finally {
    await close();
  }
}

/** Stateless MCP responses may arrive as a single-event SSE stream; extract the JSON payload. */
async function readRpcJson(response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine, "Expected an SSE data line in the response body");
    return JSON.parse(dataLine.slice("data: ".length));
  }
  return JSON.parse(text);
}

function rpcRequest(body) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  };
}

test("root GET serves a landing page on this host, never a cross-host redirect", async () => {
  await withApp(async (app) => {
    const response = await app.request("/");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /2022\.cat\/mcp/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
    assert.equal(response.headers.get("vary"), "Accept");
  });
});

test("the landing page's stylesheet is admitted by its CSP hash, nothing else is", async () => {
  await withApp(async (app) => {
    const response = await app.request("/");
    const html = await response.text();

    // The default policy blocks inline style attributes, so the styling must
    // live in a <style> block whose exact hash the page's own policy allows.
    assert.doesNotMatch(html, /\sstyle="/);
    const style = html.match(/<style>([^<]*)<\/style>/)?.[1];
    assert.ok(style, "Expected the landing page to carry a <style> block");
    const styleHash = createHash("sha256").update(style).digest("base64");
    assert.equal(
      response.headers.get("content-security-policy"),
      `default-src 'none'; style-src 'sha256-${styleHash}'; frame-ancestors 'none'; base-uri 'none'`,
    );
  });
});

test("robots.txt keeps crawling open while noindex keeps the host out of search listings", async () => {
  // Search delisting works ONLY because crawling stays open: a Disallow would
  // hide the noindex from Google and leave the bare URL listed forever.
  await withApp(async (app) => {
    const response = await app.request("/robots.txt");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    const body = await response.text();
    assert.match(body, /User-agent: \*\nAllow: \/\n/);
    assert.doesNotMatch(body, /Disallow/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
  });
});

test("GET with an SSE accept header returns 405: no standalone stream in either era", async () => {
  await withApp(async (app) => {
    const response = await app.request("/", { headers: { Accept: "text/event-stream" } });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST, DELETE, OPTIONS");
    assert.equal(response.headers.get("vary"), "Accept");
  });
});

test("DELETE returns 405 with an Allow header (stateless posture, RFC 9110)", async () => {
  await withApp(async (app) => {
    const response = await app.request("/", { method: "DELETE" });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST, DELETE, OPTIONS");
  });
});

test("PUT and PATCH on the endpoint return 405 with Allow", async () => {
  await withApp(async (app) => {
    for (const method of ["PUT", "PATCH"]) {
      const response = await app.request("/", { method });
      assert.equal(response.status, 405, `${method} should be 405`);
      assert.equal(response.headers.get("allow"), "GET, POST, DELETE, OPTIONS");
    }
  });
});

test("the Host guard refuses foreign hosts and accepts every spelling of our own", async () => {
  await withApp(async (app) => {
    const refused = await app.request("/health", { headers: { Host: "evil.example" } });
    assert.equal(refused.status, 421);

    // Allowed spellings: plain, with port, absolute-FQDN trailing dot.
    for (const host of ["mcp.2022.cat", "mcp.2022.cat:3001", "mcp.2022.cat."]) {
      const allowed = await app.request("/health", { headers: { Host: host } });
      assert.equal(allowed.status, 200, `Host "${host}" should be allowed`);
    }

    const malformed = await app.request("/health", { headers: { Host: "bad host" } });
    assert.equal(malformed.status, 400);
  });
});

test("malformed JSON bodies return a client error, not a 500", async () => {
  await withApp(async (app) => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{not json",
    });

    assert.ok(response.status >= 400 && response.status < 500, `Got ${response.status}`);
  });
});

test("bodies over the 100kb limit return 413", async () => {
  await withApp(async (app) => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(150_000) }),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Payload too large" });
  });
});

test("health route reports status, rss, version, and the exact content build", async () => {
  await withApp(async (app) => {
    const response = await app.request("/health");

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(["ok", "degraded"].includes(body.status));
    assert.equal(typeof body.rssMB, "number");
    assert.equal(typeof body.heapLimitMB, "number");
    assert.equal(body.version, SERVER_VERSION);
    assert.equal(body.contentHash, getCorpus().contentHash);
  });
});

test("OPTIONS requests return CORS and security headers including Mcp-* allowances", async () => {
  await withApp(async (app) => {
    const response = await app.request("/", { method: "OPTIONS" });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /Mcp-Method/);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /MCP-Protocol-Version/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });
});

test("well-known server card carries top-level identity plus the Smithery serverInfo block", async () => {
  await withApp(async (app) => {
    const response = await app.request("/.well-known/mcp/server-card.json");

    assert.equal(response.status, 200);
    const card = await response.json();
    // Top-level name/version are what registry-shaped and ora-style scanners
    // validate; the nested-only spelling gets flagged as "missing fields".
    assert.equal(card.name, "cat.2022/catalunya-2022");
    assert.equal(card.version, SERVER_VERSION);
    assert.equal(card.title, "Catalunya 2022 - RESET: Crida per reactivar el país");
    assert.equal(card.serverUrl, "https://mcp.2022.cat");
    assert.equal(card.remotes[0].type, "streamable-http");
    assert.equal(card.remotes[0].url, "https://mcp.2022.cat");
    assert.ok(card.icons.length >= 2, "Expected the shared icon set on the card");
    // tools[] is generated from the live registrations via a real tools/list,
    // so this pins both its presence and that it cannot drift from tools.ts.
    assert.deepEqual(card.tools.map((tool) => tool.name).sort(), [
      "get_document_metadata",
      "get_section",
      "list_proposals",
      "search_document",
    ]);
    for (const tool of card.tools) {
      assert.ok(tool.title, `${tool.name} must carry its title`);
      assert.ok(tool.description, `${tool.name} must carry its description`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} must carry its input schema`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must stay read-only annotated`);
    }
    // The Smithery-documented block must survive the hybrid shape.
    assert.equal(card.serverInfo.name, "catalunya-2022");
    assert.equal(card.serverInfo.title, "Catalunya 2022 - RESET: Crida per reactivar el país");
    assert.equal(card.serverInfo.version, SERVER_VERSION);
    assert.equal(card.transport.url, "https://mcp.2022.cat");
  });
});

test("well-known api catalog links the server card on this host", async () => {
  await withApp(async (app) => {
    const response = await app.request("/.well-known/api-catalog");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/linkset\+json/);
    const catalog = await response.json();
    assert.equal(catalog.linkset[0].anchor, "https://mcp.2022.cat");
    assert.equal(
      catalog.linkset[0]["service-meta"][0].href,
      "https://mcp.2022.cat/.well-known/mcp/server-card.json",
    );
  });
});

test("well-known glama.json declares the connector maintainers", async () => {
  await withApp(async (app) => {
    const response = await app.request("/.well-known/glama.json");

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.$schema, "https://glama.ai/mcp/schemas/connector.json");
    assert.ok(Array.isArray(body.maintainers) && body.maintainers[0].email.includes("@"));
  });
});

test("icons are served from this host with long-lived caching", async () => {
  await withApp(async (app) => {
    const svg = await app.request("/icon.svg");
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);

    const png = await app.request("/icon.png");
    assert.equal(png.status, 200);
    assert.match(png.headers.get("content-type") ?? "", /image\/png/);
    assert.match(png.headers.get("cache-control") ?? "", /max-age=604800/);
  });
});

test("unknown routes return a JSON 404 response", async () => {
  await withApp(async (app) => {
    const response = await app.request("/missing");

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  });
});

test("a legacy initialize round-trips through the stateless posture", async () => {
  await withApp(async (app) => {
    const response = await app.request(
      "/",
      rpcRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "era-test", version: "0.0.0" },
        },
      }),
    );

    assert.equal(response.status, 200);
    const payload = await readRpcJson(response);
    assert.equal(payload.result.serverInfo.name, "catalunya-2022");
    assert.equal(payload.result.serverInfo.version, SERVER_VERSION);

    // Advertised icons must resolve on this same app with the declared type
    // (VS Code's same-authority rule is the reason /icon.* exists at all).
    for (const icon of payload.result.serverInfo.icons) {
      const iconResponse = await app.request(new URL(icon.src).pathname);
      assert.equal(iconResponse.status, 200, `${icon.src} must resolve on this host`);
      assert.ok(
        (iconResponse.headers.get("content-type") ?? "").startsWith(icon.mimeType),
        `${icon.src} must serve ${icon.mimeType}`,
      );
    }
  });
});

test("a bare legacy tools/call round-trips over HTTP", async () => {
  await withApp(async (app) => {
    const response = await app.request(
      "/",
      rpcRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_section", arguments: { slug: "introduction", locale: "ca" } },
      }),
    );

    assert.equal(response.status, 200);
    const payload = await readRpcJson(response);
    assert.equal(payload.id, 7);
    assert.ok(
      payload.result.content[0].text.startsWith("**Section:** introduction"),
      "Expected the section markdown rendered through the real handler",
    );
  });
});

test("a bare prompts/get without arguments falls back to the defaults", async () => {
  await withApp(async (app) => {
    const response = await app.request(
      "/",
      rpcRequest({ jsonrpc: "2.0", id: 8, method: "prompts/get", params: { name: "explore-document" } }),
    );

    assert.equal(response.status, 200);
    const payload = await readRpcJson(response);
    assert.equal(payload.error, undefined, JSON.stringify(payload.error));
    assert.match(payload.result.messages[0].content.text, /locale="ca"/);
  });
});

test("a server factory failure surfaces as a 500, not a hung request", async () => {
  await withApp(
    async (app) => {
      const response = await app.request("/", rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      assert.equal(response.status, 500);
    },
    () => {
      throw new Error("factory exploded");
    },
  );
});

test("requests beyond the rate limit receive 429 with well-formed draft-7 headers", async () => {
  await withApp(
    async (app) => {
      assert.equal((await app.request("/health")).status, 200);
      assert.equal((await app.request("/health")).status, 200);
      const limited = await app.request("/health");

      assert.equal(limited.status, 429);
      assert.match(limited.headers.get("ratelimit") ?? "", /^limit=2, remaining=0, reset=\d+$/);
      assert.equal(limited.headers.get("ratelimit-policy"), "2;w=60");
      assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
    },
    undefined,
    { rateLimit: { limit: 2 } },
  );
});

test("CORS and security headers are present on normal responses, not just OPTIONS", async () => {
  await withApp(async (app) => {
    const response = await app.request("/health");

    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(
      response.headers.get("content-security-policy"),
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  });
});

test("CORS, security, and rate-limit headers reach MCP endpoint responses too", async () => {
  // The MCP handler returns its own Response objects, which bypass headers
  // set before next() — a browser client would pass preflight and then have
  // the actual POST blocked. Pin that the shared headers survive that path.
  await withApp(async (app) => {
    const response = await app.request("/", rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("ratelimit"), "Expected draft-7 RateLimit header on the MCP endpoint");
  });
});
