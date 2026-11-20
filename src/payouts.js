const { mnemonicToPrivateKey } = require('@ton/crypto');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');

function getTonClient() {
  const apiKey = process.env.TONCENTER_API_KEY || '';
  return new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: apiKey || undefined
  });
}

async function sendTonTransfer({ toAddress, amountTon, comment }) {
  const mnemonicRaw = (process.env.ESCROW_MNEMONIC || '').trim();
  if (!mnemonicRaw) {
    throw new Error('ESCROW_MNEMONIC is not configured');
  }
  if (!toAddress || amountTon <= 0) {
    return { skipped: true };
  }

  const mnemonic = mnemonicRaw.split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0
  });

  const client = getTonClient();
  const contract = client.open(wallet);
  const seqno = await contract.getSeqno();

  // Leave a small safety buffer for network gas if balance is tight
  const safeAmount = Math.max(0, Number(amountTon.toFixed(6)));
  if (safeAmount <= 0) {
    return { skipped: true };
  }

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: toAddress,
        value: safeAmount.toFixed(6),
        body: comment || 'KOTE Last Candle Payout',
        bounce: false
      })
    ]
  });

  return { sent: true, toAddress, amountTon: safeAmount };
}

/**
 * Total pot is the 85% prize pool collected from entries (or gross collected if raw pot passed).
 * Here, `prizePool85` = 85% of total collected entries, and `treasury15` = 15% of total collected entries.
 * Within `prizePool85`: 1st gets 50%, 2nd gets 20%, 3rd gets 15% of `prizePool85`.
 */
async function executeRoundPayouts({ roundId, prizePool85, treasury15, placements }) {
  const treasuryWallet = (process.env.TREASURY_WALLET_ADDRESS || '').trim();
  const results = [];

  // 1. Send 15% Treasury cut automatically
  if (treasuryWallet && treasury15 > 0) {
    const tRes = await sendTonTransfer({
      toAddress: treasuryWallet,
      amountTon: treasury15,
      comment: `KOTE Round #${roundId} Treasury (15%)`
    });
    results.push({ role: 'TREASURY_15', ...tRes });
  }

  // 2. Send 1st (50% of 85% pool), 2nd (20% of 85% pool), 3rd (15% of 85% pool)
  const shares = [
    { place: 1, pctOfPool: 0.50 },
    { place: 2, pctOfPool: 0.20 },
    { place: 3, pctOfPool: 0.15 }
  ];

  for (const s of shares) {
    const player = placements.find((p) => p.placement === s.place);
    if (!player || !player.wallet_address) continue;

    const amountTon = Number((prizePool85 * s.pctOfPool).toFixed(6));
    if (amountTon <= 0) continue;

    const pRes = await sendTonTransfer({
      toAddress: player.wallet_address,
      amountTon,
      comment: `KOTE Round #${roundId} #${s.place} Place`
    });
    results.push({
      role: `PLACE_${s.place}`,
      tgUserId: player.tg_user_id,
      amountTon,
      ...pRes
    });
  }

  return results;
}

module.exports = {
  sendTonTransfer,
  executeRoundPayouts
};
