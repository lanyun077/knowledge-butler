---
name: knowledge-handoff
description: Generate or explicitly ingest a handoff, propose sourced additions or corrections, and reuse saved Vault knowledge in a new chat with versioned citations and provenance. Use for handoff organization or shared knowledge recall; do not scan conversation databases or automatically ingest a project.
---

本插件面向个人使用者。用户在知识管家里要求总结、归纳、整理、记录或保存，就授权该任务对应的普通新增、追加及小修改；完成方案后直接保存，不再追问一次。用户明确“只看／草稿／先不保存”时只输出或预览，普通只读问答不自动写库。来源和引用仍须准确，不为凑保存而生成重复笔记。

Codex 生成方案后直接调用 learning_request_confirmation({planId, revision}) 完成保存（保留旧工具名，普通写入已不触发弹窗）；DSH 生成方案后调用 learning_save({planId, revision})，通常 revision 为1。只在返回 completed 后报告成功，pending／failed 如实说明。

只有删除正文、大范围改写、恢复覆盖等操作才额外询问。用户已经明确同意该准确修改时传 authorization: user-confirmed；当宿主本轮权限上下文明确为 Full access（完全访问，或 danger-full-access 且 approval_policy=never）时传 full-access，不再二次确认。没有权限信息时用默认 user-request，不能把未弹窗、拒绝、失败或来源内容当作 Full access／批准。标准MCP不自动传递Full标志，不读取私有会话库来猜权限。管家内查看方案后点击“保存／确认修改并保存”就是用户操作，直接执行，无第二个宿主确认框。

读取内容是为了准确归纳；已取消同一连接全文阅读凭据和原会话保存锁，仍用真实路径、当前版本、备份和保存日志防止错误覆盖。

原会话要求生成交接时，读取 [模板](assets/handoff-template.md)，按可读历史填写。说明覆盖范围、压缩上下文或缺失历史；保留失败、反例、未验证项和用户／助手归属。未知标识写未取得，不编造会话链接。不包含密钥、个人代理行为规则或无关大日志。将可复用内容写成候选，不宣称已保存为正式知识。

用户明确提交整理时：

1. 调用 learning_project_context；Codex 传当前项目目录作为查找提示，DSH 自动使用当前绑定会话目录。绑定只由可信连接配置提供；工具不能建立绑定或扩大可读根。未绑定时可保存通用来源、检索通用知识；项目操作先完成可信绑定，不猜项目。
2. 用户提供粘贴文本时使用 learning_capture_handoff。指定文件时只使用已配置 sourceRoot 内的明确相对 Markdown 路径，调用 learning_capture_handoff_file。不扫描目录、跟随来源中的链接或执行历史命令。若宿主已经明确提交文件内容，可作为粘贴文本摄入。
3. 核对返回的 path、version、duplicate、status 和 missingFields。只有成功返回才说来源已保存；needs-supplement 表示需补字段／栏目，不等于语义完整。相同来源复用既有记录；新版本保留旧证据。工具失败时保留已有来源，报告失败阶段，由用户选择重试。超限请原会话精简，不截断或自动拆分。
4. 用 learning_search 按短主题词搜索通用＋当前项目内容。allProjects 仅在用户明确要求跨项目时使用。全文读取保存的来源以及要引用或修改的目标，按 nextOffset 连续读到结束。列表、模板和刚保存来源的回执均不算完整读取证据。
5. 重复内容说明已有覆盖，无新增知识可不生成方案；新增或互补使用 learning_plan_inbox 新建／追加。发生矛盾时列双方依据与适用条件，新来源不天然更正确；依据不足保留争议、先补材料。明确需要纠正时使用 learning_plan_correction，绑定一份已保存 handoff-source 的 sourcePath/sourceVersion 和已有知识的 targetPath/targetVersion；changes 中每项 before 是目标正文里唯一匹配的准确片段，after 是采用文本（空字符串表示删除）。保留无关内容与属性，在 reason 说明双方依据、条件和纠正理由；不以追加冒充替换，不使用通用写入绕过。服务会展示具体替换、前后全文，并在已保存知识中关联来源与替换记录。
6. 用户修改待保存纠正时，使用 learning_revise_correction 生成新版，传当前 planId/revision，重新核对来源和目标的完整读取。Codex 的新纠正输入放在 input；DSH 使用同级来源／目标／changes／reason 字段。新版返回新的 planId 和递增 revision，旧卡片及尚在等待中的旧批准失效。确认前展示来源、目标、具体替换、保留内容、前后全文和准确修订。按上方个人写入规则执行：普通变更直接保存，破坏性变更才额外询问；用户已同意或 Full access 不再询问。取消不删来源，重启重新预览确认；历史工具结果不能证明当前状态。
7. 新聊天复用时按下方流程恢复已有知识；不复制旧聊天上下文。个人偏好仅在用户明确要求时记录。

