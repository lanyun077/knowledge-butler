import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef, useState } from "react";
import { managerSnapshot } from "../knowledge-manager-contract";
import type { StarData } from "../knowledge-stars";
import { Maximize2, Minimize2 } from "lucide-react";
import { openManagerNote } from "./open-note";

declare const __STAR_MAP_HTML__: string;

export function StarMap({ app, theme, focusPath }: { app: App; theme: string; focusPath?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!fullscreen) return;
    const hidden: { element: HTMLElement; inert: boolean }[] = [];
    let current: HTMLElement = workspace.current!;
    while (current.parentElement) {
      for (const sibling of Array.from(current.parentElement.children)) if (sibling !== current && sibling instanceof HTMLElement) {
        hidden.push({ element: sibling, inert: sibling.inert }); sibling.inert = true;
      }
      current = current.parentElement;
    }
    fullscreenButton.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setFullscreen(false); fullscreenButton.current?.focus(); } };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); hidden.forEach(({ element, inert }) => { element.inert = inert; }); };
  }, [fullscreen]);
  const [data, setData] = useState<StarData>(), [notice, setNotice] = useState("正在读取知识星空…"), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const graph: StarData = { nodes: [], links: [], domains: [] }; let offset: number | null = 0, version: string | undefined;
        while (offset !== null && active) {
          const result = await app.callServerTool({ name: "learning_manager_probe", arguments: { view: "universe", offset, ...(version ? { version } : {}) } });
          if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
          const page = managerSnapshot.parse(result.structuredContent).sky;
          if (!page || version && page.version !== version) throw new Error("知识已变化，请重新读取星图。");
          version = page.version; graph.nodes.push(...page.nodes.items); graph.links.push(...page.links.items); graph.domains.push(...page.domains.items); offset = page.nextOffset;
          if (active) setNotice(`正在读取知识星空 · ${graph.nodes.length} / ${page.nodes.total} 节点`);
        }
        if (active) { setData(graph); setNotice(""); }
      } catch (cause) { if (active) setNotice(`星图暂不可用：${cause instanceof Error ? cause.message : String(cause)}。请重新读取，或通过记录打开文章。`); }
    })();
    return () => { active = false; };
  }, [app, retry]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: "knowledge-star-theme", theme }, "*"); }, [theme]);
  const send = () => { if (data) frame.current?.contentWindow?.postMessage({ type: "knowledge-star-data", data, theme, focusPath }, "*"); };
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "knowledge-star-ready") send();
      if (event.data?.type === "knowledge-star-escape") { setFullscreen(false); fullscreenButton.current?.focus(); }
      if (event.data?.type === "knowledge-star-open") {
        const node = data?.nodes.find(node => node.id === event.data.id);
        if (node) {
          const reply = (failed: boolean) => {
            const message = failed ? "暂时无法打开文章。请先在 Obsidian 打开此知识库，再重试。" : "已请求 Obsidian 打开；若未显示，请先在 Obsidian 打开此知识库。";
            frame.current?.contentWindow?.postMessage({ type: "knowledge-star-open-result", id: node.id, message }, "*");
          };
          void openManagerNote(app, node.path).then(() => reply(false)).catch(() => reply(true));
        }
      }
    };
    window.addEventListener("message", message); return () => window.removeEventListener("message", message);
  }, [data, app, theme, focusPath]);
  return <section ref={workspace} className={`star-workspace${fullscreen ? " star-fullscreen" : ""}`} aria-label="知识星空" role={fullscreen ? "dialog" : undefined} aria-modal={fullscreen || undefined}>
    {fullscreen && <span tabIndex={0} className="sr-only" onFocus={() => frame.current?.contentWindow?.postMessage({ type: "knowledge-star-focus-last" }, "*")} />}
    <div className="star-toolbar"><button ref={fullscreenButton} aria-pressed={fullscreen} aria-label={fullscreen ? "退出星图全屏" : "星图全屏"} onClick={() => setFullscreen(value => !value)}>
      {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}{fullscreen ? "退出全屏" : "全屏"}
    </button></div>
    {notice && <p className="meta" role="status">{notice}</p>}
    {!data && <button onClick={() => setRetry(value => value + 1)}>重新读取星图</button>}
    {data && <iframe key={`${retry}:${focusPath ?? ""}`} ref={frame} onLoad={send} title="三维知识星空" className="star-frame" sandbox="allow-scripts allow-downloads"
      srcDoc={typeof __STAR_MAP_HTML__ === "string" ? __STAR_MAP_HTML__ : ""} />}
    {fullscreen && <span tabIndex={0} className="sr-only" onFocus={() => fullscreenButton.current?.focus()} />}
  </section>;
}
