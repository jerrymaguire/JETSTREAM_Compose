# 验收设计

## 1. 验收前置

1. 从 `.env.example` 创建 `.env`。
2. 填入网关 key、上游模型 key 和 Grafana 密码。
3. 检查 `docker compose config --services` 只输出四个服务。
4. 确认宿主机默认端口空闲；若 `8765` 被占用，将 `GRAFANA_PORT` 改为 `8766`。

## 2. 启动验收

执行：

```bash
docker compose up -d --build
docker compose ps
```

通过：

- `gateway`
- `agent`
- `prometheus`
- `grafana`

四者均为 `healthy`。

## 3. 四入口探针

```bash
curl -fsS http://127.0.0.1:4000/health/liveliness
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:9090/-/healthy
curl -fsS http://127.0.0.1:8765/api/health
```

通过：

- 四个请求均返回 HTTP 200。
- Agent 健康 JSON 含 `status=ok`。
- Grafana 健康 JSON 中 `database=ok`。

## 4. 网关直连验收

```bash
curl -fsS http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"用一句话说明什么是幂等"}],"max_tokens":512}'
```

通过：

- HTTP 200。
- `choices[0].message.content` 非空。
- 未出现空回答或 `finish_reason=length` 导致的完全空内容。

## 5. 指标端点验收

```bash
curl -fsSL -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  http://127.0.0.1:4000/metrics
curl -fsS http://127.0.0.1:8080/metrics
curl -fsS http://127.0.0.1:9090/api/v1/targets
```

通过：

- 网关指标包含真实 `litellm_*` 时间序列。
- 至少能查到 `litellm_proxy_total_requests_metric_total`、`litellm_total_tokens_metric_total` 和 `litellm_spend_metric_total`。
- Agent 指标包含 `agent_runs_total` 和 `agent_run_duration_ms_*`。
- Prometheus targets 中 `gateway`、`agent`、`prometheus` 均为 `UP`。

## 6. 基线记录

在 Agent 验收请求前查询：

```promql
sum(litellm_proxy_total_requests_metric_total)
sum(agent_runs_total)
```

可同时记录 Token 和成本基线：

```promql
sum(litellm_total_tokens_metric_total)
sum(litellm_spend_metric_total)
```

若没有样本，记录为“无样本”。实际指标名以首次联调输出为准。

## 7. 完整链路验收

### 7.1 同步请求

```bash
curl -fsS http://127.0.0.1:8080/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"input":"用一句话说明什么是幂等","tenant":"demo"}'
```

通过：

- 响应含 `run_id`。
- `status=completed`。
- `output` 非空。

### 7.2 异步请求

```bash
curl -fsS http://127.0.0.1:8080/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"input":"用一句话说明什么是幂等","tenant":"demo","async":true}'
```

通过：

- 初始返回 HTTP 202 和 `queued`。
- 使用 `GET /v1/runs/{run_id}` 轮询到 `completed` 或 `failed`。
- 作业主验收使用 `completed` 且 `output` 非空。

## 8. 指标增长验收

在无其他测试流量的情况下，最多等待 60 秒：

1. 网关请求总数超过基线，或基线无样本时出现正值。
2. Agent 运行总数超过基线，或基线无样本时出现正值。
3. 有条件的再验证 Token 用量或成本指标增长。

## 9. Grafana 验收

打开：

```text
http://127.0.0.1:8765
```

通过：

- 自动存在 `Prometheus` 数据源。
- 自动存在 `AgentCompose Overview` Dashboard。
- Dashboard 至少四个业务面板。
- 时间范围覆盖本轮请求。
- 至少两个面板显示非零数据。
- 截图保存到 `check/evidence/grafana-dashboard.png`。

## 10. 重建复验

```bash
docker compose down
docker compose up -d --build
```

通过：

- 四服务恢复 `healthy`。
- 数据卷保留，Run 记录仍可查询。
- Dashboard 自动加载，不依赖手工导入。
- 重新发起一次 Agent 请求并确认终态。
- 监控数据在重建后继续增长。

## 11. check.md 证据结构

| 章节 | 内容 |
|---|---|
| 环境 | Docker、Compose、镜像版本，脱敏 |
| 容器 | `docker compose ps` 摘要 |
| 端点 | 四探针结果 |
| targets | 三任务状态 |
| 网关 | 直连模型与 metrics 结论 |
| Agent | Run 请求、终态和输出非空结论 |
| 指标 | 两条指标的前后值 |
| Grafana | 数据源、Dashboard 和截图路径 |
| 重建 | down/up 后复验结果 |
| 安全 | 密钥隔离与脱敏检查结论 |

## 12. 验收判定

以下全部满足才算完成：

- 四容器与四探针通过。
- 三个 target 通过。
- 网关真实调用通过。
- Agent 真实终态通过。
- 两侧指标随本轮请求增长。
- Grafana 至少两个业务面板非零。
- 重建后再次通过。
- README 和 check.md 证据完整且脱敏。

## 13. 第六章参考后的增强验收

以下项目不替代主验收，但建议在实现阶段执行并记录：

| 场景 | 证据 |
|---|---|
| 请求关联 | 固定 `X-Request-ID`，响应、Run JSON 和事件 JSONL 中值一致 |
| 版本绑定 | `/health`、Run JSON 和 `release.json` 的 `release_id` 一致 |
| 调用级指标 | Gateway 调用次数、耗时和 Token 指标可查询 |
| 队列过载 | 超出并发上限的请求排队；队列满返回 `429 agent_busy` |
| 截止时间 | 受控慢响应触发 `run_timeout`，事件记录包含超时阶段 |
| 版本恢复 | `down/up` 后发布清单仍能对应实际镜像 digest |
| 告警状态 | 停止 Agent/Gateway 后规则进入 Pending/Firing，恢复后回到 Normal |

