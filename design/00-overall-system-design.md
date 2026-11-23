# AgentCompose 整体系统设计

> 文档定位：AgentCompose 的权威总设计。本文给出从作业目标、运行架构、接口、数据、监控、安全、部署到验收的完整主线；细节以被引用的专项设计文档为准。
>
> 设计依据：
> - 飞书作业六《用 Docker Compose 部署并验收 PI Agent》
> - 飞书第六章学习笔记
> - week06 课程代码 `course_code/week06`
> - `requirements/01-assignment-requirements.md`

## 1. 设计目标

系统需要在一台宿主机上，通过一条命令启动四个容器，完成：

1. 客户端通过 HTTP 调用 PI Agent。
2. PI Agent 通过 LiteLLM Gateway 调用 DeepSeek 上游模型。
3. Agent 返回非空结果并保存运行数据。
4. Prometheus 同时抓取 Gateway、Agent 和自身指标。
5. Grafana 自动加载 Dashboard，展示本轮请求产生的真实数据。
6. `docker compose down` 后重新构建启动，数据和 Dashboard 仍可恢复并复验。

## 2. 架构结论

采用：

```text
单主机 Docker Compose
├── Agent 单体业务服务
├── LiteLLM 独立模型网关
├── Prometheus 指标存储
└── Grafana 统一观测界面
```

不采用：

- Kubernetes 或云平台编排。
- Postgres、Redis、Loki、Langfuse、Eval 平台。
- Multi-Agent、Subagent 或服务注册中心。
- Docker Socket 控制面。
- 额外 Web 管理容器。

原因：

- 作业固定四个容器。
- 主业务链路只有一次 Agent Run。
- 业务状态可用本地目录持久化。
- 监控指标由 Prometheus 和 Grafana 完成。
- 生命周期控制由 Docker Compose 完成。

## 3. 四个平面

| 平面 | 负责组件 | 职责 |
|---|---|---|
| 运行面 | `agent`、`gateway`、上游模型 | 执行 Agent Run 和模型调用 |
| 观测面 | `prometheus`、`grafana` | 抓取、查询和展示指标 |
| 控制面 | Docker Compose CLI | 构建、启动、停止、重建和健康状态检查 |
| 验收面 | 本地脚本、HTTP 探针、`check.md` | 执行验收顺序并保存脱敏证据 |

“统一查看”和“统一控制”分开：

- Grafana 统一查看指标和 Dashboard。
- Prometheus 查询原始时序和 targets。
- `docker compose` 统一控制容器生命周期。
- 当前不提供浏览器内启动、停止或修改密钥的能力。

## 4. 总体拓扑

```text
宿主机 127.0.0.1
│
├── :${GATEWAY_PORT:-4000} -> gateway:4000
│       LiteLLM Proxy
│       ├── deepseek-flash-primary
│       ├── deepseek-flash-standby
│       └──→ DeepSeek OpenAI-compatible upstream
│
├── :${AGENT_PORT:-8080} -> agent:8080
│       Node.js + PI 1.6.0
│       ├── HTTP API
│       ├── bounded Run queue
│       ├── Run archive
│       └── /metrics
│
├── :${PROMETHEUS_PORT:-9090} -> prometheus:9090
│       ├── scrape gateway:4000/metrics
│       ├── scrape agent:8080/metrics
│       └── scrape localhost:9090/metrics
│
└── :${GRAFANA_PORT:-8765} -> grafana:8765
        └── query http://prometheus:9090

Compose network: agent-compose-net
```

容器内端口固定，宿主机端口只通过 `.env` 覆盖。所有宿主机端口默认绑定 `127.0.0.1`。

## 5. 服务契约

| Compose 服务 | 镜像/构建 | 容器端口 | 健康检查 |
|---|---|---:|---|
| `gateway` | 锁定版本/digest 的 LiteLLM | 4000 | `GET /health/liveliness` |
| `agent` | 本地多阶段 Node 构建 | 8080 | `GET /health` |
| `prometheus` | `prom/prometheus:v3.1.0` + digest | 9090 | `GET /-/healthy` |
| `grafana` | `grafana/grafana:11.4.0` + digest | 8765 | `GET /api/health` |

启动依赖：

```text
gateway healthy
  -> agent healthy
  -> prometheus healthy
  -> grafana healthy
```

`prometheus` 同时依赖 `gateway` 和 `agent` 健康；Grafana 依赖 Prometheus 健康并配置较长初始化时间。

## 6. 模块划分

