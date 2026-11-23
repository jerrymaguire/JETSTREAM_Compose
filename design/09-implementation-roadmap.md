# 实施路线

> 当前阶段只完成设计。以下为后续编码阶段的建议顺序，不在本次执行。

## 1. 阶段 A：基础设施骨架

产出：

- `docker-compose.yml`
- `.env.example`
- `.gitignore`
- `gateway/config.yaml`
- `prometheus/prometheus.yml`
- Grafana provisioning 目录骨架

完成条件：

- `docker compose config --services` 只输出四个服务。
- 环境变量按服务最小化注入。
- 端口、健康检查、网络和卷定义完整。

## 2. 阶段 B：LiteLLM 网关

产出：

- 锁定版本或 digest 的 LiteLLM 镜像引用。
- 只读配置。
- 逻辑模型 `deepseek-flash` → `deepseek/deepseek-v4-flash`。
- 同逻辑名 primary/standby 和有限 Fallback。
- `litellm_settings.callbacks: ["prometheus"]` 启用网关指标。

完成条件：

- `/health/liveliness` 返回 200。
- 直连 chat completions 返回非空内容。
- `/metrics` 携带 Bearer 后返回真实 `litellm_*` 指标。

## 3. 阶段 C：Agent 数据与接口

产出：

- `agent/package.json`
- `agent/package-lock.json`
- `agent/tsconfig.json`
- HTTP 服务、配置、Run 状态机、文件存储。

完成条件：

- `/health` 通过。
- 同步 `POST /v1/runs` 返回 completed 和非空 output。
- 异步运行可查询到终态。
- 非 root 用户可读写数据卷。

## 4. 阶段 D：Agent 指标

产出：

- `agent_runs_total`
- `agent_run_duration_ms`
- HTTP 请求指标
- `/metrics`

完成条件：

- 指标格式可被 Prometheus 解析。
- 成功和失败 Run 都能记录状态与耗时。
- 指标不泄漏 ID、密钥或正文。

## 5. 阶段 E：监控链路

产出：

- 三个 Prometheus 抓取任务。
- `bearer_token_file` 和受限权限 token 生成流程。
- Grafana 数据源 provisioning。
- 四业务面板 Dashboard JSON。

完成条件：

- 三个 target 为 `UP`。
- 一轮 Agent 请求后，Agent 指标立即有数据。
- 网关请求和 Token/成本指标名经真实 `/metrics` 确认。
- Grafana 至少两个面板非零。

## 6. 阶段 F：镜像与工程优化

产出：

- Agent 多阶段 Dockerfile。
- Node 24 slim 基础镜像和 digest 锁定。
- 非 root 运行。
- `agent/.dockerignore`。
- Docker 日志轮转。

完成条件：

- 宿主机 `node_modules` 不进入构建上下文。
- `npm ci` 使用锁文件。
- 最终镜像不包含开发依赖。

## 7. 阶段 G：自动化验收

产出：

- `scripts/acceptance.ps1`
- 可选 Bash 等价脚本。
- `check/evidence/` 证据目录。

脚本步骤：

1. 检查四个服务健康。
2. 请求四个探针。
3. 记录 Prometheus targets。
4. 记录指标基线。
5. 发起 Agent 请求。
6. 轮询终态。
7. 等待并查询指标变化。
8. 输出脱敏摘要。

## 8. 阶段 H：交付文档与重建复验

产出：

- 完整 `README.md`
- 完整 `check.md`
- Grafana 截图
- 依赖版本表
- 指标名称映射
- 工程优化说明

完成条件：

- `docker compose down` 后重新构建启动通过。
- 原有命名卷保留。
- Dashboard 自动加载。
- 重新发起真实请求并复验指标增长。

## 9. 风险与前置验证

| 风险 | 处理 |
|---|---|
| LiteLLM 指标名与预期不同 | 首次真实请求后读取 `/metrics`，按实际名称更新 Dashboard |
| LiteLLM 健康命令缺少 curl | 使用镜像自带运行时实现 healthcheck |
| PI Provider 字段与锁定版本不匹配 | 以 `1.6.0` 类型声明、Mock Gateway 和真实链路结果为准 |
| Prometheus 用户无 token 读权限 | 启动命令生成文件时设置正确 owner/mode |
| Grafana 初始化慢 | `depends_on` + 较长 `start_period` |
| 异步状态重启中断 | 启动扫描非终态 Run，标记 `interrupted_by_restart` |

## 10. 阶段 I：生产化加固

在 A-H 主链路完成后实现：

- `request_id`、`trace_id`、`model_call_id` 和 `release_id`。
- Run 事件 JSONL。
- 有界队列、并发上限、排队超时和统一任务截止时间。
- Gateway 调用级耗时、错误和 Token 指标。
- `release.json` 与运行版本绑定。
- Grafana 告警 provisioning 和状态变化验证。

完成条件：

- 一次请求可从 HTTP 入口追到 Gateway 调用和终态。
- 过载时服务不崩溃，队列满返回明确错误。
- 重建后可证明实际镜像与 Run 记录的发布版本一致。
- 告警规则可被加载并完成一次触发和恢复。

