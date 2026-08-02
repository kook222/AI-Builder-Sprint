import { askSolarJson } from './lib/solar.js';
import { SERP_SYSTEM, buildResultUser, PAGE_SYSTEM, buildPageUser } from './lib/prompts.js';
import { fetchArticle } from './lib/article.js';
import { sanitizeVerdict } from './lib/verify.js';
import { SETTINGS_KEY, getSettings, isFeatureEnabled } from '../../shared/settings.js';
import { reportProgress } from '../../shared/progress.js';
import { withServiceWorkerKeepAlive as keepAlive } from '../../shared/service-worker-keepalive.js';

const STORE = 'ft_pages';

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const REDIRECT_CLICK_WINDOW_MS = 15_000;
const REDIRECT_BIND_WINDOW_MS = 30_000;
let storeWriteQueue = Promise.resolve();
let riskStoreGeneration = 0;

const riskRuns = new Map();
let riskSettingsController = new AbortController();

// 새 Service Worker에는 이전 인스턴스의 Solar 요청이 존재하지 않습니다. 세션에
// 남은 preparing 표식을 즉시 해제해 기사 페이지가 불필요하게 90초 대기하지 않게 합니다.
void clearInterruptedPreparations();

async function isEnabled() {
  return isFeatureEnabled('risk');
}

// 주소 정규화
function key(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const name of [...u.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|ref)$/i.test(name)) u.searchParams.delete(name);
    }
    u.searchParams.sort();
    return u.hostname.replace(/^(www|m|mobile)\./, '') +
      (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^(www|m|mobile)\./, '');
  } catch {
    return '';
  }
}

async function readStore() {
  const s = await chrome.storage.session.get(STORE);
  return s[STORE] || {};
}

async function remember(url, patch, expectedGeneration = riskStoreGeneration) {
  return mutateStore((store) => {
    const k = key(url);
    store[k] = { ...store[k], url, host: hostOf(url), at: Date.now(), ...patch };
    return { changed: true, value: true };
  }, expectedGeneration);
}

/** 새 실행이 이전 10분 캐시를 재검토하는 동안 기사 탭이 옛 판정을 쓰지 않게 합니다. */
async function markRiskAnalysisPending(url, runId, expectedGeneration) {
  return mutateStore((store) => {
    const k = key(url);
    store[k] = {
      ...store[k], url, host: hostOf(url), at: Date.now(), analysisPendingRunId: runId,
    };
    return { changed: true, value: true };
  }, expectedGeneration);
}

/** 해당 실행이 만든 pending만 끝내며 더 최신 실행의 상태는 건드리지 않습니다. */
async function settleRiskAnalysis(url, runId, patch, expectedGeneration) {
  return mutateStore((store) => {
    const k = key(url);
    const current = store[k] || {};
    if (current.analysisPendingRunId && current.analysisPendingRunId !== runId) {
      return { changed: false, value: false };
    }
    store[k] = {
      ...current,
      url,
      host: hostOf(url),
      at: Date.now(),
      ...patch,
      analysisPendingRunId: '',
      analysisRunId: runId,
      clickPendingRunId: current.clickPendingRunId === runId ? '' : current.clickPendingRunId,
    };
    return { changed: true, value: true };
  }, expectedGeneration);
}

/** session 저장소의 읽기-수정-쓰기를 한 큐에서 처리해 병렬 결과의 덮어쓰기를 막습니다. */
async function mutateStore(mutation, expectedGeneration = riskStoreGeneration) {
  storeWriteQueue = storeWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (expectedGeneration !== riskStoreGeneration) return null;
      const store = await readStore();
      if (expectedGeneration !== riskStoreGeneration) return null;
      const outcome = mutation(store);
      if (!outcome) return null;
      if (outcome.changed) await chrome.storage.session.set({ [STORE]: store });
      return outcome.value;
    });
  return storeWriteQueue;
}

