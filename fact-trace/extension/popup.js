// 팝업 - 온오프, 로그 저장

import { readLogs, clearLogs, formatLogs } from './lib/logger.js';

const toggle = document.getElementById('toggle');
const state = document.getElementById('state');
const count = document.getElementById('count');
const msg = document.getElementById('msg');
const saveBtn = document.getElementById('save');
const clearBtn = document.getElementById('clear');

function say(text) {
  msg.textContent = text;
  setTimeout(() => (msg.textContent = ''), 2500);
}

chrome.storage.local.get('enabled', ({ enabled }) => {
  const on = enabled !== false;
  toggle.checked = on;
  state.textContent = on ? '켜짐' : '꺼짐';
});

toggle.addEventListener('change', () => {
  const on = toggle.checked;
  state.textContent = on ? '켜짐' : '꺼짐';
  chrome.storage.local.set({ enabled: on });
});

const apikey = document.getElementById('apikey');
const keystate = document.getElementById('keystate');

chrome.storage.local.get('apiKey', ({ apiKey }) => {
  apikey.value = apiKey || '';
  keystate.textContent = apiKey ? '저장됨' : '필요';
});

apikey.addEventListener('change', () => {
  const value = apikey.value.trim();
  chrome.storage.local.set({ apiKey: value });
  keystate.textContent = value ? '저장됨' : '필요';
  say(value ? 'API 키를 저장했습니다' : 'API 키를 지웠습니다');
});

async function refreshCount() {
  const logs = await readLogs();
  count.textContent = `${logs.length}건`;
  saveBtn.disabled = logs.length === 0;
  clearBtn.disabled = logs.length === 0;
}

refreshCount();

saveBtn.addEventListener('click', async () => {
  const logs = await readLogs();
  if (!logs.length) return;

  const blob = new Blob([formatLogs(logs)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  chrome.downloads.download(
    { url, filename: `log/fact-trace-${stamp}.log`, saveAs: false },
    () => {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      say('log 폴더에 저장했습니다');
    }
  );
});

clearBtn.addEventListener('click', async () => {
  await clearLogs();
  await refreshCount();
  say('기록을 비웠습니다');
});
