import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { SPHERE_GOALS } from "../data/constants.js";
import { SECTION_TYPES } from "../data/corpus-types.js";
import { buildWebsiteUrl, toCanonicalSlug } from "../data/route-catalog.js";
import type { Locale } from "../data/types.js";
import { asGoalId, asSphereId, byLocale, LOCALES } from "../data/types.js";
import {
  getAllSections,
  getCorpus,
  getSection,
  hasSearchableTokens,
  renderSectionMarkdown,
  search,
  suggestSlug,
} from "./corpus.js";
import {
  buildDocumentMetadataByLocale,
  compareActionIds,
  type DocumentMetadata,
  isGoalInSphere,
  sectionResourceUri,
} from "./document-utils.js";
import { localeSchema } from "./schemas.js";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// --- Output schemas (advertised via tools/list, validated on every result) ---

const searchResultSchema = z.object({
  slug: z.string().describe("Canonical section slug, usable with get_section"),
  type: z.enum(SECTION_TYPES),
  title: z.string(),
  snippet: z.string().describe("Content snippet with **highlighted** matches"),
  url: z.string().describe("Canonical page URL on 2022.cat in the requested locale"),
  sphereId: z.number().int().optional().describe("Present on sphere, goal, and action results"),
  goalId: z.number().int().optional().describe("Present on goal and action results"),
  actionId: z.string().optional().describe("Present on action results"),
});

const searchOutputSchema = z.object({
  results: z.array(searchResultSchema),
  total: z.number().int().describe("Total matches before the 10-result cap"),
  message: z.string().optional().describe("Guidance when no results were found"),
});

const proposalSchema = z.object({
  actionId: z.string(),
  goalId: z.number().int(),
  sphereId: z.number().int(),
  slug: z.string(),
  title: z.string(),
  url: z.string(),
});

const listProposalsOutputSchema = z.object({
  proposals: z.array(proposalSchema),
  count: z.number().int(),
});

const titledEntrySchema = z.object({ title: z.string(), slug: z.string() });

const metadataOutputSchema = z.object({
  title: z.string(),
  date: z.string(),
  languages: z.array(z.string()),
  structure: z.object({
    spheres: z.number().int(),
    goals: z.number().int(),
    actions: z.number().int(),
    contributors: z.number().int(),
  }),
  citation: z.object({
    title: z.string(),
    author: z.string(),
    year: z.string(),
    doi: z.string(),
    doiUrl: z.string(),
  }),
  hierarchy: z.array(
    titledEntrySchema.extend({
      id: z.number().int(),
      goals: z.array(
        titledEntrySchema.extend({
          id: z.number().int(),
          actionCount: z.number().int(),
          actions: z.array(titledEntrySchema.extend({ id: z.string() })),
        }),
      ),
    }),
  ),
  staticPages: z.array(titledEntrySchema),
  contributors: z.object({
    count: z.number().int(),
    names: z.array(z.string()),
    members: z.array(z.object({ name: z.string(), slug: z.string(), role: z.string(), url: z.string() })),
  }),
});

// --- Helpers ---

let documentMetadataByLocale: Record<Locale, DocumentMetadata> | undefined;

function getDocumentMetadataForLocale(locale: Locale): DocumentMetadata {
  documentMetadataByLocale ??= buildDocumentMetadataByLocale(getCorpus());
  return documentMetadataByLocale[locale];
}

let proposalsByLocale: Record<Locale, Proposal[]> | undefined;

type Proposal = {
  actionId: string;
  goalId: number;
  sphereId: number;
  slug: string;
  title: string;
  url: string;
};

function getProposalsForLocale(locale: Locale): Proposal[] {
  proposalsByLocale ??= byLocale((proposalLocale) =>
    getAllSections()
      .filter((section) => section.type === "action")
      .map((section) => ({
        actionId: section.actionId,
        goalId: section.goalId,
        sphereId: section.sphereId,
        slug: section.slug,
        title: section.content[proposalLocale].title,
        url: buildWebsiteUrl(section.slug, proposalLocale),
      }))
      .sort((a, b) => compareActionIds(a.actionId, b.actionId)),
  );
  return proposalsByLocale[locale];
}

function errorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function sectionLink(slug: string, locale: Locale, name: string) {
  return {
    type: "resource_link" as const,
    uri: sectionResourceUri(locale, slug),
    name,
    mimeType: "text/markdown",
  };
}

/** Result shape shared by every tool with an outputSchema: a JSON text block mirroring structuredContent. */
function structuredResult<T extends object>(
  structuredContent: T,
  extraContent: Array<ReturnType<typeof sectionLink>> = [],
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }, ...extraContent],
    structuredContent,
  };
}

// --- Registration ---

