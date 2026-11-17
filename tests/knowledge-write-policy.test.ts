import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { testSharedVault } from "./shared-vault-fixture";
import { writeReview } from "../src/knowledge-write-policy";
import { handoffText } from "./handoff-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(respond?: () => Promise<ElicitResult>) {
  const root = await mkdtemp(join(tmpdir(), "knowledge-write-policy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(join(root, "Wiki")); await mkdir(join(root, "Projects"));
  await writeFile(join(root, "Wiki/topic.md"), "# Topic\nOriginal claim.\n");
  await writeFile(join(root, "Projects/one.md"), "# Project\n");
  const shared = await testSharedVault(root); cleanup.push(shared.dispose);
  const mcp = new Client({ name: "personal-write-policy", version: "1" }, { capabilities: respond ? { elicitation: { form: {} } } : {} });
  if (respond) mcp.setRequestHandler(ElicitRequestSchema, respond);
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } } }));
  cleanup.push(() => mcp.close());
  async function call(name: string, args: object) {
    const value = await mcp.callTool({ name, arguments: { ...args } });
    if (value.isError) throw new Error(JSON.stringify(value.content));
    return value.structuredContent ?? JSON.parse((value.content as { text: string }[])[0].text);
  }
  async function removal() {
    const note = await shared.client.read("Wiki/topic.md");
    const plan = await shared.client.planUpdate(note.path, note.version, "");
    return { planId: plan.id, revision: 1 };
  }
  return { root, ...shared, call, removal };
}

describe("personal knowledge write policy", () => {
  it("saves new notes, additions, small corrections and pins without asking an available host", async () => {
    let prompts = 0;
    const f = await fixture(async () => { prompts++; return { action: "decline" }; });
    const source = await f.client.captureHandoff(handoffText("未知"));
    const input = { sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/new.md", content: "Old claim.", reason: "Requested summary" };
    const p = await f.call("learning_plan_inbox", input);
    expect(await f.call("learning_request_confirmation", { planId: p.planId, revision: 1 })).toMatchObject({ status: "completed", confirmation: "not-required" });
    const target = await f.client.read(input.targetPath);
    const correction = await f.call("learning_plan_correction", { ...input, content: undefined, targetVersion: target.version, changes: [{ before: "Old claim.", after: "Scoped claim." }] });
    expect(await f.call("learning_request_confirmation", { planId: correction.planId, revision: 1 })).toMatchObject({ status: "completed", confirmation: "not-required" });
    const daily = await f.call("learning_plan_business", { input: { operation: "daily", date: "2099-01-01", content: "User-reported progress" } });
    expect((await f.call("learning_request_confirmation", { planId: daily.planId, revision: 1 })).status).toBe("completed");
    expect(await f.call("learning_pin_project", { path: "Projects/one.md", pinned: true })).toMatchObject({ status: "completed", confirmation: "not-required" });
    expect((await f.client.read(target.path)).content).toContain("Scoped claim.");
    expect(await readFile(join(f.root, `.ai-learning-os/backups/${correction.planId}.md`), "utf8")).toBe(target.content);
    expect(prompts).toBe(0);
  });

  it("saves without elicitation and executes simultaneous/repeated requests only once", async () => {
    const f = await fixture();
    const p = await f.call("learning_plan_business", { input: { operation: "daily", date: "2099-01-01", content: "One record" } });
    const identity = { planId: p.planId, revision: 1 };
    const results = await Promise.all([f.call("learning_request_confirmation", identity), f.call("learning_request_confirmation", identity)]);
    expect(results.map(r => r.status)).toEqual(["completed", "completed"]);
    expect((await f.call("learning_request_confirmation", identity)).confirmation).toBe("already-finished");
    expect((await f.client.activity()).filter(r => r.id === p.planId)).toHaveLength(1);
    expect((await f.client.read("Daily/2099-01-01.md")).content.split("One record")).toHaveLength(2);
  });

  it("keeps destructive changes pending when a default host has no confirmation capability", async () => {
    const f = await fixture(), identity = await f.removal();
    expect(await f.call("learning_request_confirmation", identity)).toMatchObject({ status: "pending", confirmation: "required" });
    expect((await f.client.read("Wiki/topic.md")).content).toContain("Original claim.");
    expect(await f.client.activity()).toEqual([]);
  });

  it.each(["user-confirmed", "full-access"])("executes an accurately authorized destructive change and recovery (%s)", async authorization => {
    let prompts = 0;
    const f = await fixture(async () => { prompts++; return { action: "decline" }; });
    const before = await f.client.read("Wiki/topic.md"), identity = await f.removal();
    expect(await f.call("learning_request_confirmation", { ...identity, authorization })).toMatchObject({ status: "completed", confirmation: authorization });
    expect((await f.client.read(before.path)).content).toBe("");
    await expect(f.call("learning_request_restore", { operationId: identity.planId, authorization })).rejects.toThrow(/Preview/);
    await f.call("learning_preview_restore", { operationId: identity.planId });
    expect(await f.call("learning_request_restore", { operationId: identity.planId, authorization })).toMatchObject({ status: "completed", confirmation: authorization });
    expect((await f.client.read(before.path)).content).toBe(before.content);
    expect(prompts).toBe(0);
  });

  it("Full authorization still refuses changed targets and altered restore previews", async () => {
    const f = await fixture(), identity = await f.removal();
    await writeFile(join(f.root, "Wiki/topic.md"), "External change");
    await expect(f.call("learning_request_confirmation", { ...identity, authorization: "full-access" })).rejects.toThrow(/changed externally/);
    expect((await f.client.read("Wiki/topic.md")).content).toBe("External change");
    const next = await f.removal();
    await f.call("learning_request_confirmation", { ...next, authorization: "full-access" });
    await f.call("learning_preview_restore", { operationId: next.planId });
    await writeFile(join(f.root, "Wiki/topic.md"), "Keep newer text");
    await expect(f.call("learning_request_restore", { operationId: next.planId, authorization: "full-access" })).rejects.toThrow(/changed/);
    expect((await f.client.read("Wiki/topic.md")).content).toBe("Keep newer text");
  });

  it("distinguishes metadata and additions from extensive replacements, including correction provenance", () => {
    const before = "Text. ".repeat(600);
    const plan = { before, after: before + "\nAddition" };
    expect(writeReview(plan)).toBeUndefined();
    expect(writeReview({ ...plan, before: "---\nstatus: Active\n---\n" + before, after: "---\nstatus: Paused\n---\n" + before })).toBeUndefined();
    expect(writeReview({ before, after: "Replacement" })).toBe("大范围改写已有正文");
    expect(writeReview({ before, after: "" })).toBe("删除已有正文");
    expect(writeReview({ before, after: "New", create: true })).toBeUndefined();
    expect(writeReview({ ...plan, correction: { changes: [{ before: "Text.", after: "Fact." }] } })).toBeUndefined();
  });
});
