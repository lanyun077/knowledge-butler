import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultService } from "../src/vault";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "learning-vault-"));
  roots.push(root);
  return { root, service: new VaultService(root) };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Markdown Vault business service", () => {
  it("previews chat sources without writing, preserves UTF-8 bytes and prevents duplicates across restarts", async () => {
    const { root } = await fixture();
    const service = new VaultService(root, { inbox: "收件箱/聊天" });
    const content = '\uFEFF用户 10:00：解释联合类型。\r\n助手：```ts\r\nlet value: string | number;\r\n```\r\n- [ ] 历史任务\r\n';
    const input = { title: "联合类型", sourceName: 'DeepSeek "导出".md', content };
    const preview = await service.planChatImport(input);
    const plan = preview.plan!;
    expect(plan.path).toBe("收件箱/聊天/联合类型.md");
    expect(plan.after).toContain(content);
    expect(plan.after).toContain("../../.ai-learning-os/sources/");
    await expect(service.read(plan.path)).rejects.toThrow();
    await expect(readFile(join(root, plan.chat!.snapshotPath))).rejects.toThrow();
    expect((await service.execute(plan.id)).status).toBe("completed");
    expect(await readFile(join(root, plan.chat!.snapshotPath))).toEqual(Buffer.from(content, "utf8"));
    expect((await service.list("联合类型"))[0].path).toBe(plan.path);
    expect((await service.read(plan.path)).content).toBe(plan.after);
    expect(await service.execute(plan.id)).toMatchObject({ id: plan.id, status: "completed" });
    expect(await service.activity()).toHaveLength(1);
    const restarted = new VaultService(root, { inbox: "收件箱/聊天" });
    expect(await restarted.planChatImport({ ...input, title: "其他标题", sourceName: "再次粘贴" })).toMatchObject({ duplicate: { path: plan.path } });
    await expect(restarted.planChatImport({ ...input, content: "另一版本" })).rejects.toThrow("already exists");
    expect((await service.read(plan.path)).content).toBe(plan.after);
  });

  it("invalidates cancelled imports, rejects competing duplicate plans and preserves external files", async () => {
    const { root, service } = await fixture();
    const input = { title: "聊天", sourceName: "粘贴", content: "用户：测试\n助手：回答" };
    const cancelled = (await service.planChatImport(input)).plan!;
    await service.cancelPlan(cancelled.id);
    await expect(service.execute(cancelled.id)).rejects.toThrow("Plan changed");
    await expect(readFile(join(root, cancelled.chat!.snapshotPath))).rejects.toThrow();
    const first = (await service.planChatImport(input)).plan!;
    const second = (await service.planChatImport({ ...input, title: "另一标题" })).plan!;
    expect((await service.execute(first.id)).status).toBe("completed");
    expect(await service.execute(second.id)).toMatchObject({ status: "failed", error: expect.stringContaining("already imported") });
    await expect(service.read(second.path)).rejects.toThrow();
    const conflict = (await service.planChatImport({ ...input, title: "外部创建", content: "新内容" })).plan!;
    await writeFile(join(root, conflict.path), "外部文件");
    expect((await service.execute(conflict.id)).status).toBe("failed");
    expect(await readFile(join(root, conflict.path), "utf8")).toBe("外部文件");
    await expect(readFile(join(root, conflict.chat!.snapshotPath))).rejects.toThrow();
  });

  it("rejects invalid chat input and changed source snapshots instead of overwriting them", async () => {
    const { root, service } = await fixture();
    const input = { title: "聊天", sourceName: "粘贴", content: "用户：内容" };
    for (const change of [{ title: "../escape" }, { sourceName: "source\nname" }, { content: " " }, { content: "binary\x00text" }, { content: "\ud800" }, { content: "a".repeat(2_000_001) }]) {
      await expect(service.planChatImport({ ...input, ...change })).rejects.toThrow();
    }
    const plan = (await service.planChatImport(input)).plan!;
    await mkdir(join(root, ".ai-learning-os/sources"), { recursive: true });
    await writeFile(join(root, plan.chat!.snapshotPath), "Changed snapshot");
    expect(await service.execute(plan.id)).toMatchObject({ status: "failed", error: expect.stringContaining("snapshot changed") });
    expect(await readFile(join(root, plan.chat!.snapshotPath), "utf8")).toBe("Changed snapshot");
    await expect(service.read(plan.path)).rejects.toThrow();
  });

  it("builds a mapped review report with authoritative coverage, source versions and encoded relative links", async () => {
    const { root } = await fixture();
    const service = new VaultService(root, { daily: "记录", projects: "项目", knowledge: "知识" });
    await mkdir(join(root, "记录")); await mkdir(join(root, "项目"));
    await writeFile(join(root, "记录/2026-10-28.md"), "# Done\nFinished tests");
    await writeFile(join(root, "记录/undated.md"), "No date");
    await writeFile(join(root, "项目/项目#[1]).md"), "# Project\nPlanned work");
    const daily = await service.read("记录/2026-10-28.md");
    const project = await service.read("项目/项目#[1]).md");
    const sources = [daily, project].map(({ path, version }) => ({ path, version }));
    const args = { title: "周报", startDate: "2026-10-27", endDate: "2026-10-28", content: "## Facts\nTests finished\n## Plans\nNext step", sources };
    const plan = await service.planReviewReport(args);
    expect(plan).toMatchObject({ path: "知识/周报.md", create: true, before: "", report: { total: 2, missingDailyDates: ["2026-10-27"], excludedDailyNotes: 1,
      sources: [{ timeBasis: "daily-date", date: "2026-10-28" }, { timeBasis: "current-snapshot" }] } });
    expect(plan.after).toContain("选用 2 / 2 篇");
    expect(plan.after).toContain("当前无日期快照");
    expect(plan.after).toContain("%23%5B1%5D)");
    for (const source of sources) expect(plan.after).toContain(source.version);
    await expect(service.read(plan.path)).rejects.toThrow();
    expect((await service.execute(plan.id)).status).toBe("completed");
    expect((await service.read(plan.path)).content).toBe(plan.after);
    await expect(service.planReviewReport(args)).rejects.toThrow("already exists");
    for (const change of [{ title: "../escape" }, { title: "new", sources: [] }, { title: "new", sources: [sources[0], sources[0]] },
      { title: "new", startDate: "2026-10-29" }, { title: "new", endDate: "2026-10-27" },
      { title: "new", content: " " }, { title: "new", sources: [{ path: plan.path, version: (await service.read(plan.path)).version }] }]) {
      await expect(service.planReviewReport({ ...args, ...change })).rejects.toThrow();
    }
  });

  it("rejects a review source change while preparing the report write", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Daily"));
    await writeFile(join(root, "Daily/2026-10-28.md"), "Original");
    const source = await service.read("Daily/2026-10-28.md");
    const plan = await service.planReviewReport({ title: "Review", startDate: "2026-10-28", endDate: "2026-10-28", content: "Original summary", sources: [{ path: source.path, version: source.version }] });
    const read = service.read.bind(service);
    let sourceReads = 0;
    vi.spyOn(service, "read").mockImplementation(async (path, signal) => {
      if (path === source.path && ++sourceReads === 2) await writeFile(join(root, path), "Changed during confirmation");
      return read(path, signal);
    });
    expect(await service.execute(plan.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Review source changed externally") });
    await expect(read(plan.path)).rejects.toThrow();
    expect((await read(source.path)).content).toBe("Changed during confirmation");
  });

  it("keeps mapped source links valid and rechecks the Inbox version just before replacing the target", async () => {
    const { root } = await fixture();
    const service = new VaultService(root, { inbox: "收件箱", knowledge: "知识" });
    const source = await service.capture("来源#[1])", "Original source");
    await mkdir(join(root, "知识"));
    await writeFile(join(root, "知识/target.md"), "# Existing");
    const target = await service.read("知识/target.md");
    const plan = await service.planInbox({ sourcePath: source.path, sourceVersion: source.version,
      targetPath: target.path, targetVersion: target.version, content: "New contribution", reason: "Same subject" });
    expect(plan.after).toContain("%23%5B1%5D)");
    expect(plan.after).toContain("](<../");
    const read = service.read.bind(service);
    let targetReads = 0;
    vi.spyOn(service, "read").mockImplementation(async (path, signal) => {
      const document = await read(path, signal);
      if (path === target.path && ++targetReads === 2) await writeFile(join(root, source.path), "External edit during confirmation");
      return document;
    });
    expect(await service.execute(plan.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Inbox source changed externally") });
    expect((await read(target.path)).content).toBe(target.content);
    expect((await read(source.path)).content).toBe("External edit during confirmation");
  });

  it("returns full checklist counts in read/list and updates them after a saved edit", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Projects"));
    const path = "Projects/progress.md";
    const before = '---\nstatus: Completed\n---\n# Project\n' + 'Long text\n'.repeat(40) + '\n- [x] Done\n- [ ] Pending\n';
    await writeFile(join(root, path), before);
    const document = await service.read(path);
    expect(document.tasks).toEqual({ completed: 1, total: 2 });
    expect((await service.list())[0].tasks).toEqual(document.tasks);
    expect(document.status).toBe("Completed");
    const plan = await service.planUpdate(path, document.version, before.replace('[ ]', '[x]'));
    expect((await service.execute(plan.id)).status).toBe("completed");
    expect((await service.read(path)).tasks).toEqual({ completed: 2, total: 2 });
    expect((await service.list())[0].tasks).toEqual({ completed: 2, total: 2 });
  });
  it("invalidates cancelled plans and pending previews after a service restart", async () => {
    const { root, service } = await fixture();
    const plan = await service.planDailyAppend("2099-10-10", "test entry");
    expect((await service.previewPlan(plan.id)).after).toContain("test entry");
    const restarted = new VaultService(root);
    await expect(restarted.previewPlan(plan.id)).rejects.toThrow("expired");
    await expect(restarted.execute(plan.id)).rejects.toThrow("another session");
    await service.cancelPlan(plan.id);
    await expect(service.previewPlan(plan.id)).rejects.toThrow("expired");
    await expect(service.execute(plan.id)).rejects.toThrow();
    expect(await service.list()).toEqual([]);
  });
  it("checks authorization again immediately before replacing the note", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Daily"));
    await writeFile(join(root, "Daily/2099-10-10.md"), "original");
    const plan = await service.planDailyAppend("2099-10-10", "test entry");
    let checks = 0;
    const result = await service.execute(plan.id, () => { if (++checks === 2) throw new Error("binding changed during preparation"); });
    expect(result).toMatchObject({ status: "failed", error: "binding changed during preparation" });
    expect(await readFile(join(root, plan.path), "utf8")).toBe("original");
    expect(await readdir(join(root, "Daily"))).toEqual(["2099-10-10.md"]);
  });
  it("changes only the project status token, preserves YAML and bytes, and restores the original", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Projects"));
    const before = '\uFEFF---\r\nid: legacy-id\r\nstatus: "Active" # keep comment\r\ncustom:\r\n  - {name: example, count: 2}\r\n---\r\n# Demo\r\nBody without final newline';
    await writeFile(join(root, "Projects", "demo.md"), before);
    const current = await service.read("Projects/demo.md");
    const plan = await service.planProjectStatus(current.path, current.version, "Paused");
    expect(plan.after).toBe(before.replace('"Active"', "Paused"));
    expect((await service.read(current.path)).content).toBe(before);
    expect(await service.execute(plan.id)).toMatchObject({ status: "completed" });
    expect((await service.list())[0].status).toBe("Paused");
    await service.activity();
    expect(await service.restore(plan.id)).toMatchObject({ status: "completed" });
    expect((await service.read(current.path)).content).toBe(before);
    await expect(service.planProjectStatus(current.path, "stale", "Completed")).rejects.toThrow("changed externally");
    await expect(service.planProjectStatus(current.path, current.version, "Deleted")).rejects.toThrow("Invalid project status");
    await expect(service.planProjectStatus("Inbox/demo.md", current.version, "Paused")).rejects.toThrow("projects folder");
  });

  it("adds a missing status without rewriting properties and rejects ambiguous YAML", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Projects"));
    for (const before of ["# Demo", "---\ncustom: [a, b]\n---\n# Demo", "\uFEFF# Demo\r\n"]) {
      await writeFile(join(root, "Projects", "demo.md"), before);
      const current = await service.read("Projects/demo.md");
      const plan = await service.planProjectStatus(current.path, current.version, "Active");
      expect(plan.after).toContain("status: Active");
      if (before.startsWith("---")) expect(plan.after).toBe(before.replace("---\n# Demo", "status: Active\n---\n# Demo"));
      else expect(plan.after).toBe(`${before.startsWith("\uFEFF") ? "\uFEFF" : ""}---${before.includes("\r\n") ? "\r\n" : "\n"}status: Active${before.includes("\r\n") ? "\r\n" : "\n"}---${before.includes("\r\n") ? "\r\n" : "\n"}${before.replace(/^\uFEFF/, "")}`);
    }
    for (const before of ["---\nstatus: Active\nstatus: Paused\n---\n# Demo", "---\nstatus: [Active]\n---\n", "---\nstatus: |\n  Active\n---\n", "---\nstatus: Active\n", "---\n<<: {status: Active}\n---\n"]) {
      await writeFile(join(root, "Projects", "demo.md"), before);
      const current = await service.read("Projects/demo.md");
      await expect(service.planProjectStatus(current.path, current.version, "Paused")).rejects.toThrow();
      expect((await service.read(current.path)).content).toBe(before);
    }
    await mkdir(join(root, "Projects", "Active"));
    await writeFile(join(root, "Projects", "Active", "legacy.md"), "# Legacy");
    const legacy = await service.read("Projects/Active/legacy.md");
    await expect(service.planProjectStatus(legacy.path, legacy.version, "Paused")).rejects.toThrow("directory");
  });

  it("creates a learning goal only after confirmation and refuses duplicate or externally created notes", async () => {
    const { root, service } = await fixture();
    const goal = { title: "掌握 TypeScript", purpose: "完成项目", background: "了解 JavaScript", outcome: "写一个应用", schedule: "每周两小时", targetDate: "2026-11-01", verification: "独立通过测试" };
    const plan = await service.planLearningGoal(goal);
    expect(await service.list()).toEqual([]);
    expect(plan).toMatchObject({ path: "Learning/掌握 TypeScript.md", create: true, before: "" });
    expect(plan.after).toContain("type: learning-goal");
    expect(plan.after).toContain("独立通过测试");
    expect(await service.execute(plan.id)).toMatchObject({ status: "completed" });
    expect(await service.execute(plan.id)).toMatchObject({ id: plan.id, status: "completed" });
    expect((await service.list())[0]).toMatchObject({ status: "Active", category: "learning" });
    await expect(service.planLearningGoal(goal)).rejects.toThrow("already exists");
    await expect(service.planLearningGoal({ ...goal, title: "../escape" })).rejects.toThrow();
    await expect(service.planLearningGoal({ ...goal, targetDate: "2026-02-30" })).rejects.toThrow("YYYY-MM-DD");
    await expect(service.planLearningGoal({ ...goal, verification: " " })).rejects.toThrow("required");
    const collision = await service.planLearningGoal({ ...goal, title: "External" });
    await writeFile(join(root, collision.path), "");
    expect(await service.execute(collision.id)).toMatchObject({ status: "failed", error: expect.stringContaining("created externally") });
    expect((await service.read(collision.path)).content).toBe("");
  });

  it("rejects missing and non-directory roots while accepting an empty existing directory", async () => {
    const { root, service } = await fixture();
    await expect(new VaultService(join(root, "missing")).list()).rejects.toThrow();
    await writeFile(join(root, "file.md"), "not a directory");
    await expect(new VaultService(join(root, "file.md")).list()).rejects.toThrow("non-directory");
    expect(await service.list()).toEqual([]);
    expect(await readdir(root)).toEqual(["file.md"]);
  });

  it("reads a mapped existing Vault without initializing or altering its files", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "旧知识库"));
    const content = '\uFEFF---\r\ncustom: [untouched, YAML]\r\n---\r\n# 原文\r\n正文\r\n';
    await writeFile(join(root, "旧知识库", "中文.md"), content);
    const service = new VaultService(root, { knowledge: "旧知识库" });
    expect(await service.list("正文")).toMatchObject([{ path: "旧知识库/中文.md", category: "knowledge", title: "原文" }]);
    expect((await service.read("旧知识库/中文.md")).content).toBe(content);
    expect(await readdir(root)).toEqual(["旧知识库"]);
    expect(await service.activity()).toEqual([]);
  });

  it("captures without overwrite, records activity, and initializes portable metadata", async () => {
    const { root, service } = await fixture();
    expect(await service.list()).toEqual([]);
    const note = await service.capture("第一条", "# 第一条\n原始内容\n");
    expect(note.path).toBe("Inbox/第一条.md");
    expect(note.version).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.capture("第一条", "replacement")).rejects.toThrow();
    expect((await service.read(note.path)).content).toBe(note.content);
    expect(await service.activity()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "capture", status: "completed" }),
      expect.objectContaining({ kind: "capture", status: "failed" }),
    ]));
    const metadata = JSON.parse(await readFile(join(root, ".ai-learning-os", "space.json"), "utf8"));
    expect(metadata).toMatchObject({ schemaVersion: 1, folderMap: { knowledge: "Wiki" } });
    expect(metadata).not.toHaveProperty("root");
  });

  it("refuses invalid UTF-8 instead of silently replacing bytes in existing notes", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Inbox"));
    const original = Buffer.from([0x23, 0x20, 0xff, 0xfe]);
    await writeFile(join(root, "Inbox", "legacy.md"), original);
    await expect(service.read("Inbox/legacy.md")).rejects.toThrow();
    expect(await readFile(join(root, "Inbox", "legacy.md"))).toEqual(original);
  });

  it("persists a preview, executes once, and restores the exact original bytes after restart", async () => {
    const { root, service } = await fixture();
    const before = '\uFEFF---\r\nunknown: "keep: this"\r\n---\r\n# 标题\r\n原文\r\n';
    const note = await service.capture("保真", before);
    const plan = await service.planUpdate(note.path, note.version, "# 标题\n新文\n");
    expect((await service.read(note.path)).content).toBe(before);
    expect(JSON.parse(await readFile(join(root, ".ai-learning-os", "plans", `${plan.id}.json`), "utf8"))).toEqual(plan);
    const [first, duplicate] = await Promise.all([service.execute(plan.id), service.execute(plan.id)]);
    expect(first).toMatchObject({ id: plan.id, kind: "update", status: "completed" });
    expect(duplicate).toEqual(first);
    const restarted = new VaultService(root);
    expect(await restarted.execute(plan.id)).toEqual(first);
    expect((await restarted.read(note.path)).content).toBe(plan.after);
    await expect(restarted.restore(first.id)).rejects.toThrow("Open the activity log");
    await restarted.activity();
    expect(await restarted.restore(first.id)).toMatchObject({ kind: "restore", status: "completed" });
    expect(await readFile(join(root, note.path), "utf8")).toBe(before);
    expect((await restarted.activity()).filter((entry) => entry.kind === "update")).toHaveLength(1);
  });

  it("previews and appends a Daily entry, creating the date note when needed", async () => {
    const { root, service } = await fixture();
    await expect(service.planDailyAppend("2026-02-30", "无效日期")).rejects.toThrow("YYYY-MM-DD");
    const first = await service.planDailyAppend("2026-09-30", "完成资料读写闭环");
    expect(first).toMatchObject({ path: "Daily/2026-09-30.md", create: true, before: "" });
    expect(await service.list()).toEqual([]);
    const created = await service.execute(first.id);
    expect(created).toMatchObject({ path: first.path, kind: "update", status: "completed" });
    expect((await service.read(first.path)).content).toBe("# 2026-09-30\n\n完成资料读写闭环\n");

    const current = await service.read(first.path);
    const second = await service.planDailyAppend("2026-09-30", "下一步补齐学习目标");
    expect(second.before).toBe(current.content);
    expect(await service.execute(second.id)).toMatchObject({ status: "completed" });
    expect((await service.read(first.path)).content).toContain("下一步补齐学习目标");
    expect(await service.execute(second.id)).toEqual(await service.execute(second.id));
    expect(await readdir(join(root, "Daily"))).toEqual(["2026-09-30.md"]);
  });

  it("previews project progress inside an existing Progress section", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Projects"));
    await writeFile(join(root, "Projects", "demo.md"), "# Demo\n\n## Progress\n\n已有进展\n\n## Logs\n\n旧日志\n");
    const current = await service.read("Projects/demo.md");
    const plan = await service.planProjectAppend(current.path, current.version, "完成第一轮验证");
    expect(plan.after).toContain("已有进展\n\n完成第一轮验证\n\n## Logs");
    expect(await service.read(current.path)).toMatchObject({ content: current.content, version: current.version });
    expect(await service.execute(plan.id)).toMatchObject({ status: "completed", path: current.path });
    expect((await service.read(current.path)).content).toContain("完成第一轮验证");
    await expect(service.planProjectAppend("Inbox/demo.md", current.version, "错误目录")).rejects.toThrow("projects folder");
    await expect(service.planProjectAppend(current.path, current.version, "")).rejects.toThrow("must not be empty");
    expect(await readFile(join(root, current.path), "utf8")).toContain("## Logs");
  });

  it("preserves project bytes around the insertion and ignores headings in fenced examples", async () => {
    const { root, service } = await fixture();
    await mkdir(join(root, "Projects"));
    const before = '\uFEFF---\r\ncustom: "keep: this"\r\n---\r\n# 项目\r\n\r\n```md\r\n## Progress\r\n```\r\n\r\n## Progress\r\n\r\n旧记录\r\n\r\n## Logs\r\n保留尾部\r\n\r\n';
    await writeFile(join(root, "Projects", "existing.md"), before);
    const current = await service.read("Projects/existing.md");
    const plan = await service.planProjectAppend(current.path, current.version, "新增记录");
    expect(plan.after).toBe(before.replace("## Logs\r\n", "新增记录\r\n\r\n## Logs\r\n"));
    await writeFile(join(root, current.path), "外部修改");
    expect(await service.execute(plan.id)).toMatchObject({ status: "failed" });
    expect((await service.read(current.path)).content).toBe("外部修改");

    await writeFile(join(root, "Projects", "new-section.md"), "# 项目\n\n目标\n");
    const other = await service.read("Projects/new-section.md");
    const added = await service.planProjectAppend(other.path, other.version, "首条进展");
    expect(added.after).toBe("# 项目\n\n目标\n\n## Progress\n\n首条进展\n");
  });

  it("requires a fresh preview for imported plans and rejects changes after preview", async () => {
    const { root, service } = await fixture();
    const note = await service.capture("审批", "original");
    const plan = await service.planUpdate(note.path, note.version, "approved preview");
    const restarted = new VaultService(root);
    await expect(restarted.execute(plan.id)).rejects.toThrow("preview a new plan");
    const planPath = join(root, ".ai-learning-os", "plans", `${plan.id}.json`);
    await writeFile(planPath, JSON.stringify({ ...plan, after: "tampered after preview" }));
    await expect(service.execute(plan.id)).rejects.toThrow("preview a new plan");
    expect((await service.read(note.path)).content).toBe("original");
    const refreshed = await restarted.planUpdate(note.path, note.version, "fresh preview");
    expect(await restarted.execute(refreshed.id)).toMatchObject({ status: "completed" });
  });

  it("rejects stale edits both before planning and after confirmation", async () => {
    const { root, service } = await fixture();
    const note = await service.capture("冲突", "original");
    const plan = await service.planUpdate(note.path, note.version, "planned");
    await writeFile(join(root, note.path), "external change");
    await expect(service.planUpdate(note.path, note.version, "stale")).rejects.toThrow("changed externally");
    const result = await service.execute(plan.id);
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("changed externally") });
    expect(await service.execute(plan.id)).toEqual(result);
    expect((await service.read(note.path)).content).toBe("external change");
  });

  it("does not restore over later manual changes and verifies backup integrity", async () => {
    const { root, service } = await fixture();
    const note = await service.capture("恢复", "original");
    const plan = await service.planUpdate(note.path, note.version, "updated");
    await service.execute(plan.id);
    await service.activity();
    await writeFile(join(root, note.path), "manual");
    expect(await service.restore(plan.id)).toMatchObject({ status: "failed" });
    expect((await service.read(note.path)).content).toBe("manual");
    await writeFile(join(root, ".ai-learning-os", "backups", `${plan.id}.md`), "corrupted");
    await expect(service.restore(plan.id)).rejects.toThrow("integrity");
  });

  it("binds restore confirmation to the displayed record and backup", async () => {
    const { root, service } = await fixture();
    const note = await service.capture("已确认", "original");
    const other = await service.capture("不应修改", "keep untouched");
    const plan = await service.planUpdate(note.path, note.version, "updated");
    await service.execute(plan.id);
    await service.activity();
    const recordPath = join(root, ".ai-learning-os", "activity", `${plan.id}.json`);
    const raw = await readFile(recordPath, "utf8");
    const record = JSON.parse(raw);
    record.result.path = other.path;
    record.after = other.version;
    await writeFile(recordPath, JSON.stringify(record));
    await expect(service.activity()).rejects.toThrow("changed externally");
    await expect(service.restore(plan.id)).rejects.toThrow("Restore record changed");
    expect((await service.read(other.path)).content).toBe("keep untouched");
    await writeFile(recordPath, raw);
    await writeFile(join(root, ".ai-learning-os", "backups", `${plan.id}.md`), "tampered backup");
    await expect(service.restore(plan.id)).rejects.toThrow("integrity");
    expect((await service.read(note.path)).content).toBe("updated");
  });

  it.each(["../outside.md", "Inbox/../../outside.md", "C:/outside.md", "Inbox\\outside.md", ".ai-learning-os/space.md",
    "Inbox/.obsidian/config.md", "Inbox/CON.md", "Inbox/COM1.md", "Inbox/invalid .md/child.md", "Inbox/bad.md:stream", "Inbox/note.txt", "Other/note.md"])(
    "rejects unsafe or unmapped paths: %s", async (path) => {
      const { service } = await fixture();
      await expect(service.read(path)).rejects.toThrow();
    });

  it("rejects unsafe names and overlapping folder mappings before writing", async () => {
    const { root, service } = await fixture();
    for (const title of ["../evil", "CON", "NUL.txt", "bad/name", "bad\\name", ".private", ""]) {
      await expect(service.capture(title, "content")).rejects.toThrow();
    }
    expect(() => new VaultService(root, { inbox: "../outside" })).toThrow();
    expect(() => new VaultService(root, { knowledge: "inbox/Nested" })).toThrow("overlap");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects linked folders, linked roots, and linked control directories", async () => {
    const { root, service } = await fixture();
    const external = await fixture();
    await writeFile(join(external.root, "outside.md"), "private");
    // Windows junctions need no symlink privilege and are reported as symbolic links.
    await symlink(external.root, join(root, "Inbox"), "junction");
    await expect(service.list()).rejects.toThrow("link");
    await expect(service.read("Inbox/outside.md")).rejects.toThrow("link");
    await expect(service.capture("blocked", "content")).rejects.toThrow("link");
    await expect(new VaultService(join(root, "Inbox")).list()).rejects.toThrow("link");
    const controlled = await fixture();
    await symlink(external.root, join(controlled.root, ".ai-learning-os"), "junction");
    await expect(controlled.service.capture("blocked", "content")).rejects.toThrow("link");
    expect(await readdir(external.root)).toEqual(["outside.md"]);
  });

  it("refuses automatic replay of interrupted writes and exposes their recovery status", async () => {
    const { root, service } = await fixture();
    const note = await service.capture("中断", "original");
    const plan = await service.planUpdate(note.path, note.version, "updated");
    await writeFile(join(root, ".ai-learning-os", "activity", `${plan.id}.json`), JSON.stringify({
      state: "executing", before: note.version, after: "unknown", result: {
        id: plan.id, path: note.path, kind: "update", status: "failed", at: new Date().toISOString(),
      },
    }));
    await expect(new VaultService(root).execute(plan.id)).rejects.toThrow("manual review");
    expect(await service.activity()).toContainEqual(expect.objectContaining({ id: plan.id, error: expect.stringContaining("Interrupted") }));
    expect((await service.read(note.path)).content).toBe("original");
  });
});
