import type { Page, Workspace } from "./workspace";
import { referenceFromHash, referenceHash, type NoteReference } from "./references";

const routes: Record<Page, string> = {
  "概览": "overview", "Inbox": "inbox", "知识库": "knowledge",
  "项目": "projects", "学习": "learning", "日志": "activity",
};

export function pageFromHash(hash: string): Page | undefined {
  return (Object.keys(routes) as Page[]).find(page => hash.split("?")[0] === `#learning-os/${routes[page]}`);
}

// Own only our hash namespace; retain the host URL, query and history state.
export function createNavigation(
  browser: Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">,
  workspace: Pick<Workspace, "navigate" | "getSnapshot">,
  select: (open: boolean) => void,
) {
  let owned = false;
  let active = false;
  const write = (hash: string) => {
    const url = new URL(browser.location.href);
    url.hash = hash;
    if (url.href !== browser.location.href) browser.history.pushState(browser.history.state, "", url);
  };
  const sync = () => {
    const page = pageFromHash(browser.location.hash);
    if (page) {
      owned = true;
      workspace.navigate(page, referenceFromHash(browser.location.hash));
      select(true);
    } else if (owned) {
      owned = false;
      select(false);
    }
  };
  browser.addEventListener("popstate", sync);
  browser.addEventListener("hashchange", sync);
  return {
    start: sync,
    navigate(page: Page) {
      write(`#learning-os/${routes[page]}`);
      sync();
    },
    openReference(reference: NoteReference) { write(referenceHash(reference)); sync(); },
    observePanel(open: boolean) {
      if (open && !active && !pageFromHash(browser.location.hash)) {
        write(`#learning-os/${routes[workspace.getSnapshot().page]}`);
        owned = true;
      } else if (!open && active && owned) {
        write("");
        owned = false;
      }
      active = open;
    },
    leave() { write(""); owned = false; select(false); },
    dispose() {
      browser.removeEventListener("popstate", sync);
      browser.removeEventListener("hashchange", sync);
    },
  };
}

export type Navigation = ReturnType<typeof createNavigation>;
