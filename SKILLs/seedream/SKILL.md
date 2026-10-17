---
name: seedream
description: 通过脚本调用 OpenAI 兼容图片接口（如火山方舟 doubao-seedream 系列）生成、编辑图片。当用户想生成图片、画一张图、做图片编辑、图像融合或生成组图时使用。先确认 config.json 已配置 API Key，再用 scripts/seedream.js 生成。
official: true
version: 3.0.0
---

# 图片生成（脚本方式）

图片生成通过本 skill 的脚本完成：`scripts/seedream.js` 调用 OpenAI 兼容的
`/images/generations` 接口（火山方舟 Seedream 系列即此格式）。

## 前置条件

1. 编辑 `SKILLs/seedream/config.json`，填入：
   - `apiBase`：接口地址，火山方舟为 `https://ark.cn-beijing.volces.com/api/v3`
   - `apiKey`：火山方舟控制台的 API Key
   - `model`：默认模型 ID，如 `doubao-seedream-4-5-251128`
2. 也可用环境变量覆盖：`SEEDREAM_API_BASE` / `SEEDREAM_API_KEY` / `SEEDREAM_MODEL`

若脚本报「未配置 API Key」，告知用户去填 config.json，**不要**自己猜密钥。

## 命令

```bash
node "$SKILLS_ROOT/seedream/scripts/seedream.js" generate --prompt "描述" [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--prompt <text>` | 必填。图片描述 |
| `--image <path>` | 单张参考图（本地路径 / URL / data URL），做图片编辑 |
| `--images <paths...>` | 多张参考图，空格分隔，做多图融合 |
| `--size <WxH>` | 输出尺寸，如 `1024x1024`、`2048x2048` |
| `--n <count>` | 生成张数 |
| `--model <id>` | 覆盖默认模型 |
| `--out <dir>` | 输出目录（默认 `~/Downloads/hiai-images`） |
| `--json` | 只输出 JSON 原始结果 |

**Windows 下用 `node` 直接执行，不要用 bash 包装。**

## 使用流程

1. 直接 generate。脚本同步返回，成功后会打印每个文件的保存路径或图片 URL。
2. 把保存路径告诉用户；如用户在预览面板查看，引用文件路径即可。

## 场景用法

- **文生图（T2I）**：只给 `--prompt`。
- **图片编辑（I2I）**：给 `--image` + 编辑指令，如「把背景换成海边日落，人物保持不变」。
- **多图融合**：给 `--images` 多张 + 指令，适合场景合成、角色一致性、风格迁移。
- **组图生成**：给 `--n`，输出自动编号保存。

## 提示词实践

好的提示词让出图一次到位：

1. **主体明确** —— 说清画面主要内容，而不是含糊的氛围词
2. **细节具体** ——「小猫在追逐蝴蝶」优于「小猫玩耍」
3. **风格与光照** —— 写清画风、色调、光线方向
4. **构图视角** —— 特写、全景、俯视、仰角等

模板：`[主体描述]，[场景/背景]，[风格]，[光照]，[构图视角]`

## 尺寸与耗时

小尺寸出图快，适合先确认构图；大尺寸（2K/4K）较慢，可能需要数十秒。
脚本默认超时 5 分钟。

## 已知模型参考

| 模型 ID | 特点 |
| --- | --- |
| `doubao-seedream-4-5-251128` | 综合质量最佳，推荐 |
| `doubao-seedream-4-0-250828` | 成熟稳定 |
| `doubao-seedream-5-0-260128` | 支持联网搜索增强（需 provider 私有参数时用 `--json` 后手工调 API） |

用户 config.json 里配置的模型优先；换模型用 `--model` 覆盖即可，不要改 config.json。
