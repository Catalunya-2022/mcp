import assert from "node:assert/strict";
import test from "node:test";
import { readResourceText, withMcpClient } from "./helpers/mcp-test-client.js";
import { readJsonFixture } from "./helpers/read-json-fixture.js";

const corpusSummary = readJsonFixture("./fixtures/corpus-summary.json", import.meta.url);
const toolOutputs = readJsonFixture("./fixtures/tool-outputs.json", import.meta.url);

test("server exposes fixed and templated resources", async () => {
  await withMcpClient(async (client) => {
    const response = await client.listResources();
    const uris = response.resources.map((resource) => resource.uri);

    assert.ok(uris.includes("document://catalunya2022/manifest"));
    assert.ok(uris.includes("document://catalunya2022/contributors"));
    assert.ok(uris.includes("document://catalunya2022/en/sphere-1/goal-2/action-2-1"));

    // Every entry needs a programmatic name AND a per-entry human title; an
    // entry that omits title inherits the template's generic "Document
    // sections", which is wrong for any single row.
    for (const resource of response.resources) {
      assert.ok(resource.name.length > 0, `missing name for ${resource.uri}`);
      assert.ok(resource.title?.length > 0, `missing title for ${resource.uri}`);
      assert.notEqual(resource.title, "Document sections", `template title leaked into ${resource.uri}`);
    }

    const section = response.resources.find(
      (resource) => resource.uri === "document://catalunya2022/en/sphere-1/goal-2/action-2-1",
    );
    assert.equal(section.name, "en/sphere-1/goal-2/action-2-1");
    assert.match(section.title, / \(en\)$/);

    const fullDocument = response.resources.find(
      (resource) => resource.uri === "document://catalunya2022/ca",
    );
    assert.equal(fullDocument.name, "ca");
    assert.match(fullDocument.title, /^Catalunya 2022 - RESET: .+ \(full document, ca\)$/);
    assert.match(fullDocument.description, /whole document as one markdown file/);

    // manifest + contributors + full document per locale + every section per locale
    const locales = corpusSummary.metadata.languages.length;
    const expectedCount = 2 + locales + corpusSummary.counts.sections * locales;
    assert.equal(expectedCount, 332);
    assert.equal(uris.length, expectedCount);
    assert.equal(new Set(uris).size, expectedCount, "listed URIs must be unique");
  });
});

test("manifest resource preserves metadata summary", async () => {
  await withMcpClient(async (client) => {
    const response = await client.readResource({
      uri: "document://catalunya2022/manifest",
    });
    const manifest = JSON.parse(readResourceText(response));

    assert.deepEqual(manifest.metadata, corpusSummary.metadata);
    assert.equal(manifest.hierarchy.length, 3);
  });
});

test("section resource preserves markdown output", async () => {
  await withMcpClient(async (client) => {
    const response = await client.readResource({
      uri: "document://catalunya2022/en/sphere-1/goal-2/action-2-1",
    });

    assert.equal(readResourceText(response), toolOutputs.getSectionAction21En.content[0].text);
  });
});

test("section resource rejects invalid and unknown references with proper protocol errors", async () => {
  await withMcpClient(async (client) => {
    // Pin the error CODES, not only the prose: a regression that degrades
    // protocol errors into success-with-error-text must fail here.
    await assert.rejects(
      client.readResource({ uri: "document://catalunya2022/xx/introduction" }),
      (error) => error.code === -32602 && /Invalid resource URI/.test(error.message),
    );

    await assert.rejects(
      client.readResource({ uri: "document://catalunya2022/ca/sphere-9" }),
      (error) => error.code === -32602 && /Resource not found/.test(error.message),
    );
  });
});

test("the section template offers ref completions", async () => {
  await withMcpClient(async (client) => {
    const templateRef = { type: "ref/resource", uri: "document://catalunya2022/{+ref}" };

    const locales = await client.complete({ ref: templateRef, argument: { name: "ref", value: "e" } });
    assert.ok(locales.completion.values.includes("en"));
    assert.ok(locales.completion.values.includes("es"));
    assert.ok(locales.completion.values.length <= 100);

    const partial = await client.complete({
      ref: templateRef,
      argument: { name: "ref", value: "en/sphere-1/g" },
    });
    assert.ok(partial.completion.values.includes("en/sphere-1/goal-1"));
    assert.ok(partial.completion.values.every((value) => value.startsWith("en/sphere-1/g")));
  });
});

test("resource misses suggest the repaired slug when one exists", async () => {
  await withMcpClient(async (client) => {
    await assert.rejects(
      client.readResource({ uri: "document://catalunya2022/ca/sphere-1/goal-1/action-2-1" }),
      (error) =>
        /Resource not found/.test(error.message) &&
        /Did you mean document:\/\/catalunya2022\/ca\/sphere-1\/goal-2\/action-2-1\?/.test(error.message),
    );
  });
});

test("every listed resource URI reads back with the declared shape", async () => {
  await withMcpClient(async (client) => {
    const { resources } = await client.listResources();

    for (const resource of resources) {
      const response = await client.readResource({ uri: resource.uri });
      const [contents] = response.contents;
      assert.equal(contents.uri, resource.uri, `URI must round-trip for ${resource.uri}`);
      assert.ok(contents.text.length > 0, `Empty contents for ${resource.uri}`);
      const expectedMime = /\/(manifest|contributors)$/.test(resource.uri)
        ? "application/json"
        : "text/markdown";
      assert.equal(contents.mimeType, expectedMime, `Wrong mimeType for ${resource.uri}`);
    }
  });
});

test("the whole document is readable as one markdown resource per locale", async () => {
  await withMcpClient(async (client) => {
    const listed = await client.listResources();
    const uris = listed.resources.map((resource) => resource.uri);
    for (const locale of ["ca", "en", "es"]) {
      assert.ok(uris.includes(`document://catalunya2022/${locale}`), `missing full doc ${locale}`);
    }

    const response = await client.readResource({ uri: "document://catalunya2022/en" });
    const text = readResourceText(response);
    assert.ok(text.startsWith("# Catalunya 2022 - RESET: Crida per reactivar el país"));
    assert.match(text, /\n## Introduction\n/);
    assert.match(text, /\n## SPHERE 1\n/);
    assert.match(text, /\n## ACTION 12\.5\n/);
    assert.match(text, /https:\/\/2022\.cat\/en\/sphere-3\/goal-12\/action-12-5/);
    assert.equal(response.contents[0].mimeType, "text/markdown");
  });
});

test("contributors resource preserves contributor count", async () => {
  await withMcpClient(async (client) => {
    const response = await client.readResource({
      uri: "document://catalunya2022/contributors",
    });
    const contributors = JSON.parse(readResourceText(response));

    assert.equal(contributors.length, corpusSummary.counts.contributors);
    assert.equal(contributors[0].slug, "victoria-alsina");
    assert.equal(contributors[0].photo, "https://2022.cat/team-photos/victoria-alsina.png");
    assert.ok(
      contributors.every((contributor) => contributor.photo.startsWith("https://2022.cat/team-photos/")),
      "Expected every contributor portrait to be a resolvable URL",
    );
  });
});
