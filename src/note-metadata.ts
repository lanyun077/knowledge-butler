import { isMap, isScalar, parseDocument, stringify } from "yaml";
import { markdownTasks, markdownTree, taskProgress } from "./task-progress";

export const projectStatuses = ["Active", "Paused", "Completed", "Archive"] as const;
export interface LearningGoalInput {
  title: string;
  purpose: string;
  background: string;
  outcome: string;
  schedule: string;
  targetDate: string;
  verification: string;
}

export interface GoalRecallInput {
  date: string;
  entries: { question: string; answer: string; reflection?: string }[];
}

export function validReviewDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function goalReviewDate(content: string): { date: string | null } | undefined {
  const metadata = frontmatter(content);
  if (metadata?.document.get("type") !== "learning-goal") return undefined;
  const value = metadata.document.get("nextReview");
  if (value === undefined || value === null || value === "") return { date: null };
  if (typeof value !== "string" || !validReviewDate(value)) throw new Error("nextReview must be a valid YYYY-MM-DD date or null");
  return { date: value };
}

export function setGoalReviewDate(content: string, date: string | null): string {
  const metadata = frontmatter(content);
  if (metadata?.document.get("type") !== "learning-goal") throw new Error("Note must have type: learning-goal");
  if (date !== null && !validReviewDate(date)) throw new Error("Review date must be a valid YYYY-MM-DD date or null");
  const { document, start, end } = metadata;
  if (isMap(document.contents) && document.contents.items.some(pair => isScalar(pair.key) && pair.key.value === "<<")) {
    throw new Error("Merged frontmatter requires manual editing");
  }
  const value = document.get("nextReview", true);
  const token = date === null ? "null" : `"${date}"`;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  if (value === undefined) return `${content.slice(0, end)}nextReview: ${token}${newline}${content.slice(end)}`;
  if (!isScalar(value) || !value.range || value.anchor || (value.type && !["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"].includes(value.type))) {
    throw new Error("Complex nextReview property requires manual editing");
  }
  return content.slice(0, start + value.range[0]) + token + content.slice(start + value.range[1]);
}

function frontmatter(content: string) {
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(content);
  if (!opening) return undefined;
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(content.slice(opening[0].length));
  if (!closing) throw new Error("Unclosed YAML frontmatter");
  const start = opening[0].length;
  const end = start + closing.index;
  const document = parseDocument(content.slice(start, end));
  if (document.errors.length) throw new Error(document.errors.map(error => error.message).join("; "));
  if (document.contents && !isMap(document.contents)) throw new Error("Frontmatter must be a YAML mapping");
  return { document, start, end };
}

export function noteStatus(content: string): { status?: string; metadataError?: string } {
  try {
    const value = frontmatter(content)?.document.get("status");
    if (value === undefined) return {};
    if (typeof value !== "string") throw new Error("Status must be a string");
    return { status: value };
  } catch (error) {
    return { metadataError: error instanceof Error ? error.message : String(error) };
  }
}

export function appendGoalEvidence(before: string, content: string): string {
  if (frontmatter(before)?.document.get("type") !== "learning-goal") throw new Error("Note must have type: learning-goal");
  const entry = content.trim();
  if (!entry) throw new Error("Learning evidence must not be empty");
  if (taskProgress(entry).total || markdownTree(entry).children.some(node => node.type === "heading" && node.depth <= 2)) {
    throw new Error("Evidence must not add task checkboxes or top-level sections");
  }
  const tree = markdownTree(before);
  const headings = tree.children.filter(node => node.type === "heading" && node.depth === 2
    && node.children.length === 1 && node.children[0].type === "text" && node.children[0].value === "Evidence");
  if (headings.length > 1) throw new Error("Multiple Evidence sections require manual editing");
  const heading = headings[0];
  const next = heading && tree.children.slice(tree.children.indexOf(heading) + 1).find(node => node.type === "heading" && node.depth <= 2);
  const insertion = next?.position?.start.offset === undefined ? before.length : next.position.start.offset + (before.startsWith("\uFEFF") ? 1 : 0);
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const prefix = before.slice(0, insertion);
  const separator = prefix.endsWith(newline + newline) ? "" : prefix.endsWith(newline) ? newline : newline + newline;
  return `${prefix}${separator}${heading ? "" : `## Evidence${newline}${newline}`}${entry.replace(/\r?\n/g, newline)}${newline}${insertion < before.length ? newline : ""}${before.slice(insertion)}`;
}

export function appendGoalSteps(before: string, steps: string[]): string {
  if (frontmatter(before)?.document.get("type") !== "learning-goal") throw new Error("Note must have type: learning-goal");
  if (!steps.length || steps.length > 30 || steps.some(step => !step.trim() || step.length > 1000 || /[\r\n]/.test(step))) {
    throw new Error("Learning steps require 1-30 non-empty single-line descriptions of up to 1000 characters");
  }
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const separator = before.endsWith(newline + newline) ? "" : before.endsWith(newline) ? newline : newline + newline;
  const after = `${before}${separator}## Next steps${newline}${newline}${steps.map(step => `- [ ] ${step.trim()}`).join(newline)}${newline}`;
  const original = taskProgress(before);
  const updated = taskProgress(after);
  if (updated.total !== original.total + steps.length || updated.completed !== original.completed) {
    throw new Error("Next steps must produce unchecked tasks; close open code or HTML blocks before appending");
  }
  return after;
}

