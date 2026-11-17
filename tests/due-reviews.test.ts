import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { VaultService } from "../src/vault";
import { dueReviews } from "../src/due-reviews";
import { goalReviewDate, setGoalReviewDate } from "../src/note-metadata";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("changes only nextReview while preserving BOM, CRLF, comments, tasks, evidence and unknown fields", () => {
  const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Active\r\nnextReview: 2026-10-01 # keep\r\ncustom: [a, b]\r\n---\r\n# Goal\r\n- [x] Done\r\n## Evidence\r\nKeep\r\n';
  const after = setGoalReviewDate(before, "2026-11-01");
  expect(after).toBe(before.replace("2026-10-01", '"2026-11-01"'));
  expect(goalReviewDate(after)).toEqual({ date: "2026-11-01" });
  expect(setGoalReviewDate(after, null)).toBe(before.replace("2026-10-01", "null"));
  expect(goalReviewDate(setGoalReviewDate(after, null))).toEqual({ date: null });
  expect(setGoalReviewDate('---\ntype: learning-goal\n---\n# Goal', "2028-02-29")).toContain('nextReview: "2028-02-29"\n---');
  for (const date of ["2026-02-29", "2026-2-01", "not-a-date"]) expect(() => setGoalReviewDate(before, date)).toThrow();
  for (const content of ["# Ordinary", '---\ntype: learning-goal\nnextReview: [2026-10-01]\n---\n# Goal', '---\ntype: learning-goal\nnextReview: 2026-10-01\nnextReview: 2026-10-02\n---']) {
    expect(() => setGoalReviewDate(content, null)).toThrow();
  }
});

it("lists due active goals in mapped folders with pagination, invalid dates and unscheduled counts without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "learning-due-")); roots.push(root);
  await mkdir(join(root, "Goals/学习"), { recursive: true });
  const vault = new VaultService(root, { learning: "Goals/学习" });
  const write = (name: string, metadata: string) => writeFile(join(root, `Goals/学习/${name}.md`), `---\ntype: learning-goal\n${metadata}\n---\n# ${name}`);
  await Promise.all(Array.from({ length: 21 }, (_, i) => write(`due-${String(i).padStart(2, "0")}`, 'nextReview: "2026-10-27"')));
  await write("today", 'nextReview: "2026-10-28"');
  await write("future", 'nextReview: "2026-11-01"');
  for (const status of ["Paused", "Completed", "Archive"]) await write(status, `status: ${status}\nnextReview: "2026-10-01"`);
  await write("undated", "nextReview: null"); await write("invalid", 'nextReview: "2026-02-30"');
  await writeFile(join(root, "Goals/学习/ordinary.md"), "# Ordinary");
  const first = await dueReviews(vault, "2026-10-28");
  expect(first).toMatchObject({ total: 22, unscheduled: 1, nextOffset: 20, truncated: true });
  expect(first.invalid.map(item => item.path)).toEqual(["Goals/学习/invalid.md"]);
  expect(first.sources.every(item => item.overdue)).toBe(true);
  const second = await dueReviews(vault, "2026-10-28", first.nextOffset);
  expect(second.sources.at(-1)).toMatchObject({ title: "today", overdue: false });
  expect(second.truncated).toBe(false);
  const previous = second.sources.at(-1)!;
  await write("today", 'nextReview: "2026-10-28"\ncustom: changed');
  expect((await dueReviews(vault, "2026-10-28", 20)).sources.at(-1)!.version).not.toBe(previous.version);
  await expect(vault.activity()).resolves.toEqual([]);
  await expect(dueReviews(vault, "2026-02-30")).rejects.toThrow();
  await expect(dueReviews(vault, "2026-10-28", 100)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(dueReviews(vault, "2026-10-28", 0, controller.signal)).rejects.toThrow();
});
