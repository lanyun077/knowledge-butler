import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureLibrary, librarySettings } from "../src/knowledge-library";
import { loadKnowledgeConfig } from "../src/knowledge-config";
import { startKnowledgeService } from "../src/knowledge-service";
import { sharedVault } from "../src/knowledge-client";
import { defaultFolderMap } from "../src/vault";

const roots: string[] = [], services: Awaited<ReturnType<typeof startKnowledgeService>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "knowledge-setup-")); roots.push(root);
  return { root, config: join(root, "runtime", "connection.json"), folders: { ...defaultFolderMap } };
}

it("creates a clean framework, persists its connection and can save using the normal shared writer", async () => {
  const f = await fixture();
  expect(await librarySettings(f.config)).toEqual({ directory: "", folders: f.folders });
  const result = await configureLibrary(f.config, { mode: "create", directory: f.root, name: "我的知识库" });
  expect(result).toMatchObject({ backup: null, restartRequired: true });
  expect(await readdir(result.directory)).toEqual(expect.arrayContaining([".obsidian", ...Object.values(f.folders)]));
  for (const folder of Object.values(f.folders)) expect(await readdir(join(result.directory, folder))).toEqual([]);
  const config = await loadKnowledgeConfig(f.config);
  expect(config.vaultRoot).toBe(result.directory); expect(config.token).toMatch(/^[0-9a-f]{64}$/); expect(config.projects).toEqual([]);
  services.push(await startKnowledgeService(config));
  const client = sharedVault(f.config, { root: config.vaultRoot, folders: config.folders });
  const saved = await client.capture("first", "# 我的第一份材料\n来自本次明确保存。");
  expect(saved.path).toMatch(/^Inbox\//);
  expect((await client.read(saved.path)).content).toContain("我的第一份材料");
});

it("connects an existing Vault with custom mappings without changing notes or importing unmapped content", async () => {
  const f = await fixture(), vault = join(f.root, "existing");
  await mkdir(join(vault, "旧知识"), { recursive: true });
  const before = '\uFEFF---\r\ncustom: "保留"\r\n---\r\n# 旧笔记\r\n正文\r\n';
  await writeFile(join(vault, "旧知识", "old.md"), before);
  await writeFile(join(vault, "根目录笔记.md"), "# 不自动纳入");
  const folders = { ...f.folders, knowledge: "旧知识", inbox: "收集/材料" };
  await configureLibrary(f.config, { mode: "existing", directory: vault, folders });
  expect(await readFile(join(vault, "旧知识", "old.md"), "utf8")).toBe(before);
  expect(await librarySettings(f.config)).toEqual({ directory: (await loadKnowledgeConfig(f.config)).vaultRoot, folders });
  await configureLibrary(f.config, { mode: "existing", directory: vault });
  expect((await loadKnowledgeConfig(f.config)).folders).toEqual(folders);
  const config = await loadKnowledgeConfig(f.config); services.push(await startKnowledgeService(config));
  const client = sharedVault(f.config, { root: config.vaultRoot, folders });
  expect((await client.list()).map(note => note.path)).toContain("旧知识/old.md");
  await expect(client.read("根目录笔记.md")).rejects.toThrow();
});

it("uses default folders when switching libraries without carrying over the old mappings", async () => {
  const f = await fixture(), first = join(f.root, "first"), second = join(f.root, "second");
  await mkdir(first); await mkdir(second);
  await configureLibrary(f.config, { mode: "existing", directory: first, folders: { ...f.folders, knowledge: "旧知识" } });
  await writeFile(join(second, "原有笔记.md"), "# 保留原位置");
  await configureLibrary(f.config, { mode: "existing", directory: second });
  expect((await loadKnowledgeConfig(f.config)).folders).toEqual(f.folders);
  expect(await readFile(join(second, "原有笔记.md"), "utf8")).toBe("# 保留原位置");
  expect(await readdir(second)).not.toContain("旧知识");
});

it("stops the old writer, backs up its exact config, and switches the normal client to the new library", async () => {
  const f = await fixture();
  const first = await configureLibrary(f.config, { mode: "create", directory: f.root, name: "first", folders: f.folders });
  const oldText = await readFile(f.config, "utf8"), old = await loadKnowledgeConfig(f.config);
  const service = await startKnowledgeService(old); services.push(service);
  const second = await configureLibrary(f.config, { mode: "create", directory: f.root, name: "second", folders: f.folders });
  await service.done;
  expect(service.status().stopping).toBe(true);
  expect(await readFile(second.backup!, "utf8")).toBe(oldText);
  const next = await loadKnowledgeConfig(f.config);
  expect(next.token).not.toBe(old.token); expect(next.vaultId).not.toBe(old.vaultId);
  expect(await readdir(first.directory)).toContain("Inbox");
  services.push(await startKnowledgeService(next));
  const client = sharedVault(f.config, { root: next.vaultRoot, folders: next.folders });
  expect(await client.status()).toMatchObject({ vaultId: next.vaultId });
});

it("keeps credentials and project bindings when reconnecting the same library", async () => {
  const f = await fixture();
  const first = await configureLibrary(f.config, { mode: "create", directory: f.root, name: "same", folders: f.folders });
  const raw = JSON.parse(await readFile(f.config, "utf8"));
  await writeFile(join(first.directory, "Projects", "bound.md"), "# 项目");
  raw.projects = [{ directory: f.root, projectPath: "Projects/bound.md" }];
  await writeFile(f.config, JSON.stringify(raw));
  await configureLibrary(f.config, { mode: "existing", directory: first.directory, folders: f.folders });
  const saved = JSON.parse(await readFile(f.config, "utf8"));
  expect(saved.token).toBe(raw.token); expect(saved.projects).toEqual(raw.projects);
  await expect(configureLibrary(f.config, { mode: "existing", directory: first.directory, folders: { ...f.folders, projects: "Other" } })).rejects.toThrow("项目绑定");
});

it("rejects an existing creation target and invalid mappings before changing any config or files", async () => {
  const f = await fixture(), target = join(f.root, "existing"); await mkdir(target);
  await writeFile(join(target, "keep.md"), "keep");
  await expect(configureLibrary(f.config, { mode: "create", directory: f.root, name: "existing", folders: f.folders })).rejects.toThrow("已存在");
  for (const name of ["../outside", "CON", "bad.", " "]) {
    await expect(configureLibrary(f.config, { mode: "create", directory: f.root, name, folders: f.folders })).rejects.toThrow();
  }
  for (const knowledge of ["../outside", "Inbox", "Inbox/nested", ".obsidian", ""]) {
    await expect(configureLibrary(f.config, { mode: "existing", directory: target, folders: { ...f.folders, knowledge } })).rejects.toThrow();
  }
  expect(await readdir(target)).toEqual(["keep.md"]);
  await expect(readFile(f.config)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects symlinked mapped folders and keeps both libraries intact when another service owns the target", async () => {
  const f = await fixture(), target = join(f.root, "target"), elsewhere = join(f.root, "elsewhere");
  await mkdir(target); await mkdir(elsewhere);
  await symlink(elsewhere, join(target, "Wiki"), process.platform === "win32" ? "junction" : "dir");
  await expect(configureLibrary(f.config, { mode: "existing", directory: target, folders: f.folders })).rejects.toThrow("链接");
  expect(await readdir(elsewhere)).toEqual([]);
  const separate = join(f.root, "separate.json");
  const owned = await configureLibrary(separate, { mode: "create", directory: f.root, name: "owned", folders: f.folders });
  services.push(await startKnowledgeService(await loadKnowledgeConfig(separate)));
  const old = await configureLibrary(f.config, { mode: "create", directory: f.root, name: "old", folders: f.folders });
  const before = await readFile(f.config, "utf8");
  await expect(configureLibrary(f.config, { mode: "existing", directory: owned.directory, folders: f.folders })).rejects.toThrow("服务");
  expect(await readFile(f.config, "utf8")).toBe(before);
  expect(await readdir(old.directory)).toContain("Wiki");
});

it("rejects an invalid config destination and can replace a removed old Vault", async () => {
  const f = await fixture();
  await mkdir(f.config, { recursive: true });
  // An invalid destination must not create the requested new library.
  await expect(configureLibrary(f.config, { mode: "create", directory: f.root, name: "failed", folders: f.folders })).rejects.toThrow();
  expect(await readdir(f.root)).not.toContain("failed");
  const configFile = join(f.root, "removed.json");
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, vaultRoot: join(f.root, "gone"), token: "a".repeat(64) }));
  const result = await configureLibrary(configFile, { mode: "create", directory: f.root, name: "replacement", folders: f.folders });
  expect((await loadKnowledgeConfig(configFile)).vaultRoot).toBe(result.directory);
  expect(JSON.parse(await readFile(result.backup!, "utf8")).vaultRoot).toBe(join(f.root, "gone"));
});

it("preserves concurrent config changes and removes only empty folders after an interrupted switch", async () => {
  const f = await fixture();
  await configureLibrary(f.config, { mode: "create", directory: f.root, name: "first", folders: f.folders });
  const config = await loadKnowledgeConfig(f.config); services.push(await startKnowledgeService(config));
  const fetch = globalThis.fetch, concurrent = JSON.parse(await readFile(f.config, "utf8"));
  concurrent.token = "b".repeat(64);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const result = await fetch(...args);
    if (String(args[0]) === `${config.url}/stop`) {
      await writeFile(f.config, JSON.stringify(concurrent));
      await writeFile(join(f.root, "interrupted", "external.md"), "外部新文件必须保留");
    }
    return result;
  });
  await expect(configureLibrary(f.config, { mode: "create", directory: f.root, name: "interrupted", folders: f.folders })).rejects.toThrow("其他窗口");
  expect(JSON.parse(await readFile(f.config, "utf8"))).toEqual(concurrent);
  expect(await readdir(join(f.root, "interrupted"))).toEqual(["external.md"]);
  expect((await readdir(join(f.root, "runtime"))).filter(file => file.endsWith(".tmp"))).toEqual([]);
});
