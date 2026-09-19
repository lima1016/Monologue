/* The level test's microphone: open it once, record one short clip at a time
   on it, close it at the end. A leaf -- it imports nothing from the app -- so
   it can be tested on its own and reused without dragging a screen in.

   Written for the level test and kept apart from timed.js on purpose: 1분
   말하기 records one continuous minute and runs live recognition beside it;
   the level test records fourteen short clips on one open stream. The rules
   both follow are the same ones, learned there:
   - a stream whose audio tracks have all ended is no stream (a mic unplugged
     or a device gone) -- starting a recorder on it only throws;
   - MediaRecorder can throw from the constructor *or* from start() (Chrome's
     NotSupportedError on a dead track), so both sit in one try;
   - a recording with no data is nothing to upload: null, not an empty Blob. */

/* True when this browser can record at all. */
export function micAvailable() {
  return typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices)
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

function tracksOf(stream) {
  return typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : stream.getTracks();
}

function usable(stream) {
  return Boolean(stream) && tracksOf(stream).some((t) => t.readyState !== 'ended');
}

function stopTracks(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

/* The microphone, or null: no recording support, permission refused, no
   device, or a stream that came back already dead. */
export async function openMic() {
  if (!micAvailable()) return null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null;
  }
  if (!usable(stream)) {
    stopTracks(stream);
    return null;
  }
  return { stream };
}

/* One clip on an open mic: a handle for stopRecording, or null when no
   recorder could be made or started on it. */
export function startRecording(mic) {
  if (!mic || !usable(mic.stream)) return null;
  const chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(mic.stream);
    recorder.ondataavailable = (e) => { if (e && e.data) chunks.push(e.data); };
    recorder.start();
  } catch {
    return null;
  }
  return { recorder, chunks };
}

/* Stops the clip and resolves once the recorder has handed over its last
   chunk (the stop event comes after it): the whole clip as one Blob, or null
   when nothing was recorded. */
export function stopRecording(handle) {
  if (!handle) return Promise.resolve(null);
  const { recorder, chunks } = handle;
  return new Promise((resolve) => {
    const done = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      resolve(chunks.length && blob.size > 0 ? blob : null);
    };
    if (recorder.state === 'inactive') { done(); return; }
    recorder.addEventListener('stop', done, { once: true });
    try {
      recorder.stop();
    } catch {
      done();
    }
  });
}

/* Lets the microphone go (the browser's recording light goes out). */
export function closeMic(mic) {
  if (mic) stopTracks(mic.stream);
}
