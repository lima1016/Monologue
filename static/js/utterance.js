/* One spoken turn's transcript, as a pure module -- the same split
   turnstate.js makes between "what is happening" and its own file, kept out
   of audio.js so it can be driven directly instead of through a real
   microphone. dom-shim.js deliberately provides no fake speech APIs
   ("Adding fake speech APIs would test the shim, not the app"), so this is
   the only way to put a test on the policy at all.

   The policy this exists to encode: with recognition.continuous = true,
   Chrome finalises a result at the first natural pause in speech, not when
   the speaker is actually done (that mismatch is the whole bug -- see
   audio.js's wiring comment). So no single final result may be trusted as
   "the learner is finished" -- every final fragment across the whole
   recognition session has to be kept and joined, not just the last one. The
   learner decides when they are done by pressing the mic again; this module
   only has to make sure nothing they said before that press is lost. */

export function createUtterance() {
  let fragments = [];
  let interimText = '';

  return {
    begin() {
      fragments = [];
      interimText = '';
    },
    final(text) {
      if (text && text.trim()) fragments.push(text.trim());
      // This chunk just graduated from interim to final -- whatever was
      // showing as "still being recognised" for it is now represented in
      // `fragments` instead, so it must not also linger here and get
      // appended a second time by text().
      interimText = '';
    },
    interim(text) {
      // Not collected into `fragments`: interim text is provisional and
      // Chrome resends it, revised, until it finalises (or drops it, if the
      // sound turns out not to be speech at all). It exists only so text()
      // can show what is being recognised right now, live.
      interimText = text && text.trim() ? text.trim() : '';
    },
    text() {
      return [...fragments, interimText].filter(Boolean).join(' ').trim();
    },
  };
}
