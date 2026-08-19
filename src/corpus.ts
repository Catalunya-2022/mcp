import fs from "node:fs";
import FlexSearch from "flexsearch";
import type { ContentCorpus, LocalizedContent, Section, SectionType } from "../data/corpus-types.js";
import { buildWebsiteUrl } from "../data/route-catalog.js";
import type { Locale } from "../data/types.js";
import { actionSlug, asGoalId, buildExpectedSectionSlugs, byLocale } from "../data/types.js";
import { resolveSphereIdForGoal, sortSectionsForReading } from "./document-utils.js";
import { getCorpusPath } from "./paths.js";

const { Document, Charset } = FlexSearch;

const HIGHLIGHT_MARKER = "**";
const MAX_SEARCH_RESULTS = 10;
/** Single characters ("a", "1") match and highlight everything; two keeps real terms like "IA" or "5G". */
const MIN_TOKEN_LENGTH = 2;
/** A term in a section's title is its subject; an incidental body mention must not outweigh it. */
const TITLE_MATCH_WEIGHT = 4;
const MAX_SNIPPET_LENGTH = 200;
const SNIPPET_CONTEXT_BEFORE = 80;
const SNIPPET_CONTEXT_AFTER = 120;
const WORD_BOUNDARY_TRIM_THRESHOLD = 20;

type SearchResult = {
  slug: string;
  type: SectionType;
  title: string;
  snippet: string;
  url: string;
  sphereId?: number;
  goalId?: number;
  actionId?: string;
};

type SearchResponse = {
  results: SearchResult[];
  /** Full match count before the 10-result cap, so callers can tell "10" from "10 of 40". */
  total: number;
};

type FieldResult = {
  field: string;
  result: number[];
};

type CorpusState = {
  corpus: ContentCorpus;
  allSections: readonly Section[];
  slugs: string[];
  indexes: Record<Locale, InstanceType<typeof Document>>;
};

let corpusState: CorpusState | undefined;

function loadCorpusState(): CorpusState {
  const raw = fs.readFileSync(getCorpusPath(), "utf-8");
  const corpus: ContentCorpus = JSON.parse(raw);
  const allSections = Object.values(corpus.sections);
  const slugs = Object.keys(corpus.sections);

  // A parseable but wrong corpus (stale build, truncated write) must fail here,
  // where boot and the deploy health gate catch it — not as blank sections at
  // request time.
  const expectedSlugs = buildExpectedSectionSlugs();
  if (!corpus.contentHash || [...slugs].sort().join("\n") !== [...expectedSlugs].sort().join("\n")) {
    throw new Error("data/corpus.json does not match the frozen section contract; run npm run build-corpus");
  }

  const indexes = byLocale((locale) => {
    // LatinBalance folds Catalan/Spanish diacritics ('educacio' matches 'educació').
    // Title matches get finer scoring resolution (9) than body matches (3) so
    // section titles outrank incidental body mentions.
    const index = new Document({
      document: {
        id: "id",
        store: true,
        index: [
          { field: "title", tokenize: "forward", encoder: Charset.LatinBalance, resolution: 9 },
          { field: "body", tokenize: "forward", encoder: Charset.LatinBalance, resolution: 3 },
        ],
      },
    });

    for (const [indexId, slug] of slugs.entries()) {
      const content = corpus.sections[slug].content[locale];
      index.add({ id: indexId, title: content.title, body: content.body });
    }

    return index;
  });

  return { corpus, allSections, slugs, indexes };
}

function getCorpusState(): CorpusState {
  corpusState ??= loadCorpusState();
  return corpusState;
}

/** The pre-built document corpus, loaded from data/corpus.json on first access. */
export function getCorpus(): ContentCorpus {
  return getCorpusState().corpus;
}

// --- Search ---

/**
 * Full-text search over one locale's index. Deduplicates title/body matches
 * (preferring titles), extracts highlighted snippets, and caps results at 10.
 */
