---
name: cobertura-portal
description: Inspect, query, and replicate the MSP health coverage portal workflow. Use when working on `coberturasalud.msp.gob.ec`, its Next.js server actions, encrypted request payloads, local PDF generation, batch coverage queries, or project rules for this repository.
---

# Cobertura Portal

Use this skill to work on the MSP health coverage portal integration captured in this repository.

## Workflow

1. Read `references/protocol.md` before changing transport logic.
2. Use `scripts/query_live.js` as the source of truth for live queries.
3. Use `scripts/inspect_portal.js` only when the portal changes or action ids stop working.
4. Use `scripts/generate_pdf.js` to build local PDFs from the official JSON response.
5. Validate any PDF layout change by checking the generated file under `output/` and confirming page count stays correct.
6. For Oracle sync flows, use `scripts/oracle_rescan_cobertura.py` as the only orchestrator for query/save/pdf/marking.

## Rules

- Prefer direct HTTP integration over browser automation while the current server-action protocol remains valid.
- Validate `cedula` and `fecha` before network calls.
- Keep token retrieval, AES encryption, and `csconsulta` generation in one place. Do not duplicate this logic across scripts.
- Assume the portal is operationally unstable. Intermittent connectivity failures do not invalidate the protocol baseline.
- Treat the PDF as a local rendering concern. The site currently renders a PDF in the browser from response data instead of exposing a stable downloadable PDF URL.
- Treat the current PDF layout as fixed-layout rendering, not flowing document composition. Small coordinate changes are safer than structural rewrites.
- When the PDF breaks, inspect overlap, footer spill, and page count before changing business logic.
- For Oracle records, process up to 3 cédulas (`DIG_CEDULA`, `DIG_DEPENDIENTE_01`, `DIG_DEPENDIENTE_02`) with de-duplication and stable order (titular -> dependiente_01 -> dependiente_02).
- Use per-cédula states (`OK`, `SIN_DATOS`, `ERROR`) to avoid silent data loss.
- Keep deterministic artifacts: persist one JSON per cédula first, then generate PDFs from those saved JSON files.
- Generate one merged PDF per `DIG_ID` when multiple cédulas succeed for the same record.
- Mark `DIG_COBERTURA` as done only when the full record has no technical errors (`ERROR`).

## Resources

### scripts/

- Reuse repository scripts in `/scripts` rather than reimplementing the flow.

### references/

- Read `references/protocol.md` for the verified request pattern and hito decisions.
- Read `references/oracle-sync.md` for Oracle multi-cédula orchestration and status model.
