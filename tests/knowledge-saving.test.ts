import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeCore } from "../src/knowledge-core";
import { knowledgeTemplateId, readKnowledgeMetadata, type KnowledgeDraft } from "../src/knowledge-synthesis";
import { mergeKnowledge } from "../src/knowledge-document";
import { managerPlan, managerSnapshot } from "../src/knowledge-manager-contract";
import type { VaultService } from "../src/vault";
import { testSharedVault } from "./shared-vault-fixture";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-saving-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const folder of ["Inbox", "Wiki", "Projects", "Learning"]) await mkdir(join(root, folder));
  const write = (path: string, content: string) => writeFile(join(root, path), content);
  await write("Projects/a.md", "# 项目\n接口需要版本。\n");
  await write("Learning/b.md", "# 学习\n版本支持独立演进。\n");
  const core = new KnowledgeCore("test", root); await core.initialize();
  cleanups.push(() => core.stop());
  const a = await core.read("Projects/a.md"), b = await core.read("Learning/b.md");
  const draft: KnowledgeDraft = { template: knowledgeTemplateId, request: "整理接口", title: "接口知识", summary: "版本与演进。",
    sources: [a, b].map(note => ({ path: note.path, version: note.version, total: note.content.length, ranges: [{ start: 0, end: note.content.length }] })),
    groups: [{ title: "接口", items: [{ id: "version", title: "版本", content: "接口通过版本独立演进。",
      evidence: [a, b].map(note => ({ path: note.path, start: 0, end: note.content.length, quote: note.content })) }] }], relations: [], unknowns: [] };
  const input = { targetPath: "Wiki/topic.md", draft };
  const save = (entry: Awaited<ReturnType<KnowledgeCore["proposeKnowledge"]>>, authorization: "user-request" | "full-access" = "user-request") => core.requestConfirmation(entry.plan.id, entry.revision, undefined, signal(), authorization);
  return { root, core, write, a, b, draft, input, save };
}

