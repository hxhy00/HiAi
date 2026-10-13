# 去服务端依赖改造设计文档

## 1. 概述

### 1.1 问题/动机

LobsterAI 当前是一个"本地 agent 内核 + 商业服务端外壳"的结构：

- **内核**：OpenClaw agent runtime，本地进程，自带 provider 抽象、媒体生成工具、本地工具链，**本身不依赖 LobsterAI 服务端**。
- **外壳**：登录鉴权、订阅/积分、媒体生成列表与计费、ASR 实时流、企业账号、HTML 分享、站点部署、更新检查、Skill Store —— 全部经 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts:31`）打到 `lobsterai-server.youdao.com`。

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
- 不处理更新检查与 Skill Store 的替代方案（本期外，另立需求）。

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
| 媒体模型 | `GET /api/media/{images\|videos}/models` | `src/main/main.ts:6396,8908` | **替换为本地 provider** |
| 媒体生成 | `POST /api/media/{images\|videos}/generate` | `src/main/main.ts:6602` | **替换为本地 provider**（图片走 OpenAI 兼容生图协议；视频走 MiniMax 视频适配器，已定） |
| 媒体轮询 | `GET /api/media/{images\|videos}/tasks/{id}` | `src/main/main.ts:6455,7114,8952` | **替换** |
| 媒体取消 | `POST /api/media/videos/tasks/{id}/cancel` | `src/main/main.ts:6580,11117` | **替换** |
| ASR 实时 | `POST /api/asr/realtime/sessions` | `src/main/ipcHandlers/asr/handlers.ts:66` | **替换为 SenseVoice** |
| 订阅/配额 | `/api/user/quota`、`/profile`、`/models/pricing-catalog` 等 | `src/main/main.ts:7786,7860,7896,8104` | 移除 |
| 企业账号 | `/api/enterprise/context`、`/identities`、`/quota-requests` | `src/main/enterpriseAccount/context.ts:280,369,442` | 移除 |
| 模型列表 | `GET /api/models/available` | `src/main/main.ts:5942` | 替换为本地 provider 静态清单 |
| 更新检查 | `api-overmind.youdao.com/.../update` | `src/main/libs/endpoints.ts:55-65` | 本期不动 |
| Skill/Kit Store | `endpoints.ts:73-91` | 同上 | 本期不动 |
| HTML 分享 | `/api/html-shares/{id}`、`htmlShareClient.ts` | `src/main/main.ts:8513` | 关闭入口 |
| 站点部署 | `shareDeploymentClient.ts`、`siteClient.ts` | — | 关闭入口 |
| 客户端 banner/活动 | `activityClient.ts:84,99,117` | `src/main/main.ts:7956-8027` | 移除 |

### 2.2 LLM 推理路径（P0 阻塞点）

**当前**：agent 的 LLM 请求经 `openclawTokenProxy`（`src/main/libs/openclawTokenProxy.ts:133`）代理到 LobsterAI 服务端换取 token。

**这是唯一在去掉登录后会直接崩溃的核心路径**：登录没了 → 无 token → agent 无法推理。

**目标**：让 OpenClaw 直连 provider（Ollama / LM Studio / 自备 API key 的 OpenAI 兼容端点）。

> P0 是所有其他改造的前提。在 P0 完成前，其他改动都无法端到端验证。

### 2.3 媒体生成链路（三段式）

```
MediaModelPicker 选择模型
  → 每轮注入 agent 指令 mediaGenerationTurnInstruction.ts:71-111
    → OpenClaw 插件 lobster-media-generation 注册工具
       lobsterai_image_generate / lobsterai_video_generate（index.ts:56-60）
      → 插件按 callbackUrl 回调 LobsterAI 主进程
        （getMediaCallbackUrl，src/main/mcp/mcpRuntime.ts:164-166；注入 main.ts:2723）
        → handleMediaGenerationCallback（main.ts:6309）
          → 调服务端 /api/media/...（6396 / 6602 / 6455 / 6580）
