const statusEl = document.getElementById("status");

document.getElementById("open-reader").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html") });
  window.close();
});

document.getElementById("add-site").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  statusEl.style.display = "block";
  statusEl.textContent = "Adding\u2026";
  statusEl.className = "";

  const res = await chrome.runtime.sendMessage({ type: "addFeed", url: tab.url });
  if (res.ok) {
    statusEl.textContent = "Added: " + res.feed.title;
    statusEl.className = "ok";
  } else {
    statusEl.textContent = res.error;
    statusEl.className = "error";
  }
});

document.getElementById("open-panel").addEventListener("click", () => {
  chrome.sidePanel?.open?.({ windowId: chrome.windows?.WINDOW_ID_CURRENT });
  window.close();
});
