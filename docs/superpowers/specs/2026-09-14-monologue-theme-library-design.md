# Monologue — 테마 라이브러리 · 16줄/16턴 · 로딩 표시 설계

- 날짜: 2026-09-14
- 상태: 사용자 승인(설계 + 홈 흐름 수정: 모드 먼저, 그 안에서 테마)
- 묶은 항목: Phase 2 다음 순서 5번(대본 상황 다양화)
- 선행: 원어민 표현(`8110277`), 데이터 정리 완료

## 왜

- 사용자: "스크립트가 매번 똑같네". 내장 대본이 언어당 **하나**뿐이다(`standup-meeting-en`, `office-greeting-ja`).
- 사용자: "자유 대화든 스크립트든 왜 이렇게 짧아?" -- 대본 8줄, 자유 대화 8턴.
- 사용자 규칙: **오래 걸리는 로딩은 반드시 화면에 무엇을 하는 중인지 알린다.**

## 실측 (2026-09-14, RTX 4060 Ti, qwen2.5:14b, 게임 끈 상태)

| | 생성 | 음성 | 합계 |
|---|---|---|---|
| 대본 8줄 | 6.6~7.4초 | 2.7~5.9초 | 9.4~13.3초 |
| 대본 16줄 | 11.1~12.9초 | 5.8~10.2초 | 17.3~23.1초 |

- 모델 속도 약 30 tok/s. **게임이 GPU를 쓰면 3.6~4.8 tok/s로 떨어진다**(같은 대본 26초, 스키마 강제 54초).
- 대본 텍스트 약 1.1KB/편, 음성 평균 96KB/줄.
- 16줄을 요청해도 15줄이 나온 경우가 있었다 -- 검사 필수.

## 결정 (사용자)

- 테마 **20개**, 테마당 언어별 **30편**, 대본 **16줄** → 1,200편.
- 음성은 **B안: 필요할 때 합성**(테마를 고르는 순간 뒤에서 시작, 한 번 합성하면 캐시).
- 자유 대화도 같은 테마, **16턴**.
- 사용자가 직접 상황을 만들 수 있다(기존 "상황 만들기" 유지).
- 홈은 **모드 선택**, 모드에 들어가면 **테마 선택**.

## 테마 20개

`data/themes.json`. 필드: `id`, `category`(`daily`·`travel`·`smalltalk`·`business`), `title`(한국어), `situations`(한국어 세부 상황 목록).

| category | id | title | situations |
|---|---|---|---|
| daily | cafe-restaurant | 카페·음식점 주문 | 메뉴 추천 묻기, 주문이 잘못 나옴, 포장 주문, 알레르기 확인 |
| daily | shopping | 쇼핑·계산 | 사이즈 찾기, 교환·환불, 할인 묻기, 카드 결제 오류 |
| daily | clinic-pharmacy | 병원·약국 | 접수하기, 증상 설명하기, 처방약 복용법 묻기 |
| daily | bank-post-office | 은행·우체국·관공서 | 계좌 개설, 택배 보내기, 서류 발급 |
| daily | home-neighbors | 이웃·집 문제 | 소음 이야기, 수리 기사 부르기, 택배 대신 받아주기 |
| travel | airport-flight | 공항·기내 | 체크인, 좌석 변경, 짐 분실, 기내 요청 |
| travel | hotel | 호텔 | 체크인, 방 문제 알리기, 짐 맡기기, 체크아웃 연장 |
| travel | directions-transit | 길 찾기·대중교통 | 길 묻기, 표 사기, 환승, 택시 목적지 설명 |
| travel | sightseeing | 관광·예약 | 투어 예약, 입장권 사기, 사진 부탁, 추천 장소 묻기 |
| travel | travel-trouble | 여행 중 문제 | 분실물 신고, 몸이 아플 때, 예약 착오 |
| smalltalk | first-meeting | 처음 만난 사람과 인사 | 자기소개, 출신 이야기, 하는 일 |
| smalltalk | weekend-vacation | 주말·휴가 이야기 | 주말에 한 일, 휴가 계획, 추천하기 |
| smalltalk | hobbies | 취미·관심사 | 운동, 영화·드라마, 음식, 게임 |
| smalltalk | weather-life | 날씨·요즘 일상 | 날씨 이야기, 바쁜 근황, 가벼운 고민 |
| smalltalk | invitations | 초대·약속 잡기 | 식사 제안, 일정 조율, 정중하게 거절하기 |
| business | standup | 사무실 아침 대화·스탠드업 | 진행 상황 공유, 막힌 부분 말하기, 도움 요청 |
| business | meetings | 회의 | 의견 말하기, 반대 의견 내기, 일정 변경 |
| business | phone-email | 전화·이메일 응대 | 전화 받기, 메시지 남기기, 담당자 연결 요청 |
| business | clients | 거래처·손님 응대 | 회사 소개, 요구사항 확인, 가격 협의 |
| business | interview | 면접·자기소개 | 경력 설명, 강점 말하기, 면접관에게 질문하기 |

