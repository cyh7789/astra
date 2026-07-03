import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import { createAstraServer } from "../src/mcp-server.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const USER = "00000000-0000-0000-0000-000000000001";

function parseResult(res: unknown): any {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe("astra mcp server", () => {
  let db: TestDb;
  let client: Client;

  beforeAll(async () => {
    db = await createTestDb();
    const store = new MemoryStore(db.pool, new FakeEmbedder());
    const server = createAstraServer(store, USER);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterAll(async () => {
    await client.close();
    await db.drop();
  });

  it("lists the four memory tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["forget", "recall", "remember", "update_memory"],
    );
  });

  it("remember → recall roundtrip", async () => {
    const remembered = parseResult(
      await client.callTool({
        name: "remember",
        arguments: {
          context: "driving",
          memoryType: "episodic",
          content: "提醒：今天早上出門先去加油",
          importance: 0.8,
        },
      }),
    );
    expect(remembered.id).toBeTruthy();

    const recalled = parseResult(
      await client.callTool({
        name: "recall",
        arguments: { query: "要去加油", context: "driving", topK: 3 },
      }),
    );
    expect(recalled.memories[0].id).toBe(remembered.id);
    expect(recalled.memories[0].signals).toBeDefined();
    expect(recalled.memories[0].embedding).toBeUndefined(); // 不洩漏向量
    expect(Array.isArray(recalled.memories[0].annotations)).toBe(true); // guard 標注欄位
    expect(Array.isArray(recalled.memories[0].conflictsWith)).toBe(true);
  });

  it("update_memory changes content", async () => {
    const m = parseResult(
      await client.callTool({
        name: "remember",
        arguments: { context: "office", memoryType: "semantic", content: "王經理偏好月付" },
      }),
    );
    const updated = parseResult(
      await client.callTool({
        name: "update_memory",
        arguments: { id: m.id, content: "王經理偏好季付" },
      }),
    );
    expect(updated.content).toBe("王經理偏好季付");
  });

  it("forget removes memory from recall", async () => {
    const m = parseResult(
      await client.callTool({
        name: "remember",
        arguments: { context: "home", memoryType: "episodic", content: "臨時記事 xyzzy" },
      }),
    );
    await client.callTool({ name: "forget", arguments: { id: m.id } });
    const recalled = parseResult(
      await client.callTool({
        name: "recall",
        arguments: { query: "xyzzy", context: "home" },
      }),
    );
    expect(recalled.memories.map((x: any) => x.id)).not.toContain(m.id);
  });

  it("unknown memory id errors cleanly", async () => {
    const res = await client.callTool({
      name: "update_memory",
      arguments: { id: "00000000-0000-0000-0000-00000000dead", content: "x" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
