/**
 * DA DOG TAP rhythm analysis and deterministic 3-key chart generation.
 *
 * The module has no runtime dependencies. It is exposed as
 * `window.DaDogAlgorithms` in browsers and through `module.exports` in Node.
 */
(function createDaDogAlgorithms(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DaDogAlgorithms = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const ALGORITHM_VERSION = "2.0.0";
  const PATTERN_TYPES = Object.freeze({
    alternating: "交互",
    jack: "纵连",
    chord: "双压",
    stair: "楼梯",
    anchor: "锚点",
  });
  const PATTERN_KEYS = Object.freeze(Object.keys(PATTERN_TYPES));

  const DIFFICULTY_PRESETS = Object.freeze({
    easy: Object.freeze({
      label: "简单",
      weights: Object.freeze({ alternating: 50, jack: 10, chord: 0, stair: 28, anchor: 8 }),
      subdivision: 2,
      tripletSubdivision: 3,
      maxJack: 2,
      chordRate: 0,
    }),
    normal: Object.freeze({
      label: "普通",
      weights: Object.freeze({ alternating: 36, jack: 20, chord: 0, stair: 22, anchor: 12 }),
      subdivision: 2,
      tripletSubdivision: 3,
      maxJack: 3,
      chordRate: 0,
    }),
    hard: Object.freeze({
      label: "困难",
      weights: Object.freeze({ alternating: 26, jack: 24, chord: 0, stair: 17, anchor: 15 }),
      subdivision: 4,
      tripletSubdivision: 6,
      maxJack: 4,
      chordRate: 0,
    }),
    expert: Object.freeze({
      label: "专家",
      weights: Object.freeze({ alternating: 20, jack: 24, chord: 0, stair: 14, anchor: 18 }),
      subdivision: 4,
      tripletSubdivision: 6,
      maxJack: 5,
      chordRate: 0,
    }),
  });

  const LANE_PERMUTATIONS = Object.freeze([
    Object.freeze([0, 1, 2]),
    Object.freeze([0, 2, 1]),
    Object.freeze([1, 0, 2]),
    Object.freeze([1, 2, 0]),
    Object.freeze([2, 0, 1]),
    Object.freeze([2, 1, 0]),
  ]);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const roundTime = (value) => Math.round(value * 1000) / 1000;

  function hashString(value) {
    const text = String(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function hashHex(value) {
    return hashString(value).toString(16).padStart(8, "0");
  }

  function createRandom(seedText) {
    let state = hashString(seedText) || 0x6d2b79f5;
    return () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sum(values) {
    let total = 0;
    for (const value of values) total += value;
    return total;
  }

  function mean(values) {
    return values.length ? sum(values) / values.length : 0;
  }

  function cosineSimilarity(first, second) {
    if (!first?.length || first.length !== second?.length) return 0;
    let product = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = 0; index < first.length; index += 1) {
      product += first[index] * second[index];
      energyA += first[index] * first[index];
      energyB += second[index] * second[index];
    }
    if (energyA < 1e-9 || energyB < 1e-9) return 0;
    return product / Math.sqrt(energyA * energyB);
  }

  function normalizeSignatureChannel(signature, offset, length) {
    let energy = 0;
    for (let index = offset; index < offset + length; index += 1) {
      energy += signature[index] * signature[index];
    }
    const scale = energy > 1e-9 ? 1 / Math.sqrt(energy) : 1;
    for (let index = offset; index < offset + length; index += 1) {
      signature[index] *= scale;
    }
  }

  function buildFingerprint(samples, sampleRate, channelCount) {
    const sampleCount = Math.min(8192, samples.length);
    const step = samples.length / Math.max(1, sampleCount);
    let fingerprint = `${samples.length}:${sampleRate}:${channelCount}`;
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = samples[Math.min(samples.length - 1, Math.floor(index * step))] || 0;
      fingerprint += `:${Math.round(clamp(sample, -1, 1) * 32767)}`;
    }
    return hashHex(fingerprint);
  }

  class RhythmAnalyzer {
    constructor(options = {}) {
      this.targetRate = options.targetRate || 11025;
      this.minBpm = options.minBpm || 55;
      this.maxBpm = options.maxBpm || 210;
      this.frameSize = options.frameSize || 1024;
      this.hopSize = options.hopSize || 256;
      this.repeatSimilarity = options.repeatSimilarity || 0.88;
    }

    analyze(buffer) {
      const mono = this.downmixAndResample(buffer);
      const fingerprint = buildFingerprint(mono, this.targetRate, buffer.numberOfChannels || 1);
      const featureCurves = this.extractFeatures(mono);
      const novelty = this.createNoveltyCurve(featureCurves);
      const onsets = this.pickOnsets(novelty, featureCurves);
      const tempo = this.estimateTempo(novelty);
      const beatOffset = this.estimateBeatOffset(novelty, tempo.bpm, featureCurves);
      const rhythmType = this.classifyRhythm(onsets, tempo.bpm, beatOffset);
      const analysis = {
        bpm: tempo.bpm,
        rawBpm: tempo.rawBpm,
        confidence: tempo.confidence,
        beatOffset,
        rhythmType,
        onsets,
        novelty,
        featureCurves,
        fingerprint,
        frameRate: this.targetRate / this.hopSize,
        duration: buffer.duration,
      };
      return this.buildTimingData(analysis);
    }

    retime(analysis, bpm) {
      if (!analysis) throw new Error("缺少待重算的节奏分析结果。");
      const nextBpm = clamp(Math.round(Number(bpm) || analysis.bpm), 40, 260);
      const beatOffset = this.estimateBeatOffset(
        analysis.novelty,
        nextBpm,
        analysis.featureCurves,
      );
      return this.buildTimingData({
        ...analysis,
        bpm: nextBpm,
        beatOffset,
        rhythmType: this.classifyRhythm(analysis.onsets, nextBpm, beatOffset),
      });
    }

    downmixAndResample(buffer) {
      const sourceRate = buffer.sampleRate || this.targetRate;
      const ratio = sourceRate / this.targetRate;
      const outputLength = Math.max(1, Math.floor(buffer.length / ratio));
      const output = new Float32Array(outputLength);
      const channelCount = Math.max(1, buffer.numberOfChannels || 1);
      const channels = Array.from(
        { length: channelCount },
        (_, index) => buffer.getChannelData(index),
      );

      for (let index = 0; index < outputLength; index += 1) {
        const sourcePosition = index * ratio;
        const left = Math.floor(sourcePosition);
        const right = Math.min(left + 1, buffer.length - 1);
        const fraction = sourcePosition - left;
        let value = 0;
        for (const channel of channels) {
          value += channel[left] + (channel[right] - channel[left]) * fraction;
        }
        output[index] = value / channelCount;
      }
      return output;
    }

    extractFeatures(samples) {
      const frameCount = Math.max(0, Math.floor((samples.length - this.frameSize) / this.hopSize) + 1);
      const rawLow = new Float32Array(frameCount);
      const rawMid = new Float32Array(frameCount);
      const rawHigh = new Float32Array(frameCount);
      const zeroCrossings = new Float32Array(frameCount);

      const lowCoefficient = 1 - Math.exp(-2 * Math.PI * 180 / this.targetRate);
      const midCoefficient = 1 - Math.exp(-2 * Math.PI * 2400 / this.targetRate);
      let lowPass = 0;
      let midPass = 0;
      const lowSignal = new Float32Array(samples.length);
      const midSignal = new Float32Array(samples.length);
      const highSignal = new Float32Array(samples.length);

      for (let index = 0; index < samples.length; index += 1) {
        lowPass += lowCoefficient * (samples[index] - lowPass);
        midPass += midCoefficient * (samples[index] - midPass);
        lowSignal[index] = lowPass;
        midSignal[index] = midPass - lowPass;
        highSignal[index] = samples[index] - midPass;
      }

      for (let frame = 0; frame < frameCount; frame += 1) {
        const start = frame * this.hopSize;
        let lowEnergy = 0;
        let midEnergy = 0;
        let highEnergy = 0;
        let crossings = 0;
        let previous = samples[start] || 0;
        for (let index = start; index < start + this.frameSize; index += 1) {
          lowEnergy += lowSignal[index] * lowSignal[index];
          midEnergy += midSignal[index] * midSignal[index];
          highEnergy += highSignal[index] * highSignal[index];
          if ((samples[index] >= 0) !== (previous >= 0)) crossings += 1;
          previous = samples[index];
        }
        rawLow[frame] = Math.log1p(Math.sqrt(lowEnergy / this.frameSize) * 90);
        rawMid[frame] = Math.log1p(Math.sqrt(midEnergy / this.frameSize) * 105);
        rawHigh[frame] = Math.log1p(Math.sqrt(highEnergy / this.frameSize) * 125);
        zeroCrossings[frame] = crossings / this.frameSize;
      }

      const low = this.normalizeFeatureCurve(rawLow);
      const mid = this.normalizeFeatureCurve(rawMid);
      const high = this.normalizeFeatureCurve(rawHigh);
      const total = new Float32Array(frameCount);
      for (let frame = 0; frame < frameCount; frame += 1) {
        total[frame] = low[frame] * 0.95 + mid[frame] + high[frame] * 0.72;
      }
      return { total, low, mid, high, zeroCrossings };
    }

    normalizeFeatureCurve(curve) {
      const normalized = new Float32Array(curve.length);
      if (!curve.length) return normalized;
      const prefix = new Float64Array(curve.length + 1);
      for (let index = 0; index < curve.length; index += 1) {
        prefix[index + 1] = prefix[index] + curve[index];
      }
      const globalMean = prefix[curve.length] / curve.length;
      const radius = 28;
      for (let index = 0; index < curve.length; index += 1) {
        const start = Math.max(0, index - radius);
        const end = Math.min(curve.length, index + radius + 1);
        const localMean = (prefix[end] - prefix[start]) / Math.max(1, end - start);
        const reference = globalMean * 0.28 + localMean * 0.72;
        if (curve[index] < globalMean * 0.012) {
          normalized[index] = 0;
        } else {
          normalized[index] = clamp(curve[index] / Math.max(0.015, reference), 0, 4);
        }
      }
      return normalized;
    }

    createNoveltyCurve(features) {
      const length = features.total.length;
      const novelty = new Float32Array(length);
      for (let index = 2; index < length; index += 1) {
        const lowFlux = Math.max(0, features.low[index] - features.low[index - 2]);
        const midFlux = Math.max(0, features.mid[index] - features.mid[index - 2]);
        const highFlux = Math.max(0, features.high[index] - features.high[index - 2]);
        novelty[index] = lowFlux * 1.18 + midFlux + highFlux * 0.76;
      }

      const smoothed = new Float32Array(length);
      for (let index = 2; index < length - 2; index += 1) {
        smoothed[index] = novelty[index - 2] * 0.08
          + novelty[index - 1] * 0.21
          + novelty[index] * 0.42
          + novelty[index + 1] * 0.21
          + novelty[index + 2] * 0.08;
      }
      return smoothed;
    }

    pickOnsets(novelty, features) {
      const onsets = [];
      const localRadius = 18;
      const frameSeconds = this.hopSize / this.targetRate;
      let lastPeak = -8;

      for (let index = localRadius; index < novelty.length - localRadius; index += 1) {
        let localMean = 0;
        let squareMean = 0;
        for (let cursor = index - localRadius; cursor <= index + localRadius; cursor += 1) {
          localMean += novelty[cursor];
          squareMean += novelty[cursor] * novelty[cursor];
        }
        const count = localRadius * 2 + 1;
        localMean /= count;
        const deviation = Math.sqrt(Math.max(0, squareMean / count - localMean * localMean));
        const threshold = localMean + deviation * 0.68 + 0.006;
        const isPeak = novelty[index] > threshold
          && novelty[index] >= novelty[index - 1]
          && novelty[index] > novelty[index + 1]
          && index - lastPeak >= 3;
        if (!isPeak) continue;

        const bandFlux = [
          Math.max(0, features.low[index] - features.low[Math.max(0, index - 2)]),
          Math.max(0, features.mid[index] - features.mid[Math.max(0, index - 2)]),
          Math.max(0, features.high[index] - features.high[Math.max(0, index - 2)]),
        ];
        const band = bandFlux.indexOf(Math.max(...bandFlux));
        onsets.push({
          time: index * frameSeconds,
          strength: novelty[index],
          band,
          brightness: features.zeroCrossings[index],
          lowAccent: features.low[index],
        });
        lastPeak = index;
      }

      const strengths = onsets.map((onset) => onset.strength).sort((a, b) => a - b);
      const normalization = strengths[Math.floor(strengths.length * 0.92)] || 1;
      for (const onset of onsets) {
        onset.strength = clamp(onset.strength / normalization, 0, 1.5);
        onset.lowAccent = clamp(onset.lowAccent / 2.5, 0, 1.5);
      }
      return onsets;
    }

    estimateTempo(novelty) {
      const frameRate = this.targetRate / this.hopSize;
      const centered = new Float32Array(novelty.length);
      const noveltyMean = mean(novelty);
      for (let index = 0; index < novelty.length; index += 1) {
        centered[index] = Math.max(0, novelty[index] - noveltyMean * 0.68);
      }

      const rawScores = [];
      for (let bpm = this.minBpm; bpm <= this.maxBpm; bpm += 1) {
        const lag = Math.max(1, Math.round(frameRate * 60 / bpm));
        let correlation = 0;
        let energyA = 0;
        let energyB = 0;
        for (let index = lag; index < centered.length; index += 1) {
          const first = centered[index];
          const second = centered[index - lag];
          correlation += first * second;
          energyA += first * first;
          energyB += second * second;
        }
        const normalized = correlation / Math.sqrt(Math.max(1e-9, energyA * energyB));
        rawScores.push({ bpm, rawScore: normalized });
      }

      const rawScoreFor = (bpm) => {
        if (bpm < this.minBpm || bpm > this.maxBpm) return 0;
        const candidate = rawScores[Math.round(bpm) - this.minBpm];
        return candidate?.rawScore || 0;
      };
      const scores = rawScores.map((candidate) => {
        const musicalPrior = Math.exp(-Math.pow((candidate.bpm - 122) / 92, 2));
        const octaveSupport = Math.max(
          rawScoreFor(candidate.bpm / 2) * 0.08,
          rawScoreFor(candidate.bpm * 2) * 0.12,
        );
        return {
          bpm: candidate.bpm,
          rawScore: candidate.rawScore,
          score: candidate.rawScore * (0.82 + musicalPrior * 0.18) + octaveSupport,
        };
      }).sort((a, b) => b.score - a.score);

      let winner = scores[0] || { bpm: 120, score: 0, rawScore: 0 };
      const octaveFamily = [winner.bpm / 2, winner.bpm, winner.bpm * 2]
        .map((bpm) => scores.find((candidate) => Math.abs(candidate.bpm - bpm) <= 1))
        .filter(Boolean)
        .filter((candidate) => candidate.rawScore >= winner.rawScore * 0.80);
      if (octaveFamily.length > 1) {
        octaveFamily.sort((first, second) => {
          const firstPrior = Math.exp(-Math.pow((first.bpm - 122) / 78, 2));
          const secondPrior = Math.exp(-Math.pow((second.bpm - 122) / 78, 2));
          return second.rawScore * (0.74 + secondPrior * 0.26)
            - first.rawScore * (0.74 + firstPrior * 0.26);
        });
        winner = octaveFamily[0];
      }

      const baseline = mean(scores.map((candidate) => candidate.score));
      const confidence = clamp(
        (winner.score - baseline) / Math.max(0.08, winner.score) * 100,
        18,
        98,
      );
      return {
        bpm: winner.bpm,
        rawBpm: scores[0]?.bpm || winner.bpm,
        confidence,
        scores,
      };
    }

    estimateBeatOffset(novelty, bpm, features = null) {
      const frameRate = this.targetRate / this.hopSize;
      const beatFrames = Math.max(1, Math.round(frameRate * 60 / bpm));
      let bestPhase = 0;
      let bestScore = -Infinity;
      for (let phase = 0; phase < beatFrames; phase += 1) {
        let score = 0;
        for (let index = phase; index < novelty.length; index += beatFrames) {
          score += novelty[index] * 1.35 + (features?.low[index] || 0) * 0.18;
          const halfBeat = index + Math.round(beatFrames / 2);
          if (halfBeat < novelty.length) score += novelty[halfBeat] * 0.16;
        }
        if (score > bestScore) {
          bestScore = score;
          bestPhase = phase;
        }
      }
      return bestPhase / frameRate;
    }

    classifyRhythm(onsets, bpm, beatOffset) {
      if (onsets.length < 5) return "稀疏 / Minimal";
      const beat = 60 / bpm;
      let straightError = 0;
      let tripletError = 0;
      let syncopated = 0;
      let swingPairs = 0;
      let pairCount = 0;

      for (const onset of onsets) {
        const phase = ((onset.time - beatOffset) % beat + beat) % beat / beat;
        const nearestStraight = Math.min(...[0, 0.25, 0.5, 0.75, 1]
          .map((grid) => Math.abs(phase - grid)));
        const nearestTriplet = Math.min(...[0, 1 / 3, 2 / 3, 1]
          .map((grid) => Math.abs(phase - grid)));
        straightError += nearestStraight;
        tripletError += nearestTriplet;
        if (nearestStraight > 0.08 && nearestTriplet > 0.08) syncopated += 1;
      }

      for (let index = 0; index < onsets.length - 2; index += 1) {
        const first = onsets[index + 1].time - onsets[index].time;
        const second = onsets[index + 2].time - onsets[index + 1].time;
        if (first + second > beat * 0.7 && first + second < beat * 1.3) {
          pairCount += 1;
          const ratio = Math.max(first, second) / Math.max(0.001, Math.min(first, second));
          if (ratio > 1.55 && ratio < 2.7) swingPairs += 1;
        }
      }

      if (pairCount > 4 && swingPairs / pairCount > 0.35) return "摇摆 / Swing";
      if (tripletError < straightError * 0.78) return "三连音 / Triplet";
      if (syncopated / onsets.length > 0.34) return "切分 / Syncopated";
      if (bpm >= 165) return "高速 / Double-time";
      if (bpm <= 76) return "慢拍 / Half-time";
      return "四拍 / Straight";
    }

    buildTimingData(analysis) {
      const beatSeconds = 60 / analysis.bpm;
      const beatGrid = [];
      for (
        let time = analysis.beatOffset, index = 0;
        time <= analysis.duration + beatSeconds * 0.25;
        time += beatSeconds, index += 1
      ) {
        if (time >= 0) beatGrid.push({ index, time: roundTime(time), downbeat: index % 4 === 0 });
      }
      const phrases = this.buildPhrases({ ...analysis, beatSeconds });
      const repeatGroups = this.detectRepeatGroups(phrases);
      return {
        ...analysis,
        beatGrid,
        phrases,
        repeatGroups,
      };
    }

    buildPhrases(analysis) {
      const phraseBeats = 16;
      const phraseDuration = analysis.beatSeconds * phraseBeats;
      const slotCount = 64;
      const slotDuration = phraseDuration / slotCount;
      const phrases = [];
      const frameRate = analysis.frameRate;
      const features = analysis.featureCurves;

      for (
        let start = analysis.beatOffset, index = 0;
        start < analysis.duration - analysis.beatSeconds;
        start += phraseDuration, index += 1
      ) {
        const end = Math.min(analysis.duration, start + phraseDuration);
        const signature = new Float32Array(slotCount * 4);
        let totalEnergy = 0;
        let energyFrames = 0;
        const firstFrame = Math.max(0, Math.floor(start * frameRate));
        const lastFrame = Math.min(features.total.length, Math.ceil(end * frameRate));

        for (let frame = firstFrame; frame < lastFrame; frame += 1) {
          const time = frame / frameRate;
          const slot = clamp(Math.floor((time - start) / slotDuration), 0, slotCount - 1);
          signature[slot] += features.low[frame];
          signature[slotCount + slot] += features.mid[frame];
          signature[slotCount * 2 + slot] += features.high[frame];
          totalEnergy += features.total[frame];
          energyFrames += 1;
        }

        const phraseOnsets = analysis.onsets.filter((onset) => onset.time >= start && onset.time < end);
        for (const onset of phraseOnsets) {
          const slot = clamp(Math.round((onset.time - start) / slotDuration), 0, slotCount - 1);
          signature[slotCount * 3 + slot] += onset.strength;
        }
        for (let channel = 0; channel < 4; channel += 1) {
          normalizeSignatureChannel(signature, channel * slotCount, slotCount);
        }

        phrases.push({
          index,
          start: roundTime(start),
          end: roundTime(end),
          duration: end - start,
          energy: energyFrames ? totalEnergy / energyFrames : 0,
          onsetCount: phraseOnsets.length,
          signature,
          repeatGroupId: null,
          prototypePhraseIndex: index,
        });
      }
      return phrases;
    }

    phraseSimilarity(first, second) {
      if (!first || !second) return 0;
      const energyRatio = Math.max(first.energy, second.energy)
        / Math.max(1e-6, Math.min(first.energy, second.energy));
      if (energyRatio > 1 / 0.65) return 0;
      return cosineSimilarity(first.signature, second.signature);
    }

    detectRepeatGroups(phrases) {
      for (const phrase of phrases) {
        phrase.repeatGroupId = null;
        phrase.prototypePhraseIndex = phrase.index;
      }
      const repeatGroups = [];
      const claimedMembers = new Set();

      for (let prototypeStart = 0; prototypeStart < phrases.length - 1; prototypeStart += 1) {
        if (claimedMembers.has(prototypeStart)) continue;
        const candidates = [];
        for (let memberStart = prototypeStart + 1; memberStart < phrases.length; memberStart += 1) {
          if (claimedMembers.has(memberStart)) continue;
          let length = 0;
          const similarities = [];
          while (
            prototypeStart + length < phrases.length
            && memberStart + length < phrases.length
            && prototypeStart + length < memberStart
          ) {
            const similarity = this.phraseSimilarity(
              phrases[prototypeStart + length],
              phrases[memberStart + length],
            );
            if (similarity < this.repeatSimilarity) break;
            similarities.push(similarity);
            length += 1;
          }
          if (length) candidates.push({ memberStart, length, similarities });
        }
        if (!candidates.length) continue;

        const longest = Math.max(...candidates.map((candidate) => candidate.length));
        const selected = [];
        let occupiedUntil = -1;
        for (const candidate of candidates) {
          if (candidate.length < longest || candidate.memberStart < occupiedUntil) continue;
          selected.push(candidate);
          occupiedUntil = candidate.memberStart + longest;
        }
        if (!selected.length) continue;

        const groupId = `repeat-${repeatGroups.length + 1}`;
        const members = selected.map((candidate) => {
          for (let offset = 0; offset < longest; offset += 1) {
            const phrase = phrases[candidate.memberStart + offset];
            phrase.repeatGroupId = groupId;
            phrase.prototypePhraseIndex = prototypeStart + offset;
            claimedMembers.add(candidate.memberStart + offset);
          }
          return {
            startPhraseIndex: candidate.memberStart,
            length: longest,
            similarity: mean(candidate.similarities.slice(0, longest)),
          };
        });
        for (let offset = 0; offset < longest; offset += 1) {
          phrases[prototypeStart + offset].repeatGroupId = groupId;
        }
        repeatGroups.push({
          id: groupId,
          prototype: { startPhraseIndex: prototypeStart, length: longest },
          members,
          similarity: mean(members.map((member) => member.similarity)),
        });
        prototypeStart += longest - 1;
      }
      return repeatGroups;
    }
  }

  function normalizeWeights(weights, fallback) {
    const normalized = {};
    for (const key of PATTERN_KEYS) {
      normalized[key] = clamp(Number(weights?.[key] ?? fallback[key]) || 0, 0, 100);
    }
    if (sum(Object.values(normalized)) <= 0) normalized.alternating = 100;
    return normalized;
  }

  function chooseWeighted(weights, random) {
    const total = sum(PATTERN_KEYS.map((key) => weights[key]));
    let cursor = random() * total;
    for (const key of PATTERN_KEYS) {
      cursor -= weights[key];
      if (cursor <= 0) return key;
    }
    return "alternating";
  }

  function countLanes(notes) {
    const counts = [0, 0, 0];
    for (const note of notes) counts[note.lane] += 1;
    return counts;
  }

  function applyPermutation(notes, permutation) {
    return notes.map((note) => ({ ...note, lane: permutation[note.lane] }));
  }

  function permutationScore(notes, permutation, currentCounts) {
    const nextCounts = [...currentCounts];
    for (const note of notes) nextCounts[permutation[note.lane]] += 1;
    const maximum = Math.max(...nextCounts);
    const minimum = Math.min(...nextCounts);
    return (maximum - minimum) * 10 + maximum * 0.15;
  }

  function chooseBalancedPermutation(notes, currentCounts, random) {
    const offset = Math.floor(random() * LANE_PERMUTATIONS.length);
    let best = LANE_PERMUTATIONS[offset];
    let bestScore = Infinity;
    for (let index = 0; index < LANE_PERMUTATIONS.length; index += 1) {
      const permutation = LANE_PERMUTATIONS[(index + offset) % LANE_PERMUTATIONS.length];
      const score = permutationScore(notes, permutation, currentCounts);
      if (score < bestScore - 1e-9) {
        best = permutation;
        bestScore = score;
      }
    }
    return best;
  }

  function groupNotesByTime(notes) {
    const groups = new Map();
    for (const note of notes) {
      const key = Math.round(note.time * 1000);
      const group = groups.get(key) || [];
      group.push(note);
      groups.set(key, group);
    }
    return [...groups.values()].sort((first, second) => first[0].time - second[0].time);
  }

  function maxJackLength(notes) {
    let lastLane = -1;
    let run = 0;
    let maximum = 0;
    for (const group of groupNotesByTime(notes)) {
      if (group.length !== 1) {
        lastLane = -1;
        run = 0;
        continue;
      }
      const lane = group[0].lane;
      run = lane === lastLane ? run + 1 : 1;
      lastLane = lane;
      maximum = Math.max(maximum, run);
    }
    return maximum;
  }

  class ChartGenerator {
    generate(analysis, settings = {}) {
      if (!analysis?.onsets || !Number.isFinite(analysis.bpm)) {
        throw new Error("谱面生成需要有效的节奏分析结果。");
      }
      const difficulty = DIFFICULTY_PRESETS[settings.difficulty]
        ? settings.difficulty
        : "normal";
      const preset = DIFFICULTY_PRESETS[difficulty];
      const density = clamp(Number(settings.density) || 0.8, 0.25, 3);
      const weights = normalizeWeights(settings.weights, preset.weights);
      // The current game mode is deliberately single-note only. Keep the
      // chord key in the public pattern interface for compatibility, but never
      // select or emit simultaneous notes.
      weights.chord = 0;
      if (sum(Object.values(weights)) <= 0) weights.alternating = 100;
      const userSeed = String(settings.seed || "DOG-001").trim() || "DOG-001";
      const seedMaterial = [
        ALGORITHM_VERSION,
        analysis.fingerprint || "no-fingerprint",
        Math.round(analysis.bpm * 1000),
        difficulty,
        Math.round(density * 1000),
        ...PATTERN_KEYS.map((key) => Math.round(weights[key] * 100)),
        userSeed,
      ].join("|");
      const effectiveSeed = hashHex(seedMaterial);
      const random = createRandom(seedMaterial);
      const triplet = /Triplet|Swing/.test(analysis.rhythmType || "");
      const subdivision = triplet ? preset.tripletSubdivision : preset.subdivision;
      const phrases = analysis.phrases?.length
        ? analysis.phrases
        : [{
          index: 0,
          start: analysis.beatOffset || 0,
          end: analysis.duration,
          duration: analysis.duration,
          prototypePhraseIndex: 0,
          repeatGroupId: null,
        }];
      const memberMap = this.buildRepeatMemberMap(analysis.repeatGroups || []);
      const templates = new Map();
      const transformCache = new Map();
      const notes = [];
      const laneCounts = [0, 0, 0];

      for (const phrase of phrases) {
        const member = memberMap.get(phrase.index);
        let templateNotes;
        let countsAlreadyApplied = false;
        if (member && templates.has(member.prototypePhraseIndex)) {
          const transformKey = `${member.groupId}:${member.memberStart}`;
          let permutation = transformCache.get(transformKey);
          if (!permutation) {
            const sourceNotes = [];
            for (let offset = 0; offset < member.length; offset += 1) {
              const sourceTemplate = templates.get(member.prototypeStart + offset) || [];
              sourceNotes.push(...sourceTemplate);
            }
            permutation = chooseBalancedPermutation(sourceNotes, laneCounts, random);
            transformCache.set(transformKey, permutation);
          }
          const sourceTemplate = templates.get(member.prototypePhraseIndex) || [];
          templateNotes = applyPermutation(sourceTemplate, permutation)
            .map((note) => ({
              ...note,
              sourcePhraseIndex: member.prototypePhraseIndex,
              repeatGroupId: member.groupId,
            }));
        } else {
          const events = this.buildPhraseSkeleton(
            analysis,
            phrase,
            density,
            subdivision,
          );
          templateNotes = this.applyPatterns(events, preset, weights, laneCounts, random);
          countsAlreadyApplied = true;
        }

        const unfilteredTemplateNotes = templateNotes;
        templateNotes = unfilteredTemplateNotes.filter((note) => {
          const absoluteTime = phrase.start + note.relativeTime;
          return absoluteTime >= 0.55 && absoluteTime <= analysis.duration - 0.25;
        });
        if (countsAlreadyApplied && templateNotes.length !== unfilteredTemplateNotes.length) {
          for (const note of unfilteredTemplateNotes) {
            if (!templateNotes.includes(note)) laneCounts[note.lane] -= 1;
          }
        }
        templates.set(phrase.index, templateNotes.map((note) => ({ ...note })));
        for (const templateNote of templateNotes) {
          const note = {
            ...templateNote,
            time: roundTime(phrase.start + templateNote.relativeTime),
            phraseIndex: phrase.index,
            sourcePhraseIndex: templateNote.sourcePhraseIndex ?? phrase.index,
            repeatGroupId: templateNote.repeatGroupId ?? phrase.repeatGroupId,
          };
          notes.push(note);
          if (!countsAlreadyApplied) laneCounts[note.lane] += 1;
        }
      }

      let finalNotes = notes
        .filter((note) => note.time >= 0.55 && note.time <= analysis.duration - 0.25)
        .sort((first, second) => first.time - second.time || first.lane - second.lane);
      finalNotes = this.enforceSingleNotes(finalNotes);
      this.enforceJackLimit(finalNotes, preset.maxJack);
      this.balanceLanes(finalNotes, preset.maxJack);
      this.enforceJackLimit(finalNotes, preset.maxJack);
      this.balanceLanes(finalNotes, preset.maxJack);
      finalNotes.sort((first, second) => first.time - second.time || first.lane - second.lane);

      const finalLaneCounts = countLanes(finalNotes);
      const timingGroups = groupNotesByTime(finalNotes);
      const chordCount = timingGroups.filter((group) => group.length === 2).length;
      const segmentSets = Object.fromEntries(PATTERN_KEYS.map((key) => [key, new Set()]));
      for (const note of finalNotes) {
        segmentSets[note.pattern]?.add(`${note.phraseIndex}:${note.chunkIndex}`);
      }
      const patternCounts = Object.fromEntries(
        PATTERN_KEYS.map((key) => [key, segmentSets[key].size]),
      );

      return {
        notes: finalNotes.map((note) => ({
          time: note.time,
          lane: note.lane,
          strength: note.strength,
          pattern: note.pattern,
          phraseIndex: note.phraseIndex,
          sourcePhraseIndex: note.sourcePhraseIndex,
          repeatGroupId: note.repeatGroupId,
          judged: false,
          hit: false,
        })),
        laneCounts: finalLaneCounts,
        patternCounts,
        repeatGroupCount: analysis.repeatGroups?.length || 0,
        chordCount,
        subdivision,
        difficulty,
        density,
        weights,
        userSeed,
        effectiveSeed,
        algorithmVersion: ALGORITHM_VERSION,
      };
    }

    buildRepeatMemberMap(repeatGroups) {
      const memberMap = new Map();
      for (const group of repeatGroups) {
        for (const member of group.members || []) {
          for (let offset = 0; offset < member.length; offset += 1) {
            memberMap.set(member.startPhraseIndex + offset, {
              groupId: group.id,
              memberStart: member.startPhraseIndex,
              prototypeStart: group.prototype.startPhraseIndex,
              prototypePhraseIndex: group.prototype.startPhraseIndex + offset,
              length: member.length,
            });
          }
        }
      }
      return memberMap;
    }

    buildPhraseSkeleton(analysis, phrase, density, subdivision) {
      const beatSeconds = 60 / analysis.bpm;
      const grid = beatSeconds / subdivision;
      const slots = new Map();
      for (const onset of analysis.onsets) {
        if (onset.time < phrase.start || onset.time >= phrase.end) continue;
        const slotIndex = Math.round((onset.time - phrase.start) / grid);
        const relativeTime = slotIndex * grid;
        if (relativeTime < -grid * 0.25 || phrase.start + relativeTime >= phrase.end) continue;
        const mainBeat = Math.abs(slotIndex % subdivision) === 0;
        const score = onset.strength + (mainBeat ? 0.20 : 0) + (onset.band === 0 ? 0.06 : 0);
        const previous = slots.get(slotIndex);
        if (!previous || score > previous.score) {
          slots.set(slotIndex, {
            relativeTime,
            strength: onset.strength,
            band: onset.band,
            brightness: onset.brightness,
            emphasis: mainBeat || onset.strength >= 0.82,
            score,
          });
        }
      }
      const observedSlots = [...slots.entries()];
      if (density > 1 && observedSlots.length >= 2) {
        const slotCount = Math.max(0, Math.floor((phrase.end - phrase.start) / grid));
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
          if (slots.has(slotIndex)) continue;
          let nearest = null;
          let nearestDistance = Infinity;
          for (const [observedIndex, event] of observedSlots) {
            const distance = Math.abs(observedIndex - slotIndex);
            if (distance < nearestDistance) {
              nearest = event;
              nearestDistance = distance;
            }
          }
          if (!nearest || nearestDistance > subdivision * 1.5) continue;
          const mainBeat = slotIndex % subdivision === 0;
          const halfBeat = subdivision >= 2 && slotIndex % subdivision === Math.floor(subdivision / 2);
          const proximity = Math.exp(-nearestDistance / Math.max(1, subdivision * 0.65));
          slots.set(slotIndex, {
            relativeTime: slotIndex * grid,
            strength: clamp(nearest.strength * (0.38 + proximity * 0.34), 0.22, 0.82),
            band: nearest.band,
            brightness: nearest.brightness,
            emphasis: mainBeat,
            score: nearest.score * proximity * 0.58 + (mainBeat ? 0.32 : halfBeat ? 0.16 : 0.04),
            synthesized: true,
          });
        }
      }
      const candidates = [...slots.values()];
      const baseCount = observedSlots.length;
      const targetCount = Math.min(
        candidates.length,
        Math.max(baseCount ? 1 : 0, Math.round(baseCount * (0.25 + density * 0.75))),
      );
      return candidates
        .sort((first, second) => second.score - first.score || first.relativeTime - second.relativeTime)
        .slice(0, targetCount)
        .sort((first, second) => first.relativeTime - second.relativeTime);
    }

    applyPatterns(events, preset, weights, laneCounts, random) {
      const notes = [];
      let cursor = 0;
      let chunkIndex = 0;
      while (cursor < events.length) {
        const remaining = events.length - cursor;
        const chunkLength = Math.min(remaining, 4 + Math.floor(random() * 5));
        const chunk = events.slice(cursor, cursor + chunkLength);
        const pattern = chooseWeighted(weights, random);
        const canonical = this.createCanonicalPattern(chunk, pattern, preset, random)
          .map((note) => ({ ...note, pattern, chunkIndex }));
        const permutation = chooseBalancedPermutation(canonical, laneCounts, random);
        const transformed = applyPermutation(canonical, permutation);
        for (const note of transformed) {
          notes.push(note);
          laneCounts[note.lane] += 1;
        }
        cursor += chunkLength;
        chunkIndex += 1;
      }
      return notes;
    }

    createCanonicalPattern(events, pattern, preset, random) {
      const lanes = [];
      if (pattern === "jack") {
        const runLength = Math.min(
          preset.maxJack,
          Math.max(2, 2 + Math.floor(random() * Math.max(1, preset.maxJack - 1))),
        );
        for (let index = 0; index < events.length; index += 1) {
          const block = Math.floor(index / runLength);
          lanes.push(block % 2 === 0 ? 0 : (block % 3 === 1 ? 1 : 2));
        }
      } else if (pattern === "stair") {
        const sequence = random() < 0.5 ? [0, 1, 2, 1] : [2, 1, 0, 1];
        for (let index = 0; index < events.length; index += 1) {
          lanes.push(sequence[index % sequence.length]);
        }
      } else if (pattern === "anchor") {
        const sequence = [0, 1, 0, 2];
        for (let index = 0; index < events.length; index += 1) {
          lanes.push(sequence[index % sequence.length]);
        }
      } else {
        const sequence = random() < 0.42 ? [0, 1, 2] : [0, 1];
        for (let index = 0; index < events.length; index += 1) {
          lanes.push(sequence[index % sequence.length]);
        }
      }

      const notes = events.map((event, index) => ({
        relativeTime: roundTime(event.relativeTime),
        lane: lanes[index],
        strength: event.strength,
      }));
      return notes.sort((first, second) => first.relativeTime - second.relativeTime || first.lane - second.lane);
    }

    enforceSingleNotes(notes) {
      const groups = groupNotesByTime(notes);
      const result = [];
      for (const group of groups) {
        group.sort((first, second) => second.strength - first.strength || first.lane - second.lane);
        result.push(group[0]);
      }
      return result.sort((first, second) => first.time - second.time || first.lane - second.lane);
    }

    enforceJackLimit(notes, maxJack) {
      let lastLane = -1;
      let run = 0;
      const counts = countLanes(notes);
      for (const group of groupNotesByTime(notes)) {
        if (group.length !== 1) {
          lastLane = -1;
          run = 0;
          continue;
        }
        const note = group[0];
        run = note.lane === lastLane ? run + 1 : 1;
        if (run > maxJack) {
          const replacement = [0, 1, 2]
            .filter((lane) => lane !== note.lane)
            .sort((first, second) => counts[first] - counts[second])[0];
          counts[note.lane] -= 1;
          note.lane = replacement;
          counts[note.lane] += 1;
          lastLane = note.lane;
          run = 1;
        } else {
          lastLane = note.lane;
        }
      }
    }

    balanceLanes(notes, maxJack) {
      if (notes.length < 3) return;
      const requiresStrictBalance = notes.length >= 24;
      const allowedDifference = requiresStrictBalance
        ? Math.max(2, Math.ceil(notes.length * 0.08))
        : Math.max(2, Math.ceil(notes.length * 0.20));
      const maxIterations = notes.length * 6;

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const counts = countLanes(notes);
        const sortedLanes = [0, 1, 2].sort((first, second) => counts[first] - counts[second]);
        const lowLane = sortedLanes[0];
        const highLane = sortedLanes[2];
        const difference = counts[highLane] - counts[lowLane];
        const share = counts[highLane] / notes.length;
        if (difference <= allowedDifference && (!requiresStrictBalance || share <= 0.4 + 1e-9)) break;

        const groups = groupNotesByTime(notes);
        let changed = false;
        for (const protectRepeats of [true, false]) {
          for (const preferSingle of [true, false]) {
            for (let groupIndex = groups.length - 1; groupIndex >= 0 && !changed; groupIndex -= 1) {
              const group = groups[groupIndex];
              if (preferSingle !== (group.length === 1)) continue;
              const candidate = group.find((note) => (
                note.lane === highLane
                && (!protectRepeats || !note.repeatGroupId)
              ));
              if (!candidate || group.some((note) => note !== candidate && note.lane === lowLane)) continue;
              const previousLane = candidate.lane;
              candidate.lane = lowLane;
              if (maxJackLength(notes) <= maxJack) {
                changed = true;
              } else {
                candidate.lane = previousLane;
              }
            }
            if (changed) break;
          }
          if (changed) break;
        }
        if (!changed) break;
      }
    }
  }

  return Object.freeze({
    ALGORITHM_VERSION,
    PATTERN_TYPES,
    DIFFICULTY_PRESETS,
    RhythmAnalyzer,
    ChartGenerator,
  });
}));
