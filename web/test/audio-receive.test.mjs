import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch, startBridge } from './browser.mjs';

let bridge;
let browser;
before(async () => {
  bridge = await startBridge();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await bridge?.close();
});

async function receiverPage(t) {
  const page = await browser.newPage(bridge.url);
  t.after(async () => {
    await page.eval('r.engine.stop()');
    assert.deepEqual(page.errors(), []);
    await page.close();
  });
  await page.eval(`(async () => {
    const { AudioEngine } = await import('/app/audio.js');
    const { encodeServerAudio, decodeVoice } = await import('/src/voice.js');
    const decoders = [];
    const contexts = [];
    const OriginalDecoder = AudioDecoder;
    window.AudioDecoder = class extends OriginalDecoder {
      constructor(options) {
        const outputs = [];
        super({ ...options, output(audio) { outputs.push(audio.timestamp); options.output(audio); } });
        this.timestamps = outputs;
        this.inputs = [];
        this.deliver = options.output;
        this.fail = options.error;
        decoders.push(this);
      }
      decode(chunk) { this.inputs.push(chunk.timestamp); return super.decode(chunk); }
    };
    const OriginalContext = AudioContext;
    window.AudioContext = class extends OriginalContext {
      constructor(...args) { super(...args); contexts.push(this); }
    };
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    async function encode(channels, bitrate) {
      const packets = [];
      const encoder = new AudioEncoder({
        output(chunk) {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          packets.push(bytes);
        }, error(error) { throw error; },
      });
      encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate, opus: { frameDuration: 20000 } });
      for (let frame = 0; frame < 30; frame++) {
        const pcm = new Float32Array(960 * channels);
        for (let channel = 0; channel < channels; channel++) {
          const hz = channels === 1 ? 880 : (channel === 0 ? 440 : 660);
          for (let i = 0; i < 960; i++) pcm[channel * 960 + i] = 0.3 * Math.sin(2 * Math.PI * hz * (frame * 960 + i) / 48000);
        }
        const audio = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: channels, timestamp: frame * 20000, data: pcm });
        encoder.encode(audio);
        audio.close();
      }
      await encoder.flush();
      encoder.close();
      return packets.slice(0, 30);
    }
    const mono = await encode(1, 48000);
    const stereo = await encode(2, 96000);
    const logs = [];
    const client = Object.assign(new EventTarget(), {
      me: 1,
      users: new Map([[1, { session: 1, channelId: 0 }], [2, { session: 2, channelId: 0 }], [3, { session: 3, channelId: 0 }]]),
      isConnected: false, diag(tag, message) { logs.push({ tag, message }); },
      setSelfMute() {}, setSelfDeaf() {},
    });
    const engine = new AudioEngine(client, {});
    window.r = { engine, client, logs, decoders, contexts, mono, stereo, wait, time: null, format: 'protobuf' };
    const clock = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { configurable: true, value: () => r.time ?? clock() });
    r.voice = (sequence, { session = 2, opus = stereo[0], isTerminator = false } = {}) =>
      client.dispatchEvent(new CustomEvent('voice', { detail: decodeVoice(encodeServerAudio({ session, frameNumber: BigInt(sequence), opus, isTerminator }, r.format), r.format) }));
    r.burst = async (sequence, { channels = 2, other = false, terminator = false } = {}) => {
      const before = { ...engine.stats };
      const captured = engine.captureOutput(900);
      const packets = channels === 2 ? stereo : mono;
      for (let index = 0; index < packets.length; index++) {
        r.voice(sequence + index * 2, { opus: packets[index], isTerminator: terminator && index === packets.length - 1 });
        if (other) r.voice(20000 + index * 2, { session: 3, opus: mono[index], isTerminator: index === packets.length - 1 });
        await wait(20);
      }
      const pcm = await captured;
      // A window after jitter priming and before the end of transmission.
      const active = pcm.slice(48000 * 0.2, 48000 * 0.5);
      const amplitude = (hz) => {
        let sin = 0, cos = 0;
        for (let i = 0; i < active.length; i++) {
          sin += active[i] * Math.sin(2 * Math.PI * hz * i / 48000);
          cos += active[i] * Math.cos(2 * Math.PI * hz * i / 48000);
        }
        return 2 * Math.hypot(sin, cos) / active.length;
      };
      return {
        received: engine.stats.packetsIn - before.packetsIn,
        decoded: engine.stats.samplesOut - before.samplesOut,
        rms: Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length),
        music: amplitude(440) + amplitude(660), voice: amplitude(880),
      };
    };
    await engine.start({ source: 'tone' });
    engine.setReceiveDiagnostics(2);
  })()`);
  return page;
}

