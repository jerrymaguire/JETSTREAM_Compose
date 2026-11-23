# 技术栈

## 1. 运行时与组件

| 层级 | 技术 | 设计版本/约束 | 版本锁定方式 |
|---|---|---|---|
| 编排 | Docker Compose v2 | 支持 `depends_on.condition` | README 记录本机版本 |
| 模型网关 | LiteLLM Proxy | 实现时锁定稳定版本 | 镜像 tag + digest，或自建镜像锁定 Python 包 |
| Agent 运行时 | Node.js | 24，基础镜像 `node:24-bookworm-slim`，实现时固定 digest | Compose 镜像引用 |
| Agent 语言 | TypeScript | `5.9.3` | `package-lock.json` |
| PI SDK | `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent` | `1.6.0` | `package-lock.json` |
| HTTP 服务 | Node.js 原生 `node:http` | 与课程代码一致，不引入 Web 框架 | 无额外依赖 |
| 指标客户端 | `prom-client` | `15.1.3` | `package-lock.json` |
| 指标存储 | Prometheus | `prom/prometheus:v3.1.0`，实现时补充 digest | Compose 镜像引用 |
| 可视化 | Grafana | `grafana/grafana:11.4.0`，实现时补充 digest | Compose 镜像引用 |

## 2. 镜像策略

### 2.1 Agent

- 构建阶段使用 Node 24 基础镜像。
- 运行阶段使用 `node:24-bookworm-slim` 并固定 digest。
- 先复制 `package.json` 和 `package-lock.json`，执行 `npm ci`。
- 完成 TypeScript 构建后再复制生产依赖和 `dist/` 到运行阶段。
- 最终容器以非 root `node` 用户运行。

### 2.2 Gateway

- 优先使用官方 LiteLLM 镜像。
- 若官方 tag 漂移影响复现，则改用自建镜像并锁定 `litellm[proxy]` 版本。
- 配置文件通过只读挂载进入容器。
- 不在镜像中写入任何真实密钥。

### 2.3 Prometheus 和 Grafana

- 使用官方镜像。
- 固定 tag 或 digest，禁止使用 `latest` 作为唯一版本依据。
- Prometheus 配置和 Grafana provisioning 文件只读挂载。
- 数据写入命名卷。

## 3. Agent 依赖边界

| 依赖 | 用途 |
|---|---|
| `@earendil-works/pi-ai` | OpenAI 兼容 Gateway Provider 和模型定义 |
| `@earendil-works/pi-agent-core` | PI Agent 执行核心 |
| `@earendil-works/pi-coding-agent` | 课程基线 Agent 能力 |
| `prom-client` | Counter、Histogram、默认进程指标 |

不引入数据库 ORM、消息队列客户端或额外 Web 框架，避免扩大攻击面和镜像体积。

## 4. 版本锁定要求

1. `package-lock.json` 必须提交。
2. Dockerfile 使用 `npm ci`，不得使用 `npm install` 生成不确定依赖。
3. Node、LiteLLM、Prometheus、Grafana 的版本在 README 的依赖表中写明；Prometheus 使用 `v3.1.0`，Grafana 使用 `11.4.0`。
4. LiteLLM 逻辑模型名固定为 `deepseek-flash`，上游模型固定为 `deepseek/deepseek-v4-flash`，API Base 和密钥通过环境变量注入。
5. 使用课程已验证的 LiteLLM 指标名，并在锁定版本上再次核对：
   - `litellm_proxy_total_requests_metric_total`
   - `litellm_request_total_latency_metric_bucket`
   - `litellm_total_tokens_metric_total`
   - `litellm_spend_metric_total`

## 5. 工程优化选型

本次设计选择两项工程优化：

1. Agent 多阶段构建，减少运行镜像内容。
2. Agent 使用非 root 用户运行，降低容器内权限。

实现后在 README 中写明 Dockerfile 对应位置和验证方式。

