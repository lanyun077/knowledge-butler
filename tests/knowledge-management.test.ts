import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { testSharedVault } from "./shared-vault-fixture";
import { startKnowledgeService } from "../src/knowledge-service";
import { handoffText } from "./handoff-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const accept = async (): Promise<ElicitResult> => ({ action: "accept", content: { confirm: true } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-management-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(join(root, "Projects")); await mkdir(join(root, "Wiki")); await mkdir(join(root, "Inbox"));
  await writeFile(join(root, "Projects/one.md"), "---\nstatus: Active\n---\n# One\n- [x] A\n- [ ] B\n```md\n- [x] ignored\n```\n## Progress\n\nSaved progress.\n\n## Logs\nUnrelated log.\n");
  await writeFile(join(root, "Projects/two.md"), "# Two\n");
  await writeFile(join(root, "Wiki/topic.md"), "# Topic\nOriginal claim.\n");
  const shared = await testSharedVault(root); cleanup.push(shared.dispose);
  async function connect(respond: () => Promise<ElicitResult> = accept) {
    const client = new Client({ name: "management-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, respond);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } } }));
    cleanup.push(() => client.close()); return client;
  }
  return { root, ...shared, connect };
}
async function call(client: Client, name: string, args: object = {}) {
  const value = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args } }));
  const text = value.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (value.isError) throw new Error(text);
  return value.structuredContent ?? JSON.parse(text);
}
async function changed(f: Awaited<ReturnType<typeof fixture>>) {
  const before = await f.client.read("Wiki/topic.md");
  const plan = await f.client.planUpdate(before.path, before.version, "# Topic\nUpdated claim.\n");
  await f.client.execute(plan.id); return { before, plan };
}

