---
name: oracle-batch
description: "Consulta Oracle DIGITALIZACION y genera PDFs de cobertura MSP en batch. Usar cuando: (1) el usuario pregunte por registros de digitalizacion, (2) necesite procesar multiples cedulas desde Oracle, (3) vaya a hacer batch desde la tabla DIGITALIZACION. Requiere conexion Oracle RAC 11g R2 con Instant Client y delays entre consultas para evitar rate limiting del portal MSP."
---

# Oracle Batch - DIGITALIZACION + MSP Portal

## Configuracion Oracle

Base: Oracle RAC 11g R2 (PRDSGH2)
Ubicacion Instant Client: `/opt/oracle/instantclient_21_11`

**CRITICO**: Oracle 11g R2 no funciona en thin mode. Debe usarse thick mode con `initOracleClient()`.

```javascript
const oracledb = require('oracledb');
oracledb.initOracleClient({ libDir: '/opt/oracle/instantclient_21_11' });
const conn = await oracledb.getConnection({
  connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=172.16.60.21)(PORT=1521))(CONNECT_DATA=(SID=PRDSGH2)))',
  user: 'DIGITALIZACION',
  password: 'DIGITALIZACION'
});
```

## Batch Processing - Reglas de Oro

1. **Delay minimo 2 segundos** entre consultas al portal MSP
2. **Reintentos con backoff exponencial**: 2s → 4s → 8s en caso de 503
3. Si todos los reintentos fallan, continuar con el siguiente registro
4. No hacer mas de 50-100 consultas sin pausa

## Causas de Fallas Conocidas

| Error | Causa | Solucion |
|-------|-------|----------|
| `NJS-138` | Oracle 11g en thin mode | Usar thick mode con `initOracleClient()` |
| `NJS-518` | Servicio SID incorrecto | Verificar que SID sea PRDSGH2, no PRDSGH |
| `503 Service Temporarily Unavailable` | Rate limiting del portal | Reintentar con delay, no spam |
| `undefined` response | Portal ocupado/rechazo | Reintentar, posiblemente con delay mayor |

## Script batch_oracle.js

Ubicacion: `/home/crrb/codex_projects/cobertura/scripts/batch_oracle.js`

```bash
cd /home/crrb/codex_projects/cobertura
node scripts/batch_oracle.js --limit=50
```

Parametros:
- `--limit=N` - Numero de registros a procesar (default 50)

El script:
1. Conecta a Oracle con thick mode
2. Consulta `dig_cedula` y `dig_fecha_hasta` desde DIGITALIZACION
3. Para cada registro: consulta portal MSP + genera PDF
4. Aplica delay de 2s entre consultas
5. Reintenta hasta 3 veces en caso de error 503

## Historial

- **2026-04-06**: Primera ejecucion exitosa. 50 registros de abril 2026 procesados sin errores despues de ajustar delay y thick mode.
- **Fallo inicial**: Sin delay = 503 nginx. Sin thick mode = NJS-138. Sin reintentos = perder registros.
