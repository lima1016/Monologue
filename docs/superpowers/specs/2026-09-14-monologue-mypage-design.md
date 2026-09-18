# Monologue — 마이페이지 설계 (Phase 2 D)

- 날짜: 2026-09-14
- 상태: 사용자 승인("마이페이지 그대로 쭉 진행")
- 선행: 홈 대시보드(`5596d7d`). 원래 Phase 2 설계(`2026-08-29-monologue-phase2-design.md` D절, `review_queue`, "다시 말해 성공" 판정)를 지금 코드에 맞게 구체화한다.

## 원칙

- **마이페이지 = 돌아보는 곳.** 홈은 오늘 할 일, 마이페이지는 레벨·복습·약점·기록.
- **복습이 그래프보다 위.** "전치사 5회"를 아는 것으로는 늘지 않고, 그 문장을 다시 말해야 는다.
- **숫자를 꾸며내지 않는다.** 표본이 적으면 적다고 말한다.
- 사용자 규칙: 오래 걸릴 수 있는 대기는 화면에 무엇을 하는 중인지 보여준다.

## 들어가는 곳

- 헤더 `설정` 버튼 왼쪽에 `마이페이지` 버튼(`#btn-mypage`).
- 홈 이번 주 카드 아래 `기록 더 보기 →`(`#week-more`).
- 홈의 **오늘 복습 카드**(아래)의 `복습하러 가기 →`.
- 마이페이지 위에는 `← 홈`과 언어 선택(홈과 같은 상태 공유).

## 화면 (`#mypage`, 위에서부터)

### 1. 레벨 카드

- 표본 기준: 그 언어로 **리포트까지 끝낸 세션 3개 이상** 그리고 **학습자 발화 15개 이상**.
- 기준을 채우면: `지금 레벨 <초급|중급|고급>` + `최근 세션들에서 가장 많이 나온 판정이에요`. 값은 `db.stable_level(language)`(봇의 i+1 조절이 쓰는 값과 같다). `stable_level`이 None이면 기준 미달과 같게 취급.
- 못 채우면: `판정하기엔 아직 일러요` + `세션 <n>/3 · 발화 <m>/15`(각각 목표를 넘으면 목표로 표시하지 않고 실제 수).

### 2. 오늘의 복습

- 제목 줄: `오늘의 복습 <N>개` + 오른쪽 작은 글씨 `익힌 문장 <K>개`.
- 카드(오늘 할 것만, 오래된 순, 최대 20):
  - `내가 한 말`: 원래 문장(취소선), `고친 문장`: `fixed`(굵게), 태그 칩, 교정 설명(`correction`)은 `▸ 설명` 펼치기.
  - 버튼: `▶ 듣기`, `🎤 말해보기`, `다음에`.
  - `▶ 듣기`: `POST /api/review/{id}/audio`로 `fixed`의 음성 키를 받아 재생. 기다리는 동안 버튼 글자 `음성 준비 중...`.
  - `🎤 말해보기`: 세션 화면의 `고쳐서 다시 말해보기`와 **같은 흐름과 판정**(`session.startRespeak`, Whisper 최종 받아쓰기, `match.matches` 0.9). 결과 줄에 `듣는 중...` → `받아쓰는 중...` → 결과.
    - 통과: `POST /api/review/{id}/result {"result": "pass"}` → 카드에 `좋아요! <다음 복습 날짜 안내>` 후 1.5초 뒤 카드가 목록에서 빠진다. 3번째 통과면 `익혔어요 🎉`.
    - 실패: `{"result": "fail"}` → `조금 달라요. 내일 다시 볼게요` + 다시 말해볼 수 있게 버튼은 그대로.
    - 못 알아들음: 서버에 아무것도 보내지 않는다(`못 알아들었어요. 다시 해보세요`).
  - `다음에`: `{"result": "skip"}` → 카드가 빠진다.
- 없으면: `오늘 복습할 문장이 없어요` + (한 번도 틀린 적이 없으면) `대화에서 고친 문장이 여기 모여요`.

**간격 규칙** (`db.record_review(review_id, result, today)`):

| 결과 | passes | interval_d | due_date |
|---|---|---|---|
| pass | +1 | 1→3→7→14 (다음 단계, 14에서 멈춤) | today + 새 interval |
| pass로 passes가 3 | 3 | 그대로 | `mastered_at` = 지금, 목록에서 빠짐 |
| fail | 0으로 되돌림 | 1 | today + 1 |
| skip | 그대로 | 그대로 | today + 1 |

### 3. 자주 걸리는 것

