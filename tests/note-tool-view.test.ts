import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { NoteToolView } from "../src/note-tool-view";
import { referenceHash } from "../src/references";

describe("durable note tool cards", () => {
  function render(meta: unknown, isError = false, toolName = "learning_read") {
    return renderToStaticMarkup(createElement(NoteToolView, { openReference: () => {}, toolName, block: {
      kind: "tool-result", content: [{ type: "text", text: "read result" }], meta, isError,
    } } as ToolCallViewProps & { openReference: () => void }));
  }
  it("renders result-time references and handles missing or malformed metadata", () => {
    const reference = { path: "Wiki/test.md", version: "v1", scope: "test-vault" };
    expect(render({ references: [reference] })).toContain(referenceHash(reference).replaceAll("&", "&amp;"));
    expect(render(undefined)).toContain("没有可用的笔记引用");
    expect(render({ references: [null, {}, 1] })).toContain("没有可用的笔记引用");
    expect(render({ references: [reference] }, true)).not.toContain("href=");
    expect(render(undefined, true)).toContain("read result");
  });
  it("distinguishes source claims, recorded current knowledge and unrecorded changes on read and provenance cards", () => {
    const source = render({ reuse: { kind: "source", savedVersion: "unrecorded" } });
    expect(source).toContain("来源材料 · 不代表已确认知识");
    expect(source).not.toContain("当前版本有保存记录");
    expect(render({ reuse: { kind: "knowledge", savedVersion: "recorded" } })).toContain("当前版本有保存记录");
    expect(render({ reuse: { kind: "knowledge", savedVersion: "unrecorded" } })).toContain("当前版本无保存记录");
    const trace = render({ references: [{ path: "Inbox/handoff.md", version: "old-source", scope: "vault" }], reuse: { kind: "knowledge", savedVersion: "recorded" } }, false, "learning_provenance");
    expect(trace).toContain("知识来源与纠正记录");
    expect(trace).toContain("Inbox/handoff.md");
    expect(trace).not.toContain("确认保存");
  });
  it("labels period review sources without presenting undated current snapshots as period accomplishments", () => {
    const reference = { path: "Projects/demo.md", version: "v1", scope: "test-vault" };
    const html = render({ references: [reference] }, false, "learning_review_period");
    expect(html).toContain("汇总资料来源");
    expect(html).toContain("日期范围只适用于 Daily");
    expect(html).toContain("项目和学习笔记是当前快照");
    expect(html).toContain(referenceHash(reference).replaceAll("&", "&amp;"));
  });
  it("shows accessible read-time checklist progress, distinguishes zero/no tasks and rejects malformed counts", () => {
    const partial = render({ tasks: { completed: 3, total: 5 } });
    expect(partial).toContain('role="progressbar"');
    expect(partial).toContain('aria-valuemax="5"');
    expect(partial).toContain('aria-valuenow="3"');
    expect(partial).toContain("60%");
    expect(partial).toContain("读取时的清单快照");
    expect(render({ tasks: { completed: 0, total: 5 } })).toContain("0%");
    const empty = render({ tasks: { completed: 0, total: 0 } });
    expect(empty).toContain("尚无任务清单");
    expect(empty).not.toContain("progressbar");
    expect(render({ tasks: { completed: 5, total: 5 } })).toContain("清单已完成");
    const almost = render({ tasks: { completed: 199, total: 200 } });
    expect(almost).toContain("99%"); expect(almost).not.toContain("100%");
    expect(almost).toContain("width:99.5%");
    expect(render({ tasks: { completed: 7, total: 5 } })).not.toContain("progressbar");
    expect(render({ tasks: { completed: 3, total: 5 } }, true)).not.toContain("progressbar");
  });
});