async function clearInterruptedPreparations() {
  return mutateStore((store) => {
    let changed = false;
    for (const entry of Object.values(store)) {
      if (entry?.preparing === true) {
        entry.preparing = false;
        changed = true;
      }
    }
    return { changed, value: changed };
  });
}

// 판정 기록 조회 (리다이렉트 추적 포함)
async function findEntry(url, tab = null) {
  const store = await readStore();
  const now = Date.now();

  const exactKey = key(url);
  const exact = store[exactKey];
  if (exact && now - Number(exact.at || 0) < CACHE_TTL) {
    const resolved = resolveRedirectEntry(store, exact);
    if (hasOpenClick(exact) && isRelatedClickTab(exact, tab)) {
      // 요청 URL 화면이 실제로 열린 탭을 클릭 토큰에 묶습니다. 여기서 소비하면
      // 뒤이어 일어나는 client-side redirect가 원본 판정을 찾을 수 없게 됩니다.
      const bound = await bindExactClickToDestination(exactKey, exact.clickToken, tab.id, now);
      return bound || resolved;
    }
    return resolved;
  }

  if (!Number.isInteger(tab?.id)) return null;
  return claimRecentClickRedirect(url, tab, now);
}

function hasOpenClick(entry) {
  return Boolean(entry?.clickedAt && entry?.clickToken && !entry?.clickConsumedAt);
}

function isRelatedClickTab(entry, tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(entry?.clickedTabId)) return false;
  return tab.id === entry.clickedTabId || tab.openerTabId === entry.clickedTabId;
}

/** exact URL을 처음 연 탭에 클릭 토큰을 결속하되 redirect 확정 전에는 소비하지 않습니다. */
async function bindExactClickToDestination(sourceKey, clickToken, destinationTabId, now) {
  return mutateStore((store) => {
    const current = store[sourceKey];
    if (!hasOpenClick(current) || current.clickToken !== clickToken) {
      return { changed: false, value: null };
    }

    // 한 클릭 토큰을 서로 다른 도착 탭에 재결속하지 않습니다. 그런 경우에는 exact
    // URL 판정만 반환하고 redirect 관계는 만들지 않는 편이 안전합니다.
    if (Number.isInteger(current.clickDestinationTabId) &&
        current.clickDestinationTabId !== destinationTabId) {
      return { changed: false, value: null };
    }

    const changed = current.clickDestinationToken !== clickToken ||
      current.clickDestinationTabId !== destinationTabId || !current.clickDestinationAt;
    if (changed) {
      current.clickDestinationToken = clickToken;
      current.clickDestinationTabId = destinationTabId;
      current.clickDestinationAt = now;
    }
    return { changed, value: resolveRedirectEntry(store, current) };
  });
}