- 한 줄: `문장 정확도 <p>% · 최근 30일 채점된 <n>문장` (채점된 = 대본이 아닌 세션의 학습자 발화 중 `ok`가 NULL이 아닌 것). n이 0이면 줄을 숨긴다.
- 막대그래프: 그 언어의 `ok = 0` 발화 태그별 횟수(`없음`·NULL 제외), 많은 순. 막대 폭 = 횟수/최댓값. 각 줄 `<태그>  <n>회`. 없으면 `아직 틀린 문장이 없어요`.
- 태그 오분류(~10%)가 있으므로 누적 카운트로만 쓴다(원래 설계).

### 4. 지난 기록

- 리포트까지 끝낸 세션, 최신순 20개씩, `더 보기`로 다음 20개.
- 줄: `<날짜(M월 D일)> · <제목> · <모드 이름>` / 작은 글씨 `말한 문장 <t> · 고친 곳 <w>`(대본 모드는 `고친 곳` 대신 `대본`).
- 누르면 그 줄 아래가 펼쳐진다: `리포트 보기` `대화 보기`.
  - `리포트 보기`: 리포트 화면(`#report`)을 그 세션 데이터로 다시 그린다(`renderReport`). 리포트 화면에 `← 마이페이지` 버튼(`#btn-report-back`)이 보인다(마이페이지에서 열었을 때만). 옛날 산문 리포트(JSON이 아님)는 총평 한 칸으로 보여준다.
  - `대화 보기`: 펼친 자리 안에 대화 목록(봇/나 번갈아), 내 줄 아래 교정이 있으면 `→ <fixed>`.
  - 불러오는 동안 펼친 자리에 `불러오는 중...`.

## 홈에 더하는 것: 오늘 복습 카드

- 추천 카드 아래(약점 한 줄 위): `오늘 복습할 문장 <N>개` + 첫 문장 `fixed`와 `▶ 듣기` + `복습하러 가기 →`.
- N이 0이면 숨긴다. 좁은 화면 순서는 추천 바로 다음.
- 데이터는 `/api/stats/home`의 `review: {"due": N, "first": {"id", "fixed"} | null}`.

## 데이터

### `review_queue` (스키마 v5 → v6)

```sql
CREATE TABLE IF NOT EXISTS review_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER NOT NULL UNIQUE,
    language     TEXT    NOT NULL,
    due_date     TEXT    NOT NULL,          -- 로컬 YYYY-MM-DD
    interval_d   INTEGER NOT NULL DEFAULT 1,
    passes       INTEGER NOT NULL DEFAULT 0,
    mastered_at  TEXT,
    created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_queue(language, mastered_at, due_date);
-- 지금까지 고친 문장을 오늘 복습으로 (대본 세션 제외: 그 세션의 교정은 이미 비웠다)
INSERT OR IGNORE INTO review_queue (message_id, language, due_date, interval_d, passes, created_at)
SELECT m.id, s.language, date('now', 'localtime'), 1, 0, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
  FROM messages m JOIN sessions s ON s.id = m.session_id
 WHERE m.speaker = 'user' AND m.ok = 0 AND m.fixed IS NOT NULL AND m.fixed <> '' AND s.mode <> 'script';
```

- 원래 설계의 `passed`/`due_at`은 이름을 바꿨다(날짜만 필요하고, 통과 **횟수**다).
- `due_date`는 로컬 날짜 문자열 -- 복습은 "오늘"이 로컬 자정에 바뀌어야 한다(`home_stats`와 같은 이유).

### 넣는 시점

- `/api/chat`에서 학습자 메시지를 저장한 뒤, 피드백이 `ok is False`이고 `fixed`가 비어 있지 않으면 `db.enqueue_review(message_id, language, due=today+1)`. 구두점만 달라 중립 처리된 턴(`ok` True)은 넣지 않는다.
- 되돌리기(`db.delete_last_turn`)는 지우는 메시지의 `review_queue` 행도 같은 트랜잭션에서 지운다.

