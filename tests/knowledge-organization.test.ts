import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseKnowledgeLinks, resolveKnowledgeLink } from "../src/knowledge-links";
import { KnowledgeIndex } from "../src/knowledge-organization";
import { VaultService } from "../src/vault";
import { parseKnowledgeTopic } from "../src/knowledge-topic";
import { testSharedVault } from "./shared-vault-fixture";
import type { KnowledgeCollection, KnowledgeQuery } from "../src/knowledge-organization-contract";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-organization-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const folder of ["Projects", "Learning", "Inbox", "Wiki"]) await mkdir(join(root, folder));
  const write = async (path: string, content: string | Buffer) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("Projects/one.md", "# One\n[[Inbox/材料 A#^first|材料]]\n[[Wiki/excluded]]\n[[Projects/two]]\n[[Learning/other]]\n[[不存在]]\n");
  await write("Projects/two.md", "# Do not automatically include another project\n");
  await write("Learning/other.md", "# Do not automatically include another learning goal\n");
  await write("Inbox/材料 A.md", "# 材料\nExplicit material.\n[[Wiki/deep]]\n");
  await write("Wiki/excluded.md", "# Excluded\n");
  await write("Wiki/deep.md", "# Do not expand a second hop\n");
  await write("Wiki/topic.md", "# Topic\nShort summary.\n## Group\n[[Inbox/材料 A#^first|材料]]\n");
  // A query that reads unrelated bodies would fail UTF-8 decoding here.
  await write("Wiki/unrelated.md", Buffer.from([0xff]));
  const vault = new VaultService(root), index = new KnowledgeIndex(vault, async () => undefined);
  return { root, write, vault, index };
}