/** 클릭 직후 발생한 리다이렉트만 한 번 연결하고 최종 URL에 exact 별칭을 만듭니다. */
async function claimRecentClickRedirect(finalUrl, tab, now) {
  const finalHost = hostOf(finalUrl);
  return mutateStore((store) => {
    const clicked = Object.entries(store)
      // 판정이 아직 끝나지 않은 클릭도 포함해야 redirect된 기사에서 pending 상태를
      // 이어받고, source 판정이 도착한 뒤 같은 별칭으로 결과를 확인할 수 있습니다.
      .filter(([, entry]) => hasOpenClick(entry))
      .sort(([, left], [, right]) => right.clickedAt - left.clickedAt);

    // exact URL에서 결속한 토큰은 동일한 도착 탭에서만 사용할 수 있습니다.
    const bound = clicked.filter(([, entry]) =>
      entry.clickDestinationTabId === tab.id &&
      entry.clickDestinationToken === entry.clickToken &&
      now - Number(entry.clickDestinationAt || 0) < REDIRECT_BIND_WINDOW_MS
    );
    if (bound.length > 1) return { changed: false, value: null };

    let candidate = bound[0] || null;
    if (!candidate) {
      // HTTP redirect는 중간 문서의 content script가 실행되기 전에 끝날 수 있습니다.
      // 이 경우 같은 탭/오프너의 매우 최근 클릭만 보되, 동일 host 후보가 여러 개거나
      // host로도 한 건을 확정할 수 없으면 임의로 최신 항목을 고르지 않습니다.
      const related = clicked.filter(([, entry]) =>
        isRelatedClickTab(entry, tab) && now - entry.clickedAt < REDIRECT_CLICK_WINDOW_MS
      );
      const sameHost = related.filter(([, entry]) => entry.host === finalHost);
      if (sameHost.length > 1) return { changed: false, value: null };
      if (sameHost.length === 1) candidate = sameHost[0];
      else if (related.length === 1) candidate = related[0];
      else return { changed: false, value: null };
    }
    if (!candidate) return { changed: false, value: null };

    const [sourceKey, source] = candidate;
    source.clickConsumedAt = now;
    const alias = {
      ...source,
      url: finalUrl,
      host: finalHost,
      at: now,
      clickedAt: 0,
      clickedTabId: null,
      clickConsumedAt: now,
      redirectSourceUrl: source.url,
      redirectSourceKey: sourceKey,
    };
    store[key(finalUrl)] = alias;
    // 첫 GET_MARKS 응답부터 source의 최신 pending/판정을 상속해야 합니다. 별칭
    // 스냅샷 자체를 반환하면 아직 분석 중인 결과를 정상으로 잘못 볼 수 있습니다.
    return { changed: true, value: resolveRedirectEntry(store, alias) };
  });
}

/** redirect 별칭은 원본 검색 결과 entry의 최신 판정을 매 조회마다 따라갑니다. */
function resolveRedirectEntry(store, entry) {
  const source = entry.redirectSourceKey ? store[entry.redirectSourceKey] : null;
  if (!source) return entry;
  return {
    ...entry,
    ...source,
    url: entry.url,
    host: entry.host,
    at: Math.max(Number(entry.at || 0), Number(source.at || 0)),
    redirectSourceUrl: entry.redirectSourceUrl,
    redirectSourceKey: entry.redirectSourceKey,
  };
}

function pickSpans(data) {
  return (Array.isArray(data?.spans) ? data.spans : [])
    .filter((s) => typeof s?.text === 'string' && s.text.trim().length >= 8)
    .map((s) => ({
      text: s.text.trim(),
      kind: s.kind === 'phishing' ? 'phishing' : 'ad',
      reason: String(s.reason || '').slice(0, 60),
    }))
    .slice(0, 12);
}

// 칠할 문장 미리 뽑기
async function prepareMarks(query, item, verdict, runId, signal, storeGeneration) {
  throwIfAborted(signal);
  await remember(item.url, { preparing: true }, storeGeneration);
  const run = riskRuns.get(runId);
  if (run && run.completed + run.failed < run.total) {
    await reportProgress('risk', {
      status: 'running',
      phase: '의심 문구 추출',
      total: run.total,
      completed: run.completed,
      failed: run.failed,
      detail: '위험 판정 페이지에서 하이라이트할 원문을 찾고 있습니다.',
      tabId: run.tabId,
      pageKey: run.pageKey,
    });
  }

  const user = buildPageUser(item.url, query, verdict.labels, item.body);
  const { data } = await askSolarJson(PAGE_SYSTEM, user, {
    effort: 'high',
    maxTokens: 2200,
    signal,
  });

  throwIfAborted(signal);
  const spans = pickSpans(data);
  await remember(item.url, {
    preparing: false,
    spans,
    summary: String(data?.summary || '').slice(0, 200),
  }, storeGeneration);

}

let running = 0;
const queue = [];

// 동시 호출 수 제한
async function withSlot(job) {
  if (running >= 5) await new Promise((go) => queue.push(go));
  running++;
  try {
    return await job();
  } finally {
    running--;
    queue.shift()?.();
  }
}

