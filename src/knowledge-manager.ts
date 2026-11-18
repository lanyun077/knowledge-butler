import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeCore } from "./knowledge-core";
import { planSummary } from "./knowledge-management";
import { managerInput, managerSnapshot, managerUri, managerMime } from "./knowledge-manager-contract";
import { z } from "zod";
import { openNoteUri } from "./knowledge-note-open";

/** Paginated, version-bound reads for the manager UI. */
export function registerKnowledgeManager(server: McpServer, core: KnowledgeCore) {
  server.registerTool("learning_manager_open_note", {
    title: "在 Obsidian 打开笔记", description: "Open an existing mapped note in local Obsidian at the user's click. Does not modify note content.",
    inputSchema: z.object({ path: z.string().min(1).max(4096) }).strict(),
    annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ["app"] } },
  }, async ({ path }, extra) => {
    const note = await core.noteSummary(path, extra.signal);
    extra.signal.throwIfAborted();
    await openNoteUri(core.noteOpenUri(note.path));
    return { content: [{ type: "text" as const, text: "已请求在 Obsidian 打开。" }], structuredContent: { status: "requested", path: note.path } };
  });
  const read = async (input: ReturnType<typeof managerInput.parse>, signal: AbortSignal) => {
    const { view, query, offset, path, version, historyOffset } = input;
    let data;
    if (view === "universe") {
      data = { sky: await core.starMap(offset, version, signal) };
    } else if (view === "topic") {
      if (!path) throw new Error("A topic path is required");
      const result = await core.queryKnowledge({ topicPath: path, version, offset }, signal);
      data = { topic: { ...result.topic, openUri: core.noteOpenUri(path), organized: result.organized, notes: result.nodes.items,
        links: result.links.items, outline: result.outline.items, nextOffset: result.nextOffset } };
    } else if (view === "summary") {
      if (!path) throw new Error("A note path is required");
      if (historyOffset && !version) throw new Error("A pinned version is required to continue history");
      const note = await core.noteSummary(path, signal);
      if (version && note.version !== version) throw new Error("Note changed; refresh to read the current version");
      const provenance = await core.provenance(path, note.version, historyOffset, signal);
      data = { detail: { ...note, reuse: provenance.reuse, openUri: core.noteOpenUri(path), content: "", offset: 0, nextOffset: null,
        provenance: { ...provenance, history: provenance.history.map(({ changes, ...entry }) => ({ ...entry, ...(entry.sources ? { sources: entry.sources.map(source => ({ ...source,
          evidence: source.evidence.map(({ quote, ...ref }) => ({ ...ref, preview: quote.slice(0, 200), truncated: quote.length > 200 })),
        })) } : {}) })) },
        relatedPlans: core.listPlans().filter(entry => entry.plan.inbox?.path === path || entry.plan.knowledge?.sources.some(source => source.path === path)).map(planSummary) } };
    } else if (view === "detail") {
      if (!path || (offset > 0 || historyOffset > 0) && !version) throw new Error("A path and a pinned version are required to continue reading");
      const note = await core.read(path, signal);
      if (version && note.version !== version) throw new Error("Note changed; refresh to read the current version from the beginning");
      const characters = Array.from(note.content);
      if (offset > characters.length) throw new Error("Body offset exceeds note length");
      const end = Math.min(offset + 8000, characters.length);
      const provenance = await core.provenance(path, note.version, historyOffset, signal);
      const history = provenance.history.map(entry => ({ ...entry, ...(entry.sources ? { sources: entry.sources.map(source => ({ ...source,
        evidence: source.evidence.map(({ quote, ...ref }) => ({ ...ref, preview: quote.slice(0, 200), truncated: quote.length > 200 })),
      })) } : {}) }));
      data = { detail: { path: note.path, title: note.title, category: note.category, version: note.version, reuse: note.reuse,
        content: characters.slice(offset, end).join(""), offset, total: characters.length, nextOffset: end < characters.length ? end : null,
        provenance: { ...provenance, history },
        relatedPlans: core.listPlans().filter(entry => entry.plan.inbox?.path === path || entry.plan.knowledge?.sources.some(source => source.path === path)).map(planSummary) } };
    } else if (view === "records") {
      data = { management: { view, page: await core.records(query, offset, signal) } };
    } else {
      data = { management: await core.management(view, query, offset, signal) };
    }
    const snapshot = managerSnapshot.parse({ stage: "U2", resourceVersion: "u2-v4", libraryId: core.vaultId, readAt: new Date().toISOString(), request: input,
      canConfirm: true, ...data });
    return { structuredContent: snapshot, content: [{ type: "text" as const,
      text: `知识管家 · 全库管理\n${JSON.stringify(snapshot, null, 2)}\n若宿主未显示组件，可使用 learning_manage、learning_read 和 learning_provenance 继续查看。查看页面不会自动修改笔记。` }] };
  };
  const config = { inputSchema: managerInput, outputSchema: managerSnapshot,
    annotations: { readOnlyHint: true, openWorldHint: false } };
  server.registerTool("learning_open_manager", { ...config, title: "展示管家主页",
    description: "Open the knowledge manager when the user asks to open 知识管家, 管家首页 or a management page. Select home, records, plans, knowledge, projects, learning or settings with view. Returns actual shared Vault data, not a generated mockup. This display call does not write; explicit Save actions execute directly, including without elicitation support. Text fallback remains available.",
    _meta: { ui: { resourceUri: managerUri } },
  }, async (input, extra) => read(input, extra.signal));
  server.registerTool("learning_manager_probe", { ...config, title: "读取管家实际状态",
    description: "Read actual shared manager data without remounting the UI. Body pages contain up to 8000 Unicode characters; subsequent body/history pages require the same version. Does not write.",
    _meta: { ui: { visibility: ["app"] } },
  }, async (input, extra) => read(input, extra.signal));
  server.registerResource("knowledge-manager-u2", managerUri, { mimeType: managerMime }, async () => ({ contents: [{
    uri: managerUri, mimeType: managerMime,
    text: await readFile(new URL("../dist/knowledge-manager.html", import.meta.url), "utf8"),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
}
