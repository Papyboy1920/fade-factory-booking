// ============================================================
// Fade Factory Barber Shop — capa de base de datos
// Dos backends: Postgres (si existe DATABASE_URL) o SQLite
// local (node:sqlite) como respaldo. server.js no toca SQL.
// ============================================================

const path = require("path");
const { SEED_CATALOG, CATALOG_VERSION, SEED_SETTINGS, SETTINGS_VERSION } = require("./seed");

let kind = null;
let pool = null;
let sdb = null;

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT UNIQUE NOT NULL,
    service TEXT NOT NULL,
    customer TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    number TEXT UNIQUE NOT NULL,
    service TEXT NOT NULL,
    customer TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`;

// ---------- Fusión de catálogo (nunca destructiva) ----------
// Conserva lo que la dueña agregó/editó en /store; solo agrega
// ítems nuevos de la semilla y rellena campos vacíos (desc, img).
function mergeCatalog(live, seed) {
  const base =
    live && Array.isArray(live.departments)
      ? JSON.parse(JSON.stringify(live))
      : { departments: [] };
  if (!Array.isArray(base.departments)) base.departments = [];
  let added = 0;
  let filled = 0;
  const byId = (arr, id) => (arr || []).find((x) => x && x.id === id);
  for (const sDept of (seed && seed.departments) || []) {
    let d = byId(base.departments, sDept.id);
    if (!d) {
      base.departments.push(JSON.parse(JSON.stringify(sDept)));
      added++;
      continue;
    }
    if ((d.img === undefined || d.img === null || d.img === "") && sDept.img) {
      d.img = sDept.img;
      filled++;
    }
    if ((d.nameEs === undefined || d.nameEs === null || d.nameEs === "") && sDept.nameEs) {
      d.nameEs = sDept.nameEs;
      filled++;
    }
    d.categories = d.categories || [];
    for (const sCat of sDept.categories || []) {
      let c = byId(d.categories, sCat.id);
      if (!c) {
        d.categories.push(JSON.parse(JSON.stringify(sCat)));
        added++;
        continue;
      }
      c.items = c.items || [];
      for (const sItem of sCat.items || []) {
        const it = byId(c.items, sItem.id);
        if (!it) {
          c.items.push(JSON.parse(JSON.stringify(sItem)));
          added++;
        } else {
          for (const f of ["desc", "img", "nameEs"]) {
            if ((it[f] === undefined || it[f] === null || it[f] === "") && sItem[f]) {
              it[f] = sItem[f];
              filled++;
            }
          }
        }
      }
    }
  }
  return { catalog: base, added, filled };
}

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const url = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false }
    });
    await pool.query(PG_SCHEMA);
    kind = "pg";
    console.log("[fadefactory] DB: Postgres");
  } else {
    const { DatabaseSync } = require("node:sqlite");
    sdb = new DatabaseSync(path.join(__dirname, "fade-factory.db"));
    sdb.exec(SQLITE_SCHEMA);
    kind = "sqlite";
    console.log("[fadefactory] DB: SQLite local (fade-factory.db)");
  }

  if (!(await kvGet("catalog"))) {
    await kvSet("catalog", JSON.stringify(SEED_CATALOG));
    await kvSet("catalog_version", String(CATALOG_VERSION));
    console.log("[fadefactory] Catálogo semilla cargado.");
  } else {
    const v = await kvGet("catalog_version");
    if (v !== String(CATALOG_VERSION)) {
      let live = null;
      try { live = JSON.parse(await kvGet("catalog")); } catch { live = null; }
      const m = mergeCatalog(live, SEED_CATALOG);
      await kvSet("catalog", JSON.stringify(m.catalog));
      await kvSet("catalog_version", String(CATALOG_VERSION));
      console.log(`[fadefactory] Catálogo fusionado (v${v} → v${CATALOG_VERSION}): +${m.added} nuevos, ${m.filled} rellenados.`);
    }
  }
  if (!(await kvGet("settings"))) {
    await kvSet("settings", JSON.stringify(SEED_SETTINGS));
    console.log("[fadefactory] Ajustes de agenda semilla cargados.");
  }
  if (!(await kvGet("booking_seq"))) await kvSet("booking_seq", "0");
  return kind;
}

function dbKind() { return kind; }

// ---------- kv ----------
async function kvGet(key) {
  if (kind === "pg") {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
    return r.rows.length ? r.rows[0].value : null;
  }
  const row = sdb.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? row.value : null;
}

async function kvSet(key, value) {
  if (kind === "pg") {
    await pool.query(
      "INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
    return;
  }
  sdb.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// ---------- catálogo y ajustes ----------
async function getCatalog() { return JSON.parse(await kvGet("catalog")); }
async function setCatalog(cat) { await kvSet("catalog", JSON.stringify(cat)); }
async function getSettings() {
  const s = JSON.parse(await kvGet("settings"));
  if (!s) return { ...SEED_SETTINGS };
  if ((s.version || 0) < SETTINGS_VERSION) {
    // Migración de horario: se imponen los bloques vigentes (SEED_SETTINGS);
    // días abiertos y cupo guardados se respetan. Al guardar desde /store
    // la versión queda estampada y manda lo guardado.
    return { ...s, slots: [...SEED_SETTINGS.slots], version: SETTINGS_VERSION };
  }
  return s;
}
async function setSettings(s) { await kvSet("settings", JSON.stringify(s)); }

// ---------- reservas ----------
function mapBooking(row) {
  let svc = null;
  try { svc = JSON.parse(row.service); } catch { svc = null; }
  let services, total;
  if (svc && Array.isArray(svc.services)) {
    services = svc.services;
    total = svc.total != null ? svc.total : services.reduce((s, x) => s + (x.price || 0), 0);
  } else if (svc && svc.id) {
    // Formato v1: un solo servicio por reserva.
    services = [svc];
    total = svc.price || 0;
  } else {
    services = [];
    total = 0;
  }
  return {
    id: row.id,
    number: row.number,
    service: services[0] || null,
    services,
    total,
    customer: JSON.parse(row.customer),
    date: row.date,
    time: row.time,
    notes: row.notes || "",
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function nextBookingNumber() {
  let seq;
  if (kind === "pg") {
    const r = await pool.query(
      `INSERT INTO kv (key, value) VALUES ('booking_seq', '1')
       ON CONFLICT(key) DO UPDATE SET value = ((kv.value)::int + 1)::text
       RETURNING value`
    );
    seq = Number(r.rows[0].value);
  } else {
    seq = Number(await kvGet("booking_seq")) + 1;
    await kvSet("booking_seq", String(seq));
  }
  return "#" + String(seq).padStart(3, "0");
}

async function createBooking({ number, service, customer, date, time, notes }) {
  if (kind === "pg") {
    const r = await pool.query(
      `INSERT INTO bookings (number, service, customer, date, time, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [number, JSON.stringify(service), JSON.stringify(customer), date, time, notes || null]
    );
    return mapBooking(r.rows[0]);
  }
  const info = sdb.prepare(
    "INSERT INTO bookings (number, service, customer, date, time, notes, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
  ).run(number, JSON.stringify(service), JSON.stringify(customer), date, time, notes || null);
  const row = sdb.prepare("SELECT * FROM bookings WHERE id = ?").get(info.lastInsertRowid);
  return mapBooking(row);
}

