# 去会员理念改造设计文档

> 本文是《去服务端依赖改造设计文档》（`specs/refactors/de-server-dependency/2026-10-13-de-server-dependency-design.md`）的**子文档**，对应其 FR-5 的拆解与细化。
>
> 关系说明：FR-5 是"移除商业壳"的**实现条目**；本文是"去会员"的**理念定义 + 完整边界 + 收口口径**。本文档**先于实现**产出，用于在动刀前把术语、边界、依赖与验收固定下来。

---

## 1. 问题定义

### 1.1 谁在什么场景下遇到什么问题

| 角色 | 场景 | 现状痛点 |
| --- | --- | --- |
| 个人离线用户 | 无 LobsterAI 服务端、无登录，使用本地 provider 完成对话/生图 | 应用内到处是"订阅/加油包/积分/升级/企业套餐"的入口与文案，点击后跳转到不可达的 Portal 页面 |
| 个人离线用户 | 语音输入、媒体生成、分享/部署等功能 | 部分入口以"订阅会员"为门控（如 `mediaSubscriptionRequired` 文案），与实际"本地自有 provider 可用"的能力矛盾 |
| 维护者 | 阅读/修改代码 | "会员"语义在三个维度上混用（见 1.3），无法判断某个 `subscriptionStatus` 判断该不该留 |

### 1.2 现状：三个被混称为"会员"的概念

代码里被笼统叫作"会员"的东西，实际是三个不同维度，必须先拆开：

| 维度 | 载体 | 语义 | 去留判断 |
| --- | --- | --- | --- |
| **A. 订阅权益** | `AuthSubscriptionStatus`（`free`/`active`/`enterprise`）、`hasPublishingEntitlement`、`shareEntitled`/`deploymentEntitled` | 付费订阅用户才能用分享/部署等云端能力 | **移除**（该能力本身由 FR-4 关闭） |
| **B. 积分/额度** | `NormalizedAuthQuota`（`creditsLimit/Used/Remaining`、`hasPaidCredits`）、`asrQuotaSlice`、`siteQuota`、低积分加油包 offer | 计量与售卖单位，用于计费与额度控制 | **移除**（本地 provider 无服务端计量） |
| **C. 企业成员资格** | `EnterpriseAccountMode`、`membershipRevocation`、`EnterpriseMembershipRevoked` | 企业 RBAC：成员/超管、企业积分池、成员额度 | **移除**（无服务端即无企业账号） |

> 注意：C 里的英文 `membership` 指"企业成员资格"，**不是**付费会员。历史上三者共用"会员/套餐"中文文案，是本次混乱的根源。

### 1.3 现状痛点清单（可核验事实）

1. `resolveMediaGenerationAccess`（`src/renderer/features/enterpriseAccount/mediaAccess.ts:43`）已无订阅门控、无登录门控，**仅剩企业上下文/企业配额校验** —— 即"媒体功能已本地化，但代码仍挂在企业账号目录下"。
2. `mediaSubscriptionRequired`（`src/renderer/services/i18n.ts:2570`）文案「媒体生成为订阅会员专属权益」**已与实现矛盾**（媒体生成走本地 provider）。
3. 加油包逻辑仍完整存活：`lowCreditPurchaseOffer.ts`、`lowCreditPurchaseAnalytics.ts`、主进程 `activateLowCreditPurchaseOffer`（`main.ts:7390`）。
4. 订阅恢复、试用活动、banner 三条独立链路仍挂在 `auth.ts` 与 `main.ts` 的启动与登录流程上。
5. 请求头注入 `X-LobsterAI-Account-Mode` / `X-LobsterAI-Enterprise-Id` 由 `buildEnterpriseAccountRequestHeaders`（`src/main/enterpriseAccount/context.ts:267`）构造，在 `openclawTokenProxy.ts` 注入 —— 随 FR-1（P0 已落地）后，该注入点已无实际调用场景。

---

## 2. 概念模型（术语统一）

本节定义"去会员"之后的领域术语。实现阶段**一律以本表术语为准**，不再使用"会员/套餐/加油包"等旧词。

| 术语 | 定义 | 对旧概念的替代关系 |
| --- | --- | --- |
| **本地 provider** | 用户自行配置的 LLM / 图片 / 视频 / 语音推理来源（Ollama、LM Studio、OpenAI 兼容端点、MiniMax、sherpa-onnx 侧车） | 取代"套餐模型"`modelGroupServer` |
| **计费** | 由用户自有 provider 与其上游账单承担，应用内**不做任何计量展示** | 取代"积分/额度/加油包" |
| **权益门控** | 仅剩两类：① 本地能力是否已配置可用；② 编译期 feature flag（如分享/部署开关） | 取代"订阅门控" |
| **登录态** | 仅是本地会话残留清理对象，不代表任何权益 | 取代"会员身份" |

