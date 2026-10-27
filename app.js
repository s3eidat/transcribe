/* Transcribe — decode with WebAudio (16 kHz mono), run Whisper in a module worker (worker.js), edit, export.
   Nothing is uploaded: the model and runtime are files of this site and the CSP blocks every other host. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var SR = 16000, CHUNK = 30, STRIDE = 5, STEP = CHUNK - 2 * STRIDE;
  var TOTAL_BYTES = 81265296 + 22040209; // model folder + jsep runtime, what a first visit really downloads
  var LANGS = [["auto", "Auto-detect"], ["ar", "Arabic"], ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["tr", "Turkish"],
    ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ru", "Russian"], ["uk", "Ukrainian"], ["pl", "Polish"], ["nl", "Dutch"],
    ["sv", "Swedish"], ["no", "Norwegian"], ["da", "Danish"], ["fi", "Finnish"], ["el", "Greek"], ["ro", "Romanian"], ["cs", "Czech"],
    ["hu", "Hungarian"], ["fa", "Persian"], ["ur", "Urdu"], ["hi", "Hindi"], ["bn", "Bengali"], ["he", "Hebrew"], ["id", "Indonesian"],
    ["ms", "Malay"], ["tl", "Tagalog"], ["vi", "Vietnamese"], ["th", "Thai"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"],
    ["sw", "Swahili"], ["ta", "Tamil"]];
  var LANG_NAME = {}; LANGS.forEach(function (l) { LANG_NAME[l[0]] = l[1]; });

  // ---------- pure helpers (unit-tested in S3_SELFTEST) ----------
  function pad(n, w) { return String(n).padStart(w, "0"); }
  // 3661.5 -> "01:01:01,500" (SRT) / "01:01:01.500" (VTT). Rounds to whole ms first so 59.9996 s is 00:01:00.000.
  function stamp(sec, sep) {
    var ms = Math.round(Math.max(0, sec || 0) * 1000);
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + sep + pad(ms % 1000, 3);
  }
  function clock(sec) { // short display time: 0:07, 12:40, 1:02:03
    var t = Math.floor(Math.max(0, sec || 0)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ":" + pad(m, 2) : m) + ":" + pad(s, 2);
  }
  function cueText(t) { return String(t).replace(/-->/g, "→").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).join("\n"); }
  function toSRT(segs) {
    return segs.filter(function (s) { return cueText(s.text); }).map(function (s, i) {
      return (i + 1) + "\n" + stamp(s.start, ",") + " --> " + stamp(s.end, ",") + "\n" + cueText(s.text) + "\n";
    }).join("\n");
  }
  function toVTT(segs) {
    return "WEBVTT\n\n" + segs.filter(function (s) { return cueText(s.text); }).map(function (s) {
      return stamp(s.start, ".") + " --> " + stamp(s.end, ".") + "\n" + cueText(s.text) + "\n";
    }).join("\n");
  }
  // With times: one line per segment. Without: flowing text, new paragraph after a pause of 2 s or more.
  function toTXT(segs, withTimes) {
    if (withTimes) return segs.map(function (s) { return "[" + clock(s.start) + "] " + s.text.trim(); }).join("\n") + "\n";
    var out = "";
    segs.forEach(function (s, i) {
      var t = s.text.trim(); if (!t) return;
      out += i === 0 || !out ? t : (s.start - segs[i - 1].end >= 2 ? "\n\n" : " ") + t;
    });
    return out + "\n";
  }
  // Number of 30 s windows the pipeline makes (window 30 s, 5 s stride each side -> 20 s step).
  function chunkCount(samples) { return samples <= CHUNK * SR ? 1 : Math.ceil((samples - CHUNK * SR) / (STEP * SR)) + 1; }
  // Whisper chunks -> clean segments: trimmed, end never missing or before start, back-to-back repeats dropped.
  function normalize(chunks, duration) {
    var segs = [], prevEnd = 0;
    chunks.forEach(function (c) {
      var text = String(c.text || "").trim(); if (!text) return;
      var ts = c.timestamp || [];
      var start = ts[0] == null ? prevEnd : ts[0], end = ts[1] == null ? duration : ts[1];
      start = Math.min(Math.max(0, start), duration || start);
      if (!(end > start)) end = Math.min(start + 2, duration > start ? duration : start + 2);
      if (segs.length && segs[segs.length - 1].text === text) return;
      segs.push({ start: +start.toFixed(2), end: +end.toFixed(2), text: text });
      prevEnd = end;
    });
    return segs;
  }
  function words(t) { var m = String(t).trim().match(/\S+/g); return m ? m.length : 0; }
  function baseName(n) { return (String(n || "transcript").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "transcript").slice(0, 80); }

  // ---------- audio: any file -> Float32Array, 16 kHz mono ----------
  function OAC() { return window.OfflineAudioContext || window.webkitOfflineAudioContext; }
  function decodeAB(ctx, ab) {
    return new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  }
  async function decode16k(ab) {
    var Ctx = OAC();
    var buf = await decodeAB(new Ctx(1, 1, SR), ab); // decodes and resamples to the context's 16 kHz
    if (buf.numberOfChannels === 1 && buf.sampleRate === SR) return new Float32Array(buf.getChannelData(0));
    // Mix down to mono (and resample, if a browser didn't) by rendering through an OfflineAudioContext.
    var len = Math.max(1, Math.ceil(buf.duration * SR)), off = new Ctx(1, len, SR), src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    var out = await off.startRendering();
    return new Float32Array(out.getChannelData(0));
  }
  function peak(a) { var m = 0; for (var i = 0; i < a.length; i += 7) { var v = Math.abs(a[i]); if (v > m) m = v; } return m; }

  // ---------- state + settings ----------
  var saved = Object.assign({ lang: "auto", task: "transcribe", stamps: true }, S3.store("transcribe") || {});
  var state = { name: "", audio: null, duration: 0, url: null, segs: [], lang: null, busy: false, last: null };
  function save() { S3.store("transcribe", saved); }

  var langSel = $("#lang");
  LANGS.forEach(function (l) { langSel.appendChild(S3.h("option", { value: l[0], text: l[1] })); });
  langSel.value = LANG_NAME[saved.lang] ? saved.lang : "auto";
  langSel.addEventListener("change", function () { saved.lang = langSel.value; save(); });
  $$("#task button").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.v === saved.task));
    b.addEventListener("click", function () {
      $$("#task button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      saved.task = b.dataset.v; save();
    });
  });
  var stampsBox = $("#stamps");
  stampsBox.checked = saved.stamps;
  stampsBox.addEventListener("change", function () { saved.stamps = stampsBox.checked; save(); $("#segs").classList.toggle("no-times", !saved.stamps); });

  // ---------- progress UI ----------
  function progress(label, frac, num) {
    $("#prog").hidden = false;
    $("#progLbl").textContent = label;
    $("#progNum").textContent = num || "";
    var bar = $("#progBar");
    bar.classList.toggle("busy", frac == null);
    bar.style.width = frac == null ? "" : (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + "%";
  }
  function setBusy(b) {
    state.busy = b;
    $("#go").disabled = b || !state.audio; $("#cancel").hidden = !b;
    $("#sample").disabled = b; $("#rec").disabled = b;
    $("#drop").classList.toggle("tx-locked", b);
  }
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB"; }

  // ---------- worker ----------
  var worker = null, job = null;
  function resetWorker() { if (worker) { worker.terminate(); worker = null; } }
  function getWorker() {
    if (worker) return worker;
    worker = new Worker("worker.js", { type: "module" });
    worker.onmessage = function (e) { onMsg(e.data); };
    worker.onerror = function (e) { e.preventDefault(); finish(new Error(e.message || "The speech engine stopped unexpectedly.")); resetWorker(); };
    return worker;
  }
  function finish(err, res) {
    var j = job; job = null; if (!j) return;
    if (err) j.reject(err); else j.resolve(res);
  }
  function onMsg(m) {
    if (!job) return;
    var j = job;
    if (m.type === "load") {
      var total = Math.max(m.total, TOTAL_BYTES);
      progress(j.cachedModel ? "Loading Whisper from this device's cache…" : "Downloading Whisper (one time only)…", m.loaded / total, mb(m.loaded) + " / " + mb(total));
    } else if (m.type === "stage") {
      if (/^(Listening|Transcribing)/.test(m.text) && !j.t0) j.t0 = performance.now();
      progress(m.text, m.text.indexOf("Transcribing") === 0 ? 0 : null);
    } else if (m.type === "ready") {
      j.loadMs = m.ms;
      setModelNote(true);
    } else if (m.type === "lang") {
      state.lang = m.code;
      progress("Detected " + (LANG_NAME[m.code] || m.code) + ", transcribing…", 0);
    } else if (m.type === "text") {
      var live = $("#live"); live.hidden = false; $("#empty").hidden = true;
      live.textContent += m.text; live.scrollTop = live.scrollHeight;
    } else if (m.type === "pos" || m.type === "chunk") {
      var done = m.type === "chunk" ? m.done : m.chunk, at = m.type === "chunk" ? done * STEP : m.chunk * STEP + (m.t || 0);
      if (m.type === "chunk" && done >= j.chunks) at = state.duration;
      at = Math.min(at, state.duration);
      var el = (performance.now() - (j.t0 || performance.now())) / 1000, speed = el > 1 && at > 0 ? at / el : 0;
      progress((j.task === "translate" ? "Translating… " : "Transcribing… ") + clock(at) + " of " + clock(state.duration),
        at / (state.duration || 1), "window " + Math.min(done + 1, j.chunks) + "/" + j.chunks + (speed ? " · " + speed.toFixed(1) + "× real time" : ""));
    } else if (m.type === "done") {
      m.loadMs = j.loadMs; finish(null, m);
    } else if (m.type === "error") {
      finish(new Error(m.message));
    }
  }
  function transcribe() {
    if (!state.audio || state.busy) return Promise.reject(new Error("Nothing to transcribe yet"));
    var audio = state.audio.slice();
    var opts = { language: langSel.value, task: saved.task };
    setBusy(true);
    $("#live").textContent = ""; $("#live").hidden = false; $("#segs").hidden = true; $("#stats").hidden = true;
    $("#editHint").hidden = true; $("#empty").hidden = true;
    exportsOn(false);
    state.lang = opts.language === "auto" ? null : opts.language;
    var t0 = performance.now();
    return modelCached().then(function (cached) {
      return new Promise(function (resolve, reject) {
        job = { resolve: resolve, reject: reject, chunks: chunkCount(audio.length), task: opts.task, cachedModel: cached, t0: 0 };
        progress(cached ? "Loading Whisper from this device's cache…" : "Preparing the download (about 100 MB, one time only)…", null);
        getWorker().postMessage({ type: "run", id: Date.now(), audio: audio, language: opts.language, task: opts.task }, [audio.buffer]);
      });
    }).then(function (res) {
      var j = { total: performance.now() - t0, load: res.loadMs };
      state.lang = res.language;
      state.segs = normalize(res.chunks.length ? res.chunks : [{ timestamp: [0, state.duration], text: res.text }], state.duration);
      state.last = { runMs: res.ms, loadMs: j.load || 0, totalMs: Math.round(j.total), text: res.text, task: opts.task };
      $("#prog").hidden = true; $("#live").hidden = true;
      render();
      setBusy(false);
      if (state.segs.length) S3.done(); else S3.toast("No speech was found in this audio", "error");
      return res;
    }, function (err) {
      setBusy(false);
      $("#prog").hidden = true;
      if (err.message !== "cancelled") {
        S3.toast(friendly(err.message), "error");
        progress("Failed: " + friendly(err.message), 0);
      }
      if (!state.segs.length) $("#empty").hidden = false; else render();
      $("#live").hidden = true;
      throw err;
    });
  }
  function friendly(msg) {
    if (/memory|allocation|Array buffer/i.test(msg)) return "Ran out of memory. Try a shorter file, or close other tabs.";
    if (/failed to fetch|NetworkError|load file|not found locally/i.test(msg)) return "Couldn't load the model files. Check your connection and reload the page.";
    return msg;
  }
  $("#go").addEventListener("click", function () { transcribe().catch(function () {}); });
  $("#cancel").addEventListener("click", function () {
    resetWorker(); finish(new Error("cancelled"));
    S3.toast("Cancelled");
  });

  // ---------- model cache ----------
  function myURL(p) { return new URL(p, location.href).href; }
  function modelCached() {
    if (!window.caches) return Promise.resolve(false);
    return caches.open("transformers-cache").then(function (c) {
      return Promise.all([c.match(myURL("models/whisper-base/onnx/decoder_model_merged_quantized.onnx")), c.match(myURL("lib/ort-wasm-simd-threaded.jsep.wasm"))]);
    }).then(function (r) { return !!(r[0] && r[1]); }, function () { return false; });
  }
  function setModelNote(cached) {
    $("#modelNote").textContent = cached ? "Downloaded and cached on this device. Transcription works offline from now on."
      : "First use downloads about 100 MB (model 81 MB + runtime 22 MB) from this site, once. After that it's cached on this device and works offline.";
    $("#model").classList.toggle("is-cached", cached);
    $("#forget").hidden = !cached;
  }
  modelCached().then(setModelNote);
  $("#forget").addEventListener("click", async function () {
    if (!window.confirm("Remove the cached Whisper model (about 100 MB) from this browser? It downloads again next time you transcribe.")) return;
    resetWorker();
    var mine = [myURL("models/"), myURL("lib/ort-wasm")];
    try {
      var names = await caches.keys();
      for (var i = 0; i < names.length; i++) {
        var c = await caches.open(names[i]), keys = await c.keys();
        for (var k = 0; k < keys.length; k++) if (mine.some(function (p) { return keys[k].url.indexOf(p) === 0; })) await c.delete(keys[k]);
      }
      S3.toast("Model removed from this browser");
    } catch (e) { S3.toast("Couldn't clear the cache: " + e.message, "error"); }
    setModelNote(false);
  });

  // ---------- input: file, sample, microphone ----------
  async function loadInput(blob, name) {
    if (state.busy) return;
    progress("Reading " + name + "…", null);
    try {
      var ab = await (blob.arrayBuffer ? blob.arrayBuffer() : S3.readFile(blob));
      var audio = await decode16k(ab);
      if (audio.length < SR * 0.2) throw new Error("too short");
      state.audio = audio; state.duration = audio.length / SR; state.name = name;
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = URL.createObjectURL(blob);
      $("#player").src = state.url;
      $("#fname").textContent = name;
      $("#finfo").textContent = clock(state.duration) + " · " + S3.fmtBytes(blob.size);
      $("#file").hidden = false;
      $("#drop").classList.add("tx-compact"); $("#drop b").textContent = "Drop another file, or click to choose";
      $("#go").disabled = false;
      $("#prog").hidden = true;
      if (peak(audio) < 0.002) S3.toast("This audio looks silent. Whisper may return nothing.", "error");
      return audio;
    } catch (e) {
      $("#prog").hidden = true;
      S3.toast(e.message === "too short" ? "That recording is too short." : "Couldn't read audio from that file. This browser can't decode its format; try MP3, WAV, M4A or MP4.", "error");
      throw e;
    }
  }
  S3.drop($("#drop"), function (files) { loadInput(files[0], files[0].name).catch(function () {}); },
    { accept: "audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.weba,.mp4,.m4v,.mov,.mkv,.3gp,.amr", multiple: false });
  function sampleBlob() { return fetch("sample.wav").then(function (r) { if (!r.ok) throw new Error("sample missing"); return r.blob(); }); }
  $("#sample").addEventListener("click", function () {
    sampleBlob().then(function (b) { return loadInput(b, "sample.wav"); }).then(function () { langSel.value = "auto"; }).catch(function () {});
  });

  var rec = null;
  async function toggleRec() {
    if (rec) { rec.mr.stop(); return; }
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) {
      S3.toast(window.isSecureContext === false ? "Recording needs a secure page (https)." : "This browser can't record audio.", "error"); return;
    }
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) {
      S3.toast(e && e.name === "NotAllowedError" ? "Microphone access was blocked. Allow it from the address bar and try again."
        : e && e.name === "NotFoundError" ? "No microphone was found." : "Couldn't open the microphone.", "error");
      return;
    }
    var mr = new MediaRecorder(stream), chunks = [], t0 = Date.now();
    rec = { mr: mr, timer: setInterval(function () { $("#recTime").textContent = clock((Date.now() - t0) / 1000); }, 250) };
    mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = function () {
      clearInterval(rec.timer); rec = null;
      stream.getTracks().forEach(function (t) { t.stop(); });
      document.body.classList.remove("tx-recording");
      $("#recLbl").textContent = "Record from microphone"; $("#recTime").hidden = true;
      var type = mr.mimeType || "audio/webm", d = new Date();
      var name = "Recording " + pad(d.getHours(), 2) + "-" + pad(d.getMinutes(), 2) + "." + (/ogg/.test(type) ? "ogg" : /mp4/.test(type) ? "m4a" : "webm");
      loadInput(new Blob(chunks, { type: type }), name).catch(function () {});
    };
    mr.start(500);
    document.body.classList.add("tx-recording");
    $("#recLbl").textContent = "Stop recording"; $("#recTime").textContent = "0:00"; $("#recTime").hidden = false;
  }
  $("#rec").addEventListener("click", function () { toggleRec(); });

  // ---------- transcript editor ----------
  function grow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
  window.addEventListener("resize", S3.debounce(function () { $$("#segs .tx-text").forEach(grow); }, 150));
  function render() {
    var box = $("#segs"); box.innerHTML = "";
    box.classList.toggle("no-times", !saved.stamps);
    var rtl = state.lang && /^(ar|fa|ur|he|yi|ps|sd|ug)$/.test(state.lang) && state.last && state.last.task !== "translate";
    state.segs.forEach(function (s, i) {
      var ta = S3.h("textarea", { "class": "tx-text", rows: "1", dir: rtl ? "rtl" : "auto", "aria-label": "Line " + (i + 1) + " at " + clock(s.start), spellcheck: "true" });
      ta.value = s.text;
      ta.addEventListener("input", function () { s.text = ta.value; grow(ta); });
      var t = S3.h("button", { "class": "tx-t mono", type: "button", title: "Play from " + clock(s.start), text: clock(s.start) });
      t.addEventListener("click", function () { var p = $("#player"); p.currentTime = s.start; p.play().catch(function () {}); });
      box.appendChild(S3.h("div", { "class": "tx-seg", "data-i": String(i) }, [t, ta]));
    });
    var has = state.segs.length > 0;
    box.hidden = !has; $("#editHint").hidden = !has; $("#empty").hidden = has;
    requestAnimationFrame(function () { $$(".tx-text", box).forEach(grow); });
    exportsOn(has);
    var st = $("#stats"); st.innerHTML = "";
    if (!has) { st.hidden = true; return; }
    var L = state.last || {}, all = state.segs.map(function (x) { return x.text; }).join(" ");
    var took = L.runMs ? (L.runMs < 60000 ? (L.runMs / 1000).toFixed(1) + " s" : clock(L.runMs / 1000)) : "—";
    [["duration", clock(state.duration)], ["words", words(all).toLocaleString()],
      ["language", (LANG_NAME[state.lang] || state.lang || "?") + (L.task === "translate" ? " → English" : "")],
      ["took", took]].forEach(function (p) {
      st.appendChild(S3.h("div", { "class": "stat" }, [S3.h("b", { text: p[1] }), S3.h("span", { text: p[0] })]));
    });
    st.hidden = false;
  }
  $("#player").addEventListener("timeupdate", function () {
    var t = this.currentTime, rows = $$("#segs .tx-seg");
    rows.forEach(function (r, i) { var s = state.segs[i]; r.classList.toggle("is-now", !!s && t >= s.start && t < s.end && !$("#player").paused); });
  });
  function exportsOn(on) { ["#copy", "#txt", "#srt", "#vtt"].forEach(function (id) { $(id).disabled = !on; }); }
  function current() { return state.segs.filter(function (s) { return s.text.trim(); }); }
  $("#copy").addEventListener("click", function () { S3.copy(toTXT(current(), saved.stamps).trim()); S3.done(); });
  $("#txt").addEventListener("click", function () { S3.download(toTXT(current(), saved.stamps), baseName(state.name) + ".txt", "text/plain;charset=utf-8"); S3.done(); });
  $("#srt").addEventListener("click", function () { S3.download(toSRT(current()), baseName(state.name) + ".srt", "application/x-subrip;charset=utf-8"); S3.done(); });
  $("#vtt").addEventListener("click", function () { S3.download(toVTT(current()), baseName(state.name) + ".vtt", "text/vtt;charset=utf-8"); S3.done(); });

  // ---------- demo + self-test (scripts/smoke.py) ----------
  var sampleRun = null;
  function runSample() {
    if (!sampleRun) {
      sampleRun = sampleBlob().then(function (b) { return loadInput(b, "sample.wav"); }).then(function () {
        langSel.value = "auto"; return transcribe();
      });
      sampleRun.catch(function () { sampleRun = null; });
    }
    return sampleRun;
  }
  window.S3_DEMO = async function () {
    if (!state.segs.length) await runSample();
    window.scrollTo(0, 0);
  };

  function wav(chans, rate) { // tiny 16-bit PCM WAV writer, only for the decode test
    var n = chans.length, len = chans[0].length, v = new DataView(new ArrayBuffer(44 + len * n * 2));
    function s(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
    s(0, "RIFF"); v.setUint32(4, 36 + len * n * 2, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, n, true); v.setUint32(24, rate, true); v.setUint32(28, rate * n * 2, true); v.setUint16(32, n * 2, true); v.setUint16(34, 16, true);
    s(36, "data"); v.setUint32(40, len * n * 2, true);
    for (var i = 0, o = 44; i < len; i++) for (var c = 0; c < n; c++, o += 2) v.setInt16(o, Math.round(chans[c][i] * 32767), true);
    return v.buffer;
  }

  window.S3_SELFTEST = async function () {
    var fails = [];
    function eq(name, got, want) { if (got !== want) fails.push(name + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); }
    eq("srt 0", stamp(0, ","), "00:00:00,000");
    eq("srt 3661.5", stamp(3661.5, ","), "01:01:01,500");
    eq("vtt round", stamp(59.9996, "."), "00:01:00.000");
    eq("vtt 0.0004", stamp(0.0004, "."), "00:00:00.000");
    eq("srt 7.123", stamp(7.123, ","), "00:00:07,123");
    eq("clock", clock(3723), "1:02:03");
    var segs = [{ start: 0, end: 2.5, text: " Hello " }, { start: 2.5, end: 61.25, text: "A --> B" }];
    eq("toSRT", toSRT(segs), "1\n00:00:00,000 --> 00:00:02,500\nHello\n\n2\n00:00:02,500 --> 00:01:01,250\nA → B\n");
    eq("toVTT", toVTT(segs), "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello\n\n00:00:02.500 --> 00:01:01.250\nA → B\n");
    eq("toTXT times", toTXT(segs, true), "[0:00] Hello\n[0:02] A --> B\n");
    eq("toTXT flow", toTXT([{ start: 0, end: 1, text: "One." }, { start: 1.2, end: 2, text: "Two." }, { start: 5, end: 6, text: "Three." }], false), "One. Two.\n\nThree.\n");
    eq("chunks 10s", chunkCount(SR * 10), 1); eq("chunks 30s", chunkCount(SR * 30), 1);
    eq("chunks 31s", chunkCount(SR * 31), 2); eq("chunks 50s", chunkCount(SR * 50), 2); eq("chunks 51s", chunkCount(SR * 51), 3);
    eq("normalize", JSON.stringify(normalize([{ timestamp: [0, 1.5], text: " hi " }, { timestamp: [1.5, 1.5], text: "hi" }, { timestamp: [3, null], text: "end" }], 4)),
      '[{"start":0,"end":1.5,"text":"hi"},{"start":3,"end":4,"text":"end"}]');
    // decode + mixdown + resample: stereo 8 kHz (L 0.5, R 0.1) -> mono 16 kHz at about 0.3
    var L = new Float32Array(800).fill(0.5), R = new Float32Array(800).fill(0.1);
    var mono = await decode16k(wav([L, R], 8000));
    eq("resample length", Math.abs(mono.length - 1600) <= 2, true);
    eq("mixdown level", Math.abs(mono[800] - 0.3) < 0.01, true);
    if (fails.length) return fails.join(" | ");

    // The real thing: Whisper on a bundled speech clip (Windows TTS, 5.5 s, 16 kHz mono WAV), language auto-detected.
    var t0 = performance.now(), res = await runSample();
    var text = (res.text || "").toLowerCase(), missing = ["quick", "brown", "fox", "jumps", "lazy", "dog", "computer"].filter(function (w) { return text.indexOf(w) < 0; });
    console.log("[transcribe selftest] " + JSON.stringify({ last: state.last, selftestMs: Math.round(performance.now() - t0), language: res.language, segs: state.segs }));
    if (res.language !== "en") fails.push("language detected as " + res.language);
    if (missing.length) fails.push("missing words: " + missing.join(", ") + " in " + JSON.stringify(res.text));
    if (!state.segs.length || !/^1\n00:00:0\d,\d{3} --> /.test(toSRT(state.segs))) fails.push("no timed segments");
    return fails.length ? fails.join(" | ") : true;
  };
})();
