# 去服务端依赖改造设计文档

## 1. 概述

### 1.1 问题/动机

LobsterAI 当前是一个"本地 agent 内核 + 商业服务端外壳"的结构：

- **内核**：OpenClaw agent runtime，本地进程，自带 provider 抽象、媒体生成工具、本地工具链，**本身不依赖 LobsterAI 服务端**。
- **外壳**：登录鉴权、订阅/积分、媒体生成列表与计费、ASR 实时流、企业账号、HTML 分享、站点部署 —— 经 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts:31`）打到 `lobsterai-server.youdao.com`；更新检查与 Skill/Kit Store 另有独立端点。

产品定位变更：**本软件将转为纯个人离线使用，不再依赖 LobsterAI 服务端。**

这意味着外壳中所有依赖服务端的能力必须**移除或就地替换为本地实现**，而不是"关闭入口"——因为服务端一旦不可达，这些路径会直接失败。

### 1.2 目标

| 目标 | 说明 |
| --- | --- |
| G1 | agent（含 LLM 推理）在**无 LobsterAI 服务端、无登录**的情况下正常运行 |
| G2 | 图片/视频生成改用**用户自配的第三方 API provider**，去掉服务端模型列表与积分估算 |
| G3 | 语音输入改用 **SenseVoice 本地推理**，去掉服务端实时 ASR 与其配额 |
| G4 | 关闭 HTML 分享与站点部署 |
| G5 | 移除企业账号、订阅、积分、banner、活动等商业壳 |

### 1.3 不做（Non-Goals）

- 不改动 OpenClaw 引擎本身的 agent 能力与工具协议。
- 不保留任何"服务端可用时增强、不可用时降级"的双轨逻辑 —— 本次是**单向移除**。
- SenseVoice 采用 **sherpa-onnx 预编译二进制**方案（已定，见 FR-3），不引入 Python 运行时依赖。
- 不处理 Skill Store / Kit Store / MCP Marketplace 的替代方案（本期外，见 U-6）。更新检查已另行改走 GitHub Releases（2026-10-16）。

### 1.4 关键前提（已验证）

| 前提 | 证据 |
| --- | --- |
| OpenClaw 原生支持图片/视频/音乐生成工具 | `vendor/openclaw-runtime/mac-arm64/docs/gateway/config-tools.md:26,46`（`image_generate` / `video_generate` / `music_generate`，`group: media`） |
| OpenClaw 原生支持第三方媒体 provider | `docs/providers/fal.md`、`runway.md`、`pixverse.md`、`minimax.md`、`google.md` |
| 图片与视频是**两个独立配置项** | `agents.defaults.mediaModels.image.primary` / `.video.primary`（`docs/providers/fal.md:38-45,171-181`） |
| OpenClaw 支持 OpenAI 兼容的 ASR provider，且有 `senseaudio` 先例 | `docs/providers/senseaudio.md`（`tools.media.models[]`，`baseUrl` 可覆盖） |
| 仓库已有 Python 运行时打包先例 | `scripts/setup-python-runtime.js:22-27`（嵌入 Python 3.11.9 → `resources/python-win`）。**注意：仅覆盖 Windows**，mac 侧无先例 —— 本期改用 sherpa-onnx 后此先例仅供"运行时自修复"模式参考 |
| 已有"运行时自修复"先例 | `scripts/setup-python-runtime.js:48-51` + `src/main/libs/pythonPipShim.ts`（启动时自修复用户运行时），可参考用于 SenseVoice 侧车缺失时的恢复 |
| 去掉登录后本地能力不受影响 | `openclawEngineManager.ts:873-904`（启动无 token 检查）、`mcpRuntime.ts:160-175`（本地 bridge） |

---

## 2. 现状分析

### 2.1 服务端调用清单（按功能分组）

| 功能组 | 接口 | 位置 | 去服务端化处置 |
| --- | --- | --- | --- |
| 登录/鉴权 | `/api/auth/exchange`、`/refresh`、`/logout` | `src/main/main.ts:7606,5846,8065` | 移除 |
| 媒体模型 | `GET /api/media/{images\|videos}/models` | `src/main/main.ts` | **已完成**：工具 `action=list` 与 IPC `GetMediaModels` 均读本地 provider |
| 媒体生成 | `POST /api/media/{images\|videos}/generate` | `src/main/main.ts` | **已完成**（图片走 OpenAI 兼容生图协议；视频走 MiniMax 三步异步协议） |
| 媒体轮询 | `GET /api/media/{images\|videos}/tasks/{id}` | `src/main/main.ts` | **已完成**：`action=status`、`media:getTaskStatus`、后台 `pollPendingMediaTasks` 均走适配层 + `taskRegistry` 反查 |
| 媒体取消 | `POST /api/media/videos/tasks/{id}/cancel` | `src/main/main.ts` | **已完成**：工具 `action=cancel` 与 IPC `CancelMediaTask` 均调适配层 `cancel()` |
| ASR 实时 | `POST /api/asr/realtime/sessions` | `src/main/ipcHandlers/asr/handlers.ts:66` | **替换为 SenseVoice** |
| 订阅/配额 | `/api/user/quota`、`/profile`、`/models/pricing-catalog` 等 | `src/main/main.ts:7786,7860,7896,8104` | 移除 |
| 企业账号 | `/api/enterprise/context`、`/identities`、`/quota-requests` | `src/main/enterpriseAccount/context.ts:280,369,442` | 移除 |
| 模型列表 | `GET /api/models/available` | `src/main/main.ts:5942` | 替换为本地 provider 静态清单 |
| 更新检查 | `getUpdateCheckUrl()` | `src/main/libs/endpoints.ts:65-67` | **已完成（2026-10-16 核实）**：已改走 GitHub Releases（`hxhy00/HiAi`），不再使用有道更新服务。注：灰度更新检查 `appUpdateGrayClient.ts:111` 仍打 server baseUrl，见下表 |
| Skill/Kit Store | `getSkillStoreUrl()` / `getKitStoreUrl()` | `src/main/libs/endpoints.ts:79-89` | **未处理**：两条链路均被 UI 真实调用（技能市场 / 输入框 Kit 按钮），归 `product-roadmap` 任务 2 R1/R2 |
| MCP Marketplace | `api-overmind.youdao.com/.../mcp-marketplace` | `src/main/ipcHandlers/mcp/handlers.ts:409-410`（硬编码） | **未处理**：`McpManager` 挂载即请求，归任务 2 R3 |
| HTML 分享 | `/api/html-shares/{id}`、`htmlShareClient.ts` | `src/main/main.ts` 约 18 处 handler（`:6181`–`:6595`） | 入口已 gate（FR-4.2），**服务层代码与 handler 仍保留**，归任务 2 R4 |
| 站点部署 | `shareDeploymentClient.ts`、`siteClient.ts` | — | **已完成**：服务层与 IPC 已整块删除（FR-4.3/FR-4.4） |
| 灰度更新检查 | `POST /api/client-updates/check` | `src/main/libs/appUpdateGrayClient.ts:111-124`，注入点 `src/main/main.ts:1848-1850` | **未处理**：session getter 恒为 null 故当前不发请求，代码路径仍在，归任务 2 R4 |
| 云端素材库 | `GET /api/library/cloud-items` | `src/main/library/libraryCloudClient.ts:317-318` | **未处理**：入口已随 `LibrarySourceFilter.Cloud` 隐藏（FR-4.2），客户端代码保留，归任务 2 R4 |
| 客户端 banner/活动 | `activityClient.ts:84,99,117` | `src/main/main.ts:7956-8027` | 移除 |

### 2.2 LLM 推理路径（P0 阻塞点）

> **状态更新（2026-10-16）：P0 已关闭。** 登录能力已随 `remove-membership` 改造整体移除，`src/main/libs/openclawTokenProxy.ts` 已删除，`startOpenClawTokenProxy` 注入点不再存在。agent 现已直连 provider，本节描述的阻塞已不存在。

**原状（历史）**：agent 的 LLM 请求曾经 `openclawTokenProxy` 代理到 LobsterAI 服务端换取 token；在去掉登录后会直接崩溃（登录没了 → 无 token → agent 无法推理）。

**已达成目标**：OpenClaw 直连 provider（Ollama / LM Studio / 自备 API key 的 OpenAI 兼容端点）。

### 2.3 媒体生成链路（三段式）

```
MediaModelPicker 选择模型
  → 每轮注入 agent 指令 mediaGenerationTurnInstruction.ts:71-111
    → OpenClaw 插件 lobster-media-generation 注册工具
       hiai_image_generate / hiai_video_generate（index.ts:56-60）
      → 插件按 callbackUrl 回调 LobsterAI 主进程
        （getMediaCallbackUrl，src/main/mcp/mcpRuntime.ts:164-166；注入 main.ts:2723）
        → handleMediaGenerationCallback（main.ts:6309）
          → 调服务端 /api/media/...（6396 / 6602 / 6455 / 6580）
