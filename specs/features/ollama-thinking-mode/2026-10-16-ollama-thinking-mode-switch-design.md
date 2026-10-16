# Ollama 模型思考模式开关设计

日期：2026-10-16
状态：规格已确认第 1–4 章；U-1 / U-2 已由 Ollama 实测收敛（见 §8.1），U-3 待有思考模型后抓包，U-4 待产品决策
关联：`specs/features/cowork-thinking-block-display/2026-07-13-cowork-thinking-block-display-design.md`（思考块展示）、`specs/refactors/product-roadmap/2026-10-15-hiai-product-roadmap.md`

行号会随重构漂移，一律以符号名为准。

## 1. 概述

### 1.1 问题/背景

思考模式当前只有**官方套餐源（`lobsterai-server`）**能用：模型选择器里的思考开关由 `canConfigureModelThinking()` 把关，而它要求模型带 `lobsterai-options-v1` 请求能力——该能力仅由服务端下发。

Ollama 用户因此处于一个尴尬状态：

1. **勾了也没用**：模型设置里可以勾「支持思考输出」（`ProviderConfig.models[].supportsThinking`），配置同步侧也确实会为它合成 `thinkingConfig`、生成 `reasoning: true` 与 `thinkingLevelMap`，但 UI 门槛把这道门关上了，思考开关**永远不出现**。
2. **默认模型没有能力位**：Ollama 的 `defaultModels`（`qwen3-coder-next`、`glm-4.7-flash`）都只声明 `supportsImage: false`，没有 `supportsThinking`，用户不手动勾就没有任何思考入口。
3. **档位天然受限**：自配 provider 只有 `off / low / medium / high` 四档（`CUSTOM_MODEL_THINKING_OPTIONS`），产品侧的 `max` 档不能透传给 OpenClaw（`OPENCLAW_CONFIGURABLE_THINKING_LEVELS` 不含 `max`，且等级映射只对 `lobsterai-server/` 前缀生效）。

结果是：本地跑 Ollama 的用户即使模型本身支持思考，也无法在 HiAi 里开启。

### 1.2 目标

让 Ollama（以及同属自配 provider 的 LM Studio 等）模型在满足「模型确实支持思考」的前提下，能在模型选择器里正常开关思考模式并选择档位，同时不误伤官方源既有的协议路径。

## 2. 用户场景

### 场景 1: 为 Ollama 模型开启思考

**Given** 用户已配置 Ollama 并在模型设置里为某个模型勾选「支持思考输出」
**When** 在模型选择器选中该模型
**Then** 出现「思考模式」二级菜单，可开关并选择强度档位；开启后会话以 `thinkingLevel` 下发给运行时

### 场景 2: 未声明能力的模型不显示开关

**Given** Ollama 模型未勾选「支持思考输出」
**When** 选中该模型
**Then** 不显示思考模式入口（与官方源不支持思考的模型行为一致）

### 场景 3: 每个模型各自记住档位

**Given** 用户为模型 A 选了「高」
**When** 切到模型 B（也支持思考）再切回 A
**Then** A 仍为「高」，B 使用其自身上次选择或默认值

### 场景 4: 关闭思考

**Given** 当前思考为「中」
**When** 关闭思考模式开关
**Then** 下一次发起的会话以关闭态下发，不残留上次档位

### 场景 5: 模型不再支持思考后的回退

**Given** 某模型历史记录过思考档位，后来用户取消勾选「支持思考输出」
**When** 再次选中该模型
**Then** 回落到默认档位而不报错（等级失效必须有兜底，否则 `sessions.patch` 失败）

## 3. 功能需求

### FR-1: 思考开关 UI 门槛按「配置来源」拆分

现状（`ModelSelector.canConfigureModelThinking`）把两件事混在一个判定里：

- **协议能力**：官方源需要 `lobsterai-options-v1`，因为思考参数是由 `lobsterai-model-compat` 扩展注入请求体的；
- **本地能力**：自配 provider 靠 `thinkingConfig` + OpenClaw 的 `thinkingLevelMap` / `supportedReasoningEfforts` 生效，不需要该协议。