export function search(
  query: string,
  locale: Locale,
  scope: SectionType | undefined,
  buildUrl: (slug: string, locale: Locale) => string,
): SearchResponse {
  const { corpus, indexes, slugs } = getCorpusState();
  // FlexSearch's Document#search return type is untyped; FieldResult mirrors its runtime shape.
  // limit must cover the whole corpus: FlexSearch defaults to 100 per field, and the
  // scope filter below runs on this pool — a smaller pool silently drops scoped matches.
  // No enrich/highlight: snippets are built from the original text below, both for
  // typographic fidelity (FlexSearch's highlighter reconstructs encoder-normalized
  // text, dropping the Catalan interpunct and wrapping token fragments mid-word)
  // and because highlighting the full pool was nearly the entire cost of a search.
  const runQuery = (q: string) =>
    indexes[locale].search({ query: q, limit: slugs.length, suggest: true }) as FieldResult[];

  // Single-letter query parts (elided articles like l' and d', stray digits)
  // dilute the candidate pool at the index level, so "l'educació" returned a
  // different, noisier set than "educació". Drop them before searching; the
  // interpunct stays token-internal so ela geminada words survive intact.
  const cleanedQuery = query
    .split(/[^\p{L}\p{N}·]+/u)
    .filter((part) => part.length >= MIN_TOKEN_LENGTH)
    .join(" ");
  if (cleanedQuery === "") {
    return { results: [], total: 0 };
  }

  // Quoted phrases are exact-match filters: every "..." must occur verbatim
  // (at the fold level) in a section's title or body for it to qualify.
  const phrases = [...query.matchAll(/"([^"]+)"/g)]
    .map((match) => foldForMatching(match[1]).trim())
    .filter((phrase) => phrase.length >= MIN_TOKEN_LENGTH);

  let fieldResults = runQuery(cleanedQuery);

  // Catalan ela geminada: without a Catalan keyboard, "l·l" is typed "ll"
  // ("intelligencia" for "intel·ligència"), but the interpunct is a token
  // separator at index time, so the joined spelling matches nothing. Retry a
  // zero-hit query with the geminate restored.
  if (cleanedQuery.includes("ll") && fieldResults.every((fieldResult) => fieldResult.result.length === 0)) {
    fieldResults = runQuery(cleanedQuery.replaceAll("ll", "l·l"));
  }

  // Deduplicate across fields; title-field results enter first and stable
  // sorting preserves that order within equal scores.
  const seen = new Set<number>();
  for (const fieldResult of fieldResults) {
    for (const id of fieldResult.result) {
      seen.add(id);
    }
  }

  const queryTokens = [
    ...new Set(
      foldForMatching(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= MIN_TOKEN_LENGTH),
    ),
  ];

  // Relevance floor and score in one pass. Matching is word-start only,
  // mirroring the index's forward tokenization: substring matching let short
  // tokens hide inside unrelated words ("or" in "història", "table" in
  // "estable"). Each covered token contributes its LENGTH, so a query's
  // specific terms outrank its incidental short ones, and a section matching
  // nothing real is dropped entirely.
  type Candidate = {
    slug: string;
    section: Section;
    content: LocalizedContent;
    titleMatched: boolean;
    score: number;
  };
  const candidates: Candidate[] = [];
  for (const id of seen) {
    const slug = slugs[id];
    const section = corpus.sections[slug];
    if (scope && section.type !== scope) {
      continue;
    }

    const content = section.content[locale];
    const { title: titleHaystack, body: bodyHaystack } = foldedContent(content);
    let score = 0;
    let titleMatched = false;
    for (const token of queryTokens) {
      if (hasWordStartingWith(titleHaystack, token)) {
        score += token.length * TITLE_MATCH_WEIGHT;
        titleMatched = true;
      } else if (hasWordStartingWith(bodyHaystack, token)) {
        score += token.length;
      }
    }
    if (score === 0) {
      continue;
    }

    let missingPhrase = false;
    for (const phrase of phrases) {
      if (titleHaystack.includes(phrase)) {
        score += phrase.length * TITLE_MATCH_WEIGHT;
        titleMatched = true;
      } else if (bodyHaystack.includes(phrase)) {
        score += phrase.length;
      } else {
        missingPhrase = true;
        break;
      }
    }
    if (missingPhrase) {
      continue;
    }

    candidates.push({ slug, section, content, titleMatched, score });
  }

  // Stable sort: FlexSearch's own relevance order survives within equal
  // scores; title matches break the remaining ties.
  candidates.sort((a, b) => b.score - a.score || Number(b.titleMatched) - Number(a.titleMatched));

  // The snippet follows OUR match signal, not FlexSearch's field attribution:
  // a title snippet is only served when the title really contains a query
  // token, so every snippet carries a visible highlight.
  const results = candidates.slice(0, MAX_SEARCH_RESULTS).map((candidate) => ({
    slug: candidate.slug,
    type: candidate.section.type,
    title: candidate.content.title,
    snippet: candidate.titleMatched
      ? highlightTokens(candidate.content.title, queryTokens)
      : buildBodySnippet(candidate.content.body, queryTokens),
    url: buildUrl(candidate.slug, locale),
    ...sectionIds(candidate.section),
  }));

  return { results, total: candidates.length };
}

