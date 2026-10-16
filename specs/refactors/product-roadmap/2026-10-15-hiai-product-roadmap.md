# HiAi 产品改造路线图（任务台账）

> 本文是**跨领域任务台账**，用于集中跟踪品牌迁移（rebrand-hiai）之后的一批产品/能力改造项。
> 单项任务的实现细节以各自独立设计文档为准（见 §3 跳转索引）；本文只维护**状态、目标、验收要点与依赖**。
> 维护约定：每项任务落地后就地更新本文状态列，并在下方「变更记录」追加一行。

## 1. 概述

### 1.1 背景

LobsterAI 已迁移为 HiAi 品牌，并完成「去服务端依赖」「去会员」两条主线。
在此基础上，用户提出一批后续改造诉求：进一步剥离云端能力、对标 CodeBuddy 引入规则与 Hook 机制、增强提示词与技能市场体验、修正版本更新与遥测等遗留问题。

这些诉求彼此独立、跨度较大，适合以**台账**形式集中跟踪，避免散落丢失。

### 1.2 状态图例

| 标记 | 含义 |
| --- | --- |
| ⏳ 待执行 | 尚未开工，需要独立设计文档 + 实施 |
| 🔜 暂缓 | 已识别，本期不排期 |
| ✅ 已完成 | 已落地并合入主干 |
| 🔍 已定位 | 根因已明确，处置待定 |

## 2. 任务清单

| # | 任务 | 状态 | 一句话目标 |
| --- | --- | --- | --- |
| 2 | 彻底移除云端模块 | ⏳ 待执行 | 已审计：仍有多条会真实发请求的云端链路，无法断网运行 |
| 3 | 建立规则系统（对标 CodeBuddy） | 🔜 暂缓 | 支持项目级/用户级规则文档，注入 agent 提示词 |
| 4 | 建立 Hook 系统（对标 CodeBuddy） | 🔜 暂缓 | 在关键生命周期点支持用户自定义钩子 |
| 5 | 增加提示词润色功能 | ⏳ 待执行 | 输入框支持一键润色当前提示词 |
| 6 | 思考过程展示问题 | ✅ 已完成 | 用户自配 provider 缺 thinking 声明导致网关无事件；已桥接修复 |
| 7 | Skill 市场切换功能 | ✅ 已完成 | 诉求改由多源统一聚合落地（见任务 13） |
| 8 | 移除模型凭据冷却期 | ✅ 已完成 | 全局禁用模型凭据冷却期 |
| 9 | 版本更新改 GitHub Releases | ✅ 已完成 | 更新检查已改走 GitHub Releases API |
| 10 | 彻底移除遥测功能 | ✅ 已完成 | 删除使用日志上报链路 |
| 11 | 删除设置中的「帮助改进 HiAi」 | ✅ 已完成 | 移除使用统计开关（随任务 10 一并删除） |
| 12 | 开启 Agent 间通信（A2A） | ⏳ 待执行 | 开启 OpenClaw 的 `sessions_send` 跨 Agent 通信门控 |
| 13 | Skill 市场多源聚合 | ✅ 已完成 | 统一聚合 Youdao + SkillHub，支持跨源搜索与安装 |
| — | Web Search 方案调研 | 🔜 暂缓 | 调研联网搜索方案，本期不落地 |

## 3. 各项说明

### 任务 2 · 彻底移除云端模块 ⏳

**现状（2026-10-16 审计结论）**：`de-server-dependency` 与 `remove-membership` 已断开登录、媒体生成、ASR、企业账号、分享/部署入口，但**仍有 4 条会真实发起请求的云端链路**，且入口对用户可见。断网环境下应用能启动，但点开对应界面即失败。

**残留清单（按必须处理排序）**：

| # | 残留 | 位置 | 触发时机 |
| --- | --- | --- | --- |
| R1 | Skill Store | `src/main/libs/skillMarketplace/youdaoAdapter.ts:91` → `getSkillStoreUrl()`（`endpoints.ts:79`） | 技能市场每次搜索/浏览都会请求（youdao 是聚合市场的一等源，非死代码） |
| R2 | Kit Store | `kits:fetchStore`（`src/main/ipcHandlers/kits/handlers.ts:234`）→ `getKitStoreUrl()` | 输入框工具栏 Kit 按钮每次打开 Popover |
| R3 | MCP Marketplace | `src/main/ipcHandlers/mcp/handlers.ts:409-410`（硬编码 `api-overmind.youdao.com`） | `McpManager` 组件挂载即请求（设置→技能与连接器） |
| R4 | Server API 基址 | `getServerApiBaseUrl()`（`endpoints.ts:31`） | 剩余调用点以"依赖登录态"的路径为主：HTML 分享 handler 全套（`main.ts` 约 18 处）、灰度更新 `appUpdateGrayClient.ts:111`、云端素材库 `libraryCloudClient.ts:317`、模型列表 `main.ts:4885`、LLM 代理回退 `claudeSettings.ts:508`。**注**：登录已移除，多数因无 token 而实际不发请求，但代码路径仍在 |