- 拆成两个判定：保留 `supportsConfigurableModelThinkingProtocol()` 供**协议相关**逻辑使用；新增（或改造）为「有 thinkingConfig 且非不可用模型」即可展示思考菜单。
- 官方源行为**保持不变**：仍需协议能力，二者取交集。
- 同步排查 `supportsConfigurableModelThinkingProtocol` 的其它调用点，避免门槛放宽后误放行依赖注入协议的场景。

### FR-2: 能力声明落点沿用既有字段，不新增 provider 级开关

- 能力声明继续用 `ProviderConfig.models[].supportsThinking`（存 `app_config` kv），这是唯一同时覆盖官方源、自配 provider 与 Ollama 的既有字段。
- 设置页复选框（`ModelSettingsSection`，`supportsThinkingOutput` / `supportsThinkingOutputHint`）对 Ollama 同样生效，无需新增 UI。
- **不新增** provider 级 `supportsThinking` 字段（避免同一能力两处声明）。

### FR-3: 档位范围与映射

- Ollama / 自配 provider 使用既有 `CUSTOM_MODEL_THINKING_OPTIONS`（`off / low / medium / high`），默认 `medium`。
- **实测依据**：Ollama 0.40.4 的 OpenAI 兼容层接受 `reasoning_effort` 参数，四档均可路由（见 §8.1），因此无需为 Ollama 另设参数通道。
- 不向 OpenClaw 透传产品侧 `max` 档（`OPENCLAW_CONFIGURABLE_THINKING_LEVELS` 不含 `max`）。
- 每模型记忆沿用 `modelThinkingLevelMemory` 的既有三级优先级，不退回全局单值。
- 持久化等级在模型不再声明思考时回落到 `defaultLevel`（防止 patch 失败）。

### FR-4: 配置同步侧确认无需新增声明

- `resolveAllEnabledProviderConfigs()` 读取 `app_config.providers` 且仅排除 `lobsterai-server`，**Ollama 已在该路径内**：模型勾选 `supportsThinking` 后，`buildCustomModelThinkingConfig()` 会合成 `thinkingConfig`，`openclaw.json` 中产出 `reasoning: true`、`thinkingLevelMap` 与 `compat.supportedReasoningEfforts`。
- 实现时以回归测试锁定这条链路（含未勾选时三者均为 `undefined`）。
- Ollama 的传输恒为 `openai-completions`（descriptor `resolveApi` 固定），不引入新的传输分支。

### FR-5: 思考内容展示沿用既有链路

- 会话下发时同时带 `reasoningLevel: 'stream'`，思考块由既有 `block.type === 'thinking'` 提取路径渲染。
- 不支持思考的模型必须能忽略该设置（既有 history-only 路径保留）。

### 不做清单

- **不接入 Ollama 原生 `/api/chat`**：HiAi 侧只走 OpenAI 兼容 `/v1`，Ollama 原生 `thinking` 请求字段不纳入本期。
- **不为 Ollama 开放 `max` 档**。
- **不放开 `KIMI_K3_RESERVED_CUSTOM_PARAM_KEYS` 等保留键**，不允许用户自定义 `thinking` / `reasoning` / `reasoning_effort` / `thinkingLevelMap` / `supportsReasoningEffort` / `supportedReasoningEfforts`。
- **不做思考内容的分轮边界改造**（受运行时事件能力限制，见关联文档）。
- **不改官方源的协议注入路径**。

## 4. 交互设计

- 入口形态沿用现状：模型选择器 hover 卡片上的「深度思考」徽标 → 点击展开二级级联菜单（`ModelThinkingMenu`：顶部开关行 + 下方档位单选）。
- Ollama 模型不满足条件时不显示徽标与菜单，不显示任何禁用态占位。
- 档位项为 `关闭 / 低 / 中 / 高` 四项；文案复用既有 `modelThinkingLevel*` 键，**不新增文案**。
- 状态反馈沿用现有交互：开关切换即时生效于下一次会话发起的 patch，不阻塞输入。

