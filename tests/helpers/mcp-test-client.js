import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../../dist/src/server.js";

export async function withMcpClient(run) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-tests", version: "1.0.0" }, { capabilities: {} });
  const server = createMcpServer();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    return await run(client, server);
  } finally {
    await Promise.allSettled([
      client.close(),
      server.close(),
      clientTransport.close(),
      serverTransport.close(),
    ]);
  }
}

export function normalizeToolResult(result) {
  return {
    ...(result.isError ? { isError: true } : {}),
    content: result.content,
  };
}

export function readToolText(result) {
  assert.ok(result.content?.length, "Expected tool result to contain content");
  const [content] = result.content;
  assert.equal(content.type, "text", "Expected first tool content block to be text");
  return content.text;
}

export function normalizePromptResult(result) {
  return { messages: result.messages };
}

export function readResourceText(result) {
  assert.ok(result.contents?.length, "Expected resource result to contain contents");
  return result.contents[0].text;
}
