// 검색 결과에 광고성 · 피싱 · 로그인 필요 표시

(() => {
  if (!/^(www\.)?google\.[a-z.]+$/.test(location.hostname)) return;
  if (!location.pathname.startsWith('/search')) return;
  if (globalThis.__GURAJEGO_RISK_SERP_LOADED__) return;
  globalThis.__GURAJEGO_RISK_SERP_LOADED__ = true;

  const SETTINGS_KEY = 'gurajegeoSettings';
  const SEEN = 'gurajegeoRiskSeen';

  const MARKS = {
    phishing: { text: '피싱 의심', cls: 'ft-phishing' },
    ad: { text: '광고성', cls: 'ft-ad' },
    login: { text: '로그인 필요', cls: 'ft-login' },
  };

  let tip = null;
  let featureReady = false;
  let isEnabled = false;
  let activePageKey = '';
  let activeRunId = '';
  let activeTotal = 0;
  let generation = 0;
  let settingsGeneration = 0;
  let observer = null;
  const clickContexts = new WeakMap();

  // 마우스오버 설명 표시
  function showTip(anchor, kind, verdict) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ft-tip';
      tip.dataset.gurajegeoUi = 'risk';
      document.body.appendChild(tip);
    }

    const head = document.createElement('div');
    head.className = `ft-tip-head ft-tip-${kind}`;
    head.textContent = MARKS[kind].text;

    const body = document.createElement('div');
    body.className = 'ft-tip-body';
    body.textContent = verdict.reason || '자세한 근거를 받지 못했습니다.';

    const pieces = [head, body];

    if (verdict.parts?.length) {
      const label = document.createElement('div');
      label.className = 'ft-tip-label';
      label.textContent = '의심되는 부분';

      const list = document.createElement('ul');
      list.className = 'ft-tip-parts';
      for (const part of verdict.parts) {
        const li = document.createElement('li');
        li.textContent = part;
        list.appendChild(li);
      }
      pieces.push(label, list);
    }

    tip.replaceChildren(...pieces);
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';

    const box = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left), window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = box.bottom + window.scrollY + 6 + 'px';
    tip.style.visibility = 'visible';
  }

  function hideTip() {
    if (tip) tip.style.display = 'none';
  }

  function makeMark(kind, verdict) {
    const el = document.createElement('span');
    el.className = `ft-mark ${MARKS[kind].cls}`;
    el.dataset.gurajegeoUi = 'risk';
    el.textContent = MARKS[kind].text;

    el.addEventListener('mouseenter', () => showTip(el, kind, verdict));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    return el;
  }

  function clearMarks(h3) {
    hideTip();
    h3.querySelectorAll('[data-gurajegeo-ui="risk"]').forEach((el) => el.remove());
    h3.querySelectorAll(':scope > [data-gurajegeo-ui="result-hub"]:empty')
      .forEach((hub) => hub.remove());
  }

  function showPending(h3) {
    clearMarks(h3);
    const el = document.createElement('span');
    el.className = 'ft-mark ft-pending';
    el.dataset.gurajegeoUi = 'risk';
    el.textContent = '검사 중';
    getResultHub(h3).appendChild(el);
  }

  function showVerdict(h3, verdict) {
    clearMarks(h3);
    if (!verdict?.labels?.length) return;

    const hub = getResultHub(h3);
    for (const kind of verdict.labels) {
      if (MARKS[kind]) hub.appendChild(makeMark(kind, verdict));
    }
  }

  // 결과 요약문 추출
  function snippetOf(h3, title) {
    const block = h3.closest('div[data-hveid]') || h3.closest('div.g') || h3.parentElement;
    if (!block) return '';

    return cleanElementText(block)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== title)
      .filter((line) => !/^https?:\/\//.test(line) && !line.includes(' › ') && line !== '웹 검색결과')
      .join(' ')
      .slice(0, 300);
  }

  // 검색 결과 수집
  function collect() {
    const root = document.querySelector('#search') || document.querySelector('#rso');
    if (!root) return [];

    const items = [];

    for (const h3 of root.querySelectorAll('h3')) {
      if (h3.dataset[SEEN]) continue;

      const link = h3.closest('a[href]');
      if (!link) continue;

      const url = link.href;
      if (!/^https?:/.test(url)) continue;
      if (/^https?:\/\/[^/]*google\.[^/]+\//.test(url)) continue;
      if (isExcludedAnalysisResult(url, h3)) {
        h3.dataset[SEEN] = '1';
        continue;
      }

      h3.dataset[SEEN] = '1';

      const title = cleanElementText(h3);
      items.push({ id: 'r' + items.length + Date.now().toString(36), title, url, snippet: snippetOf(h3, title), h3, link });
    }

    return items;
  }

  /** 위키 문서와 PDF는 통합 확장의 세 분석 기능에서 공통으로 제외합니다. */
  function isExcludedAnalysisResult(url, heading) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '');
      const path = decodeURIComponent(`${parsed.pathname}${parsed.search}`).toLowerCase();
      const card = heading.closest('div[data-hveid]') || heading.closest('div.g') || heading.parentElement;
      const hasPdfBadge = [...(card?.querySelectorAll('span, div') || [])]
        .some((element) => String(element.textContent || '').trim().toUpperCase() === 'PDF');
      return host === 'namu.wiki' || host === 'wikipedia.org' || host.endsWith('.wikipedia.org') ||
        /\.pdf(?:$|[?&#])/i.test(path) || hasPdfBadge ||
        Boolean(card?.querySelector("a[type='application/pdf'], a[href*='.pdf' i]"));
    } catch {
      return true;
    }
  }

  async function run({ detachAfterRegistration = false } = {}) {
    if (!isEnabled || !isActiveSearchPage()) return;
    const query = new URLSearchParams(location.search).get('q');
    if (!query) return;

    const items = collect();
    if (!items.length) return;
    const runGeneration = generation;
    const runId = activeRunId;
    const runSettingsGeneration = settingsGeneration;
    const runPageUrl = location.href;
    activeTotal += items.length;

    items.forEach((it) => showPending(it.h3));

    const registration = await chrome.runtime.sendMessage({
      target: 'gj:risk',
      type: 'RUN_STARTED',
      runId,
      total: activeTotal,
      pageUrl: runPageUrl,
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if (!registration?.ok || registration.off || registration.error) {
      items.forEach(({ h3 }) => clearMarks(h3));
      throw new Error(registration?.error || '위험 분석 실행을 등록하지 못했습니다.');
    }
    if (runGeneration !== generation || runId !== activeRunId ||
        runSettingsGeneration !== settingsGeneration || !isActiveSearchPage()) {
      // RUN_STARTED가 성공한 직후 설정/페이지가 바뀔 수 있습니다. 전역 activeRunId는
      // 이미 새 실행으로 교체되었을 수 있으므로, 등록에 사용한 ID를 직접 취소합니다.
      await cancelRegisteredRun(runId, runPageUrl);
      throw new Error('위험 분석 설정 또는 검색 페이지가 변경되었습니다.');
    }

    for (const { link, url } of items) {
      clickContexts.set(link, { url, query });
      if (link.dataset.gurajegeoRiskClickBound !== '1') {
        link.dataset.gurajegeoRiskClickBound = '1';
        link.addEventListener('mousedown', () => {
          const context = clickContexts.get(link);
          if (!context) return;
          chrome.runtime.sendMessage({
            target: 'gj:risk',
            type: 'CLICKED',
            runId,
            url: context.url,
            query: context.query,
          }).catch(() => {});
        });
      }
    }

    const analysis = Promise.all(
      items.map(async ({ id, title, url, snippet, h3 }) => {
        try {
          const res = await chrome.runtime.sendMessage({
            target: 'gj:risk',
            type: 'ANALYZE_RESULT',
            runId,
            query,
            result: { id, title, url, snippet },
          });

          if (runGeneration !== generation || !isEnabled) return;
          if (!res || res.off || res.error) clearMarks(h3);
          else showVerdict(h3, res.verdict);
        } catch {
          clearMarks(h3);
        }
      })
    );
    if (detachAfterRegistration) {
      void analysis.catch(() => undefined);
      return;
    }
    await analysis;
  }

  // 목록 변화 감시
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!isActiveSearchPage()) {
        deactivateSearchPage();
        return;
      }
      run().catch(() => undefined);
    }, 600);
  };

  const initialSettingsGeneration = settingsGeneration;
  chrome.storage.local.get(SETTINGS_KEY, (stored) => {
    if (settingsGeneration === initialSettingsGeneration) {
      featureReady = isRiskReady(stored[SETTINGS_KEY]);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
    const settingChange = changes[SETTINGS_KEY];
    if (riskSettingsSignature(settingChange.oldValue) === riskSettingsSignature(settingChange.newValue)) return;
    settingsGeneration += 1;
    featureReady = isRiskReady(settingChange.newValue);
    // API 키 교체도 기존 판정과 실행을 폐기합니다. 새 키 분석은 다음 RUN에서만 시작합니다.
    deactivateSearchPage();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'gj:risk-content') return false;
    if (message.type === 'RUN') {
      activateRiskSearchPage()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      return true;
    }
    if (message.type === 'CLEAR') {
      deactivateSearchPage();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  async function activateRiskSearchPage() {
    const expectedSettingsGeneration = settingsGeneration;
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    if (expectedSettingsGeneration !== settingsGeneration || !isRiskReady(stored[SETTINGS_KEY])) {
      throw new Error('피싱·광고 위험 기능을 켜고 API 키를 입력해 주세요.');
    }
    if (!new URLSearchParams(location.search).get('q') || !hasCollectableSearchResult()) {
      throw new Error('현재 화면에서 위험 분석할 일반 검색 결과를 찾지 못했습니다.');
    }

    featureReady = true;
    isEnabled = true;
    activePageKey = getSearchIdentity();
    const runId = `risk-${crypto.randomUUID()}`;
    const runPageUrl = location.href;
    activeRunId = runId;
    activeTotal = 0;
    clearSearchState();
    try {
      // Background가 실행을 실제로 등록한 뒤에만 popup에 시작 성공을 알립니다.
      // 개별 결과의 병렬 분석은 등록 이후 분리되어 popup 메시지 포트를 붙잡지 않습니다.
      await run({ detachAfterRegistration: true });
      if (activeRunId !== runId || expectedSettingsGeneration !== settingsGeneration ||
          !isActiveSearchPage()) {
        await cancelRegisteredRun(runId, runPageUrl);
        throw new Error('위험 분석 설정 또는 검색 페이지가 변경되었습니다.');
      }
      startObserver();
    } catch (error) {
      // 설정 변경 콜백이 activeRunId를 먼저 비워도 등록된 백그라운드 실행은 남을
      // 수 있으므로, 이 활성화가 만든 ID를 반드시 명시적으로 취소합니다.
      await cancelRegisteredRun(runId, runPageUrl);
      deactivateSearchPage({ expectedRunId: runId, cancelRun: false });
      throw error;
    }
  }

  function hasCollectableSearchResult() {
    const root = document.querySelector('#search') || document.querySelector('#rso');
    return [...(root?.querySelectorAll('h3') || [])].some((heading) => {
      const link = heading.closest('a[href]');
      return link && /^https?:/.test(link.href) &&
        !/^https?:\/\/[^/]*google\.[^/]+\//.test(link.href) &&
        !isExcludedAnalysisResult(link.href, heading);
    });
  }

  function startObserver() {
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        const onlyExtensionUiChanged = mutations.every((mutation) =>
          [...mutation.addedNodes, ...mutation.removedNodes].every((node) =>
            node.nodeType === Node.ELEMENT_NODE && (
              node.matches?.('[data-gurajegeo-ui]') ||
              node.closest?.('[data-gurajegeo-ui]')
            )
          )
        );
        if (!onlyExtensionUiChanged) later();
      });
      // Google SPA는 #search 노드 자체를 교체합니다. 검색 결과 노드에 직접
      // 붙으면 그 교체를 놓치므로 항상 문서 루트에서 페이지 수명주기를 봅니다.
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  function deactivateSearchPage({ expectedRunId = '', cancelRun = true } = {}) {
    // 오래된 활성화의 catch가 더 최신 실행 상태를 지우지 못하게 합니다.
    if (expectedRunId && activeRunId !== expectedRunId) return;
    const runId = activeRunId;
    isEnabled = false;
    activePageKey = '';
    activeRunId = '';
    activeTotal = 0;
    clearSearchState();
    observer?.disconnect();
    observer = null;
    if (cancelRun && runId) {
      void cancelRegisteredRun(runId, location.href);
    }
  }

  /** 전역 상태와 무관하게 백그라운드에 등록했던 정확한 실행을 취소합니다. */
  async function cancelRegisteredRun(runId, pageUrl) {
    if (!runId) return;
    await chrome.runtime.sendMessage({
      target: 'gj:risk',
      type: 'CANCEL_RUN',
      runId,
      pageUrl,
    }).catch(() => undefined);
  }

  function isActiveSearchPage() {
    return featureReady && isEnabled && activePageKey && activePageKey === getSearchIdentity();
  }

  function getSearchIdentity() {
    const url = new URL(location.href);
    // q/start가 같아도 이미지·뉴스 등 검색 모드(tbm/udm)가 바뀌면 별도 페이지입니다.
    return JSON.stringify([
      url.searchParams.get('q') || '',
      Number(url.searchParams.get('start') || 0),
      url.searchParams.get('tbm') || '',
      url.searchParams.get('udm') || '',
    ]);
  }

  function isRiskReady(settings) {
    return settings?.features?.risk !== false && Boolean(String(settings?.apiKey || '').trim());
  }

  function riskSettingsSignature(settings) {
    return JSON.stringify({
      apiKey: String(settings?.apiKey || '').trim(),
      enabled: settings?.features?.risk !== false,
    });
  }

  function clearSearchState() {
    generation += 1;
    clearTimeout(timer);
    hideTip();
    document.querySelectorAll('[data-gurajegeo-ui="risk"]').forEach((element) => element.remove());
    tip = null;
    document.querySelectorAll('[data-gurajegeo-risk-seen]')
      .forEach((heading) => delete heading.dataset.gurajegeoRiskSeen);
    document.querySelectorAll('[data-gurajegeo-ui="result-hub"]:empty').forEach((hub) => hub.remove());
  }

  function cleanElementText(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[data-gurajegeo-ui]')
      .forEach((node) => node.remove());
    return String(clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getResultHub(heading) {
    let hub = heading.querySelector(':scope > [data-gurajegeo-ui="result-hub"]');
    if (!hub) {
      hub = document.createElement('span');
      hub.className = 'gj-result-hub';
      hub.dataset.gurajegeoUi = 'result-hub';
      heading.appendChild(hub);
    }
    return hub;
  }
})();