```

**关键（已核实）**：媒体工具路由是**按 `selection.mode` 动态切换**的，不是静态绑定：

- `mode === 'image' | 'auto'` → `hiai_image_generate`（`mediaGenerationTurnInstruction.ts:9-10,20-28`）
- 否则 → **OpenClaw 原生 `image_generate`**（`:29-33`，注释明确 "locked to the OpenClaw-native image_generate tool"）

**这意味着 FR-2.1 不需要"禁用插件"这么粗暴**：更稳妥的做法是让媒体选择始终走原生分支（即不再产生 `lobsterai_*` 路由），插件可保留但不被调用。真正的开关是 `selection.mode` 与 `hasMediaSkillActive` 的取值。

**连带影响（易漏）**：`buildSkinPackInstruction`（`:8-48`，"AI 皮肤包"工作流）同样强绑 `hiai_image_generate`（`:21`），且配套 `hiai_skin_manage` 工具。若插件被移除，皮肤包工作流需一并处置 —— 见 FR-2.7。

### 2.4 ASR 链路

> **已实现（2026-10-14 回填）**：下方为**旧方案（已删除）**，仅供对照；新链路见 2.4.1。

旧方案（远端实时流式，已删除）：

```
CoworkPromptInput（语音按钮）
  → useCoworkVoiceInput.ts（handleVoiceInput:210）
    → realtimeAsrClient.ts:155（startRealtimeVoiceInput）
      → IPC asr:realtime:createSession（shared/asr/constants.ts:1-3）
        → main/ipcHandlers/asr/handlers.ts:50-99
          → POST /api/asr/realtime/sessions（:66）→ 返回 wsUrl → WebSocket 流式
```

- **语言固定 `zh-CHS`**（`realtimeAsrClient.ts:160-161`）
- **无本地配置项**，全部服务端下发（`wsUrl`、`maxSessionSeconds`、配额秒数）
- **无 token 直接返回 `Unauthorized`**（`handlers.ts:54-58`）
- 音频链路可复用：`realtimeAudioRecorder.ts`、`wavEncoder.ts`（PCM16 WAV）

#### 2.4.1 新链路（本地 SenseVoice 侧车）

```
CoworkPromptInput（语音按钮）
  → useCoworkVoiceInput.ts（本地模式，VOICE_INPUT_MODE_LABEL='local'）
    → startLocalVoiceInput()（services/voiceInput/localAsrClient.ts）
      → batchAudioRecorder.ts 整流采集成 PCM16 WAV（16kHz 单声道）
        → IPC AsrIpcChannel.Transcribe（'asr:local:transcribe'，shared/asr/constants.ts）
          → main/ipcHandlers/asr/handlers.ts（registerAsrIpcHandlers）
            → 落临时 WAV → senseVoice/sidecar.ts（runSenseVoiceRecognition）
              → spawn 预编译 sherpa-onnx-offline + SenseVoice int8 模型 → 返回文本
