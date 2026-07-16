"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RhythmAnalyzer,
  ChartGenerator,
  DIFFICULTY_PRESETS,
  PATTERN_TYPES,
} = require("../rhythm-algorithms.js");

function createPulseBuffer({
  bpm = 120,
  duration = 24,
  offset = 0.25,
  sampleRate = 11025,
} = {}) {
  const samples = new Float32Array(Math.floor(sampleRate * duration));
  const beat = 60 / bpm;
  for (let time = offset; time < duration; time += beat) {
    const amplitude = time < duration / 2 ? 0.9 : 0.25;
    const start = Math.floor(time * sampleRate);
    const pulseLength = Math.floor(sampleRate * 0.07);
    for (let index = 0; index < pulseLength && start + index < samples.length; index += 1) {
      const envelope = Math.exp(-index / (sampleRate * 0.018));
      samples[start + index] += amplitude * envelope * (
        Math.sin(2 * Math.PI * 110 * index / sampleRate) * 0.65
        + Math.sin(2 * Math.PI * 1600 * index / sampleRate) * 0.35
      );
    }
  }
  return {
    sampleRate,
    length: samples.length,
    duration,
    numberOfChannels: 1,
    getChannelData() {
      return samples;
    },
  };
}

function createChartAnalysis() {
  const bpm = 120;
  const beat = 60 / bpm;
  const phraseDuration = beat * 16;
  const phraseCount = 6;
  const offset = 0.25;
  const phrases = Array.from({ length: phraseCount }, (_, index) => ({
    index,
    start: offset + index * phraseDuration,
    end: offset + (index + 1) * phraseDuration,
    duration: phraseDuration,
    energy: 1,
    onsetCount: 16,
    signature: new Float32Array(256),
    repeatGroupId: index < 2 || index >= 4 ? "repeat-1" : null,
    prototypePhraseIndex: index >= 4 ? index - 4 : index,
  }));
  const onsets = [];
  for (let phraseIndex = 0; phraseIndex < 4; phraseIndex += 1) {
    const phrase = phrases[phraseIndex];
    for (let slot = 1; slot <= 15; slot += 1) {
      const halfBeatStep = beat / 2;
      onsets.push({
        time: phrase.start + slot * halfBeatStep,
        strength: 0.45 + (slot % 4 === 0 ? 0.65 : (slot % 3) * 0.08),
        band: slot % 3,
        brightness: slot % 2 ? 0.08 : 0.18,
      });
    }
  }
  return {
    bpm,
    rawBpm: bpm,
    confidence: 90,
    beatOffset: offset,
    rhythmType: "四拍 / Straight",
    onsets,
    novelty: new Float32Array(1),
    fingerprint: "chart-fixture",
    frameRate: 43,
    duration: offset + phraseCount * phraseDuration,
    phrases,
    repeatGroups: [{
      id: "repeat-1",
      prototype: { startPhraseIndex: 0, length: 2 },
      members: [{ startPhraseIndex: 4, length: 2, similarity: 0.97 }],
      similarity: 0.97,
    }],
  };
}

function groupByTime(notes) {
  const groups = new Map();
  for (const note of notes) {
    const key = Math.round(note.time * 1000);
    const group = groups.get(key) || [];
    group.push(note);
    groups.set(key, group);
  }
  return [...groups.values()].sort((first, second) => first[0].time - second[0].time);
}

function getMaxJack(notes) {
  let previous = -1;
  let run = 0;
  let maximum = 0;
  for (const group of groupByTime(notes)) {
    if (group.length !== 1) {
      previous = -1;
      run = 0;
      continue;
    }
    run = group[0].lane === previous ? run + 1 : 1;
    previous = group[0].lane;
    maximum = Math.max(maximum, run);
  }
  return maximum;
}

test("exports four difficulty presets and five chart patterns with chords disabled", () => {
  assert.deepEqual(Object.keys(DIFFICULTY_PRESETS), ["easy", "normal", "hard", "expert"]);
  assert.deepEqual(Object.keys(PATTERN_TYPES), ["alternating", "jack", "chord", "stair", "anchor"]);
  for (const preset of Object.values(DIFFICULTY_PRESETS)) {
    assert.equal(preset.weights.chord, 0);
    assert.equal(preset.chordRate, 0);
  }
});

test("detects a 120 BPM pulse train across a large local loudness change", () => {
  const analyzer = new RhythmAnalyzer();
  const result = analyzer.analyze(createPulseBuffer());
  assert.ok(Math.abs(result.bpm - 120) <= 2, `detected ${result.bpm} BPM`);
  assert.ok(result.onsets.length >= 40);
  assert.ok(result.fingerprint.length === 8);
  assert.ok(result.beatGrid.length > 40);
  assert.ok(result.phrases.length >= 2);

  const retimed = analyzer.retime(result, 128);
  assert.equal(retimed.bpm, 128);
  assert.notDeepEqual(retimed.beatGrid, result.beatGrid);
  assert.equal(retimed.fingerprint, result.fingerprint);
});

test("groups an A-B-A phrase layout and keeps the earliest phrase as prototype", () => {
  const analyzer = new RhythmAnalyzer();
  const signatureA = new Float32Array(256);
  const signatureB = new Float32Array(256);
  for (let index = 0; index < 64; index += 8) {
    signatureA[index] = 1;
    signatureA[192 + index] = 0.8;
    signatureB[64 + index + 2] = 1;
    signatureB[192 + index + 2] = 0.8;
  }
  const phrases = [
    { index: 0, energy: 1, signature: signatureA },
    { index: 1, energy: 1, signature: signatureB },
    { index: 2, energy: 0.96, signature: Float32Array.from(signatureA, (value) => value * 0.98) },
  ];
  const groups = analyzer.detectRepeatGroups(phrases);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].prototype, { startPhraseIndex: 0, length: 1 });
  assert.equal(groups[0].members[0].startPhraseIndex, 2);
  assert.equal(phrases[2].prototypePhraseIndex, 0);
});

