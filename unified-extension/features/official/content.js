(() => {
if (globalThis.__GURAJEGO_OFFICIAL_CONTENT_LOADED__) return;
globalThis.__GURAJEGO_OFFICIAL_CONTENT_LOADED__ = true;
const SETTINGS_KEY = "gurajegeoSettings";
const BADGE_ATTRIBUTE = "data-gurajegeo-official-checked";
const SUPPORTED_CLASSIFICATIONS = ["OFFICIAL", "AUTHORITATIVE"];
const MIN_CONFIDENCE = 0.7;

let classificationTimer;
let featureReady = false;
let isEnabled = false;
let activePageKey = "";
let activeRunId = "";
let searchGeneration = 0;
let settingsGeneration = 0;
let inFlightGeneration = null;
let rerunRequested = false;
let initialBatchPending = false;

function clearClassificationState() {
  // 진행 중인 이전 검색의 응답이 도착해도 적용되지 않도록 무효화합니다.
  searchGeneration += 1;
  rerunRequested = false;
  initialBatchPending = false;
  clearTimeout(classificationTimer);
  document.querySelectorAll('[data-gurajegeo-ui="official"]').forEach((badge) => badge.remove());
  document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach((heading) => {
    heading.removeAttribute(BADGE_ATTRIBUTE);
  });
  document.querySelectorAll("[data-gurajegeo-official-bound]").forEach((anchor) => {
    delete anchor.dataset.gurajegeoOfficialBound;
  });
  document.querySelectorAll('[data-gurajegeo-ui="result-hub"]:empty').forEach((hub) => hub.remove());
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);

    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }

    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return { url: url.href };
  } catch {
    return null;
  }
}

// 공식 SNS 프로필/채널은 허용하고 개별 게시물, 영상, 릴스 등은 제외합니다.
function isSocialMediaContentUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^(?:www\.|m\.)/, "").toLowerCase();
    const pathname = url.pathname.replace(/\/{2,}/g, "/");

    if (hostname === "youtu.be") {
      return pathname.length > 1;
    }

    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
      return pathname === "/watch" || /^\/(?:shorts|live)\//i.test(pathname);
    }

    if (hostname === "instagram.com") {
      return /^\/(?:p|reel|reels|stories|tv)\//i.test(pathname);
    }

    if (hostname === "x.com" || hostname === "twitter.com") {
      return /^\/[^/]+\/status\/\d+/i.test(pathname);
    }

    if (hostname === "tiktok.com") {
      return /^\/(?:@[^/]+\/video|t)\//i.test(pathname);
    }

    if (hostname === "facebook.com" || hostname === "fb.watch") {
      return (
        hostname === "fb.watch" ||
        /^\/(?:watch|reel|reels|stories|photo|photos|videos|posts|share)\b/i.test(
          pathname,
        ) ||
        /^\/[^/]+\/(?:posts|videos)\//i.test(pathname) ||
        url.searchParams.has("story_fbid")
      );
    }

    if (hostname === "linkedin.com") {
      return /^\/(?:feed\/update|posts)\//i.test(pathname);
    }

    return false;
  } catch {
    return false;
  }
}

function collectSearchResults() {
  const seenUrls = new Set();
  const results = [];

  for (const heading of document.querySelectorAll("h3")) {
    const anchor = heading.closest("a") || heading.parentElement?.closest("a");

    if (anchor && isSocialMediaContentUrl(anchor.href)) {
      anchor.dataset.gurajegeoOfficialBound = normalizeUrl(anchor.href)?.url || anchor.href;
      continue;
    }

    const urlInfo = anchor && normalizeUrl(anchor.href);

    // Google은 같은 DOM 노드에 다른 검색 결과를 재사용합니다. URL이 바뀌었으면 이전
    // 완료 표식만 버리고, 같은 URL이면 UNKNOWN 결과도 다시 API로 보내지 않습니다.
    if (anchor?.dataset.gurajegeoOfficialBound &&
        anchor.dataset.gurajegeoOfficialBound !== urlInfo?.url) {
      delete anchor.dataset.gurajegeoOfficialBound;
    }

    if (
      !urlInfo ||
      seenUrls.has(urlInfo.url) ||
      anchor.dataset.gurajegeoOfficialBound === urlInfo.url ||
      // 중복 판정 방지
      heading.hasAttribute(BADGE_ATTRIBUTE)
    ) {
      continue;
    }

    if (isExcludedAnalysisResult(urlInfo.url, heading)) {
      anchor.dataset.gurajegeoOfficialBound = urlInfo.url;
      continue;
    }

    const container =
      heading.closest("div.MjjYud") ||
      heading.closest("div[data-snhf]") ||
      heading.parentElement;

    seenUrls.add(urlInfo.url);
    results.push({
      id: results.length,
      title: readCleanElementText(heading).slice(0, 240),
      snippet: readCleanElementText(container).slice(0, 1000),
      heading,
      anchor,
      ...urlInfo,
    });
  }

  return results;
}

