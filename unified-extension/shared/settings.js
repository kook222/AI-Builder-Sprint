/**
 * 세 기능이 함께 사용하는 유일한 영구 설정 저장소입니다.
 * API 키는 확장 전용 저장소에만 두며 DOM이나 대상 사이트 요청에는 넣지 않습니다.
 * Solar 인증에 실제 키 값을 사용하는 주체는 Service Worker뿐입니다.
 */

export const SETTINGS_KEY = "gurajegeoSettings";

// API 키 저장과 여러 토글 변경이 거의 동시에 와도 마지막 쓰기가 다른 필드를
// 되돌리지 않도록 모든 설정 변경을 한 줄의 비동기 쓰기 큐로 직렬화합니다.
let settingsWriteQueue = Promise.resolve();

export async function ensureSettings() {
  const settings = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export function saveSettings(patch) {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await getSettings();
      const next = normalizeSettings({
        ...current,
        ...patch,
        features: {
          ...current.features,
          ...(patch?.features || {})
        }
      });
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      return next;
    });
  return settingsWriteQueue;
}

export async function isFeatureEnabled(feature) {
  const settings = await getSettings();
  return settings.features[feature] !== false;
}

export async function getApiKey() {
  const settings = await getSettings();
  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    throw new Error("확장 팝업에서 Upstage API 키를 입력해 주세요.");
  }
  return apiKey;
}

export function normalizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const features = source.features && typeof source.features === "object"
    ? source.features
    : {};
  return {
    apiKey: typeof source.apiKey === "string" ? source.apiKey.trim() : "",
    features: {
      title: features.title !== false,
      risk: features.risk !== false,
      official: features.official !== false
    }
  };
}
