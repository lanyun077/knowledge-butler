import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { managerMime, managerSnapshot, managerUri, managerPlan, managerRestore, managerOperationResult, managerPinResult } from "../src/knowledge-manager-contract";
import { testSharedVault } from "./shared-vault-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
let directory: string, worker: string;
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["build-manager.mjs"]);
  await mkdir("node_modules/.cache", { recursive: true });
  directory = await mkdtemp(resolve("node_modules/.cache/manager-test-")); worker = join(directory, "bridge.mjs");
  await build({ stdin: { contents: "import { knowledgeStdio } from './src/knowledge-stdio'; await knowledgeStdio(JSON.parse(process.argv[2]));", resolveDir: process.cwd() },
    outfile: worker, bundle: true, packages: "external", platform: "node", format: "esm", target: "es2022" });
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function call(client: Client, name: string, args: object = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args } }));
  if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
  return result;
}
async function stdio(url: string, token: string, capabilities: ClientCapabilities, respond?: (message: string) => Promise<ElicitResult>) {
  const client = new Client({ name: "synthetic-ui-host", version: "1" }, { capabilities });
  if (respond) client.setRequestHandler(ElicitRequestSchema, request => respond(request.params.message));
  cleanup.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [worker, JSON.stringify({ url, token })], stderr: "pipe" }));
  return client;
}
const uiCapability = { mimeTypes: [managerMime] };