/** The hierarchy ids a section carries, for programmatic filtering of results. */
function sectionIds(section: Section): Pick<SearchResult, "sphereId" | "goalId" | "actionId"> {
  switch (section.type) {
    case "static":
      return {};
    case "sphere":
      return { sphereId: section.sphereId };
    case "goal":
      return { sphereId: section.sphereId, goalId: section.goalId };
    case "action":
      return { sphereId: section.sphereId, goalId: section.goalId, actionId: section.actionId };
  }
}

/** Mirror the index-side folding for containment checks: lowercase, no diacritics, no interpunct. */
function foldForMatching(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replaceAll("·", "")
    .toLowerCase();
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

/** Whether the query yields any token long enough to search for (used to explain empty results). */
export function hasSearchableTokens(query: string): boolean {
  return foldForMatching(query)
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= MIN_TOKEN_LENGTH);
}

/** True when any word in the folded haystack starts with the token (forward-tokenization semantics). */
function hasWordStartingWith(folded: string, token: string): boolean {
  for (let index = folded.indexOf(token); index !== -1; index = folded.indexOf(token, index + 1)) {
    if (index === 0 || !isWordChar(folded[index - 1])) {
      return true;
    }
  }
  return false;
}

type FoldedText = {
  folded: string;
  /** Original-string index each folded character came from. */
  map: number[];
};

// Folded haystacks are pure functions of frozen corpus content; caching them
// keeps scoring from re-normalizing every candidate's body on every search
// (the former hottest path, at several ms per query).
const foldedContentCache = new WeakMap<LocalizedContent, { title: string; body: string }>();

function foldedContent(content: LocalizedContent): { title: string; body: string } {
  let folded = foldedContentCache.get(content);
  if (!folded) {
    folded = { title: foldForMatching(content.title), body: foldForMatching(content.body) };
    foldedContentCache.set(content, folded);
  }
  return folded;
}

// Per-character fold results, memoized: inputs are corpus text, so the key
// space is the document's alphabet. Folding char-by-char through normalize()
// uncached made snippets the hottest part of a search.
const charFoldCache = new Map<string, string>();

function foldChar(char: string): string {
  let folded = charFoldCache.get(char);
  if (folded === undefined) {
    folded = foldForMatching(char);
    charFoldCache.set(char, folded);
  }
  return folded;
}

