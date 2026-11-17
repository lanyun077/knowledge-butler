import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ISessions, SessionReference } from "@deepseek-ai/dsh-api-session-controller/client";
import { apply } from "../src/client";
import type { SavedBinding, Workspace } from "../src/workspace";
import { defaultFolders, type VaultConfig } from "../src/business-api";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";

type Snapshot = { status: "unavailable" } | {
  status: "ready"; mode: "host" | "memory"; writable: boolean;
  value: { binding: SavedBinding; vault?: VaultConfig };
};

const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals();
});

function fixture(initial: Snapshot) {
  let snapshot = initial;
  const subscribers = new Set<() => void>();
  const cleanups: (() => void)[] = [];
  let workspace!: Workspace;
  const references: SessionReference[] = [];
  const sessions = {
    list: createSnapshotStore({ byId: {} } as ReturnType<ISessions["list"]["getSnapshot"]>),
    create: vi.fn<ISessions["create"]>().mockImplementation(async options => options!.sessionId!),
    retain: vi.fn<ISessions["retain"]>(sessionId => {
      const reference = {
        sessionId, binding: {} as SessionReference["binding"],
        ready: Promise.resolve({} as SessionReference["binding"]),
        release: vi.fn(), [Symbol.dispose]: vi.fn(),
      } satisfies SessionReference;
      references.push(reference);
      return reference;
    }),
  };
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    set: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal("window", {
    location: new URL("http://localhost/"), history: { state: null, pushState: vi.fn() },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    createElement: () => ({ dataset: {}, textContent: "", remove: vi.fn() }),
    head: { appendChild: vi.fn() },
  });
  apply({
    get: () => ({ rpc: { call: vi.fn().mockResolvedValue({ ok: true, value: { ready: true } }) } }),
    configForms: { get: () => form }, sessions,
    layout: { selectPanel: vi.fn() },
    effect(effect: () => (() => void)) { cleanups.push(effect()); },
    slots: {
      inject(_name: string, register: () => void) { register(); },
      register(options: { name: string; inject?: () => { hooks: { workspace: Workspace } } }) {
        if (options.name === "main") workspace = options.inject!().hooks.workspace;
      },
    },
  } as unknown as Context);
  const dispose = () => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); };
  disposals.push(dispose);
  return {
    workspace, sessions, references, form, subscribers, dispose,
    publish(next: Snapshot) { snapshot = next; subscribers.forEach(listener => listener()); },
  };
}

function host(sessionId: string): Snapshot {
  return { status: "ready", mode: "host", writable: true, value: { binding: { cwd: `D:/${sessionId}`, sessionId }, vault: { root: "D:/test-vault", folders: defaultFolders } } };
}

describe("client host configuration lifecycle", () => {
  it("survives synchronous host acknowledgement when selecting another workspace conversation", async () => {
    const first = { cwd: "D:/first", sessionId: "first" };
    const second = { cwd: "D:/second", sessionId: "second" };
    const initial = host("first");
    if (initial.status === "ready") initial.value.binding = { ...first, conversations: [first, second] };
    const f = fixture(initial);
    f.form.set.mockImplementation(async (_key, binding) => {
      f.publish({ status: "ready", mode: "host", writable: true, value: { binding, vault: { root: "D:/test-vault", folders: defaultFolders } } });
      return true;
    });
    await f.workspace.selectConversation("second");
    expect(f.workspace.reference()?.sessionId).toBe("second");
    expect(f.workspace.getSnapshot().conversations).toEqual([first, second]);
    expect(f.form.set).toHaveBeenCalledWith("binding", { ...second, conversations: [first, second] });
  });
  it("releases the composer when Vault configuration changes and prepares the same session again", async () => {
    const { workspace, references, publish, sessions } = fixture(host("first"));
    await workspace.connect();
    const next = host("first");
    if (next.status === "ready") next.value.vault = { root: "D:/second-vault", folders: defaultFolders };
    publish(next);
    expect(references[0].release).toHaveBeenCalledOnce();
    expect(workspace.reference()).toBeUndefined();
    await workspace.connect();
    expect(workspace.reference()?.sessionId).toBe("first");
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/first", sessionId: "first" });
  });

  it("shows missing Vault configuration without exposing the composer", async () => {
    const snapshot = host("first");
    if (snapshot.status === "ready") delete snapshot.value.vault;
    const { workspace, sessions } = fixture(snapshot);
    await workspace.connect();
    expect(workspace.getSnapshot().error).toContain("请先连接资料目录");
    expect(sessions.retain).not.toHaveBeenCalled();
  });
  it("recovers from unavailable configuration and attaches the newly restored session", async () => {
    const { workspace, sessions, references, form, publish } = fixture({ status: "unavailable" });
    await workspace.connect();
    expect(sessions.retain).not.toHaveBeenCalled();
    publish(host("first"));
    expect(workspace.getSnapshot()).toMatchObject({ loading: false, error: "", sessionId: "first" });
    await workspace.connect();
    expect(workspace.reference()?.sessionId).toBe("first");

    publish({ status: "unavailable" });
    expect(workspace.reference()).toBeUndefined();
    expect(references[0].release).toHaveBeenCalledOnce();
    publish(host("second"));
    await workspace.connect();
    expect(workspace.getSnapshot()).toMatchObject({ cwd: "D:/second", sessionId: "second", loading: false, error: "" });
    expect(workspace.reference()?.sessionId).toBe("second");
    expect(sessions.create).toHaveBeenCalledTimes(2);
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/second", sessionId: "second" });
    expect(form.set).not.toHaveBeenCalled();
  });

  it.each(["memory", "host"] as const)("disables connection when %s configuration is not writable", async mode => {
    const { workspace, sessions, references, publish } = fixture(host("first"));
    await workspace.connect();
    publish({ status: "ready", mode, writable: false, value: { binding: { cwd: "D:/temporary", sessionId: "temporary" } } });
    expect(workspace.reference()).toBeUndefined();
    expect(references[0].release).toHaveBeenCalledOnce();
    expect(workspace.getSnapshot().loading).toBe(true);
    expect(workspace.getSnapshot().error).not.toBe("");
    await workspace.connect();
    expect(sessions.retain).toHaveBeenCalledOnce();
    expect(sessions.create).toHaveBeenCalledOnce();
  });

  it("unsubscribes from configuration updates when the plugin is disposed", async () => {
    const { workspace, subscribers, publish, dispose, sessions } = fixture({ status: "unavailable" });
    expect(subscribers.size).toBe(1);
    const before = workspace.getSnapshot();
    dispose();
    expect(subscribers.size).toBe(0);
    publish(host("after-unload"));
    await workspace.connect();
    expect(workspace.getSnapshot()).toBe(before);
    expect(sessions.retain).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
