import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Volatile } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";
import { apply } from "../src/index";
import { businessApi, defaultFolders, type VaultConfig } from "../src/business-api";
import { toolRuntime } from "./tool-runtime";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import type { DailyProposal } from "../src/assistant-daily";
import { createEveryScheduleRecord, ScheduleId } from "@deepseek-ai/dsh-schedule";
import { testSharedVault } from "./shared-vault-fixture";
import { handoffText } from "./handoff-fixture";

const roots: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function fixture(bound = true, schedules = false, initialFolders = { ...defaultFolders, inbox: "收件箱" }, withProject = false) {
  const root = await mkdtemp(join(tmpdir(), "learning-host-business-"));
  roots.push(root);
  const routes = new Map<string, ConnectionFetchRoute>();
  const connection = {
    fetch: {
      register(route: ConnectionFetchRoute) {
        expect(route.methods).toEqual(["POST"]);
        expect(route.requestBody).toBe("buffered");
        expect(routes.has(route.path)).toBe(false);
        routes.set(route.path, route);
        return async () => { routes.delete(route.path); };
      },
    },
  };
  const vault = { root: bound ? root : "", folders: initialFolders };
  if (withProject) {
    await mkdir(join(root, initialFolders.projects), { recursive: true });
    await mkdir(join(root, "handoff-submissions"));
    await writeFile(join(root, initialFolders.projects, "one.md"), "# Synthetic project\n");
  }
  const shared = await testSharedVault(root, vault.folders, withProject ? [{ directory: root,
    projectPath: `${initialFolders.projects}/one.md`, sourceRoot: join(root, "handoff-submissions") }] : []);
  disposals.push(shared.dispose);
  let currentVault = vault;
  const configure = (nextVault: VaultConfig) => { currentVault = nextVault; };
  const runtime = await toolRuntime(root, schedules ? [] : undefined);
  let binding = { cwd: root, sessionId: runtime.agent.id as string };
  disposals.push(runtime.dispose);
  runtime.ctx.provide("connection", connection as never);
  apply(runtime.ctx, {
    knowledgeConnection: shared.connectionFile,
    binding: { get: () => binding } as Volatile<{ cwd: string; sessionId: string }>,
    vault: { get: () => currentVault } as Volatile<VaultConfig>,
  });
  const dispatch = async (method: string, envelope: unknown, signal?: AbortSignal) => {
    const path = `/api/learning-os/${method}`;
    const route = routes.get(path);
    if (!route) return new Response("Not found", { status: 404 });
    return route.fetch(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope), signal,
    }));
  };
  const rpc: ClientConnectionRpc = {
    async call(channel, endpoint, payload, signal) {
      expect(channel).toBe("/api");
      expect(endpoint.startsWith("learning-os/")).toBe(true);
      const response = await dispatch(endpoint.slice("learning-os/".length), {
        type: "client-request", rpcId: "business-test", method: endpoint, payload,
      }, signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const envelope = await response.json();
      expect(envelope).toMatchObject({ type: "server-response", rpcId: "business-test" });
      return envelope.result;
    },
  };
  const scope = JSON.stringify([vault.root, ...Object.keys(defaultFolders).map((key) => vault.folders[key as keyof typeof defaultFolders])]);
  const run = (name: string, args: object) => runtime.ctx.tools.execute({ callId: "daily-test" as ToolExecutionInput["callId"],
    name, arguments: args, agent: runtime.agent, signal: new AbortController().signal });
  return { root, api: businessApi(rpc, vault), dispatch, configure, rpc, vault, scope, run, agent: runtime.agent,
    configureBinding: (next: typeof binding) => { binding = next; } };
}

async function confirm(api: ReturnType<typeof businessApi>, kind: "Daily" | "Project" | "Goal" | "Inbox" | "Report", identity: DailyProposal) {
  const review = api[`review${kind}`];
  const preview = await review(identity, "preview");
  return ["pending", "completed", "failed"].includes(preview.status) ? review(identity, "confirm") : preview;
}

