(() => {
  const ALL_SERVERS_BUTTON_ID = "lootlink-scan-all-servers-button";
  const PANEL_ID = "lootlink-sync-raids-panel";
  // const API_IMPORT_URL = "http://localhost:3000/api/raidhelper/import";
  const API_IMPORT_URL = "https://loot-link-server.onrender.com/api/raidhelper/import";

  // Tune scan speed here.
  const SERVER_WAIT_MS = 350;
  const CHANNEL_WAIT_MS = 350;
  const BETWEEN_ACTIONS_MS = 80;

  const RAID_CHANNEL_KEYWORDS = [
    "raid", "signup", "sign-up", "signups", "mc", "molten", "bwl", "blackwing",
    "aq", "aq20", "aq40", "zg", "zul", "ony", "onyxia", "naxx", "gdkp"
  ];

  const SKIP_SERVERS = [
    "Raid-Helper",
    "Loot-Link's server",
    "Capstone",
  ];

  let scanIsRunning = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getChannelIdFromUrl() {
    const match = location.pathname.match(/\/channels\/\d+\/(\d+)/);
    return match ? match[1] : null;
  }

  function getGuildIdFromUrl() {
    const match = location.pathname.match(/\/channels\/(\d+)\/\d+/);
    return match ? match[1] : null;
  }

  function cleanText(text) {
    return (text || "")
      .replace(/\u200e/g, "")
      .replace(/\u2800/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyFn(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function safeUrl(href) {
    try {
      return new URL(href, location.origin);
    } catch {
      return null;
    }
  }

  function parseGcalStart(gcalUrl) {
    if (!gcalUrl) return null;
    try {
      const url = new URL(gcalUrl);
      const dates = url.searchParams.get("dates");
      const start = dates?.split("/")[0];
      if (!start) return null;
      const match = start.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (!match) return null;
      const [, year, month, day, hour, minute, second] = match;
      return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString();
    } catch {
      return null;
    }
  }

  function parseRenderedDateTime(text) {
    const lines = text.split("\n").map(cleanText).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const dateMatch = lines[i].match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i);
      if (!dateMatch) continue;

      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const timeMatch = lines[j].match(/^\d{1,2}:\d{2}\s*(AM|PM)$/i);
        if (!timeMatch) continue;

        const parsed = new Date(`${lines[i]} ${lines[j]}`);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      }
    }

    return null;
  }

  function normalizeTitle(title) {
    return cleanText(title)
      .replace(/^@/, "")
      .replace(/^#+/, "")
      .replace(/\s*\(edited\)$/i, "")
      .trim();
  }

  function dedupeRaids(raids) {
    const map = new Map();

    for (const raid of raids) {
      const key = raid.eventId || raid.softresId || `${raid.title}-${raid.startTime || raid.rawText?.slice(0, 80)}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, raid);
        continue;
      }

      const score = (r) =>
        Number(Boolean(r.eventId)) * 4 +
        Number(Boolean(r.startTime)) * 3 +
        Number(Boolean(r.signupCount)) * 2 +
        Math.min((r.rawText || "").length, 4000) / 4000;

      if (score(raid) > score(existing)) map.set(key, raid);
    }

    return [...map.values()];
  }

  function getClosestMessageNode(el) {
    return (
      el.closest('[id^="chat-messages-"]') ||
      el.closest('[class*="message"]') ||
      el.closest("li") ||
      el.closest("article") ||
      el.parentElement
    );
  }

  function parseSignup(text) {
    const lines = text.split("\n").map(cleanText).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(\d+)\s*\/\s*(\d+)(?:\s*\(\+\d+\))?$/);
      if (match) return { signupCount: Number(match[1]), signupMax: Number(match[2]) };
    }
    return { signupCount: null, signupMax: null };
  }

  function getGcalTitle(gcalUrl) {
    if (!gcalUrl) return null;
    try {
      return normalizeTitle(new URL(gcalUrl).searchParams.get("text") || "");
    } catch {
      return null;
    }
  }

  function isEventDateLine(line) {
    return /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i.test(line);
  }

  function isMessageTimestampLine(line) {
    return /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(line);
  }

  function isDiscordShortTimestampLine(line) {
    return /^(Today|Yesterday)\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(line) ||
      /^\d{1,2}\/\d{1,2}\/\d{2},\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(line);
  }

  function parseRaidNameAndNotes(text, gcalUrl, fallbackTitle) {
    const rawLines = text.split("\n").map(cleanText).filter(Boolean);

    const gcalTitle = getGcalTitle(gcalUrl);
    const raidName = normalizeTitle(gcalTitle || fallbackTitle || "Raid Helper Event");

    const eventDateIndex = rawLines.findIndex(isEventDateLine);
    let raidLeader = null;

    if (eventDateIndex > 0) {
      const possibleLeader = rawLines[eventDateIndex - 1];
      raidLeader = possibleLeader && possibleLeader !== "—" ? possibleLeader : null;
    }

    if (eventDateIndex === -1) {
      return { raidName, raidNotes: null, raidLeader: null };
    }

    let noteStartIndex = 0;
    for (let i = 0; i < eventDateIndex; i++) {
      if (isMessageTimestampLine(rawLines[i]) || isDiscordShortTimestampLine(rawLines[i])) {
        noteStartIndex = i + 1;
      }
    }

    let noteEndIndex = eventDateIndex;
    if (noteEndIndex - noteStartIndex > 1) {
      // Usually the line immediately before the event date is the raid leader name.
      noteEndIndex -= 1;
    }

    const ignoreExact = new Set([
      "Raid-Helper",
      "VERIFIED APP",
      "APP",
      "Web View",
      "Comp",
      "Gcal",
      "Premium",
      "Softres.it",
      "Select your class.",
      "—",
    ]);

    const noteLines = rawLines
      .slice(noteStartIndex, noteEndIndex)
      .map((line) => cleanText(line))
      .filter(Boolean)
      .filter((line) => !ignoreExact.has(line))
      .filter((line) => normalizeTitle(line) !== raidName)
      .filter((line) => !line.startsWith("@") || normalizeTitle(line) !== raidName)
      .filter((line) => !isMessageTimestampLine(line))
      .filter((line) => !isDiscordShortTimestampLine(line))
      .filter((line) => !isEventDateLine(line));

    const raidNotes = noteLines.length ? noteLines.join("\n") : null;
    return { raidName, raidNotes, raidLeader };
  }

  function parseRaidCard(node) {
    const text = cleanText(node.innerText || node.textContent || "");
    const links = [...node.querySelectorAll("a")].map((a) => ({
      text: cleanText(a.innerText || a.textContent || ""),
      href: a.href
    }));

    const raidHelperLink = links.find((l) =>
      l.href.includes("raid-helper.xyz/event/") || l.href.includes("raid-helper.dev/event/")
    );
    const softresLink = links.find((l) => l.href.includes("softres.it/raid/"));
    const gcalLink = links.find((l) => l.href.includes("google.com/calendar"));

    const eventId = raidHelperLink?.href.match(/event\/(\d+)/)?.[1] || text.match(/event-(\d+)/)?.[1] || null;
    const softresId = softresLink?.href.match(/softres\.it\/raid\/([A-Za-z0-9]+)/)?.[1] || null;

    const lines = text
      .split("\n")
      .map((line) => cleanText(line))
      .filter(Boolean)
      .filter((line) => !["Raid-Helper", "VERIFIED APP", "APP", "Web View", "Comp", "Gcal", "Softres.it"].includes(line));

    let title =
      getGcalTitle(gcalLink?.href) ||
      lines.find((line) => /^@?(AQ40|AQ20|MC|Molten Core|BWL|Blackwing|Ony|Onyxia|ZG|Naxx)/i.test(line)) ||
      lines.find((line) => /AQ40|AQ20|Molten Core|\bMC\b|BWL|Blackwing|Ony|Onyxia|ZG|Zul|Naxx/i.test(line)) ||
      lines.find((line) => line !== "—") ||
      "Raid Helper Event";

    const { raidName, raidNotes, raidLeader } = parseRaidNameAndNotes(text, gcalLink?.href, title);
    title = raidName || normalizeTitle(title);

    const startTime = parseGcalStart(gcalLink?.href) || parseRenderedDateTime(text);
    const { signupCount, signupMax } = parseSignup(text);
    const timestampMatch = text.match(/<t:(\d+):[A-Za-z]>/);

    return {
      source: "discord-visible-dom",
      guildId: getGuildIdFromUrl(),
      
      channelId: getChannelIdFromUrl(),
      eventId,
      title: normalizeTitle(title),
      raidName,
      raidNotes,
      raidLeader,
      startTime,
      displayDateTime: startTime ? new Date(startTime).toLocaleString() : null,
      signupCount,
      signupMax,
      discordTimestamp: timestampMatch ? Number(timestampMatch[1]) : null,
      raidHelperUrl: raidHelperLink?.href || null,
      softresUrl: softresLink?.href || null,
      softresId,
      gcalUrl: gcalLink?.href || null,
      rawText: text.slice(0, 4000),
      scannedAt: new Date().toISOString()
    };
  }

  async function importRaids(raids) {
    // Only import real Raid-Helper events. SoftRes-only links are useful context but not calendar events.
    const cleanRaids = dedupeRaids(raids).filter((raid) => raid?.eventId);
    if (!cleanRaids.length) return null;

    try {
      const res = await fetch(API_IMPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanRaids)
      });
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        console.log("[LootLink] Import result:", json);
        return json;
      } catch {
        console.log("[LootLink] Raw import response:", text);
        return text;
      }
    } catch (err) {
      console.error("[LootLink] Import failed:", err);
      return null;
    }
  }

  function scanCurrentChannel({ show = true, send = true } = {}) {
    const raidHelperLinks = [
      ...document.querySelectorAll('a[href*="raid-helper.xyz/event/"], a[href*="raid-helper.dev/event/"], a[href*="softres.it/raid/"]')
    ];

    const nodes = uniqueBy(
      raidHelperLinks.map(getClosestMessageNode).filter(Boolean),
      (node) => node.id || node.innerText?.slice(0, 200)
    );

    const raids = dedupeRaids(
      nodes
        .map(parseRaidCard)
        .filter((raid) => raid.eventId)
    );

    console.log("[LootLink] Current channel raids:", raids);

    chrome.storage.local.get(["allRaidScans"], (result) => {
      const existingRaids = result.allRaidScans || [];
      const mergedRaids = dedupeRaids([...existingRaids, ...raids]);
      chrome.storage.local.set({
        lastRaidScan: {
          url: location.href,
          channelId: getChannelIdFromUrl(),
          raids,
          scannedAt: new Date().toISOString()
        },
        allRaidScans: mergedRaids
      });
    });

    if (send) importRaids(raids);
    if (show) showPanel(raids, `${raids.length} raid card(s) found in the visible channel.`);
    return raids;
  }

  function getCurrentGuildIdFromUrl() {
    const match = location.pathname.match(/\/channels\/(\d+)\//);
    return match ? match[1] : null;
  }

  function getCandidateChannelLinks() {
    const currentGuildId = getCurrentGuildIdFromUrl();
    const links = [...document.querySelectorAll('a[href^="/channels/"], a[href*="discord.com/channels/"]')];

    const candidates = links
      .map((a) => {
        const label = cleanText(a.getAttribute("aria-label") || a.innerText || a.textContent || "");
        const href = a.href || a.getAttribute("href") || "";
        const url = safeUrl(href);
        const parts = url ? url.pathname.split("/").filter(Boolean) : [];
        return { el: a, label, href: url?.href || href, guildId: parts[1], channelId: parts[2] };
      })
      .filter((item) => item.label && item.href.includes("/channels/"))
      .filter((item) => item.guildId && item.channelId)
      .filter((item) => !currentGuildId || item.guildId === currentGuildId)
      .filter((item) => RAID_CHANNEL_KEYWORDS.some((kw) => item.label.toLowerCase().includes(kw)))
      .filter((item) => !/voice|rules|welcome|announcement|log|admin|officer/i.test(item.label));

    return uniqueBy(candidates, (item) => item.href);
  }

  function getGuildNav() {
    return (
      document.querySelector('[data-list-id="guildsnav"]') ||
      document.querySelector('nav[aria-label*="Servers"]') ||
      document.querySelector('nav[aria-label*="servers"]')
    );
  }

  function getCandidateServerLabels() {
    const guildNav = getGuildNav();
    if (!guildNav) {
      console.log("SERVER NAV NOT FOUND");
      return [];
    }

    const serverNodes = [...guildNav.querySelectorAll('[data-dnd-name]')];

    const labels = serverNodes
      // .map((node) => cleanText(node.getAttribute("data-dnd-name") || ""))
      .map((node) =>
        cleanText(node.getAttribute("data-dnd-name") || "")
          .replace(/^Above\s+/i, "")
          .replace(/^Combine with\s+/i, "")
      )
      .filter(Boolean)
      .filter((label) => !/direct messages|add a server|discover|download apps/i.test(label))
      .filter((label) => !/^end of list$/i.test(label))
      .filter((label) => !label.includes(","))
      // .filter((label) => !/direct messages|add a server|discover|download apps|end of list/i.test(label))
      .filter((label) => !SKIP_SERVERS.some((serverName) => label.toLowerCase().includes(serverName.toLowerCase())));

    const uniqueLabels = [...new Set(labels)];
    console.log("SERVER LABELS FOUND", uniqueLabels);
    console.log("SERVER LABELS RAW", labels);
    return uniqueLabels;
  }

  function clickServerByLabel(label) {
    const guildNav = getGuildNav();
    if (!guildNav) return false;

    const node = [...guildNav.querySelectorAll('[data-dnd-name]')]
      .find((candidate) => cleanText(candidate.getAttribute("data-dnd-name") || "") === label);

    if (!node) return false;

    const clickable =
      node.querySelector('[role="treeitem"]') ||
      node.closest('[role="treeitem"]') ||
      node.closest('[class*="listItem"]') ||
      node;

    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false
    }));

    return true;
  }

  function clickChannelByHref(href) {
    const links = [...document.querySelectorAll('a[href^="/channels/"], a[href*="discord.com/channels/"]')];
    const targetUrl = safeUrl(href)?.href;
    if (!targetUrl) return false;

    const link = links.find((a) => safeUrl(a.href || a.getAttribute("href") || "")?.href === targetUrl);
    if (!link) return false;

    if (link.tagName === "A") link.setAttribute("target", "_self");

    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    link.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false
    }));

    return true;
  }

  async function scanCurrentServer(guildName) {
    await wait(SERVER_WAIT_MS);
    const channels = getCandidateChannelLinks();
    const allFound = [];

    showPanel([], `Scanning ${channels.length} matching channel(s) in this server...`);
    console.log("[LootLink] Server scan candidates:", channels.map((c) => c.label));

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      showPanel(allFound, `Scanning channel ${i + 1}/${channels.length}: ${channel.label}`);
      console.log("[LootLink] Visiting channel", channel.label, channel.href);

      const clicked = clickChannelByHref(channel.href);
      if (!clicked) {
        console.warn("[LootLink] Could not click channel, skipping:", channel);
        continue;
      }

      await wait(CHANNEL_WAIT_MS);
      // const raids = scanCurrentChannel({ show: false, send: false });
      console.log("guildName =", guildName);
      const raids = scanCurrentChannel({ show: false, send: false })
        .map((raid) => ({
          ...raid,          
          guildName: guildName
            ?.replace(/^Combine with\s+/i, "")
            ?.replace(/^Above\s+/i, ""),
        }));
      allFound.push(...raids);
      await wait(BETWEEN_ACTIONS_MS);
    }

    const uniqueFound = dedupeRaids(allFound);
    await importRaids(uniqueFound);
    return uniqueFound;
  }

  async function scanAllServers() {
    if (scanIsRunning) return;
    scanIsRunning = true;

    const button = document.getElementById(ALL_SERVERS_BUTTON_ID);
    if (button) {
      button.disabled = true;
      button.textContent = "Scanning...";
    }

    const originalUrl = location.href;
    const serverLabels = getCandidateServerLabels();
    const allFound = [];

    showPanel([], `Scanning ${serverLabels.length} server(s)...`);

    for (let i = 0; i < serverLabels.length; i++) {
      const label = serverLabels[i];
      showPanel(allFound, `Scanning server ${i + 1}/${serverLabels.length}: ${label}`);
      console.log("[LootLink] Clicking server", label);

      const clicked = clickServerByLabel(label);
      if (!clicked) {
        console.warn("[LootLink] Could not click server, skipping:", label);
        continue;
      }

      await wait(SERVER_WAIT_MS);
      // const raids = await scanCurrentServer();
      const raids = await scanCurrentServer(label);
      allFound.push(...raids);
      await wait(BETWEEN_ACTIONS_MS);
    }

    const uniqueFound = dedupeRaids(allFound);
    await importRaids(uniqueFound);

    chrome.storage.local.get(["allRaidScans"], (result) => {
      const existingRaids = result.allRaidScans || [];
      const mergedRaids = dedupeRaids([...existingRaids, ...uniqueFound]);
      chrome.storage.local.set({ allRaidScans: mergedRaids });
    });

    showPanel(uniqueFound, `All-server scan complete. ${uniqueFound.length} unique raid(s) found this run.`);
    alert(`LootLink scan complete. ${uniqueFound.length} raid(s) found.`);

    if (originalUrl && location.href !== originalUrl) {
      history.pushState(null, "", originalUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    scanIsRunning = false;

    if (button) {
      button.disabled = false;
      button.textContent = "LootLink Scan All";
    }
  }

  function showPanel(raids, message) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }

    panel.innerHTML = `
      <div class="lootlink-panel-header">
        <strong>LootLink Raid Scan</strong>
        <button id="lootlink-close-panel">×</button>
      </div>
      <div class="lootlink-panel-body">
        <p>${escapeHtml(message || `${raids.length} raid card(s) found.`)}</p>
        <button id="lootlink-copy-json">Copy Master JSON</button>
        <div class="lootlink-raid-list">
          ${raids.map((raid) => `
            <div class="lootlink-raid-item">
              <strong>${escapeHtml(raid.raidName || raid.title)}</strong>
              ${raid.startTime ? `<span>${new Date(raid.startTime).toLocaleString()}</span>` : ""}
              ${raid.raidLeader ? `<span>Leader: ${escapeHtml(raid.raidLeader)}</span>` : ""}
              <span>${raid.signupCount ?? "?"}/${raid.signupMax ?? "?"} signups</span>
              ${raid.softresId ? `<span>SoftRes: ${escapeHtml(raid.softresId)}</span>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    `;

    document.getElementById("lootlink-close-panel").onclick = () => panel.remove();
    document.getElementById("lootlink-copy-json").onclick = async () => {
      chrome.storage.local.get(["allRaidScans"], async (result) => {
        await navigator.clipboard.writeText(JSON.stringify(result.allRaidScans || raids, null, 2));
        document.getElementById("lootlink-copy-json").textContent = "Copied";
      });
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function addButton() {
    if (!document.getElementById(ALL_SERVERS_BUTTON_ID)) {
      const button = document.createElement("button");
      button.id = ALL_SERVERS_BUTTON_ID;
      button.textContent = "LootLink Scan All";
      button.title = "Scan all visible Discord servers for raid channels";
      button.addEventListener("click", scanAllServers);
      document.body.appendChild(button);
    }
  }

  addButton();

  // let lastAutoScanUrl = "";
  // const observer = new MutationObserver(() => {
  //   addButton();
  //   if (scanIsRunning) return;
  //   if (location.href !== lastAutoScanUrl) {
  //     lastAutoScanUrl = location.href;
  //     // setTimeout(() => scanCurrentChannel({ show: false, send: true }), 900);
  //     setTimeout(() => scanCurrentChannel({ show: false, send: false }), 900);
  //   }
  // });

  // observer.observe(document.body, { childList: true, subtree: true });
  console.log("[LootLink] Discord raid sync extension loaded.");
})();
