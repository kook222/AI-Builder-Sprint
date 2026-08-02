import { SETTINGS_KEY, getSettings, saveSettings } from "./shared/settings.js";
import { PROGRESS_KEY, getProgress } from "./shared/progress.js";

const FEATURES = ["title", "risk", "official"];
const elements = {
  apiKey: document.querySelector("#gjp-api-key"),
  keyState: document.querySelector("#gjp-key-state"),
  saveKey: document.querySelector("#gjp-save-key"),
  keyVisibility: document.querySelector("#gjp-key-visibility"),
  run: document.querySelector("#gjp-run"),
  message: document.querySelector("#gjp-message"),
  overall: document.querySelector("#gjp-overall-state"),
  clearProgress: document.querySelector("#gjp-clear-progress")
};

let currentSettings;
let currentProgress;
let apiKeyDirty = false;
let runStarting = false;
let currentTabId = null;
let currentTabUrl = "";

initialize();

async function initialize() {
  try {
    const [dashboard, tabs] = await Promise.all([
      sendCore("GET_DASHBOARD"),
      chrome.tabs.query({ active: true, currentWindow: true })
    ]);
    currentSettings = dashboard.settings;
    currentProgress = dashboard.progress;
    currentTabId = tabs[0]?.id ?? null;
    currentTabUrl = tabs[0]?.url || "";
  } catch (error) {
    // Service Worker가 막 깨어나는 순간의 일시 오류에도 팝업 조작 자체는 유지합니다.
    [currentSettings, currentProgress] = await Promise.all([getSettings(), getProgress()]);
    showMessage(error instanceof Error ? error.message : String(error), true);
  }
  if (!Number.isInteger(currentTabId)) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id ?? null;
    currentTabUrl = tab?.url || "";
  }
  bindEvents();
  renderSettings();
  renderProgress();
}

function bindEvents() {
  elements.saveKey.addEventListener("click", saveApiKey);
  elements.apiKey.addEventListener("input", () => {
    apiKeyDirty = true;
  });
  elements.apiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveApiKey();
  });
  elements.keyVisibility.addEventListener("click", () => {
    const showing = elements.apiKey.type === "text";
    elements.apiKey.type = showing ? "password" : "text";
    elements.keyVisibility.textContent = showing ? "보기" : "숨김";
    elements.keyVisibility.setAttribute("aria-label", showing ? "API 키 표시" : "API 키 숨기기");
  });
  elements.run.addEventListener("click", runAnalysis);
  elements.clearProgress.addEventListener("click", async () => {
    try {
      const result = await sendCore("CLEAR_PROGRESS");
      currentProgress = result.progress;
      renderProgress();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), true);
    }
  });
  for (const toggle of document.querySelectorAll("[data-feature-toggle]")) {
    toggle.addEventListener("change", () => changeFeature(toggle.dataset.featureToggle, toggle.checked));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== "gj:popup" || message.type !== "PROGRESS_UPDATED") return false;
    currentProgress = {
      ...(currentProgress || {}),
      [message.payload.feature]: message.payload.progress
    };
    renderProgress();
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SETTINGS_KEY]) {
      getSettings().then((settings) => {
        currentSettings = settings;
        renderSettings();
      });
    }
    if (areaName === "session" && changes[PROGRESS_KEY]) {
      getProgress().then((progress) => {
        currentProgress = progress;
        renderProgress();
      });
    }
  });
}

async function saveApiKey() {
  currentSettings = await saveSettings({ apiKey: elements.apiKey.value });
  apiKeyDirty = false;
  elements.apiKey.value = currentSettings.apiKey;
  renderSettings();
  showMessage(currentSettings.apiKey ? "API 키를 저장했습니다." : "API 키를 삭제했습니다.");
}

async function changeFeature(feature, enabled) {
  if (!FEATURES.includes(feature)) return;
  currentSettings = await saveSettings({ features: { [feature]: enabled } });
  const result = await sendCore("FEATURE_TOGGLED", { feature, enabled });
  currentProgress = result.progress;
  renderSettings();
  renderProgress();
  showMessage(`${featureLabel(feature)} 기능을 ${enabled ? "켰습니다" : "껐습니다"}.`);
}

