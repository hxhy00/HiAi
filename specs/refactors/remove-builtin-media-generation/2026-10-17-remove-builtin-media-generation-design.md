# 移除内置媒体生成链路设计文档

> 关联：《去会员理念改造》`../remove-membership/2026-10-14-remove-membership-design.md`、《去服务端依赖》`../de-server-dependency/2026-10-13-de-server-dependency-design.md`、《产品路线图》`../product-roadmap/2026-10-15-hiai-product-roadmap.md`。

---

## 1. 问题定义

### 1.1 谁在什么场景下遇到什么问题

| 角色 | 场景 | 现状痛点 |
| --- | --- | --- |
| 维护者 | 排查生图失败 | 图片/视频生成有两条并行链路：内置 `hiai_image_generate` / `hiai_video_generate`（走设置页手填 provider + `safeStorage` 密钥 + 任务注册表 + 轮询）与 `seedream` / `seedance` skill 脚本（直接调上游）。两条链路各自维护模型清单、参数映射与错误文案，问题定位要靠猜是哪条在跑 |
| 维护者 | 移除登录 / 会员 / 服务端 | 媒体链路仍挂着「账户作用域」：`MediaAccountScope`、`LOCAL_MEDIA_OWNER_KEY`、`createAccountScopedFetch`、按会话记录的 `mediaTurnAccountScopeBySession`。账户概念已整体移除，这些代码在每次调用时都要走一遍没有意义的分支 |
| 用户 | 想生图 | 输入框里有「媒体模型选择器」与 `@` 媒体引用选择器，但底层 provider 需要先手动填 `baseUrl`/`apiKey`，且与 skill 脚本配置的是同一类上游——等于要求用户配置两遍 |
| 用户 | 看对话里的生图过程 | 内置媒体任务有一套独立的 Lottie 轮询指示器与 `mediaPolling` 会话字段，与普通工具调用的展示逻辑分裂 |

### 1.2 结论

**内置媒体生成不是用户保留项。** 图片/视频生成统一由 `seedream` / `seedance` skill 提供：脚本直连上游、用户只填一处配置、结果以普通文件产物呈现。

因此本重构的边界是：**删除应用内置的媒体生成能力，连同它携带的账户作用域、模型设置界面与轮询展示；保留并修正皮肤工作流消费图片产物的能力。**

### 1.3 不在本次范围

- 不删除 `seedream` / `seedance` skill 与 `config.json` 配置方式。
- 不删除 OpenClaw 原生 `image_generate` / `video_generate`（平台能力，agent 自行可见可用）。
- 不改 `lobster-skin://` 协议、皮肤库结构、皮肤表现层与主题适配。
- 不改 HTML 分享、云端素材库（见路线图任务 2 的"明确保留"表）。

---

## 2. 概念模型

| 术语 | 定义 |
| --- | --- |
| **媒体生成** | 产出一个图片或视频文件的能力。本重构后**唯一实现**是 `seedream` / `seedance` skill 的脚本调用 |
| **内置媒体链路** | 被删除的那套：`mediaProvider` adapter + 设置页 provider 配置 + `media:*` IPC + 插件工具 + 前端选择器与轮询 |
| **皮肤工作流** | 受可信 `skin_pack` Kit 约束的两槽位资产工作流（`workspace.backdrop` → `home.emblem`），通过 `hiai_skin_manage` 注册与应⽤ |
| **账户作用域** | 曾用于把媒体任务绑定到登录账号的机制。已随登录体系移除，本重构彻底删除 |

**关键拆分**：皮肤工作流「需要一张图片」与「自己生成图片」是两件事。前者只要能拿到本地文件路径即可，后者由 skill 负责。二者通过 `register_asset` 的 `sourcePath` 解耦。

---

## 3. 用户旅程

### 主流程：用 skill 生图

1. 用户在会话里描述想要的图。
2. Agent 调用 `seedream` skill 脚本，参数为 prompt / 尺寸 / 输出目录。
3. 脚本落盘并打印本地路径。
4. 图片作为普通文件产物出现在对话与产物面板中。

### 主流程：生成皮肤

1. 用户选择内置「外观定制」Kit 并描述风格。
2. 运行时校验 Kit 的 `skin_pack` 标记，建立会话事务。
3. Agent 调用 `seedream` 脚本生成 `workspace.backdrop`，成功后 `hiai_skin_manage` 的 `register_asset` 注册。
4. 同上生成并注册 `home.emblem`。
5. `status` 确认两槽位就绪后 `apply`。