/** Fold like foldForMatching, keeping a map from folded positions back to the original text. */
function foldWithMap(text: string): FoldedText {
  let folded = "";
  const map: number[] = [];
  let originalIndex = 0;
  for (const char of text) {
    for (const foldedChar of foldChar(char)) {
      folded += foldedChar;
      map.push(originalIndex);
    }
    originalIndex += char.length;
  }
  return { folded, map };
}

/**
 * Wrap every word starting with a query token in highlight markers, working
 * on the ORIGINAL text so excerpts keep their exact typography (accents, the
 * Catalan interpunct) and matched words are wrapped whole, never mid-word.
 */
function highlightTokens(text: string, tokens: string[]): string {
  // Content emphasis (*once only*) would merge with the injected ** markers
  // into ambiguous asterisk runs; titles carry such italics too.
  const cleaned = text.replace(/[*_]/g, "");
  const { folded, map } = foldWithMap(cleaned);

  const ranges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    for (let from = folded.indexOf(token); from !== -1; from = folded.indexOf(token, from + 1)) {
      if (from > 0 && isWordChar(folded[from - 1])) {
        continue;
      }
      let wordEnd = from + token.length;
      while (wordEnd < folded.length && isWordChar(folded[wordEnd])) {
        wordEnd += 1;
      }

      const start = map[from];
      let end = map[wordEnd - 1] + 1;
      // Keep combining marks attached to the last highlighted character.
      while (end < cleaned.length && /\p{M}/u.test(cleaned[end])) {
        end += 1;
      }
      ranges.push({ start, end });
    }
  }
  if (ranges.length === 0) {
    return cleaned;
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  let highlighted = cleaned;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const { start, end } = merged[i];
    highlighted = `${highlighted.slice(0, start)}${HIGHLIGHT_MARKER}${highlighted.slice(
      start,
      end,
    )}${HIGHLIGHT_MARKER}${highlighted.slice(end)}`;
  }
  return highlighted;
}

/** Extract a ~200-char window around the first matched token, from the original body text. */
function buildBodySnippet(body: string, tokens: string[]): string {
  const { folded, map } = foldWithMap(body);

  let firstMatch = -1;
  for (const token of tokens) {
    for (let index = folded.indexOf(token); index !== -1; index = folded.indexOf(token, index + 1)) {
      if (index > 0 && isWordChar(folded[index - 1])) {
        continue;
      }
      if (firstMatch === -1 || map[index] < firstMatch) {
        firstMatch = map[index];
      }
      break;
    }
  }
  // Suggest can surface a section whose body contains no query token (the
  // match lived in the title); fall back to the opening of the body.
  if (firstMatch === -1) {
    const head =
      body.length > MAX_SNIPPET_LENGTH ? `${body.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}...` : body;
    return head.replace(/[*_]/g, "");
  }

  const start = Math.max(0, firstMatch - SNIPPET_CONTEXT_BEFORE);
  const end = Math.min(body.length, firstMatch + SNIPPET_CONTEXT_AFTER);
  let snippet = body.slice(start, end);

  // Trim to word boundaries
  let prefix = "";
  let suffix = "";
  if (start > 0) {
    const firstSpace = snippet.indexOf(" ");
    if (firstSpace > 0 && firstSpace < WORD_BOUNDARY_TRIM_THRESHOLD) {
      snippet = snippet.slice(firstSpace + 1);
    }
    prefix = "...";
  }
  if (end < body.length) {
    const lastSpace = snippet.lastIndexOf(" ");
    if (lastSpace > snippet.length - WORD_BOUNDARY_TRIM_THRESHOLD) {
      snippet = snippet.slice(0, lastSpace);
    }
    suffix = "...";
  }

  return `${prefix}${highlightTokens(snippet, tokens)}${suffix}`;
}

// --- Accessors ---

/** Look up a section by canonical slug; undefined when the slug does not exist. */
export function getSection(slug: string): Section | undefined {
  const { corpus } = getCorpusState();
  return Object.hasOwn(corpus.sections, slug) ? corpus.sections[slug] : undefined;
}

