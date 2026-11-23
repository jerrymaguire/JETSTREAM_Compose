# AgentCompose

Docker Compose 部署并验收 PI Agent、LiteLLM、Prometheus 和 Grafana。

## 1. 当前状态

- 四容器实现完成。
- 真实 DeepSeek 调用通过 LiteLLM 成功。
- Agent 同步和异步运行均达到 `completed`。
- Agent Workbench `/ui/` 支持多轮对话、任务模式、响应、事件和元数据。
- Agent 具备联网搜索、网页抓取、工作区文件、执行计划、Skill 加载和多轮工具循环。
- 支持 Markdown、文本、HTML、DOCX、PDF 和网页 URL 输入。
- 支持 SSE 实时输出、工具事件和 `@skill-name` 显式引用。
- 已集成 13 个 Skills，包括完整软件交付流水线角色技能。
- 三个 Prometheus targets 均为 `UP`。
- Grafana Dashboard 自动加载，业务面板有真实非零数据。
- `docker compose down` 后重建复验通过。
- Agent 测试：40 项通过，行覆盖率 84.08%，分支覆盖率 70.09%。
- Agent UI 浏览器 E2E：通过，桌面和移动端无控制台错误。
- `npm audit --omit=dev`：0 个已知漏洞。

实际验收证据见 [check.md](check.md)。

## 2. 架构

```text
宿主机 127.0.0.1
├── :4000 gateway      LiteLLM -> DeepSeek
├── :8080 agent        PI Agent HTTP + tool loop + skills + Workbench + metrics
├── :9090 prometheus   三个 scrape jobs
└── :8765 grafana      AgentCompose Overview
```

```text
Client
  -> Agent POST /v1/runs
  -> PI SDK agent loop
     -> web_search / web_fetch / workspace / skills / plan
  -> http://gateway:4000/v1/chat/completions
  -> DeepSeek upstream

Prometheus -> gateway:4000/metrics
Prometheus -> agent:8080/metrics
Prometheus -> localhost:9090/metrics
Grafana    -> http://prometheus:9090
```

## 3. 固定服务

| Compose 服务 | 镜像 | 容器端口 | 默认宿主机地址 |
|---|---|---:|---|
| `gateway` | LiteLLM `main-stable` digest | 4000 | `http://127.0.0.1:4000` |
| `agent` | 本地多阶段 Node 构建 | 8080 | `http://127.0.0.1:8080` |
| `prometheus` | `prom/prometheus:v3.1.0` digest | 9090 | `http://127.0.0.1:9090` |
| `grafana` | `grafana/grafana:11.4.0` digest | 8765 | `http://127.0.0.1:8765` |

实例版本和配置摘要见 [release.json](release.json)。

## 4. 依赖版本

| 组件 | 版本 |
|---|---|
| Node.js | 24.19 / 镜像 `node:24-bookworm-slim` digest |
| TypeScript | 5.9.3 |
| PI packages | 1.6.0 |
| `prom-client` | 15.1.3 |
| `mammoth` | 1.13.0 |
| `pdfjs-dist` | 5.4.296 |
| LiteLLM | `main-stable` digest |
| Prometheus | 3.1.0 |
| Grafana | 11.4.0 |

PI 课程代码快照使用 `0.87.1`。实现采用 `1.6.0`，同时满足作业 `>=0.87.x` 要求，并移除旧版依赖中的 high 漏洞。

## 5. 配置

从模板创建本地配置：

```powershell
Copy-Item .env.example .env
```

需要填写：

```dotenv
LITELLM_MASTER_KEY=<long-random-local-key>
LITELLM_VIRTUAL_KEY=<same-as-master>
DEEPSEEK_API_KEY=<vendor-key>
DEEPSEEK_API_BASE=https://api.deepseek.com
GRAFANA_ADMIN_PASSWORD=<strong-local-password>
```

Agent Harness 可调参数（均有默认值）：

```dotenv
AGENT_MAX_LOOP_TURNS=8
AGENT_MAX_TOOL_CALLS=16
AGENT_TOOL_TIMEOUT_MS=20000
AGENT_WEB_FETCH_MAX_BYTES=1000000
AGENT_TOOL_OUTPUT_MAX_CHARS=20000
AGENT_ATTACHMENT_MAX_BYTES=8000000
AGENT_ATTACHMENT_TOTAL_MAX_BYTES=20000000
AGENT_ATTACHMENT_MAX_CHARS=50000
AGENT_ATTACHMENT_TOTAL_MAX_CHARS=120000
AGENT_ATTACHMENT_COUNT_LIMIT=8
```

安全边界：

- `DEEPSEEK_API_KEY` 只注入 `gateway`。
- Agent 只接收 `GATEWAY_API_KEY`。
- Prometheus 使用临时 `bearer_token_file`。
- `.env` 和本地运行数据已被 `.gitignore` 排除。
- 所有端口默认绑定 `127.0.0.1`。

## 6. 启动和停止

```powershell
docker compose up -d --build
docker compose ps
```