```

- **无服务端、无 WebSocket、无配额**：`AsrIpcChannel` 仅两个通道 —— `GetAvailability`（`asr:local:getAvailability`）与 `Transcribe`（`asr:local:transcribe`）；旧 `asr:realtime:*` 与 `AsrRealtimeSessionData` 配额字段已删除。
- **可用性判定**：`checkSenseVoiceAvailability()` 校验侧车可执行文件与模型是否存在，缺失即返回 `unavailable`。
- **音频链路**：整流 WAV（`batchAudioRecorder.ts` + `wavEncoder.ts`），采样率 `VOICE_INPUT_TARGET_SAMPLE_RATE=16000`，与 sherpa-onnx 要求一致，零转换成本。
- **诊断埋点**：sidecar 通过 `onDiagnostics` 上报 `exitCode / stderr / stdout / wavBytes / durationMs / parsedText`（见 §7.1 D-3）。

### 2.5 商业壳的耦合点（为什么必须最后做）

企业账号并非独立模块，它耦合在：

- **请求头注入**：`main.ts:5579-5583` 每个请求注入 `X-LobsterAI-Account-Mode` / `X-LobsterAI-Enterprise-Id`
- **登录链路**：`auth.ts:317-370` 从 `user.accountMode`、`quota.accountMode` 判定
- **错误码依赖**：`authSessionManager.ts:63`（服务端 `NotMember` 触发登出）
- **fail-closed 分支**：`mediaAccess.ts:41-79`、`artifactSubscriptionGate.ts:90-98`

在服务端调用尚未全部断开前删除企业分支，可能连带破坏仍在使用的调用链。

---

## 3. 功能需求

### FR-1：agent 直连 provider（P0）

- **FR-1.1** 支持在设置中配置 LLM provider（Ollama / LM Studio / OpenAI 兼容自备 key），配置写入 OpenClaw 配置。
- **FR-1.2** 移除 `openclawTokenProxy` 的注入（`main.ts` 中 `startOpenClawTokenProxy` 调用点），agent 请求不再经本地 loopback 换取 LobsterAI token。
- **FR-1.3** 无登录状态下，agent 可完整完成一轮对话（含工具调用）。

### FR-2：媒体生成接第三方 API provider

- **FR-2.1（修订）** **保留** `lobster-media-generation` 插件（工具名与 schema 不变，皮肤包与会话生图无感）；**后端改由主进程直连本地 provider**。插件仍走 callback 回主进程，`handleMediaGenerationCallback`（`main.ts:6309`）内部从"转发服务端"改为"调本地 provider 适配层"。`action=status` 分两类：**图片**为本地同步调用，直接返回终态；**视频**通过 `taskRegistry` 反查 target 后轮询 MiniMax。
- **FR-2.2（修订，方案 A1：独立 kv key）** 媒体模型配置**不复用** `app_config.providers`（该结构被 `claudeSettings`、`openclawConfigSync`、`coworkOpenAICompatProxy` 等聊天链路消费，且其 `models[]` 只有 `supportsImage`/`supportsVideo`（语义为"能读图/读视频"的多模态文本模型），**没有** `category` 字段，塞入媒体配置会污染聊天链路）。改为**新增独立 kv key `mediaProviders`**，结构为 `{ image: MediaProviderEntry[], video: MediaProviderEntry[] }`，每条含 `key / displayName / baseUrl / apiKey / modelId / capabilities?`。清单**完全由用户手填配置推导**，无网络依赖、无内置预设；老配置不迁移（旧配置中本无媒体模型）。存储实现见 `src/main/libs/mediaProvider/store.ts`。
- **FR-2.2a（UI，顺延）** 设置页"媒体模型"分组（图片 / 视频两个 tab，各支持增删改）**本轮不做**，留下一轮。本轮落存储、适配层与完整工具链路；无 UI 时 `action=list` 返回空列表并提示用户去设置中添加。
- **FR-2.3（修订）** 视频生成 provider 定为 **MiniMax**（已确认）：用户手填 MiniMax API（`https://api.minimax.cn/v1`，视频接口非 OpenAI 兼容，主进程适配层单独实现 MiniMax 视频协议）。图片生成 provider 适配 OpenAI 兼容生图协议（`/images/generations`、`/images/edits`）。**三步异步协议详见 10.5 D5**。两者**均已落地**，见 `openaiCompatImage.ts` / `minimaxVideo.ts`。
- **FR-2.4（已实现）** **撤销积分估算**：移除 `MediaModelPicker.tsx:310-404` 的积分单价估算与 `CLIENT_ESTIMATE_CONFIGS`（`:256-287`）。同时移除 `getModelDiscountLabel`（"6 折"标签）、`getClientEstimateConfig`、`formatChineseEstimateScope` / `formatEnglishEstimateScope`、`BANANA_*_ESTIMATE_KEYS` 等硬编码估算体系；`getTokenBillingEstimateNotes` 统一返回 `mediaTokenBillingEstimateNote`。保留 `per_token` 计费读取（`getCreditsPerUsd` / `calculateEstimatedTokenCredits` 等，读 `pricing` 配置值而非硬编码）。
- **FR-2.5（已决，降级）** **不显示 token 消耗**：媒体生成链路无用量字段（见 10.5 D4），`details.billing` 一并移除。
- **FR-2.6（已实现）** 移除媒体生成的门控：删除 `NormalizedAuthQuota.mediaGenerationEntitled`、`AuthQuotaGateState.mediaGenerationEntitled`、`hasMediaGenerationEntitlement`、`cachedMediaGenerationEntitled`、`MediaGenerationAccessReason.NotEntitled` 分支、`UserQuota.mediaGenerationEntitled` 字段与 `mediaSubscribe*` 文案；`openclawConfigSync.canUseMediaGeneration` 死代码与 `skinWorkflowRegistry` 的 entitlement 短路一并删除。因媒体链路已完全改为用户自有本地 provider，**登录门控一并移除**：`resolveMediaGenerationAccess` 不再要求登录，`MediaGenerationAccessReason.LoginRequired`、`MediaModelPicker` 的登录提示面板与 `mediaLogin*` / `mediaLearnMore` 文案全部删除；仅保留企业账号的企业上下文/企业配额校验。未登录用户以 `local` 作用域缓存模型与保存选择（`coworkSlice.mediaModelsScopeKey`）。
- **FR-2.7（已实现）** "AI 皮肤包"工作流保留：`buildSkinPackInstruction`（`mediaGenerationTurnInstruction.ts:8-48`）继续绑定 `hiai_image_generate`，因 FR-2.1 已决定保留插件且其后端改为本地 provider，皮肤包随之自动走本地生图。`preflightLobsterImageGeneration`（`src/main/skins/skinMediaBridge.ts`）触发条件已改为"存在可用本地图片模型 + 生成 gate 放行"（见 4.3 节第 6 点）。



### FR-3：语音输入改用 SenseVoice（sherpa-onnx 预编译二进制，已定）

> **实现状态（2026-10-14）**：已实现，落点见 4.4 与 §7.1。行号会随重构漂移，以符号名为准。

- **FR-3.1（修订）** 运行时形态定为 **sherpa-onnx 预编译二进制**（已确认）：主进程以子进程方式调用 sherpa-onnx 的离线识别可执行文件，**无需 Python 环境**。打包分发 mac-arm64 与 win-x64 两套预编译产物 + SenseVoice Small 量化 ONNX 模型（int8，约 200MB 级）。**分发方式已决（U-9 方案 A）**：随安装包分发。
- **FR-3.2** 主进程新增侧车管理模块（`src/main/libs/senseVoice/sidecar.ts`）：按需拉起 sherpa-onnx 进程，输入 PCM16 WAV 文件路径（16kHz 单声道），解析识别结果（**v1.10.30 实际把 JSON 打到 stderr，解析器已按 stderr+stdout 合并、JSON 行 → `text=` 标记 → 纯文本三级解析**，见 §7.1 D-3），进程用毕回收。
- **FR-3.3** 复用音频采样链路（`batchAudioRecorder.ts` / `wavEncoder.ts`，`VOICE_INPUT_TARGET_SAMPLE_RATE=16000` 与 sherpa-onnx 要求一致，零转换成本），不做重复采集。**注**：原计划的 `realtimeAudioRecorder.ts` 随流式方案一并删除，改由 `batchAudioRecorder.ts` 整流采集。
- **FR-3.4** 移除服务端 ASR 链路（`handlers.ts` 的 `/api/asr/realtime/sessions`）；`asrQuotaSlice` 删除——本地推理无配额概念。**已落地**：`handlers.ts` 改为 `registerAsrIpcHandlers()` 无参注册本地通道；`shared/asr/constants.ts` 重写为本地契约（无 session/quota 字段）。
- **FR-3.5** 交互变更：从 WebSocket 流式转写改为**录音结束→一次性识别→出文本**（批量模式），无实时上屏。录音链路（60s 上限、300ms 下限）保留不变。
- **FR-3.6** 参考 `pythonPipShim.ts` 的"运行时自修复"模式：sherpa-onnx 二进制或模型缺失/损坏时，应用启动检测并提示，语音按钮置灰，不回退服务端。**已落地**：`checkSenseVoiceAvailability()` 覆盖"文件缺失"路径（返回 `unavailable` 并置灰按钮，见 AC-3.3）。

### FR-4：关闭 HTML 分享与站点部署

> **实现状态（2026-10-15 回填）：已全部落地。** 行号会随重构漂移，以符号名为准。

- **FR-4.1（已更新）** 编译期 flag（`src/shared/featureFlags.ts`）：仅保留 `ENABLE_HTML_SHARE`（置 `false`）；`ENABLE_SITE_DEPLOYMENT` 已随部署整块下线一并删除。
- **FR-4.2（已实现，2026-10-16 补全）** 分享入口 gate：
  - `artifactToolbarPublishPolicy.ts`：`resolveArtifactPreviewToolbarPublishTarget` 首行 `if (!ENABLE_HTML_SHARE) return null`（`resolveBrowserToolbarPublishTarget` 经其间接 gate）。
  - `ArtifactPreviewCard.tsx`：`canShare`。
  - `libraryItemActionPolicy.ts`：`LibraryItemAction.ShareLocal` 过滤（驱动 `LibraryView` 卡片菜单与 `LibraryPreviewModal` 溢出菜单）。
  - `LibraryPreviewModal.tsx`：头部独立分享按钮 `canShare`（**2026-10-16 补漏**，此前未接 flag）。
  - `LibraryView.tsx`：云端资源库视角（`LibrarySourceFilter.Cloud`）整体随 flag 隐藏（**2026-10-16 补漏**）——`SOURCE_FILTERS` 只保留 Local，`resolveSource` 对请求进来的 `Cloud` 兜底为 `Local`，使 `LibraryNavigationEvent.OpenCloud` 无法再打开云视角。
  - `ArtifactPanel.tsx`：经 publish policy 间接 gate。
