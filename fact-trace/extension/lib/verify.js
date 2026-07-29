// 모델 판정 검증

const LABELS = ['ad', 'phishing', 'login'];

// 근거가 원문에 실재하는지 대조
export function quoteIsReal(quote, item) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

  const words = norm(quote)
    .split(/[^0-9a-z가-힣]+/)
    .filter((w) => w.length >= 2);

  if (words.length < 2) return false;

  const hay = norm(`${item.evidence} ${item.status} ${item.body}`);
  return words.filter((w) => hay.includes(w)).length / words.length >= 0.7;
}

// 판정 걸러내기
export function sanitizeVerdict(answer, item) {
  let labels = Array.isArray(answer?.labels) ? answer.labels.filter((l) => LABELS.includes(l)) : [];
  let dropped = null;

  if (labels.length && (item.body || '').length < 50) {
    dropped = { labels, why: '본문을 못 가져와서 판단 불가' };
    labels = [];
  } else if (labels.length && !quoteIsReal(answer.quote, item)) {
    dropped = { labels, why: '근거를 원문에서 확인할 수 없음', quote: answer.quote };
    labels = [];
  }

  let reason = labels.length ? String(answer?.reason || '').slice(0, 120) : '';

  const body = String(item.body || '').replace(/\s+/g, ' ');
  const evidence = String(item.evidence || '').replace(/\s+/g, ' ');
  const parts = (labels.length && Array.isArray(answer?.parts) ? answer.parts : [])
    .map((p) => String(p || '').trim())
    .filter((p) => p.length >= 8 && p.length <= 200)
    .filter((p) => {
      const flat = p.replace(/\s+/g, ' ');
      return body.includes(flat) || evidence.includes(flat);
    })
    .slice(0, 3);

  if (item.loginWall && !labels.includes('login')) {
    labels.push('login');
    reason ||= '본문이 거의 없고 로그인 창만 나옵니다. 로그인해야 글을 읽을 수 있습니다.';
  }

  return {
    verdict: { id: item.id, labels, risk: Number(answer?.risk) || 0, reason, parts },
    dropped,
  };
}
