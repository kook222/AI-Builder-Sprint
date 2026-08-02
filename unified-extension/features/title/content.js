/**
 * content.js
 * ---------------------------------------------------------------------------
 * 실제 브라우저 화면을 읽고 표시하는 파일입니다.
 *
 * 구글 검색 화면에서는:
 * - 현재 페이지의 일반 검색 결과 전체를 수집합니다.
 * - Background가 보내는 결과를 제목 아래에 표시합니다.
 * - 뒤로 돌아왔을 때 현재 확장 실행의 메모리 결과를 다시 표시합니다.
 *
 * 일반 글 화면에서는:
 * - 실제 렌더링이 끝난 제목·canonical URL·전체 본문을 추출합니다.
 * - 검색어 관련 문장을 즉시 하이라이트합니다.
 * - Background에 전체 본문을 보내 Solar 분석을 요청합니다.
 *
 * 같은 본문 추출 함수를 자동 수집 탭과 사용자가 직접 연 탭이 함께 사용합니다.
 */

// 세 기능의 content script가 같은 페이지에서 함께 실행되므로 전역 이름이 섞이지
// 않도록 제목 기능 전체를 자체 스코프로 감쌉니다.
(() => {

if (globalThis.__GURAJEGO_TITLE_CONTENT_LOADED__) return;
globalThis.__GURAJEGO_TITLE_CONTENT_LOADED__ = true;

const SETTINGS_KEY = "gurajegeoSettings";

// 실제 본문이 두 문장뿐인 속보·시황 단신도 처리하되, 광고·메뉴는 아래의
// 의미 태그·링크 밀도·차단 선택자 검사를 추가로 통과해야 합니다.
const MIN_ARTICLE_LENGTH = 80;
const LARGE_DOCUMENT_EARLY_RETURN_LENGTH = 50000;
const ARTICLE_STABLE_TIMEOUT_MS = 15000;
const ARTICLE_STABLE_INTERVAL_MS = 450;
const CSS_HIGHLIGHT_NAME = "gurajegeo-query";
const COUNTRY_SECOND_LEVEL_DOMAINS = new Set([
  "co.kr", "or.kr", "go.kr", "ac.kr", "ne.kr", "re.kr", "pe.kr",
  "co.jp", "com.au", "com.cn", "com.sg", "co.uk", "org.uk"
]);
const INLINE_TEXT_TAGS = new Set([
  "A", "SPAN", "STRONG", "EM", "B", "I", "U", "SMALL", "SUP", "SUB",
  "FONT", "MARK", "ABBR", "TIME", "S", "DEL", "INS"
]);
const BLOCKED_PAGE_MESSAGES = [
  "access denied", "captcha", "로봇이 아닙니다", "접근이 제한",
  "javascript를 활성화", "서비스 이용이 제한"
];
// form 자체는 제외하지 않습니다. ASP.NET처럼 페이지 전체를 하나의 form으로 감싸는
// 사이트가 있어 form을 막으면 그 안의 정상 기사까지 전부 사라집니다. 입력 컨트롤만 막습니다.
const BLOCKED_CONTENT_SELECTOR = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe",
  "textarea", "input", "select", "nav", "footer", "aside", "button",
  "[role='navigation']", "[role='dialog']", "[hidden]", "[aria-hidden='true']",
  "[data-gurajegeo-ui]:not([data-gurajegeo-ui='risk-highlight'])",
  ".advertisement", ".advert", ".ads", ".ad",
  ".ad-area", "[id^='google_ads']", "[id^='ad-']", "[id^='ads-']",
  "[class~='advertisement']", "[class~='sponsored']", "[data-ad-client]",
  "[data-ad-slot]", ".related", ".recommend", ".comment", ".comments"
].join(",");
const ARTICLE_BODY_HINT_SELECTORS = [
  "[itemprop='articleBody']", "[data-testid*='article-body' i]",
  "[id*='article' i][id*='body' i]", "[id*='news' i][id*='body' i]",
  "[id*='news' i][id*='text' i]", "[class*='article' i][class*='body' i]",
  "[class*='article' i][class*='content' i]", "[class*='article' i][class*='text' i]",
  "[class*='news' i][class*='body' i]", "[class*='news' i][class*='view' i]",
  "[class*='view' i][class*='text' i]", "[class*='detail' i][class*='body' i]",
  "[class*='post' i][class*='content' i]", ".entry-content"
];
const ARTICLE_BODY_HINT_SELECTOR = ARTICLE_BODY_HINT_SELECTORS.join(",");

// DOM 요소는 메시지로 전달할 수 없으므로 resultId와 검색 결과 요소를 현재 탭 메모리에서 연결합니다.
const resultElements = new Map();

let articleGeneration = 0;
let articleScheduleTimer = null;
let articleMutationObserver = null;
let lastArticleUrl = location.href;
// 토글뿐 아니라 API 키까지 있어야 실행 가능한 상태입니다. 키가 삭제되거나
// 교체되면 이전 분석 UI를 즉시 걷어 내어 오래된 판정이 화면에 남지 않게 합니다.
let titleFeatureReady = false;
let titleSettingsGeneration = 0;
let googleLifecycleInstalled = false;
let activeGoogleSearchIdentity = "";
let lastGoogleSearchPageUrl = location.href;
let articleLifecycleInstalled = false;
const titleFeatureInitialization = initializeTitleFeature().catch((error) => {
  console.warn("[구라제거기] 제목 기능 초기화 실패", error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 구글 검색 탭에서 사용자가 확장 아이콘을 누른 경우입니다.
  if (message?.target === "gj:title-content" && message.type === "START_ANALYSIS") {
    titleFeatureInitialization
      .then(() => {
        if (!titleFeatureReady) {
          throw new Error("제목·본문 비교 기능을 켜고 API 키를 입력해 주세요.");
        }
        return runCurrentPageAnalysis();
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        showPageError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  // 결과 하나의 수집·분석 단계가 바뀔 때마다 Background가 보내는 점진적 갱신입니다.
  if (message?.target === "gj:title-content" && message.type === "RESULT_UPDATED") {
    if (titleFeatureReady && isGoogleSearchPage() &&
        isSameSearchPage(message.payload?.searchPageUrl, location.href)) {
      ensureGoogleResultMap();
      renderAnalysisComment(message.payload?.result);
    }
    sendResponse({ ok: true });
    return false;
  }

  // 비활성 수집 탭에서 실제 렌더링된 전체 본문을 요청하는 메시지입니다.
  if (message?.target === "gj:title-content" && message.type === "EXTRACT_RENDERED_ARTICLE") {
    titleFeatureInitialization
      .then(() => {
        if (!titleFeatureReady) {
          throw new Error("제목·본문 비교 기능을 켜고 API 키를 입력해 주세요.");
        }
        if (!isExpectedCollectionPage(message.expectedUrl, location.href)) {
          sendResponse({ ok: false, retryable: true, error: "수집 탭이 새 페이지로 이동 중입니다." });
          return null;
        }
        return waitForStableArticle();
      })
      .then((article) => {
        if (!article) return;
        if (article.content.length < MIN_ARTICLE_LENGTH) {
          const failure = diagnoseRenderedPageFailure();
          sendResponse({
            ok: false,
            retryable: failure.code === "body_missing",
            failureCode: failure.code,
            error: failure.message
          });
          return;
        }
        sendResponse({ ok: true, data: toSerializableArticle(article) });
      })
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) {
    return;
  }
  const settingChange = changes[SETTINGS_KEY];
  if (titleSettingsSignature(settingChange.oldValue) === titleSettingsSignature(settingChange.newValue)) {
    return;
  }

  titleSettingsGeneration += 1;
  const nextReady = isTitleReady(settingChange.newValue);
  // 키 A→B 교체도 기존 키로 만든 판정·하이라이트를 무효화합니다. 검색 결과는
  // 자동 재분석하지 않고 사용자가 다음 실행을 명시적으로 시작할 때까지 비웁니다.
  deactivateTitleFeature();
  titleFeatureReady = nextReady;
  if (titleFeatureReady) {
    activateTitleFeature({ restoreSearchResults: false });
  }
});

async function initializeTitleFeature() {
  const expectedSettingsGeneration = titleSettingsGeneration;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (expectedSettingsGeneration !== titleSettingsGeneration) return;
  titleFeatureReady = isTitleReady(stored[SETTINGS_KEY]);
  if (titleFeatureReady) {
    activateTitleFeature();
  }
}

function isTitleReady(settings) {
  return settings?.features?.title !== false && Boolean(String(settings?.apiKey || "").trim());
}

function titleSettingsSignature(settings) {
  return JSON.stringify({
    apiKey: String(settings?.apiKey || "").trim(),
    enabled: settings?.features?.title !== false
  });
}

/** 토글을 켠 시점의 현재 페이지에서 즉시 기능을 시작합니다. */
function activateTitleFeature({ restoreSearchResults = true } = {}) {
  if (isGoogleSearchPage()) {
    installGoogleLifecycle();
    if (restoreSearchResults) restoreCurrentSearchResults().catch(() => undefined);
    return;
  }
  installArticleLifecycle();
  scheduleArticleRun();
}

/** 토글을 끄면 제목 기능이 만든 화면 요소와 관찰 작업만 정리합니다. */
function deactivateTitleFeature() {
  articleGeneration += 1;
  clearTimeout(articleScheduleTimer);
  articleScheduleTimer = null;
  disconnectArticleObserver();
  clearQueryHighlights();
  removeExistingComments();
  resultElements.clear();
  activeGoogleSearchIdentity = "";
}

function installGoogleLifecycle() {
  if (googleLifecycleInstalled) {
    return;
  }
  googleLifecycleInstalled = true;
  const reconcileSearchPage = () => {
    if (!activeGoogleSearchIdentity || activeGoogleSearchIdentity === getSearchIdentity(location.href)) {
      return;
    }
    const previousPageUrl = lastGoogleSearchPageUrl;
    activeGoogleSearchIdentity = "";
    removeExistingComments();
    resultElements.clear();
    sendRuntimeMessage({
      target: "gj:title",
      type: "CANCEL_SEARCH_RUN",
      payload: { searchPageUrl: previousPageUrl, currentPageUrl: location.href }
    }).catch(() => undefined);
  };
  addEventListener("pageshow", () => {
    if (!titleFeatureReady) return;
    reconcileSearchPage();
    restoreCurrentSearchResults().catch(() => undefined);
  });
  addEventListener("popstate", reconcileSearchPage);
  new MutationObserver(reconcileSearchPage).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  document.addEventListener("visibilitychange", () => {
    if (titleFeatureReady && document.visibilityState === "visible") {
      restoreCurrentSearchResults().catch(() => undefined);
    }
  });
}

/* =============================================================================
 * 1. 구글 검색 결과 수집과 화면 표시
 * ========================================================================== */

async function runCurrentPageAnalysis() {
  if (!titleFeatureReady) {
    throw new Error("제목·본문 비교 기능을 켜고 API 키를 입력해 주세요.");
  }
  removeExistingComments();
  resultElements.clear();
  activeGoogleSearchIdentity = getSearchIdentity(location.href) || "";
  lastGoogleSearchPageUrl = location.href;

  const context = extractGoogleSearchContext();
  if (context.results.length === 0) {
    throw new Error("현재 화면에서 분석할 일반 검색 결과를 찾지 못했습니다.");
  }

  for (const result of context.results) {
    renderLoadingComment(result.resultId, "수집 순서를 기다리고 있습니다.");
  }

  const response = await sendRuntimeMessage({
    target: "gj:title",
    type: "ANALYZE_PAGE",
    payload: context
  });
  if (!response?.ok) {
    throw new Error(response?.error || "검색 결과 분석에 실패했습니다.");
  }

  for (const result of response.data.results || []) {
    renderAnalysisComment(result);
  }
}

/** 현재 URL의 검색어와 start 값을 사용하므로 1페이지와 2페이지가 섞이지 않습니다. */
function extractGoogleSearchContext() {
  const url = new URL(location.href);
  const query = url.searchParams.get("q") || document.querySelector("input[name='q']")?.value || "";
  const results = [];
  const seenUrls = new Set();

  for (const heading of document.querySelectorAll("h3")) {
    const anchor = heading.closest("a");
    if (!anchor) {
      continue;
    }

    const normalizedUrl = normalizeExternalUrl(anchor.href);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    const container = findResultContainer(heading);
    if (!container || isAdvertisement(container)) {
      continue;
    }
    if (isExcludedAnalysisResult(normalizedUrl, container)) {
      continue;
    }

    const title = readCleanText(heading);
    if (title.length < 2) {
      continue;
    }

    const resultId = `result-${results.length + 1}`;
    const documentType = detectDocumentType(normalizedUrl, container);
    results.push({
      resultId,
      position: results.length + 1,
      url: normalizedUrl,
      originalTitle: title,
      snippet: extractSnippet(container, title, documentType),
      documentType
    });
    seenUrls.add(normalizedUrl);
    resultElements.set(resultId, { anchor, container, url: normalizedUrl });
  }

  return {
    query: normalizeText(query),
    searchPageUrl: location.href,
    results
  };
}

/** URL과 Google 카드의 재생 신호를 함께 사용해 일반 글과 영상을 구분합니다. */
function detectDocumentType(url, container) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    if (/(^|\.)youtube\.com$/.test(hostname) || hostname === "youtu.be" ||
        /(^|\.)dailymotion\.com$/.test(hostname)) {
      return "video";
    }
  } catch {
    // URL 파싱이 실패해도 아래의 검색 결과 화면 신호로 영상 여부를 판단합니다.
  }
  return hasVideoResultSignals(container) ? "video" : "html";
}

/**
 * 특정 영상 사이트 목록을 계속 추가하지 않고 Google 결과 카드가 보여 주는 공통 신호를 봅니다.
 * 재생시간(예: 2:49, 1:15:00)이나 명시적인 재생 버튼이 있으면 영상 결과로 분류합니다.
 */
function hasVideoResultSignals(container) {
  if (!container) {
    return false;
  }
  if (container.querySelector(
    "video, [aria-label*='재생' i], [aria-label*='동영상' i], " +
    "[aria-label*='play' i], [data-video-id], [data-video-url]"
  )) {
    return true;
  }

  // 시각이 아니라 썸네일 위에 겹쳐 표시된 순수 재생시간만 인정합니다.
  // 그래서 기사 스니펫의 "오전 9:45" 같은 시간 표시는 영상으로 오인하지 않습니다.
  const durationElements = [...container.querySelectorAll("span, div")]
    .filter((element) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(normalizeText(element.textContent || "")));
  const images = [...container.querySelectorAll("img")];
  return durationElements.some((duration) => {
    const durationRect = duration.getBoundingClientRect();
    return images.some((image) => {
      const imageRect = image.getBoundingClientRect();
      return durationRect.width > 0 && durationRect.height > 0 &&
        imageRect.width > 0 && imageRect.height > 0 &&
        durationRect.left < imageRect.right && durationRect.right > imageRect.left &&
        durationRect.top < imageRect.bottom && durationRect.bottom > imageRect.top;
    });
  });
}

/** 위키 문서와 PDF는 이번 제목 분석 대상에서 완전히 제외합니다. */
function isExcludedAnalysisResult(url, container) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const urlText = decodeURIComponent(`${parsed.pathname}${parsed.search}`).toLowerCase();
    const hasPdfBadge = [...container.querySelectorAll("span, div")]
      .some((element) => normalizeText(element.textContent || "").toUpperCase() === "PDF");
    return hostname === "namu.wiki" || hostname === "wikipedia.org" ||
      hostname.endsWith(".wikipedia.org") || /\.pdf(?:$|[?&#])/i.test(urlText) ||
      hasPdfBadge || Boolean(container.querySelector("a[type='application/pdf'], a[href*='.pdf' i]"));
  } catch {
    return true;
  }
}

/** Google 클래스가 바뀌어도 제목에서 가장 가까운 결과 카드까지 단계적으로 찾습니다. */
function findResultContainer(heading) {
  return heading.closest("div.MjjYud") ||
    heading.closest("div[data-snhf]") ||
    heading.closest("div.g") ||
    heading.closest("div") ||
    heading.parentElement;
}

/** 명시적인 광고 속성과 카드 시작 문구만 사용해 일반 결과 오탐을 줄입니다. */
function isAdvertisement(container) {
  if (container.matches("[data-text-ad], [data-ad]") ||
      container.querySelector("[data-text-ad], [data-ad]")) {
    return true;
  }
  return /^(광고|스폰서|Sponsored)(?:\s|$)/i.test(readCleanText(container));
}

/** 일반 결과의 설명을 읽고, 영상은 카드 공개 텍스트를 마지막 대안으로 사용합니다. */
function extractSnippet(container, title, documentType) {
  const selectors = [".VwiC3b", ".IsZvec", "[data-sncf]", "[data-content-feature='1']"];
  for (const selector of selectors) {
    const value = readCleanText(container.querySelector(selector));
    if (value && value !== title) {
      return value.slice(0, 1000);
    }
  }
  if (documentType !== "video") {
    return "";
  }
  // 영상 카드의 설명은 일반 검색 결과와 클래스가 다른 경우가 많아 카드의 공개 텍스트를 씁니다.
  return readCleanText(container).replace(title, "").trim().slice(0, 1000);
}

/** 다른 두 기능이 결과 카드에 붙인 UI는 제목·스니펫 원문에서 제외합니다. */
function readCleanText(element) {
  if (!element) {
    return "";
  }
  const clone = element.cloneNode(true);
  for (const injected of clone.querySelectorAll("[data-gurajegeo-ui]")) {
    injected.remove();
  }
  return normalizeText(clone.textContent || "");
}

/** 분석 요청 직후 결과별 대기 상태를 먼저 표시합니다. */
function renderLoadingComment(resultId, message) {
  const wrapper = ensureCommentWrapper(resultId);
  if (!wrapper) {
    return;
  }
  resetCommentWrapper(wrapper);
  renderCompactStatus(wrapper, "gurajegeo-loading", "수집 대기", message, "gurajegeo-loading-text");
}

/** 수집 상태와 AI 상태를 분리해 더 이상 모든 실패를 '본문 확인 필요'로 표시하지 않습니다. */
function renderAnalysisComment(result) {
  if (!result?.resultId) {
    return;
  }
  const wrapper = ensureCommentWrapper(result.resultId, result.document?.url);
  if (!wrapper) {
    return;
  }

  resetCommentWrapper(wrapper);
  const documentState = result.document?.state;
  const analysis = result.analysis || {};

  if (documentState === "pending") {
    renderCompactStatus(
      wrapper,
      "gurajegeo-loading",
      "수집 대기",
      "다른 기사와 함께 병렬 수집 순서를 기다립니다."
    );
    return;
  }

  if (documentState === "collecting") {
    renderCompactStatus(
      wrapper,
      "gurajegeo-loading",
      "수집 중",
      "실제 페이지에서 전체 본문을 읽고 있습니다."
    );
    return;
  }

  if (documentState === "failed") {
    renderCompactStatus(
      wrapper,
      "gurajegeo-unknown",
      "수집 실패",
      result.document?.failureMessage || "페이지를 직접 열면 실제 화면 본문으로 다시 수집합니다."
    );
    return;
  }

  if (analysis.state === "pending") {
    renderCompactStatus(
      wrapper,
      "gurajegeo-loading",
      "AI 분석 중",
      "전체 본문을 읽고 제목을 판정하고 있습니다."
    );
    return;
  }

  if (analysis.state === "failed") {
    renderCompactStatus(
      wrapper,
      "gurajegeo-unknown",
      "AI 분석 실패",
      "본문은 읽었지만 모델 호출을 완료하지 못했습니다."
    );
    return;
  }

  const hasSuggestedTitle = Boolean(analysis.suggestedTitle);

  // Background 검증을 통과한 문제 판정에는 중립 제목이 반드시 있어야 합니다.
  // 이 분기는 메시지 손상이나 구버전 Service Worker가 섞인 경우의 화면 안전장치입니다.
  if (["mismatch", "clickbait"].includes(analysis.verdict) && !hasSuggestedTitle) {
    renderCompactStatus(
      wrapper,
      "gurajegeo-unknown",
      "AI 판단 보류",
      "검증된 본문 기반 제목이 없어 결과 표시를 보류했습니다."
    );
    return;
  }

  if (analysis.verdict === "mismatch") {
    renderCorrectionCard(
      wrapper,
      "gurajegeo-mismatch-card",
      "gurajegeo-danger",
      "제목과 본문 차이",
      analysis.suggestedTitle,
      analysis.comment || "제목과 본문의 핵심 내용에 차이가 있습니다."
    );
    return;
  }

  if (analysis.verdict === "clickbait") {
    renderCorrectionCard(
      wrapper,
      "gurajegeo-clickbait-card",
      "gurajegeo-warning",
      "자극 표현 있음",
      analysis.suggestedTitle,
      analysis.comment || "사실은 맞지만 자극적인 표현이 있습니다."
    );
    return;
  }

  if (analysis.verdict === "normal") {
    renderCompactStatus(
      wrapper,
      "gurajegeo-consistent",
      "본문 일치",
      analysis.comment || "제목이 핵심 내용을 대체로 반영합니다."
    );
    return;
  }

  renderCompactStatus(
    wrapper,
    "gurajegeo-unknown",
    "AI 판단 보류",
    analysis.comment || "본문을 읽었지만 모델이 판정을 보류했습니다."
  );
}

/** 카드 재사용 시 이전 판정의 클래스·내용·반전 보정을 한 번에 초기화합니다. */
function resetCommentWrapper(wrapper) {
  wrapper.replaceChildren();
  wrapper.className = "gurajegeo-comment";
  applyCommentOrientation(wrapper);
}

/** 대기·실패·정상처럼 한 줄로 끝나는 상태 카드의 공통 DOM을 만듭니다. */
function renderCompactStatus(
  wrapper,
  badgeClass,
  badgeText,
  reason,
  reasonClass = "gurajegeo-reason"
) {
  wrapper.classList.add("gurajegeo-compact");
  wrapper.append(
    createElement("span", `gurajegeo-badge ${badgeClass}`, badgeText),
    createElement("span", reasonClass, reason)
  );
}

/** 문제 판정 카드의 배지·대체 제목·근거를 동일한 DOM 구조로 표시합니다. */
function renderCorrectionCard(
  wrapper,
  cardClass,
  badgeClass,
  badgeText,
  suggestedTitle,
  reason
) {
  wrapper.classList.add(cardClass);
  wrapper.append(
    createElement("span", `gurajegeo-badge ${badgeClass}`, badgeText),
    createElement("div", "gurajegeo-suggested-title", `본문 기반 제목: ${suggestedTitle}`),
    createElement("div", "gurajegeo-reason", reason)
  );
}

/** 결과 카드마다 판정 DOM을 하나만 유지하고 Google 재배치 시 위치를 복원합니다. */
function ensureCommentWrapper(resultId, expectedUrl = "") {
  const elements = resolveResultElements(resultId, expectedUrl);
  if (!elements) {
    return null;
  }
  const existing = elements.container.querySelector(`[data-gurajegeo-result="${resultId}"]`);
  if (existing) {
    placeCommentWrapper(existing, elements);
    return existing;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "gurajegeo-comment";
  wrapper.dataset.gurajegeoResult = resultId;
  wrapper.dataset.gurajegeoUi = "title";
  placeCommentWrapper(wrapper, elements);
  return wrapper;
}

/** Google이 같은 DOM 카드를 다른 결과에 재사용해도 URL이 같은 카드에만 결과를 붙입니다. */
function resolveResultElements(resultId, expectedUrl) {
  const expected = normalizeUrlForMatching(expectedUrl || "");
  let elements = resultElements.get(resultId);
  if (!expected || normalizeUrlForMatching(elements?.anchor?.href || elements?.url || "") === expected) {
    return elements || null;
  }

  document.querySelector(`[data-gurajegeo-result="${CSS.escape(resultId)}"]`)?.remove();
  resultElements.clear();
  extractGoogleSearchContext();
  elements = [...resultElements.values()].find((candidate) =>
    normalizeUrlForMatching(candidate.anchor?.href || candidate.url || "") === expected
  );
  if (elements) resultElements.set(resultId, elements);
  return elements || null;
}

/**
 * 일반 결과는 제목 링크 다음에 카드를 붙입니다.
 *
 * 일부 Google 영상 결과는 목록 순서를 구현하려고 부모를 scaleY(-1)로 뒤집은 뒤
 * Google이 만든 자식들만 다시 scaleY(-1)로 복구합니다. 이 영역에 평범하게 만든
 * 카드를 넣으면 글자가 거꾸로 보이고 DOM의 `after`가 화면에서는 제목 위가 됩니다.
 * 실제 부모의 계산된 transform을 확인해 이런 경우에만 DOM 순서와 Y축을 함께
 * 보정합니다. 문서 종류나 자주 바뀌는 Google 클래스 이름에 의존하지 않습니다.
 */
function placeCommentWrapper(wrapper, elements) {
  const insertionTarget = elements.anchor.closest("div.yuRUbf") || elements.anchor;
  const isVerticallyFlipped = hasVerticalAxisFlip(
    insertionTarget.parentElement,
    elements.container
  );

  if (isVerticallyFlipped) {
    if (wrapper.nextElementSibling !== insertionTarget) {
      insertionTarget.before(wrapper);
    }
  } else if (insertionTarget.nextElementSibling !== wrapper) {
    insertionTarget.after(wrapper);
  }

  applyCommentOrientation(wrapper, isVerticallyFlipped);
}

/** Google 부모의 2D/3D 변환 행렬이 실제로 Y축 반전인지 판별합니다. */
function hasVerticalAxisFlip(element, boundary = null) {
  let flipped = false;
  for (let current = element; current; current = current.parentElement) {
    const transform = getComputedStyle(current).transform;
    if (transform && transform !== "none" && isSingleVerticalFlip(transform)) {
      flipped = !flipped;
    }
    if (current === boundary) break;
  }
  return flipped;
}

function isSingleVerticalFlip(transform) {
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return matrix.d < -0.5 && matrix.a > 0.5;
  } catch {
    const match = transform.match(/^matrix\(([^)]+)\)$/);
    const values = match?.[1].split(",").map(Number) || [];
    return values.length === 6 && values[0] > 0.5 && values[3] < -0.5;
  }
}

function applyCommentOrientation(
  wrapper,
  isVerticallyFlipped = hasVerticalAxisFlip(wrapper.parentElement)
) {
  wrapper.classList.toggle("gurajegeo-counter-flip-y", isVerticallyFlipped);
}

function removeExistingComments() {
  for (const element of document.querySelectorAll("[data-gurajegeo-result], [data-gurajegeo-page-error]")) {
    element.remove();
  }
}

function showPageError(message) {
  const firstResult = resultElements.values().next().value;
  if (!firstResult) {
    console.error("[구라제거기]", message);
    return;
  }
  let errorBox = document.querySelector("[data-gurajegeo-page-error]");
  if (!errorBox) {
    errorBox = document.createElement("div");
    errorBox.dataset.gurajegeoPageError = "true";
    errorBox.dataset.gurajegeoUi = "title";
    errorBox.className = "gurajegeo-page-error";
    firstResult.anchor.after(errorBox);
  }
  errorBox.textContent = `구라제거기 오류: ${message}`;
}

/** 뒤로가기나 탭 복원 시 같은 검색어·페이지의 현재 메모리 결과만 다시 표시합니다. */
async function restoreCurrentSearchResults() {
  if (!titleFeatureReady || !isGoogleSearchPage()) {
    return;
  }
  const expectedSettingsGeneration = titleSettingsGeneration;
  const expectedPageIdentity = getSearchIdentity(location.href);
  const response = await sendRuntimeMessage({ target: "gj:title", type: "GET_CURRENT_RUN" });
  if (expectedSettingsGeneration !== titleSettingsGeneration || !titleFeatureReady ||
      expectedPageIdentity !== getSearchIdentity(location.href) ||
      !response?.ok || !isSameSearchPage(response.data?.searchPageUrl, location.href)) {
    return;
  }
  activeGoogleSearchIdentity = getSearchIdentity(location.href) || "";
  lastGoogleSearchPageUrl = location.href;
  ensureGoogleResultMap();
  for (const result of response.data.results || []) {
    renderAnalysisComment(result);
  }
}

function ensureGoogleResultMap() {
  if (resultElements.size === 0) {
    extractGoogleSearchContext();
  }
}

function isSameSearchPage(left, right) {
  const leftIdentity = getSearchIdentity(left);
  const rightIdentity = getSearchIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

function getSearchIdentity(value) {
  try {
    const url = new URL(value);
    if (!["www.google.com", "www.google.co.kr"].includes(url.hostname) || url.pathname !== "/search") {
      return null;
    }
    return JSON.stringify({
      q: normalizeText(url.searchParams.get("q") || ""),
      start: Number(url.searchParams.get("start") || 0),
      tbm: normalizeText(url.searchParams.get("tbm") || ""),
      udm: normalizeText(url.searchParams.get("udm") || "")
    });
  } catch {
    return null;
  }
}

/* =============================================================================
 * 2. 일반 기사 lifecycle: 매칭 -> 전체 본문 -> 즉시 강조 -> Solar 결과
 * ========================================================================== */

function installArticleLifecycle() {
  if (articleLifecycleInstalled) {
    return;
  }
  articleLifecycleInstalled = true;

  addEventListener("pageshow", () => titleFeatureReady && scheduleArticleRun());
  addEventListener("popstate", () => titleFeatureReady && scheduleArticleRun());
  addEventListener("hashchange", () => titleFeatureReady && scheduleArticleRun());
  document.addEventListener("visibilitychange", () => {
    if (titleFeatureReady && document.visibilityState === "visible") {
      scheduleArticleRun();
    }
  });

  // History API로 주소만 바뀌는 SPA를 별도 라이브러리 없이 감지합니다.
  setInterval(() => {
    if (titleFeatureReady && location.href !== lastArticleUrl) {
      lastArticleUrl = location.href;
      scheduleArticleRun();
    }
  }, 500);
}

function scheduleArticleRun() {
  if (!titleFeatureReady || isGoogleSearchPage()) {
    return;
  }
  clearTimeout(articleScheduleTimer);
  const generation = ++articleGeneration;
  articleScheduleTimer = setTimeout(() => runArticleLifecycle(generation), 120);
}

/** 열린 글을 현재 검색 결과와 연결하고 즉시 강조한 뒤 최신 AI 결과로 갱신합니다. */
async function runArticleLifecycle(generation) {
  if (!titleFeatureReady || generation !== articleGeneration) {
    return;
  }
  disconnectArticleObserver();
  clearQueryHighlights();

  try {
    const descriptor = getPageDescriptor();
    const matchResponse = await sendRuntimeMessage({
      target: "gj:title",
      type: "MATCH_OPEN_ARTICLE",
      payload: descriptor
    });
    const context = matchResponse?.ok ? matchResponse.data : null;
    if (!context || context.collector || !context.matched || generation !== articleGeneration) {
      return;
    }

    // 영상 결과는 검색 화면의 공개 설명으로 이미 판정하므로 본문 하이라이트 대상이 아닙니다.
    if (context.result?.document?.documentType === "video") {
      return;
    }
    let highlights = getHighlights(context.result);
    const earlyArticle = extractRenderedArticle();
    let appliedHighlightCount = 0;
    if (earlyArticle.rootElement && highlights.length > 0) {
      appliedHighlightCount = applyQueryHighlights(highlights, earlyArticle.rootElement);
    }
    // 기존 AI 문장이 없거나 현재 DOM과 아직 맞지 않아도, 첫 추출 본문에서 검색어
    // 관련 문장을 바로 만들어 표시합니다. 안정화·Solar 완료를 기다렸다가 처음 표시하는
    // 방식보다 사용자가 글을 연 순간 피드백을 볼 수 있습니다.
    if (earlyArticle.rootElement && (highlights.length === 0 || appliedHighlightCount === 0)) {
      const immediateHighlights = createImmediateQueryHighlights(earlyArticle.content, context.query);
      const immediateCount = applyQueryHighlights(immediateHighlights, earlyArticle.rootElement);
      if (immediateCount > 0) {
        highlights = immediateHighlights;
        appliedHighlightCount = immediateCount;
      }
    }

    const article = await waitForStableArticle();
    if (generation !== articleGeneration || article.content.length < MIN_ARTICLE_LENGTH) {
      return;
    }

    appliedHighlightCount = applyQueryHighlights(highlights, article.rootElement);
    if (highlights.length === 0 || appliedHighlightCount === 0) {
      highlights = createImmediateQueryHighlights(article.content, context.query);
      appliedHighlightCount = applyQueryHighlights(highlights, article.rootElement);
    }

    const response = await sendRuntimeMessage({
      target: "gj:title",
      type: "ANALYZE_OPEN_ARTICLE",
      payload: {
        runId: context.runId,
        resultId: context.result.resultId,
        url: article.url,
        canonicalUrl: article.canonicalUrl,
        title: article.title,
        content: article.content,
        documentType: article.documentType,
        source: article.source
      }
    });

    if (generation !== articleGeneration) {
      return;
    }
    const finalHighlights = response?.ok ? getHighlights(response.data) : [];
    if (finalHighlights.length > 0) {
      clearQueryHighlights();
      const latestRoot = extractRenderedArticle().rootElement || article.rootElement;
      const finalAppliedCount = applyQueryHighlights(finalHighlights, latestRoot);
      if (finalAppliedCount > 0) {
        highlights = finalHighlights;
      } else {
        highlights = createImmediateQueryHighlights(article.content, context.query);
        applyQueryHighlights(highlights, latestRoot);
      }
    }
    observeArticleForHighlightReapply(highlights, generation);
  } catch (error) {
    console.warn("[구라제거기] 기사 자동 분석을 완료하지 못했습니다.", error);
  }
}

function getPageDescriptor(targetDocument = getArticleDocument()) {
  return {
    url: location.href,
    canonicalUrl: targetDocument.querySelector("link[rel='canonical']")?.href ||
      document.querySelector("link[rel='canonical']")?.href || "",
    title: normalizeText(
      targetDocument.querySelector("meta[property='og:title']")?.content ||
      targetDocument.querySelector("h1")?.textContent ||
      document.querySelector("meta[property='og:title']")?.content ||
      document.querySelector("h1")?.textContent ||
      document.title
    )
  };
}

/**
 * 실제 글을 같은 출처 iframe에 넣는 페이지는 가장 기사다운 문서를 선택합니다.
 * 출처 이름이나 iframe id를 나열하지 않고 의미 태그와 텍스트 양만 비교합니다.
 */
function getArticleDocument() {
  const candidates = [document];
  for (const iframe of document.querySelectorAll("iframe")) {
    try {
      const frameDocument = iframe.contentDocument;
      if (frameDocument?.body) {
        candidates.push(frameDocument);
      }
    } catch {
      // 다른 출처 iframe은 브라우저 보안상 읽을 수 없으므로 후보에서 제외합니다.
    }
  }

  return candidates
    .map((candidate) => ({ candidate, score: scoreArticleDocument(candidate) }))
    .sort((left, right) => right.score - left.score)[0].candidate;
}

/** 의미상 본문 루트가 있으면 우선하고, 없을 때만 전체 텍스트 양을 보조 점수로 씁니다. */
function scoreArticleDocument(targetDocument) {
  const semanticRoot = targetDocument.querySelector([
    "article", "[itemprop='articleBody']", "main", "[role='main']",
    ...ARTICLE_BODY_HINT_SELECTORS
  ].join(","));
  const semanticLength = normalizeText(semanticRoot?.textContent || "").length;
  const bodyLength = normalizeText(targetDocument.body?.textContent || "").length;
  return semanticLength >= MIN_ARTICLE_LENGTH ? 100000 + semanticLength : bodyLength;
}

function getHighlights(result) {
  return Array.isArray(result?.analysis?.queryHighlights)
    ? result.analysis.queryHighlights
    : [];
}

function createImmediateQueryHighlights(content, query) {
  const terms = normalizeText(query)
    .split(/[\s,./|]+/)
    .map(normalizeForComparison)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return [];
  }

  return [...new Set(
    normalizeArticleText(content)
      .split("\n")
      .flatMap((paragraph) => paragraph.split(/(?<=[.!?。])\s+/))
  )]
    .filter((text) => text.length >= 20 && text.length <= 500)
    .filter((text) => {
      const comparable = normalizeForComparison(text);
      return terms.some((term) => comparable.includes(term));
    })
    .sort((left, right) => left.length - right.length)
    .slice(0, 5)
    .map((text) => ({
      text,
      reason: `검색어 '${normalizeText(query)}'와 관련된 실제 본문입니다.`,
      relevanceScore: 1
    }));
}

/* =============================================================================
 * 3. 실제 렌더링된 전체 본문 추출
 * ========================================================================== */

/** 본문 문자열이 두 번 연속 동일할 때 동적 렌더링이 안정됐다고 판단합니다. */
async function waitForStableArticle() {
  const deadline = Date.now() + ARTICLE_STABLE_TIMEOUT_MS;
  let best = extractRenderedArticle();
  if (best.content.length >= LARGE_DOCUMENT_EARLY_RETURN_LENGTH) {
    return best;
  }
  let previousContent = "";
  let stableCount = 0;

  while (Date.now() < deadline) {
    const current = extractRenderedArticle();
    if (current.content.length > best.content.length) {
      best = current;
    }

    if (current.content.length >= LARGE_DOCUMENT_EARLY_RETURN_LENGTH) {
      return current;
    }
    if (current.content.length >= MIN_ARTICLE_LENGTH) {
      if (current.content === previousContent) {
        stableCount += 1;
      } else {
        previousContent = current.content;
        stableCount = 0;
      }
      if (stableCount >= 1) {
        return current;
      }
    }
    await wait(ARTICLE_STABLE_INTERVAL_MS);
  }
  return best;
}

/**
 * 사이트 클래스 하나에 의존하지 않고 본문 후보의 길이·문단 수·링크 밀도를 점수화합니다.
 * 클래스명이 바뀌거나 난수인 페이지도 실제 긴 문장이 있는 div의 조상을 후보로 삼습니다.
 */
function extractRenderedArticle() {
  const targetDocument = getArticleDocument();
  const descriptor = getPageDescriptor(targetDocument);
  const roots = collectArticleRootCandidates(targetDocument);
  const snapshots = roots
    .map((rootElement) => createArticleSnapshot(rootElement))
    .filter((snapshot) => snapshot.content.length >= MIN_ARTICLE_LENGTH)
    .filter((snapshot) => isUsableArticleContent(snapshot.content));

  // 일부 언론사는 본문을 늦게 그리거나 비활성 탭에서 레이아웃 계산을 생략합니다.
  // 이때 화면 DOM만으로 수집하지 못하면 표준 Article JSON-LD의 articleBody를
  // 마지막 후보로 사용합니다. 특정 사이트용 선택자가 아니므로 다른 기사에도 통합니다.
  const structuredContent = extractStructuredArticleContent(targetDocument);
  if (isUsableArticleContent(structuredContent)) {
    snapshots.push({
      rootElement: targetDocument.querySelector("article, main, [role='main']") || targetDocument.body,
      content: structuredContent,
      score: structuredContent.length + 6500,
      source: "structured-data"
    });
  }

  // 실제 DOM과 Article JSON-LD가 모두 비었을 때만 출처가 제공한 메타 요약을 씁니다.
  // 정상 본문이 존재하면 짧은 description이 전체 글을 덮어쓰지 않습니다.
  if (snapshots.length === 0) {
    const metadataContent = extractMetadataArticleContent(targetDocument);
    if (isUsableArticleContent(metadataContent)) {
      snapshots.push({
        rootElement: targetDocument.body,
        content: metadataContent,
        score: metadataContent.length,
        source: "metadata-description"
      });
    }
  }

  // 정밀 선택자가 하나 잡혔다는 이유만으로 다른 후보를 버리지 않습니다.
  // 잘못 붙은 article-body 클래스보다 실제 문단 밀도가 높은 영역이 이길 수 있어야 합니다.
  const rankedSnapshots = snapshots.sort((left, right) => right.score - left.score);

  const best = rankedSnapshots[0] || {
    rootElement: targetDocument.body,
    content: "",
    score: 0
  };
  return {
    url: location.href,
    canonicalUrl: descriptor.canonicalUrl,
    title: descriptor.title,
    content: best.content,
    rootElement: best.rootElement,
    documentType: "html",
    source: best.source || "rendered"
  };
}

/** JSON-LD에서 표준 Article 계열의 전체 articleBody만 읽습니다. */
function extractStructuredArticleContent(targetDocument = document) {
  const bodies = [];
  for (const script of targetDocument.querySelectorAll("script[type='application/ld+json']")) {
    try {
      collectStructuredArticleBodies(JSON.parse(script.textContent || "null"), bodies);
    } catch {
      // 페이지에 깨진 JSON-LD가 섞여 있어도 나머지 DOM 수집은 그대로 진행합니다.
    }
  }
  return bodies
    .map((body) => normalizeArticleText(body))
    .filter((body) => body.length >= MIN_ARTICLE_LENGTH)
    .sort((left, right) => right.length - left.length)[0] || "";
}

/** 렌더링 본문이 완전히 없을 때 사용할 출처 제공 설명 중 가장 긴 값을 고릅니다. */
function extractMetadataArticleContent(targetDocument = document) {
  return [
    targetDocument.querySelector("meta[property='og:description']")?.content,
    targetDocument.querySelector("meta[name='description']")?.content,
    targetDocument.querySelector("meta[name='twitter:description']")?.content
  ]
    .map((value) => normalizeArticleText(value || ""))
    .filter((value) => value.length >= MIN_ARTICLE_LENGTH)
    .sort((left, right) => right.length - left.length)[0] || "";
}

/** 중첩 배열·@graph를 포함한 JSON-LD 트리에서 Article 본문만 재귀 수집합니다. */
function collectStructuredArticleBodies(value, bodies) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredArticleBodies(item, bodies));
    return;
  }

  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  const isArticle = types.some((type) => /(?:News)?Article|BlogPosting/i.test(String(type || "")));
  if (isArticle && typeof value.articleBody === "string") {
    bodies.push(value.articleBody);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectStructuredArticleBodies(child, bodies);
    }
  }
}

