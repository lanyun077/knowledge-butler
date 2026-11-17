import { describe, expect, it } from "vitest";
import { markdownTasks, taskProgress } from "../src/task-progress";
import { appendGoalEvidence, appendGoalRecall, appendGoalSteps, setGoalTask } from "../src/note-metadata";

describe("checklist progress from Markdown", () => {
  it("appends dated recall questions, user answers and reflections without changing tasks, evidence or formatting", () => {
    const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Active\r\nevidence: []\r\n---\r\n# Goal\r\n- [x] Original\r\n## Evidence\r\nKeep evidence\r\n';
    const after = appendGoalRecall(before, { date: "2026-10-28", entries: [
      { question: "Explain a union type", answer: "I cannot explain it yet.\n- [x] This is quoted answer text", reflection: "Review the example" },
      { question: "Show an example", answer: "type Result = string | number" },
    ] }, "a".repeat(64));
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('## Recall · 2026-10-28\r\n');
    expect(after).toContain("a".repeat(64));
    expect(after).toContain("I cannot explain it yet.");
    expect(after).toContain("Review the example");
    expect(after).not.toMatch(/(?<!\r)\n/);
    expect(taskProgress(after)).toEqual(taskProgress(before));
  });

  it("rejects invalid recall dates, empty answers, excessive entries and notes without a learning goal identity", () => {
    const before = '---\ntype: learning-goal\n---\n# Goal';
    const entry = { question: "Question", answer: "I do not know" };
    for (const input of [{ date: "2026-02-30", entries: [entry] }, { date: "2026-1-01", entries: [entry] },
      { date: "2026-10-28", entries: [] }, { date: "2026-10-28", entries: Array(6).fill(entry) },
      { date: "2026-10-28", entries: [{ ...entry, answer: " " }] }, { date: "2026-10-28", entries: [{ ...entry, question: " " }] },
      { date: "2026-10-28", entries: [{ ...entry, answer: "x".repeat(10001) }] }]) {
      expect(() => appendGoalRecall(before, input, "a".repeat(64))).toThrow();
    }
    expect(() => appendGoalRecall("# Ordinary", { date: "2026-10-28", entries: [entry] }, "a".repeat(64))).toThrow("learning-goal");
    expect(() => appendGoalRecall(before + '\n```md\nOpen block', { date: "2026-10-28", entries: [entry] }, "a".repeat(64))).toThrow();
  });
  it("identifies real task lines and changes only one marker, including nested, quoted and ordered tasks", () => {
    const before = '\uFEFF---\r\ntype: learning-goal\r\nexample: "- [x] YAML"\r\n---\r\n# Goal\r\n- [ ] Duplicate\r\n  - [X] Nested\r\n1. [ ] Duplicate\r\n> - [ ] Quoted\r\n\r\n```md\r\n- [ ] Code\r\n```\r\n';
    const tasks = markdownTasks(before);
    expect(tasks.map(({ line, checked, text }) => ({ line, checked, text }))).toEqual([
      { line: 6, checked: false, text: "Duplicate" }, { line: 7, checked: true, text: "Nested" },
      { line: 8, checked: false, text: "Duplicate" }, { line: 9, checked: false, text: "Quoted" },
    ]);
    expect(setGoalTask(before, 8, true)).toBe(before.replace('1. [ ] Duplicate', '1. [x] Duplicate'));
    expect(setGoalTask(before, 7, false)).toBe(before.replace('[X] Nested', '[ ] Nested'));
    expect(setGoalTask(before, 9, true)).toBe(before.replace('> - [ ] Quoted', '> - [x] Quoted'));
    for (const line of [0, 1.5, 3, 5, 12, 99]) expect(() => setGoalTask(before, line, true)).toThrow();
    expect(() => setGoalTask(before, 7, true)).toThrow("already");
    expect(() => setGoalTask("# Ordinary\n- [ ] Task", 2, true)).toThrow("learning-goal");
  });
  it("appends unchecked goal actions while preserving existing content and rejects ineffective or multiline steps", () => {
    const before = '\uFEFF---\r\ntype: learning-goal\r\ncustom: keep\r\n---\r\n# Goal\r\n- [x] Done\r\n## Evidence\r\nExisting';
    const after = appendGoalSteps(before, ["Read the example", "Write a parser"]);
    expect(after.startsWith(before)).toBe(true);
    expect(after).toBe(before + '\r\n\r\n## Next steps\r\n\r\n- [ ] Read the example\r\n- [ ] Write a parser\r\n');
    expect(taskProgress(after)).toEqual({ completed: 1, total: 3 });
    for (const steps of [[], [" "], ["Task\n- [x] Injected"], ["x".repeat(1001)], Array(31).fill("Task")]) expect(() => appendGoalSteps(before, steps)).toThrow();
    expect(() => appendGoalSteps("# Ordinary", ["Task"])).toThrow("learning-goal");
    expect(() => appendGoalSteps(before + '\r\n```md\r\nUnclosed code', ["Task"])).toThrow("unchecked tasks");
  });
  it("counts explicit nested, ordered and uppercase tasks, excluding YAML and code examples", () => {
    const content = '\uFEFF---\r\nexample: |\r\n  - [x] property\r\n---\r\n# Goal\r\n- [x] Done\r\n  - [ ] Child\r\n1. [X] Ordered\r\n2. [ ] Pending\r\n\r\n```md\r\n- [x] Example\r\n```\r\n\r\n    - [x] Indented code\r\n\r\nText with `- [x] inline code`';
    expect(taskProgress(content)).toEqual({ completed: 2, total: 4 });
  });
  it("distinguishes no tasks, zero completion and all checked without inferring from status or evidence", () => {
    expect(taskProgress('---\nstatus: Completed\n---\n## Evidence\n10 records')).toEqual({ completed: 0, total: 0 });
    expect(taskProgress('- [ ] Pending')).toEqual({ completed: 0, total: 1 });
    expect(taskProgress('- [x] Done')).toEqual({ completed: 1, total: 1 });
  });
});

describe("learning evidence append", () => {
  const before = '\uFEFF---\r\ntype: learning-goal\r\nstatus: Completed # keep\r\nevidence: []\r\ncustom: [a, b]\r\n---\r\n# Goal\r\n\r\n- [x] Done\r\n- [ ] Pending\r\n\r\n```md\r\n## Evidence\r\n```\r\n\r\n## Evidence\r\n\r\nOld evidence\r\n\r\n## Logs\r\n\r\nKeep logs\r\n';
  it("inserts inside the actual section preserving BOM, CRLF, properties and checklist counts", () => {
    const after = appendGoalEvidence(before, 'New evidence\nNext detail');
    expect(after).toBe(before.replace('Old evidence\r\n\r\n## Logs', 'Old evidence\r\n\r\nNew evidence\r\nNext detail\r\n\r\n## Logs'));
    expect(taskProgress(after)).toEqual(taskProgress(before));
  });
  it("adds a missing section and rejects ambiguous sections, invalid goal metadata and task injection", () => {
    expect(appendGoalEvidence('---\ntype: learning-goal\n---\n# Goal', 'Evidence')).toContain('## Evidence\n\nEvidence\n');
    for (const content of ['# Ordinary note', '---\ntype: project\n---', '---\ntype: [broken\n---', before + '\r\n## Evidence\r\n']) {
      expect(() => appendGoalEvidence(content, 'Evidence')).toThrow();
    }
    for (const entry of [' ', '- [x] Claim', '## Tasks\nClaim', 'Section\n=======']) expect(() => appendGoalEvidence(before, entry)).toThrow();
  });
});
