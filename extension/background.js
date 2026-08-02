const API_URL = "http://127.0.0.1:8787/classify";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CLASSIFY_RESULTS") {
    return;
  }

  classify(message.payload)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function classify(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `서버 오류 (${response.status})`);
  }

  return { ok: true, ...data };
}