/** 의미 태그와 본문 밀도 후보를 합치고 비용이 큰 정밀 평가는 상위 후보로 제한합니다. */
function collectArticleRootCandidates(targetDocument = document) {
  const preferredRoots = new Set();
  const genericRoots = new Set();
  const preferredSelectors = [
    "article", "main", "[role='main']", ...ARTICLE_BODY_HINT_SELECTORS
  ];
  for (const element of targetDocument.querySelectorAll(preferredSelectors.join(","))) {
    preferredRoots.add(element);
  }

  // 메뉴의 짧은 li를 무작위로 샘플링하면 실제 기사 문단이 후보에서 빠질 수 있습니다.
  // 대신 링크 비율이 낮고 문장 길이가 긴 블록을 먼저 고릅니다.
  const textBlocks = [
    ...targetDocument.querySelectorAll("p, blockquote, .par, [role='paragraph']"),
    ...targetDocument.querySelectorAll("div")
  ];
  const informativeBlocks = textBlocks
    .map((element) => {
      if (isBlockedContentElement(element) || !isVisiblyReadableElement(element)) {
        return null;
      }
      const text = element.matches("div")
        ? getDirectReadableText(element)
        : normalizeText(element.textContent || "");
      const linkTextLength = [...element.querySelectorAll("a")]
        .reduce((sum, link) => sum + normalizeText(link.textContent || "").length, 0);
      const linkRatio = text.length > 0 ? Math.min(1, linkTextLength / text.length) : 1;
      return { element, textLength: text.length, score: text.length * (1 - linkRatio) };
    })
    .filter((candidate) => candidate && candidate.textLength >= 30 && candidate.score >= 20)
    .sort((left, right) => right.score - left.score)
    .slice(0, 600);

  for (const { element: block } of informativeBlocks) {
    let ancestor = block.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth += 1) {
      if (ancestor !== targetDocument.body && ancestor !== targetDocument.documentElement) {
        genericRoots.add(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
  }

  // 전체 페이지처럼 링크가 많은 조상은 감점하고 본문 밀도가 높은 후보만 자세히 평가합니다.
  const limitedGenericRoots = [...genericRoots]
    .map((element) => ({
      element,
      length: normalizeText(element.textContent || "").length,
      linkLength: [...element.querySelectorAll("a")]
        .reduce((sum, link) => sum + normalizeText(link.textContent || "").length, 0)
    }))
    .filter((candidate) => candidate.length >= MIN_ARTICLE_LENGTH)
    .map((candidate) => ({
      ...candidate,
      score: candidate.length - candidate.linkLength * 2
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 60)
    .map((candidate) => candidate.element);

  const roots = [...new Set([...preferredRoots, ...limitedGenericRoots])];
  return roots.length > 0 ? roots : [targetDocument.body];
}

/** 본문 후보 하나를 정제하고 길이·문단 수·의미 태그·링크 밀도로 점수화합니다. */
function createArticleSnapshot(rootElement) {
  const blocks = collectReadableBlockEntries(rootElement);
  const blockContent = normalizeArticleText(blocks.map((entry) => entry.text).join("\n"));
  const fallbackContent = blockContent.length >= MIN_ARTICLE_LENGTH
    ? blockContent
    : extractCleanFallbackText(rootElement);
  const content = normalizeArticleText(fallbackContent);
  const linkTextLength = [...rootElement.querySelectorAll("a")]
    .reduce((sum, link) => sum + normalizeText(link.textContent || "").length, 0);
  let semanticBonus = 0;
  if (rootElement.matches(ARTICLE_BODY_HINT_SELECTOR)) {
    semanticBonus = 6500;
  } else if (rootElement.matches("article")) {
    semanticBonus = 5000;
  } else if (rootElement.matches("main, [role='main']")) {
    semanticBonus = 1500;
  }

  return {
    rootElement,
    content,
    score: content.length + Math.min(blocks.length * 80, 4000) + semanticBonus - linkTextLength * 1.5
  };
}

/** 실제 문단과 직접 텍스트 div를 DOM 순서대로 모으고 같은 문장은 한 번만 남깁니다. */
function collectReadableBlockEntries(rootElement) {
  if (!rootElement) {
    return [];
  }
  const entries = [];
  const seenElements = new Set();
  const seenText = new Set();
  const standard = rootElement.matches("p, li, blockquote, h2, h3, h4, td, dd, .par, [role='paragraph']")
    ? [rootElement]
    : [];
  standard.push(...rootElement.querySelectorAll(
    "p, li, blockquote, h2, h3, h4, td, dd, .par, [role='paragraph']"
  ));
  const standardSet = new Set(standard);

  const directDivs = rootElement.matches("div") ? [rootElement] : [];
  directDivs.push(...rootElement.querySelectorAll("div"));

  for (const element of [...standard, ...directDivs]) {
    if (seenElements.has(element) || isBlockedContentElement(element) ||
        !isVisiblyReadableElement(element)) {
      continue;
    }
    seenElements.add(element);
    const text = standardSet.has(element)
      ? normalizeText(element.textContent || "")
      : getDirectReadableText(element);
    if (text.length < 20 || seenText.has(text)) {
      continue;
    }
    seenText.add(text);
    entries.push({ element, text });
  }

  entries.sort((left, right) => {
    if (left.element === right.element) {
      return 0;
    }
    return left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return entries;
}

/** div 자체와 인라인 자식에 바로 들어 있는 글만 읽어 거대한 중첩 div의 중복을 피합니다. */
function getDirectReadableText(element) {
  const pieces = [];
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.nodeValue || "");
    } else if (node.nodeType === Node.ELEMENT_NODE && INLINE_TEXT_TAGS.has(node.tagName)) {
      pieces.push(node.textContent || "");
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
      pieces.push(" ");
    }
  }
  return normalizeText(pieces.join(" "));
}

function extractCleanFallbackText(rootElement) {
  const ownerDocument = rootElement.ownerDocument || document;
  const ownerNodeFilter = ownerDocument.defaultView?.NodeFilter || NodeFilter;
  const walker = ownerDocument.createTreeWalker(rootElement, ownerNodeFilter.SHOW_TEXT);
  const pieces = [];
  let node;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    const text = normalizeText(node.nodeValue || "");
    if (!text || isBlockedContentElement(parent) || !isVisiblyReadableElement(parent)) {
      continue;
    }
    pieces.push(text);
  }
  return normalizeArticleText(pieces.join("\n"));
}

function isBlockedContentElement(element) {
  return Boolean(element?.closest?.(BLOCKED_CONTENT_SELECTOR));
}

/**
 * 숨겨진 공유창은 제외하되 비활성 탭이라는 이유만으로 본문을 버리지는 않습니다.
 * Chrome은 백그라운드 탭이나 content-visibility 영역의 rect를 0으로 보고할 수 있으므로,
 * 레이아웃 좌표 대신 현재 요소와 조상의 실제 숨김 스타일을 확인합니다.
 */
function isVisiblyReadableElement(element) {
  if (!element?.isConnected) {
    return false;
  }
  const ownerWindow = element.ownerDocument.defaultView;
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    const style = ownerWindow?.getComputedStyle(current);
    if (style && (style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse" || Number(style.opacity) === 0)) {
      return false;
    }
  }
  return element.ownerDocument.visibilityState === "hidden" || element.getClientRects().length > 0;
}

function isUsableArticleContent(content) {
  const normalized = normalizeText(content).toLowerCase();
  if (normalized.length < MIN_ARTICLE_LENGTH) {
    return false;
  }
  if (isEmbedMarkupPlaceholder(normalized)) {
    return false;
  }
  return !BLOCKED_PAGE_MESSAGES.some(
    (message) => normalized.includes(message) && normalized.length < 2000
  );
}

/** 본문이 비어 있을 때 저장 없이 현재 화면만 보고 실패 종류를 구분합니다. */
function diagnoseRenderedPageFailure(targetDocument = getArticleDocument()) {
  const pageText = normalizeText(targetDocument.body?.innerText || targetDocument.body?.textContent || "")
    .toLowerCase()
    .slice(0, 4000);
  if (BLOCKED_PAGE_MESSAGES.some((message) => pageText.includes(message))) {
    return {
      code: "blocked_page",
      message: "사이트의 접근 제한 또는 로봇 확인 화면이 열렸습니다."
    };
  }
  return {
    code: "body_missing",
    message: `렌더링을 기다렸지만 ${MIN_ARTICLE_LENGTH}자 이상의 본문이 나타나지 않았습니다.`
  };
}

/**
 * 공유 레이어가 `<iframe ...>` 코드를 글자로 노출하면 태그 길이만으로 최소 길이를 넘을 수
 * 있습니다. 마크업을 걷어낸 실제 문장이 부족한 경우에는 본문이 아니라 placeholder입니다.
 */
function isEmbedMarkupPlaceholder(content) {
  if (!/<(?:iframe|embed|object)\b/i.test(content)) {
    return false;
  }
  const readableText = normalizeText(
    content
      .replace(/<(?:iframe|embed|object)\b[^>]*>[\s\S]*?<\/(?:iframe|object)>/gi, " ")
      .replace(/<(?:iframe|embed|object)\b[^>]*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/(?:공유하기|퍼가기|url\s*복사|창\s*닫기)/gi, " ")
  );
  return readableText.length < MIN_ARTICLE_LENGTH;
}

function toSerializableArticle(article) {
  return {
    url: article.url,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    content: article.content,
    documentType: article.documentType || "html",
    source: article.source || "rendered"
  };
}

/* =============================================================================
 * 4. Text Node 범위 기반 하이라이트
 * ========================================================================== */

/**
 * 문장이 여러 span/strong에 나뉘어 있어도 Text Node 위치표로 Range를 만듭니다.
 * Chrome의 CSS Highlight API를 우선 사용해 원래 기사 DOM을 직접 감싸지 않습니다.
 */
function applyQueryHighlights(highlights, rootElement) {
  if (!Array.isArray(highlights) || highlights.length === 0 || !rootElement) {
    return 0;
  }

  clearQueryHighlights();
  const ownerDocument = rootElement.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || globalThis;
  ensureHighlightStyles(ownerDocument);
  const blocks = collectReadableBlockEntries(rootElement);
  const ranges = [];
  const rangeElements = [];
  const fallbackElements = [];

  for (const highlight of highlights) {
    const match = findRangeForQuote(blocks, highlight?.text || "", rootElement);
    if (match?.range) {
      ranges.push(match.range);
      rangeElements.push(match.element);
    } else if (match?.element) {
      fallbackElements.push(match.element);
    }
  }

  const supportsCssHighlights = Boolean(
    ownerWindow.CSS?.highlights && typeof ownerWindow.Highlight === "function"
  );
  if (ranges.length > 0 && supportsCssHighlights) {
    ownerWindow.CSS.highlights.set(CSS_HIGHLIGHT_NAME, new ownerWindow.Highlight(...ranges));
  } else if (ranges.length > 0) {
    fallbackElements.push(...rangeElements);
  }
  for (const element of [...new Set(fallbackElements)]) {
    element.classList.add("gurajegeo-highlight-block");
  }
  return ranges.length + fallbackElements.length;
}

/** 원문 인용과 가장 작은 본문 블록을 연결하고 필요하면 전체 본문에서 다시 찾습니다. */
function findRangeForQuote(blocks, quote, rootElement) {
  const comparableQuote = normalizeForHighlightComparison(quote);
  if (!comparableQuote) {
    return null;
  }

  const candidates = blocks
    .filter((entry) => normalizeForHighlightComparison(entry.text).includes(comparableQuote))
    .sort((left, right) => left.text.length - right.text.length);
  for (const candidate of candidates) {
    const mapped = buildComparableTextMap(candidate.element);
    const range = createRangeFromMappedText(mapped, comparableQuote);
    if (range) {
      return { range, element: candidate.element };
    }
  }

  // 분석 당시 문단 태그와 현재 화면 태그가 달라도 본문 루트 전체 Text Node에서 찾습니다.
  if (rootElement) {
    const mappedRoot = buildComparableTextMap(rootElement);
    const searchValues = [
      comparableQuote,
      comparableQuote.slice(0, 120),
      comparableQuote.slice(0, 80),
      comparableQuote.slice(0, 40)
    ].filter((value, index, values) => value.length >= 20 && values.indexOf(value) === index);
    for (const searchValue of searchValues) {
      const range = createRangeFromMappedText(mappedRoot, searchValue);
      if (range) {
        return { range, element: rootElement };
      }
    }
  }
  return candidates[0] ? { range: null, element: candidates[0].element } : null;
}

/** 정규화 문자열의 위치표를 원래 Text Node 오프셋으로 되돌려 DOM Range를 만듭니다. */
function createRangeFromMappedText(mapped, comparableQuote) {
  const startIndex = mapped.text.indexOf(comparableQuote);
  if (startIndex < 0) {
    return null;
  }
  const start = mapped.positions[startIndex];
  const end = mapped.positions[startIndex + comparableQuote.length - 1];
  if (!start || !end) {
    return null;
  }
  const range = start.node.ownerDocument.createRange();
  range.setStart(start.node, start.startOffset);
  range.setEnd(end.node, end.endOffset);
  return range;
}

/** 정규화된 각 글자가 원래 어느 Text Node 오프셋인지 기록합니다. */
function buildComparableTextMap(rootElement) {
  const ownerDocument = rootElement.ownerDocument || document;
  const ownerNodeFilter = ownerDocument.defaultView?.NodeFilter || NodeFilter;
  const walker = ownerDocument.createTreeWalker(rootElement, ownerNodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isBlockedContentElement(node.parentElement)
        ? ownerNodeFilter.FILTER_REJECT
        : ownerNodeFilter.FILTER_ACCEPT;
    }
  });
  let text = "";
  const positions = [];
  let node;

  while ((node = walker.nextNode())) {
    const value = node.nodeValue || "";
    for (let offset = 0; offset < value.length;) {
      const codePoint = value.codePointAt(offset);
      const original = String.fromCodePoint(codePoint);
      const width = original.length;
      const normalized = normalizeForHighlightComparison(original);
      for (const char of normalized) {
        text += char;
        positions.push({ node, startOffset: offset, endOffset: offset + width });
      }
      offset += width;
    }
  }
  return { text, positions };
}

