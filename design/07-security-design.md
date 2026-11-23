# 安全设计

## 1. 安全目标

- 上游厂商 API Key 只存在 `gateway` 容器的运行环境中。
- Agent 只能使用受控网关凭据，不接触厂商密钥。
- 网关指标端点必须鉴权。
- 本地监控入口默认只绑定 `127.0.0.1`。
- 仓库、镜像构建上下文和验收材料不包含真实密钥。

## 2. 凭据分类

| 凭据 | 持有者 | 用途 | 禁止暴露 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | `gateway` | 调用 DeepSeek 上游 | Agent、Prometheus、Grafana、日志、Git |
| `LITELLM_MASTER_KEY` | `gateway` | 网关管理鉴权 | Git、README、截图 |
| `GATEWAY_API_KEY` | `agent` | 调用 LiteLLM | Git、日志、Run 响应 |
| `LITELLM_VIRTUAL_KEY` | `gateway` | 课程配置兼容，与 master 同值 | 其他容器、Git |
| `GRAFANA_ADMIN_PASSWORD` | `grafana` | Grafana 登录 | Git、日志、截图 |

## 3. Compose 注入规则

- 不使用全局 `env_file` 给所有服务广播环境变量。
- `.env` 只作为 Compose 插值来源。
- 每个服务通过显式 `environment` 接收最小变量集合。
- Prometheus 接收 master key 仅用于启动时生成受限权限 token 文件。
- Agent 的 `GATEWAY_API_KEY` 使用 Compose 映射，不额外保存副本。

## 4. 网络暴露

- 端口绑定 `127.0.0.1`，避免局域网直接访问。
- Grafana 在 `127.0.0.1` 本地入口启用匿名 Viewer 只读访问，便于直接查看 Dashboard；管理员账号仍用于登录和编辑。用户注册关闭。
- LiteLLM `/metrics` 需要 Bearer 凭据。
- Agent `/metrics` 虽然按作业要求对内网和宿主机开放，但不包含密钥和用户正文。

## 5. 文件与目录权限

- `.env` 和本地凭据文件不进入 Git。
- 构建上下文排除 `.env`、`secrets/` 和本地数据。
- Prometheus token 文件权限设置为仅运行用户可读。
- Agent 数据卷只保存运行记录，不写入凭据。
- `release.json` 只记录镜像、模型和配置摘要，不包含真实密钥。

## 6. 日志与错误

禁止记录：

- `Authorization` 请求头。
- 上游厂商密钥和网关 master key。
- 完整模型请求体。
- 未脱敏的上游异常响应。

允许记录：

- `run_id`。
- `request_id`、`trace_id`、`model_call_id` 和 `release_id`。
- `tenant`。
- 稳定错误码。
- HTTP 状态码。
- 脱敏后的错误摘要。

## 7. 容器安全

- Agent 最终镜像以非 root `node` 用户运行。
- 使用多阶段构建，最终镜像不含编译工具链。
- 配置文件只读挂载。
- 不启用特权模式，不挂载 Docker socket。
- 镜像 tag/digest 固定，不使用单一 `latest`。

## 8. 脱敏检查

交付前检查：

| 检查项 | 通过条件 |
|---|---|
| Git 跟踪文件 | 无 `.env`、token、密码和真实密钥 |
| Agent 环境变量 | 不含 `DEEPSEEK_API_KEY` |
| Gateway 环境变量 | 不含 Grafana 密码 |
| Prometheus 配置 | 不含明文 Bearer token |
| 日志样本 | 不含 Authorization 和密钥 |
| README/check.md | 只记录变量名、结论和脱敏值 |

## 9. 已知限制

- 本作业是本地四容器方案，使用 master key 作为 Agent 和 Prometheus 共享凭据。
- 未实现多用户、细粒度租户授权、TLS 和审计留存策略。
- 当前 `tenant` 是调用方提供的指标标签，不构成身份认证或授权边界。
- 结构化事件只用于本地排障，若接入生产 Trace 系统，需要另行设计归档访问权限和保留周期。
- 这些限制在生产环境中必须替换为正式密钥管理、独立凭据和网络策略。

