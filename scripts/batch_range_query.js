const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { runSingle } = require("./query_live");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key.startsWith("--")) {
      args[key.slice(2)] = value;
      index += 1;
    }
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function validateCedula(cedula) {
  if (!/^\d{10}$/.test(cedula || "")) {
    throw new Error("La cedula debe tener 10 digitos.");
  }
}

function validateDate(dateValue, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue || "")) {
    throw new Error(`${fieldName} debe usar formato YYYY-MM-DD.`);
  }
  const date = new Date(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} no es valida.`);
  }
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function expandDateRange(start, end) {
  const days = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    days.push(formatDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function classifyError(error) {
  const message = String(error && error.message ? error.message : error);
  if (/cedula|fecha/i.test(message)) {
    return "validation_error";
  }
  if (/fetch failed|network|ECONN|ETIMEDOUT|timeout/i.test(message)) {
    return "network_error";
  }
  return "unknown_error";
}

function pdfPathFor(cedula, fecha) {
  return path.resolve("output", `cobertura_${safeFilename(cedula)}_${safeFilename(fecha)}.pdf`);
}

function jsonPathFor(cedula, fecha) {
  return path.resolve("output", `cobertura_${safeFilename(cedula)}_${safeFilename(fecha)}.json`);
}

function parseCedulasArg(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((cedula) => {
      validateCedula(cedula);
      return cedula;
    });
}

function loadRangeCsv(csvPath) {
  const rows = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const [header, ...data] = rows;
  const columns = header.split(",").map((item) => item.trim());
  const cedulaIndex = columns.indexOf("cedula");
  const startIndex = columns.indexOf("fecha_inicio");
  const endIndex = columns.indexOf("fecha_fin");
  if (cedulaIndex < 0 || startIndex < 0 || endIndex < 0) {
    throw new Error("El CSV debe tener columnas cedula,fecha_inicio,fecha_fin");
  }
  return data
    .map((line) => line.split(","))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({
      cedula: parts[cedulaIndex].trim(),
      fecha_inicio: parts[startIndex].trim(),
      fecha_fin: parts[endIndex].trim(),
    }));
}

function buildJobs(args) {
  if (args.input_csv) {
    return loadRangeCsv(path.resolve(args.input_csv)).map((row) => {
      validateCedula(row.cedula);
      const start = validateDate(row.fecha_inicio, "fecha_inicio");
      const end = validateDate(row.fecha_fin, "fecha_fin");
      if (start > end) {
        throw new Error(`fecha_inicio no puede ser mayor que fecha_fin para ${row.cedula}.`);
      }
      return {
        cedula: row.cedula,
        fecha_inicio: row.fecha_inicio,
        fecha_fin: row.fecha_fin,
        fechas: expandDateRange(start, end),
      };
    });
  }

  const cedulas = args.cedulas ? parseCedulasArg(args.cedulas) : [];
  if (args.cedula) {
    validateCedula(args.cedula);
    cedulas.push(args.cedula);
  }
  const uniqueCedulas = [...new Set(cedulas)];
  if (!uniqueCedulas.length || !args.fecha_inicio || !args.fecha_fin) {
    throw new Error("Usa --cedula o --cedulas junto con --fecha_inicio y --fecha_fin, o --input_csv.");
  }

  const start = validateDate(args.fecha_inicio, "fecha_inicio");
  const end = validateDate(args.fecha_fin, "fecha_fin");
  if (start > end) {
    throw new Error("fecha_inicio no puede ser mayor que fecha_fin.");
  }
  const fechas = expandDateRange(start, end);
  return uniqueCedulas.map((cedula) => ({
    cedula,
    fecha_inicio: args.fecha_inicio,
    fecha_fin: args.fecha_fin,
    fechas,
  }));
}

async function generatePdf(cedula, fecha) {
  const result = spawnSync("node", ["scripts/generate_pdf.js", "--cedula", cedula, "--fecha", fecha], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Fallo generando PDF.");
  }

  return {
    pdfPath: pdfPathFor(cedula, fecha),
    jsonPath: jsonPathFor(cedula, fecha),
  };
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
    iess_tipo: iess.TipoSeguro || "",
    issfa_estado: issfa.EstadoCobertura || "",
    issfa_tipo: issfa.TipoSeguro || "",
    isspol_estado: isspol.EstadoCobertura || "",
    isspol_tipo: isspol.TipoSeguro || "",
    privada_codigo:
      data && data.coberturaPrivada && data.coberturaPrivada.CodigoMensaje
        ? data.coberturaPrivada.CodigoMensaje
        : "",
  };
}

async function executeSingle(cedula, fecha) {
  const startedAt = Date.now();
  const response = await runSingle(cedula, fecha);
  const artifacts = await generatePdf(cedula, fecha);
  return {
    cedula,
    fecha,
    status: "success",
    duration_ms: Date.now() - startedAt,
    json_path: artifacts.jsonPath,
    pdf_path: artifacts.pdfPath,
    response,
    summary: extractCoverageSummary(response),
  };
}

function buildJobFilePath(job) {
  return path.join(
    path.resolve("output", "jobs"),
    `job_${safeFilename(job.cedula)}_${safeFilename(job.fecha_inicio)}_${safeFilename(job.fecha_fin)}.json`
  );
}

function writeJson(filePath, content) {
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, rows) {
  const headers = [
    "cedula",
    "fecha",
    "status",
    "attempts",
    "duration_ms",
    "nombre",
    "iess_estado",
    "iess_tipo",
    "issfa_estado",
    "issfa_tipo",
    "isspol_estado",
    "isspol_tipo",
    "privada_codigo",
    "json_path",
    "pdf_path",
    "error",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((header) => csvEscape(row[header] ?? ""));
    lines.push(values.join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const jobs = buildJobs(args);
  const waitMinMs = Number(args.wait_min_ms || 4000);
  const waitMaxMs = Number(args.wait_max_ms || 11000);
  const retries = Number(args.retries || 2);

  const outputDir = path.resolve("output");
  const jobDir = path.join(outputDir, "jobs");
  const reportDir = path.join(outputDir, "reports");
  ensureDir(outputDir);
  ensureDir(jobDir);
  ensureDir(reportDir);

  const allResults = [];
  const totalUnits = jobs.reduce((acc, job) => acc + job.fechas.length, 0);
  let processedUnits = 0;

  for (const job of jobs) {
    const results = [];
    const jobFile = buildJobFilePath(job);

    for (let index = 0; index < job.fechas.length; index += 1) {
      const fecha = job.fechas[index];
      let attempts = 0;
      let done = false;

      while (!done) {
        attempts += 1;
        try {
          const item = await executeSingle(job.cedula, fecha);
          item.attempts = attempts;
          results.push(item);
          allResults.push(item);
          done = true;
        } catch (error) {
          const kind = classifyError(error);
          if (attempts > retries || kind === "validation_error") {
            const failed = {
              cedula: job.cedula,
              fecha,
              status: kind,
              attempts,
              duration_ms: "",
              error: String(error.message || error),
              json_path: "",
              pdf_path: "",
              summary: {},
            };
            results.push(failed);
            allResults.push(failed);
            done = true;
          } else {
            await sleep(randomBetween(15000, 40000));
          }
        }
      }

      processedUnits += 1;
      writeJson(jobFile, {
        cedula: job.cedula,
        fecha_inicio: job.fecha_inicio,
        fecha_fin: job.fecha_fin,
        generated_at: new Date().toISOString(),
        processed_units: processedUnits,
        total_units: totalUnits,
        results,
      });

      if (processedUnits < totalUnits) {
        await sleep(randomBetween(waitMinMs, waitMaxMs));
      }
    }
  }

  const reportStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const consolidatedJson = path.join(reportDir, `batch_report_${reportStamp}.json`);
  const consolidatedCsv = path.join(reportDir, `batch_report_${reportStamp}.csv`);
  const csvRows = allResults.map((item) => ({
    cedula: item.cedula,
    fecha: item.fecha,
    status: item.status,
    attempts: item.attempts,
    duration_ms: item.duration_ms || "",
    nombre: item.summary ? item.summary.nombre || "" : "",
    iess_estado: item.summary ? item.summary.iess_estado || "" : "",
    iess_tipo: item.summary ? item.summary.iess_tipo || "" : "",
    issfa_estado: item.summary ? item.summary.issfa_estado || "" : "",
    issfa_tipo: item.summary ? item.summary.issfa_tipo || "" : "",
    isspol_estado: item.summary ? item.summary.isspol_estado || "" : "",
    isspol_tipo: item.summary ? item.summary.isspol_tipo || "" : "",
    privada_codigo: item.summary ? item.summary.privada_codigo || "" : "",
    json_path: item.json_path || "",
    pdf_path: item.pdf_path || "",
    error: item.error || "",
  }));

  writeJson(consolidatedJson, {
    generated_at: new Date().toISOString(),
    total_jobs: jobs.length,
    total_results: allResults.length,
    success_count: allResults.filter((item) => item.status === "success").length,
    failure_count: allResults.filter((item) => item.status !== "success").length,
    results: allResults,
  });
  writeCsv(consolidatedCsv, csvRows);

  console.log(
    JSON.stringify(
      {
        total_jobs: jobs.length,
        total_results: allResults.length,
        consolidated_json: consolidatedJson,
        consolidated_csv: consolidatedCsv,
        job_files: jobs.map((job) => buildJobFilePath(job)),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
