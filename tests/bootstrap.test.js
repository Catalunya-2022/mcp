import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("autostart is governed solely by MCP_SKIP_AUTOSTART", async () => {
  const originalSkipAutostart = process.env.MCP_SKIP_AUTOSTART;
  const indexModuleUrl = pathToFileURL(path.resolve("dist/src/index.js")).href;

  try {
    process.env.MCP_SKIP_AUTOSTART = "1";
    const indexModule = await import(`${indexModuleUrl}?bootstrap-test=${Date.now()}`);

    assert.equal(indexModule.shouldAutostart({}), true);
    assert.equal(indexModule.shouldAutostart({ MCP_SKIP_AUTOSTART: "1" }), false);
    assert.equal(typeof indexModule.startServer, "function");
  } finally {
    if (originalSkipAutostart === undefined) {
      delete process.env.MCP_SKIP_AUTOSTART;
    } else {
      process.env.MCP_SKIP_AUTOSTART = originalSkipAutostart;
    }
  }
});
