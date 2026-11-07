# Fade Factory — Booking

Online booking for **Fade Factory Barber Shop** (Cutler Bay, Miami, FL) —
Rafael "Rawfy" Santos, Licensed Master Barber.

- Customer booking page: `/` — pick services, day & time; bookings land
  pending until the shop confirms them; clients track their booking status.
- Back office: `/store` (STORE_KEY) — bookings board, catalog, schedule.
- Owner kill switch: `/admin` (ADMIN_KEY).

Stack: Node + Express, Postgres (Neon) via DATABASE_URL or local SQLite.
Deployed on Render (free tier) from render.yaml Blueprint.