describe("knowledge source scope and explicit links", () => {
  it("keeps an empty library collectable without fabricating a topic or blocking the template", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-empty-"));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const index = new KnowledgeIndex(new VaultService(root), async () => undefined);
    const result = await index.collect({ request: "整理知识" });
    expect(result.sources).toEqual({ items: [], total: 0, nextOffset: null });
    expect(result.links.items).toEqual([]); expect(result.unavailable.items).toEqual([]);
    expect(result.nextOffset).toBeNull(); expect(result.existingTopic).toBeUndefined();
    expect(result.reuse?.state).toBe("no-topic"); expect(result.template?.id).toBe("knowledge-organize-v1");
    await expect(index.query({ topicPath: "Wiki/missing.md" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses current sections without treating fenced examples, code IDs or duplicate IDs as knowledge", () => {
    const content = `<!-- learning-knowledge:start group-example -->
## 分组
### 实际条目
适用条件与人工补充。

^real

出处：[材料](../Inbox/source.md) · 版本：\`old-version\` · 字符 0–10

### 重复一
^duplicate

### 重复二
^duplicate

### 代码不是块
\`^code\`

\`\`\`md
### 伪造条目
^fake
<!-- learning-knowledge:start group-fake -->
\`\`\`
<!-- learning-knowledge:end group-example -->
<!-- learning-knowledge:start relations -->
| 起点 | 关系 | 终点 | 依据 |
| --- | --- | --- | --- |
| [[#^real]] | 补充 | [[#^missing]] | 显式：失效 |
| \`[[#^real]]\` | 引用 | [[#^real]] | 显式：代码样例不是关系 |
<!-- learning-knowledge:end relations -->`;
    const parsed = parseKnowledgeTopic(content);
    expect(parsed.items).toEqual([{ id: "real", title: "实际条目", group: "分组", summary: "适用条件与人工补充。", evidence: "出处：材料 · 版本：old-version · 字符 0–10" }]);
    expect(parsed.relations).toEqual([]); expect(parsed.invalidRelations).toBe(1);
  });
  it("parses wiki/relative/reference links and locators while ignoring YAML, code, embeds and external URLs", () => {
    const content = '\uFEFF---\nexample: "[[yaml]]"\n---\n# 标题\n[[材料 A#本节|别名]] [相对](../Inbox/材料%20A.md#%5Eblock) [引用][r]\n\n[r]: ../Wiki/定义.md\n\n`[[inline]]` ![[embed]] ![image](picture.md) \\[[escaped]]\n\n```md\n[[fenced]]\n```\n\n    [[indented]]\n\n[[#本节]] [网页](https://example.com)\n';
    const parsed = parseKnowledgeLinks("Projects/p.md", content);
    expect(parsed.links.map(link => link.target)).toEqual(["材料 A#本节", "../Inbox/材料%20A.md#%5Eblock", "../Wiki/定义.md", "#本节"]);
    expect(parsed.links[0]).toMatchObject({ label: "别名", line: 5, format: "wiki" });
    expect(parsed.outline).toEqual([{ title: "标题", depth: 1, line: 4 }]);
  });

  it("keeps ambiguous names unresolved, resolves Markdown relative to its source and rejects out-of-scope targets", () => {
    const paths = ["Wiki/同名.md", "Inbox/同名.md", "Inbox/材料 A.md", "Wiki/百分百%笔记.md", "Inbox/Wiki/同名.md"];
    const vault = new VaultService(join(tmpdir(), "knowledge-link-scope"));
    const resolve = (target: string, format: "wiki" | "markdown" = "wiki") => resolveKnowledgeLink({ sourcePath: "Inbox/source.md", target, format, origin: "markdown" }, paths, path => vault.isMappedNote(path));
    expect(resolve("同名").state).toBe("ambiguous");
    expect(resolve("同名.md", "markdown")).toMatchObject({ targetPath: "Inbox/同名.md", state: "resolved" });
    expect(resolve("../Inbox/材料%20A.md#%5Efirst", "markdown")).toMatchObject({ targetPath: "Inbox/材料 A.md", fragment: "^first", state: "resolved" });
    expect(resolve("../Private/secret.md", "markdown").state).toBe("outside-scope");
    expect(resolve("missing").state).toBe("missing");
    expect(resolve("%ZZ", "markdown").state).toBe("unsupported");
    expect(resolve("百分百%笔记")).toMatchObject({ targetPath: "Wiki/百分百%笔记.md", state: "resolved" });
    expect(resolve("Wiki/同名")).toMatchObject({ targetPath: "Wiki/同名.md", state: "resolved" });
    expect(resolve("file.pdf", "markdown").state).toBe("unsupported");
    expect(resolve("x".repeat(5000))).toMatchObject({ state: "unsupported", target: "x".repeat(4096) });
  });

  it("collects exactly one hop, honors exclusions and does not read linked unselected projects or unrelated bodies", async () => {
    const f = await fixture(), read = vi.spyOn(f.vault, "read"), list = vi.spyOn(f.vault, "list");
    const value = await f.index.collect({ projectPaths: ["Projects/one.md"], excludePaths: ["Wiki/excluded.md"], topicPath: "Wiki/topic.md" });
    expect(value.sources.items.map(note => note.path)).toEqual(["Inbox/材料 A.md", "Projects/one.md"]);
    expect(value.sources.items[0]).toMatchObject({ selected: false, linkedFrom: ["Projects/one.md"] });
    expect(value.links.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetPath: "Wiki/excluded.md", state: "excluded" }),
      expect.objectContaining({ targetPath: "Projects/two.md", state: "not-selected" }),
      expect.objectContaining({ targetPath: "Learning/other.md", state: "not-selected" }),
      expect.objectContaining({ target: "不存在", state: "missing" }),
    ]));
    expect(value).toMatchObject({ processing: "not-assessed", native: { state: "not-configured" }, existingTopic: { path: "Wiki/topic.md" } });
    expect(read.mock.calls.map(call => call[0]).sort()).toEqual(["Inbox/材料 A.md", "Projects/one.md", "Wiki/topic.md"].sort());
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps usable sources when one selection is missing and allows explicit additional projects/goals", async () => {
    const f = await fixture();
    const value = await f.index.collect({ projectPaths: ["Projects/one.md", "Projects/two.md"], learningPaths: ["Learning/other.md"], sourcePaths: ["Inbox/missing.md"] });
    expect(value.sources.items.map(note => note.path)).toEqual(expect.arrayContaining(["Projects/two.md", "Learning/other.md", "Inbox/材料 A.md"]));
    expect(value.unavailable.items).toEqual([{ path: "Inbox/missing.md", reason: "来源笔记不存在" }]);
    expect((await f.index.collect({ projectPaths: ["Projects/one.md"], excludePaths: ["Projects/one.md"] })).sources.total).toBe(0);
    expect((await f.index.collect({ sourcePaths: ["Wiki/topic.md"], topicPath: "Wiki/topic.md" })).sources.total).toBe(0);
    await expect(f.index.collect({ projectPaths: ["Inbox/材料 A.md"] })).rejects.toThrow("category");
    await expect(f.index.collect({ sourcePaths: ["../private.md"] })).rejects.toThrow("mapped");
    await expect(f.index.collect({ excludePaths: [".obsidian/secret.md"] })).rejects.toThrow("mapped");
  });

  it("returns bounded metadata pages and does not send long source bodies", async () => {
    const f = await fixture();
    const paths = Array.from({ length: 13 }, (_, i) => `Inbox/source-${i}.md`);
    for (const path of paths) await f.write(path, "# Source\n" + "正文内容".repeat(2000));
    const first = await f.index.collect({ sourcePaths: paths }), second = await f.index.collect({ sourcePaths: paths, offset: first.nextOffset! });
    expect(first.sources).toMatchObject({ total: 13, nextOffset: 10 });
    expect(first.sources.items).toHaveLength(10); expect(second.sources.items).toHaveLength(3); expect(second.nextOffset).toBeNull();
    expect(first.sources.items.every(note => note.summary.length <= 180)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("正文内容".repeat(100));
  });

  it("reuses parsed metadata, rereads changed notes and notices deletions without scanning other bodies", async () => {
    const f = await fixture(), read = vi.spyOn(f.vault, "read");
    const first = await f.index.query({ topicPath: "Wiki/topic.md" });
    expect(first.nodes.items.map(note => note.path)).toEqual(["Wiki/topic.md", "Inbox/材料 A.md"]);
    expect(read).toHaveBeenCalledTimes(2); read.mockClear();
    await f.index.query({ topicPath: "Wiki/topic.md" }); expect(read).not.toHaveBeenCalled();
    await f.write("Inbox/材料 A.md", "# 材料\nUpdated material with different size.\n");
    const updated = await f.index.query({ topicPath: "Wiki/topic.md" });
    expect(updated.nodes.items[1].version).not.toBe(first.nodes.items[1].version);
    expect(read.mock.calls.map(call => call[0])).toEqual(["Inbox/材料 A.md"]);
    await unlink(join(f.root, "Inbox/材料 A.md"));
    const deleted = await f.index.query({ topicPath: "Wiki/topic.md" });
    expect(deleted.nodes.items).toHaveLength(1); expect(deleted.links.items[0].state).toBe("missing");
  });

  it("supports ordinary Markdown outlines, version-bound paging and rebuilding the index after restart", async () => {
    const f = await fixture();
    await f.write("Wiki/outline.md", "# Plain note\n" + Array.from({ length: 12 }, (_, i) => `## Section ${i}\nText.\n`).join(""));
    const first = await f.index.query({ topicPath: "Wiki/outline.md", view: "mindmap" });
    expect(first.outline).toMatchObject({ total: 13, nextOffset: 10 }); expect(first.outline.items).toHaveLength(10);
    await expect(f.index.query({ topicPath: first.topic.path, view: "mindmap", offset: 10 })).rejects.toThrow("pinned");
    const next = await f.index.query({ topicPath: first.topic.path, view: "mindmap", offset: 10, version: first.topic.version });
    expect(next.outline.items).toHaveLength(3); expect(next.nextOffset).toBeNull();
    const fresh = new KnowledgeIndex(f.vault, async () => undefined);
    expect((await fresh.query({ topicPath: first.topic.path, view: "document" })).topic).toEqual(first.topic);
    await f.write(first.topic.path, "# Edited externally\n");
    await expect(f.index.query({ topicPath: first.topic.path, version: first.topic.version })).rejects.toThrow("changed");
    await expect(f.index.query({ topicPath: first.topic.path, offset: -1 })).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(f.index.query({ topicPath: first.topic.path }, abort.signal)).rejects.toThrow();
  });

  it("pages one-hop graphs by links and keeps node totals and every edge endpoint usable", async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) await f.write(`Wiki/related-${i}.md`, `# Related ${i}\n`);
    await f.write("Wiki/graph.md", "# Graph\n" + Array.from({ length: 12 }, (_, i) => `[[Wiki/related-${i}]]`).join("\n"));
    const first = await f.index.query({ topicPath: "Wiki/graph.md" });
    expect(first.nodes).toMatchObject({ total: 13, nextOffset: 10 }); expect(first.nodes.items).toHaveLength(11);
    const next = await f.index.query({ topicPath: first.topic.path, version: first.topic.version, offset: first.nextOffset! });
    expect(next.nodes.items).toHaveLength(3); expect(next.links.items).toHaveLength(2); expect(next.nextOffset).toBeNull();
    for (const page of [first, next]) for (const link of page.links.items) expect(page.nodes.items.map(note => note.path)).toEqual(expect.arrayContaining([link.sourcePath, link.targetPath]));
  });
});