| 模块 | 部署位置 | 核心职责 |
|---|---|---|
| M01 Gateway | `gateway` | 逻辑模型、鉴权、主备路由、Fallback、LiteLLM 指标 |
| M02 Agent | `agent` | HTTP、Run 状态机、PI Runtime、队列、归档、Agent 指标和 `/ui/` 测试工作台 |
| M03 Observability | `prometheus`, `grafana` | 抓取、时序存储、Dashboard、告警 |
| M04 Orchestration | Compose | 网络、端口、卷、健康依赖、环境注入 |
| M05 Acceptance | 本地脚本/文档 | 探针、链路、指标、Dashboard、重建复验 |

## 7. Agent 内部结构

```text
agent:8080
├── http-server
│   ├── GET /health
│   ├── POST /v1/runs
│   ├── GET /v1/runs/{run_id}
│   ├── GET /metrics
│   ├── GET /v1/runs
│   ├── GET /v1/runs/{run_id}/events
│   └── GET /ui/
│
├── run-service
│   ├── request validation
│   ├── bounded queue
│   ├── concurrency limiter
│   ├── deadline management
│   └── run state machine
│
├── pi-adapter
│   ├── construct OpenAI-compatible model
│   ├── derive PI baseUrl as ${GATEWAY_BASE_URL}/v1
│   ├── call PI Agent loop
│   └── extract final text
│
├── run-store
│   ├── input.json
│   ├── versions.json
│   ├── events.jsonl
│   └── result.json
│
├── metrics
│   └── one prom-client Registry
│
└── config
    └── environment validation
```

### 7.1 Run 状态机

```text
queued -> running -> completed
queued -> running -> failed
queued -> failed
running -> failed
```

失败原因至少区分：

- 参数校验失败。
- 队列满。
- 排队超时。
- Gateway 鉴权失败。
- 上游调用失败。
- 总任务超时。
- 进程重启中断。

### 7.2 同步和异步

- 默认同步：`POST /v1/runs` 等待终态，返回 `completed` 和 `output`。
- 异步：请求体 `async=true` 时返回 `202 queued`，通过 `GET /v1/runs/{run_id}` 查询。
- 同步和异步共用同一状态机、归档和指标路径。

## 8. 端到端流程

### 8.1 正常同步请求

```text
Client
  -> Agent POST /v1/runs
  -> reuse session_id and previous completed turns
  -> validate input and tenant
  -> create request_id, run_id, trace_id, model_call_id
  -> write Run input and versions
  -> enter bounded queue
  -> call PI Runtime
  -> PI calls http://gateway:4000/v1/chat/completions
  -> LiteLLM authenticates GATEWAY_API_KEY
  -> LiteLLM routes deepseek-flash to upstream
  -> extract choices[0].message.content
  -> persist completed result and usage
  -> increment Agent metrics
  -> return run_id, completed, output
```

### 8.2 指标链路

```text
gateway /metrics ───┐
agent /metrics ─────┼-> Prometheus scrape every 15s
prometheus /metrics ┘          |
                               v
                         Grafana Dashboard
                               |
                               v
                  request / token / run / latency panels
```

### 8.3 启动与验收

```text
docker compose up -d --build
  -> 4 services healthy
  -> 4 host probes return 200
  -> 3 Prometheus targets UP
  -> direct gateway model call succeeds
  -> one Agent request reaches completed
  -> gateway and agent metrics increase
  -> Grafana shows at least 2 non-zero panels
  -> docker compose down
  -> rebuild and repeat
```

## 9. 外部接口

| 接口 | 入口 | 最低契约 |
|---|---|---|
| Agent health | `GET :8080/health` | 200，含 `status=ok` |
| Submit Run | `POST :8080/v1/runs` | 含 `run_id`、`status`、`output` |
| Query Run | `GET :8080/v1/runs/{run_id}` | 返回终态和结果 |
| Agent metrics | `GET :8080/metrics` | Prometheus 文本格式 |
| Recent Runs | `GET :8080/v1/runs` | 按创建时间倒序 |
| Agent UI | `GET :8080/ui/` | 提交运行并查看响应、事件和元数据 |
| Gateway health | `GET :4000/health/liveliness` | 200 |
| Gateway chat | `POST :4000/v1/chat/completions` | 鉴权通过，内容非空 |
| Gateway metrics | `GET :4000/metrics` | Bearer 通过，真实 `litellm_*` |
| Prometheus health | `GET :9090/-/healthy` | 200 |
| Prometheus targets | `GET :9090/api/v1/targets` | 三个任务 `UP` |
| Grafana health | `GET :8765/api/health` | 200，数据库 `ok` |

完整字段和错误码见 `04-api-design.md`。

## 10. 数据与持久化

### 10.1 不引入数据库

唯一业务实体是 Run。作业不要求多用户、复杂查询或事务联表，因此使用文件归档。

### 10.2 Run 目录

```text
/app/data/runs/{run_id}/
├── input.json
├── versions.json
├── events.jsonl
├── result.json
└── raw/                 # 可选
```

