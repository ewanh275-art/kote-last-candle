require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, initDb } = require('./db');
const { tickGameEngine, ensureOpenRound, sendTelegramMessage } = require('./gameLoop');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Verify Telegram Mini App initData signature
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

  // Fallback for local browser testing when BOT_TOKEN isn't set
  if (!process.env.BOT_TOKEN && req.body?.devUserId) {
    return {
      id: Number(req.body.devUserId),
      username: req.body.devUsername || 'KoteTester'
    };
  }
  return null;
}

app.get('/api/state', async (req, res) => {
  try {
    const round = await ensureOpenRound();
    const aliveRes = await pool.query(
      `SELECT COUNT(*)::int AS alive_count FROM entries WHERE round_id = $1 AND status = 'ALIVE'`,
      [round.id]
    );
    const recentRes = await pool.query(
      `SELECT id, status, pot_total, winner_username, created_at
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

    res.json({
      round,
      aliveCount: aliveRes.rows[0].alive_count,
      secondsLeft,
      picksLocked,
      escrowWallet: process.env.ESCROW_WALLET_ADDRESS || 'SET_ESCROW_WALLET',
      treasuryWallet: process.env.TREASURY_WALLET_ADDRESS || 'SET_TREASURY_WALLET',
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

    const round = await ensureOpenRound();
    if (round.status !== 'OPEN') {
      return res.status(400).json({ error: 'Round lobby is closed; wait for the next round' });
    }

    const existing = await pool.query(
      `SELECT * FROM entries WHERE round_id = $1 AND tg_user_id = $2`,
      [round.id, user.id]
    );
    if (existing.rows.length > 0) {
      return res.json({ entry: existing.rows[0] });
    }

    const randSuffix = crypto.randomInt(1000, 9999);
    const memoCode = `KOTE-R${round.id}-U${user.id}-${randSuffix}`;

    const inserted = await pool.query(
      `INSERT INTO entries (round_id, tg_user_id, tg_username, memo_code, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING *`,
      [round.id, user.id, user.username, memoCode]
    );

    res.json({ entry: inserted.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create entry' });
  }
});

// Records a verified tx hash & credits 85% to live pot (15% routed to treasury)
app.post('/api/confirm-tx', async (req, res) => {
  try {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const txHash = String(req.body?.txHash || '').trim();
    if (!txHash || txHash.length < 10) {
      return res.status(400).json({ error: 'Enter a valid transaction hash' });
    }

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

    // Prevent tx replay across all rounds/users
    const dupTx = await pool.query(`SELECT id FROM entries WHERE tx_hash = $1`, [txHash]);
    if (dupTx.rows.length > 0) {
      return res.status(409).json({ error: 'Transaction hash already used' });
    }

    // Note: Plug in your chain RPC check here before marking ALIVE in production
    const fee = Number(round.entry_fee);
    const potContribution = fee * 0.85;

    await pool.query(
      `UPDATE entries
       SET status = 'ALIVE', tx_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [txHash, entry.id]
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
    res.status(500).json({ error: 'Failed to confirm transaction' });
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
    const secondsLeft = Math.max(0, Math.floor((new Date(round.step_ends_at).getTime() - Date.now()) / 1000));
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
      `<b>$KOTÉ — LAST CANDLE STANDING</b>\n\nSurvive every candle. Last cat standing takes <b>85%</b> of the pot, and <b>15%</b> feeds the $KOTÉ Treasury (buybacks &amp; marketing).`,
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
