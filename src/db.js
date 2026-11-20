const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      entry_fee NUMERIC(18, 6) NOT NULL DEFAULT 1,
      pot_total NUMERIC(18, 6) NOT NULL DEFAULT 0,
      step_number INT NOT NULL DEFAULT 0,
      open_price NUMERIC(24, 12),
      step_ends_at TIMESTAMPTZ,
      winner_tg_id BIGINT,
      winner_username TEXT,
      payout_status VARCHAR(24) DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      round_id INT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      tg_user_id BIGINT NOT NULL,
      tg_username TEXT,
      wallet_address TEXT,
      memo_code VARCHAR(32) UNIQUE NOT NULL,
      tx_hash TEXT UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      pick VARCHAR(10),
      placement INT,
      payout_ton NUMERIC(18, 6) DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(round_id, tg_user_id)
    );
  `);

  await pool.query(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS wallet_address TEXT;`);
  await pool.query(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS placement INT;`);
  await pool.query(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS payout_ton NUMERIC(18, 6) DEFAULT 0;`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS payout_status VARCHAR(24) DEFAULT 'PENDING';`);
}

module.exports = { pool, initDb };
