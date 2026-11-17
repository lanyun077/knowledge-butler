import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { NoteDocument } from "./vault";
import type { KnowledgeProposal } from "./knowledge-types";

export interface NoteReuse {
  kind: "source" | "knowledge" | "context" | "unknown";
  sourceType?: string;
  savedVersion: "recorded" | "unrecorded";
  record?: { planId: string; revision: number; savedAt: string };
  metadataError?: string;
}
export interface ProvenanceEntry {
  planId: string; revision: number; savedAt: string;
  action: "create" | "append" | "correct" | "update";
  beforeVersion: string; afterVersion: string; matchesCurrent: boolean;
  source?: { path: string; version: string; state: "unchanged" | "changed" | "missing"; currentVersion?: string; reason: string };
  sources?: (import("./knowledge-synthesis-contract").KnowledgeMetadata["sources"][number] & { state: "unchanged" | "changed" | "missing"; currentVersion?: string;
    evidence: { item: string; start: number; end: number; quote: string }[] })[];
  issues?: { item: string; reason: string }[];
  changes?: { before: string; after: string }[];
}
export interface NoteProvenance {
  path: string; version: string; reuse: NoteReuse;
  history: ProvenanceEntry[]; total: number; nextOffset: number | null;
}
export const contentVersion = (content: string) => createHash("sha256").update(content).digest("hex");
export const savedPlans = (path: string, proposals: KnowledgeProposal[]) => proposals.filter(entry => entry.plan.path === path
  && entry.status === "completed" && entry.result?.status === "completed" && entry.result.id === entry.plan.id && entry.result.path === path)
  .sort((a, b) => b.result!.at.localeCompare(a.result!.at) || b.plan.id.localeCompare(a.plan.id));

export function noteReceipt(path: string, version: string, proposals: KnowledgeProposal[]) {
  const saved = savedPlans(path, proposals).find(entry => contentVersion(entry.plan.after) === version);
  return saved ? { savedVersion: "recorded" as const, record: { planId: saved.plan.id, revision: saved.revision, savedAt: saved.result!.at } }
    : { savedVersion: "unrecorded" as const };
}
export function noteReuse(note: NoteDocument, proposals: KnowledgeProposal[]): NoteReuse {
  const receipt = noteReceipt(note.path, note.version, proposals);
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(note.content);
  const closing = opening && /^---[ \t]*(?:\r?\n|$)/m.exec(note.content.slice(opening[0].length));
  if (opening && !closing) return { kind: "unknown", ...receipt, metadataError: "Unclosed YAML frontmatter" };
  const metadata = opening && parseDocument(note.content.slice(opening[0].length, opening[0].length + closing!.index));
  if (metadata && metadata.errors.length) return { kind: "unknown", ...receipt, metadataError: metadata.errors.map(error => error.message).join("; ") };
  const type = metadata ? metadata.get("type") : undefined;
  const sourceType = typeof type === "string" && ["handoff-source", "chat-source", "article-source", "pdf-source"].includes(type) ? type : undefined;
  const kind = sourceType || note.category === "inbox" ? "source" : note.category === "knowledge" ? "knowledge" : "context";
  return { kind, ...(sourceType ? { sourceType } : {}), ...receipt };
}
