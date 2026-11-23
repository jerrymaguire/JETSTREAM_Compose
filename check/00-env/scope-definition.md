# 设计范围定义

> 项目根目录：`D:\wj\projects\AI\GeekAgent\Week6\AgentCompose`
>
> 当前阶段：整体设计完成，未进入代码实现。

## 1. 设计对象

用 Docker Compose 部署并验收 PI Agent：

- 四个固定容器。
- 一条真实 Agent -> LiteLLM -> 上游模型调用链。
- Prometheus 三个抓取任务。
- Grafana Dashboard。
- 可重建、可复验和脱敏交付。

## 2. 范围内

- Compose 编排和健康依赖。
- LiteLLM 模型网关。
- PI Agent HTTP 服务、Run 状态和持久化。
- Agent 与 Gateway 指标。
- Prometheus 抓取和 Grafana provisioning。
- 端口、环境变量、安全边界和忽略文件。
- README、check.md 和验收证据设计。

## 3. 范围外

- Kubernetes、云平台和 CI/CD。
- Postgres、Redis、Loki、Langfuse、Eval 平台。
- Multi-Agent、Subagent 和 RAG。
- 用户注册、登录、细粒度租户授权。
- 浏览器控制 Docker 容器生命周期。
- 公网 TLS、反向代理和高可用。

## 4. 关键指标

| 指标 | 设计值 |
|---|---:|
| Compose 服务数 | 4 |
| Agent HTTP 必需接口 | 4 |
| Prometheus 抓取任务 | 3 |
| Dashboard 最低业务面板 | 4 |
| 默认 Agent 并发 | 4 |
| 默认队列容量 | 32 |
| 默认任务总超时 | 90000 ms |

## 5. 交付路径

| 类型 | 路径 |
|---|---|
| 需求 | `requirements/` |
| 设计 | `design/` |
| 审查 | `check/` |
| 后续实现 | 项目根目录及 `agent/`、`gateway/`、`prometheus/`、`grafana/` |
