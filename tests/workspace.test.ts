import { describe, expect, it, vi } from "vitest";
import type { ISessions, SessionReference } from "@deepseek-ai/dsh-api-session-controller/client";
import { createWorkspace, pages, type SavedBinding } from "../src/workspace";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";

function fixture(ready: Promise<SessionReference["binding"]> = Promise.resolve({} as SessionReference["binding"])) {
  const reference = {
    sessionId: "learning-session" as SessionReference["sessionId"],
    binding: {} as SessionReference["binding"], ready,
    release: vi.fn(), [Symbol.dispose]: vi.fn(),
  } satisfies SessionReference;
  const sessions = {
    list: createSnapshotStore({ byId: {} } as ReturnType<ISessions["list"]["getSnapshot"]>),
    create: vi.fn<ISessions["create"]>().mockImplementation(async options => options?.sessionId ?? reference.sessionId),
    retain: vi.fn<ISessions["retain"]>().mockReturnValue(reference),
  };
  return { workspace: createWorkspace(sessions), sessions, reference };
}

describe("learning workspace session ownership", () => {
  it("creates independent conversations, switches back and restores the saved collection", async () => {
    const { sessions } = fixture();
    const releases: ReturnType<typeof vi.fn>[] = [];
    const binding = { session: { getSnapshot: () => ({ running: false, pendingSubmissions: [] }) } } as unknown as SessionReference["binding"];
    sessions.create.mockImplementation(async options => options?.sessionId ?? "second" as SessionReference["sessionId"]);
    sessions.retain.mockImplementation(sessionId => {
      const release = vi.fn(); releases.push(release);
      return { sessionId: sessionId as SessionReference["sessionId"], binding, ready: Promise.resolve(binding), release, [Symbol.dispose]: release };
    });
    let persisted!: SavedBinding;
    const workspace = createWorkspace(sessions, async value => { persisted = value; return true; });
    workspace.restore({ cwd: "D:/vault", sessionId: "first" });
    await workspace.connect();
    expect(workspace.getSnapshot().conversations).toEqual([{ cwd: "D:/vault", sessionId: "first" }]);
    await workspace.newConversation();
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/vault" });
    expect(workspace.reference()?.sessionId).toBe("second");
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(persisted.conversations?.map(item => item.sessionId)).toEqual(["first", "second"]);
    await workspace.selectConversation("first");
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/vault", sessionId: "first" });
    expect(workspace.reference()?.sessionId).toBe("first");
    expect(releases[1]).toHaveBeenCalledOnce();
    workspace.dispose();
    const restored = createWorkspace(sessions, vi.fn().mockResolvedValue(true));
    restored.restore(persisted);
    await restored.connect();
    expect(restored.reference()?.sessionId).toBe("first");
    expect(restored.getSnapshot().conversations).toHaveLength(2);
    restored.dispose();
  });

  it("retains both identities after a rejected save and retries the same new identity", async () => {
    const { sessions } = fixture();
    const binding = { session: { getSnapshot: () => ({ running: false, pendingSubmissions: [] }) } } as unknown as SessionReference["binding"];
    sessions.retain.mockImplementation(sessionId => ({ sessionId: sessionId as SessionReference["sessionId"], binding, ready: Promise.resolve(binding), release: vi.fn(), [Symbol.dispose]: vi.fn() }));
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const workspace = createWorkspace(sessions, save);
    workspace.restore({ cwd: "D:/vault", sessionId: "old" });
    await workspace.connect();
    await workspace.newConversation();
    expect(workspace.reference()).toBeUndefined();
    expect(workspace.getSnapshot().error).toContain("拒绝保存");
    expect(workspace.getSnapshot().conversations).toHaveLength(2);
    await workspace.connect();
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/vault", sessionId: "learning-session" });
    expect(save.mock.calls[1][0].conversations).toHaveLength(2);
    workspace.dispose();
  });

  it.each(["running", "pending"])("does not switch or create during %s work", async mode => {
    const { sessions, reference } = fixture();
    reference.binding = { session: { getSnapshot: () => ({ running: mode === "running", pendingSubmissions: mode === "pending" ? [{}] : [] }) } } as unknown as SessionReference["binding"];
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true));
    workspace.restore({ cwd: "D:/vault", sessionId: "first", conversations: [{ cwd: "D:/vault", sessionId: "second" }] });
    await workspace.connect();
    await workspace.selectConversation("second");
    await workspace.newConversation();
    expect(sessions.create).toHaveBeenCalledOnce();
    expect(reference.release).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().error).toContain("停止生成");
    workspace.dispose();
  });

  it("keeps the composer unavailable until preparation succeeds and retains the ID when preparation fails", async () => {
    const { sessions, reference } = fixture();
    const prepare = vi.fn().mockRejectedValueOnce(new Error("Tools not ready")).mockResolvedValue(undefined);
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true), prepare);
    workspace.restore({ cwd: "D:/test", sessionId: reference.sessionId });
    await workspace.connect();
    expect(workspace.reference()).toBeUndefined();
    expect(sessions.retain).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({ sessionId: reference.sessionId, error: "Tools not ready" });
    await workspace.connect();
    expect(workspace.reference()).toBe(reference);
    expect(prepare).toHaveBeenCalledTimes(2);
    workspace.dispose();
  });

  it("discards late preparation after configuration changes", async () => {
    const { sessions, reference } = fixture();
    let finish!: () => void;
    const prepare = () => new Promise<void>(resolve => { finish = resolve; });
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true), prepare);
    workspace.restore({ cwd: "D:/first", sessionId: reference.sessionId });
    const connecting = workspace.connect();
    await Promise.resolve();
    workspace.unavailable();
    workspace.restore({ cwd: "D:/second", sessionId: "second" });
    finish(); await connecting;
    expect(sessions.retain).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().sessionId).toBe("second");
    workspace.dispose();
  });
  it("adopts a saved identity into the client catalog before retaining it", async () => {
    const { sessions, reference } = fixture();
    let catalogued = false;
    sessions.create.mockImplementation(async options => {
      expect(options).toEqual({ cwd: "D:/测试空间", sessionId: reference.sessionId });
      catalogued = true;
      return reference.sessionId;
    });
    sessions.retain.mockImplementation(() => {
      if (!catalogued) throw new Error(`sessions.retain: unknown session ${reference.sessionId}`);
      return reference;
    });
    const save = vi.fn().mockResolvedValue(true);
    const workspace = createWorkspace(sessions, save);
    workspace.restore({ cwd: "D:/测试空间", sessionId: reference.sessionId });
    await workspace.connect();
    expect(workspace.reference()).toBe(reference);
    expect(workspace.getSnapshot().error).toBe("");
    expect(save).not.toHaveBeenCalled();
    workspace.dispose();
  });

  it("preserves a saved ID on failed adoption and retries that identity without retaining too early", async () => {
    const { sessions, reference } = fixture();
    sessions.create.mockRejectedValueOnce(new Error("Host disconnected"));
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true));
    workspace.restore({ cwd: "D:/测试空间", sessionId: reference.sessionId });
    await workspace.connect();
    expect(workspace.getSnapshot()).toMatchObject({ sessionId: reference.sessionId, error: "Host disconnected", connecting: false });
    expect(sessions.retain).not.toHaveBeenCalled();
    await workspace.connect();
    expect(sessions.create.mock.calls).toEqual([
      [{ cwd: "D:/测试空间", sessionId: reference.sessionId }],
      [{ cwd: "D:/测试空间", sessionId: reference.sessionId }],
    ]);
    expect(workspace.reference()).toBe(reference);
    workspace.dispose();
  });

  it("does not attach an adopted identity after the configuration changes", async () => {
    const { sessions, reference } = fixture();
    let finish!: (id: SessionReference["sessionId"]) => void;
    sessions.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true));
    workspace.restore({ cwd: "D:/first", sessionId: reference.sessionId });
    const connecting = workspace.connect();
    workspace.unavailable();
    workspace.restore({ cwd: "D:/second", sessionId: "next-session" });
    finish(reference.sessionId);
    await connecting;
    expect(sessions.retain).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({ cwd: "D:/second", sessionId: "next-session", connecting: false });
    workspace.dispose();
  });

  it("does not create sessions or lose the binding while navigating", async () => {
    const { workspace, sessions, reference } = fixture();
    workspace.setDirectory("D:/测试空间");
    await workspace.connect();
    for (const page of pages) workspace.navigate(page);
    await workspace.connect();
    expect(sessions.create).toHaveBeenCalledOnce();
    expect(sessions.create).toHaveBeenCalledWith({ cwd: "D:/测试空间" });
    expect(workspace.reference()).toBe(reference);
    expect(reference.release).not.toHaveBeenCalled();
    workspace.dispose();
    expect(reference.release).toHaveBeenCalledOnce();
  });

  it("requires a directory and freezes its identity after creation", async () => {
    const { workspace, sessions } = fixture();
    await workspace.connect();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().error).not.toBe("");
    workspace.setDirectory("D:/测试空间");
    await workspace.connect();
    workspace.setDirectory("D:/另一个空间");
    expect(workspace.getSnapshot().cwd).toBe("D:/测试空间");
    workspace.dispose();
  });

  it("retries the same created session after history fails to open", async () => {
    const { workspace, sessions, reference } = fixture(Promise.reject(new Error("Host disconnected")));
    workspace.setDirectory("D:/测试空间");
    await workspace.connect();
    expect(workspace.getSnapshot().error).toBe("Host disconnected");
    expect(reference.release).toHaveBeenCalledOnce();
    expect(workspace.reference()).toBeUndefined();
    reference.ready = Promise.resolve(reference.binding);
    await workspace.connect();
    expect(sessions.create.mock.calls).toEqual([
      [{ cwd: "D:/测试空间" }], [{ cwd: "D:/测试空间", sessionId: reference.sessionId }],
    ]);
    expect(workspace.reference()).toBe(reference);
    expect(workspace.getSnapshot().error).toBe("");
    workspace.dispose();
  });

  it("does not retain a session when creation finishes after unload", async () => {
    const { workspace, sessions, reference } = fixture();
    let finish!: (id: SessionReference["sessionId"]) => void;
    sessions.create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    workspace.setDirectory("D:/测试空间");
    const connecting = workspace.connect();
    await workspace.connect();
    expect(sessions.create).toHaveBeenCalledOnce();
    workspace.dispose();
    finish(reference.sessionId);
    await connecting;
    expect(sessions.retain).not.toHaveBeenCalled();
  });

  it("releases an opening reference immediately on unload", async () => {
    let finish!: (binding: SessionReference["binding"]) => void;
    const { workspace, reference } = fixture(new Promise(resolve => { finish = resolve; }));
    workspace.setDirectory("D:/测试空间");
    const connecting = workspace.connect();
    await Promise.resolve();
    workspace.dispose();
    expect(reference.release).toHaveBeenCalledOnce();
    finish(reference.binding);
    await connecting;
    expect(workspace.reference()).toBeUndefined();
    expect(reference.release).toHaveBeenCalledOnce();
  });

  it("restores a host-saved session by adopting the exact identity", async () => {
    const { sessions, reference } = fixture();
    const save = vi.fn().mockResolvedValue(true);
    const workspace = createWorkspace(sessions, save);
    await workspace.connect();
    expect(sessions.create).not.toHaveBeenCalled();
    workspace.restore({ cwd: "D:/测试空间", sessionId: reference.sessionId });
    await workspace.connect();
    expect(sessions.create).toHaveBeenCalledWith({ cwd: "D:/测试空间", sessionId: reference.sessionId });
    expect(save).not.toHaveBeenCalled();
    expect(workspace.reference()).toBe(reference);
    workspace.dispose();
  });

  it("does not attach until the host accepts the binding, and reuses the ID on retry", async () => {
    const { sessions, reference } = fixture();
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const workspace = createWorkspace(sessions, save);
    workspace.restore({ cwd: "", sessionId: "" });
    workspace.setDirectory("D:/测试空间");
    await workspace.connect();
    expect(sessions.retain).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().error).toContain("拒绝保存");
    await workspace.connect();
    expect(sessions.create).toHaveBeenCalledTimes(2);
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/测试空间", sessionId: reference.sessionId });
    expect(save).toHaveBeenLastCalledWith({ cwd: "D:/测试空间", sessionId: reference.sessionId });
    expect(workspace.reference()).toBe(reference);
    workspace.dispose();
  });

  it("keeps the same ID when saving fails with a transport error", async () => {
    const { sessions } = fixture();
    const save = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(true);
    const workspace = createWorkspace(sessions, save);
    workspace.restore({ cwd: "D:/测试空间", sessionId: "" });
    await workspace.connect();
    expect(workspace.getSnapshot().error).toBe("Disconnected");
    await workspace.connect();
    expect(sessions.create).toHaveBeenCalledTimes(2);
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/测试空间", sessionId: "learning-session" });
    workspace.dispose();
  });

  it("detaches the old conversation when configuration becomes unavailable", async () => {
    const { sessions, reference } = fixture();
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true));
    workspace.restore({ cwd: "D:/first", sessionId: reference.sessionId });
    await workspace.connect();
    workspace.unavailable();
    expect(workspace.reference()).toBeUndefined();
    expect(reference.release).toHaveBeenCalledOnce();
    const next = { ...reference, sessionId: "next-session" as SessionReference["sessionId"], release: vi.fn() };
    sessions.retain.mockReturnValue(next);
    workspace.restore({ cwd: "D:/second", sessionId: next.sessionId });
    expect(workspace.getSnapshot().error).toBe("");
    await workspace.connect();
    expect(workspace.reference()).toBe(next);
    expect(sessions.create.mock.calls).toEqual([
      [{ cwd: "D:/first", sessionId: reference.sessionId }],
      [{ cwd: "D:/second", sessionId: next.sessionId }],
    ]);
    workspace.dispose();
    expect(reference.release).toHaveBeenCalledOnce();
    expect(next.release).toHaveBeenCalledOnce();
  });

  it("ignores an old opening result after configuration has recovered", async () => {
    let finish!: (binding: SessionReference["binding"]) => void;
    const { sessions, reference } = fixture(new Promise(resolve => { finish = resolve; }));
    const workspace = createWorkspace(sessions, vi.fn().mockResolvedValue(true));
    workspace.restore({ cwd: "D:/first", sessionId: reference.sessionId });
    const first = workspace.connect();
    await Promise.resolve();
    expect(sessions.retain).toHaveBeenCalledOnce();
    workspace.unavailable();
    const next = { ...reference, sessionId: "next-session" as SessionReference["sessionId"], ready: Promise.resolve(reference.binding), release: vi.fn() };
    sessions.retain.mockReturnValue(next);
    workspace.restore({ cwd: "D:/second", sessionId: next.sessionId });
    await workspace.connect();
    finish(reference.binding);
    await first;
    expect(workspace.reference()).toBe(next);
    expect(workspace.getSnapshot()).toMatchObject({ cwd: "D:/second", sessionId: next.sessionId, connecting: false, error: "" });
    expect(reference.release).toHaveBeenCalledOnce();
    workspace.dispose();
    expect(next.release).toHaveBeenCalledOnce();
  });

  it("does not attach an old session when saving finishes after configuration loss", async () => {
    const { sessions, reference } = fixture();
    let finish!: (saved: boolean) => void;
    const workspace = createWorkspace(sessions, () => new Promise(resolve => { finish = resolve; }));
    workspace.restore({ cwd: "D:/first", sessionId: "" });
    const connecting = workspace.connect();
    await Promise.resolve();
    workspace.unavailable();
    finish(true);
    await connecting;
    expect(sessions.retain).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().loading).toBe(true);
    workspace.restore({ cwd: "D:/first", sessionId: reference.sessionId });
    await workspace.connect();
    expect(workspace.reference()).toBe(reference);
    expect(sessions.create).toHaveBeenCalledTimes(2);
    expect(sessions.create).toHaveBeenLastCalledWith({ cwd: "D:/first", sessionId: reference.sessionId });
    workspace.dispose();
  });
});
