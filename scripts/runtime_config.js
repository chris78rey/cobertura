const fs = require("fs");
const path = require("path");
const https = require("https");

let envLoaded = false;
let cachedAgent = null;

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const idx = trimmed.indexOf("=");
  if (idx < 0) {
    return null;
  }
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1).trim();
  if (!key) {
    return null;
  }
  return { key, value };
}

function loadEnvFile() {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const pair = parseEnvLine(line);
    if (!pair) {
      continue;
    }
    if (process.env[pair.key] === undefined) {
      process.env[pair.key] = pair.value;
    }
  }
}

function isTrue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getHttpsAgent() {
  if (cachedAgent) {
    return cachedAgent;
  }
  loadEnvFile();
  const insecure = isTrue(process.env.COBERTURA_TLS_INSECURE);
  if (insecure) {
    cachedAgent = new https.Agent({ rejectUnauthorized: false });
    return cachedAgent;
  }

  const caFile = process.env.COBERTURA_CA_FILE ? path.resolve(process.env.COBERTURA_CA_FILE) : "";
  if (!caFile) {
    cachedAgent = new https.Agent({ rejectUnauthorized: true });
    return cachedAgent;
  }

  if (!fs.existsSync(caFile)) {
    throw new Error(`No existe COBERTURA_CA_FILE: ${caFile}`);
  }

  const ca = fs.readFileSync(caFile, "utf8");
  cachedAgent = new https.Agent({ rejectUnauthorized: true, ca });
  return cachedAgent;
}

module.exports = {
  loadEnvFile,
  getHttpsAgent,
};
