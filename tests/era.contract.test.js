import assert from "node:assert/strict";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../dist/src/app.js";
import { SERVER_VERSION } from "../dist/src/identity.js";

/** Serve the real app on an ephemeral port and run against it with the real v2 client. */
async function withHttpServer(run) {
  const { app, close } = createApp();
  const httpServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const { port } = httpServer.address();
  const url = new URL(`http://127.0.0.1:${port}/`);

  try {
    return await run(url);
  } finally {
    await Promise.resolve(close());
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

async function withConnectedClient(url, clientOptions, run) {
  const client = new Client({ name: "era-tests", version: "1.0.0" }, clientOptions);
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

test("a modern-era client connects via server/discover and reads full serverInfo", async () => {
  await withHttpServer(async (url) => {
    await withConnectedClient(url, { versionNegotiation: { mode: "auto" } }, async (client) => {
      assert.equal(client.getProtocolEra(), "modern");

      const instructions = client.getInstructions();
      assert.match(instructions ?? "", /Catalunya 2022 - RESET/);
      assert.match(instructions ?? "", /get_document_metadata/);

      // The instructions state the document's shape in prose; keep that
      // honest against the computed structure.
      const metadata = await client.callTool({ name: "get_document_metadata", arguments: {} });
      const { structure } = metadata.structuredContent;
      assert.match(instructions ?? "", new RegExp(`${structure.actions} accions`));
      assert.match(instructions ?? "", new RegExp(`${structure.actions} actions`));
      assert.match(instructions ?? "", new RegExp(`${structure.goals} objectius`));

      const { tools } = await client.listTools();
      const search = tools.find((tool) => tool.name === "search_document");
      assert.equal(search.title, "Search the document");
      assert.ok(search.outputSchema, "search_document should advertise an output schema");

      const result = await client.callTool({
        name: "search_document",
        arguments: { query: "cultura", locale: "ca" },
      });
      assert.ok(result.structuredContent?.results?.length > 0, "Expected structuredContent");
      const links = result.content.filter((block) => block.type === "resource_link");
      assert.equal(links.length, result.structuredContent.results.length);
      assert.match(links[0].uri, /^document:\/\/catalunya2022\/ca\//);
    });
  });
});

test("a legacy-era client still connects through the stateless posture", async () => {
  await withHttpServer(async (url) => {
    await withConnectedClient(url, { capabilities: {} }, async (client) => {
      assert.equal(client.getProtocolEra(), "legacy");

      const metadata = await client.callTool({
        name: "get_document_metadata",
        arguments: { locale: "en" },
      });
      const parsed = JSON.parse(metadata.content[0].text);
      assert.equal(parsed.structure.actions, 91);
      assert.equal(parsed.citation.doi, "10.5281/zenodo.19500831");
    });
  });
});

test("both eras see the same tool surface and version", async () => {
  await withHttpServer(async (url) => {
    const names = [];
    for (const options of [{ versionNegotiation: { mode: "auto" } }, { capabilities: {} }]) {
      await withConnectedClient(url, options, async (client) => {
        const { tools } = await client.listTools();
        names.push(
          tools
            .map((tool) => tool.name)
            .sort()
            .join(","),
        );
      });
    }
    assert.equal(names[0], names[1]);
    assert.equal(names[0], "get_document_metadata,get_section,list_proposals,search_document");
    assert.match(SERVER_VERSION, /^2\./, "the rewrite ships as 2.x");
  });
});
