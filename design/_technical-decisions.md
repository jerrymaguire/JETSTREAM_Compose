# 技术决策

| 编号 | 决策项 | 结论 | 理由 | 影响 |
|---|---|---|---|---|
| D-001 | 架构形态 | Agent 单体服务 + 基础设施容器 | 作业只有一条 Agent 业务链路 | 不引入服务拆分和内部 RPC |
| D-002 | 容器数量 | 严格四个 | 需求固定服务和启动命令 | 不使用 Postgres、Redis、init 容器 |
| D-003 | 网关 | LiteLLM 官方镜像或锁定版本自建镜像 | 满足模型路由、鉴权和指标要求 | 镜像 tag/digest 在实现时锁定 |
| D-004 | Agent 运行时 | Node 24 slim 镜像，PI `1.6.0` | 保持课程调用方式并清除旧版 high 依赖漏洞，满足 Node `>=22.19` | 镜像 digest 和 lock 文件共同锁定 |
| D-005 | Agent 语言 | TypeScript | 适合 PI SDK 与接口类型约束 | 构建为 JavaScript 后运行 |
| D-006 | HTTP 框架 | Node.js 原生 `node:http` | 与课程 6-4、6-6 实现一致，减少 Web 框架依赖 | 路由和请求校验由项目代码显式实现 |
| D-007 | 指标客户端 | `prom-client` | 原生 Prometheus 文本格式 | 统一指标注册 |
| D-008 | Agent 执行模式 | 默认同步，`async=true` 可选异步 | 同步验收最直接，异步接口仍可用 | Run 状态机必须完整 |
| D-009 | Agent 存储 | 命名卷 + 单 Run JSON 文件 | 不增加数据库容器，仍可保留数据 | 使用原子写和启动时加载 |
| D-010 | Agent 工作目录 | 独立命名卷 | 满足 PI 工作目录保留要求 | 与 Run 记录目录分离 |
| D-011 | 网关逻辑模型 | `deepseek-flash` | 与验收示例一致 | Agent 不暴露模型覆盖入口 |
| D-012 | 上游配置 | `DEEPSEEK_API_BASE`, `DEEPSEEK_API_KEY`，模型在 LiteLLM 配置中固定 | 与 week06 课程代码一致 | 只有 `gateway` 接收厂商凭据 |
| D-013 | 网关鉴权 | Bearer master key | 作业课程配置和验收命令采用 | master key 与 virtual key 同值 |
| D-014 | Prometheus 网关凭据 | 启动时写入 `/tmp` 受限权限文件 | 不把真实 token 提交到仓库 | 文件权限和运行用户需验证 |
| D-015 | Prometheus 抓取间隔 | 15 秒 | 满足及时观测 | 验收等待窗口至少 60 秒 |
| D-016 | Grafana 初始化 | provisioning 文件 | 重建后自动恢复数据源和 Dashboard | JSON 必须纳入版本管理 |
| D-017 | 端口暴露 | 默认 `127.0.0.1:<host>:<container>` | 局限本地作业访问面 | 不使用 `0.0.0.0` 发布 |
| D-018 | 启动顺序 | `gateway -> agent -> prometheus -> grafana` | 使用健康依赖满足课程要求 | 四服务均需真实 healthcheck |
| D-019 | 日志 | stdout/stderr + Docker 日志轮转 | 保持容器可观测且避免磁盘膨胀 | 不写容器内无限增长日志文件 |
| D-020 | Agent 镜像安全 | 多阶段构建、非 root `node` 用户 | 满足工程优化要求 | 最终镜像不包含开发依赖和源码工具链 |
| D-021 | SSE | 不纳入 MVP | 作业标记为可选 | 预留路径，不阻塞主验收 |
| D-022 | 测试方式 | 单元测试 + Compose 集成验收脚本 | 覆盖状态机、接口和真实链路 | 真实证据写入 `check.md` |
| D-023 | 链路关联 | `request_id` + `run_id` + `trace_id` + `model_call_id` | 可从一次失败追到具体 Gateway 调用 | 事件归档必须统一携带 |
| D-024 | 过载保护 | 有界队列 + 并发上限 + 任务截止时间 | 防止本地服务被并发请求拖垮 | 过载返回明确状态 |
| D-025 | 版本追踪 | `release.json` + `RELEASE_ID` | 固定镜像、模型和配置组合 | Run 和健康接口绑定版本 |
| D-026 | 模型调用指标 | 调用次数、耗时和 Token 用量 | 区分 Agent 总耗时与 Gateway 调用耗时 | 不将高基数 ID 放入标签 |
| D-027 | 告警 | Grafana provisioning 规则 | 不增加容器即可主动发现 target 和业务异常 | 作为增强验收 |
| D-028 | 第六章重型能力 | Langfuse、Replay 服务、RAG Cache、Eval Runner 延后 | 超出四容器主作业范围 | 保留后续演进接口 |
| D-029 | 版本基线 | PI `1.6.0`、TypeScript `5.9.3`、`prom-client` `15.1.3` | 课程 0.87.1 基线存在已知依赖漏洞，1.6.0 兼容并满足 `>=0.87.x` | 通过 `package-lock.json` 锁定 |
| D-030 | Gateway 模型 | `deepseek-flash` → `deepseek/deepseek-v4-flash`，main/standby 同别名 | 与课程 6-6 LiteLLM 配置一致 | 上游密钥仅进入 gateway |
| D-031 | Prometheus 网关凭据 | `bearer_token_file` | 作业建议并与课程配置一致 | 启动时生成受限权限文件 |
| D-032 | 指标口径 | Run 按任务、模型调用按单次调用统计 | 与课程 6-4 的分母定义一致 | 禁止混用任务数和调用数 |

## 1. 被拒绝的方案

| 方案 | 拒绝原因 |
|---|---|
| 引入 Postgres 保存 Run | 超出课程四容器配置，增加启动与凭据复杂度 |
| 所有服务共用一个 `env_file` | 会把上游密钥暴露给 Agent 和监控服务 |
| 宿主机用 `localhost` 作为容器间地址 | 会指向各自容器，不是目标服务 |
| 使用内存 Run 状态 | 不满足运行数据保留和重建复验要求 |
| 把 token 明文写入 `prometheus.yml` | 违反凭据隔离和脱敏要求 |
| 手工导入 Grafana Dashboard | 重建后无法自动恢复，不满足 provisioning 要求 |
| Agent 直接调用上游模型 | 绕开 LiteLLM，无法满足网关和网关指标验收 |
| 为追踪加入 Langfuse 第五个容器 | 违反本次固定四容器边界 |
| 无上限地并发执行 Run | 本地服务过载时所有请求一起超时 |
| 只保存最终答案不保存事件 | 无法定位 Gateway 调用和状态迁移发生在哪一步 |

