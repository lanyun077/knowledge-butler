import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { stringify } from "yaml";
import { KnowledgeIndex } from "../src/knowledge-organization";
import { VaultService } from "../src/vault";
import { knowledgeDraft, knowledgeTemplateId, knowledgeTemplateUri, prepareKnowledge, processedRanges, readKnowledgeMetadata, sourceProcessing, type KnowledgeDraft } from "../src/knowledge-synthesis";
import type { KnowledgeCollection } from "../src/knowledge-organization-contract";
import { testSharedVault } from "./shared-vault-fixture";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-synthesis-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const dir of ["Wiki", "Inbox"]) await mkdir(join(root, dir));
  const write = (path: string, content: string | Buffer) => writeFile(join(root, path), content);
  await write("Inbox/材料 #% A.md", "# 来源 A\n接口需要版本。\n\n条件：不可信扩展才需要沙箱。\n");
  await write("Inbox/B.md", "# Source B\n接口允许独立演进。\n\n条件：可信扩展不默认使用沙箱。\n");
  await write("Wiki/unrelated.md", Buffer.from([0xff]));
  const vault = new VaultService(root), index = new KnowledgeIndex(vault, async () => undefined);
  const a = await vault.read("Inbox/材料 #% A.md"), b = await vault.read("Inbox/B.md");
  const evidence = (note: typeof a, quote: string) => ({ path: note.path, start: note.content.indexOf(quote), end: note.content.indexOf(quote) + quote.length, quote });
  const draft: KnowledgeDraft = { template: knowledgeTemplateId, request: "整理插件接口及隔离条件", title: "插件设计", summary: "接口演进与信任条件不同，保留差异。",
    sources: [a, b].map(note => ({ path: note.path, version: note.version, total: note.content.length, ranges: [{ start: 0, end: note.content.length }] })),
    groups: [{ title: "接口", items: [
      { id: "version", title: "接口版本", content: "接口需要版本，帮助独立演进。", evidence: [evidence(a, "接口需要版本。"), evidence(b, "接口允许独立演进。")] },
      { id: "sandbox", title: "隔离条件", content: "不可信扩展需要沙箱，可信扩展按需使用。", evidence: [evidence(a, "条件：不可信扩展才需要沙箱。"), evidence(b, "条件：可信扩展不默认使用沙箱。")] },
    ] }], relations: [{ from: "version", to: "sandbox", type: "补充", origin: "inferred", reason: "接口兼容和信任边界解决不同问题。", evidence: [evidence(a, "接口需要版本。"), evidence(b, "条件：可信扩展不默认使用沙箱。")] }],
    unknowns: ["尚未验证实际性能，不把条目数量视为掌握度。"] };
  const input = { request: draft.request, topicPath: "Wiki/topic.md", sourcePaths: [a.path, b.path] };
  return { root, write, vault, index, a, b, draft, input, evidence };
}

