import { createHash } from "node:crypto";
import type { VaultService } from "./vault";
import type { InferValue } from "@deepseek-ai/dsh-tools";

export interface ObsidianConfig { baseUrl: string; apiKeyRef: string }
export interface ObsidianStatus { version: string; pluginVersion: string }
export interface ObsidianMetadata {
  path: string; version: string; tags: string[]; frontmatter: InferValue<{ type: "object"; additionalProperties: true }>;
  links: string[]; backlinks: string[]; unresolvedLinks: string[];
}

/** Local REST API 5.4.0: only status, note metadata and explicit UI navigation. */
export class ObsidianBridge {
  constructor(private vault: Pick<VaultService, "read" | "isMappedNote" | "verifyObsidianConnection">, private config: ObsidianConfig, private resolveKey: () => Promise<string | undefined>, private checkCurrent: () => void) {}

  private async connection() {
    this.checkCurrent();
    if (!this.config.baseUrl) throw new Error("尚未配置 Obsidian 连接，请在资料区连接设置中填写本机服务地址。");
    const url = new URL(this.config.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
      || url.search || url.hash || url.username || url.password) {
      throw new Error("Obsidian 地址须为 http://127.0.0.1:端口，不支持远程地址或其他路径。");
    }
    const key = await this.resolveKey();
    if (!key?.trim()) throw new Error("Obsidian 连接凭据未配置，请在宿主凭据设置中保存对应密钥。");
    await this.vault.verifyObsidianConnection(key, Number(url.port));
    this.checkCurrent();
    return { url, key };
  }

  private async request(route: string, method = "GET", signal?: AbortSignal) {
    const { url, key } = await this.connection();
    let response: Response;
    try {
      response = await fetch(new URL(route, url), {
        method, headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.olrapi.note+json" },
        redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch (cause) {
      signal?.throwIfAborted();
      throw new Error("无法连接 Obsidian，请检查应用、Local REST API 插件和本机 HTTP 服务是否已开启。", { cause });
    }
    if (!response.ok) throw new Error(`Obsidian 请求失败（HTTP ${response.status}），请检查凭据和目标笔记。`);
    this.checkCurrent();
    return response;
  }

  async status(signal?: AbortSignal): Promise<ObsidianStatus> {
    const value = await (await this.request("/", "GET", signal)).json();
    this.checkCurrent();
    if (value.authenticated !== true || value.service !== "Obsidian Local REST API"
      || typeof value.versions?.obsidian !== "string" || typeof value.versions?.self !== "string") {
      throw new Error("Obsidian 服务未通过认证或返回了不支持的状态。");
    }
    return { version: value.versions.obsidian, pluginVersion: value.versions.self };
  }

  async metadata(path: string, signal?: AbortSignal): Promise<ObsidianMetadata> {
    const before = await this.vault.read(path, signal);
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const value = await (await this.request(`/vault/${encoded}`, "GET", signal)).json();
    if (value.path !== path || typeof value.content !== "string" || !value.frontmatter || typeof value.frontmatter !== "object"
      || Array.isArray(value.frontmatter) || ![value.tags, value.links, value.backlinks, value.unresolvedLinks]
        .every(list => Array.isArray(list) && list.every(item => typeof item === "string"))) {
      throw new Error("Obsidian 返回的笔记元数据格式不受支持。");
    }
    // Obsidian's text reader omits an initial UTF-8 BOM; disk versions retain it.
    const remoteVersion = createHash("sha256").update(value.content.replace(/^\uFEFF/, "")).digest("hex");
    const applicationVersion = createHash("sha256").update(before.content.replace(/^\uFEFF/, "")).digest("hex");
    const after = await this.vault.read(path, signal);
    this.checkCurrent();
    if (before.version !== after.version || remoteVersion !== applicationVersion) {
      throw new Error("Obsidian 原文与当前资料不一致，可能连接了其他资料库或笔记正在变化，请核对后重试。");
    }
    // Relationship targets outside the mapped note scope are not exposed to the Agent.
    const scoped = (paths: string[]) => paths.filter(target => this.vault.isMappedNote(target));
    return { path, version: after.version, tags: value.tags, frontmatter: value.frontmatter,
      links: scoped(value.links), backlinks: scoped(value.backlinks), unresolvedLinks: value.unresolvedLinks };
  }

  async open(path: string, signal?: AbortSignal): Promise<{ path: string }> {
    await this.metadata(path, signal);
    await this.request(`/open/${path.split("/").map(encodeURIComponent).join("/")}`, "POST", signal);
    return { path };
  }
}
