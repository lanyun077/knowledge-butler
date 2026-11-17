import { posix } from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import { markdownTree } from "./task-progress";

const version = z.string().regex(/^[a-f0-9]{64}$/);
export const correctionInput = z.object({
  sourcePath: z.string().min(1).max(4096), sourceVersion: version,
  targetPath: z.string().min(1).max(4096), targetVersion: version,
  changes: z.array(z.object({ before: z.string().min(1).max(100000), after: z.string().max(100000) }).strict()).min(1).max(20),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type CorrectionInput = z.infer<typeof correctionInput>;

export function correctionBody(before: string, input: CorrectionInput, id: string): string {
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(before);
  const closing = opening && /^---[ \t]*(?:\r?\n|$)/m.exec(before.slice(opening[0].length));
  if (opening && !closing) throw new Error("Unclosed YAML frontmatter requires manual editing");
  const bodyStart = opening ? opening[0].length + closing!.index + closing![0].length : before.startsWith("\uFEFF") ? 1 : 0;
  if (opening && parseDocument(before.slice(opening[0].length, opening[0].length + closing!.index)).errors.length) {
    throw new Error("Invalid YAML frontmatter requires manual editing");
  }
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const edits = input.changes.map(change => {
    if (!change.before.trim() || change.before === change.after) throw new Error("Correction must replace nonempty, changed text");
    const start = before.indexOf(change.before, bodyStart);
    if (start < 0 || before.indexOf(change.before, start + 1) >= 0) throw new Error("Correction text must match exactly once in the knowledge body; include more context");
    return { start, end: start + change.before.length, after: change.after.replace(/\r?\n/g, newline) };
  }).sort((a, b) => a.start - b.start);
  if (edits.some((edit, i) => i > 0 && edit.start < edits[i - 1].end)) throw new Error("Correction changes must not overlap");
  let edited = before;
  for (const edit of [...edits].reverse()) edited = edited.slice(0, edit.start) + edit.after + edited.slice(edit.end);
  if (edited === before) throw new Error("Correction does not change the knowledge body");
  if (!opening && /^(?:\uFEFF)?---\r?\n/.test(edited)) throw new Error("Correction must not introduce frontmatter");
  const link = (path: string) => posix.relative(posix.dirname(input.targetPath), path).split("/").map(encodeURIComponent).join("/");
  const separator = edited.endsWith(newline + newline) ? "" : edited.endsWith(newline) ? newline : newline + newline;
  const heading = `知识纠正 ${id}`;
  const after = `${edited}${separator}## ${heading}${newline}${newline}`
    + `来源：[交接文档](<${link(input.sourcePath)}>) · 版本：\`${input.sourceVersion}\`${newline}${newline}`
    + `替代知识版本：\`${input.targetVersion}\`。未列入替换的内容保留；原结论及采用结论见[本次替换记录](<${link(`.ai-learning-os/plans/${id}.json`)}>)。${newline}${newline}`
    + `理由：${newline}${newline}${input.reason.split(/\r?\n/).map(line => `    ${line}`).join(newline)}${newline}`;
  const offset = edited.length + separator.length - (after.startsWith("\uFEFF") ? 1 : 0);
  if (!markdownTree(after).children.some(node => node.type === "heading" && node.position?.start.offset === offset)) {
    throw new Error("Correction leaves the provenance inside an unclosed Markdown block");
  }
  return after;
}
