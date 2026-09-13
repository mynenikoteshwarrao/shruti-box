const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Browser boundaries are faked so lifecycle races can be advanced deterministically.
// The application itself, event handlers and signal routing run unchanged.
function app({ storageError = false, resumeError = false, resumePending = false } = {}) {
  let now = 0, nextTimer = 1;
  const timers = new Map(), contexts = [], storage = new Map(), resumes = [];
  const schedule = (fn, delay = 0, interval = false) => {
    const id = nextTimer++;
    timers.set(id, { fn, at: now + delay, interval: interval && delay });
    return id;
  };
  const canvas = new Proxy({}, { get: (_, key) => key === 'createRadialGradient'
    ? () => ({ addColorStop() {} }) : () => {} });
  function element(tagName = 'DIV') {
    const events = {}, classes = new Set();
    return {
      tagName, dataset: {}, style: {}, children: [], textContent: '', value: '',
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force) { const on = force ?? !classes.has(name); on ? classes.add(name) : classes.delete(name); },
      },
      set innerHTML(value) { this.children = []; this.markup = value; },
      get innerHTML() { return this.markup || ''; },
      addEventListener(name, fn) { (events[name] ||= []).push(fn); },
      async dispatch(name, extra = {}) {
        for (const fn of events[name] || []) await fn({ target: this, preventDefault() {}, ...extra });
      },
      click() { return this.dispatch('click'); },
      appendChild(child) { this.children.push(child); },
      setAttribute(name, value) { this[name] = value; },
      getBoundingClientRect: () => ({ width: 400, height: 280 }),
      getContext: () => canvas,
    };
  }
  const els = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
  for (const match of html.matchAll(/<button[^>]*data-(mode|tala)="([^"]+)"/g)) {
    const button = element('BUTTON');
    button.dataset[match[1]] = match[2];
    els.set(match[2], button);
  }
  const document = element('DOCUMENT');
  document.getElementById = id => els.get(id);
  document.createElement = tag => element(tag.toUpperCase());
  document.querySelectorAll = selector => selector === '.sstrip-note' ? els.get('sstrip').children
    : [...els.values()].filter(el => selector === '.mbtn' ? el.dataset.mode : el.dataset.tala);
  document.querySelector = selector => selector === '.presets' ? element() : null;

  class Param {
    constructor(owner, value = 0) { this.owner = owner; this.value = value; this.inputs = []; }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    exponentialRampToValueAtTime(value) { this.rampStartValue = this.value; this.value = value; }
    cancelScheduledValues() {}
    cancelAndHoldAtTime() {}
    sample(at) { return this.value + this.inputs.reduce((sum, input) => sum + input.sample(at), 0); }
  }
  class Node {
    constructor(context, kind) {
      this.context = context; this.kind = kind; this.inputs = []; this.outputs = [];
      this.gain = new Param(this, 1); this.frequency = new Param(this, 440);
      this.delayTime = new Param(this, 0); this.Q = new Param(this, 1);
      context.nodes.push(this);
    }
    connect(target) { target.inputs.push(this); this.outputs.push(target); return target; }
    disconnect() {
      for (const output of this.outputs) output.inputs = output.inputs.filter(node => node !== this);
      this.outputs = [];
    }
    start(at = this.context.currentTime, offset = 0) { this.started = true; this.startAt = at; this.offset = offset; }
    stop(at = this.context.currentTime) {
      schedule(() => { this.stopped = true; this.onended?.(); }, Math.max(0, at * 1000 - now));
    }
    sample(at = now / 1000) {
      if (this.kind === 'oscillator' || this.kind === 'buffer') {
        if (!this.started || this.stopped || at < this.startAt) return 0;
        if (this.kind === 'oscillator') return Math.sin(2 * Math.PI * this.frequency.value * (at - this.startAt));
        const index = Math.floor((at - this.startAt + this.offset) * this.buffer.sampleRate) % this.buffer.length;
        return this.buffer.getChannelData(0)[index];
      }
      const inputTime = this.kind === 'delay' ? at - this.delayTime.value : at;
      return this.inputs.reduce((sum, input) => sum + input.sample(inputTime), 0) * this.gain.sample(at);
    }
  }
  class AudioContext {
    constructor() { this.state = 'suspended'; this.nodes = []; this.destination = new Node(this, 'destination'); contexts.push(this); }
    get currentTime() { return now / 1000; }
    async resume() {
      if (resumeError) throw new Error('Audio output unavailable');
      if (resumePending) await new Promise((resolve, reject) => resumes.push({ resolve, reject }));
      this.state = 'running';
    }
    createGain() { return new Node(this, 'gain'); }
    createOscillator() { return new Node(this, 'oscillator'); }
    createDelay() { return new Node(this, 'delay'); }
    createBiquadFilter() { return new Node(this, 'filter'); }
    createBufferSource() { return new Node(this, 'buffer'); }
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    }
  }
  const window = element('WINDOW');
  Object.assign(window, { AudioContext, devicePixelRatio: 1 });
  const sandbox = vm.createContext({
    window, document, navigator: {}, console, setTimeout: schedule,
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), requestAnimationFrame() {},
    localStorage: {
      getItem(key) { if (storageError) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageError) throw new Error('Storage blocked'); storage.set(key, value); },
    },
  });
  vm.runInContext(script, sandbox);
  return {
    els, contexts, storage, document, window,
    resolveResume: index => resumes[index].resolve(),
    rejectResume: index => resumes[index].reject(new Error('Earlier resume failed')),
    state: () => JSON.parse(vm.runInContext('JSON.stringify(S)', sandbox)),
    run: code => vm.runInContext(code, sandbox),
    click: id => els.get(id).click(),
    instrument(value) {
      const selector = els.get('instrumentSelect');
      assert.ok(selector, 'a labeled instrument selector is available');
      selector.value = value;
      return selector.dispatch('change');
    },
    async advance(milliseconds) {
      await Promise.resolve(); await Promise.resolve();
      const until = now + milliseconds;
      while (true) {
        const pending = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending) break;
        const [id, timer] = pending;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        await timer.fn();
      }
      now = until;
    },
    voices: () => contexts.flatMap(context => context.nodes).filter(node => node.kind === 'oscillator' && node.started && !node.stopped),
    sources: () => contexts.flatMap(context => context.nodes).filter(node => ['oscillator', 'buffer'].includes(node.kind) && node.started && !node.stopped),
    connectedNodes: () => contexts.flatMap(context => context.nodes).filter(node => node.outputs.length),
    output: () => contexts.reduce((sum, context) => sum + context.destination.sample(), 0),
  };
}

