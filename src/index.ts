const NSE_API = process.env.NSE_API || "https://nse-api-ruby.vercel.app";

const INDICES = ["NIFTY 50", "NIFTY BANK", "NIFTY IT", "NIFTY AUTO", "SENSEX", "NIFTY PHARMA"];
const WATCHED_SYMBOLS = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", 
  "BHARTIARTL", "KOTAKBANK", "ADANIENT", "TATAMOTORS", "HINDUNILVR", 
  "ITC", "LT", "SUNPHARMA", "MARUTI"
];

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

async function fetchNSEIndices(): Promise<void> {
  const fallbackURL = "https://nse-api-ruby.vercel.app";
  const apis = [NSE_API, fallbackURL];
  
  const indexSymbols = ["NIFTY%2050", "NIFTY%20BANK", "NIFTY%20IT", "NIFTY%20AUTO", "SENSEX", "NIFTY%20PHARMA"];
  
  for (const api of apis) {
    try {
      const symbolList = indexSymbols.join(",");
      const response = await fetch(`${api}/stock/list?symbols=${symbolList}&res=num`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const stocks = data.stocks || [];

      for (const idx of stocks) {
        if (!idx.symbol) continue;
        
        console.log(`📈 ${idx.symbol}: ${idx.last_price} (${idx.percent_change}%)`);
      }
      console.log(`✅ Fetched ${stocks.length} indices from ${api}`);
      return;
    } catch (error) {
      console.warn(`⚠️ Failed to fetch indices from ${api}:`, error);
    }
  }
  
  console.warn("⚠️ All NSE APIs failed for indices");
}

async function fetchStockQuote(symbol: string): Promise<TickerData | null> {
  const fallbackURL = "https://nse-api-ruby.vercel.app";
  const apis = [NSE_API, fallbackURL];
  
  for (const api of apis) {
    try {
      const response = await fetch(
        `${api}/stock?symbol=${symbol}&res=num`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) }
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
      if (data) {
        console.log(`📊 ${data.symbol}: ₹${data.ltp} (${data.percentChange > 0 ? '+' : ''}${data.percentChange}%)`);
      }
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