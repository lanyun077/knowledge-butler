import { useEffect, useState } from "react";
import { defaultObsidian, type businessApi } from "./business-api";
import type { ObsidianConfig } from "./obsidian";

export function ObsidianConnection({ config, save, api, writable }: {
  config?: ObsidianConfig; save: (value: ObsidianConfig) => Promise<boolean>;
  api: ReturnType<typeof businessApi>; writable: boolean;
}) {
  const [address, setAddress] = useState(config?.baseUrl ?? "");
  const [ref, setRef] = useState(config?.apiKeyRef ?? defaultObsidian.apiKeyRef);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setNotice(""); }, [config?.baseUrl, config?.apiKeyRef]);
  return <details className="learning-business learning-obsidian-connection">
    <summary>Obsidian 连接</summary>
    <p>在同一个资料库启用 Local REST API，开启仅监听本机的 HTTP 服务。</p>
    <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError(""); setNotice("");
      void (async () => {
        if (!await save({ baseUrl: address.trim(), apiKeyRef: ref.trim() })) throw new Error("宿主未接受连接设置，请重试。");
        const status = await api.connectObsidian(key);
        setNotice(`已连接 Obsidian ${status.version}，支持笔记元数据与打开笔记。`);
      })().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => { setKey(""); setBusy(false); });
    }}>
      <label>Obsidian 服务地址<input required value={address} disabled={busy || !writable} placeholder="http://127.0.0.1:27123" onChange={event => setAddress(event.target.value)} /></label>
      <label>Local REST API 密钥<input type="password" autoComplete="new-password" value={key} disabled={busy || !writable} placeholder="首次连接填写，已保存可留空" onChange={event => setKey(event.target.value)} /></label>
      <details><summary>凭据设置</summary><label>宿主凭据名称<input required value={ref} disabled={busy || !writable} onChange={event => setRef(event.target.value)} /></label></details>
      <p>密钥保存在宿主凭据存储中。这里仅连接和读取，不修改笔记。</p>
      <button disabled={busy || !writable || !address.trim() || !ref.trim()}>{busy ? "正在连接 Obsidian…" : "保存并检查 Obsidian 连接"}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
