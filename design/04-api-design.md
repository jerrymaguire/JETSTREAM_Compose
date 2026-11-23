# API 设计

## 1. Agent API

### 1.1 健康检查

```http
GET /health
```

响应：`200 OK`

```json
{
  "status": "ok",
  "service": "agent",
  "version": "0.1.0",
  "release_id": "local-20261122.1",
  "uptime_seconds": 12
}
```

约束：

- 不要求鉴权。
- 必须能反映 HTTP 服务已就绪，不执行上游模型调用。

### 1.2 提交 Run

```http
POST /v1/runs
Content-Type: application/json
X-Request-ID: req-20261122-001
```

`X-Request-ID` 可选。合法时复用，否则 Agent 生成；响应和 Run 记录均带回该值。

`traceparent` 可选。存在合法 W3C Trace Context 时提取 `trace_id`，否则 Agent 生成；MVP 不要求部署独立 Trace 服务。

请求：

```json
{
  "input": "用一句话说明什么是幂等",
  "tenant": "demo",
  "async": false,
  "session_id": "session-ui-0123456789abcdef",
  "task_mode": false
}
```

字段：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `input` | string | 是 | 1 到 10000 字符 |
| `tenant` | string | 是 | 1 到 64 字符，`[A-Za-z0-9_-]` |
| `async` | boolean | 否 | 默认 `false` |
| `session_id` | string | 否 | 多轮会话 ID；同一 ID 的已完成 Run 作为下一轮上下文 |
| `task_mode` | boolean | 否 | `true` 时要求 Agent 按任务处理并报告结果与剩余项 |

同步成功响应：`200 OK`

```json
{
  "request_id": "req-20261122-001",
  "trace_id": "trace-20261122-001",
  "run_id": "019b0000-0000-7000-8000-000000000001",
  "model_call_id": "model-call-20261122-001",
  "status": "completed",
  "output": "幂等是指同一操作重复执行多次与执行一次产生相同结果。",
  "tenant": "demo",
  "release_id": "local-20261122.1",
  "duration_ms": 2080,
  "created_at": "2026-11-22T00:00:00.000Z"
}
```

异步成功响应：`202 Accepted`

```json
{
  "request_id": "req-20261122-002",
  "trace_id": "trace-20261122-002",
  "run_id": "019b0000-0000-7000-8000-000000000002",
  "model_call_id": null,
  "status": "queued",
  "output": null,
  "tenant": "demo",
  "release_id": "local-20261122.1",
  "created_at": "2026-11-22T00:00:00.000Z"
}
```

错误：

| HTTP | 条件 | 响应 `error.code` |
|---:|---|---|
| 400 | 字段缺失或校验失败 | `invalid_request` |
| 429 | 并发队列满 | `agent_busy` |
| 502 | 上游模型调用失败 | `gateway_call_failed` |
| 504 | PI 或上游超时 | `run_timeout` |

### 1.3 查询 Run

```http
GET /v1/runs/{run_id}
```

响应：`200 OK`

```json
{
  "request_id": "req-20261122-002",
  "trace_id": "trace-20261122-002",
  "run_id": "019b0000-0000-7000-8000-000000000002",
  "model_call_id": "model-call-20261122-002",
  "tenant": "demo",
  "release_id": "local-20261122.1",
  "status": "completed",
  "output": "幂等是指重复执行不会改变最终结果。",
  "error_code": null,
  "created_at": "2026-11-22T00:00:00.000Z",
  "finished_at": "2026-11-22T00:00:02.100Z",
  "duration_ms": 2100
}
```

状态：

- `queued`
- `running`
- `completed`
- `failed`

不存在时返回 `404 not_found`。查询接口不得暴露内部文件路径和完整异常堆栈。

### 1.4 Prometheus 指标

```http
GET /metrics
```

响应：`200 OK`，`Content-Type: text/plain; version=0.0.4; charset=utf-8`

必须包含：

- `agent_runs_total`
- `agent_run_duration_ms_bucket`
- `agent_run_duration_ms_sum`
- `agent_run_duration_ms_count`
- `agent_http_requests_total`
- `agent_queue_depth`
- `agent_runs_in_flight`
- `agent_run_queue_wait_ms_*`
- `agent_model_calls_total`
- `agent_model_call_duration_seconds_*`
- `agent_model_tokens_total`
- `agent_build_info`
- `agent_up`