/** All 109 sections in corpus order. */
export function getAllSections(): readonly Section[] {
  return getCorpusState().allSections;
}

/**
 * Repair the predictable slug mistakes: a goal filed under the wrong sphere,
 * or an action whose id disagrees with its path ("2-1" embeds goal 2). Each
 * goal belongs to exactly one sphere, so the repair is deterministic; the
 * corrected slug is returned only when it actually exists.
 */
export function suggestSlug(slug: string): string | undefined {
  const actionMatch = slug.match(/^sphere-\d{1,2}\/goal-\d{1,2}\/action-(\d{1,2})-(\d{1,2})$/);
  const goalMatch = slug.match(/^sphere-\d{1,2}\/(goal-(\d{1,2})(?:\/.+)?)$/);

  let repaired: string | undefined;
  try {
    if (actionMatch) {
      const goalId = asGoalId(Number.parseInt(actionMatch[1], 10));
      repaired = actionSlug(resolveSphereIdForGoal(goalId), goalId, `${actionMatch[1]}-${actionMatch[2]}`);
    } else if (goalMatch) {
      repaired = `sphere-${resolveSphereIdForGoal(asGoalId(Number.parseInt(goalMatch[2], 10)))}/${goalMatch[1]}`;
    }
  } catch {
    return undefined;
  }

  if (repaired && repaired !== slug && getSection(repaired)) {
    return repaired;
  }

  // Typos: the nearest known slug within a small edit distance.
  return nearestSlug(slug);
}

/** Closest existing slug within edit distance 2, for near-miss typos ("executive-sumary"). */
function nearestSlug(slug: string): string | undefined {
  if (slug.length < 5) {
    return undefined;
  }

  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of getCorpusState().slugs) {
    const distance = boundedLevenshtein(slug, candidate, bestDistance - 1);
    if (distance !== undefined && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Levenshtein distance, or undefined once it must exceed maxDistance. */
function boundedLevenshtein(a: string, b: string, maxDistance: number): number | undefined {
  if (Math.abs(a.length - b.length) > maxDistance) {
    return undefined;
  }

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + substitutionCost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxDistance) {
      return undefined;
    }
    previous = current;
  }
  return previous[b.length] <= maxDistance ? previous[b.length] : undefined;
}

/**
 * Render a section as the markdown served by get_section and section resources.
 * The `**Section:** slug | **Website:** url` header line is part of the public contract.
 */
export function renderSectionMarkdown(slug: string, url: string, content: LocalizedContent): string {
  return `**Section:** ${slug} | **Website:** ${url}\n---\n# ${content.identifier}\n## ${content.title}\n\n${content.body}`;
}

// ~150 KB per locale, kept for the process lifetime: cheap insurance against
// clients that re-read the full-document resource repeatedly.
const fullDocumentCache = new Map<Locale, string>();

/**
 * Render the whole document for one locale as a single markdown file — the
 * same shape as the website's /documents/catalunya-2022-{locale}.md downloads:
 * H1 document title, then per section `## identifier`, the website URL, the
 * `### title` subtitle, and the body, separated by `---` rules.
 */
export function renderFullDocumentMarkdown(locale: Locale): string {
  const cached = fullDocumentCache.get(locale);
  if (cached) {
    return cached;
  }

  const { corpus } = getCorpusState();
  const header = `# ${corpus.metadata.title}\n\n${buildWebsiteUrl("", locale)}`;
  const sections = sortSectionsForReading(getAllSections()).map((section) => {
    const content = section.content[locale];
    return [
      `## ${content.identifier}`,
      "",
      buildWebsiteUrl(section.slug, locale),
      "",
      `### ${content.title}`,
      "",
      content.body,
    ].join("\n");
  });

  const rendered = `${[header, ...sections].join("\n\n---\n\n")}\n`;
  fullDocumentCache.set(locale, rendered);
  return rendered;
}
