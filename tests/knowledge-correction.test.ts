import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { testSharedVault } from "./shared-vault-fixture";
import { handoffText } from "./handoff-fixture";
import { startKnowledgeService } from "../src/knowledge-service";
import type { CorrectionInput } from "../src/knowledge-correction";
import type { KnowledgeProposal } from "../src/knowledge-types";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const targetPath = "Wiki/topic.md";
const original = '\uFEFF---\r\nprojectPath: "Projects/one.md"\r\ncustom: keep # preserve\r\n---\r\n# Topic\r\n\r\nOld claim.\r\n\r\nKeep this evidence and task:\r\n- [x] verified example\r\n';
const accept = async (): Promise<ElicitResult> => ({ action: "accept", content: { confirm: true } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-correction-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(join(root, "Wiki"));
  await writeFile(join(root, targetPath), original);
  const shared = await testSharedVault(root);
  cleanups.push(shared.dispose);
  const source = await shared.client.captureHandoff(handoffText("未知"));
  const sourceText = (await shared.client.read(source.path)).content;
  const target = await shared.client.read(targetPath);
  const input: CorrectionInput = { sourcePath: source.path, sourceVersion: source.version, targetPath, targetVersion: target.version,
    changes: [{ before: "Old claim.", after: "Corrected claim, only under the tested conditions." }], reason: "Old claim was too broad; synthetic handoff records the tested conditions, not universal correctness." };
  async function connect(respond?: (message: string) => Promise<ElicitResult>) {
    const client = new Client({ name: "correction-synthetic", version: "1" }, { capabilities: respond ? { elicitation: { form: {} } } : {} });
    if (respond) client.setRequestHandler(ElicitRequestSchema, request => respond(request.params.message));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } },
    }));
    cleanups.push(() => client.close());
    return client;
  }
  return { root, ...shared, sourceText, input, connect };
}
async function call(client: Client, name: string, args: object = {}) {
  const value = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args } }));
  const text = value.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (value.isError) throw new Error(text);
  return value.structuredContent ?? JSON.parse(text);
}
async function readBoth(client: Client, input: CorrectionInput) {
  for (const path of [input.sourcePath, input.targetPath]) {
    let offset = 0;
    while (true) {
      const note = await call(client, "learning_read", { path, offset });
      if (note.nextOffset === null) break;
      offset = note.nextOffset;
    }
  }
}

