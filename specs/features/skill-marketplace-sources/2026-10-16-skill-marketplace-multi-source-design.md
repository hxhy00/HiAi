# Skill 市场多源聚合设计（ClawHub / SkillHub / skills.sh）

日期：2026-10-16
状态：已实现（回填式规格）——本文档把已落地代码登记为规格基线，并登记已定位但未修复的缺陷（第 8 章 U-1~U-7）。
关联：`specs/refactors/de-server-dependency/2026-10-13-de-server-dependency-design.md` 的 U-6（更新检查与 Skill Store 后续处置）中的「多源聚合」子项。

行号会随重构漂移，一律以符号名为准。

## 1. 概述

### 1.1 问题/背景

内置技能市场此前只有一个第一方端点（官方源），存在三个问题：

1. **单一端点即单点故障**：官方端点不可达时市场 tab 完全空白，无退路。
2. **契约被官方响应绑架**：渲染层直接解析官方响应的原始字符串（`json.data.value.marketplace`），响应结构调整会直接击穿渲染层。
3. **无第三方生态入口**：ClawHub、SkillHub 等公开技能注册表已有可用公开 API，应用侧没有接入。

### 1.2 目标

技能市场支持多个公开注册表聚合：每个源一个主进程适配器，对外暴露统一的归一化条目形状；渲染层按源切换，不感知上游差异；安装链路完全复用既有实现。

## 2. 用户场景

### 场景 1: 切换到第三方源浏览技能

**Given** 用户进入「技能 → 市场」tab，默认源为官方
**When** 用户点击源按钮 `ClawHub`
**Then** 市场列表重新拉取并展示 ClawHub 条目，标签过滤重置为「全部」，源选中态切换

### 场景 2: 在第三方源搜索

**Given** 当前源 `supportsSearch` 为真
**When** 用户输入搜索词
**Then** 350ms 防抖后向该源发起远程查询并替换列表；清空搜索词回落浏览视图

### 场景 3: 安装第三方源技能

**Given** 用户在第三方源列表点击安装
**When** 安装器接收条目 URL
**Then** 走既有安装、审计与回滚链路完成安装（不新增安装器分支）

### 场景 4: 源请求失败

**Given** 某源不可达或返回非 2xx
**When** 用户切换到该源
**Then** 主进程记录日志并返回空列表，界面显示空态，不中断 tab 操作

### 场景 5: 切到无搜索能力的源

**Given** 当前源 `supportsSearch` 为假（如 skills.sh）
**When** 用户操作搜索框
**Then** 不发起远程查询（输入框保留，不破坏布局）

## 3. 功能需求

### FR-1: 源枚举与能力契约

共享层集中定义源枚举、展示顺序、能力声明（`supportsBrowse` / `supportsSearch`）与默认源，并提供类型守卫校验入参。**端点 URL 不进共享层**，全部下沉主进程适配器。

### FR-2: 适配器归一化

每个第三方源一个适配器，对外只暴露 `fetchPage(query)`，返回统一形状 `NormalizedMarketplaceSkill`。上游缺关键字段的条目在适配器内丢弃，不进入列表。

### FR-3: 统一 HTTP 层

经 Electron `session.defaultSession.fetch` 走会话（复用 cookie/代理），15s 超时（`AbortController`），非 2xx 与网络异常统一包装为 `MarketplaceError`（携带 `status`）。

### FR-4: IPC 契约

新增 `skills:fetchMarketplaceSource(source, query?)` → `{success, skills, nextCursor?, error?}`；preload 暴露同名 API；渲染层类型声明同步。失败不抛异常，吞为 `success:false` + 空数组，保证切源不打断 UI。

### FR-5: 渲染层接入

- 市场 tab 内以药丸按钮组切源（`data-testid="skill-market-source-switch"`），仅在市场 tab 渲染；文案取 `i18nService.t(SKILL_MARKETPLACE_SOURCES[source].labelKey)`。
- 源选择是**纯视图状态，不持久化**，切源重置标签过滤。
- 非官方源跳过前端二次过滤（服务端已过滤）；第三方源无标签体系，标签集置空。

### FR-6: 安装链路复用

仅扩展 `skillManager.isRemoteZipUrl()` 白名单，放行 `/api/v1/download?slug=|owner=` 这类无 `.zip` 后缀的重定向下载路由；安装器、审计、回滚、升级比对全部沿用既有实现。

### FR-7: 安装来源记录与跨源状态判定（2026-10-16 补实现）

多源条目 id 形如 `clawhub:owner/slug`，而已安装技能的 id 是技能目录名（`resolveInstallFolderName` 的产物），两者永不相等；仅靠 id 全等匹配会让第三方源技能恒显示「未安装」、无法升级，且升级接口因收到 marketplace id 而找不到目标。

