import fs from "node:fs";
import path from "node:path";
import { getProjectRoot } from "./paths.js";

/** MCP server name announced in serverInfo, discover results, and the server card. */
export const SERVER_NAME = "catalunya-2022";

/** Public origin this server is deployed at; also the authority serverInfo icons are served from. */
export const MCP_ENDPOINT_URL = "https://mcp.2022.cat";

/** Human-facing documentation page for this server on the companion website. */
export const DOCS_URL = "https://2022.cat/mcp";

const packageVersion: unknown = JSON.parse(
  fs.readFileSync(path.join(getProjectRoot(), "package.json"), "utf-8"),
).version;
if (typeof packageVersion !== "string") {
  throw new Error("package.json is missing a version string");
}

/** Server version, read from package.json so releases are bumped in one place. */
export const SERVER_VERSION: string = packageVersion;

/** One-paragraph description shared by serverInfo and the well-known server card. */
export const SERVER_DESCRIPTION =
  "Full-text access to «Catalunya 2022 - RESET: Crida per reactivar el país», the strategic policy document with 3 spheres, 12 goals, and 91 actions authored by 30 Catalan civil-society experts. Provides document search, section retrieval, proposal listings, and contributor profiles in Catalan, English, and Spanish. No authentication required.";
