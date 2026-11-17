// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessPanel, type BusinessApi } from "../src/business-panel";
import type { NoteDocument, ChangeResult } from "../src/vault";
import { TextDecoder } from "node:util";
import type { Page } from "../src/workspace";
import type { NoteReference } from "../src/references";

const first: NoteDocument = { path: "Inbox/first.md", title: "第一篇", category: "inbox", excerpt: "原始正文", content: "---\ntitle: 原始\n---\n原始正文\n", version: "v1" };
const second: NoteDocument = { ...first, path: "Inbox/second.md", title: "第二篇", content: "第二篇正文" };
const project: NoteDocument = { path: "Projects/demo.md", title: "学习助手", category: "projects", excerpt: "目标", content: "# 学习助手\n\n## Progress\n\n已有进展\n\n## Logs\n\n旧日志\n", version: "project-v1" };
const change: ChangeResult = { id: "operation-1", path: first.path, kind: "update", status: "completed", at: "2026-09-22T12:00:00Z" };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("TextDecoder", TextDecoder);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function fixture() {
  let saved = { ...first };
  let history: ChangeResult[] = [];
  const api = {
    list: vi.fn(async () => [saved, second, project]),
    read: vi.fn(async (path: string) => path === first.path ? saved : path === project.path ? project : second),
    capture: vi.fn(async (title: string, content: string) => ({ ...first, title, content })),
    planPdfImport: vi.fn<BusinessApi["planPdfImport"]>(async () => ({ plan: { id: "pdf-plan", path: "Inbox/PDF.md", version: "", before: "", after: "PDF 第 1 页", create: true } })),
    readPdf: vi.fn<BusinessApi["readPdf"]>(async () => ({ base64: "JVBERi0=", pages: 2, sourceName: "sample.pdf" })),
    planArticleImport: vi.fn<BusinessApi["planArticleImport"]>(async input => ({ plan: { id: "article-plan", path: `Inbox/${input.title}.md`, version: "", before: "", after: input.content, create: true } })),
    planChatImport: vi.fn<BusinessApi["planChatImport"]>(async input => ({ plan: { id: "chat-plan", path: `Inbox/${input.title}.md`, version: "", before: "", after: input.content, create: true } })),
    cancelPlan: vi.fn(async () => {}),
    planUpdate: vi.fn(async (path: string, version: string, content: string) => ({ id: "plan-1", path, version, before: saved.content, after: content })),
    planDailyAppend: vi.fn(async (date: string, content: string) => ({ id: "daily-plan-1", path: `Daily/${date}.md`, version: "", before: "", after: `# ${date}\n\n${content}\n`, create: true })),
    planProjectAppend: vi.fn(async (path: string, version: string, content: string) => ({ id: "project-plan-1", path, version, before: project.content, after: `${project.content}\n${content}\n` })),
    planProjectStatus: vi.fn(async (path: string, version: string, status: string) => ({ id: "status-plan-1", path, version, before: project.content, after: `---\nstatus: ${status}\n---\n${project.content}` })),
    planLearningGoal: vi.fn(async (goal) => ({ id: "goal-plan-1", path: `Learning/${goal.title}.md`, version: "", before: "", after: `# ${goal.title}\n${goal.outcome}\n${goal.verification}`, create: true })),
    execute: vi.fn(async () => {
      if (api.planDailyAppend.mock.calls.length) {
        const [date] = api.planDailyAppend.mock.calls.at(-1)!;
        const daily: ChangeResult = { ...change, id: "daily-plan-1", path: `Daily/${date}.md` };
        history = [daily];
        return daily;
      }
      if (api.planProjectAppend.mock.calls.length) {
        const [path] = api.planProjectAppend.mock.calls.at(-1)!;
        const updated: ChangeResult = { ...change, id: "project-plan-1", path };
        history = [updated];
        return updated;
      }
      const call = api.planUpdate.mock.calls.at(-1)!;
      saved = { ...saved, content: call[2], version: "v2" };
      history = [change];
      return change;
    }),
    previewRestore: vi.fn(async (operationId: string) => ({ operationId, path: saved.path, version: saved.version, before: saved.content, after: first.content })),
    restore: vi.fn(async () => {
      saved = { ...first };
      const restored: ChangeResult = { ...change, id: "operation-2", kind: "restore" };
      history.push(restored);
      return restored;
    }),
    activity: vi.fn(async () => history),
    openObsidian: vi.fn(async (path: string) => ({ path })),
  } satisfies BusinessApi;
  return api;
}