- 安装与升级时把来源写入本地 kv（键 `skills_install_origins`，结构 `Record<skillId, SkillInstallOrigin>` = `{marketplace, sourceId, url, installedAt}`）。
  - 落盘点覆盖三条路径：直接安装、`confirmPendingInstall`（安全审核确认后）、`upgradeSkill` 直接完成；`pendingInstalls` 携带 `installOrigin` 以跨确认流程保留。
  - 重装同一条目时清理指向旧目录的记录；`deleteSkill` 同步清除。
  - 读取时逐项校验（`normalizeSkillOriginMap` 丢弃缺 `sourceId` 的坏数据），单条脏数据不导致整体失败。
- 渲染层以来源映射为权威匹配（`marketplaceInstallMatch.ts` 的 `findInstalledSkillIdFor` / `findMarketplaceSkillForInstalled`）：先按 `sourceId` 命中已安装技能，未命中回退 id 全等——历史技能（无来源记录）与官方源条目行为不变。
- 升级必须传**已安装 id**（`resolveUpgradeTargetId`）并附带来源；找不到已安装技能时直接跳过，避免把 marketplace id 传给安装器。
- 官方源条目无 `marketplace` 字段且 id 与目录名一致，不记录来源（`buildSkillOrigin` 返回 `undefined`）。

### FR-8: 游标分页与「加载更多」（2026-10-16 补实现）

- 切源与搜索重置游标；列表底部在存在 `nextCursor` 时展示「加载更多」（`skillMarketplaceLoadMore`），点击以 `fetchMarketplaceSource(source, {cursor})` 追加。
- 追加按 id 去重（`appendMarketplacePage`），上游跨页重复条目不会产生重复卡片；无新条目时保持原列表引用不变。
- 官方源无游标不显示该按钮；SkillHub 无分页能力，`nextCursor` 恒空，按钮同样不出现。

### 不做清单

- ~~不做「加载更多」分页~~ **已做**（见 FR-8）。
- 不做源偏好的持久化（切源不跨会话保留）。
- 不做重试/退避/限流（见 U-5）。
- 不改造官方源旧通道（见 U-4）。
- 不为第三方源补标签（tag）体系。

## 4. 实现方案

### 4.1 概念模型

| 术语 | 含义 |
| --- | --- |
| 源（Source） | 一个技能注册表的标识，UI 切源的唯一维度 |
| 适配器（Adapter） | 主进程侧的源实现，请求上游并归一化 |
| 归一化条目 | `NormalizedMarketplaceSkill`：跨源同构的技能条目 |
| 能力声明 | `supportsBrowse` / `supportsSearch`，决定 UI 是否启用搜索 |
| 上游游标 | `nextCursor`：上游不透明分页令牌，**不是** offset |

**源与能力矩阵**

| 源 | 值 | 上游 | 适配器 | browse | search | 分页 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 官方 | `official` | 遗留 `skills:fetchMarketplace` | 无（走旧通道） | 是 | 是（前端过滤） | 无 | 唯一带 `marketTags` 的源 |
| ClawHub | `clawhub` | `clawhub.ai/api/v1/skills` | `clawhubAdapter` | 是 | 是（`q`） | 有（`cursor`） | 带 `User-Agent: HiAi-SkillMarketplace`；`limit` 默认 30 |
| SkillHub | `skillhub` | `api.skillhub.cn` 的 `/api/v1/search`、`/api/v1/showcase/{section}`（默认 `hot`） | `skillhubAdapter` | 是 | 是 | **无** | 描述中文优先；下载走 302 重定向 |
| skills.sh | `skills-sh` | 无公开列表 API | 复用 `clawhubAdapter` | 声明为否 | 声明为否 | 随 ClawHub | 「经 ClawHub 浏览」，见 U-3 |

默认源 `official`；`isSkillMarketplaceSource()` 做白名单校验，未知源静默回落到默认源。

**归一化条目字段**

| 字段 | 说明 |
| --- | --- |
| `id` | 源内稳定标识，形如 `clawhub:owner/slug`、`skillhub:@ns/slug` |
| `name` / `description` | 上游名称与描述（SkillHub 中文优先） |
| `url` | 下载地址，可直接交给安装器 |
| `version` | 版本；缺失时 UI 不显示可升级 |
| `source` | `{from, url, author?}` 站点/仓库/作者 |
| `displayName?` / `icon?` / `downloadCount?` | 可选展示字段 |
| `marketplace` | 来源源标识 |

上游缺关键字段的条目被丢弃：ClawHub 缺 `ownerHandle`/`slug`、SkillHub 缺 `canonicalName` 与 `slug`。

### 4.2 数据流

`SkillsManager` → `skillService.fetchMarketplaceSource` → IPC `skills:fetchMarketplaceSource` → `fetchMarketplacePage(source, query)` → adapter → `fetchJson` → 上游；归一化条目直达 UI。

