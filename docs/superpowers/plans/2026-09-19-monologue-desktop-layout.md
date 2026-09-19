# 데스크톱 화면 구조 — 계획

스펙: `docs/superpowers/specs/2026-09-19-monologue-desktop-layout-design.md`. 시안: `static/mock/*.html` + `mock.css`
(8010에서 `/mock/index.html`로 볼 수 있다). 워크트리 `C:/git/Monologue-wt/desktop`, 브랜치 `desktop`.

## 모든 작업 공통

- 시안은 **배치·위계·크기감**의 기준이다. 시안 속 문구·숫자는 가짜다. 실제 데이터가 없는 칸(시안의 소리 모양 파형,
  목표 문장의 한국어 뜻, 타일의 "7/12줄에서 멈춤" 같은 가짜 진행, "2주 뒤 다시" 추천일)은 **만들지 않는다**.
- 기존 id·이벤트 연결·`inert`/`aria-hidden` 규칙·스켈레톤·자리 예약·opacity 페이드는 유지한다. 기존 테스트는 고치지 않고 통과해야 한다.
  테스트가 배치(부모 구조)를 전제해서 깨지면, 그 테스트가 지키려던 동작을 새 구조에서 지키도록 바꾸고 보고서에 이유를 적는다.
- 색은 `tokens.css` 토큰만. 새 크기 값은 토큰(`--content-w: 1200px` 등)으로. transform 애니메이션 금지. 학습자 말 취소선 금지.
- 900px 아래에서는 한 줄(지금 모바일 배치와 같은 순서). 480px 규칙(모드 2×2 등)은 유지.
- dom-shim 함정: `children`은 브라우저에서 HTMLCollection이다(`Array.from`), 셀렉터 엔진 없음, `closest()`는 null, SVG는 `createElementNS` + `setAttribute('class')`.
- CSS 테스트는 `\r\n`을 정규화해서 읽는다(메인 트리는 autocrlf).
- 테스트: `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/git/Monologue/venv/Scripts/python.exe -m pytest -m "not engine" -q -p no:cacheprovider`
  와 `node --test --test-force-exit static/js/*.test.js`. 새 테스트는 일부러 부숴서 빨갛게 되는지 확인(자기 단언으로 실패).
- 커밋 메시지 형식: `feat: …`/`fix: …` 소문자 영어 한 줄, 끝에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: 공통 틀 + 홈 C

시안: `static/mock/home-c.html`.

**서버** (`app/api.py` `/stats/home`, 테스트 `tests/test_api_home*.py` 쪽에 추가):
- `target`: `top_tags[0]`(3회 이상 규칙 그대로)가 있으면 그 태그로 틀린 가장 최근 문장 하나
  `{tag, text, fixed}`(`db.wrong_tag_counts`의 examples[0]과 같은 규칙, 또는 그 함수를 재사용), 없으면 `null`.
- `accuracy`: 마이페이지와 같은 창(`db.accuracy_since(language, today - (_ACCURACY_DAYS-1)일)`) 그대로.

**화면** (`static/index.html` `#home`, `home.js`, `components.css`, `base.css`, `tokens.css`):
- `main` 최대 너비를 `--content-w`(1200px)로. 다른 화면의 기존 640px 한 줄 규칙은 이 작업에서 건드리지 않는다(각자 자기 작업에서).
- 맨 위 인사줄(날짜·인사·언어 전환)은 그대로 한 줄.
- **히어로**(한 칸 전체): 왼쪽 `#today-card`를 크게 — 라벨 `오늘의 추천`, 제목 크게, 상황들을 칩으로, reason, 시작 버튼들
  (지금의 script/free 버튼과 `대본 준비 중` 규칙 그대로), `#today-alt`(다른 추천)는 히어로 안 아래줄. 오른쪽 **목표 문장 패널**
  (`#home-target`): `오늘의 목표 문장` + `초점: {tag}` + fixed 문장 크게 + `▶ 들어 보기`(`#review-home-play`가 쓰는 같은 재생 경로/함수를
  재사용; 버튼 글자 바뀔 때 폭 고정 `btn-stable`). `target`이 null이면 패널 없이 히어로가 한 칸 전체. 로딩 중에는 자리 스켈레톤.
  `#recommend` 줄(“요즘 X에서 자주 걸립니다”)은 목표 문장 패널이 대신하므로 패널이 있을 때는 숨긴다(없을 때도 숨김 — 같은 정보).
- **아래 두 칸**: 왼쪽 `연습 방법` 타일 5개(`#modes` `.mode` 버튼, data-mode 유지) — 아이콘(시안의 인라인 SVG, `currentColor`)·이름·설명,
  자유 상황극/스크립트 두 개는 넓게(시안처럼 2+3). 타일 아래 `최근 테마`(`#recent-themes-wrap`) 3열 격자. 타일의 "최근 …" 줄은
  `recent_themes`에 그 모드 항목이 있을 때만 그 제목을 쓴다(없으면 줄 없음, 자리는 타일 높이로 고정).
- 오른쪽 열(`.home-aside`, 약 360px): `#resume-card` → **내 상태**(`#week-card`를 바꿈: 이번 주 목표 링 SVG(goal 대비 done, 정적 도형),
  옆에 레벨(`/level-test/latest`의 cefr·step과 IELTS 또는 JF 한 줄; 테스트가 없으면 `레벨 테스트 전`), 요일 점(기존 week-days),
  연속·정확도(`accuracy`의 퍼센트; 채점 문장이 없으면 `—`) 두 숫자, 목표 −/+ 와 `기록 더 보기 →` 유지) → `#review-home` → 레벨 테스트 카드
  (`#leveltest-home`: 테스트가 없으면 지금 문구+시작, 있으면 `지난 테스트 {날짜} · {cefr} {step}` + `결과 보기`(마이페이지에서 결과 여는 것과 같은 경로) + `다시 테스트`).
  분당 단어는 이 화면에 넣지 않는다(추가 요청이 필요해서).
