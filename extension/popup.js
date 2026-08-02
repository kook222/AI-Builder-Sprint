const enabledToggle = document.querySelector("#enabled");

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  enabledToggle.checked = enabled;
});

enabledToggle.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledToggle.checked });
});