describe("U2 shared manager", () => {
  it("combines real save events and unlogged source notes, preserves provenance and supplies separate home modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-manager-records-"));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    for (const folder of ["Wiki", "Inbox", "Learning", "Projects"]) await mkdir(join(root, folder));
    const sourceContent = '---\ntype: article-source\nsourceUrl: https://example.com/actual-source\nsourceName: Reading\n---\n# Source\nA real declared claim.';
    for (let index = 0; index < 12; index++) await writeFile(join(root, `Inbox/source-${index}.md`), sourceContent);
    await writeFile(join(root, "Wiki/topic.md"), "# Topic\nOriginal");
    await writeFile(join(root, "Learning/goal.md"), "# Goal\n- [ ] Practice");
    await writeFile(join(root, "Projects/one.md"), "# Project");
    const f = await testSharedVault(root); cleanup.push(f.dispose);
    const source = await f.client.read("Inbox/source-0.md"), target = await f.client.read("Wiki/topic.md");
    const plan = await f.client.planInbox({ sourcePath: source.path, sourceVersion: source.version, targetPath: target.path, targetVersion: target.version, content: "Supported addition", reason: "Keep the original and add the source claim" });
    await f.client.execute(plan.id);
    const activity = await f.client.activity();
    const client = await stdio(f.config.url, f.config.token, {});
    const home = managerSnapshot.parse((await call(client, "learning_open_manager")).structuredContent);
    expect(home.management!.home).toMatchObject({ learning: { total: 1 }, knowledge: { total: 1 }, records: { total: 13, nextOffset: 10 } });
    const records = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "records" })).structuredContent).management!.page!;
    expect(records.items[0]).toMatchObject({ recordId: plan.id, path: target.path, savedAt: activity[0].at, summary: "Keep the original and add the source claim", origin: expect.stringContaining("https://example.com/actual-source"), sourcePath: source.path, sourceState: "版本未变" });
    expect(records.items[1]).not.toHaveProperty("savedAt");
    expect(records.items[1]).toMatchObject({ summary: "A real declared claim." });
    expect(managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "records", offset: 10 })).structuredContent).management!.page!.items).toHaveLength(3);
    await writeFile(join(root, source.path), sourceContent.replace("actual-source", "later-source"));
    const changed = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "records", query: target.path })).structuredContent).management!.page!.items[0];
    expect(changed).toMatchObject({ sourcePath: source.path, sourceState: "来源已修改" });
    expect(changed).not.toHaveProperty("origin");
    await rm(join(root, source.path));
    const missing = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "records", query: target.path })).structuredContent).management!.page!.items[0];
    expect(missing).toMatchObject({ sourcePath: source.path, sourceState: "来源已缺失" });
    expect(await f.client.activity()).toEqual(activity);
  }, 20000);

  it("carries structured previews and native confirmations through STDIO for save, pin, restore and explicit cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-manager-controls-"));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    await mkdir(join(root, "Wiki")); await mkdir(join(root, "Projects"));
    await writeFile(join(root, "Wiki/topic.md"), "Original text");
    await writeFile(join(root, "Projects/one.md"), "# One");
    const f = await testSharedVault(root); cleanup.push(f.dispose);
    let response: ElicitResult = { action: "cancel" }; const messages: string[] = [];
    const client = await stdio(f.config.url, f.config.token, { extensions: { "io.modelcontextprotocol/ui": uiCapability }, elicitation: { form: {} } }, async message => { messages.push(message); return response; });
    await client.listTools(); // Enable the SDK's advertised output-schema validation before exercising controls.
    const home = managerSnapshot.parse((await call(client, "learning_open_manager")).structuredContent);
    expect(home.canConfirm).toBe(true);
    const note = await f.client.read("Wiki/topic.md"), plan = await f.client.planUpdate(note.path, note.version, "");
    const identity = { planId: plan.id, revision: 1 };
    const preview = managerPlan.parse((await call(client, "learning_preview", identity)).structuredContent);
    expect(preview.plan).toMatchObject({ before: note.content, after: plan.after });
    expect(managerPlan.parse((await call(client, "learning_request_confirmation", identity)).structuredContent)).toMatchObject({ status: "pending", confirmation: "cancelled" });
    expect((await f.client.read(note.path)).content).toBe(note.content);
    response = { action: "accept", content: { confirm: true } };
    expect(managerPlan.parse((await call(client, "learning_request_confirmation", identity)).structuredContent)).toMatchObject({ status: "completed", confirmation: "accepted" });
    expect(messages.at(-1)).toContain(plan.before); expect(messages.at(-1)).toContain(plan.after);
    expect(managerPlan.parse((await call(client, "learning_request_confirmation", identity)).structuredContent).confirmation).toBe("already-finished");
    expect(await f.client.activity()).toHaveLength(1);
    expect(managerPinResult.parse((await call(client, "learning_pin_project", { path: "Projects/one.md", pinned: true })).structuredContent)).toMatchObject({ status: "completed", confirmation: "not-required", paths: ["Projects/one.md"] });
    const restore = managerRestore.parse((await call(client, "learning_preview_restore", { operationId: plan.id })).structuredContent);
    expect(restore).toMatchObject({ before: plan.after, after: note.content });
    expect(managerOperationResult.parse((await call(client, "learning_request_restore", { operationId: plan.id })).structuredContent)).toMatchObject({ status: "completed", confirmation: "accepted" });
    expect((await f.client.read(note.path)).content).toBe(note.content);
    const pending = await f.client.planUpdate(note.path, (await f.client.read(note.path)).version, "Cancelled text");
    expect(managerPlan.parse((await call(client, "learning_cancel", { planId: pending.id, revision: 1 })).structuredContent).status).toBe("cancelled");
    expect((await f.client.read(note.path)).content).toBe(note.content);
  }, 20000);
  it("serves actual shared pages and version-bound Unicode bodies without writes or model read receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-manager-"));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const f = await testSharedVault(root); cleanup.push(f.dispose);
    await mkdir(join(root, "Inbox"), { recursive: true });
    await mkdir(join(root, "Wiki"), { recursive: true });
    for (let i = 0; i < 12; i++) await writeFile(join(root, `Inbox/source-${i}.md`), `# Source ${i}\nClaim ${i}`);
    const content = "# Long note\n" + "😀资料".repeat(6000);
    await writeFile(join(root, "Wiki/long.md"), content);
    const source = await f.client.read("Inbox/source-0.md");
    const proposal = await f.client.planInbox({ sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/saved.md", content: "Saved claim", reason: "Synthetic provenance" });
    await f.client.execute(proposal.id);
    const before = await readdir(root), activity = await f.client.activity();
    const client = await stdio(f.config.url, f.config.token, { extensions: { "io.modelcontextprotocol/ui": uiCapability } });
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "learning_open_manager")).toMatchObject({
      _meta: { ui: { resourceUri: managerUri } }, annotations: { readOnlyHint: true }, outputSchema: { type: "object" },
    });
    expect(tools.find(tool => tool.name === "learning_manager_probe")?._meta).toEqual({ ui: { visibility: ["app"] } });
    expect(tools.find(tool => tool.name === "learning_manage")?._meta).toBeUndefined();
    expect((await client.listResources()).resources).toContainEqual(expect.objectContaining({ uri: managerUri, mimeType: managerMime }));
    const resource = (await client.readResource({ uri: managerUri })).contents[0];
    expect(resource).toMatchObject({ mimeType: managerMime, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
    expect(resource).toHaveProperty("text", await readFile("dist/knowledge-manager.html", "utf8"));
    expect(JSON.stringify(resource)).not.toContain(f.config.token);
    const home = managerSnapshot.parse((await call(client, "learning_open_manager")).structuredContent);
    expect(home).toMatchObject({ stage: "U2", management: { home: { sources: { total: 12, nextOffset: 10 } } } });
    expect(home).not.toHaveProperty("synthetic");
    const first = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "sources" })).structuredContent);
    const second = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "sources", offset: 10 })).structuredContent);
    expect([...first.management!.page!.items, ...second.management!.page!.items]).toHaveLength(12);
    expect(second.management!.page!.nextOffset).toBeNull();
    expect(managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "sources", query: "source-11" })).structuredContent).management!.page!.total).toBe(1);
    const detail = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "detail", path: "Wiki/long.md" })).structuredContent).detail!;
    const short = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "summary", path: detail.path })).structuredContent).detail!;
    expect(short.content).toBe(""); expect(short.summary!.length).toBeLessThanOrEqual(400);
    expect(short.openUri).toContain("obsidian://open?path="); expect(short.nextOffset).toBeNull();
    expect(JSON.stringify(short)).not.toContain(content.slice(-1000));
    const sky = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "universe" })).structuredContent).sky!;
    expect(sky.nodes.items).toContainEqual(expect.objectContaining({ path: detail.path, kind: "domain", uri: short.openUri }));
    expect(JSON.stringify(sky)).not.toContain(content.slice(-1000));
    expect(Array.from(detail.content)).toHaveLength(8000);
    let assembled = detail.content, offset = detail.nextOffset;
    while (offset !== null) {
      const page = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "detail", path: detail.path, version: detail.version, offset })).structuredContent).detail!;
      assembled += page.content; offset = page.nextOffset;
    }
    expect(assembled).toBe(content);
    await expect(call(client, "learning_plan_inbox", { sourcePath: detail.path, sourceVersion: detail.version, targetPath: "Wiki/new.md", content: "No receipt", reason: "UI is not model reading" })).rejects.toThrow(/Inbox/);
    const saved = managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "detail", path: "Wiki/saved.md" })).structuredContent).detail!;
    expect(saved.provenance).toMatchObject({ total: 1, history: [{ source: { path: source.path, version: source.version, state: "unchanged" } }] });
    const peer = await stdio(f.config.url, f.config.token, {});
    await writeFile(join(root, "Inbox/later.md"), "# Added from another chat");
    expect(managerSnapshot.parse((await call(peer, "learning_open_manager")).structuredContent).management!.home!.sources.total).toBe(13);
    expect(managerSnapshot.parse((await call(client, "learning_manager_probe")).structuredContent).management!.home!.sources.total).toBe(13);
    await writeFile(join(root, detail.path), "Externally changed");
    await expect(call(client, "learning_manager_probe", { view: "detail", path: detail.path, version: detail.version, offset: 8000 })).rejects.toThrow(/changed/);
    expect(managerSnapshot.parse((await call(client, "learning_manager_probe", { view: "detail", path: detail.path })).structuredContent).detail!.content).toBe("Externally changed");
    await expect(call(client, "learning_manager_probe", { view: "detail", path: detail.path, offset: 1 })).rejects.toThrow(/version/);
    await expect(call(client, "learning_manager_probe", { view: "detail", path: "../outside.md" })).rejects.toThrow();
    expect(JSON.stringify((await call(client, "learning_manager_probe", { view: "settings" })).structuredContent)).not.toContain(f.config.token);
    await expect(call(client, "learning_open_manager", { approved: true })).rejects.toThrow();
    await expect(call(client, "learning_manager_probe", { view: "write" })).rejects.toThrow();
    expect((await readdir(root)).filter(name => name !== "Inbox")).toEqual(before.filter(name => name !== "Inbox"));
    expect(await f.client.activity()).toEqual(activity);
  });

  it("retains a useful text result when the host has no UI or elicitation capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-manager-text-"));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const f = await testSharedVault(root); cleanup.push(f.dispose);
    const client = new Client({ name: "text-only-host", version: "1" }, { capabilities: {} });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${f.config.token}` } } }));
    const result = await call(client, "learning_open_manager");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("全库管理") }));
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("learning_manage") }));
  });

  it.each([true, false])("negotiates only actual host UI/form capabilities before the upstream connection (UI=%s)", async supportsUi => {
    const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
    const token = randomBytes(32).toString("hex");
    const http = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      let session = sessions.get(String(req.headers["mcp-session-id"]));
      if (!session) {
        const server = new McpServer({ name: "capability-fixture", version: "1" });
        server.registerTool("inspect_capabilities", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: JSON.stringify(server.server.getClientCapabilities()) }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { sessions.set(id, { server, transport }); } });
        await server.connect(transport); session = { server, transport };
      }
      await session.transport.handleRequest(req, res);
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await Promise.all([...sessions.values()].map(session => session.server.close())); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
    const port = (http.address() as { port: number }).port;
    const capabilities: ClientCapabilities = supportsUi ? { extensions: { "io.modelcontextprotocol/ui": uiCapability }, elicitation: { form: {} } } : {};
    const client = await stdio(`http://127.0.0.1:${port}`, token, capabilities);
    const result = await call(client, "inspect_capabilities");
    const text = result.content.find(item => item.type === "text")!;
    expect(JSON.parse("text" in text ? text.text : "null")).toEqual(capabilities);
  });
});
