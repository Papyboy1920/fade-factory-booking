// ============================================================
// Interruptor de suspensión — kill switch del dueño (Portal)
//
// Si la tienda está suspendida, el lado del CLIENTE muestra una
// página de "servicio suspendido" y las APIs de cliente devuelven
// 503. /tienda y /admin siguen vivos.
//
// El interruptor vive en /admin, protegido por ADMIN_KEY, una env
// var que SOLO Portal conoce (se configura en Render). Los managers
// con STORE_KEY no pueden tocarlo.
//
// Uso en server.js:
//   const suspend = require("./suspend");
//   app.use(suspend.middleware);   // antes de express.static
//   suspend.registerAdmin(app);
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const ADMIN_KEY = process.env.ADMIN_KEY || "";

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function isSuspended() {
  try {
    return (await db.kvGet("suspended")) === "1";
  } catch (e) {
    return false;
  }
}

async function setSuspended(v) {
  await db.kvSet("suspended", v ? "1" : "0");
}

const SUSPENDED_PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Servicio suspendido</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
         background:#141416; color:#f5f5f5; display:flex; align-items:center; justify-content:center;
         min-height:100vh; text-align:center; padding:24px; }
  .box { max-width:420px; }
  .big { font-size:64px; }
  h1 { font-size:24px; margin:12px 0 8px; }
  p { color:#a1a1aa; font-size:15px; line-height:1.6; }
  .en { margin-top:18px; padding-top:18px; border-top:1px solid #2a2a2e; }
</style>
</head>
<body>
  <div class="box">
    <div class="big">⛔</div>
    <h1>Servicio suspendido temporalmente</h1>
    <p>Esta tienda está pausada por el momento.<br>Contacta a tu administrador para más información.</p>
    <div class="en">
      <h1>Service temporarily suspended</h1>
      <p>This store is currently paused.<br>Please contact your administrator for more information.</p>
    </div>
  </div>
</body>
</html>`;

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin — Interruptor</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
         background:#141416; color:#f5f5f5; padding:24px; }
  main { max-width:440px; margin:0 auto; }
  h1 { font-size:22px; }
  .card { background:#1d1d21; border:1px solid #2a2a2e; border-radius:14px; padding:20px; margin-top:16px; }
  label { display:block; font-size:13px; color:#a1a1aa; margin:0 0 6px; }
  input { width:100%; box-sizing:border-box; background:#0b0b0d; border:1px solid #3a3a40; color:#fff;
          border-radius:10px; padding:12px; font-size:16px; margin-bottom:12px; }
  .status { font-size:15px; margin:12px 0; padding:12px; border-radius:10px; text-align:center; font-weight:700; }
  .status.on { background:#3a1414; color:#ff8080; border:1px solid #7a2020; }
  .status.off { background:#12351f; color:#7dff9e; border:1px solid #1f7a3a; }
  button.big { width:100%; border:none; border-radius:12px; padding:16px; font-size:17px; font-weight:800;
               cursor:pointer; margin-top:6px; }
  button.suspend { background:#e03131; color:#fff; }
  button.reactivate { background:#2f9e44; color:#fff; }
  button:disabled { opacity:.5; }
  .msg { font-size:13px; color:#a1a1aa; margin-top:12px; min-height:18px; text-align:center; }
  .warn { font-size:12px; color:#a1a1aa; margin-top:16px; line-height:1.6; }
</style>
</head>
<body>
<main>
  <h1>🔑 Interruptor de la tienda</h1>
  <div class="card">
    <label>Clave maestra (ADMIN_KEY)</label>
    <input type="password" id="key" placeholder="Tu clave maestra" autocomplete="off">
    <label style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" id="remember" style="width:auto;margin:0"> Guardar en este dispositivo
    </label>
    <div class="status off" id="status">Consultando estado…</div>
    <button class="big suspend" id="toggle">⛔ Suspender tienda</button>
    <div class="msg" id="msg"></div>
  </div>
  <div class="warn">Solo el dueño tiene esta clave. Al suspender, los clientes ven "servicio suspendido" y no pueden pedir. /tienda sigue funcionando. Reactivar es instantáneo.</div>
</main>
<script>
const $ = id => document.getElementById(id);
try { const k = localStorage.getItem("portal-admin-key"); if (k) { $("key").value = k; $("remember").checked = true; } } catch (e) {}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("Error " + r.status));
  return j;
}
async function refresh() {
  const key = $("key").value.trim();
  if (!key) { $("status").className = "status off"; $("status").textContent = "Escribe tu clave maestra"; return; }
  try {
    const s = await api("/api/admin/status?key=" + encodeURIComponent(key));
    render(s.suspended);
    $("msg").textContent = "";
  } catch (e) {
    $("status").className = "status off"; $("status").textContent = "Sin acceso — revisa la clave";
    $("msg").textContent = e.message;
  }
}
function render(suspended) {
  const st = $("status"), btn = $("toggle");
  if (suspended) {
    st.className = "status on"; st.textContent = "⛔ TIENDA SUSPENDIDA — los clientes no pueden pedir";
    btn.className = "big reactivate"; btn.textContent = "✅ Reactivar tienda";
  } else {
    st.className = "status off"; st.textContent = "✅ TIENDA ACTIVA — los clientes pueden pedir";
    btn.className = "big suspend"; btn.textContent = "⛔ Suspender tienda";
  }
  btn.dataset.suspended = suspended ? "1" : "0";
}
$("toggle").onclick = async () => {
  const key = $("key").value.trim();
  if (!key) { $("msg").textContent = "Escribe tu clave maestra primero."; return; }
  const to = $("toggle").dataset.suspended !== "1";
  if (to && !confirm("¿Suspender la tienda? Los clientes verán 'servicio suspendido'.")) return;
  $("toggle").disabled = true;
  try {
    const s = await api("/api/admin/suspend", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, suspended: to }) });
    if ($("remember").checked) { try { localStorage.setItem("portal-admin-key", key); } catch (e) {} }
    render(s.suspended);
    $("msg").textContent = s.suspended ? "Tienda suspendida. ⛔" : "Tienda reactivada. ✅";
  } catch (e) { $("msg").textContent = e.message; }
  $("toggle").disabled = false;
};
$("key").addEventListener("change", refresh);
refresh();
</script>
</body>
</html>`;

// Middleware: va ANTES de express.static y de las rutas de cliente.
async function middleware(req, res, next) {
  if (req.path === "/admin" || req.path.startsWith("/api/admin") ||
      req.path.startsWith("/tienda")) {
    return next();
  }
  let s = false;
  try { s = await isSuspended(); } catch (e) { s = false; }
  if (!s) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: "Servicio suspendido temporalmente. / Service temporarily suspended." });
  }
  return res.status(503).send(SUSPENDED_PAGE);
}

function adminConfigured(res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ error: "Admin no configurado (falta ADMIN_KEY)." });
    return false;
  }
  return true;
}

function checkKey(req, res) {
  const k = req.headers["x-admin-key"] || req.query.key || (req.body && req.body.key) || "";
  if (k && safeEqual(k, ADMIN_KEY)) return true;
  res.status(401).json({ error: "No autorizado." });
  return false;
}

function registerAdmin(app) {
  app.get("/admin", (req, res) => res.send(ADMIN_PAGE));
  app.get("/api/admin/status", async (req, res) => {
    if (!adminConfigured(res) || !checkKey(req, res)) return;
    res.json({ suspended: await isSuspended() });
  });
  app.post("/api/admin/suspend", async (req, res) => {
    if (!adminConfigured(res) || !checkKey(req, res)) return;
    await setSuspended(!!req.body.suspended);
    const s = await isSuspended();
    console.log(`[suspend] Tienda ${s ? "SUSPENDIDA ⛔" : "REACTIVADA ✅"}`);
    res.json({ suspended: s });
  });
}

module.exports = { middleware, registerAdmin, isSuspended, setSuspended };
