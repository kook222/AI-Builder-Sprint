import { askSolarJson } from './lib/solar.js';
import { SERP_SYSTEM, buildResultUser, PAGE_SYSTEM, buildPageUser } from './lib/prompts.js';
import { fetchArticle } from './lib/article.js';
import { writeLog } from './lib/logger.js';
import { sanitizeVerdict } from './lib/verify.js';

const STORE = 'ft_pages';

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

let pending = 0;
let ticker = null;

// 서비스 워커 유지
async function keepAlive(job) {
  pending++;
  ticker ??= setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await job();
  } finally {
    if (--pending === 0) {
      clearInterval(ticker);
      ticker = null;
    }
  }
}

async function isEnabled() {
  const { enabled } = await chrome.storage.local.get('enabled');
  return enabled !== false;
}

// 주소 정규화
function key(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^(www|m|mobile)\./, '') + u.pathname.replace(/\/+$/, '');
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

async function remember(url, patch) {
  const store = await readStore();
  const k = key(url);
  store[k] = { ...store[k], url, host: hostOf(url), at: Date.now(), ...patch };
  await chrome.storage.session.set({ [STORE]: store });
}

// 판정 기록 조회 (리다이렉트 추적 포함)
async function findEntry(url) {
  const store = await readStore();

  const exact = store[key(url)];
  if (exact) return exact;

  const host = hostOf(url);
  const now = Date.now();

  const clicked = Object.values(store)
    .filter((e) => (e.risky || e.needsLive) && e.clickedAt)
    .sort((a, b) => b.clickedAt - a.clickedAt);

  const sameSite = clicked.find((e) => e.host === host && now - e.clickedAt < 3 * 60 * 1000);
  if (sameSite) return sameSite;

  return clicked.find((e) => now - e.clickedAt < 30 * 1000) || null;
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
async function prepareMarks(query, item, verdict) {
  await remember(item.url, { preparing: true });

  const user = buildPageUser(item.url, query, verdict.labels, item.body);
  const { data, raw, ms } = await askSolarJson(PAGE_SYSTEM, user, { effort: 'high' });
  await writeLog('page', item.url, PAGE_SYSTEM, user, raw, ms);

  const spans = pickSpans(data);
  await remember(item.url, {
    preparing: false,
    spans,
    summary: String(data?.summary || '').slice(0, 200),
  });

  console.log('[FactTrace] 칠할 곳 준비됨:', item.url, `${spans.length}곳`);
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
async function analyzeResult(query, result) {
  const k = 'serp:' + key(result.url) + '|' + query;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  return withSlot(() =>
    keepAlive(async () => {
      const again = cache.get(k);
      if (again && Date.now() - again.at < CACHE_TTL) return again.value;

      const seen = (await readStore())[key(result.url)];
      if (seen && !seen.needsLive && seen.labels) {
        const value = {
          verdict: { id: result.id, labels: seen.labels, risk: 0, reason: seen.reason || '', parts: seen.parts || [] },
        };
        cache.set(k, { at: Date.now(), value });
        return value;
      }

      const article = await fetchArticle(result.url);
      const item = { ...result, ...article };

      const unreadable =
        (item.body || '').length < 200 || /HTTP (401|403|429|5\d\d)|가져오기 실패/.test(item.status || '');

      if (unreadable) {
        await remember(result.url, { query, needsLive: true, title: result.title, evidence: item.evidence });
        const value = { verdict: { id: result.id, labels: [], risk: 0, reason: '', parts: [] } };
        cache.set(k, { at: Date.now(), value });
        return value;
      }

      const user = buildResultUser(query, item);
      const { data, raw, ms } = await askSolarJson(SERP_SYSTEM, user, { effort: 'high' });
      await writeLog('serp', `${query} — ${result.url}`, SERP_SYSTEM, user, raw, ms);

      const { verdict, dropped } = sanitizeVerdict(data, item);
      if (dropped) {
        console.warn('[FactTrace] 판정 폐기:', result.url, dropped.labels.join('+'), dropped.why);
      }

      const risky = verdict.labels.includes('ad') || verdict.labels.includes('phishing');
      if (verdict.labels.length) {
        await remember(result.url, { query, labels: verdict.labels, reason: verdict.reason, risky });
      }

      const value = { verdict };
      cache.set(k, { at: Date.now(), value });

      if (risky) {
        keepAlive(() => prepareMarks(query, item, verdict)).catch((err) => {
          console.error('[FactTrace] 준비 실패:', result.url, err);
          remember(result.url, { preparing: false, spans: [] });
        });
      }

      return value;
    })
  );
}

// 화면에 그려진 글자로 판정 (못 읽는 사이트용)
async function analyzeLive(url, text) {
  const known = await findEntry(url);
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
    const { data, raw, ms } = await askSolarJson(SERP_SYSTEM, user, { effort: 'high' });
    await writeLog('live', `${known.query || ''} — ${url}`, SERP_SYSTEM, user, raw, ms);

    const { verdict } = sanitizeVerdict(data, item);
    const risky = verdict.labels.includes('ad') || verdict.labels.includes('phishing');

    let spans = [];
    let summary = '';

    if (risky) {
      const pageUser = buildPageUser(url, known.query || '', verdict.labels, text);
      const page = await askSolarJson(PAGE_SYSTEM, pageUser, { effort: 'high' });
      await writeLog('page', url, PAGE_SYSTEM, pageUser, page.raw, page.ms);

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
    });

    console.log('[FactTrace] 화면 글자로 판정:', url, verdict.labels.join('+') || '정상', `${spans.length}곳`);

    const value = { risky, spans, labels: verdict.labels, reason: verdict.reason, summary };
    cache.set(k, { at: Date.now(), value });
    return value;
  });
}

// 칠할 문장 다시 뽑기
async function respan(url, text) {
  const known = await findEntry(url);
  if (!known?.risky) return { spans: [] };

  const k = 'respan:' + key(url);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  return keepAlive(async () => {
    const user = buildPageUser(url, known.query || '', known.labels || [], text);
    const { data, raw, ms } = await askSolarJson(PAGE_SYSTEM, user, { effort: 'high' });
    await writeLog('respan', url, PAGE_SYSTEM, user, raw, ms);

    const spans = pickSpans(data);
    console.log('[FactTrace] 화면 글자로 다시 뽑음:', url, `${spans.length}곳`);

    const value = { spans, labels: known.labels || [], reason: known.reason || '', summary: known.summary || '' };
    cache.set(k, { at: Date.now(), value });
    return value;
  });
}

const routes = {
  ANALYZE_RESULT: (m) => analyzeResult(m.query, m.result),
  ANALYZE_LIVE: (m) => analyzeLive(m.url, m.text),
  RESPAN: (m) => respan(m.url, m.text),

  // 칠할 곳 조회
  GET_MARKS: async (m) => {
    const known = await findEntry(m.url);
    if (known?.needsLive) return { needsLive: true };
    if (!known?.risky) return { risky: false };

    return {
      risky: true,
      preparing: !known.spans,
      spans: known.spans || [],
      labels: known.labels || [],
      reason: known.reason || '',
      summary: known.summary || '',
    };
  },

  // 클릭 기록
  CLICKED: async (m) => {
    await remember(m.url, { clickedAt: Date.now() });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      if (!(await isEnabled())) return respond({ off: true });

      const route = routes[msg.type];
      respond(route ? await route(msg) : { error: '알 수 없는 요청' });
    } catch (err) {
      console.error('[FactTrace]', err);
      respond({ error: err.message });
    }
  })();

  return true;
});
