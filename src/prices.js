async function getCurrentTokenPrice() {
  const chainId = process.env.DEX_CHAIN_ID || 'ton';
  const pairAddress = process.env.DEX_PAIR_ADDRESS;

  if (!pairAddress) {
    throw new Error('Missing DEX_PAIR_ADDRESS');
  }

  const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener HTTP ${res.status}`);
  }

  const data = await res.json();
  const pair = data.pair || (Array.isArray(data.pairs) && data.pairs[0]);
  const priceUsd = pair && Number(pair.priceUsd);

  if (!priceUsd || Number.isNaN(priceUsd)) {
    throw new Error('Invalid priceUsd returned from DexScreener');
  }

  return priceUsd;
}

module.exports = { getCurrentTokenPrice };
