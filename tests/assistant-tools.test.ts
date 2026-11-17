import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Volatile } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { assistantTools } from "../src/assistant-tools";
import { testSharedVault } from "./shared-vault-fixture";
import { defaultFolders, vaultScope, type PlainConfig } from "../src/business-api";
import { referenceHash } from "../src/references";
import { toolRuntime } from "./tool-runtime";
import { assistantDaily } from "../src/assistant-daily";
import { assistantRoutines } from "../src/routines";
import { handoffText } from "./handoff-fixture";
import type { SharedVault } from "../src/knowledge-host";
import type { DailyProposal } from "../src/assistant-daily";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(existing?: { root: string; vault: SharedVault }) {
  const root = existing?.root ?? await mkdtemp(join(tmpdir(), "learning-tools-"));
  if (!existing) {
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "Wiki"));
  }
  const runtime = await toolRuntime(root, undefined, existing ? "new-learning-session" : "learning-session");
  cleanups.push(runtime.dispose);
  const values: PlainConfig = { binding: { cwd: root, sessionId: runtime.agent.id }, vault: { root, folders: defaultFolders } };
  const config = { binding: { get: () => values.binding }, vault: { get: () => values.vault } } as { [K in keyof PlainConfig]: Volatile<PlainConfig[K]> };
  const shared = existing ? undefined : await testSharedVault(root, defaultFolders);
  if (shared) cleanups.push(shared.dispose);
  const vault = existing?.vault ?? shared!.client;
  const daily = assistantDaily(() => values, () => vault);
  const prepare = assistantTools(runtime.ctx, config, () => vault, async (_scope, path, signal) => {
    const document = await vault.read(path, signal);
    return { path, version: document.version, tags: ["test"], frontmatter: { title: "test" }, links: [], backlinks: [], unresolvedLinks: [] };
  }, daily.propose, daily.proposeProject, daily.proposeGoalEvidence, daily.proposeInbox, daily.proposeLearningGoal, daily.proposeReport, daily.proposeGoalSteps, daily.proposeGoalTask, daily.proposeProjectStatus, daily.proposeGoalRecall,
  { routines: assistantRoutines(runtime.ctx, () => values), proposeGoalReviewDate: daily.proposeGoalReviewDate, proposeCorrection: daily.proposeCorrection, reviseCorrection: daily.reviseCorrection });
  runtime.ctx.tools.register({ name: "bash", description: "host tool", parameters: { type: "object", properties: {} },
    output: { schema: { type: "string" }, render: () => [{ type: "text", text: "host allowed" }] }, execute: async () => "host allowed" });
  const run = (name: string, args: object, agent: Agent = runtime.agent, signal = new AbortController().signal) => runtime.ctx.tools.execute({
    callId: "test-call" as ToolExecutionInput["callId"], name, arguments: args, agent, signal,
  });
  return { ...runtime, root, values, vault, prepare, run, daily, scope: vaultScope(values.vault) };
}

