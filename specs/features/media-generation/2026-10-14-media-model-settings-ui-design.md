# 媒体生成模型设置界面设计文档

> 关联：[媒体生成模型配置](../../refactors/de-server-dependency/) 相关设计、[LobsterAI 生图生视频托管工具](./2026-05-13-media-generation-design.md)。

## 1. 概述

### 1.1 问题/背景

去服务端依赖改造后，图片/视频生成不再走 `lobsterai-server`，改为用户在设置页手填
provider（`baseUrl` / `apiKey` / `modelId`）。当前设置页存在三个问题：

1. **导航命名混乱**：「自定义模型」这个 tab 实际装的是文本生成模型的 provider 配置；
   「图片/视频生成模型」这个 tab 才是媒体生成模型。两个 tab 的名字都没说清自己是什么。
2. **媒体模型界面是半成品**：`MediaProviderSettingsSection` 用一组 `图片 / 视频` 平铺按钮
   在同一个列表区里切换，和文本生成模型界面的「左列表 + 右详情」布局完全不一致，用户在
   两个 tab 之间要换一套心智模型。
3. **图片与视频模型的空间关系不明确**：设计意图是图片、视频两块模型清单上下排列，各自
   再左右分栏「模型列表 ↔ 具体设置」，但现在的实现是二选一的切换，看不到全貌。

### 1.2 目标

1. 重命名设置页导航项，让两个 tab 的职责一眼可辨：
   - 「自定义模型」→ **「文本生成模型」**
   - 「图片/视频生成模型」→ **「媒体生成模型」**
2. 将媒体生成模型界面重构为两块，**上下排列**：
   - 上：图片生成模型
   - 下：视频生成模型
3. 每一块内部**左右排列**：左侧模型列表，右侧具体设置，布局与文本生成模型界面一致。
4. 两块各自独立保存/增删，不再有「切 tab 才能看到另一种」的二选一状态。

### 1.3 非目标

- 不改动媒体 provider 的数据结构（`MediaProvidersConfig`）与 IPC 契约。
- 不改动文本生成模型界面（`ModelSettingsSection`）的内部逻辑，只改其 tab 名称与文案
  （见 FR-8）。
- 不新增 3D / 音频等其他媒体类型（`MediaProviderKind` 仍只有 `image`、`video`）。
- 不引入媒体模型的连通性测试能力（文本生成模型有「测试连接」，媒体侧本期不做）。

## 2. 用户场景

### 场景 1: 辨认两个模型设置入口

**Given** 用户打开设置页
**When** 用户看左侧导航
**Then** 看到「文本生成模型」与「媒体生成模型」两项，能直接判断前者管对话/文本模型、后者管图片和视频生成模型

### 场景 2: 配置一个图片生成模型

**Given** 用户进入「媒体生成模型」tab
**When** 页面加载完成
**Then** 上方是「图片生成模型」区块，左侧列出已配置的图片模型，右侧显示当前选中模型的具体设置项；下方是「视频生成模型」区块，结构相同

### 场景 3: 新增一个视频模型

**Given** 用户在「视频生成模型」区块
**When** 点击该区块的「添加模型」
**Then** 该区块左侧列表新增一行并自动选中，右侧出现空白设置表单供填写，不影响上方图片模型区块

### 场景 4: 切换查看不同模型

**Given** 图片生成模型区块已配置 3 个模型
**When** 用户点击左侧列表中第 2 个模型
**Then** 右侧设置区切换为该模型的配置，其余行保持列表状态

### 场景 5: 删除正在编辑的模型

**Given** 用户选中了某个视频模型并在右侧查看其设置
**When** 用户点击该模型行的「删除」
**Then** 该行从列表移除；选中态转移到相邻行；若列表已空，右侧显示空态提示

### 场景 6: 在某一区块保存配置

**Given** 用户在视频区块修改了设置，图片区块有未保存的编辑
**When** 用户点击视频区块自己的「保存」
**Then** 整份 `MediaProvidersConfig`（含图片区块当前编辑）一并写入，规范化后回填界面；空白行（无 modelId）被丢弃；状态提示只出现在视频区块

### 场景 7: 按名称过滤模型