export function registerTools(server: McpServer): void {
  server.registerTool(
    "search_document",
    {
      title: "Search the document",
      description:
        "Search the Catalunya 2022 - RESET policy document by keyword. Returns up to 10 results with canonical slugs (for follow-up with get_section) and text snippets; \"total\" carries the full match count. Terms are matched independently with coverage-based ranking; quoted phrases (\"energia sostenible\") must match exactly. Handles Catalan/Spanish diacritics automatically (e.g., 'educacio' matches 'educació').",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Search query (e.g., 'housing', 'educacio', 'digital transformation'). Use terms in the target locale for best results.",
          ),
        locale: localeSchema,
        scope: z
          .enum(SECTION_TYPES)
          .optional()
          .describe(
            "Filter by section type: 'action' (91 proposals), 'goal' (12 overviews), 'sphere' (3 overviews), or 'static' (introduction, executive summary, train of prosperity)",
          ),
      }),
      outputSchema: searchOutputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    ({ query, locale, scope }) => {
      const { results, total } = search(query, locale, scope, buildWebsiteUrl);

      let message: string | undefined;
      if (results.length === 0) {
        // An already-quoted query must not gain a second pair of quotes.
        const displayQuery =
          query.startsWith('"') && query.endsWith('"') && query.length > 1 ? query : `"${query}"`;
        if (!hasSearchableTokens(query)) {
          // Suggesting another locale cannot help when no token was long
          // enough to search for in the first place.
          message = `No results found for ${displayQuery} in ${locale}: search terms must be at least 2 characters long. Try longer keywords, or use list_proposals to browse all 91 actions.`;
        } else {
          // Probing the other locales is nearly free and turns "try another
          // locale" from a guess into a directed retry.
          const localesWithHits = LOCALES.filter(
            (other) => other !== locale && search(query, other, scope, buildWebsiteUrl).results.length > 0,
          );
          message =
            localesWithHits.length > 0
              ? `No results found for ${displayQuery} in ${locale}, but the query matches sections in: ${localesWithHits.join(", ")}. Retry with locale "${localesWithHits[0]}".`
              : `No results found for ${displayQuery} in ${locale}. Try different keywords or a different locale (ca, en, es), as terms may appear in another language. You can also use list_proposals to browse all 91 actions.`;
        }
      }

      const structuredContent = { results, total, ...(message && { message }) };

      return structuredResult(
        structuredContent,
        results.map((result) => sectionLink(result.slug, locale, result.title)),
      );
    },
  );

  server.registerTool(
    "get_section",
    {
      title: "Read a section",
      description:
        "Retrieve the full text of any section of the Catalunya 2022 document by its canonical slug. Slugs follow the pattern: 'sphere-1', 'sphere-1/goal-2', 'sphere-1/goal-2/action-2-1'. Static pages: 'introduction', 'executive-summary', 'train-of-prosperity'. Use get_document_metadata to discover all available slugs.",
      inputSchema: z.object({
        slug: z
          .string()
          .regex(
            /^[a-z0-9-]+(?:\/[a-z0-9-]+){0,2}$/,
            "Slug must be 1-3 lowercase segments, like 'sphere-1/goal-2/action-2-1' or 'introduction'",
          )
          .max(100)
          .describe("Canonical section slug"),
        locale: localeSchema,
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    ({ slug, locale }) => {
      // Accept the server's own localized URL segments back
      // ("ambit-1/objectiu-2" resolves to "sphere-1/goal-2").
      const canonicalSlug = getSection(slug) ? slug : toCanonicalSlug(slug);
      const section = getSection(canonicalSlug);

      if (!section) {
        const suggestion = suggestSlug(canonicalSlug);
        return errorResult(
          `Section not found: '${slug}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""} Valid patterns: sphere-1, sphere-1/goal-2, sphere-1/goal-2/action-2-1. Static pages: introduction, executive-summary, train-of-prosperity. Use get_document_metadata to see all available sections.`,
        );
      }

      const content = section.content[locale];
      return {
        content: [
          {
            type: "text" as const,
            text: renderSectionMarkdown(canonicalSlug, buildWebsiteUrl(canonicalSlug, locale), content),
          },
          sectionLink(canonicalSlug, locale, content.title),
        ],
      };
    },
  );

  server.registerTool(
    "get_document_metadata",
    {
      title: "Document structure and citation",
      description:
        'Get the complete structure of the policy document "Catalunya 2022 - RESET: Crida per reactivar el país": 3 spheres, 12 goals, 91 actions created by a 30-expert Catalonia Task Force. Returns the hierarchy with canonical slugs for navigation via get_section, plus the formal citation with DOI.',
      inputSchema: z.object({
        locale: localeSchema,
      }),
      outputSchema: metadataOutputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    ({ locale }) => structuredResult(getDocumentMetadataForLocale(locale)),
  );

  server.registerTool(
    "list_proposals",
    {
      title: "List action proposals",
      description:
        "List all 91 action proposals from the Catalunya 2022 document, optionally filtered by sphere (1-3) or goal (1-12). Returns actionId, goalId, sphereId, title, slug, and url. Use get_section with the returned slug to read full action content.",
      inputSchema: z.object({
        locale: localeSchema,
        sphereId: z.number().int().min(1).max(3).optional().describe("Filter by sphere (1-3)"),
        goalId: z.number().int().min(1).max(12).optional().describe("Filter by goal (1-12)"),
      }),
      outputSchema: listProposalsOutputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    ({ locale, sphereId, goalId }) => {
      if (sphereId !== undefined && goalId !== undefined) {
        const normalizedSphereId = asSphereId(sphereId);
        const normalizedGoalId = asGoalId(goalId);

        if (!isGoalInSphere(normalizedSphereId, normalizedGoalId)) {
          const validGoals = SPHERE_GOALS[normalizedSphereId].join(", ");
          return errorResult(
            `Goal ${goalId} does not belong to Sphere ${sphereId}. Sphere ${sphereId} contains Goals ${validGoals}.`,
          );
        }
      }

      const proposals = getProposalsForLocale(locale)
        .filter((proposal) => sphereId === undefined || proposal.sphereId === sphereId)
        .filter((proposal) => goalId === undefined || proposal.goalId === goalId);

      return structuredResult({ proposals, count: proposals.length });
    },
  );
}