## API

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/stats/mypage?language=` | `{level: {value: "beginner"\|…\|null, sessions, utterances, need_sessions: 3, need_utterances: 15}, accuracy: {correct, graded}, tags: [{tag, n}], review: {due, mastered}}` |
| GET | `/api/review?language=` | `{items: [{id, text, fixed, correction, tag, created_at}]}` (오늘 할 것, 최대 20) |
| POST | `/api/review/{id}/result` `{result: "pass"\|"fail"\|"skip"}` | `{id, passes, interval_d, due_date, mastered}`; 없는 id 404, 이미 익힌 것 409, 잘못된 값 422 |
| POST | `/api/review/{id}/audio` | `{audio_key: str\|null}` (`fixed`를 합성, TTS 실패는 null → 브라우저 음성) |
| GET | `/api/sessions/history?language=&offset=0&limit=20` | `{items: [{id, ended_at, title, mode, turns, wrong}], more: bool}` |
| GET | `/api/sessions/{id}/report` | `{summary, weak_points, expressions, next_focus, level, stats, mode}` -- 저장된 JSON + `db.session_stats` + `active_minutes`; 산문 리포트는 `summary`에 원문; 리포트 없는 세션 404 |
| GET | `/api/stats/home` (필드 추가) | `review: {due, first: {id, fixed} \| null}` |

`/api/sessions/history`는 FastAPI 경로 순서상 `/sessions/{session_id}`보다 **먼저** 등록한다(`/sessions/resumable`과 같은 이유).

## 화면 구성 (정적 파일)

- `static/index.html`: 헤더 `#btn-mypage`; 새 섹션 `#mypage`(`#btn-mypage-home`, `#mypage-language-seg`, `#level-card`, `#review-section`(`#review-count`, `#review-mastered`, `#review-list`), `#weak-section`(`#accuracy-line`, `#tag-bars`), `#history-section`(`#history-list`, `#btn-history-more`)); 홈 `#review-home`(`#review-home-count`, `#review-home-first`, `#review-home-play`, `#review-home-go`), `#week-more`; 리포트 `#btn-report-back`.
- `static/js/mypage.js` (새): `openMypage()`, `renderLevel`, `renderReview`, `speakReview(item, card)`, `renderTags`, `loadHistory(append)`, `openReport(sessionId)`, `openTranscript(sessionId, slot)`.
- `static/js/session.js`: `startRespeak(target, resultEl, btn, onResult?)` -- 끝났을 때 `onResult(good: boolean, spoken)`, 못 알아들었으면 `onResult(null, null)`. 기존 호출은 그대로.
- `static/js/home.js`: 오늘 복습 카드 그리기.
- `static/js/main.js`: 라우터 `mypage` 등록, 버튼·위임 연결.
- `static/css/components.css`: 레벨 카드, 복습 카드, 태그 막대, 기록 줄, 홈 복습 카드. 좁은 화면 한 줄.

## 로딩

- 섹션마다 첫 그리기 전 `불러오는 중...`.
- `▶ 듣기`: `음성 준비 중...`. `🎤 말해보기`: `듣는 중...` → `받아쓰는 중...`(기존 respeak 문구).
- 기록 `더 보기`: 버튼 글자 `불러오는 중...`, 펼친 줄: `불러오는 중...`.
- 요청 시점 언어를 잡고, 늦게 온 다른 언어 응답은 버린다.

## 테스트

### pytest

- 마이그레이션 v6: 새 DB·v5 DB 모두 테이블, 기존 고친 문장 백필(대본 세션·`ok` 1·`fixed` 없음 제외), 두 번 돌려도 중복 없음.
- `enqueue_review`: 중복 무시. `/api/chat`: 교정 턴은 내일로 들어감, 중립 처리 턴·맞은 턴은 안 들어감.
- `delete_last_turn`이 복습 행도 지움.
- `due_reviews`: 오늘 이전·오늘만, 익힌 것 제외, 언어 분리, 오래된 순, 20개 상한.
- `record_review`: 표의 모든 줄(1→3→7→14→14, 3번째 통과 익힘, 실패 초기화, skip), 익힌 것에 다시 기록하면 오류.
- `/api/stats/mypage`: 레벨 기준 미달/충족, 정확도 30일 경계·대본 제외, 태그 정렬·없음 제외, 복습 수.
- `/api/review*`: 404/409/422, 오디오 TTS 실패 null.
- `/api/sessions/history`: 리포트 있는 것만, 최신순, offset/limit/more, 제목(시나리오·라이브러리·주제·기본), 대본 모드 wrong.
- `/api/sessions/{id}/report`: JSON 리포트, 산문 리포트, 리포트 없음 404. 경로 순서(`history`가 id로 먹히지 않음).
- `/api/stats/home`의 `review`.

### node

- 헤더 버튼 → `#mypage`, `← 홈`, 언어 전환 시 다시 불러오기, 늦은 응답 무시.
- 레벨 카드 두 상태 문구.
- 복습 카드: 듣기(음성 준비 중 → 재생), 말해보기 통과/실패/못 알아들음 → 결과 요청과 문구, 통과 뒤 카드 제거, 익힘 문구, 다음에, 빈 상태.
- `startRespeak`의 `onResult` 콜백(통과, 실패, 못 알아들음), 기존 칩 경로는 콜백 없이 그대로.
- 정확도 줄·막대 폭·빈 상태.
- 기록: 줄 모양, 더 보기(append, more false면 버튼 숨김), 리포트 보기 → `#report` + 뒤로 버튼, 대화 보기.
- 홈 오늘 복습 카드: 0이면 숨김, 듣기, 가기 → 마이페이지.

## 범위 밖

- 레벨 추이 그래프, 태그별 문장 목록 필터.
- 복습 알림.
- 대본 세션의 읽기 정확도 기록.
