import fs from "node:fs";

export function readJsonFixture(relativePath, importMetaUrl) {
  return JSON.parse(fs.readFileSync(new URL(relativePath, importMetaUrl), "utf-8"));
}
