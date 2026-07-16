/**
 * DA DOG TAP
 * Client-side rhythm analysis, quantized sample playback and 3-key chart engine.
 * No library is required: all timing uses Web Audio's monotonic clock.
 */

"use strict";

// Resolve packaged assets from script.js itself. This keeps audio paths inside
// /toy/<slug>/ even when the page is opened through a preview or route URL.
const ASSET_BASE_URL = new URL(".", document.currentScript?.src || window.location.href);
const resolveAssetUrl = (path) => new URL(path, ASSET_BASE_URL).href;

const APP_CONFIG = Object.freeze({
  defaultTrack: "./music/XmegaLxl - JET SET!.mp3",
  samples: {
    da: "./audio/da.wav",
    gou: "./audio/gou.wav",
    jiao: "./audio/jiao.wav",
  },
  analysisSampleRate: 11025,
  minBpm: 55,
  maxBpm: 210,
  approachSeconds: 2.8,
  hitWindows: { perfect: 0.055, great: 0.105, good: 0.18 },
});

const {
  RhythmAnalyzer,
  ChartGenerator,
  DIFFICULTY_PRESETS,
  PATTERN_TYPES,
} = window.DaDogAlgorithms || {};
if (!RhythmAnalyzer || !ChartGenerator) {
  throw new Error("节奏算法模块未加载，请确认 rhythm-algorithms.js 位于 script.js 之前。");
}

