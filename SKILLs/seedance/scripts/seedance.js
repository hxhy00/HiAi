#!/usr/bin/env node
'use strict';

/**
 * seedance — 视频生成脚本（火山方舟 /contents/generations/tasks 异步协议）
 *
 *   1. POST {apiBase}/contents/generations/tasks  -> { id }
 *   2. GET  {apiBase}/contents/generations/tasks?id=  -> status / content.video_url
 *
 * 配置优先级：环境变量 > config.json > 默认值
 *   SEEDANCE_API_BASE / SEEDANCE_API_KEY / SEEDANCE_MODEL / SEEDANCE_OUTPUT_DIR
 *
 * 用法：
 *   seedance.js generate --prompt "..." [--image first.png] [--last-frame last.png]
 *       [--duration 5] [--ratio 16:9] [--resolution 720p] [--audio] [--seed -1]
 *   seedance.js status <taskId>          查询任务状态（单次）
 *   seedance.js wait <taskId> [--timeout 秒]  轮询直到完成
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 配置 ----------

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // 允许缺省，全靠环境变量
  }
  return {
    apiBase: process.env.SEEDANCE_API_BASE || fileConfig.apiBase || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: process.env.SEEDANCE_API_KEY || fileConfig.apiKey || '',
    model: process.env.SEEDANCE_MODEL || fileConfig.model || 'doubao-seedance-1-5-pro-251215',
    pollIntervalMs: Number(process.env.SEEDANCE_POLL_INTERVAL_MS || fileConfig.pollIntervalMs || 5000),
    timeoutMs: Number(process.env.SEEDANCE_TIMEOUT_MS || fileConfig.timeoutMs || 600000),
    outputDir: process.env.SEEDANCE_OUTPUT_DIR || fileConfig.outputDir || '~/Downloads/hiai-videos',
  };
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`用法:
  seedance.js generate --prompt "<镜头描述>" [选项]
  seedance.js status <taskId>
  seedance.js wait <taskId> [--timeout <秒>]

generate 选项:
  --prompt <text>       视频描述，建议含镜头语言（必填）
  --image <path>        首帧参考图（本地路径 / URL / data URL）
  --last-frame <path>   尾帧图（首尾帧过渡）
  --duration <sec>      时长秒数（取值范围依模型，-1 自动）
  --ratio <16:9>        宽高比: 16:9 / 9:16 / 1:1 / adaptive
  --resolution <p>      480p / 720p / 1080p
  --audio               生成同步音频（加此开关）
  --camera-fixed        锁定镜头
  --seed <n>            随机种子，-1 随机
  --model <id>          覆盖默认模型 ID
  --out <dir>           输出目录
  --no-wait             提交后立即返回 taskId，不轮询`);
}

// ---------- HTTP ----------

async function requestJson(cfg, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  try {
    const resp = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(init && init.headers ? init.headers : {}),
      },
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data.error?.message || data.message || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function toRef(ref) {
  if (/^https?:\/\//.test(ref) || ref.startsWith('data:')) return ref;
  const abs = ref.replace(/^~(?=$|\/)/, os.homedir());
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---------- 命令 ----------

async function submitTask(cfg, args) {
  const prompt = args.prompt || args._.slice(1).join(' ');
  if (!prompt) { usage(); process.exit(1); }

  const content = [];
  if (args.image && typeof args.image === 'string') {
    content.push({ type: 'image_url', image_url: { url: await toRef(args.image) }, role: 'first_frame' });
  }
  if (args['last-frame'] && typeof args['last-frame'] === 'string') {
    content.push({ type: 'image_url', image_url: { url: await toRef(args['last-frame']) }, role: 'last_frame' });
  }
  content.push({ type: 'text', text: prompt });

  const body = { model: args.model || cfg.model, content };
  const params = {};
  if (args.duration && typeof args.duration === 'string') params.duration = Number(args.duration);
  if (args.ratio && typeof args.ratio === 'string') params.ratio = args.ratio;
  if (args.resolution && typeof args.resolution === 'string') params.resolution = args.resolution;
  if (args.audio === true) params.audio = true;
  if (args['camera-fixed'] === true) params.camera_fixed = true;
  if (args.seed && typeof args.seed === 'string') params.seed = Number(args.seed);
  if (Object.keys(params).length > 0) body.parameters = params;

  const url = `${cfg.apiBase.replace(/\/+$/, '')}/contents/generations/tasks`;
  const data = await requestJson(cfg, url, { method: 'POST', body: JSON.stringify(body) });
  const taskId = data.id;
  if (!taskId) throw new Error(`提交成功但未返回任务 ID: ${JSON.stringify(data)}`);
  console.log(`taskId: ${taskId}`);
  return taskId;
}

async function queryTask(cfg, taskId) {
  const url = `${cfg.apiBase.replace(/\/+$/, '')}/contents/generations/tasks?id=${encodeURIComponent(taskId)}`;
  return requestJson(cfg, url, { method: 'GET' });
}

async function waitTask(cfg, taskId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || cfg.timeoutMs);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    const data = await queryTask(cfg, taskId);
    const status = data.status || 'unknown';
    if (status === 'succeeded') return data;
    if (status === 'failed' || status === 'cancelled') {
      const err = data.error?.message || data.failure_reason || '未知原因';
      throw new Error(`任务 ${status}: ${err}`);
    }
    if (Date.now() > deadline) throw new Error(`等待超时（${Math.round((timeoutMs || cfg.timeoutMs) / 1000)}s），任务仍在 ${status}，可稍后用 status 命令重查: ${taskId}`);
    if (!process.env.SEEDANCE_QUIET) console.log(`状态: ${status}，${cfg.pollIntervalMs / 1000}s 后重查...`);
    await sleep(cfg.pollIntervalMs);
  }
}

async function downloadVideo(cfg, taskData, outDir) {
  const videoUrl = taskData?.content?.video_url;
  if (!videoUrl) { console.log(JSON.stringify(taskData, null, 2)); return; }
  const dir = outDir.replace(/^~(?=$|\/)/, os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(dir, `${stamp}.mp4`);
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error(`下载视频失败: HTTP ${resp.status}`);
  fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
  console.log(`已保存: ${file}`);
  const lastFrame = taskData?.content?.last_frame_url;
  if (lastFrame) {
    const frameFile = `${file.replace(/\.mp4$/, '')}-last-frame.png`;
    const fr = await fetch(lastFrame);
    if (fr.ok) fs.writeFileSync(frameFile, Buffer.from(await fr.arrayBuffer()));
    console.log(`尾帧已保存: ${frameFile}`);
  }
  console.log(`视频 URL（1 小时内有效）: ${videoUrl}`);
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'generate';
  if (command === 'help' || args.help) { usage(); return; }

  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.apiKey.includes('填入')) {
    console.error('未配置 API Key。请编辑 SKILLs/seedance/config.json 的 apiKey 字段，');
    console.error('或设置环境变量 SEEDANCE_API_KEY。');
    process.exit(1);
  }

  try {
    if (command === 'generate') {
      const taskId = await submitTask(cfg, args);
      if (args['no-wait'] === true) return;
      const data = await waitTask(cfg, taskId, typeof args.timeout === 'string' ? Number(args.timeout) * 1000 : undefined);
      await downloadVideo(cfg, data, args.out || cfg.outputDir);
    } else if (command === 'status') {
      const taskId = args._[1];
      if (!taskId) { usage(); process.exit(1); }
      const data = await queryTask(cfg, taskId);
      console.log(JSON.stringify(data, null, 2));
    } else if (command === 'wait') {
      const taskId = args._[1];
      if (!taskId) { usage(); process.exit(1); }
      const data = await waitTask(cfg, taskId, typeof args.timeout === 'string' ? Number(args.timeout) * 1000 : undefined);
      await downloadVideo(cfg, data, args.out || cfg.outputDir);
    } else {
      console.error(`未知命令: ${command}`);
      usage();
      process.exit(1);
    }
  } catch (err) {
    console.error(`[seedance] ${err.message}`);
    process.exit(1);
  }
}

main();
