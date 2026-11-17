import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error("Pass a new absolute directory for the synthetic demo");
await mkdir(destination);
const vaultRoot = join(destination, "vault");
const projectRoot = join(destination, "synthetic-project");
const sourceRoot = join(projectRoot, "handoffs");
await mkdir(sourceRoot, { recursive: true });
for (const folder of ["Inbox", "Wiki", "Daily", "Projects", "Learning"]) await mkdir(join(vaultRoot, folder), { recursive: true });
await writeFile(join(vaultRoot, "Inbox", "合成交接.md"), "# 合成交接\n\n来源：合成试件，非真实会话。\n覆盖：仅一个测试知识点；未调用模型。\n事实：本次练习使用版本检查避免覆盖外部编辑。\n缺口：桌面渲染和真人确认尚未验收。\n");
await writeFile(join(vaultRoot, "Wiki", "版本检查.md"), "# 版本检查\n\n旧知识：保存前读取目标当前版本。\n");
await writeFile(join(vaultRoot, "Projects", "合成项目.md"), "# 合成项目\n\n仅用于隔离验收，不是真实项目。\n");
await copyFile(new URL("../skills/knowledge-handoff/assets/handoff-template.md", import.meta.url), join(sourceRoot, "交接模板.md"));
const configPath = join(destination, "connection.json");
await writeFile(configPath, JSON.stringify({ schemaVersion: 1, vaultRoot, token: randomBytes(32).toString("hex"),
  projects: [{ directory: projectRoot, projectPath: "Projects/合成项目.md", sourceRoot }] }, null, 2), { flag: "wx", mode: 0o600 });
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(packageRoot, "dist", "knowledge-launcher.js");
const quote = value => JSON.stringify(value);
await mkdir(join(destination, "codex-home"));
await writeFile(join(destination, "codex-home", "config.toml"), `[mcp_servers.dsh_knowledge_demo]\ncommand = ${quote(process.execPath)}\nargs = [${quote(entry)}, "stdio", "--config", ${quote(configPath)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 360\n`);
process.stdout.write(`Synthetic demo prepared: ${destination}\nConnection config: ${configPath}\nSynthetic project: ${projectRoot}\nHandoff template: ${join(sourceRoot, "交接模板.md")}\nIsolated CODEX_HOME: ${join(destination, "codex-home")}\n`);
