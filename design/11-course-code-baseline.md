# 课程代码对齐基线

> 课程代码根目录：
> `D:\wj\projects\AI\GeekAgent\gitstore\ai-agent-fullstack-training\course_code\week06`
>
> 目的：把课程代码中已经验证过的版本、配置格式、指标名称和归档方式映射到作业六设计。本文只记录设计基线，不复制课程平台的多服务实现。

## 1. 参考位置

| 课程目录 | 主要参考内容 | 在 AgentCompose 中的用途 |
|---|---|---|
| `6-2/config/litellm.*.yaml` | 逻辑模型、限流、Fallback、冷却和 OpenAI 兼容配置 | Gateway 配置结构 |
| `6-3/6-3.zip` | `run_id`、`tool_call_id`、结构化日志、Trace、Replay | 关联 ID 和事件归档 |
| `6-4/src/` | `prom-client` Registry、模型调用 Counter/Histogram | Agent 指标实现 |
| `6-4/monitoring/` | Prometheus、Grafana provisioning、镜像版本和 Dashboard | 监控栈配置 |
| `6-5/release.py` | stable/pilot 路由、候选检查、发布、回滚 | 发布清单和后续灰度扩展 |
| `6-6/.../services/gateway/litellm.config.yaml` | 同逻辑名的 main/standby、LiteLLM 指标开关 | Gateway 主备部署和指标启用 |
| `6-6/.../services/agent/src/server.ts` | HTTP/SSE、请求 ID、运行归档、用量和回放 | Agent 服务结构 |
| `6-6/.../services/agent/src/core/runs.ts` | 目录式 Run 归档和重启恢复 | 文件持久化方式 |
| `6-6/.../deploy/prometheus/` | `bearer_token_file`、数据源 UID 和 Dashboard | 监控准入与面板 |

## 2. 版本基线

课程目录中同时存在监控演示和平台快照，两者版本不完全相同。AgentCompose 采用以下选择：

| 组件 | 采用版本 | 依据 |
|---|---|---|
| PI SDK | `1.6.0` | 课程快照为 `0.87.1`；实现升级到 `1.6.0`，仍符合作业 `>=0.87.x` 且清除旧依赖漏洞 |
| Node.js | `24-bookworm-slim`，最终镜像锁定 digest | `6-6/services/agent/Dockerfile`，同时满足 `>=22.19` |
| TypeScript | `5.9.3` | `6-6/codebase/package.json` |
| HTTP 服务 | Node.js 原生 `node:http` | `6-4` 与 `6-6` 均使用，减少额外 Web 框架 |
| 指标客户端 | `prom-client` `15.1.3` | `6-4/package.json` |
| Prometheus | `prom/prometheus:v3.1.0` | `6-4` 和 `6-6` 监控配置 |
| Grafana | `grafana/grafana:11.4.0` | `6-4` 监控配置 |
| LiteLLM | 稳定版本 tag + digest | 课程使用 `main-stable`，作业要求可复现，因此不能只写浮动 tag |

`6-6/codebase` 的业务快照使用 PI `0.87.1`，但该版本的传递依赖审计包含 high 漏洞。AgentCompose 保留 `6-6` 的调用方式，并将三个 PI 包统一下载到 `1.6.0`；编译、本地 OpenAI-compatible Mock 和真实 DeepSeek 链路均已验证。

## 3. Gateway 对齐

### 3.1 模型部署

采用与课程平台一致的 DeepSeek 逻辑模型：

```yaml
model_list:
  - model_name: deepseek-flash
    litellm_params:
      model: deepseek/deepseek-v4-flash
      api_base: os.environ/DEEPSEEK_API_BASE
      api_key: os.environ/DEEPSEEK_API_KEY
      timeout: 80
      max_retries: 0
    model_info:
      id: deepseek-flash-primary

  - model_name: deepseek-flash
    litellm_params:
      model: deepseek/deepseek-v4-flash
      api_base: os.environ/DEEPSEEK_API_BASE
      api_key: os.environ/DEEPSEEK_API_KEY
      timeout: 80
      max_retries: 0
    model_info:
      id: deepseek-flash-standby
```

