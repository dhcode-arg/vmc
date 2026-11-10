// node --test scripts/smart-money/registro.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import { main as registrar } from './registrar.mjs';
import { main as evaluar } from './evaluar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 9, 0, 20); // 09/11/2026 00:20 UTC
const bar = (d, o, h, l, c) => ({ t: Date.UTC(2026, 10, 9) + d * DAY, o, h, l, c });

/* ---------- evaluación direccional ---------- */
test('direccional long: toca +8 % primero → ganada', () => {
  const cs = [bar(0, 100, 103, 99, 102), bar(1, 102, 108.5, 101, 108)];
  assert.deepEqual(L.evalDirectional('L', 100, T0, cs), { resultado: 'ganada', dias: 2 });
});
test('direccional long: toca −6 % primero → perdida', () => {
  const cs = [bar(0, 100, 101, 93.9, 95)];
  assert.deepEqual(L.evalDirectional('L', 100, T0, cs), { resultado: 'perdida', dias: 1 });
});
test('direccional short: espejo', () => {
  assert.equal(L.evalDirectional('S', 100, T0, [bar(0, 100, 101, 91.9, 92)]).resultado, 'ganada');
  assert.equal(L.evalDirectional('S', 100, T0, [bar(0, 100, 106.1, 99, 105)]).resultado, 'perdida');
});
test('direccional: objetivo y stop en la misma vela → pérdida y se marca ambigua', () => {
  assert.deepEqual(L.evalDirectional('L', 100, T0, [bar(0, 100, 109, 93, 100)]), { resultado: 'perdida', dias: 1, ambigua: true });
});
test('direccional: 30 velas sin tocar nada → vencida con retorno', () => {
  const cs = Array.from({ length: 35 }, (_, i) => bar(i, 100, 103, 97, i === 29 ? 102.5 : 100));
  assert.deepEqual(L.evalDirectional('L', 100, T0, cs), { resultado: 'vencida', dias: 30, retorno: 2.5 });
  assert.equal(L.evalDirectional('S', 100, T0, cs).retorno, -2.5);
});
test('direccional: menos de 30 velas y sin resultado → abierta', () => {
  assert.deepEqual(L.evalDirectional('L', 100, T0, [bar(0, 100, 101, 99, 100)]), { resultado: 'abierta', dias: 1 });
});
test('direccional: ignora velas anteriores a la foto', () => {
  const cs = [bar(-3, 100, 200, 50, 100), bar(0, 100, 101, 99, 100)];
  assert.equal(L.evalDirectional('L', 100, T0, cs).resultado, 'abierta');
});
test('direccional: sin dirección o precio inválido → sin_senal', () => {
  assert.equal(L.evalDirectional(null, 100, T0, []).resultado, 'sin_senal');
  assert.equal(L.evalDirectional('L', 0, T0, []).resultado, 'sin_senal');
});

/* ---------- plan exacto ---------- */
const shortPlan = { clave: 'follow', dir: 'S', estado: 'activo', entrada: 102, stop: 104, tp1: 98, rr1: 2 };
test('plan short: entra, después TP1', () => {
  const cs = [bar(0, 100, 101, 99, 100), bar(1, 100, 102.5, 100, 101), bar(2, 101, 101, 97.5, 98)];
  assert.deepEqual(L.evalPlan(shortPlan, T0, cs), { resultado: 'tp1', dias: 3, R: 2 });
});
test('plan: en la vela de entrada el TP1 no cuenta (no se sabe si fue antes)', () => {
  const cs = [bar(0, 100, 102.5, 97, 99)];
  assert.equal(L.evalPlan(shortPlan, T0, cs).resultado, 'abierta');
});
test('plan: stop en la vela de entrada sí cuenta', () => {
  assert.deepEqual(L.evalPlan(shortPlan, T0, [bar(0, 100, 104.5, 99, 104)]), { resultado: 'stop', dias: 1, R: -1, ambigua: false });
});
test('plan: no toca la entrada en 5 velas → no_entro; con menos velas → pendiente', () => {
  const cs = Array.from({ length: 5 }, (_, i) => bar(i, 100, 101, 99, 100));
  assert.equal(L.evalPlan(shortPlan, T0, cs).resultado, 'no_entro');
  assert.equal(L.evalPlan(shortPlan, T0, cs.slice(0, 3)).resultado, 'pendiente');
});
test('plan: vencido calcula R por cierre', () => {
  const cs = [bar(0, 100, 102.5, 100, 102)].concat(Array.from({ length: 31 }, (_, i) => bar(i + 1, 101, 103, 99, 101)));
  assert.deepEqual(L.evalPlan(shortPlan, T0, cs), { resultado: 'vencida', dias: 30, R: 0.5 });
});
test('plan long y escenario no activo', () => {
  const longPlan = { clave: 'squeeze', dir: 'L', estado: 'activo', entrada: 100, stop: 98, tp1: 103, rr1: 1.5 };
  assert.equal(L.evalPlan(longPlan, T0, [bar(0, 101, 101, 99.5, 100), bar(1, 100, 103.2, 99, 103)]).resultado, 'tp1');
  assert.equal(L.evalPlan({ ...longPlan, estado: 'espera' }, T0, []).resultado, 'sin_plan');
  assert.equal(L.evalPlan(undefined, T0, []).resultado, 'sin_plan');
});

