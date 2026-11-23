# 可观测性设计

## 1. 指标边界

### 1.1 Agent 自定义指标

| 指标 | 类型 | 标签 | 含义 |
|---|---|---|---|
| `agent_runs_total` | Counter | `status`, `tenant`, `mode` | Run 最终状态计数 |
| `agent_run_duration_ms` | Histogram | `status`, `tenant`, `mode` | Run 耗时，单位毫秒 |
| `agent_http_requests_total` | Counter | `method`, `route`, `status_code` | HTTP 请求数 |
| `agent_runs_in_flight` | Gauge | `mode` | 当前执行中的 Run 数 |
| `agent_queue_depth` | Gauge | 无 | 当前等待执行的 Run 数 |
| `agent_run_queue_wait_ms` | Histogram | `outcome` | 运行在队列中的等待时间 |
| `agent_model_calls_total` | Counter | `workflow`, `model`, `outcome`, `status_code` | 单次 Gateway 模型调用结果 |
| `agent_model_call_duration_seconds` | Histogram | `workflow`, `model`, `outcome` | 单次模型调用耗时 |
| `agent_model_tokens_total` | Counter | `kind`, `model` | Prompt、Completion、Total Token |
| `agent_build_info` | Gauge | `release_id`, `version`, `model` | 固定为 `1`，标识当前运行版本 |
| `agent_up` | Gauge | `service` | Agent 进程存活标识，固定为 `1` |

耗时桶：

```text
100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 90000, 120000
```

模型调用耗时使用秒级桶：

```text
0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10, 30, 60
```

约束：

- `tenant` 只接受请求校验后的安全字符。
- 只使用稳定路由模板，例如 `/v1/runs/:run_id`，不把实际 ID 放入标签。
- `failed` 终态也记录运行次数和耗时。
- `request_id`、`run_id`、`trace_id` 和 `model_call_id` 只进入日志与事件归档，不进入 Prometheus 标签。
- 模型调用耗时包含错误结束前的等待时间；用户取消只增加 `cancelled` 计数，不写入延迟 Histogram。

### 1.2 网关指标

网关必须开放真实 `litellm_*` 指标。课程代码已经验证以下名称：

| 指标 | 用途 |
|---|---|
| `litellm_proxy_total_requests_metric_total` | 按 `model_id`、`status_code` 统计请求 |
| `litellm_request_total_latency_metric_bucket` | 请求延迟 Histogram |
| `litellm_total_tokens_metric_total` | Token 累计量 |
| `litellm_spend_metric_total` | 估算成本累计量 |

LiteLLM 配置必须包含：

```yaml
litellm_settings:
  callbacks: ["prometheus"]
```

Dashboard 查询：

```promql
sum by (model_id, status_code) (
  rate(litellm_proxy_total_requests_metric_total[$__rate_interval])
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, model_id) (
    rate(litellm_request_total_latency_metric_bucket[$__rate_interval])
  )
)
```

```promql
sum(litellm_total_tokens_metric_total)
```

```promql
sum(litellm_spend_metric_total)
```

## 2. Prometheus 抓取配置

```text
scrape_interval: 15s

job=gateway     -> http://gateway:4000/metrics
job=agent       -> http://agent:8080/metrics
job=prometheus  -> http://localhost:9090/metrics
```

网关任务使用课程配置中的 `bearer_token_file`：

```yaml
bearer_token_file: /tmp/prometheus_gateway_token
```

Prometheus 启动命令先从 `LITELLM_MASTER_KEY` 生成此文件，并设置 `0600` 或同等受限权限。文件只在容器内部存在，不进入镜像和 Git。

## 3. Grafana 数据源

| 属性 | 值 |
|---|---|
| 名称 | `Prometheus` |
| UID | `agent-prometheus` |
| 类型 | `prometheus` |
| URL | `http://prometheus:9090` |
| 默认数据源 | 是 |
| 访问模式 | 容器内 HTTP |
| HTTP Method | `POST` |

Provisioning 文件：

