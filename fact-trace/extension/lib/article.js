// 링크 본문과 판정 근거 수집

const LOGIN_WORDS = [
  '로그인이 필요',
  '로그인 후 이용',
  '로그인하고',
  '회원만 볼 수',
  '회원 전용',
  '구독자 전용',
  '멤버십 전용',
  '유료 회원',
  '가입하고 계속',
  '계속 읽으려면',
  'sign in to continue',
  'log in to continue',
  'members only',
  'subscribe to read',
  'subscribe to continue',
  'create an account to',
  'please log in',
  'please sign in',
];

// 가장 긴 태그 블록 찾기
function biggestBlock(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let best = '';
  let m;
  while ((m = re.exec(html))) {
    if (m[1].length > best.length) best = m[1];
  }
  return best;
}

// HTML에서 본문 글자만 추출
export function htmlToText(html) {
  let s = html
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  const main = biggestBlock(s, 'main') || biggestBlock(s, 'article');
  if (main.length > 500) s = main;

  const text = s
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function pickTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

// 머리말 요약문 추출
function metaText(html) {
  const lines = [];
  const seen = new Set();

  const re = /<meta[^>]+(?:name|property)\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!/^(og:)?(title|description)$|^twitter:(title|description)$|^keywords$/i.test(m[1])) continue;
    const value = htmlToText(m[2]).trim();
    if (value.length < 5 || seen.has(value)) continue;
    seen.add(value);
    lines.push(value);
  }

  return lines.join('\n');
}

const AD_NETWORKS = [
  'googlesyndication',
  'adsbygoogle',
  'doubleclick',
  'googletagservices',
  'adservice.google',
  'criteo',
  'taboola',
  'outbrain',
  'dable.io',
  'adnxs',
  'pubmatic',
  'rubiconproject',
  'mediacategory',
  'adop.cc',
  'teads',
  'admixer',
];

const AFFILIATE = [
  'partners.coupang.com',
  'link.coupang.com',
  'linkprice.com',
  'aliexpress.com/item',
  'amzn.to',
  'coupa.ng',
  'ldb.im',
  'lnk.to',
  'tracking.',
  'affiliate',
  'utm_source=affiliate',
];