### 4.3 交互设计

- 源按钮组按展示顺序（官方 → ClawHub → SkillHub → skills.sh）排列，选中态 `bg-primary text-white`。
- 切到第三方源后标签集为空，标签过滤控件随之失效（保留位置以稳定布局）。
- 切源与搜索均复用现有市场骨架屏。
- 边界：切源不写盘、无二次确认。

### 4.4 关键取舍

- **适配器不共享渲染逻辑**：官方源结构差异大且带标签体系，强行归一化会牵连既有渲染，故官方源保留旧通道（代价见 U-4）。
- **端点下沉主进程**：共享层不放 URL，避免渲染层或多进程消费者误用。
- **失败不抛给渲染层**：IPC 层吞异常返回空数组，保证切源不打断 UI。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 源请求失败（HTTP 非 2xx / 超时 / 网络异常） | 主进程记日志，返回 `success:false` + 空数组，界面显示空态；不向用户呈现具体原因 |
| 未知源值传入 IPC | 静默回落到默认源（官方） |
| 官方源请求（无适配器） | `fetchMarketplacePage` 抛 `MarketplaceError('... has no list adapter')`，IPC 吞为失败结果 |
| `supportsSearch` 为假 | 搜索防抖 effect 不启用；切到 skills.sh 时仍会请求 ClawHub 并展示其结果（U-3） |
| 上游返回空列表 | 沿用现有空态文案 |
| 上游条目缺关键字段 | 适配器内丢弃，不进入列表 |

## 6. 涉及文件

| 落点 | 文件 |
| --- | --- |
| 共享契约 | `src/shared/skills/marketplaceSources.ts`（含 `SkillInstallOrigin` / `SkillInstallOriginInput`） |
| 匹配与分页纯函数 | `src/renderer/components/skills/marketplaceInstallMatch.ts`（+ 同名 `.test.ts`） |
| 安装来源存储 | `src/main/skills/skillManager.ts`（kv `skills_install_origins`；+ `skillManager.origins.test.ts`） |
| 适配层 | `src/main/libs/skillMarketplace/{index,types,http,clawhubAdapter,skillhubAdapter}.ts` |
| 适配层测试 | `src/main/libs/skillMarketplace/adapters.test.ts` |
| IPC | `src/main/ipcHandlers/skills/handlers.ts`；类型 `src/renderer/types/electron.d.ts` |
| preload | `src/main/preload.ts`（`skills.fetchMarketplaceSource`） |
| 渲染服务 | `src/renderer/services/skill.ts` |
| UI | `src/renderer/components/skills/{SkillsManager.tsx,skillTabs.ts}` |
| i18n | `src/renderer/services/i18n.ts`（`marketSourceOfficial/ClawHub/SkillHub/SkillsSh`） |
| 安装白名单 | `src/main/skills/skillManager.ts` 的 `isRemoteZipUrl()` |

## 7. 验收标准

| 编号 | 验收标准 | 状态 |
| --- | --- | --- |
| AC-1.1 | ClawHub 条目归一化正确：`id=clawhub:owner/slug`、下载 URL 命中 `clawhub.ai/api/v1/download`、搜索词与 `limit`、`nextCursor` 透传 | ✅ `adapters.test.ts` |
| AC-1.2 | ClawHub 缺 `ownerHandle`/`slug` 的条目被丢弃 | ✅ 同上 |
| AC-2.1 | SkillHub 有查询词走 `/api/v1/search`，无查询词走 `/api/v1/showcase/hot`；描述中文优先；icon 绝对化 | ✅ `adapters.test.ts` |
| AC-3.1 | skills.sh 请求打到 ClawHub，且返回项 `marketplace` 为 `clawhub`（现状行为，见 U-3） | ✅ 同上 |
| AC-4.1 | 未知源/官方源 `hasMarketplaceAdapter` 为假；未知源抛 `no list adapter`；上游非 2xx 抛 `HTTP 500` | ✅ 同上 |
| AC-5.1 | 市场 tab 可切源、切源后重新拉取并重置标签过滤 | ✅ 代码核对（无自动化用例） |
| AC-5.2 | `supportsSearch` 为假的源不触发搜索请求 | ✅ 代码核对（`SkillsManager` 搜索 effect） |
| AC-6.1 | 第三方源条目 URL 可被安装器接受（`/api/v1/download` 白名单）并跟随重定向 | ✅ 代码核对；**端到端安装待手工实测** |
| AC-7.1 | 改动文件在 CI 同款 eslint（`--max-warnings 0`）下通过，`tsc --noEmit` 与 `npm test` 无回归 | ✅ 2026-10-16：`adapters.test.ts` 与 `TrafficAnalyticsChart.test.ts` 共 8 用例通过；全量 6140 通过，2 处失败为无关遗留（popo-sdk）与计时抖动（skillManager.watcher 单跑全绿） |
| AC-8.1 | 第三方源安装后，市场列表该条目显示「已安装」/「可升级」而非「安装」（FR-7） | ✅ `marketplaceInstallMatch.test.ts` + `skillManager.origins.test.ts`；**端到端待手工实测** |
| AC-8.2 | 升级第三方源技能走通：传入已安装 id，安装后目录名不变、来源记录刷新 | ✅ 单测覆盖记录与清理；**端到端待手工实测** |
| AC-8.3 | 历史已安装技能（无来源记录）与官方源条目的状态判定不变（FR-7 回退路径） | ✅ `marketplaceInstallMatch.test.ts` |
| AC-9.1 | ClawHub 列表有 `nextCursor` 时出现「加载更多」，点击追加且无重复卡片（FR-8） | ✅ `appendMarketplacePage` 用例；**端到端待手工实测** |
| AC-9.2 | 官方源与 SkillHub 不显示「加载更多」 | ✅ 官方源走旧通道无游标；SkillHub 无分页，`nextCursor` 恒空 |

