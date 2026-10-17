#!/usr/bin/env node
'use strict';

/**
 * seedream — 图片生成脚本（OpenAI 兼容 /images/generations）
 *
 * 配置优先级：命令行 > 环境变量 > config.json > 默认值
 *   SEEDREAM_API_BASE / SEEDREAM_API_KEY / SEEDREAM_MODEL / SEEDREAM_OUTPUT_DIR
 *
 * 用法：
 *   seedream.js generate --prompt "一只橘猫" [--image a.png] [--images a.png b.png]
 *                       [--size 1024x1024] [--n 1] [--model ID] [--out dir]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------- 配置 ----------

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // 没有 config.json 也可以，全靠环境变量
  }
  return {
    apiBase: process.env.SEEDREAM_API_BASE || fileConfig.apiBase || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: process.env.SEEDREAM_API_KEY || fileConfig.apiKey || '',
    model: process.env.SEEDREAM_MODEL || fileConfig.model || 'doubao-seedream-4-5-251128',
    outputDir: process.env.SEEDREAM_OUTPUT_DIR || fileConfig.outputDir || '~/Downloads/hiai-images',
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
  console.log(`用法: seedream.js generate --prompt "<描述>" [选项]

选项:
  --prompt <text>     图片描述（必填）
  --image <path>      参考图（单张，本地路径 / URL / data URL）
  --images <paths...> 多张参考图，空格分隔
  --size <WxH>        输出尺寸，如 1024x1024、2048x2048
  --n <count>         生成张数
  --model <id>        覆盖默认模型 ID
  --out <dir>         输出目录
  --json              只输出 JSON 结果`);
}

// ---------- API ----------

async function generateImage(cfg, opts) {
  const url = `${cfg.apiBase.replace(/\/+$/, '')}/images/generations`;
  const body = { model: opts.model, prompt: opts.prompt };
  if (opts.size) body.size = opts.size;
  if (opts.n) body.n = Number(opts.n);
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  // 参考图：单张走 image 字段（方舟支持 URL/data URL；本地文件转 data URL）
  const images = [];
  if (opts.images && opts.images !== true) {
    images.push(...String(opts.images).split(/[\s,]+/).filter(Boolean));
  }
  if (opts.image && opts.image !== true) images.push(opts.image);
  if (images.length === 1) body.image = await toRef(images[0]);
  else if (images.length > 1) body.image = await Promise.all(images.map(toRef));

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  }, DEFAULT_TIMEOUT_MS);

  const data = await resp.json();
  if (!resp.ok || data.error) {
    const msg = data.error?.message || data.message || `HTTP ${resp.status}`;
    throw new Error(`图片生成失败: ${msg}`);
  }
  return data;
}

async function toRef(ref) {
  if (/^https?:\/\//.test(ref) || ref.startsWith('data:')) return ref;
  const abs = ref.replace(/^~(?=$|\/)/, os.homedir());
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 输出 ----------

function extFromDataUrl(dataUrl) {
  const m = /^data:image\/([a-z+]+);/.exec(dataUrl);
  if (!m) return 'png';
  return m[1] === 'jpeg' ? 'jpg' : m[1] === 'svg+xml' ? 'svg' : m[1];
}

async function saveOutputs(data, outDir, jsonOnly) {
  const items = Array.isArray(data.data) ? data.data : [];
  const saved = [];
  const dir = outDir.replace(/^~(?=$|\/)/, os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let file = null;
    if (item.b64_json) {
      const ext = item.output_format || 'png';
      file = path.join(dir, `${stamp}-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(item.b64_json, 'base64'));
    } else if (item.url && item.url.startsWith('data:')) {
      const ext = extFromDataUrl(item.url);
      file = path.join(dir, `${stamp}-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(item.url.split(',')[1], 'base64'));
    }
    saved.push({ index: i + 1, url: item.url && !item.url.startsWith('data:') ? item.url : undefined, file });
  }
  if (!jsonOnly) {
    for (const s of saved) {
      if (s.file) console.log(`已保存: ${s.file}`);
      else if (s.url) console.log(`图片 URL: ${s.url}`);
    }
    if (saved.length === 0) console.log(JSON.stringify(data, null, 2));
  }
  return saved;
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'generate';
  if (command === 'help' || args.help) { usage(); return; }
  if (command !== 'generate') {
    console.error(`未知命令: ${command}（仅支持 generate）`);
    process.exit(1);
  }

  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.apiKey.includes('填入')) {
    console.error('未配置 API Key。请编辑 SKILLs/seedream/config.json 的 apiKey 字段，');
    console.error('或设置环境变量 SEEDREAM_API_KEY。接口地址以火山方舟为例：');
    console.error('  https://ark.cn-beijing.volces.com/api/v3');
    process.exit(1);
  }

  const prompt = args.prompt || args._.slice(1).join(' ');
  if (!prompt) { usage(); process.exit(1); }

  const jsonOnly = args.json === true;
  try {
    const data = await generateImage(cfg, {
      prompt,
      model: args.model || cfg.model,
      size: typeof args.size === 'string' ? args.size : undefined,
      n: typeof args.n === 'string' ? args.n : undefined,
      image: typeof args.image === 'string' ? args.image : undefined,
      images: typeof args.images === 'string' ? args.images : undefined,
    });
    await saveOutputs(data, args.out || cfg.outputDir, jsonOnly);
    if (jsonOnly) console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[seedream] ${err.message}`);
    process.exit(1);
  }
}

main();
