# Agent Monitor

一个完全在本机运行的 Agent token 与会话历史监控台。它从各客户端已经写入磁盘的记录中读取真实用量，不调用外部计费接口，也不会估算缺失的 token。

当前支持：

- Codex Desktop、Codex CLI、`codex exec` 和 Codex subagent
- PodeX CLI 与 `podex exec`
- Claude Code CLI / SDK CLI
- WorkBuddy 本地交互会话
- DeepSeek Harness 多帧 Zstandard 会话

## 启动

需要 Node.js 24 或更高版本。

```powershell
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。首次启动会回填历史记录，之后通过文件监听和 5 秒周期校验持续更新。

生产模式：

```powershell
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。

## 数据口径

| Agent | 历史位置 | 去重/累计规则 |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 按稳定的 `response_id` 记录真实增量；旧格式才使用会话累计值兜底 |
| PodeX | `~/.podex/profiles/*/sessions/**/rollout-*.jsonl` | 与 Codex 同格式；按元数据识别 CLI / exec，并按响应去重 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 按消息去重增量记录；结束态累计值只补齐非负差额 |
| WorkBuddy | `~/.workbuddy/projects/**/*.jsonl` | 按 `providerData.messageId` 去重；不使用上下文窗口占用量 |
| DeepSeek Harness | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 扫描每个独立 Zstd frame，只处理完整帧 |

统一展示的 `input` 是包含缓存命中的完整输入量，`total` 优先采用客户端报告值。缓存读取/写入和 reasoning 是 input/output 的子集，因此它们单独展示但不会再次加到 total。

## 隐私与安全

- HTTP 服务默认且强制建议只绑定 `127.0.0.1`。
- 采集器只读会话目录，不扫描 `auth`、credentials、配置密钥或 keyblob。
- 会话详情只提取 user/assistant 的纯文本；不渲染 HTML，不默认展示工具参数、工具输出、系统提示或推理内容。
- 索引保存在项目的 `.data/agent-monitor.sqlite`，可随时停止服务后删除并重新回填。

## 配置

环境变量见 [.env.example](./.env.example)。常用变量：

- `AGENT_MONITOR_HOST`：默认 `127.0.0.1`
- `AGENT_MONITOR_PORT`：默认 `4317`
- `AGENT_MONITOR_DB`：自定义 SQLite 路径
- `DSH_HOME`：覆盖 DeepSeek Harness 默认的 `~/.dsh`

## 校验

```powershell
npm test
npm run build
```

如果某个客户端尚未在本机生成历史目录，采集源会明确显示“未发现”，不会用模拟数据代替。
