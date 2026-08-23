import assert from "node:assert/strict";
import test from "node:test";
import {
  compareActionIds,
  parseActionId,
  parseSectionResourceRef,
  resolveSphereIdForGoal,
} from "../dist/src/document-utils.js";

test("parseActionId accepts valid action identifiers", () => {
  assert.deepEqual(parseActionId("2-1"), {
    actionId: "2-1",
    goalId: 2,
    actionNumber: 1,
  });
});

test("parseActionId rejects invalid or out-of-range action identifiers", () => {
  assert.equal(parseActionId("02-1"), undefined);
  assert.equal(parseActionId("2-99"), undefined);
  assert.equal(parseActionId("goal-2"), undefined);
});

test("resolveSphereIdForGoal maps goals to the correct sphere", () => {
  assert.equal(resolveSphereIdForGoal(1), 1);
  assert.equal(resolveSphereIdForGoal(8), 2);
  assert.equal(resolveSphereIdForGoal(12), 3);
});

test("compareActionIds sorts numerically instead of lexicographically", () => {
  const actionIds = ["3-10", "3-2", "2-6", "2-1"];
  actionIds.sort(compareActionIds);

  assert.deepEqual(actionIds, ["2-1", "2-6", "3-2", "3-10"]);
});

test("parseSectionResourceRef validates locale and slug structure", () => {
  assert.deepEqual(parseSectionResourceRef("en/sphere-1/goal-2"), {
    locale: "en",
    slug: "sphere-1/goal-2",
  });
  assert.equal(parseSectionResourceRef("fr/sphere-1"), undefined);
  assert.equal(parseSectionResourceRef("en"), undefined);
});
