#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List


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
        description="Reescanea DIGITALIZACION.DIGITALIZACION, consulta MSP y actualiza DIG_COBERTURA."
    )
    parser.add_argument("--dotenv", default=".env", help="Archivo env (default: .env).")
    parser.add_argument("--limit", type=int, default=60, help="Max filas por corrida.")
    parser.add_argument(
        "--pending-value",
        default="N",
        help="Valor pendiente en DIG_COBERTURA (default: N).",
    )
    parser.add_argument(
        "--done-value",
        default="S",
        help="Valor final en DIG_COBERTURA al generar cobertura (default: S).",
    )
    parser.add_argument(
        "--output-dir",
        default="output/oracle_sync",
        help="Directorio para guardar JSON de respuesta MSP.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="No actualiza Oracle; solo consulta y reporta.",
    )
    parser.add_argument(
        "--ayer",
        action="store_true",
        help="Filtra solo filas con DIG_FECHA_PLANILLA de ayer.",
    )
    parser.add_argument(
        "--thick",
        action="store_true",
        help="Usa modo thick de python-oracledb.",
    )
    parser.add_argument(
        "--lib-dir",
        default="",
        help="Ruta Instant Client (override ORACLE_CLIENT_LIB_DIR).",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Reintentos por fila ante fallo MSP (default: 2).",
    )
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=1.2,
        help="Espera en segundos entre reintentos (default: 1.2).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=20,
        help="Tamano de bloque para post-proceso (default: 20).",
    )
    parser.add_argument(
        "--pdf-per-batch",
        action="store_true",
        help="Genera PDF al cerrar cada bloque.",
    )
    parser.add_argument(
        "--keep-svg",
        action="store_true",
        help="Conserva SVG intermedio al generar PDF (default: borrar).",
    )
    parser.add_argument(
        "--keep-generated-json",
        action="store_true",
        help="Conserva JSON duplicado que genera generate_pdf.js en output/.",
    )
    return parser.parse_args()


def resolve_oracle_config() -> Dict[str, str]:
    config = {
        "host": os.environ.get("ORACLE_HOST", "").strip(),
        "port": os.environ.get("ORACLE_PORT", "1521").strip(),
        "service": os.environ.get("ORACLE_SERVICE", "").strip(),
        "user": os.environ.get("ORACLE_USER", "").strip(),
        "password": os.environ.get("ORACLE_PASSWORD", ""),
    }
    missing = [key for key, value in config.items() if not value]
    if missing:
        raise ValueError("Faltan variables Oracle: " + ", ".join(f"ORACLE_{m.upper()}" for m in missing))
    return config


def get_connection(args: argparse.Namespace):
    try:
        import oracledb
    except ImportError as exc:
        raise RuntimeError("Falta dependencia: python3 -m pip install oracledb") from exc

    if args.thick:
        lib_dir = (args.lib_dir or os.environ.get("ORACLE_CLIENT_LIB_DIR", "")).strip()
        kwargs: Dict[str, str] = {}
        if lib_dir:
            kwargs["lib_dir"] = lib_dir
        oracledb.init_oracle_client(**kwargs)

    config = resolve_oracle_config()
    dsn = f"{config['host']}:{config['port']}/{config['service']}"
    return oracledb.connect(
        user=config["user"],
        password=config["password"],
        dsn=dsn,
        tcp_connect_timeout=10.0,
    )


def fetch_pending_rows(
    conn,
    pending_value: str,
    limit: int,
    only_yesterday: bool,
) -> List[Dict[str, Any]]:
    where_extra = "AND TRUNC(DIG_FECHA_PLANILLA)=TRUNC(SYSDATE)-1" if only_yesterday else ""
    sql = f"""
    SELECT *
    FROM (
      SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02, DIG_FECHA_PLANILLA, DIG_COBERTURA
      FROM DIGITALIZACION.DIGITALIZACION
      WHERE NVL(DIG_COBERTURA, 'N') = :pending
        AND DIG_CEDULA IS NOT NULL
        AND DIG_FECHA_PLANILLA IS NOT NULL
        {where_extra}
      ORDER BY DIG_FECHA_PROCESO DESC NULLS LAST, DIG_ID DESC
    )
    WHERE ROWNUM <= :max_rows
    """
    cur = conn.cursor()
    try:
        cur.execute(sql, pending=pending_value, max_rows=limit)
        rows = []
        for (
            dig_id,
            dig_tramite,
            dig_cedula,
            dig_dependiente_01,
            dig_dependiente_02,
            dig_fecha_planilla,
            dig_cobertura,
        ) in cur.fetchall():
            rows.append(
                {
                    "dig_id": int(dig_id),
                    "dig_tramite": int(dig_tramite) if dig_tramite is not None else None,
                    "dig_cedula": str(dig_cedula).strip(),
                    "dig_dependiente_01": str(dig_dependiente_01).strip() if dig_dependiente_01 else "",
                    "dig_dependiente_02": str(dig_dependiente_02).strip() if dig_dependiente_02 else "",
                    "dig_fecha_planilla": dig_fecha_planilla,
                    "dig_cobertura": dig_cobertura,
                }
            )
        return rows
    finally:
        cur.close()


