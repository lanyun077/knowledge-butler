import type { ArticleImportInput } from "./article-source";
import type { PdfImportInput, PdfOriginal } from "./pdf-source";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { NoteSummary, NoteDocument, ChangePlan, ChangeResult, ChatImportInput, ChatImportPreview } from "./vault";
import type { LearningGoalInput } from "./note-metadata";
import type { ObsidianConfig, ObsidianStatus, ObsidianMetadata } from "./obsidian";
import type { DailyProposal, DailyPreview } from "./assistant-daily";
import type { DueReviews } from "./due-reviews";
import type { RoutineKind, RoutineStatus } from "./routines";
import type { SavedBinding } from "./workspace";

export const defaultFolders = { inbox: "Inbox", knowledge: "Wiki", daily: "Daily", projects: "Projects", learning: "Learning" };
export const defaultObsidian: ObsidianConfig = { baseUrl: "", apiKeyRef: "OBSIDIAN_LOCAL_REST_API_KEY" };
export interface VaultConfig { root: string; folders: typeof defaultFolders }
export interface PlainConfig { binding: SavedBinding; vault: VaultConfig; obsidian?: ObsidianConfig }
export const vaultScope = (vault: VaultConfig) => JSON.stringify([vault.root, ...Object.keys(defaultFolders).map(key => vault.folders[key as keyof typeof defaultFolders])]);

export function businessApi(rpc: ClientConnectionRpc, vault: VaultConfig) {
  const scope = vaultScope(vault);
  async function call<T>(method: string, payload: object): Promise<T> {
    const result = await rpc.call("/api", `learning-os/${method}`, { ...payload, scope });
    if (!result.ok) throw new Error(result.error.message);
    return result.value as T;
  }
  return {
    planKnowledge: (input: import("./knowledge-synthesis-contract").KnowledgePlanInput) => call<import("./knowledge-types").KnowledgeProposal>("plan-knowledge", { input }),
    collectKnowledge: (input: import("./knowledge-organization-contract").KnowledgeCollectInput) => call<import("./knowledge-organization-contract").KnowledgeCollection>("knowledge-collect", { input }),
    queryKnowledge: (input: import("./knowledge-organization-contract").KnowledgeQueryInput) => call<import("./knowledge-organization-contract").KnowledgeQuery>("knowledge-query", { input }),
    management: (view: import("./knowledge-management").ManagementView = "home", query = "", offset = 0) => call<import("./knowledge-management").ManagementResult>("management", { view, query, offset }),
    inspectPlan: (planId: string) => call<DailyPreview>("inspect-plan", { planId }),
    setProjectPinned: (path: string, pinned: boolean) => call<string[]>("pin-project", { path, pinned }),
    previewRestore: (operationId: string) => call<Awaited<ReturnType<import("./vault").VaultService["previewRestore"]>>>("preview-restore", { operationId }),
    serviceStatus: () => call<unknown>("service-status", {}),
    projectContext: () => call<import("./knowledge-projects").ProjectContext>("project-context", {}),
    handoffTemplate: () => call<string>("handoff-template", {}),
    captureHandoff: (content: string) => call<import("./handoff-source").HandoffCapture>("capture-handoff", { content }),
    captureHandoffFile: (path: string) => call<import("./handoff-source").HandoffCapture>("capture-handoff-file", { path }),
    pendingPlans: () => call<import("./knowledge-types").KnowledgeProposal[]>("pending-plans", {}),
    provenance: (path: string, version: string, offset = 0) => call<import("./knowledge-provenance").NoteProvenance>("provenance", { path, version, offset }),
    previewPlan: (planId: string) => call<ChangePlan>("preview-plan", { planId }),
    dueReviews: (date: string, offset = 0) => call<DueReviews>("due-reviews", { date, offset }),
    planGoalReviewDate: (path: string, version: string, date: string | null) => call<ChangePlan>("plan-goal-review-date", { path, version, date }),
    routines: (binding: PlainConfig["binding"]) => call<RoutineStatus>("routines", binding),
    setRoutine: (binding: PlainConfig["binding"], kind: RoutineKind, enabled: boolean, timeZone: string) => call<RoutineStatus>("routine-set", { ...binding, kind, enabled, timeZone }),
    stopRoutine: (binding: PlainConfig["binding"], id: string) => call<RoutineStatus>("routine-stop", { ...binding, id }),
    prepareAssistant: () => call<{ ready: true }>("prepare-assistant", {}),
    reviewDaily: (proposal: DailyProposal, action: "preview" | "cancel" | "confirm") => call<DailyPreview>(`assistant-daily-${action}`, proposal),
    reviewProject: (proposal: DailyProposal, action: "preview" | "cancel" | "confirm") => call<DailyPreview>(`assistant-project-${action}`, proposal),
    reviewGoal: (proposal: DailyProposal, action: "preview" | "cancel" | "confirm") => call<DailyPreview>(`assistant-goal-${action}`, proposal),
    reviewInbox: (proposal: DailyProposal, action: "preview" | "cancel" | "confirm") => call<DailyPreview>(`assistant-inbox-${action}`, proposal),
    reviewReport: (proposal: DailyProposal, action: "preview" | "cancel" | "confirm") => call<DailyPreview>(`assistant-report-${action}`, proposal),
    obsidianStatus: () => call<ObsidianStatus>("obsidian-status", {}),
    connectObsidian: (key = "") => call<ObsidianStatus>("obsidian-connect", { key }),
    obsidianMetadata: (path: string) => call<ObsidianMetadata>("obsidian-metadata", { path }),
    openObsidian: (path: string) => call<{ path: string }>("obsidian-open", { path }),
    list: (query = "") => call<NoteSummary[]>("list", { query }),
    read: (path: string) => call<NoteDocument>("read", { path }),
    capture: (title: string, content: string) => call<NoteDocument>("capture", { title, content }),
    planPdfImport: (input: PdfImportInput) => call<ChatImportPreview>("plan-pdf-import", input),
    readPdf: (path: string, version: string) => call<PdfOriginal>("read-pdf", { path, version }),
    planArticleImport: (input: ArticleImportInput) => call<ChatImportPreview>("plan-article-import", input),
    planChatImport: (input: ChatImportInput) => call<ChatImportPreview>("plan-chat-import", input),
    cancelPlan: (planId: string) => call<void>("cancel-plan", { planId }),
    planUpdate: (path: string, version: string, content: string) => call<ChangePlan>("plan-update", { path, version, content }),
    planDailyAppend: (date: string, content: string) => call<ChangePlan>("plan-daily-append", { date, content }),
    planProjectAppend: (path: string, version: string, content: string) => call<ChangePlan>("plan-project-append", { path, version, content }),
    planProjectStatus: (path: string, version: string, status: string) => call<ChangePlan>("plan-project-status", { path, version, status }),
    planLearningGoal: (goal: LearningGoalInput) => call<ChangePlan>("plan-learning-goal", { ...goal }),
    execute: (planId: string) => call<ChangeResult>("execute", { planId }),
    restore: (operationId: string) => call<ChangeResult>("restore", { operationId }),
    activity: () => call<ChangeResult[]>("activity", {}),
  };
}
