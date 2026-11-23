# 数据与持久化设计

## 1. 设计结论

本作业不引入关系数据库。原因如下：

- 强制容器数量为四个，课程配置明确不引入 Postgres。
- 业务实体只有 Agent Run，不需要复杂事务和联表查询。
- 运行记录、Agent 工作目录、Prometheus 和 Grafana 数据均可通过命名卷持久化。

## 2. 持久化卷

| 卷名 | 挂载点 | 内容 | 生命周期 |
|---|---|---|---|
| `agent-data` | `/app/data` | Run 目录、事件和重建索引所需数据 | `down` 保留 |
| `agent-workspace` | `/workspace` | PI 工作目录 | `down` 保留 |
| `prometheus-data` | `/prometheus` | TSDB | `down` 保留 |
| `grafana-data` | `/var/lib/grafana` | Grafana 数据库、用户状态 | `down` 保留 |

`docker compose down` 不删除命名卷。只有显式执行 `docker compose down -v` 才会清除数据，该命令不用于正常验收。

## 3. Run 记录模型

每个 Run 对应一个目录：

```text
/app/data/runs/{run_id}/
├── input.json
├── versions.json
├── events.jsonl
├── result.json
└── raw/
```

`input.json` 保存请求输入和发布绑定，`versions.json` 保存发布清单摘要，`events.jsonl` 保存状态迁移和模型调用事件，`result.json` 保存查询接口需要的最终摘要，`raw/` 可选保存受控模型消息快照。

查询接口返回的逻辑记录字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | integer | 是 | 初始值 `1` |
| `run_id` | string | 是 | UUID |
| `session_id` | string | 是 | 多轮会话 ID |
| `request_id` | string | 是 | HTTP 请求关联 ID |
| `trace_id` | string | 是 | Trace 关联 ID，MVP 只归档、不依赖 Trace 服务 |
| `tenant` | string | 是 | 请求租户标签 |
| `input` | string | 是 | 用户输入 |
| `model` | string | 是 | 固定为 `deepseek-flash` |
| `resolved_model` | string/null | 否 | Gateway 响应中可确认的实际模型 |
| `model_call_id` | string | 是 | 本次 Gateway 调用的关联 ID |
| `release_id` | string | 是 | 本次运行绑定的发布编号 |
| `status` | string | 是 | `queued/running/completed/failed` |
| `task_mode` | boolean | 是 | 是否按任务模式执行 |
| `output` | string/null | 是 | 终态回答 |
| `error_code` | string/null | 否 | 稳定错误码 |
| `error_message` | string/null | 否 | 脱敏错误信息 |
| `created_at` | ISO-8601 string | 是 | 创建时间 |
| `started_at` | ISO-8601 string/null | 否 | 开始执行时间 |
| `finished_at` | ISO-8601 string/null | 否 | 终态时间 |
| `duration_ms` | integer/null | 否 | 运行耗时 |
| `gateway_request_id` | string/null | 否 | 上游请求关联 ID，如可用 |
| `usage_available` | boolean | 是 | Gateway 是否返回真实 Token 用量 |
| `prompt_tokens` | integer/null | 否 | 输入 Token 数 |
| `completion_tokens` | integer/null | 否 | 输出 Token 数 |
| `total_tokens` | integer/null | 否 | 总 Token 数 |

示例结构：

```json
{
  "schema_version": 1,
  "run_id": "019b0000-0000-7000-8000-000000000001",
  "session_id": "session-ui-0123456789abcdef",
  "request_id": "req-20261122-001",
  "trace_id": "trace-20261122-001",
  "tenant": "demo",
  "input": "用一句话说明什么是幂等",
  "model": "deepseek-flash",
  "resolved_model": "deepseek-v4-flash",
  "model_call_id": "model-call-20261122-001",
  "release_id": "local-20261122.1",
  "status": "completed",
  "task_mode": false,
  "output": "示例回答",
  "error_code": null,
  "error_message": null,
  "created_at": "2026-11-22T00:00:00.000Z",
  "started_at": "2026-11-22T00:00:00.050Z",
  "finished_at": "2026-11-22T00:00:02.100Z",
  "duration_ms": 2050,
  "gateway_request_id": null,
  "usage_available": true,
  "prompt_tokens": 28,
  "completion_tokens": 36,
  "total_tokens": 64
}
```

## 4. 运行事件归档

事件追加到 `events.jsonl`，至少包含 `run.created`、`run.started`、`gateway.call.started`、`gateway.call.finished`、`run.completed` 或 `run.failed`。统一字段包括 `request_id`、`run_id`、`trace_id`、`release_id` 和时间戳。

事件文件用于排障和后续 Replay。`result.json` 是查询终态的主要来源，`input.json` 和 `events.jsonl` 用于补足上下文。

## 5. 写入策略

1. 创建 Run 目录并写入 `input.json` 和 `versions.json`。
2. 先追加事件，再更新查询摘要，避免广播出没有归档的事实。
3. `result.json` 使用临时文件写入后重命名，避免中断产生半截 JSON。
4. 启动时扫描 `runs/*/input.json` 和 `result.json`，以目录名作为 `run_id` 重建内存索引。
5. 没有 `result.json` 的非终态目录在重启后标记为 `failed`，错误码为 `interrupted_by_restart`。

## 6. 索引与查询

- 主查询键：`run_id`。
- 不实现按租户或时间的复杂查询。
- 指标中的 `tenant` 用于聚合，不替代 Run 查询。
- 若后续扩展，可增加轻量索引文件，但不引入数据库容器。

## 7. 数据安全

- Run 输入和输出可能包含业务内容，不写应用日志正文。
- 错误消息不得包含凭据、完整请求头或上游响应中的敏感字段。
- 卷数据属于本地作业数据，不提交到 Git。
- `check.md` 中只记录必要结果，敏感输入使用固定验收问题。