/** 위키 문서와 PDF는 통합 확장의 세 분석 기능에서 공통으로 제외합니다. */
function isExcludedAnalysisResult(rawUrl, heading) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const path = decodeURIComponent(`${url.pathname}${url.search}`).toLowerCase();
    const card = heading.closest("div.MjjYud") || heading.closest("div[data-snhf]") || heading.parentElement;
    const hasPdfBadge = [...(card?.querySelectorAll("span, div") || [])]
      .some((element) => String(element.textContent || "").trim().toUpperCase() === "PDF");
    return host === "namu.wiki" || host === "wikipedia.org" || host.endsWith(".wikipedia.org") ||
      /\.pdf(?:$|[?&#])/i.test(path) || hasPdfBadge ||
      Boolean(card?.querySelector("a[type='application/pdf'], a[href*='.pdf' i]"));
  } catch {
    return true;
  }
}

function addBadge(result, verdict) {
  // 공식 또는 공신력 판정이면서 신뢰도가 기준 이상일 때만 표시
  if (
    !verdict ||
    !SUPPORTED_CLASSIFICATIONS.includes(verdict.classification) ||
    verdict.confidence < MIN_CONFIDENCE
  ) {
    return;
  }
  const hub = getResultHub(result.heading);
  if (hub.querySelector(':scope > [data-gurajegeo-ui="official"]')) {
    return;
  }

  const badge = document.createElement("span");
  badge.className = `osb-badge osb-${verdict.classification.toLowerCase()}`;
  badge.dataset.gurajegeoUi = "official";
  badge.tabIndex = 0;
  badge.setAttribute(
    "aria-label",
    `${verdict.classification === "OFFICIAL" ? "공식 사이트" : "준공식 또는 공신력 있는 사이트"}, 확신도 ${Math.round(verdict.confidence * 100)}%, ${verdict.reason}`,
  );

  const dot = document.createElement("span");
  dot.className = "osb-dot";

  const tooltip = document.createElement("span");
  tooltip.className = "osb-tooltip";

  const confidence = document.createElement("strong");
  confidence.textContent = `확신도 ${Math.round(verdict.confidence * 100)}%`;

  const reason = document.createElement("span");
  reason.textContent = verdict.reason;

  tooltip.append(confidence, reason);
  badge.append(dot, tooltip);
  hub.append(badge);
}

