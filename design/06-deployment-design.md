# 部署设计

## 1. Compose 服务

| 服务 | 镜像来源 | 容器端口 | 宿主机映射 |
|---|---|---:|---|
| `gateway` | LiteLLM 官方镜像或锁定版本自建镜像 | 4000 | `127.0.0.1:${GATEWAY_PORT:-4000}:4000` |
| `agent` | 本地多阶段构建 | 8080 | `127.0.0.1:${AGENT_PORT:-8080}:8080` |
| `prometheus` | Prometheus 官方镜像 | 9090 | `127.0.0.1:${PROMETHEUS_PORT:-9090}:9090` |
| `grafana` | Grafana 官方镜像 | 8765 | `127.0.0.1:${GRAFANA_PORT:-8765}:8765` |

网络：显式 Compose network `agent-compose-net`。

## 2. 健康检查

| 服务 | 检查 | 建议参数 |
|---|---|---|
| `gateway` | `GET /health/liveliness` | `interval=10s`, `timeout=3s`, `retries=12`, `start_period=20s` |
| `agent` | `GET /health` | `interval=10s`, `timeout=3s`, `retries=12`, `start_period=10s` |
| `prometheus` | `GET /-/healthy` | `interval=10s`, `timeout=3s`, `retries=12`, `start_period=10s` |
| `grafana` | `GET /api/health` | `interval=10s`, `timeout=3s`, `retries=18`, `start_period=30s` |

健康检查命令必须使用镜像内实际存在的 HTTP 客户端；若镜像无 `curl`，使用镜像自带运行时或最小工具完成，不通过安装大型依赖改变镜像边界。

## 3. 依赖顺序

```text
gateway
  `-> agent      condition: service_healthy
        `-> prometheus condition: service_healthy
              `-> grafana condition: service_healthy
```

`prometheus` 同时依赖 `gateway` 和 `agent` 健康。Grafana 只依赖 Prometheus 健康，但保留初始化时间。

## 4. 挂载

| 服务 | 宿主机文件/卷 | 容器路径 | 权限 |
|---|---|---|---|
| `gateway` | `gateway/config.yaml` | LiteLLM 配置路径 | ro |
| `agent` | `agent-data` | `/app/data` | rw |
| `agent` | `agent-workspace` | `/workspace` | rw |
| `prometheus` | `prometheus/prometheus.yml` | `/etc/prometheus/prometheus.yml` | ro |
| `prometheus` | `prometheus-data` | `/prometheus` | rw |
| `grafana` | `grafana/provisioning/` | `/etc/grafana/provisioning/` | ro |
| `grafana` | `grafana/dashboards/` | `/var/lib/grafana/dashboards/` | ro |
| `grafana` | `grafana-data` | `/var/lib/grafana` | rw |
| `agent` | `release.json` | `/app/release.json` | ro |

## 5. 环境变量

### 5.1 `.env.example`

```dotenv
GATEWAY_PORT=4000
AGENT_PORT=8080
PROMETHEUS_PORT=9090
GRAFANA_PORT=8765

LITELLM_MASTER_KEY=replace-with-a-local-gateway-key
LITELLM_VIRTUAL_KEY=replace-with-the-same-local-gateway-key
DEEPSEEK_API_BASE=https://api.deepseek.com
DEEPSEEK_API_KEY=replace-with-deepseek-api-key

AGENT_MODEL=deepseek-flash
AGENT_MAX_CONCURRENCY=4
AGENT_QUEUE_CAPACITY=32
AGENT_QUEUE_TIMEOUT_MS=2000
AGENT_RUN_TIMEOUT_MS=90000
AGENT_GATEWAY_TIMEOUT_MS=80000
RELEASE_ID=local-20261122.1

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=replace-with-a-strong-local-password
```

### 5.2 注入边界

| 变量 | `gateway` | `agent` | `prometheus` | `grafana` |
|---|---:|---:|---:|---:|
| `DEEPSEEK_API_KEY` | 是 | 否 | 否 | 否 |
| `DEEPSEEK_API_BASE` | 是 | 否 | 否 | 否 |
| `LITELLM_MASTER_KEY` | 是 | 否 | 是 | 否 |
| `LITELLM_VIRTUAL_KEY` | 是 | 否 | 否 | 否 |
| `GATEWAY_API_KEY` | 否 | 是 | 否 | 否 |
| `GRAFANA_ADMIN_PASSWORD` | 否 | 否 | 否 | 是 |

Agent 的 `GATEWAY_API_KEY` 由 Compose 从 `LITELLM_MASTER_KEY` 映射，不在 `.env` 维护第二份明文。

## 6. Grafana 环境变量

```text
GF_SERVER_HTTP_ADDR=0.0.0.0
GF_SERVER_HTTP_PORT=8765
GF_SECURITY_ADMIN_USER=${GRAFANA_ADMIN_USER:-admin}
GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
GF_USERS_ALLOW_SIGN_UP=false
GF_AUTH_ANONYMOUS_ENABLED=true
GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
GF_AUTH_ANONYMOUS_ORG_NAME=Main Org.
GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/agent-compose.json
```

## 7. Prometheus 启动参数

- `--config.file=/etc/prometheus/prometheus.yml`
- `--storage.tsdb.path=/prometheus`
- `--web.listen-address=0.0.0.0:9090`
- 日志输出到 stdout/stderr。
- 启动命令生成 `/tmp/prometheus_gateway_token`，权限 `0600` 或同等受限权限。
- `prometheus.yml` 使用 `bearer_token_file: /tmp/prometheus_gateway_token`。

## 8. 忽略文件

### 8.1 `.gitignore`

```text
.env
secrets/
node_modules/
agent/node_modules/
agent/dist/
agent/data/
*.log
check/evidence/*.tmp
```

不得忽略需要提交的 Dashboard JSON、provisioning 配置和真实脱敏截图。

### 8.2 `agent/.dockerignore`

```text
node_modules
dist
data
.env
*.log
coverage
.git
```

若 gateway 使用自建镜像，`gateway/.dockerignore` 排除 `.env`、本地密钥、缓存和 Git 元数据。

## 9. 日志轮转

四个服务建议统一：

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

## 10. 启动与停止

```text
启动：docker compose up -d --build
状态：docker compose ps
停止：docker compose down
重建复验：docker compose down && docker compose up -d --build
```

正常验收不使用 `down -v`，避免丢失运行记录和监控历史。

## 11. 发布清单与版本绑定

`release.json` 固定以下信息：

- `release_id`
- 四个镜像的 tag/digest
- 逻辑模型名和上游模型标识
- Gateway、Prometheus、Grafana 配置文件的 SHA-256
- 不包含任何密钥或插值后的 `.env`

Compose 将 `RELEASE_ID` 注入 Agent。Agent 健康检查、Run 记录和结构化事件都返回该值。重建后先核对发布清单，再执行健康、链路、指标和 Dashboard 复验。

## 12. 告警与四容器边界

告警规则通过 Grafana provisioning 文件加载，不需要增加 Alertmanager 容器。课程主验收要求仍然只有四个容器和至少四业务面板；告警是增强能力，若未配置外部通知，至少记录规则从 Pending 到 Firing 再恢复的状态。

