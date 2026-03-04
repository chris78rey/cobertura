const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { runSingle } = require("./query_live");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key.startsWith("--")) {
      args[key.slice(2)] = value;
      i += 1;
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

function writeLabelValue(doc, label, value, options = {}) {
  const {
    x = 50,
    y = doc.y,
    labelWidth = 220,
    valueWidth = 180,
    gap = 8,
    size = 10,
    align = "left",
  } = options;
  doc.font("Helvetica-Bold").fontSize(size).text(label, x, y, {
    width: labelWidth,
    lineBreak: false,
  });
  doc.font("Helvetica").fontSize(size).text(value || "-", x + labelWidth + gap, y, {
    width: valueWidth,
    align,
    lineBreak: false,
  });
}

function drawTable(doc, headers, rows, widths, options = {}) {
  const startX = 50;
  const headerHeight = options.headerHeight || 24;
  const rowHeight = options.rowHeight || 36;
  const headerFontSize = options.headerFontSize || 9;
  const headerTopPadding = options.headerTopPadding || 7;
  let y = options.y || doc.y;

  doc.lineWidth(0.8);
  doc.font("Helvetica-Bold").fontSize(headerFontSize);
  let x = startX;
  headers.forEach((header, index) => {
    doc.rect(x, y, widths[index], headerHeight).stroke();
    doc.text(header, x + 6, y + headerTopPadding, {
      width: widths[index] - 12,
      align: "center",
    });
    x += widths[index];
  });

  y += headerHeight;
  doc.font("Helvetica").fontSize(8.5);
  rows.forEach((row) => {
    x = startX;
    row.forEach((cell, index) => {
      doc.rect(x, y, widths[index], rowHeight).stroke();
      doc.text(cell || "-", x + 6, y + 6, { width: widths[index] - 12, height: rowHeight - 8 });
      x += widths[index];
    });
    y += rowHeight;
  });

  doc.y = y + 12;
  return y;
}

function drawHeader(doc, pageWidth) {
  const previousX = doc.x;
  const previousY = doc.y;
  doc.lineWidth(1.5);
  doc.moveTo(20, 46).lineTo(pageWidth - 20, 46).stroke();
  doc.moveTo(20, 92).lineTo(pageWidth - 20, 92).stroke();
  const mspLogo = path.resolve("assets", "logomsp.jpg");
  const rpisLogo = path.resolve("assets", "logorpis.jpg");
  if (fs.existsSync(mspLogo)) {
    doc.image(mspLogo, 24, 52, { fit: [120, 30], align: "left", valign: "center" });
  } else {
    doc.rect(24, 52, 120, 30).stroke();
    doc.font("Helvetica-Bold").fontSize(12).text("MSP", 68, 61, { align: "center", width: 32 });
  }

  if (fs.existsSync(rpisLogo)) {
    doc.image(rpisLogo, pageWidth / 2 - 55, 56, { fit: [110, 26], align: "center", valign: "center" });
  }

  doc.rect(pageWidth - 70, 52, 30, 30).stroke();
  doc.font("Helvetica-Bold").fontSize(11).text("EC", pageWidth - 63, 61, { width: 16, align: "center" });
  doc.x = previousX;
  doc.y = previousY;
}

function drawFooter(doc, pageWidth, pageHeight) {
  const previousX = doc.x;
  const previousY = doc.y;
  const footerInfoX = pageWidth - 205;
  const footerInfoWidth = 170;
  doc.lineWidth(1.5);
  doc.moveTo(20, pageHeight - 108).lineTo(pageWidth - 20, pageHeight - 108).stroke();
  const logoY = pageHeight - 101;
  const logos = [
    ["logomsp.jpg", 80, 24],
    ["mininterior.jpg", 80, 24],
    ["mindefensa.jpg", 80, 24],
    ["iess.jpg", 50, 24],
    ["issfa.jpg", 50, 24],
    ["isspol.jpg", 50, 24],
  ];
  let x = pageWidth / 2 - 205;
  logos.forEach(([fileName, width, height]) => {
    const filePath = path.resolve("assets", fileName);
    if (fs.existsSync(filePath)) {
      doc.image(filePath, x, logoY, { fit: [width, height], align: "center", valign: "center" });
    } else {
      doc.rect(x, logoY, width, height).stroke();
    }
    x += width + 16;
  });

  doc.moveTo(20, pageHeight - 76).lineTo(pageWidth - 20, pageHeight - 76).stroke();
  doc.font("Helvetica").fontSize(8);
  doc.text("1 / 1", pageWidth / 2 - 10, pageHeight - 66, { width: 20, align: "center", lineBreak: false });
  doc.text("Plataforma Gubernamental de Desarrollo Social", footerInfoX, pageHeight - 70, {
    width: footerInfoWidth,
    align: "right",
    lineBreak: false,
  });
  doc.text("Av. Quitumbe Nan y Amaru Nan", footerInfoX, pageHeight - 58, {
    width: footerInfoWidth,
    align: "right",
    lineBreak: false,
  });
  doc.text("Telf: 593 (2) 3814400  |  www.msp.gob.ec", footerInfoX, pageHeight - 46, {
    width: footerInfoWidth,
    align: "right",
    lineBreak: false,
  });
  doc.x = previousX;
  doc.y = previousY;
}

function applyChromeToAllPages(doc) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    drawHeader(doc, pageWidth);
    drawFooter(doc, pageWidth, pageHeight);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.cedula || !args.fecha) {
    throw new Error("Usa --cedula y --fecha.");
  }

  const result = await runSingle(args.cedula, args.fecha);
  const data = result.response.data;
  const seguros = data.coberturaSalud.CoberturaSeguros.aseguradora || [];
  const privados =
    (data.coberturaPrivada.RegistrosAsegurados &&
      data.coberturaPrivada.RegistrosAsegurados.RegistroAsegurado) ||
    [];

  const outDir = path.resolve("output");
  ensureDir(outDir);
  const baseName = args.output_name
    ? safeFilename(args.output_name)
    : `cobertura_${safeFilename(args.cedula)}_${safeFilename(args.fecha)}`;
  const pdfPath = path.join(outDir, `${baseName}.pdf`);
  const jsonPath = path.join(outDir, `${baseName}.json`);

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 30,
    bufferPages: true,
  });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentX = 30;
  const contentWidth = pageWidth - 60;
  const privatePanelX = 70;
  const privatePanelWidth = 260;
  const titleY = 108;
  const subtitleY = 136;
  const nameY = 160;
  const metaY = 184;
  const sectionY = 208;
  const tableY = 230;
  const noteY = 420;
  const privateTitleY = 440;
  const privateBodyY = 462;
  const consultY = 468;

  doc.font("Helvetica-Bold").fontSize(15).text("RED PUBLICA INTEGRAL DE SALUD", contentX, titleY, {
    width: contentWidth,
    align: "center",
    lineBreak: false,
  });
  doc.font("Helvetica-Bold").fontSize(12).text("CONSULTA DE COBERTURA DE SALUD", contentX, subtitleY, {
    width: contentWidth,
    align: "center",
    lineBreak: false,
  });

  const nombre = seguros.find((item) => item.Nombre)?.Nombre || "";
  if (nombre) {
    doc.font("Helvetica-Bold").fontSize(10).text(nombre, 50, nameY, {
      width: 320,
      lineBreak: false,
    });
  }

  writeLabelValue(doc, "Numero de documento de Identificacion: ", args.cedula, {
    x: 50,
    y: metaY,
    labelWidth: 210,
    valueWidth: 120,
    size: 10,
  });
  writeLabelValue(doc, "Fecha de Cobertura de Seguro de Salud: ", args.fecha, {
    x: 420,
    y: metaY,
    labelWidth: 250,
    valueWidth: 95,
    align: "right",
    size: 10,
  });

  doc.font("Helvetica-Bold").fontSize(10).text("IESS, ISSFA, ISSPOL", contentX, sectionY, {
    width: contentWidth,
    align: "center",
    lineBreak: false,
  });
  drawTable(
    doc,
    ["Seguro", "Tipo de seguro", "Mensaje", "Registro de Cobertura\nde Atencion de Salud"],
    seguros.map((item) => [
      item.NombreInstitucion || "",
      item.TipoSeguro || "Servicio no disponible",
      item.MensajeServicioExterno || "Servicio no disponible",
      item.EstadoCobertura || "Servicio no disponible",
    ]),
    [90, 190, 255, 195],
    { y: tableY, rowHeight: 34, headerHeight: 30, headerFontSize: 8.5, headerTopPadding: 5 }
  );

  doc.font("Helvetica").fontSize(7).fillColor("blue").text(
    "* La informacion historica reflejada corresponde a datos\ndesde Junio 2010",
    privatePanelX,
    noteY,
    { width: privatePanelWidth }
  );
  doc.fillColor("black");

  doc.font("Helvetica-Bold").fontSize(9).text("RED PRIVADA COMPLEMENTARIA", privatePanelX, privateTitleY, {
    width: privatePanelWidth,
  });

  if (privados.length) {
    drawTable(
      doc,
      ["RUC", "Nombre del Financiador", "Identificacion del Beneficiario", "Nombres", "Apellidos"],
      privados.map((item) => [
        item.RucEmpresa || "",
        item.NombreFinanciador || "",
        item.IdentificacionBeneficiario || "",
        item.NombreBeneficiario || "",
        item.ApellidosBeneficiario || "",
      ]),
      [100, 240, 135, 120, 120],
      { y: privateBodyY, rowHeight: 28, headerHeight: 22 }
    );
  } else {
    doc.font("Helvetica").fontSize(8.5).text(
      "NO EXISTEN RESULTADOS PARA LOS\nPARAMETROS INGRESADOS",
      privatePanelX,
      privateBodyY,
      { width: privatePanelWidth }
    );
  }

  writeLabelValue(doc, "Fecha de consulta: ", new Date().toISOString().slice(0, 16).replace("T", " "), {
    x: 500,
    y: consultY,
    labelWidth: 115,
    valueWidth: 110,
    align: "right",
    size: 9,
  });
  applyChromeToAllPages(doc);
  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ pdfPath, jsonPath }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  safeFilename,
};
