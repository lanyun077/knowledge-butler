import type { ChangePlan, ChangeResult } from "./vault";

export type ProposalKind = "daily" | "project" | "goal" | "inbox" | "report";
export interface ProposalOwner { scope: string; sessionId: string; cwd: string; kind: ProposalKind }
export type ConfirmationOutcome = "accepted" | "declined" | "cancelled" | "unchecked" | "already-finished" | "not-required" | "user-confirmed" | "full-access" | "required";
export function confirmationOutcome(response: { action: string; content?: Record<string, unknown> }): ConfirmationOutcome {
  return response.action === "accept" ? response.content?.confirm === true ? "accepted" : "unchecked"
    : response.action === "decline" ? "declined" : "cancelled";
}
export interface KnowledgeProposal {
  schemaVersion: 1;
  plan: ChangePlan;
  revision: number;
  kind: ProposalKind | "manual";
  owner?: ProposalOwner;
  createdAt: string;
  validationError?: string;
  status: "pending" | "superseded" | "cancelled" | "stale" | "applying" | "completed" | "failed" | "needs-reconciliation" | "legacy";
  supersedes?: string;
  supersededBy?: string;
  result?: ChangeResult;
}
