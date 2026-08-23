/**
 * Sync vendored website artifacts into this repo.
 *
 * The companion website repo is the single source of truth for the document
 * text and the task-force data. This script mirrors:
 *   1. content/{ca,en,es}/**\/*.mdx      ← <website>/content/
 *   2. data/team-members.ts              ← <website>/src/lib/data/team-members.ts
 *      (transformed: the `@/i18n/routing` import becomes a local Trilingual type)
 *   3. data/content-provenance.json      ← source commit + sync timestamp
 *
 * Modes:
 *   npm run sync         copy everything that drifted (and prune removed files)
 *   npm run sync-check   report drift and exit 1; exits 0 with "skipped" when
 *                        the website repo is absent (CI has no sibling checkout)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LOCALES } from "../data/types.js";
import { getContentPath, getProjectRoot } from "../src/paths.js";
import { listMdxFilesRelative } from "./build-corpus-lib.js";

const WEBSITE_DIR_ENV = "CAT22_WEBSITE_DIR";

/** Public identity of the content source recorded in the provenance file. */
const CONTENT_SOURCE = "catalunya-2022/web";
const TEAM_MEMBERS_IMPORT_LINE = 'import type { Trilingual } from "@/i18n/routing";';
const TEAM_MEMBERS_LOCAL_HEADER = `// GENERATED FILE — synced from the website repo by scripts/sync-from-website.ts.
// Do not edit by hand: edit <website>/src/lib/data/team-members.ts and run \`npm run sync\`.
export type Trilingual<T = string> = { ca: T; en: T; es: T };`;

function resolveWebsiteDir(): string {
  const override = process.env[WEBSITE_DIR_ENV];
  if (override) {
    return path.resolve(override);
  }
  // Default: the website repo checked out alongside this one, under its
  // public name. Set CAT22_WEBSITE_DIR when your layout differs.
  return path.resolve(getProjectRoot(), "..", "web");
}

/** Rewrite the website module into a dependency-free local module, verbatim otherwise. */
function transformTeamMembers(source: string): string {
  if (!source.includes(TEAM_MEMBERS_IMPORT_LINE)) {
    throw new Error(
      "team-members.ts transform failed: expected import line not found. " +
        "The website module changed shape — update scripts/sync-from-website.ts.",
    );
  }
  return source.replace(TEAM_MEMBERS_IMPORT_LINE, TEAM_MEMBERS_LOCAL_HEADER);
}

type Drift = { path: string; kind: "changed" | "added" | "removed" };

function collectDrift(websiteDir: string): { drift: Drift[]; contentFiles: number; teamMembers: string } {
  const drift: Drift[] = [];
  let contentFiles = 0;

  for (const locale of LOCALES) {
    const websiteLocaleDir = path.join(websiteDir, "content", locale);
    const localLocaleDir = getContentPath(locale);
    const websiteFiles = listMdxFilesRelative(websiteLocaleDir);
    const localFiles = listMdxFilesRelative(localLocaleDir);
    contentFiles += websiteFiles.length;

    for (const file of websiteFiles) {
      const relative = path.join("content", locale, file);
      const localPath = path.join(localLocaleDir, file);
      if (!fs.existsSync(localPath)) {
        drift.push({ path: relative, kind: "added" });
      } else if (
        fs.readFileSync(path.join(websiteLocaleDir, file), "utf-8") !== fs.readFileSync(localPath, "utf-8")
      ) {
        drift.push({ path: relative, kind: "changed" });
      }
    }

    for (const file of localFiles) {
      if (!websiteFiles.includes(file)) {
        drift.push({ path: path.join("content", locale, file), kind: "removed" });
      }
    }
  }

  const teamMembers = transformTeamMembers(
    fs.readFileSync(path.join(websiteDir, "src", "lib", "data", "team-members.ts"), "utf-8"),
  );
  const localTeamMembersPath = path.join(getProjectRoot(), "data", "team-members.ts");
  if (fs.readFileSync(localTeamMembersPath, "utf-8") !== teamMembers) {
    drift.push({ path: "data/team-members.ts", kind: "changed" });
  }

  return { drift, contentFiles, teamMembers };
}

function applySync(websiteDir: string, drift: Drift[], teamMembers: string): void {
  for (const item of drift) {
    const localPath = path.join(getProjectRoot(), item.path);

    if (item.path === "data/team-members.ts") {
      fs.writeFileSync(localPath, teamMembers);
      continue;
    }

    if (item.kind === "removed") {
      fs.rmSync(localPath);
      continue;
    }

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.copyFileSync(path.join(websiteDir, item.path), localPath);
  }
}

/** The stable provenance facts (everything except syncedAt, which only changes when we write). */
function computeProvenance(websiteDir: string, contentFiles: number) {
  return {
    source: CONTENT_SOURCE,
    websiteCommit: execFileSync("git", ["-C", websiteDir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim(),
    websiteCommitDate: execFileSync("git", ["-C", websiteDir, "log", "-1", "--format=%cs", "HEAD"], {
      encoding: "utf-8",
    }).trim(),
    contentFiles,
  };
}

function provenancePath(): string {
  return path.join(getProjectRoot(), "data", "content-provenance.json");
}

function isProvenanceFresh(expected: ReturnType<typeof computeProvenance>): boolean {
  if (!fs.existsSync(provenancePath())) {
    return false;
  }
  const stored = JSON.parse(fs.readFileSync(provenancePath(), "utf-8"));
  return (
    stored.source === expected.source &&
    stored.websiteCommit === expected.websiteCommit &&
    stored.websiteCommitDate === expected.websiteCommitDate &&
    stored.contentFiles === expected.contentFiles
  );
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const websiteDir = resolveWebsiteDir();

  if (!fs.existsSync(path.join(websiteDir, "content"))) {
    if (checkOnly) {
      console.log(`sync-check skipped (website repo not found at ${websiteDir})`);
      return;
    }
    console.error(`Website repo not found at ${websiteDir}. Set ${WEBSITE_DIR_ENV} to override.`);
    process.exit(1);
  }

  const { drift, contentFiles, teamMembers } = collectDrift(websiteDir);
  // Checked independently of content drift: the website commit can advance
  // without changing any mirrored byte, and the provenance record must not
  // silently go stale when it does.
  const expectedProvenance = computeProvenance(websiteDir, contentFiles);
  const provenanceFresh = isProvenanceFresh(expectedProvenance);

  if (drift.length === 0 && provenanceFresh) {
    console.log(`In sync with the website repo (${contentFiles} content files + team-members.ts).`);
    return;
  }

  if (checkOnly) {
    console.error(`Out of sync with the website repo — ${drift.length} file(s) drifted:`);
    for (const item of drift) {
      console.error(`  ${item.kind.padEnd(7)} ${item.path}`);
    }
    if (!provenanceFresh) {
      console.error("  stale   data/content-provenance.json");
    }
    console.error("Run `npm run sync` (with the website repo checked out alongside) to update.");
    process.exit(1);
  }

  applySync(websiteDir, drift, teamMembers);
  fs.writeFileSync(
    provenancePath(),
    `${JSON.stringify({ ...expectedProvenance, syncedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
  console.log(`Synced ${drift.length} file(s) + provenance from ${websiteDir}:`);
  for (const item of drift) {
    console.log(`  ${item.kind.padEnd(7)} ${item.path}`);
  }
}

main();
