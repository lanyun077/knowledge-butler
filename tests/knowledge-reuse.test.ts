import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { testSharedVault } from "./shared-vault-fixture";
import { handoffText } from "./handoff-fixture";
import { startKnowledgeService } from "../src/knowledge-service";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const targetPath = "Wiki/复用 topic.md";
const accept = async (): Promise<ElicitResult> => ({ action: "accept", content: { confirm: true } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-reuse-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(join(root, "Projects")); await mkdir(join(root, "Wiki"));
  await writeFile(join(root, "Projects/one.md"), "# Project one\n");
  await writeFile(join(root, "Projects/two.md"), "# Project two\n");
  await writeFile(join(root, "Wiki/other.md"), '---\nprojectPath: "Projects/two.md"\n---\n# Reusable topic in another project\n');
  const shared = await testSharedVault(root, undefined, [{ directory: root, projectPath: "Projects/one.md" }]);
  cleanups.push(shared.dispose);
  const source = await shared.client.captureHandoff(handoffText("Projects/one.md"), root);
  async function connect(respond?: () => Promise<ElicitResult>) {
    const client = new Client({ name: "independent-reuse-chat", version: "1" }, { capabilities: respond ? { elicitation: { form: {} } } : {} });
    if (respond) client.setRequestHandler(ElicitRequestSchema, respond);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } } }));
    cleanups.push(() => client.close()); return client;
  }
  return { root, ...shared, source, connect };
}
async function call(client: Client, name: string, args: object = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args } }));
  const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (result.isError) throw new Error(text);
  return result.structuredContent ?? JSON.parse(text);
}
async function fullRead(client: Client, path: string) {
  let offset = 0, content = "", last;
  do {
    last = await call(client, "learning_read", { path, offset });
    content += last.content; offset = last.nextOffset;
  } while (offset !== null);
  return { ...last, content };
}
async function savedKnowledge(f: Awaited<ReturnType<typeof fixture>>, large = false) {
  const old = await f.connect(accept);
  await fullRead(old, f.source.path);
  const created = await call(old, "learning_plan_inbox", { sourcePath: f.source.path, sourceVersion: f.source.version,
    targetPath, content: "# Reusable topic\n\nOld claim.\n" + (large ? "Context stays unchanged.\n".repeat(300) : "Keep context.\n"), reason: "Synthetic sourced knowledge" });
  const creation = { planId: created.planId, revision: created.revision };
  await call(old, "learning_request_confirmation", creation);
  const before = await fullRead(old, targetPath);
  const input = { sourcePath: f.source.path, sourceVersion: f.source.version, targetPath, targetVersion: before.version,
    changes: [{ before: "Old claim.", after: "Scoped reusable claim." }], reason: "Only tested under stated conditions." };
  const corrected = await call(old, "learning_plan_correction", input);
  const correction = { planId: corrected.planId, revision: corrected.revision };
  await call(old, "learning_request_confirmation", correction);
  const saved = await f.client.read(targetPath);
  await old.close();
  return { creation, correction, saved, input };
}

