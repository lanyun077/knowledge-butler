import { vaultScope, type PlainConfig } from "./business-api";
import type { ChangePlan, ChangeResult, InboxInput } from "./vault";
import type { GoalRecallInput, LearningGoalInput } from "./note-metadata";
import type { ReviewReportInput } from "./period-review";
import type { PlanMethod, SharedVault } from "./knowledge-host";
import type { KnowledgeProposal, ProposalKind } from "./knowledge-types";
import type { CorrectionInput } from "./knowledge-correction";

export interface DailyProposal { planId: string; scope: string; sessionId: string; cwd: string }
export interface DailyPreview { plan: ChangePlan; status: KnowledgeProposal["status"]; result?: ChangeResult; revision?: number; validationError?: string }

// DSH checks its active binding; proposal ownership and status live in the service.
export function assistantDaily(current: () => PlainConfig, getVault: (scope: string) => SharedVault) {
  function check(identity: Omit<DailyProposal, "planId">) {
    const value = current();
    if (vaultScope(value.vault) !== identity.scope || value.binding.sessionId !== identity.sessionId || value.binding.cwd !== identity.cwd) {
      throw new Error("资料目录或管家会话已变化，请重新生成方案。");
    }
  }
  async function propose(scope: string, kind: ProposalKind, method: PlanMethod, args: unknown[], signal: AbortSignal) {
    const { sessionId, cwd } = current().binding;
    const owner = { scope, kind, sessionId, cwd };
    check(owner);
    signal.throwIfAborted();
    const identity = await getVault(scope).proposeAssistant(owner, method, args, signal);
    check(owner);
    return identity;
  }
  return {
    owns: (scope: string, planId: string) => getVault(scope).owns(planId),
    propose: (scope: string, date: string, content: string, signal: AbortSignal) => propose(scope, "daily", "planDailyAppend", [date, content], signal),
    proposeProject: (scope: string, path: string, version: string, content: string, signal: AbortSignal) => propose(scope, "project", "planProjectAppend", [path, version, content], signal),
    proposeProjectStatus: (scope: string, path: string, version: string, status: string, signal: AbortSignal) => propose(scope, "project", "planProjectStatus", [path, version, status], signal),
    proposeGoalEvidence: (scope: string, path: string, version: string, content: string, signal: AbortSignal) => propose(scope, "goal", "planGoalEvidence", [path, version, content], signal),
    proposeGoalSteps: (scope: string, path: string, version: string, steps: string[], signal: AbortSignal) => propose(scope, "goal", "planGoalSteps", [path, version, steps], signal),
    proposeGoalRecall: (scope: string, path: string, version: string, input: GoalRecallInput, signal: AbortSignal) => propose(scope, "goal", "planGoalRecall", [path, version, input], signal),
    proposeGoalReviewDate: (scope: string, path: string, version: string, date: string | null, signal: AbortSignal) => propose(scope, "goal", "planGoalReviewDate", [path, version, date], signal),
    proposeGoalTask: (scope: string, path: string, version: string, line: number, checked: boolean, signal: AbortSignal) => propose(scope, "goal", "planGoalTask", [path, version, line, checked], signal),
    proposeLearningGoal: (scope: string, input: LearningGoalInput, signal: AbortSignal) => propose(scope, "goal", "planLearningGoal", [input], signal),
    proposeReport: (scope: string, input: ReviewReportInput, signal: AbortSignal) => propose(scope, "report", "planReviewReport", [input], signal),
    proposeInbox: (scope: string, input: InboxInput, signal: AbortSignal) => propose(scope, "inbox", "planInbox", [input], signal),
    proposeCorrection: async (scope: string, input: CorrectionInput, signal: AbortSignal) => ({ ...await propose(scope, "inbox", "planCorrection", [input], signal), revision: 1 }),
    async reviseCorrection(scope: string, id: string, revision: number, input: CorrectionInput, signal: AbortSignal) {
      const { sessionId, cwd } = current().binding;
      const owner = { scope, sessionId, cwd, kind: "inbox" as const };
      check(owner);
      signal.throwIfAborted();
      const identity = await getVault(scope).reviseAssistant(owner, id, revision, input, signal);
      check(owner);
      return identity;
    },
    async review(identity: DailyProposal, action: "preview" | "cancel" | "confirm", signal?: AbortSignal, kind: ProposalKind = "daily"): Promise<DailyPreview> {
      check(identity);
      const preview = await getVault(identity.scope).reviewAssistant(identity, action, kind, signal);
      check(identity);
      return preview;
    },
  };
}
