// --- RSS/Atom Parser (regex-based, works in service workers) ---

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeEntities(m[1].trim()) : "";
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}\\s*=\\s*"([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function stripCDATA(s) {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function decodeEntities(s) {
  const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => map[m]);
}

function parseRSS(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml);

  if (isAtom) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const entry of entries) {
      items.push({
        title: stripCDATA(extractTag(entry, "title")),
        link: extractAttr(entry, "link", "href") || stripCDATA(extractTag(entry, "link")),
        pubDate: extractTag(entry, "updated") || extractTag(entry, "published"),
      });
    }
  } else {
    const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    for (const item of rssItems) {
      items.push({
        title: stripCDATA(extractTag(item, "title")),
        link: stripCDATA(extractTag(item, "link")),
        pubDate: extractTag(item, "pubDate") || extractTag(item, "dc:date"),
      });
    }
  }

  if (!items.length) return null;
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items.slice(0, 20);
}

function parseFeedTitle(xml) {
  const isAtom = /<feed[\s>]/i.test(xml);
  if (isAtom) {
    const feedBlock = xml.match(/<feed[\s>][\s\S]*?(?=<entry[\s>])/i);
    if (feedBlock) return stripCDATA(extractTag(feedBlock[0], "title"));
  }
  const channelBlock = xml.match(/<channel[\s>][\s\S]*?(?=<item[\s>])/i);
  if (channelBlock) return stripCDATA(extractTag(channelBlock[0], "title"));
  return stripCDATA(extractTag(xml, "title"));
}

// --- Storage Helpers ---

async function getStore() {
  const data = await chrome.storage.local.get(["feeds", "feedItems", "settings"]);
  return {
    feeds: data.feeds || [],
    feedItems: data.feedItems || {},
    settings: data.settings || { sortBy: "custom", refreshInterval: 30 },
  };
}

async function saveFeeds(feeds) {
  await chrome.storage.local.set({ feeds });
}

async function saveFeedItems(feedItems) {
  await chrome.storage.local.set({ feedItems });
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// --- Feed Auto-Detection ---

function fetchWithTimeout(url, ms = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function detectFeeds(url) {
  const found = [];
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return found;
    const html = await res.text();
    const linkRe = /<link[^>]+(?:rel=["']alternate["'][^>]*type=["']application\/(rss|atom)\+xml["']|type=["']application\/(rss|atom)\+xml["'][^>]*rel=["']alternate["'])[^>]*>/gi;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const tag = match[0];
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (hrefMatch) {
        try {
          const resolved = new URL(hrefMatch[1], url).href;
          if (!found.includes(resolved)) found.push(resolved);
        } catch {}
      }
    }
  } catch {}

  if (!found.length) {
    const origin = new URL(url).origin;
    const commonPaths = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/rss.xml", "/index.xml"];
    const probes = await Promise.allSettled(commonPaths.map(async (path) => {
      const probe = origin + path;
      const res = await fetchWithTimeout(probe);
      if (!res.ok) return null;
      const text = await res.text();
      return parseRSS(text) ? probe : null;
    }));
    for (const r of probes) {
      if (r.status === "fulfilled" && r.value) {
        found.push(r.value);
        break;
      }
    }
  }

  return found;
}

// --- Feed Fetching ---

async function fetchFeed(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const xml = await res.text();
    return xml;
  } catch {
    return null;
  }
}

async function refreshAllFeeds() {
  const store = await getStore();
  const feedItems = { ...store.feedItems };

  for (const feed of store.feeds) {
    const xml = await fetchFeed(feed.url);
    if (!xml) continue;

    // Update feed title if we don't have one yet
    if (!feed.title || feed.title === feed.url) {
      const title = parseFeedTitle(xml);
      if (title) feed.title = title;
    }

    const items = parseRSS(xml);
    if (items) feedItems[feed.url] = items;
  }

  await saveFeeds(store.feeds);
  await saveFeedItems(feedItems);
}

// --- Alarm Setup ---

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh") refreshAllFeeds();
});

chrome.runtime.onInstalled.addListener(async () => {
  const store = await getStore();
  chrome.alarms.create("refresh", { periodInMinutes: store.settings.refreshInterval });
  refreshAllFeeds();
});

