import { z } from "zod";
import { knowledgePlanMetadata } from "./knowledge-synthesis-contract";
import { knowledgeTopicPage } from "./knowledge-organization-contract";
import { starPage } from "./knowledge-stars";

export const managerUri = "ui://learning-os/manager-u2-v4-interaction-3.html";
export const managerMime = "text/html;profile=mcp-app";
export const managerViews = ["home", "plans", "sources", "knowledge", "projects", "learning", "activity", "records", "settings"] as const;
export const managerInput = z.object({
  view: z.enum([...managerViews, "universe", "summary", "detail", "topic"]).default("home"),
  query: z.string().max(500).default(""), offset: z.number().int().nonnegative().default(0),
  path: z.string().min(1).optional(), version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  historyOffset: z.number().int().nonnegative().default(0),
}).strict();
export type ManagerInput = z.input<typeof managerInput>;
const pageFields = { total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() };
const reuse = z.object({ kind: z.enum(["source", "knowledge", "context", "unknown"]), sourceType: z.string().optional(),
  savedVersion: z.enum(["recorded", "unrecorded"]), metadataError: z.string().optional(),
  record: z.object({ planId: z.string(), revision: z.number(), savedAt: z.string() }).optional() });
const plan = z.object({ planId: z.string(), revision: z.number(), path: z.string(), kind: z.string(), status: z.string(),
  createdAt: z.string(), action: z.string(), origin: z.enum(["dsh", "mcp"]), validationError: z.string().optional(),
  source: z.object({ path: z.string(), version: z.string() }).optional(), sourceCount: z.number().int().nonnegative().optional() });
const note = z.object({ path: z.string(), title: z.string(), category: z.string(), excerpt: z.string(), version: z.string(), reuse,
  status: z.string().optional(), metadataError: z.string().optional(), savedAt: z.string().optional(), sourceStatus: z.string().optional(),
  tasks: z.object({ completed: z.number(), total: z.number() }).optional(), progressExcerpt: z.string().optional(), pinned: z.boolean().optional(),
  relatedPlans: z.array(z.object({ planId: z.string(), revision: z.number(), path: z.string(), status: z.string() })) });
const activity = z.object({ id: z.string(), path: z.string(), kind: z.string(), status: z.string(), at: z.string(), error: z.string().optional() });
export const managerRecord = z.object({ recordId: z.string(), path: z.string(), title: z.string(), summary: z.string(),
  savedAt: z.string().optional(), origin: z.string().optional(), sourcePath: z.string().optional(), sourceState: z.string().optional(),
  sourceCount: z.number().int().nonnegative().optional(),
  status: z.string(), operationId: z.string().optional(), operationKind: z.string().optional(), error: z.string().optional() });
const recordPage = z.object({ ...pageFields, items: z.array(managerRecord) });
const notePage = z.object({ ...pageFields, items: z.array(note) });
const management = z.object({
  view: z.enum(managerViews),
  home: z.object({ pending: z.object({ ...pageFields, items: z.array(plan) }), sources: notePage, pinned: notePage, missingPins: z.array(z.string()),
    records: recordPage, knowledge: notePage, learning: notePage }).optional(),
  page: z.object({ ...pageFields, items: z.array(z.union([note, plan, activity, managerRecord])) }).optional(),
  settings: z.object({ service: z.object({ vaultId: z.string(), instanceId: z.string(), stopping: z.boolean(), pending: z.number() }),
    folders: z.record(z.string(), z.string()), projects: z.array(z.object({ directory: z.string(), projectPath: z.string(), fileSubmission: z.boolean() })) }).optional(),
});
const provenance = z.object({ path: z.string(), version: z.string(), reuse, ...pageFields,
  history: z.array(z.object({ planId: z.string(), revision: z.number(), savedAt: z.string(), action: z.string(),
    beforeVersion: z.string(), afterVersion: z.string(), matchesCurrent: z.boolean(),
    source: z.object({ path: z.string(), version: z.string(), state: z.enum(["unchanged", "changed", "missing"]), currentVersion: z.string().optional(), reason: z.string() }).optional(),
    sources: z.array(z.object({ ...knowledgePlanMetadata.shape.sources.element.shape,
      state: z.enum(["unchanged", "changed", "missing"]), currentVersion: z.string().optional(),
      evidence: z.array(z.object({ item: z.string(), start: z.number(), end: z.number(), preview: z.string().max(200), truncated: z.boolean() })) })).optional(),
    issues: knowledgePlanMetadata.shape.issues.optional(),
    changes: z.array(z.object({ before: z.string(), after: z.string() })).optional() })) });