```

**关键（已核实）**：媒体工具路由是**按 `selection.mode` 动态切换**的，不是静态绑定：

- `mode === 'image' | 'auto'` → `lobsterai_image_generate`（`mediaGenerationTurnInstruction.ts:9-10,20-28`）
- 否则 → **OpenClaw 原生 `image_generate`**（`:29-33`，注释明确 "locked to the OpenClaw-native image_generate tool"）

**这意味着 FR-2.1 不需要"禁用插件"这么粗暴**：更稳妥的做法是让媒体选择始终走原生分支（即不再产生 `lobsterai_*` 路由），插件可保留但不被调用。真正的开关是 `selection.mode` 与 `hasMediaSkillActive` 的取值。

**连带影响（易漏）**：`buildSkinPackInstruction`（`:8-48`，"AI 皮肤包"工作流）同样强绑 `lobsterai_image_generate`（`:21`），且配套 `lobsterai_skin_manage` 工具。若插件被移除，皮肤包工作流需一并处置 —— 见 FR-2.7。

### 2.4 ASR 链路

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

- **FR-2.1（修订）** **保留** `lobster-media-generation` 插件（工具名与 schema 不变，皮肤包与会话生图无感）；**后端改由主进程直连本地 provider**。插件仍走 callback 回主进程，`handleMediaGenerationCallback`（`main.ts:6309`）内部从"转发服务端"改为"调本地 provider 适配层"。`action=status` 在本地分支直接返回终态（本地同步调用，无异步任务）。
- **FR-2.2（修订，方案 A1：独立 kv key）** 媒体模型配置**不复用** `app_config.providers`（该结构被 `claudeSettings`、`openclawConfigSync`、`coworkOpenAICompatProxy` 等聊天链路消费，且其 `models[]` 只有 `supportsImage`/`supportsVideo`（语义为"能读图/读视频"的多模态文本模型），**没有** `category` 字段，塞入媒体配置会污染聊天链路）。改为**新增独立 kv key `mediaProviders`**，结构为 `{ image: MediaProviderEntry[], video: MediaProviderEntry[] }`，每条含 `key / displayName / baseUrl / apiKey / modelId / capabilities?`。清单**完全由用户手填配置推导**，无网络依赖、无内置预设；老配置不迁移（旧配置中本无媒体模型）。存储实现见 `src/main/libs/mediaProvider/store.ts`。
- **FR-2.2a（UI，顺延）** 设置页"媒体模型"分组（图片 / 视频两个 tab，各支持增删改）**第 2 轮不做**，留下一轮。本轮仅落存储与适配层；无 UI 时 `action=list` 返回空列表并提示用户去设置中添加。
- **FR-2.3（修订）** 视频生成 provider 定为 **MiniMax**（已确认）：用户手填 MiniMax API（`https://api.minimax.cn/v1`，视频接口非 OpenAI 兼容，需在主进程适配层单独实现 MiniMax 视频协议适配器）。图片生成 provider 适配 OpenAI 兼容生图协议（`/images/generations`、`/images/edits`）。**三步异步协议详见 10.5 D5**。视频适配器**第 2 轮不做**（本轮仅图片），下一轮实现。
- **FR-2.4** **撤销积分估算**：移除 `MediaModelPicker.tsx:310-404` 的积分单价估算与 `CLIENT_ESTIMATE_CONFIGS`（`:256-287`）。
- **FR-2.5（已决，降级）** **不显示 token 消耗**：媒体生成链路无用量字段（见 10.5 D4），`details.billing` 一并移除。
- **FR-2.6** 移除媒体生成的 entitlement 门控（`mediaGenerationEntitled` 相关判断）。
- **FR-2.7（已决）** "AI 皮肤包"工作流保留：`buildSkinPackInstruction`（`mediaGenerationTurnInstruction.ts:8-48`）继续绑定 `lobsterai_image_generate`，因 FR-2.1 已决定保留插件且其后端改为本地 provider，皮肤包随之自动走本地生图。`preflightLobsterImageGeneration`（`src/main/skins/skinMediaBridge.ts:102-133`）的触发条件需同步修订（见 4.3 节第 6 点）。



### FR-3：语音输入改用 SenseVoice（sherpa-onnx 预编译二进制，已定）

- **FR-3.1（修订）** 运行时形态定为 **sherpa-onnx 预编译二进制**（已确认）：主进程以子进程方式调用 sherpa-onnx 的离线识别可执行文件，**无需 Python 环境**。打包分发 mac-arm64 与 win-x64 两套预编译产物 + SenseVoice Small 量化 ONNX 模型（int8，约 200MB 级，安装时下载或随包分发需在实现期按体积权衡）。
- **FR-3.2** 主进程新增侧车管理模块：按需拉起 sherpa-onnx 进程，输入 PCM16 WAV 文件路径（16kHz 单声道），stdout 返回识别文本 JSON，进程用毕回收。
- **FR-3.3** 复用现有音频链路（`realtimeAudioRecorder.ts` / `wavEncoder.ts`，`VOICE_INPUT_TARGET_SAMPLE_RATE=16000` 与 sherpa-onnx 要求一致，零转换成本），不做重复采集。
- **FR-3.4** 移除服务端 ASR 链路（`handlers.ts` 的 `/api/asr/realtime/sessions`）；`asrQuotaSlice` 删除——本地推理无配额概念。
- **FR-3.5** 交互变更：从 WebSocket 流式转写改为**录音结束→一次性识别→出文本**（批量模式），无实时上屏。录音链路（60s 上限、300ms 下限）保留不变。
- **FR-3.6** 参考 `pythonPipShim.ts` 的"运行时自修复"模式：sherpa-onnx 二进制或模型缺失/损坏时，应用启动检测并提示，语音按钮置灰，不回退服务端。

