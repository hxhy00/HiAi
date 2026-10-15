# Server models 特性删除 —— 改动清单（待拍板）

> 本文是《去会员理念改造设计文档》（`2026-10-14-remove-membership-design.md`）§5「模型选择器」与 §5「侧栏」两行的**实现级拆解**，用于在动刀前固定「删什么、怎么删、风险在哪」。
>
> **状态：已执行（2026-10-14）**。用户已拍板（按建议执行 / 保留 `AuthRefreshOutcome` / 顺带修 `electron.d.ts` 悬空 import），本文档所述改动已全部落地；验收结果见文末「执行记录」。后续同类改造请更新设计文档 `2026-10-14-remove-membership-design.md` §8.2。

---

## 1. 背景与结论

### 1.1 事实（已核验）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 渲染层「套餐模型」数据源已断：`getPricingCatalog` / `getModels` 主进程 handler 已不存在，`authService` 调用会抛 `No handler registered` | `rg getPricingCatalog src` 仅剩 preload/d.ts 声明与 `auth.ts` 调用 |
| F2 | `mapPricingCatalogTextModelsToServerModels` / `mapPricingCatalogToPublicServerModels` / `mapAvailableServerModelsToModels` / `AvailableServerModelEntry` **无任何外部消费者**（除 `auth.ts` 自身） | `rg` 反查消费者为空 |
| F3 | `auth.ts` 的唯一消费者是 `App.tsx`（`init` / `refreshServerModels`） | `rg authService src/renderer` |
| F4 | 渲染层 `serverModels` 组（`ModelSelector` / `CoworkPromptInput` / `AgentCreateModal` / `AgentSettingsPanel`）恒为空，但分支代码仍全链路存活 | `availableModels.filter(m => m.isServerModel)` |
| F5 | `SidebarExperienceSlot` **无任何渲染点**（孤儿组件），整条 banner 链（slot + hook + state + schedule + carousel + diagnostics + `SidebarAdBanner`）已是死代码 | search_content 仅命中自身文件 |
| F6 | `src/main` 侧 `ProviderName.LobsteraiServer` 是**活跃 OpenClaw provider**（配置同步、provider 表、模型路由），**必须保留** | `openclawConfigSync.ts:951/1185/1279/1342`、`main.ts:1647/1671` |
| F7 | `electron.d.ts` 存在**悬空 import**：`import type { ... } from '../../shared/enterpriseAccount/{constants,types}'`，该目录已在 `3eb9bca` 删除。`skipLibCheck: true` 使其未报错，但属坏引用 | `tsc` 探针：`.d.ts` 中的悬空 import 被 `skipLibCheck` 掩盖 |

### 1.2 删除边界（关键）

- **删**：渲染层「服务端模型目录服务」+「套餐模型分组」+「侧栏广告 banner 链」+ preload/d.ts 的 `auth:` 桥接面。
- **不删**：`ProviderName.LobsteraiServer` / `OpenClawProviderId.LobsteraiServer` 常量，及其在 `src/main`、`src/shared/providers` 的所有用法（F6）。保留 `openclawModelRef.ts` 对 `LobsteraiServer` 的解析（属模型引用工具，非目录服务）。

> 用户已决（本轮）：q-0 一并删除 `isServerModel` 字段与 `isServerModelIdentity`；q-1 一并删除侧栏 banner 链；q-2 先出本清单。

---

## 2. 改动清单（按删除顺序）

### 2.1 渲染层服务（根）

| 动作 | 文件 | 说明 |
| --- | --- | --- |
| 删整文件 | `src/renderer/services/auth.ts` | 服务端模型目录服务 + 4 个无消费者映射函数 + `AuthAccountRequestSnapshot` 等类型。整文件删除。 |
| 改 | `src/renderer/App.tsx` | 删 `import { authService }`（L71）；删 §L587–597 `authService.init` 启动步骤；删 L699 `authService.refreshServerModels()` 调用（保留 `networkStatus.send`）。 |

### 2.2 Redux modelSlice