export const managerSnapshot = z.object({
  stage: z.literal("U2"), resourceVersion: z.literal("u2-v4"), libraryId: z.string(), readAt: z.string(), request: managerInput,
  canConfirm: z.boolean().default(false),
  management: management.optional(),
  sky: starPage.optional(),
  topic: z.object({ path: z.string(), title: z.string(), summary: z.string(), version: z.string(), openUri: z.string(),
    organized: knowledgeTopicPage.optional(), nextOffset: z.number().nullable(),
    notes: z.array(z.object({ path: z.string(), title: z.string(), summary: z.string() })),
    links: z.array(z.object({ sourcePath: z.string(), targetPath: z.string().optional(), state: z.string() })),
    outline: z.array(z.object({ title: z.string(), depth: z.number(), line: z.number() })),
  }).optional(),
  detail: z.object({ path: z.string(), title: z.string(), category: z.string(), version: z.string(), reuse,
    summary: z.string().max(400).optional(), openUri: z.string().optional(),
    content: z.string(), offset: z.number(), total: z.number(), nextOffset: z.number().nullable(),
    provenance, relatedPlans: z.array(plan) }).optional(),
});
export type ManagerSnapshot = z.infer<typeof managerSnapshot>;
export type ManagerRecord = z.infer<typeof managerRecord>;

const confirmation = z.enum(["accepted", "declined", "cancelled", "unchecked", "already-finished", "not-required", "user-confirmed", "full-access", "required"]);
const savedOperation = { id: z.string(), kind: z.enum(["capture", "update", "restore"]), at: z.string() };
const sourceSnapshot = z.object({ sourceName: z.string(), hash: z.string(), content: z.string(), snapshotPath: z.string() });
export const managerPlan = z.object({
  schemaVersion: z.literal(1).optional(), createdAt: z.string().optional(), supersedes: z.string().optional(), supersededBy: z.string().optional(),
  plan: z.object({ id: z.string().uuid(), path: z.string(), before: z.string(), after: z.string(), version: z.string(),
    create: z.boolean().optional(), knowledge: knowledgePlanMetadata.optional(), origin: z.enum(["dsh", "mcp"]).optional(), inbox: z.object({ path: z.string(), version: z.string(), reason: z.string() }).optional(),
    correction: z.object({ changes: z.array(z.object({ before: z.string(), after: z.string() })) }).optional(),
    article: sourceSnapshot.optional(), chat: sourceSnapshot.optional(),
    pdf: z.object({ sourceName: z.string(), hash: z.string(), base64: z.string(), snapshotPath: z.string() }).optional(),
    report: z.object({ startDate: z.string(), endDate: z.string(), collectedAt: z.string(), total: z.number(),
      missingDailyDates: z.array(z.string()), excludedDailyNotes: z.number(),
      sources: z.array(z.object({ path: z.string(), version: z.string(), timeBasis: z.enum(["daily-date", "current-snapshot"]), date: z.string().optional() })) }).optional() }),
  revision: z.number().int().positive(), kind: z.string(), status: z.string(), validationError: z.string().optional(),
  owner: z.object({ scope: z.string(), sessionId: z.string(), cwd: z.string(), kind: z.string() }).optional(),
  confirmation: confirmation.optional(),
  result: z.object({ ...savedOperation, path: z.string(), status: z.string(), error: z.string().optional() }).optional(),
});
export const managerRestore = z.object({ operationId: z.string().uuid(), path: z.string(), version: z.string(), before: z.string(), after: z.string() });
export const managerOperationResult = z.object({ id: savedOperation.id.optional(), kind: savedOperation.kind.optional(), at: savedOperation.at.optional(),
  status: z.string(), confirmation, path: z.string().optional(), error: z.string().optional() });
export const managerPinResult = z.object({ status: z.enum(["completed", "cancelled"]), confirmation, paths: z.array(z.string()).optional() });
export type ManagerPlan = z.infer<typeof managerPlan>;
export type ManagerRestore = z.infer<typeof managerRestore>;