test('instrument can be selected before power without starting audio', async () => {
  const a = app();
  await a.instrument('shruti-box');
  assert.equal(a.state().instrument, 'shruti-box');
  assert.equal(a.contexts.length, 0);
  await a.click('pwrBtn');
  await a.advance(800);
  assert.equal(a.state().on, true);
  assert.equal(a.sources().some(source => source.kind === 'buffer'), true, 'multi-note reed profiles follow the note sequence');
});

test('Soft Sine has only the selected clean note frequencies, without detune or effects', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.click('SA-MA-SA');
  await a.instrument('soft-sine');
  await a.advance(800);
  assert.deepEqual(a.voices().map(voice => voice.frequency.value).sort((x, y) => x - y), [261.63, 348.84, 523.26]);
  assert.equal(a.sources().length, 6, 'three clean tones and three note envelopes');
  assert.equal(a.connectedNodes().some(node => ['filter', 'delay'].includes(node.kind)), false);
});

for (const instrument of ['tanpura', 'shruti-box', 'harmonium', 'soft-sine']) {
  for (const [mode, notes] of [['SA-PA-SA', ['sa', 'pa', 'su']], ['SA-MA-SA', ['sa', 'ma', 'su']], ['SA-SA', ['sa', 'su']]]) {
    test(`${instrument} ${mode} keeps a smooth continuous blend with rotating emphasis`, async () => {
      const a = app();
      await a.instrument(instrument);
      await a.click('pwrBtn');
      await a.click(mode);
      await a.advance(0);
      const start = a.run('drone.start');
      let elapsed = 0;
      for (let slot = 0; slot < notes.length * 2; slot++) {
        for (const phase of [0, 0.001, 0.1, 0.25, 0.5, 0.7, 0.75, 0.85, 0.99]) {
          const at = (start + slot + phase) * 1000;
          await a.advance(at - elapsed); elapsed = at;
          const levels = notes.map(note => a.run(`drone.notes.${note}.gain.sample()`));
          assert.ok(levels.every(level => level >= 0.199 && level <= 1.0001), 'every note sustains quietly throughout each handoff');
          assert.ok(Math.abs(levels.reduce((sum, level) => sum + level, 0) - (0.8 + notes.length * 0.2)) < 0.001,
            'complementary gains keep the blend level steady at transitions and loop wrap');
          if (phase === 0.5 || phase === 0.7) {
            const lead = slot % notes.length;
            assert.ok(levels[lead] > 4.5 * Math.max(...levels.filter((_, i) => i !== lead)), 'the emphasized note remains distinct');
          }
        }
      }
      const curve = a.sources().find(source => source.kind === 'buffer').buffer.getChannelData(0);
      for (let i = 0; i < curve.length; i++) {
        assert.ok(Math.abs(curve[i] - curve[(i + 1) % curve.length]) < 0.0005, 'the audio envelope stays smooth, including its loop seam');
      }
    });
  }
  test(`${instrument} SA-FINE remains a continuous single pitch`, async () => {
    const a = app();
    await a.instrument(instrument);
    await a.click('pwrBtn');
    await a.click('SA-FINE');
    await a.advance(5200);
    assert.equal(a.sources().some(source => source.kind === 'buffer'), false);
    assert.equal(a.run('drone.notes.sa.gain.sample()'), 1);
  });
}

