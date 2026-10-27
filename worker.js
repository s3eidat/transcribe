/* Transcribe worker: Whisper base (ONNX, 8-bit) through transformers.js. Every file comes from this site:
   the model from models/, the runtime from lib/. Remote models are switched off, so nothing is ever fetched elsewhere. */
import { pipeline, env, Tensor, WhisperTextStreamer } from "./lib/transformers.min.js";

const BASE = new URL("./", self.location.href).href;
const WASM_URL = BASE + "lib/ort-wasm-simd-threaded.jsep.wasm";
const CACHE = "transformers-cache";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "models/";
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = BASE + "lib/";
env.backends.onnx.wasm.numThreads = 1; // no cross-origin isolation on GitHub Pages
env.backends.onnx.wasm.proxy = false;

let pipe = null;
const post = (m) => self.postMessage(m);

// The 22 MB runtime, cache-first, with real download progress.
async function loadWasm(onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { /* storage blocked: just download */ }
  let res = cache ? await cache.match(WASM_URL) : null;
  const cached = !!res;
  if (!res) res = await fetch(WASM_URL);
  if (!res.ok) throw new Error("Couldn't load the speech runtime (" + res.status + ")");
  const total = +res.headers.get("content-length") || 22040209;
  const reader = res.body.getReader(), parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length; onProgress(loaded, total, cached);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  if (cache && !cached) {
    try { await cache.put(WASM_URL, new Response(bytes, { headers: { "content-type": "application/wasm", "content-length": String(loaded) } })); } catch (e) { /* quota: fine */ }
  }
  return bytes;
}

// CPU (WebAssembly) only. Measured on an RTX-class GPU with this ORT build: the 8-bit (q8) Whisper graphs on WebGPU
// return garbage (wrong language, random tokens) and run ~14x slower, whether the encoder, the decoder or both run there.
// WebGPU needs fp32/fp16 model files, which this tool doesn't ship.
async function load() {
  const t0 = performance.now();
  const files = {};
  const report = (cached) => {
    let l = 0, t = 0;
    for (const k in files) { l += files[k].loaded; t += files[k].total; }
    post({ type: "load", loaded: l, total: t, cached: cached });
  };
  const wasm = await loadWasm((l, t, c) => { files.wasm = { loaded: l, total: t }; report(c); });
  env.backends.onnx.wasm.wasmBinary = wasm;
  const progress = (p) => {
    if (p.status === "progress" && p.file) { files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 }; report(false); }
  };
  post({ type: "stage", text: "Starting Whisper…" });
  pipe = await pipeline("automatic-speech-recognition", "whisper-base", {
    dtype: "q8", device: "wasm", progress_callback: progress, session_options: { logSeverityLevel: 3 },
  });
  post({ type: "ready", ms: Math.round(performance.now() - t0) });
}

// Whisper's own language guess: one decoder step after <|startoftranscript|>, best language token wins.
async function detectLanguage(audio) {
  const feats = (await pipe.processor(audio.subarray(0, 16000 * 30))).input_features;
  const gc = pipe.model.generation_config;
  const ids = new Tensor("int64", BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]);
  const out = await pipe.model({ input_features: feats, decoder_input_ids: ids });
  const logits = out.logits.data, vocab = out.logits.dims[out.logits.dims.length - 1];
  const row = logits.length - vocab;
  let best = "en", bv = -Infinity;
  for (const tok in gc.lang_to_id) {
    const v = logits[row + gc.lang_to_id[tok]];
    if (v > bv) { bv = v; best = tok.slice(2, -2); }
  }
  return best;
}

async function run(msg) {
  const audio = msg.audio, t0 = performance.now();
  let language = msg.language;
  if (!language || language === "auto") {
    post({ type: "stage", text: "Listening for the language…" });
    language = await detectLanguage(audio);
    post({ type: "lang", code: language });
  }
  const precision = pipe.processor.feature_extractor.config.chunk_length / pipe.model.config.max_source_positions;
  let chunk = 0;
  const streamer = new WhisperTextStreamer(pipe.tokenizer, {
    time_precision: precision,
    callback_function: (text) => post({ type: "text", text: text }),
    on_chunk_start: (t) => post({ type: "pos", chunk: chunk, t: t }),
    on_finalize: () => { chunk++; post({ type: "chunk", done: chunk }); },
  });
  post({ type: "stage", text: "Transcribing…" });
  const out = await pipe(audio, {
    language: language,
    task: msg.task === "translate" ? "translate" : "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    streamer: streamer,
  });
  post({ type: "done", id: msg.id, text: out.text, chunks: out.chunks || [], language: language, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") { if (!pipe) await load(); else post({ type: "ready", ms: 0 }); }
    else if (m.type === "run") { if (!pipe) await load(); await run(m); }
  } catch (err) {
    post({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
