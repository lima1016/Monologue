# Monologue — 홈 대시보드 설계

- 날짜: 2026-09-14
- 상태: 사용자 승인("추천대로 다 넣어서 쭉 진행")
- 선행: 테마 라이브러리(`a75f96c`) -- 홈은 모드 카드만 남아 허전하다(사용자)

## 원칙

- **홈 = 오늘 뭘 할지 정하고 바로 시작하는 곳.** 돌아보는 것(레벨, 약점 그래프, 복습 목록, 세션 하나하나의 기록)은 마이페이지(Phase 2 D)의 몫이다.
- 사용자 규칙: 오래 걸릴 수 있는 대기는 화면에 무엇을 하는 중인지 보여준다.

## 화면 구성

데스크톱 2칸(왼쪽 본문, 오른쪽 곁칸), 좁은 화면(720px 이하)은 한 줄로 쌓는다.

```
왼쪽                                           오른쪽
- 날짜, 인사, 언어 선택                         - 이어서 하기 (지금과 같음)
- 오늘의 추천 (큰 카드 1 + 대안 한 줄)           - 이번 주 (7칸 달력, 연속 학습일, 목표 진행률)
- 약점 한 줄 (지금의 #recommend, 추천 아래로)
- 모드 카드 3개 (지금과 같음)
- 최근 테마 (최대 4)
- 대본 준비 상태 줄 (라이브러리가 덜 찼을 때만)
```

좁은 화면 순서: 추천 → 이어서 하기 → 이번 주 → 약점 한 줄 → 모드 → 최근 테마 → 준비 상태 줄.
(CSS grid 영역으로 배치한다. DOM 순서를 두 번 쓰지 않는다.)

**없어지는 것:** "내 기록" 패널(`#home-stats`: 연속 학습일·최근 7일 발화·고친 표현)과 "최근 연습" 목록(`#home-recent`). 연속 학습일은 이번 주 카드로 옮기고, 나머지 숫자와 세션 목록은 마이페이지에서 다시 쓴다. `/api/stats/home`의 기존 필드는 그대로 둔다(마이페이지가 쓸 수 있게).

### 1. 오늘의 추천

- 큰 카드: 테마 이름, 세부 상황 요약(` · `로 이어서 앞 3개), 추천 이유 한 줄, 버튼 `스크립트로 시작` `자유 대화로 시작`. 준비 안 된 모드의 버튼은 `disabled` + 이유(`대본 준비 중`).
- 아래 한 줄: `또는: <테마 이름> →` (누르면 그 테마를 큰 카드와 바꿔 보여준다 -- 시작하지 않는다).
- 버튼을 누르면 테마 선택 화면(`#pick`)으로 가서 그 모드·테마를 고른 채 **바로 시작**한다. 단계 문구는 테마 화면의 기존 `#start-status`가 보여준다(`대본 고르는 중...` → `음성 준비 중...` / `첫 대사 만드는 중...`).
- 추천할 테마가 하나도 없으면(라이브러리가 비어 있음) 카드 대신 `새 대본을 준비하고 있어요. 그동안 직접 만들기나 수업으로 연습해 보세요.`

**고르는 규칙** (`library.recommend(language, today, rng_seed)`):

1. 후보 = 그 언어에서 준비된 테마(대본 1편 이상 또는 자유 설정 있음).
2. 테마별 마지막 연습 = 그 테마의 라이브러리 id(`lib-<theme>-<language>-…`)로 시작한 세션의 가장 최근 `started_at`.
3. 한 번도 안 한 테마가 있으면 그중에서, 없으면 마지막 연습이 가장 오래된 순으로 앞쪽 절반(최소 1개)에서.
4. 가장 최근에 한 라이브러리 세션의 분류와 **다른 분류**를 우선한다(그런 후보가 있을 때만).
5. 그 안에서 `random.Random(f"{today}:{language}")`로 고른다 -- **같은 날에는 같은 추천**. 대안은 같은 규칙으로 큰 카드와 다른 분류에서 하나(없으면 같은 분류에서, 그것도 없으면 없음).
6. 이유 문구: 안 해본 테마 `아직 안 해본 테마예요`, 오늘 했으면 `오늘도 한 번 더 해볼까요?`, 어제 `어제 연습했어요`, 그 밖 `<N>일 전에 마지막으로 했어요`(로컬 날짜 기준).