/** 분석/렌더링 사이의 따옴표·가운뎃점·문장부호 차이는 하이라이트 매칭에서 무시합니다. */
function normalizeForHighlightComparison(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function clearQueryHighlights() {
  const documents = new Set([document, getArticleDocument()]);
  for (const targetDocument of documents) {
    targetDocument.defaultView?.CSS?.highlights?.delete(CSS_HIGHLIGHT_NAME);
    for (const element of targetDocument.querySelectorAll(".gurajegeo-highlight-block")) {
      element.classList.remove("gurajegeo-highlight-block");
    }
  }
}

/** content_scripts의 CSS가 iframe 안까지 들어가지 않으므로 같은 출처 글 iframe에만 넣습니다. */
function ensureHighlightStyles(targetDocument) {
  if (targetDocument === document || targetDocument.getElementById("gurajegeo-highlight-styles")) {
    return;
  }
  const style = targetDocument.createElement("style");
  style.id = "gurajegeo-highlight-styles";
  style.textContent = `
    ::highlight(${CSS_HIGHLIGHT_NAME}) {
      background: rgba(0, 188, 212, 0.32);
      color: inherit;
      text-decoration: underline 2px #00bcd4;
    }
    .gurajegeo-highlight-block {
      padding: 6px 8px !important;
      border-left: 4px solid #00bcd4 !important;
      border-radius: 4px !important;
      background: rgba(0, 188, 212, 0.22) !important;
    }
  `;
  (targetDocument.head || targetDocument.documentElement).append(style);
}

/** 동적 페이지가 본문 DOM을 교체하면 같은 근거를 새 Text Node에 다시 적용합니다. */
function observeArticleForHighlightReapply(highlights, generation) {
  disconnectArticleObserver();
  if (!highlights.length) {
    return;
  }

  let timer;
  const observedArticle = extractRenderedArticle();
  const observerWindow = observedArticle.rootElement?.ownerDocument?.defaultView || globalThis;
  articleMutationObserver = new observerWindow.MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (generation !== articleGeneration) {
        disconnectArticleObserver();
        return;
      }
      const article = extractRenderedArticle();
      applyQueryHighlights(highlights, article.rootElement);
    }, 300);
  });
  articleMutationObserver.observe(observedArticle.rootElement || document.documentElement, {
    childList: true,
    subtree: true
  });
  setTimeout(() => {
    if (generation === articleGeneration) {
      disconnectArticleObserver();
    }
  }, 15000);
}

