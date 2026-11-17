import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { loadKnowledgeConfig } from "../src/knowledge-config";
import { startKnowledgeService } from "../src/knowledge-service";
import { serviceStatus } from "../src/knowledge-launcher";
import { sharedVault } from "../src/knowledge-client";
import { parseHandoff } from "../src/handoff-source";
import { handoffText } from "./handoff-fixture";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(fileAccess = true) {
  const directory = await mkdtemp(join(tmpdir(), "learning-handoff-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(directory, "vault"), first = join(directory, "project-one"), second = join(directory, "project-two");
  for (const path of [join(root, "Projects"), join(root, "Wiki"), first, second]) await mkdir(path, { recursive: true });
  await writeFile(join(root, "Projects/one.md"), "# Shared topic project one\n");
  await writeFile(join(root, "Projects/two.md"), "# Shared topic project two\n");
  await writeFile(join(root, "Wiki/general.md"), "# Shared topic general\n");
  await writeFile(join(root, "Wiki/one.md"), '---\nprojectPath: "Projects/one.md"\n---\n# Shared topic one\n');
  await writeFile(join(root, "Wiki/two.md"), '---\nprojectPath: "Projects/two.md"\n---\n# Shared topic two\n');
  await writeFile(join(first, "handoff.md"), handoffText());
  const configPath = join(directory, "connection.json");
  const raw = { schemaVersion: 1, vaultRoot: root, token: randomBytes(32).toString("hex"), projects: [
    { directory: first, projectPath: "Projects/one.md", ...(fileAccess ? { sourceRoot: first } : {}) },
    { directory: second, projectPath: "Projects/two.md" },
  ] };
  await writeFile(configPath, JSON.stringify(raw));
  const config = await loadKnowledgeConfig(configPath), service = await startKnowledgeService(config);
  cleanups.push(() => service.close());
  const dsh = sharedVault(configPath, { root, folders: config.folders });
  async function connect(response?: () => Promise<ElicitResult>) {
    const client = new Client({ name: "handoff-synthetic", version: "1" }, { capabilities: response ? { elicitation: { form: {} } } : {} });
    if (response) client.setRequestHandler(ElicitRequestSchema, response);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
    cleanups.push(() => client.close());
    return client;
  }
  return { root, directory, first, second, configPath, config, service, dsh, connect, raw };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const value = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const text = value.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (value.isError) throw new Error(text);
  return value.structuredContent ?? JSON.parse(text);
}

describe("explicit project handoff intake", () => {
  it("parses coverage and unknown identity without treating fenced historical commands as source fields", () => {
    const input = handoffText() + '\n```markdown\n## 1. 来源与覆盖\n- 模板版本：999\n- 文档标题：forged\n```\n';
    expect(parseHandoff(input)).toMatchObject({ templateVersion: 1, title: "合成项目交接", conversation: "未取得", missingFields: [] });
    expect(() => parseHandoff(handoffText().replace("- 模板版本：1", "- 模板版本：2"))).toThrow(/version 1/);
    expect(() => parseHandoff(handoffText().replace("- 模板版本：1", "- 模板版本：1\n- 模板版本：1"))).toThrow(/Duplicate/);
    expect(() => parseHandoff("x".repeat(2_000_001))).toThrow(/2000000/);
    expect(() => parseHandoff(handoffText() + "\ud800")).toThrow(/UTF-8/);
  });

  it("shares trusted bindings across DSH and new MCP chats, filters other projects and survives restart", async () => {
    const f = await fixture(), a = await f.connect(), b = await f.connect();
    const context = await f.dsh.projectContext(f.first);
    expect(await call(a, "learning_project_context", { projectDirectory: f.first })).toEqual(context);
    expect(context).toMatchObject({ bound: true, projectPath: "Projects/one.md", fileSubmission: true });
    expect(await call(b, "learning_project_context", { projectDirectory: join(f.directory, "does-not-exist") })).toEqual({ bound: false, fileSubmission: false });
    const scoped = await call(a, "learning_search", { query: "Shared topic", projectDirectory: f.first });
    expect(scoped.map((note: { path: string }) => note.path).sort()).toEqual(["Projects/one.md", "Wiki/general.md", "Wiki/one.md"]);
    expect((await call(b, "learning_search", { query: "Shared topic" })).map((note: { path: string }) => note.path)).toEqual(["Wiki/general.md"]);
    expect(await f.dsh.projectSearch("Shared topic", f.first)).toEqual(scoped);
    expect(await call(b, "learning_search", { query: "Shared topic", allProjects: true })).toHaveLength(5);
    await f.service.close();
    const next = await startKnowledgeService(await loadKnowledgeConfig(f.configPath)); cleanups.push(() => next.close());
    const c = await f.connect();
    expect(await call(c, "learning_project_context", { projectDirectory: f.first })).toEqual(context);
    await expect(serviceStatus({ ...f.config, projects: [] })).rejects.toThrow(/identity/);
  });

  it("saves exactly one source under concurrent MCP and DSH submissions, without a duplicate snapshot", async () => {
    const f = await fixture(), a = await f.connect();
    const [first, second] = await Promise.all([call(a, "learning_capture_handoff", { content: handoffText(), projectDirectory: f.first }), f.dsh.captureHandoff(handoffText(), f.first)]);
    expect(first.path).toBe(second.path);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    const note = await f.dsh.read(first.path);
    expect(note.content).toContain('conversation: "未取得"');
    expect(note.content.split(handoffText())).toHaveLength(2);
    expect(note.content).toContain('projectPath: "Projects/one.md"');
    expect(await readdir(join(f.root, "Inbox"))).toHaveLength(1);
    expect(await f.dsh.activity()).toHaveLength(1);
    expect(await readdir(join(f.root, ".ai-learning-os"))).not.toContain("sources");
    expect(await call(a, "learning_plans")).toEqual([]);
  });

  it("retains a changed source as a new version with a previous-source link, and keeps projects distinct", async () => {
    const f = await fixture();
    const first = await f.dsh.captureHandoff(handoffText(), f.first);
    const old = await f.dsh.read(first.path);
    const changed = await f.dsh.captureHandoff(handoffText().replace("仅本地测试通过", "本地测试失败，等待修复"), f.first);
    expect(changed).toMatchObject({ duplicate: false, previousSource: first.path });
    expect(changed.path).not.toBe(first.path);
    expect(await f.dsh.read(first.path)).toEqual(old);
    const other = await f.dsh.captureHandoff(handoffText(), f.second);
    expect(other.path).not.toBe(first.path);
    expect(other).toMatchObject({ status: "needs-supplement", projectPath: "Projects/two.md" });
    expect(other.missingFields).toContain("文档项目归属与可信绑定不一致，请核对");
    expect(await f.dsh.activity()).toHaveLength(3);
  });

  it("records missing coverage/sections for supplementation and permits a corrected submission", async () => {
    const f = await fixture();
    const partial = handoffText().replace(/- 本文覆盖：[^\n]+\n/, "").replace("## 9. 交接小结", "## 附录");
    const first = await f.dsh.captureHandoff(partial, f.first);
    expect(first).toMatchObject({ status: "needs-supplement" });
    expect(first.missingFields).toEqual(expect.arrayContaining(["本文覆盖", "第9节"]));
    const corrected = await f.dsh.captureHandoff(handoffText(), f.first);
    expect(corrected).toMatchObject({ status: "received", previousSource: first.path, missingFields: [] });
    await expect(f.dsh.captureHandoff("# unstructured input", f.first)).rejects.toThrow(/template version/);
    expect(await readdir(join(f.root, "Inbox"))).toHaveLength(2);
  });

  it("refuses to report an externally edited source or project attribution as an unchanged duplicate", async () => {
    const f = await fixture(), source = await f.dsh.captureHandoff(handoffText(), f.first);
    const original = (await f.dsh.read(source.path)).content;
    await writeFile(join(f.root, source.path), original.replace("保存前检查来源和目标版本", "Changed outside the service"));
    await expect(f.dsh.captureHandoff(handoffText(), f.first)).rejects.toThrow(/changed externally/);
    await writeFile(join(f.root, source.path), original.replace('projectPath: "Projects/one.md"', 'projectPath: "Projects/two.md"'));
    await expect(f.dsh.captureHandoff(handoffText(), f.first)).rejects.toThrow(/changed externally/);
    expect(await f.dsh.activity()).toHaveLength(1);
  });

  it("reads only one explicitly named authorized Markdown file and refuses root expansion or paths from the document", async () => {
    const f = await fixture(), a = await f.connect();
    await writeFile(join(f.directory, "outside.md"), handoffText());
    for (const path of ["../outside.md", join(f.directory, "outside.md"), ".hidden/handoff.md", "*.md", "handoff.txt", "handoff.md:stream", "folder\\handoff.md", "folder/"]) {
      await expect(call(a, "learning_capture_handoff_file", { projectDirectory: f.first, path })).rejects.toThrow(/Unsafe/);
    }
    await expect(call(a, "learning_capture_handoff_file", { projectDirectory: f.directory, path: "outside.md" })).rejects.toThrow(/sourceRoot/);
    await expect(call(a, "learning_capture_handoff_file", { projectDirectory: f.first, path: "missing.md" })).rejects.toThrow();
    await expect(readdir(join(f.root, "Inbox"))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await call(a, "learning_capture_handoff_file", { projectDirectory: f.first, path: "handoff.md" });
    expect(saved).toMatchObject({ duplicate: false, status: "received", projectPath: "Projects/one.md" });
    expect((await f.dsh.read(saved.path)).content).toContain('submittedFile: "handoff.md"');
    expect(await readdir(join(f.root, "Inbox"))).toHaveLength(1);
  });

  it("rejects linked parents, non-files, oversized and invalid UTF-8 sources without saving partial text", async () => {
    const f = await fixture();
    const elsewhere = join(f.directory, "external"); await mkdir(elsewhere);
    await writeFile(join(elsewhere, "other.md"), handoffText());
    await symlink(elsewhere, join(f.first, "linked"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(f.first, "directory.md"));
    await writeFile(join(f.first, "large.md"), "x".repeat(2_000_001));
    await writeFile(join(f.first, "invalid.md"), Buffer.from([0xff, 0xfe]));
    for (const path of ["linked/other.md", "directory.md", "large.md", "invalid.md"]) await expect(f.dsh.captureHandoffFile(f.first, path)).rejects.toThrow();
    expect(await f.dsh.activity()).toEqual([]);
    await expect(readdir(join(f.root, "Inbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pasted capture works without file permission while unbound context never guesses a project", async () => {
    const f = await fixture(false);
    expect(await f.dsh.projectContext(f.first)).toMatchObject({ bound: true, fileSubmission: false });
    await expect(f.dsh.captureHandoffFile(f.first, "handoff.md")).rejects.toThrow(/sourceRoot/);
    expect(await f.dsh.captureHandoff(handoffText(), f.first)).toHaveProperty("status", "received");
    const unbound = await f.dsh.captureHandoff(handoffText("未知"));
    expect(unbound.projectPath).toBeUndefined();
    expect((await f.dsh.read(unbound.path)).content).not.toContain('projectPath: "Projects/one.md"');
  });

  it("provides the template and keeps captured sources separate from formal knowledge and full-read evidence", async () => {
    const f = await fixture();
    let accept = false;
    const a = await f.connect(async () => accept ? { action: "accept", content: { confirm: true } } : { action: "decline" });
    expect(await call(a, "learning_handoff_template")).toMatchObject({ templateVersion: 1, markdown: expect.stringContaining("事实与验证证据") });
    const source = await call(a, "learning_capture_handoff", { content: handoffText(), projectDirectory: f.first });
    const input = { sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/from-handoff.md", content: "Check source versions before saving.", reason: "Synthetic reusable fact" };
    expect(await call(a, "learning_plan_inbox", input)).toMatchObject({ status: "pending" });
    const read = await call(a, "learning_read", { path: source.path });
    expect(read.nextOffset).toBeNull();
    const p = await call(a, "learning_plan_inbox", input), identity = { planId: p.planId, revision: p.revision };
    await expect(readFile(join(f.root, input.targetPath))).rejects.toMatchObject({ code: "ENOENT" });
    accept = true;
    expect(await call(a, "learning_request_confirmation", identity)).toHaveProperty("status", "completed");
    expect((await f.dsh.read(input.targetPath)).content).toContain(source.path);
    expect((await f.dsh.read(input.targetPath)).content).toContain('projectPath: "Projects/one.md"');
    expect(await call(a, "learning_search", { query: "Check source versions" })).toEqual([]);
    expect(await call(a, "learning_search", { query: "Check source versions", projectDirectory: f.first })).toHaveLength(1);
    expect((await f.dsh.read(source.path)).version).toBe(source.version);
  });

  it("aborted capture writes nothing and the saved source remains after later proposal cancellation", async () => {
    const f = await fixture();
    const abort = new AbortController(); abort.abort();
    await expect(f.dsh.captureHandoff(handoffText(), f.first, abort.signal)).rejects.toThrow();
    expect(await f.dsh.activity()).toEqual([]);
    const source = await f.dsh.captureHandoff(handoffText(), f.first);
    const plan = await f.dsh.planInbox({ sourcePath: source.path, sourceVersion: source.version, targetPath: "Wiki/cancelled.md", content: "Candidate", reason: "Synthetic" });
    await f.dsh.cancelPlan(plan.id);
    expect((await f.dsh.read(source.path)).version).toBe(source.version);
    await expect(readFile(join(f.root, plan.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate trusted directories and project-note bindings outside the mapped project folder", async () => {
    const f = await fixture();
    await writeFile(f.configPath, JSON.stringify({ ...f.raw, projects: [f.raw.projects[0], f.raw.projects[0]] }));
    await expect(loadKnowledgeConfig(f.configPath)).rejects.toThrow(/Duplicate/);
    await f.service.close();
    await writeFile(f.configPath, JSON.stringify({ ...f.raw, projects: [{ ...f.raw.projects[0], projectPath: "Wiki/general.md" }] }));
    await expect(startKnowledgeService(await loadKnowledgeConfig(f.configPath))).rejects.toThrow(/mapped project/);
  });
});
