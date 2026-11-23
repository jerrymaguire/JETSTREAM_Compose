# 架构类型决策

| 项目 | 结论 |
|---|---|
| 工程路径 | `D:\wj\projects\AI\GeekAgent\Week6\AgentCompose` |
| 架构类型 | Agent 单体业务服务 + 外部基础设施容器 |
| 是否微服务 | 否 |
| 业务服务数量 | 1，`agent` |
| 基础设施服务 | 3，`gateway`、`prometheus`、`grafana` |
| 容器总数 | 4，固定 |
| 数据库 | 不引入关系数据库 |
| 容器网络 | 单个 Compose 项目网络 |
| 决策依据 | 作业明确四容器、无 Postgres，主业务链路只有 Agent 调用网关 |

