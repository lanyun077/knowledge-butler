import { z } from "zod";
import type { SourceProcessing } from "./knowledge-synthesis";

const path = z.string().min(1).max(4096);
const offset = z.number().int().nonnegative().default(0);
export const knowledgeCollectInput = z.object({
  topicPath: path.optional(), projectPaths: z.array(path).default([]), learningPaths: z.array(path).default([]),
  sourcePaths: z.array(path).default([]), excludePaths: z.array(path).default([]), offset,
  request: z.string().trim().min(1).max(100000).optional(),
}).strict();
export const knowledgeQueryInput = z.object({
  topicPath: path, view: z.enum(["graph", "mindmap", "document"]).default("graph"),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional(), offset,
}).strict();
export type KnowledgeCollectInput = z.input<typeof knowledgeCollectInput>;
export type KnowledgeQueryInput = z.input<typeof knowledgeQueryInput>;

export interface KnowledgeNote { path: string; version: string; title: string; category: string; summary: string }
export interface KnowledgeLink {
  sourcePath: string; target: string; targetPath?: string; fragment?: string; label?: string; line?: number;
  origin: "markdown" | "obsidian";
  format?: "wiki" | "markdown";
  state: "resolved" | "ambiguous" | "missing" | "outside-scope" | "unsupported" | "excluded" | "not-selected";
}
export interface KnowledgeOutline { title: string; depth: number; line: number }
export interface KnowledgeNative { state: "not-requested" | "not-configured" | "available" | "unavailable"; reason?: string }
export interface KnowledgePage<T> { items: T[]; total: number; nextOffset: number | null }
export interface KnowledgeCollection {
  sources: KnowledgePage<KnowledgeNote & { selected: boolean; linkedFrom: string[]; linkedFromTotal: number; processing?: SourceProcessing }>;
  links: KnowledgePage<KnowledgeLink>;
  unavailable: KnowledgePage<{ path: string; reason: string }>;
  existingTopic?: KnowledgeNote;
  processing: "not-assessed" | "assessed";
  reuse?: { state: "no-topic" | "ordinary" | "invalid" | "unsupported" | "different-request" | "update-needed" | "reusable";
    reason?: string; removedSources: number; counts: Record<SourceProcessing["state"], number>; unavailable: number };
  template?: { id: string; uri: string; markdown: string };
  native: KnowledgeNative;
  nextOffset: number | null;
}
export interface KnowledgeQuery {
  topic: KnowledgeNote; view: "graph" | "mindmap" | "document";
  nodes: KnowledgePage<KnowledgeNote>; links: KnowledgePage<KnowledgeLink>; outline: KnowledgePage<KnowledgeOutline>;
  native: KnowledgeNative; nextOffset: number | null;
  organized?: KnowledgeTopicPage;
}

const topicItem = z.object({ id: z.string(), title: z.string().max(240), group: z.string().max(240), summary: z.string().max(400), evidence: z.string().max(600) });
const topicRelation = z.object({ from: z.string(), to: z.string(), type: z.enum(["引用", "包含", "前置依赖", "应用于", "补充", "冲突", "相关"]),
  inferred: z.boolean(), evidence: z.string().max(600) });
export const knowledgeTopicPage = z.object({
  items: z.object({ items: z.array(topicItem), total: z.number(), nextOffset: z.number().nullable() }),
  relations: z.object({ items: z.array(topicRelation), total: z.number(), nextOffset: z.number().nullable() }),
  endpoints: z.array(topicItem), invalidRelations: z.number(),
});
export type KnowledgeTopicItem = z.infer<typeof topicItem>;
export type KnowledgeTopicRelation = z.infer<typeof topicRelation>;
export type KnowledgeTopicPage = z.infer<typeof knowledgeTopicPage>;