export function appendGoalRecall(before: string, input: GoalRecallInput, version: string): string {
  if (frontmatter(before)?.document.get("type") !== "learning-goal") throw new Error("Note must have type: learning-goal");
  const date = new Date(`${input.date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) {
    throw new Error("Recall date must be a valid YYYY-MM-DD calendar date");
  }
  if (!input.entries.length || input.entries.length > 5 || input.entries.some(entry =>
    !entry.question.trim() || entry.question.length > 2000 || !entry.answer.trim() || entry.answer.length > 10_000
    || (entry.reflection?.length ?? 0) > 5000)) throw new Error("Recall requires 1-5 answered questions within field limits");
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  // Literal blocks keep answers (including Markdown examples) out of the goal's checklist.
  const literal = (text: string) => text.trim().split(/\r?\n/).map(line => `    ${line}`).join(newline);
  const separator = before.endsWith(newline + newline) ? "" : before.endsWith(newline) ? newline : newline + newline;
  const heading = `## Recall · ${input.date}`;
  const entries = input.entries.map((entry, index) => `### ${index + 1}${newline}${newline}问题：${newline}${newline}${literal(entry.question)}${newline}${newline}用户回答：${newline}${newline}${literal(entry.answer)}${newline}`
    + (entry.reflection?.trim() ? `${newline}用户自我反思：${newline}${newline}${literal(entry.reflection)}${newline}` : "")).join(newline);
  const after = `${before}${separator}${heading}${newline}${newline}本次仅记录问答与自我反思，不代表学习成果已验证。${newline}复习依据版本：\`${version}\`${newline}${newline}${entries}`;
  const headingOffset = before.length + separator.length - (before.startsWith("\uFEFF") ? 1 : 0);
  if (!markdownTree(after).children.some(node => node.type === "heading" && node.depth === 2 && node.position?.start.offset === headingOffset)) {
    throw new Error("Close open Markdown blocks before appending recall records");
  }
  return after;
}

export function setGoalTask(before: string, line: number, checked: boolean): string {
  if (frontmatter(before)?.document.get("type") !== "learning-goal") throw new Error("Note must have type: learning-goal");
  if (!Number.isSafeInteger(line) || line < 1 || typeof checked !== "boolean") throw new Error("Invalid task line or checked state");
  const task = markdownTasks(before).find(task => task.line === line);
  if (!task) throw new Error("No Markdown task at the requested line; reread the goal checklist");
  if (task.checked === checked) throw new Error("Task already has the requested state");
  return before.slice(0, task.markerOffset) + (checked ? "x" : " ") + before.slice(task.markerOffset + 1);
}

export function setProjectStatus(content: string, status: string): string {
  if (!projectStatuses.some(value => value === status)) throw new Error("Invalid project status");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const metadata = frontmatter(content);
  if (!metadata) {
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
    return `${bom}---${newline}status: ${status}${newline}---${newline}${content.slice(bom.length)}`;
  }
  const { document, start, end } = metadata;
  if (isMap(document.contents) && document.contents.items.some(pair => isScalar(pair.key) && pair.key.value === "<<")) {
    throw new Error("Merged frontmatter requires manual editing");
  }
  const value = document.get("status", true);
  if (value === undefined) return `${content.slice(0, end)}status: ${status}${newline}${content.slice(end)}`;
  if (!isScalar(value) || typeof value.value !== "string" || !value.range || value.anchor
    || !["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"].includes(value.type ?? "")) {
    throw new Error("Complex status property requires manual editing");
  }
  // Only replace the scalar token; comments, unknown fields, BOM and body stay byte-for-byte intact.
  return content.slice(0, start + value.range[0]) + status + content.slice(start + value.range[1]);
}

export function learningGoalContent(input: LearningGoalInput, id: string): string {
  if (!input.title.trim() || input.title.includes("/") || input.title.includes("\\") || /[\r\n]/.test(input.title)) {
    throw new Error("Learning goal title must be a filename");
  }
  if (!input.outcome.trim() || !input.verification.trim()) throw new Error("Learning outcome and verification are required");
  if (input.targetDate) {
    const date = new Date(`${input.targetDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.targetDate) {
      throw new Error("Target date must be YYYY-MM-DD");
    }
  }
  const metadata = stringify({ id, type: "learning-goal", schemaVersion: 1, title: input.title.trim(),
    status: "Active", schedule: input.schedule.trim(), targetDate: input.targetDate || null, evidence: [] });
  return `---\n${metadata}---\n# ${input.title.trim()}\n\n## Purpose\n\n${input.purpose.trim()}\n\n## Background\n\n${input.background.trim()}\n\n## Outcome\n\n${input.outcome.trim()}\n\n## Verification\n\n${input.verification.trim()}\n\n## Evidence\n`;
}