### 2. 약점 한 줄

지금의 `#recommend`(`요즘 <태그>에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`)를 추천 카드 아래로 옮긴다. 조건·문구는 그대로.

### 3. 이번 주 카드

- 7칸 달력: 이번 주 **월~일**(로컬). 칸마다 요일 한 글자(`월화수목금토일`). 연습한 날(그날 학습자 메시지가 있음) = 채운 점, 오늘 = 테두리, 미래 = 흐리게.
- `연속 <N>일` (기존 `streak` 그대로. 0이면 줄을 숨긴다).
- 목표 진행률: `이번 주 <n>/<goal> 세션` + 막대. n = 이번 주(월요일 0시 로컬 이후) **리포트까지 끝낸** 세션 수(그 언어). 막대는 `min(n/goal, 1)`, 목표를 넘으면 `목표 달성!`을 덧붙인다.
- 목표 조절: `−` `+` 버튼, 1~14, 기본 5. 누르면 바로 화면을 바꾸고 `POST /api/settings/weekly-goal`로 저장. 실패하면 되돌리고 `notify('목표를 저장하지 못했어요')`. 목표는 언어와 무관한 하나의 설정.

### 4. 최근 테마

- 최대 4개. 그 언어의 라이브러리 세션을 최신순으로 훑어 **테마당 하나**(가장 최근 세션의 모드). 카드: 테마 이름 + 모드 이름(`스크립트`/`자유 상황극`).
- 누르면 추천 카드 버튼과 같은 경로로 그 모드·테마를 바로 시작(새 대본).
- 하나도 없으면 영역을 숨긴다.

### 5. 대본 준비 상태 줄

- 그 언어의 저장된 대본 수 < 목표(`테마 수 × config.LIBRARY_PER_THEME`)일 때만: `새 대본 준비 중 · <n>/<target>편`.
- 홈을 열 때 한 번 읽는다(실시간 갱신 없음 -- 새로고침·언어 전환 때 다시 읽는다).

### 6. 빈 상태 (그 언어의 세션이 하나도 없음)

- 인사 대신 `첫 연습을 시작해 보세요`.
- 이번 주 카드와 최근 테마는 숨긴다(곁칸이 비면 기존 `no-aside` 규칙으로 한 칸).
- 추천 카드는 그대로(이유는 전부 `아직 안 해본 테마예요`).

### 7. 로딩

- 홈 데이터(`/api/stats/home`)를 기다리는 동안 추천 카드 자리에 `오늘의 추천 불러오는 중...`(점 애니메이션). 실패하면 추천 카드를 숨기고 모드 카드는 그대로 쓸 수 있다.
- 추천·최근 테마에서 시작하면 테마 화면의 기존 단계 문구가 보인다. 테마 화면이 테마를 불러오는 동안은 기존 `테마 불러오는 중...`.

## API

### `GET /api/stats/home?language=` (필드 추가)

```json
{
  "...기존": "streak, week_turns, fixed_total, top_tags, recent",
  "has_history": true,
  "week": {"days": [{"date": "2026-09-14", "label": "월", "practiced": true, "today": true, "future": false}],
           "sessions": 3, "goal": 5},
  "recommend": [{"theme_id": "hotel", "title": "호텔", "category": "travel",
                 "situations": ["체크인", "방 문제 알리기", "짐 맡기기", "체크아웃 연장"],
                 "reason": "아직 안 해본 테마예요", "ready": {"free": true, "script": 12}}],
  "recent_themes": [{"theme_id": "cafe-restaurant", "title": "카페·음식점 주문", "mode": "script"}],
  "library": {"scripts": 312, "target": 600}
}
```

- `week.days`는 항상 7개(월~일). `recommend`는 0~2개(첫째가 큰 카드).
- `has_history`: 그 언어의 세션이 하나라도 있으면 true.

### `POST /api/settings/weekly-goal` `{"goal": int}`

1~14가 아니면 422. 응답 `{"goal": n}`. 설정 키 `weekly_goal`.

## 서버 구성