// 검색 결과 한 건 판정
async function analyzeResult(query, result, runId) {
  const run = riskRuns.get(String(runId || ''));
  if (!run) throw createRiskCancelledError();
  run.urls.add(result.url);
  const signal = run.controller.signal;
  const storeGeneration = run.storeGeneration;
  throwIfAborted(signal);
  await markRiskAnalysisPending(result.url, runId, storeGeneration);
  throwIfAborted(signal);
  const k = 'serp:' + key(result.url) + '|' + query;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    await settleRiskAnalysis(result.url, runId, {}, storeGeneration);
    return hit.value;
  }

  return withSlot(() =>
    keepAlive(async () => {
      throwIfAborted(signal);
      const again = cache.get(k);
      if (again && Date.now() - again.at < CACHE_TTL) {
        await settleRiskAnalysis(result.url, runId, {}, storeGeneration);
        return again.value;
      }

      const seen = (await readStore())[key(result.url)];
      if (seen && Date.now() - Number(seen.at || 0) < CACHE_TTL &&
          seen.query === query && !seen.needsLive && seen.labels) {
        const value = {
          verdict: { id: result.id, labels: seen.labels, risk: 0, reason: seen.reason || '', parts: seen.parts || [] },
        };
        cache.set(k, { at: Date.now(), value });
        await settleRiskAnalysis(result.url, runId, {}, storeGeneration);
        return value;
      }

      const article = await fetchArticle(result.url, 8000, signal);
      throwIfAborted(signal);
      const item = { ...result, ...article };

      const unreadable =
        (item.body || '').length < 200 || /HTTP (401|403|429|5\d\d)|가져오기 실패/.test(item.status || '');

      if (unreadable) {
        await settleRiskAnalysis(
          result.url,
          runId,
          { query, needsLive: true, title: result.title, evidence: item.evidence },
          storeGeneration
        );
        const value = { verdict: { id: result.id, labels: [], risk: 0, reason: '', parts: [] } };
        cache.set(k, { at: Date.now(), value });
        return value;
      }

      const user = buildResultUser(query, item);
      const { data } = await askSolarJson(SERP_SYSTEM, user, {
        effort: 'high',
        maxTokens: 900,
        signal,
      });

      throwIfAborted(signal);
      const { verdict, dropped } = sanitizeVerdict(data, item);
      if (dropped) {
        console.warn('[FactTrace] 판정 폐기:', result.url, dropped.labels.join('+'), dropped.why);
      }

      const risky = verdict.labels.includes('ad') || verdict.labels.includes('phishing');
      // 정상 판정도 저장해 같은 URL의 오래된 위험·하이라이트 상태를 확실히 지웁니다.
      await settleRiskAnalysis(result.url, runId, {
        query,
        labels: verdict.labels,
        reason: verdict.reason,
        parts: verdict.parts,
        risky,
        needsLive: false,
        preparing: false,
        spans: risky ? undefined : [],
      }, storeGeneration);

      const value = { verdict };
      cache.set(k, { at: Date.now(), value });

      if (risky) {
        await keepAlive(() => prepareMarks(
          query, item, verdict, runId, signal, storeGeneration
        )).catch(async (err) => {
          if (signal.aborted) throw err;
          console.error('[FactTrace] 준비 실패:', result.url, err);
          await remember(result.url, { preparing: false, spans: [] }, storeGeneration);
        });
      }

      return value;
    })
  );
}

