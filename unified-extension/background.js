/**
 * 통합 Service Worker 진입점입니다.
 * 기능별 코드는 각 모듈이 소유하고, 이 파일은 설정 초기화와 팝업 명령만 조정합니다.
 */

import { ensureSettings, getSettings } from "./shared/settings.js";
import {
  clearProgress,
  getProgress,
  recoverInterruptedProgress,
  reportProgress
} from "./shared/progress.js";
import { startTitleAnalysisInTab } from "./features/title/background.js";
import "./features/risk/background.js";
import "./features/official/background.js";

// 자동 실행과 수동 버튼이 동시에 들어와도 같은 검색 화면은 한 번만 시작합니다.
const featureStartRuns = new Map();

chrome.runtime.onInstalled.addListener(() => {
  ensureSettings().catch((error) => console.error("[구라제거기] 설정 초기화 실패", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "gj:core") {
    return false;
  }

  const operation = routeCoreMessage(message, sender);
  operation
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  return true;
});

async function routeCoreMessage(message, sender) {
  if (message.type === "GET_DASHBOARD") {
    const [settings, progress] = await Promise.all([getSettings(), recoverInterruptedProgress()]);
    return { settings, progress };
  }
  if (message.type === "CLEAR_PROGRESS") {
    const current = await getProgress();
    if (Object.values(current).some((item) => item.status === "running")) {
      throw new Error("분석이 끝난 뒤 상태를 초기화해 주세요.");
    }
    await clearProgress();
    return { progress: await getProgress() };
  }
  if (message.type === "FEATURE_TOGGLED") {
    const feature = String(message.feature || "");
    if (!['title', 'risk', 'official'].includes(feature)) {
      throw new Error("알 수 없는 기능입니다.");
    }
    await reportProgress(feature, message.enabled ? {
      status: "idle",
      phase: "대기",
      total: 0,
      completed: 0,
      failed: 0,
      detail: "다음 분석 실행을 기다립니다."
    } : {
      status: "disabled",
      phase: "꺼짐",
      total: 0,
      completed: 0,
      failed: 0,
      detail: "이 기능은 현재 실행되지 않습니다."
    });
    return { progress: await getProgress() };
  }
  if (message.type === "RUN_ALL") {
    return runEnabledFeatures(Number(message.tabId));
  }
  if (message.type === "AUTO_RUN") {
    return startAutomaticAnalysis(message, sender);
  }
  throw new Error("지원하지 않는 통합 명령입니다.");
}

/** Google content script가 보낸 현재 검색 화면만 자동 실행합니다. */
async function startAutomaticAnalysis(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    throw new Error("자동 분석을 요청한 검색 탭을 확인하지 못했습니다.");
  }

  const requestedIdentity = String(message.identity || "");
  const messageIdentity = getGoogleSearchIdentity(String(message.pageUrl || ""));
  const tab = await chrome.tabs.get(tabId);
  const tabIdentity = getGoogleSearchIdentity(tab.url || "");
  if (!requestedIdentity || requestedIdentity !== messageIdentity || requestedIdentity !== tabIdentity) {
    throw new Error("검색 페이지가 변경되어 자동 분석 요청을 취소했습니다.");
  }

  const settings = await getSettings();
  const enabledCount = Object.values(settings.features).filter(Boolean).length;
  if (!settings.apiKey || enabledCount === 0) {
    return { accepted: false, reason: "not-ready", tabId, identity: requestedIdentity };
  }

  return runEnabledFeatures(tabId, {
    expectedIdentity: requestedIdentity,
  }).then((result) => ({
    ...result,
    accepted: result.started + result.skipped > 0 && result.failedToStart === 0,
    identity: requestedIdentity,
  }));
}

async function runEnabledFeatures(tabId, { expectedIdentity = "" } = {}) {
  if (!Number.isInteger(tabId)) {
    throw new Error("현재 탭을 확인하지 못했습니다.");
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleSearchUrl(tab.url || "")) {
    throw new Error("Google 검색 결과 페이지에서 실행해 주세요.");
  }
  if (expectedIdentity && getGoogleSearchIdentity(tab.url || "") !== expectedIdentity) {
    throw new Error("검색 페이지가 변경되어 자동 분석을 시작하지 않았습니다.");
  }

  const identity = getGoogleSearchIdentity(tab.url || "");
  const runKey = `${tabId}:${identity}`;
  const existing = featureStartRuns.get(runKey);
  if (existing) return existing;

  const operation = startEnabledFeatures(tabId, tab.url || "", identity, expectedIdentity)
    .finally(() => {
      if (featureStartRuns.get(runKey) === operation) featureStartRuns.delete(runKey);
    });
  featureStartRuns.set(runKey, operation);
  return operation;
}