- 900px 아래: 히어로 → 목표 문장 → 오른쪽 열 카드들 → 모드 → 최근 테마 순 한 줄(지금 모바일 순서와 비슷하게, 이어서 하기가 위).
- 기존 `no-aside`/`syncAside` 규칙: 오른쪽 열에 보일 것이 없을 때 빈 트랙이 남지 않게 그대로 동작해야 한다.
- 테스트: 서버 `target`/`accuracy`(태그 3회 미만이면 null, 가장 최근 문장), home.test.js에 목표 문장 패널 유무, 레벨 줄(테스트 있음/없음),
  링 비율, 타일 최근 줄(있음/없음), CSS 테스트로 `--content-w`와 900px 규칙.

### Task 2: 마이페이지 B

시안: `static/mock/mypage-b.html`.

- `#mypage`: 왼쪽 세로 메뉴(약 240px, 화면 스크롤에도 위에 붙음 `position: sticky`) — 제목 `마이페이지`, 언어 전환, `#level-card`(레벨 줄과
  버튼들), 그 아래 세로 탭 `성장 · 복습(n) · 약점 · 기록`. 오른쪽 넓은 내용.
- 탭 4개: 새 `#tab-growth`(data-tab="growth", 기본 선택)와 `#growth-section`(tabpanel). 지금의 `#growth-card` 요약 + `#growth-details`
  내용을 이 패널에서 **펼쳐진 채로** 보여 준다(자세히 보기 접기 없음: `#btn-growth-more`와 fold 제거, 차트는 패널이 처음 보일 때 그림).
  탭 기억(`rememberedTab`)은 growth를 포함, 저장값이 없으면 growth. 방향키 이동은 세로 탭이므로 위/아래도(좌/우 유지).
  `openMypage({tab})` 호출부(홈 `기록 더 보기`, 복습하러 가기 등)는 지금처럼 원하는 탭을 연다.
- 성장 패널 배치: 위 숫자 요약 줄, 달력(넓게), 정확도·말하기 차트 두 칸, 레벨 테스트 기록. 차트 폭은 패널 폭 기준(`growthWidth`).
- 복습·약점·기록 패널은 내용 그대로, 넓어진 폭에 맞춰 복습 카드 2열 가능하면 2열(카드 높이 튐 없이), 약점은 코치 + 태그 막대 두 칸.
- 900px 아래: 메뉴가 위로 올라가고 탭은 가로 한 줄(지금 모양).
- 테스트: mypage.test.js 탭 4개·기본 growth·키 이동, growth.test.js, CSS 테스트.

### Task 3: 테마 고르기

시안: `static/mock/pick.html`.

- `#pick`: 위 머리줄 그대로. 아래 두 칸 — 왼쪽 분류 탭 + 테마 격자(넓으면 3~4열), 오른쪽 고정 패널(sticky, 약 360px):
  선택한 테마 이름/상황(pick.js가 이미 아는 선택 상태로), 1분 말하기의 `#pick-questions`, `#wish-box`, `#btn-start`, `#start-status`.
  선택 전에는 패널에 안내 한 줄(자리 고정). 900px 아래 한 줄(지금 순서).
- 테스트: pick.test.js 선택 → 패널 이름 갱신, CSS 테스트.

### Task 4: 연습 화면 — 대화 세션 · 쉐도잉 · 1분 말하기 · 레벨 테스트

시안: `session.html`, `shadowing.html`, `timed.html`, `leveltest.html`.

- 세션: `.session-grid` 최대 너비를 `--content-w`로, 대화 열 넓게 + 오른쪽 패널 360px, 마이크 독은 대화 열 아래 폭에 맞춤.
- 쉐도잉: 같은 격자에서 한 줄 카드 크게(글자 크기 키움, 자리 고정 유지), 오른쪽 패널은 지금 패널 내용(대본 목록·진행).
- 1분 말하기: `#timed` 넓게 — 녹음·준비 단계는 카드 + 옆 질문 패널(`.timed-head`를 옆 칸으로), 결과(`#timed-review`)는
  문장 목록 | 원어민이라면 두 칸. 단계 전환에 카드 높이 튐 없음 유지.
- 레벨 테스트: 시험 단계는 가운데 카드(최대 720px) 그대로, 결과(`#lt-result-body`)만 넓게 두 칸(레벨·환산 | 난이도별 막대·평).
- 900px 아래 지금 배치. 테스트: 각 모듈 테스트 통과, CSS 테스트로 격자 규칙.

### Task 5: 리포트 · 설정

시안: `report.html`, `settings.html`.

- 리포트: 최대 너비 `--content-w`, 고친 곳 줄을 내 말 | 고친 문장 두 칸(학습자 말 취소선 없음 — `.fix-row .said`의 line-through 제거),
  오른쪽 숫자 패널 그대로. 900px 아래 한 줄.
- 설정 대화상자: 넓게(약 760px) 두 칸 — 왼쪽 `화면`(`#screen-prefs`), 오른쪽 언어·음성·읽기 보조(`#lang-sections` 높이 고정 규칙 유지).
  작은 화면은 한 칸.
- 테스트: settings.test.js, CSS 테스트(취소선 없음 포함).
