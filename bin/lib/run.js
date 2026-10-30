'use strict';

// Spawn mechanics shared by review.js (and, eventually, other runners):
// PTY-wrapper selection, the heartbeat/timeout/SIGTERM→SIGKILL lifecycle
// around one engine child process, the signal-name→number helper, and the
// synchronous-stdout-write helper that survives process.exit().

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { shellQuote } = require('../shell-quote');
const { whichCmd } = require('./harnesses');
const {
  createEnvelopeWatcher,
  createStrictEnvelopeWatcher,
} = require('./envelope');

// Bytes of recent engine stdout to flush to the parent's stdout on exit when
// the live stream was suppressed. Helps callers see a tail without opening the
// log file, while still forcing them to Read the log for the full content.
const TAIL_BYTES_ON_EXIT = 4096;

// Grace period between SIGTERM and SIGKILL when --timeout fires.
const KILL_GRACE_MS = 5000;

// Map a signal name ('SIGTERM') to its number via os.constants for the
// conventional 128+N exit-code convention.
function signum(sig) {
  const table = os.constants && os.constants.signals;
  if (table && typeof table[sig] === 'number') return table[sig];
  const fallback = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return fallback[sig] || 0;
}

// Many engine CLIs (codex exec, claude --print, gemini -p, etc.) detect a
// non-TTY stdout and buffer output until completion. When review.js is run
// from a background shell (CI, agent harness, `&`), this produces long silent
// stretches that look like a hang.
//
// We probe wrappers in this order, picking the first that exists AND is
// usable in the current environment:
//
//   1. `unbuffer -p` (expect package). Cross-platform, no TTY-on-stdin
//      requirement. Best when available.
//   2. `script(1)`. Per-platform syntax. BSD `script` calls tcgetattr() on
//      its own stdin and aborts when stdin is not a TTY, so on darwin we
//      can only use it when stdin is a real TTY. Linux util-linux is fine.
//   3. Direct spawn — engine bytes may buffer until exit, but at least the
//      process runs.
//
// We use streaming `spawn` (not `spawnSync`) so we can pipe chunks into both
// the parent stdio and an optional log file.
function chooseSpawn(cmd, args) {
  // No PTY needed when stdout is already a TTY (interactive use).
  if (process.stdout.isTTY || process.platform === 'win32') {
    return { cmd, args, viaScript: false, viaUnbuffer: false };
  }

  // Step 1: unbuffer (from `expect`). Works cross-platform without needing
  // a real TTY on stdin. Preferred when present.
  if (whichCmd('unbuffer')) {
    return {
      cmd: 'unbuffer',
      args: ['-p', cmd, ...args],
      viaScript: false,
      viaUnbuffer: true,
    };
  }

  // Step 2: script(1). Skip on darwin if stdin isn't a TTY (BSD script
  // aborts via tcgetattr). Linux util-linux `script -qfc` has no such
  // requirement.
  const scriptUsable = process.platform !== 'darwin' || process.stdin.isTTY;
  if (scriptUsable && whichCmd('script')) {
    const scriptArgs =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', cmd, ...args]
        : ['-qfc', [cmd, ...args].map(shellQuote).join(' '), '/dev/null'];
    return {
      cmd: 'script',
      args: scriptArgs,
      viaScript: true,
      viaUnbuffer: false,
    };
  }

  // Step 3: give up on PTY. Engine may buffer output until exit.
  return { cmd, args, viaScript: false, viaUnbuffer: false };
}