function audible(result, packets = 30) {
  assert.equal(result.received, packets, 'packets arrive');
  assert.equal(result.decoded, packets * 960, 'all packets decode to PCM');
  assert.ok(result.rms > 0.01, `PCM reaches mixer output (RMS ${result.rms})`);
}

// This is the original regression: before the fix received=30, decoded=0,
// rms=0 after the pause, despite successful playback before it.
test('stereo 96 kbit/s resumes after a five-second pause and a sequence restart without a terminator', { timeout: 30_000 }, async (t) => {
  const page = await receiverPage(t);
  assert.equal(await page.eval('Boolean(r.stereo[0][0] & 4)'), true);
  audible(await page.eval('r.burst(10000)'));
  await page.eval('r.wait(5100)');
  const resumed = await page.eval('r.burst(0)');
  console.log('five-second stereo restart:', resumed);
  audible(resumed);
  assert.equal(await page.eval('r.decoders.length'), 1, 'idle restart reuses its decoder');
  assert.ok(await page.eval(`r.logs.some(x => /stage=restart.*sequence=0.*previousNext=10060/.test(x.message))`));
  await page.eval('r.wait(1100)');
  assert.ok(await page.eval(`r.logs.some(x => /stage=render.*rendered=[1-9].*peak=0\.[1-9]/.test(x.message))`), 'render thread reports a nonzero signal');
});

for (const channels of [1, 2]) {
  test(`${channels === 1 ? 'mono 48' : 'stereo 96'} kbit/s: continuous audio, real 1/5/10/30-second pauses and repeated track starts`, { timeout: 100_000 }, async (t) => {
    const page = await receiverPage(t);
    if (channels === 1) await page.eval(`r.format = 'legacy'`);
    for (const sequence of [10000, 10060, 10120]) audible(await page.eval(`r.burst(${sequence}, { channels: ${channels} })`));
    for (const seconds of [1, 5, 10, 30, 5, 5]) {
      // Wait outside CDP: its Runtime.evaluate deadline is 30 seconds.
      await sleep(seconds * 1000);
      // PyMumble continues its clock below five seconds; otherwise restarts at 0.
      const sequence = seconds === 1 ? 10280 : 0;
      audible(await page.eval(`r.burst(${sequence}, { channels: ${channels} })`));
      console.log(`${channels} channel(s), pause ${seconds}s: audible`);
    }
    assert.equal(await page.eval('r.decoders.length'), 1);
    await page.eval('r.engine.stop()');
    assert.equal(await page.eval(`r.contexts.filter(c => c.state !== 'closed').length`), 0);
    assert.equal(await page.eval(`r.decoders.filter(d => d.state !== 'closed').length`), 0);
    await page.eval(`r.engine.start({ source: 'tone' })`);
    audible(await page.eval(`r.burst(0, { channels: ${channels} })`));
  });
}

