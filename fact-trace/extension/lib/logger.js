// 모델 입출력 기록

const KEY = 'ft_logs';
const MAX = 200;

// 호출 한 건 기록
export async function writeLog(kind, label, system, user, raw, ms) {
  const entry = {
    time: new Date().toISOString(),
    kind,
    label,
    ms,
    system,
    user,
    raw,
  };

  const store = await chrome.storage.local.get(KEY);
  const logs = store[KEY] || [];

  logs.push(entry);
  if (logs.length > MAX) logs.splice(0, logs.length - MAX);

  await chrome.storage.local.set({ [KEY]: logs });
}

export async function readLogs() {
  const store = await chrome.storage.local.get(KEY);
  return store[KEY] || [];
}

export async function clearLogs() {
  await chrome.storage.local.remove(KEY);
}

// 기록을 텍스트로 변환
export function formatLogs(logs) {
  if (!logs.length) return '기록이 없습니다.\n';

  const bar = '='.repeat(78);

  return logs
    .map((e) => {
      const t = new Date(e.time).toLocaleString('ko-KR');
      const head = `${bar}\n[${t}] ${e.kind.toUpperCase()} · ${e.ms}ms\n대상: ${e.label}\n${bar}`;
      return [
        head,
        '----- system -----',
        e.system,
        '----- user -----',
        e.user,
        '----- 모델 응답 -----',
        e.raw,
        '',
      ].join('\n');
    })
    .join('\n');
}
