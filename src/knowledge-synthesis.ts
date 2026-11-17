import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { VaultService } from "./vault";

export * from "./knowledge-synthesis-contract";
import { knowledgeDraft, knowledgeMetadata, knowledgeTemplateId, type KnowledgeDraft, type KnowledgeMetadata, type KnowledgeMetadataResult, type SourceProcessing } from "./knowledge-synthesis-contract";
export const knowledgeTemplate = () => readFile(new URL("../skills/knowledge-handoff/assets/knowledge-organize-v1.md", import.meta.url), "utf8");

export function processedRanges(ranges: { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function sourceProcessing(path: string, version: string, total: number, metadata?: KnowledgeMetadata): SourceProcessing {
  const previous = metadata?.sources.find(source => source.path === path);
  const changed = previous && (previous.version !== version || previous.total !== total);
  const ranges = previous && !changed ? processedRanges(previous.ranges) : [];
  const processedUnits = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  let start = 0;
  for (const range of ranges) { if (range.start > start) break; start = range.end; }
  const end = ranges.find(range => range.start > start)?.start ?? total;
  return { state: changed ? "changed" : !previous || !processedUnits && total > 0 ? "unprocessed" : processedUnits === total ? "reusable" : "partial", processedUnits, total,
    ...(start < total ? { nextRange: { start, end } } : {}) };
}

/** Metadata declares prior processing, not a read receipt or independent verification. */
export function readKnowledgeMetadata(content: string): KnowledgeMetadataResult {
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!header) return { state: "ordinary" };
  try {
    const document = parseDocument(header[1]);
    if (document.errors.length) return { state: "invalid", reason: "主题属性无法解析，保留原文并重新核对" };
    const value = document.toJS();
    if (value?.type !== "knowledge-topic") return { state: "ordinary" };
    if (value.template !== knowledgeTemplateId) return { state: "unsupported", reason: "主题使用其他模板版本，不能自动复用" };
    const parsed = knowledgeMetadata.safeParse(value);
    return parsed.success ? { state: "valid", value: parsed.data } : { state: "invalid", reason: "主题来源或已处理范围不完整，不能自动复用" };
  } catch { return { state: "invalid", reason: "主题属性无法解析，保留原文并重新核对" }; }
}

const label = (value: string) => value.replace(/\r?\n/g, " ").replace(/[\\[\]`*_<>]/g, character => `\\${character}`);
function sourceLink(target: string, source: string) {
  const relative = posix.relative(posix.dirname(target), source).split("/").map(encodeURIComponent).join("/");
  return `[${label(source)}](<${relative}>)`;
}

/** Prepare content only; planKnowledge uses the existing writer and rechecks source versions. */
export async function prepareKnowledge(vault: Pick<VaultService, "read" | "isMappedNote" | "folderMap">, targetPath: string, input: KnowledgeDraft, signal?: AbortSignal) {
  const value = knowledgeDraft.parse(input);
  if (!vault.isMappedNote(targetPath) || !targetPath.toLowerCase().startsWith(`${vault.folderMap().knowledge.toLowerCase()}/`)) throw new Error("Knowledge target must be in the mapped knowledge folder");
  const metadata = knowledgeMetadata.parse({ type: "knowledge-topic", template: value.template, request: value.request, sources: value.sources });
  const identity = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (new Set(metadata.sources.map(source => identity(source.path))).size !== metadata.sources.length) throw new Error("Duplicate knowledge source");
  const ids = value.groups.flatMap(group => group.items.map(item => item.id));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate knowledge block ID");
  if (new Set(value.groups.map(group => group.title)).size !== value.groups.length) throw new Error("Duplicate knowledge group title");
  const contents = new Map<string, string>();
  for (const source of metadata.sources) {
    signal?.throwIfAborted();
    if (identity(source.path) === identity(targetPath) || !vault.isMappedNote(source.path)) throw new Error("Knowledge source must be mapped and distinct from its target");
    const note = await vault.read(source.path, signal);
    if (note.version !== source.version || note.content.length !== source.total) throw new Error("Knowledge source changed; reread before organizing");
    source.ranges = processedRanges(source.ranges);
    contents.set(source.path, note.content);
  }
  const validEvidence = (refs: KnowledgeDraft["groups"][number]["items"][number]["evidence"]) => refs.length > 0 && refs.every(ref => {
    const source = metadata.sources.find(source => source.path === ref.path);
    return source && ref.end > ref.start && source.ranges.some(range => ref.start >= range.start && ref.end <= range.end)
      && contents.get(ref.path)?.slice(ref.start, ref.end) === ref.quote;
  });
  const cite = (refs: KnowledgeDraft["groups"][number]["items"][number]["evidence"]) => refs.map(ref => `${sourceLink(targetPath, ref.path)} · 版本：\`${metadata.sources.find(source => source.path === ref.path)!.version}\` · 字符 ${ref.start}–${ref.end} · ${label(ref.quote)}`).join("；");
  const issues: { item: string; reason: string }[] = [], accepted = new Set<string>();
  const groups = value.groups.map(group => ({ ...group, items: group.items.filter(item => {
    if (validEvidence(item.evidence)) { accepted.add(item.id); return true; }
    issues.push({ item: item.id, reason: `「${item.title}」缺少匹配已处理片段的出处，暂不纳入知识条目` }); return false;
  }) })).filter(group => group.items.length);
  const relations = value.relations.filter((relation, index) => {
    if (accepted.has(relation.from) && accepted.has(relation.to) && validEvidence(relation.evidence)) return true;
    issues.push({ item: `relation-${index}`, reason: `「${relation.from} → ${relation.to}」端点或出处不完整，暂不纳入关系` }); return false;
  });
  const table = (value: string) => value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const groupParts = groups.map(group => ({ key: `group-${createHash("sha256").update(group.title).digest("hex").slice(0, 16)}`,
    content: `## ${label(group.title)}\n\n` + group.items.map(item => `### ${label(item.title)}\n\n${item.content}\n\n^${item.id}\n\n出处：${cite(item.evidence)}\n`).join("\n") }));
  const edges = relations.length ? "## 关联\n\n| 起点 | 关系 | 终点 | 依据 |\n| --- | --- | --- | --- |\n" + relations.map(relation =>
    `| [[#^${relation.from}]] | ${relation.type} | [[#^${relation.to}]] | ${table(`${relation.origin === "inferred" ? "推断" : "显式"}：${relation.reason}；${cite(relation.evidence)}`)} |`).join("\n") + "\n\n" : "";
  const gaps = [...value.unknowns, ...issues.map(issue => issue.reason), ...metadata.sources.flatMap(source => {
    const coverage = sourceProcessing(source.path, source.version, source.total, metadata);
    return coverage.state === "reusable" ? [] : [`${source.path}：已处理 ${coverage.processedUnits}/${coverage.total} 个字符，其余未纳入本次整理。`];
  })];
  const sources = metadata.sources.map(source => `- ${sourceLink(targetPath, source.path)} · 版本：\`${source.version}\` · 已处理范围：${source.ranges.map(range => `[${range.start}, ${range.end})`).join("、") || "未处理"} / ${source.total}`).join("\n");
  signal?.throwIfAborted();
  const parts = [{ key: "overview", content: `# ${label(value.title)}\n\n${value.summary}\n` }, ...groupParts,
    { key: "relations", content: edges }, { key: "gaps", content: `## 待补充\n\n${gaps.length ? gaps.map(gap => `- ${gap}`).join("\n") : "暂无已知缺口。"}\n` },
    { key: "sources", content: `## 来源与处理范围\n\n${sources}\n` }];
  const body = parts.map(part => `<!-- learning-knowledge:start ${part.key} -->\n\n${part.content}\n<!-- learning-knowledge:end ${part.key} -->\n`).join("\n");
  return { metadata, issues, evidence: [...groups.flatMap(group => group.items.flatMap(item => item.evidence.map(ref => ({ item: item.id, ...ref })))),
    ...relations.flatMap((relation, i) => relation.evidence.map(ref => ({ item: `relation-${i}`, ...ref })))], content: `---\n${stringify(metadata)}---\n\n${body}` };
}
