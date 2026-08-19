import assert from "node:assert/strict";
import test from "node:test";
import { STATIC_SLUGS } from "../dist/data/constants.js";
import { buildExpectedSectionSlugs } from "../dist/data/types.js";
import { getCorpus } from "../dist/src/corpus.js";
import { readJsonFixture } from "./helpers/read-json-fixture.js";

const corpusSummary = readJsonFixture("./fixtures/corpus-summary.json", import.meta.url);
const expectedSlugs = readJsonFixture("./fixtures/expected-slugs.json", import.meta.url);

test("corpus summary matches the golden fixture", () => {
  const corpus = getCorpus();
  const summary = {
    metadata: corpus.metadata,
    counts: {
      sections: Object.keys(corpus.sections).length,
      contributors: corpus.contributors.length,
    },
    staticPages: [...STATIC_SLUGS],
  };

  assert.deepEqual(summary, corpusSummary);
});

test("generated expected slug set matches the fixture and corpus", () => {
  const corpusSlugs = Object.keys(getCorpus().sections);

  assert.deepEqual(buildExpectedSectionSlugs(), expectedSlugs);
  assert.deepEqual(corpusSlugs.sort(), [...expectedSlugs].sort());
});

test("every section includes all supported locales", () => {
  const corpus = getCorpus();

  for (const [slug, section] of Object.entries(corpus.sections)) {
    for (const locale of corpus.metadata.languages) {
      assert.ok(section.content[locale]?.title, `Missing title for ${slug} in ${locale}`);
      assert.ok(section.content[locale]?.identifier, `Missing identifier for ${slug} in ${locale}`);
      assert.ok(typeof section.content[locale]?.body === "string", `Missing body for ${slug} in ${locale}`);
    }
  }
});
