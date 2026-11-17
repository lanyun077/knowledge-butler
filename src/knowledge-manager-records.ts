import { parseDocument } from "yaml";
import type { ChangeResult } from "./vault";
import type { IndexedManagementNote } from "./knowledge-management";
import type { KnowledgeProposal } from "./knowledge-types";
import { pageOf } from "./knowledge-management";
import type { ManagerRecord } from "./knowledge-manager-contract";

export function managerExcerpt(content: string) {
  return content.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/<!-- learning-knowledge:(?:start|end) [a-z0-9-]+ -->/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function origin(content: string): string | undefined {
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!header) return;
  const metadata = parseDocument(header[1]);
  if (metadata.errors.length) return;
  const values = ["sourceUrl", "sourceName", "client", "conversation", "submittedFile"].map(key => metadata.get(key))
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  return [...new Set(values)].join(" · ") || undefined;
}

/** A UI projection of recorded operations and source notes, never a write or model read receipt. */
export function managerRecords(notes: IndexedManagementNote[], activity: ChangeResult[], proposals: KnowledgeProposal[], query: string, offset: number) {
  const records: ManagerRecord[] = [];
  for (const entry of activity) {
    const proposal = proposals.find(item => item.plan.id === entry.id);
    const sourcePath = proposal?.plan.inbox?.path;
    let sourceOrigin: string | undefined, sourceState: string | undefined;
    if (sourcePath) {
      // Do not attach a later source's metadata to a historical save.
      const exists = notes.some(note => note.path === sourcePath);
      if (exists) {
        const source = notes.find(note => note.path === sourcePath)!;
        sourceState = source.version === proposal!.plan.inbox!.version ? "版本未变" : "来源已修改";
        if (sourceState === "版本未变") sourceOrigin = source.origin;
      } else sourceState = "来源已缺失";
    } else if (proposal?.plan.knowledge) {
      const states = [];
      for (const source of proposal.plan.knowledge.sources) {
        const current = notes.find(note => note.path === source.path);
        states.push(!current ? "来源已缺失" : current.version === source.version ? "版本未变" : "来源已修改");
      }
      sourceState = [...new Set(states)].join(" · ");
      sourceOrigin = "知识整理";
    } else if (proposal) sourceOrigin = origin(proposal.plan.after);
    else if (entry.kind === "capture" && notes.some(note => note.path === entry.path)) {
      // Capture logs have no source snapshot; label this explicitly as the current note's declaration.
      sourceOrigin = notes.find(note => note.path === entry.path)!.origin;
      if (sourceOrigin) sourceState = "当前材料声明";
    }
    records.push({ recordId: entry.id, path: entry.path, title: notes.find(note => note.path === entry.path)?.title ?? entry.path,
      savedAt: entry.at, status: entry.status, operationId: entry.id, operationKind: entry.kind, error: entry.error,
      ...(proposal?.plan.knowledge ? { sourceCount: proposal.plan.knowledge.sources.length } : {}),
      summary: (entry.status === "failed" ? "操作未完成" : proposal?.plan.knowledge ? `整理知识 · ${proposal.plan.knowledge.sources.length} 个来源` : proposal?.plan.inbox?.reason ?? ({ capture: "保存材料", update: "保存笔记修改", restore: "恢复历史版本" })[entry.kind]).slice(0, 180),
      origin: sourceOrigin, sourcePath, sourceState });
  }
  for (const note of notes.filter(item => item.category === "inbox" && !activity.some(entry => entry.path === item.path && entry.status === "completed"))) {
    records.push({ recordId: `source:${note.path}`, path: note.path, title: note.title, summary: note.excerpt,
      origin: note.origin, sourceState: "当前材料声明", status: "unrecorded" });
  }
  const match = query.trim().toLocaleLowerCase();
  return pageOf(records.filter(item => `${item.title}\n${item.path}\n${item.summary}\n${item.origin ?? ""}\n${item.sourcePath ?? ""}`.toLocaleLowerCase().includes(match))
    .sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? "") || a.recordId.localeCompare(b.recordId)), offset);
}
