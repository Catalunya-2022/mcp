import assert from "node:assert/strict";
import test from "node:test";
import { getAllSections, search } from "../dist/src/corpus.js";

const url = (slug) => `https://example.test/${slug}`;
const find = (query, locale, scope) => search(query, locale, scope, url).results;

test("scoped search sees the whole corpus, not FlexSearch's default 100-result pool", () => {
  // "de" prefix-matches nearly every section. Without an explicit limit,
  // FlexSearch caps each field's results at 100 BEFORE the scope filter runs,
  // which silently dropped scoped matches (2 of 3 spheres for this query).
  const spheres = find("de", "ca", "sphere");
  assert.equal(spheres.length, 3, "all three sphere overviews match 'de'");
  assert.deepEqual(spheres.map((r) => r.slug).sort(), ["sphere-1", "sphere-2", "sphere-3"]);

  const statics = find("en", "ca", "static");
  assert.equal(statics.length, 3, "all three static pages match 'en'");
});

test("results cap at 10 while total reports the full match count", () => {
  const { results, total } = search("Catalunya", "ca", undefined, url);
  assert.ok(results.length > 0 && results.length <= 10);
  assert.ok(total >= results.length, "total must cover at least the returned results");
  for (const result of results) {
    assert.equal(result.url, `https://example.test/${result.slug}`);
    assert.ok(result.title.length > 0);
  }
});

test("results carry their hierarchy ids for programmatic filtering", () => {
  const [top] = find("energia", "ca", "action");
  assert.equal(top.type, "action");
  assert.equal(typeof top.sphereId, "number");
  assert.equal(typeof top.goalId, "number");
  assert.match(top.actionId, /^\d{1,2}-\d{1,2}$/);

  const [staticPage] = find("en", "ca", "static");
  assert.equal(staticPage.sphereId, undefined);
});

test("scope filters return only the requested section type", () => {
  for (const scope of ["sphere", "goal", "action", "static"]) {
    for (const result of find("cultura", "ca", scope)) {
      assert.equal(result.type, scope);
    }
  }
});

test("query-term coverage outranks incidental short-token matches", () => {
  // Junk-heavy queries must not bury the one real term: sections matching
  // only "or" ranked above the section containing "energia", and body-wide
  // pages that merely mention it ranked above sections TITLED with it.
  const results = find("energia' OR 1=1; DROP TABLE sections;--", "ca", undefined);
  assert.ok(results.length > 1);
  assert.match(results[0].title, /energia/i);
  assert.match(results[1].title, /energia/i);
});

test("quoted phrases must match exactly", () => {
  const phrase = find('"energia sostenible"', "ca", undefined);
  assert.ok(phrase.length > 0, "the phrase exists in the corpus");
  // Every returned section carries the exact phrase; single-term tail
  // matches ("energia" alone) are excluded.
  const loose = find("energia sostenible", "ca", undefined);
  assert.ok(phrase.length < loose.length, "phrase filtering must narrow the result set");
  assert.ok(phrase.every((result) => loose.some((r) => r.slug === result.slug)));
});

test("single-character queries return guidance instead of highlighting every letter", () => {
  assert.deepEqual(search("a", "ca", undefined, url), { results: [], total: 0 });
  assert.deepEqual(search("1", "en", undefined, url), { results: [], total: 0 });
  // Two-character terms stay searchable ("10" appears standalone in the text).
  assert.ok(find("10", "ca", undefined).length > 0);
});

test("queries that occur nowhere return no results instead of encoder noise", () => {
  // The LatinBalance encoder folds aggressively ("zzz" collides with common
  // tokens at the index level); the relevance floor must drop those hits.
  assert.deepEqual(find("zzz", "ca", undefined), []);
  assert.deepEqual(find("xyzzyplugh", "en", undefined), []);
});

test("Catalan ela geminada matches with or without the interpunct", () => {
  const native = find("intel·ligencia", "ca", undefined);
  const joined = find("intelligencia", "ca", undefined);

  assert.ok(native.length > 0, "native spelling should match");
  assert.ok(joined.length > 0, "keyboard-less 'll' spelling should match too");
  assert.deepEqual(
    joined.map((result) => result.slug),
    native.map((result) => result.slug),
  );
});

test("snippets keep the original typography and wrap matched words whole", () => {
  // Snippets are built from the original corpus text: FlexSearch's own
  // highlighter reconstructed encoder-normalized text, dropping the Catalan
  // interpunct ("col·lectives" -> "collectives") and wrapping token
  // fragments mid-word ("col·**laboració**").
  const goal1 = find("transformacions", "ca", undefined).find((r) => r.slug === "sphere-1/goal-1");
  assert.ok(goal1, "expected a goal-1 result");
  assert.match(goal1.snippet, /\*\*transformacions\*\*/);
  assert.match(goal1.snippet, /col·lectives/);

  const retried = find("collaboracio", "ca", undefined);
  assert.ok(retried.length > 0);
  assert.ok(
    retried.some((r) => r.snippet.includes("**col·laboraci")),
    "the geminate retry must highlight the whole original word",
  );
  assert.ok(
    retried.every((r) => !r.snippet.includes("·**")),
    "matched words must never be wrapped from mid-word",
  );
});

test("content emphasis is stripped from snippets so injected markers stay unambiguous", () => {
  // The corpus italicizes foreign terms (*once only*, *click & collect*);
  // left in place they merge with the injected ** into asterisk runs.
  for (const result of find("once only", "ca", undefined)) {
    const withoutMarkers = result.snippet.replaceAll("**", "");
    assert.ok(!withoutMarkers.includes("*"), `stray emphasis in snippet for ${result.slug}`);
  }
});

test("elided articles do not change the results, and every result is highlighted", () => {
  // "l'educació" is how a Catalan speaker types it; the stray "l" token used
  // to dilute the candidate pool with article matches.
  const plain = find("educació", "ca", undefined);
  const elided = find("l'educació", "ca", undefined);
  assert.deepEqual(
    elided.map((result) => result.slug),
    plain.map((result) => result.slug),
  );
  for (const result of [...plain, ...elided]) {
    assert.ok(result.snippet.includes("**"), `unhighlighted snippet for ${result.slug}`);
  }
});

test("diacritics fold in both directions", () => {
  const plain = find("educacio", "ca", undefined);
  const accented = find("educació", "ca", undefined);
  assert.ok(plain.length > 0);
  assert.deepEqual(
    plain.map((r) => r.slug),
    accented.map((r) => r.slug),
  );
});

test("every section type present in the corpus is reachable via scoped search", () => {
  const types = new Set(getAllSections().map((section) => section.type));
  assert.deepEqual([...types].sort(), ["action", "goal", "sphere", "static"]);
});
