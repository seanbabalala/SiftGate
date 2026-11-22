# 30 分钟 PoC 演示剧本

[English](poc-playbook.md) · [企业 AI 治理方案](enterprise-overview.zh-cn.md) · [安全与合规简报](security-compliance-brief.zh-cn.md)

用这份剧本向平台、安全和财务听众演示 SiftGate 能治理什么。全程分四幕，每一幕结束时都有可以当场核对的通过标准。

## 演示前准备

- 一个运行中的网关：[客户安装包](customer-install.zh-cn.md)或源码 [Quickstart](QUICKSTART.md)，PoC 用 SQLite 即可。
- 控制台管理员账号，地址 `http://localhost:2099/dashboard`。
- 一个演示用的真实供应商 Key，设置为环境变量，例如 `ANTHROPIC_POOL_KEY_BACKUP`。请使用低额度账号。
- 可选：演示者电脑上的 Claude Code 或 Codex。

屏幕上只展示占位符，不要把真实 Key 粘贴到幻灯片或聊天中。

演示前把下面的节点加入私有的 `gateway.config.yaml`。其中 `primary` 凭证故意无效，用于第三幕演示凭证故障切换；把 `401` 放进 `retry_on_status` 只适用于本次演示。

```yaml
nodes:
  - id: poc-anthropic
    name: "PoC Anthropic"
    protocol: messages
    base_url: "https://api.anthropic.com"
    endpoint: "/v1/messages"
    auth_type: x-api-key
    models: ["YOUR_MODEL", "YOUR_SECOND_MODEL"]
    credentials:
      - id: primary
        api_key: "${env:POC_INVALID_KEY}"
      - id: backup
        api_key: "${env:ANTHROPIC_POOL_KEY_BACKUP}"
    credential_pool:
      enabled: true
      strategy: cache_aware
      sticky_by: agent_session
      cooldown_ms: 60000
      retry_on_status: [401, 429, 500, 502, 503, 504]
```

把 `POC_INVALID_KEY` 设为任意无效的占位值，源码安装可先用 `npm run validate:config` 校验配置，然后启动网关。

## 第一幕（5 分钟）：工程师手里没有供应商 Key

1. 在 **Gateway Keys** 中创建名为 `pilot-team` 的 Key，允许直接路由，允许的模型只填 `YOUR_MODEL`。展示完整 Key 只显示一次，列表里只剩掩码前缀。
2. 在 **Agent Profiles** 中为该 Key 生成 Claude Code 配置。生成的配置里是 `<SIFTGATE_GATEWAY_API_KEY>` 占位符，而不是供应商 Key。
3. 让 Agent 或命令行指向 SiftGate：

   ```bash
   export SIFTGATE_API_KEY="<pilot-team 的 Key>"
   curl -sS -D - http://localhost:2099/v1/messages \
     -H "content-type: application/json" \
     -H "x-api-key: ${SIFTGATE_API_KEY}" \
     -H "anthropic-version: 2023-06-01" \
     -d '{"model":"poc-anthropic/YOUR_MODEL","max_tokens":64,
          "messages":[{"role":"user","content":"Reply with OK. marker-POC-7F3A"}]}'
   ```

4. 记下响应头中的 `x-siftgate-request-id`，第三幕会用到。

**通过标准：** 请求经网关成功返回，并在 **Request Logs** 中归属 `pilot-team`；客户端机器上不存在任何供应商 Key。

## 第二幕（5 分钟）：策略与预算真实生效

1. 把模型改为 `"model": "poc-anthropic/YOUR_SECOND_MODEL"` 再发一次。该模型已在节点上配置，但不在这个 Key 的允许列表里，网关在调用任何供应商之前返回 HTTP 403。
2. 在 **Budget Rules** 中打开 `pilot-team` 这个 API Key 作用域，把每日 Token 上限设得很低，例如 `100`。
3. 重复第一幕的请求直到超限。网关返回 HTTP 429，`error.type` 为 `budget_exceeded`，`code` 为 `daily_tokens`。
4. 演示结束后重置或删除这条限制。

**通过标准：** 调用方对未批准模型收到明确的 403，对预算耗尽收到 429 `budget_exceeded`；**Budget Rules** 页面显示该 Key 的用量与上限；两次被拒的请求都没有到达供应商。

## 第三幕（10 分钟）：可解释的故障切换

1. 第一幕的请求已经走过凭证池：无效的 `primary` 凭证返回 401，请求被重试到 `backup`。
2. 在 **Request Logs** 中打开该请求，展示凭证 ID、策略和重试次数。任何位置都不显示密钥值。
3. 用第一幕记下的 ID 打开 `/route-decisions/<request-id>`，逐项讲解被选中的候选、被淘汰或过滤的候选、策略过滤、fallback 原因、延迟和费用估算。
4. Coding Agent 场景可选：从同一个 Agent 会话连续发送几次请求，展示 `cache_aware` 让它们留在同一条凭证上，并在日志中看到缓存读取 Token。

**通过标准：** 听众仅凭控制台就能回答“这个请求用的是哪条 Key，为什么”。

## 第四幕（10 分钟）：有证据，无内容

1. 在 **Request Logs** 中导出最近一天的 CSV 或 JSON，在导出文件里搜索第一幕发送的标记：

   ```bash
   grep -c "marker-POC-7F3A" logs-1d.csv
   ```

   结果为 `0`：Prompt 从未被存储。
2. 如果是 SQLite PoC，再对 `database.path` 指向的数据库文件（默认 `./data/gateway.db`）做同样的搜索，标记同样不存在。
3. 打开 **Audit Log**，展示第一、二幕中创建 Key 和修改预算的记录，均为脱敏摘要。
4. 打开 **Config Audit**，展示版本化配置和先校验再回滚。
5. 打开 **Cost Review**，按 API Key 或团队导出成本分摊 CSV。

**通过标准：** 安全团队确认导出和存储中都没有内容；财务看到成本归属到 `pilot-team`。

## 评分表

| 听众的问题 | 对应演示 |
| --- | --- |
| 工程师能否在不持有供应商 Key 的情况下工作？ | 第一幕 |
| 能否按团队限制模型并封顶支出？ | 第二幕 |
| Key 或供应商故障时会怎样？能否举证？ | 第三幕 |
| 网关会存储我们的 Prompt 或代码吗？ | 第四幕 |
| 财务能否把成本归因到团队？ | 第四幕 |
| 管理变更有没有审计？ | 第四幕 |

## 演示之后

- 删除 PoC 节点和故意无效的凭证，或在用于生产前把 `401` 从 `retry_on_status` 中移除。
- 如果 `pilot-team` 是为演示创建的，请吊销它。
- 发送[安全与合规简报](security-compliance-brief.zh-cn.md)和[企业 AI 治理方案](enterprise-overview.zh-cn.md)中的落地计划。
