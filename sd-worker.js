// sd-worker.js — Web Worker内でsdcpp wasm(WebGPU)を動かす
// 参照実装: naidan stable-diffusion-cpp-browser(MIT) / browser-inference-core(MIT)
import schema from './sdcpp-runtime/3ddb0cb2589244dd4494ffbcd0117c2a3bd3a2a6/api/schema.mjs';
import { attachCore } from './sdcpp-runtime/3ddb0cb2589244dd4494ffbcd0117c2a3bd3a2a6/examples/runtime/bindings.mjs';
import { mountReadOnlyFile } from './sdcpp-runtime/3ddb0cb2589244dd4494ffbcd0117c2a3bd3a2a6/examples/runtime/read-only-file.mjs';

const BASE = './sdcpp-runtime/3ddb0cb2589244dd4494ffbcd0117c2a3bd3a2a6';
const PROFILE = 'webgpu-wasm32-asyncify';
const COMMIT = 'f973fc41ec7545364ac9776c2440285f43ff2a30'; // circlestone-labs/Anima

// 固定モデル(Anima-Turbo v1.1)— bytesはHF実測値(進捗計算用)
const MODEL_SOURCES = [
  { slot: 'diffusion', path: '/models/anima-turbo-v1.1.safetensors', bytes: 4182230656, url: `https://huggingface.co/circlestone-labs/Anima/resolve/${COMMIT}/split_files/diffusion_models/anima-turbo-v1.1.safetensors` },
  { slot: 'vae', path: '/models/qwen_image_vae.safetensors', bytes: 253806246, url: `https://huggingface.co/circlestone-labs/Anima/resolve/${COMMIT}/split_files/vae/qwen_image_vae.safetensors` },
  { slot: 'lm', path: '/models/qwen_3_06b_base.safetensors', bytes: 1192135096, url: `https://huggingface.co/circlestone-labs/Anima/resolve/${COMMIT}/split_files/text_encoders/qwen_3_06b_base.safetensors` },
];
// 固定LoRA(HF移管後にURL確定・multiplierは確定値)
const LORA_SOURCES = [];
const CACHE = 'web-ai-demo2-models-v1';

let core = null;
let context = 0n;
let modelVersion = '';

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function log(message) { post({ type: 'log', message }); }

