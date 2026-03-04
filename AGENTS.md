# Project Rules

## Scope

This repository automates the MSP coverage portal at `https://coberturasalud.msp.gob.ec/`, captures its current integration pattern, and generates local artifacts from the official response.

## Operating Rules

- Prefer the live integration in [scripts/query_live.js](/G:/codex_projects/cobertura/scripts/query_live.js) over browser automation when the current portal protocol still works.
- Treat the portal as unstable. Re-verify the live flow before refactoring request logic or action ids.
- Keep generated artifacts deterministic: query first, persist JSON response, then derive the PDF or any downstream export from that response.
- Preserve the separation of concerns already established:
  - inspect transport in `scripts/inspect_portal.js`
  - perform live query in `scripts/query_live.js`
  - render local PDF in `scripts/generate_pdf.js`
  - keep UI experiments in `web/`
- When adding batch features, reuse the same single-query core instead of duplicating encryption, token, or request logic.

## Portal Protocol Baseline

- The current app is Next.js and uses server actions over `POST /`.
- Action id `40e5613a02e25c0dfb759fd7f199149081432edf13` resolves the ephemeral token and request id.
- Action id `70987a4dcfb783907102d476e4a450486019bbcc62` submits the coverage query.
- The request body format is currently:
  - `["cobertura","POST",{identificacion,fechaConsulta,token,csconsulta}]`
- `identificacion` and `fechaConsulta` are AES-encrypted with the token.
- `csconsulta` is derived by summing cedula digits in consecutive pairs.

## Error Handling Rules

- Fail fast on invalid input format before touching the network.
- Surface transient portal failures as network/protocol issues, not as data absence.
- If the live endpoint fails temporarily, do not delete the current protocol knowledge. Capture the failure and keep the verified path as baseline.
- Do not assume a server-side PDF endpoint exists. The official site currently generates the PDF client-side from the JSON response.
- Treat PDF layout regressions separately from query regressions. A good JSON response does not imply a valid export.

## Asset Rules

- Keep official visual assets under `assets/` when they are reused in local PDF output.
- If a downloaded asset is unsupported by `pdfkit` (for example `.ico`), keep the generator resilient and fall back to text or vector placeholders.

## PDF Layout Rules

- The current stable PDF layout in `scripts/generate_pdf.js` is coordinate-based. Prefer explicit `x/y` placement for fixed sections instead of `moveDown()` driven flow.
- Keep header and footer drawing isolated from body layout. Apply chrome after content generation with buffered pages.
- If a footer line causes an unexpected extra page, compact or reposition the footer text before changing the main body layout.
- Keep the private coverage block on the lower-left free area under the main table. Do not place it over the footer or over `Fecha de consulta`.
- Keep `Fecha de consulta` as an independent block and validate that it does not overlap the private coverage block.
- After any PDF layout change, verify page count programmatically. Current standard: single-result export should remain `1` page for the validated sample case.

## Continuation Rule

- Before changing the portal integration, read [docs/investigacion.md](/G:/codex_projects/cobertura/docs/investigacion.md) and the local skill under `skills/cobertura-portal/`.
