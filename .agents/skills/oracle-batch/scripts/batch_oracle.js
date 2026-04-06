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

async function queryRecords(conn, limit = 50) {
  const result = await conn.execute(`
    SELECT dig_cedula, TO_CHAR(dig_fecha_hasta, 'YYYY-MM-DD') as dig_fecha_hasta 
    FROM DIGITALIZACION 
    WHERE dig_fecha_hasta >= TO_DATE('2026-04-01', 'YYYY-MM-DD')
    AND ROWNUM <= :limit
  `, [limit]);
  return result.rows;
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

  if (cedulaArg && fechaArg) {
    console.log(`Single query: cedula=${cedulaArg}, fecha=${fechaArg}`);
    try {
      const result = await queryWithRetry(cedulaArg, fechaArg);
      if (result?.response?.success === 'success') {
        await generatePdfFromResult({ result, cedula: cedulaArg, fecha: fechaArg });
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
  console.log(`Batch Oracle → Portal MSP (limit=${limit}, delay=${DELAY_MS}ms)\n`);

  let conn;
  try {
    conn = await getOracleConnection();
    const records = await queryRecords(conn, limit);
    console.log(`Registros a procesar: ${records.length}\n`);

    let success = 0, fail = 0;
    for (let i = 0; i < records.length; i++) {
      const [cedula, fecha] = records[i];
      process.stdout.write(`[${i+1}/${records.length}] ${cedula}... `);
      
      try {
        const result = await queryWithRetry(cedula, fecha);
        if (result?.response?.success === 'success') {
          await generatePdfFromResult({ result, cedula, fecha });
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
