import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACTION_COUNTS, DOCUMENT_TITLE, DOCUMENT_YEAR, SPHERE_GOALS, SPHERE_IDS } from "../data/constants.js";
import type { ContentCorpus, LocalizedContent, Section, SectionMetadata } from "../data/corpus-types.js";
import { buildTeamPhotoUrl, buildWebsiteUrl, hasStaticRoute, WEBSITE_ORIGIN } from "../data/route-catalog.js";
import type { Trilingual } from "../data/team-members.js";
import { teamMembers } from "../data/team-members.js";
import type { Locale } from "../data/types.js";
import { asGoalId, asSphereId, buildExpectedSectionSlugs, LOCALES } from "../data/types.js";
import { getContentPath } from "../src/paths.js";

export function parseMdx(raw: string, locale: Locale, sourcePath: string): LocalizedContent {
  const lines = raw.split("\n");
  const identifierLineIndex = lines.findIndex((line) => line.startsWith("# "));
  const titleLineIndex = lines.findIndex((line) => line.startsWith("## "));

  if (identifierLineIndex === -1 || titleLineIndex === -1 || titleLineIndex <= identifierLineIndex) {
    throw new Error(
      `Invalid section structure in ${sourcePath}. Expected '# identifier' followed by '## title'.`,
    );
  }

  const identifier = lines[identifierLineIndex].slice(2).trim();
  const title = lines[titleLineIndex].slice(3).trim();
  if (!identifier || !title) {
    throw new Error(`Missing identifier or title in ${sourcePath}.`);
  }

  const betweenHeadings = lines
    .slice(identifierLineIndex + 1, titleLineIndex)
    .join("\n")
    .trim();
  if (betweenHeadings) {
    throw new Error(`Unexpected content between H1 and H2 in ${sourcePath}.`);
  }

  const body = absolutifyLinks(
    lines
      .slice(titleLineIndex + 1)
      .join("\n")
      .trim(),
    locale,
    sourcePath,
  );
  return { identifier, title, body };
}

export function absolutifyLinks(text: string, locale: Locale, sourcePath: string): string {
  return text.replace(/\[([^\]]+)\]\(\/([^)]+)\)/g, (_, label, pathValue: string) => {
    // Asset paths (anything with a file extension) have no localized variant;
    // prefixing them with a locale would produce 404s.
    if (/\.[a-z0-9]+$/i.test(pathValue)) {
      return `[${label}](${WEBSITE_ORIGIN}/${pathValue})`;
    }

    // Unknown segments would silently pass through untranslated and ship a
    // canonical path under a locale prefix; fail the build instead.
    const firstSegment = pathValue.split("/")[0];
    if (!hasStaticRoute(firstSegment) && !/^(?:sphere|goal|action)-\d/.test(firstSegment)) {
      throw new Error(`Unlocalizable internal link "/${pathValue}" in ${sourcePath}.`);
    }

    return `[${label}](${buildWebsiteUrl(pathValue, locale)})`;
  });
}

export function filePathToSlug(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.mdx$/, "");

  if (!withoutExtension.includes("/")) {
    return withoutExtension;
  }

  const parts = withoutExtension.split("/");
  const transformed = parts.map((part) => part.replace(/^(sphere|goal)(\d+)$/, "$1-$2"));

  if (
    transformed.length >= 2 &&
    transformed[transformed.length - 1] === transformed[transformed.length - 2]
  ) {
    transformed.pop();
  }

  return transformed.join("/");
}

export function deriveMetadata(slug: string): SectionMetadata {
  if (!slug.startsWith("sphere-")) {
    return { type: "static" };
  }

  const parts = slug.split("/");
  const sphereId = asSphereId(Number.parseInt(parts[0].split("-")[1], 10));

  if (parts.length === 1) {
    return { type: "sphere", sphereId };
  }

  const goalId = asGoalId(Number.parseInt(parts[1].split("-")[1], 10));
  if (parts.length === 2) {
    return { type: "goal", sphereId, goalId };
  }

  const actionId = parts[2].replace("action-", "");
  return { type: "action", sphereId, goalId, actionId };
}

/** All .mdx paths under baseDir, relative to it and sorted. Shared with sync-from-website.ts. */
export function listMdxFilesRelative(baseDir: string): string[] {
  const paths: string[] = [];

  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (entry.name.endsWith(".mdx")) {
        paths.push(path.relative(baseDir, entryPath));
      }
    }
  }

  walk(baseDir);
  return paths.sort();
}