**Given** 图片区块已配置 5 个模型
**When** 用户在图片区块的搜索框输入「dall」
**Then** 左列表只显示名称或 modelId 匹配的行，选中态与右栏不变；清空搜索框后恢复全量列表

## 3. 功能需求

### FR-1: 导航项重命名

设置页左侧导航重命名两个 tab：

| tab key | 旧文案 | 新文案 |
| --- | --- | --- |
| `model` | 自定义模型 | **文本生成模型** |
| `mediaProvider` | 图片/视频生成模型 | **媒体生成模型** |

要求：

- 中英文案同步更新（`settingsCustomModel`、`mediaProviderConfigTitle` 相关键）。
- tab key 与内部路由标识**不变**，避免影响 `initialTab` 跳转、快捷键、企业配置的
  `ui["settings.*"]` 显隐控制。
- 快捷键标签中若引用了旧名，一并更新。

### FR-8: 文本生成模型页语境统一

文本生成模型页（`ModelSettingsSection`）内部的「提供商」文案统一为文本生成语境。
经检索，以下键只被 `ModelSettingsSection` 使用，改值无外溢影响：

| key | 旧值（zh / en） | 新值（zh / en） |
| --- | --- | --- |
| `modelProviders` | 模型提供商 / Model Providers | 文本模型提供商 / Text Model Providers |
| `searchProviders` | 搜索提供商... / Search providers... | 搜索模型提供商... / Search model providers... |
| `addCustomProvider` | + 添加自定义 / + Add Custom | + 添加自定义模型 / + Add Custom Model |

- `providersEnabledSuffix`（已启用 / enabled）语义中性，不改。
- tab 页内标题 `activeTabLabel` 已随 FR-1 的新 tab 文案生效，无需单独处理。

### FR-2: 媒体生成模型界面分块

媒体生成模型 tab 的页面结构：

```text
┌──────────────────────────────────────────┐
│ 媒体生成模型                                  │
│ （区块说明文案）                              │
├──────────────────────────────────────────┤
│ 图片生成模型                                  │
│ ┌────────────┬─────────────────────────┐ │
│ │ [搜索框]     │  当前模型设置              │ │
│ │ 模型列表      │                          │ │
│ │ （左）        │  （右）                   │ │
│ ├────────────┴─────────────────────────┤ │
│ │                     [保存] 状态提示      │ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ 视频生成模型                                  │
│ ┌────────────┬─────────────────────────┐ │
│ │ [搜索框]     │  当前模型设置              │ │
│ │ 模型列表      │                          │ │
│ │ （左）        │  （右）                   │ │
│ ├────────────┴─────────────────────────┤ │
│ │                     [保存] 状态提示      │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

要求：

- 图片块在上、视频块在下，两块始终同时可见，不做二选一切换。
- 每块内部左右两栏：左栏模型列表（含搜索框、选中态、每行带删除入口），右栏为选中模型的具体设置。
- 每块有自己的「保存」按钮与状态提示区，位置在块内底部。
- 两块固定最小高度，视觉均衡，不因某块内容少而塌陷（见 4.3）。
- 左右分栏比例与文本生成模型界面保持观感一致（左窄右宽）。

### FR-3: 模型列表（每块左栏）

每个媒体区块的左栏：

- 列出该 kind（`image` / `video`）的全部已配置模型。
- 顶部提供搜索框，按 `displayName` / `modelId` 不区分大小写过滤；过滤只影响列表展示，
  不影响选中态与右栏内容；清空后恢复全量。交互与文本生成模型页的 provider 搜索一致。
- 每行显示：模型显示名（`displayName`），副标题显示 `modelId`；两者皆空时显示「未命名模型」。
- 当前选中的行有明确选中样式。
- 每行提供删除入口（或悬停显示），删除即从该 kind 列表中移除。
- 列表底部或顶部提供「添加模型」入口。
- 列表为空时显示空态文案，并保留「添加模型」入口。

### FR-4: 模型设置（每块右栏）

右栏展示当前选中模型的设置表单，字段沿用现有 `MediaProviderEntry`：

| 字段 | 文案 | 说明 |
| --- | --- | --- |
| `displayName` | 显示名称 | 占位示例 `DALL·E 3` |
| `modelId` | 模型 ID | 必填，占位示例 `gpt-image-1`，等宽字体 |
| `baseUrl` | 接口地址 | 占位示例 `https://api.openai.com/v1`，等宽字体 |
| `apiKey` | API 密钥 | 密码输入；已存密钥显示「已保存密钥」与「清除密钥」 |
| `capabilities` | 能力说明（可选） | 占位「如：支持参考图」 |

