import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolResult, readToolText, withMcpClient } from "./helpers/mcp-test-client.js";
import { readJsonFixture } from "./helpers/read-json-fixture.js";

const corpusSummary = readJsonFixture("./fixtures/corpus-summary.json", import.meta.url);
const toolOutputs = readJsonFixture("./fixtures/tool-outputs.json", import.meta.url);
const expectedSlugs = readJsonFixture("./fixtures/expected-slugs.json", import.meta.url);

function collectMetadataSlugs(metadata) {
  const slugs = [...metadata.staticPages.map((page) => page.slug)];

  for (const sphere of metadata.hierarchy) {
    slugs.push(sphere.slug);

    for (const goal of sphere.goals) {
      slugs.push(goal.slug);

      for (const action of goal.actions) {
        slugs.push(action.slug);
      }
    }
  }

  return slugs;
}

test("server exposes the expected tool names", async () => {
  await withMcpClient(async (client) => {
    const response = await client.listTools();
    const toolNames = response.tools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      "get_document_metadata",
      "get_section",
      "list_proposals",
      "search_document",
    ]);
  });
});

test("every tool advertises a title and read-only annotations", async () => {
  // Annotations drive client auto-approval; losing them changes user-facing behavior.
  await withMcpClient(async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.title?.length > 0, `${tool.name} needs a title`);
      assert.deepEqual(
        tool.annotations,
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        `${tool.name} annotations drifted`,
      );
    }
  });
});

test("tools with an outputSchema return structuredContent mirroring the text block", async () => {
  // Modern-era clients consume structuredContent; dropping it would leave CI
  // green while breaking them, since the helpers only read the text block.
  await withMcpClient(async (client) => {
    const calls = [
      { name: "search_document", arguments: { query: "housing", locale: "en" } },
      { name: "get_document_metadata", arguments: { locale: "en" } },
      { name: "list_proposals", arguments: { locale: "en", goalId: 2 } },
    ];
    for (const call of calls) {
      const response = await client.callTool(call);
      assert.deepEqual(
        response.structuredContent,
        JSON.parse(readToolText(response)),
        `${call.name} structuredContent must mirror the text block`,
      );
    }
  });
});

test("search_document returns well-formed, relevant results", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "search_document",
      arguments: { query: "housing", locale: "en" },
    });
    const { results } = JSON.parse(readToolText(response));

    assert.ok(results.length >= 1 && results.length <= 10, "Expected 1-10 results");
    for (const result of results) {
      assert.ok(expectedSlugs.includes(result.slug), `Unknown slug: ${result.slug}`);
      assert.ok(["sphere", "goal", "action", "static"].includes(result.type));
      assert.ok(result.title.length > 0);
      assert.ok(result.snippet.length > 0);
      assert.ok(result.url.startsWith("https://2022.cat/en/"), `Unexpected URL: ${result.url}`);
      const highlightMarkers = result.snippet.split("**").length - 1;
      assert.equal(highlightMarkers % 2, 0, `Unbalanced highlight markers in: ${result.snippet}`);
    }
    const mentionsQuery = results.some((result) =>
      `${result.title} ${result.snippet}`.toLowerCase().includes("housing"),
    );
    assert.ok(mentionsQuery, "Expected at least one result to mention the query term");
  });
});

test("search_document filters by scope and explains empty results", async () => {
  await withMcpClient(async (client) => {
    const scopedResponse = await client.callTool({
      name: "search_document",
      arguments: { query: "housing", locale: "en", scope: "action" },
    });
    const scoped = JSON.parse(readToolText(scopedResponse));
    assert.ok(scoped.results.length >= 1, "Expected scoped results");
    assert.ok(scoped.results.every((result) => result.type === "action"));

    const emptyResponse = await client.callTool({
      name: "search_document",
      arguments: { query: "xyzzyplugh", locale: "en" },
    });
    const empty = JSON.parse(readToolText(emptyResponse));
    assert.equal(empty.results.length, 0);
    assert.match(empty.message, /No results found/);
  });
});

