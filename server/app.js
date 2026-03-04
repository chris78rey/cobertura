const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const { processExcelFile } = require("../scripts/batch_excel_query");

const app = express();
const uploadDir = path.resolve("uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.use("/output", express.static(path.resolve("output")));
app.use("/data", express.static(path.resolve("data")));
app.use(express.static(path.resolve("web")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/process-excel", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Debes subir un archivo Excel." });
  }
  try {
    const result = await processExcelFile(req.file.path, {
      waitMinMs: 6000,
      waitMaxMs: 11000,
      retries: 1,
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: String(error.message || error) });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.get("/*rest", (_req, res) => {
  res.sendFile(path.resolve("web", "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Servidor web disponible en http://127.0.0.1:${port}`);
});