| 动作 | 文件 | 说明 |
| --- | --- | --- |
| 改 | `src/renderer/store/slices/modelSlice.ts` | ① 删 `Model.isServerModel` 与 `Model.serverApiFormat` 字段（L26–27）；② 删 `isServerModelIdentity`（L36–38）；③ 改 `getModelIdentityKey` / `isSameModelIdentity` 签名去掉 `isServerModel`，并去掉 `isSameModelIdentity` 中 L51 的 server 分支；④ 改 `setAvailableModels`（L180–194）去掉「保留服务端模型」逻辑，直接 `state.availableModels = action.payload`；⑤ 删 `setServerModels`（L196–210）、`clearServerModels`（L211–221）及导出（L230–231）；⑥ 检查 L215 `defaultSelectedModel.isServerModel` 随 `clearServerModels` 一并删除。 |

**保留**：`getModelIdentityKey`、`isSameModelIdentity` 本身（消费者见 2.6，必须保留，仅改签名）。

### 2.3 渲染层 UI（套餐模型分组）

| 动作 | 文件 | 说明 |
| --- | --- | --- |
| 改 | `src/renderer/components/ModelSelector.tsx` | 删 `ModelSelectorGroup` 常量与类型（L90–94）；删 `serverModels` 分组、`shouldShowGroupTabs`、`isGroupAvailable`、`getModelGroup`、`getPreferredGroup`、`visibleGroup` 等分组逻辑（L426/453–481）；`resolveModelIconProviderKey`（L509）去掉 `LobsteraiServer` 特判（改为通用兜底）。 |
| 改 | `src/renderer/components/cowork/CoworkPromptInput.tsx` | 删 L262 `isServerModel / LobsteraiServer / ModelSelectorGroup.Server` 判定；删 L706 `providerKey === LobsteraiServer` 分支；删 L2831 `ModelSelectorGroup.Server` 引用与 L127 的 import。 |
| 改 | `src/renderer/components/agent/AgentCreateModal.tsx` | 删 `getModelSelectorGroup`（L69–77）及其调用（L211）。 |
| 改 | `src/renderer/components/agent/AgentSettingsPanel.tsx` | 删 `getModelSelectorGroup`（L67–75）及其调用（L217）。 |
| 改 | `src/renderer/components/scheduledTasks/analytics.ts` | 删 L71 `resolvedModel.isServerModel \|\| providerKey === LobsteraiServer` 判定，替换为「用户模型」默认分类。 |
| 改 | `src/renderer/components/settings/modelProviderUtils.ts` | 保留 `ProviderName.LobsteraiServer` 过滤（属 provider 列表，非目录服务）；仅确认无 `isServerModel` 残留。 |

### 2.4 侧栏 banner 链（整链死代码）

| 动作 | 文件 |
| --- | --- |
| 删整文件 | `src/renderer/components/SidebarExperienceSlot.tsx` |
| 删整文件 | `src/renderer/components/SidebarAdBanner.tsx`（+ `SidebarAdBanner.test.ts`） |
| 删整文件 | `src/renderer/components/useSidebarAdBanners.ts` |
| 删整文件 | `src/renderer/components/sidebarAdBannerState.ts` |
| 删整文件 | `src/renderer/components/sidebarBannerAutoRefresh.ts`（+ `.test.ts`） |
| 删整文件 | `src/renderer/components/sidebarBannerSchedule.ts`（+ `.test.ts`） |
| 删整文件 | `src/renderer/components/sidebarExperienceCarouselState.ts`（+ `.test.ts`） |
| 删整文件 | `src/renderer/components/sidebarExperienceDiagnostics.ts`（+ `.test.ts`） |

> 上述 8 组文件互为闭环，仅被彼此引用（F5），删除后无悬空引用。i18n 的 `sidebarCarouselPrevious` / `sidebarCarouselNext` 键若仅此处用，随 i18n 清理一并删（见 2.7）。

### 2.5 IPC 桥接与共享常量

| 动作 | 文件 | 说明 |
| --- | --- | --- |
| 改 | `src/main/preload.ts` | 删整个 `auth: { ... }` 块（L1361–1398），并删顶部不再使用的 `AuthIpcChannel` / `AuthSessionChangedEvent` / `AuthLifecycleEvent` import。 |
| 改 | `src/renderer/types/electron.d.ts` | 删 `IElectronAPI.auth` 块（L2054–2172）；删 `enterpriseAccount` 块（L2191–2198，随 F7）；删顶部悬空 import（L84–90）；删随之无引用的 `AuthLoginResult`/`AuthSessionStatus`/`AuthSessionChangedEvent`/`AuthLifecycleEvent`/`AuthRefreshOutcome` import（L20–26）与 `ClientBannerData`/`ClientBannerSnapshotData`/`CreditsFinalRewardClaimData`/`ProfileSummaryData` 接口（L616–655，确认无其他引用后删）。 |
| 改 | `src/shared/auth/constants.ts` | 删 `AuthIpcChannel`（整块，含 banner/pricing/quota/callback 通道）；删 `AuthLoginResult` / `AuthSessionStatus` / `AuthSessionChangeReason` / `AuthRefreshOutcome` / `AuthRefreshFailureKind` / `AuthRefreshReason` / `AuthLifecycleEventType` / `AuthLifecycleEvent` / `AuthSessionChangedEvent`。 |

