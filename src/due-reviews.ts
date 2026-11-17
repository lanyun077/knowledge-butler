import { goalReviewDate, validReviewDate } from "./note-metadata";
import type { VaultService } from "./vault";

/** The explicit date is a calendar cutoff, never inferred from the server's time zone. */
export async function dueReviews(vault: Pick<VaultService, "list" | "read">, date: string, offset = 0, signal?: AbortSignal) {
  if (!validReviewDate(date)) throw new Error("Review cutoff must be a valid YYYY-MM-DD date");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid review offset");
  const due: { path: string; title: string; version: string; date: string; overdue: boolean }[] = [];
  const invalid: { path: string; error: string }[] = [];
  let unscheduled = 0;
  for (const item of await vault.list("", signal)) {
    if (item.category !== "learning") continue;
    signal?.throwIfAborted();
    const note = await vault.read(item.path, signal);
    try {
      const review = goalReviewDate(note.content);
      if (!review || ["Paused", "Completed", "Archive"].includes(note.status ?? "")) continue;
      if (!review.date) { unscheduled++; continue; }
      if (review.date <= date) due.push({ path: note.path, title: note.title, version: note.version, date: review.date, overdue: review.date < date });
    } catch (error) { invalid.push({ path: note.path, error: error instanceof Error ? error.message : String(error) }); }
  }
  due.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
  if (offset > due.length) throw new Error("Review list changed; restart at offset 0");
  const sources = due.slice(offset, offset + 20);
  return { date, total: due.length, unscheduled, invalid, sources, nextOffset: offset + sources.length, truncated: offset + sources.length < due.length };
}

export type DueReviews = Awaited<ReturnType<typeof dueReviews>>;
