# 开启 Agent 间通信（A2A）设计

> 2026-10-16 · 阶段 1–6 已定稿，等待用户确认方案后进入实现（阶段 7）。

## 1. 问题定义

**谁在什么场景下遇到什么问题？**

用户在 HiAi 里创建了多个 Agent（每个有独立的身份、系统提示词、技能、模型、工作目录）。当前一个 Agent 无法把任务交给另一个 Agent 协作，也无法直接询问另一个 Agent 的会话情况：

- 主 Agent 想让「翻译 Agent」润色一段文案，只能自己硬干，或让用户手动复制粘贴到另一个会话。
- 用户需要人工在多个 Agent 会话之间搬运上下文，打断工作流。

**现状怎么凑合的？**

- 用户手动开两个会话，自己复制中间结果。
- 部分场景用 subagent（`sessions_spawn`）委派——但那只覆盖「父会话派生一次性子任务」，子代理不能跨 Agent 委派，也不能与其它 Agent 的既有会话互通。

**痛点归纳**：Agent 之间是孤岛，协作必须由用户人肉中转。

## 2. 概念模型

### 2.1 术语表

| 术语 | 定义 |
| --- | --- |
| Agent | HiAi 的持久智能体配置（身份 + 提示词 + 技能 + 模型 + 工作目录），存于 `agents` 表 |
| 会话（session） | Agent 的一次对话实例，OpenClaw 侧以 sessionKey 标识 |
| A2A（Agent-to-Agent） | Agent 与 Agent 之间定向发送消息并获取回复的能力 |
| subagent 委派 | 既有能力：父会话通过 `sessions_spawn` 派生一次性子会话执行任务，经 announce 链回传结果 |
| `sessions_send` | OpenClaw 内置工具：向可见会话发消息、可等待回复、可 announce 回传 |
| 请求方 / 目标方 | A2A 消息的发送 Agent 与接收 Agent |

### 2.2 能力边界（A2A vs subagent 委派）

| 维度 | subagent 委派（已有） | A2A 通信（本特性） |
| --- | --- | --- |
| 发起方 | 任意 Agent 会话 | 任意 Agent 会话 |
| 接收方 | 本 Agent 允许列表内的 Agent，**一次性子会话** | 其它 Agent 的**主会话/既有会话** |
| 结果回传 | announce 链回父会话 | 直接回到请求方会话（或等待回复） |
| 持久性 | 子会话用完即弃 | 目标 Agent 收到消息后按正常会话处理，历史保留 |
| 门控 | `subagents.allowAgents`（已按 agent 粒度配置） | `tools.agentToAgent.enabled + allow`（全局开关 + 白名单） |

### 2.3 实体与状态

无新数据库实体。复用：

- `agents` 表（现有字段，不新增列——见 §6 的方案取舍）
- OpenClaw 侧会话状态机不变：A2A 消息进入目标 Agent 会话后走正常 run 生命周期（queued → running → done），请求方通过 `sessions_send` 的返回（runId / reply snapshot）感知结果。

## 3. 用户旅程

### 主流程：主 Agent 委托翻译 Agent

1. 用户在主 Agent 会话里说：「把这段话交给翻译 Agent 润色，然后把结果贴回来」。
2. 主 Agent 调用 `sessions_send`，目标为翻译 Agent 的主会话，携带内容。
3. OpenClaw 校验 A2A 门控（enabled + allow），通过后路由到翻译 Agent 会话，产生一个 run。
4. 翻译 Agent 处理并回复；主 Agent（`waitForAgentRun` / announce）收到回复。
5. 主 Agent 把润色结果整合进自己的回答，用户在原会话看到完整结果。

### 异常流程

| 分支 | 用户看到 |
| --- | --- |
| 目标 Agent 不存在 | 主 Agent 收到 `error: Agent "x" not found`，转述给用户 |
| A2A 未开启 / 白名单拒绝 | 主 Agent 收到 `forbidden`，应向用户解释需要开启或加白 |
| 目标 Agent 超时无回复 | 请求方收到等待超时结果，可放弃或重试 |
| 目标 Agent 正在运行中 | 消息排队（embedded run 队列语义），不丢消息 |

### 管理旅程：开启与授权

1. 用户打开「设置 → Agent 间通信」开关（全局）。
2. 可选：配置白名单（允许哪些 Agent 参与 A2A；缺省为全部已启用 Agent）。
3. 保存后 `openclawConfigSync` 重写 `openclaw.json` 并热生效。

## 4. 需求规格

### 4.1 功能清单

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-A1 | 主进程配置同步支持写入 `tools.agentToAgent`（enabled + allow），由 Cowork 配置项驱动 | P0 |
| FR-A2 | Cowork 设置 UI 新增「Agent 间通信」开关（全局，默认**关闭**） | P0 |
| FR-A3 | 可选白名单：从已启用 Agent 列表多选；空 = 全部允许 | P1 |
| FR-A4 | 开关/白名单变更后触发 `openclawConfigSync.sync()`，gateway 热重载生效 | P0 |
| FR-A5 | 主 Agent 工作区 `AGENTS.md` 管理段追加 A2A 使用指引（何时用 `sessions_send`、失败如何向用户解释） | P2 |
| FR-A6 | 会话内对 `sessions_send` 的 tool_use/tool_result 正常渲染（既有工具渲染通道，确认无需特判即可） | P1 |

### 4.2 验收标准

