# 安装与本机配置

## 发行包与运行目录

发行ZIP只包含程序和文档。`prepare-codex-trial.mjs` 会在用户指定的新目录创建固定运行副本、合成Vault和随机凭据，安装生产依赖，不自动注册Codex。准备目录必须不存在；已有安装按知识指南升级，不重复生成。

```powershell
node scripts/prepare-codex-trial.mjs "$env:LOCALAPPDATA\KnowledgeButler\rc1"
```

以该目录为例，插件位于 `plugins/learning-os-trial`，配置位于 `demo/connection.json`，合成库位于 `demo/vault`。生成的 `TRIAL.md` 给出完整本机路径、验证、注册和停止命令。`TRIAL.md`、`.mcp.json`、`connection.json` 及Vault只能留在本机。

## 连接已有Vault

1. 先在合成库确认程序可用；备份个人Vault以及旧运行目录和连接配置。
2. 关闭相关工具连接和页面，停止当前服务：

```powershell
$runtime = "$env:LOCALAPPDATA\KnowledgeButler\rc1"
node "$runtime\plugins\learning-os-trial\dist\knowledge-launcher.js" stop --config "$runtime\demo\connection.json"
```

服务未启动时无需停止；不要把无法连接误认为已停止了其他进程。

3. 编辑本机 `connection.json`，保留随机生成的 `token`，将 `vaultRoot` 改为已经存在的个人Vault绝对路径，并设置对应目录映射。下面是字段示例，路径与token须换成本机实际值：

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

4. 重启Codex连接，在新聊天调用 `learning_status`，核对返回的库身份与映射，再读取一篇旧笔记。先用少量明确选择的材料验证保存和恢复，不同时运行另一个writer。

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
