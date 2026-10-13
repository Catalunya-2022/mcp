import { completable, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ACTION_COUNTS, SPHERE_GOALS } from "../data/constants.js";
import type { Locale } from "../data/types.js";
import { actionSlug, asSphereId, goalSlug, LOCALES, sphereSlug } from "../data/types.js";
import { ACTION_ID_PATTERN, parseActionIdFormat, resolveSphereIdForGoal } from "./document-utils.js";
import { LOCALE_DESCRIPTION } from "./schemas.js";

type PromptResult = {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

const SPHERE_IDS_AS_STRINGS = ["1", "2", "3"] as const;

/** Every valid "N-M" action id, for argument completion. */
const ALL_ACTION_IDS = Object.entries(ACTION_COUNTS).flatMap(([goalId, count]) =>
  Array.from({ length: count }, (_, index) => `${goalId}-${index + 1}`),
);

function startsWithCompletions<T extends string>(values: readonly T[]) {
  return (value: string | undefined) => values.filter((candidate) => candidate.startsWith(value ?? ""));
}

// completable() must wrap last: zod's .describe() clones the schema and the
// clone would drop the completion marker the SDK looks for. Not shared with
// the tools' localeSchema instance because completable() mutates its schema.
const localeArg = completable(
  z.enum(LOCALES).default("ca").describe(LOCALE_DESCRIPTION),
  startsWithCompletions(LOCALES),
);

function createPromptResult(text: string): PromptResult {
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text,
        },
      },
    ],
  };
}

function getExploreDocumentPrompt(locale: Locale): PromptResult {
  return createPromptResult(`Guide me through the policy document "Catalunya 2022 - RESET: Crida per reactivar el país".

1. Call get_document_metadata with locale="${locale}" to see the full structure
2. Provide a high-level overview of the 3 spheres and 12 goals
3. Highlight the most impactful proposals across spheres
4. Offer to search specific topics with search_document or drill into any section with get_section

Keep the response organized and suggest next steps for deeper exploration.`);
}

function getSummarizeSpherePrompt(sphereId: "1" | "2" | "3", locale: Locale): PromptResult {
  const normalizedSphereId = asSphereId(Number(sphereId));
  const goalIds = SPHERE_GOALS[normalizedSphereId];
  // Steps 1-2 are fixed below, so per-goal steps start at 3.
  const goalSteps = goalIds
    .map(
      (goalId, index) =>
        `${index + 3}. Call get_section with slug="${goalSlug(normalizedSphereId, goalId)}" locale="${locale}" (Goal ${goalId})`,
    )
    .join("\n");

  return createPromptResult(`Summarize Sphere ${normalizedSphereId} of the Catalunya 2022 document.

1. Call get_section with slug="${sphereSlug(normalizedSphereId)}" locale="${locale}" (the sphere overview)
2. Read the sphere's vision and key themes
${goalSteps}
${goalIds.length + 3}. Call list_proposals with sphereId=${normalizedSphereId} locale="${locale}" (all actions in this sphere)

Synthesize into a comprehensive summary covering:
- The sphere's overarching vision
- Key themes across its goals
- Notable action proposals
- How the goals connect to each other`);
}

function getInvalidActionPrompt(actionId: string): PromptResult {
  return createPromptResult(
    `Invalid actionId "${actionId}". Valid format: "2-1" (goal 2, action 1). Goal IDs range from 1 to 12. Use get_document_metadata to see all available actions.`,
  );
}

function getAnalyzeProposalPrompt(actionId: string, locale: Locale): PromptResult {
  const parsedActionId = parseActionIdFormat(actionId);

  if (!parsedActionId) {
    return getInvalidActionPrompt(actionId);
  }

  const sphereId = resolveSphereIdForGoal(parsedActionId.goalId);
  const maxActions = ACTION_COUNTS[parsedActionId.goalId];
  if (parsedActionId.actionNumber > maxActions) {
    return createPromptResult(
      `Invalid actionId "${actionId}". Goal ${parsedActionId.goalId} has ${maxActions} actions (${parsedActionId.goalId}-1 to ${parsedActionId.goalId}-${maxActions}). Use get_document_metadata to see all available actions.`,
    );
  }

  return createPromptResult(`Analyze Action ${actionId} from the Catalunya 2022 document.

1. Call get_section with slug="${actionSlug(sphereId, parsedActionId.goalId, actionId)}" locale="${locale}" (the action itself)
2. Call get_section with slug="${goalSlug(sphereId, parsedActionId.goalId)}" locale="${locale}" (its parent goal, for context)
3. Call get_section with slug="${sphereSlug(sphereId)}" locale="${locale}" (the sphere it belongs to)

Provide analysis covering:
- Summary of what the action proposes
- How it aligns with its parent goal's objectives
- Key stakeholders involved
- Feasibility considerations
- Cross-references to related actions in other goals`);
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "explore-document",
    {
      title: "Explore Document",
      description:
        "Guided tour of the Catalunya 2022 document structure and key themes. Uses get_document_metadata, search_document, and get_section.",
      argsSchema: z.object({
        locale: localeArg,
      }),
    },
    ({ locale }): PromptResult => getExploreDocumentPrompt(locale),
  );

  server.registerPrompt(
    "summarize-sphere",
    {
      title: "Summarize Sphere",
      description:
        "Summarize a sphere and all its goals. Uses get_section and list_proposals to retrieve content.",
      argsSchema: z.object({
        sphereId: completable(
          z.enum(SPHERE_IDS_AS_STRINGS).describe("Sphere ID (1, 2, or 3)"),
          startsWithCompletions(SPHERE_IDS_AS_STRINGS),
        ),
        locale: localeArg,
      }),
    },
    ({ sphereId, locale }): PromptResult => getSummarizeSpherePrompt(sphereId, locale),
  );

  server.registerPrompt(
    "analyze-proposal",
    {
      title: "Analyze Proposal",
      description:
        "Deep analysis of a specific action proposal. Uses get_section for the action, its parent goal, and parent sphere.",
      argsSchema: z.object({
        actionId: completable(
          z
            .string()
            .regex(ACTION_ID_PATTERN, "Action ID must look like '2-1' (goal 2, action 1)")
            .describe("Action ID, e.g. '2-1' for Action 2.1"),
          startsWithCompletions(ALL_ACTION_IDS),
        ),
        locale: localeArg,
      }),
    },
    ({ actionId, locale }): PromptResult => getAnalyzeProposalPrompt(actionId, locale),
  );
}
