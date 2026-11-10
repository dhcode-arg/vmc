// Evalúa cada foto registrada contra las velas diarias reales y actualiza el track record.
// Uso: node scripts/smart-money/evaluar.mjs   (desde la raíz del repo)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeClient, fetchCandles, parseJSONL, evaluate, summarize, resumenMarkdown, toCSV, CRIT } from './lib.mjs';

export async function main({ root = process.cwd(), fetchImpl = globalThis.fetch, now = new Date(), clientOpts = {}, log = console.log } = {}) {
  const dir = path.join(root, 'datos', 'smart-money');
  const file = path.join(dir, 'registro.jsonl');
  if (!existsSync(file)) { log('Todavía no hay registro para evaluar.'); return null; }
  const registro = parseJSONL(await readFile(file, 'utf8'));
  if (!registro.length) { log('Registro vacío.'); return null; }
  const client = makeClient(fetchImpl, clientOpts);
  const coins = [...new Set(registro.flatMap(r => (r.senales || []).filter(s => s.direccion).map(s => s.coin)))];
  const start = Date.parse(registro[0].ts) - 86400000;
  const candlesByCoin = {};
  for (const c of coins) {
    try { candlesByCoin[c] = await fetchCandles(client, c, start, now.getTime()); }
    catch (e) { log(`Aviso: no se pudieron bajar velas de ${c} (${e.message}); sus señales quedan abiertas.`); candlesByCoin[c] = []; }
  }
  const filas = evaluate(registro, candlesByCoin, CRIT);
  const res = summarize(filas, CRIT);
  const meta = { actualizado: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC', dias: registro.length, desde: registro[0].fecha, motor: registro[registro.length - 1].motor };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'resultados.csv'), toCSV(filas));
  await writeFile(path.join(dir, 'resumen.json'), JSON.stringify({ ...meta, ...res }, null, 1) + '\n');
  await writeFile(path.join(dir, 'RESUMEN.md'), resumenMarkdown(res, meta));
  const d = res.direccionalNuevas, p = res.plan;
  log(`Evaluación: dirección (cuando cambia) ${d.resueltas} resueltas, acierto ${d.acierto ?? '—'}% · plan ${p.resueltas} resueltas, acierto ${p.acierto ?? '—'}%.`);
  return { filas, res };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('ERROR evaluar:', e.message); process.exit(1); });
}
