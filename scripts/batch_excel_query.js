const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { runSingle } = require("./query_live");
const { generatePdfFromResult } = require("./generate_pdf");
const { formatDateTimeInTimezone, formatTimestampSlugInTimezone } = require("./runtime_config");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function validateCedula(cedula) {
  if (!/^\d{10}$/.test(String(cedula || "").trim())) {
    throw new Error("La cedula debe tener 10 digitos.");
  }
}

function validateFecha(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || "").trim())) {
    throw new Error("La fecha debe usar formato YYYY-MM-DD.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function classifyError(error) {
  const message = String(error && error.message ? error.message : error);
  if (/cedula|fecha|fila/i.test(message)) {
    return "validation_error";
  }
  if (/fetch failed|network|ECONN|ETIMEDOUT|timeout/i.test(message)) {
    return "network_error";
  }
  if (/PDF/i.test(message)) {
    return "pdf_error";
  }
  return "unknown_error";
}

function readWorkbookRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const firstSheet = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows.map((row, index) => ({
    row_number: index + 2,
    nombre_pdf: String(row.nombre_pdf || "").trim(),
    cedula: String(row.cedula || "").trim(),
    fecha: String(row.fecha || "").trim(),
  }));
}

function validateRows(rows) {
  if (!rows.length) {
    throw new Error("El Excel no contiene filas de datos.");
  }
  rows.forEach((row) => {
    if (!row.nombre_pdf) {
      throw new Error(`La fila ${row.row_number} no tiene nombre_pdf.`);
    }
    validateCedula(row.cedula);
    validateFecha(row.fecha);
  });
}

function extractCoverageSummary(payload) {
  const data = payload && payload.response && payload.response.data ? payload.response.data : null;
  const aseguradoras =
    data && data.coberturaSalud && data.coberturaSalud.CoberturaSeguros
      ? data.coberturaSalud.CoberturaSeguros.aseguradora || []
      : [];
  const lookup = new Map(aseguradoras.map((item) => [item.NombreInstitucion, item]));
  const iess = lookup.get("IESS") || {};
  const issfa = lookup.get("ISSFA") || {};
  const isspol = lookup.get("ISSPOL") || {};
  return {
    nombre: iess.Nombre || issfa.Nombre || isspol.Nombre || "",
    iess_estado: iess.EstadoCobertura || "",
    issfa_estado: issfa.EstadoCobertura || "",
    isspol_estado: isspol.EstadoCobertura || "",
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function processExcelFile(filePath, options = {}) {
  const rows = readWorkbookRows(filePath);
  validateRows(rows);
  const waitMinMs = Number(options.waitMinMs || 6000);
  const waitMaxMs = Number(options.waitMaxMs || 11000);
  const retries = Number(options.retries || 2);
  const reportsDir = path.resolve("output", "reports");
  ensureDir(reportsDir);

  const results = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let attempts = 0;
    let done = false;

    while (!done) {
      attempts += 1;
      try {
        const startedAt = Date.now();
        const response = await runSingle(row.cedula, row.fecha);
        const artifacts = await generatePdfFromResult({
          result: response,
          cedula: row.cedula,
          fecha: row.fecha,
          outputName: row.nombre_pdf,
        });
        results.push({
          ...row,
          status: "success",
          attempts,
          duration_ms: Date.now() - startedAt,
          pdf_path: artifacts.pdfPath,
          json_path: artifacts.jsonPath,
          summary: extractCoverageSummary(response),
        });
        done = true;
      } catch (error) {
        const kind = classifyError(error);
        if (attempts > retries || kind === "validation_error") {
          results.push({
            ...row,
            status: kind,
            attempts,
            duration_ms: "",
            error: String(error.message || error),
            pdf_path: "",
            json_path: "",
            summary: {},
          });
          done = true;
        } else {
          await sleep(randomBetween(15000, 40000));
        }
      }
    }

    if (index < rows.length - 1) {
      await sleep(randomBetween(waitMinMs, waitMaxMs));
    }
  }

  const stamp = formatTimestampSlugInTimezone(new Date());
  const jsonReport = path.join(reportsDir, `excel_batch_${stamp}.json`);
  const csvReport = path.join(reportsDir, `excel_batch_${stamp}.csv`);
  fs.writeFileSync(
    jsonReport,
    JSON.stringify(
      {
        generated_at: formatDateTimeInTimezone(new Date()),
        source_file: path.resolve(filePath),
        total_rows: results.length,
        success_count: results.filter((item) => item.status === "success").length,
        failure_count: results.filter((item) => item.status !== "success").length,
        results,
      },
      null,
      2
    ),
    "utf8"
  );

  const headers = [
    "nombre_pdf",
    "cedula",
    "fecha",
    "status",
    "attempts",
    "duration_ms",
    "nombre",
    "iess_estado",
    "issfa_estado",
    "isspol_estado",
    "pdf_path",
    "json_path",
    "error",
  ];
  const lines = [headers.join(",")];
  results.forEach((item) => {
    const values = [
      item.nombre_pdf,
      item.cedula,
      item.fecha,
      item.status,
      item.attempts || "",
      item.duration_ms || "",
      item.summary && item.summary.nombre ? item.summary.nombre : "",
      item.summary && item.summary.iess_estado ? item.summary.iess_estado : "",
      item.summary && item.summary.issfa_estado ? item.summary.issfa_estado : "",
      item.summary && item.summary.isspol_estado ? item.summary.isspol_estado : "",
      item.pdf_path || "",
      item.json_path || "",
      item.error || "",
    ].map(csvEscape);
    lines.push(values.join(","));
  });
  fs.writeFileSync(csvReport, lines.join("\n"), "utf8");

  return {
    json_report: jsonReport,
    csv_report: csvReport,
    total_rows: results.length,
    success_count: results.filter((item) => item.status === "success").length,
    failure_count: results.filter((item) => item.status !== "success").length,
    results,
  };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error("Debes indicar la ruta del archivo Excel.");
  }
  const result = await processExcelFile(filePath);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  processExcelFile,
};
