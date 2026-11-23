# 作业六需求基线

> 来源：飞书文档《AI Agent 全栈工程师训练营-作业六》
>
> 来源链接：`https://geekbang.feishu.cn/docx/Z7XIdMWqToE4xUxhwRLcpSLcn5d?from=from_copylink`
>
> 解析日期：2026-11-22

## 1. 总体目标

用 Docker Compose 部署 PI Agent、LiteLLM、Prometheus、Grafana 四个容器，通过宿主机 HTTP 入口完成一次真实 Agent 请求，并证明请求经过 LiteLLM 调用上游模型，相关指标可被 Prometheus 查询并在 Grafana 展示。

## 2. 固定服务契约

| Compose 服务名 | 职责 | 容器内端口 | 默认宿主机地址 | 端口变量 |
|---|---|---:|---|---|
| `gateway` | LiteLLM 模型网关 | 4000 | `http://127.0.0.1:4000` | `GATEWAY_PORT` |
| `agent` | PI Agent HTTP 服务 | 8080 | `http://127.0.0.1:8080` | `AGENT_PORT` |
| `prometheus` | 指标抓取和查询 | 9090 | `http://127.0.0.1:9090` | `PROMETHEUS_PORT` |
| `grafana` | 监控展示 | 8765 | `http://127.0.0.1:8765` | `GRAFANA_PORT` |

容器内端口固定，宿主机端口通过 `.env` 修改。若 `8765` 被占用，Grafana 可改用 `8766`。

## 3. 评分与强制项

| 评分项 | 分值 | 强制交付 |
|---|---:|---|
| LiteLLM 网关 | 20 | 逻辑模型、上游 OpenAI 兼容接口、密钥隔离、三个端点、Prometheus 指标 |
| PI Agent | 25 | PI >=0.87.x、Node >=22.19、锁文件、HTTP 服务、同步/异步运行、两类指标 |
| Prometheus 和 Grafana | 25 | 三个抓取任务、Bearer 文件凭据、数据源和至少四面板 Dashboard |
| Compose 编排 | 20 | 四服务、端口、健康检查、依赖顺序、环境模板和忽略文件 |
| 可复现与交付 | 10 | README、check.md、脱敏检查、至少一项工程优化、重建复验 |

## 4. LiteLLM 网关要求

- 使用官方镜像或自建镜像。
- 提交 LiteLLM 配置并以只读方式挂载。
- 至少配置一个逻辑模型，例如 `deepseek-flash`，指向 OpenAI 兼容上游模型。
- 上游厂商 API Key 只注入 `gateway` 容器。
- `GET /health/liveliness` 返回 HTTP 200。
- `POST /v1/chat/completions` 在网关鉴权通过后返回非空 `choices[0].message.content`。
- `GET /metrics` 携带网关凭据后返回真实 `litellm_*` 指标。
- 将 `LITELLM_MASTER_KEY` 映射为 Agent 的 `GATEWAY_API_KEY`。
- 若使用 `LITELLM_VIRTUAL_KEY`，其值必须与 master key 相同。
- 课程配置不引入 Postgres，只使用本地四容器方案。

## 5. PI Agent 要求

- PI 版本基线为 `>=0.87.x`，Node 版本基线为 `>=22.19`。
- 锁定依赖并提交 `package-lock.json`。
- Dockerfile 先复制依赖清单并执行 `npm ci`，再复制源码。
- 宿主机 `node_modules` 必须排除出构建上下文。
- HTTP 服务监听 `0.0.0.0:8080`。
- 通过 `GATEWAY_BASE_URL=http://gateway:4000` 和 `GATEWAY_API_KEY` 调用网关。
- 运行数据通过卷挂载持久化。
- `GET /health` 返回 200，JSON 至少包含 `{"status":"ok"}`。
- `POST /v1/runs` 接收 `input` 和 `tenant`，返回 `run_id`、`status`、`output`。
- 异步实现必须提供 `GET /v1/runs/{run_id}` 查询终态。
- SSE `GET /v1/runs/{run_id}/events` 为可选项。
- `GET /metrics` 返回真实 Prometheus 文本指标。
- 至少提供 `agent_runs_total` 与 `agent_run_duration_ms` 两类指标，或明确映射。