async function classifyVisibleResults() {
  if (!isActiveSearchPage()) {
    deactivateSearchPage();
    return;
  }
  if (inFlightGeneration === searchGeneration) {
    rerunRequested = true;
    return;
  }

  // 요청 당시의 검색 페이지와 세대 번호를 응답 시점에 다시 확인합니다.
  const requestGeneration = searchGeneration;
  const requestPageKey = activePageKey;
  const requestRunId = activeRunId;
  const query = new URL(location.href).searchParams.get("q") || "";
  const results = collectSearchResults();

  if (results.length === 0) {
    // BEGIN_RUN 뒤 첫 분류에서 결과 DOM이 사라졌다면 background 실행을 반드시
    // 끝냅니다. 이후 MutationObserver 재검사는 단순히 다음 DOM 변화를 기다립니다.
    if (initialBatchPending && requestRunId && requestRunId === activeRunId) {
      initialBatchPending = false;
      await cancelOfficialRun(requestRunId, location.href);
      clearActiveSearchPage(requestRunId);
    }
    return;
  }
  initialBatchPending = false;
  inFlightGeneration = requestGeneration;

  results.forEach(({ heading }) => {
    heading.setAttribute(BADGE_ATTRIBUTE, "pending");
  });

  const payloadResults = results.map(({ id, title, url, snippet }) => ({
    id,
    title,
    url,
    snippet,
  }));

  try {
    const response = await chrome.runtime.sendMessage({
      target: "gj:official",
      type: "CLASSIFY_RESULTS",
      payload: {
        runId: requestRunId,
        query,
        pageUrl: location.href,
        results: payloadResults,
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || "분류 실패");
    }

    if (!isActiveSearchPage()) {
      return;
    }

    // 연속 검색으로 화면이 바뀌었다면 늦게 도착한 이전 응답은 버립니다.
    if (requestGeneration !== searchGeneration || requestPageKey !== getSearchPageKey() ||
        requestRunId !== activeRunId) {
      return;
    }

    if (!Array.isArray(response.verdicts)) {
      throw new Error("분류 응답 형식이 올바르지 않습니다.");
    }

    const verdicts = response.verdicts;
    const verdictsById = new Map(
      verdicts.map((verdict) => [verdict.id, verdict]),
    );

    results.forEach((result) => {
      const verdict = verdictsById.get(result.id);
      const currentUrl = normalizeUrl(result.anchor.href)?.url;

      // Google이 검색 결과 DOM을 재사용한 경우 잘못된 링크에 붙이지 않습니다.
      if (verdict && result.heading.isConnected && currentUrl === result.url) {
        // UNKNOWN도 완료 상태로 기록해야 다른 기능의 DOM 변경 때 재호출되지 않습니다.
        result.anchor.dataset.gurajegeoOfficialBound = result.url;
        addBadge(result, verdict);
      }
    });
  } catch (error) {
    console.warn("[공식 사이트 딱지]", error.message || "분류 실패");
  } finally {
    // 오래된 요청이 새 검색 결과의 처리 상태를 지우지 않게 합니다.
    if (requestGeneration === searchGeneration && requestPageKey === getSearchPageKey() &&
        requestRunId === activeRunId) {
      results.forEach(({ heading }) => {
        heading.removeAttribute(BADGE_ATTRIBUTE);
      });
    }
    if (inFlightGeneration === requestGeneration) {
      inFlightGeneration = null;
      const shouldRerun = rerunRequested;
      rerunRequested = false;
      if (shouldRerun && isActiveSearchPage()) scheduleClassification();
    }
  }
}

function scheduleClassification() {
  clearTimeout(classificationTimer);
  if (!isActiveSearchPage()) {
    if (isEnabled) deactivateSearchPage();
    return;
  }
  if (inFlightGeneration === searchGeneration) {
    rerunRequested = true;
    return;
  }

  classificationTimer = setTimeout(() => {
    classifyVisibleResults().catch(console.error);
  }, 700);
}

new MutationObserver((mutations) => {
  // 제목 카드·위험 마크·공식 딱지 자체를 붙이는 변화에는 재분류하지 않습니다.
  const onlyExtensionUiChanged = mutations.every((mutation) =>
    [...mutation.addedNodes, ...mutation.removedNodes].every((node) =>
      node.nodeType === Node.ELEMENT_NODE && (
        node.matches?.("[data-gurajegeo-ui]") ||
        node.closest?.("[data-gurajegeo-ui]")
      )
    )
  );
  if (!onlyExtensionUiChanged) scheduleClassification();
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// 설치·새로고침 시에는 설정 가능 여부만 읽습니다. 실제 분석은 팝업의 RUN 명령을
// 받은 현재 q+start 검색 페이지에서만 활성화됩니다.
const initialSettingsGeneration = settingsGeneration;
readFeatureEnabled().then((enabled) => {
  if (settingsGeneration === initialSettingsGeneration) featureReady = enabled;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) {
    return;
  }

  const settingChange = changes[SETTINGS_KEY];
  if (officialSettingsSignature(settingChange.oldValue) === officialSettingsSignature(settingChange.newValue)) {
    return;
  }
  settingsGeneration += 1;
  featureReady = isOfficialReady(settingChange.newValue);
  deactivateSearchPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "gj:official-content") return false;
  if (message.type === "RUN") {
    activateCurrentSearchPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }
  if (message.type === "CLEAR") {
    deactivateSearchPage();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function hasCollectableSearchResult() {
  return [...document.querySelectorAll("h3")].some((heading) => {
    const anchor = heading.closest("a") || heading.parentElement?.closest("a");
    return anchor && normalizeUrl(anchor.href) &&
      !isSocialMediaContentUrl(anchor.href) &&
      !isExcludedAnalysisResult(anchor.href, heading);
  });
}

async function activateCurrentSearchPage() {
  const expectedSettingsGeneration = settingsGeneration;
  const currentReady = await readFeatureEnabled();
  if (expectedSettingsGeneration !== settingsGeneration) {
    throw new Error("공식 출처 설정이 변경되었습니다. 다시 실행해 주세요.");
  }
  featureReady = currentReady;
  if (!featureReady) {
    throw new Error("공식 출처 기능을 켜고 Upstage API 키를 입력해 주세요.");
  }
  if (!hasCollectableSearchResult()) {
    throw new Error("현재 화면에서 공식 출처를 판별할 일반 검색 결과를 찾지 못했습니다.");
  }

  clearClassificationState();
  const pageKey = getSearchPageKey();
  const pageUrl = location.href;
  const runId = createRunId();
  activePageKey = pageKey;
  activeRunId = runId;
  isEnabled = true;
  const response = await chrome.runtime.sendMessage({
    target: "gj:official",
    type: "BEGIN_RUN",
    payload: { runId },
  });
  if (!response?.ok) {
    await cancelOfficialRun(runId, pageUrl);
    clearActiveSearchPage(runId);
    throw new Error(response?.error || "공식 출처 분석 실행을 준비하지 못했습니다.");
  }

  // 설정 변경이나 Google SPA 이동이 BEGIN_RUN 응답보다 먼저 일어나면 앞선
  // CANCEL_RUN이 아직 등록되지 않은 실행을 놓칠 수 있습니다. 등록이 끝난 뒤
  // 캡처한 runId를 다시 명시적으로 취소해 고아 progress를 남기지 않습니다.
  if (expectedSettingsGeneration !== settingsGeneration || !featureReady ||
      activeRunId !== runId || activePageKey !== pageKey || getSearchPageKey() !== pageKey) {
    await cancelOfficialRun(runId, pageUrl);
    clearActiveSearchPage(runId);
    throw new Error("공식 출처 설정 또는 검색 페이지가 변경되었습니다. 다시 실행해 주세요.");
  }
  initialBatchPending = true;
  scheduleClassification();
}

function deactivateSearchPage() {
  const runId = activeRunId;
  const pageUrl = location.href;
  clearActiveSearchPage(runId);
  if (runId) void cancelOfficialRun(runId, pageUrl);
}

/** 캡처한 실행이 아직 현재 실행일 때만 로컬 UI 상태를 정리합니다. */
function clearActiveSearchPage(runId) {
  if (runId && activeRunId !== runId) return false;
  isEnabled = false;
  activePageKey = "";
  activeRunId = "";
  clearClassificationState();
  return true;
}

/** 전역 activeRunId가 바뀌어도 정확히 캡처한 background 실행을 종료합니다. */
function cancelOfficialRun(runId, pageUrl) {
  if (!runId) return Promise.resolve();
  return chrome.runtime.sendMessage({
    target: "gj:official",
    type: "CANCEL_RUN",
    payload: { runId, pageUrl },
  }).catch(() => undefined);
}

function isActiveSearchPage() {
  return featureReady && isEnabled && activePageKey && activePageKey === getSearchPageKey();
}

/** 검색어·페이지 번호·검색 영역(Web/뉴스/이미지)을 한 실행 단위로 식별합니다. */
function getSearchPageKey() {
  const params = new URL(location.href).searchParams;
  return JSON.stringify({
    q: String(params.get("q") || "").trim(),
    start: String(params.get("start") || "0").trim(),
    tbm: String(params.get("tbm") || "").trim(),
    udm: String(params.get("udm") || "").trim(),
  });
}

function createRunId() {
  return globalThis.crypto?.randomUUID?.() ||
    `official-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readFeatureEnabled() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return isOfficialReady(stored[SETTINGS_KEY]);
}

function isOfficialReady(settings) {
  return settings?.features?.official !== false && Boolean(String(settings?.apiKey || "").trim());
}

function officialSettingsSignature(settings) {
  return JSON.stringify({
    apiKey: String(settings?.apiKey || "").trim(),
    enabled: settings?.features?.official !== false,
  });
}

/** 다른 기능이 제목에 추가한 UI 텍스트를 모델 입력에서 제외합니다. */
function readCleanElementText(element) {
  if (!element) return "";
  const clone = element.cloneNode(true);
  clone.querySelectorAll("[data-gurajegeo-ui]")
    .forEach((node) => node.remove());
  return String(clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
}

/** 공식 딱지와 위험 딱지가 같은 줄을 공유해 서로 밀어내지 않게 합니다. */
function getResultHub(heading) {
  let hub = heading.querySelector(':scope > [data-gurajegeo-ui="result-hub"]');
  if (!hub) {
    hub = document.createElement("span");
    hub.className = "gj-result-hub";
    hub.dataset.gurajegeoUi = "result-hub";
    heading.append(hub);
  }
  return hub;
}
})();
