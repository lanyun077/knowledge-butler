import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";
import { expect, it } from "vitest";

it("boots the standalone manager from an isolated build without a global React", async () => {
  // Installed/isolated builds inside node_modules do not inherit the source tsconfig.
  const directory = await mkdtemp(resolve("node_modules/.manager-bootstrap-"));
  let dom: JSDOM | undefined;
  try {
    await Promise.all([
      cp("src", join(directory, "src"), { recursive: true }),
      cp("third-party", join(directory, "third-party"), { recursive: true }),
      cp("build-manager.mjs", join(directory, "build-manager.mjs")),
    ]);
    await promisify(execFile)(process.execPath, ["build-manager.mjs"], { cwd: directory, windowsHide: true });
    const html = await readFile(join(directory, "dist/knowledge-manager.html"), "utf8");
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", error => errors.push(error.message));
    let initialized!: () => void;
    const initialization = new Promise<void>(resolve => { initialized = resolve; });
    dom = new JSDOM(html, {
      url: "https://manager.example/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
      beforeParse(window) {
        window.addEventListener("message", event => {
          if (event.data?.method === "ui/initialize") initialized();
        });
      },
    });
    expect(errors).toEqual([]);
    await initialization;
    expect(dom.window.document.querySelector("#root h1")?.textContent).toBe("正在准备你的空间");
    expect("React" in dom.window).toBe(false);
  } finally {
    dom?.window.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
