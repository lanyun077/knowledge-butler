import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";
import { prepareArticle, type ArticleImportInput } from "../src/article-source";
import { VaultService } from "../src/vault";

const input: ArticleImportInput = { kind: "url", title: "文章", sourceName: "示例网站", url: "https://example.com/start", content: "" };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const paragraph = "TypeScript unions combine alternatives with the pipe operator. ".repeat(20);
const html = `<html><head><title>Union guide</title><meta name="author" content="Ada"></head><body><nav>IGNORE NAV</nav><article><h1>Union guide</h1><p>${paragraph}</p><p><a href="/reference">Reference</a><img src="https://example.com/image.png" alt="Union diagram"></p><pre><code>type X = string | number;</code></pre><pre><div class="code-container"><code><div>let x = 1;</div><div>// Keep this comment separate.</div><div>use(x);</div></code></div></pre><script>DO_NOT_EXECUTE</script><div hidden>HIDDEN TEXT</div></article></body></html>`;

describe("article intake", () => {
  it("extracts inert HTML with attributed absolute links and preserves the decoded original", async () => {
    vi.spyOn(HttpFetchProvider.prototype, "fetch").mockResolvedValue({ url: "https://example.com/final", statusCode: 200, body: { kind: "html", content: html }, truncated: false });
    const source = await prepareArticle(input);
    expect(source).toMatchObject({ raw: html, submittedUrl: input.url, finalUrl: "https://example.com/final", sourceTitle: "Union guide", author: "Ada", format: "html" });
    expect(source.markdown).toContain(paragraph.trim());
    expect(source.markdown).toContain("[Reference](https://example.com/reference)");
    expect(source.markdown).toContain("type X = string | number;");
    expect(source.markdown).toContain("let x = 1;\n// Keep this comment separate.\nuse(x);");
    expect(source.markdown).toContain("Union diagram");
    expect(source.markdown).not.toMatch(/DO_NOT_EXECUTE|HIDDEN TEXT|IGNORE NAV|image\.png/);
  });

  it("rejects failed or truncated fetches and pages with no article, preserving explicit failure", async () => {
    const fetch = vi.spyOn(HttpFetchProvider.prototype, "fetch");
    const result = { url: input.url, statusCode: 200, body: { kind: "html" as const, content: html }, truncated: false };
    fetch.mockResolvedValueOnce({ ...result, statusCode: 403 });
    await expect(prepareArticle(input)).rejects.toThrow("403");
    fetch.mockResolvedValueOnce({ ...result, truncated: true });
    await expect(prepareArticle(input)).rejects.toThrow("不完整");
    fetch.mockResolvedValueOnce({ ...result, body: { kind: "html", content: "<html><body><script>loading()</script></body></html>" } });
    await expect(prepareArticle(input)).rejects.toThrow("未能提取");
    fetch.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(prepareArticle(input)).rejects.toThrow("network unavailable");
  });

  it("uses the official URL policy to reject local, credentialed and non-HTTP addresses", async () => {
    for (const url of ["http://127.0.0.1/private", "http://[::1]/", "https://user:pass@example.com/", "file:///private", "http://192.168.1.2/"]) {
      await expect(prepareArticle({ ...input, url })).rejects.toThrow();
    }
    const abort = new AbortController(); abort.abort();
    await expect(prepareArticle(input, abort.signal)).rejects.toThrow();
  });

  it("previews without sources, cancels, saves exact Markdown snapshots and detects duplicates after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "article-intake-")); roots.push(root);
    const vault = new VaultService(root);
    const raw = '\uFEFF---\r\ntype: malicious\r\n---\r\n# Types\r\n```text\r\n![external](https://example.com/a.png)\r\n```\r\n';
    const source = await prepareArticle({ ...input, kind: "markdown", content: raw });
    expect(source.raw).toBe(raw);
    const cancelled = (await vault.planArticleImport("取消", source)).plan!;
    await expect(readFile(join(root, cancelled.article!.snapshotPath))).rejects.toThrow();
    await vault.cancelPlan(cancelled.id);
    await expect(vault.execute(cancelled.id)).rejects.toThrow("Plan changed");
    const plan = (await vault.planArticleImport("文章", source)).plan!;
    expect(plan.after).toContain('type: "article-source"');
    expect(plan.after).toContain("````markdown");
    await expect(vault.read(plan.path)).rejects.toThrow();
    expect((await vault.execute(plan.id)).status).toBe("completed");
    expect(await readFile(join(root, plan.article!.snapshotPath))).toEqual(Buffer.from(raw));
    expect((await vault.execute(plan.id)).status).toBe("completed");
    expect((await new VaultService(root).planArticleImport("重复", source)).duplicate?.path).toBe(plan.path);
    expect((await vault.list("external"))[0].path).toBe(plan.path);
  });

  it("keeps old URL versions and rejects same-title, concurrent duplicate and external-create conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "article-versions-")); roots.push(root);
    const vault = new VaultService(root);
    const fetch = vi.spyOn(HttpFetchProvider.prototype, "fetch");
    fetch.mockResolvedValue({ url: input.url, statusCode: 200, body: { kind: "html", content: html }, truncated: false });
    const source = await prepareArticle(input);
    const a = (await vault.planArticleImport("v1", source)).plan!;
    const race = (await vault.planArticleImport("重复竞争", source)).plan!;
    expect((await vault.execute(a.id)).status).toBe("completed");
    expect(await vault.execute(race.id)).toMatchObject({ status: "failed", error: expect.stringContaining("already imported") });
    fetch.mockResolvedValue({ url: input.url, statusCode: 200, body: { kind: "html", content: html.replaceAll("alternatives", "choices") }, truncated: false });
    const changed = await prepareArticle(input);
    await expect(vault.planArticleImport("v1", changed)).rejects.toThrow("已存在");
    const b = (await vault.planArticleImport("v2", changed)).plan!;
    expect((await vault.execute(b.id)).status).toBe("completed");
    expect((await vault.read(a.path)).content).toBe(a.after);
    expect(b.article!.snapshotPath).not.toBe(a.article!.snapshotPath);
    const next = (await vault.planArticleImport("external", { ...changed, raw: changed.raw + "\n" })).plan!;
    await writeFile(join(root, next.path), "Externally created");
    expect((await vault.execute(next.id)).status).toBe("failed");
    expect((await vault.read(next.path)).content).toBe("Externally created");
  });

  it("rejects invalid Markdown and filenames without fetching", async () => {
    const fetch = vi.spyOn(HttpFetchProvider.prototype, "fetch");
    for (const content of ["", "\x00", "a".repeat(2_000_001), "\ud800"]) {
      await expect(prepareArticle({ ...input, kind: "markdown", content })).rejects.toThrow();
    }
    await expect(prepareArticle({ ...input, title: "../escape" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
