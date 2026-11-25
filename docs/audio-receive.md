# Receiving audio after a silent interval

## Confirmed failure and scope

The Electron app uses the same receive engine as the browser. A Chromium regression
with actual WebCodecs Opus and AudioWorklet reproduces the reported Botamusique
failure without a live server:

1. Send stereo Opus at 96 kbit/s, sequence numbers 10000 through 10058, with no
   terminator. This represents joining a bot part-way through a long track.
2. Stop sending for 5.1 seconds.
3. Resume with sequence numbers 0 through 58, still without a terminator.

Before the fix, the second burst receives all 30 packets but decodes **zero** PCM
frames; the captured mixer output has RMS **0**. The initial burst decodes 28800
frames and has RMS approximately 0.122. With the fix the resumed burst also decodes
28800 frames and has RMS approximately 0.164.

This confirms the receive-ordering defect in Mutter. It does not identify the
exact image digest or PyMumble version in the user's running container, and does
not constitute a test of Windows audio drivers or the live Botamusique instance.
The defect is reproducible in Linux Chromium, so the shared code does not limit
it to Windows.

## Source evidence

Botamusique declares `pymumble>=1.2` in its
[requirements](https://github.com/azlux/botamusique/blob/master/requirements.txt).
In PyMumble's
[`SoundOutput.send_audio`](https://github.com/azlux/pymumble/blob/pymumble_py3/pymumble_py3/soundoutput.py),
`sequence_last_time + PYMUMBLE_SEQUENCE_RESET_INTERVAL <= current_time` resets
`sequence` to zero. The
[constant](https://github.com/azlux/pymumble/blob/pymumble_py3/pymumble_py3/constants.py)
is five seconds. Below that interval the sequence instead follows elapsed time.
The Opus branch writes the payload length without the terminator bit, and an
empty PCM queue returns without sending an end packet. This is a source-supported
explanation for the observed threshold, rather than a coincidental Mutter timeout.
Check the deployed library version or the receive logs below to confirm the same
sequence transition on the affected installation.

In Mutter, `AudioEngine.#onVoice` rejected every sequence below
`receiver.nextSequence`. That high-water mark persisted through silence;
`#endWithoutAudio` or a payload terminator could clear it, but neither arrives in
this sender pattern. The packet was discarded before `#play` and `decoder.decode`.
The counter would have to catch up to the previous track's high-water mark before
playback returned. Another pause and reset can prevent it from ever catching up.

`MumbleClient.#onVoice` marks the user as talking **before** dispatching to the audio
engine. Consequently the activity indicator works while decoding receives no data.
Other users have separate receivers, so they continue to play. Reconnecting calls
`AudioEngine.stop`, clearing receivers and decoders; a new receiver accepts the
bot's current sequence, explaining the temporary recovery.

## Receive architecture and timeout audit

| Stage | Implementation and state |
| --- | --- |
| Server transport | `web/bridge/server.mjs`, `Tunnel`: TLS `UDPTunnel` and decrypted UDP reach the browser's WebSocket. `decodeVoice` in `web/src/voice.js` handles legacy and protobuf voice formats. |
| Voice events | `web/app/client.js`, `MumbleClient.#onVoice`: parses packets, finds the numeric Mumble session, updates activity, emits `voice`. |
| Ordering | `web/app/audio.js`, `AudioEngine.#onVoice`, `#drainPending`: one receiver per session; pending packets wait at most 30 ms for reordering. Short-gap late packets stay rejected. Sequence units represent 10 ms, not stereo sample counts. |
| Decode | `#decoderFor`, `#play`, `#onDecoded`: one WebCodecs Opus `AudioDecoder` per session, configured for 48 kHz mono output. Decoded frame counts update the sender's packet duration. |
| Concealment | `#scheduleConcealment`, `#emitFills`: short losses use decaying PCM; gaps beyond 25 packets break the spurt instead of generating unbounded silence. |
| Playback | `#emitDecoded` transfers PCM to `mutter-mixer` in `web/app/worklets.js`. Per-session ring buffers feed the shared AudioContext destination and selected output device. Electron/Chromium handles Windows audio output. |
| Quiet intervals | The worklet drains, ramps out and becomes unprimed. Its 300 ms dry confirmation affects underrun accounting; `process()` keeps returning true. It neither deletes the user nor suspends AudioContext. |
| End/cleanup | `end` drains remaining audio; channel changes and user removal close that receiver's decoder, cancel pending timers and remove its mixer state. `stop()` closes all codecs and AudioContext. |

The bridge's 5000 ms ping and nonce-resynchronization constants affect transport,
not individual decoder deletion. There was no five-second decoder cleanup timer.
The decoder and AudioContext remained alive in the failing regression. Stereo and
mono take the same ordering path. Stereo input is currently rendered through the
existing mono receive/mixer path, duplicated to both output channels; this change
does not add stereo spatial playback or change the bot's bitrate.

## Fix

The receiver records incoming packet arrival using monotonic `performance.now()`.
On the first packet after at least two seconds without audio packets, it clears
the old reorder expectation and pending reorder timer. A break is placed in the
existing decoded-output queue before the new spurt. That preserves ordering of
in-flight decode callbacks, discards obsolete concealment history at the break
and fades in the resumed signal. The decoder and mixer node are reused.

The two-second threshold establishes a new receive spurt before PyMumble's
five-second reset. It also handles a lost first packet of a new spurt: resumption
does not require receiving exactly sequence zero. It is checked on packet arrival;
there is no polling timer, automatic reconnection or continuous silence source.
Packets during active transmission still use the original ordering checks.

Related lifecycle protection discards callbacks from closed/replaced decoders,
and prunes receiver state on channel changes and server departure, including
receivers whose decoder already failed. A new whisper from a different channel
can still create a receiver normally.

## Automated verification

Run from the repository root with Node 22.12+ and Chrome/Chromium installed:

```sh
CHROME=google-chrome node --test web/test/audio-receive.test.mjs
node web/test/jitter.test.mjs
node web/test/voice.test.mjs
CHROME=google-chrome node --test web/test/lifecycle.test.mjs
CHROME=google-chrome node web/test/e2e.test.mjs
CHROME=google-chrome node web/test/quality.test.mjs
```

On Windows PowerShell, set `$env:CHROME` to the local Chrome executable and omit
the `CHROME=google-chrome` prefix. Run the audio tests sequentially, avoiding other
CPU-heavy audio benchmarks.

`audio-receive.test.mjs` exercises real Opus encode/decode and captures actual
worklet output rather than accepting the activity indicator as evidence of sound.
It covers mono 48 kbit/s and stereo 96 kbit/s, continuous playback, real pauses of
1/5/10/30 seconds, repeated five-second pauses, payload/empty terminators, mixed
music and ordinary speech, duplicates, reordered/late packets, channel changes,
user departure, and engine stop/start. It checks decoder reuse and resource closure.
Some ordering/lifecycle cases advance the receive clock deterministically; the
pause matrix and original regression use real wall-clock waits.

Local verification on Linux/Chrome (2026-11-21): all six receive tests passed,
including both real pause matrices. The subsequently expanded mixed-stream,
ordering and cleanup tests also passed, including retained volume/mute, loss of
the first restarted packet and callbacks from a replaced decoder. All ten
existing lifecycle tests passed. End-to-end runs passed with protobuf voice,
legacy voice and TCP fallback. The quality run measured 42.7 dB SNR, zero clicks,
zero dropouts and zero underruns, with a 60 ms jitter target unchanged across
short spurts and lost terminators. Voice-codec tests, jitter tests, 11 desktop
logic tests and generated-theme checks passed. Windows CI has the receive test
configured, but was not executed from this workspace.

## Windows diagnostic capture

1. Open the fixed app, connect to the existing server and keep Botamusique at
   stereo/96 kbit/s. Open Developer Tools with **Ctrl+Shift+I**, then **Console**.
2. Find the bot's session and enable its receive trace:

   ```js
   [...mutter.client.users.values()].map(({ session, name }) => ({ session, name }))
   // Replace 42 with the numeric session from the result:
   mutter.audio.setReceiveDiagnostics(42)
   ```

3. Play a track, pause for at least six seconds, then resume. Copy the log promptly
   from the app's **Server → Log → Copy log**, or Settings' diagnostic log. The log
   is bounded, and normal receive stages are rate-limited to once per second.
4. Look for `stage=restart` with `idleMs`, `sequence` and `previousNext`. A smaller
   new sequence confirms the reset on the actual bot. Subsequent `stage=decode`
   and `stage=push` should show growing decoded/submitted counts. `stage=render`
   reports per-user buffered samples, rendered samples, signal peak, gain and
   AudioContext state. `stage=drop` records late rejection; `stage=error` identifies
   a decoder error; `stage=remove` states the cleanup reason.
5. Disable tracing when finished:

   ```js
   mutter.audio.setReceiveDiagnostics(null)
   ```

These receive trace records contain session IDs, timing, sequence numbers, sizes,
counts and signal-level metadata; they do not log encoded packet bytes, PCM,
passwords or tokens. They show the worklet's signal, not a measurement at the
physical speakers. If `rendered` and `peak` are nonzero but nothing is audible,
check the selected output device and Windows mixer separately.

## Build and manual acceptance on Windows

From the repository root, with Node 22.12+:

```powershell
node scripts/generate-themes.mjs --check
cd desktop
npm ci
npm run dist:win -- --publish never
```

Artifacts are in `desktop/dist/`. Use an output directory distinct from older
builds when retaining both. The app's version remains 0.1.0; identify the fixed
build by its source revision and the presence of `setReceiveDiagnostics`.
The locally cross-built fixed artifacts are kept in
`desktop/dist/audio-receive-fix/`, separately from the earlier Windows builds.

Keep the running server and bot configuration unchanged. In the fixed Windows app:

1. Listen continuously for a minute, then pause/resume for 1, 5, 10 and 30 seconds.
   Sound must return without reconnecting; confirm the five-second reset in logs.
2. Repeat at least ten pause/resume cycles and several track changes, including
   stopping a track and starting another. Repeat with an ordinary voice user.
3. Have a participant speak while the bot resumes. Both must remain audible;
   exercise per-user volume/mute and self-deafen to check gain handling.
4. Move the bot/participant between channels, remove/rejoin them, and switch the
   listener's channel. Check `stage=remove`, sound on rejoin, and whispers if used.
5. Disconnect/reconnect Mutter, and close/reopen it. Verify normal audio startup,
   microphone cleanup and device selection. Listen through the actual Windows
   output device; a nonzero worklet capture alone cannot verify WASAPI/driver output.

The tests do not connect to the production server, inspect its Docker containers,
or modify Botamusique. Final acceptance requires this Windows/live-bot check.