/* ---------- estadística ---------- */
test('Wilson 95 % con valores de referencia', () => {
  assert.deepEqual(L.wilson(7, 10), [39.7, 89.2]);
  assert.deepEqual(L.wilson(0, 0), [null, null]);
  const [lo, hi] = L.wilson(50, 100); assert.ok(lo < 50 && hi > 50);
});

const reg = (fecha, dir, precio = 100, rec = 'follow') => ({
  fecha, ts: fecha + 'T00:20:00.000Z',
  senales: [{ coin: 'BTC', precio, direccion: dir, recomendado: dir ? rec : null,
    escenarios: dir ? [{ clave: rec, dir, estado: 'activo', entrada: precio, stop: dir === 'S' ? precio * 1.02 : precio * 0.98, tp1: dir === 'S' ? precio * 0.96 : precio * 1.04, rr1: 2 }] : [] }]
});
test('evaluate: marca "nueva" solo cuando cambia la dirección', () => {
  const r = [reg('2026-11-01', 'S'), reg('2026-11-02', 'S'), reg('2026-11-03', 'L'), reg('2026-11-04', null), reg('2026-11-05', 'L')];
  const f = L.evaluate(r, { BTC: [] }).filter(x => x.metodo === 'direccional');
  assert.deepEqual(f.map(x => x.nueva), [true, false, true, false, true]);
  assert.equal(f[3].resultado, 'sin_senal');
});
test('summarize: equilibrio 42,9 % con +8/−6 y aviso de muestra chica', () => {
  const s = L.summarize(L.evaluate([reg('2026-11-01', 'S')], { BTC: [] }));
  assert.equal(s.direccionalTodas.equilibrio, 42.9);
  assert.equal(s.direccionalTodas.muestraSuficiente, false);
  assert.equal(s.plan.equilibrio, 33.3); // 1 / (1 + 2)
});
test('summarize: cuenta ganadas/perdidas y calcula acierto', () => {
  const filas = [
    ...Array(6).fill({ metodo: 'direccional', coin: 'BTC', resultado: 'ganada', nueva: true }),
    ...Array(4).fill({ metodo: 'direccional', coin: 'BTC', resultado: 'perdida', nueva: false }),
    { metodo: 'direccional', coin: 'BTC', resultado: 'abierta' }
  ];
  const s = L.summarize(filas);
  assert.equal(s.direccionalTodas.acierto, 60); assert.equal(s.direccionalTodas.abiertas, 1);
  assert.equal(s.direccionalNuevas.resueltas, 6); assert.equal(s.direccionalNuevas.acierto, 100);
});

/* ---------- registro ---------- */
test('upsert: el mismo día reemplaza (idempotente), otro día agrega y ordena', () => {
  let a = L.upsertRegistro([], { fecha: '2026-11-09', x: 1 });
  a = L.upsertRegistro(a, { fecha: '2026-11-09', x: 2 });
  a = L.upsertRegistro(a, { fecha: '2026-11-08', x: 3 });
  assert.deepEqual(a.map(r => [r.fecha, r.x]), [['2026-11-08', 3], ['2026-11-09', 2]]);
  assert.equal(L.parseJSONL('{"a":1}\nbasura\n\n{"b":2}\n').length, 2);
});
test('motor ausente en el HTML → error claro', () => {
  assert.throws(() => L.loadEngine('<html></html>'), /No se encontró el motor/);
});

