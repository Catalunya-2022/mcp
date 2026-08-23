import assert from "node:assert/strict";
import test from "node:test";
import { REGISTRY_NAME } from "../dist/src/identity.js";
import { readJsonFixture } from "./helpers/read-json-fixture.js";

const serverJson = readJsonFixture("../server.json", import.meta.url);
const packageJson = readJsonFixture("../package.json", import.meta.url);

test("server.json tracks the package version", () => {
  assert.equal(serverJson.version, packageJson.version);
});

test("server.json stays within registry limits and points at production", () => {
  assert.ok(
    serverJson.description.length <= 100,
    `description is ${serverJson.description.length} chars; the registry rejects more than 100`,
  );
  assert.equal(serverJson.name, "cat.2022/catalunya-2022");
  assert.equal(REGISTRY_NAME, serverJson.name, "identity REGISTRY_NAME must match server.json");
  assert.equal(serverJson.remotes[0].type, "streamable-http");
  assert.equal(serverJson.remotes[0].url, "https://mcp.2022.cat");
});
