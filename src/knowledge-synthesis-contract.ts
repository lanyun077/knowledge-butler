import { z } from "zod";

export const knowledgeTemplateId = "knowledge-organize-v1" as const;
export const knowledgeTemplateUri = `learning://templates/${knowledgeTemplateId}`;
const path = z.string().min(1).max(4096);
const text = z.string().trim().min(1).max(100000);
const title = z.string().trim().min(1).max(240).regex(/^[^\r\n]+$/);
const range = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .refine(value => value.end > value.start, "Range end must follow start");
const source = z.object({ path, version: z.string().regex(/^[a-f0-9]{64}$/), total: z.number().int().nonnegative(), ranges: z.array(range) }).strict()
  .refine(value => value.ranges.every(range => range.end <= value.total), "Processed ranges exceed source length");
export const knowledgeMetadata = z.object({ type: z.literal("knowledge-topic"), template: z.literal(knowledgeTemplateId), request: text, sources: z.array(source).min(1) })
  .refine(value => new Set(value.sources.map(source => source.path)).size === value.sources.length, "Duplicate knowledge source");
const evidence = z.object({ path, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(100000) }).strict();
const blockId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const knowledgeDraft = z.object({
  template: z.literal(knowledgeTemplateId), request: text, title, summary: text,
  sources: z.array(source).min(1),
  groups: z.array(z.object({ title, items: z.array(z.object({ id: blockId, title, content: text, evidence: z.array(evidence) }).strict()).min(1) }).strict()).min(1),
  relations: z.array(z.object({ from: blockId, to: blockId, type: z.enum(["引用", "包含", "前置依赖", "应用于", "补充", "冲突", "相关"]),
    origin: z.enum(["explicit", "inferred"]), reason: text, evidence: z.array(evidence) }).strict()).default([]),
  unknowns: z.array(text).default([]),
}).strict();
export type KnowledgeDraft = z.input<typeof knowledgeDraft>;
export const knowledgePlanInput = z.object({ targetPath: path, targetVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(), draft: knowledgeDraft,
  replacements: z.array(z.object({ key: z.string().regex(/^[a-z0-9-]+$/), before: z.string() }).strict()).default([]) }).strict();
export type KnowledgePlanInput = z.input<typeof knowledgePlanInput>;
export const knowledgePlanMetadata = z.object({ ...knowledgeMetadata.shape,
  issues: z.array(z.object({ item: z.string(), reason: z.string() }).strict()),
  evidence: z.array(z.object({ item: z.string(), ...evidence.shape }).strict()),
  changes: z.array(z.object({ before: z.string(), after: z.string() }).strict()),
}).strict();
export type KnowledgePlanMetadata = z.infer<typeof knowledgePlanMetadata>;
export type KnowledgeMetadata = z.infer<typeof knowledgeMetadata>;
export type KnowledgeMetadataResult = { state: "ordinary" | "invalid" | "unsupported"; reason?: string } | { state: "valid"; value: KnowledgeMetadata };
export type SourceProcessing = { state: "unprocessed" | "reusable" | "partial" | "changed"; processedUnits: number; total: number; nextRange?: { start: number; end: number } };
