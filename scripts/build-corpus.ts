import fs from "node:fs";
import { getCorpusPath } from "../src/paths.js";
import { buildCorpus, serializeCorpus } from "./build-corpus-lib.js";

const start = performance.now();
const corpus = buildCorpus();
const json = serializeCorpus(corpus);
const sectionCount = Object.keys(corpus.sections).length;
fs.writeFileSync(getCorpusPath(), json, "utf-8");

const elapsed = (performance.now() - start).toFixed(0);
const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(
  `Built corpus: ${sectionCount} sections, ${corpus.contributors.length} contributors, ${sizeMB} MB, ${elapsed}ms`,
);