**同时清理的死代码**：`llmTurnUsage.ts` 的 `LLM_TRACE_USAGE_API_PATH`、renderer 侧 `TurnUsageChip → cowork.ts` 的 IPC 残链（对应 handler 已不存在，调用必失败）。

**仅文案类（不发请求，最后清理即可）**：i18n 里的 portal 定价链接、`shared/platform/constants.ts` 的 IM 指南 URL、`decisionModelClient.ts:16` 的 OpenRouter Referer 头、`shared/providers/constants.ts:360` 的有道智云 LLM provider（用户配置该 provider 才发请求，属正常业务能力，保留与否需单独决策）。

**待确认项**：R1/R2/R3 三个商店的去向——自建静态托管、改由 GitHub Releases/仓库文件托管，还是随 `ENABLE_*` flag 直接下线入口？`getServerApiBaseUrl()` 余下调用点是"仅删除代码"还是需要替代实现（尤其是 HTML 分享 handler，服务层已断入口但代码未删）？

**验收要点**：全局搜索非测试代码无 `lobsterai-server.youdao.com` / `api-overmind.youdao.com` 的 API 调用引用；断网 + 抓包确认零云端请求；技能市场 / Kit / MCP 市场入口在无网络时行为明确（隐藏或本地兜底）。

**相关文档**：`specs/refactors/de-server-dependency/2026-10-13-de-server-dependency-design.md`（§2.1 表中"本期不动"项即本任务的 R1–R4，U-6 未决项）。

### 任务 3 · 建立规则系统（对标 CodeBuddy）🔜 暂缓

**现状**：仓库当前**无**任何规则系统实现（无 `rules/` 相关模块）。

**状态**：按用户决定暂缓，本期不排期。

**目标（暂缓前已定）**：对标 CodeBuddy 的规则能力，支持以文档形式定义项目级 / 用户级规则，并在 agent 运行时注入提示词，约束其行为。

**恢复时待确认项**：规则文件的位置与命名约定、加载优先级、注入方式（系统提示词 / 上下文）、与现有 AGENTS.md 体系的整合。

**验收要点**：新增规则文件后，agent 行为随之改变；规则冲突时有明确优先级。

### 任务 4 · 建立 Hook 系统（对标 CodeBuddy）🔜 暂缓

**现状**：仓库当前**无** hook 机制。

**状态**：按用户决定暂缓，本期不排期。与任务 3 同属"agent 可扩展机制"，恢复时建议一并设计。

**目标（暂缓前已定）**：在关键生命周期点（如提交前、工具调用前后、会话事件）支持用户自定义钩子脚本。

**恢复时待确认项**：支持的事件点清单、钩子执行环境与安全边界、失败处理策略（阻塞 vs 放行）。

**验收要点**：注册钩子后能在对应事件触发；钩子失败不影响主流程或有明确阻断语义。

### 任务 5 · 增加提示词润色功能 ⏳

**现状**：输入组件为 `src/renderer/components/cowork/CoworkPromptInput.tsx`，无润色入口。

**目标**：在输入框提供「润色」入口，调用 LLM 优化当前提示词后回填。

**待确认项**：触发方式（按钮/快捷键）、使用的模型与 provider、失败与取消处理、是否保留原文可回退。

**验收要点**：点击润色后输入框内容被改写，可撤回；无可用模型时给出提示。

### 任务 6 · 思考过程展示问题 ✅ 已完成

**根因**：**非前端 bug**。用户自配 provider 只有布尔 `supportsThinking`，没有服务端下发的
`thinkingConfig`；配置同步时该路径未做桥接，生成的 `openclaw.json` 只有 `reasoning: true`，
缺少 `compat.supportsReasoningEffort` 与非空 `compat.supportedReasoningEfforts`，网关因此不
产生 `agent stream=thinking` 事件，前端无内容可渲染。

**修复**：`buildCustomModelThinkingConfig`（`src/shared/providers/modelThinking.ts`）在勾选
思考时按通用档位（`off`/`low`/`medium`/`high`，默认 `medium`）合成 thinkingConfig，
`openclawConfigSync.ts` 的用户 provider 分支将其传入 `buildProviderSelection` 与
`collectThinkingProfile`，写出 `thinkingLevelMap` 与 `supportedReasoningEfforts`。