describe("shared management home and trusted controls", () => {
  it("returns ordered home sections with real source relations, task counts and saved progress without granting reads", async () => {
    const f = await fixture(), mcp = await f.connect();
    const source = await f.client.captureHandoff(handoffText("未知"));
    const target = await f.client.read("Wiki/topic.md");
    const plan = await f.client.planInbox({ sourcePath: source.path, sourceVersion: source.version, targetPath: target.path, targetVersion: target.version, content: "Useful addition", reason: "Synthetic source relation" });
    await f.client.setProjectPinned("Projects/one.md", true);
    const before = await f.client.activity();
    const home = await call(mcp, "learning_manage");
    expect(Object.keys(home.home)).toEqual(["pending", "sources", "pinned", "missingPins", "knowledge", "learning", "records"]);
    expect(home.home.pending.items[0]).toMatchObject({ planId: plan.id, status: "pending", action: "追加", origin: "mcp" });
    expect(home.home.sources.items[0]).toMatchObject({ path: source.path, sourceStatus: "有待保存方案", relatedPlans: [{ planId: plan.id }] });
    expect(home.home.pinned.items[0]).toMatchObject({ status: "Active", tasks: { completed: 1, total: 2 }, progressExcerpt: "Saved progress." });
    expect(home.home.pinned.items[0].progressExcerpt).not.toContain("Unrelated log.");
    expect(JSON.stringify(home)).not.toContain("sessionId");
    expect(JSON.stringify(home.home.pending)).not.toContain("before");
    const proposed = await call(mcp, "learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/new.md", content: "No receipts", reason: "Test boundary" }).catch(error => error);
    expect(proposed).toMatchObject({ status: "pending" });
    expect(await f.client.activity()).toEqual(before);
  });

  it("refreshes stale pending states and pages sources and records without inventing timestamps", async () => {
    const f = await fixture();
    const note = await f.client.read("Wiki/topic.md");
    const plan = await f.client.planUpdate(note.path, note.version, "Proposed change");
    await writeFile(join(f.root, note.path), "External edit");
    for (let i = 0; i < 12; i++) await writeFile(join(f.root, `Inbox/manual-${i}.md`), `# Source ${i}\n`);
    await writeFile(join(f.root, "Inbox/broken.md"), "---\ntype: [unclosed\n---\nBroken source");
    const home = await f.client.management();
    expect(home.home?.pending.total).toBe(0);
    const plans = await f.client.management("plans");
    expect(plans.page?.items[0]).toMatchObject({ planId: plan.id, status: "stale" });
    const first = await f.client.management("sources"), next = await f.client.management("sources", "", first.page!.nextOffset!);
    expect(first.page).toMatchObject({ total: 13, nextOffset: 10 });
    expect(next.page).toMatchObject({ total: 13, nextOffset: null });
    expect([...first.page!.items, ...next.page!.items]).toHaveLength(13);
    expect(first.page!.items[0]).toMatchObject({ path: "Inbox/broken.md", reuse: { kind: "unknown" }, sourceStatus: "材料格式待核对" });
    expect(first.page!.items[0]).not.toHaveProperty("savedAt");
    expect((await f.client.management("sources", "manual-11")).page?.total).toBe(1);
  });

  it("shares concurrent pins, persists restart and permits explicit removal of a missing pin without modifying notes", async () => {
    const f = await fixture(), one = await readFile(join(f.root, "Projects/one.md"), "utf8");
    await Promise.all([f.client.setProjectPinned("Projects/one.md", true), f.client.setProjectPinned("Projects/two.md", true)]);
    expect((await f.client.management()).home?.pinned.total).toBe(2);
    await f.service.close(); const restarted = await startKnowledgeService(f.config); cleanup.push(restarted.close);
    const fresh = await f.connect();
    expect((await call(fresh, "learning_manage")).home.pinned.total).toBe(2);
    expect(await readFile(join(f.root, "Projects/one.md"), "utf8")).toBe(one);
    await unlink(join(f.root, "Projects/two.md"));
    expect((await call(fresh, "learning_manage")).home.missingPins).toEqual(["Projects/two.md"]);
    await call(fresh, "learning_pin_project", { path: "Projects/two.md", pinned: false });
    expect((await f.client.management()).home?.missingPins).toEqual([]);
  });

  it("pins without a second prompt and rejects unknown approval fields", async () => {
    const f = await fixture(), decline = await f.connect(async () => ({ action: "decline" }));
    expect(await call(decline, "learning_pin_project", { path: "Projects/one.md", pinned: true })).toEqual({ status: "completed", confirmation: "not-required", paths: ["Projects/one.md"] });
    expect((await f.client.management()).home?.pinned.total).toBe(1);
    const accepted = await f.connect();
    await expect(call(accepted, "learning_pin_project", { path: "Projects/one.md", pinned: true, approved: true })).rejects.toThrow();
    await call(accepted, "learning_pin_project", { path: "Projects/one.md", pinned: true });
    expect((await f.client.management()).home?.pinned.total).toBe(1);
    await expect(f.client.setProjectPinned("Wiki/topic.md", true)).rejects.toThrow(/projects/);
    await expect(f.client.setProjectPinned("../outside.md", false)).rejects.toThrow(/Unsafe/);
  });

  it("previews full restore text and requires a fresh connection preview plus human confirmation", async () => {
    const f = await fixture(), { before, plan } = await changed(f), decline = await f.connect(async () => ({ action: "cancel" }));
    await expect(call(decline, "learning_request_restore", { operationId: plan.id })).rejects.toThrow(/Preview/);
    const preview = await call(decline, "learning_preview_restore", { operationId: plan.id });
    expect(preview).toMatchObject({ before: plan.after, after: before.content });
    expect(await call(decline, "learning_request_restore", { operationId: plan.id })).toMatchObject({ status: "cancelled" });
    expect((await f.client.read(before.path)).content).toBe(plan.after);
    const fresh = await f.connect();
    await expect(call(fresh, "learning_request_restore", { operationId: plan.id })).rejects.toThrow(/Preview/);
    await call(fresh, "learning_preview_restore", { operationId: plan.id });
    expect(await call(fresh, "learning_request_restore", { operationId: plan.id })).toMatchObject({ status: "completed", kind: "restore" });
    expect((await f.client.read(before.path)).content).toBe(before.content);
    await expect(call(fresh, "learning_request_restore", { operationId: plan.id })).rejects.toThrow(/Preview/);
  });

  it("rejects later edits and altered backups after a restore preview", async () => {
    const f = await fixture(), { before, plan } = await changed(f);
    const mcp = await f.connect(async () => { await writeFile(join(f.root, before.path), "Later external edit"); return accept(); });
    await call(mcp, "learning_preview_restore", { operationId: plan.id });
    expect(await call(mcp, "learning_request_restore", { operationId: plan.id })).toMatchObject({ status: "failed", error: expect.stringMatching(/changed/i) });
    expect((await f.client.read(before.path)).content).toBe("Later external edit");
    await writeFile(join(f.root, before.path), plan.after);
    await writeFile(join(f.root, `.ai-learning-os/backups/${plan.id}.md`), "Tampered backup");
    await expect(call(mcp, "learning_preview_restore", { operationId: plan.id })).rejects.toThrow(/changed|integrity/i);
  });

  it("allows personal saves in the current manager while original DSH cards retain ownership checks", async () => {
    const f = await fixture(), mcp = await f.connect();
    const owner = { scope: "synthetic-scope", cwd: f.root, sessionId: "original-dsh-chat", kind: "daily" as const };
    const identity = await f.client.proposeAssistant(owner, "planDailyAppend", ["2099-11-03", "Owned proposal"], new AbortController().signal);
    expect(await f.client.inspectPlan(identity.planId)).toMatchObject({ status: "pending", plan: { after: expect.stringContaining("Owned proposal") } });
    expect((await f.client.management("plans")).page?.items[0]).toMatchObject({ origin: "dsh", planId: identity.planId });
    await expect(f.client.execute(identity.planId)).rejects.toThrow(/归属/);
    expect(await call(mcp, "learning_request_confirmation", { planId: identity.planId, revision: 1 })).toMatchObject({ status: "completed", confirmation: "not-required" });
    const result = await call(mcp, "learning_manage", { view: "plans" });
    expect(result.page).toMatchObject({ items: [], total: 0, nextOffset: null });
    expect((await f.client.management()).home?.pending.total).toBe(0);
    expect(JSON.stringify(result)).not.toContain(owner.sessionId);
    expect(await f.client.activity()).toHaveLength(1);
  });

  it("exposes safe settings and rejects invalid management views and offsets", async () => {
    const f = await fixture(), mcp = await f.connect();
    const settings = await call(mcp, "learning_manage", { view: "settings" });
    expect(settings.settings).toMatchObject({ folders: { knowledge: "Wiki" }, service: { vaultId: f.config.vaultId } });
    expect(JSON.stringify(settings)).not.toContain(f.config.token);
    await expect(call(mcp, "learning_manage", { view: "shell" })).rejects.toThrow();
    await expect(call(mcp, "learning_manage", { offset: -1 })).rejects.toThrow();
    await expect(f.client.management("home", "", 0.5)).rejects.toThrow(/Invalid/);
  });
});