- `grafana/provisioning/datasources/prometheus.yml`
- `grafana/provisioning/dashboards/agent-compose.yml`
- `grafana/dashboards/agent-compose.json`

## 4. Dashboard 设计

Dashboard 标题：`AgentCompose Overview`

| 面板 | 类型 | 数据源 | 目的 |
|---|---|---|---|
| Gateway Requests | Time series / Stat | Prometheus | 展示网关请求数 |
| Gateway Tokens or Cost | Time series / Stat | Prometheus | 展示 Token 用量或成本 |
| Agent Runs | Time series / Bar gauge | Prometheus | 按状态展示运行数 |
| Agent Run p95 | Time series | Prometheus | 展示耗时尾部 |
| Queue Depth | Time series / Stat | Prometheus | 展示等待队列压力 |
| Agent Model Call p95 | Time series | Prometheus | 展示 Agent 侧观察到的模型调用耗时 |
| Gateway Request p95 | Time series | Prometheus | 展示 LiteLLM 请求延迟 |
| Targets Up | Stat | Prometheus | 展示三个抓取目标健康 |

至少四个业务面板；`Queue Depth`、`Targets Up` 等作为运行增强面板。

### 4.1 Agent 查询

```promql
sum by (status) (increase(agent_runs_total[$__rate_interval]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(agent_run_duration_ms_bucket[$__rate_interval]))
)
```

### 4.2 模型调用查询

```promql
sum by (outcome) (
  increase(agent_model_calls_total[$__rate_interval])
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, model) (
    rate(agent_model_call_duration_seconds_bucket[$__rate_interval])
  )
)
```

### 4.3 网关查询

网关使用 `litellm_proxy_total_requests_metric_total`、`litellm_request_total_latency_metric_bucket`、`litellm_total_tokens_metric_total` 和 `litellm_spend_metric_total`。验收截图应选择覆盖本轮请求的时间范围，并展示至少两个非零面板。

### 4.4 目标状态

```promql
min by (job) (up{job=~"gateway|agent|prometheus"})
```

## 5. 健康与故障定位

| 层级 | 检查 |
|---|---|
| 容器 | `docker compose ps` |
| 服务 | 四个 HTTP 探针 |
| 抓取 | `/api/v1/targets` |
| 指标 | 直接访问两个 `/metrics` |
| 查询 | Prometheus `/api/v1/query` |
| 展示 | Grafana Dashboard 和数据源测试 |

常见失败：

| 现象 | 优先检查 |
|---|---|
| 网关 target 401 | token 文件是否存在、权限是否正确 |
| 网关 target 404 | LiteLLM 指标是否启用、路径是否为 `/metrics` |
| Agent target DOWN | Agent 是否监听 `0.0.0.0:8080` |
| 看板无数据 | 时间范围、PromQL 指标名、Prometheus 自身查询结果 |
| 只有容器 UP 无业务样本 | 是否真正完成过一次 Agent 请求 |

## 6. 日志

- 应用日志全部输出 stdout/stderr。
- LiteLLM、Agent、Prometheus、Grafana 使用 Docker 日志轮转。
- 不记录 Authorization、上游密钥、完整请求体和完整模型响应。
- 错误日志记录 `run_id`、稳定错误码和脱敏消息，便于与 Run 记录关联。
- 结构化日志统一携带 `request_id`、`run_id`、`trace_id`、`model_call_id` 和 `release_id`。
- Run 事件同时写入 `/app/data/runs/{run_id}/events.jsonl`，用于串联状态迁移与 Gateway 调用。

## 7. 告警增强

通过 `grafana/provisioning/alerting/agent-compose-alerts.yml` 管理以下规则：

- Gateway target 或 Agent target 持续 `DOWN`。
- Agent 运行失败率超出阈值且样本充足。
- `agent_queue_depth` 接近容量上限。
- Agent P95 运行耗时超出目标。

告警规则不增加容器。作业主验收仍以 Dashboard 为准，告警状态变化作为增强验收记录。

