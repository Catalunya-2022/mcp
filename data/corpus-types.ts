import type { GoalId, SphereId } from "./constants.js";
import type { TeamMember, Trilingual } from "./team-members.js";

export const SECTION_TYPES = ["sphere", "goal", "action", "static"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export type LocalizedContent = {
  title: string;
  identifier: string;
  body: string;
};

type SectionBase = {
  slug: string;
  content: Trilingual<LocalizedContent>;
};

type StaticSection = SectionBase & {
  type: "static";
};

type SphereSection = SectionBase & {
  type: "sphere";
  sphereId: SphereId;
};

type GoalSection = SectionBase & {
  type: "goal";
  sphereId: SphereId;
  goalId: GoalId;
};

type ActionSection = SectionBase & {
  type: "action";
  sphereId: SphereId;
  goalId: GoalId;
  actionId: string;
};

export type Section = StaticSection | SphereSection | GoalSection | ActionSection;

export type SectionMetadata =
  | Pick<StaticSection, "type">
  | Pick<SphereSection, "type" | "sphereId">
  | Pick<GoalSection, "type" | "sphereId" | "goalId">
  | Pick<ActionSection, "type" | "sphereId" | "goalId" | "actionId">;

export type ContentCorpus = {
  /** sha256 over sections + contributors: identifies the content build (echoed by /health). */
  contentHash: string;
  metadata: {
    title: string;
    date: string;
    languages: string[];
    structure: { spheres: number; goals: number; actions: number; contributors: number };
  };
  sections: Record<string, Section>;
  contributors: TeamMember[];
  hierarchy: {
    spheres: Array<{
      id: SphereId;
      goals: Array<{
        id: GoalId;
        actionCount: number;
        actions: Array<{ id: string }>;
      }>;
    }>;
  };
};