test("same song, settings and seed produce an identical chart", () => {
  const generator = new ChartGenerator();
  const analysis = createChartAnalysis();
  const settings = {
    difficulty: "normal",
    density: 0.8,
    weights: DIFFICULTY_PRESETS.normal.weights,
    seed: "DOG-001",
  };
  const first = generator.generate(analysis, settings);
  const second = generator.generate(analysis, settings);
  assert.deepEqual(second, first);

  const changed = generator.generate(analysis, { ...settings, seed: "DOG-002" });
  assert.notDeepEqual(changed.notes, first.notes);
  assert.notEqual(changed.effectiveSeed, first.effectiveSeed);
});

test("repeated phrases reuse relative timing and one whole-lane permutation", () => {
  const generator = new ChartGenerator();
  const result = generator.generate(createChartAnalysis(), {
    difficulty: "hard",
    density: 0.9,
    weights: DIFFICULTY_PRESETS.hard.weights,
    seed: "REPEAT-A",
  });
  const prototype = result.notes.filter((note) => note.phraseIndex === 0);
  const repeated = result.notes.filter((note) => note.phraseIndex === 4);
  const phraseStarts = [0.25, 32.25];
  assert.deepEqual(
    repeated.map((note) => Math.round((note.time - phraseStarts[1]) * 1000)),
    prototype.map((note) => Math.round((note.time - phraseStarts[0]) * 1000)),
  );
  assert.deepEqual(repeated.map((note) => note.pattern), prototype.map((note) => note.pattern));

  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const prototypeGroups = groupByTime(prototype);
  const repeatedGroups = groupByTime(repeated);
  const hasWholePhrasePermutation = permutations.some((permutation) => (
    prototypeGroups.every((group, index) => {
      const mapped = group.map((note) => permutation[note.lane]).sort();
      const target = repeatedGroups[index].map((note) => note.lane).sort();
      return mapped.length === target.length && mapped.every((lane, laneIndex) => lane === target[laneIndex]);
    })
  ));
  assert.ok(hasWholePhrasePermutation);
});

for (const [difficulty, preset] of Object.entries(DIFFICULTY_PRESETS)) {
  test(`${difficulty} charts remain single-note and respect jack and lane-balance limits`, () => {
    const generator = new ChartGenerator();
    const result = generator.generate(createChartAnalysis(), {
      difficulty,
      density: 1,
      weights: preset.weights,
      seed: `LIMIT-${difficulty}`,
    });
    const groups = groupByTime(result.notes);
    assert.ok(groups.every((group) => group.length === 1));
    const chordCount = groups.filter((group) => group.length === 2).length;
    assert.equal(chordCount, 0);
    assert.equal(result.chordCount, 0);
    assert.ok(getMaxJack(result.notes) <= preset.maxJack);

    if (result.notes.length >= 24) {
      const maximum = Math.max(...result.laneCounts);
      const minimum = Math.min(...result.laneCounts);
      assert.ok(maximum / result.notes.length <= 0.4 + 1e-9);
      assert.ok(maximum - minimum <= Math.max(2, Math.ceil(result.notes.length * 0.08)));
    }

    const uniqueTimes = groups.map((group) => group[0].time);
    const expectedGrid = (60 / 120) / preset.subdivision;
    for (let index = 1; index < uniqueTimes.length; index += 1) {
      assert.ok(uniqueTimes[index] - uniqueTimes[index - 1] >= expectedGrid - 0.002);
    }
  });
}

test("non-zero chord input is ignored and never creates simultaneous notes", () => {
  const generator = new ChartGenerator();
  const result = generator.generate(createChartAnalysis(), {
    difficulty: "expert",
    density: 1,
    weights: { alternating: 0, jack: 0, chord: 100, stair: 0, anchor: 0 },
    seed: "NO-CHORDS",
  });
  assert.equal(result.weights.chord, 0);
  assert.equal(result.chordCount, 0);
  assert.ok(groupByTime(result.notes).every((group) => group.length === 1));
});

test("300 percent density adds grid-supported notes without creating chords", () => {
  const generator = new ChartGenerator();
  const analysis = createChartAnalysis();
  const baseSettings = {
    difficulty: "hard",
    weights: DIFFICULTY_PRESETS.hard.weights,
    seed: "DENSITY",
  };
  const defaultDensity = generator.generate(analysis, { ...baseSettings, density: 0.8 });
  const maximumDensity = generator.generate(analysis, { ...baseSettings, density: 3 });
  assert.equal(maximumDensity.density, 3);
  assert.ok(maximumDensity.notes.length > defaultDensity.notes.length);
  assert.ok(groupByTime(maximumDensity.notes).every((group) => group.length === 1));
});

test("all-zero custom weights fall back to alternating patterns", () => {
  const generator = new ChartGenerator();
  const result = generator.generate(createChartAnalysis(), {
    difficulty: "normal",
    density: 0.7,
    weights: { alternating: 0, jack: 0, chord: 0, stair: 0, anchor: 0 },
    seed: "ZERO",
  });
  assert.ok(result.patternCounts.alternating > 0);
  assert.equal(result.patternCounts.jack, 0);
  assert.equal(result.patternCounts.chord, 0);
  assert.equal(result.patternCounts.stair, 0);
  assert.equal(result.patternCounts.anchor, 0);
});