test("queries with only sub-length tokens get the minimum-length explanation", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "search_document",
      arguments: { query: "a 1 x", locale: "ca" },
    });
    const { results, message } = JSON.parse(readToolText(response));

    assert.equal(results.length, 0);
    assert.match(message, /at least 2 characters/);
    assert.doesNotMatch(message, /different locale/);
  });
});

test("already-quoted queries are not double-quoted in the empty-result message", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "search_document",
      arguments: { query: '"energia nuclear"', locale: "ca" },
    });
    const { results, message } = JSON.parse(readToolText(response));

    assert.equal(results.length, 0);
    assert.match(message, /No results found for "energia nuclear" in ca/);
    assert.ok(!message.includes('""'), "query must not be double-quoted");
  });
});

test("empty results name the locales where the query does match", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "search_document",
      arguments: { query: "housing", locale: "ca" },
    });
    const { results, message } = JSON.parse(readToolText(response));

    assert.equal(results.length, 0);
    assert.match(message, /No results found/);
    assert.match(message, /matches sections in: en/);
    assert.match(message, /Retry with locale "en"/);
  });
});

test("get_section suggests the corrected slug for wrong-parent mistakes", async () => {
  await withMcpClient(async (client) => {
    const wrongSphere = await client.callTool({
      name: "get_section",
      arguments: { slug: "sphere-1/goal-5/action-5-1", locale: "en" },
    });
    assert.equal(wrongSphere.isError, true);
    assert.match(readToolText(wrongSphere), /Did you mean 'sphere-2\/goal-5\/action-5-1'\?/);

    // The action id embeds its goal, so a wrong goal segment is repairable too.
    const wrongGoal = await client.callTool({
      name: "get_section",
      arguments: { slug: "sphere-1/goal-1/action-2-1", locale: "en" },
    });
    assert.equal(wrongGoal.isError, true);
    assert.match(readToolText(wrongGoal), /Did you mean 'sphere-1\/goal-2\/action-2-1'\?/);

    // Near-miss typos get an edit-distance suggestion.
    const typo = await client.callTool({
      name: "get_section",
      arguments: { slug: "executive-sumary", locale: "en" },
    });
    assert.equal(typo.isError, true);
    assert.match(readToolText(typo), /Did you mean 'executive-summary'\?/);
  });
});

test("get_section accepts the server's own localized URL segments", async () => {
  await withMcpClient(async (client) => {
    // The exact path segments the url fields emit must round-trip.
    const catalan = await client.callTool({
      name: "get_section",
      arguments: { slug: "ambit-1/objectiu-2", locale: "ca" },
    });
    assert.notEqual(catalan.isError, true);
    assert.ok(
      readToolText(catalan).startsWith("**Section:** sphere-1/goal-2"),
      "localized slug must resolve to the canonical section",
    );

    const spanish = await client.callTool({
      name: "get_section",
      arguments: { slug: "ambito-3/objetivo-10", locale: "es" },
    });
    assert.notEqual(spanish.isError, true);
    assert.ok(readToolText(spanish).startsWith("**Section:** sphere-3/goal-10"));
  });
});

test("get_section preserves markdown rendering for a representative action", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "get_section",
      arguments: { slug: "sphere-1/goal-2/action-2-1", locale: "en" },
    });

    assert.deepEqual(normalizeToolResult(response), toolOutputs.getSectionAction21En);
  });
});

