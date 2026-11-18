import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { testSharedVault } from "./shared-vault-fixture";
import { openNoteUri } from "../src/knowledge-note-open";

vi.mock("../src/knowledge-note-open", () => ({ openNoteUri: vi.fn(async () => {}) }));

it("opens only a real mapped note through the app tool, constructs its URI on the server, and reports launch failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "manager-open-"));
  const f = await testSharedVault(root);
  const client = new Client({ name: "open-test", version: "1" }, {});
  try {
    await mkdir(join(root, "Wiki"), { recursive: true });
    const path = "Wiki/中文 空格.md";
    await writeFile(join(root, path), "# 原文\n保留内容");
    await client.connect(new StreamableHTTPClientTransport(new URL(f.config.url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + f.config.token } } }));
    expect((await client.listTools()).tools.find(tool => tool.name === "learning_manager_open_note")?._meta).toEqual({ ui: { visibility: ["app"] } });
    const call = (args: Record<string, unknown>) => client.callTool({ name: "learning_manager_open_note", arguments: args });
    expect((await call({ path })).structuredContent).toEqual({ status: "requested", path });
    expect(openNoteUri).toHaveBeenCalledWith("obsidian://open?path=" + encodeURIComponent(await realpath(join(root, path))));
    for (const args of [{ path: "../outside.md" }, { path: "Wiki/missing.md" }, { path, url: "https://untrusted.example" }]) {
      expect((await call(args)).isError).toBe(true);
    }
    expect(openNoteUri).toHaveBeenCalledTimes(1);
    vi.mocked(openNoteUri).mockRejectedValueOnce(new Error("Obsidian protocol unavailable"));
    expect((await call({ path })).isError).toBe(true);
    expect(await f.client.activity()).toEqual([]);
  } finally {
    await client.close(); await f.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