主备部署使用同一个逻辑模型名，Agent 不需要感知切换。Fallback 必须有次数上限和冷却，不能无限重试。

### 3.2 指标开关

LiteLLM 配置必须显式启用 Prometheus：

```yaml
litellm_settings:
  callbacks: ["prometheus"]
```

未启用时 `/metrics` 常见结果是 404，而不是鉴权失败。

### 3.3 已确认指标

课程 Dashboard 和验收文档使用以下指标名：

| 指标 | 用途 |
|---|---|
| `litellm_proxy_total_requests_metric_total` | 按 `model_id`、`status_code` 统计请求 |
| `litellm_request_total_latency_metric_bucket` | 请求延迟 Histogram |
| `litellm_total_tokens_metric_total` | Token 累计量 |
| `litellm_spend_metric_total` | 估算成本累计量 |

Agent 的 Gateway 调用指标使用 `agent_model_calls_total` 和 `agent_model_call_duration_seconds`，与课程 6-4 的“按单次模型调用统计”口径一致。

## 4. Agent 归档对齐

课程 6-6 使用目录式归档，AgentCompose 采用同样的结构：

```text
/app/data/runs/{run_id}/
├── input.json
├── versions.json
├── events.jsonl
├── result.json
└── raw/                 # 可选，保存受控模型消息快照
```

区别：

- `input.json` 保存请求、租户、发布版本和模型别名。
- `versions.json` 保存发布清单摘要。
- `events.jsonl` 保存状态迁移、Gateway 调用和最终结果。
- `result.json` 保存查询接口需要的最终状态和输出。
- 暂不复制课程平台的 Replay Worker、Langfuse 和平台控制面。

## 5. 可直接复用的代码模式

| 课程模式 | AgentCompose 设计 |
|---|---|
| `request_id` 从 `X-Request-ID` 读取或生成 | 保留 |
| `run_id` 作为查询和归档主键 | 保留 |
| 运行先写盘再广播事件 | 保留 |
| 进程重启后从归档恢复历史 Run | 保留 |
| `prom-client` 单 Registry 输出 `/metrics` | 保留，绑定 `0.0.0.0:8080` |
| 模型调用使用单调时钟测量耗时 | 保留 |
| 未返回用量或价格时标记 unknown | 保留 |
| `bearer_token_file` 抓取 LiteLLM 指标 | 保留 |
| Grafana provisioning 加载数据源和 Dashboard | 保留 |
| 发布版本绑定 Run | 保留精简版 `release_id` |

## 6. 不直接复制的部分

| 课程内容 | 不复制原因 |
|---|---|
| 6-6 的 platform、retrieval、eval、Langfuse 多服务部署 | 作业六固定四容器 |
| 平台 API Key、租户角色和预算控制面 | 超出本地作业范围 |
| PI CLI 子进程和 Codebase 工具集 | 当前只要求一层 PI Agent HTTP 服务 |
| 6-4 指标服务监听 `127.0.0.1:9464` | 容器内必须监听 `0.0.0.0:8080` 才能被 Prometheus 抓取 |
| `litellm:main-stable` 浮动 tag | 不满足可复现交付 |
| 6-4 的 `node-exporter` 和 Pi 会话动态发现 | 不改变作业固定四个抓取服务 |
| 6-6 stable/pilot 双轨发布 | 作业不要求灰度，但保留发布清单和回滚设计 |

## 7. 对齐后的设计结论

AgentCompose 继续采用四容器：

```text
gateway      LiteLLM + main/standby + Prometheus callback
agent        Node 原生 HTTP + PI 1.6.0 + 文件归档 + prom-client
prometheus   bearer_token_file 抓取 gateway/agent/self
grafana      数据源 + Dashboard + 可选告警 provisioning
```

课程代码用于确定版本、配置写法和指标口径，不作为多服务平台的直接拷贝来源。