test('visualization follows the emphasized relative note without showing gaps in the blend', async () => {
  const a = app();
  await a.instrument('harmonium');
  await a.click('pwrBtn');
  await a.els.get('sstrip').children[7].click();
  await a.advance(620);
  a.run('animate()');
  assert.equal(a.els.get('vizSwara').textContent, 'Sa');
  assert.equal(a.els.get('vizNote').textContent, 'G');
  assert.match(a.els.get('vizMode').textContent, /BLEND/);
  await a.advance(1000); a.run('animate()');
  assert.equal(a.els.get('vizSwara').textContent, 'Pa');
  assert.equal(a.els.get('vizNote').textContent, 'D');
  assert.equal(a.els.get('vizFreq').textContent, '588.00 Hz');
  await a.advance(1000); a.run('animate()');
  assert.equal(a.els.get('vizSwara').textContent, 'Sā');
  assert.equal(a.els.get('vizFreq').textContent, '784.00 Hz');
  await a.advance(300); a.run('animate()');
  assert.equal(a.els.get('vizSwara').textContent, 'Sā');
  await a.advance(200); a.run('animate()');
  assert.equal(a.els.get('vizSwara').textContent, 'Sa');
  await a.click('muteBtn');
  assert.equal(a.els.get('vizSwara').textContent, 'Muted');
  await a.click('muteBtn'); a.run("ctx.state = 'suspended'; animate()");
  assert.equal(a.els.get('vizSwara').textContent, 'Paused');
  await a.click('pwrBtn');
  assert.equal(a.els.get('vizSwara').textContent, 'Power off');
});

test('Soft Sine reserves headroom for an accented metronome at full volume', async () => {
  const a = app();
  await a.instrument('soft-sine');
  await a.click('pwrBtn');
  await a.els.get('volSlider').dispatch('input', { target: { value: '100' } });
  await a.click('metToggle');
  await a.advance(753);
  const tonePeakBound = a.run('Object.values(gns).reduce((sum, node) => sum + Math.abs(node.gain.value), 0)');
  const accent = a.run('Array.from(metVoices)[0].outputs[0].gain.rampStartValue');
  assert.ok(tonePeakBound + accent <= 1, 'even aligned tone and click peaks must fit the output range');
});