// When a log file is in use AND stdout is not a TTY, suppress live engine
// output from the parent's stdout entirely. Models invoking review.js from an
// agent harness routinely pipe to `| tail -N`, which truncates long reviews
// and loses content. By keeping engine bytes off stdout in that mode, we force
// callers to read the log file — there is literally nothing else to consume
// live. We DO flush a final tail (TAIL_BYTES_ON_EXIT) to stdout when the
// engine exits so callers always see at least the end of the review without
// having to open the log file.
//
// `opts` = { cwd, timeoutSec, heartbeatSec, started } — passed in explicitly
// (rather than read from module-level state) so this module has nothing
// shared across entry points to get out of sync.
function runHarness(cmd, args, logStream, opts) {
  const {
    cwd,
    timeoutSec,
    heartbeatSec,
    started,
    progName = 'review.js',
    // Defaults to review.js's long-standing loose, presence-only streaming
    // check (bare START marker = "seen") — review.js never passes this
    // option, so its behavior is unchanged. agent.js always opts into the
    // strict variant instead (complete START..END pair, non-empty payload),
    // on EVERY run, not only a no-log-file one — see envelope.js's
    // createStrictEnvelopeWatcher() comment for why "always".
    strictEnvelope = false,
  } = opts;
  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  return new Promise((resolve) => {
    const choice = chooseSpawn(cmd, args);
    let child;
    // Track engine activity for heartbeat + tail buffer.
    let lastByteAt = Date.now();
    let totalBytes = 0;
    const tail = [];
    let tailBytes = 0;
    // Whether the engine's stdout ever contained the structured-output START
    // marker (loose) or a complete non-empty START..END pair (strict). Used
    // by main() to distinguish a real answer from empty/refused/
    // sandbox-blocked output.
    const envelopeWatcher = strictEnvelope
      ? createStrictEnvelopeWatcher()
      : createEnvelopeWatcher();

    function recordBytes(chunk) {
      lastByteAt = Date.now();
      totalBytes += chunk.length;
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > TAIL_BYTES_ON_EXIT && tail.length > 1) {
        const dropped = tail.shift();
        tailBytes -= dropped.length;
      }
    }

    // stdio: 'ignore' on stdin — engines must NOT inherit the agent
    // harness stdin. Codex `exec` (and others) treat a non-TTY non-EOF
    // stdin as supplementary prompt input and block forever waiting for
    // EOF. Closing stdin makes them use only the argv prompt.
    //
    // detached: true makes this child the leader of its OWN process group
    // (POSIX: equivalent to calling setsid()) instead of sharing ours. On a
    // non-TTY stdout, this direct child may itself be a PTY wrapper
    // (unbuffer/script) around the real engine — and even without a
    // wrapper, an engine's own subprocess is a further descendant either
    // way. A plain child.kill() only ever signals THIS ONE process; every
    // process that isn't itself detached inherits its parent's group, so
    // signaling the NEGATIVE pid (see the timeout handler below) reaches
    // the wrapper, the engine, and anything the engine spawned in one shot.
    // Without this, a timeout leaves the rest of that tree orphaned and
    // running (and writing) after this function has already resolved.
    try {
      child = spawn(choice.cmd, choice.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ status: null, error: err, killedByTimeout: false });
      return;
    }

    let scriptFellBack = false;
    let killedByTimeout = false;
    let heartbeatTimer = null;
    let timeoutTimer = null;
    let killTimer = null;
    let sigKillTimer = null;
    // Whichever child process is CURRENTLY live — the initial spawn, or (on
    // the script-missing ENOENT fallback below) the direct re-spawn without
    // a PTY wrapper. The signal-forwarding handlers below always target
    // THIS one's process group, so a signal arriving after the fallback
    // swap still reaches the right tree.
    let currentChild = child;
    let signalForwarded = null;

    function clearTimers() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (sigKillTimer) clearTimeout(sigKillTimer);
      heartbeatTimer = timeoutTimer = killTimer = sigKillTimer = null;
    }

    // Forward a terminal/parent SIGINT or SIGTERM to the engine's WHOLE
    // process group. `detached: true` above makes the engine (or its PTY
    // wrapper) the leader of its OWN group, separate from ours — without
    // this, a terminal Ctrl-C (or a SIGTERM sent to this process, e.g. by
    // review.js's fusion parent forwarding to a fusion-child process) no
    // longer reaches the engine at all: it's orphaned, left running (and
    // writing) in the background indefinitely. Mirrors review.js's
    // fusion-parent signal handling (always escalate via SIGTERM -> grace ->
    // SIGKILL regardless of which signal was actually received) and the
    // timeout path's own SIGTERM/SIGKILL grace below. One-shot (a second
    // Ctrl-C is a no-op here, same as the fusion parent's `forwardedSignal`
    // guard) — registered once per runHarness() call right after the child
    // exists (below), removed in settle(), the single funnel every
    // resolution path (normal exit, spawn error, non-ENOENT child error)
    // already goes through, so there is no listener leak.
    function forwardSignal(sig) {
      if (signalForwarded) return;
      signalForwarded = sig;
      const msg = `# received ${sig}; forwarding to engine process group\n`;
      if (logStream) logStream.write(msg);
      process.stderr.write(`${progName}: ${msg.replace(/^# /, '')}`);
      killGroup(currentChild, 'SIGTERM');
      sigKillTimer = setTimeout(() => {
        const m2 = `# escalating to SIGKILL after ${KILL_GRACE_MS}ms grace (signal forward)\n`;
        if (logStream) logStream.write(m2);
        process.stderr.write(`${progName}: ${m2.replace(/^# /, '')}`);
        killGroup(currentChild, 'SIGKILL');
      }, KILL_GRACE_MS);
      if (sigKillTimer.unref) sigKillTimer.unref();
    }
    function onSigint() {
      forwardSignal('SIGINT');
    }
    function onSigterm() {
      forwardSignal('SIGTERM');
    }
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    function settle(result) {
      clearTimers();
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve(result);
    }

    function emitHeartbeat() {
      const elapsed = Math.round((Date.now() - lastByteAt) / 1000);
      const totalElapsed = Math.round((Date.now() - started) / 1000);
      // When the engine has produced ZERO bytes since launch, this is not
      // ordinary mid-stream silence — it usually means the upstream model is
      // unavailable/queued, or the engine is wedged before emitting anything.
      // Flag it distinctly so a 0-byte run is recognizable in the log/stderr
      // rather than looking like normal "thinking" silence.
      const outage =
        totalBytes === 0
          ? ' — NO OUTPUT YET; possible upstream model unavailability'
          : '';
      const msg = `# heartbeat +${totalElapsed}s (no engine output for ${elapsed}s, bytes-so-far=${totalBytes})${outage}\n`;
      if (logStream) logStream.write(msg);
      process.stderr.write(
        `${progName}: alive +${totalElapsed}s (silent ${elapsed}s, bytes=${totalBytes})${outage}\n`
      );
    }

    child.on('error', (err) => {
      // `script` missing — fall back to direct spawn once.
      if (choice.viaScript && !scriptFellBack && err && err.code === 'ENOENT') {
        scriptFellBack = true;
        process.stderr.write(
          `${progName}: 'script' not found on PATH; running without PTY (output may buffer)\n`
        );
        const direct = spawn(cmd, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        currentChild = direct;
        wireStreams(direct);
        attachLifecycle(direct);
        return;
      }
      settle({ status: null, error: err, killedByTimeout });
    });

    // Signal the CHILD'S WHOLE PROCESS GROUP (negative pid — see kill(2)),
    // not just the one process. Falls back to a plain child.kill() if the
    // group signal itself fails (e.g. the group already reaped, or a
    // platform where negative-pid signaling isn't supported) — matching the
    // pre-detached behavior exactly rather than leaving the child unsignaled.
    function killGroup(c, sig) {
      try {
        process.kill(-c.pid, sig);
      } catch {
        try {
          c.kill(sig);
        } catch {
          /* already exited */
        }
      }
    }

    function wireStreams(c) {
      c.stdout.on('data', (chunk) => {
        recordBytes(chunk);
        envelopeWatcher.feed(chunk);
        if (!stdoutSuppressed) process.stdout.write(chunk);
        if (logStream) logStream.write(chunk);
      });
      c.stderr.on('data', (chunk) => {
        recordBytes(chunk);
        process.stderr.write(chunk);
        if (logStream) logStream.write(chunk);
      });
    }

    function attachLifecycle(c) {
      // Heartbeat: every heartbeatSec, if no bytes seen since the last
      // tick, emit a liveness line to both the log and stderr.
      if (heartbeatSec > 0) {
        let lastTickAt = Date.now();
        heartbeatTimer = setInterval(() => {
          if (lastByteAt > lastTickAt) {
            // We saw bytes this interval — quiet.
            lastTickAt = Date.now();
            return;
          }
          lastTickAt = Date.now();
          emitHeartbeat();
        }, heartbeatSec * 1000);
        if (heartbeatTimer.unref) heartbeatTimer.unref();
      }

      // Timeout: SIGTERM after timeoutSec, SIGKILL after KILL_GRACE_MS.
      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          killedByTimeout = true;
          const totalElapsed = Math.round((Date.now() - started) / 1000);
          const msg = `# TIMEOUT after ${totalElapsed}s (--timeout=${timeoutSec}); sending SIGTERM\n`;
          if (logStream) logStream.write(msg);
          process.stderr.write(`${progName}: ${msg.replace(/^# /, '')}`);
          killGroup(c, 'SIGTERM');
          killTimer = setTimeout(() => {
            const m2 = `# escalating to SIGKILL after ${KILL_GRACE_MS}ms grace\n`;
            if (logStream) logStream.write(m2);
            process.stderr.write(`${progName}: ${m2.replace(/^# /, '')}`);
            killGroup(c, 'SIGKILL');
          }, KILL_GRACE_MS);
          if (killTimer.unref) killTimer.unref();
        }, timeoutSec * 1000);
        if (timeoutTimer.unref) timeoutTimer.unref();
      }

      c.on('exit', (code, signal) => {
        // On exit, flush tail to stdout if it was suppressed and there's
        // something to show.
        const tailBuf = Buffer.concat(tail);
        if (stdoutSuppressed && tailBuf.length > 0) {
          process.stdout.write(
            `\n--- engine output tail (last ${tailBuf.length} bytes; full log via Read tool) ---\n`
          );
          process.stdout.write(tailBuf);
          if (!tailBuf.toString('utf8').endsWith('\n'))
            process.stdout.write('\n');
          process.stdout.write('--- end tail ---\n');
        }
        settle({
          status: signal ? 128 + signum(signal) : code,
          error: null,
          killedByTimeout,
          totalBytes,
          sawEnvelope: envelopeWatcher.seen(),
          tailText: tailBuf.toString('utf8'),
        });
      });
    }

    wireStreams(child);
    attachLifecycle(child);
  });
}

