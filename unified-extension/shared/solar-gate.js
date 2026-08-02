/** 모든 기능의 Solar 호출을 합산해 브라우저 전체 동시 요청 수를 제한합니다. */

const MAX_CONCURRENT_SOLAR_REQUESTS = 6;
let activeRequests = 0;
const waiters = [];

export async function runWithSolarSlot(job) {
  if (activeRequests >= MAX_CONCURRENT_SOLAR_REQUESTS) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  activeRequests += 1;
  try {
    return await job();
  } finally {
    activeRequests -= 1;
    waiters.shift()?.();
  }
}
