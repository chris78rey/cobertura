# Oracle Sync Pattern (Latest Hito)

## Scope

This document standardizes how Oracle rows are reprocessed against MSP and converted into deterministic local artifacts.

## Source Script

- `scripts/oracle_rescan_cobertura.py` is the source of truth for Oracle synchronization.
- Do not duplicate this orchestration in ad-hoc scripts.

## Record Input Model

Per Oracle row (`DIGITALIZACION.DIGITALIZACION`):

- Primary cédula: `DIG_CEDULA`
- Optional dependents: `DIG_DEPENDIENTE_01`, `DIG_DEPENDIENTE_02`
- Query date: `DIG_FECHA_PLANILLA` -> normalized to `YYYY-MM-DD`

## Multi-Cédula Resolution Rules

1. Build candidate list in strict order:
   - `titular` (`DIG_CEDULA`)
   - `dependiente_01`
   - `dependiente_02`
2. Skip empty values.
3. Validate each cédula as 10 digits.
4. De-duplicate repeated cédulas while preserving first appearance order.
5. Fail fast if no valid cédulas remain.

## Per-Cédula Status Model

- `OK`: MSP query completed and result is treated as generated coverage.
- `SIN_DATOS`: MSP query completed but no generated coverage record.
- `ERROR`: technical failure (network/protocol/runtime) after retry policy.

This avoids conflating no-data outcomes with technical failures.

## Deterministic Artifact Rules

For every attempted cédula (including `SIN_DATOS`):

1. Persist JSON first: `output/oracle_sync/dig_<DIG_ID>_<CEDULA>_<FECHA>.json`
2. Generate PDF from saved JSON (never from in-memory response only).

If response lacks expected `response.data`, normalize a minimal envelope so PDF generation remains resilient.

## Per-Record PDF Consolidation

- Generate per-cédula PDFs in slot order.
- Merge PDFs by `DIG_ID + fecha` into:
  - `output/oracle_<DIG_ID>_<FECHA>_unificado.pdf`
- If only one PDF exists, reuse it as unified output (no unnecessary copy).

## Oracle Update Rule

- Mark row `DIG_COBERTURA` from pending to done only when the record has no per-cédula `ERROR`.
- A row with only `OK`/`SIN_DATOS` is considered technically complete.

## Error Handling Baseline

- Validation errors: fail row early with explicit message.
- MSP transient failures: retry per configured policy.
- Persistent technical failures: classify as `ERROR`, keep trace logs, avoid false completion.
- PDF merge failure: treat as processing failure for final summary.

## Operational Validation

Minimum regression command:

```bash
python3 scripts/oracle_rescan_cobertura.py \
  --dotenv .env.example \
  --thick --lib-dir /opt/oracle/instantclient_21_11 \
  --limit 1 --dry-run --pdf-per-batch --batch-size 1
```

Expected: row processed, status breakdown printed, deterministic artifacts created, and summary counters emitted.