**状态机（去会员后）**：

```
应用启动
  ├─ 读取本地 provider 配置
  │    ├─ 已配置 → 对应能力可用
  │    └─ 未配置 → 对应入口提示"未配置"，不引导付费、不引导登录
  └─ 读取编译期 feature flag
       ├─ flag=on  → 入口可见（本期分享/部署均为 off）
       └─ flag=off → 入口不可见
```

> 不再存在 `free / active / enterprise` 这类驱动 UI 与门控的账号状态。

---

## 3. 用户旅程

### 3.1 主流程（去会员后）

| 步 | 用户动作 | 系统响应 |
| --- | --- | --- |
| 1 | 启动应用 | 无登录、无 banner、无活动弹窗、无"试用"浮层 |
| 2 | 打开设置 | 只看到 provider 配置（LLM / 图片 / 视频）、本地模型等；无"当前套餐/积分余额/充值/订阅" |
| 3 | 配好 provider 并发起对话 | 直接可用；积分耗尽类 banner 与"升级套餐"链接不再出现 |
| 4 | 生图/生视频 | 走本地 provider；无"订阅会员专属"提示 |
| 5 | 语音输入 | 走本地 sherpa-onnx 侧车（FR-3）；无"今日额度/升级订阅"提示 |

### 3.2 异常/边界流程

| 场景 | 处理 |
| --- | --- |
| 用户未配任何 provider | 入口提示"未配置"，指向设置页；**不引导登录/付费** |
| 历史升级用户本地残留登录态与订阅缓存 | 首次启动检测并静默清理（见 §7 U-5 口径） |
| 历史数据含 `subscriptionStatus === 'enterprise'` | 按"无此状态"处理，不报错、不进入任何企业分支 |
| 历史数据含企业上下文（`X-LobsterAI-*` 相关持久化） | 清理持久化的企业上下文 kv |

---

## 4. 需求规格

### 4.1 功能清单

- **RM-1** 删除订阅状态驱动的一切 UI 与门控（维度 A）。
- **RM-2** 删除积分/额度/加油包的一切展示与逻辑（维度 B）。
- **RM-3** 删除企业账号、企业配额、企业撤销、请求头注入（维度 C）。
- **RM-4** 删除订阅试用活动、banner、活动客户端、订阅恢复链路。
- **RM-5** 清理所有"会员/套餐/加油包/积分/充值/升级"相关 i18n 键（中英文）。
- **RM-6** 清理旧登录态、订阅缓存、企业上下文的本地持久化数据。
- **RM-7** 明确"计费/额度"归零后的替代口径：应用内不展示任何计量。
- **RM-8（已决）** 移除登录能力：登录入口、登录流程、token 存储与刷新、会话管理（见 §11 D1）。

### 4.2 验收标准

| 编号 | 验收标准 | 验证方式 |
| --- | --- | --- |
| AC-RM-1 | 全局搜索 `AuthSubscriptionStatus` 无生产代码引用 | `rg "AuthSubscriptionStatus" src --glob '!*.test.ts'` 为空 |
| AC-RM-2 | 全局搜索无 `creditsLimit` / `hasPaidCredits` / `purchaseOffer` 生产引用 | 同上 |
| AC-RM-3 | `src/main/enterpriseAccount/`、`src/renderer/features/enterpriseAccount/` 目录不存在 | 目录检查 |
| AC-RM-4 | 请求头 `X-LobsterAI-Account-Mode` / `X-LobsterAI-Enterprise-Id` 无构造与注入点 | `rg "X-LobsterAI-Account-Mode" src` 为空 |
| AC-RM-5 | i18n 中无 `authSubscribe` / `authTopUp` / `modelSelectorSubscribe*` / `lowCreditOffer*` / `subscriptionTrial*` / `enterpriseQuota*` 等键 | i18n 键全表扫描 |
| AC-RM-6 | 启动无 banner 请求、无试用活动弹窗、无低积分引导 | 手动启动 + 抓包 |
| AC-RM-7 | 应用内任何页面不出现"订阅/会员/套餐/加油包/积分/充值/升级"字样 | 全局文案扫描 |
| AC-RM-8 | 断网 + 无登录，核心功能（对话、生图、语音）正常 | 手动验证 |
| AC-RM-9 | 旧登录态升级：首启后本地无残留 token / 企业上下文 / 订阅缓存 | 带旧数据启动后检查 kv 表 |
| AC-RM-10 | 应用内无登录入口；`auth.ts` 无登录/token 刷新流程 | 代码审查 + 手动启动 |

