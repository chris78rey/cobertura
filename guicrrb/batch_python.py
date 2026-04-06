#!/usr/bin/env python3
import sys
import os
import time
import random
import json
import hashlib
import base64
import urllib.request
import urllib.error
import uuid
import oracledb
from pypdf import PdfWriter
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
from datetime import datetime

ORACLE_CONFIG = {
    "user": "DIGITALIZACION",
    "password": "DIGITALIZACION",
    "dsn": "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=172.16.60.21)(PORT=1521))(CONNECT_DATA=(SID=PRDSGH2)))",
    "lib_dir": "/opt/oracle/instantclient_21_11",
}

PORTAL_URL = "https://coberturasalud.msp.gob.ec/"
ACTION_GET_CAPTCHA = "40e5613a02e25c0dfb759fd7f199149081432edf13"
ACTION_API_CLIENT = "70987a4dcfb783907102d476e4a450486019bbcc62"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
DELAY_MS = 2000
MAX_RETRIES = 3


def csconsulta(cedula):
    out = ""
    for i in range(0, len(cedula), 2):
        a = int(cedula[i]) if i < len(cedula) else 0
        b = int(cedula[i + 1]) if i + 1 < len(cedula) else 0
        out += str(a + b)
    return out


def aes_encrypt(text, token):
    key = hashlib.sha256(token.encode()).digest()
    iv = token[:16].encode() if len(token) >= 16 else token.ljust(16, "0").encode()

    def pkcs7_pad(data, block_size=16):
        padding = block_size - (len(data) % block_size)
        return data + bytes([padding] * padding)

    def xor_blocks(b1, b2):
        return bytes(a ^ b for a, b in zip(b1, b2))

    padded = pkcs7_pad(text.encode())
    blocks = [padded[i : i + 16] for i in range(0, len(padded), 16)]

    result = b""
    prev = iv
    for block in blocks:
        xored = xor_blocks(block, prev)
        encrypted = bytes(a ^ b for a, b in zip(xored, key[:16]))
        prev = encrypted
        result += encrypted

    return base64.b64encode(result).decode()


def parse_rsc_payload(text):
    for line in text.split("\n"):
        if line.startswith("1:"):
            return json.loads(line[2:])
    return None


