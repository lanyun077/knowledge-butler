# 安装与本机配置

环境：Windows、[Node.js 24 LTS](https://nodejs.org/)、Codex 和 Obsidian。确认 `node --version` 和 `codex --version` 可用。

从 [Releases](https://github.com/lanyun077/knowledge-butler/releases) 下载附加的 Windows ZIP，解压后在该目录打开 PowerShell。使用发行附件，GitHub 自动生成的源码 ZIP 不含构建产物。日常操作见[简明使用指南](docs/GETTING-STARTED.md)。

## 发行包与运行目录

发行ZIP只包含程序和文档。`prepare-codex-trial.mjs` 会在用户指定的新目录创建固定运行副本、合成Vault和随机凭据，安装生产依赖，不自动注册Codex。准备目录必须不存在；已有安装按知识指南升级，不重复生成。

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\KnowledgeButler" | Out-Null
node scripts/prepare-codex-trial.mjs "$env:LOCALAPPDATA\KnowledgeButler\rc2"
```

使用一个尚未创建的目录作为运行目录。

准备完成后，按生成的 `TRIAL.md` 验证并注册插件：

```powershell
$runtime = "$env:LOCALAPPDATA\KnowledgeButler\rc2"
node "$runtime\plugins\learning-os-trial\scripts\verify-codex-trial.mjs" "$runtime\plugins\learning-os-trial" "$runtime\demo"
codex plugin marketplace add "$runtime"
codex plugin add learning-os-trial@learning-os-trial
node "$runtime\plugins\learning-os-trial\scripts\verify-codex-plugin.mjs" "$runtime"
```

重启 Codex，在新聊天中说“打开知识管家”。已有安装按[升级与回退](KNOWLEDGE-GUIDE.md#升级与回退)操作。

以该目录为例，插件位于 `plugins/learning-os-trial`，配置位于 `demo/connection.json`，合成库位于 `demo/vault`。生成的 `TRIAL.md` 给出完整本机路径、验证、注册和停止命令。`TRIAL.md`、`.mcp.json`、`connection.json` 及Vault只能留在本机。

## 连接已有Vault

双击运行目录的 **设置知识库.cmd** 接入知识库；也可按[配置文件接入](#通过配置文件接入)手动设置。

1. 在合成库验证程序后，关闭当前管家页面与工具连接，双击运行目录的 **设置知识库.cmd**。
2. 选择“使用已有知识库”，通过“选择文件夹”选择已经在 Obsidian 使用的库。
3. 点击“接入知识库”，完成后重启 Codex。无需逐项设置分类目录；同库重新接入保留原映射，新接入的库自动使用默认基础目录。旧笔记不搬迁、不改写。
程序自动核对目标服务、停止旧服务、备份并保存配置。在新聊天核对 `learning_status`；仅纳入已配置的资料目录，其他位置的笔记不会自动搬入。需要调整旧库目录映射时，可使用下方高级配置，不放在首次接入窗口。

同一库重新接入保留凭据及原项目绑定；更换库使用新凭据，不把旧库项目绑定带入新库。上一份配置保存在 `demo/connection.json.previous`，旧库资料保留。所有连接该运行副本的宿主都应重新连接；程序不会自动修改其他独立运行副本的配置。

## 框架式新建Vault

双击同一“设置知识库.cmd”，选择“新建知识库”，选择父文件夹并填写名称，点击“创建并接入”。建立 `Inbox`、`Wiki`、`Projects`、`Learning`、`Daily` 与空的 `.obsidian` 目录，生成正式连接；不注入示例文章、项目或学习成果。业务操作继续使用管家已有模板，不要求用户配置 Obsidian 社区插件。

同名文件夹已存在时不会覆盖；可换名或通过已有库入口接入。关闭窗口、取消目录选择均不会创建知识库。创建后重启 Codex；首次在 Obsidian 使用这个新库时，通过其“打开本地仓库”选择新文件夹一次。

开发源码也可启动同一窗口：`npm run knowledge:setup -- --config <本机connection.json的绝对路径>`。窗口使用 Windows 自带 .NET Framework，核心配置仍由 Node.js 24 执行；不会向模型开放任意目录操作接口。

## 通过配置文件接入

关闭管家页面与工具连接，停止对应服务：

```powershell
$runtime = "$env:LOCALAPPDATA\KnowledgeButler\rc2"
node "$runtime\plugins\learning-os-trial\dist\knowledge-launcher.js" stop --config "$runtime\demo\connection.json"
```

服务未启动时无需停止；不要把无法连接误认为已停止了其他进程。

编辑本机 `connection.json`，保留随机生成的 `token`，将 `vaultRoot` 改为已经存在的个人Vault绝对路径，并设置对应目录映射。下面是字段示例，路径与token须换成本机实际值：

```json
{
  "schemaVersion": 1,
  "vaultRoot": "D:\\Notes\\MyVault",
  "token": "<本机生成的64位十六进制凭据>",
  "folders": {
    "inbox": "Inbox",
    "knowledge": "Wiki",
    "daily": "Daily",
    "projects": "Projects",
    "learning": "Learning"
  },
  "projects": []
}
```

目录映射使用Vault内相对目录；旧知识目录可映射为 `Knowledge`，不需搬文件。`projects` 为空时仍可粘贴聊天材料。需要将当前代码项目绑定到Vault项目笔记时，添加 `directory`（存在的项目绝对目录）、`projectPath`（映射内项目笔记路径），可选 `sourceRoot`（允许提交指定文件的已有绝对目录）。不配置不会自动扫描项目。

重启Codex连接，在新聊天调用 `learning_status`，核对返回的库身份与映射，再读取一篇旧笔记。先用少量明确选择的材料验证保存和恢复，不同时运行另一个writer。

## 直接使用MCP

不使用本地插件市场时，可在支持STDIO的MCP客户端配置同一个固定运行副本；技能需由宿主另行加载。命令和参数如下：

```text
command: node的本机绝对路径
args: [launcher的本机绝对路径, "stdio", "--config", connection.json的本机绝对路径]
```

launcher位于运行副本 `dist/knowledge-launcher.js`。多个客户端可连接同一配置，通过单服务writer协作。不要把凭据放进命令行或仓库；客户端只传配置路径。图形管理页需要宿主支持MCP Apps，否则使用文本工具。

## 排错与移除

- 未加载工具：检查 `node --version`、固定运行目录是否被移动、插件是否启用，然后重启新聊天；运行生成的宿主发现验证脚本。
- 页面桥接失效：重新调用 `learning_open_manager`。再次登录后宿主连接可能失效，输入暂存不等于连接仍有效。
- 安装依赖失败：保留错误信息，检查npm网络。失败目录不要注册；选一个新目录重新准备。
- 卸载前停止对应服务，再执行 `codex plugin remove learning-os-trial@learning-os-trial` 和 `codex plugin marketplace remove learning-os-trial`。保留运行目录与Vault即可保留资料，卸载不要求删除知识库。
- 旧版回退和多来源方案处理见 [知识指南](KNOWLEDGE-GUIDE.md#升级与回退)。
