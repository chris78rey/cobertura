# Transacción y conexión Oracle (guía para replicar en otro proyecto)

Este documento resume cómo está implementada la conexión Oracle en este repo (`DIGITALIZACION`) para que puedas replicarla en otro aplicativo sin romper lo que ya funciona.

## 1) Stack usado en este proyecto

- Python
- `JayDeBeApi` + `JPype1`
- Driver JDBC Oracle: `ojdbc8` (archivo local: `jdbc/ojdbc8 copy.jar`)
- Conexión a RAC por lista de targets (`host:port:sid`) con failover manual

Referencia en código:
- `fastapi_app/app.py` (`_cd_oracle_connect`, `_cd_oracle_select`, `_cd_oracle_execute`)
- `scripts/oracle_jdbc_smoketest.py` (smoke test)
- `scripts/oracle_make_dirs_from_tree.py` (ejemplo robusto de transacción)

## 2) Variables de entorno obligatorias

Basado en `.env.example`:

- `ORACLE_USER` (ej. `DIGITALIZACION`)
- `ORACLE_PASSWORD`
- `ORACLE_JDBC_JAR` (default: `jdbc/ojdbc8 copy.jar`)
- `ORACLE_TARGETS` (ej. `172.16.60.20:1521:prdsgh1,172.16.60.21:1521:prdsgh2`)

Opcionales según módulo:
- `ORACLE_SOURCE_TABLE`
- `ORACLE_TREE_TABLE`
- `ORACLE_OWNER` / `ORACLE_CONTROL_DOC_OWNER`

## 3) Manejo de claves (passwords) recomendado

Cómo se hace aquí:

1. Se carga `.env` al inicio del proceso (helper `_load_dotenv(Path('.env'))`).
2. No se comitea `.env`.
3. Si falta `ORACLE_PASSWORD`, algunos scripts abortan o piden prompt (solo local).
4. Se evita imprimir password en logs.

Buenas prácticas para el otro proyecto:

- Producción: inyectar credenciales por variables de entorno del servicio (systemd/k8s/secret manager).
- Desarrollo: `.env` local no versionado.
- Nunca loguear DSN completo con credenciales.

## 4) Timezone/JDBC para evitar ORA-01882

En este host se fuerza:

```bash
JAVA_TOOL_OPTIONS='-Doracle.jdbc.timezoneAsRegion=false -Duser.timezone=UTC'
```

Se usa en servicios y loops. Esto evita errores de región horaria en Oracle JDBC.

## 5) Patrón de conexión usado (failover RAC)

La conexión no usa un único host fijo. Se intenta por orden cada target hasta conectar:

1. Parsear `ORACLE_TARGETS` (lista `host:port:sid`)
2. Construir URL: `jdbc:oracle:thin:@host:port:sid`
3. `jaydebeapi.connect(...)`
4. Si falla, pasar al siguiente target
5. Si todos fallan, error final

## 6) Patrón de consultas (SELECT)

Patrón aplicado:

- Abrir conexión
- Abrir cursor
- Ejecutar SQL con parámetros bind (nunca concatenar valores de usuario)
- `fetchall()` o `fetchmany()`
- Cerrar cursor y conexión en `finally`

Ejemplo base (estilo repo):

```python
import jaydebeapi
from pathlib import Path


def oracle_select(sql: str, params: tuple[object, ...] = ()):
    conn = oracle_connect_failover()
    try:
        cur = conn.cursor()
        try:
            cur.execute(sql, params)
            return cur.fetchall()
        finally:
            cur.close()
    finally:
        conn.close()
```

## 7) Patrón de inserciones/updates (DML)

En `fastapi_app/app.py` se usa helper tipo `execute`:

- `cur.execute(sql, params)`
- `conn.commit()`
- devolver `rowcount`

Ejemplo:

