import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterable, List, Optional


DEFAULT_ENDPOINT = os.getenv("COBERTURA_ENDPOINT", "").strip()
DEFAULT_TIMEOUT = float(os.getenv("COBERTURA_TIMEOUT", "30"))
DEFAULT_DELAY = float(os.getenv("COBERTURA_DELAY", "1.0"))


@dataclass
class QueryInput:
    cedula: str
    fecha: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Consulta coberturas de salud de forma individual o por lote."
    )
    parser.add_argument("--cedula", help="Numero de cedula.")
    parser.add_argument("--fecha", help="Fecha en formato YYYY-MM-DD.")
    parser.add_argument("--input", help="CSV de entrada con columnas cedula,fecha.")
    parser.add_argument("--output", help="CSV de salida para consultas por lote.")
    parser.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help="Endpoint HTTP real del portal cuando se identifique.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
        help="Segundos de espera entre consultas en lote.",
    )
    return parser.parse_args()


def validate_fecha(fecha: str) -> str:
    try:
        datetime.strptime(fecha, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"Fecha invalida: {fecha}. Usa YYYY-MM-DD.") from exc
    return fecha


def validate_cedula(cedula: str) -> str:
    cedula = cedula.strip()
    if not cedula.isdigit():
        raise ValueError(f"Cedula invalida: {cedula}. Debe contener solo digitos.")
    if len(cedula) != 10:
        raise ValueError(f"Cedula invalida: {cedula}. Debe tener 10 digitos.")
    return cedula


def load_queries(args: argparse.Namespace) -> List[QueryInput]:
    if args.input:
        return list(load_queries_from_csv(args.input))

    if not args.cedula or not args.fecha:
        raise ValueError("Debes indicar --cedula y --fecha, o usar --input.")

    return [QueryInput(validate_cedula(args.cedula), validate_fecha(args.fecha))]


def load_queries_from_csv(path: str) -> Iterable[QueryInput]:
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        required = {"cedula", "fecha"}
        if not required.issubset(reader.fieldnames or set()):
            raise ValueError("El CSV debe contener columnas cedula y fecha.")
        for row in reader:
            yield QueryInput(
                cedula=validate_cedula(row["cedula"]),
                fecha=validate_fecha(row["fecha"]),
            )


def perform_query(item: QueryInput, endpoint: str) -> Dict[str, str]:
    if not endpoint:
        return {
            "cedula": item.cedula,
            "fecha": item.fecha,
            "status": "pending_endpoint",
            "detail": (
                "Falta configurar COBERTURA_ENDPOINT o --endpoint con la llamada real "
                "del portal."
            ),
        }

    payload = json.dumps({"cedula": item.cedula, "fecha": item.fecha}).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
            body = response.read().decode("utf-8", errors="replace")
            return {
                "cedula": item.cedula,
                "fecha": item.fecha,
                "status": "ok",
                "http_status": str(response.status),
                "detail": body[:2000],
            }
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {
            "cedula": item.cedula,
            "fecha": item.fecha,
            "status": "http_error",
            "http_status": str(exc.code),
            "detail": detail[:2000],
        }
    except urllib.error.URLError as exc:
        return {
            "cedula": item.cedula,
            "fecha": item.fecha,
            "status": "network_error",
            "detail": str(exc.reason),
        }


def write_results(path: str, results: List[Dict[str, str]]) -> None:
    fieldnames = ["cedula", "fecha", "status", "http_status", "detail"]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def main() -> int:
    try:
        args = parse_args()
        queries = load_queries(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    results: List[Dict[str, str]] = []
    total = len(queries)
    for index, item in enumerate(queries, start=1):
        result = perform_query(item, args.endpoint)
        results.append(result)
        print(
            f"[{index}/{total}] cedula={item.cedula} fecha={item.fecha} status={result['status']}"
        )
        if index < total:
            time.sleep(max(args.delay, 0))

    if args.output:
        write_results(args.output, results)
        print(f"Resultados escritos en: {args.output}")
    else:
        print(json.dumps(results[0] if total == 1 else results, ensure_ascii=True, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