// 화면에 그려진 글자로 판정 (못 읽는 사이트용)
async function analyzeLive(url, text, tab) {
  const signal = riskSettingsController.signal;
  const storeGeneration = riskStoreGeneration;
  throwIfAborted(signal);
  const known = await findEntry(url, tab);
  if (!known?.needsLive) return { spans: [] };

  const k = 'live:' + key(url);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  return keepAlive(async () => {
    const item = {
      id: 'live',
      title: known.title || '',
      url,
      snippet: '',
      body: text,
      status: `본문 ${text.length}자 (브라우저에 그려진 글자)`,
      evidence: known.evidence || '- 없음',
      loginWall: false,
    };

    const user = buildResultUser(known.query || '', item);
    const { data } = await askSolarJson(SERP_SYSTEM, user, {
      effort: 'high',
      maxTokens: 900,
      signal,
    });

    const { verdict } = sanitizeVerdict(data, item);
    const risky = verdict.labels.includes('ad') || verdict.labels.includes('phishing');

    let spans = [];
    let summary = '';

    if (risky) {
      const pageUser = buildPageUser(url, known.query || '', verdict.labels, text);
      const page = await askSolarJson(PAGE_SYSTEM, pageUser, {
        effort: 'high',
        maxTokens: 2200,
        signal,
      });

      spans = pickSpans(page.data);
      summary = String(page.data?.summary || '').slice(0, 200);
    }

    await remember(url, {
      needsLive: false,
      labels: verdict.labels,
      reason: verdict.reason,
      parts: verdict.parts,
      risky,
      spans,
      summary,
    }, storeGeneration);

    const value = { risky, spans, labels: verdict.labels, reason: verdict.reason, summary };
    cache.set(k, { at: Date.now(), value });
    return value;
  });
}

// 칠할 문장 다시 뽑기
async function respan(url, text, tab) {
  const signal = riskSettingsController.signal;
  throwIfAborted(signal);
  const known = await findEntry(url, tab);
  if (!known?.risky) return { spans: [] };

  const k = 'respan:' + key(url);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  return keepAlive(async () => {
    const user = buildPageUser(url, known.query || '', known.labels || [], text);
    const { data } = await askSolarJson(PAGE_SYSTEM, user, {
      effort: 'high',
      maxTokens: 2200,
      signal,
    });

    const spans = pickSpans(data);
    const value = { spans, labels: known.labels || [], reason: known.reason || '', summary: known.summary || '' };
    cache.set(k, { at: Date.now(), value });
    return value;
  });
}