test('Shruti Box and Harmonium use distinct reed blends and every partial follows fine tuning', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.click('SA-FINE');
  await a.instrument('shruti-box');
  await a.advance(800);
  const reed = a.run('Object.values(gns).map(node => node.gain.value)');
  assert.ok(reed[2] > reed[1], 'Shruti Box emphasizes odd harmonics');
  await a.instrument('harmonium');
  await a.advance(800);
  const organ = a.run('Object.values(gns).map(node => node.gain.value)');
  assert.ok(organ[1] > organ[2], 'Harmonium has a fuller even-harmonic blend');
  const before = a.voices().map(voice => voice.frequency.value);
  await a.click('fUp');
  for (const [i, voice] of a.voices().entries()) {
    assert.ok(Math.abs(voice.frequency.value / before[i] - Math.pow(2, 1 / 1200)) < 0.000001);
  }
});

test('instrument changes while muted stay silent and release every old graph', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(800);
  await a.click('muteBtn');
  for (const instrument of ['shruti-box', 'harmonium', 'soft-sine', 'tanpura']) {
    const oldNodes = a.connectedNodes().filter(node => node !== a.run('master'));
    await a.instrument(instrument);
    await a.advance(800);
    assert.equal(a.output(), 0);
    assert.ok(oldNodes.every(node => node.outputs.length === 0));
  }
  await a.click('pwrBtn');
  await a.advance(800);
  assert.equal(a.sources().length, 0);
  assert.equal(a.connectedNodes().length, 1);
});

test('instrument selector keeps native arrow, space and typeahead keyboard behavior', async () => {
  const a = app();
  await a.click('pwrBtn');
  const before = a.state();
  let intercepted = false;
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyM', 'KeyT']) {
    await a.document.dispatch('keydown', { target: { tagName: 'SELECT' }, code, preventDefault() { intercepted = true; } });
  }
  assert.deepEqual(a.state(), before);
  assert.equal(intercepted, false);
});

test('presets save the instrument and older presets recall the original Tanpura', async () => {
  const a = app();
  await a.instrument('harmonium');
  await a.click('storeBtn');
  await a.instrument('soft-sine');
  await a.click('recallBtn');
  assert.equal(a.state().instrument, 'harmonium');
  assert.equal(a.els.get('instrumentSelect').value, 'harmonium');
  const preset = JSON.parse(a.storage.get('shrutiPreset'));
  delete preset.instrument;
  a.storage.set('shrutiPreset', JSON.stringify(preset));
  await a.click('recallBtn');
  assert.equal(a.state().instrument, 'tanpura');
  assert.equal(a.els.get('instrumentSelect').value, 'tanpura');
});

test('Sa, Pa and upper Sa swell separately on a repeating audio-clock cycle', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(240);
  const levels = () => ['sa1', 'pa1', 'su1'].map(id => a.run(`gns.${id}.outputs[0].gain.sample()`));
  for (let note = 0; note < 3; note++) {
    const current = levels();
    assert.ok(current[note] > 2 * current[(note + 1) % 3], 'the leading note must stand apart from the next note');
    assert.ok(current[note] > 2 * current[(note + 2) % 3], 'the leading note must stand apart from the preceding note');
    await a.advance(1000);
  }
  assert.ok(levels()[0] > 0.9, 'Sa repeats without a JavaScript scheduler');
});

test('Sa fine provides an undetuned reference without a competing nearby pitch', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.click('SA-FINE');
  await a.advance(800);
  for (const voice of a.voices()) {
    const harmonic = voice.frequency.value / 261.63;
    assert.ok(Math.abs(harmonic - Math.round(harmonic)) < 0.000001, 'reference harmonics must remain in tune');
  }
});