- `app/db.py`: `practice_days(language, start, end) -> set[str]`(로컬 날짜 문자열), `sessions_completed_since(language, start_local_iso) -> int`, `library_sessions(language, limit=50) -> list[{scenario_id, mode, started_at}]`(최신순), `library_script_count(language) -> int`, `has_sessions(language) -> bool`.
- `app/library.py`: `theme_of(scenario_id) -> str | None`(`lib-<theme>-<lang>-<nn|free>`에서 theme; 테마 id에 `-`가 들어 있으므로 뒤에서 두 조각을 뗀다), `recommend(language, today: date, *, seed=None) -> list[dict]`, `reason_for(last_started_local_date, today) -> str`.
- `app/api.py`: `home_stats` 라우트가 새 필드를 붙이고, 목표 설정 라우트를 더한다. 주의 시작(월요일)과 "오늘"은 로컬 시간(기존 `home_stats`와 같은 이유, 그 docstring 참고).

## 화면 구성 (정적 파일)

- `static/index.html`: `#home-stats`, `#home-recent` 삭제. 새 요소: `#today-card`(추천), `#today-alt`, `#week-card`(`#week-days`, `#week-streak`, `#week-progress`, `#week-bar`, `#goal-minus`, `#goal-plus`, `#goal-value`), `#recent-themes`, `#library-progress`. `#recommend`는 추천 카드 아래로.
- `static/js/home.js`: `loadHome`이 새 필드를 그린다(`renderToday`, `renderWeek`, `renderRecentThemes`, `renderLibraryProgress`). 기존 규칙(요청 시점 언어를 잡고 늦게 온 응답 버리기, 실패해도 시작은 막지 않기, `syncAside`) 유지.
- `static/js/pick.js`: `startTheme(mode, themeId)` -- `openPick(mode)`를 기다리고, 그 테마의 분류 탭을 고르고, 테마를 고르고, `startFromPick()`. 바쁘면(`isBusy()`) 아무것도 하지 않는다.
- `static/css/components.css`: 추천 카드, 이번 주 카드(점 7개, 막대), 최근 테마 카드, 준비 상태 줄, 좁은 화면 grid 영역 순서. 정의된 토큰만.

## 테스트

### pytest

- `practice_days`: 로컬 날짜 경계(자정), 언어 분리.
- `sessions_completed_since`: 리포트 없는 세션 제외, 월요일 0시 경계, 언어 분리.
- `library.theme_of`: `lib-cafe-restaurant-ja-07` → `cafe-restaurant`, `lib-hotel-en-free` → `hotel`, 내장·사용자 id → None.
- `recommend`: 안 해본 테마 먼저 / 다 했으면 오래된 쪽 / 직전 분류 피하기(대안 있을 때만) / 같은 날 같은 결과, 다른 날 달라질 수 있음(시드) / 준비 안 된 테마 제외 / 빈 라이브러리 → [] / 대안은 다른 분류 우선.
- `reason_for`: 없음·오늘·어제·N일.
- `/api/stats/home` 새 필드 모양, `week.days` 7개·월요일 시작·오늘 표시, `recent_themes` 테마당 하나·최대 4, `library` 수, `has_history`.
- `/api/settings/weekly-goal`: 저장, 0·15 → 422, 기본 5.

### node

- 로딩 중 `오늘의 추천 불러오는 중...`, 응답 뒤 추천 카드, 늦게 온 다른 언어 응답 무시.
- 추천 카드: 이유, 준비 안 된 모드 버튼 비활성, `또는:` 누르면 카드가 바뀌고 시작하지 않음, 시작 버튼이 `startTheme(mode, themeId)`를 부름.
- 빈 라이브러리 문구, 빈 상태(인사 문구, 이번 주·최근 테마 숨김).
- 이번 주: 점 7개(연습한 날·오늘·미래 클래스), 연속 0이면 숨김, 진행 문구·막대 폭, 목표 달성 문구, `−`/`+` 경계(1, 14), 저장 실패 시 되돌림+문구.
- 최근 테마: 최대 4, 누르면 `startTheme`.
- 준비 상태 줄: 목표 미만일 때만.
- `startTheme`: 다른 분류의 테마도 그 탭을 골라 시작, 바쁠 때 무시, 단계 문구가 테마 화면에 보임.

## 범위 밖

- 오늘의 표현(지난 교정 문장 듣기) -- 마이페이지의 복습 목록과 함께.
- 테마 추가(20개 유지, 사용자 결정).
- 레벨·약점 그래프·세션 기록 -- 마이페이지.