**验证**：`modelThinking.test.ts` 新增用例覆盖合成、关闭、可解析性；`openclawConfigSync`
相关 158 项测试通过；触及文件 ESLint 零警告。

**现有文档**：展示层设计见 `specs/features/cowork-thinking-block-display/`（含 §1.1.1 上游前置条件）。

**后续**：无。若仍看不到思考，先检查生成的 `openclaw.json` 中目标模型是否带
`thinkingLevelMap` / `supportedReasoningEfforts`。

### 任务 7 · Skill 市场切换功能 ✅ 已完成

**现状**：技能相关实现见 `src/renderer/components/skills/`（`SkillsManager.tsx` / `skillTabs.ts`）与 `src/main/ipcHandlers/skills/`。

**目标**：技能市场支持来源切换（如不同市场源之间切换）。

**结论**：原「用户手动切换市场源」的诉求，改为**多源统一聚合**方案落地——同一次搜索/浏览同时命中 Youdao 与 SkillHub，按来源标注，安装时记录来源，不再需要手动切换。ClawHub / skills.sh 源在设计中评估后砍掉，仅保留 Youdao + SkillHub 两个源。

**落地实现**：
- 统一聚合入口（单源 IPC 通道已下线）、跨源搜索、TTL 缓存失效、虚拟列表滚动。
- 安装来源记录（FR-7）：记录技能来自哪个源，供后续升级判断。

**验证**：`src/main/libs/skillMarketplace/` 下 adapter 与 http 层用例（含 `http.test.ts` 11 例）通过；`npm test` 无回归；触及文件 ESLint 零警告。

**现有文档**：`specs/features/skill-marketplace-sources/2026-10-16-skill-marketplace-multi-source-design.md`（§10 统一聚合重构、§11 收尾）。

**残留**：无重试/退避/限流（U-5，需先确认上游限流策略）；handler 层用例与 SkillHub 缺 `homepage` 的 URL 拼接断言（U-7 剩余部分）；若干 AC 需 `npm run electron:dev` 手工端到端实测。

### 任务 8 · 移除模型凭据冷却期 ✅ 已完成

**落地提交**：`0709eb7 fix(openclaw): 全局禁用模型凭据冷却期`。

**说明**：模型凭据的冷却期机制已全局禁用，不再阻断开关键换后的重试。

### 任务 9 · 版本更新改 GitHub Releases ✅ 已完成

**现状（2026-10-16 核实）**：`src/main/libs/endpoints.ts` 的更新检查端点已改为 GitHub Releases：

- `GITHUB_RELEASES_OWNER = 'hxhy00'` / `GITHUB_RELEASES_REPO = 'HiAi'`（`endpoints.ts:58-59`）
- `getUpdateCheckUrl()` 指向 `https://api.github.com/repos/.../releases/latest`（取最新非草稿、非预发布 release）
- `getManualUpdateCheckUrl()` 与自动检查共用同一端点
- `getFallbackDownloadUrl()` 指向 releases 页面，供跳转下载

**结论**：有道更新服务（`api-overmind.youdao.com` 的 update 端点）已不再被更新检查使用，"脱离有道更新服务"目标达成。

**验收要点**：发布新 GitHub Release 后应用能检测到并提示更新；断网时不阻塞启动。

**残留归属**：本任务余下的仅是 `getServerApiBaseUrl()` 上的**灰度更新检查**（`appUpdateGrayClient.ts:111`），归任务 2 R4 处理。

### 任务 10 · 彻底移除遥测功能 ✅ 已完成

**落地提交**：`74734f2 refactor(telemetry): remove usage analytics and telemetry reporting`（合入 `c9a12cd`）。

**说明**：使用日志上报链路已整体删除（含 `logReporter`、`installationId`、`analyticsIdentity`）。原设计文档 `specs/features/usage-analytics/2026-06-22-usage-analytics-design.md` 已加废弃标注，仅作历史记录保留。

### 任务 11 · 删除设置中的「帮助改进 HiAi」✅ 已完成

**结论**：该开关（i18n key `usageAnalyticsEnabled`，中文文案「帮助改进 HiAi」，位于设置
「数据与隐私」组）**已随任务 10 一并删除**，无需另行开发。

**证据**：`74734f2` 提交说明明确列出「删除『帮助改进 HiAi』设置开关、配置字段与 i18n 文案」；
`git show 74734f2 -- src/renderer/services/i18n.ts` 可见被删行
`-    usageAnalyticsEnabled: '帮助改进 HiAi',`。

**现状核实**：`src/renderer/components/Settings.tsx` 的「数据与隐私」组（`settingsGroupDataPrivacy`）
现仅含「临时文件占用」与「SQLite 自动备份」两项；全仓已无 `帮助改进 HiAi` / `usageAnalyticsEnabled` 残留。