统一关联字段：

- `request_id`
- `run_id`
- `trace_id`
- `model_call_id`
- `release_id`

运行数据不包含密钥。事件统一在写入后可供排障，终态以 `result.json` 为准。

### 10.3 命名卷

| 卷 | 容器路径 | 内容 |
|---|---|---|
| `agent-data` | `/app/data` | Run 目录和事件 |
| `agent-workspace` | `/workspace` | PI 工作目录 |
| `prometheus-data` | `/prometheus` | TSDB |
| `grafana-data` | `/var/lib/grafana` | Dashboard 状态和 Grafana 数据库 |

正常验收不使用 `docker compose down -v`。

## 11. 配置与凭据

| 类别 | 变量 | 注入位置 |
|---|---|---|
| 宿主机端口 | `GATEWAY_PORT`, `AGENT_PORT`, `PROMETHEUS_PORT`, `GRAFANA_PORT` | Compose |
| 上游模型 | `DEEPSEEK_API_BASE`, `DEEPSEEK_API_KEY` | 仅 `gateway` |
| Gateway 鉴权 | `LITELLM_MASTER_KEY`, `LITELLM_VIRTUAL_KEY` | `gateway` |
| Agent 网关凭据 | `GATEWAY_API_KEY` | `agent`，由 master key 映射 |
| Agent 并发 | `AGENT_MAX_CONCURRENCY`, `AGENT_QUEUE_CAPACITY` | `agent` |
| Agent 超时 | `AGENT_QUEUE_TIMEOUT_MS`, `AGENT_GATEWAY_TIMEOUT_MS`, `AGENT_RUN_TIMEOUT_MS` | `agent` |
| 版本 | `RELEASE_ID` | `agent` |
| Grafana | `GRAFANA_ADMIN_PASSWORD` | `grafana` |

边界：

- `DEEPSEEK_API_KEY` 绝不进入 Agent、Prometheus 或 Grafana。
- `.env` 不进入 Git，也不进入镜像构建上下文。
- Prometheus 使用临时 `bearer_token_file` 抓取 Gateway。

## 12. 技术选型

| 层 | 选择 |
|---|---|
| 编排 | Docker Compose v2 |
| Gateway | LiteLLM Proxy，锁定版本/digest |
| Agent | Node 24、TypeScript 5.9.3、原生 `node:http` |
| PI | `@earendil-works/pi-*` 1.6.0 |
| 指标 | `prom-client` 15.1.3 |
| Prometheus | `v3.1.0` |
| Grafana | `11.4.0` |
| 模型别名 | `deepseek-flash` |
| 上游模型 | `deepseek/deepseek-v4-flash` |

## 13. 可观测性

### 13.1 Agent 必选指标

- `agent_runs_total{status,tenant,mode}`
- `agent_run_duration_ms{status,tenant,mode}`

### 13.2 Agent 增强指标

- `agent_queue_depth`
- `agent_runs_in_flight`
- `agent_run_queue_wait_ms`
- `agent_model_calls_total`
- `agent_model_call_duration_seconds`
- `agent_model_tokens_total`
- `agent_build_info`
- `agent_up`

### 13.3 Gateway 指标

- `litellm_proxy_total_requests_metric_total`
- `litellm_request_total_latency_metric_bucket`
- `litellm_total_tokens_metric_total`
- `litellm_spend_metric_total`

### 13.4 Dashboard

`AgentCompose Overview` 至少包含：

1. Gateway Requests。
2. Gateway Tokens or Cost。
3. Agent Runs。
4. Agent Run p95 或错误。

增强面板：

- Queue Depth。
- Agent Model Call p95。
- Gateway Request p95。
- Targets Up。

完整 PromQL 和告警见 `05-observability-design.md`。

## 14. 安全设计

- 宿主机端口只绑定 `127.0.0.1`。
- 厂商密钥仅进入 Gateway。
- Agent 只持有网关凭据。
- Gateway `/metrics` 需要 Bearer。
- 不挂载 Docker Socket。
- Agent 最终镜像使用非 root 用户。
- 日志和事件不保存 Authorization、密钥或完整敏感请求头。
- `release.json` 只记录镜像、模型和配置摘要。
- 当前 `tenant` 只是指标标签，不是身份授权边界。

## 15. 可复现设计

1. 提交 `package-lock.json`，Dockerfile 使用 `npm ci`。
2. 宿主机 `node_modules` 通过 `.dockerignore` 排除。
3. 镜像固定 tag + digest。
4. 配置模板提交，真实 `.env` 排除。
5. `release.json` 绑定镜像、模型和配置摘要。
6. `down` 后重建保留命名卷。
7. `README.md` 和 `check.md` 记录真实脱敏结果。

至少两项工程优化：

