# Investigación técnica

Fecha de revisión: 2026-03-04

## Objetivo

Evitar consultas manuales una por una en el portal de coberturas de salud y preparar una solución reproducible para consultas masivas.

## Hallazgos confirmados

- El dominio `coberturasalud.msp.gob.ec` resolvió a `181.112.138.227`.
- Fuentes públicas de terceros describen un flujo de consulta por:
  - número de cédula;
  - fecha de consulta;
  - generación o descarga de un comprobante PDF.
- La app actual es `Next.js` y expone la consulta mediante `Server Actions` sobre `POST /`.
- El frontend capturado el 2026-03-04 usa estas acciones:
  - `40e5613a02e25c0dfb759fd7f199149081432edf13`: `getCaptcha`
  - `70987a4dcfb783907102d476e4a450486019bbcc62`: `apiClient`
- El payload real capturado para la consulta fue:
  - `["cobertura","POST",{"identificacion":"...","fechaConsulta":"...","token":"...","csconsulta":"831015"}]`
- `identificacion` y `fechaConsulta` se cifran con `CryptoJS.AES.encrypt(valor, token)`.
- `csconsulta` se calcula sumando la cédula en pares consecutivos.

## Implicación técnica

Hay dos estrategias viables:

## Estrategia A: reutilizar petición interna

Aplicable si el sitio usa una llamada HTTP/JSON o un POST tradicional.

Ventajas:

- más rápida;
- apta para lotes grandes;
- más fácil de integrar con CSV, Excel o backend propio.

Pasos:

1. abrir DevTools cuando el portal esté disponible;
2. enviar una consulta manual;
3. capturar URL, método, payload, headers y cookies requeridas;
4. replicar la llamada desde `scripts/batch_query.py`.

## Estrategia B: automatización de navegador

Aplicable si el sitio depende de JavaScript, captcha, sesión compleja o descarga directa de PDF sin API reutilizable.

Ventajas:

- replica exactamente el comportamiento del usuario;
- menor riesgo de romperse por detalles de frontend.

Costes:

- más lenta;
- más frágil;
- requiere navegador instalado y control de esperas.

## Recomendación

Intentar primero la Estrategia A. Si no existe una llamada reutilizable clara, pasar a Playwright o Selenium.

## Estado actualizado

La Estrategia A sí quedó identificada. Ya no es necesario automatizar la interfaz para consultar en lote si los IDs de acción y el formato actual se mantienen.

## Prueba solicitada por el usuario

Datos:

- cédula: `1712730132`
- fecha: `2026-03-02`

Resultado:

- no se pudo ejecutar la consulta real porque el portal no respondió durante la revisión.

## Riesgos y límites

- El portal podría incluir controles anti-bot o validaciones de sesión.
- Si el resultado contiene datos personales sensibles, el almacenamiento local debe minimizarse.
- Un volumen alto de consultas debe ejecutarse con pausas y trazabilidad.
