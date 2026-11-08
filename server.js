// ============================================================
// Fade Factory Barber Shop — servidor de reservas
// Node.js + Express. DB: Postgres (DATABASE_URL) o SQLite local.
// Env vars:
//   PORT          puerto (default 3000)
//   DATABASE_URL  si existe -> Postgres; si no -> SQLite local
//   STORE_KEY     clave compartida para /store y APIs de gestión.
//   ADMIN_KEY     clave del dueño para /admin (kill switch).
// ============================================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const suspend = require("./suspend");
const { SETTINGS_VERSION } = require("./seed");

const PORT = process.env.PORT || 3000;
const STORE_KEY = process.env.STORE_KEY || "";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(suspend.middleware);
suspend.registerAdmin(app);

// ---------------- Auth de gestión ----------------
if (!STORE_KEY) {
  console.warn("[fadefactory] ⚠️  STORE_KEY no configurado — /store abierto (modo desarrollo).");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireStore(req, res, next) {
  if (!STORE_KEY) return next();
  const k = req.headers["x-store-key"] || req.query.key || "";
  if (k && safeEqual(k, STORE_KEY)) return next();
  return res.status(401).json({ error: "Unauthorized." });
}

// ---------------- SSE (eventos en vivo) ----------------
const sseClients = [];
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].write(payload); } catch (e) { sseClients.splice(i, 1); }
  }
}

app.get("/api/events", requireStore, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.push(res);
  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch (e) { clearInterval(heartbeat); }
  }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    const i = sseClients.indexOf(res);
    if (i >= 0) sseClients.splice(i, 1);
  });
});

// ---------------- API: catálogo y ajustes ----------------
app.get("/api/catalog", async (req, res) => {
  res.json(await db.getCatalog());
});

app.put("/api/catalog", requireStore, async (req, res) => {
  const cat = req.body;
  if (!cat || !Array.isArray(cat.departments)) {
    return res.status(400).json({ error: "Invalid catalog format." });
  }
  await db.setCatalog(cat);
  broadcast("catalog-updated", { at: new Date().toISOString() });
  res.json({ ok: true });
});

app.get("/api/settings", async (req, res) => {
  const s = await db.getSettings();
  res.json({ openDays: s.openDays, slots: s.slots, capacity: s.capacity, daySlots: s.daySlots || {} });
});

app.put("/api/settings", requireStore, async (req, res) => {
  const { openDays, slots, capacity, daySlots } = req.body || {};
  if (!Array.isArray(openDays) || !Array.isArray(slots) || !slots.length || !(Number(capacity) > 0)) {
    return res.status(400).json({ error: "Invalid settings." });
  }
  const cleanDaySlots = {};
  if (daySlots && typeof daySlots === "object") {
    for (const k of Object.keys(daySlots)) {
      if (!/^[0-6]$/.test(k) || !Array.isArray(daySlots[k])) continue;
      const arr = daySlots[k].map((s) => String(s).trim().slice(0, 24)).filter(Boolean);
      if (arr.length) cleanDaySlots[k] = arr;
    }
  }
  const clean = {
    openDays: openDays.map(Number).filter((d) => d >= 0 && d <= 6),
    slots: slots.map((s) => String(s).trim().slice(0, 24)).filter(Boolean),
    capacity: Math.min(20, Math.max(1, Number(capacity))),
    daySlots: cleanDaySlots,
    version: SETTINGS_VERSION
  };
  await db.setSettings(clean);
  broadcast("settings-updated", clean);
  res.json({ ok: true, settings: clean });
});

// ---------------- API: disponibilidad ----------------
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- Duraciones: una reserva bloquea TODOS los slots que abarca ----
function toMin(t) {
  const m = String(t || "").match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}
function bookingMins(b) {
  if (b.mins) return Number(b.mins);
  if (Array.isArray(b.services) && b.services.length) {
    return b.services.reduce((s, x) => s + (Number(x.mins) || 60), 0);
  }
  return 60;
}
function slotsFor(settings, dow) {
  const ds = settings.daySlots && settings.daySlots[String(dow)];
  return Array.isArray(ds) && ds.length ? ds : settings.slots;
}
async function slotUsage(date, settings, daySlots) {
  const usage = {};
  for (const s of daySlots) usage[s] = 0;
  const day = await db.listActiveForDate(date);
  for (const b of day) {
    const start = toMin(b.time);
    if (start == null) continue;
    const dur = bookingMins(b);
    for (const s of daySlots) {
      const x = toMin(s);
      if (x != null && x >= start && x < start + dur) usage[s]++;
    }
  }
  return usage;
}

app.get("/api/availability", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date." });
  }
  const settings = await db.getSettings();
  const dow = new Date(date + "T12:00:00").getDay();
  if (!settings.openDays.includes(dow)) {
    return res.json({ date, open: false, slots: [] });
  }
  const daySlots = slotsFor(settings, dow);
  const usage = await slotUsage(date, settings, daySlots);
  const slots = daySlots.map((time) => ({
    time, used: usage[time] || 0, left: Math.max(0, settings.capacity - (usage[time] || 0))
  }));
  res.json({ date, open: true, slots });
});