def post_action(action_id, params, cookie=None):
    data = json.dumps(params)
    headers = {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": USER_AGENT,
        "next-action": action_id,
        "Accept": "*/*",
    }
    if cookie:
        headers["Cookie"] = cookie

    req = urllib.request.Request(
        PORTAL_URL, data=data.encode(), headers=headers, method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            set_cookie = resp.getheader("Set-Cookie", "")
            body = resp.read().decode()
            return set_cookie, body
    except urllib.error.HTTPError as e:
        return "", f"HTTP {e.code}: {e.reason}"
    except Exception as e:
        return "", str(e)


def query_msp(cedula, fecha):
    for attempt in range(MAX_RETRIES):
        try:
            req_id = str(uuid.uuid4())
            cookie1, resp1 = post_action(ACTION_GET_CAPTCHA, [req_id])
            if not resp1:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(DELAY_MS * (2**attempt) / 1000)
                    continue
                return None

            data1 = parse_rsc_payload(resp1)
            if not data1 or data1.get("success") != "success":
                if attempt < MAX_RETRIES - 1:
                    time.sleep(DELAY_MS * (2**attempt) / 1000)
                    continue
                return None

            token = data1.get("data", {}).get("token", "")

            encrypted_id = aes_encrypt(cedula, token)
            encrypted_date = aes_encrypt(fecha, token)
            cs = csconsulta(cedula)

            cookie2, resp2 = post_action(
                ACTION_API_CLIENT,
                [
                    "cobertura",
                    "POST",
                    {
                        "identificacion": encrypted_id,
                        "fechaConsulta": encrypted_date,
                        "token": token,
                        "csconsulta": cs,
                    },
                ],
                cookie1,
            )

            if not resp2:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(DELAY_MS * (2**attempt) / 1000)
                    continue
                return None

            result = parse_rsc_payload(resp2)
            if result and result.get("success") == "success":
                return result

            if attempt < MAX_RETRIES - 1:
                time.sleep(DELAY_MS * (2**attempt) / 1000)
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(DELAY_MS * (2**attempt) / 1000)
            else:
                return None

    return None


def get_oracle_connection():
    oracledb.init_oracle_client(lib_dir=ORACLE_CONFIG["lib_dir"])
    return oracledb.connect(
        user=ORACLE_CONFIG["user"],
        password=ORACLE_CONFIG["password"],
        dsn=ORACLE_CONFIG["dsn"],
    )


def query_records(conn, start_date, end_date, modo, limit=100):
    cursor = conn.cursor()

    if modo == "DIG_COBERTURA":
        query = """
            SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD,
                   DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02,
                   TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD')
            FROM DIGITALIZACION
            WHERE DIG_COBERTURA = 'N'
            AND DIG_FECHA_HASTA BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
        """
    else:
        query = """
            SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD,
                   DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02,
                   TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD')
            FROM DIGITALIZACION
            WHERE DIG_FECHA_HASTA BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
            AND ROWNUM <= :limit
        """

    if modo == "DIG_COBERTURA":
        cursor.execute(query, sd=start_date, ed=end_date)
    else:
        cursor.execute(query, sd=start_date, ed=end_date, limit=limit)

    return cursor.fetchall()


def format_date(fecha_iso):
    try:
        dt = datetime.strptime(fecha_iso, "%Y-%m-%d")
        return dt.strftime("%d de %B de %Y")
    except:
        return fecha_iso


def save_pdf(data, cedula, fecha, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    pdf_path = os.path.join(output_dir, f"cobertura_{cedula}_{fecha}.pdf")
    json_path = os.path.join(output_dir, f"cobertura_{cedula}_{fecha}.json")

    with open(json_path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    cobertura = data.get("coberturaSalud", {})
    aseguradoras = cobertura.get("CoberturaSeguros", {}).get("aseguradora", [])
    privados = data.get("coberturaPrivada", {})

    c = canvas.Canvas(pdf_path, pagesize=landscape(A4))
    width, height = landscape(A4)

    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, height - 50, "CONSULTA DE COBERTURA DE SALUD")
    c.setFont("Helvetica", 10)
    c.drawString(50, height - 70, f"Cedula: {cedula}")
    c.drawString(50, height - 85, f"Fecha: {format_date(fecha)}")
    c.drawString(
        50,
        height - 100,
        f"Fecha Consulta: {datetime.now().strftime('%d de %B de %Y %H:%M')}",
    )

    y = height - 140
    c.setFont("Helvetica-Bold", 11)
    c.drawString(50, y, "COBERTURA DE SALUD")
    y -= 20

    c.setFont("Helvetica-Bold", 9)
    c.drawString(50, y, "Institucion")
    c.drawString(200, y, "Estado")
    c.drawString(300, y, "Tipo")
    c.drawString(500, y, "Mensaje")
    y -= 5
    c.line(50, y, width - 50, y)
    y -= 15

    c.setFont("Helvetica", 8)
    for aseg in aseguradoras:
        if y < 100:
            c.showPage()
            y = height - 50

        nombre = aseg.get("NombreInstitucion", "")
        estado = "SI" if aseg.get("CoberturaSalud") == "1" else "NO"
        tipo = aseg.get("TipoSeguro", "")
        msg = aseg.get("MensajeServicioExterno", "")

        c.drawString(50, y, nombre[:30])
        c.drawString(200, y, estado)
        c.drawString(300, y, tipo[:40] if tipo else "")
        c.drawString(500, y, msg[:50] if msg else "")
        y -= 15

    y -= 10
    c.setFont("Helvetica-Bold", 11)
    c.drawString(50, y, "COBERTURA PRIVA")
    y -= 20

    priv_msg = privados.get("Mensaje", "No registra cobertura privada")
    c.setFont("Helvetica", 9)
    c.drawString(50, y, priv_msg)

    c.save()
    return {"pdfPath": pdf_path, "jsonPath": json_path}


def merge_pdfs(pdf_paths, output_path):
    merger = PdfWriter()
    for pdf in pdf_paths:
        try:
            if pdf and os.path.exists(pdf):
                merger.append(pdf)
        except:
            pass
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "wb") as f:
        merger.write(f)
    for pdf in pdf_paths:
        try:
            if pdf and os.path.exists(pdf):
                os.remove(pdf)
        except:
            pass


def process_batch(
    start_date,
    end_date,
    modo,
    output_dir,
    skip_update=False,
    limit=100,
    progress_callback=None,
):
    conn = get_oracle_connection()
    records = query_records(conn, start_date, end_date, modo, limit)

    print(f"Registros encontrados: {len(records)}")

    ok_count = 0
    fail_count = 0

    for i, row in enumerate(records):
        dig_id, tramite, titular, es_menor, d1, d2, fecha = row
        print(f"[{i + 1}/{len(records)}] {tramite} ({titular})")

        cedulas = [titular]
        if es_menor == "S":
            cedulas.extend([d for d in [d1, d2] if d and d.strip()])

        pdf_paths = []
        for cedula in cedulas:
            print(f"  Consultando {cedula}...")
            result = query_msp(cedula, fecha)

            if result and result.get("success") == "success":
                data = result.get("data", {})
                pdf_file = save_pdf(data, cedula, fecha, output_dir)
                pdf_paths.append(pdf_file.get("pdfPath", ""))
                print(f"  OK: {cedula}")
                ok_count += 1
            else:
                print(f"  FALLO: {cedula}")
                fail_count += 1

        if len(pdf_paths) > 1:
            merged_name = f"{tramite}_CC.pdf"
            merged_path = os.path.join(output_dir, merged_name)
            merge_pdfs(pdf_paths, merged_path)
            print(f"  Merged: {merged_name}")
        elif len(pdf_paths) == 1 and pdf_paths[0]:
            final_name = f"{tramite}_CC.pdf"
            final_path = os.path.join(output_dir, final_name)
            try:
                os.rename(pdf_paths[0], final_path)
                json_orig = pdf_paths[0].replace(".pdf", ".json")
                json_final = final_path.replace(".pdf", ".json")
                try:
                    os.rename(json_orig, json_final)
                except:
                    pass
            except:
                pass
            print(f"  Renamed: {final_name}")

        if modo == "DIG_COBERTURA" and not skip_update:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE DIGITALIZACION SET DIG_COBERTURA = 'S' WHERE DIG_ID = :id",
                id=dig_id,
            )
            conn.commit()

        wait_time = random.uniform(3, 7)
        print(f"  Esperando {wait_time:.1f}s...")
        time.sleep(wait_time)

        if progress_callback:
            progress_callback(int(((i + 1) / len(records)) * 100))

    conn.close()
    print(f"\n--- FINALIZADO ---")
    print(f"Exitosos: {ok_count}")
    print(f"Fallidos: {fail_count}")
    return ok_count, fail_count


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(
            "Usage: python batch_python.py <start_date> <end_date> <output_dir> [modo] [limit]"
        )
        print("  modo: DIG_COBERTURA (default) or TODOS")
        sys.exit(1)

    start_date = sys.argv[1]
    end_date = sys.argv[2]
    output_dir = sys.argv[3]
    modo = sys.argv[4] if len(sys.argv) > 4 else "DIG_COBERTURA"
    limit = int(sys.argv[5]) if len(sys.argv) > 5 else 100

    process_batch(start_date, end_date, modo, output_dir, limit=limit)