/* ---------- API simulada ---------- */
const MIDS = { BTC: '75440.5', ETH: '2143.15', SOL: '87.7555', HYPE: '76.2805', ZEC: '1227.85' };
const lbRow = (a, av, m, at, v) => ({ ethAddress: a, accountValue: String(av), displayName: null, windowPerformances: [['month', { pnl: String(m), roi: '0.3', vlm: String(v) }], ['allTime', { pnl: String(at), roi: '0', vlm: '0' }]] });
const ap = (coin, szi, entry, lev = 5) => ({ type: 'oneWay', position: { coin, szi: String(szi), entryPx: String(entry), positionValue: String(Math.abs(szi) * +MIDS[coin]), unrealizedPnl: '0', returnOnEquity: '0', leverage: { type: 'cross', value: lev }, liquidationPx: null } });
function world() {
  return {
    lb: [lbRow('0xa', 1e8, 1e8, 5e7, 1e9), lbRow('0xb', 8e7, 8e7, 4e7, 1e9), lbRow('0xc', 6e6, 9e6, 2e6, 1e8), lbRow('0xd', 2e7, 2e7, 5e6, 1e8), lbRow('0xe', 3e6, 1e6, 1e6, 1e7)],
    states: {
      '0xa': { assetPositions: [ap('BTC', -2354.6, 76390.2), ap('ETH', -58093, 2322.72), ap('ZEC', -10000, 1335)] },
      '0xb': { assetPositions: [ap('BTC', -2089.7, 77924.2), ap('HYPE', -965150, 75.28)] },
      '0xc': { assetPositions: [ap('BTC', -86.45, 77174.1, 40)] },
      '0xd': { assetPositions: [ap('ETH', 100, 2000)] },
      '0xe': { assetPositions: [] }
    },
    orders: { '0xc': [{ coin: 'BTC', side: 'B', limitPx: '73954.3', sz: '8.645', isTrigger: false }] },
    candles: { BTC: [], ETH: [], SOL: [], HYPE: [], ZEC: [] },
    down: new Set(), calls: { lb: 0, info: {} }
  };
}
function fakeFetch(w) {
  return async (url, init) => {
    const ok = b => ({ ok: true, status: 200, json: async () => b });
    if (url === L.LB) { w.calls.lb++; return ok({ leaderboardRows: w.lb }); }
    const b = JSON.parse(init.body); w.calls.info[b.type] = (w.calls.info[b.type] || 0) + 1;
    if (b.type === 'allMids') return ok(MIDS);
    if (b.type === 'clearinghouseState') { if (w.down.has(b.user)) return { ok: false, status: 503, json: async () => ({}) }; return ok(w.states[b.user] || { assetPositions: [] }); }
    if (b.type === 'frontendOpenOrders') return ok(w.orders[b.user] || []);
    if (b.type === 'candleSnapshot') return ok(w.candles[b.req.coin] || []);
    return { ok: false, status: 400, json: async () => ({}) };
  };
}
const quick = { sleep: async () => {} };

test('collect: foto con BTC short activo, TP1 anclado a la salida real y peso de API correcto', async () => {
  const SM = L.loadEngine(await readFile(path.join(ROOT, 'smart-money.html'), 'utf8'));
  const w = world();
  const client = L.makeClient(fakeFetch(w), quick);
  const r = await L.collect({ client, SM, now: new Date(T0) });
  assert.equal(r.fecha, '2026-11-09'); assert.equal(r.billeteras, 5); assert.equal(r.conPosicion, 4);
  const btc = r.senales.find(s => s.coin === 'BTC');
  assert.equal(btc.direccion, 'S'); assert.equal(btc.recomendado, 'follow'); assert.equal(btc.dominante, 'S');
  const f = btc.escenarios.find(e => e.clave === 'follow');
  assert.equal(f.estado, 'activo'); assert.equal(f.tp1, 73950); assert.deepEqual(f.errores, []);
  assert.deepEqual(r.senales.map(s => s.coin), ['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC'], 'activos base + los de más notional');
  assert.equal(r.senales.find(s => s.coin === 'SOL').estado, 'none', 'SOL sin posiciones: sin operación');
  assert.equal(r.senales.find(s => s.coin === 'SOL').precio, 87.7555, 'pero con precio');
  assert.equal(r.pesoApi, 2 + 5 * 2 + 4 * 20);
  assert.equal(r.motor, '1.4');
});

test('collect: si más de la mitad de las billeteras falla, aborta (no guarda una foto mala)', async () => {
  const SM = L.loadEngine(await readFile(path.join(ROOT, 'smart-money.html'), 'utf8'));
  const w = world(); ['0xa', '0xb', '0xc'].forEach(a => w.down.add(a));
  await assert.rejects(L.collect({ client: L.makeClient(fakeFetch(w), quick), SM }), /Más de la mitad/);
});

