/** Official document title, in the original Catalan. Single source for corpus metadata and the server card. */
export const DOCUMENT_TITLE = "Catalunya 2022 - RESET: Crida per reactivar el país";

/** Citation facts, mirroring the website's citation.ts (the Zenodo record is the anchor). */
export const DOCUMENT_DOI = "10.5281/zenodo.19500831";
export const DOCUMENT_DOI_URL = `https://doi.org/${DOCUMENT_DOI}`;
export const DOCUMENT_AUTHOR = "Grup de Treball Catalunya 2022";
export const DOCUMENT_YEAR = "2021";

export type SphereId = 1 | 2 | 3;
export type GoalId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export const SPHERE_IDS = [1, 2, 3] as const;

export const SPHERE_GOALS = {
  1: [1, 2, 3, 4],
  2: [5, 6, 7, 8],
  3: [9, 10, 11, 12],
} as const satisfies Record<SphereId, readonly GoalId[]>;

export const STATIC_SLUGS = ["introduction", "executive-summary", "train-of-prosperity"] as const;

export const ACTION_COUNTS = {
  1: 9,
  2: 6,
  3: 10,
  4: 6,
  5: 12,
  6: 10,
  7: 9,
  8: 4,
  9: 5,
  10: 7,
  11: 8,
  12: 5,
} as const satisfies Record<GoalId, number>;
