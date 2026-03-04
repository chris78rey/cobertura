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

## Rules

- Prefer direct HTTP integration over browser automation while the current server-action protocol remains valid.
- Validate `cedula` and `fecha` before network calls.
- Keep token retrieval, AES encryption, and `csconsulta` generation in one place. Do not duplicate this logic across scripts.
- Assume the portal is operationally unstable. Intermittent connectivity failures do not invalidate the protocol baseline.
- Treat the PDF as a local rendering concern. The site currently renders a PDF in the browser from response data instead of exposing a stable downloadable PDF URL.
- Treat the current PDF layout as fixed-layout rendering, not flowing document composition. Small coordinate changes are safer than structural rewrites.
- When the PDF breaks, inspect overlap, footer spill, and page count before changing business logic.

## Resources

### scripts/

- Reuse repository scripts in `/scripts` rather than reimplementing the flow.

### references/

- Read `references/protocol.md` for the verified request pattern and hito decisions.
