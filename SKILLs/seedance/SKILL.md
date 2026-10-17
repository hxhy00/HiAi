---
name: seedance
description: 通过脚本调用火山方舟视频生成接口（doubao-seedance 系列）生成 AI 视频。当用户想生成视频、做文生视频、图生视频、首尾帧过渡视频时使用。任务为异步提交 + 轮询，脚本已封装。
official: true
version: 3.0.0
---

# 视频生成（脚本方式）

视频生成通过本 skill 的脚本完成：`scripts/seedance.js` 调用火山方舟
`/contents/generations/tasks` 异步协议（提交 → 轮询 → 下载）。

## 前置条件

1. 编辑 `SKILLs/seedance/config.json`，填入：
   - `apiBase`：火山方舟为 `https://ark.cn-beijing.volces.com/api/v3`
   - `apiKey`：火山方舟控制台的 API Key
   - `model`：默认模型 ID，如 `doubao-seedance-1-5-pro-251215`
2. 也可用环境变量覆盖：`SEEDANCE_API_BASE` / `SEEDANCE_API_KEY` / `SEEDANCE_MODEL`

## 命令

```bash
node "$SKILLS_ROOT/seedance/scripts/seedance.js" generate --prompt "镜头描述" [选项]
node "$SKILLS_ROOT/seedance/scripts/seedance.js" status <taskId>
node "$SKILLS_ROOT/seedance/scripts/seedance.js" wait <taskId> [--timeout <秒>]
```

**Windows 下用 `node` 直接执行，不要用 bash 包装。**

### generate 选项

| 选项 | 说明 |
| --- | --- |
| `--prompt <text>` | 必填。视频描述，建议含镜头语言（推拉摇移、景别、光线） |
| `--image <path>` | 首帧参考图（本地路径 / URL / data URL） |
| `--last-frame <path>` | 尾帧图，做首尾帧过渡 |
| `--duration <sec>` | 时长秒数（范围依模型，`-1` 自动） |
| `--ratio <16:9>` | 宽高比：`16:9` / `9:16` / `1:1` / `adaptive` |
| `--resolution <p>` | `480p` / `720p` / `1080p` |
| `--audio` | 生成同步音频（部分模型支持） |
| `--camera-fixed` | 锁定镜头（不运动） |
| `--seed <n>` | 随机种子，`-1` 随机；同种子同参数结果相近 |
| `--model <id>` | 覆盖默认模型 |
| `--out <dir>` | 输出目录（默认 `~/Downloads/hiai-videos`） |
| `--no-wait` | 只提交不等待，立即返回 taskId |

## 使用流程

1. generate 默认会提交任务并轮询到完成，自动下载 mp4 到输出目录，
   打印保存路径与视频 URL（URL 一小时内有效）。
2. 视频生成耗时较长（数十秒到几分钟）。若轮询超时，脚本会打印 taskId，
   稍后用 `status <taskId>` 重查，再用 `wait <taskId>` 接着等并下载。
3. 提交失败时脚本会报上游错误信息（鉴权失败 / 余额不足 / 内容审核拒绝等），如实转告用户。

## 提示词实践

视频提示词的关键是**镜头语言**：

```
[镜头运动]，[主体动作]，[场景氛围]，[光线与风格]
```

例：`缓慢推镜，一只橘猫在窗台伸懒腰，午后暖光洒进房间，写实电影感`

- 多主体动作建议拆分描述先后顺序
- 图生视频时 prompt 描述「让画面如何动起来」，而不是重复图片内容
- 首尾帧过渡：`--image` 起始画面 + `--last-frame` 结束画面 + 简短过渡描述

## 已知模型参考

| 模型 ID | 特点 |
| --- | --- |
| `doubao-seedance-1-5-pro-251215` | 质量优先，支持音频 |
| `doubao-seedance-2-0-fast` | 速度快，性价比高 |

用户 config.json 里配置的模型优先；换模型用 `--model` 覆盖即可。
