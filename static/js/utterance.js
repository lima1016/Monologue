/* One spoken turn's timing policy, as a pure module -- the same split
   turnstate.js makes between "what is happening" and its own file, kept out
   of audio.js so it can be driven by a fake clock instead of a real
   microphone. dom-shim.js deliberately provides no fake speech APIs
   ("Adding fake speech APIs would test the shim, not the app"), so this is
   the only way to put a test on the policy at all.

   The policy this exists to encode: with recognition.continuous = true,
   Chrome finalises a result at the first natural pause in speech, not when
   the speaker is actually done (that mismatch is the whole bug -- see
   audio.js's wiring comment). So no single final result may be trusted as
   "the learner is finished". Instead: collect every final fragment, and only
   decide the learner has stopped after `silenceMs` has passed with nothing
   more arriving -- finalised or still-interim -- to extend that deadline. */

export function createUtterance({
  silenceMs = 2000,
  onSilence,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let fragments = [];
  let timer = null;

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  // Not started in begin(): a learner can take a few seconds after pressing
  // the mic before saying anything, and starting the clock at begin() would
  // cut that learner off before they ever spoke. Silence with nothing said
  // at all is Chrome's own `no-speech` error, handled elsewhere -- this timer
  // only needs to exist once there is something to go silent *after*.
  function restartTimer() {
    cancelTimer();
    timer = setTimer(() => { timer = null; if (onSilence) onSilence(); }, silenceMs);
  }

  return {
    begin() {
      fragments = [];
      cancelTimer(); // a stale timer from a previous utterance must not fire into this one
    },
    final(text) {
      if (text && text.trim()) fragments.push(text.trim());
      restartTimer();
    },
    interim() {
      // Not collected: interim text is provisional and Chrome resends it,
      // revised, until it finalises. It counts only as evidence the learner
      // is still talking, which is exactly what should push the deadline out.
      restartTimer();
    },
    stop() {
      cancelTimer(); // no delivery here -- audio.js's onend does that, once, in one place
    },
    text() {
      return fragments.join(' ').trim();
    },
  };
}
