/**
 * Route catalog: single source of truth for URL generation.
 * Mirrors the companion website's route-catalog.ts and path-utils.ts.
 *
 * Two kinds of translations:
 * 1. SEGMENT_PREFIXES: word-level for hierarchy segments (sphere-N, goal-N, action-N-M)
 * 2. STATIC_ROUTES: whole-slug translations for non-hierarchy pages
 */

import type { Locale } from "./types.js";

// --- Hierarchy segment prefixes ---

const SEGMENT_PREFIXES: Record<string, Record<Locale, string>> = {
  sphere: { ca: "ambit", en: "sphere", es: "ambito" },
  goal: { ca: "objectiu", en: "goal", es: "objetivo" },
  action: { ca: "accio", en: "action", es: "accion" },
};

// --- Static page routes (canonical English key → localized slug without leading slash) ---
// These include companion website pages referenced from the MDX body content, not only
// sections served directly by the MCP server. build-corpus.ts uses them to localize links.
// Some keys (organizations, people-consulted, press, resources) have no referencing link
// in today's content; they are kept for parity with the website's catalog, since a content sync
// may introduce links to them at any time.

const STATIC_ROUTES: Record<string, Record<Locale, string>> = {
  introduction: { ca: "introduccio", en: "introduction", es: "introduccion" },
  "executive-summary": { ca: "resum-executiu", en: "executive-summary", es: "resumen-ejecutivo" },
  "train-of-prosperity": { ca: "tren-de-prosperitat", en: "train-of-prosperity", es: "tren-de-prosperidad" },
  "action-plan": { ca: "pla-accio", en: "action-plan", es: "plan-de-accion" },
  "task-force": { ca: "grup-de-treball", en: "task-force", es: "grupo-de-trabajo" },
  organizations: { ca: "organitzacions", en: "organizations", es: "organizaciones" },
  "people-consulted": { ca: "persones-consultades", en: "people-consulted", es: "personas-consultadas" },
  press: { ca: "premsa", en: "press", es: "prensa" },
  resources: { ca: "recursos", en: "resources", es: "recursos" },
};

// --- URL builders ---

/** Origin of the companion website; every URL this module builds lives under it. */
export const WEBSITE_ORIGIN = "https://2022.cat";

/** Base URL where the companion website serves contributor portraits (its Next.js public/ dir). */
const TEAM_PHOTO_BASE_URL = `${WEBSITE_ORIGIN}/team-photos`;

/** Whether a canonical first path segment has a static-route translation. */
export function hasStaticRoute(segment: string): boolean {
  return Object.hasOwn(STATIC_ROUTES, segment);
}

// Reverse lookups, derived from the same tables so they cannot drift. Maps
// rather than plain objects: the keys looked up come from client input, and an
// object would answer "constructor" or "__proto__" from its prototype.
const CANONICAL_STATIC_BY_LOCALIZED = new Map<string, string>(
  Object.entries(STATIC_ROUTES).flatMap(([canonical, localized]) =>
    Object.values(localized).map((slug) => [slug, canonical] as const),
  ),
);
const CANONICAL_PREFIX_BY_LOCALIZED = new Map<string, string>(
  Object.entries(SEGMENT_PREFIXES).flatMap(([canonical, localized]) =>
    Object.values(localized).map((prefix) => [prefix, canonical] as const),
  ),
);

/**
 * Translate a localized path back to its canonical English form, so the URL
 * segments this server emits ("ambit-1/objectiu-2") round-trip into slug
 * lookups. Canonical input passes through unchanged.
 */
export function toCanonicalSlug(path: string): string {
  const segments = path.split("/");
  const canonicalFirst = CANONICAL_STATIC_BY_LOCALIZED.get(segments[0]);
  if (canonicalFirst) {
    return [canonicalFirst, ...segments.slice(1)].join("/");
  }

  return segments
    .map((segment) =>
      segment.replace(
        /^([a-zà-ú]+)(-\d.*)$/,
        (_, word, rest) => (CANONICAL_PREFIX_BY_LOCALIZED.get(word) ?? word) + rest,
      ),
    )
    .join("/");
}

/** Build the public URL for a contributor portrait; the return type keeps the filename's image-extension suffix. */
export function buildTeamPhotoUrl<Filename extends string>(
  photoFilename: Filename,
): `${typeof TEAM_PHOTO_BASE_URL}/${Filename}` {
  return `${TEAM_PHOTO_BASE_URL}/${photoFilename}`;
}

/**
 * Build an absolute 2022.cat URL from a canonical English path and locale.
 * Handles static pages, hierarchy segments, and the empty path (the locale's home page).
 *
 * Examples:
 *   ("introduction", "es")           → "https://2022.cat/es/introduccion"
 *   ("task-force/member-slug", "ca") → "https://2022.cat/grup-de-treball/member-slug"
 *   ("sphere-1/goal-2", "es")        → "https://2022.cat/es/ambito-1/objetivo-2"
 *   ("", "en")                       → "https://2022.cat/en"
 */
export function buildWebsiteUrl(canonicalPath: string, locale: Locale): string {
  if (canonicalPath === "") {
    return locale === "ca" ? WEBSITE_ORIGIN : `${WEBSITE_ORIGIN}/${locale}`;
  }

  const prefix = locale === "ca" ? "" : `${locale}/`;
  const translated = translatePath(canonicalPath, locale);
  return `${WEBSITE_ORIGIN}/${prefix}${translated}`;
}

/**
 * Translate a canonical English path to locale-specific segments.
 */
function translatePath(canonicalPath: string, locale: Locale): string {
  const segments = canonicalPath.split("/");
  const firstSegment = segments[0];

  if (hasStaticRoute(firstSegment)) {
    // Translate the static slug, keep remaining segments as-is (e.g., member slugs)
    const translated = [STATIC_ROUTES[firstSegment][locale], ...segments.slice(1)];
    return translated.join("/");
  }

  // Translate hierarchy segments (sphere-N, goal-N, action-N-M)
  return segments
    .map((seg) =>
      seg.replace(/^(sphere|goal|action)(-\d+.*)$/, (_, word, rest) => {
        return (SEGMENT_PREFIXES[word]?.[locale] ?? word) + rest;
      }),
    )
    .join("/");
}