async function listBookings() {
  if (kind === "pg") {
    const r = await pool.query("SELECT * FROM bookings ORDER BY date ASC, id DESC LIMIT 500");
    return r.rows.map(mapBooking);
  }
  return sdb.prepare("SELECT * FROM bookings ORDER BY date ASC, id DESC LIMIT 500").all().map(mapBooking);
}

async function countActiveForSlot(date, time) {
  if (kind === "pg") {
    const r = await pool.query(
      "SELECT COUNT(*)::int AS n FROM bookings WHERE date = $1 AND time = $2 AND status IN ('pending','confirmed')",
      [date, time]
    );
    return r.rows[0].n;
  }
  const row = sdb.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND time = ? AND status IN ('pending','confirmed')"
  ).get(date, time);
  return row.n;
}

async function findByNumberAndPhone(number, phone) {
  const all = await listBookings();
  const clean = (s) => String(s || "").replace(/\D/g, "").slice(-10);
  return all.find(
    (b) => b.number.toLowerCase() === String(number || "").trim().toLowerCase() &&
           clean(b.customer.phone) === clean(phone)
  ) || null;
}

async function updateBookingStatus(id, status) {
  if (kind === "pg") {
    const r = await pool.query("UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *", [status, id]);
    return r.rows.length ? mapBooking(r.rows[0]) : null;
  }
  const row = sdb.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
  if (!row) return null;
  sdb.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, id);
  return mapBooking(sdb.prepare("SELECT * FROM bookings WHERE id = ?").get(id));
}

async function deleteAllBookings() {
  if (kind === "pg") {
    await pool.query("DELETE FROM bookings");
    await pool.query("UPDATE kv SET value = '0' WHERE key = 'booking_seq'");
  } else {
    sdb.prepare("DELETE FROM bookings").run();
    sdb.prepare("UPDATE kv SET value = '0' WHERE key = 'booking_seq'").run();
  }
}

// Borrado selectivo desde /store: una reserva o todas las de un estado.
async function deleteBooking(id) {
  if (kind === "pg") {
    const r = await pool.query("DELETE FROM bookings WHERE id = $1", [id]);
    return r.rowCount > 0;
  }
  const info = sdb.prepare("DELETE FROM bookings WHERE id = ?").run(id);
  return info.changes > 0;
}

async function deleteBookingsByStatus(status) {
  if (kind === "pg") {
    const r = await pool.query("DELETE FROM bookings WHERE status = $1", [status]);
    return r.rowCount;
  }
  const info = sdb.prepare("DELETE FROM bookings WHERE status = ?").run(status);
  return info.changes;
}

module.exports = {
  init, dbKind, kvGet, kvSet,
  getCatalog, setCatalog, getSettings, setSettings,
  nextBookingNumber, createBooking, listBookings,
  countActiveForSlot, findByNumberAndPhone,
  updateBookingStatus, deleteAllBookings,
  deleteBooking, deleteBookingsByStatus
};
