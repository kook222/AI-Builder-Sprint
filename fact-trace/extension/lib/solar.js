// solar-pro3 호출

const API_URL = 'https://api.upstage.ai/v1/chat/completions';
const MODEL = 'solar-pro3';

// 저장된 API 키 읽기
async function apiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('API 키가 없습니다. 확장 팝업에서 키를 넣어주세요.');
  return apiKey;
}

// 모델에 질문
export async function askSolar(system, user, { effort = 'low', timeoutMs = 60000 } = {}) {
  const key = await apiKey();
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        reasoning_effort: effort,
        stream: false,
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      throw new Error(`solar ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }

    const data = await res.json();
    return { text: data?.choices?.[0]?.message?.content ?? '', ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 답변에서 JSON 추출
export function parseJson(text) {
  if (!text) return null;

  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end < start) return null;

  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 질문 후 JSON 받기 (실패 시 재시도)
export async function askSolarJson(system, user, opts = {}) {
  let last = { text: '', ms: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await askSolar(system, user, opts);
      const parsed = parseJson(last.text);
      if (parsed) return { data: parsed, raw: last.text, ms: last.ms };
    } catch (err) {
      last = { text: `[에러] ${err.message}`, ms: 0 };
    }
  }

  return { data: null, raw: last.text, ms: last.ms };
}
