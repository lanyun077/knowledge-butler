import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { z } from "zod";
import { knowledgeConfigSchema, loadKnowledgeConfig, type KnowledgeConfig } from "./knowledge-config";
import { serviceStatus } from "./knowledge-service-status";
import { defaultFolderMap, VaultService } from "./vault";

const inputSchema = z.object({ mode: z.enum(["existing", "create"]), directory: z.string().refine(isAbsolute, "请选择知识库文件夹"),
  name: z.string().optional(), folders: knowledgeConfigSchema.shape.folders.removeDefault().optional() });
export type LibraryInput = z.infer<typeof inputSchema>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function current(path: string) {
  try { const text = await readFile(path, "utf8"); return { text, config: knowledgeConfigSchema.parse(JSON.parse(text)) }; }
  catch (error) { if (missing(error)) return; throw error; }
}

export async function librarySettings(path: string) {
  const previous = await current(path);
  return { directory: previous?.config.vaultRoot ?? "", folders: previous?.config.folders ?? defaultFolderMap };
}

// Match the writer's directory boundary, without scanning note contents during setup.
async function checkDirectories(path: string, allowMissing = false) {
  let cursor = parse(path).root;
  for (const part of relative(cursor, path).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`请选择普通文件夹，不能使用链接或文件：${cursor}`);
    } catch (error) { if (allowMissing && missing(error)) return; throw error; }
  }
}

async function running(config: KnowledgeConfig) {
  try { await serviceStatus(config); return true; }
  catch (error) {
    if (error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED") return false;
    throw new Error("无法核对已有知识库服务，请关闭旧连接后重试。", { cause: error });
  }
}

/** Local setup only; never exposed as a model tool or an unauthenticated web route. */
export async function configureLibrary(configFile: string, raw: LibraryInput) {
  if (!isAbsolute(configFile)) throw new Error("连接配置必须使用绝对路径");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const input = parsed.data, previous = await current(configFile);
  const directory = resolve(input.directory);
  await checkDirectories(directory);
  if (input.mode === "create" && (!input.name || input.name !== input.name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(input.name)
    || /^[.]/.test(input.name) || /[. ]$/.test(input.name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(input.name))) {
    throw new Error("请填写有效的知识库名称，不含路径、保留名称或末尾空格");
  }
  const root = input.mode === "create" ? join(await realpath(directory), input.name!) : await realpath(directory);
  if (input.mode === "create") {
    try { await lstat(root); throw new Error("此名称的文件夹已存在，请换名或选择接入已有知识库"); }
    catch (error) { if (!missing(error)) throw error; }
  }
  let old: KnowledgeConfig | undefined;
  if (previous) {
    // A removed old Vault must not prevent selecting its replacement.
    let exists = true;
    try { await lstat(previous.config.vaultRoot); } catch (error) { if (missing(error)) exists = false; else throw error; }
    if (exists) old = await loadKnowledgeConfig(configFile);
  }
  const same = !!old && samePath(root, old.vaultRoot);
  const folders = input.mode === "create" ? { ...defaultFolderMap } : input.folders ?? (same ? old!.folders : { ...defaultFolderMap });
  try { new VaultService(root, folders); } // Reuse path, overlap and reserved-name validation.
  catch { throw new Error("资料目录须为知识库内不同的子目录，不能重叠或使用特殊路径"); }
  for (const folder of Object.values(folders)) await checkDirectories(join(root, ...folder.split("/")), true);
  if (same && previous!.config.projects.length && folders.projects !== old!.folders.projects) {
    throw new Error("已有项目绑定使用当前项目目录，请保留项目目录映射后再接入");
  }
  const value = knowledgeConfigSchema.parse({ schemaVersion: 1, vaultRoot: root, folders,
    token: same ? previous!.config.token : randomBytes(32).toString("hex"), projects: same ? previous!.config.projects : [] });
  const created: string[] = [], temp = `${configFile}.${randomUUID()}.tmp`;
  let saved = false;
  async function createDirectory(path: string) {
    const parts: string[] = []; let cursor = path;
    while (!samePath(cursor, root)) { parts.unshift(cursor); cursor = dirname(cursor); }
    for (const part of parts) {
      try { await mkdir(part); created.push(part); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await checkDirectories(part); }
    }
  }
  try {
    if (input.mode === "create") { await mkdir(root); created.push(root); }
    for (const folder of Object.values(folders)) await createDirectory(join(root, ...folder.split("/")));
    if (input.mode === "create") await createDirectory(join(root, ".obsidian"));
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const next = await loadKnowledgeConfig(temp);
    // Reject a target already owned by another configured service before changing the old connection.
    if (!same) await running(next);
    if (old && await running(old)) {
      const response = await fetch(`${old.url}/stop`, { method: "POST", headers: { Authorization: `Bearer ${old.token}` } });
      if (!response.ok) throw new Error("旧服务未能停止，连接尚未更改");
      await response.text();
    }
    const latest = await current(configFile);
    if (latest?.text !== previous?.text) throw new Error("连接配置已被其他窗口修改，请重新打开设置");
    if (previous) await writeFile(`${configFile}.previous`, previous.text, { mode: 0o600 });
    await rename(temp, configFile); saved = true;
    return { directory: next.vaultRoot, folders, backup: previous ? `${configFile}.previous` : null, restartRequired: true };
  } finally {
    if (!saved) {
      await unlink(temp).catch(error => { if (!missing(error)) throw error; });
      // Remove only empty directories created by this attempt; never delete notes or existing folders.
      for (const path of created.reverse()) await rmdir(path).catch(() => {});
    }
  }
}