function countOf(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

// 광고 근거 수집
function adEvidence(html) {
  const lower = html.toLowerCase();
  const notes = [];

  const nets = AD_NETWORKS.filter((n) => lower.includes(n));
  if (nets.length) {
    const much = nets.length >= 3;
    notes.push(
      `광고 스크립트 ${nets.length}종 (${nets.slice(0, 4).join(', ')}) — ${much ? '많은 편' : '요즘 사이트에 흔한 정도'}`
    );
  }

  const slots = countOf(lower, 'adsbygoogle') + countOf(lower, 'ad-slot') + countOf(lower, 'data-ad-');
  if (slots >= 5) notes.push(`광고 자리 표시가 ${slots}군데 — 많은 편`);

  const iframes = countOf(lower, '<iframe');
  if (iframes >= 6) notes.push(`iframe ${iframes}개 (상당수가 광고일 수 있음)`);

  const aff = AFFILIATE.filter((a) => lower.includes(a));
  if (aff.length) notes.push(`제휴 링크 발견 (${aff.slice(0, 3).join(', ')})`);

  const disclosure = ['소정의 수수료', '수수료를 제공받', '업체로부터 제공', '협찬을 받아', '광고 포함', '유료광고', '내돈내산이 아']
    .filter((w) => html.includes(w));
  if (disclosure.length) notes.push(`협찬·수수료 고지 문구 있음 ("${disclosure[0]}")`);

  return notes;
}

// 외부 이동 근거 수집
function redirectEvidence(html, url) {
  const notes = [];
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {}

  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i);
  if (meta && /url\s*=/i.test(meta[0])) {
    notes.push(`meta refresh로 자동 이동시킴: ${meta[0].slice(0, 120)}`);
  }

  const jumps = [
    /location\s*\.\s*(href|replace|assign)\s*[=(]\s*["'][^"']+["']/gi,
    /window\s*\.\s*open\s*\(\s*["'][^"']+["']/gi,
  ];
  for (const re of jumps) {
    const hits = html.match(re) || [];
    const outward = hits.filter((h) => /https?:\/\//.test(h) && (!host || !h.includes(host)));
    if (outward.length) {
      notes.push(`스크립트로 외부 주소를 여는 코드 ${outward.length}곳: ${outward[0].slice(0, 100)}`);
      break;
    }
  }

  const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);

  const tally = new Map();
  for (const h of links) {
    try {
      const d = new URL(h).hostname.replace(/^www\./, '');
      if (host && (d === host || d.endsWith('.' + host))) continue;
      if (/(^|\.)(cdn|static|img|image|assets?|media|ssl)\./.test(d)) continue;
      tally.set(d, (tally.get(d) || 0) + 1);
    } catch {}
  }

  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (total) {
    notes.push(`외부 사이트로 나가는 링크 ${total}개, 주요 도착지: ` + top.map(([d, n]) => `${d}(${n})`).join(', '));
  }

  return notes;
}

// 로그인 벽 판정
export function isLoginWall(html, text) {
  if (text.length >= 600) return false;

  const hasPassword = /<input[^>]+type=["']?password/i.test(html);
  const saysLogin = /(로그인|계속 읽으려면|log ?in|sign ?in|subscribe to (read|continue))/i.test(text);

  return hasPassword && saysLogin;
}

// 본문 접근 근거 수집
function loginEvidence(html, text, status) {
  const notes = [];

  if (isLoginWall(html, text)) {
    notes.push(`본문이 ${text.length}자뿐이고 화면에 로그인 창만 들어와 있음 — 로그인 벽이 확실함`);
  }

  if (status === 401) notes.push('서버가 401로 인증을 요구함');
  if (status === 403) notes.push('서버가 403으로 막음 (로그인 벽일 수도, 단순 크롤러 차단일 수도 있음)');

  const lower = text.toLowerCase();
  const hit = LOGIN_WORDS.find((w) => lower.includes(w.toLowerCase()));

  const blocked = text.length < 1000;

  if (hit && blocked) notes.push(`본문이 ${text.length}자뿐인데 "${hit}" 문구가 있음`);
  else if (hit) notes.push(`"${hit}" 문구가 있지만 본문은 ${text.length}자 들어와 있음`);

  if (blocked && /<input[^>]+type=["']?password/i.test(html)) {
    notes.push('본문이 짧고 비밀번호 입력칸이 있음');
  }

  if (text.length < 300) notes.push(`본문이 ${text.length}자밖에 안 됨`);

  return notes;
}

// 근거 묶기
function buildEvidence(html, text, url, status) {
  const ad = adEvidence(html);
  const redir = redirectEvidence(html, url);
  const login = loginEvidence(html, text, status);

  const lines = [];
  lines.push(`- 광고 관련: ${ad.length ? ad.join(' / ') : '특이사항 없음'}`);
  lines.push(`- 외부 이동 관련: ${redir.length ? redir.join(' / ') : '특이사항 없음'}`);
  lines.push(`- 본문 접근 관련: ${login.length ? login.join(' / ') : '특이사항 없음'}`);
  return lines.join('\n');
}

// 주소 하나 가져오기
export async function fetchArticle(url, timeoutMs = 8000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,*/*' },
      signal: abort.signal,
    });

    const type = res.headers.get('content-type') || '';
    if (!type.includes('html') && !type.includes('text')) {
      return { body: '', status: `HTML이 아님 (${type || '알 수 없음'})`, ok: false };
    }

    const html = await res.text();
    const text = htmlToText(html).slice(0, 20000);
    const title = pickTitle(html);

    const status = `본문 ${text.length}자 (HTTP ${res.status})`;
    const evidence = buildEvidence(html, text, res.url || url, res.status);

    const body = text.length < 400 ? [title, metaText(html), text].filter(Boolean).join('\n') : text;

    return { body, html, status, evidence, loginWall: isLoginWall(html, text), ok: true };
  } catch (err) {
    const reason = err.name === 'AbortError' ? '시간 초과' : err.message;
    return {
      body: '',
      html: '',
      status: `가져오기 실패 (${reason})`,
      evidence: '- 페이지를 못 가져와서 확인할 수 없음',
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