test('limitador: 80 consultas de peso 20 nunca superan 1.100 por minuto', async () => {
  let t = 0; const stamps = [];
  const client = L.makeClient(async () => { stamps.push(t); return { ok: true, status: 200, json: async () => ({}) }; }, { now: () => t, sleep: async ms => { t += ms; } });
  for (let i = 0; i < 80; i++) await client.info({ type: 'frontendOpenOrders', user: 'x' });
  for (const s0 of stamps) assert.ok(stamps.filter(s => s >= s0 && s < s0 + 60000).length * 20 <= 1100);
  assert.ok(t >= 60000, 'tuvo que esperar');
});

/* ---------- de punta a punta en una carpeta temporal ---------- */
async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'smrepo-'));
  await cp(path.join(ROOT, 'smart-money.html'), path.join(dir, 'smart-money.html'));
  return dir;
}

test('registrar + evaluar: archivos, idempotencia del día y track record', async () => {
  const root = await tempRepo(); const w = world(); const silent = () => {};
  await registrar({ root, fetchImpl: fakeFetch(w), now: new Date(T0), clientOpts: quick, log: silent });
  await registrar({ root, fetchImpl: fakeFetch(w), now: new Date(T0 + 3600e3), clientOpts: quick, log: silent }); // mismo día, re-corrida
  let lines = (await readFile(path.join(root, 'datos/smart-money/registro.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'la re-corrida del mismo día no duplica');
  await registrar({ root, fetchImpl: fakeFetch(w), now: new Date(T0 + DAY), clientOpts: quick, log: silent });
  lines = (await readFile(path.join(root, 'datos/smart-money/registro.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);

  // BTC baja 9 % al tercer día: el short del día 1 gana; la foto del día 2 también
  w.candles.BTC = [0, 1, 2, 3].map(d => ({ t: String(Date.UTC(2026, 10, 9) + d * DAY), o: '75440', h: d === 2 ? '75500' : '76000', l: d === 2 ? '68500' : '75000', c: '75400' }));
  const out = await evaluar({ root, fetchImpl: fakeFetch(w), now: new Date(T0 + 4 * DAY), clientOpts: quick, log: silent });
  const btcDir = out.filas.filter(f => f.coin === 'BTC' && f.metodo === 'direccional');
  assert.deepEqual(btcDir.map(f => f.resultado), ['ganada', 'ganada']);
  assert.deepEqual(btcDir.map(f => f.nueva), [true, false]);
  const files = await readdir(path.join(root, 'datos/smart-money'));
  for (const f of ['registro.jsonl', 'ultimo.json', 'resultados.csv', 'resumen.json', 'RESUMEN.md']) assert.ok(files.includes(f), f);
  const csv = await readFile(path.join(root, 'datos/smart-money/resultados.csv'), 'utf8');
  assert.match(csv.split('\n')[0], /^fecha;coin;metodo;/);
  assert.match(csv, /;75440,5;/, 'coma decimal para Excel en español');
  const md = await readFile(path.join(root, 'datos/smart-money/RESUMEN.md'), 'utf8');
  assert.match(md, /Necesario para no perder/); assert.match(md, /42\.9 %/);
});

test('evaluar: si fallan las velas de un activo, sus señales quedan abiertas y no rompe', async () => {
  const root = await tempRepo(); const w = world(); const silent = () => {};
  await registrar({ root, fetchImpl: fakeFetch(w), now: new Date(T0), clientOpts: quick, log: silent });
  const base = fakeFetch(w);
  const broken = async (u, i) => (i && i.body && JSON.parse(i.body).type === 'candleSnapshot') ? { ok: false, status: 503, json: async () => ({}) } : base(u, i);
  const msgs = [];
  const out = await evaluar({ root, fetchImpl: broken, now: new Date(T0 + DAY), clientOpts: quick, log: m => msgs.push(m) });
  assert.ok(out.filas.filter(f => f.metodo === 'direccional' && f.resultado !== 'sin_senal').every(f => f.resultado === 'abierta'));
  assert.ok(msgs.some(m => /no se pudieron bajar velas/.test(m)));
});

test('evaluar sin registro: no falla', async () => {
  const root = await tempRepo();
  assert.equal(await evaluar({ root, fetchImpl: async () => { throw new Error('no debería llamar'); }, log: () => {} }), null);
});
