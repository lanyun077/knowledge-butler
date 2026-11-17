import type { ChangeResult, NoteDocument, NoteSummary } from "./vault";
import type { KnowledgeProposal } from "./knowledge-types";
import { noteReceipt, type NoteReuse } from "./knowledge-provenance";
import { markdownTree } from "./task-progress";
import type { ManagerRecord } from "./knowledge-manager-contract";

export const managementViews = ["home", "plans", "sources", "knowledge", "projects", "learning", "activity", "settings"] as const;
export type ManagementView = typeof managementViews[number];
export interface PlanSummary {
  planId: string; revision: number; path: string; kind: string; status: KnowledgeProposal["status"];
  createdAt: string; source?: { path: string; version: string }; sourceCount?: number; action: string;
  origin: "dsh" | "mcp"; validationError?: string;
}
export interface ManagedNote extends NoteSummary {
  version: string; reuse: NoteReuse; savedAt?: string; sourceStatus?: string;
  relatedPlans: { planId: string; revision: number; path: string; status: KnowledgeProposal["status"] }[];
  progressExcerpt?: string;
  pinned?: boolean;
}
export interface ManagementPage<T> { items: T[]; total: number; nextOffset: number | null }
export interface ManagementHome {
  pending: ManagementPage<PlanSummary>; sources: ManagementPage<ManagedNote>; pinned: ManagementPage<ManagedNote>;
  missingPins: string[];
  knowledge: ManagementPage<ManagedNote>; learning: ManagementPage<ManagedNote>;
  records: ManagementPage<ManagerRecord>;
}
export interface ManagementResult {
  view: ManagementView; home?: ManagementHome;
  page?: ManagementPage<PlanSummary | ManagedNote | ChangeResult>;
  settings?: { service: { vaultId: string; instanceId: string; stopping: boolean; pending: number }; folders: import("./vault").FolderMap; projects: { directory: string; projectPath: string; fileSubmission: boolean }[] };
}
export function pageOf<T>(items: T[], offset: number): ManagementPage<T> {
  return { items: items.slice(offset, offset + 10), total: items.length, nextOffset: offset + 10 < items.length ? offset + 10 : null };
}
export function planSummary(entry: KnowledgeProposal): PlanSummary {
  const { plan } = entry;
  return { planId: plan.id, revision: entry.revision, path: plan.path, kind: entry.kind, status: entry.status,
    createdAt: entry.createdAt, source: plan.inbox && { path: plan.inbox.path, version: plan.inbox.version },
    action: plan.knowledge ? "知识整理" : plan.correction ? "纠正" : plan.create ? "新建" : plan.inbox ? "追加" : "修改",
    ...(plan.knowledge ? { sourceCount: plan.knowledge.sources.length } : {}),
    origin: plan.origin ?? (entry.owner ? "dsh" : "mcp"), validationError: entry.validationError };
}
export function progressExcerpt(note: NoteDocument) {
  const content = note.content.replace(/^\uFEFF/, "");
  const nodes = markdownTree(content).children;
  const index = nodes.findIndex(node => node.type === "heading" && node.depth === 2 && content.slice(node.position!.start.offset!, node.position!.end.offset!).trim() === "## Progress");
  if (index < 0) return undefined;
  const next = nodes.slice(index + 1).find(node => node.type === "heading" && node.depth <= 2);
  return content.slice(nodes[index].position!.end.offset!, next?.position?.start.offset).trim().slice(-300) || undefined;
}
export interface IndexedManagementNote extends NoteSummary { version: string; reuse: NoteReuse; importedStatus?: string; origin?: string; progressExcerpt?: string }
export function managementNotes(indexed: IndexedManagementNote[], proposals: KnowledgeProposal[], activity: ChangeResult[]) {
  const notes: ManagedNote[] = [];
  for (const { importedStatus, origin: _origin, ...summary } of indexed) {
    const note = summary, reuse = { ...note.reuse, ...noteReceipt(note.path, note.version, proposals) };
    const related = proposals.filter(entry => entry.plan.inbox?.path === note.path || entry.plan.knowledge?.sources.some(source => source.path === note.path));
    notes.push({ ...summary, version: note.version, reuse,
      savedAt: activity.find(item => item.path === note.path && item.status === "completed")?.at,
      sourceStatus: reuse.kind !== "source" && note.category !== "inbox" ? undefined : reuse.kind === "unknown" ? "材料格式待核对" : importedStatus === "needs-supplement" ? "待补充"
        : related.some(entry => entry.status === "pending") ? "有待保存方案"
        : related.some(entry => entry.status === "completed" && entry.result?.status === "completed") ? "有关联已保存知识 · 不代表全部说法已核实"
        : related.some(entry => entry.status === "cancelled") ? "关联方案已取消" : "未记录整理结果",
      relatedPlans: related.map(entry => ({ planId: entry.plan.id, revision: entry.revision, path: entry.plan.path, status: entry.status })),
    });
  }
  return notes;
}
