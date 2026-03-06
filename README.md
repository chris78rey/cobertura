# Cobertura Salud

Base de trabajo para:

- inspeccionar el portal `https://coberturasalud.msp.gob.ec/`;
- automatizar consultas en lote por cédula y fecha;
- replicar localmente la interfaz para uso interno.

## Estado actual

El dominio resolvió DNS durante la revisión, pero no respondió por HTTP ni HTTPS desde este entorno el 4 de marzo de 2026. Por eso el proyecto queda preparado para conectar el endpoint real cuando el sitio vuelva a estar disponible.

## Estructura

- `docs/investigacion.md`: hallazgos y plan de integración.
- `scripts/batch_query.py`: script CLI para consultas individuales o por CSV.
- `scripts/query_live.js`: cliente HTTP real basado en las acciones capturadas del portal.
- `web/index.html`: réplica local simple del formulario.
- `data/ejemplo_consultas.csv`: lote de ejemplo.

## Uso

Antes de ejecutar en Ubuntu/Linux, crea tu entorno local:

```bash
cp .env.example .env
```

Si aparece error de certificado TLS al consultar el portal MSP, activa temporalmente en `.env`:

```env
COBERTURA_TLS_INSECURE=true
```

Consulta individual:

```bash
python scripts/batch_query.py --cedula 1712730132 --fecha 2026-03-02
```

Consulta real contra el portal:

```bash
node scripts/query_live.js --cedula 1712730132 --fecha 2026-03-02
```

Generar PDF local con la respuesta real del portal:

```bash
node scripts/generate_pdf.js --cedula 1712730132 --fecha 2026-03-02
```

Nota: el generador ahora produce ambos formatos desde el mismo layout:

- `output/*.svg` como base visual
- `output/*.pdf` renderizado desde ese SVG

Consulta por lote:

```bash
python scripts/batch_query.py --input data/ejemplo_consultas.csv --output data/resultados.csv
```

Consulta por rango y generar JSON/PDF por fecha:

```bash
node scripts/batch_range_query.js --cedula 1712730132 --fecha_inicio 2026-02-28 --fecha_fin 2026-03-04
```

Control de ritmo adaptativo (recomendado para no saturar el portal):

```bash
node scripts/batch_range_query.js \
  --cedula 1712730132 \
  --fecha_inicio 2026-02-28 \
  --fecha_fin 2026-03-04 \
  --wait_min_ms 8000 --wait_max_ms 12000 \
  --good_wait_min_ms 5000 --good_wait_max_ms 8000 \
  --busy_wait_min_ms 12000 --busy_wait_max_ms 20000 \
  --cooldown_wait_min_ms 30000 --cooldown_wait_max_ms 60000 \
  --long_pause_every 25 --long_pause_min_ms 120000 --long_pause_max_ms 240000 \
  --hard_pause_error_threshold 3 --hard_pause_ms 180000
```

Modo ultra-seguro por franja horaria + tope diario:

```bash
node scripts/batch_range_query.js \
  --input_csv data/lotes.csv \
  --ultra_safe_mode true \
  --max_daily_queries 5000
```

Por defecto el horario se calcula en zona Ecuador (`America/Guayaquil`).
Si necesitas otra zona, usa `--schedule_timezone`.

En ultra-seguro, además del ritmo adaptativo, se aplica un mínimo por horario local:

- `07:00-14:00`: `7-10s`
- `14:00-20:00`: `10-14s`
- `20:00-24:00`: `14-20s`
- `00:00-07:00`: `20-35s`

Consulta masiva para varias cédulas:

```bash
node scripts/batch_range_query.js --cedulas 1712730132,0123456789 --fecha_inicio 2026-02-28 --fecha_fin 2026-03-04
```

Consulta masiva desde CSV con columnas `cedula,fecha_inicio,fecha_fin`:

```bash
node scripts/batch_range_query.js --input_csv data/lotes.csv
```

Servidor local para la réplica:

```bash
python -m http.server 8080
```

Luego abre `http://127.0.0.1:8080/web/`.

## Integración pendiente

Cuando el portal responda otra vez, hay que completar una de estas rutas:

1. mapear la petición HTTP interna y configurar `COBERTURA_ENDPOINT`;
2. si no existe API reutilizable, cambiar el script a automatización con navegador.
