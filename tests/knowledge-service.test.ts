import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { loadKnowledgeConfig, type KnowledgeConfig } from "../src/knowledge-config";
import { startKnowledgeService } from "../src/knowledge-service";
import { sharedVault } from "../src/knowledge-client";
import { VaultService } from "../src/vault";
import { serviceStatus } from "../src/knowledge-launcher";

let bundleDir: string;
let entry: string;
const cleanups: (() => Promise<unknown>)[] = [];
const sourcePath = "Inbox/source.md";
const targetPath = "Wiki/topic.md";
const original = "\uFEFF# Topic\r\n\r\nKeep this original.\r\n";
beforeAll(async () => {
  await mkdir("node_modules/.cache", { recursive: true });
  bundleDir = await mkdtemp(resolve("node_modules/.cache/knowledge-test-"));
  entry = join(bundleDir, "launcher.mjs");
  await build({ entryPoints: ["src/knowledge-launcher.ts"], outfile: entry, bundle: true, packages: "external", platform: "node", format: "esm", target: "es2022" });
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => { await rm(bundleDir, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-knowledge-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(directory, "vault");
  await mkdir(join(root, "Inbox"), { recursive: true });
  await mkdir(join(root, "Wiki"));
  await writeFile(join(root, sourcePath), "---\ntype: handoff-source\n---\n# Synthetic source\n\nSource claim, not a live instruction.\n");
  await writeFile(join(root, targetPath), original);
  const configPath = join(directory, "connection.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, vaultRoot: root, token: randomBytes(32).toString("hex") }));
  const config = await loadKnowledgeConfig(configPath);
  return { root, config, configPath };
}

async function direct(config: KnowledgeConfig, respond?: (message: string) => Promise<ElicitResult>) {
  const client = new Client({ name: "synthetic-test", version: "1" }, { capabilities: respond ? { elicitation: { form: {} } } : {} });
  if (respond) client.setRequestHandler(ElicitRequestSchema, request => respond(request.params.message));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
  cleanups.push(() => client.close());
  return client;
}

async function stdio(configPath: string, respond: (message: string, signal: AbortSignal) => Promise<ElicitResult>) {
  const client = new Client({ name: "synthetic-stdio-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, (request, extra) => respond(request.params.message, extra.signal));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "stdio", "--config", configPath], stderr: "pipe" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const value = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  if (value.isError) throw new Error(value.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
  const text = value.content.find(item => item.type === "text");
  return value.structuredContent ?? JSON.parse(text && "text" in text ? text.text : "null");
}

async function proposal(client: Client, newTarget = false, destructive = false) {
  const source = await call(client, "learning_read", { path: sourcePath });
  const target = newTarget ? undefined : await call(client, "learning_read", { path: targetPath });
  const p = destructive ? await call(client, "learning_plan_correction", { sourcePath, sourceVersion: source.version, targetPath, targetVersion: target.version,
    changes: [{ before: "Keep this original.", after: "" }], reason: "Synthetic deletion requires review." }) : await call(client, "learning_plan_inbox", { sourcePath, sourceVersion: source.version, targetPath: newTarget ? "Wiki/new.md" : targetPath,
    ...(target ? { targetVersion: target.version } : {}), content: "Evidence-backed synthetic addition.", reason: "Synthetic integration test." });
  return { planId: p.planId, revision: p.revision };
}

async function running() {
  const f = await fixture();
  const service = await startKnowledgeService(f.config);
  cleanups.push(() => service.close());
  return { ...f, service };
}

describe("shared knowledge service (synthetic protocol responses, not human approval)", () => {
  it("two competing STDIO launchers share the writer, forward exact previews/resources and apply once", async () => {
    const f = await fixture();
    cleanups.push(async () => {
      await fetch(`${f.config.url}/stop`, { method: "POST", headers: { Authorization: `Bearer ${f.config.token}` } });
      for (let i = 0; i < 40; i++) {
        try { await serviceStatus(f.config); } catch { return; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Child service did not stop");
    });
    const messages: string[] = [];
    let action: ElicitResult = { action: "decline" };
    const respond = async (message: string) => { messages.push(message); return action; };
    const [a, b] = await Promise.all([stdio(f.configPath, respond), stdio(f.configPath, respond)]);
    expect(await call(a, "learning_status")).toEqual(await call(b, "learning_status"));
    const plan = await proposal(a, false, true);
    const preview = await call(b, "learning_preview", plan);
    const resource = await b.readResource({ uri: `learning://plans/${plan.planId}` });
    expect(resource.contents[0]).toHaveProperty("text", expect.stringContaining(preview.plan.after));
    expect(await call(a, "learning_request_confirmation", plan)).toHaveProperty("status", "pending");
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
    expect(messages[0]).toContain(preview.plan.before);
    expect(messages[0]).toContain(preview.plan.after);
    expect(messages[0]).toContain(preview.plan.inbox.version);
    action = { action: "accept", content: { confirm: true } };
    const results = await Promise.all([call(a, "learning_request_confirmation", plan), call(b, "learning_request_confirmation", plan)]);
    expect(results.map(item => item.status)).toEqual(["completed", "completed"]);
    expect(results[0].result).toEqual(results[1].result);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(preview.plan.after);
    expect(await readdir(join(f.root, ".ai-learning-os/activity"))).toHaveLength(1);
    expect(await readFile(join(f.root, ".ai-learning-os/backups", `${plan.planId}.md`), "utf8")).toBe(original);
    await a.close();
    expect(await call(b, "learning_status")).toHaveProperty("instanceId", (await serviceStatus(f.config)).instanceId);
    const count = messages.length;
    expect(await call(b, "learning_request_confirmation", plan)).toMatchObject({ status: "completed", confirmation: "already-finished" });
    expect(messages).toHaveLength(count);
  }, 20000);

  it("rejects forged approval, unexposed execute, wrong revision and incomplete/other-connection reads", async () => {
    const f = await running();
    let prompts = 0;
    const a = await direct(f.config, async () => { prompts++; return { action: "accept", content: { confirm: true } }; });
    const b = await direct(f.config);
    const p = await proposal(a);
    await expect(call(a, "learning_request_confirmation", { ...p, approved: true })).rejects.toThrow();
    await expect(call(a, "learning_request_confirmation", { ...p, revision: 2 })).rejects.toThrow(/revision/);
    await expect(call(a, "execute", p)).rejects.toThrow();
    const source = await call(a, "learning_read", { path: sourcePath });
    expect(await call(b, "learning_plan_inbox", { sourcePath, sourceVersion: source.version, targetPath: "Wiki/new.md", content: "x", reason: "x" })).toMatchObject({ status: "pending" });
    await writeFile(join(f.root, sourcePath), "a".repeat(7000));
    const partial = await call(b, "learning_read", { path: sourcePath });
    expect(await call(b, "learning_plan_inbox", { sourcePath, sourceVersion: partial.version, targetPath: "Wiki/new.md", content: "x", reason: "x" })).toMatchObject({ status: "pending" });
    expect(prompts).toBe(0);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });

  it.each(["decline", "cancel", "unchecked"])("%s never writes knowledge or an activity record", async action => {
    const f = await running();
    const client = await direct(f.config, async () => action === "unchecked" ? { action: "accept", content: { confirm: false } } : { action: action as "decline" | "cancel" });
    const p = await proposal(client, false, true);
    expect(await call(client, "learning_request_confirmation", p)).toMatchObject({ status: "pending", confirmation: action === "decline" ? "declined" : action === "cancel" ? "cancelled" : "unchecked" });
    expect(await call(client, "learning_preview", p)).not.toHaveProperty("confirmation");
    const stored = await readFile(join(f.root, ".ai-learning-os/plans", `${p.planId}.state.json`), "utf8");
    expect(JSON.parse(stored)).not.toHaveProperty("confirmation");
    await expect(readFile(join(f.root, targetPath), "utf8")).resolves.toBe(original);
    await expect(readdir(join(f.root, ".ai-learning-os/activity"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["source", "target"])("invalidates %s edits made while the host confirmation is open", async changed => {
    const f = await running();
    const path = changed === "source" ? sourcePath : targetPath;
    const client = await direct(f.config, async () => {
      await writeFile(join(f.root, path), "External edit must survive.\n");
      return { action: "accept", content: { confirm: true } };
    });
    const p = await proposal(client, false, true);
    await expect(call(client, "learning_request_confirmation", p)).rejects.toThrow(/changed externally/);
    expect(await readFile(join(f.root, path), "utf8")).toBe("External edit must survive.\n");
    expect(await call(client, "learning_preview", p)).toHaveProperty("status", "stale");
    if (changed === "source") expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });

  it("a new target created externally cannot be overwritten", async () => {
    const f = await running();
    const client = await direct(f.config, async () => {
      await writeFile(join(f.root, "Wiki/new.md"), "Someone else created this.");
      return { action: "accept", content: { confirm: true } };
    });
    const p = await proposal(client, true);
    await writeFile(join(f.root, "Wiki/new.md"), "Someone else created this.");
    await expect(call(client, "learning_request_confirmation", p)).rejects.toThrow(/created externally/);
    expect(await readFile(join(f.root, "Wiki/new.md"), "utf8")).toBe("Someone else created this.");
  });

  it("cancellation on another connection invalidates an already open confirmation", async () => {
    const f = await running();
    const b = await direct(f.config);
    let p: Record<string, unknown>;
    const a = await direct(f.config, async () => {
      await call(b, "learning_cancel", p);
      return { action: "accept", content: { confirm: true } };
    });
    p = await proposal(a, false, true);
    await expect(call(a, "learning_request_confirmation", p)).rejects.toThrow(/cancelled/);
    expect(await call(b, "learning_preview", p)).toHaveProperty("status", "cancelled");
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });

  it("hosts without elicitation save ordinary additions; mapped paths remain enforced", async () => {
    const f = await running();
    const a = await direct(f.config);
    const p = await proposal(a);
    expect(await call(a, "learning_request_confirmation", p)).toMatchObject({ status: "completed", confirmation: "not-required" });
    await expect(call(a, "learning_read", { path: "../outside.md" })).rejects.toThrow(/Unsafe/);
    await expect(call(a, "learning_read", { path: ".ai-learning-os/space.json" })).rejects.toThrow();
    expect(await readFile(join(f.root, targetPath), "utf8")).toContain("Evidence-backed synthetic addition.");
  });

  it("STDIO cancellation invalidates the active confirmation even if a late accept is returned", async () => {
    const f = await running();
    let entered!: () => void;
    const opened = new Promise<void>(resolve => { entered = resolve; });
    let lateAccept!: () => void;
    const release = new Promise<void>(resolve => { lateAccept = resolve; });
    const a = await stdio(f.configPath, async () => {
      entered();
      await release;
      return { action: "accept", content: { confirm: true } };
    });
    const p = await proposal(a, false, true);
    const abort = new AbortController();
    const work = a.callTool({ name: "learning_request_confirmation", arguments: p }, undefined, { signal: abort.signal });
    await opened;
    abort.abort();
    await expect(work).rejects.toThrow();
    lateAccept();
    await vi.waitFor(async () => { expect(await call(a, "learning_status")).toHaveProperty("confirming", 0); });
    expect(await call(a, "learning_preview", p)).toHaveProperty("status", "pending");
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  }, 15000);

  it("stops the shared service, invalidates connected clients and never auto-starts on status", async () => {
    const f = await running();
    const a = await direct(f.config);
    const instanceId = (await call(a, "learning_status")).instanceId;
    const response = await fetch(`${f.config.url}/stop`, { method: "POST", headers: { Authorization: `Bearer ${f.config.token}` } });
    expect(response.ok).toBe(true);
    await f.service.done;
    await expect(call(a, "learning_status")).rejects.toThrow();
    await expect(serviceStatus(f.config)).rejects.toThrow();
    const next = await startKnowledgeService(f.config);
    cleanups.push(() => next.close());
    expect(next.status().instanceId).not.toBe(instanceId);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });

  it("authenticates every HTTP request, rejects browser origins/hosts and prevents a second listener", async () => {
    const f = await running();
    const auth = { Authorization: `Bearer ${f.config.token}` };
    expect((await fetch(`${f.config.url}/status`)).status).toBe(401);
    expect((await fetch(`${f.config.url}/status`, { headers: { ...auth, Origin: "https://example.com" } })).status).toBe(403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${f.config.url}/status`, { headers: { ...auth, Host: "example.com" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    expect(badHostStatus).toBe(403);
    await expect(startKnowledgeService(f.config)).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(serviceStatus({ ...f.config, token: "0".repeat(64) })).rejects.toThrow(/401/);
    await expect(serviceStatus({ ...f.config, vaultId: "wrong-vault" })).rejects.toThrow(/identity/);
  });
});


describe("persisted proposals and DSH service adapter", () => {
  const accept = async (): Promise<ElicitResult> => ({ action: "accept", content: { confirm: true } });
  async function restart(f: Awaited<ReturnType<typeof running>>) {
    await f.service.close();
    const next = await startKnowledgeService(f.config);
    cleanups.push(() => next.close());
    return next;
  }
  const adapter = (f: Awaited<ReturnType<typeof fixture>>) => sharedVault(f.configPath, { root: f.root, folders: f.config.folders });
  const statePath = (root: string, id: string) => join(root, ".ai-learning-os/plans", `${id}.state.json`);

  it("DSH and two MCP connections observe one instance and concurrently confirm a shared plan once", async () => {
    const f = await running();
    const dsh = adapter(f);
    const a = await direct(f.config, accept), b = await direct(f.config, accept);
    expect(await dsh.status()).toEqual(await call(a, "learning_status"));
    expect(await dsh.status()).toEqual(await call(b, "learning_status"));
    const plan = await dsh.planDailyAppend("2026-11-03", "Synthetic shared append");
    const p = { planId: plan.id, revision: 1 };
    expect(await call(a, "learning_preview", p)).toMatchObject({ status: "pending", plan });
    const [d, m, n] = await Promise.all([dsh.execute(plan.id), call(a, "learning_request_confirmation", p), call(b, "learning_request_confirmation", p)]);
    expect(m.result).toEqual(d); expect(n.result).toEqual(d);
    expect(await dsh.activity()).toHaveLength(1);
    expect((await dsh.read(plan.path)).content).toBe(plan.after);
    expect(await call(a, "learning_plans")).toEqual(expect.arrayContaining([expect.objectContaining({ planId: plan.id, status: "completed" })]));
  });

  it("restores pending plans but rejects old DSH tickets until a fresh preview; completed results never replay", async () => {
    const f = await running();
    const dsh = adapter(f);
    const plan = await dsh.planDailyAppend("2026-11-03", "Recovered only after preview");
    const oldInstance = f.service.status().instanceId;
    const next = await restart(f);
    expect(next.status().instanceId).not.toBe(oldInstance);
    const a = await direct(f.config);
    expect(await call(a, "learning_plans")).toEqual(expect.arrayContaining([expect.objectContaining({ planId: plan.id, status: "pending" })]));
    await expect(readFile(join(f.root, plan.path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(dsh.execute(plan.id)).rejects.toThrow(/Preview/);
    expect(await dsh.previewPlan(plan.id)).toEqual(plan);
    const saved = await dsh.execute(plan.id);
    expect(saved.status).toBe("completed");
    await next.close();
    const third = await startKnowledgeService(f.config); cleanups.push(() => third.close());
    expect(await adapter(f).execute(plan.id)).toEqual(saved);
    expect(await adapter(f).activity()).toHaveLength(1);
  });

  it.each(["source", "target"])("marks changed %s stale during restart and preserves external content", async changed => {
    const f = await running();
    const a = await direct(f.config, accept);
    const p = await proposal(a);
    await f.service.close();
    const path = changed === "source" ? sourcePath : targetPath;
    await writeFile(join(f.root, path), "Changed during downtime");
    const next = await startKnowledgeService(f.config); cleanups.push(() => next.close());
    const b = await direct(f.config, accept);
    expect(await call(b, "learning_preview", p)).toMatchObject({ status: "stale", validationError: expect.stringContaining("changed externally") });
    await expect(call(b, "learning_request_confirmation", p)).rejects.toThrow(/stale/);
    expect(await readFile(join(f.root, path), "utf8")).toBe("Changed during downtime");
    await expect(readdir(join(f.root, ".ai-learning-os/activity"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists supersession, serves revision 2 resources and rejects an old open confirmation", async () => {
    const f = await running();
    const b = await direct(f.config, accept);
    let old: { planId: string; revision: number };
    let revised: { planId: string; revision: number };
    const a = await direct(f.config, accept);
    old = await proposal(a);
    await expect(call(b, "learning_revise_inbox", { ...old, input: { sourcePath, sourceVersion: "0".repeat(64), targetPath, content: "x", reason: "x" } })).rejects.toThrow(/source changed/);
    const source = await call(b, "learning_read", { path: sourcePath });
    const target = await call(b, "learning_read", { path: targetPath });
    const next = await call(b, "learning_revise_inbox", { ...old, input: { sourcePath, sourceVersion: source.version, targetPath,
      targetVersion: target.version, content: "Corrected synthetic text", reason: "User correction" } });
    revised = { planId: next.planId, revision: next.revision };
    await expect(call(a, "learning_request_confirmation", old)).rejects.toThrow(/superseded/);
    expect(revised!.revision).toBe(2);
    const resource = await b.readResource({ uri: `learning://plans/${revised!.planId}` });
    expect(resource.contents[0]).toHaveProperty("text", expect.stringContaining("Corrected synthetic text"));
    await restart(f);
    const c = await direct(f.config, accept);
    expect(await call(c, "learning_preview", old)).toHaveProperty("status", "superseded");
    await expect(call(c, "learning_request_confirmation", old)).rejects.toThrow(/superseded/);
    await expect(call(c, "learning_request_confirmation", { ...revised!, revision: 1 })).rejects.toThrow(/revision/);
    expect(await call(c, "learning_request_confirmation", revised!)).toHaveProperty("status", "completed");
    const content = await readFile(join(f.root, targetPath), "utf8");
    expect(content).toContain("Corrected synthetic text"); expect(content).not.toContain("Evidence-backed synthetic addition");
    expect(await adapter(f).activity()).toHaveLength(1);
  });

  it.each(["applying", "executing"])("does not replay an interrupted %s operation", async state => {
    const f = await running();
    const plan = await adapter(f).planDailyAppend("2026-11-03", "Do not replay");
    await f.service.close();
    const file = statePath(f.root, plan.id);
    const entry = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...entry, status: "applying" }));
    if (state === "executing") {
      await mkdir(join(f.root, ".ai-learning-os/activity"));
      await writeFile(join(f.root, ".ai-learning-os/activity", `${plan.id}.json`), JSON.stringify({ state: "executing",
        result: { id: plan.id, path: plan.path, kind: "update", status: "failed", at: new Date().toISOString() }, after: plan.after }));
    }
    const next = await startKnowledgeService(f.config); cleanups.push(() => next.close());
    const a = await direct(f.config, accept);
    expect(await call(a, "learning_preview", { planId: plan.id, revision: 1 })).toHaveProperty("status", "needs-reconciliation");
    await expect(adapter(f).execute(plan.id)).rejects.toThrow(/needs-reconciliation/);
    await expect(call(a, "learning_request_confirmation", { planId: plan.id, revision: 1 })).rejects.toThrow(/needs-reconciliation/);
    await expect(readFile(join(f.root, plan.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a finished write from its operation log when proposal state still says applying", async () => {
    const f = await running();
    const dsh = adapter(f), plan = await dsh.planDailyAppend("2026-11-03", "Saved before crash");
    const saved = await dsh.execute(plan.id);
    await f.service.close();
    const file = statePath(f.root, plan.id), entry = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...entry, status: "applying", result: undefined }));
    const next = await startKnowledgeService(f.config); cleanups.push(() => next.close());
    expect(await adapter(f).execute(plan.id)).toEqual(saved);
    expect(await adapter(f).activity()).toHaveLength(1);
  });

  it("upgrades v1 metadata with a backup, marks legacy plans non-executable and blocks the old writer", async () => {
    const f = await fixture();
    const old = new VaultService(f.root);
    const plan = await old.planDailyAppend("2026-11-03", "Legacy pending");
    const originalSpace = await readFile(join(f.root, ".ai-learning-os/space.json"), "utf8");
    const service = await startKnowledgeService(f.config); cleanups.push(() => service.close());
    expect(await readFile(join(f.root, ".ai-learning-os/space.before-shared-v2.json"), "utf8")).toBe(originalSpace);
    expect(JSON.parse(await readFile(join(f.root, ".ai-learning-os/space.json"), "utf8")).schemaVersion).toBe(2);
    const a = await direct(f.config, accept);
    expect(await call(a, "learning_preview", { planId: plan.id, revision: 1 })).toHaveProperty("status", "legacy");
    await expect(call(a, "learning_request_confirmation", { planId: plan.id, revision: 1 })).rejects.toThrow(/legacy/);
    await expect(old.execute(plan.id)).rejects.toThrow(/metadata/);
    await expect(old.capture("old-writer", "blocked")).rejects.toThrow(/metadata/);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });

  it.each(["schema", "filename", "legacy"])("fails initialization for invalid persisted %s without executing anything", async invalid => {
    const f = await running();
    const plan = await adapter(f).planDailyAppend("2026-11-03", "Invalid state cannot execute");
    await f.service.close();
    const file = statePath(f.root, plan.id), entry = JSON.parse(await readFile(file, "utf8"));
    if (invalid === "legacy") {
      await rm(file);
      await writeFile(join(f.root, ".ai-learning-os/plans", `${plan.id}.json`), JSON.stringify({ ...plan, version: "invalid" }));
    } else await writeFile(file, JSON.stringify(invalid === "schema" ? { ...entry, schemaVersion: 99 } : { ...entry, plan: { ...plan, id: "00000000-0000-4000-8000-000000000000" } }));
    await expect(startKnowledgeService(f.config)).rejects.toThrow();
    await expect(serviceStatus(f.config)).rejects.toThrow();
    await expect(readFile(join(f.root, plan.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a preview, original owner and type for DSH assistant plans; generic and MCP paths cannot bypass them", async () => {
    const f = await running(), dsh = adapter(f);
    const owner = { scope: "synthetic", sessionId: "first", cwd: f.root, kind: "daily" as const };
    const identity = await dsh.proposeAssistant(owner, "planDailyAppend", ["2026-11-03", "Owned card"], new AbortController().signal);
    await expect(dsh.reviewAssistant(identity, "confirm", "daily")).rejects.toThrow(/Preview/);
    await expect(dsh.execute(identity.planId)).rejects.toThrow("方案卡片");
    await expect(dsh.cancelPlan(identity.planId)).rejects.toThrow("方案卡片");
    await expect(dsh.reviewAssistant({ ...identity, sessionId: "other" }, "preview", "daily")).rejects.toThrow("归属");
    await expect(dsh.reviewAssistant(identity, "preview", "project")).rejects.toThrow("类型");
    const a = await direct(f.config, accept);
    const p = { planId: identity.planId, revision: 1 };
    // Manual/agent save and cancel use personal-library authorization; original DSH cards still check their owner.
    await restart(f);
    await expect(dsh.reviewAssistant(identity, "confirm", "daily")).rejects.toThrow(/Preview/);
    expect(await dsh.reviewAssistant(identity, "preview", "daily")).toHaveProperty("status", "pending");
    expect(await dsh.reviewAssistant(identity, "confirm", "daily")).toHaveProperty("status", "completed");
  });

  it("never falls back to local writing when connection configuration is missing, invalid or mismatched", async () => {
    const f = await fixture();
    const expected = { root: f.root, folders: f.config.folders };
    await expect(sharedVault("", expected).capture("blocked", "x")).rejects.toThrow("knowledgeConnection");
    await expect(sharedVault(join(f.root, "missing.json"), expected).capture("blocked", "x")).rejects.toThrow();
    const service = await startKnowledgeService(f.config); cleanups.push(() => service.close());
    await expect(sharedVault(f.configPath, { ...expected, folders: { ...expected.folders, inbox: "Other" } }).capture("blocked", "x")).rejects.toThrow("不一致");
    await expect(serviceStatus({ ...f.config, folders: { ...f.config.folders, inbox: "Other" } })).rejects.toThrow(/identity/);
    await expect(sharedVault(f.configPath, expected).restore("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/activity/);
    expect(await readdir(join(f.root, ".ai-learning-os"))).toEqual(["space.json"]);
    expect(await readFile(join(f.root, targetPath), "utf8")).toBe(original);
  });
});
