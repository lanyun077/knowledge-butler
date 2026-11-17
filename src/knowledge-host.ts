import type { VaultService } from "./vault";
import type { ProposalKind, ProposalOwner } from "./knowledge-types";

// The authenticated DSH backend may call these existing operations. MCP does not
// expose this RPC surface, and execute/restore are handled separately with receipts.
export const readMethods = ["list", "read", "readPdf", "verifyObsidianConnection"] as const;
export const planMethods = ["planUpdate", "planChatImport", "planArticleImport", "planPdfImport", "planDailyAppend", "planProjectAppend",
  "planProjectStatus", "planGoalEvidence", "planGoalSteps", "planGoalRecall", "planGoalReviewDate", "planGoalTask", "planLearningGoal", "planInbox", "planCorrection", "planReviewReport"] as const;
export type PlanMethod = typeof planMethods[number];
export const contextMethods = ["projectContext", "projectSearch", "handoffTemplate", "captureHandoff", "captureHandoffFile", "reviseCorrection", "provenance", "management", "inspectPlan", "setProjectPinned", "previewRestore", "saveRequested", "collectKnowledge", "queryKnowledge", "planKnowledge"] as const;
export type HostMethod = typeof readMethods[number] | typeof contextMethods[number] | PlanMethod | "capture" | "execute" | "restore" | "activity" | "cancelPlan" | "previewPlan" | "owns" | "listPlans" | "status";
export type HostVault = Pick<VaultService, typeof readMethods[number] | PlanMethod | "capture" | "execute" | "restore" | "activity" | "cancelPlan" | "previewPlan" | "isMappedNote">;
export interface HostRequest { channel: string; method: HostMethod; args: unknown[]; owner?: ProposalOwner; ticket?: string }
export interface HostReply { value: unknown; ticket?: string }
export interface SharedVault extends HostVault {
  planKnowledge(input: import("./knowledge-synthesis").KnowledgePlanInput, signal?: AbortSignal): Promise<import("./knowledge-types").KnowledgeProposal>;
  collectKnowledge(input: import("./knowledge-organization-contract").KnowledgeCollectInput, signal?: AbortSignal): Promise<import("./knowledge-organization-contract").KnowledgeCollection>;
  queryKnowledge(input: import("./knowledge-organization-contract").KnowledgeQueryInput, signal?: AbortSignal): Promise<import("./knowledge-organization-contract").KnowledgeQuery>;
  saveRequested(id: string, revision: number, authorization: import("./knowledge-write-policy").SaveAuthorization, signal?: AbortSignal): Promise<KnowledgeProposalResult>;
  management(view?: import("./knowledge-management").ManagementView, query?: string, offset?: number, signal?: AbortSignal): Promise<import("./knowledge-management").ManagementResult>;
  inspectPlan(id: string): Promise<import("./assistant-daily").DailyPreview>;
  setProjectPinned(path: string, pinned: boolean): Promise<string[]>;
  previewRestore(id: string): ReturnType<VaultService["previewRestore"]>;
  provenance(path: string, version: string, offset?: number, signal?: AbortSignal): Promise<import("./knowledge-provenance").NoteProvenance>;
  projectContext(directory?: string): Promise<import("./knowledge-projects").ProjectContext>;
  projectSearch(query: string, directory?: string, allProjects?: boolean, signal?: AbortSignal): ReturnType<HostVault["list"]>;
  handoffTemplate(): Promise<string>;
  captureHandoff(content: string, directory?: string, signal?: AbortSignal): Promise<import("./handoff-source").HandoffCapture>;
  captureHandoffFile(directory: string, path: string, signal?: AbortSignal): Promise<import("./handoff-source").HandoffCapture>;
  proposeAssistant(owner: ProposalOwner, method: PlanMethod, args: unknown[], signal: AbortSignal): Promise<{ planId: string; scope: string; sessionId: string; cwd: string }>;
  reviseAssistant(owner: ProposalOwner, id: string, revision: number, input: import("./knowledge-correction").CorrectionInput, signal: AbortSignal): Promise<{ planId: string; revision: number; scope: string; sessionId: string; cwd: string }>;
  reviewAssistant(identity: { planId: string; scope: string; sessionId: string; cwd: string }, action: "preview" | "cancel" | "confirm", kind: ProposalKind, signal?: AbortSignal): Promise<import("./assistant-daily").DailyPreview>;
  owns(planId: string): Promise<boolean>;
  listPlans(): Promise<import("./knowledge-types").KnowledgeProposal[]>;
  status(): Promise<unknown>;
}
type KnowledgeProposalResult = import("./knowledge-types").KnowledgeProposal & { confirmation: import("./knowledge-types").ConfirmationOutcome };