def format_fecha_for_msp(fecha_value: Any) -> str:
    if isinstance(fecha_value, datetime):
        return fecha_value.strftime("%Y-%m-%d")
    raise ValueError(f"Fecha de planilla invalida: {fecha_value!r}")


def run_msp_query(cedula: str, fecha_iso: str) -> Dict[str, Any]:
    command = ["node", "scripts/query_live.js", "--cedula", cedula, "--fecha", fecha_iso]
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "Fallo query_live.js")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Salida no JSON de query_live.js: {proc.stdout[:300]}") from exc


def run_msp_query_with_retry(
    cedula: str,
    fecha_iso: str,
    retries: int,
    retry_delay: float,
) -> Dict[str, Any]:
    attempts = max(retries, 0) + 1
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return run_msp_query(cedula, fecha_iso)
        except Exception as exc:
            last_exc = exc
            if attempt < attempts:
                time.sleep(max(retry_delay, 0.0))
    raise RuntimeError(f"fallo MSP tras {attempts} intentos: {last_exc}")


def is_coverage_generated(result: Dict[str, Any]) -> bool:
    response = result.get("response") or {}
    success = response.get("success")
    data = response.get("data") or {}
    return success == "success" and isinstance(data, dict) and data.get("status") in ("200", 200)


def save_result(output_dir: Path, dig_id: int, tramite: int | None, cedula: str, fecha_iso: str, result: Dict[str, Any]) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    if tramite is not None:
        filename = f"cc_{tramite}_{cedula}_{fecha_iso}.json"
    else:
        filename = f"dig_{dig_id}_{cedula}_{fecha_iso}.json"
    path = output_dir / filename
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def merge_pdfs(pdf_paths: List[str], merged_output_path: Path) -> str:
    valid_paths = [path for path in pdf_paths if path]
    if not valid_paths:
        raise RuntimeError("No hay PDFs para unificar")
    if len(valid_paths) == 1:
        merged_output_path.parent.mkdir(parents=True, exist_ok=True)
        source = Path(valid_paths[0]).resolve()
        target = merged_output_path.resolve()
        if source != target:
            shutil.copyfile(source, target)
        return str(target)

    merged_output_path.parent.mkdir(parents=True, exist_ok=True)
    command = ["pdfunite", *valid_paths, str(merged_output_path)]
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "Fallo pdfunite")
    return str(merged_output_path)


def normalize_result_for_pdf(result: Dict[str, Any]) -> Dict[str, Any]:
    payload = result if isinstance(result, dict) else {}
    response = payload.get("response") if isinstance(payload.get("response"), dict) else {}
    data = response.get("data") if isinstance(response.get("data"), dict) else {}

    if not data:
        data = {
            "status": "204",
            "coberturaSalud": {"CoberturaSeguros": {"aseguradora": []}},
            "coberturaPrivada": {"RegistrosAsegurados": {"RegistroAsegurado": []}},
        }

    response["data"] = data
    payload["response"] = response
    return payload


def build_cedula_targets(row: Dict[str, Any]) -> List[Dict[str, str]]:
    targets = [
        {"slot": "titular", "cedula": str(row.get("dig_cedula") or "").strip(), "order": 1},
        {"slot": "dependiente_01", "cedula": str(row.get("dig_dependiente_01") or "").strip(), "order": 2},
        {"slot": "dependiente_02", "cedula": str(row.get("dig_dependiente_02") or "").strip(), "order": 3},
    ]
    valid_targets: List[Dict[str, str]] = []
    seen = set()
    for target in targets:
        cedula = target["cedula"]
        if not cedula:
            continue
        if not re.fullmatch(r"\d{10}", cedula):
            raise ValueError(f"{target['slot']} invalida: '{cedula}'")
        if cedula in seen:
            continue
        seen.add(cedula)
        valid_targets.append(target)
    if not valid_targets:
        raise ValueError("No hay cedulas validas en titular/dependientes")
    return valid_targets


