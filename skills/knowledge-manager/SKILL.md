---
name: knowledge-manager
description: Open the installed knowledge manager or a specific management page when the user asks to open 知识管家, 管家首页, 保存记录, 待保存方案, 项目管理 or 学习管理. Use for entering and navigating the manager, not developing its code or general knowledge questions.
---

用户要求“打开知识管家／进入管家／展示管家主页”时，直接调用 `learning_open_manager({view: "home"})`，不要先只输出介绍、工具清单或旧文字首页。

明确要进入具体栏目时传对应 view：保存记录为 records，待保存方案为 plans，知识为 knowledge，项目为 projects，学习为 learning，设置为 settings。查看已有方案列表不表示批准保存；打开某页也不自动发起新方案、模型轮次或任务。

组件可用时，简短说明已打开及相关操作即可，不在聊天重复整份页面 JSON。用户可通过“新建”选择操作，预览请求后发送到当前聊天；不支持发送时复制请求继续。资料、Daily、项目和学习的业务仍复用现有工具与个人写入规则。

未显示组件时，使用 `learning_manage` 的对应文字视图；records 的文字回退使用 activity，材料可用 sources，正文使用 learning_read，来源关系使用 learning_provenance。明确说明当前是文字结果，不声称图形界面已打开。

工具未加载或连接失败时报告具体问题，让用户在启用本插件的新聊天重开。不要通过 shell、HTTP 或直接读写 Vault 代替用户要求的管家入口，不自动重装插件或修改配置。

普通新增、追加和小修改按用户请求直接保存，不再二次确认。只有删除、大范围改写和恢复覆盖才询问；用户已确认或实际Full access可直接执行。页面保存按钮本身就是明确用户操作，不依赖宿主再次弹窗。
