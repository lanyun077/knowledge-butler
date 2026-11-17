// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsx from "react/jsx-runtime";
import * as cordis from "@deepseek-ai/cordis";
import * as store from "@deepseek-ai/dsh-client-store";
import * as slots from "@deepseek-ai/dsh-client-ui-slots";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type { SessionReference } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import { defaultFolders, vaultScope, type PlainConfig } from "../src/business-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as plugin from "../src/client";

const shared: Record<string, unknown> = {
  react: React, "react-dom": ReactDOM, "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": jsx, "@deepseek-ai/cordis": cordis,
  "@deepseek-ai/dsh-client-store": store, "@deepseek-ai/dsh-client-ui-slots": slots,
};

// Published DSH client modules use lazy factories, not native ESM exports.
function client<T>(id: string): T {
  let result!: T;
  const browser = window as unknown as { __ModuleLoader__?: unknown };
  const previous = browser.__ModuleLoader__;
  browser.__ModuleLoader__ = {
    load: ({ factory }: { factory: (require: (name: string) => unknown) => T }) => {
      result = factory(name => {
        if (!(name in shared)) throw new Error(`Missing shared module: ${name}`);
        return shared[name];
      });
    },
  };
  try {
    const filename = createRequire(import.meta.url).resolve(`${id}/client`);
    runInThisContext(readFileSync(filename, "utf8"), { filename });
    return result;
  } finally {
    browser.__ModuleLoader__ = previous;
  }
}

const renderer = client<typeof import("@deepseek-ai/dsh-client-ui-renderer/client")>("@deepseek-ai/dsh-client-ui-renderer");
const layout = client<typeof import("@deepseek-ai/dsh-client-ui-layout/client")>("@deepseek-ai/dsh-client-ui-layout");
const disposals: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await React.act(dispose);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function bench(hash: string, withVault = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  window.history.replaceState({ host: "preserved" }, "", `/${hash}`);
  const root = new cordis.Context();
  const owner = root.plugin(() => {});
  await owner.await();
  const ctx = owner.ctx;
  disposals.push(async () => { await owner.dispose(); });
  await ctx.plugin(renderer).await();
  ctx.provide("locale", {} as never);
  ctx.provide("theme", { getTheme: () => ({ preference: "light", fontSize: 14, active: { colorScheme: "light", tokens: {} } }) } as never);
  const registry = ctx.get("slots") as InstanceType<typeof renderer.SlotRegistry>;
  registry.installLocale({ ...store.createSnapshotStore({ revision: 0 }), bind: () => ((key: string) => key) as slots.Translate });
  registry.provideRoot({ hooks: { sessions: store.createSnapshotStore({ byId: {} }) } });
  const empty = store.createSnapshotStore<slots.StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} });
  registry.installScope("session", { current: empty, bindingSource: () => empty, renderArea: () => null });
  const references: SessionReference[] = [];
  const sessions = { list: store.createSnapshotStore({ byId: {} }), create: vi.fn(async options => options.sessionId), retain: vi.fn((sessionId: SessionReference["sessionId"]) => {
    const binding = {} as SessionReference["binding"];
    const reference = { sessionId, binding, ready: Promise.resolve(binding), release: vi.fn(), [Symbol.dispose]: vi.fn() };
    references.push(reference);
    return reference;
  }) };
  ctx.provide("sessions", sessions as never);
  ctx.provide("uiConversation", {} as never);
  const call = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: endpoint === "learning-os/list"
    ? [{ path: "Inbox/first.md", title: "真实资料入口", category: "inbox", excerpt: "笔记内容" }]
    : endpoint === "learning-os/read" ? { path: "Inbox/first.md", title: "真实资料入口", category: "inbox", excerpt: "笔记内容", content: "# 正文来自宿主", version: "v1" } : [] }));
  ctx.provide("connection", { rpc: { call } } as never);
  const config = store.createSnapshotStore<ConfigFormSnapshot<PlainConfig>>({
    status: "ready", mode: "host", writable: true, value: { binding: { cwd: "", sessionId: "" },
      vault: { root: withVault ? "D:/test-vault" : "", folders: defaultFolders } },
    base: undefined, user: undefined, revision: 0,
  });
  ctx.provide("configForms", { get: () => ({ ...config, set: vi.fn() }) } as never);
  await ctx.plugin(layout).await();
  registry.register({ name: "sidebar", children: { "sidebar.panellist": { kind: "list", scope: "root" } } },
    ({ renderSlot }: slots.PropsRenderSlots<"sidebar.panellist">) => renderSlot("sidebar.panellist", { size: 16, active: false }));
  const fiber = ctx.plugin(plugin);
  await fiber.await();
  const container = document.createElement("div");
  document.body.append(container);
  let unmount!: () => void;
  await React.act(async () => { unmount = (ctx.get("uiRenderer") as import("@deepseek-ai/dsh-client-ui-renderer/client").UiRendererService).mount(container); });
  disposals.push(async () => { unmount(); });
  return { registry, panel: ctx.get("layout") as InstanceType<typeof layout.LayoutController>, fiber, container, sessions, config, references, call };
}

