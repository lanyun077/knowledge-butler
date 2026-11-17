import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { routineGuide } from "../src/knowledge-routines";
import { testSharedVault } from "./shared-vault-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const accept = async (): Promise<ElicitResult> => ({ action: "accept", content: { confirm: true } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-routines-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const dir of ["Daily", "Projects", "Learning", "Wiki", "Inbox"]) await mkdir(join(root, dir));
  await writeFile(join(root, "Daily/2026-11-01.md"), "# Recorded November 1\nReported: explained one example.\n");
  await writeFile(join(root, "Daily/2026-11-03.md"), "# Recorded November 3\nPlan: read another example.\n");
  await writeFile(join(root, "Daily/2026-11-04.md"), "# Outside requested period\n");
  await writeFile(join(root, "Daily/undated.md"), "# Undated\n");
  await writeFile(join(root, "Projects/one.md"), "# Current project\n- [x] Undated completion\n");
  await writeFile(join(root, "Learning/one.md"), "---\ntype: learning-goal\nstatus: Active\nnextReview: '2026-11-03'\n---\n# Current goal\n## Evidence\nUndated evidence.\n");
  await writeFile(join(root, "Wiki/other.md"), "# Not a report source\n");
  const shared = await testSharedVault(root); cleanup.push(shared.dispose);
  async function connect(respond: (() => Promise<ElicitResult>) | null = accept) {
    const client = new Client({ name: "routine-test", version: "1" }, { capabilities: respond ? { elicitation: { form: {} } } : {} });
    if (respond) client.setRequestHandler(ElicitRequestSchema, respond);
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
const range = { startDate: "2026-11-01", endDate: "2026-11-03" };
const identity = (plan: { planId: string; revision: number }) => ({ planId: plan.planId, revision: plan.revision });
async function fullRead(client: Client, path: string) {
  let offset = 0, note;
  do { note = await call(client, "learning_read", { path, offset }); offset = note.nextOffset; } while (offset !== null);
  return { path: note.path, version: note.version };
}
async function reportInput(client: Client) {
  const period = await call(client, "learning_review_period", range);
  const sources = [];
  for (const source of period.sources) sources.push(await fullRead(client, source.path));
  return { title: "Selected period report", ...range, content: "Recorded facts: one reported example.\nPlans: read another example.\nCurrent context: undated project and goal snapshots.", sources };
}

describe("native-host routine guide and shared period reports", () => {
  it.each([
    ["Pacific/Kiritimati", "2027-01-01T00:30:00Z", "2027-01-01", "2026-12-25", "2026-12-31"],
    ["Pacific/Honolulu", "2027-01-01T00:30:00Z", "2026-12-31", "2026-12-24", "2026-12-30"],
    ["UTC", "2024-03-01T00:30:00Z", "2024-03-01", "2024-02-23", "2024-02-29"],
  ])("calculates complete calendar days in %s across date boundaries", (zone, instant, date, startDate, endDate) => {
    expect(routineGuide("synthetic-vault", zone, new Date(instant))).toMatchObject({ date, startDate, endDate });
  });

  it("exposes only a read-only native setup guide, with stable identities and unknown actual task state", async () => {
    const f = await fixture(), mcp = await f.connect(), other = await f.connect();
    const tools = (await mcp.listTools()).tools;
    expect(tools.find(tool => tool.name === "learning_routines")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.some(tool => /schedule_(create|delete)|automation_update/.test(tool.name))).toBe(false);
    const guide = await call(mcp, "learning_routines", { timeZone: "Asia/Shanghai" });
    expect(guide).toMatchObject({ vaultId: f.config.vaultId, nativeTaskStatus: "unknown", canListNativeTasks: false, canChangeNativeTasks: false, setupOnly: true });
    expect(guide.workflows.map((workflow: { kind: string }) => workflow.kind)).toEqual(["review-reminder", "weekly-report"]);
    expect((await call(other, "learning_routines", { timeZone: "UTC" })).workflows.map((workflow: { definitionId: string }) => workflow.definitionId)).toEqual(guide.workflows.map((workflow: { definitionId: string }) => workflow.definitionId));
    expect(JSON.stringify(guide)).not.toContain(f.config.token);
    expect(await f.client.activity()).toEqual([]); expect(await call(mcp, "learning_plans")).toEqual([]);
  });

  it("rejects invalid timezones and model-supplied enable fields without creating task state", async () => {
    const f = await fixture(), mcp = await f.connect();
    await expect(call(mcp, "learning_routines", { timeZone: "Invalid/Zone" })).rejects.toThrow();
    await expect(call(mcp, "learning_routines", { timeZone: "UTC", enabled: true })).rejects.toThrow();
    expect(await f.client.activity()).toEqual([]);
    expect((await call(mcp, "learning_routines", { timeZone: "UTC" })).nativeTaskStatus).toBe("unknown");
  });

  it("collects all pages without source text or write receipts, and keeps snapshot timing distinct", async () => {
    const f = await fixture(), mcp = await f.connect();
    for (let i = 0; i < 20; i++) await writeFile(join(f.root, `Projects/extra-${i}.md`), "# Current snapshot\n");
    const first = await call(mcp, "learning_review_period", range);
    const next = await call(mcp, "learning_review_period", { ...range, offset: first.nextOffset });
    expect(first).toMatchObject({ total: 24, truncated: true, nextOffset: 20, missingDailyDates: ["2026-11-02"], excludedDailyNotes: 1 });
    expect(next).toMatchObject({ truncated: false, nextOffset: 24 });
    const sources = [...first.sources, ...next.sources];
    expect(new Set(sources.map(note => note.path)).size).toBe(24);
    expect(sources.filter(note => note.timeBasis === "daily-date").map(note => note.date)).toEqual(["2026-11-01", "2026-11-03"]);
    expect(sources.find(note => note.category === "learning")).toMatchObject({ timeBasis: "current-snapshot" });
    expect(sources[0]).not.toHaveProperty("content");
    expect(await call(mcp, "learning_plan_review", { title: "No receipts", ...range, content: "No source reading", sources: sources.map(({ path, version }) => ({ path, version })) })).toMatchObject({ status: "pending" });
    expect(await f.client.activity()).toEqual([]);
  });

  it("saves a requested report directly, shared with DSH and applied once", async () => {
    const f = await fixture(); let shown = "";
    const mcp = await f.connect(async () => ({ action: "accept", content: { confirm: !!shown } }));
    const input = await reportInput(mcp);
    const plan = await call(mcp, "learning_plan_review", input);
    expect((await f.client.list()).some(note => note.path === "Wiki/Selected period report.md")).toBe(false);
    const preview = await call(mcp, "learning_preview", identity(plan)); shown = preview.plan.after;
    expect(preview.kind).toBe("report");
    expect(preview.plan.report.sources).toHaveLength(4);
    expect(shown).toContain("2026-11-02"); expect(shown).toContain("当前无日期快照");
    expect(shown).toContain("../Daily/2026-11-01.md"); expect(shown).toContain(input.sources[0].version);
    expect((await call(mcp, "learning_request_confirmation", identity(plan))).status).toBe("completed");
    expect((await f.client.read(preview.plan.path)).content).toBe(shown);
    await call(mcp, "learning_request_confirmation", identity(plan));
    expect((await f.client.activity()).filter(item => item.id === plan.planId)).toHaveLength(1);
    await expect(call(mcp, "learning_plan_review", input)).rejects.toThrow(/already exists/);
  });

  it("allows accurate report source versions across connections and resources", async () => {
    const f = await fixture(), mcp = await f.connect(), other = await f.connect();
    const input = await reportInput(mcp);
    expect(await call(other, "learning_plan_review", input)).toMatchObject({ status: "pending" });
    for (const source of input.sources) await other.readResource({ uri: `learning://notes/${encodeURIComponent(source.path)}?version=${source.version}&offset=0` });
    expect(await call(other, "learning_plan_review", input)).toMatchObject({ status: "pending" });
    expect(await f.client.activity()).toEqual([]);
  });

  it("allows nonsequential reading and versioned report proposals without receipt locks", async () => {
    const f = await fixture(), mcp = await f.connect();
    const path = "Projects/long.md"; await writeFile(join(f.root, path), "Context.\n".repeat(1400));
    const first = await call(mcp, "learning_read", { path });
    const input = { title: "Long source report", ...range, content: "Partial selected report", sources: [{ path, version: first.version }] };
    expect(await call(mcp, "learning_plan_review", input)).toMatchObject({ status: "pending" });
    expect(await call(mcp, "learning_read", { path, offset: first.nextOffset + 1 })).toHaveProperty("path");
    await fullRead(mcp, path);
    expect((await call(mcp, "learning_plan_review", input)).status).toBe("pending");
  });

  it("rejects a source edit between report preparation and saving", async () => {
    const f = await fixture(), mcp = await f.connect(async () => {
      await writeFile(join(f.root, "Daily/2026-11-01.md"), "External change during confirmation"); return accept();
    });
    const input = await reportInput(mcp), plan = await call(mcp, "learning_plan_review", input);
    await writeFile(join(f.root, "Daily/2026-11-01.md"), "External change before saving");
    await expect(call(mcp, "learning_request_confirmation", identity(plan))).rejects.toThrow("Review source changed externally; regenerate the report");
    expect((await call(mcp, "learning_plans")).find((entry: { planId: string }) => entry.planId === plan.planId).status).toBe("stale");
    await expect(readFile(join(f.root, "Wiki/Selected period report.md"))).rejects.toThrow();
    expect((await f.client.activity()).some(item => item.status === "completed")).toBe(false);
  });

  it("saves a requested report without elicitation, and keeps explicit cancellation effective", async () => {
    const f = await fixture(); let prompts = 0;
    const decline = await f.connect(async () => { prompts++; return { action: "decline" }; });
    const input = await reportInput(decline), plan = await call(decline, "learning_plan_review", input);
    expect(await call(decline, "learning_request_confirmation", identity(plan))).toMatchObject({ status: "completed", confirmation: "not-required" });
    const unsupported = await f.connect(null);
    expect((await call(unsupported, "learning_request_confirmation", identity(plan))).confirmation).toBe("already-finished");
    const pending = await call(unsupported, "learning_plan_review", { ...input, title: "Cancelled report" });
    await call(unsupported, "learning_cancel", identity(pending));
    await expect(call(unsupported, "learning_request_confirmation", identity(pending))).rejects.toThrow(/cancelled/);
    expect(prompts).toBe(0);
    expect((await f.client.activity()).filter(item => item.status === "completed")).toHaveLength(1);
  });

  it.each(["Wiki/other.md", "Daily/2026-11-04.md"])("refuses an ineligible report source %s without writing", async path => {
    const f = await fixture(), mcp = await f.connect(), input = await reportInput(mcp);
    const note = await f.client.read(path);
    await expect(call(mcp, "learning_plan_review", { ...input, sources: [{ path, version: note.version }] })).rejects.toThrow(/sources must be|outside/);
    expect(await f.client.activity()).toEqual([]);
    expect(await call(mcp, "learning_plans")).toEqual([]);
  });

  it("rejects duplicate source paths and invalid periods before proposing", async () => {
    const f = await fixture(), mcp = await f.connect(), input = await reportInput(mcp);
    await expect(call(mcp, "learning_plan_review", { ...input, sources: [input.sources[0], input.sources[0]] })).rejects.toThrow(/distinct/);
    await expect(call(mcp, "learning_review_period", { startDate: "2026-02-30", endDate: "2026-03-01" })).rejects.toThrow(/calendar/);
    await expect(call(mcp, "learning_review_period", { startDate: range.endDate, endDate: range.startDate })).rejects.toThrow(/1-366/);
    expect(await call(mcp, "learning_plans")).toEqual([]);
  });
});
