require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, initDb } = require('./db');
const {
  tickGameEngine,
  ensureOpenRound,
  sendTelegramMessage,
  MIN_PLAYERS_TO_START
} = require('./gameLoop');

const DEFAULT_TREASURY_WALLET = 'UQAC-pXNqjUJ0u1wBkLPiDkLVMZkWYXWvNQuH5Mtx_tPdsGV';
const DEFAULT_KOTE_TOKEN = 'EQAmvp1Vrr0zY2--STdH-0X_mP5iCD61p2vNVJYwHlgBni2C';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// Anti-Hack / Anti-XSS Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Per-IP Rate Limiter
const rateBuckets = new Map();
app.use('/api/', (req, res, next) => {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > 90) {
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Resolve the $KOTÉ logo regardless of folder or filename
function resolveLogoPath() {
  const rootDir = path.join(__dirname, '..');
  const publicDir = path.join(rootDir, 'public');
  const candidates = [
    path.join(publicDir, 'kote.png .JPG'),
    path.join(rootDir, 'kote.png .JPG'),
    path.join(publicDir, 'kote.png'),
    path.join(rootDir, 'kote.png'),
    path.join(publicDir, 'kote.jpg'),
    path.join(rootDir, 'kote.jpg'),
    path.join(publicDir, 'IMG_8422.jpeg'),
    path.join(rootDir, 'IMG_8422.jpeg')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

app.get('/kote-logo', (req, res) => {
  const logoFile = resolveLogoPath();
  if (!logoFile) {
    return res.status(404).send('Logo file not found in repo');
  }
  res.sendFile(logoFile);
});

// Dynamic TON Connect Manifest
app.get('/tonconnect-manifest.json', (req, res) => {
  const baseUrl = (process.env.WEBAPP_URL || `https://${req.get('host')}`).replace(/\/$/, '');
  res.json({
    url: baseUrl,
    name: '$KOTÉ Last Candle Standing',
    iconUrl: `${baseUrl}/kote-logo`
  });
});

// Verify Telegram Mini App initData HMAC-SHA256 signature
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (computedHash !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && Math.floor(Date.now() / 1000) - authDate > 86400) {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

function extractUser(req) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  const verified = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
  if (verified && verified.id) {
    return {
      id: Number(verified.id),
      username: verified.username || verified.first_name || `Player_${verified.id}`
    };
  }
  return null;
}

// Validate TON address format (EQ..., UQ..., kQ..., 0Q..., or raw 0:hex)
function isValidTonAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  const trimmed = addr.trim();
  return (
    /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(trimmed) ||
    /^0:[a-fA-F0-9]{64}$/.test(trimmed)
  );
}

// Anti-Hack On-Chain Verifier via Toncenter public API
async function verifyIncomingTonPayment({ escrowWallet, expectedTon, memoCode, txHash }) {
  const minNano = BigInt(Math.floor(Number(expectedTon) * 1e9 * 0.99));
  const apiKey = (process.env.TONCENTER_API_KEY || '').trim();
  const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(
    escrowWallet
  )}&limit=25${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Toncenter RPC error (${res.status})`);
  }
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.result)) {
    throw new Error('Unexpected response from TON RPC');
  }

  for (const tx of data.result) {
    const hash = tx.transaction_id?.hash;
    const inMsg = tx.in_msg;
    if (!inMsg || !hash) continue;

    const valueNano = BigInt(inMsg.value || '0');
    const msgText = String(inMsg.message || '');

    const matchesMemo = memoCode && msgText.includes(memoCode);
    const matchesHash = txHash && (hash === txHash || hash.includes(txHash));

    if (valueNano >= minNano && (matchesMemo || matchesHash)) {
      return {
        verified: true,
        onChainHash: hash,
        sender: inMsg.source || null
      };
    }
  }

  return { verified: false };
}

app.get('/api/state', async (req, res) => {
  try {
    const round = await ensureOpenRound();
    const aliveRes = await pool.query(
      `SELECT COUNT(*)::int AS alive_count FROM entries WHERE round_id = $1 AND status = 'ALIVE'`,
      [round.id]
    );
    const recentRes = await pool.query(
      `SELECT id, status, pot_total, winner_username, payout_status, created_at
       FROM rounds WHERE status = 'SETTLED' ORDER BY id DESC LIMIT 5`
    );

    const user = extractUser(req);
    let myEntry = null;
    if (user) {
      const meRes = await pool.query(
        `SELECT * FROM entries WHERE round_id = $1 AND tg_user_id = $2`,
        [round.id, user.id]
      );
      myEntry = meRes.rows[0] || null;
    }

    const now = Date.now();
    const endsMs = new Date(round.step_ends_at).getTime();
    const secondsLeft = Math.max(0, Math.floor((endsMs - now) / 1000));
    const picksLocked = round.status === 'LIVE' && secondsLeft <= 20;
    const escrowWallet = (process.env.ESCROW_WALLET_ADDRESS || '').trim();
    const treasuryWallet = (process.env.TREASURY_WALLET_ADDRESS || DEFAULT_TREASURY_WALLET).trim();
    const koteTokenAddress = (process.env.KOTE_TOKEN_ADDRESS || DEFAULT_KOTE_TOKEN).trim();

    res.json({
      round,
      aliveCount: aliveRes.rows[0].alive_count,
      minPlayers: MIN_PLAYERS_TO_START,
      secondsLeft,
      picksLocked,
      escrowWallet,
      escrowValid: isValidTonAddress(escrowWallet),
      treasuryWallet,
      koteTokenAddress,
      myEntry,
      history: recentRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

app.post('/api/join', async (req, res) => {
  try {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ error: 'Open inside Telegram to play' });

    const walletAddress = String(req.body?.walletAddress || '').trim();
    if (walletAddress && !isValidTonAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid TON wallet address format' });
    }

    const round = await ensureOpenRound();
    if (round.status !== 'OPEN') {
      return res.status(400).json({ error: 'Round lobby is closed; wait for the next round' });
    }

    const existing = await pool.query(
      `SELECT * FROM entries WHERE round_id = $1 AND tg_user_id = $2`,
      [round.id, user.id]
    );
    if (existing.rows.length > 0) {
      if (walletAddress && !existing.rows[0].wallet_address) {
        const updated = await pool.query(
          `UPDATE entries SET wallet_address = $1 WHERE id = $2 RETURNING *`,
          [walletAddress, existing.rows[0].id]
        );
        return res.json({ entry: updated.rows[0] });
      }
      return res.json({ entry: existing.rows[0] });
    }

    const randSuffix = crypto.randomInt(1000, 9999);
    const memoCode = `KOTE-R${round.id}-U${user.id}-${randSuffix}`;

    const inserted = await pool.query(
      `INSERT INTO entries (round_id, tg_user_id, tg_username, wallet_address, memo_code, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       RETURNING *`,
      [round.id, user.id, user.username, walletAddress || null, memoCode]
    );

    res.json({ entry: inserted.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create entry' });
  }
});

// Anti-Hack On-Chain Payment Verification
app.post('/api/confirm-tx', async (req, res) => {
  try {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const escrowWallet = (process.env.ESCROW_WALLET_ADDRESS || '').trim();
    if (!isValidTonAddress(escrowWallet)) {
      return res.status(500).json({ error: 'Server escrow wallet not configured properly' });
    }

    const txHash = String(req.body?.txHash || '').trim();
    const walletAddress = String(req.body?.walletAddress || '').trim();

    const round = await ensureOpenRound();
    if (round.status !== 'OPEN') {
      return res.status(400).json({ error: 'Lobby is already locked for this round' });
    }

    const entryRes = await pool.query(
      `SELECT * FROM entries WHERE round_id = $1 AND tg_user_id = $2`,
      [round.id, user.id]
    );
    if (entryRes.rows.length === 0) {
      return res.status(404).json({ error: 'Join the round first' });
    }

    const entry = entryRes.rows[0];
    if (entry.status === 'ALIVE') {
      return res.json({ entry });
    }

    const check = await verifyIncomingTonPayment({
      escrowWallet,
      expectedTon: round.entry_fee,
      memoCode: entry.memo_code,
      txHash
    });

    if (!check.verified) {
      return res.status(400).json({
        error: 'GRAM deposit not confirmed on-chain yet. Wait a few seconds and tap Verify again.'
      });
    }

    // Prevent replay attacks using the real on-chain transaction hash
    const dupTx = await pool.query(`SELECT id FROM entries WHERE tx_hash = $1`, [check.onChainHash]);
    if (dupTx.rows.length > 0) {
      return res.status(409).json({ error: 'This on-chain transaction was already claimed' });
    }

    const fee = Number(round.entry_fee);
    const potContribution = fee * 0.85;

    await pool.query(
      `UPDATE entries
       SET status = 'ALIVE',
           tx_hash = $1,
           wallet_address = COALESCE($2, wallet_address),
           updated_at = NOW()
       WHERE id = $3`,
      [check.onChainHash, walletAddress || check.sender || null, entry.id]
    );

    await pool.query(
      `UPDATE rounds
       SET pot_total = pot_total + $1
       WHERE id = $2`,
      [potContribution, round.id]
    );

    const updatedEntry = await pool.query(`SELECT * FROM entries WHERE id = $1`, [entry.id]);
    res.json({ entry: updatedEntry.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to verify payment on-chain' });
  }
});

app.post('/api/pick', async (req, res) => {
  try {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const pick = String(req.body?.pick || '').toUpperCase();
    if (!['GREEN', 'RED'].includes(pick)) {
      return res.status(400).json({ error: 'Pick must be GREEN or RED' });
    }

    const round = await ensureOpenRound();
    const secondsLeft = Math.max(
      0,
      Math.floor((new Date(round.step_ends_at).getTime() - Date.now()) / 1000)
    );
    if (round.status !== 'LIVE' || secondsLeft <= 20) {
      return res.status(400).json({ error: 'Picks are locked for this candle' });
    }

    const updated = await pool.query(
      `UPDATE entries
       SET pick = $1, updated_at = NOW()
       WHERE round_id = $2 AND tg_user_id = $3 AND status = 'ALIVE'
       RETURNING *`,
      [pick, round.id, user.id]
    );

    if (updated.rows.length === 0) {
      return res.status(400).json({ error: 'You must be an ALIVE player in this round to pick' });
    }

    res.json({ entry: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save pick' });
  }
});

// Telegram Webhook handler
app.post(`/webhook/${process.env.BOT_TOKEN || 'dev'}`, async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || !msg.chat?.id) return;

  const text = (msg.text || '').trim();
  if (text.startsWith('/start') || text.startsWith('/kote') || text.startsWith('/candle')) {
    const webAppUrl = process.env.WEBAPP_URL || 'https://example.com';
    await sendTelegramMessage(
      msg.chat.id,
      `<b>🐱🔥 WELCOME TO $KOTÉ — LAST CANDLE STANDING</b>\n\nSurvive every candle. Outlast the crowd. Claim the pot.\n\n• <b>85%</b> prize pool (<b>50%</b> 1st, <b>20%</b> 2nd, <b>15%</b> 3rd)\n• <b>15%</b> auto-routes to $KOTÉ Treasury (buybacks &amp; marketing)`,
      {
        inline_keyboard: [[{ text: '🔥 Open $KOTÉ Arena', web_app: { url: webAppUrl } }]]
      }
    );
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initDb();
  await ensureOpenRound();

  if (process.env.BOT_TOKEN && process.env.WEBAPP_URL) {
    const webhookUrl = `${process.env.WEBAPP_URL}/webhook/${process.env.BOT_TOKEN}`;
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
  }

  setInterval(() => {
    tickGameEngine().catch((err) => console.error('Tick error:', err));
  }, 5000);

  app.listen(PORT, () => {
    console.log(`$KOTÉ Last Candle Standing running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
