# 模块划分

## 1. 划分原则

按部署职责和替身边界划分，而不是按具体源文件划分。模块名与 Compose 服务保持稳定映射。

## 2. 模块清单

| 模块 | Compose 服务 | 职责 | 对外边界 |
|---|---|---|---|
| M01 Gateway | `gateway` | 模型路由、鉴权、上游调用、网关指标 | `4000` |
| M02 Agent | `agent` | PI 运行、HTTP API、运行状态、Agent 指标 | `8080` |
| M03 Observability | `prometheus`, `grafana` | 指标抓取、查询、看板和 provisioning | `9090`, `8765` |
| M04 Orchestration | 无独立容器 | Compose 网络、端口、健康依赖、卷、环境变量 | Compose CLI |
| M05 Acceptance | 无独立容器 | 探针、链路验收、证据采集、重建复验 | 本地脚本和文档 |

## 3. 功能映射

| 需求功能 | 模块 |
|---|---|
| LiteLLM 配置与逻辑模型 | M01 |
| 网关鉴权和密钥隔离 | M01, M04 |
| 网关健康与指标 | M01, M03 |
| PI Agent HTTP API | M02 |
| Run 状态与持久化 | M02 |
| Agent 指标 | M02, M03 |
| Prometheus 三抓取任务 | M03 |
| Grafana 数据源与四面板 | M03 |
| 四服务启动顺序 | M04 |
| `.env.example` 与忽略文件 | M04 |
| README、check.md、工程优化说明 | M05 |

## 4. Agent 内部逻辑模块

| 逻辑模块 | 职责 | 不负责 |
|---|---|---|
| `http-server` | 路由、请求校验、状态码和 JSON 序列化 | PI 调用细节 |
| `run-service` | 同步/异步编排、状态机、超时 | 指标定义 |
| `pi-adapter` | 构造 PI Provider、调用 Agent、提取文本结果 | HTTP 响应 |
| `run-store` | 原子写入、读取运行记录 | 业务状态迁移 |
| `metrics` | Prometheus 注册、计数与耗时观测 | Dashboard JSON |
| `config` | 读取环境变量并做启动校验 | 加载 `.env` |

## 5. 跨模块约束

- M02 只能通过 `http://gateway:4000` 调用 M01。
- M03 不得调用宿主机 `localhost` 抓取其他容器。
- `prometheus` 自采集使用容器内 `localhost:9090`。
- Grafana 只通过 `http://prometheus:9090` 查询指标。
- M04 不得使用全局 `env_file` 向所有容器广播全部凭据。
- M05 的证据必须来自实际运行，不得用设计值代替。

