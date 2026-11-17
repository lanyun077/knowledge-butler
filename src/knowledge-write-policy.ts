import type { ChangePlan } from "./vault";

// New notes and additions preserve existing text. Review only destructive edits.
export function writeReview(plan: Pick<ChangePlan, "before" | "after" | "create" | "correction" | "knowledge">): string | undefined {
  if (plan.create) return;
  const body = (text: string) => text.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const before = body(plan.before), after = body(plan.after);
  const changes = plan.correction?.changes ?? plan.knowledge?.changes;
  if (changes) {
    if (plan.knowledge && [...before.matchAll(/^\^([a-z0-9][a-z0-9-]{0,79})\s*$/gm)].some(match => !new RegExp(`^\\^${match[1]}\\s*$`, "m").test(after))) return "删除已有知识条目";
    if (changes.some(change => change.before.trim() && !change.after.trim())) return "删除已有正文";
    const replaced = changes.reduce((length, change) => length + change.before.length, 0);
    if (replaced >= 1000 || (replaced >= 200 && replaced >= before.length * .3)) return "大范围改写已有正文";
    return;
  }
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const removed = before.slice(start, before.length - end), added = after.slice(start, after.length - end);
  if (removed.trim() && !added.trim()) return "删除已有正文";
  if (removed.length >= 1000 || (removed.length >= 200 && removed.length >= before.length * .3)) return "大范围改写已有正文";
}

export type SaveAuthorization = "user-request" | "user-confirmed" | "full-access";
