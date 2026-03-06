const fs = require("fs");
const path = require("path");
const { runSingle } = require("./query_live");
const { generatePdfFromResult } = require("./generate_pdf");

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

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function buildThrottleConfig(args) {
  const baseMinMs = toPositiveNumber(args.wait_min_ms, 8000);
  const baseMaxMs = Math.max(toPositiveNumber(args.wait_max_ms, 12000), baseMinMs);
  const goodMinMs = toPositiveNumber(args.good_wait_min_ms, 5000);
  const goodMaxMs = Math.max(toPositiveNumber(args.good_wait_max_ms, 8000), goodMinMs);
  const busyMinMs = toPositiveNumber(args.busy_wait_min_ms, 12000);
  const busyMaxMs = Math.max(toPositiveNumber(args.busy_wait_max_ms, 20000), busyMinMs);
  const cooldownMinMs = toPositiveNumber(args.cooldown_wait_min_ms, 30000);
  const cooldownMaxMs = Math.max(toPositiveNumber(args.cooldown_wait_max_ms, 60000), cooldownMinMs);
  const longPauseMinMs = toPositiveNumber(args.long_pause_min_ms, 120000);
  const longPauseMaxMs = Math.max(toPositiveNumber(args.long_pause_max_ms, 240000), longPauseMinMs);

  return {
    baseMinMs,
    baseMaxMs,
    goodMinMs,
    goodMaxMs,
    busyMinMs,
    busyMaxMs,
    cooldownMinMs,
    cooldownMaxMs,
    longPauseMinMs,
    longPauseMaxMs,
    goodLatencyMs: toPositiveNumber(args.good_latency_ms, 2000),
    mediumLatencyMs: toPositiveNumber(args.medium_latency_ms, 5000),
    longPauseEvery: Math.floor(toPositiveNumber(args.long_pause_every, 25)),
    errorCooldownThreshold: Math.floor(toPositiveNumber(args.error_cooldown_threshold, 2)),
    hardPauseErrorThreshold: Math.floor(toPositiveNumber(args.hard_pause_error_threshold, 3)),
    hardPauseMs: Math.floor(toPositiveNumber(args.hard_pause_ms, 180000)),
    ultraSafeMode: String(args.ultra_safe_mode || "false").toLowerCase() === "true",
    maxDailyQueries: Math.floor(toPositiveNumber(args.max_daily_queries, 5000)),
    morningMinMs: toPositiveNumber(args.morning_wait_min_ms, 7000),
    morningMaxMs: Math.max(toPositiveNumber(args.morning_wait_max_ms, 10000), toPositiveNumber(args.morning_wait_min_ms, 7000)),
    afternoonMinMs: toPositiveNumber(args.afternoon_wait_min_ms, 10000),
    afternoonMaxMs: Math.max(
      toPositiveNumber(args.afternoon_wait_max_ms, 14000),
      toPositiveNumber(args.afternoon_wait_min_ms, 10000)
    ),
    eveningMinMs: toPositiveNumber(args.evening_wait_min_ms, 14000),
    eveningMaxMs: Math.max(toPositiveNumber(args.evening_wait_max_ms, 20000), toPositiveNumber(args.evening_wait_min_ms, 14000)),
    overnightMinMs: toPositiveNumber(args.overnight_wait_min_ms, 20000),
    overnightMaxMs: Math.max(
      toPositiveNumber(args.overnight_wait_max_ms, 35000),
      toPositiveNumber(args.overnight_wait_min_ms, 20000)
    ),
    scheduleTimezone: args.schedule_timezone || "America/Guayaquil",
  };
}

function createThrottleState() {
  return {
    lastQueryLatencyMs: null,
    consecutiveErrors: 0,
    completedQueries: 0,
    stopped: false,
    stopReason: "",
  };
}

function resolveHourInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourToken = parts.find((item) => item.type === "hour");
  if (!hourToken) {
    return date.getHours();
  }
  const hour = Number(hourToken.value);
  return Number.isFinite(hour) ? hour : date.getHours();
}

function getScheduleDelay(now, config) {
  const hour = resolveHourInTimezone(now, config.scheduleTimezone);
  if (hour >= 7 && hour < 14) {
    return {
      minMs: config.morningMinMs,
      maxMs: config.morningMaxMs,
      bucket: "07-14",
    };
  }
  if (hour >= 14 && hour < 20) {
    return {
      minMs: config.afternoonMinMs,
      maxMs: config.afternoonMaxMs,
      bucket: "14-20",
    };
  }
  if (hour >= 20 && hour < 24) {
    return {
      minMs: config.eveningMinMs,
      maxMs: config.eveningMaxMs,
      bucket: "20-24",
    };
  }
  return {
    minMs: config.overnightMinMs,
    maxMs: config.overnightMaxMs,
    bucket: "00-07",
  };
}