function disconnectArticleObserver() {
  articleMutationObserver?.disconnect();
  articleMutationObserver = null;
}

/* =============================================================================
 * 5. URL과 작은 DOM 유틸리티
 * ========================================================================== */

function isGoogleSearchPage() {
  return ["www.google.com", "www.google.co.kr"].includes(location.hostname) &&
    location.pathname === "/search";
}

/** 추적 파라미터를 제거한 외부 HTTP URL만 검색 결과로 허용합니다. */
function normalizeExternalUrl(rawUrl) {
  const normalized = normalizeUrlForMatching(rawUrl);
  if (!normalized) {
    return null;
  }
  const url = new URL(normalized);
  return /(^|\.)google\.(com|co\.kr)$/.test(url.hostname) ? null : normalized;
}

/** URL 매칭용: fragment·추적 파라미터·불필요한 끝 슬래시만 제거합니다. */
function normalizeUrlForMatching(rawUrl) {
  try {
    const url = new URL(rawUrl, location.href);
    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|ref$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 수집 탭이 요청한 사이트까지 이동했는지만 빠르게 확인합니다.
 * canonical URL·기사 ID·제목을 이용한 최종 동일 기사 검증은 background.js가 담당합니다.
 */
function isExpectedCollectionPage(expectedValue, actualValue) {
  const expected = normalizeUrlForMatching(expectedValue);
  const actual = normalizeUrlForMatching(actualValue);
  if (!expected || !actual) {
    return false;
  }
  if (expected === actual) {
    return true;
  }
  const expectedUrl = new URL(expected);
  const actualUrl = new URL(actual);
  const expectedHost = expectedUrl.hostname.replace(/^(www\.|m\.)/, "");
  const actualHost = actualUrl.hostname.replace(/^(www\.|m\.)/, "");
  return getSiteKey(expectedHost) === getSiteKey(actualHost);
}

/** www·m·news처럼 달라지는 서브도메인을 같은 사이트로 비교합니다. */
function getSiteKey(hostname) {
  const labels = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) {
    return labels.join(".");
  }
  const lastTwo = labels.slice(-2).join(".");
  return COUNTRY_SECOND_LEVEL_DOMAINS.has(lastTwo)
    ? labels.slice(-3).join(".")
    : lastTwo;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

/** 화면 메타데이터용: 줄바꿈을 포함한 연속 공백을 한 칸으로 합칩니다. */
function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

/** 본문·하이라이트용: 문단 경계는 남기고 문단 내부 공백만 정리합니다. */
function normalizeArticleText(value) {
  return String(value)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** 검색어 포함 여부용: 공백과 유니코드 표기 차이만 무시합니다. */
function normalizeForComparison(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** callback 기반 Chrome 메시지를 예외가 보존되는 Promise로 감쌉니다. */
function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

})();