停止：

```powershell
docker compose down
```

正常验收不要使用 `down -v`，否则会删除运行记录和监控历史。

## 7. 入口

| 入口 | 地址 |
|---|---|
| Gateway | `http://127.0.0.1:4000` |
| Agent | `http://127.0.0.1:8080` |
| Agent Workbench | `http://127.0.0.1:8080/ui/` |
| Prometheus | `http://127.0.0.1:9090` |
| Grafana Dashboard | `http://127.0.0.1:8765/d/agentcompose-overview/agentcompose-overview` |

健康检查：

```text
GET http://127.0.0.1:4000/health/liveliness
GET http://127.0.0.1:8080/health
GET http://127.0.0.1:9090/-/healthy
GET http://127.0.0.1:8765/api/health
```

## 8. Agent API

### 健康

```http
GET /health
GET /v1/capabilities
```

### 能力清单

`GET /v1/capabilities` 返回当前 Tools、Skills 和 Agent Loop 限制。内置工具：

- `web_search`：DuckDuckGo Lite 联网搜索。
- `web_fetch`：抓取公开网页并提取正文。
- `workspace_list` / `workspace_read` / `workspace_write`：隔离工作区文件操作。
- `update_plan`：维护当前 Run 的执行计划。
- `load_skill` / `read_skill_file`：按需加载 `agent/skills/*/SKILL.md` 及引用文件。

联网工具仅允许公网 HTTP/HTTPS，并拒绝私网、loopback、凭据 URL 和路径逃逸。工作区工具不能访问 `/workspace` 之外的文件，当前不提供任意 Shell。

### 文件和网页附件

`POST /v1/runs` 可携带最多 8 个附件。文件使用 Base64 传输，网页使用 URL：

```json
{
  "input": "@software-delivery-pm 分析这些需求文档",
  "tenant": "demo",
  "attachments": [
    {
      "name": "requirements.md",
      "mime_type": "text/markdown",
      "data_base64": "<base64>"
    },
    {
      "name": "design.pdf",
      "data_base64": "<base64>"
    },
    {
      "name": "Product page",
      "url": "https://example.com/product"
    }
  ]
}
```

支持 `.md`、`.txt`、`.html`、`.docx`、`.pdf`、CSV、JSON、XML 及常见文本/代码文件。原始上传文件保存在 Run 的 `raw/` 目录，抽取文本随本轮上下文发送给模型。

### Skill 引用

- 在工作台点击 Skill 标签，或直接输入 `@software-delivery-frontend`。
- `@software-delivery-pm`、`@software-delivery-architect`、`@software-delivery-backend` 等角色 Skill 可显式触发。
- `@software-delivery-base` 提供跨角色共享的模板、规范和交付标准。
- 显式引用的 Skill 会加载完整 `SKILL.md`，并记录在 `skills_used` 和 `skill.referenced` 事件中。

### 同步运行

```powershell
$body = @{
  input = "用一句话说明什么是幂等"
  tenant = "demo"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8080/v1/runs" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

成功响应包含：

- `run_id`
- `request_id`
- `trace_id`
- `status=completed`
- 非空 `output`
- `usage`

### 异步运行

请求体增加：

```json
{
  "async": true
}
```

初始返回 HTTP 202 和 `queued`，使用以下接口查询：

```http
GET /v1/runs/{run_id}
```

### SSE

```http
GET /v1/runs/{run_id}/events
```

事件流包含：

- `state`：queued、running、completed、failed 状态。
- `token`：模型正在生成的完整文本快照。
- `trace`：Agent 轮次、工具调用和 Skill 引用事件。
- `done`：终态通知。

工作台默认使用“实时”模式，提交后立即显示逐步生成的内容；同步和异步模式仍保留用于 API 验收。

### 指标

```http
GET /metrics
```

## 9. Gateway API

```http
GET  /health/liveliness
POST /v1/chat/completions
GET  /metrics
```

逻辑模型：

```text
deepseek-flash -> deepseek/deepseek-v4-flash
```

LiteLLM 配置启用了：

```yaml
litellm_settings:
  callbacks: ["prometheus"]
```

## 10. 指标

Agent：

- `agent_runs_total`
- `agent_run_duration_ms`
- `agent_http_requests_total`
- `agent_queue_depth`
- `agent_runs_in_flight`
- `agent_run_queue_wait_ms`
- `agent_model_calls_total`
- `agent_model_call_duration_seconds`
- `agent_model_tokens_total`
- `agent_tool_calls_total`
- `agent_tool_call_duration_ms`
- `agent_build_info`
- `agent_up`

Gateway：

- `litellm_proxy_total_requests_metric_total`
- `litellm_request_total_latency_metric_bucket`
- `litellm_total_tokens_metric_total`
- `litellm_spend_metric_total`

Prometheus 抓取间隔为 15 秒。

## 11. Grafana

Provisioning 自动加载：

- 数据源：`Prometheus`
- 数据源 UID：`agent-prometheus`
- Dashboard：`AgentCompose Overview`
- Dashboard UID：`agentcompose-overview`
- 面板数：8
- 告警规则：Gateway target down、Agent target down

Dashboard 地址：

```text
http://127.0.0.1:8765/d/agentcompose-overview/agentcompose-overview
```

根地址 `http://127.0.0.1:8765/` 也默认打开该 Dashboard。Grafana 匿名访问为 Viewer 只读，管理员密码仍从 `.env` 读取。

