// --- Favicon helper ---

function getFaviconUrl(feedUrl) {
  try {
    const domain = new URL(feedUrl).origin;
    return `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(domain)}`;
  } catch {
    return "";
  }
}

// --- HTML entity decoding ---

function decodeEntities(s) {
  const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => map[m]);
}

// --- Rendering ---

function renderFeeds(container, feeds, feedItems, sortBy) {
  container.innerHTML = "";

  if (!feeds.length) {
    container.innerHTML = '<p class="empty">No feeds yet. Add one above.</p>';
    return;
  }

  const sorted = [...feeds].sort((a, b) => {
    if (sortBy === "frequency") return (b.readCount || 0) - (a.readCount || 0);
    if (sortBy === "recent") return (b.addedAt || 0) - (a.addedAt || 0);
    return (a.customOrder ?? 0) - (b.customOrder ?? 0);
  });

  for (const feed of sorted) {
    const items = feedItems[feed.url] || [];
    const section = document.createElement("div");
    section.className = "feed";

    const h2 = document.createElement("h2");

    const favicon = document.createElement("img");
    favicon.className = "feed-icon";
    favicon.src = getFaviconUrl(feed.url);
    favicon.alt = "";
    favicon.width = 16;
    favicon.height = 16;
    favicon.onerror = () => { favicon.style.display = "none"; };
    h2.appendChild(favicon);

    const titleLink = document.createElement("a");
    titleLink.href = feed.url;
    titleLink.target = "_blank";
    titleLink.textContent = decodeEntities(feed.title || feed.url);
    h2.appendChild(titleLink);

    const del = document.createElement("button");
    del.className = "feed-del";
    del.textContent = "\u00d7";
    del.title = "Remove feed";
    del.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "removeFeed", url: feed.url });
      load();
    });
    h2.appendChild(del);

    section.appendChild(h2);

    const ul = document.createElement("ul");
    const visibleCount = 5;
    items.forEach((item, i) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = item.link;
      a.target = "_blank";
      const maxLen = 120;
      const title = decodeEntities(item.title);
      a.textContent = title.length > maxLen ? title.slice(0, maxLen) + "\u2026" : title;
      a.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "trackRead", feedUrl: feed.url });
      });
      li.appendChild(a);
      if (item.pubDate) {
        const date = new Date(item.pubDate);
        if (!isNaN(date)) {
          const span = document.createElement("span");
          span.className = "item-date";
          const now = new Date();
          const diffMs = now - date;
          const diffDays = Math.floor(diffMs / 86400000);
          if (diffDays === 0) span.textContent = "today";
          else if (diffDays === 1) span.textContent = "1d";
          else if (diffDays < 30) span.textContent = diffDays + "d";
          else span.textContent = date.toLocaleDateString("en", { month: "short", day: "numeric" });
          li.appendChild(span);
        }
      }
      if (i >= visibleCount) li.hidden = true;
      ul.appendChild(li);
    });
    section.appendChild(ul);

    if (items.length > visibleCount) {
      const more = document.createElement("button");
      more.className = "more";
      more.textContent = "more\u2026";
      more.addEventListener("click", () => {
        ul.querySelectorAll("li[hidden]").forEach((li) => (li.hidden = false));
        more.remove();
      });
      section.appendChild(more);
    }

    container.appendChild(section);
  }
}

// --- Load & refresh ---

async function load() {
  const store = await chrome.runtime.sendMessage({ type: "getStore" });
  const container = document.getElementById("feeds");
  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) sortSelect.value = store.settings.sortBy;
  renderFeeds(container, store.feeds, store.feedItems, store.settings.sortBy);
}

// --- Header controls ---

document.getElementById("btn-refresh")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-refresh");
  btn.textContent = "Refreshing\u2026";
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: "refresh" });
  await load();
  btn.textContent = "Refresh";
  btn.disabled = false;
});

document.getElementById("btn-panel")?.addEventListener("click", () => {
  chrome.sidePanel?.open?.({ windowId: chrome.windows?.WINDOW_ID_CURRENT });
});

// --- Add feed ---

const urlInput = document.getElementById("url-input");
const btnAdd = document.getElementById("btn-add");
const statusEl = document.getElementById("status");