### 任务 12 · 开启 Agent 间通信（A2A）⏳

**现状**：OpenClaw 已内置完整的 A2A 能力（`sessions_send` 工具 + `tools.agentToAgent` 门控），但 HiAi **从未开启**——`openclawConfigSync.ts` 不写这个配置块，上游默认 `enabled: false`，所有 Agent 被拒绝跨 Agent 发消息。

**目标**：让 HiAi 各 Agent 能互相发送消息协同完成任务，而不是只能人肉在两个会话间复制粘贴。设计阶段 1–6 已完成。

**方案要点**（详见设计文档 §6.3）：
- **纯配置集成，零 OpenClaw patch**：复用上游 `sessions_send`（定向发送、等待回复、announce 回传、provenance 标注均已内置）。
- **全局开关，默认关闭**：设置里新增「Agent 间通信」开关；开启后才写 `tools.agentToAgent.enabled = true`。
- **白名单放全局**：`tools.agentToAgent.allow` 上游本就是全局匹配（requester 与 target 都须命中），不做每 Agent 粒度；与既有「允许调用的 Agent」（`subagentAllowAgentIds`，管 spawn 委派）语义清晰区分：**spawn 委派按 Agent 配置，跨 Agent 直接通信走全局开关**。

**改动面**：`openclawConfigSync.ts`（写 `agentToAgent` 块）、`coworkStore.ts`（两个配置键）、设置 UI 开关 + 白名单多选、i18n、`AGENTS.md` 管理段 A2A 使用指引。

**验收要点**：开关关闭时生成配置不含 `agentToAgent`；开启后端到端委托另一 Agent 并回传结果（AC-A5.1）；保存后 gateway 热重载生效。

**现有文档**：`specs/features/agent-a2a/2026-10-16-agent-to-agent-communication-design.md`（阶段 1–6 已定稿，待确认后进入实现）。

### 任务 13 · Skill 市场多源聚合 ✅ 已完成

**结论**：即任务 7 的落地形态，已独立成文并完成实现（详见任务 7 说明与设计文档）。

### Web Search 方案调研 🔜 暂缓

**说明**：联网搜索（Web Search）方案调研已识别，但本期不排期，暂缓。

**后续**：需要时另行立项调研，涉及搜索 provider 选型、结果注入方式、成本与配额。

## 4. 依赖与排序建议

- **任务 9（改 GitHub Releases）已先行完成**，任务 2 的直接依赖已解除；仅剩灰度更新检查一条链路仍需随任务 2 R4 处理。
- **任务 2（移除云端）内部有顺序**：R1/R2/R3（三个商店）需先定"替代托管方案"再动手；R4（server baseUrl 余下调用点）以删代码为主，可并行；死代码与纯文案清理放在最后。
- **任务 3 / 4（规则 / Hook）已暂缓**，恢复时同属"agent 可扩展机制"，可共享一套配置与加载框架，建议**一起设计**。
- **任务 5（润色）** 与 **任务 12（A2A）** 相互独立，可并行推进。
- **任务 6 / 7（含 13）/ 8 / 9 / 10 / 11** 已完成，无需再排期。

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-15 | 建档；归档 10 项任务状态。其中任务 8（凭据冷却期）、任务 10（遥测）已完成；任务 6（思考展示）已定位根因为上游未下发数据；Web Search 暂缓。 |
| 2026-10-15 | 任务 6 修复完成：用户自配 provider 桥接 thinkingConfig（`buildCustomModelThinkingConfig`）。任务 3（规则系统）、任务 4（Hook 系统）按用户决定暂缓。 |
| 2026-10-15 | 登记任务 11（删除「帮助改进 HiAi」开关），核实其已随任务 10 的 `74734f2` 一并删除，标记为已完成。 |
| 2026-10-16 | 登记任务 12（开启 Agent 间通信 A2A），设计阶段 1–6 已完成，待确认方案后进入实现。 |
| 2026-10-16 | 更新任务 7（Skill 市场）为已完成：诉求改由多源统一聚合落地（Youdao + SkillHub），并同步登记任务 13 作为其落地条目。 |
| 2026-10-16 | 任务 3 / 4 按用户决定改为暂缓。 |
| 2026-10-16 | 完成任务 2 云端残留审计（R1–R4 清单），结论：**未完成**——Skill/Kit/MCP 三个商店与 server baseUrl 余下调用点仍会真实发请求，入口对用户可见。任务 2 说明区由"待独立成文"改为审计结论。 |
| 2026-10-16 | 核实任务 9 已落地（`endpoints.ts` 更新检查已走 GitHub Releases，`hxhy00/HiAi`）并标记为已完成；余下灰度更新检查归入任务 2 R4。 |