### 4.3 不做（Non-Goals）

- **不**重做登录能力（已决：登录能力整体移除，见 §11 D1）。
- **不**为"计费"提供任何本地替代方案（不做本地积分统计、不做用量计费、不做成本估算 UI）。
- **不**删除分享/部署的**服务层代码**（由 FR-4.4 决定仅断入口，服务层保留）。
- **不**引入新文档/新模块来"承接"被删能力。
- **不**做数据迁移（旧数据直接清理，不做转换）。

---

## 5. 交互设计（删除后的状态）

| 位置 | 现状（删除前） | 目标（删除后） |
| --- | --- | --- |
| 启动 | 可能有 banner、试用活动、低积分浮层 | 无任何浮层，直接进主界面 |
| 侧栏 | 购买引导、体验槽位（`SidebarExperienceSlot`、`useSidebarAdBanners`） | 无 |
| 账号菜单 | 积分余额、当前套餐、升级、充值、邀请（`accountMenuState`） | 整体移除（登录能力已删，无账号态可展示） |
| 模型选择器 | "套餐模型"分组、锁定浮层、"订阅解锁更多模型"（`modelSelectorLockedOverlay`） | 只列用户已配置的 provider 模型 |
| 对话消息 | 积分耗尽 banner + 加油包 offer（`AssistantTurnBlock`） | 无 |
| 媒体选择器 | 企业上下文校验（`resolveMediaGenerationAccess`） | 无门控，直接读本地媒体模型 |
| 设置页 | 可能含订阅状态、企业信息 | 只含 provider / 本地模型配置 |
| 分享/部署入口 | 订阅门控弹窗（`ArtifactSubscriptionPromptDialog`） | 入口由 feature flag 关闭，不可见 |
| 语音输入 | "今日额度用尽，升级订阅"（`voiceInputQuota*`） | 只提示"本地模型不可用"（FR-3.6） |

---

## 6. 架构设计

### 6.1 删除顺序（自底向上，与 FR-5 一致）

> 依赖原则：先断服务端调用 → 再删 IPC → 再删 Redux/服务 → 最后删 UI。否则会留下悬空引用。

| 序 | 层 | 内容 | 对应 FR-5 |
| --- | --- | --- | --- |
| 1 | 服务端调用 | banner/活动、订阅试用、企业 context、quota/profile | FR-5.4、FR-5.1 |
| 2 | 主进程 IPC | `ipcHandlers/subscriptionTrial.ts`、banner handlers、`enterpriseAccount/*` handlers | FR-5.1、FR-5.4 |
| 3 | 主进程模块 | `enterpriseAccount/`、`authQuota.ts`、`activityClient.ts`、请求头注入 | FR-5.1~5.3 |
| 4 | 共享层 | `AuthSubscriptionStatus`、`shared/enterpriseAccount/*`、`shared/subscriptionTrial/*` | FR-5.3 |
| 5 | 渲染进程服务 | `features/enterpriseAccount/`、`publishingSubscriptionRecovery.ts`、`lowCreditPurchase*` | FR-5.3、FR-5.5 |
| 6 | Redux | `authSlice` 的 credits/quota/purchaseOffer/profileSummary、`asrQuotaSlice`、`enterpriseAccountSlice` | FR-5.3 |
| 7 | UI 组件 | banner/试用/浮层/账号菜单/模型选择器订阅分组/积分 banner/订阅门控弹窗 | FR-5.3、FR-5.4 |
| 8 | i18n | 中英文全部"会员/订阅/积分/套餐/加油包"键 | FR-5.3 |
| 9 | 本地数据 | 旧 token、企业上下文、订阅缓存 kv | 边界情况 |

### 6.2 模块归属调整

- `resolveMediaGenerationAccess` 位于 `features/enterpriseAccount/mediaAccess.ts`，但语义已与"企业"无关（FR-2.6 后仅剩企业校验，而企业校验本身也要删）。**删除该函数与文件**，`MediaModelPicker` 直接读本地媒体模型（取消访问判定层）。
- `authSlice`（已决）："登录态"与"订阅/积分态"**一并整体删除**（登录能力已移除，见 §11 D1），不存在拆分保留问题。

### 6.3 与去服务端依赖的边界