describe("multi-source knowledge saving", () => {
  it("saves an authorized ordinary draft once with evidence, records and reuse", async () => {
    const f = await fixture(), entry = await f.core.proposeKnowledge(f.input);
    expect(managerPlan.parse(entry).plan.knowledge?.sources).toHaveLength(2);
    await expect(readFile(join(f.root, f.input.targetPath))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await Promise.all([f.save(entry), f.save(entry)]);
    expect(saved.every(item => item.status === "completed")).toBe(true);
    expect(saved.some(item => item.confirmation === "not-required")).toBe(true);
    expect(await readdir(join(f.root, ".ai-learning-os/activity"))).toHaveLength(1);
    const note = await f.core.read(f.input.targetPath), provenance = await f.core.provenance(note.path, note.version);
    expect(provenance.history[0].sources?.map(item => item.state)).toEqual(["unchanged", "unchanged"]);
    expect(provenance.history[0].sources?.[0].evidence[0].quote).toBe(f.a.content);
    expect((await f.core.records("", 0, signal())).items[0]).toMatchObject({ sourceCount: 2, summary: "整理知识 · 2 个来源" });
    expect((await f.core.collectKnowledge({ topicPath: note.path, projectPaths: [f.a.path], learningPaths: [f.b.path], request: f.draft.request })).reuse?.state).toBe("reusable");
  });

  it("queries real saved block items and relations as bounded, version-consistent views", async () => {
    const f = await fixture();
    const evidence = [{ path: f.a.path, start: 0, end: f.a.content.length, quote: f.a.content }];
    f.draft.groups = [{ title: "接口", items: Array.from({ length: 23 }, (_, i) => ({ id: `item-${i}`, title: `概念 ${i}`, content: "适用条件。".repeat(200), evidence })) }];
    f.draft.relations = Array.from({ length: 13 }, (_, i) => ({ from: `item-${i}`, to: "item-22", type: "应用于", origin: i === 0 ? "inferred" : "explicit", reason: "共同接口", evidence }));
    await f.save(await f.core.proposeKnowledge(f.input));
    const graph = await f.core.queryKnowledge({ topicPath: f.input.targetPath });
    expect(graph.organized).toMatchObject({ items: { total: 23, nextOffset: 10 }, relations: { total: 13, nextOffset: 10 }, invalidRelations: 0 });
    expect(graph.organized!.items.items).toHaveLength(10);
    expect(graph.organized!.endpoints.map(item => item.id)).toEqual(["item-22"]);
    expect(graph.organized!.relations.items[0]).toMatchObject({ from: "item-0", to: "item-22", type: "应用于", inferred: true });
    expect(graph.organized!.items.items[0].evidence).toContain(f.a.version);
    expect(graph.organized!.items.items[0].summary).toHaveLength(400);
    expect(JSON.stringify(graph)).not.toContain("适用条件。".repeat(100));
    for (const view of ["mindmap", "document"] as const) expect((await f.core.queryKnowledge({ topicPath: f.input.targetPath, version: graph.topic.version, view })).organized).toEqual(graph.organized);
    const second = await f.core.queryKnowledge({ topicPath: f.input.targetPath, version: graph.topic.version, offset: 10 });
    expect(second.organized!.items.items[0].id).toBe("item-10"); expect(second.organized!.relations.items).toHaveLength(3);
    const final = await f.core.queryKnowledge({ topicPath: f.input.targetPath, version: graph.topic.version, offset: 20 });
    expect(final.organized!.items.items).toHaveLength(3); expect(final.nextOffset).toBeNull();
    const note = await f.core.read(f.input.targetPath);
    await f.write(note.path, note.content.replace("### 概念 0", "### 人工修订"));
    await expect(f.core.queryKnowledge({ topicPath: note.path, version: graph.topic.version, offset: 10 })).rejects.toThrow("changed");
    expect((await f.core.queryKnowledge({ topicPath: note.path })).organized!.items.items[0].title).toBe("人工修订");
  });

  it("reuses short metadata for home and records and invalidates only changed files", async () => {
    const f = await fixture();
    await f.save(await f.core.proposeKnowledge(f.input));
    const vault = (f.core as unknown as { vault: VaultService }).vault, read = vi.spyOn(vault, "read"), list = vi.spyOn(vault, "list");
    const home = await f.core.management();
    expect(home.home?.knowledge.total).toBe(1); expect(home.home?.learning.total).toBe(1); expect(home.home?.records.total).toBe(1);
    expect(read).toHaveBeenCalledTimes(3); expect(list).not.toHaveBeenCalled();
    read.mockClear(); await f.core.management(); await f.core.records("", 0, signal());
    expect(read).not.toHaveBeenCalled();
    await f.write(f.a.path, f.a.content + "实际修改");
    const records = await f.core.records("", 0, signal());
    expect(read).toHaveBeenCalledTimes(1); expect(records.items[0].sourceState).toContain("来源已修改");
    read.mockClear(); await unlink(join(f.root, f.b.path));
    expect((await f.core.records("", 0, signal())).items[0].sourceState).toContain("来源已缺失");
    expect(read).not.toHaveBeenCalled();
    const uri = f.core.noteOpenUri("Wiki/中文 空格 & #.md");
    expect(decodeURIComponent(uri.split("?path=")[1])).toBe(join(f.root, "Wiki/中文 空格 & #.md"));
    expect(() => f.core.noteOpenUri("../outside.md")).toThrow();
  });

  it("requires current target versions and rejects changed sources/target and cancelled plans", async () => {
    const f = await fixture(), entry = await f.core.proposeKnowledge(f.input);
    await f.write(f.a.path, f.a.content + "外部修改");
    await expect(f.save(entry)).rejects.toThrow("source changed"); expect(entry.status).toBe("stale");
    await f.write(f.a.path, f.a.content);
    const cancelled = await f.core.proposeKnowledge(f.input); await f.core.cancel(cancelled.plan.id, 1);
    await expect(f.save(cancelled)).rejects.toThrow("cancelled");
    const conflict = await f.core.proposeKnowledge(f.input); await f.write(f.input.targetPath, "人工新建");
    await expect(f.save(conflict)).rejects.toThrow("created externally");
    await expect(f.core.proposeKnowledge(f.input)).rejects.toThrow("target changed");
    expect(await readFile(join(f.root, f.input.targetPath), "utf8")).toBe("人工新建");
  });

  it("rechecks every source immediately before replacing the target", async () => {
    const f = await fixture(), entry = await f.core.proposeKnowledge(f.input);
    const vault = (f.core as unknown as { vault: VaultService }).vault, read = vault.read.bind(vault);
    let count = 0;
    vi.spyOn(vault, "read").mockImplementation(async (path, ...args) => {
      if (path === f.b.path && ++count === 4) await f.write(path, f.b.content + "写入过程中变化");
      return read(path, ...args);
    });
    const saved = await f.save(entry);
    expect(count).toBe(4); expect(saved.status).toBe("failed"); expect(saved.result?.error).toContain("source changed");
    await expect(readFile(join(f.root, f.input.targetPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(f.root, "Wiki"))).filter(path => path.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves external prose, YAML, BOM and CRLF, and restores only before later edits", async () => {
    const f = await fixture();
    const before = "\uFEFF---\r\n# 人工注释\r\ncustom: keep # comment\r\n---\r\n# 人工正文\r\n\r\n保留这些文字。\r\n";
    await f.write(f.input.targetPath, before);
    const current = await f.core.read(f.input.targetPath);
    const entry = await f.core.proposeKnowledge({ ...f.input, targetVersion: current.version }); await f.save(entry);
    const note = await f.core.read(f.input.targetPath);
    expect(note.content).toContain("# 人工注释\r\ncustom: keep # comment\r\n"); expect(note.content).toContain("# 人工正文\r\n\r\n保留这些文字。\r\n");
    expect(note.content.startsWith("\uFEFF---\r\n")).toBe(true); expect(note.content.replace(/\r\n/g, "")).not.toContain("\n");
    const preview = await f.core.previewRestore(entry.plan.id);
    await f.write(note.path, note.content + "后续编辑");
    await expect(f.core.restoreConfirmed(entry.plan.id, preview, vi.fn(), signal(), "full-access")).rejects.toThrow();
    await f.write(note.path, note.content);
    const fresh = await f.core.previewRestore(entry.plan.id);
    expect((await f.core.restoreConfirmed(entry.plan.id, fresh, vi.fn(), signal(), "full-access")).status).toBe("completed");
    expect(await readFile(join(f.root, note.path), "utf8")).toBe(before);
  });

  it("updates generated sections and preserves omitted groups and manual text", async () => {
    const f = await fixture(), initial = await f.core.proposeKnowledge(f.input); await f.save(initial);
    const before = await f.core.read(f.input.targetPath);
    await f.write(before.path, before.content + "\n人工附录。\n");
    const current = await f.core.read(before.path);
    const draft = structuredClone(f.draft); draft.groups.push({ title: "补充", items: [{ ...draft.groups[0].items[0], id: "extra", content: "新增内容。" }] });
    const next = await f.core.proposeKnowledge({ ...f.input, draft, targetVersion: current.version }); await f.save(next);
    const now = await f.core.read(before.path); expect(now.content).toContain("人工附录。"); expect(now.content).toContain("^extra");
    const again = await f.core.proposeKnowledge({ ...f.input, targetVersion: now.version });
    expect(again.plan.after).toContain("^extra"); expect(again.plan.after).toContain("人工附录。");
  });

  it("keeps manual section edits, marks coverage incomplete and merges only an exact current replacement", async () => {
    const f = await fixture(), initial = await f.core.proposeKnowledge(f.input); await f.save(initial);
    const note = await f.core.read(f.input.targetPath);
    await f.write(note.path, note.content.replace("接口通过版本独立演进。", "人工补充：接口通过版本独立演进。"));
    const current = await f.core.read(note.path);
    const unchanged = await f.core.proposeKnowledge({ ...f.input, targetVersion: current.version });
    expect(unchanged.plan.after).toContain("人工补充：");
    const metadata = readKnowledgeMetadata(unchanged.plan.after); expect(metadata.state === "valid" && metadata.value.sources.every(source => !source.ranges.length)).toBe(true);
    const draft = structuredClone(f.draft); draft.groups[0].items[0].content = "更新说法。";
    await expect(f.core.proposeKnowledge({ ...f.input, draft, targetVersion: current.version })).rejects.toThrow("manual edits");
    const section = /<!-- learning-knowledge:start (group-[a-z0-9]+) -->[\s\S]*?<!-- learning-knowledge:end \1 -->/.exec(current.content)!;
    await expect(f.core.proposeKnowledge({ ...f.input, draft, targetVersion: current.version, replacements: [{ key: section[1], before: "错误原文" }] })).rejects.toThrow("exactly");
    draft.groups[0].items[0].content = "人工补充：更新说法。";
    const merged = await f.core.proposeKnowledge({ ...f.input, draft, targetVersion: current.version, replacements: [{ key: section[1], before: section[0] }] });
    expect(merged.plan.after).toContain("人工补充：更新说法。");
  });

  it("asks only for deletion/extensive edits, keeps refusal pending, and honors Full access", async () => {
    const f = await fixture(), initial = await f.core.proposeKnowledge(f.input); await f.save(initial);
    const note = await f.core.read(f.input.targetPath), section = /<!-- learning-knowledge:start (group-[a-z0-9]+) -->[\s\S]*?<!-- learning-knowledge:end \1 -->/.exec(note.content)!;
    const draft = structuredClone(f.draft); draft.groups[0].title = "替代组"; draft.groups[0].items[0].id = "replacement";
    const entry = await f.core.proposeKnowledge({ ...f.input, draft, targetVersion: note.version, replacements: [{ key: section[1], before: section[0] }] });
    expect((await f.save(entry)).confirmation).toBe("required");
    for (const action of ["decline", "cancel"] as const) {
      const declined = await f.core.requestConfirmation(entry.plan.id, 1, async () => ({ action }), signal());
      expect(declined.status).toBe("pending"); expect(declined.confirmation).toBe(action === "decline" ? "declined" : "cancelled");
      expect((await f.core.read(note.path)).version).toBe(note.version);
    }
    expect((await f.save(entry, "full-access")).status).toBe("completed");
  });

  it("reissues pending knowledge after restart and retains multi-source history for changed/missing sources", async () => {
    const f = await fixture(), pending = await f.core.proposeKnowledge(f.input, "dsh"); await f.core.stop();
    const restarted = new KnowledgeCore("test", f.root); await restarted.initialize(); cleanups.push(() => restarted.stop());
    expect((await restarted.preview(pending.plan.id, 1)).plan.origin).toBe("dsh");
    expect((await restarted.requestConfirmation(pending.plan.id, 1, undefined, signal())).status).toBe("completed");
    await f.write(f.a.path, f.a.content + "已改变"); await unlink(join(f.root, f.b.path));
    const note = await restarted.read(f.input.targetPath), history = (await restarted.provenance(note.path, note.version)).history;
    expect(history[0].sources?.map(source => source.state)).toEqual(["changed", "missing"]);
    expect(history[0].sources?.[0].version).toBe(f.a.version); expect(history[0].sources?.[1].evidence[0].quote).toBe(f.b.content);
  });

  it("connects authenticated DSH and MCP planning, saving and manager projections", async () => {
    const f = await fixture();
    await f.write(f.a.path, f.a.content + "长文".repeat(2500));
    const a = await f.core.read(f.a.path);
    f.draft.sources[0] = { path: a.path, version: a.version, total: a.content.length, ranges: [{ start: 0, end: a.content.length }] };
    f.draft.groups[0].items[0].evidence[0] = { path: a.path, start: 0, end: a.content.length, quote: a.content };
    await f.core.stop();
    const shared = await testSharedVault(f.root); cleanups.push(() => shared.dispose());
    const dsh = await shared.client.planKnowledge(f.input); expect(dsh.plan.origin).toBe("dsh");
    expect((await shared.client.saveRequested(dsh.plan.id, 1, "user-request")).status).toBe("completed");
    const client = new Client({ name: "knowledge-saving-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } } }));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.some(tool => tool.name === "learning_plan_knowledge")).toBe(true);
    const result = await client.callTool({ name: "learning_plan_knowledge", arguments: { ...f.input, targetPath: "Wiki/mcp.md" } });
    expect(result.isError).not.toBe(true);
    const proposal = result.structuredContent as { planId: string; revision: number };
    const saved = await client.callTool({ name: "learning_request_confirmation", arguments: { planId: proposal.planId, revision: proposal.revision } });
    expect(managerPlan.parse(saved.structuredContent).status).toBe("completed");
    const source = await client.callTool({ name: "learning_manager_probe", arguments: { view: "detail", path: f.a.path } });
    expect(managerSnapshot.parse(source.structuredContent).detail?.relatedPlans).toHaveLength(2);
    const target = await client.callTool({ name: "learning_manager_probe", arguments: { view: "detail", path: "Wiki/mcp.md" } });
    const sources = managerSnapshot.parse(target.structuredContent).detail?.provenance.history[0].sources;
    expect(sources).toHaveLength(2); expect(sources?.[0].evidence[0]).toMatchObject({ truncated: true, start: 0, end: a.content.length });
    expect(sources?.[0].evidence[0].preview).toHaveLength(200); expect(sources?.[0].evidence[0]).not.toHaveProperty("quote");
      const topicResult = await client.callTool({ name: "learning_manager_probe", arguments: { view: "topic", path: "Wiki/mcp.md" } });
      const topic = managerSnapshot.parse(topicResult.structuredContent).topic!;
      expect(topic.organized?.items.total).toBe(1); expect(topic.summary).toBe(f.draft.summary);
      expect(topic.openUri).toMatch(/^obsidian:\/\/open\?path=/); expect(topic).not.toHaveProperty("content");
      expect(topic.organized?.items.items[0].evidence.length).toBeLessThanOrEqual(600);
  });

  it("rejects malformed generated sections and duplicate groups, while ignoring marker samples in code", async () => {
    const f = await fixture();
    const draft = structuredClone(f.draft); draft.summary += "\n\n<!-- learning-knowledge:start fake -->";
    await expect(f.core.proposeKnowledge({ ...f.input, draft })).rejects.toThrow("overlap");
    draft.summary = "示例\n\n```html\n<!-- learning-knowledge:start fake -->\n```";
    await expect(f.core.proposeKnowledge({ ...f.input, draft })).resolves.toBeDefined();
    draft.groups.push(structuredClone(draft.groups[0])); draft.groups[1].items[0].id = "another";
    await expect(f.core.proposeKnowledge({ ...f.input, draft })).rejects.toThrow("Duplicate knowledge group");
    const prepared = await f.core.proposeKnowledge(f.input), metadata = prepared.plan.knowledge!;
    expect(() => mergeKnowledge("<!-- learning-knowledge:end missing -->", prepared.plan.after, metadata, undefined)).toThrow("do not match");
  });
});
