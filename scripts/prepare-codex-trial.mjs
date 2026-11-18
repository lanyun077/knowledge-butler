import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Preparation only: the caller separately registers and installs the marketplace.
const destination = process.argv[2];
if (!destination || !isAbsolute(destination) || process.argv.length !== 3) throw new Error("Pass a new absolute trial directory");
if (process.platform !== "win32" || Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("This trial supports Windows with Node.js 24 LTS; install it from https://nodejs.org/");
}
const source = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (pkg.version !== manifest.version) throw new Error("Package and plugin versions differ");
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination);
const plugin = join(destination, "plugins", manifest.name);
await mkdir(join(plugin, "scripts"), { recursive: true });
for (const name of ["package.json", "package-lock.json", "skills", "README.md", "compatibility.md", "KNOWLEDGE-GUIDE.md", "docs/GETTING-STARTED.md", "docs/images", "LICENSE", "THIRD-PARTY.md", "third-party", "INSTALL.md", "CHANGELOG.md", "RELEASE-VALIDATION.md"]) {
  await cp(join(source, name), join(plugin, name), { recursive: true });
}
// Codex 0.163 discovers bundled MCP servers through the compatibility layout.
// Do not also install root plugin.json: that host then ignores these servers.
await mkdir(join(plugin, ".codex-plugin"));
await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
  name: manifest.name, version: manifest.version, description: manifest.description,
  skills: "./skills/", mcpServers: "./.mcp.json", requires_local_executor: true,
  interface: manifest.extensions["com.openai"].interface,
}, null, 2));
await mkdir(join(plugin, "dist"));
await cp(join(source, "dist", "knowledge-launcher.js"), join(plugin, "dist", "knowledge-launcher.js"));
await cp(join(source, "dist", "knowledge-setup.js"), join(plugin, "dist", "knowledge-setup.js"));
await cp(join(source, "dist", "knowledge-setup.exe"), join(plugin, "dist", "knowledge-setup.exe"));
await cp(join(source, "dist", "knowledge-manager.html"), join(plugin, "dist", "knowledge-manager.html"));
await cp(join(source, "dist", "knowledge-manager.NOTICES.txt"), join(plugin, "dist", "knowledge-manager.NOTICES.txt"));
await cp(join(source, "scripts", "prepare-knowledge-demo.mjs"), join(plugin, "scripts", "prepare-knowledge-demo.mjs"));
await cp(join(source, "scripts", "verify-codex-trial.mjs"), join(plugin, "scripts", "verify-codex-trial.mjs"));
await cp(join(source, "scripts", "verify-codex-plugin.mjs"), join(plugin, "scripts", "verify-codex-plugin.mjs"));
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
// Match the repository's lockfile installation mode (DSH prerelease peer ranges).
const install = spawnSync(process.execPath, [npmCli, "ci", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: plugin, stdio: "inherit", windowsHide: true });
if (install.error || install.status !== 0) throw install.error ?? new Error("Production dependency installation failed; trial was not registered");
const demo = join(destination, "demo");
const prepare = spawnSync(process.execPath, [join(plugin, "scripts", "prepare-knowledge-demo.mjs"), demo], { stdio: "inherit", windowsHide: true });
if (prepare.error || prepare.status !== 0) throw prepare.error ?? new Error("Synthetic demo preparation failed");
await writeFile(join(destination, "设置知识库.cmd"), `@echo off\r\nchcp 65001 >nul\r\nstart "" "%~dp0plugins\\${manifest.name}\\dist\\knowledge-setup.exe" "${process.execPath}" "%~dp0plugins\\${manifest.name}\\dist\\knowledge-setup.js" "%~dp0demo\\connection.json"\r\n`);
await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
  mcpServers: { knowledge: { command: process.execPath,
    args: [join(plugin, "dist", "knowledge-launcher.js"), "stdio", "--config", join(demo, "connection.json")] } },
}, null, 2));
await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
await writeFile(join(destination, ".agents", "plugins", "marketplace.json"), JSON.stringify({
  name: "learning-os-trial", interface: { displayName: "知识管家候选版" },
  plugins: [{ name: manifest.name, source: { source: "local", path: `./plugins/${manifest.name}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
}, null, 2));
await writeFile(join(destination, "TRIAL.md"), `# 知识管家候选版\n\n版本：${manifest.version}。仅 Windows／Node.js 24 LTS。\n\n合成 Vault：${join(demo, "vault")}\n\n合成项目：${join(demo, "synthetic-project")}\n\n此目录包含本机连接凭据，不上传或分发。提醒和周报没有创建。\n\n准备不修改 Codex 配置。先执行安装副本验证，再注册安装：\n\n\`\`\`powershell\nnode '${join(plugin, "scripts", "verify-codex-trial.mjs")}' '${plugin}' '${demo}'\ncodex plugin marketplace add '${destination}'\ncodex plugin add learning-os-trial@learning-os-trial\nnode '${join(plugin, "scripts", "verify-codex-plugin.mjs")}' '${destination}'\n\`\`\`\n\n重启 Codex 后在新聊天调用 learning_status、learning_manage，读取 Wiki/版本检查.md。请仅通过 learning_* 工具维护知识；普通总结、整理、新增、追加和小修改按用户请求直接保存；仅删除、大范围改写和恢复覆盖才额外询问，已确认或实际Full access可直接执行。另开聊天确认同一 vaultId／instanceId。不得从弹窗拒绝或失败推断授权。\n\n卸载先停止服务，再移除插件和市场（保留此目录和 Vault）：\n\n\`\`\`powershell\nnode '${join(plugin, "dist", "knowledge-launcher.js")}' stop --config '${join(demo, "connection.json")}'\ncodex plugin remove learning-os-trial@learning-os-trial\ncodex plugin marketplace remove learning-os-trial\n\`\`\`\n\n升级与回退：保留 demo 和连接配置，停止旧服务后替换运行副本／依赖，刷新安装并重启 Codex，重新预览待保存方案；不要重新生成现有测试库或重放旧批准。服务运行入口固定在本机准备目录，市场和缓存依赖此目录，请勿移动；路径变化需重新生成连接声明并刷新安装。插件使用 Codex 0.163 兼容格式。Codex 宿主发现检查通过后再进行真人测试；候选发行不代表真实模型及完整宿主流程已验收。\n`);
await writeFile(join(destination, "TRIAL.md"), "\n## 模块化管理界面与受控操作\n\n重启后在新聊天调用 learning_open_manager（例如：展示管家主页）。通过左上角菜单进入概览、记录、知识、项目、学习和设置。首页可管理模块、增删与拖动排序；布局和明暗选择按库保存在当前浏览器，宿主限制本机存储时仅本次有效。记录展示实际保存时间、位置、概况和已记录的出处；没有保存日志的材料不编造时间。\n\n右上角循环箭头重新查询当前状态；正文版本改变后刷新从第一页重新读取。详情通过叉号关闭。方案完整预览、保存、取消、项目置顶和恢复复用原有工具；普通写入不再依赖宿主弹窗，页面保存按钮直接执行。取消确认不等于取消方案，关闭详情也不会保存。查看页面不会自动修改笔记。\n\n保留聊天展示入口，不承诺固定侧栏或额外对话入口。U0 承载已由用户报告正常；新版 UI、消息交接、模型整理及 Obsidian 跳转的实际宿主验收单独记录。若没有组件或桥接已关闭，重新调用 learning_open_manager；仍无组件时可使用 learning_manage、learning_read、learning_provenance、learning_preview 和 learning_request_confirmation 的文字工具。不要把文字输出、合成批准或独立浏览器预览当作实际宿主验收。\n", { flag: "a" });
await writeFile(join(destination, "TRIAL.md"), "\n## 使用入口\n\n在启用插件的新聊天说“打开知识管家”，或选择同名快捷技能，直接打开主页；也可指定记录、知识、项目或学习栏目。右上角“新建”提供保存资料、记录今天、新建学习目标、查找知识和使用指南；项目、学习及材料详情提供对应操作。先预览请求，宿主支持文本消息时明确点击发送到当前聊天；不支持时复制请求继续。普通保存请求本身就是授权，无需再次批准。保存成功后可直接查看对应记录。关闭嵌套详情逐层返回，并保留原列表位置。\n", { flag: "a" });
await writeFile(join(destination, "TRIAL.md"), `\n## 知识整理与版本回退\n\n选择项目、学习及材料 → 预览范围／排除 → 继续到聊天 → 按模板整理并保存 → 知识页切换三视图。长文通过 Obsidian 链接阅读；页面切换不触发模型。完整流程、隔离验证和升级／回退见 [知识整理说明](plugins/${manifest.name}/KNOWLEDGE-GUIDE.md)。\n\nalpha.47 等早期 writer 不理解多来源方案，不能继续保存新格式待完成方案。回退前用新版明确取消这些方案，停止服务并保留整库快照；必要时恢复升级前配套的运行目录与 Vault 备份，升级后资料另存。实际宿主、模型和 Obsidian 启动仍需另外验收。\n`, { flag: "a" });
await writeFile(join(destination, "TRIAL.md"), `\n## 接入或新建正式知识库\n\n在合成副本验证通过后，双击运行目录的 \`设置知识库.cmd\`。选择已有知识库的位置即可接入；新建时选择存放位置、填写名称即可，分类目录由程序处理。程序保存连接配置，更换库前停止当前服务；上一份配置保留为 \`demo/connection.json.previous\`。完成后重启 Codex。新库不添加示例文章；同库重新接入保留原映射，新接入使用默认目录，其他位置的笔记不自动搬迁。首次在 Obsidian 使用新库时，需通过其“打开本地仓库”选择该文件夹一次。\n\n逐步操作与界面截图见 [图文入门指南](plugins/${manifest.name}/docs/GETTING-STARTED.md)。\n`, { flag: "a" });
process.stdout.write(`Trial prepared (not registered): ${destination}\nPlugin: ${plugin}\nLibrary setup: ${join(destination, "设置知识库.cmd")}\n`);