const SOUND_NAMES = ["da", "gou", "jiao"];
const LANE_COLORS = ["#ff5d54", "#ffbc55", "#25d6f5"];
const DEFAULT_BINDINGS = [
  { code: "ArrowLeft", label: "←" },
  { code: "ArrowDown", label: "↓" },
  { code: "ArrowRight", label: "→" },
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sleepFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const dom = {
  upload: $("#audioUpload"),
  samplerUpload: $("#samplerUpload"),
  gameUpload: $("#gameUpload"),
  useDefault: $("#useDefaultButton"),
  engineStatus: $("#engineStatus"),
  analysisState: $("#analysisState"),
  trackName: $("#trackName"),
  menuTrackName: $("#menuTrackName"),
  menuBpm: $("#menuBpm"),
  gameRhythmLabel: $("#gameRhythmLabel"),
  screens: $$("[data-screen]"),
  routeButtons: $$("[data-route]"),
  waveform: $("#waveformCanvas"),
  waveformPlaceholder: $("#waveformPlaceholder"),
  playhead: $("#playhead"),
  play: $("#playButton"),
  restart: $("#restartButton"),
  seek: $("#seekSlider"),
  currentTime: $("#currentTime"),
  duration: $("#duration"),
  bpm: $("#bpmValue"),
  bpmMinus: $("#bpmMinus"),
  bpmPlus: $("#bpmPlus"),
  confidence: $("#confidenceText"),
  rhythmType: $("#rhythmType"),
  beatInterval: $("#beatInterval"),
  onsetCount: $("#onsetCount"),
  reanalyze: $("#reanalyzeButton"),
  snapToggle: $("#snapToggle"),
  snapDivision: $("#snapDivision"),
  snapStateText: $("#snapStateText"),
  pads: $$(".sound-pad"),
  density: $("#densitySlider"),
  densityValue: $("#densityValue"),
  scrollSpeed: $("#scrollSpeedSlider"),
  scrollSpeedValue: $("#scrollSpeedValue"),
  autoplay: $("#autoplayToggle"),
  autoplayState: $("#autoplayState"),
  difficulty: $("#chartDifficulty"),
  difficultyState: $("#difficultyState"),
  patternWeights: $$("[data-pattern-weight]"),
  seed: $("#chartSeed"),
  randomizeSeed: $("#randomizeSeedButton"),
  chartConfig: $("#chartConfigPanel"),
  gameControls: $("#gameControls"),
  generateChart: $("#generateChartButton"),
  chartNoteCount: $("#chartNoteCount"),
  chartDescription: $("#chartDescription"),
  gameCanvas: $("#gameCanvas"),
  gameStage: $("#gameStage"),
  stageMessage: $("#stageMessage"),
  keyDeck: $("#keyDeck"),
  keyButtons: $$("#keyDeck button"),
  bindingButtons: $$(".binding-button"),
  bindingHelp: $("#bindingHelp"),
  resetKeys: $("#resetKeysButton"),
  startGame: $("#startGameButton"),
  stopGame: $("#stopGameButton"),
  score: $("#scoreValue"),
  combo: $("#comboValue"),
  accuracy: $("#accuracyValue"),
  judgement: $("#judgement"),
  toast: $("#toast"),
};

const appState = {
  analysis: null,
  chart: [],
  chartResult: null,
  trackBuffer: null,
  trackName: "",
  analyzing: false,
  bindingLane: null,
  bindings: loadBindings(),
  game: {
    active: false,
    score: 0,
    combo: 0,
    maxCombo: 0,
    judged: 0,
    accuracyPoints: 0,
    laneFlash: [0, 0, 0],
    animationId: 0,
  },
};

class AudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.musicGain = null;
    this.sampleGain = null;
    this.sampleBuffers = new Map();
    this.nativeSamples = new Map();
    this.samplePlaybackErrors = new Set();
    this.trackBuffer = null;
    this.source = null;
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.sessionId = 0;
  }

  ensureContext() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("当前浏览器不支持 Web Audio API。");
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.master = this.context.createGain();
      this.musicGain = this.context.createGain();
      this.sampleGain = this.context.createGain();
      this.musicGain.gain.value = 0.86;
      this.sampleGain.gain.value = 1;
      this.musicGain.connect(this.master);
      this.sampleGain.connect(this.master);
      this.master.connect(this.context.destination);
    }
    return this.context;
  }

  async resume() {
    this.ensureContext();
    if (this.context.state === "suspended") await this.context.resume();
  }

  async decodeArrayBuffer(arrayBuffer) {
    const context = this.ensureContext();
    return context.decodeAudioData(arrayBuffer.slice(0));
  }

  async loadSamples() {
    const jobs = Object.entries(APP_CONFIG.samples).map(async ([name, path]) => {
      const url = resolveAssetUrl(path);
      // HTMLAudioElement can load relative files even when the page was opened
      // directly through file://, where fetch() is usually blocked.
      const nativeAudio = new Audio();
      nativeAudio.preload = "auto";
      nativeAudio.src = url;
      nativeAudio.load();
      this.nativeSamples.set(name, nativeAudio);

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${name} 采样载入失败 (${response.status})`);
        const buffer = await this.decodeArrayBuffer(await response.arrayBuffer());
        this.sampleBuffers.set(name, buffer);
        return { name, decoded: true };
      } catch (error) {
        console.warn(`[Da Dog Tap] ${path} 无法解码，将使用原始音频元素播放。`, error);
        return { name, decoded: false };
      }
    });
    return Promise.all(jobs);
  }

  setTrack(buffer) {
    this.stop();
    this.trackBuffer = buffer;
    this.offset = 0;
  }

  createTrackSource() {
    const source = this.context.createBufferSource();
    source.buffer = this.trackBuffer;
    source.connect(this.musicGain);
    return source;
  }

  async play() {
    if (!this.trackBuffer) return;
    await this.resume();
    if (this.playing) return;
    if (this.offset >= this.trackBuffer.duration - 0.02) this.offset = 0;

    const sessionId = ++this.sessionId;
    this.source = this.createTrackSource();
    this.startedAt = this.context.currentTime - this.offset;
    this.source.start(0, this.offset);
    this.playing = true;
    this.source.onended = () => {
      if (sessionId !== this.sessionId || !this.playing) return;
      this.offset = 0;
      this.playing = false;
      updateTransportUI();
      if (appState.game.active) finishGame();
    };
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.getPosition();
    this.playing = false;
    this.sessionId += 1;
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch (_) { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  stop() {
    this.pause();
    this.offset = 0;
  }

  seek(seconds) {
    if (!this.trackBuffer) return;
    const shouldResume = this.playing;
    this.pause();
    this.offset = clamp(seconds, 0, Math.max(0, this.trackBuffer.duration - 0.005));
    if (shouldResume) this.play();
  }

  getPosition() {
    if (!this.trackBuffer) return 0;
    if (!this.playing) return this.offset;
    return clamp(this.context.currentTime - this.startedAt, 0, this.trackBuffer.duration);
  }

  getSnapDelay(bpm, division, beatOffset) {
    if (!this.playing || !bpm) return 0;
    const position = this.getPosition();
    const grid = 60 / bpm / division;
    const relative = (position - beatOffset) / grid;
    let next = Math.ceil(relative - 0.035) * grid + beatOffset;
    if (next < position + 0.006) next += grid;
    return clamp(next - position, 0, grid);
  }

  triggerSample(name, quantized = true) {
    const analysis = appState.analysis;
    const division = Number(dom.snapDivision.value);
    const delay = quantized && dom.snapToggle.checked && analysis
      ? this.getSnapDelay(analysis.bpm, division, analysis.beatOffset)
      : 0;
    const buffer = this.sampleBuffers.get(name);

    if (!buffer) {
      this.playNativeSample(name, delay);
      return Promise.resolve(delay);
    }

    return this.resume()
      .then(() => {
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.sampleGain);
        source.start(this.context.currentTime + delay);
        return delay;
      })
      .catch((error) => {
        console.warn(`[Da Dog Tap] Web Audio 播放 ${name} 失败，改用原始文件。`, error);
        this.playNativeSample(name, delay);
        return delay;
      });
  }

  playNativeSample(name, delay = 0) {
    const template = this.nativeSamples.get(name);
    const path = APP_CONFIG.samples[name];
    const url = resolveAssetUrl(path);
    const player = template ? template.cloneNode(true) : new Audio(url);
    player.preload = "auto";
    player.volume = 1;

    const play = () => {
      player.currentTime = 0;
      const result = player.play();
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          console.error(`[Da Dog Tap] 无法播放 ${url}`, error);
          if (!this.samplePlaybackErrors.has(name)) {
            this.samplePlaybackErrors.add(name);
            showToast(`无法播放 ${path}，请确认发布包中包含对应音频文件`);
          }
        });
      }
    };

    if (delay > 0.008) window.setTimeout(play, delay * 1000);
    else play();
  }
}

const audio = new AudioEngine();

function getRoute() {
  const route = location.hash.replace(/^#/, "");
  if (route === "game" || route === "sampler") return "game";
  return "menu";
}

function navigate(route) {
  const nextRoute = route === "game" || route === "sampler" ? "game" : "menu";
  const previousRoute = document.body.dataset.route;

  if (previousRoute && previousRoute !== nextRoute) {
    if (appState.game.active) finishGame(true);
    else if (audio.playing) audio.pause();
  }

  document.body.dataset.route = nextRoute;
  dom.screens.forEach((screen) => {
    const active = screen.dataset.screen === nextRoute;
    screen.hidden = !active;
    screen.setAttribute("aria-hidden", String(!active));
    if (active && screen.classList.contains("mode-screen")) screen.scrollTop = 0;
  });
  dom.routeButtons.forEach((button) => {
    const active = button.closest(".mode-tabs") && button.dataset.route === nextRoute;
    button.classList.toggle("active", Boolean(active));
    if (button.closest(".mode-tabs")) button.setAttribute("aria-current", active ? "page" : "false");
  });

  requestAnimationFrame(() => {
    if (nextRoute === "game") drawGame(performance.now());
    updateTransportUI();
  });
}

function requestRoute(route) {
  const hash = `#${route}`;
  if (location.hash === hash) navigate(route);
  else location.hash = route;
}

const analyzer = new RhythmAnalyzer({
  targetRate: APP_CONFIG.analysisSampleRate,
  minBpm: APP_CONFIG.minBpm,
  maxBpm: APP_CONFIG.maxBpm,
});
const chartGenerator = new ChartGenerator();

function loadBindings() {
  try {
    const saved = JSON.parse(localStorage.getItem("da-dog-tap-bindings"));
    if (Array.isArray(saved) && saved.length === 3 && saved.every((item) => item.code && item.label)) {
      return saved;
    }
  } catch (_) { /* invalid or unavailable localStorage */ }
  return DEFAULT_BINDINGS.map((binding) => ({ ...binding }));
}

function saveBindings() {
  try {
    localStorage.setItem("da-dog-tap-bindings", JSON.stringify(appState.bindings));
  } catch (_) { /* private mode may reject storage */ }
}

function displayKey(event) {
  const aliases = {
    ArrowLeft: "←", ArrowDown: "↓", ArrowRight: "→", ArrowUp: "↑",
    Space: "Space", Enter: "Enter", ShiftLeft: "L Shift", ShiftRight: "R Shift",
    ControlLeft: "L Ctrl", ControlRight: "R Ctrl", AltLeft: "L Alt", AltRight: "R Alt",
    Backspace: "⌫", Tab: "Tab",
  };
  if (aliases[event.code]) return aliases[event.code];
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  if (/^Numpad\d$/.test(event.code)) return `Num ${event.code.slice(6)}`;
  return event.key.length <= 5 ? event.key : event.code.replace(/(Left|Right)$/, "");
}

function renderBindings() {
  appState.bindings.forEach((binding, lane) => {
    $(`#bindingLabel${lane}`).textContent = binding.label;
    $(`#keyLabel${lane}`).textContent = binding.label;
  });
}

function setEngineStatus(text, mode = "") {
  dom.engineStatus.className = `status-pill ${mode}`.trim();
  dom.engineStatus.innerHTML = `<i></i> ${text}`;
}

function setAnalysisState(text, mode = "") {
  dom.analysisState.textContent = text;
  dom.analysisState.className = `analysis-badge ${mode}`.trim();
}

let toastTimer = 0;
function showToast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("show"), 2600);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

async function fetchTrack(path) {
  const url = resolveAssetUrl(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取默认音乐 (${response.status})`);
  return response.arrayBuffer();
}

async function loadTrack(input, name) {
  if (appState.analyzing) return;
  appState.analyzing = true;
  finishGame(true);
  audio.stop();
  setEngineStatus("正在分析", "working");
  setAnalysisState("分析中", "working");
  dom.trackName.textContent = name;
  dom.menuTrackName.textContent = name;
  dom.menuBpm.textContent = "…";
  dom.gameRhythmLabel.textContent = "正在分析";
  dom.waveformPlaceholder.classList.remove("hidden");
  dom.waveformPlaceholder.querySelector("span").textContent = "正在解码与识别节奏";
  disableTrackControls(true);

  try {
    await sleepFrame();
    const arrayBuffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    const decoded = await audio.decodeArrayBuffer(arrayBuffer);
    appState.trackBuffer = decoded;
    appState.trackName = name;
    audio.setTrack(decoded);

    await sleepFrame();
    appState.analysis = analyzer.analyze(decoded);
    appState.chart = [];
    appState.chartResult = null;
    updateAnalysisUI();
    drawWaveform();
    drawGame(performance.now());
    dom.waveformPlaceholder.classList.add("hidden");
    setAnalysisState("分析完成", "done");
    setEngineStatus("音频已就绪", "ready");
    disableTrackControls(false);
    dom.generateChart.disabled = false;
    dom.stageMessage.classList.remove("hidden");
    dom.stageMessage.innerHTML = "<b>可以生成谱面了</b><span>按需展开生成配置，然后点击“生成 / 刷新谱面”</span>";
    showToast(`检测到 ${appState.analysis.bpm} BPM · ${appState.analysis.rhythmType}`);
  } catch (error) {
    console.error(error);
    setAnalysisState("载入失败");
    setEngineStatus("音频载入失败");
    dom.waveformPlaceholder.querySelector("span").textContent = "音频载入失败，请上传本地文件";
    showToast(location.protocol === "file:"
      ? "请通过本地网页服务器打开，浏览器会阻止 file:// 读取音频"
      : `载入失败：${error.message}`);
  } finally {
    appState.analyzing = false;
  }
}

async function loadDefaultTrack() {
  try {
    const data = await fetchTrack(APP_CONFIG.defaultTrack);
    await loadTrack(data, "XmegaLxl - JET SET!.mp3");
  } catch (error) {
    console.error(error);
    setAnalysisState("等待上传");
    setEngineStatus("等待音频");
    dom.trackName.textContent = "默认音乐读取失败，请选择本地音乐";
    dom.waveformPlaceholder.querySelector("span").textContent = location.protocol === "file:"
      ? "请使用本地服务器打开，或直接上传音乐"
      : "请选择一段本地音乐";
  }
}

async function reanalyzeCurrentTrack() {
  if (!appState.trackBuffer || appState.analyzing) return;
  appState.analyzing = true;
  finishGame(true);
  setEngineStatus("正在分析", "working");
  setAnalysisState("分析中", "working");
  disableTrackControls(true);
  try {
    await sleepFrame();
    appState.analysis = analyzer.analyze(appState.trackBuffer);
    appState.chart = [];
    appState.chartResult = null;
    updateAnalysisUI();
    drawWaveform();
    drawGame(performance.now());
    setAnalysisState("分析完成", "done");
    setEngineStatus("音频已就绪", "ready");
    dom.generateChart.disabled = false;
    dom.startGame.disabled = true;
    dom.chartNoteCount.textContent = "0";
    dom.stageMessage.classList.remove("hidden");
    dom.stageMessage.innerHTML = "<b>分析已刷新</b><span>请重新生成谱面</span>";
    showToast(`重新检测到 ${appState.analysis.bpm} BPM`);
  } catch (error) {
    console.error(error);
    setAnalysisState("分析失败");
    setEngineStatus("分析失败");
    showToast(`重新分析失败：${error.message}`);
  } finally {
    appState.analyzing = false;
    disableTrackControls(false);
  }
}

function disableTrackControls(disabled) {
  dom.play.disabled = disabled || !audio.trackBuffer;
  dom.restart.disabled = disabled || !audio.trackBuffer;
  dom.seek.disabled = disabled || !audio.trackBuffer;
  dom.reanalyze.disabled = disabled || !audio.trackBuffer;
}

function updateAnalysisUI() {
  const analysis = appState.analysis;
  if (!analysis) return;
  dom.bpm.textContent = Math.round(analysis.bpm);
  dom.menuBpm.textContent = Math.round(analysis.bpm);
  dom.gameRhythmLabel.textContent = analysis.rhythmType;
  dom.confidence.textContent = `置信度 ${Math.round(analysis.confidence)}% · 可手动微调`;
  dom.rhythmType.textContent = analysis.rhythmType;
  dom.beatInterval.textContent = `${Math.round(60000 / analysis.bpm)} ms`;
  dom.onsetCount.textContent = analysis.onsets.length.toLocaleString("zh-CN");
  dom.duration.textContent = formatTime(audio.trackBuffer?.duration || 0);
}

function adjustBpm(delta) {
  if (!appState.analysis) return;
  const nextBpm = clamp(Math.round(appState.analysis.bpm + delta), 40, 260);
  appState.analysis = analyzer.retime(appState.analysis, nextBpm);
  updateAnalysisUI();
  drawWaveform();
  if (appState.chart.length) generateChart();
}

function drawWaveform() {
  const buffer = appState.trackBuffer;
  const analysis = appState.analysis;
  if (!buffer || !analysis) return;
  const canvas = dom.waveform;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  const channel = buffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
  const middle = height / 2;

  context.clearRect(0, 0, width, height);
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#0d1425");
  background.addColorStop(1, "#141d31");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const beatSeconds = 60 / analysis.bpm;
  context.lineWidth = 1;
  for (let beat = analysis.beatOffset, index = 0; beat < buffer.duration; beat += beatSeconds, index += 1) {
    const x = beat / buffer.duration * width;
    context.strokeStyle = index % 4 === 0 ? "rgba(255,188,85,.28)" : "rgba(255,255,255,.075)";
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#ff5d54");
  gradient.addColorStop(.52, "#ff9451");
  gradient.addColorStop(1, "#25d6f5");
  context.strokeStyle = gradient;
  context.lineWidth = 1.35;
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.min(channel.length, start + samplesPerPixel);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i += 1) {
      if (channel[i] < min) min = channel[i];
      if (channel[i] > max) max = channel[i];
    }
    const top = middle + min * middle * .78;
    const bottom = middle + max * middle * .78;
    context.moveTo(x, top);
    context.lineTo(x, bottom);
  }
  context.stroke();

  context.fillStyle = "rgba(255,255,255,.48)";
  const strongOnsets = analysis.onsets.filter((onset) => onset.strength > .78);
  for (const onset of strongOnsets) {
    const x = onset.time / buffer.duration * width;
    context.fillRect(x, height - 7, 1, 7);
  }
}

function updateTransportUI() {
  const position = audio.getPosition();
  const duration = audio.trackBuffer?.duration || 0;
  dom.currentTime.textContent = formatTime(position);
  dom.duration.textContent = formatTime(duration);
  dom.seek.value = duration ? Math.round(position / duration * 1000) : 0;
  dom.play.classList.toggle("playing", audio.playing);
  dom.play.setAttribute("aria-label", audio.playing ? "暂停音乐" : "播放音乐");
  const progress = duration ? position / duration : 0;
  dom.playhead.style.left = `${progress * 100}%`;
  dom.playhead.style.opacity = duration ? "1" : "0";
}

function animateTransport() {
  updateTransportUI();
  requestAnimationFrame(animateTransport);
}

async function triggerPad(lane, quantized = true) {
  const name = SOUND_NAMES[lane];
  const delay = await audio.triggerSample(name, quantized);
  window.setTimeout(() => {
    const pad = dom.pads[lane];
    const key = dom.keyButtons[lane];
    pad?.classList.remove("hit");
    key?.classList.remove("active");
    void pad?.offsetWidth;
    pad?.classList.add("hit");
    key?.classList.add("active");
    window.setTimeout(() => {
      pad?.classList.remove("hit");
      key?.classList.remove("active");
    }, 130);
  }, delay * 1000);
}

function updatePatternWeightLabel(input) {
  const value = input.closest("label")?.querySelector("[data-pattern-value]");
  if (value) value.textContent = input.value;
}

function applyDifficultyPreset(difficulty) {
  const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
  dom.patternWeights.forEach((input) => {
    input.value = preset.weights[input.dataset.patternWeight];
    updatePatternWeightLabel(input);
  });
  dom.difficultyState.textContent = preset.label;
  dom.difficultyState.classList.remove("custom");
}

function markPatternWeightsCustom() {
  dom.difficultyState.textContent = "自定义";
  dom.difficultyState.classList.add("custom");
}

function createRandomSeed() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

function getChartSettings() {
  const weights = {};
  for (const input of dom.patternWeights) {
    weights[input.dataset.patternWeight] = Number(input.value);
  }
  return {
    difficulty: dom.difficulty.value,
    density: Number(dom.density.value) / 100,
    weights,
    seed: dom.seed.value,
  };
}

function getApproachSeconds() {
  const multiplier = clamp(Number(dom.scrollSpeed.value) / 100, 0.6, 5);
  return APP_CONFIG.approachSeconds / multiplier;
}

function generateChart() {
  const analysis = appState.analysis;
  if (!analysis) return;
  const result = chartGenerator.generate(analysis, getChartSettings());
  const notes = result.notes;
  appState.chartResult = result;
  appState.chart = notes;
  resetChartNotes();
  dom.chartNoteCount.textContent = notes.length.toLocaleString("zh-CN");
  const activePatterns = Object.entries(result.patternCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${PATTERN_TYPES[key]} ${count}`)
    .join(" / ");
  const difficultyLabel = DIFFICULTY_PRESETS[result.difficulty].label;
  dom.chartDescription.textContent = [
    `${difficultyLabel}${dom.difficultyState.classList.contains("custom") ? "·自定义" : ""}`,
    `密度 ${Math.round(result.density * 100)}%`,
    `1/${result.subdivision} 网格`,
    `三轨 ${result.laneCounts.join("/")}`,
    `重复组 ${result.repeatGroupCount}`,
    activePatterns || "暂无范式",
  ].join(" · ");
  dom.startGame.disabled = notes.length === 0;
  dom.stageMessage.classList.add("hidden");
  drawGame(performance.now());
  showToast(`已生成 ${notes.length} 个音符 · SEED ${result.userSeed} / ${result.effectiveSeed}`);
}

function resetChartNotes() {
  for (const note of appState.chart) {
    note.judged = false;
    note.hit = false;
    note.result = "";
  }
}

function resetScore() {
  const game = appState.game;
  game.score = 0;
  game.combo = 0;
  game.maxCombo = 0;
  game.judged = 0;
  game.accuracyPoints = 0;
  game.laneFlash = [0, 0, 0];
  updateScoreUI();
}

function updateScoreUI() {
  const game = appState.game;
  const accuracy = game.judged ? game.accuracyPoints / game.judged * 100 : 100;
  dom.score.textContent = String(game.score).padStart(6, "0");
  dom.combo.textContent = game.combo;
  dom.accuracy.textContent = `${accuracy.toFixed(1)}%`;
}

async function startGame() {
  if (!appState.chart.length || !audio.trackBuffer) return;
  await audio.resume();
  finishGame(true);
  resetChartNotes();
  resetScore();
  audio.seek(0);
  await audio.play();
  appState.game.active = true;
  dom.chartConfig.open = false;
  dom.gameControls.classList.add("playing");
  dom.startGame.disabled = true;
  dom.stopGame.disabled = false;
  dom.play.disabled = true;
  dom.seek.disabled = true;
  dom.restart.disabled = true;
  dom.stageMessage.classList.add("hidden");
  showJudgement(dom.autoplay.checked ? "AUTO!" : "GO!", "great");
  appState.game.animationId = requestAnimationFrame(gameLoop);
}

function finishGame(silent = false) {
  if (!appState.game.active && silent) return;
  const wasActive = appState.game.active;
  appState.game.active = false;
  dom.gameControls.classList.remove("playing");
  cancelAnimationFrame(appState.game.animationId);
  if (wasActive) audio.pause();
  dom.startGame.disabled = !appState.chart.length;
  dom.stopGame.disabled = true;
  disableTrackControls(false);
  if (wasActive && !silent) {
    const accuracy = appState.game.judged
      ? appState.game.accuracyPoints / appState.game.judged * 100
      : 100;
    dom.stageMessage.classList.remove("hidden");
    dom.stageMessage.innerHTML = `<b>演奏结束 · MAX COMBO ${appState.game.maxCombo}</b><span>最终准确率 ${accuracy.toFixed(1)}%，点击开始可以重玩</span>`;
  }
}

function gameLoop(timestamp) {
  if (!appState.game.active) return;
  const position = audio.getPosition();
  const missWindow = APP_CONFIG.hitWindows.good;
  const approachSeconds = getApproachSeconds();
  for (const note of appState.chart) {
    if (!note.judged && dom.autoplay.checked && note.time <= position + 0.012) {
      registerAutoHit(note);
    } else if (!note.judged && position - note.time > missWindow) {
      registerMiss(note);
    }
    if (note.time > position + approachSeconds) break;
  }
  drawGame(timestamp);
  const lastNote = appState.chart[appState.chart.length - 1];
  if (lastNote && position > lastNote.time + 1.2) {
    finishGame();
    return;
  }
  appState.game.animationId = requestAnimationFrame(gameLoop);
}

function hitLane(lane) {
  appState.game.laneFlash[lane] = performance.now() + 110;
  triggerPad(lane, false);
  if (!appState.game.active) {
    drawGame(performance.now());
    return;
  }
  if (dom.autoplay.checked) return;

  const position = audio.getPosition();
  let nearest = null;
  let nearestDistance = Infinity;
  for (const note of appState.chart) {
    if (note.judged || note.lane !== lane) continue;
    const distance = Math.abs(note.time - position);
    if (distance < nearestDistance) {
      nearest = note;
      nearestDistance = distance;
    }
    if (note.time > position + APP_CONFIG.hitWindows.good) break;
  }

  if (!nearest || nearestDistance > APP_CONFIG.hitWindows.good) {
    appState.game.combo = 0;
    showJudgement("EMPTY", "miss");
    updateScoreUI();
    return;
  }

  nearest.judged = true;
  nearest.hit = true;
  appState.game.judged += 1;
  appState.game.combo += 1;
  appState.game.maxCombo = Math.max(appState.game.maxCombo, appState.game.combo);
  if (nearestDistance <= APP_CONFIG.hitWindows.perfect) {
    nearest.result = "PERFECT";
    appState.game.score += 1000 + Math.min(500, appState.game.combo * 4);
    appState.game.accuracyPoints += 1;
    showJudgement("PERFECT", "perfect");
  } else if (nearestDistance <= APP_CONFIG.hitWindows.great) {
    nearest.result = "GREAT";
    appState.game.score += 700 + Math.min(350, appState.game.combo * 3);
    appState.game.accuracyPoints += .82;
    showJudgement("GREAT", "great");
  } else {
    nearest.result = "GOOD";
    appState.game.score += 400;
    appState.game.accuracyPoints += .55;
    showJudgement("GOOD", "great");
  }
  updateScoreUI();
}

function registerAutoHit(note) {
  const game = appState.game;
  note.judged = true;
  note.hit = true;
  note.result = "PERFECT";
  game.judged += 1;
  game.combo += 1;
  game.maxCombo = Math.max(game.maxCombo, game.combo);
  game.score += 1000 + Math.min(500, game.combo * 4);
  game.accuracyPoints += 1;
  game.laneFlash[note.lane] = performance.now() + 110;
  triggerPad(note.lane, false);
  showJudgement("AUTO", "perfect");
  updateScoreUI();
}

function registerMiss(note) {
  note.judged = true;
  note.result = "MISS";
  appState.game.judged += 1;
  appState.game.combo = 0;
  showJudgement("MISS", "miss");
  updateScoreUI();
}

function showJudgement(text, type) {
  dom.judgement.textContent = text;
  dom.judgement.className = `judgement ${type}`;
  void dom.judgement.offsetWidth;
  dom.judgement.classList.add("show");
}

function drawGame(timestamp = performance.now()) {
  const canvas = dom.gameCanvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.floor(rect.width * dpr);
  const targetHeight = Math.floor(rect.height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const laneWidth = width / 3;
  const hitY = height - 54;
  const position = appState.game.active ? audio.getPosition() : 0;
  const approachSeconds = getApproachSeconds();
  const speed = (hitY + 55) / approachSeconds;

  context.clearRect(0, 0, width, height);
  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "#080d19");
  background.addColorStop(1, "#131d31");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  for (let lane = 0; lane < 3; lane += 1) {
    const x = lane * laneWidth;
    const flashing = appState.game.laneFlash[lane] > timestamp;
    context.fillStyle = flashing ? `${LANE_COLORS[lane]}26` : lane % 2 ? "#ffffff04" : "#00000010";
    context.fillRect(x, 0, laneWidth, height);
    context.strokeStyle = "#ffffff13";
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  if (appState.analysis) {
    const beat = 60 / appState.analysis.bpm;
    const startBeat = Math.floor((position - appState.analysis.beatOffset) / beat);
    for (let index = startBeat; index < startBeat + Math.ceil(approachSeconds / beat) + 2; index += 1) {
      const time = appState.analysis.beatOffset + index * beat;
      const y = hitY - (time - position) * speed;
      if (y < -5 || y > height + 5) continue;
      context.strokeStyle = index % 4 === 0 ? "#ffbc5535" : "#ffffff0c";
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
  }

  context.shadowBlur = 15;
  for (const note of appState.chart) {
    if (note.hit) continue;
    const delta = note.time - position;
    if (delta > approachSeconds || delta < -.35) continue;
    const y = hitY - delta * speed;
    const centerX = note.lane * laneWidth + laneWidth / 2;
    const noteWidth = Math.min(92, laneWidth * .58);
    const noteHeight = 15;
    context.shadowColor = LANE_COLORS[note.lane];
    context.fillStyle = note.judged ? "#ffffff25" : LANE_COLORS[note.lane];
    roundRect(context, centerX - noteWidth / 2, y - noteHeight / 2, noteWidth, noteHeight, 8);
    context.fill();
    context.fillStyle = "#ffffffbb";
    roundRect(context, centerX - noteWidth * .28, y - 2, noteWidth * .56, 4, 2);
    context.fill();
  }
  context.shadowBlur = 0;

  context.fillStyle = "#ffffff16";
  context.fillRect(0, hitY - 2, width, 4);
  for (let lane = 0; lane < 3; lane += 1) {
    const x = lane * laneWidth + laneWidth * .16;
    const targetWidth = laneWidth * .68;
    const target = context.createLinearGradient(x, 0, x + targetWidth, 0);
    target.addColorStop(0, `${LANE_COLORS[lane]}44`);
    target.addColorStop(.5, LANE_COLORS[lane]);
    target.addColorStop(1, `${LANE_COLORS[lane]}44`);
    context.fillStyle = target;
    roundRect(context, x, hitY - 5, targetWidth, 10, 5);
    context.fill();
  }
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function beginBinding(lane) {
  appState.bindingLane = lane;
  dom.bindingButtons.forEach((button, index) => button.classList.toggle("listening", index === lane));
  dom.bindingHelp.textContent = `正在设置第 ${lane + 1} 轨：请按下新按键（Esc 取消）`;
  dom.bindingHelp.classList.add("listening");
}

function finishBinding() {
  appState.bindingLane = null;
  dom.bindingButtons.forEach((button) => button.classList.remove("listening"));
  dom.bindingHelp.textContent = "点击任一轨道，再按下新的键即可绑定。";
  dom.bindingHelp.classList.remove("listening");
}

function handleKeydown(event) {
  if (appState.bindingLane !== null) {
    event.preventDefault();
    if (event.code === "Escape") {
      finishBinding();
      return;
    }
    const duplicateLane = appState.bindings.findIndex((binding) => binding.code === event.code);
    if (duplicateLane !== -1 && duplicateLane !== appState.bindingLane) {
      showToast(`该按键已绑定到第 ${duplicateLane + 1} 轨`);
      return;
    }
    appState.bindings[appState.bindingLane] = { code: event.code, label: displayKey(event) };
    saveBindings();
    renderBindings();
    finishBinding();
    showToast("键位已保存");
    return;
  }

  if (event.repeat || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  const route = document.body.dataset.route;
  if (route === "sampler") {
    const padShortcuts = {
      Digit1: 0, Numpad1: 0,
      Digit2: 1, Numpad2: 1,
      Digit3: 2, Numpad3: 2,
    };
    if (Object.hasOwn(padShortcuts, event.code)) {
      event.preventDefault();
      triggerPad(padShortcuts[event.code], true);
    }
    return;
  }
  if (route !== "game") return;
  const lane = appState.bindings.findIndex((binding) => binding.code === event.code);
  if (lane === -1) return;
  event.preventDefault();
  hitLane(lane);
}

function bindEvents() {
  [dom.upload, dom.samplerUpload, dom.gameUpload].forEach((input) => {
    input.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      await loadTrack(file, file.name);
      event.target.value = "";
    });
  });
  dom.routeButtons.forEach((button) => {
    button.addEventListener("click", () => requestRoute(button.dataset.route));
  });
  window.addEventListener("hashchange", () => navigate(getRoute()));
  dom.useDefault.addEventListener("click", loadDefaultTrack);
  dom.play.addEventListener("click", async () => {
    if (appState.game.active) return;
    if (audio.playing) audio.pause();
    else await audio.play();
    updateTransportUI();
  });
  dom.restart.addEventListener("click", () => audio.seek(0));
  dom.seek.addEventListener("input", () => {
    const duration = audio.trackBuffer?.duration || 0;
    audio.seek(Number(dom.seek.value) / 1000 * duration);
  });
  dom.reanalyze.addEventListener("click", reanalyzeCurrentTrack);
  dom.bpmMinus.addEventListener("click", () => adjustBpm(-1));
  dom.bpmPlus.addEventListener("click", () => adjustBpm(1));
  dom.snapToggle.addEventListener("change", () => {
    dom.snapStateText.textContent = dom.snapToggle.checked ? "已开启" : "已关闭";
  });
  dom.pads.forEach((pad, lane) => pad.addEventListener("click", () => triggerPad(lane, true)));
  dom.keyButtons.forEach((button, lane) => button.addEventListener("pointerdown", () => hitLane(lane)));
  dom.density.addEventListener("input", () => {
    dom.densityValue.textContent = `${dom.density.value}%`;
  });
  dom.scrollSpeed.addEventListener("input", () => {
    dom.scrollSpeedValue.textContent = `${(Number(dom.scrollSpeed.value) / 100).toFixed(1)}×`;
    drawGame(performance.now());
  });
  dom.autoplay.addEventListener("change", () => {
    dom.autoplayState.textContent = dom.autoplay.checked ? "开启" : "关闭";
    dom.autoplayState.classList.toggle("active", dom.autoplay.checked);
    showToast(dom.autoplay.checked ? "自动播放已开启" : "自动播放已关闭");
  });
  dom.chartConfig.addEventListener("toggle", () => {
    if (appState.game.active && dom.chartConfig.open) dom.chartConfig.open = false;
  });
  dom.difficulty.addEventListener("change", () => applyDifficultyPreset(dom.difficulty.value));
  dom.patternWeights.forEach((input) => {
    input.addEventListener("input", () => {
      updatePatternWeightLabel(input);
      markPatternWeightsCustom();
    });
  });
  dom.seed.addEventListener("change", () => {
    dom.seed.value = dom.seed.value.trim() || "DOG-001";
  });
  dom.randomizeSeed.addEventListener("click", () => {
    dom.seed.value = createRandomSeed();
    showToast(`已生成新种子 ${dom.seed.value}`);
  });
  dom.generateChart.addEventListener("click", generateChart);
  dom.startGame.addEventListener("click", startGame);
  dom.stopGame.addEventListener("click", () => finishGame());
  dom.bindingButtons.forEach((button, lane) => button.addEventListener("click", () => beginBinding(lane)));
  dom.resetKeys.addEventListener("click", () => {
    appState.bindings = DEFAULT_BINDINGS.map((binding) => ({ ...binding }));
    saveBindings();
    renderBindings();
    finishBinding();
    showToast("已恢复 ← ↓ → 默认键位");
  });
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", () => {
    drawWaveform();
    drawGame(performance.now());
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && audio.playing && !appState.game.active) audio.pause();
  });
}

async function initialize() {
  renderBindings();
  applyDifficultyPreset(dom.difficulty.value);
  bindEvents();
  navigate(getRoute());
  animateTransport();
  drawGame(performance.now());
  try {
    await audio.loadSamples();
  } catch (error) {
    console.error(error);
    showToast("采样初始化失败，请确认 audio 文件夹与 index.html 位于同一项目目录");
  }
  await loadDefaultTrack();
}

initialize();