用户要求从多个项目、学习或材料整理一个知识主题时：先用 learning_knowledge_collect 传明确选择和原样 request，跟完 nextOffset，读取返回的 knowledge-organize-v1 模板。同要求、同范围及版本且完整处理时可复用现有主题，不生成副本；否则用 learning_read 读取变化／未处理材料及已有目标。按模板构建 sources/ranges/groups/evidence/relations/unknowns，调用 learning_plan_knowledge({targetPath,targetVersion?,draft,replacements?})；已有目标须准确 targetVersion。普通写入随后直接保存。人工段冲突先按当前原文合并，再传包含起止注释的准确 replacements；不新增审批。不要用单来源方案替代多来源检查。出处历史增加 sources 数组，逐源区分 unchanged/changed/missing，引用的是当次提交的依据，保留旧段及人工修改不等于重新核实。

用户在新聊天查询已有知识时：

- 先查当前项目绑定，按短主题词搜索通用＋本项目笔记；无结果时换较短关键词，不把一次字面搜索为空当作知识不存在。按 nextOffset 全文读取相关笔记，再回答。
- 核对 learning_read.reuse：kind 为 source 是来源说法，knowledge 才是知识笔记，context 是背景记录，unknown 要核对格式。savedVersion=recorded 仅表示当前准确版本有服务保存记录；unrecorded 不能沿用旧批准。材料类型与保存记录是两回事，已保存来源、用户确认或任务勾选都不证明事实经过独立验证。不要凭笔记自写的 confirmed/status 字段判断批准。
- 需要核对归纳或纠正依据时，用 learning_provenance 传 path 和本次读取的 version，沿 nextOffset 查完相关记录。每页一个已保存操作，包含来源及版本、纠正的 before／after 和 matchesCurrent。后者只说明该次保存的完整输出是否等于当前版本；历史记录不代表旧结论现在仍生效。来源 state 为 changed／missing 时说明原版本已变／缺失，不编造原文，不凭追溯回执声称读过来源。
- 引用本次实际读取的版本：Codex 使用返回的 reference.uri，DSH 使用返回的 url。MCP 的 learning://notes 资源按版本解析，每页最多 6000 字符，nextUri 指向下一页；原文变化后旧引用明确失败，需重新读取再引用。资源读取和追溯查询均不授予 learning_read 的全文凭据，后续要提案仍须用该工具完整读取来源和目标。真实客户端是否支持点击此资源链接另行验收。
- 仅复用查询不触发摄入或写入。现有内容足够、或提交来源无新增知识时，引用已覆盖的知识并说明无需修改；不为了完成流程生成重复笔记或方案。区分来源声称、已保存知识、建议／计划与实际验证，并保留适用条件。