// Scratch cell for writeFdSync's EAGAIN backoff — hoisted so retries
// share one allocation instead of minting a SharedArrayBuffer per spin.
const EAGAIN_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

// Synchronous write to an arbitrary fd that survives process.exit().
// process.stdout/stderr on a pipe are ASYNC — writes still queued behind a
// large payload are silently discarded when process.exit() fires
// (empirically: a multi-MB --print-answer echo truncates and drops the
// trailing SECOND_OPINION_RESULT line). fs.writeSync(fd) blocks until the
// bytes reach the pipe, but may write partially — and can raise EAGAIN on the
// non-blocking stdio fd while the pipe is full — so loop until every byte is
// out. EPIPE = reader gone; nothing left to deliver.
//
// Deliberate trade: like any blocking Unix writer (cat, tee), this waits
// indefinitely for a reader that never drains — favoring completeness over
// liveness, since the alternative is silently truncated output.
function writeFdSync(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        // Pipe full — sleep a beat (synchronously) so the reader can drain.
        Atomics.wait(EAGAIN_SLEEP_CELL, 0, 0, 5);
        continue;
      }
      if (err.code === 'EPIPE') return;
      throw err;
    }
  }
}

// fd-1/fd-2 conveniences over writeFdSync. writeStdoutSync is the one
// review.js has always used (unchanged behavior); writeStderrSync exists for
// agent.js's end-of-run warnings (e.g. "NO REPORT"), which need the same
// process.exit()-survives-a-full-pipe guarantee stdout writes get.
function writeStdoutSync(text) {
  writeFdSync(1, text);
}
function writeStderrSync(text) {
  writeFdSync(2, text);
}

module.exports = {
  TAIL_BYTES_ON_EXIT,
  KILL_GRACE_MS,
  signum,
  runHarness,
  writeFdSync,
  writeStdoutSync,
  writeStderrSync,
};
