import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { KnowledgeIndex } from "../src/knowledge-organization";
import { VaultService } from "../src/vault";
import { projectStars, starPage } from "../src/knowledge-stars";
import { parseKnowledgeTopic } from "../src/knowledge-topic";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const run of cleanup.splice(0)) await run(); });
const uri = (path: string) => `obsidian://open?path=${encodeURIComponent(path)}`;

it("pages real graph metadata with a pinned version, excludes unrelated project bodies and reflects edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-stars-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  for (const folder of ["Wiki", "Inbox", "Projects"]) await mkdir(join(root, folder));
  const content = `# 主题\n短概况\n${Array.from({ length: 505 }, (_, index) => `## 分组 ${index}\n`).join("")}\n[原始材料](../Inbox/source.md)\n\n\`\`\`md\n[[Projects/unreadable]]\n\`\`\``;
  await writeFile(join(root, "Wiki/topic.md"), content);
  await writeFile(join(root, "Inbox/source.md"), "# 来源\n原始事实。");
  await writeFile(join(root, "Projects/unreadable.md"), Buffer.from([0xff]));
  const vault = new VaultService(root), index = new KnowledgeIndex(vault, async () => undefined);
  const first = starPage.parse(await index.stars(0, undefined, uri));
  expect(first.nodes.items).toHaveLength(500); expect(first.nextOffset).toBe(500); expect(first.domains.total).toBe(2);
  expect(first.links.items.filter(link => link.type === "引用")).toHaveLength(0); // Citation follows 505 hierarchy edges.
  const second = await index.stars(first.nextOffset!, first.version, uri);
  expect(second.links.items.filter(link => link.type === "引用")).toHaveLength(1); expect(second.nextOffset).toBeNull();
  expect([...first.nodes.items, ...second.nodes.items]).toHaveLength(first.nodes.total);
  expect(JSON.stringify(first)).not.toContain(content); expect(await vault.activity()).toEqual([]);
  await expect(index.stars(500, undefined, uri)).rejects.toThrow(/pinned/);
  await writeFile(join(root, "Inbox/source.md"), "# 来源\n新的事实。");
  await expect(index.stars(500, first.version, uri)).rejects.toThrow(/changed/);
  const updated = await index.stars(0, undefined, uri); expect(updated.version).not.toBe(first.version);
});

it("projects organized groups/items and preserves real semantic relations without same-name guessing", () => {
  const organized = parseKnowledgeTopic('# 主题\n<!-- learning-knowledge:start group-one -->\n## 分组\n### 一\n摘要\n\n^item-one\n\n### 二\n摘要\n\n^item-two\n<!-- learning-knowledge:end group-one -->\n<!-- learning-knowledge:start relations -->\n| 起点 | 类型 | 终点 | 依据 |\n| --- | --- | --- | --- |\n| [[#^item-one]] | 前置依赖 | [[#^item-two]] | 推断：应用需要该概念 |\n<!-- learning-knowledge:end relations -->');
  const data = projectStars([{ path: "Wiki/a.md", title: "主题", summary: "短摘要", category: "knowledge", version: "a", outline: [], organized },
    { path: "Wiki/b.md", title: "主题", summary: "同名不连线", category: "knowledge", version: "b", outline: [] }], [], uri);
  expect(data.domains).toHaveLength(2);
  const edges = data.links.filter(link => link.origin === "organized");
  expect(edges).toHaveLength(1); expect(edges[0]).toMatchObject({ source: "Wiki/a.md#^item-one", target: "Wiki/a.md#^item-two", type: "前置依赖", inferred: true });
  expect(edges[0].evidence).toContain("应用需要该概念");
  const ids = new Set(data.nodes.map(node => node.id));
  expect(data.links.every(link => ids.has(link.source) && ids.has(link.target))).toBe(true);
  expect(data.links.some(link => link.target === "g1")).toBe(false);
  expect(projectStars([], [], uri)).toEqual({ nodes: [], links: [], domains: [] });
});
