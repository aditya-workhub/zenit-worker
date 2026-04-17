import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";
const NSE_API = "https://nse-api-ruby.vercel.app";

const INDICES = ["NIFTY 50", "NIFTY BANK", "NIFTY IT", "NIFTY AUTO", "SENSEX", "NIFTY PHARMA"];
const WATCHED_SYMBOLS = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", 
  "BHARTIARTL", "KOTAKBANK", "ADANIENT", "TATAMOTORS", "HINDUNILVR", 
  "ITC", "LT", "SUNPHARMA", "MARUTI"
];

if (!REDIS_URL) {
  console.error("❌ REDIS_URL not set. Exiting.");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null;
    return Math.min(times * 500, 5000);
  },
  reconnectOnError() {
    return true;
  }
});

interface IndexData {
  symbol: string;
  name: string;
  value: number;
  change: number;
  percentChange: number;
  timestamp: number;
}

interface TickerData {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  percentChange: number;
  timestamp: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cacheTicker(data: TickerData): Promise<void> {
  try {
    const key = `ticker:${data.symbol}`;
    await redis.setex(key, 10, JSON.stringify(data));
    await redis.publish("ticker:updates", JSON.stringify(data));
  } catch (e) {
    console.error("Cache ticker error:", e);
  }
}

async function cacheIndex(data: IndexData): Promise<void> {
  try {
    const key = `index:${data.symbol.replace(/ /g, "%20")}`;
    await redis.setex(key, 10, JSON.stringify(data));
    await redis.publish("index:updates", JSON.stringify(data));
  } catch (e) {
    console.error("Cache index error:", e);
  }
}

async function fetchNSEIndices(): Promise<void> {
  try {
    const response = await fetch(`${NSE_API}/index/list`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error("NSE index API failed");

    const data = await response.json();
    const indices = data.data || [];

    for (const idx of indices) {
      if (!idx.symbol) continue;
      
      const indexData: IndexData = {
        symbol: idx.symbol.replace("NIFTY", "NIFTY%20").replace(" ", "%20"),
        name: idx.name || idx.symbol,
        value: parseFloat(idx.lastPrice || idx.value || 0),
        change: parseFloat(idx.change || 0),
        percentChange: parseFloat(idx.pChange || 0),
        timestamp: Date.now(),
      };
      await cacheIndex(indexData);
    }
    console.log(`✅ Fetched ${indices.length} indices`);
  } catch (error) {
    console.error("❌ Failed to fetch indices:", error);
  }
}

async function fetchStockQuote(symbol: string): Promise<TickerData | null> {
  try {
    const response = await fetch(
      `${NSE_API}/quote?symbol=${symbol}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
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
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

async function fetchAllStocks(): Promise<void> {
  const batchSize = 5;
  
  for (let i = 0; i < WATCHED_SYMBOLS.length; i += batchSize) {
    const batch = WATCHED_SYMBOLS.slice(i, i + batchSize);
    const promises = batch.map(s => fetchStockQuote(s));
    const results = await Promise.all(promises);

    for (const data of results) {
      if (data) await cacheTicker(data);
    }
    
    console.log(`📊 Fetched batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(WATCHED_SYMBOLS.length/batchSize)}`);
  }
}

function isMarketOpen(): boolean {
  const now = new Date();
  const istHours = now.getUTCHours() + 5;
  const istMinutes = now.getUTCMinutes() + 30;
  const hour = istMinutes >= 60 ? istHours + 1 : istHours;
  const minute = istMinutes >= 60 ? istMinutes - 60 : istMinutes;
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= 555 && totalMinutes <= 930;
}

async function main(): Promise<void> {
  console.log("🚀 Zenit Worker starting...");
  console.log(`📡 Using NSE API: ${NSE_API}`);

  redis.on("error", (err) => {
    console.error("❌ Redis error:", err.message);
  });

  redis.on("connect", () => {
    console.log("✅ Redis connected");
  });

  try {
    await redis.ping();
    console.log("✅ Redis ping OK");
  } catch (error) {
    console.error("❌ Redis connection failed:", error);
    process.exit(1);
  }

  while (true) {
    const marketOpen = isMarketOpen();
    console.log(`🕐 Market ${marketOpen ? "OPEN" : "CLOSED"}`);

    await fetchNSEIndices();
    await fetchAllStocks();

    const interval = marketOpen ? 15000 : 60000;
    console.log(`💤 Next update in ${interval / 1000}s...`);
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});