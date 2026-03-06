# Conexión Oracle en este repo (guía simple y alineada)

Este repositorio está centrado en la integración MSP (`scripts/query_live.js`) y generación de PDF (`scripts/generate_pdf.js`).

La conexión Oracle es **complementaria** (por ejemplo, para cruzar datos locales), no parte del flujo oficial del portal MSP.

## 1) Objetivo y límites

- Mantener intacta la lógica MSP actual.
- Usar Oracle como fuente adicional, separada del core de consulta MSP.
- Evitar mezclar lógica Oracle dentro de `scripts/query_live.js`.

## 2) Forma más sencilla recomendada

La opción más simple y estable para este repo es usar **Python + `oracledb` en modo thin** (sin Instant Client).

Ventajas:

- No requiere `ojdbc` ni JVM.
- Menos fricción en Linux/WSL.
- Ideal para smoke tests y consultas puntuales.

## 3) Variables de entorno

Define estas variables (en tu entorno local o en un `.env` no versionado):

- `ORACLE_USER`
- `ORACLE_PASSWORD`
- `ORACLE_HOST`
- `ORACLE_PORT` (ejemplo: `1521`)
- `ORACLE_SERVICE` (service name)

DSN resultante:

```text
HOST:PORT/SERVICE
```

Ejemplo:

```text
172.16.60.20:1521/ORCLPDB1
```

## 4) Smoke test mínimo

Instala dependencia:

```bash
python3 -m pip install oracledb
```

Prueba conexión con `SELECT 1 FROM dual`:

```bash
python3 - <<'PY'
import os
import oracledb

user = os.environ["ORACLE_USER"]
password = os.environ["ORACLE_PASSWORD"]
host = os.environ["ORACLE_HOST"]
port = os.environ.get("ORACLE_PORT", "1521")
service = os.environ["ORACLE_SERVICE"]
dsn = f"{host}:{port}/{service}"

with oracledb.connect(user=user, password=password, dsn=dsn) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM dual")
        print(cur.fetchone()[0])
PY
```

Si imprime `1`, la conexión base está correcta.

## 5) Patrón recomendado en este proyecto

- Oracle en script separado (por ejemplo `scripts/oracle_smoketest.py` o `scripts/oracle_query.py`).
- Consultar Oracle primero o después según necesidad, pero conservar el pipeline MSP:
  1. consultar MSP,
  2. persistir JSON,
  3. generar PDF desde JSON.
- No tratar un fallo Oracle como “sin cobertura MSP”; reportarlo como fallo de integración auxiliar.

## 6) Formato de fecha para MSP

- `scripts/query_live.js` recibe `--fecha` en formato `YYYY-MM-DD`.
- Internamente convierte a `DD-MM-YYYY` antes del cifrado AES para el portal MSP.
- Si la fecha viene de Oracle (`DATE`), conviértela explícitamente con `strftime("%Y-%m-%d")` antes de llamar `query_live`.

## 7) Reescaneo Oracle con marca `N -> S`

Se agregó `scripts/oracle_rescan_cobertura.py` para este flujo:

1. leer filas de `DIGITALIZACION.DIGITALIZACION` con `DIG_COBERTURA='N'`;
2. tomar `DIG_CEDULA` y `DIG_FECHA_PLANILLA`;
3. ejecutar consulta MSP reutilizando `scripts/query_live.js`;
4. guardar JSON local en `output/oracle_sync/`;
5. actualizar `DIG_COBERTURA='S'` y `DIG_FECHA_PROCESO=SYSDATE` cuando la cobertura se genera.

Ejecución sugerida:

```bash
python3 scripts/oracle_rescan_cobertura.py --dotenv .env.example --thick --limit 60
```

Primera prueba sin actualizar Oracle:

```bash
python3 scripts/oracle_rescan_cobertura.py --dotenv .env.example --thick --limit 1 --dry-run
```

## 8) Errores comunes

1. `KeyError: ORACLE_*`
- Falta variable de entorno.

2. `DPY-6005` / timeout / connection refused
- Red, VPN, firewall o host/puerto incorrecto.

3. `ORA-01017`
- Usuario/clave inválidos.

4. `ORA-12514`
- `SERVICE_NAME` incorrecto.

## 9) Nota sobre JDBC en este repo

Existe `jdbc/ojdbc8.jar` en el árbol, pero **no es la ruta recomendada** para la integración simple de este proyecto. Úsalo solo si necesitas compatibilidad específica con una solución Java/JDBC heredada.

---

Si quieres, en el siguiente paso te creo `scripts/oracle_smoketest.py` listo para ejecutar con estas variables. 
