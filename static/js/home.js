/* The home screen: the one input, the catalogue chips, 이어서 하기, and the
   counters. Named in the Phase 2 design
   (docs/superpowers/specs/2026-08-29-monologue-phase2-design.md:325) as its own
   module and split out of session.js, which had grown to four screens.

   The dependency runs one way only: home.js imports startSession and addMessage
   from session.js, because starting and resuming both hand off to the session
   screen. session.js must never import from here -- the moment it does, the two
   are one module again with an import statement between them. */
import { $, getJSON, postJSON, state, notify } from './api.js';
import * as router from './router.js';
import { addMessage, startSession } from './session.js';

/* One place that builds the catalogue request, so the three callers below
   cannot drift apart on the query string. Deliberately not cached: a cache
   here would have to be invalidated on language switch, on mode switch and on
   every scenario generation, and getting that wrong recreates the
   wrong-language-chip bug this screen already had once. The two calls inside
   startFromHome are mutually exclusive per press, so nothing is fetched twice
   in one gesture either -- this is duplicated code, not a duplicated round
   trip. */
function fetchScenarios(language, mode) {
  return getJSON(`/scenarios?language=${language}&mode=${mode}`);
}

// Filled by loadHome (Task 8) once a resumable session is found; read by
// resumeSession (Task 8). Declared here, ahead of either function, so a
// module that only defines one of the two never references an identifier
// the other half hasn't declared yet.
let resumeTarget = null;

/* Everything on the home screen that depends on history. Fails quietly: a
   learner who wants to practise should never be stopped by a counter.

   `session.turns` here comes from GET /sessions/resumable, which counts
   *every* message in the session (bot and learner) -- not the same "turns"
   db.session_stats reports on the end-of-session screen, which counts only
   the learner's own messages. Relabelling this as "말한 횟수" (times you
   spoke) would overstate the learner's count by roughly double, since every
   learner line in a live conversation is followed by a bot reply. Getting
   the learner-only count would mean fetching this session's full message
   list just to count it, on a load that must stay best-effort and cheap --
   so instead this reads as a plain exchange count ("대화 N턴"), which is
   what the payload actually measures, rather than silently mislabelling it
   as effort. */
export async function loadHome() {
  // Hidden before the await, on every path (including catch below): a failed
  // request must never leave the previous language's card/counters on screen
  // under the newly selected language button. A missing card is honest; a
  // stale one silently lies, and the learner has no way to tell the two apart.
  $('resume-card').hidden = true;
  $('home-stats').hidden = true;
  $('recommend').hidden = true;

  // Captured at call time: two quick language-switch clicks start two
  // overlapping loads, and without this an older response that resolves last
  // would paint its (now wrong) language's data over the newer, correct one.
  const lang = state.language;
  try {
    const [{ session }, stats] = await Promise.all([
      getJSON(`/sessions/resumable?language=${lang}`),
      getJSON(`/stats/home?language=${lang}`),
    ]);

    if (state.language !== lang) return; // a newer switch already won

    $('resume-card').hidden = !session;
    if (session) {
      resumeTarget = session;
      $('resume-title').textContent = `이어서 하기 — ${session.title}`;
      $('resume-sub').textContent = `대화 ${session.turns}턴에서 멈췄습니다`;
    }

    $('stat-streak').textContent = stats.streak;
    $('stat-week').textContent = stats.week_turns;
    $('stat-fixed').textContent = stats.fixed_total;
    $('home-stats').hidden = !(stats.streak || stats.week_turns || stats.fixed_total);

    $('recommend').hidden = !stats.top_tag;
    if (stats.top_tag) {
      $('recommend').textContent = `요즘 ${stats.top_tag}에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`;
    }
  } catch {
    // history is a nicety -- never block the learner from starting. But the
    // three elements above must stay hidden on this path too: a later
    // refactor that moves the initial hide out of this function must not be
    // able to silently reopen the stale-data bug this guards against.
    $('resume-card').hidden = true;
    $('home-stats').hidden = true;
    $('recommend').hidden = true;
  }
}

/* The one thing that knows a session is already being opened -- by either door.

   Opening one is a multi-second local-model call, and #wish (Enter) and the
   chips both reach startFromHome while #btn-start is disabled, so disabling
   that one button is not a guard. Two Enter presses, or a chip clicked during a
   generation wait, create *two* sessions; the loser is left open holding only
   its bot opening line, and would then be offered back as the resume card.
   Same defect and same shape as the `ending` flag in session.js (and as commit
   07caa64 for sendTurn): a flag, not a disabled attribute, because the entry
   points are not all buttons.

   One flag rather than one per door, because what is being guarded is one
   resource -- state.sessionId and the session screen painted from it -- and two
   flags could only ever give two answers to the single question "is a session
   already being opened". 이어서 하기 pressed during a generation wait used to set
   state.sessionId to the resume target and show the session screen, and the
   in-flight startSession then overwrote it, re-showed the screen and wiped
   #conversation: nothing corrupted, but the learner watched the conversation
   they had just asked for be replaced by a different one.

   Every path that sets it must clear it in a `finally`, or one failed start or
   resume locks the home screen for the rest of the page's life. */
