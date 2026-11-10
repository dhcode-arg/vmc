// Registro diario Smart Money · lógica pura (sin acceso a disco).
// Corre igual en Node (GitHub Actions) y en el navegador: recibe fetch por parámetro.

export const API = 'https://api.hyperliquid.xyz/info';
export const LB = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
export const CORE_COINS = ['BTC', 'ETH', 'SOL', 'HYPE'];
// Criterio de evaluación del ecosistema VMC: objetivo +8 %, stop −6 %, 30 velas diarias.
export const CRIT = { tp: 0.08, sl: 0.06, maxBars: 30, fillDays: 5, minMuestra: 20 };
const DAY = 86400000;

/* ---------- motor: se toma de smart-money.html, única fuente de verdad ---------- */
export function loadEngine(html) {
  const m = String(html).match(/<script id="sm-engine">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No se encontró el motor (script sm-engine) en smart-money.html');
  const mod = { exports: {} };
  new Function('module', 'window', m[1])(mod, undefined);
  const SM = mod.exports;
  if (!SM || typeof SM.buildSetups !== 'function') throw new Error('El motor de smart-money.html no es válido');
  const v = String(html).match(/<title>[^<]*v(\d+\.\d+)[^<]*<\/title>/);
  SM.__version = v ? v[1] : 'desconocida';
  return SM;
}

/* ---------- cliente con limitador por peso (límite real de Hyperliquid: 1.200/min) ---------- */
const WEIGHTS = { allMids: 2, clearinghouseState: 2, frontendOpenOrders: 20, candleSnapshot: 60 };
const realSleep = ms => new Promise(r => setTimeout(r, ms));

export function makeClient(fetchImpl, opts = {}) {
  const budget = opts.budget || 1100, windowMs = opts.windowMs || 60000;
  const now = opts.now || (() => Date.now()), sleep = opts.sleep || realSleep;
  const log = []; let usedTotal = 0;
  async function take(w) {
    for (;;) {
      const t = now();
      while (log.length && t - log[0][0] >= windowMs) log.shift();
      const used = log.reduce((a, x) => a + x[1], 0);
      if (used + w <= budget) { log.push([t, w]); usedTotal += w; return; }
      await sleep(Math.max(50, windowMs - (t - log[0][0]) + 50));
    }
  }
  async function getJSON(url, init, w) {
    let last;
    for (let i = 0; i < 4; i++) {
      if (w) await take(w);
      try {
        const r = await fetchImpl(url, init);
        if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); await sleep(2000 * 2 ** i); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { last = e; if (i < 3) await sleep(1000 * 2 ** i); }
    }
    throw last || new Error('error de red');
  }
  return {
    info: body => getJSON(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, WEIGHTS[body.type] || 20),
    leaderboard: () => getJSON(LB, {}, 0),
    pesoUsado: () => usedTotal
  };
}

const r2 = (x, d = 2) => (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;
const sig = x => (x === null || x === undefined || !isFinite(x)) ? null : Number(x.toPrecision(7));

/* ---------- foto del día ---------- */
export async function collect({ client, SM, topN = 50, extraCoins = 5, now = new Date() }) {
  const lb = await client.leaderboard();
  const rows = (lb && lb.leaderboardRows) || [];
  if (!rows.length) throw new Error('El leaderboard llegó vacío');
  const wallets = SM.selectWallets(rows, { topN });
  const mids = await client.info({ type: 'allMids' });
  if (!mids || !mids.BTC) throw new Error('Precios (allMids) inválidos');
  const positions = [], ordersBy = {}, errores = [];
  let i = 0;
  async function worker() {
    while (i < wallets.length) {
      const w = wallets[i++];
      try {
        const st = await client.info({ type: 'clearinghouseState', user: w.addr });
        const has = !!(st && Array.isArray(st.assetPositions) && st.assetPositions.length);
        const oo = has ? await client.info({ type: 'frontendOpenOrders', user: w.addr }) : [];
        ordersBy[w.addr] = oo || [];
        positions.push(...SM.parsePositions(w, st, oo, mids));
      } catch (e) { errores.push(w.addr); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (errores.length > wallets.length / 2) throw new Error('Más de la mitad de las billeteras no respondió (' + errores.length + ')');

  const agg = SM.aggregate(positions);
  const sum = SM.summarize(wallets, positions, ordersBy);
  const coins = [...new Set([...CORE_COINS, ...agg.slice(0, extraCoins).map(a => a.coin)])];
  const senales = coins.map(coin => {
    const row = agg.find(a => a.coin === coin);
    const res = SM.buildSetups(row, positions);
    const precio = row ? row.mark : SM.num(mids[coin]);
    const rec = res.state === 'ok' ? res.setups.find(s => s.key === res.recommended) : null;
    return {
      coin, precio: sig(precio), estado: res.state,
      dominante: res.dominant || null, share: r2(res.share, 4), pivote: sig(res.pivot),
      recomendado: res.recommended || null, direccion: rec ? rec.dir : null,
      longPct: row ? r2(row.longPct) : null, neto: row ? Math.round(row.net) : null,
      billeterasL: row ? row.wL : 0, billeterasS: row ? row.wS : 0, apalancamiento: row ? r2(row.lev, 1) : null,
      escenarios: res.state === 'ok' ? res.setups.map(s => ({
        clave: s.key, dir: s.dir, estado: s.status, conf: s.conf,
        entrada: sig(s.lv.entry), stop: sig(s.lv.stop), tp1: sig(s.lv.tp1), tp2: sig(s.lv.tp2),
        rr1: r2(s.lv.rr1), rr2: r2(s.lv.rr2), errores: s.errors
      })) : []
    };
  });
  return {
    v: 1, fecha: now.toISOString().slice(0, 10), ts: now.toISOString(), motor: SM.__version,
    rankingTotal: rows.length, billeteras: wallets.length, conPosicion: sum.nWithPos, posiciones: positions.length,
    errores: errores.length, shortPct: r2(sum.shortPct), apalancamiento: r2(sum.levW, 1), conTpSl: sum.nWithTrig, conSalida: sum.nWithExit,
    pesoApi: client.pesoUsado ? client.pesoUsado() : null,
    senales,
    agregados: agg.slice(0, 15).map(a => ({ coin: a.coin, notional: Math.round(a.gross), longPct: r2(a.longPct), neto: Math.round(a.net), lev: r2(a.lev, 1), wL: a.wL, wS: a.wS, entradaL: sig(a.entryL), entradaS: sig(a.entryS), precio: sig(a.mark), pnl: Math.round(a.upnl) }))
  };
}

/* agrega o reemplaza la foto del día (idempotente si el Action corre dos veces) */
export function upsertRegistro(lineas, registro) {
  const out = lineas.filter(r => r && r.fecha !== registro.fecha);
  out.push(registro);
  out.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
  return out;
}
export const parseJSONL = txt => String(txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
export const toJSONL = arr => arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : '');

/* ---------- velas ---------- */
export function normCandles(raw) {
  return (Array.isArray(raw) ? raw : []).map(c => ({ t: +c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
    .filter(c => isFinite(c.t) && c.h > 0 && c.l > 0 && c.h >= c.l).sort((a, b) => a.t - b.t);
}
export async function fetchCandles(client, coin, startMs, endMs) {
  return normCandles(await client.info({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: startMs, endTime: endMs } }));
}
const desde = (candles, ms) => { const d0 = Math.floor(ms / DAY) * DAY; return candles.filter(c => c.t >= d0); };

/* Señal direccional con el criterio del ecosistema: desde el precio de la foto, ¿qué toca primero,
   +8 % a favor o −6 % en contra, dentro de 30 velas diarias? Si ambos caen en la misma vela no se
   puede saber el orden: se cuenta como pérdida (criterio conservador) y se marca ambigua. */
export function evalDirectional(dir, ref, startMs, candles, crit = CRIT) {
  if (!(dir === 'L' || dir === 'S') || !(ref > 0)) return { resultado: 'sin_senal' };
  const bars = desde(candles, startMs).slice(0, crit.maxBars);
  const tpPx = dir === 'L' ? ref * (1 + crit.tp) : ref * (1 - crit.tp);
  const slPx = dir === 'L' ? ref * (1 - crit.sl) : ref * (1 + crit.sl);
  for (let k = 0; k < bars.length; k++) {
    const b = bars[k];
    const tp = dir === 'L' ? b.h >= tpPx : b.l <= tpPx;
    const sl = dir === 'L' ? b.l <= slPx : b.h >= slPx;
    if (tp && sl) return { resultado: 'perdida', dias: k + 1, ambigua: true };
    if (sl) return { resultado: 'perdida', dias: k + 1 };
    if (tp) return { resultado: 'ganada', dias: k + 1 };
  }
  if (bars.length >= crit.maxBars) {
    const last = bars[crit.maxBars - 1].c;
    return { resultado: 'vencida', dias: crit.maxBars, retorno: r2((dir === 'L' ? last / ref - 1 : 1 - last / ref) * 100) };
  }
  return { resultado: 'abierta', dias: bars.length };
}

/* Plan exacto de la operación sugerida activa: entrada límite (5 velas para tomarse),
   después TP1 o stop. En la vela en que se toma la entrada el stop cuenta pero el TP1 no,
   porque no se sabe si ocurrió antes de entrar (conservador). */
export function evalPlan(esc, startMs, candles, crit = CRIT) {
  if (!esc || esc.estado !== 'activo') return { resultado: 'sin_plan' };
  const { dir, entrada, stop, tp1, rr1 } = esc;
  if (!(entrada > 0 && stop > 0 && tp1 > 0)) return { resultado: 'sin_plan' };
  const bars = desde(candles, startMs);
  let fill = -1;
  for (let k = 0; k < Math.min(crit.fillDays, bars.length); k++) if (bars[k].l <= entrada && entrada <= bars[k].h) { fill = k; break; }
  if (fill < 0) return { resultado: bars.length >= crit.fillDays ? 'no_entro' : 'pendiente' };
  const risk = Math.abs(entrada - stop);
  const after = bars.slice(fill, fill + crit.maxBars);
  for (let k = 0; k < after.length; k++) {
    const b = after[k];
    const hitSl = dir === 'L' ? b.l <= stop : b.h >= stop;
    const hitTp = k > 0 && (dir === 'L' ? b.h >= tp1 : b.l <= tp1);
    if (hitSl) return { resultado: 'stop', dias: fill + k + 1, R: -1, ambigua: hitTp };
    if (hitTp) return { resultado: 'tp1', dias: fill + k + 1, R: r2(rr1) };
  }
  if (after.length >= crit.maxBars) {
    const last = after[crit.maxBars - 1].c;
    return { resultado: 'vencida', dias: fill + crit.maxBars, R: r2((dir === 'L' ? last - entrada : entrada - last) / risk) };
  }
  return { resultado: 'abierta', dias: fill + after.length };
}

/* intervalo de confianza 95 % de Wilson para una proporción */
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [r2((c - m) / d * 100, 1), r2((c + m) / d * 100, 1)];
}

/* ---------- evaluación de todo el registro ---------- */
export function evaluate(registro, candlesByCoin, crit = CRIT) {
  const filas = [];
  const prev = {};
  for (const r of registro) {
    const t0 = Date.parse(r.ts);
    for (const s of r.senales || []) {
      const cs = candlesByCoin[s.coin] || [];
      const nueva = !!s.direccion && prev[s.coin] !== s.direccion;
      prev[s.coin] = s.direccion || null;
      if (!s.direccion) { filas.push({ fecha: r.fecha, coin: s.coin, metodo: 'direccional', direccion: '', precio: s.precio, nueva: false, resultado: 'sin_senal' }); continue; }
      const d = evalDirectional(s.direccion, s.precio, t0, cs, crit);
      filas.push({ fecha: r.fecha, coin: s.coin, metodo: 'direccional', direccion: s.direccion, escenario: s.recomendado, precio: s.precio, nueva, ...d });
      const esc = (s.escenarios || []).find(e => e.clave === s.recomendado);
      const p = evalPlan(esc, t0, cs, crit);
      filas.push({ fecha: r.fecha, coin: s.coin, metodo: 'plan', direccion: s.direccion, escenario: s.recomendado, precio: s.precio, nueva, entrada: esc && esc.entrada, stop: esc && esc.stop, tp1: esc && esc.tp1, rr1: esc && esc.rr1, ...p });
    }
  }
  return filas;
}

function bloque(filas, ganan, pierden, breakeven, crit) {
  const g = filas.filter(f => ganan.includes(f.resultado)).length;
  const p = filas.filter(f => pierden.includes(f.resultado)).length;
  const n = g + p;
  const out = {
    resueltas: n, ganadas: g, perdidas: p,
    vencidas: filas.filter(f => f.resultado === 'vencida').length,
    abiertas: filas.filter(f => f.resultado === 'abierta' || f.resultado === 'pendiente').length,
    ambiguas: filas.filter(f => f.ambigua).length,
    acierto: n ? r2(g / n * 100, 1) : null, ic95: wilson(g, n), equilibrio: r2(breakeven * 100, 1),
    muestraSuficiente: n >= crit.minMuestra
  };
  const R = filas.filter(f => typeof f.R === 'number');
  if (R.length) out.Rpromedio = r2(R.reduce((a, f) => a + f.R, 0) / R.length);
  return out;
}

export function summarize(filas, crit = CRIT) {
  const dir = filas.filter(f => f.metodo === 'direccional' && f.resultado !== 'sin_senal');
  const plan = filas.filter(f => f.metodo === 'plan' && f.resultado !== 'sin_plan');
  const breakevenDir = crit.sl / (crit.tp + crit.sl);
  const rrs = plan.filter(f => f.rr1 > 0).map(f => f.rr1);
  const breakevenPlan = rrs.length ? 1 / (1 + rrs.reduce((a, b) => a + b, 0) / rrs.length) : null;
  const porCoin = {};
  for (const c of [...new Set(dir.map(f => f.coin))]) porCoin[c] = bloque(dir.filter(f => f.coin === c), ['ganada'], ['perdida'], breakevenDir, crit);
  return {
    criterio: crit,
    direccionalTodas: bloque(dir, ['ganada'], ['perdida'], breakevenDir, crit),
    direccionalNuevas: bloque(dir.filter(f => f.nueva), ['ganada'], ['perdida'], breakevenDir, crit),
    plan: Object.assign(bloque(plan, ['tp1'], ['stop'], breakevenPlan || 0, crit), { noEntro: plan.filter(f => f.resultado === 'no_entro').length }),
    porCoin
  };
}

export function resumenMarkdown(res, meta) {
  const fila = (nombre, b) => `| ${nombre} | ${b.resueltas} | ${b.acierto === null ? '—' : b.acierto + ' %'} | ${b.ic95[0] === null ? '—' : b.ic95[0] + ' – ' + b.ic95[1] + ' %'} | ${b.equilibrio} % | ${b.abiertas} | ${b.muestraSuficiente ? 'sí' : 'no (mín. ' + res.criterio.minMuestra + ')'} |`;
  const L = [];
  L.push('# Smart Money · track record', '');
  L.push(`Actualizado ${meta.actualizado} · ${meta.dias} días registrados (desde ${meta.desde}) · motor v${meta.motor}`, '');
  L.push(`Criterio: objetivo +${res.criterio.tp * 100} %, stop −${res.criterio.sl * 100} %, ${res.criterio.maxBars} velas diarias. Si objetivo y stop caen en la misma vela, cuenta como pérdida.`, '');
  L.push('| Medición | Resueltas | Acierto | Rango probable (95 %) | Necesario para no perder | Abiertas | Muestra suficiente |', '|---|---|---|---|---|---|---|');
  L.push(fila('Dirección sugerida, todos los días', res.direccionalTodas));
  L.push(fila('Dirección sugerida, solo cuando cambia', res.direccionalNuevas));
  L.push(fila('Plan exacto (entrada → TP1 o stop)', res.plan));
  L.push('', '## Por activo (dirección, todos los días)', '', '| Activo | Resueltas | Acierto | Rango probable (95 %) |', '|---|---|---|---|');
  for (const [c, b] of Object.entries(res.porCoin)) L.push(`| ${c} | ${b.resueltas} | ${b.acierto === null ? '—' : b.acierto + ' %'} | ${b.ic95[0] === null ? '—' : b.ic95[0] + ' – ' + b.ic95[1] + ' %'} |`);
  L.push('', 'Lectura: el acierto sirve si el rango probable completo queda por encima del "necesario para no perder". Con menos de ' + res.criterio.minMuestra + ' operaciones resueltas el número todavía no dice nada.', '');
  L.push('Ojo con "todos los días": días seguidos con la misma señal se solapan y no son independientes; la fila "solo cuando cambia" es la más honesta.');
  return L.join('\n') + '\n';
}

export function toCSV(filas) {
  const cols = ['fecha', 'coin', 'metodo', 'direccion', 'escenario', 'nueva', 'precio', 'entrada', 'stop', 'tp1', 'rr1', 'resultado', 'dias', 'ambigua', 'retorno', 'R'];
  // separador ';' y coma decimal: se abre directo en Excel en español
  const esc = v => v === undefined || v === null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : typeof v === 'boolean' ? (v ? 'sí' : 'no') : String(v).includes(';') ? '"' + String(v) + '"' : String(v);
  return cols.join(';') + '\n' + filas.map(f => cols.map(c => esc(f[c])).join(';')).join('\n') + '\n';
}