async function startEnabledFeatures(tabId, pageUrl, identity, expectedIdentity) {
  const [settings, progress] = await Promise.all([getSettings(), recoverInterruptedProgress()]);
  if (expectedIdentity) await assertCurrentSearchIdentity(tabId, expectedIdentity);

  const tasks = [];
  let skipped = 0;
  const alreadyRunning = (feature) => progress[feature]?.status === "running" &&
    progress[feature]?.tabId === tabId &&
    getGoogleSearchIdentity(progress[feature]?.pageKey || "") === identity;

  if (settings.features.title) {
    if (alreadyRunning("title")) skipped += 1;
    else {
      tasks.push(startFeature(
        "title", tabId, pageUrl, () => startTitleAnalysisInTab(tabId), expectedIdentity,
      ));
    }
  }
  if (settings.features.risk) {
    if (alreadyRunning("risk")) skipped += 1;
    else {
      tasks.push(startFeature("risk", tabId, pageUrl, () => sendContentCommand(tabId, {
        target: "gj:risk-content",
        type: "RUN",
        scripts: ["features/risk/content/serp.js", "features/risk/content/page.js"],
        styles: ["shared/content.css", "features/risk/content/style.css"]
      }), expectedIdentity));
    }
  }
  if (settings.features.official) {
    if (alreadyRunning("official")) skipped += 1;
    else {
      tasks.push(startFeature("official", tabId, pageUrl, () => sendContentCommand(tabId, {
        target: "gj:official-content",
        type: "RUN",
        scripts: ["features/official/content.js"],
        styles: ["shared/content.css", "features/official/badge.css"]
      }), expectedIdentity));
    }
  }

  // 제목 분석은 전체 본문을 읽으므로 완료까지 기다리지 않고 팝업을 즉시 갱신합니다.
  const settled = await Promise.allSettled(tasks);
  const started = settled.filter((result) => result.status === "fulfilled").length;
  return { started, skipped, failedToStart: settled.length - started, tabId, url: pageUrl };
}

async function startFeature(feature, tabId, pageKey, operation, expectedIdentity = "") {
  await reportProgress(feature, {
    status: "running",
    phase: "시작",
    total: 0,
    completed: 0,
    failed: 0,
    detail: "현재 검색 페이지를 읽고 있습니다.",
    tabId,
    pageKey
  });
  try {
    if (expectedIdentity) await assertCurrentSearchIdentity(tabId, expectedIdentity);
    const response = await operation();
    if (!response?.ok) {
      throw new Error(response?.error || "분석 시작 요청을 처리하지 못했습니다.");
    }
    return response;
  } catch (error) {
    await reportProgress(feature, {
      status: "error",
      phase: "시작 실패",
      total: 0,
      completed: 0,
      failed: 0,
      detail: error instanceof Error ? error.message : String(error),
      tabId,
      pageKey
    });
    throw error;
  }
}

async function assertCurrentSearchIdentity(tabId, expectedIdentity) {
  const tab = await chrome.tabs.get(tabId);
  if (getGoogleSearchIdentity(tab.url || "") !== expectedIdentity) {
    throw new Error("검색 페이지가 변경되어 이전 자동 분석을 시작하지 않았습니다.");
  }
}

async function sendContentCommand(tabId, { target, type, scripts, styles }) {
  try {
    return await chrome.tabs.sendMessage(tabId, { target, type });
  } catch (error) {
    if (!isMissingMessageReceiver(error)) throw error;
    await chrome.scripting.insertCSS({ target: { tabId }, files: styles });
    await chrome.scripting.executeScript({ target: { tabId }, files: scripts });
    return chrome.tabs.sendMessage(tabId, { target, type });
  }
}

function isMissingMessageReceiver(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection");
}

function isGoogleSearchUrl(value) {
  try {
    const url = new URL(value);
    return /^www\.google\.(?:com|co\.kr)$/.test(url.hostname) && url.pathname === "/search";
  } catch {
    return false;
  }
}

/** q·페이지 번호·검색 영역이 같은지 비교하기 위한 안정적인 검색 식별자입니다. */
function getGoogleSearchIdentity(value) {
  try {
    const url = new URL(value);
    if (!/^www\.google\.(?:com|co\.kr)$/.test(url.hostname) || url.pathname !== "/search") {
      return "";
    }
    return JSON.stringify({
      q: String(url.searchParams.get("q") || "").trim(),
      start: String(url.searchParams.get("start") || "0").trim(),
      tbm: String(url.searchParams.get("tbm") || "").trim(),
      udm: String(url.searchParams.get("udm") || "").trim(),
    });
  } catch {
    return "";
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of featureStartRuns.keys()) {
    if (key.startsWith(`${tabId}:`)) featureStartRuns.delete(key);
  }
});
