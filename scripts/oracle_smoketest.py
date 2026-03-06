#!/usr/bin/env python3
import argparse
import os
import sys
from pathlib import Path
from typing import Dict, Optional


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke test de conexion Oracle para este repo."
    )
    parser.add_argument(
        "--dotenv",
        default=".env",
        help="Ruta al archivo .env (default: .env).",
    )
    parser.add_argument(
        "--host",
        default="",
        help="Oracle host (override de ORACLE_HOST).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Oracle port (override de ORACLE_PORT).",
    )
    parser.add_argument(
        "--service",
        default="",
        help="Oracle service name (override de ORACLE_SERVICE).",
    )
    parser.add_argument(
        "--user",
        default="",
        help="Oracle user (override de ORACLE_USER).",
    )
    parser.add_argument(
        "--password",
        default="",
        help="Oracle password (override de ORACLE_PASSWORD).",
    )
    parser.add_argument(
        "--sql",
        default="SELECT 1 FROM dual",
        help="SQL de prueba (default: SELECT 1 FROM dual).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Timeout de conexion en segundos (default: 10).",
    )
    parser.add_argument(
        "--thick",
        action="store_true",
        help="Usa python-oracledb en modo thick (Instant Client).",
    )
    parser.add_argument(
        "--lib-dir",
        default="",
        help="Ruta de Instant Client (override de ORACLE_CLIENT_LIB_DIR).",
    )
    return parser.parse_args()


def resolve_config(args: argparse.Namespace) -> Dict[str, str]:
    host = (args.host or os.environ.get("ORACLE_HOST", "")).strip()
    port = args.port or int(os.environ.get("ORACLE_PORT", "1521"))
    service = (args.service or os.environ.get("ORACLE_SERVICE", "")).strip()
    user = (args.user or os.environ.get("ORACLE_USER", "")).strip()
    password = args.password or os.environ.get("ORACLE_PASSWORD", "")

    missing = []
    if not host:
        missing.append("ORACLE_HOST")
    if not service:
        missing.append("ORACLE_SERVICE")
    if not user:
        missing.append("ORACLE_USER")
    if not password:
        missing.append("ORACLE_PASSWORD")

    if missing:
        raise ValueError("Faltan variables: " + ", ".join(missing))

    return {
        "host": host,
        "port": str(port),
        "service": service,
        "user": user,
        "password": password,
    }


def run_smoketest(
    config: Dict[str, str],
    sql: str,
    timeout: float,
    use_thick: bool,
    lib_dir: str,
) -> Optional[tuple]:
    try:
        import oracledb
    except ImportError as exc:
        raise RuntimeError(
            "No se encontro 'oracledb'. Instala con: python3 -m pip install oracledb"
        ) from exc

    if use_thick:
        kwargs = {}
        if lib_dir:
            kwargs["lib_dir"] = lib_dir
        oracledb.init_oracle_client(**kwargs)

    dsn = f"{config['host']}:{config['port']}/{config['service']}"
    with oracledb.connect(
        user=config["user"],
        password=config["password"],
        dsn=dsn,
        tcp_connect_timeout=timeout,
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            row = cur.fetchone()
            return row


def main() -> int:
    args = parse_args()
    load_dotenv(Path(args.dotenv))

    try:
        config = resolve_config(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    safe_dsn = f"{config['host']}:{config['port']}/{config['service']}"
    print(f"Probando Oracle en {safe_dsn} con usuario {config['user']}")

    try:
        lib_dir = (args.lib_dir or os.environ.get("ORACLE_CLIENT_LIB_DIR", "")).strip()
        row = run_smoketest(config, args.sql, args.timeout, args.thick, lib_dir)
    except Exception as exc:
        message = str(exc)
        if "DPY-3010" in message:
            print(
                "Error de conexion/consulta: servidor Oracle no soportado en modo thin. "
                "Reintenta con --thick y Oracle Instant Client (ORACLE_CLIENT_LIB_DIR).",
                file=sys.stderr,
            )
            print(f"Detalle: {message}", file=sys.stderr)
        else:
            print(f"Error de conexion/consulta: {message}", file=sys.stderr)
        return 1

    print("Conexion OK")
    print(f"Resultado: {row}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