行为要求（沿用现有实现语义，不得回退）：

- API 密钥永不回填明文，仅通过 `apiKeyStored` 展示「已保存」状态。
- 留空密钥 = 保持原密钥；「清除密钥」需置 `clearApiKey: true` 显式表达删除意图。
- 密钥无法解密（`undecryptable`）或本机无系统密钥库（`encryption-unavailable`）时，
  显示对应诊断文案，且保存不得覆盖已有密文。
- 未选中任何模型时，右栏显示「请从左侧选择一个模型」空态。

### FR-5: 各区块独立保存

- **每个区块有自己的「保存」按钮**，位于该块底部；点击后提交整份
  `MediaProvidersConfig`（图片 + 视频）——因为 IPC 是一次整体写入，所以保存任一区块
  时，另一区块的当前编辑也会随之持久化，这是预期行为，不是缺陷。
- 保存前经 `normalizeMediaProvidersConfig` 规范化；保存后用返回配置回填界面。
- 保存成功/失败的状态提示只出现在被操作的区块内，文案沿用
  `mediaProviderSaveSuccess` / `mediaProviderSaveFailed`。
- 某一区块保存中只禁用该区块的保存按钮，不阻塞另一区块的编辑。
- 两个区块的编辑状态互不影响。

### FR-6: 组件拆分

`MediaProviderSettingsSection.tsx` 拆为可复用的内外两层：

- 单块组件（如 `MediaProviderKindPanel`）：接收 `kind` + `entries` + `selectedIndex` +
  回调，渲染「左列表 + 右表单 + 块内保存按钮与状态提示」；
- 外层容器：持有 `config`、两个块的选中状态与保存状态，纵向堆叠两个单块组件。

不得把图片/视频两份逻辑复制粘贴成两套；两块的差异只允许是 `kind` 与文案。

### FR-7: 选中状态与 React key 稳定性

- 每个 kind 各自维护独立的 `selectedIndex`（或稳定 rowId 映射）。
- 行的 React key 必须是稳定 id，不得用数组下标（删除一行会导致后续行 key 错位、输入框复用错误元素）。
- 删除选中行后，选中态落到相邻行；删除后列表为空则进入空态。
- 这里的 key 稳定性要求与现有实现一致，重构时不得退化。

## 4. 实现方案

### 4.1 落点文件

| 文件 | 操作 |
| --- | --- |
| `src/renderer/components/settings/MediaProviderSettingsSection.tsx` | 重构，拆出单 kind 面板组件，改为上下两块 |
| `src/renderer/components/Settings.tsx` | 修改，`sidebarTabs` 中 `model` / `mediaProvider` 的 label 改用新文案键 |
| `src/renderer/services/i18n.ts` | 修改，新增/更新导航与区块文案（中英） |

### 4.2 文案键规划

新增（暂定命名，实现时以既有风格为准）：

| key | zh | en |
| --- | --- | --- |
| `settingsTextModel` | 文本生成模型 | Text Generation Models |
| `mediaProviderConfigTitle`（改值） | 媒体生成模型 | Media Generation Models |
| `mediaImageModelsSection` | 图片生成模型 | Image Generation Models |
| `mediaVideoModelsSection` | 视频生成模型 | Video Generation Models |
| `mediaProviderSearchPlaceholder` | 搜索模型... | Search models... |
| `mediaProviderSelectHint` | 从左侧选择一个模型 | Select a model on the left |
| `mediaProviderAdd`（沿用） | 添加模型 | Add model |

FR-8 的文本生成页键值修改见 FR-8 表格。

说明：

- `mediaProviderConfigTitle` 目前同时被用作 tab label 与页内标题，改值即可同时生效；
  若实现时拆成两个 key，需保证 tab 与标题语义一致。
- `mediaImageModels` / `mediaVideoModels`（「图片模型」「视频模型」）如不再被媒体选择器
  复用，可复用为区块标题；实现时先确认 `MediaGenerationModelPicker` 等调用方的依赖。

