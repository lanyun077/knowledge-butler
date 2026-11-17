import type { VaultService } from "./vault";
import { createHash } from "node:crypto";
import { projectStars, type StarPage } from "./knowledge-stars";
import type { ObsidianBridge, ObsidianMetadata } from "./obsidian";
import { managerExcerpt, origin } from "./knowledge-manager-records";
import { pageOf, progressExcerpt, type IndexedManagementNote } from "./knowledge-management";
import { noteReuse } from "./knowledge-provenance";
import { parseDocument } from "yaml";
import { parseKnowledgeTopic } from "./knowledge-topic";
import { parseKnowledgeLinks, resolveKnowledgeLink, type ParsedKnowledge } from "./knowledge-links";
import { readKnowledgeMetadata, sourceProcessing, knowledgeTemplate, knowledgeTemplateId, knowledgeTemplateUri, type KnowledgeMetadataResult, type SourceProcessing } from "./knowledge-synthesis";
import { knowledgeCollectInput, knowledgeQueryInput, type KnowledgeCollectInput, type KnowledgeQueryInput,
  type KnowledgeCollection, type KnowledgeQuery, type KnowledgeLink, type KnowledgeNote, type KnowledgeNative } from "./knowledge-organization-contract";

type IndexedNote = KnowledgeNote & ParsedKnowledge & { length: number; organization: KnowledgeMetadataResult;
  management: IndexedManagementNote; organized?: ReturnType<typeof parseKnowledgeTopic> };
type IndexVault = Pick<VaultService, "read" | "notePaths" | "noteStamp" | "isMappedNote" | "folderMap">;
type NativeContext = { reader?: Pick<ObsidianBridge, "metadata">; status: KnowledgeNative };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const nextPage = (offset: number, ...totals: number[]) => offset + 10 < Math.max(0, ...totals) ? offset + 10 : null;
const summary = ({ path, version, title, category, summary }: IndexedNote): KnowledgeNote => ({ path, version, title, category, summary });

/** Rebuildable metadata only. Source text is discarded after parsing, never returned by these queries. */
export class KnowledgeIndex {
  private readonly notes = new Map<string, { stamp: string; note: IndexedNote }>();
  constructor(private readonly vault: IndexVault, private readonly native: () => Promise<Pick<ObsidianBridge, "metadata"> | undefined>) {}

  private async load(path: string, signal?: AbortSignal): Promise<IndexedNote> {
    const stamp = await this.vault.noteStamp(path, signal), cached = this.notes.get(path);
    if (cached?.stamp === stamp) return cached.note;
    this.notes.delete(path);
    const note = await this.vault.read(path, signal);
    const { content, ...fields } = note;
    const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    const importedStatus = header ? parseDocument(header[1]).get("handoffStatus") : undefined;
    const organization = readKnowledgeMetadata(content), organized = organization.state === "valid" ? parseKnowledgeTopic(content) : undefined;
    const excerpt = organized?.summary || managerExcerpt(content);
    const parsed: IndexedNote = { path: note.path, version: note.version, category: note.category, title: note.title.slice(0, 240), summary: excerpt,
      length: content.length, organization, ...parseKnowledgeLinks(path, content),
      management: { ...fields, title: note.title.slice(0, 240), excerpt, reuse: noteReuse(note, []), origin: origin(content),
        ...(typeof importedStatus === "string" ? { importedStatus } : {}), ...(note.category === "projects" ? { progressExcerpt: progressExcerpt(note) } : {}) },
      ...(organized ? { organized } : {}) };
    // A concurrent external edit must not cache earlier text under a newer file stamp.
    if (stamp === await this.vault.noteStamp(path, signal)) this.notes.set(path, { stamp, note: parsed });
    return parsed;
  }