**测试覆盖缺口**：超时/Abort 路径、`User-Agent` 头、`limit` 默认值 30、`resolveAgainst` 相对路径回退、SkillHub 缺 `homepage` 时的 URL 拼接、IPC handler 层均无用例（U-7）。

## 8. 未决项（已定位缺陷，修复前需先决策）

> U-1、U-2 已于 2026-10-16 决策并实现（FR-7 / FR-8），下表保留结论以便追溯；U-3~U-7 仍未处理。

| 编号 | 问题 | 影响 | 修复前置条件 |
| --- | --- | --- | --- |
| ~~U-1~~ | ~~跨源升级判定失配~~ **已修**（2026-10-16，FR-7）：安装/升级写入 `skills_install_origins`，渲染层以来源映射匹配并回退 id 全等；升级改传已安装 id | — | — |
| ~~U-2~~ | ~~游标链路半成品~~ **已修**（2026-10-16，FR-8）：接「加载更多」，按 id 去重追加；官方源与 SkillHub 不显示按钮 | — | — |
| U-3 | **skills.sh 源归属泄漏**：`adapters` 把 `skills-sh` 映射到 `clawhubAdapter`，条目 `marketplace` 被标为 `clawhub` | 源标签与内容不符，用户误判数据来源 | 确认 skills.sh 是否确实只能经 ClawHub 浏览；若保留，归一化时按**请求源**改写 `marketplace` |
| U-4 | **官方源与新源双通道并存**：旧 `skills:fetchMarketplace` 用裸 `https.get`（10s、无 UA、日志打印完整 store URL、返回未解析字符串），渲染层 `marketplaceCache` 永久缓存且无失效入口 | 两套超时/错误/日志行为不一致；官方源故障无降级 | 决策官方源是否迁移到适配层，或明确其长期保留 |
| U-5 | **无重试/退避/限流**：`fetchJson` 仅 15s 超时，一次失败即抛 | 上游抖动或 429 时用户直接看到空列表 | 确认各上游限流策略后再定退避参数 |
| U-6 | **类型退化**：主进程 `marketplace` 为 `SkillMarketplaceSource`，渲染层 `MarketplaceSkill.marketplace` 退化为可选 `string`；`tags`/`displayName` 的 `LocalizedText` 联合在多源路径未被满足 | 源判别失去编译期保护（FR-7 的 `buildSkillOrigin` 已加缺省兜底，但退化仍在） | 收敛渲染层类型到共享枚举（需评估官方源既有数据兼容） |
| U-7 | **测试缺口**：`handlers.ts` 无 marketplace/来源用例；无超时、UA、`limit` 默认值、`resolveAgainst` 断言 | 上游契约漂移无法被 CI 捕获 | 补 handler 层与 http 层用例 |

> FR-7 / FR-8 已补单测：`marketplaceInstallMatch.test.ts`（10 例，覆盖来源匹配、历史回退、删除后失效、跨页去重）与 `skillManager.origins.test.ts`（9 例，覆盖记录、重装清理、删除清理、坏数据归一化）。

## 9. Mock 台账

本功能**不引入 mock**：`src/main/libs/skillMarketplace/`、`src/shared/skills/`、`SkillsManager.tsx` 中 `MOCK:`/`TODO`/`FIXME` 零命中；`adapters.test.ts` 虽 mock `session.defaultSession.fetch`，但断言的是真实 URL 与归一化规则。

需要说明的两项**实现约定**（均非 mock，但易被误读）：

1. 端点硬编码在适配器内（`clawhubAdapter` 3 个常量、`skillhubAdapter` 4 个常量），无配置化入口——换环境/镜像需改代码。
2. `skills.sh` 的「浏览」实际是请求 ClawHub（U-3），数据真实但来源标记为 ClawHub。
