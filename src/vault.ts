import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, parse, posix, relative, resolve } from "node:path";
import { appendGoalEvidence, appendGoalRecall, appendGoalSteps, learningGoalContent, noteStatus, setGoalTask, setGoalReviewDate, setProjectStatus, type GoalRecallInput, type LearningGoalInput } from "./note-metadata";
import { taskProgress, type TaskProgress } from "./task-progress";
import { prepareReviewReport, type ReviewReport, type ReviewReportInput } from "./period-review";
import { parseDocument } from "yaml";
import { validateArticleText, type ArticleSource } from "./article-source";
import { pdfBytes, type PdfOriginal, type PdfSource } from "./pdf-source";
import type { KnowledgeProposal } from "./knowledge-types";
import { parseHandoff, type HandoffCapture } from "./handoff-source";
import { correctionBody, correctionInput, type CorrectionInput } from "./knowledge-correction";
import { knowledgePlanInput, knowledgePlanMetadata, prepareKnowledge, type KnowledgePlanInput, type KnowledgePlanMetadata } from "./knowledge-synthesis";
import { mergeKnowledge, validateKnowledgeSections } from "./knowledge-document";

export type FolderMap = Record<"inbox" | "knowledge" | "daily" | "projects" | "learning", string>;
export interface NoteSummary { path: string; title: string; category: string; excerpt: string; status?: string; metadataError?: string; tasks?: TaskProgress }
export interface NoteDocument extends NoteSummary { content: string; version: string; reuse?: import("./knowledge-provenance").NoteReuse }
export interface InboxInput { sourcePath: string; sourceVersion: string; targetPath: string; targetVersion?: string; content: string; reason: string }
export interface ChatImportInput { title: string; sourceName: string; content: string }
export type ChatImportPreview = { duplicate: NoteDocument; plan?: never } | { plan: ChangePlan; duplicate?: never };
export interface ChangePlan { id: string; path: string; before: string; after: string; version: string; create?: boolean; knowledge?: KnowledgePlanMetadata; origin?: "dsh" | "mcp"; inbox?: { path: string; version: string; reason: string }; correction?: { changes: CorrectionInput["changes"] }; report?: ReviewReport; article?: { sourceName: string; hash: string; content: string; snapshotPath: string }; chat?: { sourceName: string; hash: string; content: string; snapshotPath: string }; pdf?: { sourceName: string; hash: string; base64: string; snapshotPath: string } }
export interface ChangeResult {
  id: string; path: string; kind: "capture" | "update" | "restore";
  status: "completed" | "failed"; at: string; error?: string;
}
interface Operation {
  result: ChangeResult; state: "executing" | "finished"; before?: string; after: string;
}
const defaults: FolderMap = { inbox: "Inbox", knowledge: "Wiki", daily: "Daily", projects: "Projects", learning: "Learning" };
export const defaultFolderMap = defaults;
const control = ".ai-learning-os";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function appendProjectProgress(before: string, entry: string): string {
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  let fence = "";
  let found = false;
  let insertion = before.length;
  let offset = 0;
  for (const line of before.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    } else if (!fence) {
      if (found && /^#{1,2}\s+/.test(line)) { insertion = offset; break; }
      if (/^##[ \t]+Progress[ \t]*\r?$/.test(line.replace(/\n$/, ""))) found = true;
    }
    offset += line.length;
  }
  const prefix = before.slice(0, insertion);
  const separator = prefix.endsWith(newline + newline) ? "" : prefix.endsWith(newline) ? newline : newline + newline;
  const heading = found ? "" : `## Progress${newline}${newline}`;
  return `${prefix}${separator}${heading}${entry.replace(/\r?\n/g, newline)}${newline}${insertion < before.length ? newline : ""}${before.slice(insertion)}`;
}

function segments(path: string, internal = false): string[] {
  const parts = path.split("/");
  if (!path || isAbsolute(path) || path.includes("\\") || parts.some((part, index) =>
    !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || (/^\./.test(part) && !(internal && index === 0 && part === control))
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error("Unsafe Vault path");
  }
  return parts;
}

export function isMappedNotePath(path: string, folders: FolderMap): boolean {
  try {
    segments(path);
    return /\.md$/i.test(path) && Object.values(folders).some(folder => path.toLowerCase().startsWith(`${folder.toLowerCase()}/`));
  } catch { return false; }
}

/** One writer per Vault. Call execute/restore only after explicit UI confirmation. */
export class VaultService {
  private readonly root: string;
  private readonly folders: FolderMap;
  private readonly issuedPlans = new Map<string, string>();
  private readonly displayedOperations = new Map<string, { record: string; backup: string }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, folderMap: Partial<FolderMap> = {}, private readonly sharedWriter = false) {
    if (!isAbsolute(root)) throw new Error("Vault root must be absolute");
    this.root = resolve(root);
    this.folders = { ...defaults, ...folderMap };
    const paths = Object.values(this.folders);
    paths.forEach((path) => segments(path));
    if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex &&
      (path.toLowerCase() === other.toLowerCase() || path.toLowerCase().startsWith(`${other.toLowerCase()}/`))))) {
      throw new Error("Vault folder mappings must not overlap");
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private category(path: string): string {
    segments(path);
    if (!/\.md$/i.test(path)) throw new Error("Only Markdown notes are allowed");
    const match = Object.entries(this.folders).find(([, folder]) => path.toLowerCase().startsWith(`${folder.toLowerCase()}/`));
    if (!match) throw new Error("Note is outside mapped folders");
    return match[0];
  }

  private async validateRoot(): Promise<void> {
    // Check ancestors too: a symlinked Vault root must not silently redirect writes.
    let current = parse(this.root).root;
    const rootStat = await lstat(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Vault root contains a link or non-directory");
    for (const part of relative(current, this.root).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Vault root contains a link or non-directory");
    }
  }

  private async safe(path: string, createParents = false): Promise<string> {
    // Exact host-only settings path; public note operations still reject hidden directories.
    const parts = path === ".obsidian/plugins/obsidian-local-rest-api/data.json" ? path.split("/") : segments(path, true);
    await this.validateRoot();
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      if (createParents && index < parts.length - 1) {
        try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in a Vault path");
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Vault parent is not a directory");
        if (index === parts.length - 1 && !stat.isFile() && !stat.isDirectory()) throw new Error("Unsupported Vault entry");
      } catch (error) { if (!missing(error)) throw error; }
    }
    return current;
  }

  private async json<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(await this.safe(path), "utf8")) as T;
  }

  isMappedNote(path: string): boolean {
    try { this.category(path); return true; } catch { return false; }
  }

  async verifyObsidianConnection(key: string, port: number): Promise<void> {
    const settings = await this.json<{ apiKey?: string; insecurePort?: number; enableInsecureServer?: boolean; bindingHost?: string }>(
      ".obsidian/plugins/obsidian-local-rest-api/data.json");
    if (settings.apiKey !== key || settings.enableInsecureServer !== true || settings.insecurePort !== port
      || (settings.bindingHost !== undefined && settings.bindingHost !== "127.0.0.1")) {
      throw new Error("Obsidian 连接配置与当前 Vault 的插件设置不一致，请检查资料目录、端口和凭据。");
    }
  }

  async obsidianConnection(): Promise<{ key: string; port: number } | undefined> {
    let settings;
    try { settings = await this.json<{ apiKey?: string; insecurePort?: number; enableInsecureServer?: boolean; bindingHost?: string }>(".obsidian/plugins/obsidian-local-rest-api/data.json"); }
    catch (error) { if (missing(error)) return; throw error; }
    if (!settings.enableInsecureServer) return;
    if (!settings.apiKey?.trim() || !Number.isInteger(settings.insecurePort) || settings.insecurePort! < 1 || settings.insecurePort! > 65535
      || settings.bindingHost !== undefined && settings.bindingHost !== "127.0.0.1") throw new Error("Obsidian 本机 HTTP 配置不可用");
    return { key: settings.apiKey, port: settings.insecurePort! };
  }

  async noteStamp(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted(); this.category(path);
    const value = await stat(await this.safe(path));
    return `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  }

  private async readOptional(path: string): Promise<NoteDocument | undefined> {
    try { return await this.read(path); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }

  private async atomic(path: string, content: string): Promise<void> {
    const target = await this.safe(path, true);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: "wx" });
    try {
      await this.safe(path);
      await rename(temporary, target);
    } finally {
      try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
  }

  private async initialize(): Promise<void> {
    const path = `${control}/space.json`;
    const target = await this.safe(path, true);
    try {
      await writeFile(target, JSON.stringify({ id: randomUUID(), schemaVersion: this.sharedWriter ? 2 : 1, folderMap: this.folders,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.json<{ schemaVersion: number; folderMap: FolderMap }>(path);
      if (![1, ...(this.sharedWriter ? [2] : [])].includes(existing.schemaVersion) || Object.keys(defaults).some((key) =>
        existing.folderMap[key as keyof FolderMap] !== this.folders[key as keyof FolderMap])) {
        throw new Error("Vault metadata differs from configured folder mappings");
      }
      if (this.sharedWriter && existing.schemaVersion === 1) {
        const backup = await this.safe(`${control}/space.before-shared-v2.json`, true);
        try { await writeFile(backup, await readFile(target), { flag: "wx" }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await this.atomic(path, JSON.stringify({ ...existing, schemaVersion: 2 }));
      }
    }
  }

  async read(path: string, signal?: AbortSignal): Promise<NoteDocument> {
    signal?.throwIfAborted();
    const category = this.category(path);
    const bytes = await readFile(await this.safe(path), { signal });
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const title = /^#\s+(.+)$/m.exec(content)?.[1].trim() || basename(path).replace(/\.md$/i, "");
    return { path, category, title, content, version: hash(content), excerpt: content.slice(0, 240),
      ...(["projects", "learning"].includes(category) ? { ...noteStatus(content), tasks: taskProgress(content) } : {}) };
  }

  async notePaths(signal?: AbortSignal): Promise<string[]> {
    // Only missing mapped folders are empty; an invalid root is a configuration error.
    await this.validateRoot();
    const paths: string[] = [];
    const walk = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      let entries;
      try { entries = await readdir(await this.safe(path), { withFileTypes: true }); }
      catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in mapped folders");
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) paths.push(child);
      }
    };
    for (const folder of Object.values(this.folders)) await walk(folder);
    return paths.sort((a, b) => a.localeCompare(b));
  }

  noteOpenUri(path: string) {
    this.category(path);
    return `obsidian://open?path=${encodeURIComponent(resolve(this.root, ...path.split("/")))}`;
  }

  async list(query = "", signal?: AbortSignal): Promise<NoteSummary[]> {
    const notes: NoteSummary[] = [], search = query.trim().toLocaleLowerCase();
    for (const path of await this.notePaths(signal)) {
      const { content, version: _version, ...note } = await this.read(path, signal);
      if (!search || `${path}\n${content}`.toLocaleLowerCase().includes(search)) notes.push(note);
    }
    return notes;
  }

  private recordPath(id: string, area: "plans" | "activity" | "backups", extension = "json"): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid operation ID");
    return `${control}/${area}/${id}.${extension}`;
  }

  private async saveOperation(operation: Operation): Promise<void> {
    await this.atomic(this.recordPath(operation.result.id, "activity"), JSON.stringify(operation));
  }

  async capture(title: string, content: string): Promise<NoteDocument> {
    return this.serial(async () => {
      if (!title.trim() || title.includes("/") || title.includes("\\")) throw new Error("Capture title must be a filename");
      const path = `${this.folders.inbox}/${title}.md`;
      this.category(path);
      return this.captureAt(path, content);
    });
  }

  private async captureAt(path: string, content: string, check = () => {}): Promise<NoteDocument> {
    check();
    await this.initialize();
    const operation: Operation = { result: { id: randomUUID(), path, kind: "capture", status: "failed", at: new Date().toISOString() },
      state: "executing", after: hash(content) };
    await this.saveOperation(operation);
    try { const destination = await this.safe(path, true); check(); await writeFile(destination, content, { flag: "wx" }); }
    catch (error) {
      operation.state = "finished";
      operation.result.error = message(error);
      await this.saveOperation(operation);
      throw error;
    }
    operation.state = "finished";
    operation.result.status = "completed";
    try { await this.saveOperation(operation); }
    catch (error) { throw new Error(`Note was written but the activity record could not be completed: ${message(error)}`); }
    return this.read(path);
  }

  async captureHandoff(content: string, projectPath?: string, submittedFile?: string, signal?: AbortSignal): Promise<HandoffCapture> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const handoff = parseHandoff(content);
      if (projectPath && this.category(projectPath) !== "projects") throw new Error("Handoff project must be a mapped project note");
      if (projectPath) await this.read(projectPath, signal);
      if (handoff.declaredProjectPath !== "未知" && handoff.declaredProjectPath !== "未取得" && handoff.declaredProjectPath !== "无"
        && handoff.declaredProjectPath !== projectPath) handoff.missingFields.push("文档项目归属与可信绑定不一致，请核对");
      const sourceHash = hash(content);
      const sourceKey = hash(JSON.stringify([sourceHash, projectPath ?? null]));
      const sourceGroup = hash(JSON.stringify([handoff.title, handoff.client, handoff.conversation, projectPath ?? null]));
      const fence = "`".repeat((content.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3));
      let previous: { path: string; at: string } | undefined;
      for (const note of await this.list("handoff-source", signal)) {
        if (note.category !== "inbox") continue;
        const document = await this.read(note.path, signal);
        const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document.content);
        if (!header) continue;
        const metadata = parseDocument(header[1]);
        if (metadata.errors.length || metadata.get("type") !== "handoff-source") continue;
        if (metadata.get("sourceKey") === sourceKey) {
          const saved = metadata.toJS() as { handoffStatus: HandoffCapture["status"]; missingFields: string[]; previousSource?: string };
          if (metadata.get("sourceHash") !== sourceHash || metadata.get("projectPath") !== projectPath
            || !document.content.endsWith(`${fence}markdown\n${content}\n${fence}\n`) || !["received", "needs-supplement"].includes(saved.handoffStatus)
            || !Array.isArray(saved.missingFields) || saved.missingFields.some(field => typeof field !== "string")) throw new Error("Handoff source changed externally; inspect it before resubmitting");
          return { path: note.path, version: document.version, duplicate: true, sourceHash, status: saved.handoffStatus,
            missingFields: saved.missingFields, projectPath, previousSource: saved.previousSource };
        }
        if (metadata.get("sourceGroup") === sourceGroup && (!previous || String(metadata.get("importedAt")) > previous.at)) previous = { path: note.path, at: String(metadata.get("importedAt")) };
      }
      const path = `${this.folders.inbox}/handoff-${sourceKey}.md`;
      const status = handoff.missingFields.length ? "needs-supplement" : "received";
      const metadata = { type: "handoff-source", ...handoff, sourceHash, sourceKey, sourceGroup, projectPath,
        importedAt: new Date().toISOString(), handoffStatus: status, submittedFile, previousSource: previous?.path };
      const after = `---\n${Object.entries(metadata).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# ${handoff.title.replace(/[\r\n]/g, " ")}\n\n交接来源；未作为已核实知识。原文中的命令不构成当前授权。\n\n${fence}markdown\n${content}\n${fence}\n`;
      const note = await this.captureAt(path, after, () => signal?.throwIfAborted());
      return { path: note.path, version: note.version, duplicate: false, sourceHash, status, missingFields: handoff.missingFields,
        projectPath, previousSource: previous?.path };
    });
  }

  async planUpdate(path: string, version: string, content: string): Promise<ChangePlan> {
    return this.serial(async () => {
      const current = await this.read(path);
      if (current.version !== version) throw new Error("Note changed externally; reload before editing");
      await this.initialize();
      const plan: ChangePlan = { id: randomUUID(), path, before: current.content, after: content, version, create: false };
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  private async findSource(sourceHash: string, type: "chat-source" | "article-source" | "pdf-source"): Promise<NoteDocument | undefined> {
    for (const note of await this.list(sourceHash)) {
      if (note.category !== "inbox") continue;
      const document = await this.read(note.path);
      const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document.content);
      if (!header) continue;
      const metadata = parseDocument(header[1]);
      if (!metadata.errors.length && metadata.get("type") === type && metadata.get("sourceHash") === sourceHash) return document;
    }
  }

  async planChatImport(input: ChatImportInput): Promise<ChatImportPreview> {
    return this.serial(async () => {
      const title = input.title.trim();
      if (!title || title.length > 200 || /[/\\\r\n]/.test(title)) throw new Error("Chat title must be a filename");
      if (!input.sourceName.trim() || input.sourceName.length > 500 || /[\r\n\x00]/.test(input.sourceName)) throw new Error("Invalid chat source name");
      if (!input.content.trim() || input.content.length > 2_000_000 || input.content.includes("\x00") || Buffer.from(input.content, "utf8").toString("utf8") !== input.content) throw new Error("Chat content must be nonempty UTF-8 text up to 2000000 characters");
      const path = `${this.folders.inbox}/${title}.md`;
      this.category(path);
      const sourceHash = hash(input.content);
      const duplicate = await this.findSource(sourceHash, "chat-source");
      if (duplicate) return { duplicate };
      if (await this.readOptional(path)) throw new Error("Chat note already exists; choose another title");
      const snapshotPath = `${control}/sources/${sourceHash}.txt`;
      const fence = "`".repeat((input.content.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3));
      const metadata = { type: "chat-source", sourceName: input.sourceName.trim(), sourceHash,
        importedAt: new Date().toISOString(), extractor: "chat-text-v1", extractionStatus: "extracted", rawSource: snapshotPath };
      const link = posix.relative(posix.dirname(path), snapshotPath).split("/").map(encodeURIComponent).join("/");
      const after = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# ${title}\n\n[原文快照](<${link}>)\n\n## 聊天原文\n\n${fence}text\n${input.content}\n${fence}\n`;
      const plan: ChangePlan = { id: randomUUID(), path, before: "", after, version: hash(""), create: true,
        chat: { sourceName: metadata.sourceName, hash: sourceHash, content: input.content, snapshotPath } };
      await this.initialize();
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return { plan };
    });
  }

  async planArticleImport(titleInput: string, source: ArticleSource): Promise<ChatImportPreview> {
    return this.serial(async () => {
      const title = titleInput.trim();
      if (!title || title.length > 200 || /[/\\\r\n]/.test(title)) throw new Error("文章标题必须是有效文件名。");
      validateArticleText(source.raw);
      validateArticleText(source.markdown);
      const path = `${this.folders.inbox}/${title}.md`;
      this.category(path);
      const sourceHash = hash(source.raw);
      const duplicate = await this.findSource(sourceHash, "article-source");
      if (duplicate) return { duplicate };
      if (await this.readOptional(path)) throw new Error("文章笔记已存在，请使用其他标题（内容变更可在标题标明版本）。");
      const snapshotPath = `${control}/sources/${sourceHash}.${source.format === "html" ? "html" : "md"}`;
      const metadata = { type: "article-source", sourceName: source.sourceName, sourceHash,
        submittedUrl: source.submittedUrl, sourceUrl: source.finalUrl, sourceTitle: source.sourceTitle, author: source.author,
        importedAt: new Date().toISOString(), extractor: source.extractor, extractionStatus: "extracted", rawSource: snapshotPath };
      const fence = "`".repeat((source.markdown.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3));
      const link = posix.relative(posix.dirname(path), snapshotPath).split("/").map(encodeURIComponent).join("/");
      const after = `---\n${Object.entries(metadata).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# ${title}\n\n[原文快照](<${link}>)\n\n## 文章正文（来源资料）\n\n${fence}markdown\n${source.markdown}\n${fence}\n`;
      const plan: ChangePlan = { id: randomUUID(), path, before: "", after, version: hash(""), create: true,
        article: { sourceName: source.sourceName, hash: sourceHash, content: source.raw, snapshotPath } };
      await this.initialize();
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return { plan };
    });
  }

  async planPdfImport(titleInput: string, source: PdfSource): Promise<ChatImportPreview> {
    return this.serial(async () => {
      const title = titleInput.trim();
      if (!title || title.length > 200 || /[/\\\r\n]/.test(title)) throw new Error("PDF 标题必须是有效文件名。");
      const bytes = pdfBytes(source.base64);
      if (createHash("sha256").update(bytes).digest("hex") !== source.hash) throw new Error("PDF source hash mismatch");
      const path = `${this.folders.inbox}/${title}.md`;
      this.category(path);
      const duplicate = await this.findSource(source.hash, "pdf-source");
      if (duplicate) return { duplicate };
      if (await this.readOptional(path)) throw new Error("PDF 笔记已存在，请使用其他标题。");
      const snapshotPath = `${control}/sources/${source.hash}.pdf`;
      const metadata = { type: "pdf-source", sourceName: source.sourceName, sourceHash: source.hash,
        importedAt: new Date().toISOString(), extractor: "pdfjs-5.4.149-text-v1", extractionStatus: "extracted",
        pageCount: source.pages.length, rawSource: snapshotPath };
      const link = posix.relative(posix.dirname(path), snapshotPath).split("/").map(encodeURIComponent).join("/");
      const body = source.pages.map((text, index) => {
        const fence = "`".repeat((text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3));
        return `## PDF 第 ${index + 1} 页\n\n[原 PDF 第 ${index + 1} 页](<${link}#page=${index + 1}>)\n\n${fence}text\n${text || "（本页无可提取文本）"}\n${fence}`;
      }).join("\n\n");
      const after = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# ${title}\n\n[原 PDF](<${link}>)\n\n${body}\n`;
      const plan: ChangePlan = { id: randomUUID(), path, before: "", after, version: hash(""), create: true,
        pdf: { sourceName: source.sourceName, hash: source.hash, base64: source.base64, snapshotPath } };
      await this.initialize();
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return { plan };
    });
  }

  async readPdf(path: string, version: string): Promise<PdfOriginal> {
    const note = await this.read(path);
    if (note.version !== version) throw new Error("Note changed externally; reload before opening PDF");
    const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(note.content);
    const metadata = header && parseDocument(header[1]);
    const sourceHash = metadata && metadata.get("sourceHash");
    const pages = metadata && metadata.get("pageCount");
    if (!metadata || metadata.errors.length || metadata.get("type") !== "pdf-source" || typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)
      || typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > 200 || metadata.get("rawSource") !== `${control}/sources/${sourceHash}.pdf`) throw new Error("Invalid PDF source metadata");
    const bytes = await readFile(await this.safe(`${control}/sources/${sourceHash}.pdf`));
    if (createHash("sha256").update(bytes).digest("hex") !== sourceHash) throw new Error("PDF source changed externally");
    return { base64: bytes.toString("base64"), pages, sourceName: String(metadata.get("sourceName")) };
  }

  async planDailyAppend(date: string, content: string): Promise<ChangePlan> {
    return this.serial(async () => {
      const parsedDate = new Date(`${date}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        throw new Error("Daily date must be YYYY-MM-DD");
      }
      const entry = content.trim();
      if (!entry) throw new Error("Daily content must not be empty");
      const path = `${this.folders.daily}/${date}.md`;
      this.category(path);
      const current = await this.readOptional(path);
      const before = current?.content ?? "";
      const after = before
        ? `${before}${before.endsWith("\n") ? "" : "\n"}\n${entry}\n`
        : `# ${date}\n\n${entry}\n`;
      await this.initialize();
      const plan: ChangePlan = { id: randomUUID(), path, before, after, version: hash(before), create: !current };
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  async planProjectAppend(path: string, version: string, content: string): Promise<ChangePlan> {
    return this.serial(async () => {
      if (this.category(path) !== "projects") throw new Error("Project note must be in the projects folder");
      const entry = content.trim();
      if (!entry) throw new Error("Project progress must not be empty");
      const current = await this.read(path);
      if (current.version !== version) throw new Error("Note changed externally; reload before editing");
      const after = appendProjectProgress(current.content, entry);
      await this.initialize();
      const plan: ChangePlan = { id: randomUUID(), path, before: current.content, after, version, create: false };
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  async planProjectStatus(path: string, version: string, status: string): Promise<ChangePlan> {
    if (this.category(path) !== "projects") throw new Error("Project note must be in the projects folder");
    const current = await this.read(path);
    const folderStatus = relative(this.folders.projects, path).split(/[\\/]/).slice(0, -1)
      .find(part => ["active", "paused", "completed", "archive"].includes(part.toLowerCase()));
    if (folderStatus && folderStatus.toLowerCase() !== status.toLowerCase()) {
      throw new Error("Project directory and requested status differ; moving legacy projects is not supported yet");
    }
    return this.planUpdate(path, version, setProjectStatus(current.content, status));
  }

  async planGoalEvidence(path: string, version: string, content: string): Promise<ChangePlan> {
    if (this.category(path) !== "learning") throw new Error("Learning goal must be in the learning folder");
    const current = await this.read(path);
    return this.planUpdate(path, version, appendGoalEvidence(current.content, content));
  }

  async planGoalSteps(path: string, version: string, steps: string[]): Promise<ChangePlan> {
    if (this.category(path) !== "learning") throw new Error("Learning goal must be in the learning folder");
    const current = await this.read(path);
    return this.planUpdate(path, version, appendGoalSteps(current.content, steps));
  }

  async planGoalRecall(path: string, version: string, input: GoalRecallInput): Promise<ChangePlan> {
    if (this.category(path) !== "learning") throw new Error("Learning goal must be in the learning folder");
    const current = await this.read(path);
    return this.planUpdate(path, version, appendGoalRecall(current.content, input, current.version));
  }

  async planGoalReviewDate(path: string, version: string, date: string | null): Promise<ChangePlan> {
    if (this.category(path) !== "learning") throw new Error("Review date requires a learning goal");
    const current = await this.read(path);
    return this.planUpdate(path, version, setGoalReviewDate(current.content, date));
  }

  async planGoalTask(path: string, version: string, line: number, checked: boolean): Promise<ChangePlan> {
    if (this.category(path) !== "learning") throw new Error("Learning goal must be in the learning folder");
    const current = await this.read(path);
    return this.planUpdate(path, version, setGoalTask(current.content, line, checked));
  }

  async planLearningGoal(input: LearningGoalInput): Promise<ChangePlan> {
    return this.serial(async () => {
      const after = learningGoalContent(input, randomUUID());
      const path = `${this.folders.learning}/${input.title.trim()}.md`;
      this.category(path);
      if (await this.readOptional(path)) throw new Error("Learning goal already exists; edit the existing note");
      await this.initialize();
      const plan: ChangePlan = { id: randomUUID(), path, before: "", after, version: hash(""), create: true };
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  async planInbox(input: InboxInput): Promise<ChangePlan> {
    return this.serial(async () => {
      if (this.category(input.sourcePath) !== "inbox" || this.category(input.targetPath) !== "knowledge") {
        throw new Error("Inbox organization requires an Inbox source and a knowledge target");
      }
      if (!/^[0-9a-f]{64}$/.test(input.sourceVersion) || !input.content.trim() || input.content.length > 100_000
        || !input.reason.trim() || input.reason.length > 2000) throw new Error("Invalid Inbox content, reason or source version");
      const inbox = { path: input.sourcePath, version: input.sourceVersion, reason: input.reason.trim() };
      const source = await this.checkInboxSource(inbox);
      const current = await this.readOptional(input.targetPath);
      if (current ? current.version !== input.targetVersion : input.targetVersion !== undefined) {
        throw new Error("Knowledge target changed or requires its current version; reread before organizing");
      }
      const before = current?.content ?? "";
      const newline = before.includes("\r\n") ? "\r\n" : "\n";
      const link = posix.relative(posix.dirname(input.targetPath), input.sourcePath).split("/").map(encodeURIComponent).join("/");
      const label = input.sourcePath.replace(/[\\[\]]/g, "\\$&");
      const separator = !before || before.endsWith(newline + newline) ? "" : before.endsWith(newline) ? newline : newline + newline;
      const entry = input.content.trim().replace(/\r?\n/g, newline);
      const sourceHeader = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.content);
      const sourceMetadata = sourceHeader ? parseDocument(sourceHeader[1]) : undefined;
      const projectPath = sourceMetadata?.get("type") === "handoff-source" ? sourceMetadata.get("projectPath") : undefined;
      if (projectPath !== undefined && (typeof projectPath !== "string" || this.category(projectPath) !== "projects")) throw new Error("Invalid handoff project attribution");
      const projectHeader = !current && projectPath ? `---${newline}projectPath: ${JSON.stringify(projectPath)}${newline}---${newline}` : "";
      const after = `${projectHeader}${before}${separator}${current ? `## Inbox 整理${newline}${newline}` : ""}${entry}${newline}${newline}来源：[${label}](<${link}>) · 原文版本：\`${input.sourceVersion}\`${newline}`;
      await this.initialize();
      const plan: ChangePlan = { id: randomUUID(), path: input.targetPath, before, after, version: hash(before), create: !current, inbox };
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  async planCorrection(value: CorrectionInput): Promise<ChangePlan> {
    const input = correctionInput.parse(value);
    return this.serial(async () => {
      if (this.category(input.sourcePath) !== "inbox" || this.category(input.targetPath) !== "knowledge") {
        throw new Error("Correction requires an Inbox handoff source and an existing knowledge target");
      }
      const inbox = { path: input.sourcePath, version: input.sourceVersion, reason: input.reason };
      const source = await this.checkInboxSource(inbox);
      const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.content);
      const metadata = header ? parseDocument(header[1]) : undefined;
      if (!metadata || metadata.errors.length || metadata.get("type") !== "handoff-source") throw new Error("Correction requires an explicit handoff-source note");
      const current = await this.read(input.targetPath);
      if (current.version !== input.targetVersion) throw new Error("Knowledge target changed; reread before correcting");
      const id = randomUUID();
      const plan: ChangePlan = { id, path: input.targetPath, before: current.content,
        after: correctionBody(current.content, input, id), version: current.version, inbox, correction: { changes: input.changes } };
      await this.initialize();
      await this.atomic(this.recordPath(id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  async planReviewReport(input: ReviewReportInput): Promise<ChangePlan> {
    return this.serial(async () => {
      const path = `${this.folders.knowledge}/${input.title.trim()}.md`;
      this.category(path);
      if (await this.readOptional(path)) throw new Error("Review report already exists; choose a new title");
      const { report, content } = await prepareReviewReport(this, input, path);
      await this.initialize();
      const plan: ChangePlan = { id: randomUUID(), path, before: "", after: content, version: hash(""), create: true, report };
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  async planKnowledge(value: KnowledgePlanInput, baseline?: string, origin: "dsh" | "mcp" = "mcp"): Promise<ChangePlan> {
    const input = knowledgePlanInput.parse(value);
    return this.serial(async () => {
      const prepared = await prepareKnowledge(this, input.targetPath, input.draft);
      validateKnowledgeSections(prepared.content);
      const current = await this.readOptional(input.targetPath);
      if (current ? current.version !== input.targetVersion : input.targetVersion !== undefined) throw new Error("Knowledge target changed; reread before organizing");
      const before = current?.content ?? "";
      const merged = current ? mergeKnowledge(before, prepared.content, prepared.metadata, baseline, input.replacements)
        : { after: prepared.content, changes: [{ before: "", after: prepared.content }], retained: [] };
      if (!current && input.replacements.length) throw new Error("New knowledge target has no sections to replace");
      const knowledge = knowledgePlanMetadata.parse({ ...prepared.metadata, issues: [...prepared.issues, ...merged.retained.map(item => ({ item, reason: "保留旧段落或人工修改，尚未按本次来源重新整理；主题已处理范围留空。" }))], evidence: prepared.evidence, changes: merged.changes });
      const plan: ChangePlan = { id: randomUUID(), path: input.targetPath, before, after: merged.after, version: hash(before), create: !current, knowledge, origin };
      await this.initialize();
      await this.atomic(this.recordPath(plan.id, "plans"), JSON.stringify(plan));
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
      return plan;
    });
  }

  private async checkKnowledgeSources(value: KnowledgePlanMetadata): Promise<void> {
    const knowledge = knowledgePlanMetadata.parse(value);
    for (const source of knowledge.sources) {
      const note = await this.read(source.path);
      if (note.version !== source.version || note.content.length !== source.total) throw new Error("Knowledge source changed externally; reread before organizing");
    }
  }

  private async checkReviewSources(report: ReviewReport): Promise<void> {
    for (const source of report.sources) {
      if ((await this.read(source.path)).version !== source.version) throw new Error("Review source changed externally; regenerate the report");
    }
  }

  private async checkInboxSource(source: NonNullable<ChangePlan["inbox"]>): Promise<NoteDocument> {
    const current = await this.read(source.path);
    if (current.category !== "inbox" || current.version !== source.version) {
      throw new Error("Inbox source changed externally; reread before organizing");
    }
    return current;
  }

  private async replace(id: string, path: string, version: string, content: string, kind: "update" | "restore", allowMissing = false, check = () => {}, inbox?: ChangePlan["inbox"], report?: ReviewReport, chat?: ChangePlan["chat"], article?: ChangePlan["article"], pdf?: ChangePlan["pdf"], knowledge?: KnowledgePlanMetadata): Promise<ChangeResult> {
    const current = allowMissing ? await this.readOptional(path) : await this.read(path);
    const currentVersion = current?.version ?? hash("");
    const operation: Operation = { result: { id, path, kind, status: "failed", at: new Date().toISOString() },
      state: "executing", ...(current ? { before: current.version } : {}), after: hash(content) };
    await this.saveOperation(operation);
    let replaced = false;
    try {
      if (inbox) await this.checkInboxSource(inbox);
      if (report) await this.checkReviewSources(report);
      if (knowledge) await this.checkKnowledgeSources(knowledge);
      if (allowMissing && current) throw new Error("Note was created externally; create a new plan");
      if (currentVersion !== version) throw new Error("Note changed externally; create a new plan");
      const source = pdf ?? article ?? chat;
      if (source) {
        const duplicate = await this.findSource(source.hash, pdf ? "pdf-source" : article ? "article-source" : "chat-source");
        if (duplicate) throw new Error(`${article ? "Article" : "Chat"} already imported: ${duplicate.path}`);
        const snapshot = await this.safe(source.snapshotPath, true);
        const bytes = "base64" in source ? pdfBytes(source.base64) : Buffer.from(source.content, "utf8");
        try { await writeFile(snapshot, bytes, { flag: "wx" }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (createHash("sha256").update(await readFile(snapshot)).digest("hex") !== source.hash) throw new Error("Source snapshot changed externally");
        }
      }
      if (current) await writeFile(await this.safe(this.recordPath(id, "backups", "md"), true), current.content, { flag: "wx" });
      const target = await this.safe(path, true);
      const temporary = `${target}.${id}.tmp`;
      await writeFile(temporary, content, { flag: "wx" });
      try {
        const latest = allowMissing ? await this.readOptional(path) : await this.read(path);
        if (allowMissing && latest) throw new Error("Note was created while preparing the write");
        if ((latest?.version ?? hash("")) !== version) throw new Error("Note changed while preparing the write");
        const destination = await this.safe(path);
        if (inbox) await this.checkInboxSource(inbox);
        if (report) await this.checkReviewSources(report);
        if (knowledge) await this.checkKnowledgeSources(knowledge);
        check();
        await rename(temporary, destination);
        replaced = true;
      } finally {
        try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
      }
      operation.result.status = "completed";
    } catch (error) {
      if (replaced) throw new Error(`Note was written but finalization failed: ${message(error)}`);
      operation.result.error = message(error);
    }
    operation.state = "finished";
    try { await this.saveOperation(operation); }
    catch (error) {
      if (replaced) throw new Error(`Note was written but the activity record could not be completed: ${message(error)}`);
      throw error;
    }
    return operation.result;
  }

  async previewPlan(planId: string): Promise<ChangePlan> {
    const plan = await this.json<ChangePlan>(this.recordPath(planId, "plans"));
    if (plan.id !== planId || this.issuedPlans.get(planId) !== hash(JSON.stringify(plan))) {
      throw new Error("Plan changed or expired; ask the assistant for a new plan");
    }
    return plan;
  }

  async initializeSharedWriter(): Promise<void> {
    if (!this.sharedWriter) throw new Error("This VaultService is not the shared writer");
    await this.serial(() => this.initialize());
  }

  async saveManagedPlan(entry: KnowledgeProposal): Promise<void> {
    await this.serial(() => this.atomic(this.recordPath(entry.plan.id, "plans", "state.json"), JSON.stringify(entry)));
  }

  async loadManagedPlans(): Promise<{ managed: unknown[]; legacy: ChangePlan[] }> {
    let files: string[];
    try { files = await readdir(await this.safe(`${control}/plans`)); }
    catch (error) { if (missing(error)) return { managed: [], legacy: [] }; throw error; }
    const managed: unknown[] = [];
    const legacy: ChangePlan[] = [];
    for (const name of files.filter(name => name.endsWith(".json"))) {
      if (name.endsWith(".state.json")) {
        const entry = await this.json<KnowledgeProposal>(this.recordPath(name.slice(0, -11), "plans", "state.json"));
        if (entry?.plan?.id !== name.slice(0, -11)) throw new Error("Persisted plan identity differs from its state filename");
        managed.push(entry);
      } else if (!files.includes(`${name.slice(0, -5)}.state.json`)) {
        const plan = await this.json<ChangePlan>(this.recordPath(name.slice(0, -5), "plans"));
        if (plan?.id !== name.slice(0, -5) || typeof plan.path !== "string" || typeof plan.before !== "string" || typeof plan.after !== "string" || hash(plan.before) !== plan.version) throw new Error("Invalid legacy plan");
        legacy.push(plan);
      }
    }
    return { managed, legacy };
  }

  async checkPlan(plan: ChangePlan): Promise<void> {
    const persisted = await this.json<ChangePlan>(this.recordPath(plan.id, "plans"));
    if (JSON.stringify(persisted) !== JSON.stringify(plan) || hash(plan.before) !== plan.version) throw new Error("Plan changed externally; regenerate it");
    this.category(plan.path);
    const current = await this.readOptional(plan.path);
    if (plan.create && current) throw new Error("Knowledge target was created externally");
    if ((!plan.create && !current) || (current?.version ?? hash("")) !== plan.version) throw new Error("Knowledge target changed externally");
    if (plan.inbox) await this.checkInboxSource(plan.inbox);
    if (plan.report) await this.checkReviewSources(plan.report);
    if (plan.knowledge) await this.checkKnowledgeSources(plan.knowledge);
  }

  async reissuePlan(plan: ChangePlan): Promise<void> {
    await this.serial(async () => {
      await this.checkPlan(plan);
      this.issuedPlans.set(plan.id, hash(JSON.stringify(plan)));
    });
  }

  async planOperation(planId: string): Promise<{ state: "executing" | "finished"; result: ChangeResult } | undefined> {
    try { return await this.json<Operation>(this.recordPath(planId, "activity")); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }

  async cancelPlan(planId: string): Promise<void> {
    await this.serial(async () => { this.issuedPlans.delete(planId); });
  }

  async execute(planId: string, check = () => {}): Promise<ChangeResult> {
    return this.serial(async () => {
      check();
      try {
        const operation = await this.json<Operation>(this.recordPath(planId, "activity"));
        if (operation.state !== "finished") throw new Error("Interrupted operation requires manual review; it will not be replayed");
        return operation.result;
      } catch (error) { if (!missing(error)) throw error; }
      const plan = await this.json<ChangePlan>(this.recordPath(planId, "plans"));
      if (plan.id !== planId || hash(plan.before) !== plan.version) throw new Error("Invalid change plan");
      if (this.issuedPlans.get(planId) !== hash(JSON.stringify(plan))) {
        throw new Error("Plan changed or was loaded from another session; preview a new plan before confirming");
      }
      await this.initialize();
      return this.replace(plan.id, plan.path, plan.version, plan.after, "update", plan.create === true, check, plan.inbox, plan.report, plan.chat, plan.article, plan.pdf, plan.knowledge);
    });
  }

  async restore(operationId: string): Promise<ChangeResult> {
    return this.serial(async () => {
      const operation = await this.json<Operation>(this.recordPath(operationId, "activity"));
      const displayed = this.displayedOperations.get(operationId);
      if (!displayed) throw new Error("Open the activity log before confirming a restore");
      if (displayed.record !== hash(JSON.stringify(operation))) throw new Error("Restore record changed; refresh the activity log before confirming");
      if (operation.state !== "finished" || operation.result.status !== "completed" || !operation.before) {
        throw new Error("Operation has no completed replacement to restore");
      }
      const bytes = await readFile(await this.safe(this.recordPath(operationId, "backups", "md")));
      if (createHash("sha256").update(bytes).digest("hex") !== displayed.backup) throw new Error("Backup integrity check failed; refresh the activity log before confirming");
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (hash(content) !== operation.before) throw new Error("Backup integrity check failed");
      await this.initialize();
      return this.replace(randomUUID(), operation.result.path, operation.after, content, "restore");
    });
  }

  folderMap(): FolderMap { return { ...this.folders }; }

  async pinnedProjects(): Promise<string[]> {
    try {
      const value = await this.json<{ schemaVersion: number; paths: string[] }>(`${control}/pinned-projects.json`);
      if (value.schemaVersion !== 1 || !Array.isArray(value.paths) || value.paths.some(path => typeof path !== "string" || this.category(path) !== "projects")) throw new Error("Invalid pinned projects");
      return value.paths;
    } catch (error) { if (missing(error)) return []; throw error; }
  }

  async setProjectPinned(path: string, pinned: boolean): Promise<string[]> {
    if (typeof pinned !== "boolean" || this.category(path) !== "projects") throw new Error("Only mapped projects can be pinned");
    return this.serial(async () => {
      if (pinned) await this.read(path);
      const paths = (await this.pinnedProjects()).filter(item => item !== path);
      if (pinned) paths.push(path);
      await this.initialize();
      await this.atomic(`${control}/pinned-projects.json`, JSON.stringify({ schemaVersion: 1, paths }));
      return paths;
    });
  }

  async previewRestore(operationId: string) {
    await this.activity();
    const operation = await this.json<Operation>(this.recordPath(operationId, "activity"));
    if (operation.state !== "finished" || operation.result.status !== "completed" || !operation.before) throw new Error("Operation has no completed replacement to restore");
    const current = await this.read(operation.result.path);
    if (current.version !== operation.after) throw new Error("Note changed; this restore would overwrite later edits");
    const after = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(await this.safe(this.recordPath(operationId, "backups", "md"))));
    if (hash(after) !== operation.before) throw new Error("Backup integrity check failed");
    return { operationId, path: current.path, version: current.version, before: current.content, after };
  }

  async activity(): Promise<ChangeResult[]> {
    let entries: string[];
    try { entries = await readdir(await this.safe(`${control}/activity`)); }
    catch (error) { if (missing(error)) return []; throw error; }
    const results: ChangeResult[] = [];
    for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
      const id = entry.slice(0, -5);
      const operation = await this.json<Operation>(this.recordPath(id, "activity"));
      if (operation.result.id !== id) throw new Error("Activity record identity mismatch");
      if (operation.state === "finished" && operation.result.status === "completed" && operation.before) {
        const bytes = await readFile(await this.safe(this.recordPath(id, "backups", "md")));
        const snapshot = { record: hash(JSON.stringify(operation)), backup: createHash("sha256").update(bytes).digest("hex") };
        const previous = this.displayedOperations.get(id);
        if (previous && (previous.record !== snapshot.record || previous.backup !== snapshot.backup)) {
          throw new Error("Completed operation or backup changed externally; inspect recovery records before continuing");
        }
        this.displayedOperations.set(id, snapshot);
      }
      results.push(operation.state === "finished" ? operation.result : {
        ...operation.result, status: "failed", error: "Interrupted operation; inspect the note and backup before continuing",
      });
    }
    return results.sort((a, b) => b.at.localeCompare(a.at));
  }
}