## 5. 实现方案

### 5.1 落点

| 环节 | 文件 | 说明 |
| --- | --- | --- |
| UI 门槛 | `src/renderer/components/ModelSelector.tsx` | `canConfigureModelThinking` / `supportsConfigurableModelThinkingProtocol` |
| 思考菜单 | `src/renderer/components/modelSelector/ModelThinkingMenu.tsx` | 复用，无需改结构 |
| 档位记忆 | `modelThinkingLevelMemory` | 复用 |
| 等级映射 | `src/main/libs/openclawModelThinkingLevels.ts` | 仅 server 前缀做映射，其它原样透传 |
| 配置同步 | `src/main/libs/openclawConfigSync.ts` | `buildCustomModelThinkingConfig` 已在 Ollama 路径内，只补回归测试 |
| 能力声明 UI | `src/renderer/components/settings/ModelSettingsSection.tsx` | 复选框已覆盖 Ollama |
| 默认模型 | `src/shared/providers/constants.ts` | Ollama `defaultModels` 是否补 `supportsThinking` → U-2 |
| 协议能力 | `src/shared/providers/lobsterAIRequestOptions.ts` | 仅官方源，保持不变 |

### 5.2 关键取舍

- **宁可不声明，也不要错声明**：`dshConfigSync.ts` 注释已确立该立场——「各上游线路方言不同，过度声明会在请求中途破坏」。因此 Ollama 默认模型的能力位默认策略必须谨慎（U-2），且档位映射失败要能安全退化（FR-3）。
- **不新增协议能力**：自配 provider 走 OpenClaw 原生的 `thinkingLevelMap` / `supportedReasoningEfforts`，不需要 HiAi 侧注入请求体，故不放宽 `lobsterai-options-v1` 的语义。
- **门槛放宽范围**（U-4）：放宽 `canConfigureModelThinking` 会同时影响**所有自配 provider**，不只是 Ollama。这是特性上的自然结果（它们的数据结构完全同构），但需显式确认后再实现。

## 6. 验收标准

| 编号 | 验收标准 | 验证方式 |
| --- | --- | --- |
| AC-1.1 | 勾选「支持思考输出」的 Ollama 模型，模型选择器出现思考模式菜单 | 手动（配置 Ollama → 勾选 → 选中该模型） |
| AC-1.2 | 未勾选的 Ollama 模型不显示思考入口 | 手动 |
| AC-1.3 | 开启档位后 `openclaw.json` 中该模型含 `reasoning: true` 与 `thinkingLevelMap`，且 `compat.supportedReasoningEfforts` 为 `['low','medium','high']` | 单元测试（`openclawConfigSync.runtime.test.ts` 既有断言扩展到 Ollama）+ 抓包看 `sessions.patch` |
| AC-1.4 | 官方源既有行为不变（仍需 `lobsterai-options-v1`） | 既有测试全绿 + 手动抽查官方源模型 |
| AC-2.1 | 档位仅四档，不出现「最大」 | 手动 |
| AC-2.2 | 每个模型各自记忆档位；模型取消能力声明后回落默认档而不报错 | 手动 |
| AC-3.1 | 思考内容在会话中以 thinking 块展示 | 手动（需 Ollama 侧模型确实回传 reasoning 字段，见 U-3） |
| AC-4.1 | 改动文件在 CI 同款 eslint（`--max-warnings 0`）下通过，`tsc --noEmit` 与 `npm test` 无回归 | 命令行 |

## 7. 涉及文件

见 5.1 落点表（实现时以符号名为准）。

## 8. 未决项（实现前必须确认）

