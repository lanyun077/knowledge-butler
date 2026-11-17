import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { VaultService, type ChangePlan, type FolderMap, type InboxInput } from "./vault";
import { planMethods, readMethods, type HostRequest, type HostReply, type PlanMethod } from "./knowledge-host";
import type { KnowledgeProposal, ProposalOwner } from "./knowledge-types";
import { confirmationOutcome, type ConfirmationOutcome } from "./knowledge-types";
import { projectBinding, projectContext, readProjectHandoff, readProjectSource, type ProjectBinding } from "./knowledge-projects";
import { businessInput, planBusiness, articleInput, sourceFileInput, reviewReportInput, type BusinessInput } from "./knowledge-business";
import { prepareArticle } from "./article-source";
import { preparePdf } from "./pdf-source";
import { dueReviews } from "./due-reviews";
import { periodReview } from "./period-review";
import type { CorrectionInput } from "./knowledge-correction";
import { contentVersion, noteReuse, savedPlans, type NoteProvenance, type ProvenanceEntry } from "./knowledge-provenance";
import { managementNotes, managementViews, pageOf, planSummary, type ManagementResult, type ManagementView } from "./knowledge-management";
import { managerRecords } from "./knowledge-manager-records";
import { writeReview, type SaveAuthorization } from "./knowledge-write-policy";
import { KnowledgeIndex } from "./knowledge-organization";
import type { KnowledgeCollectInput, KnowledgeQueryInput } from "./knowledge-organization-contract";
import { ObsidianBridge } from "./obsidian";
import { knowledgePlanMetadata, type KnowledgePlanInput } from "./knowledge-synthesis";
export type { KnowledgeProposal } from "./knowledge-types";

