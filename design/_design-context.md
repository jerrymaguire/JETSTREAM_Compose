# 设计上下文

## 1. 事实表

### 1.1 业务功能

| 功能 | 概述 | 类型 |
|---|---|---|
| 四服务启动 | 一条 Compose 命令构建并启动全部服务 | 新增 |
| 网关健康检查 | LiteLLM liveliness 探针 | 新增 |
| 网关模型调用 | 通过逻辑模型访问 OpenAI 兼容上游 | 新增 |
| 网关指标导出 | 输出真实 `litellm_*` 指标 | 新增 |
| Agent 运行提交 | 接收 `input` 与 `tenant` 并执行 PI Agent | 新增 |
| Agent 运行查询 | 异步运行状态与终态查询 | 新增 |
| Agent 测试工作台 | 浏览器提交 Run、查看响应、事件和元数据 | 新增 |
| Agent 指标导出 | 输出运行次数与耗时指标 | 新增 |
| 指标抓取 | Prometheus 抓取网关、Agent 和自身 | 新增 |
| 监控展示 | Grafana 自动加载数据源和四面板 Dashboard | 新增 |
| 启动编排 | 按 gateway -> agent -> prometheus -> grafana 启动 | 新增 |
| 验收与证据 | 健康、链路、指标、看板、重建复验 | 新增 |

### 1.2 实体

| 实体 | 来源功能 | 关键字段 |
|---|---|---|
| Run | Agent 运行提交/查询 | `run_id`, `tenant`, `input`, `status`, `output` |
| ModelRoute | 网关模型调用 | `model_name`, `upstream_model`, `base_url` |
| MetricSample | 指标抓取 | 指标名、标签、值、时间 |
| Dashboard | 监控展示 | UID、标题、面板、PromQL |

### 1.3 流程

```text
调用方
  -> Agent POST /v1/runs
  -> PI Agent
  -> gateway:4000/v1/chat/completions
  -> 上游 OpenAI 兼容模型
  -> Agent 生成终态
  -> Prometheus 周期抓取
  -> Grafana 查询 Prometheus
```

### 1.4 输入输出

| 输入/输出 | 字段 | 约束 |
|---|---|---|
| Agent 请求 | `input` | 必填，字符串 |
| Agent 请求 | `tenant` | 必填，字符串，用于指标标签 |
| Agent 请求 | `async` | 可选，布尔值，默认 `false` |
| Agent 响应 | `run_id` | UUID 字符串 |
| Agent 响应 | `status` | `queued/running/completed/failed` |
| Agent 响应 | `output` | 完成时非空，未完成或失败时可为空 |

### 1.5 非功能约束

| 类别 | 约束 |
|---|---|
| 容器数量 | 固定四个 |
| 网络边界 | 容器通过 Compose 服务名访问 |
| 端口边界 | 宿主机默认仅绑定 `127.0.0.1` |
| 凭据边界 | 上游厂商密钥只进入 `gateway` |
| 健康检查 | 四个服务均必须定义 |
| 启动顺序 | 严格使用健康依赖 |
| 可复现 | 依赖锁文件、镜像版本/摘要、配置模板齐全 |
| 可观测 | 网关和 Agent 都有真实指标，Prometheus 可抓取 |
| 数据保留 | Agent、Prometheus、Grafana 使用命名卷 |
| 链路关联 | 请求、运行和模型调用具有稳定关联 ID |
| 过载保护 | 有界队列、并发上限和统一任务截止时间 |
| 版本可追溯 | Run 绑定发布清单，记录镜像、模型和配置摘要 |

## 2. 已确认决策摘要

