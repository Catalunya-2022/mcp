import type { GoalId, SphereId } from "./constants.js";
import { ACTION_COUNTS, SPHERE_GOALS, SPHERE_IDS, STATIC_SLUGS } from "./constants.js";

export const LOCALES = ["ca", "en", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Build a per-locale record in one pass; the single place the Record cast lives. */
export function byLocale<T>(build: (locale: Locale) => T): Record<Locale, T> {
  return Object.fromEntries(LOCALES.map((locale) => [locale, build(locale)])) as Record<Locale, T>;
}

/** Narrow an already-range-checked number (e.g. from a Zod schema) to SphereId. */
export function asSphereId(n: number): SphereId {
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new RangeError(`Invalid sphereId: ${n}. Valid: 1, 2, 3`);
  return n as SphereId;
}

/** Narrow an already-range-checked number (e.g. from a Zod schema) to GoalId. */
export function asGoalId(n: number): GoalId {
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new RangeError(`Invalid goalId: ${n}. Valid: 1–12`);
  return n as GoalId;
}

export function sphereSlug(sphereId: SphereId): string {
  return `sphere-${sphereId}`;
}

export function goalSlug(sphereId: SphereId, goalId: GoalId): string {
  return `${sphereSlug(sphereId)}/goal-${goalId}`;
}

export function actionSlug(sphereId: SphereId, goalId: GoalId, actionId: string): string {
  return `${goalSlug(sphereId, goalId)}/action-${actionId}`;
}

/** Enumerate every canonical section slug the frozen document must provide (3 static + 3 + 12 + 91). */
export function buildExpectedSectionSlugs(): string[] {
  const slugs: string[] = [...STATIC_SLUGS];

  for (const sphereId of SPHERE_IDS) {
    slugs.push(sphereSlug(sphereId));

    for (const goalId of SPHERE_GOALS[sphereId]) {
      slugs.push(goalSlug(sphereId, goalId));

      for (let actionNumber = 1; actionNumber <= ACTION_COUNTS[goalId]; actionNumber += 1) {
        slugs.push(actionSlug(sphereId, goalId, `${goalId}-${actionNumber}`));
      }
    }
  }

  return slugs;
}