test('music and ordinary speech both reach the mixer after a restart; payload and empty terminators allow short track changes', { timeout: 30_000 }, async (t) => {
  const page = await receiverPage(t);
  audible(await page.eval('r.burst(10000)'));
  // Advance only the receive clock here; the tests above use real pauses.
  await page.eval('r.time = performance.now() + 10000');
  const mixed = await page.eval('r.burst(0, { other: true, terminator: true })');
  audible(mixed, 60);
  assert.ok(mixed.music > 0.05, `music is present (${mixed.music})`);
  assert.ok(mixed.voice > 0.05, `speech is present (${mixed.voice})`);
  audible(await page.eval('r.burst(0)'));
  await page.eval('r.voice(60, { opus: new Uint8Array(), isTerminator: true })');
  audible(await page.eval('r.burst(0)'));
  assert.equal(await page.eval('r.decoders.length'), 2);
  await page.eval('r.engine.setUserVolume(2, 0.25); r.time += 10000');
  const quieter = await page.eval('r.burst(0)');
  audible(quieter);
  assert.ok(quieter.music > 0.03 && quieter.music < 0.13, 'a new spurt preserves per-user volume');
  await page.eval('r.engine.setUserLocalMute(2, true); r.time += 10000');
  const muted = await page.eval('r.burst(0)');
  assert.equal(muted.rms, 0, 'a new spurt preserves per-user mute');
});

test('short-gap late packets and duplicates stay rejected; packets within the reorder window decode in order', { timeout: 20_000 }, async (t) => {
  const page = await receiverPage(t);
  const result = await page.eval(`(async () => {
    r.time = 0;
    r.voice(10000);
    await r.wait(50);
    r.voice(10004);
    r.voice(10002);
    await r.wait(100);
    r.voice(10002);
    r.time = 1999;
    r.voice(0);
    await r.wait(50);
    const beforeRestart = [...r.decoders[0].inputs];
    r.time = 4000;
    r.voice(2); // The first packet of the new spurt may itself be lost.
    await r.wait(100);
    return { beforeRestart, afterRestart: r.decoders[0].inputs, outputs: r.decoders[0].timestamps.length, decoders: r.decoders.length };
  })()`);
  assert.deepEqual(result.beforeRestart, [100000000, 100020000, 100040000]);
  assert.deepEqual(result.afterRestart, [...result.beforeRestart, 20000]);
  assert.equal(result.decoders, 1);
  assert.equal(result.outputs, 4);
});

test('channel changes and departure close the receiver; late decoder output cannot recreate a removed mixer stream', { timeout: 20_000 }, async (t) => {
  const page = await receiverPage(t);
  const result = await page.eval(`(async () => {
    r.voice(10000);
    r.client.users.get(2).channelId = 1;
    r.client.dispatchEvent(new Event('users'));
    await r.wait(100);
    const firstClosed = r.decoders[0].state === 'closed';
    r.voice(0);
    await r.wait(100);
    const recreated = r.decoders.length;
    const samplesBeforeLateOutput = r.engine.stats.samplesOut;
    r.decoders[0].deliver(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: 0, data: new Float32Array(960).fill(0.5) }));
    r.decoders[0].fail(new Error('late callback from removed decoder'));
    r.voice(2);
    await r.wait(100);
    const staleIgnored = r.engine.stats.samplesOut === samplesBeforeLateOutput + 960 && r.decoders.length === recreated;
    r.client.users.delete(2);
    r.client.dispatchEvent(new Event('users'));
    await r.wait(100);
    return { firstClosed, recreated, staleIgnored, allClosed: r.decoders.every(d => d.state === 'closed'),
      removed: r.logs.filter(x => x.message.includes('stage=remove')).map(x => x.message) };
  })()`);
  assert.equal(result.firstClosed, true);
  assert.equal(result.recreated, 2, 'a later whisper from another channel can create a receiver');
  assert.equal(result.staleIgnored, true, 'stale codec callbacks cannot submit PCM or remove the new decoder');
  assert.equal(result.allClosed, true);
  assert.ok(result.removed.some(x => x.includes('reason=channel-changed')));
  assert.ok(result.removed.some(x => x.includes('reason=user-left-server')));
});