function readLocalizedContent(relativePath: string): Trilingual<LocalizedContent> {
  return {
    ca: parseMdx(fs.readFileSync(getContentPath("ca", relativePath), "utf-8"), "ca", `ca/${relativePath}`),
    en: parseMdx(fs.readFileSync(getContentPath("en", relativePath), "utf-8"), "en", `en/${relativePath}`),
    es: parseMdx(fs.readFileSync(getContentPath("es", relativePath), "utf-8"), "es", `es/${relativePath}`),
  };
}

function formatDiffMessage(expected: string[], actual: string[]): string {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));

  return `Missing: [${missing.join(", ")}], Extra: [${extra.join(", ")}]`;
}

function assertMirroredLocaleTrees(): string[] {
  const englishPaths = listMdxFilesRelative(getContentPath("en"));

  for (const locale of ["ca", "es"] as const) {
    const localePaths = listMdxFilesRelative(getContentPath(locale));
    if (JSON.stringify(englishPaths) !== JSON.stringify(localePaths)) {
      throw new Error(`Locale "${locale}" tree mismatch. ${formatDiffMessage(englishPaths, localePaths)}`);
    }
  }

  return englishPaths;
}

function buildHierarchy() {
  return {
    spheres: SPHERE_IDS.map((sphereId) => ({
      id: sphereId,
      goals: SPHERE_GOALS[sphereId].map((goalId) => ({
        id: goalId,
        actionCount: ACTION_COUNTS[goalId],
        actions: Array.from({ length: ACTION_COUNTS[goalId] }, (_, index) => ({
          id: `${goalId}-${index + 1}`,
        })),
      })),
    })),
  };
}

function buildStructure() {
  return {
    spheres: SPHERE_IDS.length,
    goals: SPHERE_IDS.reduce((count, sphereId) => count + SPHERE_GOALS[sphereId].length, 0),
    actions: SPHERE_IDS.reduce(
      (count, sphereId) =>
        count +
        SPHERE_GOALS[sphereId].reduce((sphereCount, goalId) => sphereCount + ACTION_COUNTS[goalId], 0),
      0,
    ),
    contributors: teamMembers.length,
  };
}

/** Exported for tests: guards the frozen 109-slug contract against build drift. */
export function assertExpectedSectionSlugs(sections: Record<string, Section>): void {
  const actualSlugs = Object.keys(sections).sort();
  const expectedSlugs = buildExpectedSectionSlugs().sort();

  if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
    throw new Error(`Generated slug set mismatch. ${formatDiffMessage(expectedSlugs, actualSlugs)}`);
  }
}

/** Exported for tests: every section must carry a non-empty title in all three locales. */
export function assertLocaleCoverage(sections: Record<string, Section>): void {
  for (const [slug, section] of Object.entries(sections)) {
    for (const locale of LOCALES) {
      if (!section.content[locale]?.title) {
        throw new Error(`Section "${slug}" missing content for locale "${locale}"`);
      }
    }
  }
}

export function buildCorpus(): ContentCorpus {
  const englishPaths = assertMirroredLocaleTrees();
  const sections: Record<string, Section> = {};

  for (const relativePath of englishPaths) {
    const slug = filePathToSlug(relativePath);

    if (sections[slug]) {
      throw new Error(`Duplicate slug generated for ${relativePath}: ${slug}`);
    }

    sections[slug] = {
      slug,
      ...deriveMetadata(slug),
      content: readLocalizedContent(relativePath),
    };
  }

  assertExpectedSectionSlugs(sections);
  assertLocaleCoverage(sections);

  // Portraits are stored as bare filenames (mirroring the website repo);
  // publish resolvable URLs so MCP clients can actually fetch them.
  const contributors = teamMembers.map((member) => ({
    ...member,
    photo: buildTeamPhotoUrl(member.photo),
  }));

  return {
    // Deterministic content fingerprint (no timestamps), echoed by /health so a
    // deployed server can be matched to the content build it serves.
    contentHash: createHash("sha256").update(JSON.stringify({ sections, contributors })).digest("hex"),
    metadata: {
      title: DOCUMENT_TITLE,
      date: DOCUMENT_YEAR,
      languages: [...LOCALES],
      structure: buildStructure(),
    },
    sections,
    contributors,
    hierarchy: buildHierarchy(),
  };
}

export function serializeCorpus(corpus: ContentCorpus): string {
  return JSON.stringify(corpus, null, 2);
}
