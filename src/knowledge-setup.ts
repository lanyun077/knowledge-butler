import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureLibrary, librarySettings } from "./knowledge-library";

async function main() {
  const [flag, configFile, command, ...rest] = process.argv.slice(2);
  if (flag !== "--config" || !configFile || !isAbsolute(configFile) || rest.length || command && !["state", "apply"].includes(command)) {
    throw new Error("Usage: node dist/knowledge-setup.js --config <absolute-connection.json> [state|apply]");
  }
  if (command === "state") process.stdout.write(JSON.stringify(await librarySettings(configFile)));
  else if (command === "apply") {
    let text = ""; for await (const chunk of process.stdin) text += chunk;
    process.stdout.write(JSON.stringify(await configureLibrary(configFile, JSON.parse(text))));
  } else {
    if (process.platform !== "win32") throw new Error("知识库设置窗口当前支持 Windows");
    const child = spawn(fileURLToPath(new URL("knowledge-setup.exe", import.meta.url)), [process.execPath, fileURLToPath(import.meta.url), resolve(configFile)], { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`知识库设置窗口退出（${code}）`)));
    });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
