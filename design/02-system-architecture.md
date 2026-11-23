# 系统架构

## 1. 架构总览

```text
宿主机 127.0.0.1
  |-- :4000 -> gateway:4000        LiteLLM
  |-- :8080 -> agent:8080          PI Agent HTTP
  |-- :9090 -> prometheus:9090     Prometheus
  `-- :8765 -> grafana:8765        Grafana

Compose network: agent-compose-net

gateway:4000  <---------------- Agent HTTP 调用
     |
     `-------------------------> OpenAI-compatible upstream

prometheus:9090
  |-- scrape gateway:4000/metrics   Bearer token file
  |-- scrape agent:8080/metrics
  `-- scrape localhost:9090

grafana:8765
  `-- query http://prometheus:9090
```

## 2. 组件职责

| 组件 | 核心职责 | 数据 |
|---|---|---|
| `gateway` | 模型路由、网关鉴权、上游调用、Token/请求指标 | 配置只读，不持久化业务数据库 |
| `agent` | 接收 Run、校验、PI 调用、状态机、指标 | Agent 数据卷和工作目录卷 |
| `prometheus` | 抓取、存储、查询指标 | `/prometheus` 命名卷 |
| `grafana` | 数据源、Dashboard、可视化查询 | `/var/lib/grafana` 命名卷 |

## 3. 主调用链

```text
Client
  -> POST http://127.0.0.1:8080/v1/runs
  -> Agent validates input/tenant
  -> Agent sends model=deepseek-flash to http://gateway:4000/v1/chat/completions
  -> LiteLLM authenticates gateway key
  -> LiteLLM chooses deepseek-flash-primary or deepseek-flash-standby
  -> LiteLLM routes to deepseek/deepseek-v4-flash upstream
  -> Agent extracts choices[0].message.content
  -> Agent persists terminal result
  -> Agent returns completed + output
```

Prometheus 不参与同步调用链。它周期抓取请求、Token、运行次数和耗时，Grafana 从 Prometheus 读取。

## 4. Run 状态机

```text
queued -> running -> completed
queued -> running -> failed
queued -> failed      # 创建后无法进入执行
running -> failed     # 超时、上游错误、PI 异常
```

- 同步模式对外通常直接返回 `completed` 或错误响应，但内部仍经过状态迁移并记录耗时。
- 异步模式创建后返回 `202 queued`，后台进入 `running`，最终落到终态。
- 不增加 `cancelled`，因为作业未要求取消能力。

## 5. 部署启动顺序

```text
gateway healthy
  -> agent healthy
  -> prometheus healthy
  -> grafana healthy
```

依赖使用 Compose `condition: service_healthy`。每个健康检查的语义如下：

| 服务 | 探针 |
|---|---|
| `gateway` | `GET /health/liveliness` |
| `agent` | `GET /health` |
| `prometheus` | `GET /-/healthy` |
| `grafana` | `GET /api/health` |

## 6. 故障边界

| 故障 | 期望行为 |
|---|---|
| 上游模型超时 | Agent Run 进入 `failed`，不无限挂起 |
| 主部署失败 | LiteLLM 在有限条件下切换同逻辑名备用部署，并记录实际部署 |
| 网关 401 | Agent 记录脱敏错误，不返回上游密钥 |
| Agent `/metrics` 异常 | Prometheus 对应 target `DOWN`，不影响已有 Dashboard |
| Prometheus 不可用 | Agent 与网关仍可调用，Grafana 显示查询错误 |
| Grafana 不可用 | Agent 主链路不受影响 |
| Agent 重启 | 已落盘 Run 可被重新查询 |
| Prometheus/Grafana 重启 | 命名卷保留历史数据，provisioning 重新加载配置 |

## 7. 网络约束

- 服务内部地址固定：
  - Agent -> Gateway：`http://gateway:4000`
  - Prometheus -> Gateway：`gateway:4000`
  - Prometheus -> Agent：`agent:8080`
  - Grafana -> Prometheus：`http://prometheus:9090`
- 除 Prometheus 自采集外，不使用容器内 `localhost` 访问其他服务。
- 宿主机端口默认绑定回环地址，不向局域网发布。

## 8. Gateway 路由与指标

- `deepseek-flash-primary` 和 `deepseek-flash-standby` 使用同一个逻辑名 `deepseek-flash`。
- Fallback 次数和冷却时间必须有限，禁止无限重试。
- LiteLLM 配置启用 `litellm_settings.callbacks: ["prometheus"]`。
- Prometheus 使用 `bearer_token_file` 抓取 `gateway:4000/metrics`。

## 9. 可选扩展

SSE `/v1/runs/{run_id}/events` 可在不改变主状态机和存储字段的前提下追加。MVP 先保证同步、异步查询、指标和监控验收稳定。

