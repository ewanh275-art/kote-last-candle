const DEFAULT_KOTE_TOKEN = 'EQAmvp1Vrr0zY2--STdH-0X_mP5iCD61p2vNVJYwHlgBni2C';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

async function getCurrentTokenPrice() {
  const chainId = (process.env.DEX_CHAIN_ID || 'ton').trim();
  const tokenOrPair = (
    process.env.KOTE_TOKEN_ADDRESS ||
    process.env.DEX_PAIR_ADDRESS ||
    DEFAULT_KOTE_TOKEN
  ).trim();

  // 1. Try DexScreener token endpoint first (works directly with KOTÉ token address)
  try {
    const tokenData = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenOrPair)}`
    );
    const pairs = Array.isArray(tokenData.pairs) ? tokenData.pairs : [];
    const matchingPairs = pairs.filter(
      (p) => (!chainId || p.chainId === chainId) && p.priceUsd && !Number.isNaN(Number(p.priceUsd))
    );

    if (matchingPairs.length > 0) {
      // Pick the pool with the highest USD liquidity so candles reflect the main market
      matchingPairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      return Number(matchingPairs[0].priceUsd);
    }
  } catch (err) {
    console.warn('DexScreener token lookup fallback:', err.message);
  }

  // 2. Fallback to DexScreener pair endpoint (if a specific pair address was entered)
  const pairData = await fetchJson(
    `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenOrPair)}`
  );
  const pair = pairData.pair || (Array.isArray(pairData.pairs) && pairData.pairs[0]);
  const priceUsd = pair && Number(pair.priceUsd);

  if (!priceUsd || Number.isNaN(priceUsd)) {
    throw new Error(`Could not resolve live priceUsd for ${tokenOrPair}`);
  }

  return priceUsd;
}

module.exports = { getCurrentTokenPrice };
