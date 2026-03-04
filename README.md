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

Consulta por lote:

```bash
python scripts/batch_query.py --input data/ejemplo_consultas.csv --output data/resultados.csv
```

Consulta por rango y generar JSON/PDF por fecha:

```bash
node scripts/batch_range_query.js --cedula 1712730132 --fecha_inicio 2026-02-28 --fecha_fin 2026-03-04
```

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
