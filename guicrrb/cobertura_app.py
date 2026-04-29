import sys
import os
import subprocess
from datetime import datetime
from PyQt6.QtWidgets import (
    QApplication,
    QMainWindow,
    QPushButton,
    QVBoxLayout,
    QHBoxLayout,
    QWidget,
    QDateEdit,
    QLabel,
    QTextEdit,
    QProgressBar,
    QComboBox,
    QMessageBox,
    QFileDialog,
    QLineEdit,
    QGroupBox,
    QStatusBar,
    QCheckBox,
)
from PyQt6.QtCore import QThread, pyqtSignal, QDate

sys.path.insert(0, os.path.dirname(__file__))
import oracledb

ORACLE_CONFIG = {
    "user": "DIGITALIZACION",
    "password": "DIGITALIZACION",
    "dsn": "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=172.16.60.21)(PORT=1521))(CONNECT_DATA=(SID=PRDSGH2)))",
    "lib_dir": "/opt/oracle/instantclient_21_11",
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)


class Worker(QThread):
    progress = pyqtSignal(int)
    log = pyqtSignal(str)
    finished = pyqtSignal()
    status = pyqtSignal(str)

    def __init__(self, start_date, end_date, modo, output_dir, limit=100):
        super().__init__()
        self.start_date = start_date
        self.end_date = end_date
        self.modo = modo
        self.output_dir = output_dir
        self.limit = limit

    def run(self):
        try:
            self.status.emit("Consultando Oracle...")

            oracledb.init_oracle_client(lib_dir=ORACLE_CONFIG["lib_dir"])
            conn = oracledb.connect(
                user=ORACLE_CONFIG["user"],
                password=ORACLE_CONFIG["password"],
                dsn=ORACLE_CONFIG["dsn"],
            )
            cursor = conn.cursor()

            if self.modo == "DIG_COBERTURA":
                query = """
                    SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD,
                           DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02,
                           TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD')
                    FROM DIGITALIZACION
                    WHERE DIG_COBERTURA = 'N'
                    AND DIG_FECHA_HASTA BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
                    AND ROWNUM <= :limit
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

            cursor.execute(
                query, sd=self.start_date, ed=self.end_date, limit=self.limit
            )
            records = cursor.fetchall()
            conn.close()

            total = len(records)
            self.log.emit(f"Registros a procesar: {total}")

            if total == 0:
                self.log.emit("No hay registros para procesar.")
                self.status.emit("Sin registros")
                self.finished.emit()
                return

            ok_count = 0
            fail_count = 0

            for i, row in enumerate(records):
                dig_id, tramite, titular, es_menor, d1, d2, fecha = row
                self.status.emit(f"Procesando {i + 1}/{total}: {tramite}")
                self.log.emit(f"[{i + 1}/{total}] {tramite} ({titular})")

                cedulas = [titular]
                if es_menor == "S":
                    cedulas.extend([d for d in [d1, d2] if d and d.strip()])

                pdf_paths = []
                for cedula in cedulas:
                    cmd = [
                        "node",
                        os.path.join(REPO_DIR, "scripts/batch_oracle.js"),
                        f"--cedula={cedula}",
                        f"--fecha={fecha}",
                        f"--output-dir={self.output_dir}",
                    ]
                    result = subprocess.run(
                        cmd, capture_output=True, text=True, cwd=REPO_DIR
                    )
                    if result.returncode == 0:
                        self.log.emit(f"  OK: {cedula}")
                        pdf_paths.append(
                            os.path.join(
                                self.output_dir, f"cobertura_{cedula}_{fecha}.pdf"
                            )
                        )
                        ok_count += 1
                    else:
                        self.log.emit(f"  ERROR: {cedula}")
                        fail_count += 1

                if len(pdf_paths) > 1:
                    from pypdf import PdfWriter

                    merged_name = f"{tramite}_CC.pdf"
                    merged_path = os.path.join(self.output_dir, merged_name)
                    merger = PdfWriter()
                    for pdf in pdf_paths:
                        if os.path.exists(pdf):
                            try:
                                merger.append(pdf)
                            except:
                                pass
                    with open(merged_path, "wb") as f:
                        merger.write(f)
                    for pdf in pdf_paths:
                        try:
                            os.remove(pdf)
                        except:
                            pass
                    self.log.emit(f"  Merge: {merged_name}")
                elif len(pdf_paths) == 1:
                    final_name = f"{tramite}_CC.pdf"
                    final_path = os.path.join(self.output_dir, final_name)
                    try:
                        os.rename(pdf_paths[0], final_path)
                    except:
                        pass
                    self.log.emit(f"  Rename: {final_name}")

                self.progress.emit(int(((i + 1) / total) * 100))

            self.log.emit(f"\n--- FINALIZADO ---")
            self.log.emit(f"Procesados: {ok_count + fail_count}")
            self.log.emit(f"OK: {ok_count}, Errores: {fail_count}")
            self.status.emit(f"Completado: {ok_count} OK")
        except Exception as e:
            self.log.emit(f"ERROR: {str(e)}")
            self.status.emit("Error de conexion")
        finally:
            self.finished.emit()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Cobertura MSP - Generador")
        self.setMinimumSize(700, 600)
        self.worker = None

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        config_group = QGroupBox("Configuracion")
        config_layout = QVBoxLayout()

        fecha_layout = QHBoxLayout()
        fecha_layout.addWidget(QLabel("Desde:"))
        self.date_start = QDateEdit(QDate.currentDate().addMonths(-1))
        self.date_start.setCalendarPopup(True)
        fecha_layout.addWidget(self.date_start)
        fecha_layout.addWidget(QLabel("Hasta:"))
        self.date_end = QDateEdit(QDate.currentDate())
        self.date_end.setCalendarPopup(True)
        fecha_layout.addWidget(self.date_end)
        config_layout.addLayout(fecha_layout)

        output_layout = QHBoxLayout()
        output_layout.addWidget(QLabel("Salida:"))
        self.output_dir = QLineEdit(os.path.join(REPO_DIR, "output"))
        self.output_dir.setReadOnly(True)
        output_layout.addWidget(self.output_dir)
        self.btn_browse = QPushButton("...")
        self.btn_browse.setMaximumWidth(40)
        self.btn_browse.clicked.connect(self.browse_output)
        output_layout.addWidget(self.btn_browse)
        config_layout.addLayout(output_layout)

        modo_layout = QHBoxLayout()
        modo_layout.addWidget(QLabel("Modo:"))
        self.modo = QComboBox()
        self.modo.addItem("Solo pendientes (DIG_COBERTURA=N)", "DIG_COBERTURA")
        self.modo.addItem("Prueba (max 100)", "TODOS")
        modo_layout.addWidget(self.modo)
        modo_layout.addStretch()
        config_layout.addLayout(modo_layout)

        config_group.setLayout(config_layout)
        layout.addWidget(config_group)

        self.progress_bar = QProgressBar()
        layout.addWidget(self.progress_bar)

        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumHeight(200)
        layout.addWidget(self.log_view)

        btn_layout = QHBoxLayout()
        self.btn_start = QPushButton("▶ Iniciar")
        self.btn_start.setStyleSheet("QPushButton { font-weight: bold; }")
        self.btn_start.clicked.connect(self.start_process)
        btn_layout.addWidget(self.btn_start)
        self.btn_stop = QPushButton("■ Detener")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self.stop_process)
        btn_layout.addWidget(self.btn_stop)
        layout.addLayout(btn_layout)

        self.status_bar = QStatusBar()
        self.status_bar.setSizeGripEnabled(False)
        self.status_bar.showMessage("Listo")
        self.setStatusBar(self.status_bar)

    def browse_output(self):
        folder = QFileDialog.getExistingDirectory(
            self, "Seleccionar carpeta de salida", self.output_dir.text()
        )
        if folder:
            self.output_dir.setText(folder)

    def start_process(self):
        if self.worker and self.worker.isRunning():
            QMessageBox.warning(self, "En progreso", "Ya hay un proceso en ejecucion.")
            return

        sd = self.date_start.date().toString("yyyy-MM-dd")
        ed = self.date_end.date().toString("yyyy-MM-dd")
        modo = self.modo.currentData()
        output = self.output_dir.text()

        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.progress_bar.setValue(0)
        self.log_view.clear()

        self.worker = Worker(sd, ed, modo, output)
        self.worker.progress.connect(self.progress_bar.setValue)
        self.worker.log.connect(self.log_view.append)
        self.worker.status.connect(self.status_bar.showMessage)
        self.worker.finished.connect(self.on_finished)
        self.worker.start()

    def stop_process(self):
        if self.worker:
            self.worker.terminate()
            self.worker.wait()
            self.status_bar.showMessage("Detenido por usuario")
            self.on_finished()

    def on_finished(self):
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
