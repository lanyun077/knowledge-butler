import { posix } from "node:path";
import type { NoteDocument, VaultService } from "./vault";

export interface ReviewSource extends Omit<NoteDocument, "content" | "excerpt" | "reuse"> {
  timeBasis: "daily-date" | "current-snapshot";
  date?: string;
}

export interface ReviewReportInput {
  title: string; startDate: string; endDate: string; content: string;
  sources: { path: string; version: string }[];
}
export interface ReviewReport {
  startDate: string; endDate: string; collectedAt: string; total: number;
  missingDailyDates: string[]; excludedDailyNotes: number;
  sources: { path: string; version: string; timeBasis: ReviewSource["timeBasis"]; date?: string }[];
}

function calendarDay(value: string): number {
  const day = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value) {
    throw new Error("Review dates must be valid YYYY-MM-DD calendar dates");
  }
  return day;
}

/** Collect sources, not claims about what was completed during the period. */
export async function periodReview(vault: Pick<VaultService, "list" | "read">, startDate: string, endDate: string, offset = 0, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const start = calendarDay(startDate);
  const end = calendarDay(endDate);
  const dayCount = (end - start) / 86_400_000 + 1;
  if (dayCount < 1 || dayCount > 366) throw new Error("Review range must contain 1-366 inclusive calendar days");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset must be a non-negative integer");
  const notes = await vault.list("", signal);
  const dates = new Set<string>();
  let excludedDailyNotes = 0;
  const candidates: { path: string; category: string; date?: string }[] = [];
  for (const note of notes) {
    if (note.category === "daily") {
      const date = /^(\d{4}-\d{2}-\d{2})\.md$/i.exec(posix.basename(note.path))?.[1];
      if (!date) { excludedDailyNotes++; continue; }
      try { calendarDay(date); }
      catch { excludedDailyNotes++; continue; }
      if (date >= startDate && date <= endDate) {
        dates.add(date);
        candidates.push({ path: note.path, category: note.category, date });
      }
    } else if (note.category === "projects" || note.category === "learning") {
      candidates.push({ path: note.path, category: note.category });
    }
  }
  const order = ["daily", "projects", "learning"];
  candidates.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category)
    || (a.date ?? "").localeCompare(b.date ?? "") || a.path.localeCompare(b.path));
  if (offset > candidates.length) throw new Error("Offset is beyond the current review sources; restart from offset 0");
  const sources: ReviewSource[] = [];
  for (const candidate of candidates.slice(offset, offset + 20)) {
    signal?.throwIfAborted();
    const { content, excerpt, reuse, ...note } = await vault.read(candidate.path, signal);
    sources.push({ ...note, timeBasis: candidate.date ? "daily-date" : "current-snapshot", ...(candidate.date ? { date: candidate.date } : {}) });
  }
  signal?.throwIfAborted();
  const missingDailyDates = Array.from({ length: dayCount }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10))
    .filter(date => !dates.has(date));
  const nextOffset = offset + sources.length;
  return { startDate, endDate, collectedAt: new Date().toISOString(), missingDailyDates, excludedDailyNotes,
    total: candidates.length, nextOffset, truncated: nextOffset < candidates.length, sources };
}

/** Build an explicitly sourced draft; its prose remains a model/user claim. */
export async function prepareReviewReport(vault: Pick<VaultService, "list" | "read">, input: ReviewReportInput, path: string) {
  if (!input.title.trim() || input.title.length > 200 || /[\\/\r\n]/.test(input.title)
    || !input.content.trim() || input.content.length > 100_000) throw new Error("Invalid review title or content");
  if (!input.sources.length || input.sources.length > 100 || new Set(input.sources.map(source => source.path)).size !== input.sources.length) {
    throw new Error("Review requires 1-100 distinct fully read sources");
  }
  const period = await periodReview(vault, input.startDate, input.endDate);
  const sources: ReviewReport["sources"] = [];
  for (const source of input.sources) {
    if (source.path.length > 4096 || !/^[0-9a-f]{64}$/.test(source.version)) throw new Error("Invalid review source path or version");
    const note = await vault.read(source.path);
    if (note.version !== source.version) throw new Error("Review source changed externally; reread before summarizing");
    if (note.category === "daily") {
      const date = /^(\d{4}-\d{2}-\d{2})\.md$/i.exec(posix.basename(note.path))?.[1];
      if (!date || date < input.startDate || date > input.endDate) throw new Error("Daily review source is outside the requested period");
      calendarDay(date);
      sources.push({ ...source, timeBasis: "daily-date", date });
    } else if (note.category === "projects" || note.category === "learning") {
      sources.push({ ...source, timeBasis: "current-snapshot" });
    } else throw new Error("Review sources must be Daily, project or learning notes");
  }
  const report: ReviewReport = { startDate: period.startDate, endDate: period.endDate, collectedAt: period.collectedAt,
    total: period.total, missingDailyDates: period.missingDailyDates, excludedDailyNotes: period.excludedDailyNotes, sources };
  const links = sources.map(source => {
    const link = posix.relative(posix.dirname(path), source.path).split("/").map(encodeURIComponent).join("/");
    const label = source.path.replace(/[\\[\]]/g, "\\$&");
    return `- [${label}](<${link}>) · ${source.date ? `${source.date} 日记` : "当前无日期快照"} · 原文版本：\`${source.version}\``;
  }).join("\n");
  const content = `# ${input.title.trim()}\n\n日期范围：${report.startDate} 至 ${report.endDate}（含首尾，仅适用于 Daily）\n资料收集时间：${report.collectedAt}\n\n`
    + `> 本报告选用 ${sources.length} / ${report.total} 篇候选资料，不代表全部记录或成果已验证。项目和学习资料是当前无日期快照，不能据此断言本期完成。\n`
    + `> 收集时缺少 Daily 的日期：${report.missingDailyDates.join("、") || "无"}。缺少记录不代表没有学习。\n`
    + `> 收集时排除的无日期或无效日期 Daily：${report.excludedDailyNotes} 篇。\n\n${input.content.trim()}\n\n## 汇总资料来源\n\n${links}\n`;
  return { report, content };
}
