import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("compiled modules can resolve project data outside the repository cwd", async () => {
  const originalCwd = process.cwd();
  const originalSkipAutostart = process.env.MCP_SKIP_AUTOSTART;
  const corpusModuleUrl = pathToFileURL(path.resolve("dist/src/corpus.js")).href;
  const indexModuleUrl = pathToFileURL(path.resolve("dist/src/index.js")).href;

  try {
    process.chdir(os.tmpdir());
    process.env.MCP_SKIP_AUTOSTART = "1";
    const corpusModule = await import(`${corpusModuleUrl}?cwd-check=${Date.now()}`);
    const indexModule = await import(`${indexModuleUrl}?cwd-check=${Date.now()}`);

    assert.equal(corpusModule.getSection("introduction")?.slug, "introduction");
    assert.equal(typeof indexModule.startServer, "function");
  } finally {
    if (originalSkipAutostart === undefined) {
      delete process.env.MCP_SKIP_AUTOSTART;
    } else {
      process.env.MCP_SKIP_AUTOSTART = originalSkipAutostart;
    }
    process.chdir(originalCwd);
  }
});
