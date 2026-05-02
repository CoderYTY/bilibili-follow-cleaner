import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireFromHere = createRequire(import.meta.url);

function loadChromium() {
  try {
    return requireFromHere("playwright").chromium;
  } catch {
    // Continue to NODE_PATH fallbacks below.
  }

  const roots = [
    process.env.PLAYWRIGHT_NODE_MODULES,
    process.env.NODE_PATH,
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(path.delimiter))
    .filter(Boolean);

  for (const root of roots) {
    try {
      const packageJson = path.join(root, "playwright", "package.json");
      return createRequire(packageJson)("playwright").chromium;
    } catch {
      // Try the next search root.
    }
  }

  throw new Error(
    "Cannot find the Playwright package. Install it locally or set NODE_PATH/PLAYWRIGHT_NODE_MODULES to a node_modules directory that contains playwright.",
  );
}

const chromium = loadChromium();

const PORT = Number(process.env.BILI_CDP_PORT || 9227);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.resolve(process.env.BILI_DATA_DIR || process.cwd());
const OUT_SCAN = path.join(DATA_DIR, "bilibili-following-scan.json");
const OUT_UNFOLLOW = path.join(DATA_DIR, "bilibili-unfollow-result.json");
const OUT_RETRY = path.join(DATA_DIR, "bilibili-unfollow-retry-result.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDate(sec) {
  if (!sec) return "";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function normalizeMid(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : null;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function connect() {
  const browser = await chromium.connectOverCDP(BASE);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context found. Start Chrome/Edge with remote debugging and log in to Bilibili first.");
  }

  let page = context.pages().find((p) => p.url().includes("bilibili.com"));
  if (!page) page = context.pages()[0] || await context.newPage();
  if (!page.url().includes("bilibili.com")) {
    await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  return { browser, context, page };
}

async function apiJson(context, url, options = {}) {
  let response;
  try {
    response = await context.request.fetch(url, {
      ...options,
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://www.bilibili.com/",
        ...(options.headers || {}),
      },
      timeout: options.timeout || 30000,
    });
  } catch (error) {
    const message = String(error?.message || error).split("\n")[0];
    throw new Error(`Request failed for ${url}: ${message}`);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 160)}`);
  }
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} from ${url}: ${text.slice(0, 160)}`);
  }
  return data;
}

async function nav(context) {
  const data = await apiJson(context, "https://api.bilibili.com/x/web-interface/nav");
  if (data.code !== 0) throw new Error(`Bilibili nav API failed: ${data.message || data.code}`);
  return data.data;
}

async function requireLogin(context) {
  const current = await nav(context);
  if (!current?.isLogin || !current?.mid) {
    throw new Error("Not logged in. Ask the user to finish login in the controlled browser window, then run again.");
  }
  return current;
}

async function fetchFollowings(context, mid) {
  const all = [];
  const ps = 50;
  for (let pn = 1; ; pn += 1) {
    const url = new URL("https://api.bilibili.com/x/relation/followings");
    url.searchParams.set("vmid", mid);
    url.searchParams.set("pn", String(pn));
    url.searchParams.set("ps", String(ps));
    url.searchParams.set("order", "desc");
    url.searchParams.set("order_type", "attention");

    const data = await apiJson(context, url.toString());
    if (data.code !== 0) throw new Error(`Followings API failed on page ${pn}: ${data.message || data.code}`);
    const list = data.data?.list || [];
    for (const item of list) {
      const id = normalizeMid(item.mid);
      if (!id) continue;
      all.push({
        mid: id,
        uname: item.uname || "",
        sign: item.sign || "",
        mtime: item.mtime || null,
        official: item.official_verify?.desc || "",
      });
    }

    const total = Number(data.data?.total || 0);
    if (list.length < ps || all.length >= total) break;
    await sleep(250);
  }
  return all;
}