- **FR-4.3（已完成，与初版方案不同）** 部署入口 gate 的方案已作废：部署入口不是被 gate 隐藏，而是**整块删除**。`ENABLE_SITE_DEPLOYMENT`、`ArtifactToolbarPublishActionKind.Deploy`、`LibraryItemAction.ManageSite`、`sitesHidden` 等已全部移除。
- **FR-4.4（已变更）** 分享服务层保留不删（`src/main/libs/htmlShare/*` 在位，仅断 UI 入口）；**部署服务层已删除**（`site/*`、`shareDeployment/*`、Site IPC、`SitesView` 均已移除），与初版"服务层保留"的结论不同。
- **FR-4.5（2026-10-16 补全）** 旧 `deployed_site` 云库条目的兼容读路径保留（`shared/library/types.ts` 的 `DeployedSiteItem`，读取旧构建产生的云端 payload），但管理 UI 已死入口化并清理：`LibrarySharedFilesView` 的 settings 菜单项仅对 `SharedFile` 条目提供（此前 DeployedSite 条目仍显示"管理网站"，点击后只滚动列表）；失去引用的 `libraryManageSite` i18n key（中英）一并删除。

### FR-5：移除商业壳（最后执行）

> **已拆分为独立文档**：`specs/refactors/remove-membership/2026-10-14-remove-membership-design.md`（《去会员理念改造设计文档》）。
> 该文档承接 FR-5 的完整边界（术语统一、三维度拆分、删除顺序、验收标准、未决项 M-1~M-4）与 FR-5.3 的重叠归属。
> 本节仅保留 FR-5 与去服务端依赖的**依赖关系**结论与逐条索引，实现细节以子文档为准。

- **FR-5.1** 移除企业账号：`main.ts:6275-6290`、`enterpriseAccount/context.ts`、`ipcHandlers/enterpriseAccount/*`、`renderer/features/enterpriseAccount/`、Redux reducer（`store/index.ts:30`）。
- **FR-5.2** 移除请求头注入（`main.ts:5579-5583`）。
- **FR-5.3** 移除订阅/积分 UI 与状态（`authSlice` 的 `creditsLimit/Used/Remaining`、`accountMenuState.ts` 的升级逻辑）。
- **FR-5.4** 移除 banner 与活动（`main.ts:7956-8027`、`activityClient.ts`）。
- **FR-5.5** `subscriptionStatus` 相关判断收敛：`enterprise` 分支删除后，`resolveMediaGenerationAccess` 整体废弃（由 FR-2.6 取代）。

**FR-5 前置**：FR-1/2/3 全部完成（理由见 §4.1）。

---

## 4. 实现方案

### 4.1 分轮次实施（依赖顺序）

| 轮次 | 内容 | 前置 | 可验证性 |
| --- | --- | --- | --- |
| **第 1 轮** | FR-1（agent 直连 provider） | 无 | 断网 + 无登录，agent 能对话 |
| **第 2 轮** | FR-2（媒体生成）+ FR-4（关闭分享/部署） | FR-1 | 配好 provider 能出图/出视频；分享入口消失 |
| **第 3 轮** | FR-3（SenseVoice 侧车） | FR-1 | 语音输入可用且不走服务端 |
| **第 4 轮** | FR-5（移除商业壳） | FR-1/2/3 | 全局搜索无服务端调用残留 |

**为什么必须这个顺序**：
- FR-2/3 依赖 agent 能独立运行（FR-1）。
- FR-5 依赖服务端调用已全部断开，否则删除企业分支会破坏残留调用链。
- FR-4 无依赖，可与 FR-2 合并。

### 4.2 FR-1 实现要点

1. `main.ts` 中 `startOpenClawTokenProxy` 调用点改为条件化：仅 `getAuthTokens()` 为真时启动；无登录时 `getOpenClawTokenProxyPort()` 返回 `null`，配置层自动回落。
2. `openclawConfigSync.ts` 无需改动 —— provider 配置直连逻辑已存在，proxy 端口为 null 时自动生效（已有 Ollama provider 定义：`src/shared/providers/constants.ts`）。
3. 移除 `openclawRuntimeAdapter.ts` 的 `isLobsterAILoginExpiredMetadata` 函数及其两处调用分支；同步删除已失效的测试用例（保留 403 用例）。
4. **保留**：HTTP 403 的"无权访问该模型"分支（见 10.4 D3）。

> 已落地。行号会随重构漂移，以符号名为准，勿再引用具体行号。

### 4.3 FR-2 实现要点

1. **插件保留（已决）**：`lobster-media-generation` 不禁用、不改代码；媒体生成链路（工具回调 + 渲染进程 IPC + 后台轮询器）的服务端 HTTP **已全部清零**（`grep -c "api/media" src/main/main.ts` == 0）。
   - **已落地**：`action=list`（图片+视频）、`action=generate`（图片+视频）、`action=status`、`action=cancel`（视频）。
   - **IPC 侧已迁移**：`CoworkIpcChannel.GetMediaModels`、`media:getTaskStatus`、`CoworkIpcChannel.CancelMediaTask` 三处改为读本地 provider（`getTaskStatus` 的 `taskId` 类型同步 `number` → `string`，与真实 task id 一致）。
   - **后台轮询器已迁移**：`pollPendingMediaTasks` 由拉服务端改为调适配层 `status()`，凭 `taskRegistry` 反查 target。
   - **同时删除**：服务端积分确认弹窗、`HappyHorse` 服务端子模型分派（`resolveHappyHorse11Selection` 等 103 行死代码）。
   - **剩余服务端调用**仅存于登录/鉴权链路（`api/auth/*`），属其余 FR 范围。
2. **主进程媒体适配层**（`src/main/libs/mediaProvider/`，**已落地**）：
   - `types.ts`：`MediaProvider` / `MediaProviderResolver` 契约与 `MediaProviderError`。
   - `store.ts`：独立 kv key `mediaProviders` 的读写与容错（缺失/畸形配置降级为空列表，不抛错）。
   - `taskRegistry.ts`：taskId → provider target 的持久映射（24h TTL），供 `action=status`/`cancel` 反查 target 后由适配层凭 `modelId` 重新解析凭据；app 重启后仍可续查。**不落 apiKey**（凭据经 safeStorage 加密，落库会造成明文泄漏），仅持久 `providerKey / baseUrl / modelId / displayName`。
   - `openaiCompatImage.ts`：OpenAI 兼容生图适配器（有参考图走 `/images/edits`，否则 `/images/generations`；同步返回）。
   - `minimaxVideo.ts`：MiniMax 三步异步协议适配器（创建 → 轮询 → 取回下载 URL），`base_resp.status_code !== 0` 视为失败；`cancel` 仅解除本地跟踪（MiniMax 无取消端点）。
   - `index.ts`：注册表 `initMediaProviders` / `getImageMediaProvider` / `getVideoMediaProvider`。
