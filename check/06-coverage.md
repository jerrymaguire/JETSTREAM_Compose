# 测试覆盖率报告

- 执行时间：2026-11-23
- 测试框架：Node.js `node:test` + `c8`
- 构建命令：`npm run build`
- 测试命令：`npm run test:coverage`

## 质量门禁

| 指标 | 阈值 | 实际 | 结论 |
|---|---:|---:|---|
| 行覆盖率 | ≥80% | 88.68% | ✅ 通过 |
| 分支覆盖率 | ≥70% | 72.07% | ✅ 通过 |
| 函数覆盖率 | 参考 | 94.02% | ✅ |

## 测试结果

| 项目 | 数量 |
|---|---:|
| 测试总数 | 26 |
| 通过 | 26 |
| 失败 | 0 |
| 跳过 | 0 |

## 覆盖率明细

| 文件 | 行覆盖率 | 分支覆盖率 |
|---|---:|---:|
| `config.ts` | 100% | 79.31% |
| `errors.ts` | 100% | 60% |
| `http.ts` | 83.96% | 70.45% |
| `logger.ts` | 100% | 100% |
| `metrics.ts` | 100% | 100% |
| `pi-runner.ts` | 80% | 36.36% |
| `run-service.ts` | 86.46% | 75% |
| `store.ts` | 94.21% | 76.31% |

## 覆盖场景

- 配置默认值和非法值。
- 同步、异步 HTTP Run。
- 最近 Run 列表和事件历史。
- Agent UI 静态资源和浏览器 E2E。
- SSE 终态事件。
- 并发限制和队列满。
- 排队超时。
- Runner 失败。
- Run 归档、事件和重启中断恢复。
- Prometheus 指标输出。
- PI SDK 通过本地 OpenAI-compatible Mock Gateway。

证据：`check/evidence/agent-test-coverage.txt`