  async managementNotes(signal?: AbortSignal): Promise<IndexedManagementNote[]> {
    const paths = await this.vault.notePaths(signal), notes: IndexedManagementNote[] = [];
    for (const cached of this.notes.keys()) if (!paths.includes(cached)) this.notes.delete(cached);
    for (const path of paths) {
      try { notes.push((await this.load(path, signal)).management); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return notes;
  }

  async noteSummary(path: string, signal?: AbortSignal) {
    this.checkPaths([path]);
    const note = await this.load(path, signal);
    return { ...summary(note), summary: note.summary.slice(0, 400), reuse: note.management.reuse, total: note.length };
  }

  async stars(offset: number, version: string | undefined, openUri: (path: string) => string, signal?: AbortSignal): Promise<StarPage> {
    if (offset && !version) throw new Error("A pinned star-map version is required to continue");
    const paths = await this.vault.notePaths(signal), notes: IndexedNote[] = [], citations: KnowledgeLink[] = [];
    const folder = `${this.vault.folderMap().knowledge.toLowerCase()}/`;
    for (const path of paths.filter(path => path.toLowerCase().startsWith(folder))) {
      signal?.throwIfAborted();
      try { const note = await this.load(path, signal); notes.push(note);
        citations.push(...note.links.map(link => resolveKnowledgeLink(link, paths, target => this.vault.isMappedNote(target))));
      } catch (error) { if (!missing(error)) throw error; }
    }
    for (const path of [...new Set(citations.filter(link => link.state === "resolved").map(link => link.targetPath!))].sort()) {
      if (!notes.some(note => note.path === path)) {
        try { notes.push(await this.load(path, signal)); } catch (error) { if (!missing(error)) throw error; }
      }
    }
    notes.sort((a, b) => a.path.localeCompare(b.path));
    const data = projectStars(notes, citations, openUri);
    const current = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    if (version && current !== version) throw new Error("Star map changed; refresh to restart at the current version");
    const page = <T,>(items: T[]) => ({ items: items.slice(offset, offset + 500), total: items.length, nextOffset: offset + 500 < items.length ? offset + 500 : null });
    return { version: current, nodes: page(data.nodes), links: page(data.links), domains: page(data.domains),
      nextOffset: offset + 500 < Math.max(data.nodes.length, data.links.length, data.domains.length) ? offset + 500 : null };
  }

  private checkPaths(paths: string[]) {
    for (const path of paths) if (!this.vault.isMappedNote(path)) throw new Error("Knowledge path is outside mapped Markdown folders");
  }
  private async nativeContext(signal?: AbortSignal): Promise<NativeContext> {
    try {
      const reader = await this.native();
      return { reader, status: { state: reader ? "available" : "not-configured" } };
    } catch {
      signal?.throwIfAborted();
      return { status: { state: "unavailable", reason: "Obsidian 连接配置不可用，使用所选 Markdown 显式链接" } };
    }
  }
  private async links(note: IndexedNote, paths: string[], native: NativeContext, signal?: AbortSignal): Promise<KnowledgeLink[]> {
    const links = note.links.map(link => resolveKnowledgeLink(link, paths, path => this.vault.isMappedNote(path)));
    if (!native.reader) return links;
    let metadata: ObsidianMetadata;
    try {
      metadata = await native.reader.metadata(note.path, signal);
      if (metadata.version !== note.version) throw new Error("Obsidian metadata version changed");
    } catch {
      signal?.throwIfAborted(); native.reader = undefined;
      native.status = { state: "unavailable", reason: "Obsidian 原生关系暂不可用，使用所选 Markdown 显式链接" };
      return links;
    }
    for (const path of metadata.links) {
      // Native targets are actual Vault paths, not encoded Markdown URLs or heading references.
      if (this.vault.isMappedNote(path) && !links.some(link => link.targetPath === path)) links.push({ sourcePath: note.path, target: path, targetPath: path,
        state: paths.includes(path) ? "resolved" : "missing", origin: "obsidian" });
    }
    for (const path of metadata.backlinks) {
      if (paths.includes(path)) links.push({ sourcePath: path, target: note.path, targetPath: note.path, state: "resolved", origin: "obsidian" });
    }
    for (const target of metadata.unresolvedLinks) {
      // Only mapped references are returned; no automatic access beyond the configured Vault scope.
      if (this.vault.isMappedNote(target) && !links.some(link => link.target === target)) links.push({ sourcePath: note.path, target: target.slice(0, 4096), state: "missing", origin: "obsidian" });
    }
    return links;
  }

  async collect(input: KnowledgeCollectInput, signal?: AbortSignal): Promise<KnowledgeCollection> {
    const value = knowledgeCollectInput.parse(input);
    this.checkPaths([...value.projectPaths, ...value.learningPaths, ...value.sourcePaths, ...value.excludePaths, ...(value.topicPath ? [value.topicPath] : [])]);
    const excluded = new Set(value.excludePaths);
    const selected = [...new Set([...value.projectPaths, ...value.learningPaths, ...value.sourcePaths])].filter(path => !excluded.has(path));
    const paths = await this.vault.notePaths(signal), native = selected.length ? await this.nativeContext(signal) : { status: { state: "not-requested" as const } };
    const sources = new Map<string, KnowledgeNote & { selected: boolean; linkedFrom: string[] }>();
    const lengths = new Map<string, number>();
    const unavailable: { path: string; reason: string }[] = [], links: KnowledgeLink[] = [];
    const add = async (path: string, direct: boolean, from?: string) => {
      if (path === value.topicPath) return;
      const previous = sources.get(path);
      if (previous) { if (from && !previous.linkedFrom.includes(from)) previous.linkedFrom.push(from); previous.selected ||= direct; return; }
      try { const note = await this.load(path, signal); sources.set(path, { ...summary(note), selected: direct, linkedFrom: from ? [from] : [] }); lengths.set(path, note.length); }
      catch (error) { if (!missing(error)) throw error; unavailable.push({ path, reason: "来源笔记不存在" }); }
    };
    for (const path of selected) {
      signal?.throwIfAborted();
      await add(path, true);
      const source = sources.get(path);
      if (!source) continue;
      if (value.projectPaths.includes(path) && source.category !== "projects" || value.learningPaths.includes(path) && source.category !== "learning") throw new Error("Selected project or learning path has the wrong mapped category");
      links.push(...await this.links(await this.load(path, signal), paths, native, signal));
    }
    for (const link of links) {
      const path = link.sourcePath === link.targetPath ? undefined : selected.includes(link.sourcePath) ? link.targetPath : link.sourcePath;
      if (link.state !== "resolved" || !path || selected.includes(path)) continue;
      if (excluded.has(path) || path === value.topicPath) { link.state = "excluded"; continue; }
      // Linked projects/goals stay opt-in. Only the explicit selection may include them.
      const category = Object.entries(this.vault.folderMap()).find(([, folder]) => path.toLowerCase().startsWith(`${folder.toLowerCase()}/`))?.[0];
      if (category === "projects" || category === "learning") { link.state = "not-selected"; continue; }
      await add(path, false, selected.includes(link.sourcePath) ? link.sourcePath : link.targetPath);
    }
    let existingTopic: KnowledgeNote | undefined, topic: IndexedNote | undefined;
    if (value.topicPath) {
      try { topic = await this.load(value.topicPath, signal); existingTopic = summary(topic); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const ordered = [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)), offset = value.offset;
    let reuse: KnowledgeCollection["reuse"];
    const processing = new Map<string, SourceProcessing>();
    if (value.request) {
      const previous = topic?.organization;
      const sameRequest = previous?.state === "valid" && previous.value.request === value.request;
      const metadata = sameRequest ? previous.value : undefined;
      // Template paths are data, never permission to read additional or excluded sources.
      const removedSources = previous?.state === "valid" ? previous.value.sources.filter(source => !sources.has(source.path) && !unavailable.some(item => item.path === source.path)).length : 0;
      const counts = { unprocessed: 0, reusable: 0, partial: 0, changed: 0 };
      for (const source of ordered) {
        const state = sourceProcessing(source.path, source.version, lengths.get(source.path)!, metadata);
        processing.set(source.path, state); counts[state.state]++;
      }
      const state = !topic ? "no-topic" : previous!.state !== "valid" ? previous!.state : !sameRequest ? "different-request"
        : ordered.length > 0 && !unavailable.length && !removedSources && counts.reusable === ordered.length ? "reusable" : "update-needed";
      reuse = { state, ...(previous?.state !== "valid" && previous?.reason ? { reason: previous.reason } : {}), removedSources, counts, unavailable: unavailable.length };
    }
    const sourcePage = pageOf(ordered, offset);
    return { sources: { ...sourcePage, items: sourcePage.items.map(source => ({ ...source, linkedFrom: source.linkedFrom.slice(0, 10), linkedFromTotal: source.linkedFrom.length,
      ...(processing.has(source.path) ? { processing: processing.get(source.path)! } : {}) })) }, links: pageOf(links, offset), unavailable: pageOf(unavailable, offset), existingTopic,
      processing: value.request ? "assessed" : "not-assessed", ...(reuse ? { reuse } : {}),
      ...(value.request && offset === 0 ? { template: { id: knowledgeTemplateId, uri: knowledgeTemplateUri, markdown: await knowledgeTemplate() } } : {}),
      native: native.status, nextOffset: nextPage(offset, ordered.length, links.length, unavailable.length) };
  }

  async query(input: KnowledgeQueryInput, signal?: AbortSignal): Promise<KnowledgeQuery> {
    const value = knowledgeQueryInput.parse(input); this.checkPaths([value.topicPath]);
    if (value.offset && !value.version) throw new Error("A pinned topic version is required to continue a knowledge query");
    const topic = await this.load(value.topicPath, signal);
    if (value.version && topic.version !== value.version) throw new Error("Knowledge topic changed; restart the query at the current version");
    if (topic.organized) {
      const items = pageOf(topic.organized.items, value.offset), relations = pageOf(topic.organized.relations, value.offset);
      const endpoints = new Set(relations.items.flatMap(relation => [relation.from, relation.to]));
      return { topic: summary(topic), view: value.view, nodes: pageOf([], 0), links: pageOf([], 0), outline: pageOf(topic.outline, value.offset),
        organized: { items, relations, endpoints: topic.organized.items.filter(item => endpoints.has(item.id) && !items.items.some(current => current.id === item.id)), invalidRelations: topic.organized.invalidRelations },
        native: { state: "not-requested" }, nextOffset: nextPage(value.offset, items.total, relations.total) };
    }
    const native = value.view === "graph" ? await this.nativeContext(signal) : { status: { state: "not-requested" as const } };
    const links = value.view === "graph" ? await this.links(topic, await this.vault.notePaths(signal), native, signal) : [];
    const linkPage = pageOf(links, value.offset), nodes = new Map<string, KnowledgeNote>([[topic.path, summary(topic)]]);
    for (const link of linkPage.items) {
      if (link.state !== "resolved" || !link.targetPath) continue;
      const path = link.sourcePath === topic.path ? link.targetPath : link.sourcePath;
      if (nodes.has(path)) continue;
      try { nodes.set(path, summary(await this.load(path, signal))); }
      catch (error) { if (!missing(error)) throw error; link.state = "missing"; }
    }
    const outline = value.view === "mindmap" ? pageOf(topic.outline, value.offset) : pageOf([], 0);
    const allNodes = new Set([topic.path, ...links.filter(link => link.state === "resolved" && link.targetPath).flatMap(link => [link.sourcePath, link.targetPath!])]);
    return { topic: summary(topic), view: value.view, nodes: { items: [...nodes.values()], total: allNodes.size, nextOffset: linkPage.nextOffset }, links: linkPage, outline,
      native: native.status, nextOffset: value.view === "graph" ? linkPage.nextOffset : outline.nextOffset };
  }
}