def mark_done(conn, dig_id: int, pending_value: str, done_value: str) -> int:
    sql = """
    UPDATE DIGITALIZACION.DIGITALIZACION
    SET DIG_COBERTURA = :done,
        DIG_FECHA_PROCESO = SYSDATE
    WHERE DIG_ID = :dig_id
      AND NVL(DIG_COBERTURA, 'N') = :pending
    """
    cur = conn.cursor()
    try:
        cur.execute(sql, done=done_value, dig_id=dig_id, pending=pending_value)
        return int(cur.rowcount or 0)
    finally:
        cur.close()


def generate_pdf_from_saved_json(
    dig_id: int,
    tramite: int | None,
    cedula: str,
    fecha_iso: str,
    json_path: Path,
    keep_svg: bool,
    keep_generated_json: bool,
) -> str:
    if tramite is not None:
        output_name = f"cc_{tramite}_{cedula}_{fecha_iso}"
    else:
        output_name = f"oracle_{dig_id}_{cedula}_{fecha_iso}"
    command = [
        "node",
        "scripts/generate_pdf.js",
        "--cedula",
        cedula,
        "--fecha",
        fecha_iso,
        "--input_json",
        str(json_path),
        "--output_name",
        output_name,
    ]
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "Fallo generate_pdf.js")

    try:
        artifacts = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Salida no JSON de generate_pdf.js: {proc.stdout[:300]}") from exc

    svg_path = artifacts.get("svgPath")
    svg_paths = artifacts.get("svgPaths") if isinstance(artifacts.get("svgPaths"), list) else []
    generated_json_path = artifacts.get("jsonPath")
    pdf_path = artifacts.get("pdfPath")

    # Se conservan SVG y JSON generados para trazabilidad y auditoria.

    return str(pdf_path or "")


def flush_pdf_batch(
    items: List[Dict[str, Any]],
    keep_svg: bool,
    keep_generated_json: bool,
) -> tuple[int, int]:
    ok = 0
    fail = 0
    grouped: Dict[tuple[int, int | None, str], List[Dict[str, Any]]] = {}
    for item in items:
        key = (item["dig_id"], item.get("dig_tramite"), item["fecha_iso"])
        grouped.setdefault(key, []).append(item)

    for (dig_id, dig_tramite, fecha_iso), group in grouped.items():
        group_sorted = sorted(group, key=lambda current: int(current.get("order", 99)))
        generated_paths: List[str] = []
        group_failed = False

        for item in group_sorted:
            try:
                pdf_path = generate_pdf_from_saved_json(
                    dig_id=item["dig_id"],
                    tramite=item.get("dig_tramite"),
                    cedula=item["cedula"],
                    fecha_iso=item["fecha_iso"],
                    json_path=item["json_path"],
                    keep_svg=keep_svg,
                    keep_generated_json=keep_generated_json,
                )
                generated_paths.append(pdf_path)
                print(
                    f"PDF OK DIG_ID={item['dig_id']} slot={item['slot']} cedula={item['cedula']} fecha={item['fecha_iso']} pdf={pdf_path}"
                )
                ok += 1
            except Exception as exc:
                print(
                    f"PDF fallo DIG_ID={item['dig_id']} slot={item['slot']} cedula={item['cedula']}: {exc}",
                    file=sys.stderr,
                )
                fail += 1
                group_failed = True

        if generated_paths and not group_failed:
            try:
                if dig_tramite is not None:
                    merged_name = f"CC_{dig_tramite}.pdf"
                else:
                    merged_name = f"oracle_{dig_id}_{fecha_iso}_unificado.pdf"
                merged_path = Path("output") / merged_name
                merged_pdf = merge_pdfs(generated_paths, merged_path)
                print(f"PDF UNIFICADO OK DIG_ID={dig_id} fecha={fecha_iso} pdf={merged_pdf}")
            except Exception as exc:
                print(f"PDF unificado fallo DIG_ID={dig_id}: {exc}", file=sys.stderr)
                fail += 1

    return ok, fail


