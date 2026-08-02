// solar-pro3 호출

import { getApiKey } from '../../../shared/settings.js';
import { runWithSolarSlot } from '../../../shared/solar-gate.js';

const API_URL = 'https://api.upstage.ai/v1/chat/completions';
const MODEL = 'solar-pro3';
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 700;

class SolarHttpError extends Error {
  constructor(status, detail) {
    super(`solar ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'SolarHttpError';
    this.status = status;
  }
}

// 모델에 질문
export async function askSolar(
  system,
  user,
  { effort = 'low', timeoutMs = 27000, maxTokens = 1600, signal = null } = {}
) {
  const key = await getApiKey();
  const started = Date.now();

  // 공용 동시성 슬롯을 얻은 뒤에만 요청 제한 시간을 세기 시작합니다.
  // 대기열에 머문 시간 때문에 실제 요청이 시작되기도 전에 취소되는 일을 막습니다.
  const res = await runWithSolarSlot(async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const abortFromOutside = () => abort.abort();
    signal?.addEventListener('abort', abortFromOutside, { once: true });

    try {
      if (signal?.aborted) abort.abort();
      return await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          reasoning_effort: effort,
          temperature: 0,
          max_tokens: Math.max(256, Math.min(4096, Number(maxTokens) || 1600)),
          response_format: { type: 'json_object' },
          stream: false,
        }),
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromOutside);
    }
  });

  if (!res.ok) {
    throw new SolarHttpError(res.status, (await res.text().catch(() => '')).slice(0, 300));
  }

  const data = await res.json();
  return { text: data?.choices?.[0]?.message?.content ?? '', ms: Date.now() - started };
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
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const strictSystem = attempt > 0
        ? `${system}\n이전 응답 형식이 잘못되었다. 설명이나 코드펜스 없이 JSON 객체 하나만 반환한다.`
        : system;
      const result = await askSolar(strictSystem, user, opts);
      const parsed = parseJson(result.text);
      if (!parsed) throw new Error('Solar 응답 JSON을 파싱하지 못했습니다.');
      return { data: parsed, raw: result.text, ms: result.ms };
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw createCancelledError();
      const retryable = err?.name === 'AbortError' || err instanceof TypeError ||
        err?.message?.includes('JSON을 파싱하지 못했습니다') ||
        (err instanceof SolarHttpError && (err.status === 429 || err.status >= 500));
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
    }
  }

  throw lastError || new Error('Solar 위험 분석 요청에 실패했습니다.');
}

function createCancelledError() {
  const error = new Error('위험 분석 실행이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}