describe("scoped learning assistant tools with official runtime", () => {
  it("prepares and saves structured multi-source knowledge without an approval card", async () => {
    const f = await fixture(); f.prepare(f.scope);
    await writeFile(join(f.root, "Wiki/source-a.md"), "# A\n版本。"); await writeFile(join(f.root, "Wiki/source-b.md"), "# B\n演进。");
    const notes = await Promise.all(["Wiki/source-a.md", "Wiki/source-b.md"].map(path => f.vault.read(path)));
    const proposed = await f.run("learning_plan_knowledge", { targetPath: "Wiki/topic.md", draft: {
      template: "knowledge-organize-v1", request: "整理接口", title: "接口", summary: "版本支持演进。",
      sources: notes.map(note => ({ path: note.path, version: note.version, total: note.content.length, ranges: [{ start: 0, end: note.content.length }] })),
      groups: [{ title: "版本", items: [{ id: "version", title: "版本", content: "版本支持演进。", evidence: notes.map(note => ({ path: note.path, start: 0, end: note.content.length, quote: note.content })) }] }],
    } });
    expect(proposed.isError, JSON.stringify(proposed)).not.toBe(true);
    const value = JSON.parse((proposed.content[0] as { text: string }).text);
    expect(value).toMatchObject({ plan: { origin: "dsh" }, kind: "manual", status: "pending" });
    expect(value.plan.knowledge.sources).toHaveLength(2);
    const saved = await f.run("learning_save", { planId: value.planId, revision: value.revision });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    expect(JSON.parse((saved.content[0] as { text: string }).text).status).toBe("completed");
    const note = await f.vault.read("Wiki/topic.md"), traced = await f.run("learning_provenance", { path: note.path, version: note.version });
    const trace = JSON.parse((traced.content[0] as { text: string }).text);
    expect(trace.history[0].sources).toHaveLength(2);
    expect(trace.references.map((ref: { path: string }) => ref.path)).toEqual(["Wiki/topic.md", ...notes.map(note => note.path)]);
  });
  it("collects and queries selected knowledge through DSH tools without changing notes", async () => {
    const f = await fixture(); f.prepare(f.scope);
    await writeFile(join(f.root, "Wiki/selected.md"), "# Selected\n## Group\nA short source.\n");
    const collected = await f.run("learning_knowledge_collect", { sourcePaths: ["Wiki/selected.md"] });
    expect(collected.isError, JSON.stringify(collected)).not.toBe(true);
    expect(JSON.parse((collected.content[0] as { text: string }).text)).toMatchObject({ sources: { total: 1 }, processing: "not-assessed" });
    const assessed = await f.run("learning_knowledge_collect", { sourcePaths: ["Wiki/selected.md"], request: "整理所选笔记" });
    expect(assessed.isError, JSON.stringify(assessed)).not.toBe(true);
    expect(JSON.parse((assessed.content[0] as { text: string }).text)).toMatchObject({ processing: "assessed", reuse: { state: "no-topic", counts: { unprocessed: 1 } }, template: { id: "knowledge-organize-v1" } });
    const queried = await f.run("learning_knowledge_query", { topicPath: "Wiki/selected.md", view: "mindmap" });
    expect(queried.isError, JSON.stringify(queried)).not.toBe(true);
    expect(JSON.parse((queried.content[0] as { text: string }).text)).toMatchObject({ outline: { total: 2 } });
    expect((await f.run("learning_knowledge_collect", { sourcePaths: ["../secret.md"] })).isError).toBe(true);
    expect(await f.vault.activity()).toEqual([]);
  });
  it("saves a requested summary through learning_save without a card approval", async () => {
    const f = await fixture(); f.prepare(f.scope);
    const proposed = await f.run("learning_plan_daily", { date: "2099-01-01", content: "Reported progress" });
    expect(proposed.isError).not.toBe(true);
    const { planId } = JSON.parse(JSON.stringify(proposed.meta)).dailyProposal as DailyProposal;
    await expect(f.vault.read("Daily/2099-01-01.md")).rejects.toThrow();
    const saved = await f.run("learning_save", { planId, revision: 1 });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    expect(JSON.parse((saved.content[0] as { text: string }).text)).toMatchObject({ planId, status: "completed", confirmation: "not-required" });
    expect((await f.vault.read("Daily/2099-01-01.md")).content).toContain("Reported progress");
    expect((await f.run("learning_save", { planId, revision: 2 })).isError).toBe(true);
    expect(await f.vault.activity()).toHaveLength(1);
  });

  it("queries the shared management home without granting mutation tools or full-read receipts", async () => {
    const f = await fixture(); f.prepare(f.scope);
    const source = await f.vault.captureHandoff(handoffText("未知"));
    const value = await f.run("learning_manage", { view: "home" });
    expect(value.isError).not.toBe(true);
    expect(JSON.parse((value.content[0] as { text: string }).text).home.sources.items[0]).toMatchObject({ path: source.path, reuse: { kind: "source" } });
    expect(f.ctx.tools.schemas(f.agent).some(tool => ["learning_pin_project", "learning_request_restore"].includes(tool.name))).toBe(false);
    await f.run("learning_search", { query: "合成" });
    expect((await f.run("learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/manage.md", content: "Not read", reason: "No full-read receipt" })).isError).not.toBe(true);
    expect((await f.run("learning_manage", { offset: -1 })).isError).toBe(true);
  });

  it("reuses saved and corrected knowledge in an independent new session without inheriting reads or creating changes", async () => {
    const old = await fixture(); old.prepare(old.scope);
    const source = await old.vault.captureHandoff(handoffText("未知"));
    await old.run("learning_search", { query: "合成" });
    await old.run("learning_read", { path: source.path });
    const proposed = await old.run("learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version,
      targetPath: "Wiki/reuse.md", content: "# Reusable topic\nOld claim.", reason: "Synthetic sourced knowledge" });
    expect(proposed.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(proposed.meta)).inboxProposal as DailyProposal;
    await old.daily.review(identity, "preview", undefined, "inbox");
    expect((await old.daily.review(identity, "confirm", undefined, "inbox")).status).toBe("completed");
    const before = await old.vault.read("Wiki/reuse.md");
    await old.run("learning_read", { path: before.path });
    const input = { sourcePath: source.path, sourceVersion: source.version, targetPath: before.path, targetVersion: before.version,
      changes: [{ before: "Old claim.", after: "Scoped reusable claim." }], reason: "Only the tested conditions apply" };
    const correction = await old.run("learning_plan_correction", input);
    expect(correction.isError).not.toBe(true);
    const corrected = JSON.parse(JSON.stringify(correction.meta)).inboxProposal as DailyProposal;
    await old.daily.review(corrected, "preview", undefined, "inbox");
    expect((await old.daily.review(corrected, "confirm", undefined, "inbox")).status).toBe("completed");
    const fresh = await fixture(old); fresh.prepare(fresh.scope);
    expect(fresh.agent.id).not.toBe(old.agent.id);
    const saved = await fresh.vault.read(before.path), activity = await fresh.vault.activity(), plans = await fresh.vault.listPlans();
    const search = await fresh.run("learning_search", { query: "Reusable" });
    expect(search.isError).not.toBe(true);
    const read = await fresh.run("learning_read", { path: before.path });
    const value = JSON.parse((read.content[0] as { text: string }).text);
    expect(value).toMatchObject({ content: saved.content, reuse: { kind: "knowledge", savedVersion: "recorded", record: { planId: corrected.planId } } });
    expect(value.url).toBe(referenceHash({ path: saved.path, version: saved.version, scope: fresh.scope }));
    const trace = await fresh.run("learning_provenance", { path: saved.path, version: saved.version });
    expect(trace.isError).not.toBe(true);
    const history = JSON.parse((trace.content[0] as { text: string }).text);
    expect(history.history[0]).toMatchObject({ action: "correct", matchesCurrent: true, source: { path: source.path, state: "unchanged" }, changes: input.changes });
    expect(history.references).toEqual(expect.arrayContaining([expect.objectContaining({ path: source.path, version: source.version })]));
    // Neither the old session's reads nor provenance give this session a source-read receipt.
    expect((await fresh.run("learning_plan_correction", { ...input, targetVersion: saved.version,
      changes: [{ before: "Scoped reusable claim.", after: "Different claim." }] })).isError).not.toBe(true);
    const sourceRead = await fresh.run("learning_read", { path: source.path });
    expect(JSON.parse((sourceRead.content[0] as { text: string }).text).reuse).toMatchObject({ kind: "source", savedVersion: "unrecorded", sourceType: "handoff-source" });
    expect(await fresh.vault.activity()).toEqual(activity);
    expect(await fresh.vault.listPlans()).toHaveLength(plans.length + 1);
    expect((await fresh.vault.read(saved.path)).version).toBe(saved.version);
  });

  it("allows explicit pasted handoff capture while unbound, never guesses the project or reads arbitrary local files", async () => {
    const f = await fixture();
    f.prepare(f.scope);
    const context = await f.run("learning_project_context", {});
    expect(JSON.parse((context.content[0] as { text: string }).text)).toEqual({ bound: false, fileSubmission: false });
    const saved = await f.run("learning_capture_handoff", { content: handoffText("未知") });
    expect(saved.isError).not.toBe(true);
    const source = JSON.parse((saved.content[0] as { text: string }).text);
    expect(source).toMatchObject({ duplicate: false, status: "received" });
    expect((await f.vault.read(source.path)).content).toContain("交接来源");
    expect((await f.run("learning_capture_handoff_file", { path: "handoff.md" })).isError).toBe(true);
    f.values.binding = { ...f.values.binding, sessionId: "other" };
    expect((await f.run("learning_capture_handoff", { content: handoffText("未知") })).isError).toBe(true);
    expect(await f.vault.activity()).toHaveLength(1);
  });

  it("keeps an inactive workspace conversation restricted before and after preparation", async () => {
    const { values, agent, prepare, run, scope } = await fixture();
    const original = values.binding;
    values.binding = { cwd: original.cwd, sessionId: "second", conversations: [original, { cwd: original.cwd, sessionId: "second" }] };
    expect((await run("bash", {}, agent)).isError).toBe(true);
    values.binding = { ...values.binding, sessionId: original.sessionId };
    prepare(scope);
    values.binding = { ...values.binding, sessionId: "second" };
    expect((await run("learning_search", { query: "test" }, agent)).isError).toBe(true);
    expect((await run("bash", {}, agent)).isError).toBe(true);
    values.binding = { ...values.binding, sessionId: original.sessionId };
    prepare(scope);
    expect((await run("learning_search", { query: "test" }, agent)).isError).not.toBe(true);
  });
  it("allows versioned recall proposals without receipt locks and rejects stale or non-goal targets", async () => {
    const { root, prepare, run, scope, vault } = await fixture();
    await mkdir(join(root, "Learning"));
    const path = "Learning/goal.md";
    await writeFile(join(root, path), '---\ntype: learning-goal\n---\n# Goal\n' + "context ".repeat(1700));
    const source = await vault.read(path);
    const args = { path, version: source.version, date: "2026-10-28", entries: [{ question: "Question", answer: "I do not know" }] };
    prepare(scope);
    expect((await run("learning_plan_goal_recall", args)).isError).not.toBe(true);
    await run("learning_read", { path });
    expect((await run("learning_plan_goal_recall", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 12000 });
    expect((await run("learning_plan_goal_recall", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 6000 });
    await run("learning_read", { path, offset: 12000 });
    const result = await run("learning_plan_goal_recall", args);
    expect(result.isError).not.toBe(true);
    expect(result.meta).toHaveProperty("goalProposal");
    expect((await vault.read(path)).content).toBe(source.content);
    await writeFile(join(root, path), source.content + "External change");
    expect((await run("learning_plan_goal_recall", args)).isError).toBe(true);
    for (const [target, content] of [["Learning/ordinary.md", "# Ordinary"], ["Wiki/goal.md", '---\ntype: learning-goal\n---\n# Goal']]) {
      await writeFile(join(root, target), content);
      await run("learning_read", { path: target });
      const note = await vault.read(target);
      expect((await run("learning_plan_goal_recall", { ...args, path: target, version: note.version })).isError).toBe(true);
    }
  });

  it("allows versioned goal changes without receipt locks and exposes task lines in their read window", async () => {
    const { root, prepare, run, scope, vault } = await fixture();
    await mkdir(join(root, "Learning"));
    const path = "Learning/goal.md";
    await writeFile(join(root, path), '---\ntype: learning-goal\n---\n# Goal\n- [ ] Task\n' + "context ".repeat(1700));
    const source = await vault.read(path);
    const edits = [
      ["learning_plan_goal_steps", { path, version: source.version, steps: ["Practice"] }],
      ["learning_plan_goal_task", { path, version: source.version, line: 5, checked: true }],
      ["learning_plan_goal_review_date", { path, version: source.version, date: "2026-11-01" }],
    ] as const;
    prepare(scope);
    for (const [name, args] of edits) expect((await run(name, args)).isError).not.toBe(true);
    const first = await run("learning_read", { path });
    expect(JSON.parse((first.content[0] as { text: string }).text).checklist).toEqual([{ line: 5, checked: false, text: "Task" }]);
    for (const [name, args] of edits) expect((await run(name, args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 12000 });
    for (const [name, args] of edits) expect((await run(name, args)).isError).not.toBe(true);
    const next = await run("learning_read", { path, offset: 6000 });
    expect(JSON.parse((next.content[0] as { text: string }).text).checklist).toEqual([]);
    await run("learning_read", { path, offset: 12000 });
    for (const [name, args] of edits) expect((await run(name, args)).isError).not.toBe(true);
    expect((await run("learning_plan_goal_task", { ...edits[1][1], line: 4 })).isError).toBe(true);
    expect((await run("learning_plan_goal_steps", { ...edits[0][1], steps: ["Task\n- [x] Injected"] })).isError).toBe(true);
    await writeFile(join(root, path), source.content + "External change");
    for (const [name, args] of edits) expect((await run(name, args)).isError).toBe(true);
    await writeFile(join(root, "Wiki/not-goal.md"), '# Ordinary\n- [ ] Task');
    await run("learning_read", { path: "Wiki/not-goal.md" });
    const ordinary = await vault.read("Wiki/not-goal.md");
    for (const [name, args] of edits) expect((await run(name, { ...args, path: ordinary.path, version: ordinary.version, line: 2 })).isError).toBe(true);
  });

  it("allows versioned status changes and rejects invalid status, non-projects and stale versions", async () => {
    const { root, prepare, run, scope, vault } = await fixture();
    await mkdir(join(root, "Projects"));
    const path = "Projects/project.md";
    await writeFile(join(root, path), '# Project\n' + "context ".repeat(1700));
    const source = await vault.read(path);
    const args = { path, version: source.version, status: "Paused" };
    prepare(scope);
    expect((await run("learning_plan_project_status", args)).isError).not.toBe(true);
    await run("learning_read", { path });
    expect((await run("learning_plan_project_status", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 6000 });
    await run("learning_read", { path, offset: 12000 });
    expect((await run("learning_plan_project_status", args)).isError).not.toBe(true);
    expect((await run("learning_plan_project_status", { ...args, status: "Done" })).isError).toBe(true);
    await writeFile(join(root, path), "External change");
    expect((await run("learning_plan_project_status", args)).isError).toBe(true);
    await writeFile(join(root, "Wiki/not-project.md"), '# Ordinary');
    await run("learning_read", { path: "Wiki/not-project.md" });
    const ordinary = await vault.read("Wiki/not-project.md");
    expect((await run("learning_plan_project_status", { ...args, path: ordinary.path, version: ordinary.version })).isError).toBe(true);
  });
  it("allows versioned report sources without receipt locks and rejects stale versions", async () => {
    const { root, prepare, run, scope, vault } = await fixture();
    await mkdir(join(root, "Daily"));
    const path = "Daily/2026-10-28.md";
    await writeFile(join(root, path), "# Daily\n" + "record ".repeat(1800));
    const source = await vault.read(path);
    prepare(scope);
    const args = { title: "Review", startDate: "2026-10-28", endDate: "2026-10-28", content: "## Facts\nA record", sources: [{ path, version: source.version }] };
    expect((await run("learning_plan_review", args)).isError).not.toBe(true);
    await run("learning_review_period", { startDate: args.startDate, endDate: args.endDate });
    expect((await run("learning_plan_review", args)).isError).not.toBe(true);
    await run("learning_read", { path });
    expect((await run("learning_plan_review", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 12000 });
    expect((await run("learning_plan_review", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 6000 });
    await run("learning_read", { path, offset: 12000 });
    const result = await run("learning_plan_review", args);
    expect(result.isError).not.toBe(true);
    expect(result.meta).toHaveProperty("reportProposal");
    await expect(vault.read("Wiki/Review.md")).rejects.toThrow();
    await writeFile(join(root, path), "Changed source");
    expect((await run("learning_plan_review", args)).isError).toBe(true);
    await run("learning_read", { path });
    expect((await run("learning_plan_review", args)).isError).toBe(true);
  });
  it("proposes learning goals with optional fields empty and rejects missing outcomes, invalid dates and oversized input", async () => {
    const { root, prepare, run, scope } = await fixture();
    prepare(scope);
    const args = { title: "TypeScript", outcome: "Write a typed parser", verification: "Run it against new examples" };
    for (const overrides of [{ outcome: " " }, { verification: "" }, { title: "../escape" },
      { targetDate: "2026-02-30" }, { title: "x".repeat(201) }, { schedule: "x".repeat(1001) }, { background: "x".repeat(100001) }]) {
      expect((await run("learning_plan_goal", { ...args, ...overrides })).isError).toBe(true);
    }
    const result = await run("learning_plan_goal", args);
    expect(result.isError).not.toBe(true);
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value.status).toBe("pending");
    expect(result.meta).toEqual({ goalProposal: { planId: value.planId, scope, sessionId: value.sessionId, cwd: root } });
    expect(await readdir(root)).not.toContain("Learning");
  });
  it("collects dated Daily and current project/learning references without writes or granting full-read evidence", async () => {
    const { root, prepare, run, scope, vault, agent } = await fixture();
    await mkdir(join(root, "Daily"));
    await mkdir(join(root, "Projects"));
    await mkdir(join(root, "Learning"));
    await writeFile(join(root, "Daily/2026-10-26.md"), "# Done\nFinished a test");
    await writeFile(join(root, "Daily/2026-10-29.md"), "# Outside period");
    await writeFile(join(root, "Projects/demo.md"), "---\nstatus: Completed\n---\n# Demo\n- [x] Done\n- [ ] Planned\n");
    await writeFile(join(root, "Learning/goal.md"), "---\ntype: learning-goal\n---\n# Goal\n## Evidence\nUndated evidence");
    await writeFile(join(root, "Wiki/unrelated.md"), "# Not a period record");
    prepare(scope);
    const args = { startDate: "2026-10-26", endDate: "2026-10-28" };
    const result = await run("learning_review_period", args);
    expect(result.isError).not.toBe(true);
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ total: 3, missingDailyDates: ["2026-10-27", "2026-10-28"], truncated: false });
    expect(value.sources[0]).toMatchObject({ date: "2026-10-26", timeBasis: "daily-date" });
    expect(value.sources[1]).toMatchObject({ timeBasis: "current-snapshot", tasks: { completed: 1, total: 2 } });
    expect(value.sources[1]).not.toHaveProperty("date");
    expect(result.meta).toEqual({ references: value.sources.map((source: { reference: unknown }) => source.reference) });
    for (const source of value.sources) {
      expect(source.reference.scope).toBe(scope);
      expect(source.url).toBe(referenceHash(source.reference));
      expect(source).not.toHaveProperty("content");
    }
    const target = await vault.read("Projects/demo.md");
    expect((await run("learning_plan_project_progress", { path: target.path, version: target.version, content: "Unapproved summary" })).isError).not.toBe(true);
    expect(await vault.activity()).toEqual([]);
    expect((await run("learning_review_period", args, { ...agent, id: "other" } as Agent)).isError).toBe(true);
    const controller = new AbortController(); controller.abort();
    expect((await run("learning_review_period", args, agent, controller.signal)).isError).toBe(true);
  });

  it("discards period sources when the workspace binding changes during collection", async () => {
    const { prepare, run, scope, vault, values } = await fixture();
    prepare(scope);
    vi.spyOn(vault, "list").mockImplementation(async () => {
      values.binding = { ...values.binding, sessionId: "replaced-during-review" };
      return [];
    });
    const result = await run("learning_review_period", { startDate: "2026-10-28", endDate: "2026-10-28" });
    expect(result.isError).toBe(true);
    expect(result.meta).toBeUndefined();
  });

  it("allows versioned Inbox proposals without search locks and restricts mapped categories", async () => {
    const { root, prepare, scope, run, vault } = await fixture();
    await mkdir(join(root, "Inbox"));
    await writeFile(join(root, "Inbox/source.md"), "# Source\n" + "fact ".repeat(2500));
    await writeFile(join(root, "Wiki/target.md"), "# Target\n" + "context ".repeat(2000));
    const source = await vault.read("Inbox/source.md");
    const target = await vault.read("Wiki/target.md");
    const args = { sourcePath: source.path, sourceVersion: source.version, targetPath: target.path, targetVersion: target.version, content: "A fact", reason: "Same topic" };
    prepare(scope);
    const propose = (overrides = {}) => run("learning_plan_inbox", { ...args, ...overrides });
    expect((await propose()).isError).not.toBe(true);
    for (const path of [source.path, target.path]) {
      const note = await vault.read(path);
      for (let offset = 0; offset < note.content.length; offset += 6000) await run("learning_read", { path, offset });
    }
    expect((await propose()).isError).not.toBe(true);
    await run("learning_search", { query: "fact" });
    expect((await propose()).isError).not.toBe(true);
    // Reading a new first window invalidates the earlier full-read evidence.
    await run("learning_read", { path: source.path });
    expect((await propose()).isError).not.toBe(true);
    await run("learning_read", { path: source.path, offset: 12000 });
    expect((await propose()).isError).not.toBe(true);
    await run("learning_read", { path: source.path, offset: 6000 });
    await run("learning_read", { path: source.path, offset: 12000 });
    await run("learning_read", { path: target.path });
    expect((await propose()).isError).not.toBe(true);
    await run("learning_read", { path: target.path, offset: 6000 });
    await run("learning_read", { path: target.path, offset: 12000 });
    expect((await propose()).isError).not.toBe(true);
    for (const overrides of [{ targetVersion: undefined }, { sourcePath: target.path, sourceVersion: target.version },
      { targetPath: "Projects/new.md", targetVersion: undefined }, { targetPath: "Wiki/../escape.md", targetVersion: undefined }, { reason: " " }, { content: " " }]) {
      expect((await propose(overrides)).isError).toBe(true);
    }
    await writeFile(join(root, source.path), "External source change");
    expect((await propose()).isError).toBe(true);
    expect((await vault.read(target.path)).content).toBe(target.content);
  });

  it("allows versioned project progress and rejects outdated or non-project targets", async () => {
    const { root, prepare, scope, run, vault } = await fixture();
    await mkdir(join(root, "Projects"));
    const path = "Projects/long.md";
    await writeFile(join(root, path), "# Long\n" + "progress\n".repeat(1700));
    const document = await vault.read(path);
    const args = { path, version: document.version, content: "Finished a test" };
    prepare(scope);
    expect((await run("learning_plan_project_progress", args)).isError).not.toBe(true);
    await run("learning_search", { query: "Long" });
    expect((await run("learning_plan_project_progress", args)).isError).not.toBe(true);
    await run("learning_read", { path });
    expect((await run("learning_plan_project_progress", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 12000 });
    expect((await run("learning_plan_project_progress", args)).isError).not.toBe(true);
    await run("learning_read", { path, offset: 6000 });
    await run("learning_read", { path, offset: 12000 });
    expect((await run("learning_plan_project_progress", args)).isError).not.toBe(true);
    expect((await vault.read(path)).content).toBe(document.content);
    await writeFile(join(root, path), "# External change");
    expect((await run("learning_plan_project_progress", args)).isError).toBe(true);
    await writeFile(join(root, "Wiki/not-project.md"), "# Not project");
    const read = await run("learning_read", { path: "Wiki/not-project.md" });
    const nonProject = JSON.parse((read.content[0] as { text: string }).text).reference;
    expect((await run("learning_plan_project_progress", { ...nonProject, content: "test" })).isError).toBe(true);
    expect((await run("learning_plan_project_progress", { ...args, content: " " })).isError).toBe(true);
  });
  it("does not return notes when binding changes during an in-flight read", async () => {
    const { prepare, scope, run, vault, values } = await fixture();
    prepare(scope);
    let finish!: () => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(vault, "read").mockImplementation(async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return { path: "Wiki/a.md", title: "a", content: "data", excerpt: "data", category: "knowledge", version: "v1" };
    });
    const result = run("learning_read", { path: "Wiki/a.md" });
    await reading;
    values.binding = { ...values.binding, sessionId: "replacement" };
    finish();
    const settled = await result;
    expect(settled.isError).toBe(true);
    expect(settled.meta).toBeUndefined();
  });
  it("blocks inherited tools before preparation, then exposes only note tools to the bound agent", async () => {
    const { ctx, agent, run, prepare, scope } = await fixture();
    expect((await run("bash", {})).isError).toBe(true);
    prepare(scope);
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(["learning_capture_handoff", "learning_capture_handoff_file", "learning_due_reviews", "learning_handoff_template", "learning_knowledge_collect", "learning_knowledge_query", "learning_manage", "learning_obsidian_metadata", "learning_plan_correction", "learning_plan_daily", "learning_plan_goal", "learning_plan_goal_evidence", "learning_plan_goal_recall", "learning_plan_goal_review_date", "learning_plan_goal_steps", "learning_plan_goal_task", "learning_plan_inbox", "learning_plan_knowledge", "learning_plan_project_progress", "learning_plan_project_status", "learning_plan_review", "learning_project_context", "learning_provenance", "learning_read", "learning_review_period", "learning_revise_correction", "learning_routines", "learning_save", "learning_search"]);
    expect((await run("bash", {})).isError).toBe(true);
    const other = { id: "ordinary" } as Agent;
    expect((await run("bash", {}, other)).isError).not.toBe(true);
    expect((await run("learning_read", { path: "Wiki/a.md" }, other)).isError).toBe(true);
    expect(ctx.tools.schemas(other).map(tool => tool.name)).toEqual(["bash"]);
  });

  it("renders Obsidian metadata with a persistent note reference and never grants an open or write tool", async () => {
    const { run, prepare, scope, root } = await fixture();
    await writeFile(join(root, "Wiki/a.md"), "# Metadata test");
    prepare(scope);
    const result = await run("learning_obsidian_metadata", { path: "Wiki/a.md" });
    expect(result.isError).not.toBe(true);
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ tags: ["test"], frontmatter: { title: "test" }, reference: { path: "Wiki/a.md", scope } });
    expect(value.url).toBe(referenceHash(value.reference));
    expect((await run("obsidian-open", { path: "Wiki/a.md" })).isError).toBe(true);
  });

  it("caps search results and read windows, carries durable references and continues without missing text", async () => {
    const { root, run, prepare, scope, vault } = await fixture();
    const content = "# Search topic\n" + "正文".repeat(6500);
    await Promise.all(Array.from({ length: 22 }, (_, index) => writeFile(join(root, "Wiki", `${index}.md`), content)));
    prepare(scope);
    const searched = await run("learning_search", { query: "Search topic" });
    expect(searched.isError).not.toBe(true);
    const search = JSON.parse((searched.content[0] as { text: string }).text);
    expect(search).toMatchObject({ total: 22, truncated: true });
    expect(search.notes).toHaveLength(20);
    const document = await vault.read("Wiki/0.md");
    const reference = { path: document.path, version: document.version, scope };
    const chunks: string[] = [];
    let offset = 0;
    do {
      const result = await run("learning_read", { path: document.path, offset });
      expect(result.isError).not.toBe(true);
      expect(result.meta).toEqual({ references: [reference], reuse: document.reuse });
      const value = JSON.parse((result.content[0] as { text: string }).text);
      expect(value.content.length).toBeLessThanOrEqual(6000);
      expect(value.url).toBe(referenceHash(reference));
      chunks.push(value.content); offset = value.nextOffset;
      if (!value.truncated) break;
    } while (offset < content.length);
    expect(chunks.join("")).toBe(content);
  });

  it("rejects traversal, hidden files, invalid offsets, empty search and cancelled calls", async () => {
    const { root, run, prepare, scope } = await fixture();
    await writeFile(join(root, "Wiki", "a.md"), "abc");
    prepare(scope);
    for (const args of [{ path: "../a.md" }, { path: ".ai-learning-os/secret.md" }, { path: "Wiki/a.md", offset: -1 }, { path: "Wiki/a.md", offset: 4 }, { path: "Wiki/a.md", offset: 0.5 }]) {
      expect((await run("learning_read", args)).isError).toBe(true);
    }
    expect((await run("learning_search", { query: " " })).isError).toBe(true);
    const controller = new AbortController(); controller.abort();
    expect((await run("learning_read", { path: "Wiki/a.md" }, undefined, controller.signal)).isError).toBe(true);
  });

  it("rejects stale configuration and old bindings, replaces scoped tools and removes contributions on unload", async () => {
    const { ctx, agent, root, values, prepare, run, scope, unload } = await fixture();
    await writeFile(join(root, "Wiki", "a.md"), "abc");
    prepare(scope); prepare(scope);
    values.vault = { ...values.vault, folders: { ...defaultFolders, inbox: "NewInbox" } };
    expect((await run("learning_read", { path: "Wiki/a.md" })).isError).toBe(true);
    prepare(vaultScope(values.vault));
    expect((await run("learning_read", { path: "Wiki/a.md" })).isError).not.toBe(true);
    values.binding = { ...values.binding, sessionId: "replacement" };
    expect((await run("learning_read", { path: "Wiki/a.md" })).isError).toBe(true);
    expect((await run("bash", {})).isError).toBe(true);
    const tools = ctx.tools;
    await unload();
    expect(tools.schemas(agent).some(tool => tool.name.startsWith("learning_"))).toBe(false);
  });
});