test("get_section wires the requested locale through content and website URL", async () => {
  // The en rendering is golden-pinned; this pins the locale WIRING for the
  // default (ca) and es, where a mix-up would otherwise be invisible.
  await withMcpClient(async (client) => {
    const cases = [
      { locale: "ca", url: "https://2022.cat/ambit-1/objectiu-2/accio-2-1" },
      { locale: "es", url: "https://2022.cat/es/ambito-1/objetivo-2/accion-2-1" },
    ];
    for (const { locale, url } of cases) {
      const response = await client.callTool({
        name: "get_section",
        arguments: { slug: "sphere-1/goal-2/action-2-1", locale },
      });
      const text = readToolText(response);
      assert.ok(
        text.startsWith(`**Section:** sphere-1/goal-2/action-2-1 | **Website:** ${url}`),
        `Wrong ${locale} header: ${text.slice(0, 120)}`,
      );
    }
  });
});

test("get_section reports unknown slugs as errors with guidance", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "get_section",
      arguments: { slug: "sphere-9", locale: "en" },
    });

    assert.equal(response.isError, true);
    assert.match(readToolText(response), /Section not found: 'sphere-9'/);
    assert.match(readToolText(response), /get_document_metadata/);
  });
});

test("list_proposals filters by goal and validates sphere membership", async () => {
  await withMcpClient(async (client) => {
    const goalResponse = await client.callTool({
      name: "list_proposals",
      arguments: { locale: "en", goalId: 2 },
    });
    const { proposals } = JSON.parse(readToolText(goalResponse));

    assert.deepEqual(
      proposals.map((proposal) => proposal.actionId),
      ["2-1", "2-2", "2-3", "2-4", "2-5", "2-6"],
    );
    for (const proposal of proposals) {
      assert.equal(proposal.goalId, 2);
      assert.equal(proposal.sphereId, 1);
      assert.equal(proposal.slug, `sphere-1/goal-2/action-${proposal.actionId}`);
      assert.ok(proposal.title.length > 0);
      assert.ok(proposal.url.startsWith("https://2022.cat/en/sphere-1/goal-2/"));
    }

    const invalidResponse = await client.callTool({
      name: "list_proposals",
      arguments: { locale: "en", sphereId: 1, goalId: 5 },
    });
    assert.deepEqual(normalizeToolResult(invalidResponse), toolOutputs.listProposalsInvalid);
  });
});

test("list_proposals covers all 91 actions unfiltered and 31 for sphere 1", async () => {
  await withMcpClient(async (client) => {
    const allResponse = await client.callTool({
      name: "list_proposals",
      arguments: { locale: "en" },
    });
    const { proposals: all, count } = JSON.parse(readToolText(allResponse));
    assert.equal(count, 91);
    assert.equal(all.length, 91);
    assert.equal(all[0].actionId, "1-1");
    assert.equal(all.at(-1).actionId, "12-5");

    const sphereResponse = await client.callTool({
      name: "list_proposals",
      arguments: { locale: "en", sphereId: 1 },
    });
    const { proposals: sphere } = JSON.parse(readToolText(sphereResponse));
    assert.equal(sphere.length, 31);
    assert.ok(sphere.every((proposal) => proposal.sphereId === 1));
  });
});

test("locale defaults to Catalan when omitted", async () => {
  await withMcpClient(async (client) => {
    const defaulted = await client.callTool({
      name: "get_document_metadata",
      arguments: {},
    });
    const explicit = await client.callTool({
      name: "get_document_metadata",
      arguments: { locale: "ca" },
    });

    assert.deepEqual(JSON.parse(readToolText(defaulted)), JSON.parse(readToolText(explicit)));
  });
});

test("get_document_metadata preserves hierarchy, counts, and slug coverage", async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({
      name: "get_document_metadata",
      arguments: { locale: "en" },
    });
    const metadata = JSON.parse(readToolText(response));

    assert.deepEqual(metadata.structure, corpusSummary.metadata.structure);
    assert.equal(metadata.contributors.count, corpusSummary.counts.contributors);
    assert.equal(metadata.hierarchy.length, 3);
    assert.deepEqual(collectMetadataSlugs(metadata).sort(), [...expectedSlugs].sort());
  });
});
