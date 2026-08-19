import * as z from "zod";
import { LOCALES } from "../data/types.js";

/** Shared by the tool schema below and the prompt argument in prompts.ts (separate schema instances). */
export const LOCALE_DESCRIPTION =
  "Content language. Defaults to 'ca' (Catalan), the original language of the document. (ca=Catalan, en=English, es=Spanish)";

export const localeSchema = z.enum(LOCALES).default("ca").describe(LOCALE_DESCRIPTION);