```python
def oracle_execute(sql: str, params: tuple[object, ...] = ()) -> int:
    conn = oracle_connect_failover()
    try:
        cur = conn.cursor()
        try:
            cur.execute(sql, params)
            rc = int(cur.rowcount) if cur.rowcount is not None else 0
            conn.commit()
            return rc
        finally:
            cur.close()
    finally:
        conn.close()
```

## 8) Transacciones reales (batch) y autocommit

En `scripts/oracle_make_dirs_from_tree.py` se muestra un patrón más fino:

- Detectar/autocontrolar autocommit con `conn.jconn.getAutoCommit()`
- Si aplica, desactivar autocommit: `setAutoCommit(False)`
- Ejecutar múltiples `UPDATE`
- `commit` cada N filas (`--commit-every`)
- `commit` final

Esto es clave para procesos masivos y para no hacer commit por cada fila cuando no conviene.

## 9) Reglas SQL importantes para replicar

- Usar bind variables (`?`) en parámetros de valor
- No usar `SELECT *` en producción (seleccionar columnas necesarias)
- Para objetos dinámicos (schema/tabla), validar/canonizar identificadores antes de interpolar
- Cerrar siempre cursor/connection
- Capturar excepción por target para failover

## 10) Errores frecuentes y diagnóstico rápido

1. `Jar not found`
- Revisar `ORACLE_JDBC_JAR` y archivo físico.

2. `ORACLE_USER or ORACLE_PASSWORD not set`
- Revisar `.env`/variables del servicio.

3. `Failed to connect to any target`
- Revisar red/VPN/firewall/targets.

4. `ORA-01882`
- Revisar `JAVA_TOOL_OPTIONS` con timezone flags.

5. Prompt interactivo falla en servicio
- No depender de prompt; usar variables de entorno.

## 11) Checklist para el otro proyecto

1. Instalar dependencias: `JayDeBeApi`, `JPype1`.
2. Tener `ojdbc8.jar` local y ruta configurable.
3. Implementar `_load_dotenv` (solo local/dev).
4. Implementar parseo de `ORACLE_TARGETS` y failover.
5. Crear helpers separados:
- `oracle_connect_failover()`
- `oracle_select(sql, params)`
- `oracle_execute(sql, params)`
6. Definir política de commit para batch (`commit every N`).
7. Forzar `JAVA_TOOL_OPTIONS` en runtime productivo.
8. Agregar smoke test tipo `SELECT 1 FROM dual` al arranque o healthcheck.

## 12) Ejemplo mínimo reutilizable (copiable)

```python
import os
from pathlib import Path
import jaydebeapi


def parse_targets(raw: str):
    out = []
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        host, port_s, sid = item.split(":", 2)
        out.append((host, int(port_s), sid))
    return out


def oracle_connect_failover():
    jar = Path(os.environ.get("ORACLE_JDBC_JAR", "jdbc/ojdbc8 copy.jar")).expanduser()
    user = os.environ.get("ORACLE_USER", "").strip()
    password = os.environ.get("ORACLE_PASSWORD", "").strip()
    if not jar.exists():
        raise RuntimeError(f"Jar not found: {jar}")
    if not user or not password:
        raise RuntimeError("ORACLE_USER or ORACLE_PASSWORD not set")

    targets = parse_targets(os.environ.get("ORACLE_TARGETS", "172.16.60.20:1521:prdsgh1,172.16.60.21:1521:prdsgh2"))
    last_exc = None
    for host, port, sid in targets:
        url = f"jdbc:oracle:thin:@{host}:{port}:{sid}"
        try:
            return jaydebeapi.connect("oracle.jdbc.OracleDriver", url, [user, password], jars=[str(jar)])
        except Exception as e:
            last_exc = e
            continue
    raise RuntimeError("Failed to connect to Oracle targets") from last_exc
```

---

Si quieres, en el siguiente paso te preparo un módulo `oracle_client.py` ya listo para copiar/pegar en el otro repo con tests de conexión y helpers de transacción.