const ownerSchema = z.object({ scope: z.string(), sessionId: z.string(), cwd: z.string(), kind: z.enum(["daily", "project", "goal", "inbox", "report"]) }).strict();
const entrySchema = z.object({
  schemaVersion: z.literal(1),
  plan: z.object({ id: z.string().uuid(), path: z.string(), before: z.string(), after: z.string(), version: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()
    .superRefine((plan, ctx) => { if (plan.knowledge !== undefined && !knowledgePlanMetadata.safeParse(plan.knowledge).success) ctx.addIssue({ code: "custom", message: "Invalid knowledge plan metadata" }); }),
  revision: z.number().int().positive(), kind: z.enum(["daily", "project", "goal", "inbox", "report", "manual"]), owner: ownerSchema.optional(),
  createdAt: z.string(), validationError: z.string().optional(), status: z.enum(["pending", "superseded", "cancelled", "stale", "applying", "completed", "failed", "needs-reconciliation", "legacy"]),
  supersedes: z.string().uuid().optional(), supersededBy: z.string().uuid().optional(),
  result: z.object({ id: z.string().uuid(), path: z.string(), kind: z.enum(["capture", "update", "restore"]), status: z.enum(["completed", "failed"]), at: z.string(), error: z.string().optional() }).strict().optional(),
}).strict();
const operationSchema = z.object({ state: z.enum(["executing", "finished"]), result: entrySchema.shape.result.unwrap() }).passthrough();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The only writer and proposal registry, shared by DSH and MCP connections. */
export class KnowledgeCore {
  readonly instanceId = randomUUID();
  private readonly vault: VaultService;
  private readonly knowledge: KnowledgeIndex;
  private readonly proposals = new Map<string, KnowledgeProposal>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly applications = new Map<string, Promise<KnowledgeProposal>>();
  private readonly tickets = new Map<string, { token: string; digest: string }>();
  private readonly displayedOperations = new Map<string, Set<string>>();
  private stopping = false;
  private confirming = 0;

  constructor(readonly vaultId: string, root: string, folders?: FolderMap, private readonly projects: ProjectBinding[] = []) {
    this.vault = new VaultService(root, folders, true);
    this.knowledge = new KnowledgeIndex(this.vault, async () => {
      const connection = await this.vault.obsidianConnection();
      if (!connection) return;
      return new ObsidianBridge(this.vault, { baseUrl: `http://127.0.0.1:${connection.port}`, apiKeyRef: "" }, async () => connection.key, () => this.available());
    });
  }

  async initialize() {
    await this.vault.initializeSharedWriter();
    for (const project of this.projects) {
      if ((await this.vault.read(project.projectPath)).category !== "projects") throw new Error("Project binding must reference a mapped project note");
    }
    const { managed, legacy } = await this.vault.loadManagedPlans();
    // Parse all metadata before restoring any plan; unknown formats never authorize.
    const entries = managed.map(value => entrySchema.parse(value) as KnowledgeProposal);
    for (const entry of entries) this.proposals.set(entry.plan.id, entry);
    for (const plan of legacy) {
      this.proposals.set(plan.id, { schemaVersion: 1, plan, revision: 1, kind: "manual", createdAt: "", status: "legacy" });
    }
    for (const entry of entries) {
      if (entry.supersedes) {
        const previous = this.proposals.get(entry.supersedes);
        if (previous && previous.status === "pending") { previous.status = "superseded"; previous.supersededBy = entry.plan.id; }
      }
    }
    for (const entry of entries) {
      const storedOperation = await this.vault.planOperation(entry.plan.id);
      const operation = storedOperation === undefined ? undefined : operationSchema.parse(storedOperation);
      if (operation) {
        if (operation.result.id !== entry.plan.id || operation.result.path !== entry.plan.path) throw new Error("Operation identity mismatch");
        entry.status = operation.state === "finished" ? operation.result.status : "needs-reconciliation";
        entry.result = operation.result;
      } else if (entry.status === "applying" || entry.status === "completed") entry.status = "needs-reconciliation";
      if (entry.status === "pending") {
        try { await this.vault.reissuePlan(entry.plan); }
        catch (error) { entry.status = "stale"; entry.validationError = error instanceof Error ? error.message : String(error); }
      }
      await this.save(entry);
    }
  }

  status() { return { vaultId: this.vaultId, instanceId: this.instanceId, stopping: this.stopping, confirming: this.confirming,
    pending: [...this.proposals.values()].filter(item => item.status === "pending").length }; }
  listPlans() { return [...this.proposals.values()]; }
  collectKnowledge(input: KnowledgeCollectInput, signal?: AbortSignal) { return this.knowledge.collect(input, signal); }
  queryKnowledge(input: KnowledgeQueryInput, signal?: AbortSignal) { return this.knowledge.query(input, signal); }
  async records(query: string, offset: number, signal: AbortSignal) {
    return managerRecords(await this.knowledge.managementNotes(signal), await this.vault.activity(), this.listPlans(), query, offset);
  }
  noteOpenUri(path: string) { return this.vault.noteOpenUri(path); }
  noteSummary(path: string, signal?: AbortSignal) { return this.knowledge.noteSummary(path, signal); }
  starMap(offset: number, version?: string, signal?: AbortSignal) { return this.knowledge.stars(offset, version, path => this.noteOpenUri(path), signal); }
  async management(view: ManagementView = "home", query = "", offset = 0, signal?: AbortSignal): Promise<ManagementResult> {
    if (!managementViews.includes(view) || typeof query !== "string" || query.length > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid management query");
    const matches = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const proposals = this.listPlans();
    for (const entry of proposals.filter(item => item.status === "pending")) {
      try { await this.preview(entry.plan.id, entry.revision); }
      catch (error) { if (entry.status !== "stale") throw error; }
    }
    if (view === "settings") return { view, settings: { service: this.status(), folders: this.vault.folderMap(), projects: this.projects.map(project => ({ directory: project.directory, projectPath: project.projectPath, fileSubmission: !!project.sourceRoot })) } };
    if (view === "plans") return { view, page: pageOf(proposals.filter(entry => !["completed", "cancelled", "superseded"].includes(entry.status) && matches(entry.plan.path)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(planSummary), offset) };
    const activity = await this.vault.activity();
    if (view === "activity") return { view, page: pageOf(activity.filter(item => matches(item.path)), offset) };
    const indexed = await this.knowledge.managementNotes(signal), notes = managementNotes(indexed, proposals, activity);
    const pins = await this.vault.pinnedProjects();
    for (const note of notes) if (note.category === "projects") note.pinned = pins.includes(note.path);
    const sources = notes.filter(note => note.reuse.kind === "source" || note.category === "inbox").sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? "") || a.path.localeCompare(b.path));
    if (view === "home") {
      return { view, home: {
        pending: pageOf(proposals.filter(entry => entry.status === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(planSummary), offset),
        sources: pageOf(sources, offset), pinned: pageOf(pins.flatMap(path => notes.find(note => note.path === path) ?? []), offset),
        missingPins: pins.filter(path => !notes.some(note => note.path === path)),
        knowledge: pageOf(notes.filter(note => note.reuse.kind === "knowledge").sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? "") || a.path.localeCompare(b.path)), 0),
        learning: pageOf(notes.filter(note => note.category === "learning"), 0),
        records: managerRecords(indexed, activity, proposals, "", 0),
      } };
    }
    const filtered = view === "sources" ? sources : notes.filter(note => view === "knowledge" ? note.reuse.kind === "knowledge" : note.category === view);
    return { view, page: pageOf(filtered.filter(note => matches(`${note.path}\n${note.title}\n${note.excerpt}`)), offset) };
  }
  async inspectPlan(id: string) {
    const entry = this.entry(id);
    try { await this.preview(id, entry.revision); } catch (error) { if (entry.status !== "stale") throw error; }
    return { plan: entry.plan, revision: entry.revision, status: entry.status, validationError: entry.validationError };
  }
  async setProjectPinned(path: string, pinned: boolean) {
    this.available();
    return this.track(this.vault.setProjectPinned(path, pinned));
  }
  previewRestore(id: string) { return this.vault.previewRestore(id); }
  async restoreConfirmed(id: string, expected: Awaited<ReturnType<VaultService["previewRestore"]>>, askHost: (message: string) => Promise<{ action: string; content?: Record<string, unknown> }>, signal: AbortSignal, authorization: SaveAuthorization = "user-request") {
    this.available();
    const current = await this.previewRestore(id);
    if (digest(current) !== digest(expected)) throw new Error("Restore preview changed; preview again");
    if (authorization !== "user-request") {
      signal.throwIfAborted();
      return { ...await this.track(this.vault.restore(id)), confirmation: authorization };
    }
    const response = await askHost(`恢复 ${id}\n目标：${current.path}\n版本：${current.version}\n--- 当前全文 ---\n${current.before}\n--- 恢复后全文 ---\n${current.after}\n仅确认以上准确恢复。`);
    signal.throwIfAborted(); this.available();
    const confirmation = confirmationOutcome(response);
    if (confirmation !== "accepted") return { status: "cancelled" as const, confirmation };
    return { ...await this.track(this.vault.restore(id)), confirmation };
  }
  projectContext(directory?: string) { return projectContext(this.projects, directory); }
  async projectSearch(query: string, directory?: string, allProjects = false, signal?: AbortSignal) {
    const context = this.projectContext(directory);
    const notes = await this.vault.list(query, signal);
    if (allProjects) return notes;
    const filtered = [];
    for (const note of notes) {
      if (note.category === "projects") {
        if (note.path === context.projectPath) filtered.push(note);
        continue;
      }
      const document = await this.vault.read(note.path, signal);
      const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document.content);
      const metadata = header ? parseDocument(header[1]) : undefined;
      if (metadata?.errors.length) continue;
      const projectPath = metadata?.get("projectPath");
      if (projectPath === undefined || projectPath === context.projectPath) filtered.push(note);
    }
    return filtered;
  }
  async search(query: string, signal?: AbortSignal, directory?: string, allProjects = false) {
    return (await this.projectSearch(query, directory, allProjects, signal)).slice(0, 20);
  }
  handoffTemplate() { return readFile(new URL("../skills/knowledge-handoff/assets/handoff-template.md", import.meta.url), "utf8"); }
  async captureHandoff(content: string, directory?: string, signal?: AbortSignal) {
    this.available();
    signal?.throwIfAborted();
    return this.track(this.vault.captureHandoff(content, this.projectContext(directory).projectPath, undefined, signal));
  }
  async captureHandoffFile(directory: string, path: string, signal?: AbortSignal) {
    this.available();
    return this.track((async () => {
      const project = projectBinding(this.projects, directory);
      const content = await readProjectHandoff(project, path, signal);
      this.available();
      return this.vault.captureHandoff(content, project!.projectPath, path, signal);
    })());
  }
  async read(path: string, signal?: AbortSignal) {
    const note = await this.vault.read(path, signal);
    return { ...note, reuse: noteReuse(note, this.listPlans()) };
  }
  async provenance(path: string, version: string, offset = 0, signal?: AbortSignal): Promise<NoteProvenance> {
    if (!/^[a-f0-9]{64}$/.test(version) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid note version or provenance offset");
    const note = await this.read(path, signal);
    if (note.version !== version) throw new Error("Note changed; reread the current version before tracing provenance");
    const saved = savedPlans(path, this.listPlans());
    if (offset > saved.length) throw new Error("Provenance offset exceeds saved history");
    const history: ProvenanceEntry[] = [];
    // One saved operation per page keeps a correction's complete before/after snippets together.
    for (const entry of saved.slice(offset, offset + 1)) {
      const { plan } = entry;
      const afterVersion = contentVersion(plan.after);
      let source: ProvenanceEntry["source"];
      if (plan.inbox) {
        try {
          const current = await this.vault.read(plan.inbox.path, signal);
          source = { ...plan.inbox, state: current.version === plan.inbox.version ? "unchanged" : "changed", currentVersion: current.version };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          source = { ...plan.inbox, state: "missing" };
        }
      }
      const sources: ProvenanceEntry["sources"] = plan.knowledge ? [] : undefined;
      for (const source of plan.knowledge?.sources ?? []) {
        let state: "unchanged" | "changed" | "missing", currentVersion: string | undefined;
        try { currentVersion = (await this.vault.read(source.path, signal)).version; state = currentVersion === source.version ? "unchanged" : "changed"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = "missing"; }
        sources!.push({ ...source, state, ...(currentVersion ? { currentVersion } : {}), evidence: plan.knowledge!.evidence.filter(ref => ref.path === source.path).map(({ path: _, ...ref }) => ref) });
      }
      history.push({ planId: plan.id, revision: entry.revision, savedAt: entry.result!.at,
        action: plan.correction ? "correct" : plan.create ? "create" : plan.inbox ? "append" : "update",
        beforeVersion: plan.version, afterVersion, matchesCurrent: afterVersion === note.version,
        ...(source ? { source } : {}), ...(sources ? { sources, issues: plan.knowledge!.issues } : {}), ...(plan.correction ? { changes: plan.correction.changes } : {}) });
    }
    signal?.throwIfAborted();
    if ((await this.vault.read(path, signal)).version !== version) throw new Error("Note changed while tracing provenance; reread it");
    return { path, version, reuse: note.reuse, history, total: saved.length, nextOffset: offset + history.length < saved.length ? offset + history.length : null };
  }
  private save(entry: KnowledgeProposal) { return this.vault.saveManagedPlan(entry); }
  private available() { if (this.stopping) throw new Error("Knowledge service is stopping"); }
  private entry(id: string, revision?: number) {
    const entry = this.proposals.get(id);
    if (!entry || (revision !== undefined && entry.revision !== revision)) throw new Error("Unknown or expired plan revision; generate a new plan");
    return entry;
  }
  private async track<T>(work: Promise<T>) {
    this.writes.add(work);
    try { return await work; } finally { this.writes.delete(work); }
  }

  private async register(plan: ChangePlan, owner?: ProposalOwner, kind: KnowledgeProposal["kind"] = "manual") {
    const entry: KnowledgeProposal = { schemaVersion: 1, plan, revision: 1, kind: owner?.kind ?? kind, owner,
      createdAt: new Date().toISOString(), status: "pending" };
    await this.save(entry);
    this.proposals.set(plan.id, entry);
    return entry;
  }
  async propose(input: InboxInput): Promise<KnowledgeProposal> {
    this.available();
    return this.track(this.vault.planInbox(input).then(plan => this.register(plan, undefined, "inbox")));
  }
  async proposeCorrection(input: CorrectionInput): Promise<KnowledgeProposal> {
    this.available();
    return this.track(this.vault.planCorrection(input).then(plan => this.register(plan, undefined, "inbox")));
  }

  async proposeKnowledge(input: KnowledgePlanInput, origin: "dsh" | "mcp" = "mcp"): Promise<KnowledgeProposal> {
    this.available();
    const baseline = savedPlans(input.targetPath, this.listPlans()).find(entry => entry.plan.knowledge)?.plan.after;
    return this.track(this.vault.planKnowledge(input, baseline, origin).then(plan => this.register(plan)));
  }

  async proposeBusiness(input: BusinessInput) {
    this.available();
    const parsed = businessInput.parse(input);
    const kind = parsed.operation === "daily" ? "daily" : parsed.operation.startsWith("project_") ? "project" : "goal";
    return this.track(planBusiness(this.vault, parsed).then(plan => this.register(plan, undefined, kind)));
  }
  dueReviews(date: string, offset = 0, signal?: AbortSignal) { return dueReviews(this.vault, date, offset, signal); }
  reviewPeriod(startDate: string, endDate: string, offset = 0, signal?: AbortSignal) { return periodReview(this.vault, startDate, endDate, offset, signal); }
  async proposeReview(input: z.infer<typeof reviewReportInput>) {
    this.available();
    return this.track(this.vault.planReviewReport(reviewReportInput.parse(input)).then(plan => this.register(plan, undefined, "report")));
  }
  async proposeArticle(input: z.infer<typeof articleInput>, signal?: AbortSignal) {
    this.available();
    const parsed = articleInput.parse(input);
    return this.track((async () => {
      const source = await prepareArticle({ ...parsed, url: parsed.kind === "url" ? parsed.url : "", content: parsed.kind === "markdown" ? parsed.content : "" }, signal);
      signal?.throwIfAborted(); this.available();
      const value = await this.vault.planArticleImport(parsed.title, source);
      return value.plan ? { proposal: await this.register(value.plan) } : { duplicate: value.duplicate };
    })());
  }
  async proposeSourceFile(input: z.infer<typeof sourceFileInput>, signal?: AbortSignal) {
    this.available();
    const parsed = sourceFileInput.parse(input);
    return this.track((async () => {
      const bytes = await readProjectSource(projectBinding(this.projects, parsed.projectDirectory), parsed.path, parsed.kind, signal);
      const source = parsed.kind === "pdf"
        ? await preparePdf({ ...parsed, base64: bytes.toString("base64") }, signal)
        : await prepareArticle({ ...parsed, kind: "markdown", url: "", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }, signal);
      signal?.throwIfAborted(); this.available();
      const value = "pages" in source ? await this.vault.planPdfImport(parsed.title, source) : await this.vault.planArticleImport(parsed.title, source);
      return value.plan ? { proposal: await this.register(value.plan) } : { duplicate: value.duplicate };
    })());
  }

  async preview(id: string, revision?: number): Promise<KnowledgeProposal> {
    const entry = this.entry(id, revision);
    if (entry.status === "pending") {
      try { await this.vault.checkPlan(entry.plan); }
      catch (error) { entry.status = "stale"; entry.validationError = error instanceof Error ? error.message : String(error); await this.save(entry); throw error; }
    }
    return entry;
  }
  async cancel(id: string, revision: number, owner?: ProposalOwner) {
    this.available();
    const entry = this.entry(id, revision);
    if (owner) this.checkOwner(entry, owner);
    if (entry.status === "pending") {
      entry.status = "cancelled";
      await this.track(this.save(entry).then(() => this.vault.cancelPlan(id)));
    }
    return entry;
  }
  async revise(id: string, revision: number, input: InboxInput) {
    this.available();
    return this.track(this.reviseInbox(id, revision, input));
  }
  async reviseCorrection(id: string, revision: number, input: CorrectionInput, owner?: ProposalOwner) {
    this.available();
    return this.track(this.reviseInbox(id, revision, input, owner, true));
  }
  private async reviseInbox(id: string, revision: number, input: InboxInput | CorrectionInput, owner?: ProposalOwner, correction = false) {
    const previous = this.entry(id, revision);
    if (owner) this.checkOwner(previous, owner);
    if (previous.kind !== "inbox" || previous.status !== "pending") throw new Error("Only a pending Inbox proposal can be revised");
    if (!!previous.plan.correction !== correction) throw new Error("Use the revision tool matching the original proposal type");
    const plan = correction ? await this.vault.planCorrection(input as CorrectionInput) : await this.vault.planInbox(input as InboxInput);
    if (previous.status !== "pending") { await this.vault.cancelPlan(plan.id); throw new Error("Previous proposal changed while revising"); }
    const next: KnowledgeProposal = { schemaVersion: 1, plan, revision: revision + 1, kind: "inbox", owner: previous.owner,
      createdAt: new Date().toISOString(), status: "pending", supersedes: id };
    previous.status = "superseded";
    previous.supersededBy = plan.id;
    await this.save(next); // Recovery uses supersedes to invalidate the old revision after an interrupted pair of saves.
    this.proposals.set(plan.id, next);
    await this.save(previous);
    await this.vault.cancelPlan(id);
    return next;
  }

  async requestConfirmation(id: string, revision: number,
    askHost: ((message: string) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>) | undefined,
    signal: AbortSignal, authorization: SaveAuthorization = "user-request"): Promise<KnowledgeProposal & { confirmation: ConfirmationOutcome }> {
    this.confirming++;
    try {
      this.available();
      const entry = await this.preview(id, revision);
      if (this.applications.has(id)) return { ...await this.applications.get(id)!, confirmation: "already-finished" };
      if (entry.status === "completed" || entry.status === "failed") return { ...entry, confirmation: "already-finished" };
      if (entry.status !== "pending") throw new Error(`Plan is ${entry.status}; it cannot be confirmed`);
      const review = writeReview(entry.plan);
      if (!review || authorization !== "user-request") {
        return { ...await this.submit(entry, signal), confirmation: authorization === "user-request" ? "not-required" : authorization };
      }
      if (!askHost) return { ...entry, confirmation: "required" };
      const response = await askHost(`${review}\n${previewText(entry)}`);
      signal.throwIfAborted();
      this.available();
      const confirmation = confirmationOutcome(response);
      if (confirmation !== "accepted") return { ...entry, confirmation };
      return { ...await this.submit(entry, signal), confirmation };
    } finally { this.confirming--; }
  }

  private async submit(entry: KnowledgeProposal, signal: AbortSignal, check = () => {}) {
    const id = entry.plan.id;
    if (this.applications.has(id)) return this.applications.get(id)!;
    if (entry.status === "completed" || entry.status === "failed") return entry;
    if (entry.status !== "pending") throw new Error(`Plan is ${entry.status}; it cannot be confirmed`);
    const work = (async () => {
      await this.preview(id, entry.revision);
      this.available();
      signal.throwIfAborted();
      check();
      if (entry.status !== "pending") throw new Error(`Plan is ${entry.status}; it cannot be confirmed`);
      entry.status = "applying";
      await this.save(entry); // Persist intent before the first possible content write.
      try {
        entry.result = await this.vault.execute(id, () => { signal.throwIfAborted(); check(); });
        entry.status = entry.result.status;
        await this.save(entry);
        return entry;
      } catch (error) {
        entry.status = "needs-reconciliation";
        await this.save(entry);
        throw error;
      }
    })();
    this.applications.set(id, work);
    try { return await this.track(work); }
    finally { this.applications.delete(id); }
  }

  private checkOwner(entry: KnowledgeProposal, owner?: ProposalOwner) {
    if (JSON.stringify(entry.owner) !== JSON.stringify(owner)) throw new Error("请通过原管家方案卡片预览并确认；方案归属或类型不匹配。");
  }
  private issueTicket(channel: string, entry: KnowledgeProposal) {
    const previous = this.tickets.get(`${channel}:${entry.plan.id}`);
    const fingerprint = digest([entry.plan, entry.revision]);
    if (previous?.digest === fingerprint) return previous.token;
    const token = randomUUID();
    this.tickets.set(`${channel}:${entry.plan.id}`, { token, digest: fingerprint });
    return token;
  }

  async host(request: HostRequest, signal: AbortSignal): Promise<HostReply> {
    return this.track(this.hostRequest(request, signal));
  }

  private async hostRequest(request: HostRequest, signal: AbortSignal): Promise<HostReply> {
    this.available();
    signal.throwIfAborted();
    const { method, args, owner, channel } = request;
    if (method === "planKnowledge") {
      const entry = await this.proposeKnowledge(args[0] as KnowledgePlanInput, "dsh");
      return { value: entry, ticket: this.issueTicket(channel, entry) };
    }
    if (method === "collectKnowledge") return { value: await this.collectKnowledge(args[0] as KnowledgeCollectInput, signal) };
    if (method === "queryKnowledge") return { value: await this.queryKnowledge(args[0] as KnowledgeQueryInput, signal) };
    if (method === "saveRequested") return { value: await this.requestConfirmation(z.string().uuid().parse(args[0]), z.number().int().positive().parse(args[1]), undefined, signal,
      z.enum(["user-request", "user-confirmed", "full-access"]).parse(args[2])) };
    if (method === "management") return { value: await this.management(args[0] as ManagementView, args[1] as string, args[2] as number, signal) };
    if (method === "inspectPlan") return { value: await this.inspectPlan(args[0] as string) };
    if (method === "setProjectPinned") return { value: await this.setProjectPinned(args[0] as string, args[1] as boolean) };
    if (method === "previewRestore") {
      const value = await this.previewRestore(args[0] as string);
      const displayed = this.displayedOperations.get(channel) ?? new Set<string>(); displayed.add(value.operationId); this.displayedOperations.set(channel, displayed);
      return { value };
    }
    if (method === "read") return { value: await this.read(args[0] as string, signal) };
    if (method === "provenance") return { value: await this.provenance(args[0] as string, args[1] as string, args[2] as number | undefined, signal) };
    if (method === "reviseCorrection") return { value: await this.reviseCorrection(args[0] as string, args[1] as number, args[2] as CorrectionInput, owner) };
    if (method === "projectContext") return { value: this.projectContext(args[0] as string | undefined) };
    if (method === "projectSearch") return { value: await this.projectSearch(args[0] as string, args[1] as string | undefined, args[2] as boolean | undefined, signal) };
    if (method === "handoffTemplate") return { value: await this.handoffTemplate() };
    if (method === "captureHandoff") return { value: await this.captureHandoff(args[0] as string, args[1] as string | undefined, signal) };
    if (method === "captureHandoffFile") return { value: await this.captureHandoffFile(args[0] as string, args[1] as string, signal) };
    if (readMethods.includes(method as typeof readMethods[number])) {
      const fn = this.vault[method as typeof readMethods[number]] as (...args: unknown[]) => Promise<unknown>;
      return { value: await fn.apply(this.vault, args) };
    }
    if (planMethods.includes(method as PlanMethod)) {
      const fn = this.vault[method as PlanMethod] as (...args: unknown[]) => Promise<unknown>;
      const value = await this.track(fn.apply(this.vault, args));
      const imported = value as { plan?: ChangePlan; duplicate?: unknown };
      const plan = imported.duplicate ? undefined : imported.plan ?? value as ChangePlan;
      if (!plan) return { value };
      const entry = await this.register(plan, owner);
      return { value, ticket: owner ? undefined : this.issueTicket(channel, entry) };
    }
    if (method === "capture") return { value: await this.track(this.vault.capture(args[0] as string, args[1] as string)) };
    if (method === "listPlans") return { value: this.listPlans() };
    if (method === "status") return { value: this.status() };
    if (method === "activity") {
      const results = await this.vault.activity();
      this.displayedOperations.set(channel, new Set(results.map(item => item.id)));
      return { value: results };
    }
    if (method === "restore") {
      const id = args[0] as string;
      if (!this.displayedOperations.get(channel)?.has(id)) throw new Error("Open the activity log before confirming a restore");
      return { value: await this.track(this.vault.restore(id)) };
    }
    if (method === "owns") return { value: !!this.proposals.get(args[0] as string)?.owner };
    const entry = this.entry(args[0] as string);
    this.checkOwner(entry, owner);
    if (method === "previewPlan") {
      try { await this.preview(entry.plan.id, entry.revision); }
      catch (error) { if (!owner || entry.status !== "stale") throw error; }
      return { value: entry, ticket: entry.status === "pending" ? this.issueTicket(channel, entry) : undefined };
    }
    if (method === "cancelPlan") return { value: await this.cancel(entry.plan.id, entry.revision, owner) };
    if (method !== "execute") throw new Error("Unknown host operation");
    if (!["pending", "applying", "completed", "failed"].includes(entry.status)) throw new Error(entry.status === "cancelled" ? "方案已取消，不能确认。" : `Plan is ${entry.status}; it cannot be confirmed`);
    if (entry.status !== "completed" && entry.status !== "failed") {
      const displayed = this.tickets.get(`${channel}:${entry.plan.id}`);
      if (!displayed || displayed.token !== request.ticket || displayed.digest !== digest([entry.plan, entry.revision])) throw new Error("Preview the exact current proposal again before confirming");
    }
    try { return { value: await this.submit(entry, signal) }; }
    catch (error) { if (owner && entry.status === "stale") return { value: entry }; throw error; }
  }

  async stop() { this.stopping = true; await Promise.allSettled([...this.writes]); }
}

export function previewText(entry: KnowledgeProposal): string {
  const { plan } = entry;
  return `知识方案 ${plan.id} · 修订 ${entry.revision} · ${entry.status}\n`
    + `目标：${plan.path}\n操作：${plan.correction ? "纠正已有知识" : plan.create ? "新建" : plan.inbox ? "追加" : "修改"}\n目标原版本：${plan.version}\n`
    + (plan.inbox ? `来源：${plan.inbox.path}\n来源版本：${plan.inbox.version}\n理由：${plan.inbox.reason}\n` : "")
    + (plan.knowledge ? `知识整理 · ${plan.knowledge.sources.length} 个来源\n${plan.knowledge.sources.map(source => `${source.path} · ${source.version}`).join("\n")}\n${plan.knowledge.issues.map(issue => issue.reason).join("\n")}\n` : "")
    + (plan.correction ? plan.correction.changes.map((change, i) => `--- 替换 ${i + 1} 原结论 ---\n${change.before}\n--- 采用结论 ---\n${change.after || "（删除）"}\n`).join("") + "未列入替换的内容和属性保留；请同时核对来源依据及下方前后全文。\n" : "")
    + (entry.validationError ? `失效原因：${entry.validationError}\n` : "")
    + `--- 原文开始 ---\n${plan.before}\n--- 原文结束 ---\n`
    + `--- 保存后全文开始 ---\n${plan.after}\n--- 保存后全文结束 ---\n`
    + (writeReview(plan) ? `注意：${writeReview(plan)}。普通权限需确认；用户已确认或 Full access 可直接执行。` : "普通新增、追加或小修改：用户的保存请求已授权，可直接保存，不再二次确认。");
}
