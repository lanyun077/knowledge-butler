# 知识管家 · Knowledge Butler

基于本地 Markdown / Obsidian 知识库的个人知识、学习与项目管理工具。通过 Codex 聊天整理材料，通过管理页面浏览记录、项目和知识星空。

**首个候选发行版：v0.1.0-rc.1。** 当前发行入口为 Windows + Node.js 24 LTS + Codex；这不是独立桌面安装器。真实模型整理质量、当前 Codex 完整页面链路及 Obsidian 实际启动仍需实测，详见 [发行说明](CHANGELOG.md) 和 [兼容范围](compatibility.md)。

## 功能

- 收集聊天文本、Markdown、公开网页和正常文本 PDF，保留来源与版本。
- 维护 Daily、项目进展与学习目标，按用户选择的材料整理知识。
- 使用固定模板生成带出处的知识条目，未变化的材料可复用。
- 三维知识星空、思维导图及 Markdown 目录；长文通过 Obsidian 阅读。
- 首页模块可增删、拖动排序；提供保存记录、变更预览和备份恢复。
- 普通总结、归纳、新增与小修改按请求直接保存；删除、大改、恢复覆盖遵循明确授权。文件版本检查、冲突保护和备份保留。

## 安装候选发行包

1. 安装 [Node.js 24 LTS](https://nodejs.org/) 和 Codex，确认 `node --version` 为 `v24.x`，`codex --version` 可用。
2. 从 [GitHub Releases](https://github.com/lanyun077/knowledge-butler/releases) 下载 `knowledge-butler-0.1.0-rc.1-windows.zip`，解压到本机目录。GitHub 自动生成的源码 ZIP 不含构建产物，请使用附加的Windows发行包。
3. 在解压目录打开 PowerShell，准备一个**尚不存在**的固定运行目录：

```powershell
node scripts/prepare-codex-trial.mjs "$env:LOCALAPPDATA\KnowledgeButler\rc1"
```

脚本安装锁定的生产依赖，创建合成测试库和本机连接配置；不会注册插件或覆盖已有库。首次运行需要网络访问 npm。默认不连接个人库，也不创建提醒或周报。

4. 按生成目录中的 `TRIAL.md` 先验证，再注册本地市场并安装插件：

```powershell
$runtime = "$env:LOCALAPPDATA\KnowledgeButler\rc1"
node "$runtime\plugins\learning-os-trial\scripts\verify-codex-trial.mjs" "$runtime\plugins\learning-os-trial" "$runtime\demo"
codex plugin marketplace add "$runtime"
codex plugin add learning-os-trial@learning-os-trial
node "$runtime\plugins\learning-os-trial\scripts\verify-codex-plugin.mjs" "$runtime"
```

5. 重启 Codex，在新聊天说“打开知识管家”，或调用 `learning_status` 核对测试库。`learning-os-trial` 是保留的插件标识，便于现有试用用户升级。

运行目录包含凭据和知识库，**不要上传、分发或随意移动**。安装命令不应覆盖已有市场；已安装旧试用版的用户请先看 [升级与回退](KNOWLEDGE-GUIDE.md#升级与回退)。本发行包不自动替换旧安装。

## 连接个人知识库

先在合成库验收，随后备份个人 Vault，停止对应服务，再在本机连接配置中设置 `vaultRoot` 和目录映射。不要重新生成测试库覆盖个人资料，也不要与旧服务同时写同一个库。

配置字段、直接 MCP 连接和服务停止命令见 [安装与配置](INSTALL.md)。完整使用流程、授权、来源与恢复说明见 [知识指南](KNOWLEDGE-GUIDE.md)。Obsidian 本身可直接打开 Vault；图中原文链接使用 `obsidian://`，需本机已安装并允许协议跳转。

## 从源码构建

```powershell
npm ci --legacy-peer-deps --ignore-scripts
npm test
npm run build
npm run release:package
```

产物位于 `release/`：Windows发行ZIP、DSH插件tarball及 `SHA256SUMS.txt`。发行ZIP包含构建产物、锁文件、安装脚本和第三方许可，不含凭据、Vault、node_modules或开发记录。DSH入口保留，实际客户端兼容范围单独列于兼容文档。

## 许可与反馈

项目采用 [Knowledge Butler 源码可见许可](LICENSE)：个人使用、企业内部日常工作使用免费，允许符合条款的查看、修改和非商业再分发；销售软件、以软件能力提供付费服务、商业产品集成需另行授权。用户笔记与生成内容不受该软件许可限制。此许可不属于标准开源许可。

问题反馈及商业授权申请：[GitHub Issues](https://github.com/lanyun077/knowledge-butler/issues)。仓库当前为私有，访问及下载以仓库权限为准。第三方及旧MIT代码保留原有权利，见 [第三方说明](THIRD-PARTY.md)。
