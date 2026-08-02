/**
 * 오래 걸리는 본문 수집·Solar 요청 동안 MV3 Service Worker가 잠들지 않게 합니다.
 * 여러 기능이 동시에 실행돼도 heartbeat는 하나만 유지하고, 마지막 작업이 끝나면
 * 즉시 정리해 유휴 상태의 확장을 불필요하게 깨우지 않습니다.
 */

const HEARTBEAT_INTERVAL_MS = 20_000;

let activeJobs = 0;
let heartbeatTimer = null;

export async function withServiceWorkerKeepAlive(job) {
  activeJobs += 1;
  startHeartbeat();
  try {
    return await job();
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    if (activeJobs === 0) stopHeartbeat();
  }
}

function startHeartbeat() {
  if (heartbeatTimer !== null) return;
  pingExtensionApi();
  heartbeatTimer = setInterval(pingExtensionApi, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer === null) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function pingExtensionApi() {
  chrome.runtime.getPlatformInfo().catch(() => undefined);
}