## 데이터

### 새 테이블 `library_scenarios` (스키마 v4 → v5)

`user_scenarios`와 같은 열 + `theme_id`, `situation`:

```sql
CREATE TABLE IF NOT EXISTS library_scenarios (
    id             TEXT PRIMARY KEY,
    theme_id       TEXT    NOT NULL,
    situation      TEXT,
    language       TEXT    NOT NULL,
    type           TEXT    NOT NULL,
    title          TEXT    NOT NULL,
    goal           TEXT,
    persona_prompt TEXT,
    max_turns      INTEGER,
    lines_json     TEXT,
    created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_theme ON library_scenarios(language, type, theme_id);
```

- id: 대본 `lib-<theme_id>-<language>-<nn>`(nn 01~30), 자유 대화 설정 `lib-<theme_id>-<language>-free`.
- 행 모양은 `scenarios.from_row`로 읽는다 -- 세션·리포트·이어하기·최근 연습은 `scenarios.get_scenario`가 라이브러리도 찾게만 하면 그대로 동작한다.
- 데이터는 DB에 있다(git에 없음). 생성 스크립트가 다시 만들 수 있다.

### 기존 내장 시나리오

`data/scenarios.json`의 6개는 **지우지 않는다**(지난 세션이 id를 참조). 테마 선택 화면에는 나오지 않는다. 자유 대화 `max_turns`는 16으로 올린다.

## 일괄 생성 스크립트 `scripts/build_library.py`

앱 밖에서 한 번 돌리는 운영 도구.

```
venv/Scripts/python.exe scripts/build_library.py [--language en|ja] [--theme ID ...] [--per-theme 30] [--dry-run]
```

- 테마 × 언어마다: 자유 대화 설정 1개(없을 때만) + 대본을 `--per-theme`편이 될 때까지.
- **이어하기:** 이미 저장된 편수를 세고 모자란 만큼만 만든다. 중간에 끊어도 다시 실행하면 이어진다.
- 대본 n번째는 `situations[n % len(situations)]`을 쓴다.
- 프롬프트(`prompts.build_library_script_messages`): 기존 `SCENARIO_SYSTEM_SCRIPT` 규칙 + 16줄 + 테마·세부 상황 + **같은 테마에서 이미 만든 대본의 제목과 첫 대사 목록(최근 10개)** "과 다르게". 초보가 따라 읽을 짧은 입말.
- 자유 대화 설정: 기존 `build_scenario_messages(language, "free", wish)`에 테마 이름과 세부 상황 전체를 wish로 넘긴다. `max_turns` 16.

### 대본 검사 `library.check_script(lines, language, existing)` -- 실패 이유 문자열 또는 None