### FR-4：关闭 HTML 分享与站点部署

- **FR-4.1** 新增编译期 flag（沿用 `src/shared/featureFlags.ts:11` 的写法）：`ENABLE_HTML_SHARE`、`ENABLE_SITE_DEPLOYMENT`，均置 `false`。
- **FR-4.2** 分享入口 gate：`artifactToolbarPublishPolicy.ts:29-58`、`ArtifactPanel.tsx:139-143,769-772,882-913`、`LibraryView.tsx:1497-1522,1587,1607,1645`。
- **FR-4.3** 部署入口 gate：`SitesView.tsx`、`App.tsx:2183-2186`、`LibrarySharedFilesView.tsx:1707`。
- **FR-4.4** 服务层保留不删（`htmlShare/*`、`site/*`、`shareDeployment/*`），仅断 UI 入口 —— 后续可能复用。

### FR-5：移除商业壳（最后执行）

- **FR-5.1** 移除企业账号：`main.ts:6275-6290`、`enterpriseAccount/context.ts`、`ipcHandlers/enterpriseAccount/*`、`renderer/features/enterpriseAccount/`、Redux reducer（`store/index.ts:30`）。
- **FR-5.2** 移除请求头注入（`main.ts:5579-5583`）。
- **FR-5.3** 移除订阅/积分 UI 与状态（`authSlice` 的 `creditsLimit/Used/Remaining`、`accountMenuState.ts` 的升级逻辑）。
- **FR-5.4** 移除 banner 与活动（`main.ts:7956-8027`、`activityClient.ts`）。
- **FR-5.5** `subscriptionStatus` 相关判断收敛：`enterprise` 分支删除后，`resolveMediaGenerationAccess` 整体废弃（由 FR-2.6 取代）。

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

1. **插件保留（已决）**：`lobster-media-generation` 不禁用、不改代码；`handleMediaGenerationCallback`（`main.ts:6309`）内部把服务端 HTTP 逐段替换为本地 provider 适配层。
   - **第 2 轮已落地**：`action=list` 的 image 分支、`action=generate` 的 image 分支。
   - **第 2 轮未动**：`action=list` 的 video 分支、`action=generate` 的 video 分支、`action=status`、`action=cancel`（仍走服务端），下一轮迁移。
2. **主进程媒体适配层**（`src/main/libs/mediaProvider/`，**第 2 轮已落地**）：
   - `types.ts`：`MediaProvider` / `MediaProviderResolver` / `MediaProviderEntry` 契约与 `MediaProviderError`。
   - `store.ts`：独立 kv key `mediaProviders` 的读写与容错（缺失/畸形配置降级为空列表，不抛错）。
   - `openaiCompatImage.ts`：OpenAI 兼容生图适配器（有参考图走 `/images/edits`，否则 `/images/generations`；同步返回，`status` 抛 `MEDIA_PROVIDER_TASK_NOT_FOUND`）。
   - `index.ts`：注册表 `initMediaProviders` / `getImageMediaProvider`。
   - 视频：**MiniMax 视频协议适配器**（任务式：创建任务 → 轮询状态 → 取回视频 URL）**下一轮实现**。
3. **配置落点（方案 A1）**：独立 kv key `mediaProviders`，**不碰** `app_config.providers`。原因：`ProviderConfig.models[]` 无 `category` 字段，且其 `supportsImage`/`supportsVideo` 语义是"多模态文本模型能读图/读视频"，与"能生成图片"无关；该结构另被聊天链路广泛消费。设置页 UI（图片/视频两个 tab 的手填表单）**下一轮**。
4. **前端选择器**：`MediaModelPicker.tsx` 数据源从 `window.electron.media.getModels`（`main.ts:8895-8933`）改为读本地媒体模型；积分估算 `CLIENT_ESTIMATE_CONFIGS`（`:256-287`）与估算逻辑（`:310-404`）删除。**下一轮**。
5. **移除媒体 entitlement 门控**（FR-2.6）后，`mediaAccess.ts` 的 fail-closed 分支一并废弃。
6. **`preflightLobsterImageGeneration`（`skinMediaBridge.ts:102-133`）**：触发条件从"服务端图片模型"改为"存在可用本地图片模型"，避免本地生图被误拒绝。**下一轮**（本轮未改，皮肤包生图在无本地图片模型时会落到上面的"未配置"提示）。

