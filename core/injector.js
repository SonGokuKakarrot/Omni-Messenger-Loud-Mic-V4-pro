(() => {
  if (window.__micMaxInjectorReady) return;
  window.__micMaxInjectorReady = true;

  // Omni Messenger Lord V4 extreme 200000x profile, with clamps to keep controls recoverable.
  const DEFAULTS = {
    profileVersion: 5,
    enabled: true,
    gainDb: 106.0206,
    thresholdDb: -60,
    knee: 40,
    ratio: 20,
    attack: 0.0001,
    release: 0.03,
    lowShelfDb: 14,
    presenceDb: 20,
    highShelfDb: 16,
    limiterDb: -0.1,
    drive: 1.2,
    loudness: 1.0,
    maxBoost: 200000,
    sustain: true,
    sustainTargetDb: 5,
    sustainMaxGain: 120,
    forceRawMic: true,
    reverbEnabled: true,
    reverbDelay: 0.045,
    reverbFeedback: 0.35,
    reverbWet: 0.18,
    keepAlive: true,
    keepAliveGain: 0.00035,
    senderRefreshMs: 500
  };
  const MSG_CFG = 'MIC_MAXIMIZER_CONFIG';
  const AUDIO_SEND_MAX_BITRATE = 512000;
  const state = {
    config: { ...DEFAULTS },
    origMD: null,
    origLegacy: null,
    pipelines: new Set(),
    trackMap: new WeakMap(),
    processedTracks: new WeakSet(),
    processedMeta: new WeakMap(),
    senderWatchTracks: new WeakSet(),
    peerConnections: new Set(),
    senderRecords: new Set(),
    senderBySender: new WeakMap(),
    refreshingSenders: new WeakSet(),
    recoverTimers: new Set(),
    sourceTracks: new Set(),
    origApplyConstraints: null,
    lastAudioConstraints: { audio: true }
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
  const dbToLinear = (db) => Math.pow(10, db / 20);

  function cfg(input = state.config) {
    const merged = { ...DEFAULTS, ...(input || {}) };
    merged.enabled = Boolean(merged.enabled);
    merged.maxBoost = clamp(merged.maxBoost, 1, 200000);
    merged.loudness = clamp(merged.loudness, 0.5, merged.maxBoost);
    merged.gainDb = clamp(merged.gainDb, 0, 120);
    merged.drive = clamp(merged.drive, 0, 10);
    merged.thresholdDb = clamp(merged.thresholdDb, -100, 0);
    merged.knee = clamp(merged.knee, 0, 40);
    // DynamicsCompressorNode.ratio has a nominal browser range of [1, 20].
    // Values above 20 trigger Quetta/Chromium extension errors/warnings at setTargetAtTime.
    merged.ratio = clamp(merged.ratio, 1, 20);
    merged.attack = clamp(merged.attack, 0.0001, 1);
    merged.release = clamp(merged.release, 0.01, 1);
    merged.lowShelfDb = clamp(merged.lowShelfDb, -60, 60);
    merged.presenceDb = clamp(merged.presenceDb, -60, 60);
    merged.highShelfDb = clamp(merged.highShelfDb, -60, 60);
    merged.limiterDb = clamp(merged.limiterDb, -24, 0);
    merged.sustain = Boolean(merged.sustain);
    merged.sustainTargetDb = clamp(merged.sustainTargetDb, -24, 12);
    merged.sustainMaxGain = clamp(merged.sustainMaxGain, 1, 160);
    merged.forceRawMic = Boolean(merged.forceRawMic);
    merged.reverbEnabled = Boolean(merged.reverbEnabled);
    merged.reverbDelay = clamp(merged.reverbDelay, 0.01, 0.35);
    merged.reverbFeedback = clamp(merged.reverbFeedback, 0, 0.75);
    merged.reverbWet = clamp(merged.reverbWet, 0, 0.6);
    merged.keepAlive = Boolean(merged.keepAlive);
    merged.keepAliveGain = clamp(merged.keepAliveGain, 0, 0.003);
    merged.senderRefreshMs = clamp(merged.senderRefreshMs, 250, 1500);
    return merged;
  }

  function makeSaturationCurve(amount = 0.5) {
    const k = Math.max(0.0001, amount * 100);
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function setParam(param, value, ctx) {
    if (!param) return;
    const safeValue = clamp(value, param.minValue ?? -Infinity, param.maxValue ?? Infinity);
    const now = ctx?.currentTime || 0;
    try {
      if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
      if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(safeValue, now, 0.005);
      else param.value = safeValue;
    } catch (_) {
      try { param.value = safeValue; } catch (_) {}
    }
  }

  function applyPipeline(pipeline, inputConfig = state.config) {
    const raw = cfg(inputConfig);
    const c = raw.enabled ? raw : {
      ...raw,
      lowShelfDb: 0,
      presenceDb: 0,
      highShelfDb: 0,
      thresholdDb: -6,
      knee: 0,
      ratio: 1,
      loudness: 1,
      gainDb: 0,
      drive: 0,
      limiterDb: -0.5
    };
    const { ctx, nodes } = pipeline;
    setParam(nodes.low.gain, c.lowShelfDb, ctx);
    setParam(nodes.pres.gain, c.presenceDb, ctx);
    setParam(nodes.high.gain, c.highShelfDb, ctx);
    setParam(nodes.comp1.threshold, c.thresholdDb, ctx);
    setParam(nodes.comp1.knee, c.knee, ctx);
    setParam(nodes.comp1.ratio, c.ratio, ctx);
    setParam(nodes.comp1.attack, c.attack, ctx);
    setParam(nodes.comp1.release, c.release, ctx);
    setParam(nodes.loudness.gain, c.loudness, ctx);
    setParam(nodes.gain.gain, dbToLinear(c.gainDb), ctx);
    nodes.saturator.curve = makeSaturationCurve(c.drive);
    if (nodes.reverbDelay) setParam(nodes.reverbDelay.delayTime, c.reverbDelay, ctx);
    if (nodes.reverbFeedback) setParam(nodes.reverbFeedback.gain, c.reverbEnabled ? c.reverbFeedback : 0, ctx);
    if (nodes.reverbWet) setParam(nodes.reverbWet.gain, c.reverbEnabled ? c.reverbWet : 0, ctx);
    if (nodes.keepAliveGain) setParam(nodes.keepAliveGain.gain, c.keepAlive ? c.keepAliveGain : 0, ctx);
    if (nodes.sustain && !c.sustain) setParam(nodes.sustain.gain, 1, ctx);
    setParam(nodes.limiter.threshold, c.limiterDb, ctx);
  }

  function updateAllPipelines(inputConfig = state.config) {
    for (const pipeline of state.pipelines) applyPipeline(pipeline, inputConfig);
  }

  function resumePipeline(pipeline) {
    const ctx = pipeline?.ctx;
    if (!ctx || ctx.state === 'closed' || typeof ctx.resume !== 'function') return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  function resumeAllPipelines() {
    for (const pipeline of state.pipelines) resumePipeline(pipeline);
  }

  function rmsDbFromAnalyser(analyser, buffer) {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = (buffer[i] - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / buffer.length);
    return 20 * Math.log10(Math.max(rms, 0.000001));
  }

  function startSustainController(pipeline) {
    const { ctx, nodes } = pipeline;
    if (!nodes.meter || !nodes.sustain) return;
    const buffer = new Uint8Array(nodes.meter.fftSize);
    let currentGain = 1;
    pipeline.sustainTimer = setInterval(() => {
      const c = cfg();
      if (!c.enabled || !c.sustain || ctx.state === 'closed') {
        currentGain = 1;
        setParam(nodes.sustain.gain, 1, ctx);
        return;
      }
      resumePipeline(pipeline);
      const db = rmsDbFromAnalyser(nodes.meter, buffer);
      const target = c.sustainTargetDb;
      if (db < target) {
        const lift = 1 + Math.min(1.2, Math.max(0.02, (target - db) * 0.035));
        currentGain = Math.min(c.sustainMaxGain, currentGain * lift);
      } else {
        currentGain = Math.max(1, currentGain * 0.82);
      }
      setParam(nodes.sustain.gain, currentGain, ctx);
    }, 120);
  }

  function createAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      return new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch (_) {
      return new AC({ latencyHint: 'interactive' });
    }
  }

  function createKeepAliveNoise(ctx) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 2));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * 0.35;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  function build(stream, inputConfig) {
    const ctx = createAudioContext();
    if (!ctx || !stream.getAudioTracks().length) return stream;
    stream.getAudioTracks().forEach(enforceRawMicTrack);

    const source = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 75;
    hp.Q.value = 0.7;

    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;

    const pres = ctx.createBiquadFilter();
    pres.type = 'peaking';
    pres.frequency.value = 3200;
    pres.Q.value = 1.5;

    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 6000;

    const comp1 = ctx.createDynamicsCompressor();
    const comp2 = ctx.createDynamicsCompressor();
    comp2.threshold.value = -10;
    comp2.knee.value = 5;
    comp2.ratio.value = 12;
    comp2.attack.value = 0.001;
    comp2.release.value = 0.05;

    const loudness = ctx.createGain();
    const gain = ctx.createGain();
    const saturator = ctx.createWaveShaper();
    saturator.oversample = '4x';
    const sustain = ctx.createGain();
    sustain.gain.value = 1;

    const reverbDelay = ctx.createDelay(0.5);
    const reverbFeedback = ctx.createGain();
    const reverbWet = ctx.createGain();
    const keepAliveGain = ctx.createGain();
    keepAliveGain.gain.value = 0;
    const keepAliveSource = createKeepAliveNoise(ctx);

    const limiter = ctx.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0001;
    limiter.release.value = 0.01;

    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0.18;

    const dst = ctx.createMediaStreamDestination();
    source.connect(hp);
    hp.connect(low);
    low.connect(pres);
    pres.connect(high);
    high.connect(comp1);
    comp1.connect(comp2);
    comp2.connect(loudness);
    loudness.connect(gain);
    gain.connect(saturator);
    saturator.connect(sustain);
    saturator.connect(reverbDelay);
    reverbDelay.connect(reverbFeedback);
    reverbFeedback.connect(reverbDelay);
    reverbDelay.connect(reverbWet);
    reverbWet.connect(sustain);
    sustain.connect(limiter);
    limiter.connect(meter);
    keepAliveSource.connect(keepAliveGain);
    keepAliveGain.connect(meter);
    meter.connect(dst);
    keepAliveSource.start(0);

    const pipeline = {
      ctx,
      nodes: { low, pres, high, comp1, loudness, gain, saturator, sustain, reverbDelay, reverbFeedback, reverbWet, keepAliveGain, limiter, meter },
      keepAliveSource,
      sustainTimer: null
    };
    applyPipeline(pipeline, inputConfig);
    state.pipelines.add(pipeline);
    startSustainController(pipeline);
    resumePipeline(pipeline);

    const outAudioTracks = dst.stream.getAudioTracks();
    outAudioTracks.forEach((track) => {
      state.processedTracks.add(track);
      state.processedMeta.set(track, { source: stream, pipeline });
    });

    const out = new MediaStream([
      ...outAudioTracks,
      ...stream.getTracks().filter((track) => track.kind !== 'audio')
    ]);

    const stop = () => {
      state.pipelines.delete(pipeline);
      if (pipeline.sustainTimer) clearInterval(pipeline.sustainTimer);
      stream.getAudioTracks().forEach((track) => state.sourceTracks.delete(track));
      try { pipeline.keepAliveSource?.stop(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
    };
    outAudioTracks.forEach((track) => track.addEventListener('ended', stop, { once: true }));
    stream.getTracks().forEach((track) => track.addEventListener('ended', scheduleRecoveryPasses, { once: true }));
    return out;
  }

  function rawMicAudioConstraints(audio = {}) {
    const base = audio && typeof audio === 'object' ? audio : {};
    const processingOff = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      googEchoCancellation: false,
      googEchoCancellation2: false,
      googEchoCancellation3: false,
      googDAEchoCancellation: false,
      googExperimentalEchoCancellation: false,
      googAutoGainControl: false,
      googAutoGainControl2: false,
      googNoiseSuppression: false,
      googNoiseSuppression2: false,
      googExperimentalNoiseSuppression: false,
      googHighpassFilter: false,
      googTypingNoiseDetection: false,
      googAudioMirroring: false,
      googBeamforming: false,
      mozAutoGainControl: false,
      mozNoiseSuppression: false
    };
    return {
      ...base,
      ...processingOff,
      channelCount: { ideal: 1, max: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      advanced: [
        ...(Array.isArray(base.advanced) ? base.advanced : []),
        processingOff,
        { channelCount: 1 },
        { sampleRate: 48000 },
        { sampleSize: 16 }
      ]
    };
  }

  function enforceRawMicTrack(track) {
    if (!track || track.kind !== 'audio' || !cfg().forceRawMic) return;
    state.sourceTracks.add(track);
    try { track.enabled = true; } catch (_) {}
    try { track.contentHint = 'speech'; } catch (_) {}
    if (typeof track.applyConstraints === 'function') {
      try { track.applyConstraints(rawMicAudioConstraints()).catch(() => {}); } catch (_) {}
    }
  }

  function enforceAllSourceConstraints() {
    for (const track of [...state.sourceTracks]) {
      if (!track || track.readyState === 'ended') {
        state.sourceTracks.delete(track);
        continue;
      }
      enforceRawMicTrack(track);
    }
  }

  function patchTrackConstraints() {
    const proto = window.MediaStreamTrack?.prototype;
    if (!proto || proto.__micMaxTrackPatched || typeof proto.applyConstraints !== 'function') return;
    state.origApplyConstraints = proto.applyConstraints;
    proto.applyConstraints = function applyConstraints(constraints = {}) {
      const next = cfg().enabled && cfg().forceRawMic && this.kind === 'audio'
        ? rawMicAudioConstraints(constraints)
        : constraints;
      return state.origApplyConstraints.call(this, next);
    };
    proto.__micMaxTrackPatched = true;
  }

  function normalizeConstraints(constraints) {
    if (constraints === true) constraints = { audio: true };
    if (!constraints || typeof constraints !== 'object') return constraints;
    const next = { ...constraints };
    if (next.audio === true) next.audio = {};
    if (typeof next.audio === 'object') next.audio = rawMicAudioConstraints(next.audio);
    return next;
  }

  function wantsAudio(constraints) {
    if (constraints === true) return true;
    if (!constraints || typeof constraints !== 'object') return false;
    return 'audio' in constraints ? Boolean(constraints.audio) : true;
  }

  function processedStreamFor(originalStream, rawTrack, processedTrack) {
    if (!originalStream || typeof originalStream.getTracks !== 'function') return new MediaStream([processedTrack]);
    return new MediaStream(originalStream.getTracks().map((track) => (track === rawTrack ? processedTrack : track)));
  }

  function liveAudioTrack(stream) {
    if (!stream || typeof stream.getAudioTracks !== 'function') return null;
    return stream.getAudioTracks().find((track) => track.readyState !== 'ended') || null;
  }

  function processedSourceIsLive(track) {
    if (!track || !state.processedTracks.has(track)) return true;
    const meta = state.processedMeta.get(track);
    if (!meta) return true;
    resumePipeline(meta.pipeline);
    const sourceTrack = liveAudioTrack(meta.source);
    return Boolean(sourceTrack && sourceTrack.enabled !== false && !sourceTrack.muted);
  }

  function trackNeedsRefresh(track) {
    if (!track || track.kind !== 'audio') return true;
    if (track.readyState === 'ended' || track.muted || track.enabled === false) return true;
    if (!state.processedTracks.has(track)) return true;
    return !processedSourceIsLive(track);
  }

  function rebuildProcessedTrack(track) {
    const meta = state.processedMeta.get(track);
    const sourceTrack = liveAudioTrack(meta?.source);
    if (!sourceTrack) return track;
    try {
      const rebuiltStream = build(new MediaStream([sourceTrack]), state.config);
      return liveAudioTrack(rebuiltStream) || track;
    } catch (_) {
      return track;
    }
  }

  function cloneForSender(track) {
    const liveTrack = track?.readyState === 'ended' ? rebuildProcessedTrack(track) : track;
    if (!liveTrack || liveTrack.readyState === 'ended' || typeof liveTrack.clone !== 'function') return liveTrack;
    try {
      const clone = liveTrack.clone();
      state.processedTracks.add(clone);
      const meta = state.processedMeta.get(liveTrack);
      if (meta) state.processedMeta.set(clone, meta);
      return clone;
    } catch (_) {
      return liveTrack;
    }
  }

  function processAudioTrack(track, forSender = false) {
    if (!track || track.kind !== 'audio') return track;
    if (state.processedTracks.has(track)) {
      const nextTrack = track.readyState === 'ended' ? rebuildProcessedTrack(track) : track;
      return forSender ? cloneForSender(nextTrack) : nextTrack;
    }

    const existing = state.trackMap.get(track);
    if (existing) {
      const nextTrack = existing.readyState === 'ended' ? rebuildProcessedTrack(existing) : existing;
      if (nextTrack && nextTrack !== existing && nextTrack.readyState !== 'ended') state.trackMap.set(track, nextTrack);
      if (nextTrack && nextTrack.readyState !== 'ended') return forSender ? cloneForSender(nextTrack) : nextTrack;
    }

    const processedStream = build(new MediaStream([track]), state.config);
    const processedTrack = liveAudioTrack(processedStream) || track;
    if (processedTrack !== track) {
      state.processedTracks.add(processedTrack);
      state.trackMap.set(track, processedTrack);
      track.addEventListener('ended', () => {
        try { processedTrack.stop(); } catch (_) {}
      }, { once: true });
    }
    return forSender ? cloneForSender(processedTrack) : processedTrack;
  }


  function enhanceAudioSdp(sdp) {
    if (typeof sdp !== 'string' || !sdp.includes('m=audio')) return sdp;
    let next = sdp;
    next = next.replace(/a=fmtp:111 ([^\r\n]*)/g, (line, params) => {
      const additions = ['maxaveragebitrate=512000', 'stereo=0', 'sprop-stereo=0', 'useinbandfec=1', 'usedtx=0'];
      const merged = params || '';
      const suffix = additions.filter((item) => !new RegExp(`(^|;)\\s*${item.split('=')[0]}=`, 'i').test(merged));
      return suffix.length ? `${line};${suffix.join(';')}` : line;
    });
    next = next.replace(/b=AS:\d+/g, 'b=AS:512').replace(/b=TIAS:\d+/g, 'b=TIAS:512000');
    if (!/b=AS:512/.test(next)) next = next.replace(/(m=audio[^\r\n]*(?:\r?\n)c=IN[^\r\n]*)/, '$1\r\nb=AS:512');
    if (!/b=TIAS:512000/.test(next)) next = next.replace(/(b=AS:512)/, '$1\r\nb=TIAS:512000');
    return next;
  }

  function cloneDescriptionWithSdp(desc, sdp) {
    if (!desc || typeof desc !== 'object' || !sdp || sdp === desc.sdp) return desc;
    try {
      return new RTCSessionDescription({ type: desc.type, sdp });
    } catch (_) {
      try { return { ...desc, sdp }; } catch (_) { return desc; }
    }
  }

  function tuneAudioSender(sender) {
    if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    try {
      const params = sender.getParameters() || {};
      const encodings = Array.isArray(params.encodings) && params.encodings.length ? params.encodings : [{}];
      params.encodings = encodings.map((encoding) => ({
        ...encoding,
        active: encoding.active !== false,
        dtx: false,
        maxBitrate: Math.max(Number(encoding.maxBitrate) || 0, AUDIO_SEND_MAX_BITRATE),
        networkPriority: 'high',
        priority: 'high'
      }));
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }

  function rememberPeerConnection(pc) {
    if (!pc || state.peerConnections.has(pc)) return;
    state.peerConnections.add(pc);
    if (typeof pc.addEventListener === 'function') {
      pc.addEventListener('connectionstatechange', () => {
        if (['closed', 'failed'].includes(pc.connectionState)) state.peerConnections.delete(pc);
      });
    }
  }

  function rememberSender(sender, track, pc = null) {
    if (!sender) return null;
    let record = state.senderBySender.get(sender);
    if (!record) {
      record = { sender, track: null, pc: null };
      state.senderBySender.set(sender, record);
      state.senderRecords.add(record);
    }
    if (track) record.track = track;
    if (pc) record.pc = pc;
    return record;
  }

  function recordIsClosed(record) {
    const pc = record?.pc;
    if (!pc) return false;
    return ['closed', 'failed'].includes(pc.connectionState || pc.iceConnectionState || '');
  }

  async function reacquireProcessedTrackForSender() {
    if (!state.origMD) return null;
    try {
      const constraints = normalizeConstraints(state.lastAudioConstraints || { audio: true });
      const stream = await state.origMD(constraints);
      const rawTrack = liveAudioTrack(stream);
      if (!rawTrack) return null;
      return processAudioTrack(rawTrack, true);
    } catch (_) {
      return null;
    }
  }

  async function replaceSenderTrack(sender, track) {
    if (!sender || typeof sender.replaceTrack !== 'function') return null;
    rememberSender(sender, track);
    const current = track || sender.track;
    let replacement = null;

    if (current && current.kind === 'audio' && !trackNeedsRefresh(current)) {
      replacement = current;
    } else if (current && current.kind === 'audio' && current.readyState !== 'ended' && !state.processedTracks.has(current)) {
      replacement = processAudioTrack(current, true);
    }

    if (!replacement || trackNeedsRefresh(replacement)) replacement = await reacquireProcessedTrackForSender();
    if (!replacement || replacement.readyState === 'ended') return null;

    try {
      await sender.replaceTrack(replacement);
      tuneAudioSender(sender);
      rememberSender(sender, replacement);
      watchSenderTrack(sender, replacement);
      return replacement;
    } catch (_) {
      return null;
    }
  }

  function queueSenderRefresh(sender, track) {
    resumeAllPipelines();
    if (!sender || state.refreshingSenders.has(sender)) return;
    state.refreshingSenders.add(sender);
    setTimeout(() => {
      replaceSenderTrack(sender, track).finally(() => state.refreshingSenders.delete(sender));
    }, 50);
  }

  function watchSenderTrack(sender, track) {
    if (!sender || !track || track.kind !== 'audio') return;
    rememberSender(sender, track);
    if (!state.processedTracks.has(track) || state.senderWatchTracks.has(track)) return;
    state.senderWatchTracks.add(track);
    track.addEventListener('ended', () => queueSenderRefresh(sender, track), { once: true });
    track.addEventListener('mute', () => setTimeout(() => queueSenderRefresh(sender, track), 120), { passive: true });
    track.addEventListener('unmute', () => tuneAudioSender(sender), { passive: true });
  }

  function scheduleRecoveryPasses() {
    for (const timer of state.recoverTimers) clearTimeout(timer);
    state.recoverTimers.clear();
    [0, 150, 500, 1200, 2500, 5000, 9000].forEach((delay) => {
      const timer = setTimeout(() => {
        state.recoverTimers.delete(timer);
        resumeAllPipelines();
        reconcileLiveSenders();
      }, delay);
      state.recoverTimers.add(timer);
    });
  }

  function reconcileLiveSenders() {
    if (!cfg().enabled) return;
    resumeAllPipelines();
    for (const pc of [...state.peerConnections]) {
      if (typeof pc.getSenders !== 'function') continue;
      try {
        for (const sender of pc.getSenders()) {
          const track = sender?.track;
          if (track?.kind === 'audio') rememberSender(sender, track);
        }
      } catch (_) {}
    }

    for (const record of [...state.senderRecords]) {
      if (recordIsClosed(record)) {
        state.senderRecords.delete(record);
        continue;
      }
      const sender = record.sender;
      const track = sender?.track || record.track;
      if (!sender || !track || track.kind !== 'audio') continue;
      if (trackNeedsRefresh(track)) queueSenderRefresh(sender, track);
      else {
        tuneAudioSender(sender);
        watchSenderTrack(sender, track);
      }
    }
  }

  function patchPeerConnectionPaths() {
    const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (PC?.prototype && !PC.prototype.__micMaxPcPatched) {
      const originalAddTrack = PC.prototype.addTrack;
      if (typeof originalAddTrack === 'function') {
        PC.prototype.addTrack = function addTrack(track, ...streams) {
          rememberPeerConnection(this);
          if (cfg().enabled && track?.kind === 'audio') {
            const processedTrack = processAudioTrack(track, true);
            const patchedStreams = streams.length
              ? streams.map((stream) => processedStreamFor(stream, track, processedTrack))
              : [new MediaStream([processedTrack])];
            const sender = originalAddTrack.call(this, processedTrack, ...patchedStreams);
            tuneAudioSender(sender);
            rememberSender(sender, processedTrack, this);
            if (typeof sender?.replaceTrack === 'function') watchSenderTrack(sender, processedTrack);
            return sender;
          }
          return originalAddTrack.call(this, track, ...streams);
        };
      }

      const originalAddTransceiver = PC.prototype.addTransceiver;
      if (typeof originalAddTransceiver === 'function') {
        PC.prototype.addTransceiver = function addTransceiver(trackOrKind, init = undefined) {
          rememberPeerConnection(this);
          if (cfg().enabled && trackOrKind?.kind === 'audio') {
            const processedTrack = processAudioTrack(trackOrKind, true);
            const patchedInit = init?.streams
              ? { ...init, streams: init.streams.map((stream) => processedStreamFor(stream, trackOrKind, processedTrack)) }
              : init;
            const transceiver = originalAddTransceiver.call(this, processedTrack, patchedInit);
            tuneAudioSender(transceiver?.sender);
            rememberSender(transceiver?.sender, processedTrack, this);
            if (typeof transceiver?.sender?.replaceTrack === 'function') watchSenderTrack(transceiver.sender, processedTrack);
            return transceiver;
          }
          return originalAddTransceiver.call(this, trackOrKind, init);
        };
      }
      const originalCreateOffer = PC.prototype.createOffer;
      if (typeof originalCreateOffer === 'function') {
        PC.prototype.createOffer = function createOffer(...args) {
          rememberPeerConnection(this);
          return originalCreateOffer.apply(this, args).then((offer) => cloneDescriptionWithSdp(offer, enhanceAudioSdp(offer?.sdp)));
        };
      }

      const originalCreateAnswer = PC.prototype.createAnswer;
      if (typeof originalCreateAnswer === 'function') {
        PC.prototype.createAnswer = function createAnswer(...args) {
          rememberPeerConnection(this);
          return originalCreateAnswer.apply(this, args).then((answer) => cloneDescriptionWithSdp(answer, enhanceAudioSdp(answer?.sdp)));
        };
      }

      const originalSetLocalDescription = PC.prototype.setLocalDescription;
      if (typeof originalSetLocalDescription === 'function') {
        PC.prototype.setLocalDescription = function setLocalDescription(desc) {
          rememberPeerConnection(this);
          const patched = cloneDescriptionWithSdp(desc, enhanceAudioSdp(desc?.sdp));
          return originalSetLocalDescription.call(this, patched);
        };
      }

      const originalSetRemoteDescription = PC.prototype.setRemoteDescription;
      if (typeof originalSetRemoteDescription === 'function') {
        PC.prototype.setRemoteDescription = function setRemoteDescription(desc) {
          rememberPeerConnection(this);
          const patched = cloneDescriptionWithSdp(desc, enhanceAudioSdp(desc?.sdp));
          const result = originalSetRemoteDescription.call(this, patched);
          Promise.resolve(result).then(scheduleRecoveryPasses).catch(() => {});
          return result;
        };
      }

      PC.prototype.__micMaxPcPatched = true;
    }

    const Sender = window.RTCRtpSender;
    if (Sender?.prototype && !Sender.prototype.__micMaxSenderPatched) {
      const originalReplaceTrack = Sender.prototype.replaceTrack;
      if (typeof originalReplaceTrack === 'function') {
        Sender.prototype.replaceTrack = function replaceTrack(track) {
          const nextTrack = cfg().enabled && track?.kind === 'audio' ? processAudioTrack(track, true) : track;
          const result = originalReplaceTrack.call(this, nextTrack);
          if (nextTrack?.kind === 'audio') {
            rememberSender(this, nextTrack);
            Promise.resolve(result).then(() => {
              tuneAudioSender(this);
              watchSenderTrack(this, nextTrack);
            }).catch(() => {});
          }
          return result;
        };
      }
      Sender.prototype.__micMaxSenderPatched = true;
    }
  }

  async function getStreamWithFallback(orig, constraints, ctx) {
    try {
      return await orig.call(ctx, normalizeConstraints(constraints));
    } catch (_) {
      return orig.call(ctx, constraints);
    }
  }

  async function wrapped(orig, constraints, ctx) {
    if (wantsAudio(constraints)) state.lastAudioConstraints = constraints || { audio: true };
    const stream = await getStreamWithFallback(orig, constraints, ctx);
    if (!cfg().enabled || !wantsAudio(constraints)) return stream;
    try {
      return build(stream, state.config);
    } catch (_) {
      return stream;
    }
  }

  patchPeerConnectionPaths();
  patchTrackConstraints();

  if (navigator.mediaDevices?.getUserMedia) {
    state.origMD = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => wrapped(state.origMD, constraints, navigator.mediaDevices);
  }

  if (navigator.getUserMedia) {
    state.origLegacy = navigator.getUserMedia.bind(navigator);
    navigator.getUserMedia = (constraints, ok, fail) => {
      wrapped(state.origLegacy, constraints, navigator).then(ok).catch((err) => fail && fail(err));
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== MSG_CFG) return;
    state.config = cfg(event.data.payload);
    updateAllPipelines(state.config);
    scheduleRecoveryPasses();
  });

  ['focus', 'pageshow', 'online', 'pointerdown', 'touchstart'].forEach((type) => {
    window.addEventListener(type, scheduleRecoveryPasses, { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRecoveryPasses();
  });

  setInterval(() => {
    enforceAllSourceConstraints();
    resumeAllPipelines();
    reconcileLiveSenders();
  }, cfg().senderRefreshMs);
  window.postMessage({ type: 'MIC_MAXIMIZER_READY' }, '*');
})();