| 编号 | 标准 | 验证方式 |
| --- | --- | --- |
| AC-A1.1 | 开关关闭时，生成的 `openclaw.json` 不含 `tools.agentToAgent`（保持 OpenClaw 默认 false） | 单测：config sync 快照断言 |
| AC-A1.2 | 开关开启且白名单为空 → `tools.agentToAgent: { enabled: true }`（无 allow = 全部允许） | 同上 |
| AC-A1.3 | 开关开启且白名单非空 → `allow` 仅含选中的 agent id | 同上 |
| AC-A2.1 | 设置 UI 开关状态持久化（`cowork_config`），重启后保留 | 单测 + 手工 |
| AC-A4.1 | 保存后 `openclaw.json` 更新且 gateway 热重载（日志确认） | 手工 |
| AC-A5.1 | 端到端：主 Agent 会话中要求委托另一 Agent，消息送达并回传结果 | 手工（`npm run electron:dev`） |
| AC-A6.1 | 改动文件 CI 同款 eslint 零告警，`npm test` 无回归 | CI |

### 4.3 不做清单

- **不做**会话级/每 Agent 粒度的 A2A 策略（OpenClaw 的 a2a allow 是全局 `tools.agentToAgent`；per-agent 粒度需要上游支持，且与既有 `subagentAllowAgentIds` 语义重叠，先不引入两套心智模型）。
- **不做**A2A 消息的专属 UI（气泡样式、发送方徽标等）——消息进入目标会话后按普通用户消息渲染，OpenClaw 已带 provenance 标注。
- **不做**请求方等待超时/重试的 UI 化配置（OpenClaw 内置默认值先行）。
- **不改动**既有 subagent 委派行为（`subagentAllowAgentIds`、`sessions_spawn`）。

## 5. 交互设计

### 5.1 入口与状态

入口：设置 → Cowork/Collaboration 区域新增卡片「Agent 间通信」。

| 状态 | 展示 |
| --- | --- |
| 关闭（默认） | 开关 off；下方说明文案：「开启后，各 Agent 可以互相发送消息协同完成任务。」 |
| 开启、白名单空 | 开关 on + 文案「所有已启用的 Agent 均可互相通信」 |
| 开启、白名单非空 | 开关 on + 已选 Agent 多选列表（复用 `AgentSettingsPanel` 协作区的复选项视觉） |
| 保存失败 | toast 报错，开关回滚显示 |

### 5.2 边界与空态

- 只有 1 个启用 Agent 时：仍可开启（对自己 Agent 主会话发送语义），但白名单区显示「暂无其他已启用 Agent」。
- 已被删除的 Agent 残留在白名单中：config sync 写入时按当前启用 Agent 过滤（`normalizeSubagentAllowAgentIds` 同款去重/自引用剔除逻辑）。

## 6. 架构设计

### 6.1 数据流

```
渲染层 CoworkSettings（新开关）
  → IPC: cowork:setConfig（既有通道，新增字段）
  → cowork_config 表（新键 a2aEnabled / a2aAllowAgentIds）
  → OpenClawConfigSync.sync()
      → buildWebToolsConfig() 追加 agentToAgent 块
  → openclaw.json 热重载 → OpenClaw sessions_send 门控生效
```

### 6.2 模块改动点

| 文件 | 改动 |
| --- | --- |
| `src/main/libs/openclawConfigSync.ts` | `buildWebToolsConfig()` 增加 `agentToAgent: { enabled, allow? }`；读取 cowork 配置新键；写 allow 前过滤已删/禁用/自身 agent |
| `src/main/coworkStore.ts` | `cowork_config` 读写支持新键（沿用既有 JSON kv 模式） |
| 渲染层设置组件 | 新开关 + 白名单多选（复用现有设置面板模式） |
| `src/renderer/services/i18n.ts` | 中英文案 |
| `src/main/libs/openclawConfigSync.test.ts`（如有）或新增 | AC-A1.x 快照用例 |
| 主工作区 `AGENTS.md` 管理段（`openclawConfigSync` 的 managed section） | A2A 指引（FR-A5） |

### 6.3 关键取舍（与用户确认项）

1. **开关默认关闭**：A2A 让 Agent 互发消息产生 token 消耗且可能形成意外联动，安全侧默认关。
2. **白名单放全局而非每 Agent**：OpenClaw 的 `tools.agentToAgent.allow` 本就是全局匹配（requester 与 target 都须命中）；per-agent 拆分是伪需求。既有「允许调用的 Agent」（`subagentAllowAgentIds`）管的是 spawn 委派，二者并存但语义清晰：**spawn 委派按 Agent 配置，跨 Agent 直接通信走全局开关**。
3. **复用 `sessions_send` 而非新工具**：OpenClaw 已内置完整实现（定向发送、等待回复、announce 回传、provenance 标注），HiAi 只做门控配置，零 patch。
4. **UI 放 Cowork 全局设置而非 Agent 设置面板**：与取舍 2 一致——它是全局能力开关。

### 6.4 依赖与风险

| 风险 | 缓解 |
| --- | --- |
| A2A 消息在目标会话的渲染样式未知（provenance 标注形态） | 实现阶段先手工验证 AC-A5.1，必要时补渲染适配 |
| OpenClaw pinned 版本升级后 a2a 语义变化 | 用例断言生成的 config 形状，CI 捕获漂移 |
| 恶意/失控 Agent 互相触发形成循环 | OpenClaw 侧有 loopDetection（已开启 `MANAGED_TOOL_LOOP_DETECTION`）；spec 中记录该边界 |

## 7. Mock 台账

本特性不引入 mock。所有配置读取真实 `cowork_config`，端到端验证走真实 OpenClaw gateway。

## 8. 实现顺序（阶段 7 计划）

1. `cowork_config` 新键 + config sync 写入 + 单测（AC-A1.x）
2. 渲染层开关与白名单 UI + i18n
3. `AGENTS.md` 管理段指引
4. 手工端到端（AC-A4.1 / AC-A5.1）
