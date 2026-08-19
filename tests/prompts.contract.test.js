import assert from "node:assert/strict";
import test from "node:test";
import { normalizePromptResult, withMcpClient } from "./helpers/mcp-test-client.js";
import { readJsonFixture } from "./helpers/read-json-fixture.js";

const promptOutputs = readJsonFixture("./fixtures/prompt-outputs.json", import.meta.url);

test("server exposes the expected prompt names", async () => {
  await withMcpClient(async (client) => {
    const response = await client.listPrompts();
    const promptNames = response.prompts.map((prompt) => prompt.name).sort();

    assert.deepEqual(promptNames, ["analyze-proposal", "explore-document", "summarize-sphere"]);
  });
});

test("the locale argument is optional everywhere and defaults to Catalan", async () => {
  await withMcpClient(async (client) => {
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      const localeArg = prompt.arguments.find((argument) => argument.name === "locale");
      assert.ok(localeArg, `${prompt.name} should declare a locale argument`);
      assert.notEqual(localeArg.required, true, `${prompt.name} must not require locale`);
    }

    const defaulted = await client.getPrompt({ name: "explore-document", arguments: {} });
    const explicit = await client.getPrompt({ name: "explore-document", arguments: { locale: "ca" } });
    assert.deepEqual(normalizePromptResult(defaulted), normalizePromptResult(explicit));
  });
});

test("prompt outputs remain stable for representative arguments", async () => {
  await withMcpClient(async (client) => {
    const explorePrompt = await client.getPrompt({
      name: "explore-document",
      arguments: { locale: "en" },
    });
    const summarizePrompt = await client.getPrompt({
      name: "summarize-sphere",
      arguments: { sphereId: "1", locale: "en" },
    });
    const analyzePrompt = await client.getPrompt({
      name: "analyze-proposal",
      arguments: { actionId: "2-1", locale: "en" },
    });

    assert.deepEqual(normalizePromptResult(explorePrompt), promptOutputs.exploreDocumentEn);
    assert.deepEqual(normalizePromptResult(summarizePrompt), promptOutputs.summarizeSphere1En);
    assert.deepEqual(normalizePromptResult(analyzePrompt), promptOutputs.analyzeProposal21En);
  });
});

test("analyze-proposal explains invalid action ids instead of failing", async () => {
  await withMcpClient(async (client) => {
    const outOfRange = await client.getPrompt({
      name: "analyze-proposal",
      arguments: { actionId: "2-99", locale: "en" },
    });
    assert.match(
      outOfRange.messages[0].content.text,
      /Goal 2 has 6 actions \(2-1 to 2-6\)/,
      "Expected the per-goal guidance for an out-of-range action number",
    );

    const unknownGoal = await client.getPrompt({
      name: "analyze-proposal",
      arguments: { actionId: "13-1", locale: "en" },
    });
    assert.match(unknownGoal.messages[0].content.text, /Goal IDs range from 1 to 12/);

    // Format violations are rejected by the argument schema before the handler runs.
    await assert.rejects(
      client.getPrompt({ name: "analyze-proposal", arguments: { actionId: "abc", locale: "en" } }),
    );
  });
});

test("prompt arguments offer completions", async () => {
  await withMcpClient(async (client) => {
    const spheres = await client.complete({
      ref: { type: "ref/prompt", name: "summarize-sphere" },
      argument: { name: "sphereId", value: "" },
    });
    assert.deepEqual(spheres.completion.values, ["1", "2", "3"]);

    const locales = await client.complete({
      ref: { type: "ref/prompt", name: "explore-document" },
      argument: { name: "locale", value: "e" },
    });
    assert.deepEqual(locales.completion.values, ["en", "es"]);

    const actions = await client.complete({
      ref: { type: "ref/prompt", name: "analyze-proposal" },
      argument: { name: "actionId", value: "12-" },
    });
    assert.deepEqual(actions.completion.values, ["12-1", "12-2", "12-3", "12-4", "12-5"]);
  });
});