async function runAnalysis() {
  if (!currentSettings.apiKey) {
    showMessage("먼저 Upstage API 키를 입력해 주세요.", true);
    elements.apiKey.focus();
    return;
  }
  if (!FEATURES.some((feature) => currentSettings.features[feature])) {
    showMessage("실행할 기능을 하나 이상 켜 주세요.", true);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  currentTabUrl = tab?.url || "";
  if (runStarting || isCurrentPageRunning()) {
    showMessage("현재 페이지 분석이 진행 중입니다.");
    return;
  }

  runStarting = true;
  renderProgress();
  showMessage("활성화된 기능의 분석을 시작했습니다.");
  try {
    const result = await sendCore("RUN_ALL", { tabId: tab?.id });
    const skipped = result.skipped ? `, 이미 실행 중 ${result.skipped}개` : "";
    showMessage(`${result.started}개 기능을 시작했습니다${skipped}. 진행 상황은 위 카드에서 확인하세요.`);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    runStarting = false;
    renderProgress();
  }
}

function renderSettings() {
  if (!currentSettings) return;
  // 기능 토글 때문에 settings가 바뀌어도 사용자가 아직 저장하지 않은 키 입력은 보존합니다.
  if (!apiKeyDirty && document.activeElement !== elements.apiKey) {
    elements.apiKey.value = currentSettings.apiKey || "";
  }
  elements.keyState.textContent = currentSettings.apiKey ? "저장됨" : "미설정";
  elements.keyState.dataset.ready = String(Boolean(currentSettings.apiKey));
  for (const feature of FEATURES) {
    const enabled = currentSettings.features[feature];
    const toggle = document.querySelector(`[data-feature-toggle="${feature}"]`);
    const card = document.querySelector(`[data-feature-card="${feature}"]`);
    toggle.checked = enabled;
    card.dataset.disabled = String(!enabled);
  }
}

function renderProgress() {
  if (!currentSettings || !currentProgress) return;
  for (const feature of FEATURES) {
    const progress = currentProgress[feature] || {
      status: "idle",
      phase: "대기",
      total: 0,
      completed: 0,
      failed: 0,
      detail: "분석을 시작하지 않았습니다."
    };
    const enabled = currentSettings?.features?.[feature] !== false;
    const card = document.querySelector(`[data-feature-card="${feature}"]`);
    const phase = document.querySelector(`[data-progress-phase="${feature}"]`);
    const count = document.querySelector(`[data-progress-count="${feature}"]`);
    const bar = document.querySelector(`[data-progress-bar="${feature}"]`);
    const detail = document.querySelector(`[data-progress-detail="${feature}"]`);
    const done = progress.completed + progress.failed;
    const percent = progress.total ? Math.min(100, Math.round((done / progress.total) * 100)) : 0;

    card.dataset.status = enabled ? progress.status : "disabled";
    phase.textContent = enabled ? progress.phase : "꺼짐";
    count.textContent = enabled ? `${done} / ${progress.total}` : "—";
    bar.style.width = enabled ? `${percent}%` : "0%";
    bar.dataset.indeterminate = String(enabled && progress.status === "running" && progress.total === 0);
    detail.textContent = enabled ? progress.detail : "이 기능은 현재 실행되지 않습니다.";
  }

  const enabledProgress = FEATURES
    .filter((feature) => currentSettings?.features?.[feature])
    .map((feature) => currentProgress[feature])
    .filter(Boolean);
  const state = enabledProgress.some((item) => item.status === "running")
    ? "running"
    : enabledProgress.some((item) => item.status === "error")
      ? "error"
      : enabledProgress.length && enabledProgress.every((item) => item.status === "complete")
        ? "complete"
        : "idle";
  elements.overall.dataset.state = state;
  elements.overall.textContent = ({ running: "분석 중", error: "일부 실패", complete: "완료", idle: "대기" })[state];
  const pageRunning = isCurrentPageRunning();
  elements.run.disabled = runStarting || pageRunning;
  elements.clearProgress.disabled = state === "running";
  elements.run.textContent = pageRunning ? "현재 페이지 분석 중" : "현재 검색 페이지 분석";
}

function isCurrentPageRunning() {
  return FEATURES.some((feature) => {
    const progress = currentProgress?.[feature];
    return currentSettings?.features?.[feature] && progress?.status === "running" &&
      progress.tabId === currentTabId && progress.pageKey === currentTabUrl;
  });
}

function sendCore(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: "gj:core", type, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "확장 작업에 실패했습니다.");
    return response.data;
  });
}

function showMessage(message, error = false) {
  elements.message.textContent = message;
  elements.message.dataset.error = String(error);
}

function featureLabel(feature) {
  return ({ title: "제목·본문 비교", risk: "피싱·광고 위험", official: "공식 출처" })[feature] || feature;
}