function buildInterQueryDelay(throttle, config) {
  const scheduled = getScheduleDelay(new Date(), config);
  if (config.longPauseEvery > 0 && throttle.completedQueries > 0 && throttle.completedQueries % config.longPauseEvery === 0) {
    return {
      ms: Math.max(randomBetween(config.longPauseMinMs, config.longPauseMaxMs), randomBetween(scheduled.minMs, scheduled.maxMs)),
      reason: "long_pause",
      window: scheduled.bucket,
    };
  }

  if (throttle.consecutiveErrors >= config.errorCooldownThreshold) {
    return {
      ms: Math.max(randomBetween(config.cooldownMinMs, config.cooldownMaxMs), randomBetween(scheduled.minMs, scheduled.maxMs)),
      reason: "error_cooldown",
      window: scheduled.bucket,
    };
  }

  let adaptive;
  if (throttle.lastQueryLatencyMs !== null && throttle.lastQueryLatencyMs <= config.goodLatencyMs) {
    adaptive = {
      ms: randomBetween(config.goodMinMs, config.goodMaxMs),
      reason: "good_network",
    };
  } else if (throttle.lastQueryLatencyMs !== null && throttle.lastQueryLatencyMs > config.mediumLatencyMs) {
    adaptive = {
      ms: randomBetween(config.busyMinMs, config.busyMaxMs),
      reason: "busy_network",
    };
  } else {
    adaptive = {
      ms: randomBetween(config.baseMinMs, config.baseMaxMs),
      reason: "normal_network",
    };
  }
  const scheduledMs = randomBetween(scheduled.minMs, scheduled.maxMs);
  if (config.ultraSafeMode) {
    return {
      ms: Math.max(adaptive.ms, scheduledMs),
      reason: `${adaptive.reason}+schedule`,
      window: scheduled.bucket,
    };
  }
  return {
    ms: adaptive.ms,
    reason: adaptive.reason,
    window: scheduled.bucket,
  };
}

function buildRetryDelay(config, kind) {
  if (kind === "network_error") {
    return randomBetween(config.cooldownMinMs, config.cooldownMaxMs);
  }
  return randomBetween(config.baseMinMs, config.baseMaxMs);
}

async function maybeApplyHardPause(throttle, config, context) {
  if (throttle.consecutiveErrors < config.hardPauseErrorThreshold) {
    return;
  }
  console.error(
    JSON.stringify(
      {
        event: "hard_pause",
        reason: context,
        wait_ms: config.hardPauseMs,
        consecutive_errors: throttle.consecutiveErrors,
      },
      null,
      2
    )
  );
  await sleep(config.hardPauseMs);
  throttle.consecutiveErrors = 0;
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
  const queryStartedAt = Date.now();
  const response = await runSingle(cedula, fecha);
  const queryDurationMs = Date.now() - queryStartedAt;
  const artifacts = await generatePdfFromResult({
    result: response,
    cedula,
    fecha,
  });
  return {
    cedula,
    fecha,
    status: "success",
    duration_ms: Date.now() - startedAt,
    query_duration_ms: queryDurationMs,
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
  const throttleConfig = buildThrottleConfig(args);
  const throttleState = createThrottleState();
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
    if (throttleState.stopped) {
      break;
    }
    const results = [];
    const jobFile = buildJobFilePath(job);

    for (let index = 0; index < job.fechas.length; index += 1) {
      if (throttleState.stopped) {
        break;
      }
      if (throttleConfig.ultraSafeMode && throttleState.completedQueries >= throttleConfig.maxDailyQueries) {
        throttleState.stopped = true;
        throttleState.stopReason = `max_daily_queries_reached:${throttleConfig.maxDailyQueries}`;
        break;
      }
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
          throttleState.lastQueryLatencyMs = item.query_duration_ms;
          throttleState.consecutiveErrors = 0;
          throttleState.completedQueries += 1;
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
            throttleState.consecutiveErrors += 1;
            throttleState.completedQueries += 1;
            await maybeApplyHardPause(throttleState, throttleConfig, "after_failed_query");
            done = true;
          } else {
            throttleState.consecutiveErrors += 1;
            await maybeApplyHardPause(throttleState, throttleConfig, "before_retry");
            await sleep(buildRetryDelay(throttleConfig, kind));
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
        const nextDelay = buildInterQueryDelay(throttleState, throttleConfig);
        console.error(
          JSON.stringify(
            {
              event: "throttle_wait",
              reason: nextDelay.reason,
              window: nextDelay.window || "n/a",
              wait_ms: nextDelay.ms,
              last_query_latency_ms: throttleState.lastQueryLatencyMs,
              consecutive_errors: throttleState.consecutiveErrors,
              completed_queries: throttleState.completedQueries,
            },
            null,
            2
          )
        );
        await sleep(nextDelay.ms);
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
    stopped: throttleState.stopped,
    stop_reason: throttleState.stopReason,
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
        stopped: throttleState.stopped,
        stop_reason: throttleState.stopReason,
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