describe("source-bound knowledge corrections (synthetic confirmation, not human approval)", () => {
  it("accepts accurate source and target versions across connections without receipt locks", async () => {
    const f = await fixture(), a = await f.connect(), b = await f.connect();
    expect(await call(a, "learning_plan_correction", f.input)).toMatchObject({ status: "pending" });
    await readBoth(a, f.input);
    expect(await call(b, "learning_plan_correction", f.input)).toMatchObject({ status: "pending" });
    await writeFile(join(f.root, targetPath), original + "x".repeat(6100));
    const target = await call(a, "learning_read", { path: targetPath });
    const input = { ...f.input, targetVersion: target.version };
    expect(await call(a, "learning_plan_correction", input)).toMatchObject({ status: "pending" });
    await readBoth(a, input);
    expect(await call(a, "learning_plan_correction", input)).toMatchObject({ status: "pending", revision: 1 });
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original + "x".repeat(6100));
  });

  it("previews actual replacements and preserves unlisted bytes, source, backup and traceable saved relations", async () => {
    const f = await fixture();
    let action: ElicitResult = { action: "decline" };
    const messages: string[] = [];
    const a = await f.connect(async message => { messages.push(message); return action; });
    await readBoth(a, f.input);
    const id = await call(a, "learning_plan_correction", f.input);
    const preview = await call(a, "learning_preview", { planId: id.planId, revision: id.revision }) as KnowledgeProposal;
    expect(preview.plan.before).toBe(original);
    expect(preview.plan.after.startsWith(original.replace("Old claim.", f.input.changes[0].after))).toBe(true);
    expect(preview.plan.after).toContain(f.input.sourceVersion);
    expect(preview.plan.after).toContain(f.input.targetVersion);
    expect(preview.plan.after).toContain(`../.ai-learning-os/plans/${id.planId}.json`);
    const identity = { planId: id.planId, revision: id.revision };
    expect(await call(a, "learning_request_confirmation", identity)).toMatchObject({ status: "completed", confirmation: "not-required" });
    expect((await call(a, "learning_request_confirmation", identity)).status).toBe("completed");
    expect(messages).toHaveLength(0);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(preview.plan.after);
    expect((await f.client.read(f.input.sourcePath)).content).toBe(f.sourceText);
    expect(await readFile(join(f.root, `.ai-learning-os/backups/${id.planId}.md`), "utf8")).toBe(original);
    const persisted = JSON.parse(await readFile(join(f.root, `.ai-learning-os/plans/${id.planId}.json`), "utf8"));
    expect(persisted.correction.changes).toEqual(f.input.changes);
    expect((await f.client.activity()).filter(item => item.path === targetPath)).toHaveLength(1);
    await f.client.restore(id.planId);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
    expect((await f.client.read(f.input.sourcePath)).content).toBe(f.sourceText);
  });

  it.each([
    ["missing match", [{ before: "Not here", after: "new" }], /match exactly once/],
    ["ambiguous match", [{ before: "\r\n", after: "\n" }], /nonempty/],
    ["overlap", [{ before: "Old claim.", after: "new" }, { before: "claim.", after: "different" }], /overlap/],
    ["frontmatter", [{ before: 'custom: keep # preserve', after: 'custom: changed' }], /match exactly once/],
    ["unchanged", [{ before: "Old claim.", after: "Old claim." }], /changed text/],
    ["unclosed Markdown", [{ before: "Old claim.", after: "```\nnew" }], /unclosed Markdown/],
  ] as const)("rejects %s without touching the knowledge note", async (_label, changes, error) => {
    const f = await fixture();
    await expect(f.client.planCorrection({ ...f.input, changes: [...changes] })).rejects.toThrow(error);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
    expect(await f.client.listPlans()).toHaveLength(0);
  });

  it("supports multiple nonoverlapping replacements and deletion, but rejects ambiguous repeated text", async () => {
    const f = await fixture();
    await writeFile(join(f.root, targetPath), original + "Old claim.\r\n");
    const repeated = await f.client.read(targetPath);
    await expect(f.client.planCorrection({ ...f.input, targetVersion: repeated.version })).rejects.toThrow(/match exactly once/);
    const plan = await f.client.planCorrection({ ...f.input, targetVersion: repeated.version, changes: [
      { before: "Old claim.\r\n\r\nKeep", after: "Scoped claim.\n\nKeep" },
      { before: "example\r\nOld claim.", after: "example" },
    ] });
    expect(plan.after).toContain("Scoped claim.\r\n\r\nKeep");
    expect(plan.after).not.toContain("Old claim.");
    expect((await f.client.execute(plan.id)).status).toBe("completed");
  });

  it("restricts source type, mapped target, current versions and model approval fields", async () => {
    const f = await fixture(), a = await f.connect();
    await mkdir(join(f.root, "Inbox"), { recursive: true });
    await writeFile(join(f.root, "Inbox/plain.md"), "# not a handoff\n");
    const plain = await f.client.read("Inbox/plain.md");
    await expect(f.client.planCorrection({ ...f.input, sourcePath: plain.path, sourceVersion: plain.version })).rejects.toThrow(/handoff-source/);
    await expect(f.client.planCorrection({ ...f.input, targetPath: "Projects/no.md" })).rejects.toThrow(/knowledge target/);
    await expect(f.client.planCorrection({ ...f.input, targetPath: "Wiki/missing.md" })).rejects.toThrow();
    await expect(f.client.planCorrection({ ...f.input, targetVersion: "0".repeat(64) })).rejects.toThrow(/target changed/);
    await expect(f.client.planCorrection({ ...f.input, sourceVersion: "0".repeat(64) })).rejects.toThrow(/source changed/);
    await readBoth(a, f.input);
    await expect(call(a, "learning_plan_correction", { ...f.input, approved: true })).rejects.toThrow();
    expect(await f.client.listPlans()).toHaveLength(0);
  });

  it.each(["source", "target"] as const)("rejects a changed %s during confirmation and preserves the external edit", async which => {
    const f = await fixture();
    f.input.changes = [{ before: "Old claim.", after: "" }];
    const path = which === "source" ? f.input.sourcePath : targetPath;
    const before = which === "source" ? f.sourceText : original;
    const a = await f.connect(async () => { await writeFile(join(f.root, path), before + "external change\n"); return accept(); });
    await readBoth(a, f.input);
    const plan = await call(a, "learning_plan_correction", f.input);
    await expect(call(a, "learning_request_confirmation", { planId: plan.planId, revision: 1 })).rejects.toThrow(/changed externally/);
    expect((await call(a, "learning_preview", { planId: plan.planId, revision: 1 })).status).toBe("stale");
    expect(await readFile(join(f.root, path), "utf8")).toBe(before + "external change\n");
    if (which === "source") expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });

  it("invalidates an in-flight approval on revision and keeps the new proposal pending until separately confirmed", async () => {
    const f = await fixture();
    f.input.changes = [{ before: "Old claim.", after: "" }];
    let arrived!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const a = await f.connect(async () => { arrived(); await gate; return accept(); }), b = await f.connect(accept);
    await readBoth(a, f.input); await readBoth(b, f.input);
    const first = await call(a, "learning_plan_correction", f.input);
    const pending = call(a, "learning_request_confirmation", { planId: first.planId, revision: 1 });
    const rejected = expect(pending).rejects.toThrow(/superseded/);
    await waiting;
    const next = await call(b, "learning_revise_correction", { planId: first.planId, revision: 1,
      input: { ...f.input, changes: [{ before: "Old claim.", after: "Revised scoped claim." }] } });
    release(); await rejected;
    expect(next).toMatchObject({ revision: 2, status: "pending" });
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
    const old = await call(b, "learning_preview", { planId: first.planId, revision: 1 });
    expect(old).toMatchObject({ status: "superseded", supersededBy: next.planId });
    await expect(call(b, "learning_revise_inbox", { planId: next.planId, revision: 2,
      input: { ...f.input, changes: undefined, content: "append" } })).rejects.toThrow();
    expect((await call(b, "learning_request_confirmation", { planId: next.planId, revision: 2 })).status).toBe("completed");
    expect(await readFile(join(f.root, targetPath), "utf8")).toContain("Revised scoped claim.");
  });

  it("restores a pending correction after restart, rejects old tickets and shares its completed state", async () => {
    const f = await fixture();
    const plan = await f.client.planCorrection(f.input);
    await f.service.close();
    const nextService = await startKnowledgeService(f.config); cleanups.push(() => nextService.close());
    await expect(f.client.execute(plan.id)).rejects.toThrow(/Preview/);
    const a = await f.connect(accept), b = await f.connect(accept);
    const restored = await call(a, "learning_preview", { planId: plan.id, revision: 1 });
    expect(restored).toMatchObject({ status: "pending", plan: { correction: { changes: f.input.changes } } });
    const results = await Promise.all([call(a, "learning_request_confirmation", { planId: plan.id, revision: 1 }),
      call(b, "learning_request_confirmation", { planId: plan.id, revision: 1 })]);
    expect(results.map(item => item.status)).toEqual(["completed", "completed"]);
    expect((await f.client.activity()).filter(item => item.path === targetPath)).toHaveLength(1);
    expect((await f.client.listPlans()).find(item => item.plan.id === plan.id)?.status).toBe("completed");
  });

  it("keeps cancelled corrections unwritten and marks a changed source stale on restart", async () => {
    const f = await fixture(), a = await f.connect(accept);
    await readBoth(a, f.input);
    const first = await call(a, "learning_plan_correction", f.input);
    await call(a, "learning_cancel", { planId: first.planId, revision: 1 });
    await expect(call(a, "learning_request_confirmation", { planId: first.planId, revision: 1 })).rejects.toThrow(/cancelled/);
    const second = await f.client.planCorrection(f.input);
    await f.service.close();
    await writeFile(join(f.root, f.input.sourcePath), f.sourceText + "changed\n");
    const next = await startKnowledgeService(f.config); cleanups.push(() => next.close());
    expect((await f.client.listPlans()).find(item => item.plan.id === second.id)?.status).toBe("stale");
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });
});
