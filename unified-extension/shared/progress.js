/**
 * 팝업을 닫았다 열어도 분석 상황을 복원할 수 있도록 본문이 아닌 진행 메타데이터만
 * chrome.storage.session에 보관합니다. 직렬 큐로 갱신해 병렬 기능 간 덮어쓰기를 막습니다.
 */

export const PROGRESS_KEY = "gurajegeoProgress";

// Service Worker가 다시 만들어지면 값이 바뀝니다. 이전 인스턴스가 남긴 running
// 상태를 팝업 초기화 때 식별해 멈춘 진행 카드로 복구하는 용도입니다.
const WORKER_INSTANCE_ID = crypto.randomUUID();

const DEFAULT_FEATURE_PROGRESS = Object.freeze({
  status: "idle",
  phase: "대기",
  total: 0,
  completed: 0,
  failed: 0,
  detail: "분석을 시작하지 않았습니다.",
  tabId: null,
  pageKey: "",
  updatedAt: 0
});

let progressWriteQueue = Promise.resolve();

export async function getProgress() {
  const stored = await chrome.storage.session.get(PROGRESS_KEY);
  const value = stored[PROGRESS_KEY] || {};
  return {
    title: normalizeFeatureProgress(value.title),
    risk: normalizeFeatureProgress(value.risk),
    official: normalizeFeatureProgress(value.official)
  };
}

export function reportProgress(feature, patch) {
  progressWriteQueue = progressWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await getProgress();
      const nextFeature = normalizeFeatureProgress({
        ...current[feature],
        ...patch,
        workerInstanceId: WORKER_INSTANCE_ID,
        updatedAt: Date.now()
      });
      const next = { ...current, [feature]: nextFeature };
      await chrome.storage.session.set({ [PROGRESS_KEY]: next });

      // 팝업이 열려 있으면 즉시 갱신하고, 닫혀 있으면 전송 오류를 무시합니다.
      chrome.runtime.sendMessage({
        target: "gj:popup",
        type: "PROGRESS_UPDATED",
        payload: { feature, progress: nextFeature }
      }).catch(() => undefined);
      return nextFeature;
    });
  return progressWriteQueue;
}

/** 이전 Service Worker가 남긴 진행 중 상태를 명시적인 오류 상태로 복구합니다. */
export async function recoverInterruptedProgress() {
  const current = await getProgress();
  const interrupted = Object.entries(current)
    .filter(([, progress]) => progress.status === "running" &&
      progress.workerInstanceId !== WORKER_INSTANCE_ID);

  if (interrupted.length === 0) return current;

  await Promise.all(interrupted.map(([feature, progress]) => reportProgress(feature, {
    status: "error",
    phase: "실행 중단",
    total: progress.total,
    completed: progress.completed,
    failed: progress.failed,
    detail: "브라우저가 백그라운드 작업을 다시 시작했습니다. 현재 페이지에서 다시 실행해 주세요.",
    tabId: progress.tabId,
    pageKey: progress.pageKey
  })));
  return getProgress();
}

export function clearProgress(feature) {
  if (feature) {
    return reportProgress(feature, DEFAULT_FEATURE_PROGRESS);
  }
  progressWriteQueue = progressWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const next = {
        title: normalizeFeatureProgress(),
        risk: normalizeFeatureProgress(),
        official: normalizeFeatureProgress()
      };
      await chrome.storage.session.set({ [PROGRESS_KEY]: next });
      return next;
    });
  return progressWriteQueue;
}

function normalizeFeatureProgress(value = {}) {
  const total = nonNegativeInteger(value.total);
  const completed = Math.min(total || Number.MAX_SAFE_INTEGER, nonNegativeInteger(value.completed));
  const failed = Math.min(total || Number.MAX_SAFE_INTEGER, nonNegativeInteger(value.failed));
  return {
    ...DEFAULT_FEATURE_PROGRESS,
    ...value,
    status: ["idle", "running", "complete", "error", "disabled"].includes(value.status)
      ? value.status
      : DEFAULT_FEATURE_PROGRESS.status,
    phase: String(value.phase || DEFAULT_FEATURE_PROGRESS.phase).slice(0, 60),
    total,
    completed,
    failed,
    detail: String(value.detail || DEFAULT_FEATURE_PROGRESS.detail).slice(0, 240),
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    pageKey: String(value.pageKey || "").slice(0, 1000),
    workerInstanceId: String(value.workerInstanceId || "").slice(0, 120),
    updatedAt: Number(value.updatedAt) || 0
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}