async function render(api: BusinessApi, page: Page = "Inbox", draftKey?: string, noteReference?: NoteReference) {
  await act(async () => root.render(createElement(BusinessPanel, { api, page, draftKey, noteReference, key: draftKey })));
}

describe("管家笔记引用", () => {
  it("reads the chosen PDF bytes without sessionStorage, previews, cancels and retains the file", async () => {
    const api = fixture(); await render(api); await click("导入 PDF");
    const picker = container.querySelector<HTMLInputElement>('[aria-label="选择 PDF 文件"]')!;
    const bytes = "%PDF-1.7\nfixture";
    Object.defineProperty(picker, "files", { configurable: true, value: [new File([bytes], "来源.pdf", { type: "application/pdf" })] });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
    await click("预览 PDF 导入");
    expect(api.planPdfImport).toHaveBeenCalledWith({ title: "来源", sourceName: "来源.pdf", base64: btoa(bytes) });
    expect(api.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStorage)).not.toContain(btoa(bytes));
    await click("取消 PDF 导入");
    expect(api.cancelPlan).toHaveBeenCalledWith("pdf-plan");
    await click("预览 PDF 导入");
    expect(api.planPdfImport).toHaveBeenCalledTimes(2);
  });

  it("opens PDF pages from the authenticated original and releases the Blob URL when leaving", async () => {
    const api = fixture();
    const note = { ...first, content: '---\ntype: "pdf-source"\n---\n# PDF\n' };
    api.read.mockResolvedValueOnce(note);
    const create = vi.fn(() => "blob:pdf-original"), revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    await render(api); await click("第一篇"); await click("加载原 PDF 与页码链接");
    expect(api.readPdf).toHaveBeenCalledWith(note.path, note.version);
    const select = container.querySelector<HTMLSelectElement>('[aria-label="原 PDF 页码"]')!;
    await act(async () => { select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(Array.from(container.querySelectorAll("a")).find(a => a.textContent === "打开所选页")?.getAttribute("href")).toBe("blob:pdf-original#page=2");
    await click("第二篇");
    expect(revoke).toHaveBeenCalledWith("blob:pdf-original");
  });

  it("keeps article input on fetch failure/cancel, restores it, and opens duplicates without writing", async () => {
    const api = fixture();
    await render(api, "Inbox", "article-draft");
    await click("导入网页／Markdown");
    await input(container.querySelector('[aria-label="文章标题"]')!, "文章测试");
    await input(container.querySelector('[aria-label="网页网址"]')!, "https://example.com/article");
    api.planArticleImport.mockRejectedValueOnce(new Error("HTTP 403"));
    await click("预览文章导入");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("403");
    expect(container.querySelector<HTMLInputElement>('[aria-label="网页网址"]')!.value).toBe("https://example.com/article");
    await click("预览文章导入");
    expect(api.execute).not.toHaveBeenCalled();
    await click("取消文章导入");
    expect(api.cancelPlan).toHaveBeenCalledWith("article-plan");
    expect(container.querySelector<HTMLInputElement>('[aria-label="文章标题"]')!.value).toBe("文章测试");
    await act(async () => root.unmount()); root = createRoot(container);
    await render(api, "Inbox", "article-draft");
    await click("导入网页／Markdown");
    expect(container.querySelector<HTMLInputElement>('[aria-label="网页网址"]')!.value).toBe("https://example.com/article");
    api.planArticleImport.mockResolvedValueOnce({ duplicate: first });
    await click("预览文章导入");
    await click("查看已导入文章");
    expect(api.read).toHaveBeenCalledWith(first.path);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("confirms article intake explicitly, clears only its draft and renders external Markdown as literal source text", async () => {
    const api = fixture();
    await render(api, "Inbox", "article-save");
    await click("第一篇"); await click("编辑全文"); await input(editor(), "独立编辑草稿");
    await click("导入网页／Markdown");
    const select = container.querySelector<HTMLSelectElement>('[aria-label="文章输入方式"]')!;
    await act(async () => { select.value = "markdown"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await input(container.querySelector('[aria-label="文章标题"]')!, "文章测试");
    await input(container.querySelector('[aria-label="Markdown 正文"]')!, "![external](https://example.com/a.png)");
    api.planArticleImport.mockResolvedValueOnce({ plan: { id: "article-plan", path: "Inbox/文章测试.md", version: "", before: "", after: "# 文章测试\n\n```markdown\n![external](https://example.com/a.png)\n```", create: true } });
    await click("预览文章导入");
    expect(container.querySelector('[aria-label="确认文章导入"] img')).toBeNull();
    expect(api.execute).not.toHaveBeenCalled();
    api.execute.mockResolvedValueOnce({ ...change, path: "Inbox/文章测试.md" });
    await click("确认导入文章");
    expect(api.execute).toHaveBeenCalledWith("article-plan");
    expect(editor().value).toBe("独立编辑草稿");
    expect(JSON.parse(sessionStorage.getItem("dsh-learning-os:draft:article-save")!).articleInput.content).toBe("");
    expect(container.textContent).toContain("放弃修改并打开 Inbox/文章测试.md");
  });

  it("reads Markdown files with BOM/CRLF intact and retains the input after a bad file", async () => {
    const api = fixture(); await render(api); await click("导入网页／Markdown");
    const select = container.querySelector<HTMLSelectElement>('[aria-label="文章输入方式"]')!;
    await act(async () => { select.value = "markdown"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const fileInput = container.querySelector<HTMLInputElement>('[aria-label="选择 Markdown 文件"]')!;
    async function upload(file: File) {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
      await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); await new Promise<void>(resolve => setTimeout(resolve, 20)); });
    }
    const text = "\uFEFF# Article\r\nOriginal\r\n";
    await upload(new File([Buffer.from(text)], "文章.md"));
    await click("预览文章导入");
    expect(api.planArticleImport).toHaveBeenLastCalledWith({ kind: "markdown", title: "文章", sourceName: "文章.md", url: "", content: text });
    await click("取消文章导入");
    await upload(new File([new Uint8Array([0xff])], "invalid.md"));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click("预览文章导入");
    expect(api.planArticleImport.mock.lastCall![0].content).toBe(text);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("previews chat imports, cancels on the host and retains drafts while opening duplicates", async () => {
    const api = fixture();
    await render(api, "Inbox", "chat-vault");
    await click("导入聊天记录");
    await input(container.querySelector('[aria-label="聊天标题"]')!, "聊天测试");
    await input(container.querySelector('[aria-label="聊天原文"]')!, "用户：问题\n助手：回答");
    await click("预览聊天导入");
    expect(api.planChatImport).toHaveBeenLastCalledWith({ title: "聊天测试", sourceName: "粘贴文本", content: "用户：问题\n助手：回答" });
    expect(api.execute).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="确认聊天导入"]')?.textContent).toContain("用户：问题");
    await click("取消聊天导入");
    expect(api.cancelPlan).toHaveBeenCalledWith("chat-plan");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="聊天原文"]')!.value).toContain("助手：回答");
    api.planChatImport.mockResolvedValueOnce({ duplicate: first });
    await click("预览聊天导入");
    expect(container.querySelector('[aria-label="重复聊天记录"]')?.textContent).toContain(first.path);
    await click("查看已导入记录");
    expect(api.read).toHaveBeenCalledWith(first.path);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("requires chat confirmation, clears its saved draft and leaves an unrelated editor draft intact", async () => {
    const api = fixture();
    await render(api, "Inbox", "chat-save");
    await click("第一篇"); await click("编辑全文");
    await input(editor(), "未保存正文");
    await click("导入聊天记录");
    await input(container.querySelector('[aria-label="聊天标题"]')!, "聊天测试");
    await input(container.querySelector('[aria-label="聊天原文"]')!, "用户：问题");
    await click("预览聊天导入");
    api.execute.mockResolvedValueOnce({ ...change, id: "chat-plan", path: "Inbox/聊天测试.md" });
    await click("确认导入聊天记录");
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(api.execute).toHaveBeenCalledWith("chat-plan");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="聊天原文"]')!.value).toBe("");
    expect(editor().value).toBe("未保存正文");
    expect(container.textContent).toContain("放弃修改并打开 Inbox/聊天测试.md");
    expect(JSON.parse(sessionStorage.getItem("dsh-learning-os:draft:chat-save")!).chat.content).toBe("");
  });

  it("reads UTF-8 chat exports without changing BOM/CRLF and rejects unsupported or invalid files", async () => {
    const api = fixture();
    await render(api);
    await click("导入聊天记录");
    const fileInput = container.querySelector<HTMLInputElement>('[aria-label="选择聊天文本文件"]')!;
    async function upload(file: File) {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
      await act(async () => {
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      });
    }
    const content = "\uFEFF用户：问题\r\n助手：```代码```\r\n";
    await upload(new File([Buffer.from(content)], "聊天.md"));
    await click("预览聊天导入");
    expect(api.planChatImport).toHaveBeenLastCalledWith({ title: "聊天", sourceName: "聊天.md", content });
    await click("取消聊天导入");
    await upload(new File(["{}"], "chat.json"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(".txt 或 .md");
    await upload(new File([new Uint8Array([0xff, 0xfe])], "invalid.txt"));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(api.execute).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="聊天原文"]')!.value).toContain("用户：问题");
  });

  it("keeps status independent of checklist progress and refreshes the saved counts", async () => {
    const api = fixture();
    const partial = { ...project, status: "Completed", tasks: { completed: 3, total: 5 } };
    api.list.mockResolvedValue([partial]); api.read.mockResolvedValue(partial);
    await render(api, "项目", "vault-progress", { path: partial.path, version: partial.version, scope: "vault-progress" });
    expect(container.querySelector('.learning-note-row')?.getAttribute("aria-label")).toBe("学习助手 · 清单 3/5");
    expect(container.querySelector('.learning-status')?.textContent).toBe("已完成");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("3");
    expect(container.querySelector('.learning-document-progress')?.textContent).toContain("60%");
    const done = { ...partial, tasks: { completed: 5, total: 5 } };
    api.list.mockResolvedValue([done]); api.read.mockResolvedValue(done);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click());
    expect(container.querySelector('.learning-note-row')?.getAttribute("aria-label")).toContain("5/5");
    expect(container.querySelector('.learning-document-progress')?.textContent).toContain("100%");
    await click("编辑全文");
    await input(editor(), "Unsaved draft\n- [ ] New task");
    const reads = api.read.mock.calls.length;
    api.list.mockResolvedValue([partial]); api.read.mockResolvedValue(partial);
    await click("刷新");
    expect(editor().value).toBe("Unsaved draft\n- [ ] New task");
    expect(api.read.mock.calls.length).toBe(reads);
    expect(container.querySelector('.learning-document-progress')?.textContent).toContain("显示已保存正文的进度");
  });
  it("opens the selected saved note in Obsidian and reports connection failure without replacing its content", async () => {
    const api = fixture();
    await render(api, "概览", "vault-a", { path: first.path, version: first.version, scope: "vault-a" });
    const button = Array.from(container.querySelectorAll("button")).find(value => value.textContent === "在 Obsidian 打开")!;
    await act(async () => button.click());
    expect(api.openObsidian).toHaveBeenCalledWith(first.path);
    api.openObsidian.mockRejectedValueOnce(new Error("Obsidian 未运行"));
    await act(async () => button.click());
    expect(container.textContent).toContain("Obsidian 未运行");
    expect(container.querySelector(".learning-markdown")?.textContent).toBe("原始正文");
    expect(api.planUpdate).not.toHaveBeenCalled();
  });
  it("positions the referenced document after a slower note list finishes loading", async () => {
    const api = fixture();
    let finish!: (notes: NoteDocument[]) => void;
    api.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(api, "概览", "vault-a", { path: first.path, version: first.version, scope: "vault-a" });
    expect(container.querySelector(".learning-markdown")?.textContent).toBe("原始正文");
    expect(document.activeElement).not.toBe(container.querySelector("article"));
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    await act(async () => { finish([first, second, project]); });
    expect(document.activeElement).toBe(container.querySelector("article"));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
  it("requires confirmation before replacing a draft and reports an externally changed version", async () => {
    const api = fixture();
    await edit(api, "正在编辑的草稿", "vault-a");
    const reference = { path: second.path, version: "older", scope: "vault-a" };
    await render(api, "概览", "vault-a", reference);
    expect(editor().value).toBe("正在编辑的草稿");
    expect(api.read).not.toHaveBeenCalledWith(second.path);
    await click("继续编辑");
    expect(editor().value).toBe("正在编辑的草稿");
    await render(api, "概览", "vault-a", { ...reference });
    await click("放弃修改并打开");
    expect(container.querySelector(".learning-markdown")?.textContent).toBe(second.content);
    expect(document.activeElement).toBe(container.querySelector("article"));
    expect(container.textContent).toContain("笔记已在引用后发生变化");
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("refuses references to another configuration without reading and preserves the current draft", async () => {
    const api = fixture();
    await edit(api, "保留草稿", "vault-a");
    await render(api, "概览", "vault-a", { path: second.path, version: "v1", scope: "vault-b" });
    expect(container.textContent).toContain("引用属于其他资料目录设置");
    expect(editor().value).toBe("保留草稿");
    expect(api.read).not.toHaveBeenCalledWith(second.path);
  });
});

function button(text: string) {
  const element = Array.from(container.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === text || item.textContent === text);
  expect(element, `button ${text}`).toBeDefined();
  return element!;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

function editor() { return container.querySelector<HTMLTextAreaElement>('article textarea')!; }

async function input(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function edit(api: BusinessApi, content: string, draftKey?: string) {
  await render(api, "Inbox", draftKey);
  await click("第一篇");
  await click("编辑全文");
  await input(editor(), content);
}

describe("资料工作台交互", () => {
  it("默认排版正文，源码保留完整 frontmatter，HTML 不执行", async () => {
    const api = fixture();
    const raw = "---\ntitle: 隐藏属性\n---\n# 标题\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>window.bad=true</script>\n\n[外链](https://example.com) [相对笔记](second.md)";
    api.read.mockResolvedValueOnce({ ...first, content: raw });
    await render(api);
    await click("第一篇");
    expect(container.querySelector(".learning-markdown h1")?.textContent).toBe("标题");
    expect(container.querySelector(".learning-markdown table")).not.toBeNull();
    expect(container.querySelector(".learning-markdown")?.textContent).not.toContain("隐藏属性");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href="https://example.com"]')?.getAttribute("target")).toBe("_blank");
    expect(container.querySelector('a[href="second.md"]')).toBeNull();
    await click("源码");
    expect(container.querySelector("article pre")?.textContent).toBe(raw);
    await click("阅读");
    expect(container.querySelector(".learning-markdown h1")?.textContent).toBe("标题");
  });

  it("按需展开表单，收起与切页保留草稿，窄屏返回列表保留编辑", async () => {
    const api = fixture();
    await edit(api, "正文草稿");
    const capture = container.querySelector<HTMLElement>('[aria-label="捕获到 Inbox"]')!;
    expect(capture.hidden).toBe(true);
    await click("新建笔记");
    expect(capture.hidden).toBe(false);
    await input(capture.querySelector("input")!, "捕获草稿");
    await click("收起表单");
    expect(capture.hidden).toBe(true);
    expect(editor().value).toBe("正文草稿");
    await render(api, "学习");
    await render(api, "Inbox");
    await click("新建笔记");
    expect(capture.querySelector("input")!.value).toBe("捕获草稿");
    await click("笔记列表");
    expect(container.querySelector(".learning-business")?.getAttribute("data-reader-open")).toBe("false");
    expect(editor().value).toBe("正文草稿");
  });

  it.each(["daily", "project"])("保存 %s 后打开结果先保护另一篇编辑草稿", async kind => {
    const api = fixture();
    await edit(api, "必须保留的编辑", "vault-a");
    if (kind === "daily") {
      await render(api, "学习", "vault-a");
      await click("记录 Daily");
      await input(container.querySelector('[aria-label="Daily 记录"]')!, "今日记录");
      await click("预览 Daily 记录");
      await click("确认写入 Daily");
    } else {
      await render(api, "项目", "vault-a");
      await click("更新项目");
      await input(container.querySelector('[aria-label="项目"]')!, project.path);
      await input(container.querySelector('[aria-label="项目进展"]')!, "最新进展");
      await click("预览项目进展");
      await click("确认写入项目进展");
    }
    expect(api.execute).toHaveBeenCalledOnce();
    expect(editor().value).toBe("必须保留的编辑");
    expect(container.textContent).toContain("当前笔记有未保存修改");
    await click("继续编辑");
    expect(container.querySelector<HTMLElement>("article")?.hidden).toBe(false);
    expect(editor().value).toBe("必须保留的编辑");
  });

  it("搜索空结果后仍能选择已加载的项目并预览", async () => {
    const api = fixture();
    await render(api, "项目");
    await click("更新项目");
    await input(container.querySelector('[aria-label="项目"]')!, project.path);
    api.list.mockResolvedValueOnce([]);
    await input(container.querySelector('[aria-label="搜索笔记"]')!, "不存在");
    await click("搜索");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="项目"]')!.value).toBe(project.path);
    await input(container.querySelector('[aria-label="项目进展"]')!, "进展内容");
    await click("预览项目进展");
    expect(api.planProjectAppend).toHaveBeenCalledWith(project.path, project.version, "进展内容");
  });

  it("切换确认态返回列表取消待打开目标，列表可再次选择且保留草稿", async () => {
    const api = fixture();
    await edit(api, "窄屏草稿");
    await click("第二篇");
    expect(button("第二篇").disabled).toBe(true);
    await click("笔记列表");
    expect(button("第二篇").disabled).toBe(false);
    expect(editor().value).toBe("窄屏草稿");
    await click("第二篇");
    await click("继续编辑");
    expect(editor().value).toBe("窄屏草稿");
    expect(container.querySelector(".learning-business")?.getAttribute("data-reader-open")).toBe("true");
  });

  it("项目状态预览可取消，确认失败保留预览且不误报成功", async () => {
    const api = fixture();
    await render(api, "项目");
    await input(container.querySelector('[aria-label="项目"]')!, project.path);
    await input(container.querySelector('[aria-label="新项目状态"]')!, "Paused");
    await click("预览状态修改");
    expect(api.planProjectStatus).toHaveBeenCalledWith(project.path, project.version, "Paused");
    expect(api.execute).not.toHaveBeenCalled();
    await click("取消状态预览");
    expect(api.execute).not.toHaveBeenCalled();
    await click("预览状态修改");
    api.execute.mockResolvedValueOnce({ ...change, status: "failed", error: "External edit" });
    await click("确认修改项目状态");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("External edit");
    expect(container.querySelector('[aria-label="确认项目状态"]')).not.toBeNull();
    expect(container.textContent).not.toContain("项目状态已保存");
    api.execute.mockResolvedValueOnce({ ...change, path: project.path });
    await click("取消状态预览");
    await click("预览状态修改");
    await click("确认修改项目状态");
    expect(container.querySelector('[aria-label="确认项目状态"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("项目状态已保存");
  });

  it("学习目标草稿可恢复，必须重新预览，确认后清空", async () => {
    const api = fixture();
    await render(api, "学习", "vault-a");
    await input(container.querySelector('[aria-label="目标名称"]')!, "学习 TypeScript");
    await input(container.querySelector('[aria-label="预期成果"]')!, "完成一个应用");
    await input(container.querySelector('[aria-label="验证方式"]')!, "独立完成测试");
    await input(container.querySelector('[aria-label="目标日期"]')!, "2026-11-01");
    await click("预览学习目标");
    expect(api.planLearningGoal).toHaveBeenLastCalledWith(expect.objectContaining({ targetDate: "2026-11-01" }));
    expect(api.execute).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(api, "学习", "vault-a");
    expect(container.querySelector<HTMLInputElement>('[aria-label="目标名称"]')!.value).toBe("学习 TypeScript");
    expect(container.querySelector<HTMLInputElement>('[aria-label="目标日期"]')!.value).toBe("2026-11-01");
    expect(container.querySelector('[aria-label="确认学习目标"]')).toBeNull();
    await click("预览学习目标");
    api.execute.mockResolvedValueOnce({ ...change, path: "Learning/学习 TypeScript.md" });
    await click("确认创建学习目标");
    expect(api.execute).toHaveBeenCalledWith("goal-plan-1");
    expect(container.querySelector<HTMLInputElement>('[aria-label="目标名称"]')!.value).toBe("");
    expect(sessionStorage.length).toBe(0);
  });

  it("保留全文，预览只展示差异，显式确认后才写入并刷新正文与日志", async () => {
    const api = fixture();
    const content = "---\ntitle: 原始\n---\n用户修改\n\n";
    await edit(api, content);
    await click("预览修改");
    expect(api.execute).not.toHaveBeenCalled();
    const preview = container.querySelector('[aria-label="确认修改"]')!;
    expect(Array.from(preview.querySelectorAll("pre")).map(node => node.textContent)).toEqual([first.content, content]);
    await click("确认写入");
    expect(api.execute).toHaveBeenCalledTimes(1);
    await click("源码");
    expect(container.querySelector("article pre")?.textContent).toBe(content);
    expect(container.querySelector("article textarea")).toBeNull();
    await render(api, "日志");
    expect(container.querySelector('[aria-label="操作日志"]')?.textContent).toContain("修改 · 已完成");
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("外部修改冲突显示具体原因并保留编辑草稿", async () => {
    const api = fixture();
    api.execute.mockRejectedValueOnce(new Error("File changed since preview"));
    await edit(api, "待保存草稿\n");
    await click("预览修改");
    await click("确认写入");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("File changed since preview");
    expect(editor().value).toBe("待保存草稿\n");
    await click("取消预览，继续编辑");
    expect(editor().disabled).toBe(false);
    expect(editor().value).toBe("待保存草稿\n");
  });

  it("切页保留捕获和编辑草稿，切文件必须先确认放弃", async () => {
    const api = fixture();
    await edit(api, "编辑草稿");
    const capture = container.querySelector('[aria-label="捕获到 Inbox"]')!;
    await input(capture.querySelector("input")!, "捕获标题");
    await input(capture.querySelector("textarea")!, "捕获草稿");
    await render(api, "项目");
    await render(api, "Inbox");
    expect(editor().value).toBe("编辑草稿");
    expect(capture.querySelector("input")!.value).toBe("捕获标题");
    expect(capture.querySelector("textarea")!.value).toBe("捕获草稿");
    await click("第二篇");
    expect(api.read).toHaveBeenCalledTimes(1);
    await click("继续编辑");
    expect(editor().value).toBe("编辑草稿");
    await click("第二篇");
    await click("放弃修改并打开");
    expect(container.querySelector(".learning-markdown")?.textContent).toBe(second.content);
  });

  it("服务返回失败记录时不误报保存成功，不丢失编辑内容", async () => {
    const api = fixture();
    api.execute.mockResolvedValueOnce({ ...change, status: "failed", error: "Backup write failed" });
    await edit(api, "尚未落盘的正文");
    await click("预览修改");
    await click("确认写入");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Backup write failed");
    expect(editor().value).toBe("尚未落盘的正文");
    expect(container.textContent).not.toContain("修改已保存");
  });

  it("较早发起的读取延迟返回时不会覆盖后来选择的笔记", async () => {
    const api = fixture();
    let finish!: (value: NoteDocument) => void;
    api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(api);
    await click("第一篇");
    await click("第二篇");
    expect(container.querySelector(".learning-markdown")?.textContent).toBe(second.content);
    await act(async () => finish(first));
    expect(container.querySelector(".learning-markdown")?.textContent).toBe(second.content);
  });

  it("恢复先显示确认，取消不调用恢复，确认后刷新日志和正文", async () => {
    const api = fixture();
    await edit(api, "修改后正文");
    await click("预览修改");
    await click("确认写入");
    await render(api, "日志");
    await click("恢复修改前版本");
    expect(api.restore).not.toHaveBeenCalled();
    await click("取消");
    expect(api.restore).not.toHaveBeenCalled();
    await click("恢复修改前版本");
    await click("确认恢复");
    expect(api.restore).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="操作日志"]')?.textContent).toContain("恢复 · 已完成");
    await render(api);
    await click("源码");
    expect(container.querySelector("article pre")?.textContent).toBe(first.content);
  });

  it("捕获失败保留输入，成功后清空草稿并显示保存路径", async () => {
    const api = fixture();
    api.capture.mockRejectedValueOnce(new Error("Vault is read-only"));
    await render(api);
    const capture = container.querySelector('[aria-label="捕获到 Inbox"]')!;
    const title = capture.querySelector("input")!;
    const content = capture.querySelector("textarea")!;
    await input(title, "新记录");
    await input(content, "完整内容\n");
    await click("保存到 Inbox");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Vault is read-only");
    expect(title.value).toBe("新记录");
    expect(content.value).toBe("完整内容\n");
    await click("保存到 Inbox");
    expect(title.value).toBe("");
    expect(content.value).toBe("");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(first.path);
  });

  it("Daily 记录先预览，确认后才写入并清空输入", async () => {
    const api = fixture();
    await render(api, "学习", "vault-a");
    const daily = container.querySelector('[aria-label="记录 Daily"]')!;
    await input(daily.querySelector('[aria-label="Daily 记录"]')!, "今天完成了资料读写闭环");
    await click("预览 Daily 记录");
    expect(api.planDailyAppend).toHaveBeenCalledWith(expect.any(String), "今天完成了资料读写闭环");
    expect(api.execute).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="确认 Daily 记录"]')?.textContent).toMatch(/Daily\/\d{4}-\d{2}-\d{2}\.md/);
    await click("确认写入 Daily");
    expect(api.execute).toHaveBeenCalledWith("daily-plan-1");
    expect(daily.querySelector<HTMLTextAreaElement>('[aria-label="Daily 记录"]')!.value).toBe("");
  });

  it("项目进展先预览，确认后才写入并清空输入", async () => {
    const api = fixture();
    await render(api, "项目");
    const panel = container.querySelector('[aria-label="记录项目进展"]')!;
    await input(panel.querySelector("select")!, project.path);
    await input(panel.querySelector('[aria-label="项目进展"]')!, "完成了第一轮验证");
    await click("预览项目进展");
    expect(api.planProjectAppend).toHaveBeenCalledWith(project.path, project.version, "完成了第一轮验证");
    expect(api.execute).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="确认项目进展"]')?.textContent).toContain(project.path);
    await click("确认写入项目进展");
    expect(api.execute).toHaveBeenCalledWith("project-plan-1");
    expect(panel.querySelector<HTMLTextAreaElement>('[aria-label="项目进展"]')!.value).toBe("");
  });
});

describe("当前标签页草稿暂存", () => {
  async function remount(api: BusinessApi, key: string) {
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(api, "Inbox", key);
  }

  it("重挂载恢复编辑和捕获，保留原始版本且不会自动写入", async () => {
    const api = fixture();
    await edit(api, "恢复的编辑\n", "vault-a");
    const capture = container.querySelector('[aria-label="捕获到 Inbox"]')!;
    await input(capture.querySelector("input")!, "恢复的标题");
    await input(capture.querySelector("textarea")!, "恢复的捕获\n");
    await remount(api, "vault-a");
    expect(editor().value).toBe("恢复的编辑\n");
    const restored = container.querySelector('[aria-label="捕获到 Inbox"]')!;
    expect(restored.querySelector("input")!.value).toBe("恢复的标题");
    expect(restored.querySelector("textarea")!.value).toBe("恢复的捕获\n");
    expect(api.capture).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();
    expect(api.planUpdate).not.toHaveBeenCalled();
    await click("预览修改");
    expect(api.planUpdate).toHaveBeenLastCalledWith(first.path, "v1", "恢复的编辑\n");
  });

  it("保存编辑与捕获后清除各自草稿，放弃修改后也不再恢复", async () => {
    const api = fixture();
    await edit(api, "要保存的编辑", "vault-a");
    const capture = container.querySelector('[aria-label="捕获到 Inbox"]')!;
    await input(capture.querySelector("input")!, "尚未保存捕获");
    await input(capture.querySelector("textarea")!, "捕获内容");
    await click("预览修改");
    await click("确认写入");
    await remount(api, "vault-a");
    expect(editor()).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="捕获到 Inbox"] input')!.value).toBe("尚未保存捕获");
    await click("保存到 Inbox");
    await remount(api, "vault-a");
    expect(container.querySelector<HTMLInputElement>('[aria-label="捕获到 Inbox"] input')!.value).toBe("");
    await click("第一篇");
    await click("编辑全文");
    await input(editor(), "要放弃的编辑");
    await click("放弃修改");
    await remount(api, "vault-a");
    expect(editor()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("不同资料配置的草稿不串用", async () => {
    const api = fixture();
    await edit(api, "空间 A 草稿", "vault-a");
    await render(api, "Inbox", "vault-b");
    expect(editor()).toBeNull();
    await click("第一篇");
    await click("编辑全文");
    await input(editor(), "空间 B 草稿");
    await render(api, "Inbox", "vault-a");
    expect(editor().value).toBe("空间 A 草稿");
    await render(api, "Inbox", "vault-b");
    expect(editor().value).toBe("空间 B 草稿");
  });

  it("暂存不可用时显示原因但不会清空正在输入的正文", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    const api = fixture();
    await edit(api, "仍在页面里的草稿", "vault-a");
    expect(editor().value).toBe("仍在页面里的草稿");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("请勿刷新或关闭");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Quota exceeded");
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("损坏的暂存数据不阻断笔记读取", async () => {
    sessionStorage.setItem("dsh-learning-os:draft:vault-a", "{invalid json");
    const api = fixture();
    await render(api, "Inbox", "vault-a");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("无法恢复当前标签页草稿");
    await click("第一篇");
    expect(container.querySelector(".learning-markdown")?.textContent).toBe("原始正文");
  });
});