| 编号 | 决策 |
|---|---|
| D-001 | 采用 Agent 单体服务 + 外部基础设施容器，不拆微服务 |
| D-002 | 固定四个容器，不增加 Postgres、Redis 或 init sidecar |
| D-003 | Agent 默认同步执行，`async=true` 时启用异步执行 |
| D-004 | Agent 运行记录使用文件持久化，不建关系数据库 |
| D-005 | 网关逻辑模型名采用 `deepseek-flash`，上游固定 `deepseek/deepseek-v4-flash`，API Base 和密钥由环境变量注入 |
| D-006 | Prometheus 通过启动时生成的受限权限 token 文件抓取网关 |
| D-007 | Grafana 使用 provisioning 自动加载数据源和 Dashboard |
| D-008 | 所有宿主机端口绑定 `127.0.0.1`，端口号可由 `.env` 覆盖 |
| D-009 | Agent 使用多阶段构建和非 root 用户，作为工程优化项 |
| D-010 | SSE 不纳入 MVP，保留可选扩展点 |
| D-023 | 使用 `request_id`、`run_id`、`trace_id`、`model_call_id` 关联一次请求链路 |
| D-024 | Agent 使用有界队列、并发上限、排队超时和统一任务截止时间 |
| D-025 | Run 绑定 `release_id`，发布清单不包含真实密钥 |
| D-026 | 增加 Gateway 调用级耗时、错误和 Token 指标 |
| D-027 | Langfuse、Replay 服务、RAG Cache 和 Eval Runner 不进入四容器 MVP |
| D-029 | PI 固定 `1.6.0`，Node 固定 Node 24 slim 镜像 digest |
| D-030 | Gateway 使用课程验证的 DeepSeek 逻辑模型、main/standby 和 Prometheus callback |
| D-031 | Prometheus 使用 `bearer_token_file`，Grafana 使用显式数据源 UID |

## 3. 跨文档引用索引

| 主题 | 权威文档 |
|---|---|
| 整体架构、运行流程与评分映射 | `00-overall-system-design.md` |
| 服务名、端口、环境变量 | `04-api-design.md`, `06-deployment-design.md` |
| Run 状态机 | `03-database-design.md`, `04-api-design.md` |
| 指标名与标签 | `05-observability-design.md` |
| 凭据隔离与日志规则 | `07-security-design.md` |
| 验收命令与证据 | `08-acceptance-design.md` |
| 第六章参考后的生产化增强 | `10-production-hardening.md` |
| 课程代码版本、配置和指标基线 | `11-course-code-baseline.md` |

## 4. 进度看板

| 文档 | 状态 |
|---|---|
| `00-overall-system-design.md` | 已完成 |
| `_design-context.md` | 已完成 |
| `_module-split.md` | 已完成 |
| `_technical-decisions.md` | 已完成 |
| `01-tech-stack.md` | 已完成 |
| `02-system-architecture.md` | 已完成 |
| `03-database-design.md` | 已完成 |
| `04-api-design.md` | 已完成 |
| `05-observability-design.md` | 已完成 |
| `06-deployment-design.md` | 已完成 |
| `07-security-design.md` | 已完成 |
| `08-acceptance-design.md` | 已完成 |
| `09-implementation-roadmap.md` | 已完成 |
| `10-production-hardening.md` | 已完成 |
| `11-course-code-baseline.md` | 已完成 |

## 5. 实现阶段验证项

以下内容不从需求中强行推定，必须在编码联调时通过镜像或真实接口确认：

| 项目 | 关闭条件 |
|---|---|
| LiteLLM 镜像版本 | 固定镜像 tag 或 digest，并记录到 README |
| LiteLLM 指标名 | 课程已给出四个指标；实现时按锁定 LiteLLM 版本再次确认 |
| PI Gateway Provider 构造 | 按锁定 PI 版本编译通过并完成真实调用 |
| Prometheus/Grafana 镜像版本 | 固定 tag 或 digest，并记录到 README |
| LiteLLM 响应中的 Token 用量字段 | 首次真实请求后确认并写入 Run 记录 |
| Grafana 告警 provisioning 格式 | 按锁定 Grafana 版本验证规则加载和状态变化 |