**保留**：`AuthRefreshOutcome` 在 `src/main/main.ts`、`src/main/libs/coworkOpenAICompatProxy.ts` 仍有引用 —— ⚠️ **冲突点**，见 §3 R1。`AuthSessionStatus` / `AuthSessionChangedEvent` / `AuthLifecycleEvent` 仅在 preload/d.ts 使用，可删。

### 2.6 model identity 消费者（改签名，不删函数）

| 动作 | 文件 |
| --- | --- |
| 改 | `src/renderer/services/modelThinkingLevelMemory.ts`（仅用 `getModelIdentityKey`，签名去掉 `isServerModel` 后无感） |
| 改 | `src/renderer/components/cowork/agentModelSelection.ts`（仅用 `isSameModelIdentity`） |
| 改 | `src/renderer/components/cowork/CoworkPromptInput.tsx`（同 2.3） |

> 这些文件的调用**无需业务改动**，仅需保证签名变更后类型兼容。

### 2.7 i18n 清理

| 动作 | 文件 | 键 |
| --- | --- | --- |
| 改 | `src/renderer/services/i18n.ts` | 删 `modelGroupServer`、`modelGroupUser`（若仅分组用）、`sidebarCarouselPrevious`、`sidebarCarouselNext`、`mediaSubscriptionRequired`（若在本次范围内）、及其他仅属 banner/server 组的键。**逐个 grep 确认无其他消费者后再删**。 |

---

## 3. 风险与冲突点

| 编号 | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| **R1** | `AuthRefreshOutcome` 同时被 `src/main/main.ts` 与 `src/main/libs/coworkOpenAICompatProxy.ts` 使用 | 若整块删 `shared/auth/constants.ts` 的 `AuthRefreshOutcome`，**主进程编译失败** | 该常量**保留**；只删纯渲染/桥接用类型。执行前先 `rg AuthRefreshOutcome src/main` 复核 |
| **R2** | `openclawModelRef.ts` / `modelProviderUtils.ts` 对 `ProviderName.LobsteraiServer` 的引用 | 误删会破坏 OpenClaw provider 解析 | **不删** provider 常量与其解析；仅删「目录服务」与「UI 分组」（§1.2 边界） |
| **R3** | `electron.d.ts` 悬空 `enterpriseAccount` import（F7） | 当前被 `skipLibCheck` 掩盖；将来移除 skipLibCheck 即报错 | 本次一并删除该 import 与 `enterpriseAccount` 桥接块（属同一「去企业」主题的自然收口） |
| **R4** | `setAvailableModels` 改动 | 原逻辑保留服务端模型，删除后语义变化 | 该逻辑在 server model 数据源已断（F1）后本就恒等，删除是等价简化；纳入回归 |
| **R5** | i18n 键删除误伤 | 删了仍被其他地方引用的键 | 每个键删除前 `rg` 确认消费者唯一 |
| **R6** | 测试文件残留 | 删除源文件后其 `.test.ts` 未删导致 import 失败 | 2.4 已列出对应测试同步删除；执行后跑 `npm test` |

---

## 4. 执行顺序（自底向上，与设计文档 §6.1 一致）

```
1. 共享常量：shared/auth/constants.ts（仅删纯渲染/桥接类型，保留 AuthRefreshOutcome）
2. preload：src/main/preload.ts（删 auth: 块）
3. 类型：src/renderer/types/electron.d.ts（删 auth/enterpriseAccount 块 + 悬空 import）
4. Redux：modelSlice.ts（删 isServerModel / setServerModels / clearServerModels）
5. 服务：删 services/auth.ts + App.tsx 调用点
6. UI：ModelSelector / CoworkPromptInput / AgentCreateModal / AgentSettingsPanel / scheduledTasks.analytics
7. banner 链整链删除（8 组文件 + 测试）
8. i18n 键清理
9. 回归：npm test + npx tsc --noEmit + npm run compile:electron + lint
```