test('resonance produces a quieter finite echo and replacement disconnects the complete old graph', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(800);
  const oldNodes = a.connectedNodes().filter(node => node !== a.run('master'));
  assert.ok(a.contexts[0].nodes.some(node => node.kind === 'delay'), 'the drone must have an echo path');
  const input = a.run('drone.input');
  const output = a.run('drone.output');
  input.inputs = [{ sample: at => at >= 1 && at < 1.01 ? 1 : 0 }];
  const direct = output.sample(1.005);
  const tail = Math.max(...Array.from({ length: 50 }, (_, i) => output.sample(1.08 + i * 0.01)));
  assert.ok(tail > 0 && tail < direct, 'a short, quieter echo follows the dry note');
  assert.equal(output.sample(2), 0, 'the echo has no feedback that can accumulate');
  await a.click('pUp');
  await a.advance(500);
  assert.ok(oldNodes.every(node => node.outputs.length === 0), 'old pitch echoes and envelopes are disconnected together');
  await a.click('pwrBtn');
  await a.advance(700);
  assert.equal(a.sources().length, 0);
  assert.equal(a.connectedNodes().length, 1, 'only the silent master remains connected');
});

test('a failed resume disconnects silent echo and envelope nodes without waiting for the audio clock', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(800);
  a.run("ctx.state = 'suspended'; ctx.resume = async () => { throw new Error('Interrupted output'); }");
  await a.click('pUp');
  await a.advance(1);
  assert.equal(a.state().on, false);
  assert.equal(a.connectedNodes().length, 1, 'a suspended clock cannot deliver a future cleanup callback');
});

test('reopening a closed context releases its former echo and envelope graph', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(800);
  const oldNodes = a.connectedNodes();
  a.run("ctx.state = 'closed'");
  await a.click('pUp');
  await a.advance(800);
  assert.ok(oldNodes.every(node => node.outputs.length === 0));
  assert.equal(a.state().on, true);
  assert.equal(a.contexts.length, 2);
});

test('rapid mode changes retain only the final drone and power off stops every oscillator', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(250);
  for (let i = 0; i < 5; i++) await a.click('SA-FINE');
  await a.advance(600);
  assert.equal(a.voices().length, 4, 'a burst must not orphan overwritten tone nodes');
  await a.click('SA-MA-SA');
  await a.advance(600);
  assert.equal(a.voices().length, 9, 'Ma mode has nine tone oscillators');
  assert.equal(a.sources().length, 12, 'only the current tones and three envelopes remain active');
  await a.click('pwrBtn');
  await a.advance(700);
  assert.equal(a.voices().length, 0, 'replaced oscillators must not be orphaned');
  assert.equal(a.sources().length, 0, 'looping envelopes must stop with their tones');
});

test('turning off during startup cannot create a delayed audible drone', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(20);
  await a.click('pwrBtn');
  await a.advance(300);
  assert.equal(a.voices().length, 0);
  assert.equal(a.output(), 0);
});

test('quick off/on keeps the newly requested drone playing', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(700);
  await a.click('pwrBtn');
  await a.advance(50);
  await a.click('pwrBtn');
  await a.advance(900);
  assert.equal(a.state().on, true);
  assert.equal(a.voices().length, 9);
  assert.notEqual(a.output(), 0);
});

for (const control of ['mute', 'zero volume']) {
  test(`${control} silences both drone modulation and metronome`, async () => {
    const a = app();
    await a.click('pwrBtn');
    await a.advance(800);
    await a.click('metToggle');
    if (control === 'mute') await a.click('muteBtn');
    else await a.els.get('volSlider').dispatch('input', { target: { value: '0' } });
    await a.advance(753);
    assert.equal(a.output(), 0, 'all sound must pass through the final mute/volume gain');
  });
}

test('metronome uses the already running audio context', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.advance(800);
  await a.click('metToggle');
  await a.advance(760);
  assert.equal(a.contexts.length, 1, 'timer callbacks must not create a locked second context');
});