function button(container: HTMLElement, label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe("published host layout and renderer integration", () => {
  it("offers setup from the primary assistant when no Vault is configured", async () => {
    const { container } = await bench("#learning-os/overview");
    const app = container.querySelector(".learning-os")!;
    expect(app.getAttribute("data-resources-open")).toBe("false");
    const entry = container.querySelector<HTMLButtonElement>(".learning-os-connect button")!;
    expect(entry.textContent).toBe("连接资料目录");
    await React.act(async () => entry.click());
    expect(app.getAttribute("data-resources-open")).toBe("true");
    expect(container.querySelector(".learning-os-setup")).not.toBeNull();
  });
  it("makes the assistant primary and preserves the mounted workspace when resources close", async () => {
    const { container } = await bench("#learning-os/overview", true);
    const app = container.querySelector(".learning-os")!;
    expect(app.getAttribute("data-resources-open")).toBe("false");
    expect(container.querySelector('main[aria-label="管家"]')).not.toBeNull();
    const business = container.querySelector(".learning-business");
    await React.act(async () => { button(container, "资料").click(); });
    expect(app.getAttribute("data-resources-open")).toBe("true");
    await React.act(async () => { button(container, "管家").click(); });
    expect(app.getAttribute("data-resources-open")).toBe("false");
    expect(container.querySelector(".learning-business")).toBe(business);
    expect(document.activeElement).toBe(button(container, "资料"));
  });

  it("opens resources for a note reference without changing the primary assistant session", async () => {
    const scope = vaultScope({ root: "D:/test-vault", folders: defaultFolders });
    const hash = `#learning-os/overview?${new URLSearchParams({ note: "Inbox/first.md", version: "v1", scope })}`;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const { container } = await bench(hash, true);
    expect(container.querySelector(".learning-os")?.getAttribute("data-resources-open")).toBe("true");
    expect(container.querySelector(".learning-markdown h1")?.textContent).toBe("正文来自宿主");
    await React.act(async () => { button(container, "管家").click(); });
    expect(container.querySelector(".learning-os")?.getAttribute("data-resources-open")).toBe("false");
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });
  it("renders host-backed notes instead of demo cards when a Vault is configured", async () => {
    const { container, call } = await bench("#learning-os/inbox", true);
    expect(container.textContent).not.toContain("演示资料");
    await React.act(async () => { button(container, "真实资料入口").click(); });
    expect(container.querySelector(".learning-markdown h1")?.textContent).toBe("正文来自宿主");
    expect(call).toHaveBeenCalledWith("/api", "learning-os/read", { path: "Inbox/first.md", scope: vaultScope({ root: "D:/test-vault", folders: defaultFolders }) });
  });
  it("registers before selecting a deep link and renders navigation through the real host", async () => {
    const { registry, panel, container, sessions } = await bench("#learning-os/projects");
    expect(panel).toBeInstanceOf(layout.LayoutController);
    expect(container.querySelector("h1")?.textContent).toBe("项目");
    expect(registry.entries("sidebar.panellist")).toHaveLength(1);
    await React.act(async () => { button(container, "知识库").click(); });
    expect(container.querySelector("h1")?.textContent).toBe("知识库");
    expect(window.location.hash).toBe("#learning-os/knowledge");
    expect(window.history.state).toEqual({ host: "preserved" });
    await React.act(async () => { button(container, "返回宿主").click(); });
    expect(container.querySelector(".learning-os")).toBeNull();
    expect(window.location.hash).toBe("");
    await React.act(async () => { panel.selectPanel("dsh-learning-os" as MainPanelId); });
    expect(container.querySelector("h1")?.textContent).toBe("知识库");
    expect(window.location.hash).toBe("#learning-os/knowledge");
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("removes the panel, styles and navigation listener when the plugin unloads", async () => {
    const { registry, panel, fiber, container } = await bench("#learning-os/learning");
    await React.act(async () => { await fiber.dispose(); });
    expect(registry.entries("main")).toHaveLength(0);
    expect(registry.entries("sidebar.panellist")).toHaveLength(0);
    expect(container.querySelector(".learning-os")).toBeNull();
    expect(document.querySelector('style[data-plugin="dsh-learning-os-client"]')).toBeNull();
    const select = vi.spyOn(panel, "selectPanel");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(select).not.toHaveBeenCalled();
  });

  it("follows back and forward without the panel observer adding history entries", async () => {
    const { container } = await bench("#learning-os/projects");
    await React.act(async () => { button(container, "学习").click(); });
    const length = window.history.length;
    await React.act(async () => {
      window.history.back();
      await new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
    });
    expect(container.querySelector("h1")?.textContent).toBe("项目");
    expect(window.history.length).toBe(length);
    await React.act(async () => {
      window.history.forward();
      await new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
    });
    expect(container.querySelector("h1")?.textContent).toBe("学习");
    expect(window.history.length).toBe(length);
  });

  it("automatically reconnects the rendered panel when host configuration recovers", async () => {
    const { container, config, sessions, references, call } = await bench("#learning-os/projects");
    for (const sessionId of ["first", "second"]) {
      await React.act(async () => { config.update(value => { value.status = "unavailable"; }); });
      expect(container.querySelector(".learning-os-session")).toBeNull();
      await React.act(async () => {
        config.update(value => {
          value.status = "ready";
          value.value = { binding: { cwd: `D:/${sessionId}`, sessionId }, vault: { root: "D:/test-vault", folders: defaultFolders } };
        });
      });
      expect(container.querySelector(".learning-os-session")?.textContent).toContain(`D:/${sessionId}`);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
    expect(sessions.retain).toHaveBeenCalledTimes(2);
    expect(sessions.retain).toHaveBeenLastCalledWith("second", { source: "learningWorkspace" });
    expect(references[0].release).toHaveBeenCalledOnce();
    expect(sessions.create.mock.calls).toEqual([
      [{ cwd: "D:/first", sessionId: "first" }], [{ cwd: "D:/second", sessionId: "second" }],
    ]);
    await React.act(async () => {
      config.update(value => { value.value!.vault = { root: "D:/new-vault", folders: defaultFolders }; });
    });
    expect(references[1].release).toHaveBeenCalledOnce();
    expect(sessions.retain).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".learning-os-session")?.textContent).toContain("D:/second");
    expect(call).toHaveBeenCalledWith("/api", "learning-os/prepare-assistant", { scope: vaultScope({ root: "D:/new-vault", folders: defaultFolders }) });
  });
});
