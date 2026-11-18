import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Launch a URI constructed by the current Vault, never a caller-supplied URL. */
export async function openNoteUri(uri: string) {
  const run = promisify(execFile);
  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:KNOWLEDGE_NOTE_URI -ErrorAction Stop"],
      { windowsHide: true, env: { ...process.env, KNOWLEDGE_NOTE_URI: uri } });
  } else {
    await run(process.platform === "darwin" ? "/usr/bin/open" : "xdg-open", [uri]);
  }
}