describe("new-chat reuse from the shared Vault, without old conversation memory", () => {
  it("searches, fully reads and cites confirmed knowledge after restart, retaining correction and original-source relations without writes", async () => {
    const f = await fixture(), saved = await savedKnowledge(f, true);
    await f.service.close();
    const restarted = await startKnowledgeService(f.config); cleanups.push(() => restarted.close());
    const fresh = await f.connect();
    expect(await call(fresh, "learning_project_context", { projectDirectory: f.root })).toMatchObject({ projectPath: "Projects/one.md" });
    const notes = await call(fresh, "learning_search", { query: "Reusable topic", projectDirectory: f.root });
    expect(notes.map((note: { path: string }) => note.path)).toContain(targetPath);
    expect(notes.map((note: { path: string }) => note.path)).not.toContain("Wiki/other.md");
    const activity = await f.client.activity(), plans = await f.client.listPlans();
    const current = await fullRead(fresh, targetPath);
    expect(current.content).toBe(saved.saved.content);
    expect(current.reuse).toMatchObject({ kind: "knowledge", savedVersion: "recorded", record: { planId: saved.correction.planId } });
    const first = await call(fresh, "learning_provenance", { path: targetPath, version: current.version });
    expect(first).toMatchObject({ total: 2, nextOffset: 1 });
    expect(first.history[0]).toMatchObject({ planId: saved.correction.planId, action: "correct", matchesCurrent: true,
      beforeVersion: saved.input.targetVersion, source: { path: f.source.path, version: f.source.version, state: "unchanged" }, changes: saved.input.changes });
    const second = await call(fresh, "learning_provenance", { path: targetPath, version: current.version, offset: first.nextOffset });
    expect(second).toMatchObject({ nextOffset: null, history: [{ planId: saved.creation.planId, action: "create", matchesCurrent: false }] });
    expect(JSON.stringify(first)).not.toContain("sessionId");
    let uri: string | null = current.reference.uri, referenced = "";
    while (uri) {
      const resource = await fresh.readResource({ uri });
      const item = resource.contents[0];
      if (!("text" in item)) throw new Error("Expected a text note resource");
      const page = JSON.parse(item.text);
      expect(page.version).toBe(current.version);
      expect(page.content.length).toBeLessThanOrEqual(6000);
      referenced += page.content; uri = page.nextUri;
    }
    expect(referenced).toBe(current.content);
    const source = await fullRead(fresh, f.source.path);
    expect(source.reuse).toMatchObject({ kind: "source", sourceType: "handoff-source", savedVersion: "unrecorded" });
    expect(await f.client.activity()).toEqual(activity);
    expect(await f.client.listPlans()).toEqual(plans);
    expect((await f.client.read(targetPath)).version).toBe(current.version);
  });

  it("does not transfer old-chat read receipts or grant them through provenance and citation resources", async () => {
    const f = await fixture(), saved = await savedKnowledge(f), fresh = await f.connect();
    await call(fresh, "learning_provenance", { path: targetPath, version: saved.saved.version });
    const target = await call(fresh, "learning_read", { path: targetPath });
    const sourceUri = `learning://notes/${encodeURIComponent(f.source.path)}?version=${f.source.version}&offset=0`;
    await fresh.readResource({ uri: sourceUri });
    const input = { ...saved.input, targetVersion: target.version, changes: [{ before: "Scoped reusable claim.", after: "Another claim." }] };
    expect(await call(fresh, "learning_plan_correction", input)).toMatchObject({ status: "pending" });
    await fullRead(fresh, f.source.path);
    const plan = await call(fresh, "learning_plan_correction", input);
    expect(plan.status).toBe("pending");
    await call(fresh, "learning_cancel", { planId: plan.planId, revision: plan.revision });
    expect((await f.client.read(targetPath)).version).toBe(saved.saved.version);
  });

  it("does not promote manual notes, forged flags or source notes in the knowledge folder to confirmed knowledge", async () => {
    const f = await fixture(), fresh = await f.connect();
    const examples = [
      ["Wiki/manual.md", '---\nconfirmed: true\nstatus: completed\n---\n# Existing knowledge\n', "knowledge"],
      ["Wiki/source.md", '---\ntype: handoff-source\nconfirmed: true\n---\n# A source claim\n', "source"],
      ["Wiki/broken.md", '---\nstatus: [\n---\n# Broken\n', "unknown"],
      ["Wiki/unclosed.md", '---\nconfirmed: true\n# Missing YAML end\n', "unknown"],
      ["Projects/one.md", "# Project context\n", "context"],
    ];
    for (const [path, content, kind] of examples) {
      await writeFile(join(f.root, path), content);
      const read = await fullRead(fresh, path);
      expect(read.reuse).toMatchObject({ kind, savedVersion: "unrecorded" });
      expect((await call(fresh, "learning_provenance", { path, version: read.version })).history).toEqual([]);
    }
  });

  it("keeps pending, cancelled and superseded plans out of saved history", async () => {
    const f = await fixture(), saved = await savedKnowledge(f), a = await f.connect();
    await fullRead(a, targetPath); await fullRead(a, f.source.path);
    const input = { ...saved.input, targetVersion: saved.saved.version, changes: [{ before: "Scoped reusable claim.", after: "Pending claim." }] };
    const first = await call(a, "learning_plan_correction", input);
    const second = await call(a, "learning_revise_correction", { planId: first.planId, revision: 1, input: { ...input, reason: "Revised pending rationale" } });
    await call(a, "learning_cancel", { planId: second.planId, revision: second.revision });
    const history = await call(a, "learning_provenance", { path: targetPath, version: saved.saved.version });
    expect(history.total).toBe(2);
    expect(history.history[0].planId).toBe(saved.correction.planId);
    expect(history.reuse.record.planId).toBe(saved.correction.planId);
  });
  it("keeps a save receipt separate from material type even when saved metadata is malformed or declares a source", async () => {
    const f = await fixture();
    const path = "Wiki/saved-material.md";
    await writeFile(join(f.root, path), "# Original\n");
    for (const [content, kind] of [["---\ntype: [\n---\n# Malformed\n", "unknown"], ["---\ntype: handoff-source\n---\n# Source claim\n", "source"]]) {
      const before = await f.client.read(path);
      const plan = await f.client.planUpdate(path, before.version, content);
      expect((await f.client.execute(plan.id)).status).toBe("completed");
      const note = await f.client.read(path);
      expect(note.reuse).toMatchObject({ kind, savedVersion: "recorded", record: { planId: plan.id } });
      expect((await f.client.provenance(path, note.version)).history[0]).toMatchObject({ planId: plan.id, matchesCurrent: true });
    }
  });

  it("detects external note changes and explicit restoration without presenting an old correction as current", async () => {
    const f = await fixture(), saved = await savedKnowledge(f), fresh = await f.connect();
    await writeFile(join(f.root, targetPath), saved.saved.content + "External contribution.\n");
    await expect(call(fresh, "learning_provenance", { path: targetPath, version: saved.saved.version })).rejects.toThrow(/changed/);
    await expect(fresh.readResource({ uri: `learning://notes/${encodeURIComponent(targetPath)}?version=${saved.saved.version}&offset=0` })).rejects.toThrow(/changed/);
    const edited = await fullRead(fresh, targetPath);
    const history = await call(fresh, "learning_provenance", { path: targetPath, version: edited.version });
    expect(history.reuse.savedVersion).toBe("unrecorded");
    expect(history.history[0].matchesCurrent).toBe(false);
    // Restore first to the saved correction, then use the existing explicit backup restore.
    await writeFile(join(f.root, targetPath), saved.saved.content);
    await f.client.activity(); await f.client.restore(saved.correction.planId);
    const restored = await fullRead(fresh, targetPath);
    expect(restored.reuse.record.planId).toBe(saved.creation.planId);
    const correction = await call(fresh, "learning_provenance", { path: targetPath, version: restored.version });
    expect(correction.history[0].matchesCurrent).toBe(false);
    const creation = await call(fresh, "learning_provenance", { path: targetPath, version: restored.version, offset: correction.nextOffset });
    expect(creation.history[0].matchesCurrent).toBe(true);
  });

  it("reports changed and missing source versions without rewriting knowledge or fabricating old contents", async () => {
    const f = await fixture(), saved = await savedKnowledge(f), fresh = await f.connect();
    await writeFile(join(f.root, f.source.path), "# External replacement\n");
    const changed = await call(fresh, "learning_provenance", { path: targetPath, version: saved.saved.version });
    expect(changed.history[0].source).toMatchObject({ version: f.source.version, state: "changed" });
    expect(changed.history[0].source.currentVersion).not.toBe(f.source.version);
    await unlink(join(f.root, f.source.path));
    const missing = await call(fresh, "learning_provenance", { path: targetPath, version: saved.saved.version });
    expect(missing.history[0].source).toMatchObject({ state: "missing", path: f.source.path, version: f.source.version });
    expect(missing.history[0].source).not.toHaveProperty("currentVersion");
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(saved.saved.content);
  });

  it("rejects unsafe paths, wrong versions, invalid pages and unversioned citation resources", async () => {
    const f = await fixture(), saved = await savedKnowledge(f), fresh = await f.connect();
    for (const input of [
      { path: "../outside.md", version: saved.saved.version },
      { path: ".ai-learning-os/space.json", version: saved.saved.version },
      { path: targetPath, version: "wrong" },
      { path: targetPath, version: saved.saved.version, offset: -1 },
      { path: targetPath, version: saved.saved.version, offset: 100 },
    ]) await expect(call(fresh, "learning_provenance", input)).rejects.toThrow();
    await expect(fresh.readResource({ uri: `learning://notes/${encodeURIComponent(targetPath)}` })).rejects.toThrow();
    await expect(fresh.readResource({ uri: `learning://notes/${encodeURIComponent("../outside.md")}?version=${saved.saved.version}&offset=0` })).rejects.toThrow();
    await expect(fresh.readResource({ uri: `learning://notes/${encodeURIComponent(targetPath)}?version=${saved.saved.version}&offset=-1` })).rejects.toThrow();
    await expect(fresh.readResource({ uri: `learning://notes/${encodeURIComponent(targetPath)}?version=${saved.saved.version}&offset=999999` })).rejects.toThrow();
  });
});