### 4.3 布局参考

与文本生成模型界面（`ModelSettingsSection`）对齐的关键点：

- 外层 `flex h-full`，左栏约 `w-2/5` 加右边框分隔，右栏自适应。
- 左列表行采用紧凑行高、选中态高亮、hover 反馈。
- 输入框样式沿用设置页现有输入类（`rounded-lg border ... bg-surface`）。

注意：`ModelSettingsSection` 是整页单实例的左右分栏；本设计是在**同一页内纵向堆叠两个**
「左列表 + 右表单」子块。**两块采用固定最小高度**（例如 `min-h-[480px]`，实现时按实际
观感调整），保证两块视觉均衡，不因某块模型少而塌陷；内容超出时块内自身滚动。

### 4.4 边界与空态

| 场景 | 处理方式 |
| --- | --- |
| 某 kind 无模型 | 该块左栏显示空态 + 「添加模型」入口；右栏显示选择提示 |
| 添加后尚未填 `modelId` | 允许暂存编辑；保存时被规范化丢弃 |
| 选中行被删除且列表非空 | 选中相邻行（优先下一行，越界取上一行） |
| 选中行被删除且列表为空 | 两块互不影响，仅本块进入空态 |
| 加载失败 | 显示 `mediaProviderLoadFailed`，两块均呈现不可编辑的空态 |
| 保存失败 | 保留用户编辑内容，显示 `mediaProviderSaveFailed`，不回滚界面 |
| 密钥不可解密 | 显示诊断文案，保存时保留原密文（`preservedCiphertext` 语义不变） |

## 5. 验收标准

1. 设置页导航显示「文本生成模型」与「媒体生成模型」，不再出现「自定义模型」「图片/视频生成模型」。
2. tab key 未变，`initialTab` 跳转、快捷键、企业配置显隐仍按原 key 生效。
3. 「媒体生成模型」页同时可见「图片生成模型」与「视频生成模型」两块，上下排列。
4. 每块内部左为模型列表、右为具体设置，观感与文本生成模型界面一致。
5. 在图片块新增/删除模型，不影响视频块的列表与选中态；反之亦然。
6. 切换左列表选中行时，右栏表单随之切换，输入内容不串行。
7. 删除选中行后选中态落到相邻行；列表清空后进入空态。
8. API 密钥不回填明文；「清除密钥」「留空保持」语义与改造前一致。
9. 每块有自己的「保存」按钮与状态提示；保存任一区块写入整份配置（含另一区块当前编辑），
   规范化后回填；保存中不阻塞另一区块编辑。
10. 每块左列表搜索框可按名称/模型 ID 过滤，清空后恢复全量。
11. 两块固定最小高度，视觉均衡；内容超出时块内滚动。
12. 设置页导航显示「文本生成模型」「媒体生成模型」；文本生成模型页内为「文本模型提供商」等新文案。
13. 中英文案完整，无遗漏旧文案。
14. `npm run compile:electron` 与改动文件的 CI 同款 eslint 通过。

### 5.1 验收结果（2026-10-15 补录）

