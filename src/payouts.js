const { mnemonicToPrivateKey } = require('@ton/crypto');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');

const DEFAULT_TREASURY_WALLET = 'UQAC-pXNqjUJ0u1wBkLPiDkLVMZkWYXWvNQuH5Mtx_tPdsGV';

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
 * Automatically routes 15% of total collected entries to the KOTÉ Treasury wallet
 * and splits the 85% prize pool across 1st (50%), 2nd (20%), and 3rd (15%) place.
 */
async function executeRoundPayouts({ roundId, prizePool85, treasury15, placements }) {
  const treasuryWallet = (process.env.TREASURY_WALLET_ADDRESS || DEFAULT_TREASURY_WALLET).trim();
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

  // 2. Split 85% prize pool: 50% to 1st, 20% to 2nd, 15% to 3rd
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