describe("business client through host RPC and real Vault", () => {
  it("prepares multi-source knowledge through authenticated business RPC and saves the exact plan", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Wiki"));
    await writeFile(join(f.root, "Wiki/a.md"), "# A\n版本。"); await writeFile(join(f.root, "Wiki/b.md"), "# B\n演进。");
    const notes = await Promise.all(["Wiki/a.md", "Wiki/b.md"].map(path => f.api.read(path)));
    const input = { targetPath: "Wiki/organized.md", draft: { template: "knowledge-organize-v1" as const, request: "整理接口", title: "接口", summary: "版本与演进。",
      sources: notes.map(note => ({ path: note.path, version: note.version, total: note.content.length, ranges: [{ start: 0, end: note.content.length }] })),
      groups: [{ title: "接口", items: [{ id: "version", title: "版本", content: "版本支持演进。", evidence: notes.map(note => ({ path: note.path, start: 0, end: note.content.length, quote: note.content })) }] }],
    } };
    const entry = await f.api.planKnowledge(input);
    expect(entry.plan.knowledge?.sources).toHaveLength(2); expect(entry.plan.origin).toBe("dsh");
    await expect(readFile(join(f.root, input.targetPath))).rejects.toMatchObject({ code: "ENOENT" });
    const other = businessApi(f.rpc, { root: f.root + "-other", folders: f.vault.folders });
    await expect(other.planKnowledge(input)).rejects.toThrow("设置已变化");
    expect((await f.api.inspectPlan(entry.plan.id)).status).toBe("pending");
    expect((await f.api.execute(entry.plan.id)).status).toBe("completed");
    expect((await f.api.read(input.targetPath)).content).toContain("^version");
  });
  it("serves knowledge scope and summaries through existing authenticated business RPC", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Wiki"), { recursive: true });
    await writeFile(join(f.root, "Wiki/selected.md"), "# Selected\n## Group\nA short source.\n");
    expect(await f.api.collectKnowledge({ sourcePaths: ["Wiki/selected.md"] })).toMatchObject({ sources: { total: 1 } });
    expect(await f.api.collectKnowledge({ sourcePaths: ["Wiki/selected.md"], request: "整理所选笔记" })).toMatchObject({ processing: "assessed", reuse: { state: "no-topic" }, template: { id: "knowledge-organize-v1" } });
    expect(await f.api.queryKnowledge({ topicPath: "Wiki/selected.md", view: "mindmap" })).toMatchObject({ outline: { total: 2 } });
    await expect(f.api.queryKnowledge({ topicPath: "../private.md" })).rejects.toThrow("mapped");
    const other = businessApi(f.rpc, { root: f.root + "-other", folders: f.vault.folders });
    await expect(other.queryKnowledge({ topicPath: "Wiki/selected.md" })).rejects.toThrow("设置已变化");
    expect(await f.api.activity()).toEqual([]);
  });
  it("serves the management home and trusted pin/restore controls over authenticated RPC", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Projects"), { recursive: true });
    await writeFile(join(f.root, "Projects/managed.md"), "# Managed project\n- [ ] A\n");
    await f.api.setProjectPinned("Projects/managed.md", true);
    expect((await f.api.management()).home?.pinned.items[0]).toMatchObject({ path: "Projects/managed.md", tasks: { completed: 0, total: 1 } });
    const note = await f.api.capture("Restore target", "Original text");
    const plan = await f.api.planUpdate(note.path, note.version, "Changed text");
    expect((await f.api.inspectPlan(plan.id)).plan.after).toBe("Changed text");
    await f.api.execute(plan.id);
    expect(await f.api.previewRestore(plan.id)).toMatchObject({ path: note.path, before: "Changed text", after: note.content });
    expect((await f.api.restore(plan.id)).status).toBe("completed");
    expect((await f.api.read(note.path)).content).toBe(note.content);
    f.configure({ ...f.vault, root: join(f.root, "different-root") });
    await expect(f.api.setProjectPinned("Projects/managed.md", false)).rejects.toThrow(/变化/);
  });

  it("exposes version-bound provenance through authenticated host RPC and never trusts a note's own confirmation flag", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Wiki"));
    await writeFile(join(f.root, "Wiki/existing.md"), '---\nconfirmed: true\n---\n# Existing\n');
    const before = await f.api.read("Wiki/existing.md");
    expect(before.reuse).toMatchObject({ kind: "knowledge", savedVersion: "unrecorded" });
    expect((await f.api.provenance(before.path, before.version)).history).toEqual([]);
    const plan = await f.api.planUpdate(before.path, before.version, before.content + "Saved contribution.\n");
    expect((await f.api.provenance(before.path, before.version)).total).toBe(0);
    expect((await f.api.execute(plan.id)).status).toBe("completed");
    const saved = await f.api.read(before.path);
    expect(saved.reuse).toMatchObject({ savedVersion: "recorded", record: { planId: plan.id } });
    expect((await f.api.provenance(saved.path, saved.version)).history[0]).toMatchObject({ planId: plan.id, matchesCurrent: true, action: "update" });
    await expect(f.api.provenance(saved.path, before.version)).rejects.toThrow(/changed/);
    await expect(f.api.provenance(saved.path, saved.version, -1)).rejects.toThrow(/offset/);
  });

  it("corrects sourced knowledge through the official tools, invalidates old cards and confirms only the current revision", async () => {
    const f = await fixture();
    const source = await f.api.captureHandoff(handoffText("未知"));
    await mkdir(join(f.root, "Wiki"));
    const original = '\uFEFF---\r\ncustom: keep\r\n---\r\n# Topic\r\nOld claim.\r\nKeep evidence.\r\n';
    await writeFile(join(f.root, "Wiki/correct.md"), original);
    const target = await f.api.read("Wiki/correct.md");
    const input = { sourcePath: source.path, sourceVersion: source.version, targetPath: target.path, targetVersion: target.version,
      changes: [{ before: "Old claim.", after: "Scoped claim." }], reason: "Source gives narrower tested conditions." };
    await f.api.prepareAssistant();
    expect((await f.run("learning_plan_correction", input)).isError).not.toBe(true);
    await f.run("learning_search", { query: "Topic" });
    expect((await f.run("learning_plan_correction", input)).isError).not.toBe(true);
    await f.run("learning_read", { path: source.path });
    await f.run("learning_read", { path: target.path });
    const first = await f.run("learning_plan_correction", input);
    expect(first.isError).not.toBe(true);
    const old = JSON.parse(JSON.stringify(first.meta)).inboxProposal as DailyProposal & { revision: number };
    expect(old.revision).toBe(1);
    expect((await f.api.reviewInbox(old, "preview")).plan.correction?.changes).toEqual(input.changes);
    const revised = await f.run("learning_revise_correction", { ...input, planId: old.planId, revision: old.revision,
      changes: [{ before: "Old claim.", after: "Revised scoped claim." }] });
    expect(revised.isError).not.toBe(true);
    const current = JSON.parse(JSON.stringify(revised.meta)).inboxProposal as DailyProposal & { revision: number };
    expect(current.revision).toBe(2);
    expect((await f.api.reviewInbox(old, "preview")).status).toBe("superseded");
    await expect(f.api.reviewInbox(old, "confirm")).rejects.toThrow(/superseded/);
    expect((await confirm(f.api, "Inbox", current)).status).toBe("completed");
    expect((await f.api.reviewInbox(current, "confirm")).status).toBe("completed");
    const saved = await f.api.read(target.path);
    expect(saved.content.startsWith(original.replace("Old claim.", "Revised scoped claim."))).toBe(true);
    expect(saved.content).toContain(source.version);
    expect((await f.api.read(source.path)).version).toBe(source.version);
    expect((await f.api.activity()).filter(item => item.path === target.path)).toHaveLength(1);
    f.configureBinding({ sessionId: "different", cwd: f.root });
    expect((await f.run("learning_revise_correction", { ...input, planId: current.planId, revision: current.revision })).isError).toBe(true);
  });

  it("uses the saved directory's trusted binding for handoff tools and RPC, then confirms sourced knowledge through the original card", async () => {
    const f = await fixture(true, false, { ...defaultFolders, inbox: "收件箱" }, true);
    expect(await f.api.projectContext()).toMatchObject({ bound: true, projectPath: "Projects/one.md", fileSubmission: true });
    expect(await f.api.handoffTemplate()).toContain("来源与覆盖");
    await writeFile(join(f.root, "handoff-submissions/provided.md"), handoffText());
    const source = await f.api.captureHandoffFile("provided.md");
    expect(await f.api.captureHandoff(handoffText())).toMatchObject({ path: source.path, duplicate: true });
    await expect(f.api.captureHandoffFile("../outside.md")).rejects.toThrow("Unsafe");
    await f.api.prepareAssistant();
    const context = await f.run("learning_project_context", {});
    expect(context.isError).not.toBe(true);
    expect(JSON.parse((context.content[0] as { text: string }).text)).toHaveProperty("projectPath", "Projects/one.md");
    expect((await f.run("learning_handoff_template", {})).isError).not.toBe(true);
    const captured = await f.run("learning_capture_handoff_file", { path: "provided.md" });
    expect(captured.isError).not.toBe(true);
    expect(JSON.parse((captured.content[0] as { text: string }).text)).toMatchObject({ path: source.path, duplicate: true });
    await f.run("learning_read", { path: source.path });
    await f.run("learning_search", { query: "来源" });
    const proposed = await f.run("learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version,
      targetPath: "Wiki/from-handoff.md", content: "保存前检查来源和目标版本。", reason: "合成可复用知识" });
    expect(proposed.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(proposed.meta)).inboxProposal as DailyProposal;
    await expect(f.api.read("Wiki/from-handoff.md")).rejects.toThrow();
    expect((await confirm(f.api, "Inbox", identity)).status).toBe("completed");
    expect((await f.api.read("Wiki/from-handoff.md")).content).toContain('projectPath: "Projects/one.md"');
    expect((await f.api.read(source.path)).version).toBe(source.version);
  });

  it("imports a real PDF and preserves pages through the existing Inbox proposal channel", async () => {
    const f = await fixture();
    const base64 = (await readFile(new URL("./fixtures/text-source.pdf", import.meta.url))).toString("base64");
    const args = { title: "PDF来源", sourceName: "text-source.pdf", base64 };
    const plan = (await f.api.planPdfImport(args)).plan!;
    await expect(f.api.read(plan.path)).rejects.toThrow();
    await expect(readFile(join(f.root, plan.pdf!.snapshotPath))).rejects.toThrow();
    expect((await f.api.execute(plan.id)).status).toBe("completed");
    const source = await f.api.read(plan.path);
    expect(await f.api.readPdf(source.path, source.version)).toMatchObject({ base64, pages: 2 });
    expect((await f.api.planPdfImport({ ...args, title: "其他标题" })).duplicate?.path).toBe(source.path);
    await f.api.prepareAssistant();
    await f.run("learning_read", { path: source.path });
    await f.run("learning_search", { query: "长期归纳" });
    const result = await f.run("learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version,
      targetPath: "Wiki/PDF知识.md", content: "来源 PDF 第2页：检索既有笔记后追加或纠正，保留页码。", reason: "保留来源的长期知识整理。" });
    expect(result.isError).not.toBe(true);
    const proposal = JSON.parse(JSON.stringify(result.meta)).inboxProposal as DailyProposal;
    await expect(f.api.execute(proposal.planId)).rejects.toThrow("方案卡片");
    expect((await confirm(f.api, "Inbox", proposal)).status).toBe("completed");
    expect((await f.api.read("Wiki/PDF知识.md")).content).toContain("第2页");
    expect((await f.api.read(source.path)).content).toBe(source.content);
    f.configure({ ...f.vault, folders: { ...f.vault.folders, inbox: "其他" } });
    await expect(f.api.readPdf(source.path, source.version)).rejects.toThrow("设置已变化");
  });

  it("imports an article through preview/confirm and organizes it with the existing model Inbox channel", async () => {
    const f = await fixture();
    const args = { kind: "markdown" as const, title: "联合类型文章", sourceName: "示例文章.md", url: "", content: "# 联合类型\n使用 | 表示联合类型。\n![remote](https://example.com/image.png)" };
    const plan = (await f.api.planArticleImport(args)).plan!;
    await expect(f.api.read(plan.path)).rejects.toThrow();
    await expect(readFile(join(f.root, plan.article!.snapshotPath))).rejects.toThrow();
    expect((await f.api.execute(plan.id)).status).toBe("completed");
    expect((await f.api.planArticleImport({ ...args, title: "另一标题" })).duplicate?.path).toBe(plan.path);
    await f.api.prepareAssistant();
    const source = await f.api.read(plan.path);
    await f.run("learning_read", { path: source.path });
    await f.run("learning_search", { query: "联合类型" });
    const result = await f.run("learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version,
      targetPath: "Wiki/联合类型文章整理.md", content: "来源文章说明：使用 | 表示联合类型。", reason: "用户提交的文章，没有对应知识页。" });
    expect(result.isError).not.toBe(true);
    const proposal = JSON.parse(JSON.stringify(result.meta)).inboxProposal as DailyProposal;
    await expect(f.api.execute(proposal.planId)).rejects.toThrow("方案卡片");
    expect((await confirm(f.api, "Inbox", proposal)).status).toBe("completed");
    expect((await f.api.read(source.path)).content).toBe(source.content);
    expect((await f.api.read("Wiki/联合类型文章整理.md")).content).toContain("联合类型文章.md");
  });

  it("discards a fetched article when its Vault scope changes or its request is aborted", async () => {
    const f = await fixture();
    const args = { kind: "url" as const, title: "异步文章", sourceName: "公开网站", url: "https://example.com/", content: "" };
    vi.spyOn(HttpFetchProvider.prototype, "fetch").mockImplementationOnce(async () => {
      f.configure({ ...f.vault, folders: { ...f.vault.folders, inbox: "其他" } });
      return { url: args.url, statusCode: 200, body: { kind: "text", content: "Fetched article" }, truncated: false };
    });
    await expect(f.api.planArticleImport(args)).rejects.toThrow("configuration changed");
    expect(await readdir(join(f.root, ".ai-learning-os"))).toEqual(["space.json"]);
    f.configure(f.vault);
    const controller = new AbortController();
    vi.spyOn(HttpFetchProvider.prototype, "fetch").mockImplementationOnce(async () => {
      controller.abort();
      return { url: args.url, statusCode: 200, body: { kind: "text", content: "Fetched article" }, truncated: false };
    });
    const response = await f.dispatch("plan-article-import", { type: "client-request", rpcId: "article-abort", method: "learning-os/plan-article-import", payload: { ...args, scope: f.scope } }, controller.signal);
    expect((await response.json()).result.ok).toBe(false);
    expect(await readdir(join(f.root, ".ai-learning-os"))).toEqual(["space.json"]);
  });

  it("rejects cross-conversation confirmation and rechecks the original note after switching back", async () => {
    const f = await fixture();
    await f.api.prepareAssistant();
    const original = { cwd: f.root, sessionId: f.agent.id as string };
    const result = await f.run("learning_plan_daily", { date: "2026-10-31", content: "Only from first conversation" });
    expect(result.isError).not.toBe(true);
    const proposal = JSON.parse(JSON.stringify(result.meta)).dailyProposal as DailyProposal;
    f.configureBinding({ ...original, sessionId: "second" });
    await expect(f.api.reviewDaily(proposal, "confirm")).rejects.toThrow("会话已变化");
    f.configureBinding(original);
    expect((await f.api.reviewDaily(proposal, "preview")).status).toBe("pending");
    const path = "Daily/2026-10-31.md";
    await mkdir(join(f.root, "Daily"), { recursive: true });
    await writeFile(join(f.root, path), "External note created while away");
    expect((await confirm(f.api, "Daily", proposal)).status).toBe("stale");
    expect((await f.api.read(path)).content).toBe("External note created while away");
  });
  it("imports chat through authenticated preview/confirm and reuses the Inbox organization channel", async () => {
    const f = await fixture();
    const input = { title: "聊天来源", sourceName: "DeepSeek", content: "用户：联合类型是什么？\n助手：使用 | 表示多个候选类型。" };
    const cancelled = (await f.api.planChatImport(input)).plan!;
    await f.api.cancelPlan(cancelled.id);
    await expect(f.api.execute(cancelled.id)).rejects.toThrow("已取消");
    const plan = (await f.api.planChatImport(input)).plan!;
    expect(plan.path).toBe("收件箱/聊天来源.md");
    await expect(f.api.read(plan.path)).rejects.toThrow();
    expect((await f.api.execute(plan.id)).status).toBe("completed");
    expect((await f.api.planChatImport({ ...input, title: "重复" })).duplicate?.path).toBe(plan.path);
    await f.api.prepareAssistant();
    const source = await f.api.read(plan.path);
    await f.run("learning_read", { path: source.path });
    await f.run("learning_search", { query: "联合类型" });
    const result = await f.run("learning_plan_inbox", { sourcePath: source.path, sourceVersion: source.version,
      targetPath: "Wiki/联合类型.md", content: "聊天中的助手回答：使用 | 表示多个候选类型。", reason: "来源是用户提交的历史问答，当前没有对应知识页。" });
    expect(result.isError).not.toBe(true);
    const proposal = JSON.parse(JSON.stringify(result.meta)).inboxProposal as DailyProposal;
    await expect(f.api.cancelPlan(proposal.planId)).rejects.toThrow("方案卡片");
    await expect(f.api.execute(proposal.planId)).rejects.toThrow("方案卡片");
    expect((await confirm(f.api, "Inbox", proposal)).status).toBe("completed");
    expect((await f.api.read(source.path)).content).toBe(source.content);
    expect((await f.api.read("Wiki/联合类型.md")).content).toContain("聊天来源.md");
    const oldApi = f.api;
    f.configure({ ...f.vault, folders: { ...f.vault.folders, inbox: "其他" } });
    await expect(oldApi.planChatImport(input)).rejects.toThrow("资料目录设置已变化");
  });

  it("confirms, clears and restores review dates through the existing goal channel without treating due-list reads as full reads", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Learning"));
    const path = "Learning/goal.md";
    const before = '---\ntype: learning-goal\nstatus: Active\n---\n# Goal\n- [ ] Task';
    await writeFile(join(f.root, path), before);
    await f.api.prepareAssistant();
    const note = await f.api.read(path);
    const args = { path, version: note.version, date: "2026-11-01" };
    await f.run("learning_due_reviews", { date: "2026-10-28" });
    expect((await f.run("learning_plan_goal_review_date", args)).isError).not.toBe(true);
    await f.run("learning_read", { path });
    const proposed = await f.run("learning_plan_goal_review_date", args);
    expect(proposed.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(proposed.meta)).goalProposal as DailyProposal;
    expect((await f.api.read(path)).content).toBe(before);
    await expect(f.api.execute(identity.planId)).rejects.toThrow("方案卡片");
    expect((await confirm(f.api, "Goal", identity)).status).toBe("completed");
    expect((await f.api.dueReviews("2026-10-28")).total).toBe(0);
    expect((await f.api.dueReviews("2026-11-01")).sources[0]).toMatchObject({ path, overdue: false });
    const saved = await f.api.read(path);
    const clear = await f.api.planGoalReviewDate(path, saved.version, null);
    expect((await f.api.execute(clear.id)).status).toBe("completed");
    expect((await f.api.dueReviews("2026-11-01")).unscheduled).toBe(1);
    await f.api.activity();
    expect((await f.api.restore(clear.id)).status).toBe("completed");
    expect((await f.api.read(path)).content).toBe(saved.content);
    const stale = await f.api.planGoalReviewDate(path, saved.version, "2026-11-02");
    await writeFile(join(f.root, path), saved.content + "\nExternal change");
    await expect(f.api.execute(stale.id)).rejects.toThrow("changed externally");
  });

  it("manages both opt-in workflows with official Schedule tools, blocks model mutations and preserves unrelated schedules", async () => {
    const f = await fixture(true, true);
    const binding = { sessionId: f.agent.id, cwd: f.root };
    const foreign = createEveryScheduleRecord(ScheduleId("foreign"), "Unrelated host reminder", 300, Date.now());
    f.agent.session.append("schedule/change", { version: 1, operation: "create", schedule: foreign });
    expect(await f.api.routines(binding)).toEqual({ available: true, items: [] });
    expect((await f.run("schedule_create", { prompt: "Unapproved", every_seconds: 300 })).isError).toBe(true);
    const [first, repeat] = await Promise.all([
      f.api.setRoutine(binding, "review-reminder", true, "Asia/Shanghai"),
      f.api.setRoutine(binding, "review-reminder", true, "Asia/Shanghai"),
    ]);
    expect(first.items).toHaveLength(1); expect(repeat.items).toHaveLength(1);
    const both = await f.api.setRoutine(binding, "weekly-report", true, "Asia/Shanghai");
    expect(both.items).toHaveLength(2);
    const weekly = both.items.find(item => item.kind === "weekly-report")!;
    expect(Date.parse(weekly.endDate!) - Date.parse(weekly.startDate!)).toBe(6 * 86400000);
    expect(Date.parse(weekly.date) - Date.parse(weekly.endDate!)).toBe(86400000);
    expect((await f.run("learning_routines", {})).isError).not.toBe(true);
    expect((await f.run("schedule_delete", { id: weekly.id })).isError).toBe(true);
    await expect(f.api.stopRoutine(binding, "foreign")).rejects.toThrow("只能暂停");
    const paused = await f.api.setRoutine(binding, "weekly-report", false, "Asia/Shanghai");
    expect(paused.items.map(item => item.kind)).toEqual(["review-reminder"]);
    const resumed = await f.api.setRoutine(binding, "weekly-report", true, "Asia/Shanghai");
    expect(resumed.items.find(item => item.kind === "weekly-report")!.id).not.toBe(weekly.id);
    const mapped = { ...f.vault, folders: { ...f.vault.folders, learning: "Goals" } };
    f.configure(mapped);
    const mappedApi = businessApi(f.rpc, mapped);
    const old = await mappedApi.routines(binding);
    expect(old.items.every(item => !item.currentScope)).toBe(true);
    expect((await mappedApi.stopRoutine(binding, old.items[0].id)).items).toHaveLength(1);
    f.configureBinding({ ...binding, sessionId: "replacement" });
    await expect(mappedApi.setRoutine(binding, "weekly-report", false, "Asia/Shanghai")).rejects.toThrow("会话已变化");
  });

  it("reports missing Schedule capability and refuses to pretend a workflow was enabled", async () => {
    const f = await fixture();
    const binding = { sessionId: f.agent.id, cwd: f.root };
    expect((await f.api.routines(binding)).available).toBe(false);
    await expect(f.api.setRoutine(binding, "weekly-report", true, "Asia/Shanghai")).rejects.toThrow("Schedule");
  });

  it("saves manual recall answers only after confirmation, preserving goal status, evidence and checklist with cancel and restore", async () => {
    const f = await fixture(true, false, { ...defaultFolders, inbox: "收件箱", learning: "Goals/学习" });
    const mapped = f.vault;
    f.configure(mapped);
    const api = businessApi(f.rpc, mapped);
    await mkdir(join(f.root, "Goals/学习"), { recursive: true });
    const path = "Goals/学习/goal.md";
    const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Active # keep\r\nevidence: []\r\ncustom: keep\r\n---\r\n# Goal\r\n- [x] Done\r\n- [ ] Pending\r\n## Evidence\r\nExisting evidence\r\n';
    await writeFile(join(f.root, path), before);
    await api.prepareAssistant();
    const source = await api.read(path);
    const args = { path, version: source.version, date: "2026-10-28", entries: [
      { question: "What is a union type?", answer: "I do not know", reflection: "Need another example" },
    ] };
    expect((await f.run("learning_plan_goal_recall", args)).isError).not.toBe(true);
    await f.run("learning_read", { path });
    const propose = async () => {
      const result = await f.run("learning_plan_goal_recall", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    };
    const cancelled = await propose();
    const preview = await api.reviewGoal(cancelled, "preview");
    expect(preview.plan.after).toContain(args.entries[0].answer);
    expect((await api.read(path)).content).toBe(before);
    await expect(api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    await expect(api.reviewProject(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.run("assistant-goal-confirm", { ...cancelled, approved: true })).isError).toBe(true);
    expect((await api.reviewGoal(cancelled, "cancel")).status).toBe("cancelled");
    await expect(api.reviewGoal(cancelled, "confirm")).rejects.toThrow("已取消");
    expect((await api.read(path)).content).toBe(before);
    const identity = await propose();
    const [saved, repeat] = await Promise.all([confirm(api, "Goal", identity), confirm(api, "Goal", identity)]);
    expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
    const note = await api.read(path);
    expect(note.content).toBe(preview.plan.after);
    expect(note.content.startsWith(before)).toBe(true);
    expect(note.tasks).toEqual(source.tasks);
    expect(note.status).toBe("Active");
    expect(note.content).toContain(source.version);
    expect((await api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    expect((await api.reviewGoal(identity, "preview")).status).toBe("completed");
    expect((await api.restore(identity.planId)).status).toBe("completed");
    expect((await api.read(path)).content).toBe(before);
    const pending = await propose();
    f.configure({ ...f.vault, folders: { ...f.vault.folders, learning: "Learning" } });
    await expect(api.reviewGoal(pending, "confirm")).rejects.toThrow("资料目录设置已变化");
    f.configure(mapped); f.configureBinding({ cwd: f.root, sessionId: "replacement" });
    await expect(api.reviewGoal(pending, "confirm")).rejects.toThrow("会话已变化");
  });

  it("rejects an external goal edit before saving recall answers", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Learning"));
    const path = "Learning/goal.md";
    await writeFile(join(f.root, path), '---\ntype: learning-goal\n---\n# Goal');
    await f.api.prepareAssistant();
    await f.run("learning_read", { path });
    const source = await f.api.read(path);
    const result = await f.run("learning_plan_goal_recall", { path, version: source.version, date: "2026-10-28", entries: [{ question: "Question", answer: "Answer" }] });
    expect(result.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    await writeFile(join(f.root, path), source.content + "\nExternal change");
    expect((await confirm(f.api, "Goal", identity)).status).toBe("stale");
    expect((await f.api.read(path)).content).toBe(source.content + "\nExternal change");
  });
  it("confirms explicit project status changes without changing tasks, supports cancellation and refuses legacy directory conflicts", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Projects/A"), { recursive: true });
    await mkdir(join(f.root, "Projects/B"), { recursive: true });
    const path = "Projects/A/Same.md";
    const before = '\uFEFF---\r\nstatus: Active # keep\r\ncustom: [a, b]\r\n---\r\n# Same\r\n- [ ] Pending\r\n## Progress\r\nOriginal\r\n';
    await writeFile(join(f.root, path), before);
    await writeFile(join(f.root, "Projects/B/Same.md"), before);
    await f.api.prepareAssistant();
    async function propose(status: string) {
      await f.run("learning_read", { path });
      const note = await f.api.read(path);
      const result = await f.run("learning_plan_project_status", { path, version: note.version, status });
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).projectProposal as DailyProposal;
    }
    const cancelled = await propose("Paused");
    await expect(f.api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    await expect(f.api.reviewGoal(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.api.reviewProject(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewProject(cancelled, "confirm")).rejects.toThrow("已取消");
    expect((await f.api.read(path)).content).toBe(before);
    for (const status of ["Paused", "Completed", "Archive", "Active"]) {
      const identity = await propose(status);
      const preview = await f.api.reviewProject(identity, "preview");
      const [saved, repeat] = await Promise.all([confirm(f.api, "Project", identity), confirm(f.api, "Project", identity)]);
      expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
      expect((await f.api.read(path)).content).toBe(before.replace("status: Active", `status: ${status}`));
      expect((await f.api.read(path)).content).toBe(preview.plan.after);
      expect((await f.api.read(path)).tasks).toEqual({ completed: 0, total: 1 });
      expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    }
    const restored = await propose("Paused");
    expect((await confirm(f.api, "Project", restored)).status).toBe("completed");
    await f.api.activity();
    expect((await f.api.restore(restored.planId)).status).toBe("completed");
    expect((await f.api.read(path)).content).toBe(before);
    const conflict = await propose("Paused");
    await writeFile(join(f.root, path), before + "External edit");
    expect((await confirm(f.api, "Project", conflict)).status).toBe("stale");
    expect((await f.api.read(path)).content).toBe(before + "External edit");
    expect((await f.api.read("Projects/B/Same.md")).content).toBe(before);
    await mkdir(join(f.root, "Projects/Active"));
    await writeFile(join(f.root, "Projects/Active/Legacy.md"), "# Legacy");
    const legacy = await f.api.read("Projects/Active/Legacy.md");
    await f.run("learning_read", { path: legacy.path });
    expect((await f.run("learning_plan_project_status", { path: legacy.path, version: legacy.version, status: "Paused" })).isError).toBe(true);
    expect((await f.api.read(legacy.path)).content).toBe("# Legacy");
  });
  it("checks only the selected same-label goal task, supports reopening, conflict checks and backup restoration", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Learning"));
    const path = "Learning/goal.md";
    const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Active # keep\r\nevidence: []\r\n---\r\n# Goal\r\n- [ ] Same task\r\n- [ ] Same task\r\n\r\n## Evidence\r\nKeep evidence\r\n';
    await writeFile(join(f.root, path), before);
    await f.api.prepareAssistant();
    async function propose(checked = true) {
      const note = await f.api.read(path);
      const args = { path, version: note.version, line: 8, checked };
      expect((await f.run("learning_plan_goal_task", args)).isError).not.toBe(true);
      const read = await f.run("learning_read", { path });
      expect(JSON.parse((read.content[0] as { text: string }).text).checklist).toEqual([
        { line: 7, checked: false, text: "Same task" }, { line: 8, checked: !checked, text: "Same task" },
      ]);
      const result = await f.run("learning_plan_goal_task", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    }
    const cancelled = await propose();
    await expect(f.api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    expect((await f.api.reviewGoal(cancelled, "cancel")).status).toBe("cancelled");
    expect((await f.api.read(path)).content).toBe(before);
    const source = await f.api.read(path);
    const result = await f.run("learning_plan_goal_task", { path, version: source.version, line: 8, checked: true });
    expect(result.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    const [saved, repeat] = await Promise.all([confirm(f.api, "Goal", identity), confirm(f.api, "Goal", identity)]);
    expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
    const expected = before.replace('- [ ] Same task\r\n\r\n## Evidence', '- [x] Same task\r\n\r\n## Evidence');
    expect((await f.api.read(path)).content).toBe(expected);
    expect((await f.api.read(path)).tasks).toEqual({ completed: 1, total: 2 });
    expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    const reopened = await propose(false);
    expect((await confirm(f.api, "Goal", reopened)).status).toBe("completed");
    expect((await f.api.read(path)).content).toBe(before);
    await f.api.activity();
    expect((await f.api.restore(reopened.planId)).status).toBe("completed");
    expect((await f.api.read(path)).content).toBe(expected);
    const conflict = await f.run("learning_plan_goal_task", { path, version: (await f.api.read(path)).version, line: 8, checked: false });
    expect(conflict.isError).not.toBe(true);
    const pending = JSON.parse(JSON.stringify(conflict.meta)).goalProposal as DailyProposal;
    await writeFile(join(f.root, path), "External\r\n" + expected);
    expect((await confirm(f.api, "Goal", pending)).status).toBe("stale");
    expect((await f.api.read(path)).content).toBe("External\r\n" + expected);
  });
  it("appends learning actions only after confirmation, preserves evidence and supports cancel, conflict and restore", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Learning"));
    const path = "Learning/goal.md";
    const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Active\r\ncustom: keep\r\n---\r\n# Goal\r\n## Outcome\r\nWrite a parser\r\n## Evidence\r\nExisting evidence\r\n- [x] Original task\r\n';
    await writeFile(join(f.root, path), before);
    await f.api.prepareAssistant();
    const source = await f.api.read(path);
    const args = { path, version: source.version, steps: ["Read the reference", "Implement a parser"] };
    expect((await f.run("learning_plan_goal_steps", args)).isError).not.toBe(true);
    await f.run("learning_read", { path });
    const propose = async () => {
      const result = await f.run("learning_plan_goal_steps", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    };
    const cancelled = await propose();
    await expect(f.api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    expect((await f.api.reviewGoal(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewGoal(cancelled, "confirm")).rejects.toThrow("已取消");
    expect((await f.api.read(path)).content).toBe(before);
    const identity = await propose();
    const preview = await f.api.reviewGoal(identity, "preview");
    const [saved, repeat] = await Promise.all([confirm(f.api, "Goal", identity), confirm(f.api, "Goal", identity)]);
    expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
    const note = await f.api.read(path);
    expect(note.content).toBe(preview.plan.after);
    expect(note.content.startsWith(before)).toBe(true);
    expect(note.tasks).toEqual({ completed: 1, total: 3 });
    expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    expect((await f.api.restore(identity.planId)).status).toBe("completed");
    expect((await f.api.read(path)).content).toBe(before);
    const conflict = await propose();
    await writeFile(join(f.root, path), before + "External edit");
    expect((await confirm(f.api, "Goal", conflict)).status).toBe("stale");
    expect((await f.api.read(path)).content).toBe(before + "External edit");
  });
  it("saves a sourced period review only through report confirmation with cancellation, once-only creation and collisions", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Daily"));
    await writeFile(join(f.root, "Daily/2026-10-28.md"), "# Daily\nFinished a test");
    await f.api.prepareAssistant();
    await f.run("learning_read", { path: "Daily/2026-10-28.md" });
    const source = await f.api.read("Daily/2026-10-28.md");
    const args = { title: "Period review", startDate: "2026-10-27", endDate: "2026-10-28", content: "## Facts\nFinished a test", sources: [{ path: source.path, version: source.version }] };
    const propose = async (title = args.title) => {
      const result = await f.run("learning_plan_review", { ...args, title });
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).reportProposal as DailyProposal;
    };
    const cancelled = await propose();
    const preview = await f.api.reviewReport(cancelled, "preview");
    expect(preview).toMatchObject({ status: "pending", plan: { path: "Wiki/Period review.md", create: true, report: { missingDailyDates: ["2026-10-27"] } } });
    await expect(f.api.read(preview.plan.path)).rejects.toThrow();
    await expect(f.api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    await expect(f.api.reviewDaily(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.run("assistant-report-confirm", { ...cancelled, approved: true })).isError).toBe(true);
    expect((await f.api.reviewReport(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewReport(cancelled, "confirm")).rejects.toThrow("已取消");
    await expect(f.api.read(preview.plan.path)).rejects.toThrow();
    const identity = await propose();
    const pending = await f.api.reviewReport(identity, "preview");
    const [saved, repeat] = await Promise.all([confirm(f.api, "Report", identity), confirm(f.api, "Report", identity)]);
    expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
    expect((await f.api.read(pending.plan.path)).content).toBe(pending.plan.after);
    expect((await f.api.read(source.path)).content).toBe(source.content);
    expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    expect((await f.api.reviewReport(identity, "preview")).status).toBe("completed");
    expect((await f.run("learning_plan_review", args)).isError).toBe(true);
    const conflict = await propose("Collision");
    await writeFile(join(f.root, "Wiki/Collision.md"), "External report");
    expect((await confirm(f.api, "Report", conflict)).status).toBe("stale");
    expect((await f.api.read("Wiki/Collision.md")).content).toBe("External report");
  });

  it("refuses changed review sources and old report workspace or session confirmations", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Daily"));
    const path = "Daily/2026-10-28.md";
    await writeFile(join(f.root, path), "Original");
    await f.api.prepareAssistant();
    await f.run("learning_read", { path });
    const source = await f.api.read(path);
    const args = { title: "Review", startDate: "2026-10-28", endDate: "2026-10-28", content: "Summary", sources: [{ path, version: source.version }] };
    const propose = async () => {
      const result = await f.run("learning_plan_review", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).reportProposal as DailyProposal;
    };
    const stale = await propose();
    await writeFile(join(f.root, path), "External edit");
    expect((await confirm(f.api, "Report", stale)).status).toBe("stale");
    await expect(f.api.read("Wiki/Review.md")).rejects.toThrow();
    await writeFile(join(f.root, path), source.content);
    const pending = await propose();
    f.configure({ ...f.vault, folders: { ...f.vault.folders, knowledge: "Knowledge" } });
    await expect(f.api.reviewReport(pending, "confirm")).rejects.toThrow("资料目录设置已变化");
    f.configure(f.vault); f.configureBinding({ cwd: f.root, sessionId: "replacement" });
    await expect(f.api.reviewReport(pending, "confirm")).rejects.toThrow("会话已变化");
    await expect(f.api.read("Wiki/Review.md")).rejects.toThrow();
  });

  it("creates a learning goal only through card confirmation, supports cancellation and saves exactly once", async () => {
    const f = await fixture();
    await f.api.prepareAssistant();
    const args = { title: "TypeScript", purpose: "Build a tool", background: "Know JavaScript", outcome: "Write a typed parser",
      verification: "Run against unseen inputs", schedule: "Two hours each week", targetDate: "2026-11-28" };
    const propose = async () => {
      const result = await f.run("learning_plan_goal", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    };
    const cancelled = await propose();
    const preview = await f.api.reviewGoal(cancelled, "preview");
    expect(preview).toMatchObject({ status: "pending", plan: { path: "Learning/TypeScript.md", create: true, before: "" } });
    await expect(f.api.read(preview.plan.path)).rejects.toThrow();
    await expect(f.api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    await expect(f.api.reviewDaily(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.run("assistant-goal-confirm", { ...cancelled, approved: true })).isError).toBe(true);
    expect((await f.api.reviewGoal(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewGoal(cancelled, "confirm")).rejects.toThrow("已取消");
    await expect(f.api.read(preview.plan.path)).rejects.toThrow();
    const identity = await propose();
    const current = await f.api.reviewGoal(identity, "preview");
    const [saved, repeat] = await Promise.all([confirm(f.api, "Goal", identity), confirm(f.api, "Goal", identity)]);
    expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
    expect((await f.api.read(current.plan.path)).content).toBe(current.plan.after);
    expect(current.plan.after).toContain("type: learning-goal");
    expect(current.plan.after).toContain("evidence: []");
    for (const value of Object.values(args)) expect(current.plan.after).toContain(value);
    expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    expect((await f.api.reviewGoal(identity, "preview")).status).toBe("completed");
    expect((await f.run("learning_plan_goal", args)).isError).toBe(true);
  });

  it("keeps learning goal creation in the mapped folder and refuses collisions and stale confirmations", async () => {
    const f = await fixture(true, false, { ...defaultFolders, inbox: "收件箱", learning: "Goals/学习" });
    const mapped = f.vault;
    f.configure(mapped);
    const api = businessApi(f.rpc, mapped);
    await api.prepareAssistant();
    const args = { title: "Parser", outcome: "Write a parser", verification: "Independent examples" };
    const result = await f.run("learning_plan_goal", args);
    expect(result.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(result.meta)).goalProposal as DailyProposal;
    const preview = await api.reviewGoal(identity, "preview");
    expect(preview.plan.path).toBe("Goals/学习/Parser.md");
    expect(preview.plan.after).toContain("targetDate: null");
    expect(preview.plan.after).toContain('schedule: ""');
    await mkdir(join(f.root, "Goals/学习"), { recursive: true });
    await writeFile(join(f.root, preview.plan.path), "External goal");
    expect((await confirm(api, "Goal", identity)).status).toBe("stale");
    expect((await api.read(preview.plan.path)).content).toBe("External goal");
    const next = await f.run("learning_plan_goal", { ...args, title: "New goal" });
    expect(next.isError).not.toBe(true);
    const pending = JSON.parse(JSON.stringify(next.meta)).goalProposal as DailyProposal;
    f.configure({ ...f.vault, folders: { ...f.vault.folders, learning: "Learning" } });
    await expect(api.reviewGoal(pending, "confirm")).rejects.toThrow("资料目录设置已变化");
    f.configure(mapped); f.configureBinding({ cwd: f.root, sessionId: "replacement" });
    await expect(api.reviewGoal(pending, "confirm")).rejects.toThrow("会话已变化");
    await expect(api.read("Goals/学习/New goal.md")).rejects.toThrow();
  });

  it("organizes one Inbox note into an exact existing knowledge path with trusted confirmation and restoration", async () => {
    const f = await fixture();
    const source = await f.api.capture("整理来源", "# Source\nTypeScript union types\n");
    await mkdir(join(f.root, "Wiki/A"), { recursive: true });
    await mkdir(join(f.root, "Wiki/B"), { recursive: true });
    const before = '\uFEFF---\r\ncustom: keep\r\n---\r\n# TypeScript\r\nOriginal';
    await writeFile(join(f.root, "Wiki/A/TypeScript.md"), before);
    await writeFile(join(f.root, "Wiki/B/TypeScript.md"), "# Same title\nKeep");
    const target = await f.api.read("Wiki/A/TypeScript.md");
    await f.api.prepareAssistant();
    await f.run("learning_search", { query: "TypeScript" });
    await f.run("learning_read", { path: source.path });
    await f.run("learning_read", { path: target.path });
    const args = { sourcePath: source.path, sourceVersion: source.version, targetPath: target.path,
      targetVersion: target.version, content: "Union types accept either member type.", reason: "与现有 TypeScript 笔记主题一致" };
    const propose = async () => {
      const result = await f.run("learning_plan_inbox", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).inboxProposal as DailyProposal;
    };
    const cancelled = await propose();
    const preview = await f.api.reviewInbox(cancelled, "preview");
    expect(preview.plan).toMatchObject({ path: target.path, before, create: false, inbox: { path: source.path, version: source.version, reason: args.reason } });
    expect(preview.plan.after.startsWith(before)).toBe(true);
    expect(preview.plan.after).toContain(source.version);
    expect(preview.plan.after).toContain("../");
    await expect(f.api.execute(cancelled.planId)).rejects.toThrow("方案卡片");
    await expect(f.api.reviewDaily(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.api.reviewInbox(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewInbox(cancelled, "confirm")).rejects.toThrow("已取消");
    expect((await f.api.read(target.path)).content).toBe(before);
    const identity = await propose();
    const [first, repeat] = await Promise.all([confirm(f.api, "Inbox", identity), confirm(f.api, "Inbox", identity)]);
    expect(first.status).toBe("completed"); expect(repeat).toEqual(first);
    expect((await f.api.read(target.path)).content).toBe(preview.plan.after);
    expect((await f.api.read(source.path)).content).toBe(source.content);
    expect((await f.api.read("Wiki/B/TypeScript.md")).content).toBe("# Same title\nKeep");
    await f.api.activity();
    expect((await f.api.restore(identity.planId)).status).toBe("completed");
    expect((await f.api.read(target.path)).content).toBe(before);
  });

  it("creates a knowledge note only on confirmation and refuses external source or target changes", async () => {
    const f = await fixture();
    const source = await f.api.capture("来源", "# Original\nSome learning notes");
    await f.api.prepareAssistant();
    await f.run("learning_search", { query: "learning" });
    await f.run("learning_read", { path: source.path });
    const args = { sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/new.md", content: "# New knowledge\nA sourced fact", reason: "没有可合并的知识笔记" };
    const propose = async () => {
      const result = await f.run("learning_plan_inbox", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse(JSON.stringify(result.meta)).inboxProposal as DailyProposal;
    };
    const staleSource = await propose();
    await expect(f.api.read(args.targetPath)).rejects.toThrow();
    await writeFile(join(f.root, source.path), "External source edit");
    const rejected = await confirm(f.api, "Inbox", staleSource);
    expect(rejected.status).toBe("stale");
    await expect(f.api.read(args.targetPath)).rejects.toThrow();
    await writeFile(join(f.root, source.path), source.content);
    const staleTarget = await propose();
    await mkdir(join(f.root, "Wiki"), { recursive: true });
    await writeFile(join(f.root, args.targetPath), "External target");
    expect((await confirm(f.api, "Inbox", staleTarget)).status).toBe("stale");
    expect((await f.api.read(args.targetPath)).content).toBe("External target");
    const created = await f.run("learning_plan_inbox", { ...args, targetPath: "Wiki/created.md" });
    expect(created.isError).not.toBe(true);
    const identity = JSON.parse(JSON.stringify(created.meta)).inboxProposal as DailyProposal;
    expect((await confirm(f.api, "Inbox", identity)).status).toBe("completed");
    expect((await f.api.read("Wiki/created.md")).content).toContain(source.path);
    expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
  });

  it("requires a full goal read and confirms evidence once through goal-only routes with cancel, conflict and restore", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Learning"));
    const path = "Learning/goal.md";
    const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Active\r\nevidence: []\r\n---\r\n# Goal\r\n- [x] Done\r\n- [ ] Pending\r\n\r\n## Evidence\r\n\r\nExisting\r\n\r\n## Logs\r\nKeep\r\n';
    await writeFile(join(f.root, path), before);
    await f.api.prepareAssistant();
    const original = await f.api.read(path);
    const args = { path, version: original.version, content: "Completed an independent exercise" };
    expect((await f.run("learning_plan_goal_evidence", args)).isError).not.toBe(true);
    const read = await f.run("learning_read", { path });
    expect(JSON.parse((read.content[0] as { text: string }).text).tasks).toEqual({ completed: 1, total: 2 });
    async function propose() {
      const result = await f.run("learning_plan_goal_evidence", args);
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content[0] as { text: string }).text) as DailyProposal;
    }
    const cancelled = await propose();
    await expect(f.api.reviewProject(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.api.reviewGoal(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewGoal(cancelled, "confirm")).rejects.toThrow("已取消");
    expect(await readFile(join(f.root, path), "utf8")).toBe(before);
    const identity = await propose();
    await expect(f.api.execute(identity.planId)).rejects.toThrow("方案卡片");
    const preview = await f.api.reviewGoal(identity, "preview");
    const [saved, repeat] = await Promise.all([confirm(f.api, "Goal", identity), confirm(f.api, "Goal", identity)]);
    expect(saved.status).toBe("completed"); expect(repeat).toEqual(saved);
    expect(await readFile(join(f.root, path), "utf8")).toBe(preview.plan.after);
    expect((await f.api.read(path)).tasks).toEqual(original.tasks);
    await f.api.activity();
    expect((await f.api.restore(identity.planId)).status).toBe("completed");
    expect(await readFile(join(f.root, path), "utf8")).toBe(before);
    const conflict = await propose();
    await writeFile(join(f.root, path), before + "External edit");
    expect((await confirm(f.api, "Goal", conflict)).status).toBe("stale");
    expect(await readFile(join(f.root, path), "utf8")).toBe(before + "External edit");
    await writeFile(join(f.root, path), "# Not a learning goal");
    const ordinary = await f.api.read(path);
    await f.run("learning_read", { path });
    expect((await f.run("learning_plan_goal_evidence", { ...args, version: ordinary.version })).isError).toBe(true);
  });
  async function projectProposal(f: Awaited<ReturnType<typeof fixture>>, path: string, content: string) {
    await f.api.prepareAssistant();
    const read = await f.run("learning_read", { path });
    expect(read.isError).not.toBe(true);
    const reference = JSON.parse((read.content[0] as { text: string }).text).reference;
    const result = await f.run("learning_plan_project_progress", { path, version: reference.version, content });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content[0] as { text: string }).text) as DailyProposal;
  }
  it("appends only to the selected same-name project, preserves its properties and supports cancel, once-only save and restore", async () => {
    const f = await fixture();
    const before = '\uFEFF---\r\nstatus: Active # keep\r\ncustom: [a, b]\r\n---\r\n# 同名项目\r\n\r\n- [ ] 原任务\r\n\r\n## Progress\r\n\r\n旧进展\r\n\r\n## Logs\r\n\r\n旧日志\r\n';
    await mkdir(join(f.root, "Projects/A"), { recursive: true });
    await mkdir(join(f.root, "Projects/B"), { recursive: true });
    const path = "Projects/A/同名项目.md";
    await writeFile(join(f.root, path), before);
    await writeFile(join(f.root, "Projects/B/同名项目.md"), before);
    const cancelled = await projectProposal(f, path, "取消的记录");
    await expect(f.api.reviewDaily(cancelled, "confirm")).rejects.toThrow("类型不匹配");
    expect((await f.api.reviewProject(cancelled, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewProject(cancelled, "confirm")).rejects.toThrow("已取消");
    expect(await readFile(join(f.root, path), "utf8")).toBe(before);
    const identity = await projectProposal(f, path, "完成接口测试\n下一步验证界面");
    const preview = await f.api.reviewProject(identity, "preview");
    expect(preview.plan.before).toBe(before);
    expect(preview.plan.after).toBe(before.replace("旧进展\r\n\r\n## Logs", "旧进展\r\n\r\n完成接口测试\r\n下一步验证界面\r\n\r\n## Logs"));
    await expect(f.api.execute(identity.planId)).rejects.toThrow("方案卡片");
    expect((await f.run("assistant-project-confirm", { ...identity, approved: true })).isError).toBe(true);
    const [first, repeat] = await Promise.all([confirm(f.api, "Project", identity), confirm(f.api, "Project", identity)]);
    expect(first.status).toBe("completed"); expect(repeat).toEqual(first);
    expect(await readFile(join(f.root, path), "utf8")).toBe(preview.plan.after);
    expect(await readFile(join(f.root, "Projects/B/同名项目.md"), "utf8")).toBe(before);
    expect((await f.api.activity()).filter(item => item.id === identity.planId)).toHaveLength(1);
    expect((await f.api.restore(identity.planId)).status).toBe("completed");
    expect(await readFile(join(f.root, path), "utf8")).toBe(before);
  });
  it("rejects project creation, external edits and old Vault or session confirmations", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Projects"));
    const path = "Projects/test.md";
    await writeFile(join(f.root, path), "# Test\n");
    await f.api.prepareAssistant();
    expect((await f.run("learning_plan_project_progress", { path: "Projects/missing.md", version: "a".repeat(64), content: "test" })).isError).toBe(true);
    const identity = await projectProposal(f, path, "test progress");
    await writeFile(join(f.root, path), "external edit");
    expect(await confirm(f.api, "Project", identity)).toMatchObject({ status: "stale", validationError: expect.stringContaining("changed externally") });
    expect(await readFile(join(f.root, path), "utf8")).toBe("external edit");
    const next = await projectProposal(f, path, "test progress");
    f.configure({ ...f.vault, folders: { ...f.vault.folders, projects: "OtherProjects" } });
    await expect(f.api.reviewProject(next, "confirm")).rejects.toThrow("资料目录设置已变化");
    f.configure(f.vault); f.configureBinding({ cwd: f.root, sessionId: "replacement" });
    await expect(f.api.reviewProject(next, "confirm")).rejects.toThrow("会话已变化");
    expect(await readFile(join(f.root, path), "utf8")).toBe("external edit");
  });
  async function proposal(f: Awaited<ReturnType<typeof fixture>>, date = "2026-10-10", content = "学习 TypeScript") {
    await f.api.prepareAssistant();
    const result = await f.run("learning_plan_daily", { date, content });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content[0] as { text: string }).text) as DailyProposal;
  }
  it("lets the model propose, but only the client can cancel or confirm exactly once", async () => {
    const f = await fixture();
    const identity = await proposal(f);
    const preview = await f.api.reviewDaily(identity, "preview");
    expect(preview).toMatchObject({ status: "pending", plan: { path: "Daily/2026-10-10.md", create: true } });
    await expect(readFile(join(f.root, preview.plan.path))).rejects.toMatchObject({ code: "ENOENT" });
    for (const tool of ["execute", "assistant-daily-confirm", "bash"]) expect((await f.run(tool, { ...identity, approved: true })).isError).toBe(true);
    await expect(f.api.execute(identity.planId)).rejects.toThrow("方案卡片");
    expect((await f.api.reviewDaily(identity, "cancel")).status).toBe("cancelled");
    await expect(f.api.reviewDaily(identity, "confirm")).rejects.toThrow("已取消");
    await expect(readFile(join(f.root, preview.plan.path))).rejects.toMatchObject({ code: "ENOENT" });
    const next = await proposal(f);
    const [first, repeat] = await Promise.all([confirm(f.api, "Daily", next), confirm(f.api, "Daily", next)]);
    expect(first.status).toBe("completed"); expect(repeat).toEqual(first);
    expect((await f.api.read(preview.plan.path)).content).toBe("# 2026-10-10\n\n学习 TypeScript\n");
    expect((await f.api.activity()).filter(item => item.id === next.planId)).toHaveLength(1);
    expect((await f.api.reviewDaily(next, "preview")).status).toBe("completed");
  });
  it("preserves external changes and allows explicit backup restoration after a successful append", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "Daily"));
    const path = join(f.root, "Daily/2026-10-10.md");
    await writeFile(path, "# 原文\n");
    const old = await proposal(f);
    await writeFile(path, "# Obsidian 外部编辑\n");
    const failed = await confirm(f.api, "Daily", old);
    expect(failed).toMatchObject({ status: "stale", validationError: expect.stringContaining("changed externally") });
    expect(await readFile(path, "utf8")).toBe("# Obsidian 外部编辑\n");
    const next = await proposal(f);
    expect((await confirm(f.api, "Daily", next)).status).toBe("completed");
    await f.api.activity();
    expect((await f.api.restore(next.planId)).status).toBe("completed");
    expect(await readFile(path, "utf8")).toBe("# Obsidian 外部编辑\n");
  });
  it("rejects stale bindings, forged proposal identities, changed plans and invalid dates", async () => {
    const f = await fixture();
    const identity = await proposal(f);
    await expect(f.api.reviewDaily({ ...identity, planId: "not-a-plan" }, "confirm")).rejects.toThrow();
    await expect(f.api.reviewDaily({ ...identity, sessionId: "different" }, "confirm")).rejects.toThrow();
    expect((await f.run("learning_plan_daily", { date: "2026-02-30", content: "test" })).isError).toBe(true);
    const planFile = join(f.root, ".ai-learning-os/plans", `${identity.planId}.json`);
    const plan = JSON.parse(await readFile(planFile, "utf8"));
    await writeFile(planFile, JSON.stringify({ ...plan, after: "tampered" }));
    expect(await confirm(f.api, "Daily", identity)).toMatchObject({ status: "stale", validationError: expect.stringContaining("Plan changed") });
    f.configureBinding({ cwd: f.root, sessionId: "new-session" });
    await expect(f.api.reviewDaily(identity, "preview")).rejects.toThrow("会话已变化");
    expect(await f.api.list()).toEqual([]);
  });
  it("prepares only the bound assistant through the scoped host endpoint", async () => {
    const { api } = await fixture();
    expect(await api.prepareAssistant()).toEqual({ ready: true });
  });
  it("previews project state and a learning goal through host routes without premature writes", async () => {
    const { root, api } = await fixture();
    await mkdir(join(root, "Projects"));
    await writeFile(join(root, "Projects", "demo.md"), "# Demo\n");
    const project = await api.read("Projects/demo.md");
    const status = await api.planProjectStatus(project.path, project.version, "Completed");
    expect((await api.read(project.path)).status).toBeUndefined();
    expect(await api.execute(status.id)).toMatchObject({ status: "completed" });
    expect((await api.read(project.path)).status).toBe("Completed");
    const goal = await api.planLearningGoal({ title: "学习测试", purpose: "", background: "", outcome: "完成测试", schedule: "每周一次", targetDate: "", verification: "独立运行" });
    expect((await api.list()).some(note => note.path === goal.path)).toBe(false);
    expect(await api.execute(goal.id)).toMatchObject({ status: "completed" });
    expect((await api.read(goal.path)).content).toContain("独立运行");
  });

  it("shares preview state across calls, executes once, and restores the original bytes", async () => {
    const { root, api } = await fixture();
    expect(await api.list()).toEqual([]);
    const before = '\uFEFF---\r\ncustom: "unchanged"\r\n---\r\n# 原文\r\n';
    const note = await api.capture("业务闭环", before);
    expect(note.path).toBe("收件箱/业务闭环.md");
    expect(await api.list("原文")).toMatchObject([{ path: note.path, category: "inbox" }]);
    const plan = await api.planUpdate(note.path, note.version, "# 更新\n");
    expect(await readFile(join(root, note.path), "utf8")).toBe(before);
    const [first, duplicate] = await Promise.all([api.execute(plan.id), api.execute(plan.id)]);
    expect(first).toMatchObject({ id: plan.id, status: "completed", kind: "update" });
    expect(duplicate).toEqual(first);
    expect((await api.read(note.path)).content).toBe("# 更新\n");
    expect(await api.activity()).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
    expect(await api.restore(first.id)).toMatchObject({ kind: "restore", status: "completed" });
    expect(await readFile(join(root, note.path), "utf8")).toBe(before);
    const activity = await api.activity();
    expect(activity.filter((entry) => entry.kind === "update")).toHaveLength(1);
    expect(activity.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["capture", "update", "restore"]));
  });

  it("surfaces host capture errors without overwriting the existing note", async () => {
    const { api } = await fixture();
    const note = await api.capture("保留", "original");
    await expect(api.capture("保留", "replacement")).rejects.toThrow();
    expect((await api.read(note.path)).content).toBe("original");
  });

  it("exposes Daily preview and execution through the authenticated host route", async () => {
    const { api } = await fixture();
    const plan = await api.planDailyAppend("2026-09-30", "完成一次 Daily 记录");
    expect(plan).toMatchObject({ path: "Daily/2026-09-30.md", create: true });
    expect(await api.execute(plan.id)).toMatchObject({ path: plan.path, status: "completed" });
    expect((await api.read(plan.path)).content).toContain("完成一次 Daily 记录");
  });

  it("exposes project progress preview and execution through the host route", async () => {
    const { root, api } = await fixture();
    const projectPath = join(root, "Projects", "demo.md");
    await mkdir(join(root, "Projects"), { recursive: true });
    await writeFile(projectPath, "# Demo\n\n## Progress\n\n旧进展\n");
    const project = await api.read("Projects/demo.md");
    const plan = await api.planProjectAppend(project.path, project.version, "新进展");
    expect(plan).toMatchObject({ path: project.path, create: false });
    expect(await api.execute(plan.id)).toMatchObject({ path: project.path, status: "completed" });
    expect((await api.read(project.path)).content).toContain("新进展");
  });

  it("rejects malformed RPC envelopes and unknown routes before any write", async () => {
    const { root, dispatch } = await fixture();
    const valid = { type: "client-request", rpcId: "request", method: "learning-os/capture", payload: {} };
    for (const envelope of [null, [], {}, { ...valid, type: "other" }, { ...valid, rpcId: 1 },
      { ...valid, rpcId: "x".repeat(201) }, { ...valid, method: "learning-os/read" },
      { type: "client-request", rpcId: "request", method: "learning-os/capture" }]) {
      const response = await dispatch("capture", envelope);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Invalid RPC envelope");
    }
    expect((await dispatch("unknown", valid)).status).toBe(404);
    expect(await readdir(root)).toEqual([".ai-learning-os"]);
    expect(await readdir(join(root, ".ai-learning-os"))).toEqual(["space.json"]);
  });

  it("rejects malformed business payloads without writing", async () => {
    const { root, dispatch, scope } = await fixture();
    for (const [method, payload] of [
      ["capture", null], ["capture", []], ["capture", { title: 42, content: "blocked" }],
      ["capture", { title: "拒绝", content: {} }], ["capture", { title: "x".repeat(201), content: "blocked" }],
      ["execute", {}],
    ] as const) {
      const request = payload && !Array.isArray(payload) ? { ...payload, scope } : payload;
      const response = await dispatch(method, { type: "client-request", rpcId: "request", method: `learning-os/${method}`, payload: request });
      expect(response.status).toBe(200);
      expect((await response.json()).result).toMatchObject({ ok: false, error: { code: "learning-os/operation-failed" } });
    }
    expect(await readdir(root)).toEqual([".ai-learning-os"]);
    expect(await readdir(join(root, ".ai-learning-os"))).toEqual(["space.json"]);
  });

  it("requires a configured root and propagates that error to the client", async () => {
    const { root, api } = await fixture(false);
    await expect(api.list()).rejects.toThrow("请先设置资料目录");
    await expect(api.capture("拒绝", "blocked")).rejects.toThrow("请先设置资料目录");
    expect(await readdir(root)).toEqual([".ai-learning-os"]);
    expect(await readdir(join(root, ".ai-learning-os"))).toEqual(["space.json"]);
  });

  it("refuses an old client's writes after host configuration switches to another Vault", async () => {
    const { api, configure, rpc, vault } = await fixture();
    const nextRoot = await mkdtemp(join(tmpdir(), "learning-host-business-"));
    roots.push(nextRoot);
    const nextVault = { ...vault, root: nextRoot };
    configure(nextVault);
    await expect(api.capture("过期请求", "must not cross spaces")).rejects.toThrow();
    expect(await readdir(nextRoot)).toEqual([]);
    const current = businessApi(rpc, nextVault);
    await expect(current.capture("当前空间", "current content")).rejects.toThrow("不一致");
    expect(await readdir(nextRoot)).toEqual([]);
  });
});
