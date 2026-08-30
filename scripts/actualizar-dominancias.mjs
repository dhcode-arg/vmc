#!/usr/bin/env node
/* Actualiza las series de dominancia con dos llamadas a CoinGecko.
   - datos/dominancias-diario.csv   una fila por día (append)
   - datos/*.csv                    velas semanales OHLC (actualiza la semana en curso)
   Corre desde la raíz del repo. */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://api.coingecko.com/api/v3";
const DIR = "datos";
const D = 86400000;

/* ---------- calibración ---------- */
/* CoinGecko cuenta más monedas en la cola que CRYPTOCAP, así que su market cap total
   es algo mayor y todas las dominancias salen bajas en la misma proporción.
   El factor corrige eso. Medido el 30-ago-2026 contra TradingView. */
const cal = JSON.parse(readFileSync(`${DIR}/calibracion.json`, "utf8"));
const FACTOR = cal.factor;

/* ---------- utilidades ---------- */
const fD = t => new Date(t).toISOString().slice(0, 10);
const lunes = t => { const d = new Date(t); return t - ((d.getUTCDay() + 6) % 7) * D; };
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function traer(url, intentos = 4) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status === 429) { console.log("límite de llamadas, espero 60 s"); await dormir(60000); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === intentos) throw e;
      console.log(`intento ${i} falló (${e.message}), reintento en ${15 * i} s`);
      await dormir(15000 * i);
    }
  }
}

/* ---------- datos del día ---------- */
const g = await traer(`${API}/global`);
const pct = g.data.market_cap_percentage;
const total = g.data.total_market_cap.usd;

await dormir(3000);
const mk = await traer(`${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`);
if (!Array.isArray(mk) || mk.length < 100) throw new Error("el ranking llegó incompleto");

const caps = mk.map(m => m.market_cap || 0).sort((a, b) => b - a);
const top10 = caps.slice(0, 10).reduce((s, x) => s + x, 0);

const dom = ((pct.btc || 0) + (pct.eth || 0) + (pct.usdt || 0) + (pct.usdc || 0)) * FACTOR;
const usdt = (pct.usdt || 0) * FACTOR;
const others = ((total - top10) / total) * 100 * FACTOR;

/* ---------- control de cordura: si algo viene raro, no se escribe nada ---------- */
const rango = (v, a, b, nom) => {
  if (!isFinite(v) || v < a || v > b) throw new Error(`${nom} fuera de rango: ${v}`);
};
rango(dom, 50, 95, "dominancia combinada");
rango(usdt, 0.5, 25, "USDT.D");
rango(others, 2, 35, "OTHERS.D");
if (usdt > dom) throw new Error("USDT.D no puede superar a la dominancia combinada");
if (others > 100 - dom + 0.5) throw new Error("OTHERS.D no puede superar al total de alts");

const hoy = fD(Date.now());
const semana = fD(lunes(Date.now()));
console.log(`${hoy} · combinada ${dom.toFixed(2)} · USDT.D ${usdt.toFixed(3)} · OTHERS.D ${others.toFixed(2)} (factor ${FACTOR})`);

/* ---------- 1. registro diario ---------- */
const diario = `${DIR}/dominancias-diario.csv`;
let lineas = existsSync(diario)
  ? readFileSync(diario, "utf8").trim().split("\n")
  : ["fecha,dominancia_combinada,usdt_d,others_d,factor"];
lineas = lineas.filter(l => !l.startsWith(hoy + ","));   // si ya corrió hoy, se pisa
lineas.push(`${hoy},${dom.toFixed(4)},${usdt.toFixed(4)},${others.toFixed(4)},${FACTOR}`);
writeFileSync(diario, lineas.join("\n") + "\n");

/* ---------- 2. velas semanales ---------- */
function actualizarSemanal(archivo, valor, dec) {
  const ruta = `${DIR}/${archivo}`;
  const txt = readFileSync(ruta, "utf8").trim();
  const filas = txt.split("\n");
  const cab = filas[0];
  const cuerpo = filas.slice(1);
  const v = +valor.toFixed(dec);
  const ultima = cuerpo[cuerpo.length - 1].split(",");

  if (ultima[0] === semana) {
    // la semana ya existe: se actualizan máximo, mínimo y cierre
    const o = +ultima[1], h = Math.max(+ultima[2], v), l = Math.min(+ultima[3], v);
    cuerpo[cuerpo.length - 1] = [semana, o.toFixed(dec), h.toFixed(dec), l.toFixed(dec), v.toFixed(dec), "coingecko"].join(",");
  } else if (ultima[0] < semana) {
    // semana nueva: abre en el cierre de la anterior
    const o = +ultima[4];
    cuerpo.push([semana, o.toFixed(dec), Math.max(o, v).toFixed(dec), Math.min(o, v).toFixed(dec), v.toFixed(dec), "coingecko"].join(","));
  } else {
    throw new Error(`${archivo}: la última fila (${ultima[0]}) es posterior a la semana actual (${semana})`);
  }
  writeFileSync(ruta, [cab, ...cuerpo].join("\n") + "\n");
  console.log(`  ${archivo}: semana ${semana} → ${v}`);
}

actualizarSemanal("dominancia-combinada.csv", dom, 2);
actualizarSemanal("usdt-dominancia.csv", usdt, 3);
actualizarSemanal("others-dominancia.csv", others, 2);

console.log("listo");