3. **配置落点（方案 A1）**：独立 kv key `mediaProviders`，**不碰** `app_config.providers`。原因：`ProviderConfig.models[]` 无 `category` 字段，且其 `supportsImage`/`supportsVideo` 语义是"多模态文本模型能读图/读视频"，与"能生成图片"无关；该结构另被聊天链路广泛消费。设置页 UI（图片/视频两个 tab 的手填表单）**下一轮**。
4. **前端选择器**：`MediaModelPicker.tsx` 数据源从 `window.electron.media.getModels`（`main.ts:8895-8933`）改为读本地媒体模型；积分估算 `CLIENT_ESTIMATE_CONFIGS`（`:256-287`）与估算逻辑（`:310-404`）删除。**下一轮**。
5. **（已实现）移除媒体门控**（FR-2.6）：`mediaAccess.ts` 的 `NotEntitled` fail-closed 分支与 `LoginRequired` 登录门控均已废弃，`resolveMediaGenerationAccess` 仅保留企业账号的企业上下文/企业配额校验；`MediaModelPicker` 无未登录提示，未登录即以 `local` 作用域读写本地模型选择。
6. **（已实现）`preflightLobsterImageGeneration`（`skinMediaBridge.ts`）**：触发条件改为"存在可用本地图片模型"，并复用 `resolveMediaGenerationGate` 作为单一事实来源（preflight 先于 gate 执行，避免对必将被 gate 拒绝的调用返回 `draft_required`）。注入点 `SkinMediaBridgeOptions.hasLocalImageModel`，由 `main.ts` 提供 `getImageMediaProvider()?.resolver.listModels().length > 0`。

### 4.4 FR-3 实现要点（sherpa-onnx，已定）

> **已全部落地（2026-10-14 回填）**。行号会随重构漂移，以符号名为准。

1. **侧车打包脚本**（`scripts/setup-sherpa-onnx.js`，新增）：拉取对应平台的预编译二进制（mac-arm64 / win-x64）+ SenseVoice Small int8 ONNX 模型，落至 `resources/sherpa-onnx/`。含自愈逻辑：`isBinaryPrepared()` 将**可执行文件 + 共享库 + 悬空链接检测**共同纳入幂等判断，半成品会被重新解包（见 §7.1）。
2. **侧车管理模块**（`src/main/libs/senseVoice/`，新增）：
   - `sidecar.ts`：`checkSenseVoiceAvailability()` / `runSenseVoiceRecognition()`（spawn 子进程、WAV 路径传入、stderr+stdout 合并解析、`onDiagnostics` 上报退出码与原始输出）。
   - `parsers.ts`：JSON 行 → `text=` 标记 → 纯文本三级解析，排除 flag echo/诊断行。
   - 配套测试：`parsers.test.ts`、`sidecar.integration.test.ts`（真实二进制端到端）。
3. **渲染层**：
   - `localAsrClient.ts`（新增）：`startLocalVoiceInput()` / `isLocalAsrAvailable()`，返回 `LocalVoiceInputSession`（含 `stop()` / `cancel()` / `maxSessionSeconds`）。
   - `batchAudioRecorder.ts` / `wavEncoder.ts` / `constants.ts` / `errors.ts` / `index.ts`：整流 WAV 采集与错误文案映射。
   - `useCoworkVoiceInput.ts`：本地模式（`VOICE_INPUT_MODE_LABEL='local'`），已删除全部配额逻辑，保留 60s/300ms 录音约束与 draft 切换取消。
4. **移除服务端 ASR 与配额**：删除 `realtimeAsrClient.ts`、`realtimeAudioRecorder.ts`、`asrQuotaSlice.ts`、`voiceInput/quota.ts` 及 `voiceInputQuota*` / `voiceInputUpgrade*` / `voiceInputLoginRequired*` i18n 键（后三项归 FR-5 / remove-membership RM-2，已完成）。

### 4.5 FR-4 / FR-5 实现要点

- FR-4：加 flag + 在入口处短路，不改服务层。
- FR-5：按 `main.ts` 注册点 → IPC handler → Redux → UI 的自底向上顺序删除。

---

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 用户未配置任何 LLM provider | 首次启动引导配置；agent 不可用但应用可正常打开 |
| 用户未配置媒体 provider | 媒体选择器显示"未配置"，不显示服务端模型 |
| 用户只配图片、未配视频 | 视频入口提示未配置，图片正常 |
| SenseVoice / sherpa-onnx 侧车启动失败 | 语音按钮置灰并提示本地模型不可用；不回退服务端 |
| 旧数据（session 中残留服务端模型 id） | 加载时校验，命中未知 id 时丢弃并回退默认 |
| 升级场景：旧用户已有登录态 | 本次改造后登录态无意义，需清理本地 token 与相关 kv |
| `subscriptionStatus === 'enterprise'` 的历史数据 | 企业分支删除后按 `free` 语义处理，不报错 |
| 无网络环境 | 全部功能可用（本期范围外：Skill Store / Kit Store / MCP Marketplace 仍会失败，见 U-6） |

---

## 6. 涉及文件

### 主进程

- `src/main/main.ts`（媒体 `:6309,6396,6455,6580,6602,8895`；ASR `:13696`；企业 `:6275,5579`；token proxy `:5908`）
- `src/main/libs/openclawTokenProxy.ts`
- `src/main/libs/endpoints.ts`
- `src/main/libs/openclawConfigSync.ts`（provider / mediaModels 渲染）
- `src/main/libs/agentEngine/mediaGenerationTurnInstruction.ts`（工具路由 + 皮肤包工作流）
- `src/main/mcp/mcpRuntime.ts`（`getMediaCallbackUrl`，媒体回调 bridge）
- `src/shared/skin/constants.ts`（皮肤包槽位/工作流常量）
- `src/main/ipcHandlers/asr/handlers.ts`（已改为本地通道 `registerAsrIpcHandlers()`）
- `src/main/libs/senseVoice/*`（新增：`sidecar.ts` / `parsers.ts` + 测试）
- `src/main/enterpriseAccount/*`（整目录）
- `src/main/ipcHandlers/enterpriseAccount/*`
- `src/main/libs/htmlShare/*`、`src/main/libs/site/*`、`src/main/libs/shareDeployment/*`（仅断入口）

### 渲染进程