| 编号 | 未决项 | 影响 | 需要的前置信息 |
| --- | --- | --- | --- |
| U-1 | **Ollama 各模型对思考参数的实际接受度** | 决定 FR-3 能否成立 | ✅ **已实测**（见 8.1）：协议层接受 `reasoning_effort`，模型不支持时明确报错 |
| U-2 | **Ollama 默认模型是否默认勾选 `supportsThinking`** | 体验 vs 安全 | ✅ **已有更好答案**（见 8.1）：`/api/show` 暴露 `capabilities`，可自动判定，倾向按能力声明而非硬编码 |
| U-3 | **思考内容回传字段**：Ollama 返回 `reasoning` 还是 `reasoning_content`、是否分块 | 决定 AC-3.1 能否通过 | ⏳ **仍缺**：本机无可思考模型，需 `ollama pull` 一个思考模型后流式抓包（见 8.1 验证配方） |
| U-4 | **门槛放宽的影响范围**：`canConfigureModelThinking` 放宽后所有自配 provider 都会出现思考菜单 | 是否只给 Ollama 开特例 | 产品决策：特性对所有自配 provider 一视同仁，还是仅 Ollama |

### 8.1 Ollama 实测结论（2026-10-16，Ollama 0.40.4 / macOS）

验证环境：本地 `http://localhost:11434`，模型 `baihua:latest`（gemma4 系）与 `hf.co/mradermacher/Baihua-Gemma4-E4B-GGUF:Q4_K_M`（均为**不支持思考**的模型）。

| 验证项 | 结果 |
| --- | --- |
| OpenAI 兼容层是否接受 `reasoning_effort` 参数 | **接受**。`low/medium/high/max` 四档均未报「未知参数」，请求被正常路由 |
| 模型不支持思考时的行为 | **直接 400**：`{"error":{"message":"\"baihua:latest\" does not support thinking","type":"invalid_request_error"}}` |
| 不带 `reasoning_effort` 的普通请求 | 正常，`message` 仅含 `content` / `role` |
| `/api/show` 是否暴露能力元数据 | **是**。`capabilities: ["tools","completion","vision","audio"]`——不支持思考的模型**不含** `thinking` 项 |
| 思考内容回传字段（`reasoning` / `reasoning_content`、是否分块） | **无法验证**：本机无支持思考的模型 |

**结论与影响**：

1. **FR-3 四档映射在协议层成立**（Ollama 接受 `reasoning_effort`），无需为 Ollama 另设参数通道。
2. **「错声明会破坏请求」得到实测印证**：一旦对不支持思考的模型声明 `supportsThinking`，网关会下发 `reasoning_effort`，Ollama 直接返回 400 整轮失败——这与 `dshConfigSync.ts` 「宁可不声明，也不要错声明」的既有立场一致，也说明 U-2 必须走**能力判定**而非默认勾选。
3. **U-2 的推荐方案改为能力探测**：新增「从 Ollama 拉取模型能力」的只读通道（`/api/show` 的 `capabilities` 含 `thinking`），据此自动写入 `models[].supportsThinking`，而不是在 `PROVIDER_REGISTRY.defaultModels` 里硬编码。该方案同时解决 U-4 的体验问题（LM Studio 等同理），但需新增一次网络/本地端口请求，需确认是否值得（见 U-2 的决策点）。
4. **U-3 的验证配方**（有思考模型后执行）：
   ```bash
   ollama pull qwen3:4b   # 任一确认支持 thinking 的模型
   curl -N http://localhost:11434/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"qwen3:4b","messages":[{"role":"user","content":"9.11和9.8哪个大？先思考"}],"stream":true,"reasoning_effort":"medium"}'
   ```
   逐 chunk 检查 `delta` 中出现的是 `reasoning` 还是 `reasoning_content`，以及是否与 `content` 分离。

## 9. Mock 台账

本需求**不引入 mock**：思考能力声明、档位映射与下发链路均复用既有真实实现（`buildCustomModelThinkingConfig`、`openclawConfigSync`、`openclawModelThinkingLevels`）。

U-1 / U-3 涉及的「Ollama 实际行为」在实现前若用假响应代替实测结论，须在本节登记（位置、形态、前置条件），并在拿到真实响应后删除登记。