### 异常流程

| 场景 | 期望行为 |
| --- | --- |
| `seedream` 未配置 API Key | 脚本报错，Agent 告知用户去填 `config.json`，不凭空生成、不伪造成功 |
| 皮肤非 `skin_pack` 会话调用 `hiai_skin_manage` | 桥接端点返回错误，不创建草稿 |
| `sourcePath` 指向未注册或受管目录外文件 | 注册被拒绝，不进入下一槽位 |

---

## 4. 需求规格

### FR-1 删除内置媒体生成能力

- 删除 `src/main/libs/mediaProvider/`、`mediaGenerationPolicy`、`mediaGenerationReferences`、`mediaAssetPersistence`、`mediaGenerationTurnInstruction`、`mediaSelectionTypes`。
- 删除全部 `media:*` IPC、`CancelMediaTask`、`MediaStatusPollUpdate` 及 preload 暴露的 `window.api.media`。
- 删除设置页「媒体生成模型」区块与其 i18n 文案。

### FR-2 删除账户作用域

- 删除 `MediaAccountScope` / `LOCAL_MEDIA_OWNER_KEY` / `createAccountScopedFetch` / `scopedFetch` / `mediaTurnAccountScopeBySession`。
- 需要鉴权的请求统一走 `fetchWithAuth`，不再有"按会话区分账号"的分支。
- 删除 `authAccountChanged` / `mediaTaskAccountMismatch` 文案。

### FR-3 删除前端媒体选择与轮询展示

- 删除 `MediaModelPicker`、`MediaMentionPicker`、`mediaMentionUtils`、`MediaPollingIndicator`。
- 删除 `ToolCallGroup` 的 Lottie 生成指示器、`consolidateMediaPolling`、`retainedMediaPollCounts`、cowork slice 的 `updateToolUseMediaStatus` / `mediaModels` / `mediaSelection` / `clearMediaAccountState`。
- `@` 媒体引用映射（`buildMediaReferencePromptSection`）保留，但不再点名任何已删除工具。

### FR-4 皮肤工作流改为独立通道

- 插件 `openclaw-extensions/lobster-media-generation` 更名为 `openclaw-extensions/lobster-skin`，只注册 `hiai_skin_manage`。
- 桥接服务新增 `POST /skin/tool`；`McpRuntime` 提供 `setSkinToolHandler` / `getSkinCallbackUrl`；`openclawConfigSync` 在插件可用时写入 `lobster-skin` 条目。
- 皮肤事务不再产出 `mediaSelection`，只标记 `workflowKind: SkinPack`；生成后端从"结构化指令指定"改为"`seedream` skill 脚本"。

### 验收标准

1. 全仓库 `grep` 不到 `mediaProvider`、`mediaGenerationPolicy`、`hiai_image_generate`、`hiai_video_generate`、`MediaSelectionMode`、`mediaTurnAccountScopeBySession` 的存活引用（测试中作为"预期不存在"的反向断言除外）。
2. `tsc` 主进程与渲染进程双端 0 错误。
3. 皮肤相关测试（工作流、Store、工具处理器、Kit 生命周期）全部通过；`openclawConfigSync` 与插件清单测试通过。
4. 设置页不存在「媒体生成模型」入口；对话输入框不存在媒体模型选择器。
5. 皮肤工作流在只有 `seedream` skill 的环境下能完整走完 `create_draft → register_asset ×2 → status → apply`。

### 不做清单

- 不做内置媒体能力到 skill 的自动迁移（用户需自行填写 `config.json`）。
- 不为 `seedream` / `seedance` 增加 GUI 配置界面。
- 不恢复 `image_generate` / `video_generate` 的自定义 provider 能力。

---

## 5. 交互设计

| 界面 | 变化 |
| --- | --- |
| 设置页 | 移除「媒体生成模型」导航项与区块；相邻的「文本生成模型」保持不变 |
| 对话输入框 | 移除媒体模型选择器与 `@` 媒体选择器；技能/文件 `@` 引用不受影响 |
| 工具调用展示 | 生图过程按普通命令步骤展示（`Command` / `Tool` 种类），不再有专属 Lottie 与轮询倒计时 |
| 外观设置 | 不变：预览、应用、停用、删除仍可用 |

多轮与转发的状态机不变，只是"媒体任务"这一状态类别整体消失。

---

## 6. 架构设计

### 6.1 模块去留

