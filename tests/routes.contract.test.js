import assert from "node:assert/strict";
import test from "node:test";
import { buildWebsiteUrl, hasStaticRoute, toCanonicalSlug } from "../dist/data/route-catalog.js";

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
    canonicalPath: "task-force/member-slug",
    locale: "es",
    expected: "https://2022.cat/es/grupo-de-trabajo/member-slug",
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

test("slug lookups never answer from Object.prototype", () => {
  // Client-supplied slugs reach these lookups; a plain-object table would
  // resolve "constructor" to a function and stringify it into the slug.
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(hasStaticRoute(key), false, key);
    assert.equal(toCanonicalSlug(key), key);
    assert.equal(toCanonicalSlug(`${key}/goal-1`), `${key}/goal-1`);
  }
  assert.equal(toCanonicalSlug("constructor-1"), "constructor-1");
  assert.equal(toCanonicalSlug("ambit-1/objectiu-2"), "sphere-1/goal-2");
  assert.equal(toCanonicalSlug("resum-executiu"), "executive-summary");
});
