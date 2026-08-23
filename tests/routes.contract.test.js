import assert from "node:assert/strict";
import test from "node:test";
import { buildWebsiteUrl } from "../dist/data/route-catalog.js";

const routeCases = [
  {
    canonicalPath: "introduction",
    locale: "ca",
    expected: "https://2022.cat/introduccio",
  },
  {
    canonicalPath: "introduction",
    locale: "en",
    expected: "https://2022.cat/en/introduction",
  },
  {
    canonicalPath: "task-force/elies-campo",
    locale: "es",
    expected: "https://2022.cat/es/grupo-de-trabajo/elies-campo",
  },
  {
    canonicalPath: "sphere-1/goal-2/action-2-1",
    locale: "ca",
    expected: "https://2022.cat/ambit-1/objectiu-2/accio-2-1",
  },
  {
    canonicalPath: "sphere-1/goal-2/action-2-1",
    locale: "en",
    expected: "https://2022.cat/en/sphere-1/goal-2/action-2-1",
  },
  {
    canonicalPath: "sphere-1/goal-2/action-2-1",
    locale: "es",
    expected: "https://2022.cat/es/ambito-1/objetivo-2/accion-2-1",
  },
];

test("route catalog preserves localized URL translations", () => {
  for (const routeCase of routeCases) {
    assert.equal(buildWebsiteUrl(routeCase.canonicalPath, routeCase.locale), routeCase.expected);
  }
});