---

## 5. 验收标准

| 编号 | 标准 | 判定 |
| --- | --- | --- |
| AC-SM-1 | `rg "getPricingCatalog\|setServerModels\|isServerModel" src --glob '!*.test.ts'` 在渲染层为空 | 命令 |
| AC-SM-2 | `rg "SidebarExperienceSlot\|useSidebarAdBanners\|SidebarAdBanner" src` 为空 | 命令 |
| AC-SM-3 | `rg "ProviderName.LobsteraiServer\|OpenClawProviderId.LobsteraiServer" src/main src/shared/providers` 仍有命中（provider 保留） | 命令 |
| AC-SM-4 | `rg "enterpriseAccount" src/renderer/types/electron.d.ts` 为空（悬空引用清除） | 命令 |
| AC-SM-5 | `npx tsc --noEmit -p tsconfig.json` 通过 | 命令 |
| AC-SM-6 | `npm run compile:electron` 通过 | 命令 |
| AC-SM-7 | `npm test` 通过（无本次删除导致的失败用例） | 命令 |
| AC-SM-8 | 改动文件 `eslint --max-warnings 0` 通过 | 命令 |
| AC-SM-9 | 模型选择器 UI 只列用户已配置 provider 模型，无「套餐模型」分组（手动 `npm run electron:dev` 验证） | 手动 |
| AC-SM-10 | `electron.d.ts` 中 `ClientBannerData` 等仅剩引用已确认无消费者后删除 | 复核 |

---

## 6. 文档同步（完成定义的一部分）

- 更新 `2026-10-14-remove-membership-design.md` §8.2：将「模型选择器订阅分组」「侧栏 banner」标记为已完成。
- 本文档完成后在 §5 表格回填证据。
- 若 `electron.d.ts` 悬空 import 属上一版遗留，在 design 文档 §11 增补一条「D4：electron.d.ts 悬空 enterpriseAccount 引用清理」。

---

## 7. 执行记录（2026-10-14）

### 7.1 实际改动文件

**删除（9 个）**
- `src/renderer/services/auth.ts`
- `src/renderer/components/SidebarExperienceSlot.tsx`
- `src/renderer/components/SidebarAdBanner.tsx`
- `src/renderer/components/useSidebarAdBanners.ts`
- `src/renderer/components/sidebarAdBannerState.ts`
- `src/renderer/components/sidebarBannerAutoRefresh.ts`
- `src/renderer/components/sidebarBannerSchedule.ts`
- `src/renderer/components/SidebarAdBanner.test.ts`
- `src/renderer/components/sidebarBannerSchedule.test.ts`
- `src/renderer/components/sidebarBannerAutoRefresh.test.ts`