async function gunzipWasm(gzBuffer) {
  const stream = new Blob([gzBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- モデルDL(Cache Storage・進捗通知) ----
async function downloadModel(src) {
  const c = await caches.open(CACHE);
  const hit = await c.match(src.url);
  if (hit) {
    post({ type: 'dl', slot: src.slot, frac: 1, cached: true });
    return await hit.blob();
  }
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`モデルDL失敗 HTTP ${res.status}: ${src.url}`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    const now = Date.now();
    if (now - last > 250) { last = now; post({ type: 'dl', slot: src.slot, frac: got / src.bytes }); }
  }
  const blob = new Blob(chunks);
  await c.put(src.url, new Response(blob));
  post({ type: 'dl', slot: src.slot, frac: 1 });
  return blob;
}

function blobSource(blob) {
  return {
    size: blob.size,
    read(destination, offset) {
      const len = Math.min(destination.length, blob.size - offset);
      if (len <= 0) return 0;
      const buf = new FileReaderSync().readAsArrayBuffer(blob.slice(offset, offset + len));
      destination.set(new Uint8Array(buf));
      return len;
    },
  };
}

// ---- コア起動 ----
async function startCore() {
  const createCore = (await import(`${BASE}/${PROFILE}/core.mjs`)).default;
  const gz = await (await fetch(`${BASE}/${PROFILE}/core.wasm.gz`)).arrayBuffer();
  const wasmBinary = await gunzipWasm(gz);
  log(`sdcpp wasm 準備完了 (${(wasmBinary.length / 1048576).toFixed(1)}MB)`);
  const module = await createCore({
    wasmBinary,
    print: m => { if (m && !/^\s*$/.test(m)) log('[sdcpp] ' + m); },
    printErr: m => { if (m && !/^\s*$/.test(m)) log('[sdcpp!] ' + m); },
  });
  core = attachCore(module, schema, { suspension: 'asyncify' });
  log(`コア起動 OK (pointerBytes=${core.pointerBytes})`);
}

// ---- マウント → new_sd_ctx ----
async function initContext() {
  const blobs = new Map();
  for (const src of MODEL_SOURCES) blobs.set(src.slot, await downloadModel(src));
  for (const lora of LORA_SOURCES) lora.blob = await downloadModel({ ...lora, slot: 'lora:' + lora.name });
  try { core.module.FS.mkdir('/models'); } catch (e) { /* 既存 */ }
  const paths = new Map();
  for (const src of MODEL_SOURCES) {
    const source = blobSource(blobs.get(src.slot));
    mountReadOnlyFile(core, src.path, source, { maxChunkBytes: 8 * 1024 * 1024 });
    paths.set(src.slot, src.path);
    log(`マウント: ${src.path} (${(source.size / 1073741824).toFixed(2)}GB)`);
  }
  for (const lora of LORA_SOURCES) {
    mountReadOnlyFile(core, lora.path, blobSource(lora.blob), { maxChunkBytes: 8 * 1024 * 1024 });
    log(`マウント: ${lora.path}`);
  }

  const ctxParams = core.allocRecord('sd_ctx_params_t');
  await core.api.sd_ctx_params_init(ctxParams);
  const text = v => core.utf8(v);
  core.setField('sd_ctx_params_t', ctxParams, 'diffusion_model_path', text(paths.get('diffusion')));
  core.setField('sd_ctx_params_t', ctxParams, 'vae_path', text(paths.get('vae')));
  core.setField('sd_ctx_params_t', ctxParams, 'llm_path', text(paths.get('lm')));
  core.setField('sd_ctx_params_t', ctxParams, 'n_threads', 1);
  core.setField('sd_ctx_params_t', ctxParams, 'enable_mmap', 0);
  core.setField('sd_ctx_params_t', ctxParams, 'disable_prefetch', 0);
  core.setField('sd_ctx_params_t', ctxParams, 'eager_load', 1);
  core.setField('sd_ctx_params_t', ctxParams, 'auto_fit', 0);
  core.setField('sd_ctx_params_t', ctxParams, 'backend', text('WebGPU'));
  core.setField('sd_ctx_params_t', ctxParams, 'params_backend', 0n);
  core.setField('sd_ctx_params_t', ctxParams, 'max_vram', 0n);
  core.setField('sd_ctx_params_t', ctxParams, 'webgpu_bf16_type', core.constant('SD_TYPE_F16'));
  core.setField('sd_ctx_params_t', ctxParams, 'flash_attn', 1);
  core.setField('sd_ctx_params_t', ctxParams, 'diffusion_flash_attn', 1);
  core.setField('sd_ctx_params_t', ctxParams, 'conditioning_cache_size', 2);

  log('モデル読み込み開始(数分かかります)…');
  post({ type: 'stage', stage: 'model-load' });
  context = await core.api.new_sd_ctx(ctxParams);
  if (!context) throw new Error('モデル初期化に失敗(上のsdcppログを確認)');
  if (await core.api.sd_ctx_supports_image_generation(context) !== 1) {
    throw new Error('このコンテキストは画像生成に対応していません');
  }
  modelVersion = core.readUtf8(await core.api.sd_get_model_version_name(context), 256) || 'Unknown';
  log(`モデル読込完了: ${modelVersion}`);
  post({ type: 'ready', modelVersion });
}

// ---- 生成 ----
async function generate(req) {
  const { prompt, negativePrompt = '', width = 1024, height = 1024, steps = 8, guidance = 1, seed = -1 } = req;
  const text = v => core.utf8(v);
  const params = core.allocRecord('sd_img_gen_params_t');
  await core.api.sd_img_gen_params_init(params);
  core.setField('sd_img_gen_params_t', params, 'prompt', text(prompt));
  core.setField('sd_img_gen_params_t', params, 'negative_prompt', text(negativePrompt));
  core.setField('sd_img_gen_params_t', params, 'width', width);
  core.setField('sd_img_gen_params_t', params, 'height', height);
  core.setField('sd_img_gen_params_t', params, 'seed', BigInt(seed));
  core.setField('sd_img_gen_params_t', params, 'batch_count', 1);

  // LoRA(固定)
  const active = LORA_SOURCES.filter(l => l.multiplier !== 0);
  if (active.length) {
    const recBytes = core.recordSize('sd_lora_t');
    const records = core.alloc(recBytes * active.length);
    core.bytes(records, recBytes * active.length).fill(0);
    active.forEach((l, i) => {
      const p = records + BigInt(i * recBytes);
      core.setField('sd_lora_t', p, 'is_high_noise', 0);
      core.setField('sd_lora_t', p, 'multiplier', l.multiplier);
      core.setField('sd_lora_t', p, 'path', text(l.path));
    });
    core.setField('sd_img_gen_params_t', params, 'loras', records);
    core.setField('sd_img_gen_params_t', params, 'lora_count', active.length);
  }

  // サンプラー: Anima-Turbo推奨 euler / simple / steps8 / CFG1
  const sampleMethod = await core.api.str_to_sample_method(text('euler'));
  const sampleScheduler = await core.api.str_to_scheduler(text('simple'));
  const sample = core.fieldAddress('sd_img_gen_params_t', params, 'sample_params');
  core.setField('sd_sample_params_t', sample, 'sample_method', Number(sampleMethod));
  core.setField('sd_sample_params_t', sample, 'scheduler', Number(sampleScheduler));
  core.setField('sd_sample_params_t', sample, 'sample_steps', steps);
  const g = core.fieldAddress('sd_sample_params_t', sample, 'guidance');
  core.setField('sd_guidance_params_t', g, 'txt_cfg', guidance);
  // VAE tiling(省メモリ)
  const tiling = core.fieldAddress('sd_img_gen_params_t', params, 'vae_tiling_params');
  core.setField('sd_tiling_params_t', tiling, 'enabled', 1);
  core.setField('sd_tiling_params_t', tiling, 'tile_size_x', 1024);
  core.setField('sd_tiling_params_t', tiling, 'tile_size_y', 1024);
  core.setField('sd_tiling_params_t', tiling, 'target_overlap', 0.25);

  const imagesOut = core.alloc(core.pointerBytes);
  const countOut = core.alloc(4);
  core.bytes(imagesOut, core.pointerBytes).fill(0);
  core.bytes(countOut, 4).fill(0);

  post({ type: 'stage', stage: 'sampling' });
  const generated = await core.api.generate_image(context, params, imagesOut, countOut);

  // native呼び出し後はメモリ増大の可能性 → view再作成
  const ptrBytes = core.bytes(imagesOut, core.pointerBytes);
  const pointerView = new DataView(ptrBytes.buffer, ptrBytes.byteOffset, ptrBytes.byteLength);
  const images = core.pointerBytes === 8 ? pointerView.getBigUint64(0, true) : BigInt(pointerView.getUint32(0, true));
  const cntBytes = core.bytes(countOut, 4);
  const imageCount = new DataView(cntBytes.buffer, cntBytes.byteOffset, 4).getInt32(0, true);
  if (generated !== 1 || !images || imageCount !== 1) {
    throw new Error(`生成失敗 (generate_image=${generated}, count=${imageCount})`);
  }

  // 画像取り出し
  const w = Number(core.getField('sd_image_t', images, 'width'));
  const h = Number(core.getField('sd_image_t', images, 'height'));
  const ch = Number(core.getField('sd_image_t', images, 'channel'));
  const dataPtr = BigInt(core.getField('sd_image_t', images, 'data'));
  const byteLen = w * h * ch;
  const src = core.bytes(dataPtr, byteLen);
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let from = 0, to = 0; from < byteLen; from += ch, to += 4) {
    pixels[to] = src[from]; pixels[to + 1] = src[from + 1]; pixels[to + 2] = src[from + 2];
    pixels[to + 3] = ch === 4 ? src[from + 3] : 255;
  }
  await core.api.free_sd_images(images, imageCount);
  post({ type: 'image', width: w, height: h, pixels: pixels.buffer }, [pixels.buffer]);
}

self.onmessage = async ev => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      post({ type: 'stage', stage: 'runtime' });
      await startCore();
      await initContext();
    } else if (msg.type === 'generate') {
      if (!core || !context) throw new Error('モデル未ロードです');
      await generate(msg);
    }
  } catch (e) {
    post({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};