const validPreset = { ni: 0, cents: 0, mode: 'SA-PA-SA', vol: 75, bpm: 80, tala: 'adi8' };
const invalidPresets = ['{bad json', 'null', ...[
  { ni: 99 }, { cents: 51 }, { vol: -1 }, { bpm: 0 },
  { mode: 'bad' }, { tala: 'bad' }, { mode: ['SA-FINE'] }, { tala: ['adi8'] },
  { instrument: 'bad' }, { instrument: null }, { instrument: ['tanpura'] }, { instrument: '__proto__' },
].map(fields => JSON.stringify({ ...validPreset, ...fields }))];
for (const preset of invalidPresets) {
  test(`invalid preset ${preset} leaves a playable state`, async () => {
    const a = app();
    a.storage.set('shrutiPreset', preset);
    const before = a.state();
    await a.click('recallBtn');
    assert.deepEqual(a.state(), before);
    await a.click('pwrBtn');
    await a.advance(800);
    assert.equal(a.voices().length, 9);
  });
}

test('a stored preset restores pitch, mode, zero volume and metronome settings', async () => {
  const a = app();
  await a.click('pwrBtn');
  await a.click('pUp');
  await a.click('fUp');
  await a.click('SA-MA-SA');
  await a.els.get('volSlider').dispatch('input', { target: { value: '0' } });
  await a.click('bpmUp');
  await a.click('khanda5');
  await a.click('storeBtn');
  await a.click('pUp');
  await a.click('SA-FINE');
  await a.els.get('volSlider').dispatch('input', { target: { value: '90' } });
  await a.click('recallBtn');
  await a.advance(800);
  assert.deepEqual(a.state(), {
    on: true, ni: 1, cents: 1, mode: 'SA-MA-SA', instrument: 'tanpura', vol: 0,
    muted: false, metOn: false, bpm: 85, tala: 'khanda5', beat: -1,
  });
  assert.equal(a.voices().length, 9);
  assert.equal(a.output(), 0);
});

test('blocked local storage does not prevent startup or audio controls', async () => {
  const a = app({ storageError: true });
  await a.click('pwrBtn');
  await a.advance(800);
  await a.click('storeBtn');
  await a.click('muteBtn');
  assert.equal(a.state().on, true);
  assert.equal(a.state().muted, true);
});

test('audio resume failure leaves power off with no orphaned voices', async () => {
  const a = app({ resumeError: true });
  await a.click('pwrBtn');
  await a.advance(800);
  assert.equal(a.state().on, false);
  assert.equal(a.voices().length, 0);
  assert.match(a.els.get('toast').textContent, /audio|sound/i);
});

test('a delayed resume cannot start a drone after power off', async () => {
  const a = app({ resumePending: true });
  await a.click('pwrBtn');
  await a.click('pwrBtn');
  a.resolveResume(0);
  await a.advance(800);
  assert.equal(a.state().on, false);
  assert.equal(a.voices().length, 0);
});

for (const settle of ['resolveResume', 'rejectResume']) {
  test(`an earlier ${settle} cannot replace the latest power-on request`, async () => {
    const a = app({ resumePending: true });
    await a.click('pwrBtn');
    await a.click('pwrBtn');
    await a.click('pwrBtn');
    a.resolveResume(1);
    await a.advance(800);
    a[settle](0);
    await a.advance(800);
    assert.equal(a.state().on, true);
    assert.equal(a.voices().length, 9);
  });
}

for (const [id, field] of [['fUp', 'cents'], ['bpmUp', 'bpm']]) {
  for (const end of ['touchcancel', 'blur']) {
    test(`${id} hold stops when interrupted by ${end}`, async () => {
      const a = app();
      await a.click('pwrBtn');
      await a.els.get(id).dispatch('touchstart');
      const value = a.state()[field];
      if (end === 'blur') await a.window.dispatch('blur');
      else await a.els.get(id).dispatch(end);
      await a.advance(900);
      assert.equal(a.state()[field], value);
    });
  }
}
