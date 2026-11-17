import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObsidianBridge } from "../src/obsidian";
import { VaultService } from "../src/vault";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "learning-obsidian-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = "Wiki/中文 #笔记.md";
  const content = "---\ntags: [typescript]\nstatus: Active\n---\n# Test\n[[相关]]\n";
  await mkdir(join(root, "Wiki"));
  await writeFile(join(root, path), content);
  const calls: string[] = [];
  const state = { key: "test-key", content, current: true, redirect: false, hold: false };
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Bearer ${state.key}`) { response.writeHead(401).end(); return; }
    if (state.hold) return;
    if (state.redirect) { response.writeHead(302, { Location: "http://example.com/" }).end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/") response.end(JSON.stringify({ service: "Obsidian Local REST API", authenticated: true, versions: { obsidian: "1.14.4", self: "5.4.0" } }));
    else if (request.method === "POST" && request.url?.startsWith("/open/")) response.end("{}");
    else response.end(JSON.stringify({ path, content: state.content, tags: ["typescript"], frontmatter: { status: "Active" },
      links: ["Wiki/related.md", "Private/secret.md", "../secret.md"], backlinks: ["Daily/2026-10-09.md"], unresolvedLinks: ["未知"] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const port = (server.address() as { port: number }).port;
  const settingsPath = join(root, ".obsidian/plugins/obsidian-local-rest-api/data.json");
  await mkdir(join(root, ".obsidian/plugins/obsidian-local-rest-api"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ apiKey: state.key, enableInsecureServer: true, insecurePort: port, bindingHost: "127.0.0.1" }));
  const config = { baseUrl: `http://127.0.0.1:${port}`, apiKeyRef: "TEST_KEY" };
  const bridge = new ObsidianBridge(new VaultService(root), config, async () => state.key, () => { if (!state.current) throw new Error("Configuration changed"); });
  return { bridge, config, calls, state, path, root, settingsPath };
}

describe("Obsidian local connection through real HTTP", () => {
  it("accepts Obsidian's omitted BOM while retaining byte versions and rejecting newline changes", async () => {
    const { bridge, root, path, state } = await fixture();
    const content = '\uFEFF---\r\nstatus: Active\r\n---\r\n# Test\r\n';
    await writeFile(join(root, path), content);
    state.content = content.slice(1);
    const document = await new VaultService(root).read(path);
    expect(await bridge.metadata(path)).toMatchObject({ path, version: document.version });
    expect(await bridge.open(path)).toEqual({ path });
    expect(await readFile(join(root, path), "utf8")).toBe(content);
    state.content = state.content.replaceAll("\r\n", "\n");
    await expect(bridge.open(path)).rejects.toThrow("原文与当前资料不一致");
    expect(await readFile(join(root, path), "utf8")).toBe(content);
  });
  it("authenticates, reads application metadata, filters out-of-scope relations and opens the encoded note without writing", async () => {
    const { bridge, calls, path } = await fixture();
    expect(await bridge.status()).toEqual({ version: "1.14.4", pluginVersion: "5.4.0" });
    expect(await bridge.metadata(path)).toMatchObject({ path, tags: ["typescript"], frontmatter: { status: "Active" }, links: ["Wiki/related.md"], backlinks: ["Daily/2026-10-09.md"] });
    expect(await bridge.open(path)).toEqual({ path });
    expect(calls.at(-1)).toBe("POST /open/Wiki/%E4%B8%AD%E6%96%87%20%23%E7%AC%94%E8%AE%B0.md");
    expect(calls.every(call => call.startsWith("GET ") || call.startsWith("POST /open/"))).toBe(true);
  });

  it("rejects another Vault credential, remote endpoints and hidden paths before any network call", async () => {
    const { bridge, calls, config, state } = await fixture();
    state.key = "other-vault-key";
    await expect(bridge.status()).rejects.toThrow("当前 Vault");
    config.baseUrl = "http://example.com:27123";
    await expect(bridge.status()).rejects.toThrow("127.0.0.1");
    await expect(bridge.open(".obsidian/plugins/x.md")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("does not open a note when application content differs or settings have changed", async () => {
    const { bridge, state, path, calls } = await fixture();
    state.content = "Different note";
    await expect(bridge.open(path)).rejects.toThrow("原文与当前资料不一致");
    expect(calls.some(call => call.startsWith("POST"))).toBe(false);
    state.current = false;
    await expect(bridge.status()).rejects.toThrow("Configuration changed");
  });

  it("refuses redirects and honors cancellation without exposing the key", async () => {
    const { bridge, state } = await fixture();
    state.redirect = true;
    await expect(bridge.status()).rejects.toThrow("无法连接 Obsidian");
    state.redirect = false; state.hold = true;
    const controller = new AbortController();
    const result = bridge.status(controller.signal);
    controller.abort(new Error("User cancelled"));
    await expect(result).rejects.toThrow("User cancelled");
  });
});