- Agent 多阶段构建。
- Agent 非 root 运行。

## 16. 测试与验收

| 层级 | 内容 |
|---|---|
| 单元测试 | 参数校验、状态机、队列、超时、持久化 |
| 集成测试 | Agent -> Gateway mock/real、Prometheus 抓取 |
| 容器验收 | 四容器 healthy、四宿主机探针 |
| 业务验收 | 同步/异步 Run 到 completed，output 非空 |
| 指标验收 | 两侧指标增长，三个 target UP |
| 展示验收 | Grafana 数据源、Dashboard 和至少两个非零面板 |
| 重建验收 | down 后 build/up，数据和 Dashboard 恢复 |
| 安全验收 | 密钥隔离、脱敏和构建上下文检查 |

作业评分映射：

| 评分项 | 设计落点 |
|---|---|
| A LiteLLM 20 分 | M01、模型配置、三个端点、Gateway 指标 |
| B PI Agent 25 分 | M02、PI 1.6.0、HTTP API、Run 状态、Agent 指标 |
| C Prometheus/Grafana 25 分 | 三抓取任务、Bearer 文件、四面板 Dashboard |
| D Compose 20 分 | 四服务、端口、healthcheck、启动顺序、忽略文件 |
| E 可复现 10 分 | 锁文件、digest、README、check.md、重建复验 |

## 17. 实施阶段

| 阶段 | 内容 |
|---|---|
| A | Compose、目录、配置模板 |
| B | LiteLLM Gateway |
| C | Agent HTTP、Run 状态、归档 |
| D | Agent 指标 |
| E | Prometheus、Grafana、Dashboard |
| F | 多阶段镜像、非 root、ignore 文件 |
| G | 自动化验收脚本 |
| H | README、check.md、重建复验 |
| I | 关联 ID、队列、版本绑定、告警增强 |

详细顺序见 `09-implementation-roadmap.md`。

## 18. 目录蓝图

```text
AgentCompose/
├── docker-compose.yml
├── release.json
├── .env.example
├── .gitignore
├── README.md
├── check.md
├── agent/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   └── src/
├── gateway/
│   └── config.yaml
├── prometheus/
│   └── prometheus.yml
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/prometheus.yml
│   │   ├── dashboards/agent-compose.yml
│   │   └── alerting/agent-compose-alerts.yml
│   └── dashboards/agent-compose.json
├── scripts/
│   └── acceptance.ps1
└── check/
    └── evidence/
```

当前设计阶段不创建上述实现文件。

## 19. 风险与处理

| 风险 | 处理 |
|---|---|
| LiteLLM 指标名随版本变化 | 锁定版本并在首次真实请求后核对 `/metrics` |
| Prometheus 无法读取 token 文件 | 启动时由同一运行用户生成 `0600` 文件并验证 target |
| PI Provider 类型不兼容 | 以 1.6.0 类型声明、Mock Gateway 测试和真实链路结果为准 |
| 容器健康检查缺少 curl | 使用镜像内 Python、Node 或最小工具 |
| Grafana 初始化慢 | 健康依赖 + 较长 `start_period` |
| 队列过载 | 有界队列、并发上限、429、task deadline |
| 重启时 Run 未结束 | 启动扫描并标记 `interrupted_by_restart` |
| 看到 target UP 但没有业务样本 | 必须完成真实 Agent 请求后验收 |

## 20. 完成定义

以下全部满足才算实现完成：

1. `docker compose up -d --build` 拉起且只拉起四个服务。
2. 四服务 healthy，四个宿主机探针均返回 200。
3. 三个 Prometheus targets 均为 UP。
4. Gateway 直连返回非空回答。
5. Agent 同步和异步 Run 都能达到 completed。
6. Gateway 和 Agent 指标相对基线增长。
7. Grafana 自动加载 Dashboard，至少两个面板非零。
8. `down` 后重建，数据卷、Run 和 Dashboard 自动恢复。
9. README、check.md 和截图证据完整且脱敏。

## 21. 权威文档索引

| 主题 | 权威文档 |
|---|---|
| 需求基线 | `requirements/01-assignment-requirements.md` |
| 技术栈 | `design/01-tech-stack.md` |
| 系统架构 | `design/02-system-architecture.md` |
| 数据与持久化 | `design/03-database-design.md` |
| API | `design/04-api-design.md` |
| 可观测性 | `design/05-observability-design.md` |
| 部署 | `design/06-deployment-design.md` |
| 安全 | `design/07-security-design.md` |
| 验收 | `design/08-acceptance-design.md` |
| 实施路线 | `design/09-implementation-roadmap.md` |
| 生产化增强 | `design/10-production-hardening.md` |
| 课程代码基线 | `design/11-course-code-baseline.md` |