1. 정확히 **16줄**.
2. 기존 `scenarios.validate_item`: 봇이 먼저, 번갈아.
3. 언어: 영어 줄은 한글·가나·한자 없음, 라틴 글자 있음. 일본어 줄은 한글·라틴 글자 없음, 대본 전체에 가나가 있음(줄마다 요구하지 않는다 -- "はい。" 같은 짧은 줄 외에 "了解。" 같은 한자만의 줄도 있다).
4. 한 줄 길이: 영어 20단어 이하, 일본어 구두점 제외 45자 이하.
5. 중복: 정규화한 첫 봇 대사가 같은 테마·언어의 기존 대본과 같으면 탈락. 전체 대사를 이어 붙인 문자열의 `difflib.SequenceMatcher` 비율이 기존 어느 대본과 **0.8 이상**이면 탈락.

- 실패하면 같은 편을 **최대 3번** 다시 만든다. 그래도 실패하면 건너뛰고 다음 실행 때 다시 시도한다.
- 출력: 테마·언어별 진행률, 끝에 `통과 N편, 재생성 M번, 포기 K편`과 실패 이유별 개수.
- 모델 호출 실패(`LLMError`)는 3번까지 재시도 후 그 편을 포기한다.

## 대본 고르기와 음성 준비

### `POST /api/library/pick` `{language, mode, theme_id}`

- 404: 없는 테마. 400: `mode`가 `lesson`.
- 자유(`free`): 그 테마의 `-free` 행 id. 없으면 409 `"이 테마는 아직 준비되지 않았어요"`.
- 대본(`script`):
  1. 그 테마·언어의 대본 중 **세션 기록에 한 번도 없는 것**에서 무작위 하나.
  2. 전부 해봤으면, 마지막으로 시작한 세션이 **가장 오래된** 대본.
  3. 한 편도 없으면 409 같은 문구.
  - 고른 대본의 16줄 음성을 **뒤에서** 합성하기 시작한다(`ThreadPoolExecutor(max_workers=1)`, 이미 캐시된 줄은 건너뜀, 실패는 무시 -- 세션 시작의 `_speak`가 다시 시도한다).
- 응답: `{"id", "title", "situation"}`.

### 세션 시작

`POST /sessions`는 그대로다(`scenario_id`로 라이브러리 id를 받는다). 대본 모드의 줄별 `_speak`는 캐시를 맞추면 즉시 끝난다.

## 화면

### 홈 (`#home`)

- 인사, 언어 선택, 약점 추천 줄, **모드 카드 3개**(자유 상황극 · 스크립트 · 수업). 카드를 누르면 테마 선택 화면으로 간다.
- 오른쪽: 이어서 하기, 내 기록, 최근 연습(그대로).
- 지금 홈에 있는 `#wish`, `#chips`, `#btn-start`는 테마 선택 화면으로 옮긴다.

### 테마 선택 (`#pick`, 새 화면)

- 위: `← 홈` 버튼, 모드 이름, 언어 선택(홈과 같은 상태를 공유).
- **자유 상황극 · 스크립트**
  - 분류 탭: `일상` `여행` `스몰토크` `비즈니스`, 내가 만든 상황이 있으면 `내가 만든 것`.
  - 테마 카드: 이름 + 세부 상황 요약(예: "메뉴 추천 묻기 · 포장 주문 ..."). 누르면 선택 표시.
  - **스크립트 모드에서 테마 카드를 누르면 즉시 `/library/pick`을 호출**하고(뒤에서 음성 준비 시작), 받은 id를 들고 있는다. 다른 테마를 누르면 새로 고른다.
  - 아래: "직접 만들기" 입력칸(`#wish`) + `시작` 버튼.
  - 시작 규칙: 입력칸에 글이 있으면 직접 만들기, 아니면 선택한 테마, 아무것도 없으면 지금 탭의 테마 중 무작위.
  - `내가 만든 것` 탭의 카드는 그 시나리오 id로 바로 시작한다.
- **수업**: 테마 영역 대신 주제 입력칸(`#wish`, 예시 문구 `예: 과거형, 식당에서 쓰는 표현`) + `시작`.

### 로딩 표시 (`#start-status`, 시작 버튼 아래)

점 세 개 애니메이션(기존 `.thinking`) + 문구. 단계가 바뀌면 문구가 바뀐다. 시작 중에는 시작 버튼·카드·탭이 잠긴다.