### 4.4 FR-3 实现要点（sherpa-onnx，已定）

1. 新增 sherpa-onnx 侧车打包脚本：拉取对应平台的预编译二进制（mac-arm64 / win-x64）+ SenseVoice Small int8 ONNX 模型，落至 `resources/sherpa-onnx/`。
2. 主进程新增侧车管理模块（生命周期对齐 `openclawEngineManager.ts` 的模式）：按需拉起子进程，传 WAV 路径，收 JSON 结果，用毕回收。
3. 替换 `realtimeAsrClient.ts`：从 WebSocket 流式改为"录音 → 一次性提交侧车 → 返回文本"（批量模式，无实时上屏；交互变更已确认接受）。
4. 删除 `asrQuotaSlice.ts` 与 `useCoworkVoiceInput.ts` 中的配额逻辑；`AsrRealtimeSessionData` 中的配额字段（`shared/asr/constants.ts:35-45`）随 IPC 通道一并移除。

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
| 无网络环境 | 全部功能可用（本期范围外：更新检查、Skill Store 仍会失败） |

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
- `src/main/ipcHandlers/asr/handlers.ts`
- `src/main/enterpriseAccount/*`（整目录）
- `src/main/ipcHandlers/enterpriseAccount/*`
- `src/main/libs/htmlShare/*`、`src/main/libs/site/*`、`src/main/libs/shareDeployment/*`（仅断入口）

### 渲染进程

- `src/renderer/components/cowork/MediaModelPicker.tsx`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts`
- `src/renderer/services/voiceInput/realtimeAsrClient.ts`
- `src/renderer/store/slices/asrQuotaSlice.ts`
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
- 新增：`scripts/setup-sherpa-onnx.js`（拉取预编译二进制 + SenseVoice 模型）
- `src/main/libs/mediaProvider/*`（新增，媒体 provider 适配层）
- `vendor/openclaw-runtime/mac-arm64/third-party-extensions/lobster-media-generation/`（**保留不改**，后端本地化）

---

## 7. 验收标准

按 FR 逐条验收，每条必须给出可复现的验证方式。

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
| AC-3.2 | sherpa-onnx 侧车在 mac-arm64 上可打包运行 | 构建产物验证 |
| AC-3.3 | 侧车损坏时应用能提示而非静默失败 | 手动删除侧车文件后启动 |
| AC-4.1 | HTML 分享入口不可见 | 手动操作 |
| AC-4.2 | 站点部署入口不可见 | 手动操作 |
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
| U-5 | 升级场景：是否需要清理旧登录态与相关 kv | 影响边界情况处理 |
| U-6 | 更新检查与 Skill Store 的后续处置 | 本期外，需另立需求 |
| ~~U-7~~ | ~~皮肤包迁移还是关闭~~ **已决**：保留，随插件后端本地化自动切换（FR-2.7） | — |
| ~~U-8~~ | ~~mac 侧 Python 运行时打包~~ **已决**：sherpa-onnx 预编译二进制，无 Python 依赖（FR-3.1） | — |
| U-9 | SenseVoice 模型分发方式（随安装包 vs 首次使用时下载） | 影响 FR-3.1 打包体积与安装体验 |
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
| 第 2 轮（FR-2） | U-1、U-10 | **已关闭**（见 10.5） |
| 第 3 轮（FR-3） | U-9（SenseVoice 模型：随包分发 vs 首次下载；int8 约 200MB 级） | 待开工确认 |
| 第 4 轮（FR-5） | U-5（升级场景旧登录态清理策略）；`subscriptionStatus` 收敛后 `resolveMediaGenerationAccess` 的废弃方式 | 待开工确认 |

### 10.3 轮次交接记录

> 每轮完成后追加一行：轮次、实际改动范围、与原计划的偏差、回写到本文件的 FR 修订。

| 轮次 | 完成日期 | 实际范围 | 偏差 | 关联修订 |
| --- | --- | --- | --- | --- |
| 第 1 轮（FR-1） | 2026-10-13 | `main.ts` 条件化 token proxy 启动；`openclawRuntimeAdapter.ts` 删除 `isLobsterAILoginExpiredMetadata` 及两处调用；同步删除对应测试 | 原计划"配置落点"改为**不新增配置分支**，仅让 proxy 端口天然为 null 触发回落 | 见 10.4 |

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
