const { pool } = require('./db');
const { getCurrentTokenPrice } = require('./prices');
const { executeRoundPayouts } = require('./payouts');

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function ensureOpenRound() {
  const existing = await pool.query(
    `SELECT * FROM rounds WHERE status IN ('OPEN', 'LIVE') ORDER BY id DESC LIMIT 1`
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const entryFee = Number(process.env.ENTRY_FEE || 1);
  const lobbyMins = Number(process.env.ROUND_DURATION_MINUTES || 15);
  const endsAt = new Date(Date.now() + lobbyMins * 60 * 1000).toISOString();

  const created = await pool.query(
    `INSERT INTO rounds (status, entry_fee, step_ends_at)
     VALUES ('OPEN', $1, $2) RETURNING *`,
    [entryFee, endsAt]
  );
  return created.rows[0];
}

async function startNextCandleStep(roundId) {
  const intervalSec = Number(process.env.CANDLE_INTERVAL_SECONDS || 120);
  const openPrice = await getCurrentTokenPrice();
  const nextStepEnds = new Date(Date.now() + intervalSec * 1000).toISOString();

  const updated = await pool.query(
    `UPDATE rounds
     SET status = 'LIVE',
         step_number = step_number + 1,
         open_price = $1,
         step_ends_at = $2
     WHERE id = $3
     RETURNING *`,
    [openPrice, nextStepEnds, roundId]
  );

  await pool.query(
    `UPDATE entries SET pick = NULL WHERE round_id = $1 AND status = 'ALIVE'`,
    [roundId]
  );

  return updated.rows[0];
}

async function settleRound(round) {
  // Rank active players first, then most recently updated entries for 2nd & 3rd place
  const rankedRes = await pool.query(
    `SELECT * FROM entries
     WHERE round_id = $1 AND status IN ('ALIVE', 'ELIMINATED')
     ORDER BY CASE WHEN status = 'ALIVE' THEN 0 ELSE 1 END ASC,
              updated_at DESC,
              id ASC
     LIMIT 3`,
    [round.id]
  );

  // pot_total already stores the 85% prize pool accumulated from verified entries
  const prizePool85 = Number(round.pot_total || 0);
  const grossCollected = prizePool85 > 0 ? prizePool85 / 0.85 : 0;
  const treasury15 = Number((grossCollected * 0.15).toFixed(6));

  const placeConfigs = [
    { place: 1, pctOfPool: 0.50, status: 'WINNER' },
    { place: 2, pctOfPool: 0.20, status: 'SECOND' },
    { place: 3, pctOfPool: 0.15, status: 'THIRD' }
  ];

  const placements = [];
  for (let i = 0; i < placeConfigs.length; i++) {
    const entry = rankedRes.rows[i];
    if (!entry) break;
    const cfg = placeConfigs[i];
    const payoutTon = Number((prizePool85 * cfg.pctOfPool).toFixed(6));

    await pool.query(
      `UPDATE entries
       SET status = $1, placement = $2, payout_ton = $3, updated_at = NOW()
       WHERE id = $4`,
      [cfg.status, cfg.place, payoutTon, entry.id]
    );

    placements.push({
      ...entry,
      placement: cfg.place,
      payout_ton: payoutTon
    });
  }

  const firstPlace = placements[0] || null;
  let payoutStatus = 'NO_PAYOUT_NEEDED';

  if (prizePool85 > 0 || treasury15 > 0) {
    try {
      await executeRoundPayouts({
        roundId: round.id,
        prizePool85,
        treasury15,
        placements
      });
      payoutStatus = 'SENT';
    } catch (err) {
      console.error('Payout execution failed:', err);
      payoutStatus = 'FAILED_RETRY';
    }
  }

  await pool.query(
    `UPDATE rounds
     SET status = 'SETTLED',
         winner_tg_id = $1,
         winner_username = $2,
         payout_status = $3
     WHERE id = $4`,
    [
      firstPlace ? firstPlace.tg_user_id : null,
      firstPlace ? firstPlace.tg_username : null,
      payoutStatus,
      round.id
    ]
  );

  return { placements, prizePool85, treasury15, payoutStatus };
}

async function tickGameEngine() {
  const round = await ensureOpenRound();
  const now = Date.now();
  const endsAtMs = new Date(round.step_ends_at).getTime();

  if (round.status === 'OPEN' && now >= endsAtMs) {
    const activeCountRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM entries WHERE round_id = $1 AND status = 'ALIVE'`,
      [round.id]
    );
    const activeCount = activeCountRes.rows[0].cnt;

    if (activeCount < 2) {
      const extendMs = 5 * 60 * 1000;
      await pool.query(
        `UPDATE rounds SET step_ends_at = $1 WHERE id = $2`,
        [new Date(now + extendMs).toISOString(), round.id]
      );
      return;
    }

    await startNextCandleStep(round.id);
    return;
  }

  if (round.status === 'LIVE' && now >= endsAtMs) {
    const closePrice = await getCurrentTokenPrice();
    const openPrice = Number(round.open_price);

    if (closePrice !== openPrice) {
      const winningSide = closePrice > openPrice ? 'GREEN' : 'RED';
      await pool.query(
        `UPDATE entries
         SET status = 'ELIMINATED', updated_at = NOW()
         WHERE round_id = $1
           AND status = 'ALIVE'
           AND (pick IS NULL OR pick != $2)`,
        [round.id, winningSide]
      );
    }

    const aliveRes = await pool.query(
      `SELECT * FROM entries WHERE round_id = $1 AND status = 'ALIVE'`,
      [round.id]
    );

    if (aliveRes.rows.length <= 1) {
      await settleRound(round);
      await ensureOpenRound();
    } else {
      await startNextCandleStep(round.id);
    }
  }
}

module.exports = {
  tickGameEngine,
  ensureOpenRound,
  sendTelegramMessage
};
