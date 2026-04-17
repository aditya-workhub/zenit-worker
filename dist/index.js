// src/index.ts
import Redis from "ioredis";
var REDIS_URL = process.env.REDIS_URL || "";
var NSE_API = "https://nse-api-ruby.vercel.app";
var WATCHED_SYMBOLS = [
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "BHARTIARTL",
  "KOTAKBANK",
  "ADANIENT",
  "TATAMOTORS",
  "HINDUNILVR",
  "ITC",
  "LT",
  "SUNPHARMA",
  "MARUTI"
];
if (!REDIS_URL) {
  console.error("\u274C REDIS_URL not set. Exiting.");
  process.exit(1);
}
var redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null;
    return Math.min(times * 500, 5e3);
  },
  reconnectOnError() {
    return true;
  }
});
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function cacheTicker(data) {
  try {
    const key = `ticker:${data.symbol}`;
    await redis.setex(key, 10, JSON.stringify(data));
    await redis.publish("ticker:updates", JSON.stringify(data));
  } catch (e) {
    console.error("Cache ticker error:", e);
  }
}
async function cacheIndex(data) {
  try {
    const key = `index:${data.symbol.replace(/ /g, "%20")}`;
    await redis.setex(key, 10, JSON.stringify(data));
    await redis.publish("index:updates", JSON.stringify(data));
  } catch (e) {
    console.error("Cache index error:", e);
  }
}
async function fetchNSEIndices() {
  try {
    const response = await fetch(`${NSE_API}/index/list`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) throw new Error("NSE index API failed");
    const data = await response.json();
    const indices = data.data || [];
    for (const idx of indices) {
      if (!idx.symbol) continue;
      const indexData = {
        symbol: idx.symbol.replace("NIFTY", "NIFTY%20").replace(" ", "%20"),
        name: idx.name || idx.symbol,
        value: parseFloat(idx.lastPrice || idx.value || 0),
        change: parseFloat(idx.change || 0),
        percentChange: parseFloat(idx.pChange || 0),
        timestamp: Date.now()
      };
      await cacheIndex(indexData);
    }
    console.log(`\u2705 Fetched ${indices.length} indices`);
  } catch (error) {
    console.error("\u274C Failed to fetch indices:", error);
  }
}
async function fetchStockQuote(symbol) {
  try {
    const response = await fetch(
      `${NSE_API}/quote?symbol=${symbol}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5e3) }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const q = data.data || data;
    if (!q || !q.symbol) return null;
    return {
      symbol: q.symbol,
      ltp: parseFloat(q.lastPrice || 0),
      open: parseFloat(q.open || q.previousClose || 0),
      high: parseFloat(q.dayHigh || q.high || 0),
      low: parseFloat(q.dayLow || q.low || 0),
      close: parseFloat(q.previousClose || q.close || 0),
      volume: parseInt(q.totalTradedVolume || q.volume || 0),
      change: parseFloat(q.change || 0),
      percentChange: parseFloat(q.pChange || 0),
      timestamp: Date.now()
    };
  } catch {
    return null;
  }
}
async function fetchAllStocks() {
  const batchSize = 5;
  for (let i = 0; i < WATCHED_SYMBOLS.length; i += batchSize) {
    const batch = WATCHED_SYMBOLS.slice(i, i + batchSize);
    const promises = batch.map((s) => fetchStockQuote(s));
    const results = await Promise.all(promises);
    for (const data of results) {
      if (data) await cacheTicker(data);
    }
    console.log(`\u{1F4CA} Fetched batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(WATCHED_SYMBOLS.length / batchSize)}`);
  }
}
function isMarketOpen() {
  const now = /* @__PURE__ */ new Date();
  const istHours = now.getUTCHours() + 5;
  const istMinutes = now.getUTCMinutes() + 30;
  const hour = istMinutes >= 60 ? istHours + 1 : istHours;
  const minute = istMinutes >= 60 ? istMinutes - 60 : istMinutes;
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= 555 && totalMinutes <= 930;
}
async function main() {
  console.log("\u{1F680} Zenit Worker starting...");
  console.log(`\u{1F4E1} Using NSE API: ${NSE_API}`);
  redis.on("error", (err) => {
    console.error("\u274C Redis error:", err.message);
  });
  redis.on("connect", () => {
    console.log("\u2705 Redis connected");
  });
  try {
    await redis.ping();
    console.log("\u2705 Redis ping OK");
  } catch (error) {
    console.error("\u274C Redis connection failed:", error);
    process.exit(1);
  }
  while (true) {
    const marketOpen = isMarketOpen();
    console.log(`\u{1F550} Market ${marketOpen ? "OPEN" : "CLOSED"}`);
    await fetchNSEIndices();
    await fetchAllStocks();
    const interval = marketOpen ? 15e3 : 6e4;
    console.log(`\u{1F4A4} Next update in ${interval / 1e3}s...`);
    await sleep(interval);
  }
}
main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
