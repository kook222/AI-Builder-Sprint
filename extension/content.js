const BADGE_ATTRIBUTE = "data-official-badge-checked";
const SUPPORTED_CLASSIFICATIONS = ["OFFICIAL", "AUTHORITATIVE"];
const MIN_CONFIDENCE = 0.7;
const MAX_RESULTS = 12;

let classificationTimer;
let isEnabled = false;
let searchGeneration = 0;
let lastQuery = new URL(location.href).searchParams.get("q") || "";

function clearClassificationState() {
  // 진행 중인 이전 검색의 응답이 도착해도 적용되지 않도록 무효화합니다.
  searchGeneration += 1;
  clearTimeout(classificationTimer);
  document.querySelectorAll(".osb-badge").forEach((badge) => badge.remove());
  document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach((heading) => {
    heading.removeAttribute(BADGE_ATTRIBUTE);
  });
  document.querySelectorAll("[data-official-badge-bound]").forEach((anchor) => {
    delete anchor.dataset.officialBadgeBound;
  });
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);

    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }

    return {
      url: url.href,
    };
  } catch {
    return null;
  }
}

// 검색 결과의 YouTube 채널은 허용하고 개별 영상만 제외합니다.
function isYouTubeVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, "");

    if (hostname === "youtu.be") {
      return url.pathname.length > 1;
    }

    const isYouTube =
      hostname === "youtube.com" || hostname.endsWith(".youtube.com");
    const isVideoPath =
      url.pathname === "/watch" || /^\/(?:shorts|live)\//i.test(url.pathname);

    return isYouTube && isVideoPath;
  } catch {
    return false;
  }
}

function collectSearchResults() {
  const seenUrls = new Set();
  const results = [];

  for (const heading of document.querySelectorAll("h3")) {
    const anchor = heading.closest("a") || heading.parentElement?.closest("a");

    if (anchor && isYouTubeVideoUrl(anchor.href)) {
      anchor.dataset.officialBadgeBound = "1";
      continue;
    }

    const urlInfo = anchor && normalizeUrl(anchor.href);

    if (
      !urlInfo ||
      seenUrls.has(urlInfo.url) ||
      anchor.dataset.officialBadgeBound ||
      // 중복 판정 방지
      heading.hasAttribute(BADGE_ATTRIBUTE)
    ) {
      continue;
    }

    const container =
      heading.closest("div.MjjYud") ||
      heading.closest("div[data-snhf]") ||
      heading.parentElement;

    seenUrls.add(urlInfo.url);
    results.push({
      id: results.length,
      title: heading.textContent.trim(),
      snippet: container?.innerText?.slice(0, 700) || "",
      heading,
      anchor,
      ...urlInfo,
    });
  }

  return results.slice(0, MAX_RESULTS);
}

function addBadge(result, verdict) {
  result.anchor.dataset.officialBadgeBound = "1";

  // 공식 또는 공신력 판정이면서 신뢰도가 기준 이상일 때만 표시
  if (
    !verdict ||
    !SUPPORTED_CLASSIFICATIONS.includes(verdict.classification) ||
    verdict.confidence < MIN_CONFIDENCE
  ) {
    return;
  }
  if (result.heading.querySelector(":scope > .osb-badge")) {
    return;
  }

  const badge = document.createElement("span");
  badge.className = `osb-badge osb-${verdict.classification.toLowerCase()}`;
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
  result.heading.append(badge);
}

async function classifyVisibleResults() {
  if (!isEnabled) {
    return;
  }

  // 요청 당시의 검색어와 세대 번호를 응답 시점에 다시 확인합니다.
  const requestGeneration = searchGeneration;
  const query = new URL(location.href).searchParams.get("q") || "";
  const results = collectSearchResults();

  if (results.length === 0) {
    return;
  }

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
      type: "CLASSIFY_RESULTS",
      payload: {
        query,
        results: payloadResults,
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || "분류 실패");
    }

    if (!isEnabled) {
      return;
    }

    const currentQuery = new URL(location.href).searchParams.get("q") || "";
    // 연속 검색으로 화면이 바뀌었다면 늦게 도착한 이전 응답은 버립니다.
    if (requestGeneration !== searchGeneration || query !== currentQuery) {
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
        addBadge(result, verdict);
      }
    });
  } catch (error) {
    console.warn("[공식 사이트 딱지]", error.message || "분류 실패");
  } finally {
    // 오래된 요청이 새 검색 결과의 처리 상태를 지우지 않게 합니다.
    const currentQuery = new URL(location.href).searchParams.get("q") || "";
    if (requestGeneration === searchGeneration && query === currentQuery) {
      results.forEach(({ heading }) => {
        heading.removeAttribute(BADGE_ATTRIBUTE);
      });
    }
  }
}

function scheduleClassification() {
  const currentQuery = new URL(location.href).searchParams.get("q") || "";

  if (currentQuery !== lastQuery) {
    clearClassificationState();
    lastQuery = currentQuery;
  }

  clearTimeout(classificationTimer);
  if (!isEnabled) {
    return;
  }

  classificationTimer = setTimeout(() => {
    classifyVisibleResults().catch(console.error);
  }, 700);
}

new MutationObserver(scheduleClassification).observe(document.body, {
  childList: true,
  subtree: true,
});

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  isEnabled = enabled;
  scheduleClassification();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.enabled) {
    return;
  }

  isEnabled = changes.enabled.newValue !== false;
  clearClassificationState();

  if (isEnabled) {
    scheduleClassification();
  }
});
