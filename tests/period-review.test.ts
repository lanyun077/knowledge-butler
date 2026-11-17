import { describe, expect, it, vi } from "vitest";
import { periodReview } from "../src/period-review";
import type { NoteDocument } from "../src/vault";

function fixture() {
  const notes: NoteDocument[] = [
    { path: "记录/2026-10-26.md", category: "daily", title: "Custom title", content: "Plan: write tests", version: "v26", excerpt: "" },
    { path: "记录/2026-10-28.md", category: "daily", title: "Today", content: "Done: tests", version: "v28", excerpt: "" },
    { path: "记录/2026-10-29.md", category: "daily", title: "Outside", content: "", version: "v29", excerpt: "" },
    { path: "记录/notes.md", category: "daily", title: "Undated", content: "", version: "vu", excerpt: "" },
    { path: "记录/2026-02-30.md", category: "daily", title: "Invalid date", content: "", version: "vi", excerpt: "" },
    { path: "项目/甲.md", category: "projects", title: "Same name", content: "## Progress\nUndated", version: "vp", excerpt: "", status: "Completed", tasks: { completed: 1, total: 2 } },
    { path: "学习/甲.md", category: "learning", title: "Same name", content: "## Evidence\nUndated", version: "vl", excerpt: "", metadataError: "Invalid status" },
    { path: "Wiki/unrelated.md", category: "knowledge", title: "Unrelated", content: "", version: "vk", excerpt: "" },
  ];
  return { notes, vault: { list: vi.fn(async () => notes.map(({ content, version, ...note }) => note)),
    read: vi.fn(async (path: string) => notes.find(note => note.path === path)!) } };
}

describe("period review source collection", () => {
  it("uses inclusive Daily filename dates and keeps project/learning snapshots explicitly undated", async () => {
    const { vault } = fixture();
    const result = await periodReview(vault, "2026-10-26", "2026-10-28");
    expect(result).toMatchObject({ startDate: "2026-10-26", endDate: "2026-10-28", total: 4, nextOffset: 4, truncated: false,
      missingDailyDates: ["2026-10-27"], excludedDailyNotes: 2 });
    expect(result.sources.map(note => note.path)).toEqual(["记录/2026-10-26.md", "记录/2026-10-28.md", "项目/甲.md", "学习/甲.md"]);
    expect(result.sources[0]).toMatchObject({ date: "2026-10-26", timeBasis: "daily-date", version: "v26" });
    expect(result.sources[2]).toMatchObject({ timeBasis: "current-snapshot", status: "Completed", tasks: { completed: 1, total: 2 } });
    expect(result.sources[2]).not.toHaveProperty("date");
    expect(result.sources[3]).toMatchObject({ timeBasis: "current-snapshot", metadataError: "Invalid status" });
    expect(result.sources[0]).not.toHaveProperty("content");
  });

  it("reports empty dates without inventing records, and accepts leap days and nested Daily filenames", async () => {
    const { vault, notes } = fixture();
    notes.splice(0, notes.length);
    expect(await periodReview(vault, "2024-02-28", "2024-03-01")).toMatchObject({ total: 0, sources: [], truncated: false,
      missingDailyDates: ["2024-02-28", "2024-02-29", "2024-03-01"] });
    notes.push({ path: "记录/2024/2024-02-29.md", category: "daily", title: "Leap", content: "", version: "v", excerpt: "" });
    expect(await periodReview(vault, "2024-02-29", "2024-02-29")).toMatchObject({ total: 1, missingDailyDates: [], sources: [{ date: "2024-02-29" }] });
  });

  it("paginates 20 sources, retains exact paths and reads fresh versions for each page", async () => {
    const { vault, notes } = fixture();
    notes.splice(0, notes.length, ...Array.from({ length: 22 }, (_, index) => ({ path: `项目/${String(index).padStart(2, "0")}.md`, category: "projects", title: "Same", content: "", version: "v1", excerpt: "" })));
    const first = await periodReview(vault, "2026-10-28", "2026-10-28");
    expect(first).toMatchObject({ total: 22, nextOffset: 20, truncated: true });
    expect(first.sources).toHaveLength(20);
    notes[20].version = "v2";
    const last = await periodReview(vault, "2026-10-28", "2026-10-28", first.nextOffset);
    expect(last).toMatchObject({ nextOffset: 22, truncated: false });
    expect(last.sources.map(note => note.version)).toEqual(["v2", "v1"]);
    expect(vault.read).toHaveBeenCalledTimes(22);
    expect((await periodReview(vault, "2026-10-28", "2026-10-28", 22)).sources).toEqual([]);
  });

  it("rejects invalid dates, inverted or overlong ranges, offsets and cancellations before scanning", async () => {
    const { vault } = fixture();
    for (const [start, end, offset] of [["2026-02-30", "2026-03-01", 0], ["2026-1-01", "2026-01-02", 0],
      ["2026-10-29", "2026-10-28", 0], ["2025-01-01", "2026-01-02", 0], ["2026-10-28", "2026-10-28", -1],
      ["2026-10-28", "2026-10-28", 0.5]] as const) {
      await expect(periodReview(vault, start, end, offset)).rejects.toThrow();
    }
    const controller = new AbortController(); controller.abort();
    await expect(periodReview(vault, "2026-10-28", "2026-10-28", 0, controller.signal)).rejects.toThrow();
    expect(vault.list).not.toHaveBeenCalled();
    await expect(periodReview(vault, "2026-10-28", "2026-10-28", 99)).rejects.toThrow("Offset");
  });
});
