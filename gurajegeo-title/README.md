# 구라제거기 - 제목 분석 확장

구글 검색 결과의 제목과 실제 페이지 본문을 Solar Pro 3로 비교합니다. 제목 아래에
판정과 필요한 경우 본문 기반 제목을 표시하고, 글을 열면 검색어와 관련된 본문 문장을
자동으로 하이라이트합니다.

## 실행

1. `config.local.js`의 `UPSTAGE_API_KEY`에 Solar API 키를 입력합니다.
2. `chrome://extensions`에서 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`에서 이 폴더를 선택합니다.
4. 구글 검색 결과 페이지에서 구라제거기 아이콘을 누릅니다.

별도 서버 실행이나 패키지 설치는 필요하지 않습니다.

## 구조 원칙

- `content.js`는 Google/기사 DOM의 수집·표시·하이라이트만 담당합니다.
- `background.js`는 탭 수집 순서, 현재 실행 상태, Solar 호출, LLM 결과 검증만 담당합니다.
- 제목 의미 판정은 Background 한 곳에서 끝냅니다. 화면 코드는 판정 규칙을 다시 구현하지 않습니다.
- 출처별 기사 선택자를 추가하지 않습니다. 일반 의미 태그, 문단 밀도, 링크 비율,
  같은 출처 iframe 점수로 본문을 찾습니다.
- 제목·본문·하이라이트 정규화는 목적이 서로 달라 별도 함수로 유지하며, 각 함수 위에
  보존하는 정보와 제거하는 정보가 적혀 있습니다.
- 서버·파일 저장·`chrome.storage`·offscreen 문서는 사용하지 않습니다.

## 동작 흐름

1. `content.js`가 현재 구글 페이지의 일반 검색 결과 전체를 읽습니다.
2. `background.js`가 모든 결과 작업을 즉시 시작하고, 최대 6개의 비활성 탭으로 본문을
   수집합니다. 본문 수집과 Solar 요청은 독립된 큐로 실행됩니다.
3. 링크의 실제 렌더링 본문을 읽고 광고·메뉴·댓글을 제외합니다. 본문이 비면 한 번
   새로고침하고, 외부 iframe과 Article JSON-LD를 확인합니다. 그래도 비어 있으면
   출처가 제공한 80자 이상의 메타 요약을 마지막 대안으로 사용합니다.
4. 수집이 끝난 본문부터 Solar Pro 3에 보내며 API 요청은 최대 5개씩 병렬 처리합니다.
5. 결과가 끝나는 순서대로 구글 제목 아래의 판정 카드가 갱신됩니다.
6. 사용자가 분석된 글을 열면 관련 본문 문장이 자동으로 하이라이트됩니다.

한 검색 페이지에서 실행하면 그 페이지만 처리합니다. 다음 검색 페이지로 이동했으면
그 페이지에서 아이콘을 다시 누릅니다. 나무위키·위키백과·PDF는 분석하지 않습니다.
영상 결과는 사이트 이름과 무관하게 검색 카드의 재생 표시를 감지하고 Google 검색 설명으로
바로 판정합니다. 영상 사이트를 별도 탭으로 열지 않습니다.

수집이 끝내 실패하면 `시간 초과`, `본문 없음`, `접근 제한`, `주소 불일치`, `프레임 본문`
중 확인된 원인을 카드에 표시합니다. 이 진단값도 파일이나 `chrome.storage`에는 저장하지 않습니다.

## 데이터 처리

본문과 분석 결과를 파일이나 `chrome.storage`에 저장하지 않습니다. 전체 본문은 수집 직후
Solar 요청에만 사용되고, 현재 결과 연결에 필요한 URL·본문 해시·판정·하이라이트만
Service Worker 메모리에 잠시 유지됩니다. 확장을 새로고침하거나 Service Worker가
종료되면 이 상태도 사라집니다.

## 코드 읽는 순서

### `content.js`

1. `runCurrentPageAnalysis`
2. `extractGoogleSearchContext`
3. `renderAnalysisComment`
4. `runArticleLifecycle`
5. `waitForStableArticle`
6. `extractRenderedArticle`
7. `collectArticleRootCandidates`
8. `collectReadableBlockEntries`
9. `applyQueryHighlights`

### `background.js`

1. `chrome.action.onClicked`
2. `analyzeSearchPage`
3. `processSearchResult`
4. `collectSearchResultDocument`
5. `collectRenderedArticle`
6. `collectRenderedArticleAttempt`
7. `collectArticleFromFrames`
8. `createDocumentRecord`
9. `analyzeResult`
10. `callSolar`
11. `requestSolarJson`
12. `createConcurrencyGate`

두 JavaScript는 실행 환경이 다릅니다. `content.js`는 웹 페이지 DOM 안에서 실행되고,
`background.js`는 Service Worker에서 탭·API를 관리합니다. 그래서 URL·문자열 같은 작은
유틸리티 일부는 의도적으로 각각 둡니다. 이를 억지로 공유 파일로 빼면 실행 환경 의존성과
파일 수만 늘어나므로 현재 구조에서는 중복이 아니라 경계별 독립 구현으로 봅니다.

### 나머지 파일

- `manifest.json`: 확장 권한과 Content Script 등록
- `styles.css`: 구글 판정 카드와 기사 하이라이트 스타일
- `config.local.js`: 로컬 개발용 Solar 설정

## 코드 수정 후 확인

1. `chrome://extensions`에서 확장을 새로고침합니다.
2. 열려 있던 구글 검색 페이지도 새로고침합니다.
3. 구라제거기 아이콘을 누릅니다.
4. 제목 아래 판정이 표시되는지 확인합니다.
5. 결과 글을 열었을 때 추가 클릭 없이 하이라이트가 표시되는지 확인합니다.
