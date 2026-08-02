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

class SolarParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SolarParseError';
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

  let data;
  try {
    data = await res.json();
  } catch {
    // HTTP 200이어도 게이트웨이가 빈 문자열이나 JSON이 아닌 응답을 돌려줄 수 있습니다.
    // 이 오류는 askSolarJson에서 다른 일시 오류와 동일하게 재시도합니다.
    throw new SolarParseError('Solar API 응답 본문이 올바른 JSON이 아닙니다.');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new SolarParseError('Solar 응답에 분석 JSON이 없습니다.');
  }
  return { text: content, ms: Date.now() - started };
}

/**
 * 설명이나 잘못된 중괄호가 섞여도 문자열 내부의 괄호를 무시하며 완결된 객체만 찾습니다.
 * 임의로 쉼표·따옴표를 고치지는 않아 모델 판정 내용이 변조되지 않게 합니다.
 */
export function parseJson(text) {
  if (!text) return null;

  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // JSON 문자열 안에 JSON 객체가 한 번 더 들어간 응답도 안전하게 한 단계만 풉니다.
  try {
    const direct = JSON.parse(body);
    if (isPlainObject(direct)) return direct;
    if (typeof direct === 'string' && direct !== body) return parseJson(direct);
  } catch {
    // 아래 균형 괄호 탐색에서 정상 객체 후보를 다시 찾습니다.
  }

  for (let start = 0; start < body.length; start += 1) {
    if (body[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < body.length; index += 1) {
      const character = body[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const candidate = JSON.parse(body.slice(start, index + 1));
            if (isPlainObject(candidate)) return candidate;
          } catch {
            // 이 후보만 버리고 다음 여는 중괄호부터 다시 검사합니다.
          }
          break;
        }
      }
    }
  }
  return null;
}

// 질문 후 JSON 받기 (실패 시 재시도)
export async function askSolarJson(system, user, opts = {}) {
  let lastError;
  let parseRetryCount = 0;
  const requestedMaxTokens = Math.max(256, Math.min(4096, Number(opts.maxTokens) || 1600));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const retryingParse = parseRetryCount > 0;
      const strictSystem = retryingParse
        ? `${system}\n이전 응답 형식이 잘못되었다. 설명이나 코드펜스 없이 JSON 객체 하나만 반환한다.`
        : system;
      // 잘린 JSON을 같은 토큰 한도로 반복하지 않도록 파싱 실패 뒤에만 조금 늘립니다.
      const maxTokens = retryingParse
        ? Math.min(4096, Math.ceil(requestedMaxTokens * (1.5 ** parseRetryCount)))
        : requestedMaxTokens;
      const result = await askSolar(strictSystem, user, { ...opts, maxTokens });
      const parsed = parseJson(result.text);
      if (!parsed) throw new SolarParseError('Solar 응답 JSON을 파싱하지 못했습니다.');
      return { data: parsed, raw: result.text, ms: result.ms };
    } catch (err) {
      lastError = err;
      if (err instanceof SolarParseError) parseRetryCount += 1;
      if (opts.signal?.aborted) throw createCancelledError();
      const retryable = err?.name === 'AbortError' || err instanceof TypeError ||
        err instanceof SolarParseError ||
        (err instanceof SolarHttpError && (err.status === 429 || err.status >= 500));
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
    }
  }

  throw lastError || new Error('Solar 위험 분석 요청에 실패했습니다.');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createCancelledError() {
  const error = new Error('위험 분석 실행이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}
