/**
 * Regenerate the golden fixtures in tests/fixtures/ from the live server
 * surface. Run deliberately after an INTENDED public-contract change and
 * review the resulting diff; never hand-edit the fixtures.
 *
 *   npm run fixtures:update
 */

import fs from "node:fs";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STATIC_SLUGS } from "../data/constants.js";
import { buildExpectedSectionSlugs } from "../data/types.js";
import { getCorpus } from "../src/corpus.js";
import { getProjectRoot } from "../src/paths.js";
import { createMcpServer } from "../src/server.js";

function writeFixture(name: string, value: unknown): void {
  fs.writeFileSync(
    path.join(getProjectRoot(), "tests", "fixtures", name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  console.log(`Wrote tests/fixtures/${name}`);
}

async function main(): Promise<void> {
  const corpus = getCorpus();
  writeFixture("expected-slugs.json", buildExpectedSectionSlugs());
  writeFixture("corpus-summary.json", {
    metadata: corpus.metadata,
    counts: {
      sections: Object.keys(corpus.sections).length,
      contributors: corpus.contributors.length,
    },
    staticPages: [...STATIC_SLUGS],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture-update", version: "1.0.0" }, { capabilities: {} });
  const server = createMcpServer();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const sectionResult = await client.callTool({
      name: "get_section",
      arguments: { slug: "sphere-1/goal-2/action-2-1", locale: "en" },
    });
    const invalidResult = await client.callTool({
      name: "list_proposals",
      arguments: { locale: "en", sphereId: 1, goalId: 5 },
    });
    writeFixture("tool-outputs.json", {
      getSectionAction21En: { content: sectionResult.content },
      listProposalsInvalid: { isError: true, content: invalidResult.content },
    });

    const explore = await client.getPrompt({ name: "explore-document", arguments: { locale: "en" } });
    const summarize = await client.getPrompt({
      name: "summarize-sphere",
      arguments: { sphereId: "1", locale: "en" },
    });
    const analyze = await client.getPrompt({
      name: "analyze-proposal",
      arguments: { actionId: "2-1", locale: "en" },
    });
    writeFixture("prompt-outputs.json", {
      exploreDocumentEn: { messages: explore.messages },
      summarizeSphere1En: { messages: summarize.messages },
      analyzeProposal21En: { messages: analyze.messages },
    });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

await main();
