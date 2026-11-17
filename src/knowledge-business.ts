import { z } from "zod";
import type { VaultService } from "./vault";
import { projectStatuses } from "./note-metadata";

const text = z.string().trim().min(1).max(100_000);
const target = { path: z.string().min(1).max(4096), version: z.string().regex(/^[a-f0-9]{64}$/) };
const date = z.string().max(10);
export const businessInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("daily"), date, content: text }).strict(),
  z.object({ operation: z.literal("project_progress"), ...target, content: text }).strict(),
  z.object({ operation: z.literal("project_status"), ...target, status: z.enum(projectStatuses) }).strict(),
  z.object({ operation: z.literal("goal"), title: z.string().trim().min(1).max(200), outcome: text, verification: text,
    purpose: z.string().max(100_000).default(""), background: z.string().max(100_000).default(""),
    schedule: z.string().max(1000).default(""), targetDate: date.default("") }).strict(),
  z.object({ operation: z.literal("goal_evidence"), ...target, content: text }).strict(),
  z.object({ operation: z.literal("goal_steps"), ...target, steps: z.array(z.string().min(1).max(1000)).min(1).max(30) }).strict(),
  z.object({ operation: z.literal("goal_task"), ...target, line: z.number().int().positive(), checked: z.boolean() }).strict(),
  z.object({ operation: z.literal("goal_recall"), ...target, date,
    entries: z.array(z.object({ question: text, answer: text, reflection: z.string().max(100_000).optional() }).strict()).min(1).max(5) }).strict(),
  z.object({ operation: z.literal("goal_review_date"), ...target, date: date.nullable() }).strict(),
]);
export type BusinessInput = z.infer<typeof businessInput>;

export const reviewReportInput = z.object({ title: z.string().min(1).max(200), startDate: date, endDate: date, content: text,
  sources: z.array(z.object({ path: target.path, version: target.version }).strict()).min(1).max(100) }).strict();

/** Reuse the same business rules as DSH. Registration and confirmation stay in KnowledgeCore. */
export async function planBusiness(vault: VaultService, input: BusinessInput) {
  switch (input.operation) {
    case "daily": return vault.planDailyAppend(input.date, input.content);
    case "project_progress": return vault.planProjectAppend(input.path, input.version, input.content);
    case "project_status": return vault.planProjectStatus(input.path, input.version, input.status);
    case "goal": return vault.planLearningGoal(input);
    case "goal_evidence": return vault.planGoalEvidence(input.path, input.version, input.content);
    case "goal_steps": return vault.planGoalSteps(input.path, input.version, input.steps);
    case "goal_task": return vault.planGoalTask(input.path, input.version, input.line, input.checked);
    case "goal_recall": return vault.planGoalRecall(input.path, input.version, input);
    case "goal_review_date": return vault.planGoalReviewDate(input.path, input.version, input.date);
  }
}

export const articleInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), title: z.string().min(1).max(200), sourceName: z.string().min(1).max(500), url: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("markdown"), title: z.string().min(1).max(200), sourceName: z.string().min(1).max(500), content: z.string().min(1).max(2_000_000) }).strict(),
]);
export const sourceFileInput = z.object({ kind: z.enum(["markdown", "pdf"]), title: z.string().min(1).max(200),
  sourceName: z.string().min(1).max(500), projectDirectory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }).strict();
