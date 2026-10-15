# 品牌迁移 HiAi 验收单

日期：2026-10-15
分支：`feature/rebrand-hiai`（基于 `main`，截至本文 32 个提交）。**已合入 `develop`（`21074a6`）并删除分支**，与 `main` 同名提交亦已同步。
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
| AC-RB-10 | GUI 冒烟：首次启动目录/库文件迁移、模型列表无「套餐模型」分组、导出文件名与 scheme | ✅ 已完成（见 §3.1；迁移与 scheme 经用户决定不做人工验证，理由见下） |
| AC-RB-11 | 数据迁移备份/回滚文件名为 `hiai-backup-*` / `hiai-rollback-*` | ✅（§3.2 缺陷修复后） |
| AC-RB-12 | 归档内部标识为 `hiai-data-migration` / `.hiai-migration.json` | ✅（clean cut，旧备份不再可导入，用户已确认接受） |

### 3.1 GUI 冒烟结果（2026-10-15 人工）

| 检查项 | 结果 |
| --- | --- |
| 模型列表无「套餐模型」分组（同时满足 remove-membership AC-SM-9） | ✅ 通过 |
| 媒体生成模型页：图片/视频两块上下排列、左列表右表单、块内滚动、独立保存 | ✅ 通过（同媒体 spec AC-4/11） |
| 导出/备份文件名 | ❌ **首次冒烟不通过**——文件名仍为 `lobsterai-backup-20261015-165254.tar.gz`，详见 §3.2 |
| 导出/备份文件名（复查） | ✅ 通过——`hiai-backup-*.tar.gz`，用户确认 |
| 启动目录/库文件迁移 | ⏭️ **用户决定不做人工验证** |
| `hiai://` scheme 唤起 | ⏭️ **用户决定不做人工验证** |

**跳过依据**：这两项需人工构造环境（前项要保留旧 `LobsterAI` 数据目录再启动新版，后项要在浏览器地址栏敲 scheme），
用户评估成本后决定跳过。二者的实现逻辑均有单元测试覆盖（`userDataDirMigration`、`appConstants` 的 scheme 常量断言）。
此决定为**已知风险接受**，非「无法验证」：若后续线上出现迁移未生效或 scheme 无法唤起，应回到本项重新排查。

### 3.2 缺陷修复：备份文件名遗漏（2026-10-15）

**现象**：用户实际执行备份，产出 `/Users/hxhy/Downloads/lobsterai-backup-20261015-165254.tar.gz`。

**根因**：`src/main/libs/dataMigration/dataMigrationService.ts` 中品牌迁移时漏改 5 处：

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `buildDataMigrationBackupFileName` | `lobsterai-backup-*` | `hiai-backup-*` |
| `buildDataMigrationRollbackFileName` | `lobsterai-rollback-*` | `hiai-rollback-*` |
| `MANIFEST_FILE_NAME` | `.lobsterai-migration.json` | `.hiai-migration.json` |
| `ARCHIVE_FORMAT` | `lobsterai-data-migration` | `hiai-data-migration` |
| `PENDING_RESTORE_FILE_NAME` / `LAST_RESTORE_RESULT_FILE_NAME` | `.lobsterai-data-migration-*` | `.hiai-data-migration-*` |

#### 3.2.1 顺带发现的三处同类遗漏（同一根因，一并修复）

按 §4 结尾「逐点裁决可见性」的新规则重扫全部 `rg -i lobster src` 命中，又找出 3 个直接写进
用户下载目录的旧品牌文件名——它们的共同特征是「字符串模板，而非可搜索的字面文件名」，
此前的核查方式（按文件归类）系统性地漏掉了这一类：

| 位置 | 改前 | 改后 | 可见路径 |
| --- | --- | --- | --- |
| `main.ts` `buildLogExportFileName` | `lobsterai-logs-*.zip` | `hiai-logs-*.zip` | 设置页「导出日志」→ 下载目录 |
| `archive.ts` `buildSessionDiagnosticsDefaultFileName` | `lobsterai-diagnostics-*.zip` | `hiai-diagnostics-*.zip` | 会话诊断包保存对话框默认名 |
| `ProposedPlanBlock.tsx` `anchor.download` | `lobsterai-plan-*.md` | `hiai-plan-*.md` | 计划块「下载」按钮 → 下载目录 |