| 경로 | 단계 문구 |
|---|---|
| 스크립트 · 테마 | `대본 고르는 중...`(pick이 아직 안 끝났을 때만) → `음성 준비 중...` |
| 스크립트 · 직접 만들기 | `대본 만드는 중...` → `음성 준비 중...` |
| 자유 상황극 · 테마 | `첫 대사 만드는 중...` |
| 자유 상황극 · 직접 만들기 | `상황 만드는 중...` → `첫 대사 만드는 중...` |
| 수업 | `첫 대사 만드는 중...` |
| 이어서 하기 | `대화 불러오는 중...`(홈 카드 안) |

실패는 `#start-status`를 지우고 `notify`로 무엇이 실패했는지 알린다(`대본을 만들지 못했어요`, `세션을 시작하지 못했어요: ...`).

### `▸ 뜻` 대기

`toggleMeaning`이 요청하는 동안 뜻 칸에 `뜻 가져오는 중...`을 보여준다(실패 문구와 같은 자리).

## 길이

- `config.DEFAULT_MAX_TURNS` 16(자유 대화 생성·수업). 마무리 유도는 기존 규칙 `turns_used >= max_turns - 2` 그대로 → 14턴째부터.
- `SCENARIO_SYSTEM_SCRIPT`의 "대사 8줄" → **16줄**. `/scenarios/generate`의 대본은 `library.check_script`의 1~4번(중복 제외) 검사를 거치고, 떨어지면 **한 번** 다시 만든다. 그래도 떨어지면 지금처럼 422.
- 기존 `data/scenarios.json` 자유 시나리오 `max_turns` 8 → 16.

## 테스트

### pytest (모델 목)

- 마이그레이션 v5: 새 DB와 v4 DB 모두 테이블 생성, 기존 행 보존.
- `scenarios.get_scenario`가 라이브러리 id를 찾는다. `from_row` 모양이 내장과 같다.
- `library.check_script`: 줄 수, 번갈아, 언어(각 방향), 길이 경계, 첫 대사 중복, 유사도 0.8 경계.
- 생성 스크립트: 모자란 만큼만 만든다(이어하기), 3번 실패 시 포기하고 계속, 세부 상황 순환, 이미 만든 제목·첫 대사가 프롬프트에 들어간다, 자유 설정은 없을 때만.
- `/library/pick`: 안 해본 것 먼저, 다 해봤으면 가장 오래전, 404/400/409, 자유 모드는 `-free` id, 뒤에서 합성 요청이 대본 줄 전부로 들어간다(실행기는 목).
- 16턴: 14턴째부터 마무리 문구, 대본 프롬프트 16줄, `/scenarios/generate` 재생성 1회.

### node

- 홈의 모드 카드 → `#pick` 화면, 모드 이름 표시, `← 홈`.
- 분류 탭 전환, `내가 만든 것` 탭은 있을 때만.
- 스크립트 모드 테마 카드 클릭 → `/api/library/pick` 1회, 다른 테마 → 새로 호출, 시작 시 받은 id로 `/api/sessions`.
- 시작 규칙(입력칸 > 선택 테마 > 무작위).
- `#start-status` 단계 문구 순서(경로별), 실패 시 지워지고 `notify`.
- `뜻 가져오는 중...`.

### engine

- `tests/test_library_quality.py`: 테마 2개 × 언어 2개 × 3편을 실제 모델로 생성 → 통과율, 16줄 비율, 실패 이유 분포, 표본 출력. 문턱은 실측 아래로.

### 운영 (구현 후)

1. 표본 실행: `--theme cafe-restaurant hotel --per-theme 3` → 사람이 읽는다.
2. 전체 실행: 1,200편 + 설정 40개. 약 4시간(게임을 끈 상태 기준). 결과 수치를 보고한다.

## 범위 밖

- 레벨별 대본(초급/중급).
- 음성 미리 합성(A안).
- 라이브러리 편집 화면.
- 테마별 진행률 표시.
