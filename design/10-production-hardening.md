# 第六章参考后的生产化加固设计

> 参考文档：[第六章 学习笔记](https://geekbang.feishu.cn/docx/BQkDdoehfoM009xOknsczlz2noc?from=from_copylink)
>
> 适用范围：在不改变作业六“四容器、无 Postgres、一次真实 Agent 调用”要求的前提下，吸收第六章中可低成本落地的生产化做法。

## 1. 对比结论

原设计已经覆盖作业六的交付要求，但对照第六章后，发现以下缺口值得补齐：

| 优先级 | 缺口 | 风险 | 本次处理 |
|---|---|---|---|
| P0 | 请求、运行、模型调用缺少统一关联 ID | 出问题时只能看到一个最终错误，难以定位链路 | 纳入设计 |
| P0 | 队列、并发和三层超时没有明确上限 | 并发请求可能拖垮本地服务，异步任务可能永久等待 | 纳入设计 |
| P0 | 运行记录没有绑定发布版本和实际模型 | 重建后无法证明某次结果来自哪套配置 | 纳入设计 |
| P1 | 缺少模型调用级延迟、错误和 Token 用量 | 只能知道 Agent 总耗时，难以判断慢在 Agent 还是 Gateway | 纳入设计 |
| P1 | 没有告警规则设计 | Dashboard 只能人工观察，异常不能主动暴露 | 纳入设计，作为增强验收 |
| P2 | 没有 Trace、Replay、缓存和评测平台 | 排障深度和多环境发布能力有限 | 明确延后，不增加容器 |
| P2 | 没有多模型路由、Fallback 和预算台账 | 无法比较模型能力与失败代价 | 预留扩展点，不进入 MVP |

## 2. 关联 ID 与事件记录

### 2.1 稳定字段

| 字段 | 生成方 | 作用 |
|---|---|---|
| `request_id` | Agent HTTP 入口 | 关联一次宿主机请求；优先复用合法 `X-Request-ID`，否则生成 UUID |
| `run_id` | Agent | 标识一次 Agent 运行，作为查询和持久化主键 |
| `trace_id` | Agent 或上游 `traceparent` | 预留 Trace 系统接入；MVP 只写入事件记录 |
| `model_call_id` | Agent | 标识一次 Gateway 调用，用于关联耗时、Token、错误和 Fallback |
| `release_id` | 部署配置 | 标识本次运行实际加载的发布清单 |

`trace_id` 不要求引入额外服务。MVP 中由 Agent 生成或接收，并与 `request_id`、`run_id` 一起写入运行事件。

### 2.2 事件归档

在 Agent 数据卷中保留两份数据：

```text
/app/data/runs/{run_id}/input.json    # 请求输入和发布绑定
/app/data/runs/{run_id}/versions.json # 发布清单摘要
/app/data/runs/{run_id}/events.jsonl  # 追加式结构化事件
/app/data/runs/{run_id}/result.json   # 当前和最终状态，供查询接口读取
```

事件至少包括：

- `run.created`
- `run.started`
- `gateway.call.started`
- `gateway.call.finished`
- `run.completed`
- `run.failed`

每条事件统一携带 `timestamp`、`event`、`request_id`、`run_id`、`trace_id` 和 `release_id`。Gateway 调用事件额外携带 `model_call_id`、逻辑模型、实际模型（如响应可用）、耗时、结果和 Token 用量。

容器 stdout/stderr 仍输出结构化 JSON 运行日志。`events.jsonl` 属于本地运行数据，不替代 Docker 日志。

## 3. 并发、队列与超时

### 3.1 有界执行

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `AGENT_MAX_CONCURRENCY` | `4` | 同时执行的 Run 上限 |
| `AGENT_QUEUE_CAPACITY` | `32` | 等待执行的 Run 上限 |
| `AGENT_QUEUE_TIMEOUT_MS` | `2000` | 单个 Run 最长排队时间 |
| `AGENT_RUN_TIMEOUT_MS` | `90000` | 包含排队、Gateway 调用和状态持久化的总截止时间 |
| `AGENT_GATEWAY_TIMEOUT_MS` | `80000` | 单次 Gateway HTTP 调用上限 |

所有超时必须使用同一个任务截止时间计算。排队已消耗的时间要从 Gateway 调用预算中扣除，避免排队和下游调用各自使用完整超时。

### 3.2 过载行为

- 队列未满：异步请求返回 `202 queued`。
- 队列已满：返回 `429 agent_busy`，不创建成功运行。
- 排队超时：Run 进入 `failed`，错误码为 `queue_timeout`。
- Gateway 超时：Run 进入 `failed`，错误码为 `run_timeout`。
- 服务重启时发现的非终态 Run：标记为 `failed`，错误码为 `interrupted_by_restart`。

## 4. 模型调用级可观测性

在保留原有 Run 指标的基础上增加以下指标：

| 指标 | 类型 | 标签 | 用途 |
|---|---|---|---|
| `agent_queue_depth` | Gauge | 无 | 当前等待中的 Run 数 |
| `agent_runs_in_flight` | Gauge | `mode` | 当前执行中的 Run 数 |
| `agent_run_queue_wait_ms` | Histogram | `outcome` | 排队耗时 |
| `agent_model_calls_total` | Counter | `workflow`, `model`, `outcome`, `status_code` | 单次 Gateway 模型调用结果 |
| `agent_model_call_duration_seconds` | Histogram | `workflow`, `model`, `outcome` | 单次模型调用耗时 |
| `agent_model_tokens_total` | Counter | `kind`, `model` | `prompt`、`completion` 和 `total` Token |
| `agent_build_info` | Gauge | `release_id`, `version`, `model` | 固定为 `1`，标识当前发布版本 |

标签只使用稳定枚举或受控配置值。不得把 `run_id`、`request_id`、`trace_id` 或完整 URL 放入 Prometheus 标签。

若 Gateway 响应包含 `usage`，Agent 将 Token 用量写入 Run 记录和指标；若响应无用量，记录 `usage_available=false`，不以估算值冒充真实用量。

## 5. 发布清单与版本绑定

新增只读的 `release.json`。它只记录版本和脱敏后的配置摘要，不包含密钥：

```json
{
  "release_id": "local-20261122.1",
  "agent_image": "sha256:...",
  "gateway_image": "sha256:...",
  "prometheus_image": "sha256:...",
  "grafana_image": "sha256:...",
  "model_alias": "deepseek-flash",
  "upstream_model": "deepseek/deepseek-v4-flash",
  "config_files": {
    "gateway/config.yaml": "sha256:...",
    "prometheus/prometheus.yml": "sha256:...",
    "grafana/dashboards/agent-compose.json": "sha256:..."
  }
}
```

约束：

1. `RELEASE_ID` 通过环境变量注入，并与 `release.json` 一致。
2. `/health`、Run 记录、事件归档和新增指标可读取 `release_id`。
3. 一个 Run 创建后固定发布版本；重试和恢复继续按该版本执行。
4. `docker compose down` 后重建时重新核对 `release.json` 和实际镜像 digest。
5. 真实密钥不进入发布清单。

## 6. 告警规则

告警通过 Grafana provisioning 管理，不增加容器。建议新增：

```text
grafana/provisioning/alerting/agent-compose-alerts.yml
```

首批规则：

| 告警 | 条件 | 最低增强验收 |
|---|---|---|
| Gateway target down | `up{job="gateway"} == 0` 持续 1 分钟 | 停止 gateway 后规则进入 Pending/Firing |
| Agent target down | `up{job="agent"} == 0` 持续 1 分钟 | 停止 agent 后规则进入 Pending/Firing |
| Agent 失败率偏高 | 最近 10 分钟失败率 > 5%，样本至少 20 次 | 制造连续失败并核对通知或规则状态 |
| 队列接近满载 | `agent_queue_depth > 24` 持续 2 分钟 | 压入等待任务并观察规则 |
| Agent P95 超时 | `histogram_quantile(0.95, ...) > 60s` 持续 5 分钟 | 用受控慢响应验证 |

作业主验收不强制通知通道，但至少应验证规则状态变化。没有真实通知接收人时，Grafana 中保留规则和触发记录，并在 `check.md` 说明未配置外部通知。

## 7. 不进入本次四容器 MVP 的能力

| 第六章能力 | 当前处理 | 原因 |
|---|---|---|
| Langfuse 全链路 Trace | 延后 | 需要额外服务，作业固定四容器 |
| 独立 Eval Runner | 延后 | 当前只有一个 Agent 主链路 |
| Replay 服务和归档管理界面 | 延后 | 先保留事件与请求材料，后续再接入 |
| Semantic/RAG/Embedding Cache | 不适用 | 当前 Agent 不包含检索链 |
| 多能力模型路由 | 预留 | 当前只要求一个逻辑模型 |
| 同逻辑名 main/standby | 纳入 | 课程已验证，可降低单部署故障影响 |
| 日/月预算与费用台账服务 | 延后 | 当前规模小，先记录单次调用真实用量 |
| vLLM 自托管推理 | 可选替换上游 | 作业要求 OpenAI 兼容上游，不要求本地 GPU |
| SDK 与多服务治理平台 | 延后 | 超出作业六范围 |

## 8. 新增验收项

在不替代原验收的前提下增加：

1. 调用 `POST /v1/runs` 时传入固定 `X-Request-ID`，响应、Run 记录和事件 JSONL 中出现同一个值。
2. Run 记录中的 `release_id` 与 `/health` 返回值和 `release.json` 一致。
3. 事件 JSONL 中能用 `run_id` 找到 Gateway 调用开始、结束和最终状态。
4. Gateway 响应有 `usage` 时，Run 记录和 Agent 指标出现对应 Token 数。
5. 同时提交超过并发上限的请求时，多出的请求进入有界队列；队列满后返回 `429 agent_busy`，服务不崩溃。
6. 停止 Agent 或 Gateway 后，对应的 `up` 告警规则能够进入 Pending/Firing，恢复后回到 Normal。

这些增强项不改变四容器数量、端口契约、真实模型调用和 Dashboard 最低要求。