function historyOwner(item) {
  const business = item.history?.business || item.business || "";
  const mid = normalizeMid(item.author_mid || item.owner?.mid || item.up_mid);
  if (!mid) return null;
  return {
    mid,
    name: item.author_name || item.owner?.name || item.name || "",
    title: item.title || item.long_title || "",
    viewAt: Number(item.view_at || 0),
    business,
  };
}

async function fetchRecentHistory(context, cutoffSec) {
  const latestByMid = new Map();
  let max = 0;
  let viewAt = 0;
  let scanned = 0;

  for (let pageNo = 1; pageNo <= 600; pageNo += 1) {
    const url = new URL("https://api.bilibili.com/x/web-interface/history/cursor");
    url.searchParams.set("max", String(max));
    url.searchParams.set("view_at", String(viewAt));
    url.searchParams.set("business", "");
    url.searchParams.set("ps", "30");

    const data = await apiJson(context, url.toString());
    if (data.code !== 0) throw new Error(`History API failed on page ${pageNo}: ${data.message || data.code}`);
    const list = data.data?.list || [];
    if (list.length === 0) break;

    let oldest = Number.MAX_SAFE_INTEGER;
    for (const item of list) {
      const owner = historyOwner(item);
      if (!owner || owner.business !== "archive") continue;
      scanned += 1;
      oldest = Math.min(oldest, owner.viewAt || oldest);
      if (owner.viewAt >= cutoffSec) {
        const prev = latestByMid.get(owner.mid);
        if (!prev || owner.viewAt > prev.viewAt) latestByMid.set(owner.mid, owner);
      }
    }

    const cursor = data.data?.cursor || {};
    max = cursor.max || 0;
    viewAt = cursor.view_at || 0;
    if (!max && !viewAt) break;
    if (oldest !== Number.MAX_SAFE_INTEGER && oldest < cutoffSec) break;
    await sleep(250);
  }

  return { latestByMid, scanned };
}

async function scan(cutoffDays) {
  await ensureDataDir();
  const { browser, context } = await connect();
  try {
    const account = await requireLogin(context);
    const cutoffSec = Math.floor(Date.now() / 1000) - cutoffDays * 24 * 60 * 60;
    const followings = await fetchFollowings(context, String(account.mid));
    const { latestByMid, scanned } = await fetchRecentHistory(context, cutoffSec);
    const candidates = followings
      .filter((item) => !latestByMid.has(item.mid))
      .map((item) => ({
        ...item,
        reason: `${cutoffDays} days without watched archive videos in available history`,
      }));
    const kept = followings
      .filter((item) => latestByMid.has(item.mid))
      .map((item) => {
        const hit = latestByMid.get(item.mid);
        return {
          ...item,
          lastWatchedAt: hit.viewAt,
          lastWatchedDate: formatDate(hit.viewAt),
          lastWatchedTitle: hit.title,
        };
      });

    const result = {
      scannedAt: new Date().toISOString(),
      cutoffDays,
      cutoffDate: formatDate(cutoffSec),
      account: { mid: String(account.mid), uname: account.uname || "" },
      totals: {
        followings: followings.length,
        recentHistoryVideosScanned: scanned,
        candidates: candidates.length,
        kept: kept.length,
      },
      candidates,
      kept,
    };
    await fs.writeFile(OUT_SCAN, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ outFile: OUT_SCAN, account: result.account, cutoffDays, cutoffDate: result.cutoffDate, totals: result.totals }, null, 2));
  } finally {
    await browser.close();
  }
}