| 事项 | 归属 |
| --- | --- |
| LLM 直连 provider、token proxy 条件化 | FR-1（已落地），本文档不重复 |
| 媒体 provider 本地化 | FR-2（已落地），本文档只收尾门控 |
| 语音 SenseVoice 化 | FR-3（未开工），其 `asrQuotaSlice` 删除与本文档 RM-2 重叠，需协调 |
| 分享/部署入口关闭 | FR-4（未开工），其订阅门控弹窗删除与本文档 RM-1 重叠，需协调 |

> **重叠项必须明确归属**：`asrQuotaSlice` 建议归 FR-3 一并删（避免两次动同一处）；订阅门控弹窗建议归本文档 RM-1（因 FR-4 只断入口，不删门控组件）。

---

## 7. 未决项（实现前必须确认）

| 编号 | 未决项 | 影响 | 建议 |
| --- | --- | --- | --- |
| ~~U-5~~（承接） | ~~升级场景：是否清理旧登录态与相关 kv~~ **已决**：清理（token、企业上下文、订阅缓存全部清除；登录能力整体移除，见 §11 D1） | — |
| ~~M-1~~ | ~~登录能力本身是否保留~~ **已决**：**不保留**，登录能力整体移除（见 §11 D1） | — |
| ~~M-2~~ | ~~`asrQuotaSlice` 删除归属~~ **已决**：归 FR-3 一并删除，本文档不涉及（见 §11 D2） | — |
| ~~M-3~~ | ~~企业账号删除是否需保留只读迁移~~ **已决**：不做迁移，直接清理（与 §4.3 Non-Goals 一致，见 §11 D3） | — |
| ~~M-4~~ | ~~分享/部署服务层是否随之删除~~ **已决**：保留服务层（与 FR-4.4 一致：仅断入口、feature flag 关闭，服务层代码不在本次范围，见 §11 D3） | — |

---

## 8. 涉及文件（按删除顺序）

### 8.1 主进程

- `src/main/main.ts`（订阅缓存 `cachedSubscriptionStatus`、gate 同步、banner IPC、企业撤销挂载、`activateLowCreditPurchaseOffer`、启动预热 quota 分支）
- `src/main/authQuota.ts`（+ `authQuota.test.ts`）—— 整文件
- `src/main/enterpriseAccount/`（整目录，含 `context.ts`、`membershipRevocation.ts` + 测试）
- `src/main/ipcHandlers/enterpriseAccount/`（整目录）
- `src/main/ipcHandlers/subscriptionTrial.ts`（+ 测试）
- `src/main/ipcHandlers/activity/handlers.ts`
- `src/main/libs/activity/activityClient.ts`（+ 测试）
- `src/main/libs/openclawTokenProxy.ts` —— 整文件删除（登录与企业移除后无调用方，见 §11 D1）
- `src/main/libs/authSessionManager.ts`（+ 测试）—— 整文件删除（含 `NotMember` 登出分支，见 §11 D1）
- `src/main/libs/startupCacheWarmup.ts`（quota gate 预热部分）
- `src/main/libs/coworkTurnUsage.ts`（credits 日志）
- `src/main/i18n.ts`（企业/套餐/积分错误文案）
- `src/main/preload.ts`（banner / subscriptionTrial 桥接）
- `src/main/libs/endpoints.ts`（`getPortalTasksUrl`）

### 8.2 渲染进程

- `src/renderer/store/slices/authSlice.ts`（订阅/积分态）
- ~~`src/renderer/store/slices/asrQuotaSlice.ts`~~ —— 归 FR-3 一并删除，不在本文档范围（见 §11 D2）
- `src/renderer/store/index.ts`（`enterpriseAccount` reducer 挂载）
- `src/renderer/services/auth.ts`（订阅/企业/quota 判定）
- `src/renderer/services/analyticsIdentity.ts`（+ 测试）
- `src/renderer/services/publishingConversionAttribution.ts`（+ 测试）
- `src/renderer/services/publishingSubscriptionRecovery.ts`（+ 测试）
- `src/renderer/services/lowCreditPurchaseOffer.ts`、`lowCreditPurchaseAnalytics.ts`
- `src/renderer/services/endpoints.ts`（会员类 URL）
- `src/renderer/features/enterpriseAccount/`（整目录）
- `src/renderer/components/artifacts/artifactSubscriptionGate.ts`（+ 测试）、`ArtifactSubscriptionPromptDialog.tsx`
- `src/renderer/components/SubscriptionTrialCampaign.tsx`、`subscriptionTrialPopupState.ts`、`subscriptionTrialAnalytics.ts`、`subscriptionTrialCampaign.css`
- `src/renderer/components/useSidebarAdBanners.ts`、`SidebarExperienceSlot.tsx`
- `src/renderer/components/useSidebarPurchaseGuide.ts`、`sidebarPurchaseGuideState.ts`
- `src/renderer/components/CreditsResetCampaignFloat.tsx`
- `src/renderer/components/modelSelector/useModelPurchaseOffer.ts`
- `src/renderer/components/cowork/AssistantTurnBlock.tsx`（积分耗尽 banner 段）
- `src/renderer/components/cowork/MediaModelPicker.tsx`（访问判定层）
- `src/renderer/services/i18n.ts`（会员文案）
- `src/renderer/types/electron.d.ts`（banner/subscriptionTrial 桥接类型）