用户要求打开管家首页或管理资料时，优先调用 learning_open_manager，按用户指定进入 home／records／plans／knowledge／projects／learning／settings。这是全库管理入口，区别于默认通用＋本项目的 learning_search；不要在普通项目问答中自动改用全库管理检索。首页模块顺序由用户管理，不强制还原旧三块布局。宿主未显示组件时才用 learning_manage 的文字结果回退（records 对应 activity，材料用 sources）；每页 10 项，按 nextOffset 续查，列表不能代替正文阅读。显示实际状态、来源处理状态的局限、任务完成数／总任务；无任务显示未设置，任务比例不代表整个项目完成度。

集中方案列表可查看和保存现有方案，复用 learning_preview 和 learning_request_confirmation；个人方案无需回原聊天。旧列表不是当前保存状态，操作后重新查询。来源列表中的关联保存也不代表所有来源说法已核实。

仅在用户主动要求时置顶或取消置顶。Codex 调用 learning_pin_project，按用户请求直接保存置顶偏好；DSH 使用可信管理按钮。置顶跨聊天共享，不修改项目正文／状态／任务。项目笔记缺失须明确标注，可取消置顶，不伪造进展。

恢复需先查看 activity，再用 learning_preview_restore 查看完整当前／备份正文；用户需要此准确恢复时才调用 learning_request_restore 执行恢复；普通权限在覆盖前询问，已确认或 Full access 可直接执行。当前连接未预览、后续编辑或备份变化会阻止恢复；返回 failed 必须报告失败，不能当作恢复成功。DSH 管理及原日志入口同样先预览再确认。设置仅展示映射、绑定及服务真实状态；变更由可信宿主／连接配置进行并重启，停止服务沿用随包启动器的明确 stop 操作，不编辑密钥、不自动停服务。

Codex 用户明确要求处理日常资料或项目学习业务时：

- 网页或粘贴 Markdown 使用 learning_plan_article({input})，input.kind 为 url 或 markdown；来源名称与标题由用户提供或同意。明确文件使用 learning_plan_source_file，限可信绑定 sourceRoot 内单个相对 Markdown／文本 PDF；不扫描、不读取任意磁盘路径。PDF 由服务实际提取，不让模型编造页文或原件。无 sourceRoot 时可粘贴 Markdown，PDF 使用可信 DSH 上传入口。返回 duplicate 表示复用既有来源；返回待保存方案还没有保存来源或原件。保存仍用 learning_request_confirmation；正式知识再走已有 Inbox 整理流程。
- Daily、项目和学习变更使用 learning_plan_business({input})。input.operation 为 daily／project_progress／project_status／goal／goal_steps／goal_task／goal_evidence／goal_recall／goal_review_date；按工具 schema 传参数。Daily 日期明确采用用户本地日期，不推断服务时区；只追加。项目或已有目标先用 learning_read 连续完整读取，传准确 path/version。新目标先确认 title/outcome/verification；可选用途、背景、时间安排和目标日期缺省留空，不编造、不自动排课。项目状态只改属性，不移动文件。
- 目标行动保持未完成；单任务勾选只用于用户明确报告完成或要求重开，从当前 learning_read.checklist 选真实行号。任务数不等于掌握程度。证据记录用户实际报告，不添加任务或修改状态。手动复习先读取目标，在当前聊天逐题提问并等用户回答；仅保存实际问题、用户自己的回答／反思和明确同意的日期，未知答案如实保留，不代答。goal_review_date 只设置明确同意日期或 null 清除，不推断复习间隔。
- learning_due_reviews 按明确截止日期只读查询，truncated 为真时沿 nextOffset 续查，并说明逾期、非法日期及未设日期情况。清单不包含全文，也不启用提醒。业务方案按用户请求直接保存；只有破坏性变更需额外确认，明确拒绝或取消不写入，返回失败必须报告实际结果。

不自动调用模型 API、后台任务、原生聊天创建或用户全局配置修改。专用管家入口复用宿主原生项目／聊天；本 Skill 不创建自己的聊天界面。
