# Portal Protocol

## Verified On

- Date: 2026-03-04
- Base URL: `https://coberturasalud.msp.gob.ec/`

## Verified Request Flow

1. Request ephemeral token and request id through Next.js server action:
   - header `next-action: 40e5613a02e25c0dfb759fd7f199149081432edf13`
   - body: `["<reqId>"]`
2. Submit live query through Next.js server action:
   - header `next-action: 70987a4dcfb783907102d476e4a450486019bbcc62`
   - body:
     - `["cobertura","POST",{identificacion,fechaConsulta,token,csconsulta}]`

## Encoding Rules

- Encrypt `cedula` with `CryptoJS.AES.encrypt(cedula, token)`.
- Encrypt date with `CryptoJS.AES.encrypt(DD-MM-YYYY, token)`.
- Derive `csconsulta` by summing cedula digits in consecutive pairs.

## Verified Architectural Pattern

- Live inspection belongs in `/scripts/inspect_portal.js`.
- Stable integration belongs in `/scripts/query_live.js`.
- Local PDF rendering belongs in `/scripts/generate_pdf.js`.
- Generated PDF should be based on live JSON, not on scraping rendered HTML.
- The stable PDF renderer currently uses explicit coordinates for the main sections, not relative flowing layout.

## Error Model

- Invalid input: reject locally before network.
- Connectivity failure: treat as transient portal/network failure.
- Protocol mismatch: re-run the inspector and compare action ids, payload format, and response envelope.
- Asset incompatibility in PDF generation: degrade gracefully to placeholders instead of failing the whole export.

## Oracle Synchronization Decisions (Latest Hito)

- Oracle sync now processes up to three cédulas per row (`DIG_CEDULA`, `DIG_DEPENDIENTE_01`, `DIG_DEPENDIENTE_02`).
- Cédulas are validated, deduplicated, and executed in stable order: titular -> dependiente_01 -> dependiente_02.
- Per-cédula outcomes are explicit: `OK`, `SIN_DATOS`, `ERROR`.
- JSON persistence remains first-class and deterministic: one JSON per cédula before PDF generation.
- PDFs are generated per cédula and merged into a single per-row artifact (`oracle_<DIG_ID>_<FECHA>_unificado.pdf`) when applicable.
- Oracle row completion (`DIG_COBERTURA` done value) should happen only if there are no technical `ERROR` outcomes for that row.

## PDF Layout Decisions From The Latest Hito

- Header and footer are drawn after body rendering using buffered pages.
- The footer previously caused an unwanted second page; compact footer text before changing the main report structure.
- `RED PRIVADA COMPLEMENTARIA` now lives on the lower-left free area below the table.
- `Fecha de consulta` is an independent lower-center block and must remain visually separated from the private coverage block.
- Use `pdf-lib` page counting as the minimum regression check after PDF edits.
- Validated sample:
  - `cedula`: `1712730132`
  - `fecha`: `2026-03-02`
  - expected export behavior: `1` page