chrome.runtime.onStartup.addListener(() => {
  refreshAllFeeds();
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "addFeed") {
    (async () => {
      try {
        const store = await getStore();
        if (store.feeds.some((f) => f.url === msg.url)) {
          sendResponse({ ok: false, error: "Feed already exists" });
          return;
        }

        let feedUrl = msg.url;
        let xml = await fetchFeed(feedUrl);
        let items = xml ? parseRSS(xml) : null;

        // If direct parse failed, treat as website URL and auto-detect
        if (!items) {
          const detected = await detectFeeds(msg.url);
          for (const candidate of detected) {
            if (store.feeds.some((f) => f.url === candidate)) continue;
            const candidateXml = await fetchFeed(candidate);
            const candidateItems = candidateXml ? parseRSS(candidateXml) : null;
            if (candidateItems) {
              feedUrl = candidate;
              xml = candidateXml;
              items = candidateItems;
              break;
            }
          }
        }

        if (!items) {
          sendResponse({ ok: false, error: "No RSS feed found" });
          return;
        }

        if (store.feeds.some((f) => f.url === feedUrl)) {
          sendResponse({ ok: false, error: "Feed already exists" });
          return;
        }

        const title = parseFeedTitle(xml) || feedUrl;
        const feed = {
          url: feedUrl,
          title,
          customOrder: store.feeds.length,
          readCount: 0,
          addedAt: Date.now(),
        };

        store.feeds.push(feed);
        store.feedItems[feedUrl] = items;
        await saveFeeds(store.feeds);
        await saveFeedItems(store.feedItems);
        sendResponse({ ok: true, feed });
      } catch (err) {
        console.error("addFeed error:", err);
        sendResponse({ ok: false, error: err.message || "Unknown error" });
      }
    })();
    return true;
  }

  if (msg.type === "removeFeed") {
    (async () => {
      try {
        const store = await getStore();
        store.feeds = store.feeds.filter((f) => f.url !== msg.url);
        delete store.feedItems[msg.url];
        await saveFeeds(store.feeds);
        await saveFeedItems(store.feedItems);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "reorderFeeds") {
    (async () => {
      try {
        const store = await getStore();
        const byUrl = Object.fromEntries(store.feeds.map((f) => [f.url, f]));
        const reordered = msg.urls.map((url, i) => {
          const feed = byUrl[url];
          if (feed) feed.customOrder = i;
          return feed;
        }).filter(Boolean);
        await saveFeeds(reordered);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "trackRead") {
    (async () => {
      try {
        const store = await getStore();
        const feed = store.feeds.find((f) => f.url === msg.feedUrl);
        if (feed) {
          feed.readCount = (feed.readCount || 0) + 1;
          await saveFeeds(store.feeds);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "refresh") {
    refreshAllFeeds().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "getStore") {
    getStore().then((store) => sendResponse(store)).catch(() => sendResponse({ feeds: [], feedItems: {}, settings: { sortBy: "custom", refreshInterval: 30 } }));
    return true;
  }

  if (msg.type === "saveSettings") {
    (async () => {
      try {
        await saveSettings(msg.settings);
        chrome.alarms.create("refresh", { periodInMinutes: msg.settings.refreshInterval });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// --- Bookmark Import (port-based for streaming progress) ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "importBookmarks") return;

  (async () => {
    try {
      const store = await getStore();
      const subscribedOrigins = new Set(store.feeds.map((f) => {
        try { return new URL(f.url).origin; } catch { return ""; }
      }));

      function flattenBookmarks(nodes) {
        const urls = [];
        for (const node of nodes) {
          if (node.url && node.url.startsWith("http")) urls.push(node.url);
          if (node.children) urls.push(...flattenBookmarks(node.children));
        }
        return urls;
      }

      const tree = await chrome.bookmarks.getTree();
      const allUrls = flattenBookmarks(tree);
      const seenOrigins = new Set();
      const uniqueUrls = [];
      for (const url of allUrls) {
        try {
          const origin = new URL(url).origin;
          if (seenOrigins.has(origin) || subscribedOrigins.has(origin)) continue;
          seenOrigins.add(origin);
          uniqueUrls.push(url);
        } catch {}
      }

      const total = uniqueUrls.length;
      let scanned = 0;
      const BATCH = 10;
      const seenFeedUrls = new Set();

      for (let i = 0; i < total; i += BATCH) {
        const batch = uniqueUrls.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async (url) => {
          try {
            const feeds = await detectFeeds(url);
            if (feeds.length) {
              const feedUrl = feeds[0];
              if (seenFeedUrls.has(feedUrl)) return;
              seenFeedUrls.add(feedUrl);
              const currentStore = await getStore();
              if (currentStore.feeds.some((f) => f.url === feedUrl)) return;
              let title = feedUrl;
              try {
                const res = await fetchWithTimeout(feedUrl);
                if (res.ok) {
                  const xml = await res.text();
                  title = parseFeedTitle(xml) || feedUrl;
                }
              } catch {}
              port.postMessage({ type: "found", url: feedUrl, title });
            }
          } catch {}
        }));
        scanned += batch.length;
        port.postMessage({ type: "progress", current: scanned, total });
      }

      port.postMessage({ type: "done" });
    } catch (err) {
      port.postMessage({ type: "error", error: err.message || "Unknown error" });
    }
  })();
});
