import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeProjects, projectContext } from "../src/knowledge-projects";
import { loadKnowledgeConfig } from "../src/knowledge-config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it("matches the configured directory alias and real path without resolving unconfigured hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-binding-")); roots.push(root);
  const target = join(root, "project"), alias = join(root, "configured"), other = join(root, "unconfigured");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await symlink(target, other, process.platform === "win32" ? "junction" : "dir");
  const input = { directory: alias, projectPath: "Projects/one.md", sourceRoot: target };
  const projects = await normalizeProjects([input]);
  expect(projectContext(projects, alias)).toMatchObject({ bound: true, projectPath: input.projectPath, fileSubmission: true });
  expect(projectContext(projects, await realpath(target))).toMatchObject({ bound: true, projectPath: input.projectPath });
  expect(projectContext(projects, other)).toEqual({ bound: false, fileSubmission: false });
  await expect(normalizeProjects([input, { ...input, directory: target }])).rejects.toThrow("Duplicate project directory");
});

it("keeps stable service ports below Windows' default dynamic range", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-port-")); roots.push(root);
  const base = await realpath(root);
  const vault = Array.from({ length: 1000 }, (_, index) => join(base, `vault-${index}`)).find(path => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    return 20000 + parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 30000 >= 49152;
  })!;
  expect(vault).toBeDefined(); await mkdir(vault);
  const configFile = join(root, "connection.json");
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, vaultRoot: vault, token: "a".repeat(64) }));
  const config = await loadKnowledgeConfig(configFile);
  expect(config.port).toBeLessThan(49152);
  expect((await loadKnowledgeConfig(configFile)).port).toBe(config.port);
});