describe("knowledge-organize-v1 content and declared processing", () => {
  it("merges processed intervals without mutating inputs and finds actual gaps in UTF-16 units", () => {
    const ranges = [{ start: 4, end: 8 }, { start: 0, end: 2 }, { start: 6, end: 10 }];
    expect(processedRanges(ranges)).toEqual([{ start: 0, end: 2 }, { start: 4, end: 10 }]);
    expect(ranges[0]).toEqual({ start: 4, end: 8 });
    const metadata = { type: "knowledge-topic" as const, template: knowledgeTemplateId, request: "r", sources: [{ path: "Inbox/a.md", version: "a".repeat(64), total: 12, ranges }] };
    expect(sourceProcessing("Inbox/a.md", "a".repeat(64), 12, metadata)).toEqual({ state: "partial", processedUnits: 8, total: 12, nextRange: { start: 2, end: 4 } });
    expect(sourceProcessing("Inbox/a.md", "b".repeat(64), 12, metadata)).toMatchObject({ state: "changed", processedUnits: 0, nextRange: { start: 0, end: 12 } });
    expect(sourceProcessing("Inbox/new.md", "a".repeat(64), 5, metadata)).toMatchObject({ state: "unprocessed", processedUnits: 0 });
  });

  it("prepares one Markdown with stable blocks, source versions, conditions and inferred relation evidence without writing", async () => {
    const f = await fixture();
    const prepared = await prepareKnowledge(f.vault, f.input.topicPath, f.draft);
    expect(prepared.issues).toEqual([]);
    expect(prepared.content).toContain("^version\n"); expect(prepared.content).toContain("^sandbox\n");
    expect(prepared.content).toContain("[[#^version]] | 补充 | [[#^sandbox]]");
    expect(prepared.content).toContain("推断：接口兼容和信任边界解决不同问题。");
    expect(prepared.content).toContain("../Inbox/%E6%9D%90%E6%96%99%20%23%25%20A.md");
    expect(prepared.content).toContain(f.a.version); expect(prepared.content).toContain("不可信扩展才需要沙箱");
    expect(prepared.content).toContain("可信扩展不默认使用沙箱"); expect(prepared.content).toContain("尚未验证实际性能");
    expect(readKnowledgeMetadata(prepared.content)).toEqual({ state: "valid", value: prepared.metadata });
    const withManualField = prepared.content.replace("type: knowledge-topic", "type: knowledge-topic\nmanual: 人工属性，不进入索引");
    expect(readKnowledgeMetadata(withManualField)).toEqual({ state: "valid", value: prepared.metadata });
    await expect(readFile(join(f.root, f.input.topicPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps usable entries while sending unsourced candidates, bad quotes and dangling relations to gaps", async () => {
    const f = await fixture();
    f.draft.groups[0].items.push({ id: "invented", title: "没有出处的候选", content: "猜测。", evidence: [] });
    f.draft.groups[0].items[1].evidence[0].quote = "伪造原文";
    const prepared = await prepareKnowledge(f.vault, f.input.topicPath, f.draft);
    expect(prepared.issues).toHaveLength(3);
    expect(prepared.content).toContain("^version\n");
    expect(prepared.content).not.toContain("^sandbox\n"); expect(prepared.content).not.toContain("^invented\n");
    expect(prepared.content).not.toContain("| [[#^version]]");
    expect(prepared.content).toContain("「没有出处的候选」缺少匹配已处理片段的出处");
    expect(prepared.content).toContain("## 待补充");
  });

  it("checks source versions, mapped scope, unique IDs and declared partial ranges without a full-read receipt lock", async () => {
    const f = await fixture();
    f.draft.sources[0].ranges = [{ start: 0, end: 7 }];
    const prepared = await prepareKnowledge(f.vault, f.input.topicPath, f.draft);
    expect(prepared.content).toContain(`已处理 7/${f.a.content.length} 个字符`);
    expect(prepared.issues.length).toBeGreaterThan(0);
    f.draft.groups[0].items[1].id = "version";
    await expect(prepareKnowledge(f.vault, f.input.topicPath, f.draft)).rejects.toThrow("Duplicate");
    f.draft.groups[0].items[1].id = "sandbox";
    await expect(prepareKnowledge(f.vault, "Inbox/wrong.md", f.draft)).rejects.toThrow("knowledge folder");
    f.draft.sources[0].path = "../private.md";
    await expect(prepareKnowledge(f.vault, f.input.topicPath, f.draft)).rejects.toThrow("mapped");
    f.draft.sources[0].path = f.a.path;
    await f.write(f.a.path, f.a.content + "External edit.");
    await expect(prepareKnowledge(f.vault, f.input.topicPath, f.draft)).rejects.toThrow("changed");
    expect(knowledgeDraft.safeParse({ ...f.draft, template: "unknown-version" }).success).toBe(false);
  });

  it("preserves leading whitespace in exact quotes and counts emoji as UTF-16 units", async () => {
    const f = await fixture(), quote = "  内容🙂\n";
    await f.write(f.a.path, quote);
    const a = await f.vault.read(f.a.path);
    f.draft.sources = [{ path: a.path, version: a.version, total: quote.length, ranges: [{ start: 0, end: quote.length }] }];
    f.draft.groups = [{ title: "中文", items: [{ id: "utf16", title: "原文", content: "保留原文定位。", evidence: [{ path: a.path, start: 0, end: quote.length, quote }] }] }];
    f.draft.relations = [];
    expect((await prepareKnowledge(f.vault, f.input.topicPath, f.draft)).issues).toEqual([]);
  });

  it("reuses only identical requirements and versions, rebuilds from disk and does not reread unchanged source bodies", async () => {
    const f = await fixture();
    const saved = (await prepareKnowledge(f.vault, f.input.topicPath, f.draft)).content + "\n人工补充：这一段保留。\n";
    await f.write(f.input.topicPath, saved);
    const read = vi.spyOn(f.vault, "read");
    const first = await f.index.collect(f.input);
    expect(first).toMatchObject({ processing: "assessed", reuse: { state: "reusable", removedSources: 0, counts: { reusable: 2 } }, template: { id: knowledgeTemplateId } });
    expect(first.sources.items.every(source => source.processing?.state === "reusable")).toBe(true);
    read.mockClear();
    expect((await f.index.collect(f.input)).reuse?.state).toBe("reusable"); expect(read).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, f.input.topicPath), "utf8")).toBe(saved);
    const fresh = new KnowledgeIndex(f.vault, async () => undefined);
    expect((await fresh.collect(f.input)).reuse).toEqual(first.reuse);
    expect((await f.index.collect({ ...f.input, request: "其他任务" })).reuse?.state).toBe("different-request");
    await f.write(f.a.path, f.a.content + "外部修改。\n"); read.mockClear();
    const changed = await f.index.collect(f.input);
    expect(changed.reuse).toMatchObject({ state: "update-needed", counts: { changed: 1, reusable: 1 } });
    expect(changed.sources.items.find(source => source.path === f.a.path)?.processing).toMatchObject({ state: "changed", processedUnits: 0 });
    expect(read.mock.calls.map(call => call[0])).toEqual([f.a.path]);
  });

  it("tracks partial/unread sources, added and removed scope, missing files and exclusions without reading old metadata paths", async () => {
    const f = await fixture();
    f.draft.sources[0].ranges = [{ start: 0, end: 7 }];
    f.draft.sources[1].ranges = [];
    await f.write(f.input.topicPath, (await prepareKnowledge(f.vault, f.input.topicPath, f.draft)).content);
    const partial = await f.index.collect(f.input);
    expect(partial.reuse).toMatchObject({ state: "update-needed", counts: { partial: 1, unprocessed: 1 } });
    expect(partial.sources.items.find(source => source.path === f.a.path)?.processing).toMatchObject({ nextRange: { start: 7, end: f.a.content.length } });
    await f.write("Inbox/new.md", "# New\nNot processed yet.\n");
    const added = await f.index.collect({ ...f.input, sourcePaths: [...f.input.sourcePaths, "Inbox/new.md"] });
    expect(added.sources.items.find(source => source.path === "Inbox/new.md")?.processing?.state).toBe("unprocessed");
    const read = vi.spyOn(f.vault, "read");
    const excluded = await f.index.collect({ ...f.input, excludePaths: [f.b.path] });
    expect(excluded.reuse).toMatchObject({ state: "update-needed", removedSources: 1 });
    expect(read.mock.calls.some(call => call[0] === f.b.path)).toBe(false);
    await unlink(join(f.root, f.a.path));
    const missing = await f.index.collect(f.input);
    expect(missing.reuse).toMatchObject({ state: "update-needed", unavailable: 1 });
    expect(missing.unavailable.items[0].path).toBe(f.a.path);
  });

  it("leaves ordinary, malformed and unsupported topics readable and never turns their markers into trusted coverage", async () => {
    const f = await fixture();
    expect((await f.index.collect(f.input)).reuse?.state).toBe("no-topic");
    await f.write(f.input.topicPath, "# 手工笔记\n正文保留。\n");
    expect((await f.index.collect(f.input)).reuse?.state).toBe("ordinary");
    await f.write(f.input.topicPath, "---\ntype: knowledge-topic\ntemplate: knowledge-organize-v2\n---\n# Newer version\n");
    expect((await f.index.collect(f.input)).reuse?.state).toBe("unsupported");
    await f.write(f.input.topicPath, "---\ntype: knowledge-topic\ntemplate: knowledge-organize-v1\nsources: [broken\n---\n# Invalid YAML\n");
    expect((await f.index.collect(f.input)).reuse?.state).toBe("invalid");
    expect((await f.index.query({ topicPath: f.input.topicPath, view: "document" })).topic.path).toBe(f.input.topicPath);
    const forged = { type: "knowledge-topic", template: knowledgeTemplateId, request: f.input.request, sources: [{ ...f.draft.sources[0], ranges: [{ start: 0, end: 999999 }] }] };
    expect(readKnowledgeMetadata(`---\n${stringify(forged)}---\n# Note\n`).state).toBe("invalid");
    forged.sources[0] = { ...f.draft.sources[0], path: "../secret.md" };
    await f.write(f.input.topicPath, `---\n${stringify(forged)}---\n# Note\n`);
    expect((await f.index.collect(f.input)).reuse).toMatchObject({ state: "update-needed", removedSources: 1 });
  });

  it("returns the bundled template through MCP and authenticated Host with bounded pages, without plans or writes", async () => {
    const f = await fixture();
    await f.write(f.input.topicPath, (await prepareKnowledge(f.vault, f.input.topicPath, f.draft)).content);
    const shared = await testSharedVault(f.root); cleanups.push(shared.dispose);
    const client = new Client({ name: "knowledge-template-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${shared.config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${shared.config.token}` } } }));
    cleanups.push(() => client.close());
    const result = await client.callTool({ name: "learning_knowledge_collect", arguments: f.input });
    expect(result.isError).not.toBe(true);
    const value = JSON.parse((result.content as { text: string }[])[0].text) as KnowledgeCollection;
    expect(value).toEqual(await shared.client.collectKnowledge(f.input));
    expect(value.reuse?.state).toBe("reusable");
    const resources = await client.listResources();
    expect(resources.resources.some(resource => resource.uri === knowledgeTemplateUri)).toBe(true);
    const resource = await client.readResource({ uri: knowledgeTemplateUri });
    expect("text" in resource.contents[0] && resource.contents[0].text).toBe(value.template?.markdown);
    expect(value.template?.markdown).toContain("## 1. 提取"); expect(value.template?.markdown).toContain("## 4. 成文");
    expect(JSON.stringify(value)).not.toContain(f.a.content);
    const paths = Array.from({ length: 11 }, (_, i) => `Inbox/page-${i}.md`);
    for (const path of paths) await f.write(path, "# Source\nShort body.\n");
    const page = await shared.client.collectKnowledge({ request: "r", sourcePaths: paths });
    expect(page.sources.items).toHaveLength(10); expect(page.nextOffset).toBe(10);
    const next = await shared.client.collectKnowledge({ request: "r", sourcePaths: paths, offset: page.nextOffset! });
    expect(next.sources.items).toHaveLength(1); expect(next.template).toBeUndefined(); expect(next.reuse?.counts.unprocessed).toBe(11);
    expect(await shared.client.listPlans()).toEqual([]); expect(await shared.client.activity()).toEqual([]);
  });
});