| 编号 | 复核方式 | 结果 |
| --- | --- | --- |
| 1 | `i18n.ts`: `settingsTextModel: '文本生成模型'`、`mediaProviderConfigTitle: '媒体生成模型'`；tab 定义（`Settings.tsx:4635-4636`）使用这两个键；旧 tab 名仅剩「自定义模型」语境下的合法用法（`modelGroupUser` / `addCustomProvider` 等指用户自建 provider 的场景，非导航名） | ✅ |
| 2 | `initialTab` / `initialTabRequestId` 逻辑未动，tab key（`model` / `mediaProvider`）保持原值 | ✅ |
| 3 | `MediaProviderSettingsSection.tsx` 头部注释与结构：图片、视频两块纵向堆叠（stacked vertically），始终同时可见 | ✅ |
| 4 | 每块内部 `flex-col md:flex-row`：左列表（`max-h-[240px] md:max-h-none` 滚动）+ 右表单，与文本生成模型布局同构 | ✅ |
| 5–7 | 两块各自独立 state（独立选中行、独立增删），列表行为经 `mediaProviders.test.ts` 19 用例验证；切换/删除/空态逻辑未改动 | ✅ |
| 8 | `apiKeyStored` 徽标 + `mediaProviderApiKeyKeepPlaceholder`（「留空则保持原密钥」）+ `clearApiKey`（「清除密钥」）均在位，密钥明文不回填 | ✅ |
| 9 | 每块独立保存按钮与状态提示（`mediaProviderSaveFailed` / `mediaProviderLoadFailed` 中英齐备）；保存写入整份配置 | ✅ |
| 10 | 左列表 `searchQuery` 过滤（按名称/模型 ID，`normalizedQuery` 匹配），清空恢复全量 | ✅ |
| 11 | 两块统一 `min-h-[420px]`，列表列内滚动（`overflow-y-auto`） | ✅ |
| 12 | `i18n.ts:387` `modelProviders: '文本模型提供商'` 等新文案在位 | ✅ |
| 13 | 中英词典均含全部媒体设置键；全量 `i18n.ts` 无旧 tab 名残留 | ✅ |
| 14 | `npx tsc --noEmit` 退出码 0；`MediaProviderSettingsSection.tsx` + `Settings.tsx` eslint `--max-warnings 0` 零告警；`npm test -- mediaProviders` 19/19 通过；主进程无改动故 `compile:electron` 沿用 remove-membership 复验结论 | ✅ |

注：本特性为纯 renderer 改动，自动检查无法覆盖的视觉观感（块间距、滚动手感）
在 AC-4/11 层面依赖同构布局实现，可在 AC-SM-9 同次的 GUI 冒烟中顺带确认。

## 6. 已确认决定

2026-10-14 与用户确认：

1. 保存按钮：**两块各自独立保存**（见 FR-5）。
2. 左列表：**需要搜索/过滤**（见 FR-3）。
3. 区块高度：**固定最小高度求视觉均衡**（见 4.3）。
4. 文本生成模型页内部文案：**一并统一为文本生成语境**（见 FR-8）。

## 7. FR-9: 媒体模型以工具暴露，由 skill 指导使用（2026-10-15 追加）

用户补充的产品定位，**覆盖 1.3 中「不改动 IPC 契约」的部分**：

1. 媒体模型**只在设置页配置**（用户手填 `baseUrl` / `apiKey` / `modelId`），配置是唯一
   来源；密钥经 `safeStorage` 加密后存 SQLite，明文不跨 IPC。
2. 生成能力**以工具形式暴露**给 agent：`POST /media-generation/tool`
   （`McpBridgeServer`）→ `handleMediaGenerationCallback`（`main.ts`）→
   `src/main/libs/mediaProvider/` 的 adapter。agent 通过
   `action=list | generate | status | cancel` 调用。
3. **skill 只做「使用指导」**，不持有密钥、不自带 API 调用脚本。

### 7.1 现状：两条并行路径需要收敛

| 路径 | 实现 | 问题 |
| --- | --- | --- |
| A（工具） | 设置页配置 → adapter → MCP bridge → agent | 现行主路径，符合定位 |
| B（skill） | `SKILLs/seedream`、`SKILLs/seedance` 读环境变量 `ARK_API_KEY`，自带脚本直连火山方舟 | **不读设置页配置**，等于第二套密钥来源 |

路径 B 造成的后果：用户在设置页配好火山方舟（`baseUrl` 填
`https://ark.cn-beijing.volces.com/api/v3`）后，agent 仍可能优先选seedream skill
（skill 是对 agent 的显式指导，天然优先），结果去读并不存在的环境变量，
**用户配置形同虚设，且要维护两份密钥**。

2026-10-15 确认：**改造 `seedream` / `seedance` skill 为工具使用指导层**，
去掉密钥与自带脚本，只保留场景知识与模型知识。

### 7.2 前置阻塞：`action=list` 目前无法表达参数能力

改造 skill 之前必须先修工具侧，否则指导层只能靠猜参数，或把参数知识复制一份到
skill 里（等于又制造一个配置源）。已核查代码，结论：

1. **`parameterSpec` 是死字段。** `MediaProviderModel.parameterSpec` 在
   `src/main/libs/mediaProvider/types.ts` 有类型定义，但两个 adapter 的
   `listModels()`（`openaiCompatImage.ts` / `minimaxVideo.ts`）**从不填充**，
   因此 `action=list` 返回的 `Supported parameters:` 段落永远不会出现。
