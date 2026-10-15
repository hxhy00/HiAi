# 品牌迁移 HiAi 验收单

日期：2026-10-15
分支：`feature/rebrand-hiai`（基于 `main`，截至本文 32 个提交，未推送、未合并）
范围：`main...feature/rebrand-hiai` 全量 diff（333 文件，+3209 / −2992）。

## 1. 问题定义

LobsterAI 更名 HiAi。改名涉及三层：

1. **用户可见表面**：应用名、安装器、关于页、错误页、设置文案、许可声明。
2. **持久化身份**：应用标识（`com.hiai.app`）、用户数据目录、SQLite 文件名、URL scheme、导出备份格式标识。
3. **内部标识符**（兼容层，见 §4）：部分旧名保留，属有意决策而非遗漏。

## 2. 已完成改动（按提交时间序，关键项）

| 提交 | 内容 |
| --- | --- |
| `5a459d3` | 应用更名为 HiAi，用户数据目录迁移（`userDataDirMigration`） |
| `dc04976` | 数据库文件改名 `hiai.sqlite`，旧库随迁移重命名（`renameLegacySqliteFiles`） |
| `bffcc7c` | 应用标识 `hiai` / `com.hiai.app` |
| `81544ce` | 导出标识与口令改为 `hiai`（保留旧导出文件导入能力） |
| `bba1825` | 关于页精简，更新开源地址与联系方式 |
| `fa81cd0` | 打包身份与安装器改名 HiAi（`electron-builder.json`: `com.hiai.app` / `HiAi` / scheme `hiai`） |
| `1f9e683` | 用户可见品牌文案统一改为 HiAi |
| `e0412e8` | 重新生成 Word / Sheet 第三方许可声明 |
| `9ed8b39` | 导出与备份标识彻底切换；清理登录过期死代码 |
| `5281e2b` | OpenClaw 运行时标识去掉旧品牌前缀 |
| `893cda7` / `00fbca3` | 页面残留旧品牌清理；错误页标题改 HiAi |
| `6ed84c4` | 任务容器目录 `.lobsterai-tasks` → `.hiai-tasks`（直接替换，无写入侧、无存量数据，不迁移） |

注：分支同时承载去会员化、媒体本地化、语音本地化、管理页列表化等前置重构，
其验收记录分别在 `specs/refactors/remove-membership/`、`specs/features/media-generation/`、
`specs/features/management-list-view/`，不在本单重复。

## 3. 验收标准与结果

| 编号 | 标准 | 结果 |
| --- | --- | --- |
| AC-RB-1 | `package.json` / `electron-builder.json`：`name=hiai`、`productName=HiAi`、`appId=com.hiai.app`、scheme `hiai` | ✅（已核对源文件） |
| AC-RB-2 | SQLite 文件为 `hiai.sqlite`，旧 `lobsterai.sqlite` 启动时自动重命名迁移 | ✅（代码在位；`b527eb2` 修复缺失导入后 compile 通过） |
| AC-RB-3 | 用户数据目录迁移逻辑在位（`src/main/libs/userDataDirMigration.ts`） | ✅（代码在位，真实升级路径待 GUI 冒烟） |
| AC-RB-4 | 导出/备份格式标识 `hiai.providers`（clean cut：旧版导出文件不保证可导入，用户已接受） | ✅ |
| AC-RB-5 | 用户可见文案零旧品牌残留 | ✅（`rg -i lobster src` 命中项均为内部标识符或 CSS 变量，见 §4） |
| AC-RB-6 | 第三方许可声明重新生成（Word / Sheet） | ✅（`e0412e8`） |
| AC-RB-7 | 改动文件 CI 同款 eslint `--max-warnings 0` 零告警 | ✅（`6ed84c4` 时点逐文件通过；remove-membership 复核亦确认 133 文件零告警） |
| AC-RB-8 | `npm test` 全绿 | ✅（复验 6301 用例通过；唯一失败为 `tests/openclaw-plugin-patches-popo-sdk.test.ts` 既有失败，与改动无关） |
| AC-RB-9 | `npm run compile:electron` / `npm run build` 通过 | ✅（复验退出码 0） |
| AC-RB-10 | GUI 冒烟：首次启动目录/库文件迁移、模型列表无「套餐模型」分组、导出文件名与 scheme | ⏳ 待人工执行（与 remove-membership AC-SM-9 同次跑完） |

## 4. 内部标识符决策记录（有意保留，不属品牌残留）

以下命中 `rg -i lobster src` 的位置**不改**；改任何一项都需先评估兼容性并在本节更新：

| 标识符 | 位置 | 保留理由 |
| --- | --- | --- |
| `lobsterai_` 埋点 action 前缀 | `src/shared/analytics/constants.ts` | 上报端按前缀聚合历史数据，改前缀会割裂报表口径；更换需服务端配合 |
| `LOBSTERAI_ELECTRON_PATH` 等环境变量 | `src/main/libs/coworkUtil.ts` 等 | 脚本/工具链契约，需同步 OpenClaw 侧使用方 |
| `LOBSTER_COMPUTER_USE_*`、`LOBSTER_APIKEY_*` 环境变量 | `src/main/computerUse/`、`openclawConfigSync.ts` | 同上，跨进程/跨运行时契约 |
| `--lobster-*` CSS 变量与 design token | `themes.css`、`tokens/contract.ts`、`tailwind/plugin.cjs` 等 | 纯内部命名，无用户可见影响；整体替换收益低、diff 面大（约 900 处），待设计 token 体系下一次演进时一并处理 |
| `lobsterAIRequestOptions` / `lobsterBrowserMcpServer` 文件名及导出名 | `src/shared/providers/`、`src/main/libs/` | 内部 API 命名，重命名属纯 churn |
| `ProviderName.LobsteraiServer` | provider 解析 | remove-membership AC-SM-3 明确保留（服务端 provider 遗留兼容） |
| `claude_session_id`、`cowork:*` IPC 通道等历史列名 | SQLite / IPC | AGENTS.md 已声明为兼容历史名，与品牌无关 |

**结论**：`src` 内旧品牌字样 2140 处命中，逐项归入上表后，无一处属于应改未改的用户可见品牌表面。

## 5. 遗留与下一步

- [ ] AC-RB-10：GUI 冒烟（需人工，`npm run electron:dev`；同时覆盖 remove-membership AC-SM-9）。
- [ ] 分支合并：验收全部通过后合回 `develop`（Git Flow），推送由用户手动执行。
- §4 表格是「允许保留」的权威清单；后续若发现表中之外的旧品牌命中，按品牌残留处理并更新本单。