const routes = {
  RUN_STARTED: (m, sender) => beginRiskRun(m, sender?.tab?.id),
  CANCEL_RUN: (m, sender) => cancelRiskRun(m.runId, sender?.tab?.id, m.pageUrl),
  ANALYZE_RESULT: async (m) => {
    try {
      const result = await analyzeResult(m.query, m.result, m.runId);
      await finishRiskResult(m.runId, false);
      return result;
    } catch (error) {
      const run = riskRuns.get(String(m.runId || ''));
      if (run && m.result?.url) {
        await settleRiskAnalysis(m.result.url, m.runId, {
          risky: false, labels: [], reason: '', parts: [], needsLive: false,
          preparing: false, spans: [],
        }, run.storeGeneration);
      }
      await finishRiskResult(m.runId, true, error);
      throw error;
    }
  },
  ANALYZE_LIVE: (m, sender) => analyzeLive(m.url, m.text, sender?.tab),
  RESPAN: (m, sender) => respan(m.url, m.text, sender?.tab),

  // 칠할 곳 조회
  GET_MARKS: async (m, sender) => {
    const known = await findEntry(m.url, sender?.tab);
    // 사용자가 '검사 중' 결과를 바로 연 경우 클릭 기록은 있지만 판정은 아직 없습니다.
    // 정상으로 오인하지 않고 기사 content가 결과 도착을 잠시 기다리게 합니다.
    if (known?.clickPendingRunId || known?.analysisPendingRunId ||
        (known?.clickedAt && typeof known.risky !== 'boolean' && !known.needsLive)) {
      return { pending: true };
    }
    if (known?.needsLive) return { needsLive: true };
    if (!known?.risky) return { risky: false };

    return {
      risky: true,
      preparing: known.preparing === true,
      spans: known.spans || [],
      labels: known.labels || [],
      reason: known.reason || '',
      summary: known.summary || '',
    };
  },

  // 클릭 기록
  CLICKED: async (m, sender) => {
    const clickRunId = String(m.runId || '');
    await mutateStore((store) => {
      const k = key(m.url);
      const current = store[k] || {};
      store[k] = {
        ...current,
        url: m.url,
        host: hostOf(m.url),
        at: Date.now(),
        clickedAt: Date.now(),
        clickedTabId: sender?.tab?.id ?? null,
        clickToken: crypto.randomUUID(),
        clickConsumedAt: 0,
        clickDestinationTabId: null,
        clickDestinationToken: '',
        clickDestinationAt: 0,
        clickPendingRunId: current.analysisRunId === clickRunId ? '' : clickRunId,
      };
      return { changed: true, value: true };
    });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.target !== 'gj:risk') return false;
  (async () => {
    try {
      // 설정 OFF 이벤트가 content의 취소보다 먼저 도착해도 등록된 실행을 정리해야
      // 하므로 CANCEL_RUN은 기능 활성 여부를 검사하기 전에 항상 처리합니다.
      if (msg.type === 'CANCEL_RUN') {
        return respond(await routes.CANCEL_RUN(msg, sender));
      }
      if (!(await isEnabled())) return respond({ off: true });

      const route = routes[msg.type];
      if (!route) return respond({ error: '알 수 없는 위험 분석 요청' });
      respond(await route(msg, sender));
    } catch (err) {
      console.error('[FactTrace]', err);
      respond({ error: err.message });
    }
  })();

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = areaName === 'local' ? changes[SETTINGS_KEY] : null;
  if (!change || riskSettingsSignature(change.oldValue) === riskSettingsSignature(change.newValue)) return;

  // 토글 또는 API 키가 바뀌면 이전 자격 증명으로 시작한 네트워크 작업을 실제 중단합니다.
  riskSettingsController.abort();
  riskSettingsController = new AbortController();
  riskStoreGeneration += 1;
  for (const run of riskRuns.values()) run.controller.abort();
  riskRuns.clear();
  cache.clear();
  storeWriteQueue = storeWriteQueue
    .catch(() => undefined)
    .then(() => chrome.storage.session.remove(STORE));
  void reportProgress('risk', change.newValue?.features?.risk === false ? {
    status: 'disabled', phase: '꺼짐', total: 0, completed: 0, failed: 0,
    detail: '피싱·광고 위험 기능이 꺼져 있습니다.',
  } : {
    status: 'idle', phase: '대기', total: 0, completed: 0, failed: 0,
    detail: '설정이 변경되어 다음 실행을 기다립니다.',
  });
});

