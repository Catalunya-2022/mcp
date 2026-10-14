import type { GoalId, SphereId } from "../data/constants.js";
import {
  ACTION_COUNTS,
  DOCUMENT_AUTHOR,
  DOCUMENT_DOI,
  DOCUMENT_DOI_URL,
  DOCUMENT_TITLE,
  DOCUMENT_YEAR,
  SPHERE_GOALS,
  SPHERE_IDS,
  STATIC_SLUGS,
} from "../data/constants.js";
import type { ContentCorpus, Section } from "../data/corpus-types.js";
import { buildWebsiteUrl } from "../data/route-catalog.js";
import type { Locale } from "../data/types.js";
import { actionSlug, asGoalId, byLocale, goalSlug, isLocale, LOCALES, sphereSlug } from "../data/types.js";

type TitleMap = Record<Locale, string>;

type ParsedActionId = {
  actionId: string;
  goalId: GoalId;
  actionNumber: number;
};

/** Action IDs are "N-M": goal number, dash, action number within the goal. Shared with the Zod arg schema in prompts.ts. */
export const ACTION_ID_PATTERN = /^([1-9]\d?)-([1-9]\d?)$/;

const staticSectionOrder = new Map<string, number>(STATIC_SLUGS.map((slug, index) => [slug, index]));

/**
 * Parse "N-M" into goal and action number, validating only the format and
 * goal range, not whether action M exists. Callers that want a tailored
 * out-of-range message (see analyze-proposal) check ACTION_COUNTS themselves.
 */
export function parseActionIdFormat(actionId: string): ParsedActionId | undefined {
  const match = actionId.match(ACTION_ID_PATTERN);
  if (!match) {
    return undefined;
  }

  const rawGoalId = Number.parseInt(match[1], 10);
  const actionNumber = Number.parseInt(match[2], 10);

  let goalId: GoalId;
  try {
    goalId = asGoalId(rawGoalId);
  } catch {
    return undefined;
  }

  return { actionId, goalId, actionNumber };
}

/** Parse "N-M" and additionally require that action M exists within goal N. */
export function parseActionId(actionId: string): ParsedActionId | undefined {
  const parsed = parseActionIdFormat(actionId);
  if (!parsed || parsed.actionNumber > ACTION_COUNTS[parsed.goalId]) {
    return undefined;
  }

  return parsed;
}

const GOAL_TO_SPHERE = Object.fromEntries(
  SPHERE_IDS.flatMap((sphereId) => SPHERE_GOALS[sphereId].map((goalId) => [goalId, sphereId])),
) as Record<GoalId, SphereId>;

/** The sphere a goal belongs to; SPHERE_GOALS covers every GoalId, so this is total. */
export function resolveSphereIdForGoal(goalId: GoalId): SphereId {
  return GOAL_TO_SPHERE[goalId];
}

export function isGoalInSphere(sphereId: SphereId, goalId: GoalId): boolean {
  return GOAL_TO_SPHERE[goalId] === sphereId;
}