- `src/renderer/components/cowork/MediaModelPicker.tsx`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts`（本地模式，已删配额逻辑）
- `src/renderer/components/cowork/voiceInput/`（`VoiceInputButton.tsx` / `VoiceInputRecordingStatus.tsx` / `useVoiceInputAvailability.ts` / `voiceInputUiState.ts`）
- `src/renderer/services/voiceInput/`（本地链路：`localAsrClient.ts` / `batchAudioRecorder.ts` / `wavEncoder.ts` / `constants.ts` / `errors.ts` / `index.ts`）
- ~~`src/renderer/services/voiceInput/realtimeAsrClient.ts`~~（已删除）
- ~~`src/renderer/store/slices/asrQuotaSlice.ts`~~（已删除）
- `src/renderer/components/Settings.tsx`
- `src/renderer/features/enterpriseAccount/*`（整目录）
- `src/renderer/components/artifacts/ArtifactPanel.tsx`
- `src/renderer/components/sites/SitesView.tsx`
- `src/renderer/components/library/LibraryView.tsx`
- `src/renderer/components/artifacts/publishing*Policy.ts`

### 共享与脚本

- `src/shared/featureFlags.ts`（新增 flag）
- `src/shared/providers/constants.ts`
- `src/shared/asr/constants.ts`
- `scripts/setup-python-runtime.js`（仅参考"运行时自修复"模式）
- 新增：`scripts/setup-sherpa-onnx.js`（拉取预编译二进制 + SenseVoice 模型，自愈）
- `scripts/electron-builder-hooks.cjs`（新增 `assertSidecarHasNoSymlinks()` 打包断言）
- `src/main/libs/mediaProvider/*`（新增，媒体 provider 适配层）
- `vendor/openclaw-runtime/mac-arm64/third-party-extensions/lobster-media-generation/`（**保留不改**，后端本地化）

---

## 7. 验收标准

按 FR 逐条验收，每条必须给出可复现的验证方式。

> **实现状态（2026-10-14 回填）**：FR-1/2/4/5 已实现，FR-3 已实现（U-9 已决：**方案 A 随包分发**）。
> **FR-4 补记（2026-10-15）**：AC-4.1 / AC-4.2 已由用户手动验证通过（分享/部署入口不可见）。
> FR-5 由 `specs/refactors/remove-membership/` 承接并已闭环（10 条 AC 全绿）。
> 验证结果：`tsc --noEmit` 通过；`npm run compile:electron` 通过；`vite build`（用户执行）通过；
> 全量 vitest 6429 用例仅 3 个失败，均为无关遗留（openclawConfigSync.runtime / popo-sdk / markdownEditorCommands）；
> 改动文件 eslint 零错误零警告。AC-2.2 / AC-2.5 / AC-3.1 / AC-G1 等
> 手动/抓包项待用户验收；AC-4.1 / AC-4.2 已于 2026-10-15 验证通过。
>
> **AC-3.2 补验（2026-10-14 真实环境联调）**：首次接线暴露了两个打包脚本缺陷，均已修复并补测，
> 详见 §7.1。修复后 mac-arm64 侧车可真实运行，离线识别实测通过。

### 7.1 FR-3 打包缺陷记录（2026-10-14）

mac-arm64 首次真实联调时，语音按钮置灰 → 修复后可用，但识别返回"未识别到有效语音"。逐层隔离定位到
`scripts/setup-sherpa-onnx.js` 两处缺陷（**与运行时业务逻辑无关，运行时无需改动**）：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| D-1 | 下载 404，按钮置灰 | 脚本按内部目标名拼 URL（`sherpa-onnx-v1.10.30-mac-arm64.tar.bz2`），上游 macOS 仅有 `osx-universal2-shared` 资产 | 新增 `SHERPA_ONNX_ASSET_SUFFIX` 映射，**区分"运行时布局 `bin/<target>`"与"上游资产名"** |
| D-2 | 二进制就位后仍报 `recognitionFailed` | `*_shared` 包的依赖库在兄弟目录 `lib/`，脚本只拷了 `bin/`；可执行文件经 `@rpath` 找 `../lib/libonnxruntime.1.17.1.dylib` 失败，进程启动即崩溃（`dyld: Library not loaded`），非零退出被归类为识别失败 | 一并拷贝 `lib/` 至 `bin/lib/`（正好命中 dyld 查找路径） |
| D-3 | dylib 修复后依旧"未识别到有效语音"（**运行时 bug**） | v1.10.30 二进制把识别结果 JSON 打到 **stderr**（stdout 为空、退出码 0），而 `sidecar.ts` 只解析 stdout；且 `parsers.ts` 只认 `text=` 标记，实际输出是 JSON 行——两层叠加导致永远解析出空文本 | `sidecar.ts` 将 stderr+stdout 合并交给解析器；`parsers.ts` 按 JSON 行 → `text=` 标记 → 纯文本三级解析，并排除 flag echo/诊断行 |

**自愈能力**：`isBinaryPrepared()` 现将**可执行文件 + 共享库**共同纳入幂等判断（此前只看可执行文件，
半成品会被误判为"已就绪"），缺失时清空目标目录重新解包；脚本末尾完整性校验同步纳入 `bin/lib/`。
新增 `tests/setupSherpaOnnx.test.ts`（7 用例）覆盖资产名映射与半成品识别。

**验证证据**：`bin/mac-arm64/sherpa-onnx-offline` 离线识别 `今天天气真不错我们出去散步吧`，
耗时 0.23s，RTF 0.066；缺 lib 时 `isBinaryPrepared` 返回 `false` 并成功自愈补齐；
D-3 修复后用编译后的真实解析器 + 真实二进制 + 应用同款 spawn 方式（`cwd=os.tmpdir()`、
stdio pipe）端到端实测，识别文本正确返回。

**使用者路径（U-9 方案 A 的落实）**：`resources/sherpa-onnx` 已通过 `electron-builder.json` 的
基础 `extraResources` 随安装包分发（打包后位于 `process.resourcesPath/sherpa-onnx/`，正是
`sidecar.ts` 的首选查找路径），**终端用户无需任何 setup 即可使用语音**。本脚本仅服务于开发者
checkout。

| 编号 | 验收标准 | 验证方式 |
| --- | --- | --- |
| AC-1.1 | 配置 Ollama 后，无登录状态下 agent 可完成一轮对话 | 断网 + 清除登录态，发起对话（含工具调用） |
| AC-1.2 | 无登录时 `getOpenClawTokenProxyPort()` 返回 `null`，配置回落真实 provider | 无登录启动，检查日志出现 `Skipping OpenClaw token proxy` 且生成的 `openclaw.json` 中 provider baseUrl 为真实地址 |
| AC-1.3 | 无登录时不再出现"登录状态已过期"提示 | 代码审查：`isLobsterAILoginExpiredMetadata` 无引用 |
| AC-1.4 | HTTP 403 仍提示"无权访问该模型" | 单元测试保留用例通过 |
| AC-2.1 | 设置"自定义模型"中按 文本/图像/视频 三分类配置（方案 X） | 手动操作 |
| AC-2.2 | 配好 provider 后，agent 能生成图片与视频 | 手动操作 |
| AC-2.3 | 应用内不存在任何积分估算显示 | 全局搜索 `CLIENT_ESTIMATE_CONFIGS` 无引用 |
| AC-2.4 | 媒体模型列表不来自服务端 | 抓包确认 |
| AC-2.5 | 皮肤包工作流走本地图片 provider（已决保留） | 手动操作 |
| AC-3.1 | 语音输入可用，且不产生服务端请求 | 抓包确认无 `/api/asr` 请求 |
| AC-3.2 | sherpa-onnx 侧车在 mac-arm64 上可打包运行 | **已通过**（2026-10-14 实测）：`npm run setup:sherpa-onnx` 拉取 `osx-universal2-shared` 包并落到 `bin/mac-arm64/`；离线识别实测 `今天天气真不错我们出去散步吧`，耗时 0.23s（RTF 0.066） |
| AC-3.3 | 侧车损坏时应用能提示而非静默失败 | **部分通过**：`checkSenseVoiceAvailability()` 覆盖"文件缺失"路径（返回 `unavailable` 并置灰按钮）；**已修缺陷**：`bin/lib/` 缺失时原先静默判为"已就绪"，实际 `dyld` 崩溃并误报为 `recognitionFailed`（见下方缺陷记录） |
| AC-4.1 | HTML 分享入口不可见 | ✅ **已通过**（2026-10-15 手动）：`ENABLE_HTML_SHARE=false`，3 处 gate 生效（`artifactToolbarPublishPolicy` / `ArtifactPreviewCard` / `libraryItemActionPolicy`）。**2026-10-16 补充**：另发现 2 处漏点并已 gate（`LibraryPreviewModal` 头部分享按钮、`LibraryView` 云端资源库视角），详见 FR-4.2 |
| AC-4.2 | 站点部署入口不可见 | ✅ **已通过**（2026-10-15 手动）：`ENABLE_SITE_DEPLOYMENT=false`，4 处 gate 生效（`App.tsx` `sitesHidden` + 3 处，见 FR-4.3） |
| AC-5.1 | 全局搜索无 `enterprise` 相关请求 | 抓包 + 代码审查 |
| AC-5.2 | 无订阅/积分/banner UI | 手动操作 |
| AC-G1 | 服务端域名不可达时，应用启动与核心功能正常 | 修改 hosts 屏蔽 `lobsterai-server.youdao.com` |

---

## 8. 未决项（实现前必须确认）

| 编号 | 未决项 | 影响 |
| --- | --- | --- |
| ~~U-1~~ | ~~媒体生成的 token 消耗数据来源~~ **已决**：媒体生成链路全程无 token 用量字段，FR-2.5 降级为"不显示"（见 10.5 D4） | — |
| ~~U-2~~ | ~~SenseVoice 侧车常驻 vs 按需拉起~~ **已决**：sherpa-onnx 按需拉起进程（FR-3.2） | — |
| ~~U-3~~ | ~~流式 ASR 改批量识别的体验~~ **已决**：接受批量模式（FR-3.5） | — |
| ~~U-4~~ | ~~插件禁用机制~~ **已决**：插件保留，后端本地化（FR-2.1） | — |
| ~~U-5~~ | ~~升级场景：是否需要清理旧登录态与相关 kv~~ **已决**：清理；登录能力整体移除（由 `specs/refactors/remove-membership/` §11 D1 承接） | — |
| U-6 | ~~更新检查~~ **已决**（2026-10-16）：`getUpdateCheckUrl()` 已改走 GitHub Releases（`hxhy00/HiAi`）。**剩余**：Skill Store / Kit Store / MCP Marketplace 三条链路仍打有道域名且 UI 入口可见，连同 server baseUrl 余下调用点（HTML 分享 handler、灰度更新、云端素材库）已移交 `specs/refactors/product-roadmap/` 任务 2（R1–R4），本文件不再承接 | — |
| ~~U-7~~ | ~~皮肤包迁移还是关闭~~ **已决**：保留，随插件后端本地化自动切换（FR-2.7） | — |
| ~~U-8~~ | ~~mac 侧 Python 运行时打包~~ **已决**：sherpa-onnx 预编译二进制，无 Python 依赖（FR-3.1） | — |
| ~~U-9~~ | ~~SenseVoice 模型分发方式（随安装包 vs 首次使用时下载）~~ **已决**：**随安装包分发**（`extraResources` 打包 `resources/sherpa-onnx`），终端用户零配置；开发者用 `npm run setup:sherpa-onnx`（自愈） | — |
| ~~U-10~~ | ~~MiniMax 视频适配器细节~~ **已决**：官方三步异步协议已核，域名应为 `api.minimax.cn`（见 10.5 D5） | — |

---

## 9. Mock 台账

本次改造**不引入 mock**。所有替换项均指向真实实现（OpenClaw 原生工具 / 本地 provider / sherpa-onnx 本地推理）。若实现阶段为验证目的临时使用假数据，须在本节追加登记（位置、形态、前置条件）。

---

## 10. 轮次开工前置确认（实现基准）

本文件是实现基准，**不拆独立规格**。每轮次编码前，按下表逐项确认后开工；确认结论**就地回写本文件**（修订对应 FR / 新增决策记录），不留"讨论过程"痕迹。

### 10.1 通用开工清单（每轮必做）

1. 运行 `codegraph_affected { node: "<本轮涉及符号>", depth: 2 }`，确认爆炸半径并写入本节"影响面"栏。
2. 核对本节待确认项是否已全部关闭；有未关闭项，**先确认再编码**。
3. 确认当前分支为 `feature/de-server-dependency`（Git Flow，见 Git 规范）。
4. 确认本轮 FR 的验收标准（第 7 章）在当前环境可复现。

### 10.2 各轮次待确认项

| 轮次 | 待确认项 | 状态 |
| --- | --- | --- |
| 第 1 轮（FR-1） | LLM provider 首启引导方式（设置页 / 首启向导 / 两者）；OpenClaw 配置中 provider 直连的字段落点 | **已关闭**（见 10.4） |
| 第 2 轮（FR-2 + FR-4） | U-1、U-10（FR-4 无未决项） | **已关闭**（见 10.5） |
| 第 3 轮（FR-3） | U-9（SenseVoice 模型：随包分发 vs 首次下载；int8 约 200MB 级） | **已关闭**：随包分发（见 §7.1） |
| 第 4 轮（FR-5） | U-5（升级场景旧登录态清理策略）；`subscriptionStatus` 收敛后 `resolveMediaGenerationAccess` 的废弃方式 | **已关闭**：U-5 已决（清理旧登录态，登录能力整体移除）；`resolveMediaGenerationAccess` 整体删除（见 `specs/refactors/remove-membership/` §11 D1/D2） |

### 10.3 轮次交接记录

> 每轮完成后追加一行：轮次、实际改动范围、与原计划的偏差、回写到本文件的 FR 修订。

| 轮次 | 完成日期 | 实际范围 | 偏差 | 关联修订 |
| --- | --- | --- | --- | --- |
| 第 1 轮（FR-1） | 2026-10-13 | `main.ts` 条件化 token proxy 启动；`openclawRuntimeAdapter.ts` 删除 `isLobsterAILoginExpiredMetadata` 及两处调用；同步删除对应测试 | 原计划"配置落点"改为**不新增配置分支**，仅让 proxy 端口天然为 null 触发回落 | 见 10.4 |
| 第 2 轮（FR-2 + FR-4） | 2026-10-14 | FR-2：主进程媒体适配层（`mediaProvider/*`）落地，媒体 `action=list/generate/status/cancel` 与三处 IPC 全部切本地 provider，独立 kv `mediaProviders`，移除媒体门控（FR-2.6）。FR-4：新增 `ENABLE_HTML_SHARE` / `ENABLE_SITE_DEPLOYMENT`（均 false），分享 3 处 + 部署 4 处入口全部 gate，服务层保留 | 媒体配置落点由"复用 `app_config.providers`"改为**独立 kv key `mediaProviders`**（方案 A1，原结构无 `category` 且被聊天链路消费）；媒体 UI 手填表单顺延（FR-2.2a） | 见 10.5、FR-4 |
| 第 3 轮（FR-3） | 2026-10-14 | 运行时按原设计实现完毕；联调阶段修复打包脚本两处缺陷（资产名映射、共享库拷贝）并加入自愈与单测 | 原计划未预见上游资产命名与 `lib/` 布局差异；打包脚本从"只校验可执行文件"升级为"可执行文件 + 共享库"完整性判断 | 见 §7.1、U-9 |
| 第 3 轮（FR-3 补记） | 2026-10-14 | 二/三轮联调再修：`setup-sherpa-onnx.js` 新增 `materializeSymlinks()` 物化符号链接、`isBinaryPrepared` 增加悬空链接检测；`electron-builder-hooks.cjs` 增加打包前 `assertSidecarHasNoSymlinks()` 断言；`sidecar.ts` 合并 stderr+stdout 并新增 `onDiagnostics` | 发现第三处缺陷 D-3（识别结果打到 stderr）与符号链接打包缺陷（悬空链接会随包分发到用户机器崩溃） | 见 §7.1 D-3 及"自愈能力" |
| 第 4 轮（FR-5） | 2026-10-14 | 移除商业壳：企业账号/请求头注入、订阅积分态与 UI、banner/活动、登录能力整体移除（含 `authSlice`、`authSessionManager`、`openclawTokenProxy` 删除），i18n 会员文案清零 | FR-5 拆分为独立文档 `specs/refactors/remove-membership/` 承接；登录能力由 M-1 决策**整体移除**（原计划仅清理登录态）；分享/部署服务层字段按 M-4 保留 | 见 `remove-membership` §11 D1-D5 |
| 第 5 轮（FR-4 收口） | 2026-10-16 | 部署整块**删除**（非 gate）：删除 `src/main/libs/site/*`、`src/main/libs/shareDeployment/*`、`src/main/ipcHandlers/site/*`、`src/renderer/components/sites/*`、`src/shared/site/constants.ts`、`src/shared/shareDeployment/*`；`ArtifactPanel.tsx` 移除全部部署状态/JSX（约 1700 行）；`CoworkSessionDetail.tsx` 移除浏览器本地服务上下文；`artifactToolbarPublishPolicy.ts` 移除 Deploy 目标；`libraryItemActionPolicy.ts` 移除 `ManageSite`；删除 `ENABLE_SITE_DEPLOYMENT` flag；清理 `nodeDeployment*` i18n（渲染层 280 条 + 主进程 2 条）；`libraryCloudClient` 解除对 `shared/site/constants` 的依赖 | 与 FR-4 初版"仅断 UI 入口、保留服务层"的方案**不同**：部署服务层一并删除，仅分享服务层保留（见 FR-4.4 修订）。`DeployedSite` 云库条目与 `sitesStatus_*` i18n 因属保留的 Library 云端展示面而保留 | FR-4.1~FR-4.4、§2.2 |
| 第 5 轮（FR-4 补记） | 2026-10-16 | 清理 Round 5 残留的死入口：`LibrarySharedFilesView` settings 菜单项改为仅对 `SharedFile` 提供（DeployedSite 条目的"管理网站"在 `ManageSite` action 移除后点击只滚动列表）；删除失去引用的 `libraryManageSite` i18n（中英各 1 条） | `DeployedSite` 兼容读路径与展示按 Round 5 决策保留，仅清死入口与孤儿文案 | 见 FR-4.5 |
| 文档校正（非代码改动） | 2026-10-16 | 回填 U-6：更新检查已改走 GitHub Releases，§2.1 表补 MCP Marketplace / 灰度更新检查 / 云端素材库三行并更新站点部署为"已完成"；Skill/Kit/MCP 三店与 server baseUrl 余下调用点移交 `product-roadmap` 任务 2（R1–R4），本文件不再承接 | 全文校正，无代码改动 | 见 §1.1、§1.3、§2.1、§5、§8 U-6 |

### 10.4 第 1 轮已关闭决策

**D1：provider 首启引导方式** —— **不新增首启向导**。复用现有 `Settings.tsx` provider 配置区（`PROVIDER_REGISTRY` 已含 Ollama / LM Studio / 自定义 OpenAI 兼容）。理由：新增向导会引入新 UI 状态机与持久化分支，与 G5"单向移除"原则相悖。

**D2：OpenClaw 配置落点** —— **不在 `openclawConfigSync` 新增分支**。改为：`startOpenClawTokenProxy` 仅在 `getAuthTokens()` 为真时启动，无登录时 `getOpenClawTokenProxyPort()` 返回 `null`，全链路自动回落：
- `PROVIDER_REGISTRY[LobsteraiServer].normalizeBaseUrl` → 走 `stripChatCompletionsSuffix(url)` 取真实 baseUrl
- `resolveApiKey` → 走 `LOBSTER_APIKEY_SERVER` 环境变量
- `openclawConfigSync.ts:2296` 的 proxy 注入块被 `if (proxyPort)` 包裹，整块跳过

**D3：403 语义保留** —— 删除范围限定为 401/`auth_refresh`/`auth_invalid_token`/`failoverReason=auth` 的"登录过期"重映射；HTTP 403 的"无权访问该模型"分支保留（`openclawRuntimeAdapter.test.ts` 对应用例保留）。

**影响面（codegraph_affected）**：`codegraph_build` 超时未完成，改用人工核验：`openclawTokenProxy` 调用点仅 `main.ts` 一处；`isLobsterAILoginExpiredMetadata` 为文件内私有函数，调用点仅 2 处，均已处理。

**验证**：`npx tsc --noEmit` 通过；`npx eslint --max-warnings 0` 三个改动文件全通过；`vitest run openclawRuntimeAdapter.test.ts` → **306 passed (306)**（改动前 307，删除 1 个测已移除行为的用例）。

### 10.5 第 2 轮已关闭决策

**D4：U-1 —— 媒体生成不显示 token 消耗**。核验 `main.ts` 的 `handleMediaGenerationCallback` 全链路（`action=list/status/cancel/generate`）后发现：任务响应只有 `taskId / upstreamTaskId / status / resultUrls / model / upstreamModel / modelSelectionReason / quotaRemaining / errorMessage / metadata`，**无任何 `usage` / `tokens` 字段**；`openclawRuntimeAdapter` 与 `authQuota` 中亦无媒体侧用量解析。故 **FR-2.5 降级为"不显示"**，`billing` 仅保留 `quotaRemaining`（服务端积分口径，本地 provider 下同样无意义，一并移除）。

**D5：U-10 —— MiniMax 视频为三步异步协议（官方文档已核）**：

| 步骤 | 方法与 URL | 关键参数 | 关键响应字段 |
| --- | --- | --- | --- |
| 1 创建 | `POST https://api.minimax.cn/v1/video_generation` | `model`(必填)、`prompt`(必填,≤2000字符)、`duration`、`resolution`、`prompt_optimizer`、`aigc_watermark`、`callback_url` | `task_id`、`base_resp.status_code` |
| 2 查询 | `GET https://api.minimax.cn/v1/query/video_generation?task_id=xxx` | `task_id`(query) | `status`、`file_id`、`video_width`、`video_height`、`base_resp` |
| 3 下载 | `GET https://api.minimax.cn/v1/files/retrieve?file_id=xxx` | `file_id`(query,int64) | `file.download_url`（**有效期 1 小时**） |

- 鉴权：`Authorization: Bearer <API_key>`；成功标志 `base_resp.status_code === 0`。
- **域名修正**：FR-2.3 原写 `https://api.minimaxi.com/v1` 有误，官方文档域名为 `api.minimax.cn`（`platform.minimaxi.com` 会 301 到 `platform.minimax.cn`）。
- 模型清单：`MiniMax-Hailuo-2.3`、`MiniMax-Hailuo-02`、`T2V-01-Director`、`T2V-01`。
- `status` 枚举（注意首字母大写）：`Preparing` / `Queueing` / `Processing` / `Success` / `Fail`。
- 分辨率与时长映射：Hailuo-2.3 / Hailuo-02 → 768P(默认) / 1080P；6s 或 10s（10s 仅 768P）；其他模型 → 720P，仅 6s。
- 错误码：`1002` 限流、`1004` 鉴权失败、`1008` 余额不足、`1026` 输入敏感、`1027` 输出敏感。
