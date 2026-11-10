// Guarda la foto diaria del posicionamiento y la operación sugerida.
// Uso: node scripts/smart-money/registrar.mjs   (desde la raíz del repo)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEngine, makeClient, collect, upsertRegistro, parseJSONL, toJSONL } from './lib.mjs';

export async function main({ root = process.cwd(), fetchImpl = globalThis.fetch, now = new Date(), clientOpts = {}, log = console.log } = {}) {
  const html = await readFile(path.join(root, 'smart-money.html'), 'utf8');
  const SM = loadEngine(html);
  const client = makeClient(fetchImpl, clientOpts);
  const reg = await collect({ client, SM, now });
  const dir = path.join(root, 'datos', 'smart-money');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'registro.jsonl');
  const prev = existsSync(file) ? parseJSONL(await readFile(file, 'utf8')) : [];
  const all = upsertRegistro(prev, reg);
  await writeFile(file, toJSONL(all));
  await writeFile(path.join(dir, 'ultimo.json'), JSON.stringify(reg, null, 1) + '\n');
  const btc = reg.senales.find(s => s.coin === 'BTC');
  log(`Registro ${reg.fecha}: ${reg.billeteras} billeteras, ${reg.posiciones} posiciones, ${reg.shortPct}% short, peso API ${reg.pesoApi}. ` +
      `BTC ${btc ? btc.precio : '—'} → ${btc && btc.direccion ? (btc.direccion === 'L' ? 'long' : 'short') + ' (' + btc.recomendado + ')' : 'sin operación'}. Total: ${all.length} días.`);
  return { reg, total: all.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('ERROR registrar:', e.message); process.exit(1); });
}