btnAdd?.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  statusEl.textContent = "Adding\u2026";
  statusEl.className = "status";
  btnAdd.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "addFeed", url });
  btnAdd.disabled = false;
  if (res.ok) {
    statusEl.textContent = "";
    urlInput.value = "";
    load();
  } else {
    statusEl.textContent = res.error;
    statusEl.className = "status error";
  }
});

urlInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnAdd.click();
});

// --- Import Bookmarks ---

document.getElementById("btn-import")?.addEventListener("click", () => {
  const modal = document.getElementById("import-modal");
  const progress = document.getElementById("import-progress");
  const list = document.getElementById("import-list");
  const actions = document.getElementById("import-actions");

  modal.hidden = false;
  progress.hidden = false;
  progress.textContent = "Scanning bookmarks for feeds\u2026";
  list.hidden = true;
  list.innerHTML = "";
  actions.hidden = true;
  document.getElementById("import-add").hidden = false;

  let foundAny = false;
  const port = chrome.runtime.connect({ name: "importBookmarks" });

  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      progress.textContent = `Scanning bookmarks\u2026 (${msg.current}/${msg.total})`;
    } else if (msg.type === "found") {
      foundAny = true;
      list.hidden = false;
      const label = document.createElement("label");
      label.className = "import-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = msg.url;
      label.appendChild(cb);
      const span = document.createElement("span");
      span.textContent = msg.title;
      label.appendChild(span);
      list.appendChild(label);
    } else if (msg.type === "done") {
      if (!foundAny) {
        progress.textContent = "No new feeds found in bookmarks.";
        document.getElementById("import-add").hidden = true;
      } else {
        progress.hidden = true;
      }
      actions.hidden = false;
    } else if (msg.type === "error") {
      progress.textContent = "Error: " + msg.error;
      actions.hidden = false;
      document.getElementById("import-add").hidden = true;
    }
  });
});

document.getElementById("import-cancel")?.addEventListener("click", () => {
  document.getElementById("import-modal").hidden = true;
});

document.getElementById("import-add")?.addEventListener("click", async () => {
  const modal = document.getElementById("import-modal");
  const list = document.getElementById("import-list");
  const actions = document.getElementById("import-actions");
  const progress = document.getElementById("import-progress");

  const checked = list.querySelectorAll("input[type=checkbox]:checked");
  if (!checked.length) {
    modal.hidden = true;
    return;
  }

  actions.hidden = true;
  list.hidden = true;
  progress.hidden = false;
  progress.textContent = "Adding feeds\u2026";

  for (const cb of checked) {
    await chrome.runtime.sendMessage({ type: "addFeed", url: cb.value });
  }

  modal.hidden = true;
  load();
});

document.getElementById("import-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "import-modal") {
    document.getElementById("import-modal").hidden = true;
  }
});

// --- Sort toggle ---

document.getElementById("sort-select")?.addEventListener("change", async (e) => {
  const store = await chrome.runtime.sendMessage({ type: "getStore" });
  store.settings.sortBy = e.target.value;
  await chrome.runtime.sendMessage({ type: "saveSettings", settings: store.settings });
  load();
});

// --- Side panel: highlight active article ---

const isSidePanel = document.body.classList.contains("sidepanel");

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/$/, "") + u.search;
  } catch {
    return url;
  }
}

function highlightActive(tabUrl) {
  document.querySelectorAll("#feeds .feed li").forEach((li) => {
    const a = li.querySelector("a");
    if (!a) return;
    const match = normalizeUrl(a.href) === normalizeUrl(tabUrl);
    li.classList.toggle("active", match);
    if (match && li.hidden) {
      li.closest(".feed")?.querySelectorAll("li[hidden]").forEach((h) => (h.hidden = false));
      li.closest(".feed")?.querySelector(".more")?.remove();
    }
  });
}

async function updateHighlight() {
  if (!isSidePanel) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) highlightActive(tab.url);
  } catch {}
}

if (isSidePanel) {
  chrome.tabs.onActivated.addListener(() => updateHighlight());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") updateHighlight();
  });
}

load().then(() => updateHighlight());