## 12. Agent Workbench

打开：

```text
http://127.0.0.1:8080/ui/
```

页面支持：

- 最近会话列表和搜索。
- `input`、`tenant`、同步/异步和对话/任务模式。
- “实时”模式通过 SSE 逐步显示回答、状态和工具事件。
- 选择 Markdown、文本、HTML、DOCX、PDF 文件，或添加网页 URL。
- 点击 Skill 标签插入 `@skill-name` 引用。
- 同一 `session_id` 下多轮对话，后续消息自动携带前文。
- 展示可用 Tools、Skills、执行计划、循环轮次和工具调用记录。
- 每个会话支持删除，并同时删除该会话下的全部 Run。
- status、output、Token、耗时和模型展示。
- 事件时间线和原始 JSON。
- run/request/trace/model-call ID 复制。
- Grafana、Prometheus 和健康入口。
- 桌面三栏与移动端抽屉布局。

浏览器 E2E：

```powershell
npm install --prefix scripts
node scripts/e2e-agent-ui.mjs
```

E2E 会真实发送两轮消息，验证同一 session 复用、任务模式、响应、事件和移动布局。

发布前清空 Agent 测试历史：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\clear-agent-history.ps1
```

该脚本只删除 Agent 会话和 Run 记录，不删除 Prometheus、Grafana 或 Docker 卷。

结果：

```text
check/evidence/agent-ui-e2e.json
check/evidence/agent-ui.png
check/evidence/agent-ui-mobile.png
```

## 13. 测试

在 `agent/`：

```powershell
npm ci
npm test
npm run test:coverage
npm audit --omit=dev
```

测试覆盖：

- 配置解析
- Run 文件归档和重启恢复
- 队列容量、并发上限、排队超时
- 同步/异步 HTTP API
- 最近 Run 列表和事件历史
- Agent UI 静态资源和浏览器交互
- SSE 终态事件
- Prometheus 指标输出
- 结构化日志
- PI SDK 经本地 OpenAI-compatible Mock Gateway 的真实调用路径
- PI 多轮工具循环和计划状态
- Skill frontmatter、按需加载和引用文件路径隔离
- 工作区文件读写和目录逃逸防护
- HTML/搜索结果解析、SSRF 地址阻断
- DOCX、PDF、Markdown 和网页附件抽取及原始文件持久化
- SSE token、状态和 trace 事件
- `@skill-name` 显式引用、完整 Skill 注入和结果记录

## 14. 完整验收

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\acceptance.ps1
```

脚本会验证：

1. 四个服务 healthy。
2. 四个宿主机探针返回 200。
3. 三个 Prometheus targets 为 UP。
4. Gateway 直连模型返回非空内容。
5. Agent 同步和异步运行达到 completed。
6. Gateway 和 Agent 指标增长。
7. Grafana 数据源和 Dashboard 已加载。
8. 生成 Grafana 截图。

结果写入：

```text
check/evidence/acceptance-summary.json
check/evidence/grafana-dashboard.png
```

## 15. 工程优化

1. Agent 多阶段构建，最终镜像不包含 TypeScript 工具链和开发依赖。
2. Agent 以非 root `node` 用户运行。
3. Dockerfile 先复制依赖清单并 `npm ci`，复用依赖层缓存。
4. 最终运行镜像约 115 MB，包含 Word/PDF 文本解析但不含浏览器和 TypeScript 工具链。
5. 镜像和配置均记录 digest/hash。
6. PI 升级到 1.6.0，生产依赖审计为 0 漏洞。

## 16. 目录

```text
AgentCompose/
├── docker-compose.yml
├── .env.example
├── release.json
├── agent/
│   ├── skills/              # Agent Skills
│   └── public/              # Agent Workbench
├── gateway/
├── prometheus/
├── grafana/
├── scripts/
├── design/
├── requirements/
├── check/
└── check.md
```

## 17. 设计文档

- [整体系统设计](design/00-overall-system-design.md)
- [技术栈](design/01-tech-stack.md)
- [系统架构](design/02-system-architecture.md)
- [数据与持久化](design/03-database-design.md)
- [API](design/04-api-design.md)
- [可观测性](design/05-observability-design.md)
- [部署](design/06-deployment-design.md)
- [安全](design/07-security-design.md)
- [验收](design/08-acceptance-design.md)
- [实施路线](design/09-implementation-roadmap.md)
- [生产化增强](design/10-production-hardening.md)
- [课程代码对齐](design/11-course-code-baseline.md)
- [Agent Harness 扩展设计](design/12-agent-harness.md)
