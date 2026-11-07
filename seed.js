// ============================================================
// Fade Factory Barber Shop — Cutler Bay (Rafael "Rawfy" Santos)
// Semilla: menú de CITAS (pizarra de precios del local, 11/7/2026)
// + ajustes de agenda. La fusión es aditiva: lo que el dueño
// edite en /store nunca se sobrescribe (ver mergeCatalog en db.js).
// Precios de lanzamiento = precios de la pizarra (citas):
// Men $35 · Corte+Barba $40 · Corte+Barba+Cejas $45 · Niños $25.
// ============================================================

const CATALOG_VERSION = 3;

const SEED_CATALOG = {
  departments: [
    {
      id: "haircuts", name: "Haircuts & Combos", nameEs: "Cortes y combos", img: "", categories: [
        { id: "haircuts-main", name: "Haircuts & Combos", items: [
          { id: "haircut", name: "Haircut", nameEs: "Corte de cabello", price: 35, mins: 45, unit: "service", desc: "By appointment", img: "", active: true },
          { id: "haircut-beard", name: "Haircut + Beard", nameEs: "Corte + barba", price: 40, mins: 60, unit: "service", desc: "By appointment", img: "", active: true },
          { id: "haircut-beard-brows", name: "Haircut + Beard + Eyebrows", nameEs: "Corte + barba + cejas", price: 45, mins: 75, unit: "service", desc: "By appointment", img: "", active: true }
        ] }
      ]
    },
    {
      id: "kids", name: "Kids", nameEs: "Niños", img: "", categories: [
        { id: "kids-main", name: "Kids", items: [
          { id: "kids-haircut", name: "Kids Haircut", nameEs: "Corte de niños", price: 25, mins: 40, unit: "service", desc: "By appointment", img: "", active: true },
          { id: "kids-fade", name: "Kids Fade", nameEs: "Fade de niños", price: 25, mins: 40, unit: "service", desc: "", img: "", active: true }
        ] }
      ]
    },
    {
      id: "tapes", name: "Tapes & Designs", nameEs: "Delineados y diseños", img: "", categories: [
        { id: "tapes-main", name: "Tapes & Designs", items: [
          { id: "tape", name: "Tape (Line-Up)", nameEs: "Delineado (tape)", price: 12, mins: 30, unit: "service", desc: "", img: "", active: true },
          { id: "tape-beard", name: "Tape + Beard", nameEs: "Delineado + barba", price: 20, mins: 45, unit: "service", desc: "", img: "", active: true },
          { id: "tape-beard-brows", name: "Tape + Beard + Eyebrows", nameEs: "Delineado + barba + cejas", price: 25, mins: 50, unit: "service", desc: "", img: "", active: true },
          { id: "designs", name: "Designs", nameEs: "Diseños", price: 0, mins: 30, unit: "service", desc: "Price set at the chair — every design is different", img: "", active: true }
        ] }
      ]
    }
  ]
};

// Ajustes de agenda editables en /store:
// openDays: 0=domingo ... 6=sábado. Martes CERRADO (día libre de Rafi).
// Horario 9 AM–7 PM: slots cada hora, último a las 6 PM (el corte
// termina antes del cierre). capacity: sillas por horario.
const SEED_SETTINGS = {
  openDays: [0, 1, 3, 4, 5, 6],
  slots: ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM", "6:00 PM"],
  capacity: 2,
  version: 1
};

const SETTINGS_VERSION = 1;

module.exports = { SEED_CATALOG, CATALOG_VERSION, SEED_SETTINGS, SETTINGS_VERSION };