// ---------------- API: reservas ----------------
const VALID_STATUS = ["pending", "confirmed", "done", "cancelled", "no-show"];

function findItem(catalog, itemId) {
  for (const d of catalog.departments || []) {
    for (const c of d.categories || []) {
      for (const it of c.items || []) {
        if (it.id === itemId) return it;
      }
    }
  }
  return null;
}

// Público: los clientes reservan sin clave. Una reserva puede
// llevar varios servicios (serviceIds) o uno solo (serviceId).
app.post("/api/bookings", async (req, res) => {
  const { serviceId, serviceIds, customer, date, time, notes } = req.body || {};

  if (!customer || !String(customer.name || "").trim() || !String(customer.phone || "").trim()) {
    return res.status(400).json({ error: "Name and phone are required." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || String(date) < todayStr()) {
    return res.status(400).json({ error: "Please pick a valid upcoming date." });
  }
  const settings = await db.getSettings();
  const dow = new Date(date + "T12:00:00").getDay();
  if (!settings.openDays.includes(dow)) {
    return res.status(400).json({ error: "We are closed that day. Please pick another date." });
  }
  if (!slotsFor(settings, dow).includes(time)) {
    return res.status(400).json({ error: "Please pick one of the available times." });
  }
  const catalog = await db.getCatalog();
  const ids = Array.isArray(serviceIds) && serviceIds.length ? serviceIds : (serviceId ? [serviceId] : []);
  if (!ids.length) {
    return res.status(400).json({ error: "Please pick at least one service." });
  }
  const snapshots = [];
  for (const id of ids.slice(0, 12)) {
    const item = findItem(catalog, id);
    if (!item || !item.active) {
      return res.status(400).json({ error: "One of those services is not available right now." });
    }
    snapshots.push({ id: item.id, name: item.name, nameEs: item.nameEs || "", price: item.price, mins: Number(item.mins) || 60 });
  }
  const total = Math.round(snapshots.reduce((s, x) => s + x.price, 0) * 100) / 100;
  const totalMins = snapshots.reduce((s, x) => s + x.mins, 0);
  const startMin = toMin(time);
  const daySlots = slotsFor(settings, dow);
  const usage = await slotUsage(date, settings, daySlots);
  const blocked = daySlots.some((s) => {
    const x = toMin(s);
    return x != null && startMin != null && x >= startMin && x < startMin + totalMins &&
      (usage[s] || 0) >= settings.capacity;
  });
  if (blocked) {
    return res.status(409).json({ error: "That time just filled up. Please pick another time." });
  }

  const number = await db.nextBookingNumber();
  const booking = await db.createBooking({
    number,
    service: { services: snapshots, total, mins: totalMins },
    customer: {
      name: String(customer.name).trim().slice(0, 80),
      phone: String(customer.phone).trim().slice(0, 30)
    },
    date,
    time,
    notes: String(notes || "").slice(0, 500)
  });

  broadcast("new-booking", booking);
  res.status(201).json(booking);
});

// Público: el cliente consulta el estado de su reserva.
app.get("/api/track", async (req, res) => {
  const { number, phone } = req.query;
  if (!number || !phone) return res.status(400).json({ error: "Booking number and phone required." });
  const b = await db.findByNumberAndPhone(number, phone);
  if (!b) return res.status(404).json({ error: "Booking not found. Check the number and phone." });
  res.json({
    number: b.number,
    service: b.services[0] ? b.services[0].name : "",
    serviceEs: b.services[0] ? (b.services[0].nameEs || "") : "",
    services: b.services, total: b.total, price: b.total,
    date: b.date, time: b.time, status: b.status
  });
});

// Solo gestión:
app.get("/api/bookings", requireStore, async (req, res) => {
  res.json(await db.listBookings());
});

app.patch("/api/bookings/:id", requireStore, async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  const updated = await db.updateBookingStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: "Booking not found." });
  broadcast("booking-status", updated);
  res.json(updated);
});

// Limpieza selectiva: ?status=cancelled|done|... borra solo ese estado;
// sin parámetro borra todo. Borrar una sola: DELETE /api/bookings/:id
app.delete("/api/bookings/:id", requireStore, async (req, res) => {
  const ok = await db.deleteBooking(req.params.id);
  if (!ok) return res.status(404).json({ error: "Booking not found." });
  broadcast("bookings-cleared", {});
  res.json({ ok: true });
});

app.delete("/api/bookings", requireStore, async (req, res) => {
  const status = String(req.query.status || "");
  if (status) {
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const n = await db.deleteBookingsByStatus(status);
    broadcast("bookings-cleared", {});
    return res.json({ ok: true, deleted: n });
  }
  await db.deleteAllBookings();
  broadcast("bookings-cleared", {});
  res.json({ ok: true });
});

// ---------------- Páginas ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/store", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "store.html"));
});

// ---------------- Arranque ----------------
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`[fadefactory] Servidor corriendo en http://localhost:${PORT}`);
    console.log(`[fadefactory] Clientes: http://localhost:${PORT}/`);
    console.log(`[fadefactory] Gestión:  http://localhost:${PORT}/store`);
  });
}).catch((err) => {
  console.error("[fadefactory] ❌ No se pudo inicializar la base de datos:", err.message);
  process.exit(1);
});