同时裁决为**不改**（理由已入 §4）：computerUse 安装包名（服务端资源，改名会 404）、
更新包名（内部 `userData/updates` + 在途包识别前缀）、安装/迁移 sentinel 文件（改名会被
判为未安装而重复执行）、tmpdir 前缀（用户不可见）。

**验证**：`tsc --noEmit` 退出码 0；5 个改动源文件 eslint `--max-warnings 0` 零告警；
`dataMigrationService.test.ts` 20/20、`archive.test.ts` 3/3、`repository.test.ts` 2/2 通过
（诊断包测试的文件名长度断言由 91 同步为 86）。

**为何此前漏检**：AC-RB-5 的核查以「命中项是否属用户可见」为判据，而这几处直接写在字符串模板与常量里，
`rg -i lobster src` 的关键词模式匹配到了，但在归类 §4 时被笼统当作「内部标识」放过——
判据本身没错（备份文件名的确同时有用户可见与兼容两重属性），错在**未对每个命中的可见性单独裁决**。

**兼容性决策**：归档内部标识一并改名（clean cut），**更名前导出的备份不再可导入**。
与 AC-RB-4 的 provider 配置处理同属一类，用户已明确确认。`ACCEPTED_ARCHIVE_ROOTS` /
`ACCEPTED_DB_FILE_NAMES` 的旧名兼容分支保留（删它只会扩大 diff），但注释已更新说明其实际不可达。

**验证**：`tsc --noEmit` 退出码 0；两文件 eslint `--max-warnings 0` 零告警；
`dataMigrationService.test.ts` 20/20 通过；全仓（`src`/`tests`/`scripts`）无旧归档标识残留。

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
| `lobsterai-computer-use-runtime-*.zip` 安装包名与下载 URL | `src/main/computerUse/computerUseRuntime.ts`、`src/shared/computerUse/constants.ts` | **服务端已发布资源**：URL 路径含旧名，客户端改名会 404。`archivePrefix`（第 619 行）用于清理下载目录里的旧安装包，必须与远端实际文件名保持一致。改名前需先由服务端重新发布资源 |
| `lobsterai-update-*.{zip,dmg,exe}.download` 更新包名 | `src/main/libs/appUpdateInstaller.ts`、`appUpdateCoordinator.ts` | 写入 `userData/updates`（内部路径，用户不可见）；且 `appUpdateCoordinator` 按 `lobsterai-update-` 前缀识别与清理**在途更新包**，改名会让升级中断时的残留文件无法被回收 |
| `.lobsterai-install-ok.json`、`.lobsterai-cron-doctor-openclaw.json`、`.lobsterai-writer-lock` 等 sentinel | `dshRuntimeInstaller.ts`、`openclawCronLegacyMigration.ts`、`dshSharedHome.ts` | 内部状态哨兵文件，用于判断「是否已安装/已迁移/已加锁」；改名会导致**已安装用户被判定为未安装**、重复安装或重复迁移 |
| `lobsterai-*` 命名的 tmpdir 前缀（`lobsterai-preview`、`lobsterai-browser-probe.html`、`lobsterai-app-icon-`、`lobsterai-kit-`） | `main.ts`、`shellApps.ts`、`ipcHandlers/kits/handlers.ts` | 系统临时目录内部命名，随进程结束清理，用户不可见 |
| `LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP` | `src/main/libs/sqliteBackup/constants.ts` | 测试/调试用环境变量契约，同 §4 首条 |

**结论**：`src` 内旧品牌字样 2140 处命中，逐项归入上表后，无一处属于应改未改的用户可见品牌表面。

**核查方法教训（2026-10-15 补）**：此前归类的失误在于按**文件或模块**批量判定，而非按**每个命中点**判定。
`dataMigrationService.ts` 被整体当作「内部标识」放过，其中却混着直接写进用户看到的文件名的字符串模板。
后续核查规则：每个 `rg` 命中单独裁决可见性，「同文件其余命中属内部」不构成放过理由。

## 5. 遗留与下一步

- [x] AC-RB-10：GUI 冒烟完成。迁移与 scheme 两项**经用户决定跳过**（依据见 §3.1），
      不阻塞验收；如线上出现对应问题再回本单排查。
- [x] 分支合并：已合回 `develop`（`21074a6 Merge branch 'feature/rebrand-hiai' into develop`），
      本地分支已删除，远端无该分支。本条闭环。
- §4 表格是「允许保留」的权威清单；后续若发现表中之外的旧品牌命中，按品牌残留处理并更新本单。