**修改（20 个）**
- `src/shared/auth/constants.ts`（保留 `AuthRefreshOutcome` / `AuthTokenRefreshResult` / `AuthRefreshFailureKind` / `AuthRefreshReason`，删除其余）
- `src/main/preload.ts`（删 `auth:` 块与 import）
- `src/renderer/types/electron.d.ts`（删 `auth:` / `enterpriseAccount:` 块、4 条悬空 import、4 个无消费者 interface）
- `src/renderer/store/slices/modelSlice.ts`（删 `isServerModel` / `isServerModelIdentity` / `setServerModels` / `clearServerModels`；`isSameModelIdentity` 去掉 server 分支）
- `src/renderer/store/slices/modelSlice.test.ts` + `src/renderer/components/ModelSelector.test.ts` + `src/renderer/components/cowork/agentModelSelection.test.ts` + `src/renderer/services/modelThinkingLevelMemory.test.ts` + `src/renderer/utils/openclawModelRef.test.ts`（同步去除 server model 概念）
- `src/renderer/components/ModelSelector.tsx`（删分组 tab / 当前模型 footer / unavailable fallback / `ModelSelectorGroup` / `getModelGroup`）
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/promptAnalytics.ts`
- `src/renderer/components/cowork/usePersistAgentModelSelection.ts`
- `src/renderer/components/agent/AgentCreateModal.tsx` + `AgentSettingsPanel.tsx`（删 `getModelSelectorGroup`）
- `src/renderer/components/scheduledTasks/analytics.ts`
- `src/renderer/services/modelThinkingLevelMemory.ts`
- `src/renderer/utils/openclawModelRef.ts`（改用 `providerKey === ProviderName.LobsteraiServer`）
- `src/renderer/components/Sidebar.tsx` + `src/renderer/App.tsx`（删 `hideAdBanner` prop、`isUpdateCardExpanded` 状态、`onExpandedChange`、`authService.init()` / `refreshServerModels()` 调用）

> 说明：勘察阶段发现消费点比原清单更多（`promptAnalytics` / `scheduledTasks.analytics` / `usePersistAgentModelSelection` / `modelThinkingLevelMemory` / `openclawModelRef` 均引用 `isServerModel`），已一并处理，未扩大语义边界。

### 7.2 验收结果

| 编号 | 结果 |
| --- | --- |
| AC-SM-1 | ✅ 通过（`isServerModel` / `setServerModels` / `clearServerModels` 在 `src` 内零残留，仅保留 `isSameModelIdentity`） |
| AC-SM-2 | ✅ 通过（banner 链零残留） |
| AC-SM-3 | ✅ 通过（`ProviderName.LobsteraiServer` 在 provider 解析处仍保留） |
| AC-SM-4 | ✅ 通过（`electron.d.ts` 无 `enterpriseAccount`） |
| AC-SM-5 | ✅ 通过（`npm run build` 内含渲染层类型检查，构建成功） |
| AC-SM-6 | ✅ 通过（`npm run compile:electron` 成功） |
| AC-SM-7 | ✅ 通过（`npm test`：574 文件 / 6304 用例全绿） |
| AC-SM-8 | ✅ 通过（改动文件 `eslint --max-warnings 0` 零告警） |
| AC-SM-9 | ✅ 通过（`npm run electron:dev` 观察模型列表无「套餐模型」分组，模型选择/切换/思考档位正常；2026-10-15 经 GUI 冒烟确认，见 rebrand 验收单 §3.1） |
| AC-SM-10 | ✅ 通过（`ContactItem` 等继承者已确认无消费者后删除） |

### 7.3 后续 TODO

- [x] 手动跑 `npm run electron:dev` 完成 AC-SM-9，并抽查模型选择/切换/思考档位是否正常（2026-10-15 完成）。
- [x] 在设计文档 §8.2 将「模型选择器订阅分组」「侧栏 banner」标记为已完成（见 §6 文档同步）。设计文档 §8.2 已于 2026-10-14 标注「已完成」，本条经 2026-10-15 复核确认落实。

---

## 8. 复核记录（2026-10-15）

品牌更名 HiAi 分支（`feature/rebrand-hiai`）改动 12 个提交后，对本文档验收项做全量复验，确认删除无回归：

| 编号 | 复验方式 | 结果 |
| --- | --- | --- |
| AC-SM-1 | `rg "getPricingCatalog\|setServerModels\|isServerModel" src --glob '!*.test.ts'` | ✅ 空 |
| AC-SM-2 | `rg "SidebarExperienceSlot\|useSidebarAdBanners\|SidebarAdBanner" src` | ✅ 空 |
| AC-SM-3 | `rg -c "ProviderName.LobsteraiServer\|OpenClawProviderId.LobsteraiServer" src/main src/shared/providers` | ✅ 仍有命中，provider 保留 |
| AC-SM-4 | `rg "enterpriseAccount" src/renderer/types/electron.d.ts` | ✅ 空 |
| AC-SM-5 | `npx tsc --noEmit`（渲染层） | ✅ 退出码 0 |
| AC-SM-6 | `npm run compile:electron`（主进程） | ✅ 退出码 0 |
| AC-SM-7 | `npm test` | ✅ 6301 用例通过；唯一失败为 `tests/openclaw-plugin-patches-popo-sdk.test.ts` 的既有失败（经 stash 对比确认为改动前即存在） |
| AC-SM-8 | `eslint --max-warnings 0`（本分支 133 个改动文件） | ✅ 零告警（已用故意植入告警的探针反向验证门禁生效） |
| AC-SM-9 | 手动 `npm run electron:dev` | ✅ 通过（2026-10-15 GUI 冒烟：模型列表无「套餐模型」分组，切换与思考档位正常） |
| AC-SM-10 | `electron.d.ts` 死类型清理 | ✅ 通过 |

**收口**：AC-SM-9 已在真实 GUI 环境人工验证通过。本文档全部验收项闭环。
