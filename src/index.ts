import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";
const NSE_API = process.env.NSE_API || "https://nse-api-ruby.vercel.app";

const INDICES = ["NIFTY 50", "NIFTY BANK", "NIFTY IT", "NIFTY AUTO", "SENSEX", "NIFTY PHARMA"];
const WATCHED_SYMBOLS = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", 
  "BHARTIARTL", "KOTAKBANK", "ADANIENT", "TATAMOTORS", "HINDUNILVR", 
  "ITC", "LT", "SUNPHARMA", "MARUTI"
];

let redis: Redis | null = null;
let redisAvailable = false;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
    reconnectOnError() {
      return true;
    },
    lazyConnect: true,
  });
}

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
  if (!redis || !redisAvailable) return;
  try {
    const key = `ticker:${data.symbol}`;
    await redis.setex(key, 10, JSON.stringify(data));
    await redis.publish("ticker:updates", JSON.stringify(data));
  } catch (e) {
    console.warn("Cache ticker error:", e);
  }
}

async function cacheIndex(data: IndexData): Promise<void> {
  if (!redis || !redisAvailable) return;
  try {
    const key = `index:${data.symbol.replace(/ /g, "%20")}`;
    await redis.setex(key, 10, JSON.stringify(data));
    await redis.publish("index:updates", JSON.stringify(data));
  } catch (e) {
    console.warn("Cache index error:", e);
  }
}

async function fetchNSEIndices(): Promise<void> {
  const fallbackURL = "https://nse-api-ruby.vercel.app";
  const apis = [NSE_API, fallbackURL];
  
  const indexSymbols = ["NIFTY%2050", "NIFTY%20BANK", "NIFTY%20IT", "NIFTY%20AUTO", "SENSEX", "NIFTY%20PHARMA"];
  
  for (const api of apis) {
    try {
      const symbolList = indexSymbols.join(",");
      const response = await fetch(`${api}/stock/list?symbols=${symbolList}&res=num`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const stocks = data.stocks || [];

      for (const idx of stocks) {
        if (!idx.symbol) continue;
        
        const indexData: IndexData = {
          symbol: idx.symbol.replace(" ", "%20"),
          name: idx.symbol,
          value: parseFloat(idx.last_price || 0),
          change: parseFloat(idx.change || 0),
          percentChange: parseFloat(idx.percent_change || 0),
          timestamp: Date.now(),
        };
        await cacheIndex(indexData);
      }
      console.log(`✅ Fetched ${stocks.length} indices from ${api}`);
      return;
    } catch (error) {
      console.warn(`⚠️ Failed to fetch indices from ${api}:`, error);
    }
  }
  
  console.warn("⚠️ All NSE APIs failed for indices, using fallback");
}

async function fetchStockQuote(symbol: string): Promise<TickerData | null> {
  const fallbackURL = "https://nse-api-ruby.vercel.app";
  const apis = [NSE_API, fallbackURL];
  
  for (const api of apis) {
    try {
      const response = await fetch(
        `${api}/stock?symbol=${symbol}&res=num`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
      );

      if (!response.ok) continue;

      const data = await response.json();
      const q = data.stocks?.[0] || data;

      if (!q || !q.symbol) continue;

      return {
        symbol: q.symbol,
        ltp: parseFloat(q.last_price || 0),
        open: parseFloat(q.open || q.previous_close || 0),
        high: parseFloat(q.day_high || q.high || 0),
        low: parseFloat(q.day_low || q.low || 0),
        close: parseFloat(q.previous_close || q.close || 0),
        volume: parseInt(q.volume || 0),
        change: parseFloat(q.change || 0),
        percentChange: parseFloat(q.percent_change || 0),
        timestamp: Date.now(),
      };
    } catch {
      continue;
    }
  }
  
  return null;
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

  if (redis) {
    redis.on("error", (err) => {
      console.warn("⚠️ Redis error:", err.message);
      redisAvailable = false;
    });

    redis.on("connect", () => {
      console.log("✅ Redis connected");
      redisAvailable = true;
    });

    try {
      await redis.connect();
      await redis.ping();
      redisAvailable = true;
      console.log("✅ Redis ping OK");
    } catch (error) {
      console.warn("⚠️ Redis not available, running without cache");
      redisAvailable = false;
    }
  } else {
    console.warn("⚠️ REDIS_URL not set, running without cache");
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