async function unfollowItems(items, outFile, options = {}) {
  const batchSize = Number(options.batchSize || 50);
  const pauseMs = Number(options.pauseMs || 60000);
  const stopAfterConsecutive352 = Number(options.stopAfterConsecutive352 || 5);
  const previousResults = options.previousResults || [];
  if (items.length === 0) throw new Error("No items to unfollow.");

  await ensureDataDir();
  const { browser, context } = await connect();
  const results = [];
  let consecutive352 = 0;
  let stopped = false;

  try {
    await requireLogin(context);
    const cookies = await context.cookies("https://www.bilibili.com/");
    const csrf = cookies.find((cookie) => cookie.name === "bili_jct")?.value;
    if (!csrf) throw new Error("Cannot find bili_jct CSRF cookie. Make sure the user is logged in.");

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let response;
      try {
        response = await apiJson(context, "https://api.bilibili.com/x/relation/modify", {
          method: "POST",
          headers: {
            origin: "https://www.bilibili.com",
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          },
          data: new URLSearchParams({
            fid: String(item.mid),
            act: "2",
            re_src: "11",
            csrf,
          }).toString(),
        });
      } catch (error) {
        const message = String(error?.message || error);
        results.push({ mid: item.mid, uname: item.uname, ok: false, code: "REQUEST_ERROR", message });
        console.log(`FAIL\t${index + 1}/${items.length}\t${item.uname}\t${item.mid}\t${message}`);
        stopped = true;
        break;
      }

      const ok = response.code === 0;
      const row = { mid: item.mid, uname: item.uname, ok, code: response.code, message: response.message || "" };
      results.push(row);
      console.log(`${ok ? "OK" : "FAIL"}\t${index + 1}/${items.length}\t${item.uname}\t${item.mid}\t${response.message || ""}`);

      consecutive352 = response.code === -352 ? consecutive352 + 1 : 0;
      if (consecutive352 >= stopAfterConsecutive352) {
        stopped = true;
        console.log(`STOP\tConsecutive -352 responses reached ${consecutive352}.`);
        break;
      }

      const finishedBatch = (index + 1) % batchSize === 0 && index + 1 < items.length;
      await sleep(finishedBatch ? pauseMs : 700);
    }
  } finally {
    await browser.close();
  }

  const out = {
    unfollowedAt: new Date().toISOString(),
    batchSize,
    pauseMs,
    stopped,
    latestRun: results,
    results: [...previousResults, ...results],
  };
  await fs.writeFile(outFile, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outFile, total: results.length, ok: results.filter((r) => r.ok).length, stopped }, null, 2));
}

async function unfollowFromScan() {
  const raw = await fs.readFile(OUT_SCAN, "utf8");
  const scanResult = JSON.parse(raw);
  await unfollowItems(scanResult.candidates || [], OUT_UNFOLLOW);
}