2. **`capabilities` 是用户手填的自由文本。** 来源是设置页的「能力说明」字段
   （`MediaProviderEntry.capabilities`），可为空、机器不可读、不做校验。
3. **参数白名单全局硬编码在 `main.ts`**（`handleMediaGenerationCallback` 的参数
   归一化段），不区分 provider，agent 无从得知「哪个模型支持哪些参数」。

### 7.2.1 已实现（2026-10-15）

`parameterSpec` 按 **kind** 给通用参数表，不新增数据字段：

- 新增 `src/main/libs/mediaProvider/parameterSpecs.ts`，导出 `IMAGE_PARAMETER_SPEC`
  与 `VIDEO_PARAMETER_SPEC`，字段类型为
  `{ type, required?, description, example? }`。
- 两个 adapter 的 `listModels()` 各自挂上对应 kind 的参数表，字段不再是死字段。
- `action=list` 的文本重排为「模型清单（名称 + modelId + capabilities）」+
  **一份**参数表（`formatMediaParameterSpec` 输出 `- name (type, required): 说明`）。
  参数表按 kind 去重、只输出一次，避免配了 N 个模型就重复 N 份。
- 参数表的字段与取值说明与 OpenClaw 插件的工具 schema
  （`openclaw-extensions/lobster-media-generation/index.ts`）逐项对齐；该schema 里
  多处「Valid values depend on model; use action=list to check」的承诺至此成立。

按 kind 而非按模型给的理由：按模型给需要先在设置页加一个字段才能覆盖最常见的
情况，而同一 kind 在不同供应商下的行为一致，用户另有说明时可用 `capabilities`
补充。若后续确需按模型覆盖，再在此基础上扩展。

### 7.3 已有工具能力对火山参数的覆盖度（已核查）

`main.ts` 参数白名单与 `SKILLs/seedance` 的参数对照，**覆盖度接近完整**：

| skill 参数 | 工具参数 | 说明 |
| --- | --- | --- |
| `--prompt` | `prompt` | ✅ |
| `--image`（多次） | `images` / `imageRoles` | ✅ |
| `--model` | 当轮选中的模型 | ✅ |
| `--duration` | `durationSeconds` | ✅ |
| `--ratio` | `aspectRatio` | ✅ |
| `--audio` | `audio` | ✅ |
| `--no-watermark` | `watermark` | ✅ |
| `--output` | `filename` | ✅ |
| 首尾帧 | `firstFrame` / `lastFrame` | ✅ |
| 轮询间隔 / 超时 | 无 | 工具内部固定接管，无需 agent 关心 |

白名单中的 `cameraFixed`、`returnLastFrame` 本就是为火山 Seedance 预留的。
**结论：seedance skill 的脚本能力已被工具完全覆盖，改造后它只剩「知识」价值**
（模型列表、音画同步等场景写法、Pro/Lite 限流差异），这部分适合搬进 SKILL.md。

### 7.4 已实现：两个 skill 改造为工具使用指导层（2026-10-15）

- 删除 `SKILLs/seedream/scripts/` 与 `SKILLs/seedance/scripts/`（各 3 个脚本：
  `.sh` / `.ps1` / `.js`），不再自带 API 调用实现。
- 两个 `SKILL.md` 重写为工具使用指导层，版本升到 `2.0.0`：
  - 前置条件改为「先在设置页配置模型」，`action=list` 返回空时引导用户去配置，
    而不是让agent 自己找密钥；
  - 明确禁止用脚本 / `curl` / 环境变量直连 API；
  - 流程固定为 `action=list` → `action=generate` →（异步时）`action=status` /
    `action=cancel`，并说明视频任务必然异步、不要自行轮询；
  - 保留原有知识：模型清单与限流、场景用法（T2I / I2I / 多图融合 / 组图、
    首尾帧过渡 / 音画同步）、镜头语言提示词、提示词最佳实践、排错表；
  - 参数表不复制进 skill（由 7.2.1 的 `action=list` 提供），只在文中列出最常用参数
    并指向 `action=list`。
- 全仓已无`ARK_API_KEY` / `SKILLS_ROOT` / 旧脚本名在这两个 skill 中的残留引用。