let busy = false;

/* 이어서 하기: attach to the existing session rather than starting a new one.
   GET /sessions/{id} already returns every message, so replaying them is
   enough to restore the conversation on screen.

   resumable_session (db.py) already excludes mode === 'script' sessions --
   the learner's position in a script (scriptIndex) lives only in the
   browser and is never persisted, so there is nothing server-side to place
   them back into. That exclusion predates this task (it shipped with
   GET /sessions/resumable itself); resumeSession does not need its own
   guard for it because resumeTarget can never hold a script session. */
export async function resumeSession() {
  if (!resumeTarget || busy) return;
  busy = true;
  try {
    const { messages } = await getJSON(`/sessions/${resumeTarget.id}`);
    state.sessionId = resumeTarget.id;
    state.mode = resumeTarget.mode;
    router.show('session');
    $('conversation').replaceChildren();
    // GET /sessions/{id} hands back a cache-only audio_key per bot message
    // (null if nothing is cached, never freshly synthesised) -- see
    // _resumable_audio_key in app/api.py. Passing it through means clicking a
    // replayed bot bubble plays the real clip when it is still on disk,
    // rather than main.js's play() reporting a synthesis failure that never
    // happened.
    for (const m of messages) addMessage(m.speaker, m.text, m.audio_key);
    // Same rule as startSession: the side panel holds only 목표 or 대본, so a
    // resumed session with no goal (lesson mode, or free mode with none set)
    // hides the panel rather than showing the "목표" heading over nothing.
    const goal = resumeTarget.goal || '';
    $('panel-title').textContent = '목표';
    $('panel-body').textContent = goal;
    $('side-panel').hidden = !goal;
    notify('');
  } catch (err) {
    notify(`이어서 하지 못했습니다: ${err.message}`);
  } finally {
    busy = false;
  }
}

/* The chips are the catalogue, not a required choice. A learner who knows what
   they want types it; the chips are for the ones they have used before and for
   the days they have no idea. */
export async function loadChips() {
  const box = $('chips');
  box.replaceChildren();
  // Captured at call time, the same way loadHome does it: two quick language
  // (or mode) clicks issue two overlapping requests, and if the older one
  // resolves last it would paint its now-wrong catalogue over the newer,
  // correct one. These chips are clickable, so a stale chip is not merely
  // cosmetic -- it hands startFromHome a scenario id from the other language.
  const lang = state.language;
  const mode = state.mode;
  if (mode === 'lesson') return;   // lesson takes a topic, not a scenario
  try {
    const { scenarios } = await fetchScenarios(lang, mode);
    if (state.language !== lang || state.mode !== mode) return; // a newer switch already won
    for (const s of scenarios.slice(0, 8)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.title;
      b.dataset.id = s.id;
      box.append(b);
    }
  } catch {
    // The catalogue is a convenience, not a required choice -- the learner can
    // still type what they want. Leaving the box empty (it was cleared above)
    // is honest; an unhandled rejection here used to empty it anyway, just
    // without anything having decided to.
  }
}

/* Three ways in, one button:
   - a chip, or text that names a scenario we already have -> reuse it
   - text we have never seen -> ask the model to build it
   - nothing typed -> pick one, because "고르세요" is what this screen removed */
export async function startFromHome(scenarioId = null) {
  if (busy) return;
  const wish = $('wish').value.trim();
  // Captured once, here, and used for every request below -- never re-read
  // from `state` after an await. /scenarios/generate is a local 14b call that
  // takes seconds, and the language segment and the mode buttons stay live
  // throughout it: a switch landing mid-generation would otherwise post the
  // new language with the old language's scenario id, creating a session
  // stamped `ja` bound to an `en` scenario, whose turns then feed the wrong
  // language's history forever with nothing on screen to say so.
  const language = state.language;
  const mode = state.mode;
  // Inside the try, not before it: a throw between setting `busy` and the
  // `finally` that clears it latches the flag true for the life of the page,
  // and every home-screen button then silently stops working. #btn-start
  // going missing is exactly such a throw. resumeSession has no such gap.
  try {
    busy = true;
    $('btn-start').disabled = true;
    let id = scenarioId;
    if (!id && mode !== 'lesson' && wish) {
      const { scenarios } = await fetchScenarios(language, mode);
      const hit = scenarios.find((s) => s.title.trim() === wish);
      if (hit) id = hit.id;
      else {
        notify('상황을 만드는 중입니다...');
        const made = await postJSON('/scenarios/generate', { language, mode, wish });
        id = made.id;
        notify('');
      }
    }
    if (!id && mode !== 'lesson') {
      const { scenarios } = await fetchScenarios(language, mode);
      if (!scenarios.length) { notify('연습할 상황이 없습니다.'); return; }
      id = scenarios[Math.floor(Math.random() * scenarios.length)].id;
    }
    await startSession({ language, mode, scenarioId: id, topic: mode === 'lesson' ? wish : null });
  } catch (err) {
    notify(`시작하지 못했습니다: ${err.message}`);
  } finally {
    busy = false;
    $('btn-start').disabled = false;
  }
}