## 6. Prometheus 要求

- 三个抓取任务：
  1. `gateway` -> `gateway:4000/metrics`
  2. `agent` -> `agent:8080/metrics`
  3. `prometheus` -> `localhost:9090`
- 建议抓取间隔 15 秒。
- 网关抓取使用 Bearer token。
- token 从只读文件或启动时生成的受限权限文件读取。
- Prometheus 运行用户必须可读该文件。
- 持久化 `/prometheus`。
- 健康检查使用 `/-/healthy`。
- 日志输出到 stdout/stderr。
- 验收时三个 target 均为 `UP`。

## 7. Grafana 要求

- `GF_SERVER_HTTP_ADDR=0.0.0.0`。
- `GF_SERVER_HTTP_PORT=8765`。
- `GRAFANA_ADMIN_PASSWORD` 映射为 `GF_SECURITY_ADMIN_PASSWORD`。
- 通过 provisioning 加载 Prometheus 数据源。
- 数据源地址为 `http://prometheus:9090`。
- 通过 provisioning 加载至少一份 Dashboard JSON。
- 持久化 `/var/lib/grafana`。
- 健康检查使用 `/api/health`。
- Dashboard 至少四个面板：
  1. 网关请求数。
  2. 网关 Token 用量或成本。
  3. Agent 运行数。
  4. Agent 耗时或错误。
- 发出测试请求后，至少两个面板出现真实非零数据。

## 8. Compose 要求

- `docker-compose.yml` 定义且只定义四个服务。
- 使用 Compose 项目网络。
- 四个服务都发布宿主机端口。
- 建议绑定 `127.0.0.1`。
- 四个服务均配置 `healthcheck`。
- 使用 `depends_on` 和 `condition: service_healthy`。
- 启动顺序为 `gateway -> agent -> prometheus -> grafana`。
- 提供 `.env.example`、`.gitignore` 和对应构建上下文的 `.dockerignore`。
- 真实 `.env` 和本地凭据文件不能进入版本管理或镜像构建上下文。
- 一条命令启动：`docker compose up -d --build`。
- 一条命令停止：`docker compose down`。

## 9. 可复现与交付要求

- `README.md` 写清：
  - 调用关系。
  - 依赖版本。
  - 配置步骤。
  - 端口表。
  - 接口和指标映射。
  - 验收命令。
  - 实际脱敏结果。
- `check.md` 记录：
  - 四个容器健康状态。
  - 四个宿主机端点响应。
  - 三个 Prometheus targets 状态。
  - Agent 运行终态。
  - 两条指标的前后值。
  - Grafana 截图。
  - 重建后的复验结果。
- 至少完成一项工程优化，例如：
  - 非 root 运行。
  - 多阶段构建。
  - 镜像瘦身。
- 执行 `docker compose down` 后重新构建启动并复验。

## 10. 验收证据清单

| 证据 | 最低要求 |
|---|---|
| 容器状态 | 四服务均为 `healthy` |
| 宿主机探针 | 四入口均返回 HTTP 200 |
| 模型网关 | 直接调用返回非空回答 |
| Prometheus targets | 三个任务均为 `UP` |
| Agent 链路 | 返回 `completed` 且 `output` 非空 |
| 指标增长 | 网关请求数和 Agent 运行数相对基线增长 |
| Grafana | 至少四面板，至少两个面板非零 |
| 重建复验 | down 后重新 build/up，链路和看板仍通过 |

## 11. 不在本作业范围

- Postgres 或其他外部持久化数据库。
- 多用户认证与租户隔离策略。
- SSE 实时事件流，属于可选项。
- 生产级 TLS、反向代理和高可用。
- 云平台部署与 Kubernetes 编排。

