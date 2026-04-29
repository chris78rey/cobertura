const oracledb = require('oracledb');
const { runSingle } = require('./query_live');
const { generatePdfFromResult } = require('./generate_pdf');

const OCI_LIB_DIR = '/opt/oracle/instantclient_21_11';
const DELAY_MS = 2000;
const MAX_RETRIES = 3;

const delay = ms => new Promise(r => setTimeout(r, ms));

async function getOracleConnection() {
  oracledb.initOracleClient({ libDir: OCI_LIB_DIR });
  return oracledb.getConnection({
    connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=172.16.60.21)(PORT=1521))(CONNECT_DATA=(SID=PRDSGH2)))',
    user: 'DIGITALIZACION',
    password: 'DIGITALIZACION'
  });
}

async function queryRecords(conn, startDate, endDate, modo, limit = 50) {
  let query, params;
  
  if (modo === 'DIG_COBERTURA') {
    query = `
      SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD,
             DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02,
             TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD')
      FROM DIGITALIZACION 
      WHERE DIG_COBERTURA = 'N'
      AND DIG_FECHA_HASTA BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      AND ROWNUM <= :limit
    `;
    params = { startDate, endDate, limit };
  } else {
    query = `
      SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD,
             DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02,
             TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD')
      FROM DIGITALIZACION 
      WHERE DIG_FECHA_HASTA BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      AND ROWNUM <= :limit
    `;
    params = { startDate, endDate, limit };
  }
  
  const result = await conn.execute(query, params);
  return result.rows;
}

async function markAsProcessed(conn, digId) {
  await conn.execute(
    `UPDATE DIGITALIZACION SET DIG_COBERTURA = 'S' WHERE DIG_ID = :digId`,
    { digId },
    { autoCommit: false }
  );
  await conn.commit();
}

async function queryWithRetry(cedula, fecha, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await runSingle(cedula, fecha);
      if (result.response?.success === 'success') return result;
      if (i < retries - 1) await delay(DELAY_MS * Math.pow(2, i));
    } catch (e) {
      if (e.message.includes('503') || e.message.includes('RSC')) {
        if (i < retries - 1) await delay(DELAY_MS * Math.pow(2, i));
        else throw e;
      } else throw e;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const cedulaArg = args.find(a => a.startsWith('--cedula='))?.split('=')[1];
  const fechaArg = args.find(a => a.startsWith('--fecha='))?.split('=')[1];
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const startDateArg = args.find(a => a.startsWith('--start-date='))?.split('=')[1];
  const endDateArg = args.find(a => a.startsWith('--end-date='))?.split('=')[1];
  const modoArg = args.find(a => a.startsWith('--modo='))?.split('=')[1] || 'DIG_COBERTURA';
  const outputDir = args.find(a => a.startsWith('--output-dir='))?.split('=')[1] || process.env.COBERTURA_OUTPUT_DIR || 'output';

  if (cedulaArg && fechaArg) {
    console.log(`Single query: cedula=${cedulaArg}, fecha=${fechaArg}, output=${outputDir}`);
    try {
      const result = await queryWithRetry(cedulaArg, fechaArg);
      if (result?.response?.success === 'success') {
        await generatePdfFromResult({ result, cedula: cedulaArg, fecha: fechaArg, outputDir });
        console.log('OK');
        process.exit(0);
      } else {
        console.log('Sin cobertura o fallido');
        process.exit(1);
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  const limit = parseInt(limitArg || '50');
  const startDate = startDateArg || '2026-04-01';
  const endDate = endDateArg || '2026-04-01';
  
  console.log(`Batch Oracle → Portal MSP (limit=${limit}, start=${startDate}, end=${endDate}, modo=${modoArg}, output=${outputDir})\n`);

  let conn;
  try {
    conn = await getOracleConnection();
    const records = await queryRecords(conn, startDate, endDate, modoArg, limit);
    console.log(`Registros a procesar: ${records.length}\n`);

    let success = 0, fail = 0;
    for (let i = 0; i < records.length; i++) {
      const [dig_id, tramite, cedula, es_menor, d1, d2, fecha] = records[i];
      process.stdout.write(`[${i+1}/${records.length}] ${tramite} (${cedula})... `);
      
      try {
        const result = await queryWithRetry(cedula, fecha);
        if (result?.response?.success === 'success') {
          await generatePdfFromResult({ result, cedula, fecha, outputDir });
          await markAsProcessed(conn, dig_id);
          success++;
          console.log('OK');
        } else {
          console.log('Sin cobertura o fallido');
          fail++;
        }
      } catch (e) {
        console.log(`Error: ${e.message.slice(0,60)}`);
        fail++;
      }

      if (i < records.length - 1) await delay(DELAY_MS);
    }

    console.log(`\n--- Resumen ---`);
    console.log(`Exitosos: ${success}`);
    console.log(`Fallidos: ${fail}`);
    console.log(`Total: ${records.length}`);
  } finally {
    if (conn) await conn.close();
  }
}

main().catch(console.error);