### 8.3 共享层

- `src/shared/auth/constants.ts`（`AuthSubscriptionStatus`、banner IPC 通道）
- `src/shared/enterpriseAccount/`（整目录）
- `src/shared/subscriptionTrial/constants.ts`
- `src/shared/publishing/constants.ts`（`PublishingSubscriptionRecoveryMode`）
- `src/shared/analytics/constants.ts`（订阅类事件）
- `src/shared/site/constants.ts`、`src/shared/shareDeployment/constants.ts`、`src/shared/library/types.ts`（`subscriptionRecoveryMode` 字段）

---

## 9. Mock 台账

本次改造**不引入 mock**。删除类改造无新增外部依赖；若实现期需要临时保留桩以便分步验证，须在本节登记（位置、形态、前置条件、清理条件）。

| 编号 | 位置 | 内容与形态 | 为什么先 mock | 替换为真实实现的前置条件 | 关联 |
| --- | --- | --- | --- | --- | --- |
| MOCK-1 | `src/main/main.ts`（代码内标记 `MOCK: asr-stub-getAuthTokens`） | `registerAsrIpcHandlers({ getAuthTokens: () => null, ... })`，登录移除后无 token 可供，所有 ASR 处理器快速失败（Unauthorized） | ASR 服务端会话依赖已移除的登录后端；ASR 能力整体归 FR-3 删除，本文档不重复处理 | FR-3 落地，删除整个 ASR 服务端注册块（含该注册与 `MOCK:` 标记） | FR-3 |

---

## 10. 验收单（对照 §4.2 逐条打勾）

> 实现完成后回填。每条须给出证据（命令输出 / 截图 / 日志片段）。

| 编号 | 结论 | 证据 |
| --- | --- | --- |
| AC-RM-1 | ☐ | |
| AC-RM-2 | ☐ | |
| AC-RM-3 | ☐ | |
| AC-RM-4 | ☐ | |
| AC-RM-5 | ☐ | |
| AC-RM-6 | ☐ | |
| AC-RM-7 | ☐ | |
| AC-RM-8 | ☐ | |
| AC-RM-9 | ☐ | |
| AC-RM-10 | ☐ | |

---

## 11. 已关闭决策（2026-10-14）

**D1：登录能力不保留，整体移除** —— 登录入口、登录流程、token 存储与刷新、会话管理全部移除；`authSlice` 的登录态与订阅/积分态一并整删。连带影响：
- `openclawTokenProxy.ts` 整文件删除：FR-1 后其启动已条件化为"仅 `getAuthTokens()` 为真"，登录移除后 `getAuthTokens()` 恒为假，`main.ts` 调用点与模块本身均无存在意义。
- `src/main/libs/authSessionManager.ts` 整文件删除（含 `NotMember` 服务端登出分支）。
- `src/main/auth/authQuota.ts`（依赖登录态）整文件删除，已在 §8.1 列出。
- 边界情况"旧用户已有登录态"：启动时清理本地 token 与订阅缓存，不做迁移。
- FR-1 的条件化逻辑（`getOpenClawTokenProxyPort()` 返回 `null`）退化为"永不启动"，无需改动，随模块删除自然消失。

**D2：重叠归属** —— `asrQuotaSlice` 及语音额度逻辑（`voiceInput/quota.ts`、`AsrRealtimeSessionData` 配额字段）归 **FR-3 一并删除**（本地推理无配额概念），本文档不再涉及；订阅门控弹窗（`ArtifactSubscriptionPromptDialog`、`artifactSubscriptionGate.ts`）归**本文档 RM-1** 删除（FR-4 仅断入口、保留服务层，不删门控组件）。

**D3：剩余未决项闭合（2026-10-14）** —— M-3：企业历史数据**不做迁移**，直接清理（与 §4.3 Non-Goals「不做数据迁移」一致）；M-4：分享/部署**服务层保留**，与 FR-4.4 一致（仅断入口、feature flag 关闭，服务层删除与否由未来需求决定）。至此 §7 未决项全部闭合，可开工。