async function beginRiskRun(message, tabId) {
  const expectedStoreGeneration = riskStoreGeneration;
  const expectedSettingsSignature = await assertRiskRegistrationReady(expectedStoreGeneration);
  const runId = String(message.runId || '');
  if (!runId) throw new Error('위험 분석 실행 식별자가 없습니다.');
  const normalizedTabId = Number.isInteger(tabId) ? tabId : null;
  let riskRun = riskRuns.get(runId);
  if (riskRun) {
    riskRun.total = Math.max(riskRun.total, Math.max(0, Number(message.total) || 0));
    riskRun.pageKey = String(message.pageUrl || riskRun.pageKey);
  } else {
    riskRun = {
      total: Math.max(0, Number(message.total) || 0),
      completed: 0,
      failed: 0,
      tabId: normalizedTabId,
      pageKey: String(message.pageUrl || ''),
      controller: new AbortController(),
      urls: new Set(),
      storeGeneration: riskStoreGeneration,
    };
    // 같은 탭의 새 수동 실행만 이전 실행을 폐기합니다.
    for (const [existingId, existing] of riskRuns) {
      if (existing.tabId === normalizedTabId) {
        existing.controller.abort();
        await Promise.all([...existing.urls].map((url) => remember(url, { preparing: false })));
        riskRuns.delete(existingId);
      }
    }
    // 위의 preparing 정리 await 중 설정 변경 콜백이 모든 실행을 비울 수 있습니다.
    // 실제 등록 직전에 generation과 최신 설정을 함께 다시 확인합니다.
    await assertRiskRegistrationReady(expectedStoreGeneration, expectedSettingsSignature);
    riskRuns.set(runId, riskRun);
  }
  // 신규/기존 실행 모두 진행 상태를 쓰기 직전에 설정을 재검증합니다. 이 await 중
  // CANCEL_RUN이 실행을 지웠다면 running 상태를 다시 만들지 않습니다.
  try {
    await assertRiskRegistrationReady(expectedStoreGeneration, expectedSettingsSignature);
  } catch (error) {
    if (riskRuns.get(runId) === riskRun) {
      riskRun.controller.abort();
      riskRuns.delete(runId);
    }
    throw error;
  }
  if (riskRuns.get(runId) !== riskRun) throw createRiskCancelledError();
  await reportProgress('risk', {
    status: 'running',
    phase: '본문 수집',
    total: riskRun.total,
    completed: riskRun.completed,
    failed: riskRun.failed,
    tabId: riskRun.tabId,
    pageKey: riskRun.pageKey,
    detail: `${riskRun.total}개 결과의 위험 신호를 확인합니다.`,
  });
  return { ok: true };
}

async function assertRiskRegistrationReady(expectedStoreGeneration, expectedSettingsSignature = '') {
  const settings = await getSettings();
  const currentSettingsSignature = riskSettingsSignature(settings);
  if (expectedStoreGeneration !== riskStoreGeneration ||
      settings.features.risk === false || !settings.apiKey ||
      (expectedSettingsSignature && currentSettingsSignature !== expectedSettingsSignature)) {
    throw new Error('피싱·광고 위험 기능을 켜고 API 키를 입력해 주세요.');
  }
  return currentSettingsSignature;
}

async function finishRiskResult(runId, didFail, error = null) {
  const riskRun = riskRuns.get(String(runId || ''));
  if (!riskRun) return;
  if (didFail) riskRun.failed += 1;
  else riskRun.completed += 1;
  const done = riskRun.completed + riskRun.failed;
  const finished = riskRun.total > 0 && done >= riskRun.total;
  await reportProgress('risk', {
    status: finished ? (riskRun.failed === riskRun.total ? 'error' : 'complete') : 'running',
    phase: finished ? (riskRun.failed ? '일부 완료' : '완료') : 'AI 판정',
    total: riskRun.total,
    completed: riskRun.completed,
    failed: riskRun.failed,
    detail: error
      ? String(error.message || error).slice(0, 200)
      : `${done}/${riskRun.total}개 위험 검사를 마쳤습니다.`,
    tabId: riskRun.tabId,
    pageKey: riskRun.pageKey,
  });
}

async function cancelRiskRun(rawRunId, tabId, pageUrl = "") {
  const runId = String(rawRunId || '');
  const run = riskRuns.get(runId);
  if (!run || (Number.isInteger(tabId) && run.tabId !== tabId)) return { cancelled: false };
  run.controller.abort();
  riskRuns.delete(runId);
  await Promise.all([...run.urls].map((url) => remember(url, { preparing: false })));
  await reportProgress('risk', {
    status: 'idle',
    phase: '대기',
    total: 0,
    completed: 0,
    failed: 0,
    detail: '검색 페이지가 바뀌어 다음 실행을 기다립니다.',
    tabId: run.tabId,
    pageKey: String(pageUrl || ''),
  });
  return { cancelled: true };
}

function riskSettingsSignature(settings) {
  return JSON.stringify({
    apiKey: String(settings?.apiKey || '').trim(),
    enabled: settings?.features?.risk !== false,
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createRiskCancelledError();
}

function createRiskCancelledError() {
  const error = new Error('위험 분석 실행이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}