### 1.5 最近 Run 列表

```http
GET /v1/runs?limit=50
```

返回 `{ "items": RunResult[] }`，按创建时间倒序，`limit` 范围 1 到 100。供 Agent Workbench 左侧运行列表使用。

删除会话及其全部 Run：

```http
DELETE /v1/sessions/{session_id}
```

返回 `{ "session_id": "...", "deleted_runs": 2 }`。

### 1.6 运行事件

```http
GET /v1/runs/{run_id}/events
Accept: text/event-stream
```

默认以 SSE 返回当前状态和终态：

- `event: state`
- `event: done`

查询事件历史：

```http
GET /v1/runs/{run_id}/events?format=json
```

返回 `{ "items": RunEvent[] }`，供 UI 事件时间线使用。

### 1.7 Agent Workbench

```http
GET /ui/
```

由 `agent` 容器托管静态页面，不增加第五个容器。页面提供：

- 最近会话列表和搜索。
- `input`、`tenant`、同步/异步和对话/任务模式。
- 多轮消息流；同一 `session_id` 自动带上前文。
- status、output、Token 和耗时展示。
- 事件时间线和原始 JSON。
- run/request/trace/model-call ID 检查与复制。
- Grafana、Prometheus 和健康入口。
- 桌面与移动端布局。

## 2. LiteLLM API

### 2.1 Liveliness

```http
GET /health/liveliness
```

期望：`200 OK`，无需模型调用。

### 2.2 Chat Completions

```http
POST /v1/chat/completions
Authorization: Bearer <GATEWAY_API_KEY>
Content-Type: application/json
```

请求：

```json
{
  "model": "deepseek-flash",
  "messages": [
    {
      "role": "user",
      "content": "用一句话说明什么是幂等"
    }
  ],
  "max_tokens": 512
}
```

响应验收：

- HTTP 200。
- `choices[0].message.content` 非空字符串。

### 2.3 Metrics

```http
GET /metrics
Authorization: Bearer <GATEWAY_API_KEY>
```

响应必须包含真实 `litellm_*` 指标。课程已确认的核心指标为：

- `litellm_proxy_total_requests_metric_total`
- `litellm_request_total_latency_metric_bucket`
- `litellm_total_tokens_metric_total`
- `litellm_spend_metric_total`

## 3. 配置契约

| 变量 | 容器 | 必填 | 说明 |
|---|---|---:|---|
| `GATEWAY_BASE_URL` | `agent` | 是 | 固定 `http://gateway:4000` |
| `GATEWAY_API_KEY` | `agent` | 是 | 由 `LITELLM_MASTER_KEY` 映射 |
| `AGENT_MODEL` | `agent` | 是 | 固定 `deepseek-flash` |
| `AGENT_MAX_CONCURRENCY` | `agent` | 是 | 同时执行上限，默认 `4` |
| `AGENT_QUEUE_CAPACITY` | `agent` | 是 | 等待队列上限，默认 `32` |
| `AGENT_QUEUE_TIMEOUT_MS` | `agent` | 是 | 排队超时，默认 `2000` |
| `AGENT_RUN_TIMEOUT_MS` | `agent` | 是 | 任务总截止时间，默认 `90000` |
| `AGENT_GATEWAY_TIMEOUT_MS` | `agent` | 是 | 单次 Gateway 调用上限，默认 `80000` |
| `RELEASE_ID` | `agent` | 是 | 与 `release.json` 一致的发布编号 |
| `DEEPSEEK_API_BASE` | `gateway` | 是 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_API_KEY` | `gateway` | 是 | 厂商密钥，禁止注入其他服务 |
| `LITELLM_MASTER_KEY` | `gateway`, `prometheus` | 是 | 网关管理密钥 |
| `LITELLM_VIRTUAL_KEY` | `gateway` | 是 | 与 master key 同值 |
| `GRAFANA_ADMIN_PASSWORD` | `grafana` | 是 | Grafana 管理员密码 |