| 模块 | 处置 |
| --- | --- |
| `src/main/libs/mediaProvider/**` | 删除 |
| `src/main/mediaGeneration{Policy,References}.ts`、`mediaAssetPersistence.ts`、`mediaAccountIsolation.ts` | 删除 |
| `src/main/mediaSelectionTypes.ts` | 删除 |
| `src/main/libs/agentEngine/mediaGenerationTurnInstruction.ts` | 删除 |
| `src/main/skins/skinMediaBridge.ts` | 删除（皮肤改用 `/skin/tool`） |
| `src/main/skins/skinToolHandler.ts` | 保留并恢复接入（皮肤唯一写入口） |
| `src/main/libs/mcpBridgeServer.ts` | 新增 `/skin/tool` 与 `SkinToolRequest` / `SkinToolResponse` |
| `src/main/mcp/mcpRuntime.ts` | 新增 `setSkinToolHandler` / `getSkinCallbackUrl` |
| `openclaw-extensions/lobster-skin/` | 仅保留 `hiai_skin_manage` |
| `SKILLs/skin-creator/SKILL.md` | 生图路线改为 `seedream` 脚本 |

### 6.2 关键契约

```
POST http://127.0.0.1:<port>/skin/tool
Header: x-lobster-media-secret: ${LOBSTER_MCP_BRIDGE_SECRET}
Body:   { tool: 'hiai_skin_manage', args: {...}, context: { sessionKey, toolCallId } }
Reply:  { content: [{ type: 'text', text }], isError?: boolean, details?: {...} }
```

配置同步写入：

```jsonc
"plugins": {
  "entries": {
    "lobster-skin": {
      "enabled": true,
      "config": {
        "callbackUrl": "<bridge>/skin/tool",
        "secret": "${LOBSTER_MCP_BRIDGE_SECRET}",
        "requestTimeoutMs": 30000
      }
    }
  }
}
```

### 6.3 选型理由

- **复用桥接而非新建进程间通道**：桥接已有 secret 鉴权、`readBody`、错误封装与 404 兜底，皮肤只需一条同构路由，避免再造一套鉴权。
- **插件只做转发**：皮肤库、校验、事务都在主进程；插件侧不持有任何业务状态，便于主进程独立测试。
- **皮肤不再关心后端选择**：删掉 `mediaSelection` 后，皮肤只认"一个本地文件路径"，后端变化（skill 换上游模型）不影响皮肤代码。

---

## 7. 实现

已落地，改动清单：

- 主进程：`main.ts`、`preload.ts`、`mcpBridgeServer.ts`、`mcp/mcpRuntime.ts`、`openclawConfigSync.ts`、`agentEngine/openclawRuntimeAdapter.ts`、`skins/*`、`i18n.ts`。
- 渲染进程：`App.tsx`、`Settings.tsx`、`cowork/*`、`coworkSlice.ts`、`artifactParser.ts`、`services/i18n.ts`、`types/{cowork,electron}.d.ts`。
- 插件与脚本：`openclaw-extensions/lobster-skin/*`、`scripts/electron-builder-hooks.cjs`。
- Skill：`SKILLs/skin-creator/SKILL.md`、`SKILLs/seedream/SKILL.md`、`SKILLs/seedance/SKILL.md`。

---

## 8. 验收

| # | 验收项 | 结论 |
| --- | --- | --- |
| 1 | 内置媒体链路代码全部删除，无存活引用 | ✅ |
| 2 | 账户作用域机制删除，鉴权统一走 `fetchWithAuth` | ✅ |
| 3 | 前端媒体选择器与轮询 UI 删除，`@` 媒体引用映射保留 | ✅ |
| 4 | 皮肤通过 `/skin/tool` + `lobster-skin` 插件可完整工作 | ✅ |
| 5 | 双端 `tsc` 0 错误 | ✅ |
| 6 | 主进程皮肤 / 配置同步 / 插件清单 / 桥接测试通过（178 项） | ✅ |
| 7 | 渲染进程全量测试通过（195 文件 / 1769 项） | ✅ |
| 8 | 改动文件 ESLint 0 error（余 8 条 `exhaustive-deps` 为既有历史告警，非本次引入） | ✅ |
| 9 | 设置页与输入框无媒体入口 | ✅（代码层核对） |

**待补**：手动跑一次 `npm run electron:dev`，确认设置页导航与输入框展示符合第 5 节，并完整走一遍皮肤生成。