def main() -> int:
    args = parse_args()
    load_dotenv(Path(args.dotenv))

    try:
        conn = get_connection(args)
    except Exception as exc:
        print(f"No se pudo conectar a Oracle: {exc}", file=sys.stderr)
        return 1

    processed = 0
    marked = 0
    failures = 0
    pdf_ok = 0
    pdf_fail = 0
    handled = 0
    cedulas_total = 0
    cedulas_ok = 0
    cedulas_sin_datos = 0
    cedulas_error = 0
    batch_items: List[Dict[str, Any]] = []
    output_dir = Path(args.output_dir)

    try:
        rows = fetch_pending_rows(conn, args.pending_value, max(args.limit, 0), args.ayer)
        print(f"Filas pendientes encontradas: {len(rows)}")

        for row in rows:
            dig_id = row["dig_id"]
            dig_tramite = row.get("dig_tramite")
            try:
                fecha_iso = format_fecha_for_msp(row["dig_fecha_planilla"])
                targets = build_cedula_targets(row)
                row_has_error = False
                per_row_statuses = []

                for target in targets:
                    cedula = target["cedula"]
                    cedulas_total += 1
                    try:
                        result = run_msp_query_with_retry(
                            cedula,
                            fecha_iso,
                            retries=args.retries,
                            retry_delay=args.retry_delay,
                        )
                        generated = is_coverage_generated(result)
                        status = "OK" if generated else "SIN_DATOS"
                        if generated:
                            cedulas_ok += 1
                        else:
                            cedulas_sin_datos += 1

                        normalized = normalize_result_for_pdf(result)
                        save_path = save_result(output_dir, dig_id, dig_tramite, cedula, fecha_iso, normalized)
                        batch_items.append(
                            {
                                "dig_id": dig_id,
                                "dig_tramite": dig_tramite,
                                "cedula": cedula,
                                "fecha_iso": fecha_iso,
                                "json_path": save_path,
                                "slot": target["slot"],
                                "order": target["order"],
                            }
                        )
                        per_row_statuses.append(f"{target['slot']}:{status}")
                    except Exception as exc:
                        row_has_error = True
                        cedulas_error += 1
                        per_row_statuses.append(f"{target['slot']}:ERROR")
                        print(
                            f"DIG_ID={dig_id} cedula={cedula} slot={target['slot']} fallo MSP: {exc}",
                            file=sys.stderr,
                        )

                if not row_has_error and not args.dry_run:
                    updated = mark_done(conn, dig_id, args.pending_value, args.done_value)
                    if updated:
                        marked += 1

                if row_has_error:
                    failures += 1

                joined_status = " | ".join(per_row_statuses)
                print(f"DIG_ID={dig_id} fecha={fecha_iso} -> {joined_status}")
                processed += 1
            except Exception as exc:
                failures += 1
                print(f"DIG_ID={dig_id} fallo: {exc}", file=sys.stderr)
            finally:
                handled += 1
                if args.pdf_per_batch and args.batch_size > 0 and handled % args.batch_size == 0:
                    if batch_items:
                        print(f"Generando PDFs del bloque: {len(batch_items)}")
                        ok, fail = flush_pdf_batch(
                            batch_items,
                            keep_svg=args.keep_svg,
                            keep_generated_json=args.keep_generated_json,
                        )
                        pdf_ok += ok
                        pdf_fail += fail
                        batch_items = []
                    if not args.dry_run:
                        conn.commit()

        if args.pdf_per_batch and batch_items:
            print(f"Generando PDFs del bloque final: {len(batch_items)}")
            ok, fail = flush_pdf_batch(
                batch_items,
                keep_svg=args.keep_svg,
                keep_generated_json=args.keep_generated_json,
            )
            pdf_ok += ok
            pdf_fail += fail

        if not args.dry_run:
            conn.commit()
    finally:
        conn.close()

    print(
        f"Resumen: procesadas={processed} marcadas={marked} fallos={failures} "
        f"cedulas_total={cedulas_total} cedulas_ok={cedulas_ok} "
        f"cedulas_sin_datos={cedulas_sin_datos} cedulas_error={cedulas_error} "
        f"pdf_ok={pdf_ok} pdf_fallos={pdf_fail} dry_run={args.dry_run}"
    )
    return 0 if failures == 0 and pdf_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
