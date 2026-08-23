import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  absolutifyLinks,
  assertExpectedSectionSlugs,
  assertLocaleCoverage,
  buildCorpus,
  deriveMetadata,
  filePathToSlug,
  parseMdx,
  serializeCorpus,
} from "../dist/scripts/build-corpus-lib.js";

test("filePathToSlug preserves canonical slug generation", () => {
  assert.equal(filePathToSlug("introduction.mdx"), "introduction");
  assert.equal(filePathToSlug("sphere1/goal2/action-2-1.mdx"), "sphere-1/goal-2/action-2-1");
  assert.equal(filePathToSlug("sphere1/sphere1.mdx"), "sphere-1");
});

test("deriveMetadata preserves section typing", () => {
  assert.deepEqual(deriveMetadata("executive-summary"), { type: "static" });
  assert.deepEqual(deriveMetadata("sphere-2"), { type: "sphere", sphereId: 2 });
  assert.deepEqual(deriveMetadata("sphere-2/goal-6"), {
    type: "goal",
    sphereId: 2,
    goalId: 6,
  });
  assert.deepEqual(deriveMetadata("sphere-2/goal-6/action-6-4"), {
    type: "action",
    sphereId: 2,
    goalId: 6,
    actionId: "6-4",
  });
});

test("absolutifyLinks localizes internal links, passes assets through, rejects unknown pages", () => {
  assert.equal(
    absolutifyLinks("[Task Force](/task-force/elies-campo)", "es", "es/example.mdx"),
    "[Task Force](https://2022.cat/es/grupo-de-trabajo/elies-campo)",
  );
  // A real website asset: must pass through WITHOUT a locale prefix
  // (/es/documents/... would 404).
  assert.equal(
    absolutifyLinks("[PDF](/documents/catalunya-2022-es.pdf)", "es", "es/example.mdx"),
    "[PDF](https://2022.cat/documents/catalunya-2022-es.pdf)",
  );
  assert.throws(
    () => absolutifyLinks("[x](/unknown-page)", "es", "es/example.mdx"),
    /Unlocalizable internal link "\/unknown-page" in es\/example\.mdx/,
  );
});

test("rebuilding the corpus reproduces the generated artifact byte for byte", () => {
  const builtCorpusJson = serializeCorpus(buildCorpus());
  const committedCorpusJson = fs.readFileSync(new URL("../data/corpus.json", import.meta.url), "utf-8");

  assert.equal(builtCorpusJson, committedCorpusJson);
});

test("parseMdx accepts the canonical section shape and rejects malformed input", () => {
  const parsed = parseMdx("# 1.2\n\n## A Title\n\nBody text.", "en", "en/example.mdx");
  assert.deepEqual(parsed, { identifier: "1.2", title: "A Title", body: "Body text." });

  assert.throws(
    () => parseMdx("## Title without identifier\n\nBody.", "en", "en/broken.mdx"),
    /Invalid section structure in en\/broken\.mdx/,
  );
  assert.throws(
    () => parseMdx("# 1.2\nStray text between headings\n## Title\n\nBody.", "en", "en/broken.mdx"),
    /Unexpected content between H1 and H2 in en\/broken\.mdx/,
  );
  assert.throws(
    () => parseMdx("#  \n\n## Title\n\nBody.", "en", "en/broken.mdx"),
    /Missing identifier or title in en\/broken\.mdx/,
  );
});

test("corpus validators reject drift from the frozen contract", () => {
  const validSections = buildCorpus().sections;

  const missingOne = { ...validSections };
  delete missingOne.introduction;
  assert.throws(() => assertExpectedSectionSlugs(missingOne), /Missing: \[introduction\]/);

  const extraOne = {
    ...validSections,
    "sphere-9": { slug: "sphere-9", type: "sphere", sphereId: 9, content: {} },
  };
  assert.throws(() => assertExpectedSectionSlugs(extraOne), /Extra: \[sphere-9\]/);

  const blankTitle = {
    ...validSections,
    introduction: {
      ...validSections.introduction,
      content: {
        ...validSections.introduction.content,
        es: { ...validSections.introduction.content.es, title: "" },
      },
    },
  };
  assert.throws(
    () => assertLocaleCoverage(blankTitle),
    /Section "introduction" missing content for locale "es"/,
  );
});