/** Order "N-M" action ids numerically (goal first, then action), falling back to code units for malformed ids. */
export function compareActionIds(a: string, b: string): number {
  const parsedA = parseActionId(a);
  const parsedB = parseActionId(b);

  if (!parsedA || !parsedB) {
    // Plain code-unit comparison: localeCompare would make a public ordering
    // contract depend on the host's ICU locale.
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return parsedA.goalId - parsedB.goalId || parsedA.actionNumber - parsedB.actionNumber;
}

/** Sort sections into reading order without mutating the input. */
export function sortSectionsForReading(sections: readonly Section[]): Section[] {
  return [...sections].sort(compareSectionsForListing);
}

/** Reading order for resource listings: static pages first, then each sphere's overview, goals, and actions. */
function compareSectionsForListing(a: Section, b: Section): number {
  if (a.type === "static" || b.type === "static") {
    if (a.type !== b.type) {
      return a.type === "static" ? -1 : 1;
    }

    return (
      (staticSectionOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
      (staticSectionOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  if (a.sphereId !== b.sphereId) {
    return a.sphereId - b.sphereId;
  }

  if (a.type === "sphere" || b.type === "sphere") {
    return a.type === b.type ? 0 : a.type === "sphere" ? -1 : 1;
  }

  if (a.goalId !== b.goalId) {
    return a.goalId - b.goalId;
  }

  if (a.type === "goal" || b.type === "goal") {
    return a.type === b.type ? 0 : a.type === "goal" ? -1 : 1;
  }

  return compareActionIds(a.actionId, b.actionId);
}

function buildTitleMap(corpus: ContentCorpus, slug: string): TitleMap {
  return byLocale((locale) => corpus.sections[slug].content[locale].title);
}

/** Localized document overview served by get_document_metadata: hierarchy with slugs, static pages, contributors. */
function buildDocumentMetadata(corpus: ContentCorpus, locale: Locale) {
  return {
    ...corpus.metadata,
    citation: {
      title: DOCUMENT_TITLE,
      author: DOCUMENT_AUTHOR,
      year: DOCUMENT_YEAR,
      doi: DOCUMENT_DOI,
      doiUrl: DOCUMENT_DOI_URL,
    },
    hierarchy: corpus.hierarchy.spheres.map((sphere) => {
      const sphereSectionSlug = sphereSlug(sphere.id);

      return {
        id: sphere.id,
        title: corpus.sections[sphereSectionSlug].content[locale].title,
        slug: sphereSectionSlug,
        goals: sphere.goals.map((goal) => {
          const goalSectionSlug = goalSlug(sphere.id, goal.id);

          return {
            id: goal.id,
            title: corpus.sections[goalSectionSlug].content[locale].title,
            slug: goalSectionSlug,
            actionCount: goal.actionCount,
            actions: goal.actions.map((action) => {
              const actionSectionSlug = actionSlug(sphere.id, goal.id, action.id);

              return {
                id: action.id,
                title: corpus.sections[actionSectionSlug].content[locale].title,
                slug: actionSectionSlug,
              };
            }),
          };
        }),
      };
    }),
    staticPages: STATIC_SLUGS.map((slug) => ({
      slug,
      title: corpus.sections[slug].content[locale].title,
    })),
    contributors: {
      count: corpus.contributors.length,
      names: corpus.contributors.map((contributor) => contributor.name),
      members: corpus.contributors.map((contributor) => ({
        name: contributor.name,
        slug: contributor.slug,
        role: contributor.role[locale],
        url: buildWebsiteUrl(`task-force/${contributor.slug}`, locale),
      })),
    },
  };
}

export type DocumentMetadata = ReturnType<typeof buildDocumentMetadata>;

/** Pre-build the metadata overview per locale; computed once and cached by tools.ts. */
export function buildDocumentMetadataByLocale(corpus: ContentCorpus): Record<Locale, DocumentMetadata> {
  return byLocale((locale) => buildDocumentMetadata(corpus, locale));
}

/** Full trilingual hierarchy served by the manifest resource. */
export function buildManifest(corpus: ContentCorpus) {
  return {
    metadata: corpus.metadata,
    staticPages: STATIC_SLUGS.map((slug) => ({
      slug,
      titles: buildTitleMap(corpus, slug),
    })),
    hierarchy: corpus.hierarchy.spheres.map((sphere) => ({
      id: sphere.id,
      titles: buildTitleMap(corpus, sphereSlug(sphere.id)),
      goals: sphere.goals.map((goal) => ({
        id: goal.id,
        titles: buildTitleMap(corpus, goalSlug(sphere.id, goal.id)),
        actions: goal.actions.map((action) => ({
          id: action.id,
          titles: buildTitleMap(corpus, actionSlug(sphere.id, goal.id, action.id)),
        })),
      })),
    })),
  };
}

/** Base of every document resource URI this server exposes. */
export const DOCUMENT_URI_BASE = "document://catalunya2022";

/** Resource URI for one section in one locale. */
export function sectionResourceUri(locale: Locale, slug: string): string {
  return `${DOCUMENT_URI_BASE}/${locale}/${slug}`;
}

/** Resource URI for the whole document in one locale. */
export function fullDocumentResourceUri(locale: Locale): string {
  return `${DOCUMENT_URI_BASE}/${locale}`;
}

/**
 * One resource entry per section per locale (109 × 3), in reading order.
 * `name` is the programmatic identifier (the URI ref); `title` carries the
 * human-readable section title; clients that display titles would otherwise
 * inherit the template's generic title on every entry.
 */
export function buildSectionResourceList(corpus: ContentCorpus): Array<{
  uri: string;
  name: string;
  title: string;
}> {
  return sortSectionsForReading(Object.values(corpus.sections)).flatMap((section) =>
    LOCALES.map((locale) => ({
      uri: sectionResourceUri(locale, section.slug),
      name: `${locale}/${section.slug}`,
      title: `${section.content[locale].title} (${locale})`,
    })),
  );
}

/** Split a "{locale}/{slug}" resource ref; undefined when the locale is unknown or the slug is empty. */
export function parseSectionResourceRef(ref: string):
  | {
      locale: Locale;
      slug: string;
    }
  | undefined {
  const firstSlash = ref.indexOf("/");
  const localeValue = firstSlash > 0 ? ref.slice(0, firstSlash) : ref;
  const slug = firstSlash > 0 ? ref.slice(firstSlash + 1) : "";

  if (!isLocale(localeValue) || !slug) {
    return undefined;
  }

  return { locale: localeValue, slug };
}
