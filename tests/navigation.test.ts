import { describe, expect, it, vi } from "vitest";
import { createNavigation, pageFromHash } from "../src/navigation";
import type { Page } from "../src/workspace";
import type { NoteReference } from "../src/references";

function fixture(hash = "") {
  const events = new EventTarget();
  let url = new URL(`https://example.test/dsh/?host=chosen${hash}`);
  const entries = [url.href];
  const state = { host: "unchanged" };
  let page: Page = "概览";
  const references: (NoteReference | undefined)[] = [];
  const browser = {
    get location() { return url as unknown as Location; },
    history: { state, pushState: vi.fn((next: unknown, _title: string, value: string | URL) => {
      expect(next).toBe(state);
      url = new URL(value);
      entries.push(url.href);
    }) } as unknown as History,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  const select = vi.fn();
  const navigation = createNavigation(browser, {
    navigate: (value, reference) => { page = value; references.push(reference); },
    getSnapshot: () => ({ page, noteReference: undefined, cwd: "", sessionId: "", conversations: [], connecting: false, loading: false, error: "" }),
  }, select);
  return { navigation, select, entries, references, page: () => page, url: () => url,
    backTo(index: number) { url = new URL(entries[index]); events.dispatchEvent(new Event("popstate")); },
  };
}

describe("workspace navigation", () => {
  it("reopens the same reference on repeated clicks without adding duplicate history", () => {
    const f = fixture();
    const reference = { path: "Wiki/中文.md", scope: "test-vault", version: "v1" };
    f.navigation.openReference(reference);
    f.navigation.openReference(reference);
    expect(f.references).toEqual([reference, reference]);
    expect(f.references[0]).not.toBe(f.references[1]);
    expect(f.entries).toHaveLength(2);
    f.navigation.dispose();
  });
  it("opens a deep link and preserves the host pathname, query and state", () => {
    const f = fixture("#learning-os/projects");
    f.navigation.start();
    expect(f.page()).toBe("项目");
    expect(f.select).toHaveBeenCalledWith(true);
    f.navigation.navigate("学习");
    expect(f.url().pathname).toBe("/dsh/");
    expect(f.url().search).toBe("?host=chosen");
    f.backTo(0);
    expect(f.page()).toBe("项目");
    expect(f.entries).toHaveLength(2);
    f.navigation.dispose();
  });

  it("returns to the host via history and detaches its listeners", () => {
    const f = fixture();
    f.navigation.start();
    expect(f.select).not.toHaveBeenCalled();
    f.navigation.observePanel(true);
    f.navigation.navigate("知识库");
    f.backTo(0);
    expect(f.select).toHaveBeenLastCalledWith(false);
    f.navigation.dispose();
    f.select.mockClear();
    f.backTo(1);
    expect(f.select).not.toHaveBeenCalled();
  });

  it("clears its URL when another host panel is selected without duplicating page entries", () => {
    const f = fixture();
    f.navigation.observePanel(true);
    f.navigation.navigate("概览");
    expect(f.entries).toHaveLength(2);
    f.navigation.observePanel(false);
    expect(f.url().hash).toBe("");
    f.navigation.dispose();
  });

  it("does not interpret foreign or malformed routes as workspace instructions", () => {
    expect(pageFromHash("#settings")).toBeUndefined();
    expect(pageFromHash("#learning-os/unknown")).toBeUndefined();
    expect(pageFromHash("#learning-os/%ZZ")).toBeUndefined();
    const f = fixture("#settings");
    f.navigation.start();
    expect(f.select).not.toHaveBeenCalled();
    f.navigation.dispose();
  });
});
