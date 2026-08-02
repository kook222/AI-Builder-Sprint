/**
 * Google 검색 페이지 전용 자동 실행 조정자입니다.
 * 검색어·페이지·검색 영역이 바뀔 때 한 번만 Service Worker에 시작을 요청하며,
 * 팝업의 수동 실행 버튼은 재시도 용도로 그대로 유지합니다.
 */
(() => {
  if (globalThis.__GURAJEGO_GOOGLE_AUTO_RUN_LOADED__) return;
  globalThis.__GURAJEGO_GOOGLE_AUTO_RUN_LOADED__ = true;

  const IDENTITY_POLL_MS = 300;
  const RESULTS_WAIT_MS = 250;
  const RESULTS_WAIT_ATTEMPTS = 40;
  const AUTO_RUN_DELAY_MS = 600;
  const MAX_AUTO_ATTEMPTS = 3;

  let currentIdentity = getSearchIdentity(location.href);
  let completedIdentity = "";
  let completedResultsSignature = "";
  let inFlightIdentity = "";
  let attemptIdentity = currentIdentity;
  let attemptCount = 0;
  let scheduleToken = 0;
  let scheduleTimer = null;

  scheduleAutoRun(currentIdentity);

  new MutationObserver((mutations) => {
    const onlyExtensionUiChanged = mutations.every((mutation) =>
      [...mutation.addedNodes, ...mutation.removedNodes].every((node) =>
        node.nodeType === Node.ELEMENT_NODE && (
          node.matches?.("[data-gurajegeo-ui]") ||
          node.closest?.("[data-gurajegeo-ui]")
        )
      )
    );
    if (onlyExtensionUiChanged) return;
    if (currentIdentity && currentIdentity !== completedIdentity) {
      scheduleAutoRun(currentIdentity);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Google은 새 문서를 열지 않고 같은 탭에서 검색 결과를 교체할 수 있으므로
  // URL의 실행 단위가 바뀌는지만 가볍게 확인합니다.
  setInterval(() => {
    const nextIdentity = getSearchIdentity(location.href);
    if (nextIdentity === currentIdentity) return;
    currentIdentity = nextIdentity;
    completedIdentity = "";
    resetAttempts(nextIdentity);
    scheduleAutoRun(nextIdentity);
  }, IDENTITY_POLL_MS);

  window.addEventListener("pageshow", () => scheduleAutoRun(getSearchIdentity(location.href)));

  // 검색 페이지를 먼저 연 뒤 API 키를 저장하거나 기능을 새로 켠 경우에도
  // 버튼을 누르지 않고 현재 화면을 한 번 분석합니다. 기능을 끄는 변화는 재실행하지 않습니다.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const change = areaName === "local" && changes.gurajegeoSettings;
    if (!change || !becameRunnable(change.oldValue, change.newValue)) return;
    currentIdentity = getSearchIdentity(location.href);
    completedIdentity = "";
    completedResultsSignature = "";
    resetAttempts(currentIdentity);
    scheduleAutoRun(currentIdentity);
  });

  function scheduleAutoRun(identity) {
    clearTimeout(scheduleTimer);
    const token = ++scheduleToken;
    scheduleTimer = setTimeout(() => {
      requestAutoRun(identity, token).catch(() => undefined);
    }, AUTO_RUN_DELAY_MS);
  }

  async function requestAutoRun(identity, token) {
    if (!identity || identity === completedIdentity || identity === inFlightIdentity) return;
    if (attemptIdentity !== identity) resetAttempts(identity);
    if (attemptCount >= MAX_AUTO_ATTEMPTS) return;

    const resultsReady = await waitForSearchResults(identity, token);
    if (!resultsReady || token !== scheduleToken || identity !== getSearchIdentity(location.href)) {
      return;
    }

    inFlightIdentity = identity;
    attemptCount += 1;
    try {
      const response = await chrome.runtime.sendMessage({
        target: "gj:core",
        type: "AUTO_RUN",
        identity,
        pageUrl: location.href,
      });
      if (response?.ok && response.data?.accepted) {
        completedIdentity = identity;
        completedResultsSignature = getSearchResultsSignature();
      } else if (response?.data?.reason !== "not-ready") {
        scheduleRetry(identity, token);
      }
    } catch {
      scheduleRetry(identity, token);
    } finally {
      if (inFlightIdentity === identity) inFlightIdentity = "";
    }
  }

  async function waitForSearchResults(identity, token) {
    for (let attempt = 0; attempt < RESULTS_WAIT_ATTEMPTS; attempt += 1) {
      if (token !== scheduleToken || identity !== getSearchIdentity(location.href)) return false;
      const signature = getSearchResultsSignature();
      const resultsUpdated = !completedResultsSignature || signature !== completedResultsSignature;
      if (signature && resultsUpdated) return true;
      await new Promise((resolve) => setTimeout(resolve, RESULTS_WAIT_MS));
    }
    // 링크 구성이 우연히 이전 검색과 완전히 같아도 10초 동안 현재 identity가
    // 유지됐다면 새 화면으로 간주합니다. 즉시 실행하지 않아 이전 DOM 오인을 막습니다.
    return identity === getSearchIdentity(location.href) && Boolean(getSearchResultsSignature());
  }

  function scheduleRetry(identity, token) {
    if (token !== scheduleToken || identity !== getSearchIdentity(location.href) ||
        attemptCount >= MAX_AUTO_ATTEMPTS) return;
    clearTimeout(scheduleTimer);
    const retryToken = ++scheduleToken;
    scheduleTimer = setTimeout(() => {
      requestAutoRun(identity, retryToken).catch(() => undefined);
    }, 1000 * attemptCount);
  }

  function resetAttempts(identity) {
    attemptIdentity = identity;
    attemptCount = 0;
  }

  /** UI 문구가 아니라 결과 링크를 비교해 이전 검색 DOM을 새 검색으로 오인하지 않습니다. */
  function getSearchResultsSignature() {
    return [...document.querySelectorAll("h3")]
      .map((heading) => ({
        heading,
        anchor: heading.closest("a") || heading.parentElement?.closest("a"),
      }))
      .filter(({ anchor }) => /^https?:/i.test(anchor?.href || ""))
      .slice(0, 30)
      .map(({ heading, anchor }) => {
        const cleanHeading = heading.cloneNode(true);
        cleanHeading.querySelectorAll?.("[data-gurajegeo-ui]").forEach((node) => node.remove());
        return `${anchor.href}\t${String(cleanHeading.textContent || "").replace(/\s+/g, " ").trim()}`;
      })
      .join("\n");
  }

  function becameRunnable(previous, next) {
    const oldKey = String(previous?.apiKey || "").trim();
    const newKey = String(next?.apiKey || "").trim();
    if (newKey && oldKey !== newKey) return true;
    if (!newKey) return false;
    return ["title", "risk", "official"].some((feature) =>
      previous?.features?.[feature] === false && next?.features?.[feature] !== false
    );
  }

  function getSearchIdentity(value) {
    try {
      const url = new URL(value);
      if (!/^www\.google\.(?:com|co\.kr)$/.test(url.hostname) || url.pathname !== "/search") {
        return "";
      }
      return JSON.stringify({
        q: String(url.searchParams.get("q") || "").trim(),
        start: String(url.searchParams.get("start") || "0").trim(),
        tbm: String(url.searchParams.get("tbm") || "").trim(),
        udm: String(url.searchParams.get("udm") || "").trim(),
      });
    } catch {
      return "";
    }
  }
})();