describe("knowledge tools through the shared service", () => {
  it("shares collection/query over authenticated host RPC and MCP without writing or exposing bodies", async () => {
    const f = await fixture(), shared = await testSharedVault(f.root); cleanup.push(shared.dispose);
    const mcp = new Client({ name: "knowledge-organization-test", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } } }));
    cleanup.push(() => mcp.close());
    const call = async <T>(name: string, args: object): Promise<T> => {
      const result = await mcp.callTool({ name, arguments: { ...args } });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return JSON.parse((result.content as { type: string; text: string }[])[0].text);
    };
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["learning_knowledge_collect", "learning_knowledge_query"]));
    const input = { projectPaths: ["Projects/one.md"], excludePaths: ["Wiki/excluded.md"] };
    expect(await call<KnowledgeCollection>("learning_knowledge_collect", input)).toEqual(await shared.client.collectKnowledge(input));
    const query = { topicPath: "Wiki/topic.md", view: "document" as const };
    expect(await call<KnowledgeQuery>("learning_knowledge_query", query)).toEqual(await shared.client.queryKnowledge(query));
    await expect(call("learning_knowledge_query", { topicPath: "../outside.md" })).rejects.toThrow();
    await expect(shared.client.collectKnowledge({ projectPaths: ["Projects/one.md"], offset: -1 })).rejects.toThrow();
    expect(await shared.client.activity()).toEqual([]); expect(await shared.client.listPlans()).toEqual([]);
  });

  it("reuses configured Obsidian metadata and safely falls back when remote text or service is unavailable", async () => {
    const f = await fixture(), requests: string[] = [];
    await f.write("Wiki/中文 #与%.md", "# Native file with punctuation\n");
    let changed = false, available = true;
    const server = createServer(async (request, response) => {
      requests.push(request.url!);
      if (request.headers.authorization !== "Bearer synthetic-native-key") { response.writeHead(401).end(); return; }
      if (!available) { response.writeHead(503).end(); return; }
      const path = decodeURIComponent(request.url!.slice("/vault/".length));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ path, content: changed ? "Different vault text" : await readFile(join(f.root, path), "utf8"), tags: [], frontmatter: {},
        links: ["Wiki/deep.md", "Wiki/中文 #与%.md", "Private/secret.md"], backlinks: ["Wiki/excluded.md"], unresolvedLinks: ["Wiki/unknown.md"] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as { port: number }).port;
    await f.write(".obsidian/plugins/obsidian-local-rest-api/data.json", JSON.stringify({ apiKey: "synthetic-native-key", insecurePort: port, enableInsecureServer: true, bindingHost: "127.0.0.1" }));
    const shared = await testSharedVault(f.root); cleanup.push(shared.dispose);
    const first = await shared.client.queryKnowledge({ topicPath: "Wiki/topic.md" });
    expect(first.native.state).toBe("available");
    expect(first.links.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "Wiki/topic.md", targetPath: "Wiki/deep.md", origin: "obsidian" }),
      expect.objectContaining({ sourcePath: "Wiki/topic.md", targetPath: "Wiki/中文 #与%.md", state: "resolved", origin: "obsidian" }),
      expect.objectContaining({ sourcePath: "Wiki/excluded.md", targetPath: "Wiki/topic.md", origin: "obsidian" }),
    ]));
    expect(JSON.stringify(first)).not.toContain("synthetic-native-key"); expect(JSON.stringify(first)).not.toContain("Private/secret");
    changed = true;
    const mismatch = await shared.client.queryKnowledge({ topicPath: "Wiki/topic.md" });
    expect(mismatch.native.state).toBe("unavailable"); expect(mismatch.links.items[0]).toMatchObject({ origin: "markdown", targetPath: "Inbox/材料 A.md" });
    available = false;
    const offline = await shared.client.queryKnowledge({ topicPath: "Wiki/topic.md" });
    expect(offline.native.state).toBe("unavailable"); expect(offline.nodes.items).toHaveLength(2);
    expect(requests.every(path => path.startsWith("/vault/"))).toBe(true);
  });
});
