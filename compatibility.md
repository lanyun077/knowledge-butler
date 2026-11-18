# v0.1.0-rc.2 兼容范围

| 组件 | 当前范围与证据 |
| --- | --- |
| 操作系统 | Codex准备脚本只支持Windows；本机已完成生产依赖安装与隔离工具链测试。macOS/Linux不在此发行承诺中 |
| Node.js | 24 LTS；安装脚本检查主版本24，实际验证采用24.21.0 |
| Codex | 使用 `.codex-plugin/plugin.json`、`.mcp.json` 插件格式；本机 0.169.0-alpha.11.1 独立配置中发现 33 工具和 3 技能。页面支持 MCP Apps |
| MCP Apps | 正式自包含HTML＋官方AppBridge合成宿主已验证，包含519节点图、宽窄屏、主题与全屏交互；当前Codex真实CSP、消息交接和完整页面流程尚未全部验收 |
| Obsidian | 原文入口由本地服务启动 `obsidian://open`，支持中文及空格路径；已验证原生应用打开笔记。知识库需先在 Obsidian 登记 |
| Obsidian Local REST API | 可选元数据桥接基线5.4.0，只接受本机HTTP地址；不可用时使用本地Markdown显式链接。Codex全库星图目前不额外拉取该元数据 |
| DSH Web | 固定开发契约0.1.7-alpha.1 / Cordis4.0.3；此前隔离业务接口与基础UI有证据。此次未完成当前DSH页面及真实模型全流程验收 |
| DSH Desktop / EAC | 未验收，不宣称兼容 |
| 模型 | 使用宿主已有模型；不内置模型、不附API凭据。真实模型首次整理、未变化复用、增量整理质量和token用量尚待实测 |

## 已验证的程序行为

全量测试覆盖本地读写、来源版本、单writer、幂等、持久方案、保存与恢复、普通写入授权、多来源整理及短投影。生产副本验证覆盖双MCP客户端、服务重启、五来源整理、人工附录保留、冲突和PDF worker／字体。固定合成草稿不能替代模型效果验收。

管理页的三维依赖为Three.js 0.187.0 / 3d-force-graph 1.80.2，导图为Markmap；浏览器需要WebGL，不能启动时仍提供目录和短摘要。三维图按批读取，但完整短图最终仍在浏览器内存中；常态按距离简化，全视图主动绘制当前范围全部节点，不保证巨大数据量下的帧率。

## 升级兼容

保留插件标识 `learning-os-trial` 和现有 Markdown 格式。页面资源地址更新为 `ui://learning-os/manager-u2-v4-interaction-3.html`，快照协议保持 `u2-v4`。alpha.47 等早期 writer 不理解多来源方案；回退需先用新版取消未完成的新格式方案，停止服务并保留整库备份。具体步骤见[知识指南](KNOWLEDGE-GUIDE.md#升级与回退)。
