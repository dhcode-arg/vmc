# Smart Money · registro diario

Mide si la operación sugerida de `smart-money.html` acierta, con datos reales y sin mirar hacia atrás.

## Qué hace
Todos los días a las **21:20 ART**, después del cierre de la vela diaria, el Action `smart-money-registro.yml`:

1. **Foto del día** (`registrar.mjs`). Toma las 50 billeteras top de Hyperliquid, su posicionamiento y la operación sugerida para BTC, ETH, SOL, HYPE y los 5 activos con más dinero en juego. Guarda una línea por día en `datos/smart-money/registro.jsonl` (unos 5 KB por día). Si corre dos veces el mismo día, reemplaza la foto en lugar de duplicarla.
2. **Evaluación** (`evaluar.mjs`). Baja las velas diarias reales y resuelve cada foto anterior:
   - **Dirección sugerida:** desde el precio de la foto, qué toca primero, +8 % a favor o −6 % en contra, dentro de 30 velas. Es el mismo criterio del resto del ecosistema VMC. Si los dos niveles caen en la misma vela, cuenta como pérdida.
   - **Plan exacto:** si la entrada límite se toma dentro de 5 velas, qué toca primero, TP1 o stop.

Usa el motor de `smart-money.html` (debe estar en la raíz del repo), así el registro calcula exactamente lo mismo que la página.

## Qué genera (`datos/smart-money/`)
| Archivo | Para qué |
|---|---|
| `RESUMEN.md` | El track record de un vistazo. Se lee directo en GitHub. |
| `resultados.csv` | Cada señal con su resultado. Separador `;` y coma decimal: se abre directo en Excel. |
| `resumen.json` | Los mismos números, para mostrarlos después en la página o el portal. |
| `registro.jsonl` | Las fotos diarias (fuente de todo). |
| `ultimo.json` | La foto de hoy. |

## Cómo leer el resultado
- Mirá la fila **"solo cuando cambia"**. Los días seguidos con la misma señal no son independientes e inflan la muestra.
- El acierto sirve si el **rango probable completo** queda por encima de **"necesario para no perder"**: 42,9 % para la dirección (+8 / −6) y alrededor de 33 % para el plan con TP1 a 2 veces el riesgo.
- Con **menos de 20 resueltas** el número todavía no dice nada. Con la señal cambiando poco, se necesitan semanas o meses.

## Correrlo a mano
Desde GitHub: pestaña **Actions → Smart Money · registro diario → Run workflow**.

En local (Node 20 o más nuevo), desde la raíz del repo:
```
node scripts/smart-money/registrar.mjs
node scripts/smart-money/evaluar.mjs
node --test scripts/smart-money/registro.test.mjs
```