async function retryFailed(batchSize, pauseMs, skippedMidsArg) {
  const raw = await fs.readFile(OUT_UNFOLLOW, "utf8");
  const unfollowResult = JSON.parse(raw);
  const skippedMids = new Set(String(skippedMidsArg || "").split(",").map((item) => item.trim()).filter(Boolean));
  const retriedOkMids = new Set();
  let previousResults = [];

  try {
    const retryRaw = await fs.readFile(OUT_RETRY, "utf8");
    const retryResult = JSON.parse(retryRaw);
    previousResults = retryResult.results || [];
    for (const item of previousResults) {
      if (item.ok) retriedOkMids.add(String(item.mid));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const failed = (unfollowResult.results || []).filter((item) => !item.ok && !skippedMids.has(String(item.mid)) && !retriedOkMids.has(String(item.mid)));
  await unfollowItems(failed, OUT_RETRY, { batchSize, pauseMs, previousResults });
}

async function report() {
  await ensureDataDir();
  const raw = await fs.readFile(OUT_SCAN, "utf8");
  const scanResult = JSON.parse(raw);
  const candidates = scanResult.candidates || [];
  const mdPath = path.join(DATA_DIR, "bilibili-following-candidates.md");
  const csvPath = path.join(DATA_DIR, "bilibili-following-candidates.csv");

  const escapeTable = (value) => String(value || "").replace(/\|/g, "\\|");
  const rows = [
    "# Bilibili following cleanup candidates",
    "",
    `Rule: no watched archive videos from these accounts in available history since ${scanResult.cutoffDate} (${scanResult.cutoffDays} days).`,
    "",
    "| Index | Name | UID | Followed at |",
    "|---:|---|---:|---|",
    ...candidates.map((item, index) => `| ${index + 1} | ${escapeTable(item.uname)} | ${item.mid} | ${item.mtime ? formatDate(item.mtime) : ""} |`),
  ];
  await fs.writeFile(mdPath, `${rows.join("\n")}\n`, "utf8");

  const csvQuote = (value) => `"${String(value || "").replace(/"/g, '""')}"`;
  const csvRows = [
    "index,uname,mid,followed_at",
    ...candidates.map((item, index) => [index + 1, item.uname, item.mid, item.mtime ? formatDate(item.mtime) : ""].map(csvQuote).join(",")),
  ];
  await fs.writeFile(csvPath, `${csvRows.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ mdPath, csvPath, count: candidates.length }, null, 2));
}

async function remainingReport(skippedMidsArg) {
  await ensureDataDir();
  const raw = await fs.readFile(OUT_UNFOLLOW, "utf8");
  const unfollowResult = JSON.parse(raw);
  const skippedMids = new Set(String(skippedMidsArg || "").split(",").map((item) => item.trim()).filter(Boolean));
  const retriedOkMids = new Set();
  try {
    const retryRaw = await fs.readFile(OUT_RETRY, "utf8");
    const retryResult = JSON.parse(retryRaw);
    for (const item of retryResult.results || []) {
      if (item.ok) retriedOkMids.add(String(item.mid));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const remaining = (unfollowResult.results || []).filter((item) => !item.ok && !skippedMids.has(String(item.mid)) && !retriedOkMids.has(String(item.mid)));
  const mdPath = path.join(DATA_DIR, "bilibili-unfollow-remaining.md");
  const csvPath = path.join(DATA_DIR, "bilibili-unfollow-remaining.csv");
  const escapeTable = (value) => String(value || "").replace(/\|/g, "\\|");
  const rows = [
    "# Bilibili remaining unfollow targets",
    "",
    "| Index | Name | UID | Last code | Last message |",
    "|---:|---|---:|---:|---|",
    ...remaining.map((item, index) => `| ${index + 1} | ${escapeTable(item.uname)} | ${item.mid} | ${item.code} | ${escapeTable(item.message)} |`),
  ];
  await fs.writeFile(mdPath, `${rows.join("\n")}\n`, "utf8");

  const csvQuote = (value) => `"${String(value || "").replace(/"/g, '""')}"`;
  const csvRows = [
    "index,uname,mid,last_code,last_message",
    ...remaining.map((item, index) => [index + 1, item.uname, item.mid, item.code, item.message].map(csvQuote).join(",")),
  ];
  await fs.writeFile(csvPath, `${csvRows.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ mdPath, csvPath, count: remaining.length }, null, 2));
}

function usage() {
  return `Usage:
  node scripts/bilibili_follow_cleaner.mjs scan [days]
  node scripts/bilibili_follow_cleaner.mjs report
  node scripts/bilibili_follow_cleaner.mjs unfollow
  node scripts/bilibili_follow_cleaner.mjs retry-failed [batchSize] [pauseMs] [skipMidsCsv]
  node scripts/bilibili_follow_cleaner.mjs remaining-report [skipMidsCsv]

Environment:
  BILI_CDP_PORT=9227
  BILI_DATA_DIR=<directory for generated scan/report/result files>
  NODE_PATH or PLAYWRIGHT_NODE_MODULES=<node_modules containing playwright>
`;
}

const command = process.argv[2] || "help";
if (command === "scan") {
  await scan(Number(process.argv[3] || 180));
} else if (command === "report") {
  await report();
} else if (command === "unfollow") {
  await unfollowFromScan();
} else if (command === "retry-failed") {
  await retryFailed(Number(process.argv[3] || 50), Number(process.argv[4] || 60000), process.argv[5] || "");
} else if (command === "remaining-report") {
  await remainingReport(process.argv[3] || "");
} else {
  console.log(usage());
}
