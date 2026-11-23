# Agent Harness 扩展设计

## 1. 目标

在原有四容器部署验收基础上，把 Agent 从单轮问答扩展为可执行任务的 Harness：

- 可查询公开互联网并读取网页正文。
- 可在隔离工作区创建和读取文件。
- 可发现并加载 Agent Skills。
- 可维护显式执行计划。
- 使用 PI 原生多轮工具循环，直到得到最终回答。
- 所有工具轮次和执行结果可从 Run 事件、指标和工作台查看。
- 可接收 Markdown、文本、HTML、DOCX、PDF 和网页 URL。
- 可通过 `@skill-name` 显式加载角色 Skill。
- 可通过 SSE 实时显示回答 token、工具事件和状态。

## 2. 工具

| 工具 | 作用 | 边界 |
|---|---|---|
| `web_search` | DuckDuckGo Lite 搜索 | 返回标题、URL、摘要 |
| `web_fetch` | 抓取公开网页并转成文本 | 仅 http/https、阻断私网、限制重定向、大小和超时 |
| `workspace_list` | 列出工作区文件 | 仅 `/workspace`，忽略隐藏目录和 `node_modules` |
| `workspace_read` | 读取工作区文本 | 路径必须位于工作区，限制文件大小和输出字符数 |
| `workspace_write` | 创建或追加文本产物 | 路径必须位于工作区，限制单次内容大小 |
| `update_plan` | 更新当前 Run 的计划 | 最多 12 个步骤 |
| `load_skill` | 加载 Skill 正文 | 按名称加载，不暴露容器绝对路径 |
| `read_skill_file` | 读取 Skill 附带文件 | 路径限制在 Skill 根目录 |

联网工具在每次 DNS 解析后拒绝 loopback、私网、link-local 和本地域名，并逐次校验重定向目标。工具输出默认限制为 20,000 字符，网页响应默认上限为 1 MB。

## 3. Skills

Skill 使用 Agent Skills 目录规范：

```text
agent/skills/{skill-name}/SKILL.md
```

启动时只向模型暴露 `name` 和 `description`。任务匹配后，模型调用 `load_skill` 读取完整说明，再通过 `read_skill_file` 按需读取引用文件。

内置 Skill：

- `web-research`：查询、来源选择和交叉验证。
- `task-planning`：计划制定与状态维护。
- `artifact-writer`：结构化报告和文件交付。
- `software-delivery-*`：从 EvalLab 引入的 PM、架构、前后端、移动端、DBA、测试、运维、反向设计和共享交付规范。

## 4. 多格式输入

`POST /v1/runs` 的 `attachments` 支持两种来源：

- `data_base64`：文件内容，最高 8 MB/文件、20 MB/请求。
- `url`：公网网页，复用 SSRF 防护的网页抓取链路。

抽取方式：

- Markdown、文本、CSV、JSON、XML、代码：UTF-8 文本。
- HTML：清理脚本和样式后转成正文。
- DOCX：Mammoth 提取 Word 正文。
- PDF：PDF.js 按页提取文本。

原始文件写入 Run 的 `raw/` 目录，附件元数据写入 `input.json`、`result.json` 和事件流。附件正文作为不可信上下文注入本轮 Prompt，并受单文件与总字符数限制。

## 5. Skill 引用

工作台 Skill 标签可插入 `@skill-name`。运行前解析显式引用，加载对应 `SKILL.md`，完整工作流会进入当前 Prompt；结果保存到 `skills_used`，事件流记录 `skill.referenced`。

## 6. Agent Loop

PI Agent 在工具返回后自动进入下一轮模型请求，直到不再请求工具或达到限制。当前限制：

- 最多 8 个循环轮次。
- 最多 16 次工具调用。
- 单次工具超时 20 秒。

每轮产生 `agent.turn.started`，每次工具调用产生 `tool.call.started` 和 `tool.call.finished`。Run 结果额外保存：

- `loop_turns`
- `tool_calls_total`
- `tools_used`
- `skills_used`
- `plan`

## 7. 流式输出

`GET /v1/runs/{run_id}/events` 推送：

- `state`：Run 状态。
- `token`：当前生成的完整文本快照。
- `trace`：循环轮次、工具调用和 Skill 引用。
- `done`：终态结束信号。

工作台“实时”模式提交异步 Run 后立即建立 SSE，逐步渲染回答。

## 8. 可观测性

新增 Agent 指标：

- `agent_tool_calls_total{tool,outcome}`
- `agent_tool_call_duration_ms{tool,outcome}`

`GET /v1/capabilities` 返回当前工具、Skill 和执行限制。Agent Workbench Inspector 展示能力清单、计划、循环轮数、工具调用次数和 Skill 使用情况。

## 9. 安全边界

- Agent 容器仍以非 root `node` 用户运行。
- 工作区和 Skill 路径均执行根目录约束及符号链接逃逸检查。
- 不提供任意 Shell 工具，避免模型读取容器环境变量或执行宿主机命令。
- 不把厂商 API Key 注入 Agent；Agent 仍只持有 LiteLLM 网关凭据。
- Web 内容视为不可信输入，模型需综合并引用来源，不能覆盖系统安全规则。
- 附件正文和 Skill 文件同样作为不可信数据注入，并限制大小、字符数和文件数量。
