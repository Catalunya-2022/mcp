import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findProjectRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    const dataDirPath = path.join(currentDir, "data");

    if (fs.existsSync(packageJsonPath) && fs.existsSync(dataDirPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate project root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = findProjectRoot(MODULE_DIR);

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

function getDataPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, "data", ...segments);
}

export function getContentPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, "content", ...segments);
}

export function getCorpusPath(): string {
  return getDataPath("corpus.json");
}
