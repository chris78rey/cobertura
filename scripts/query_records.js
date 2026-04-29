const oracledb = require('oracledb');

const OCI_LIB_DIR = '/opt/oracle/instantclient_21_11';

async function main() {
    const args = process.argv.slice(2);
    const startDate = args.find(a => a.startsWith('--start-date='))?.split('=')[1];
    const endDate = args.find(a => a.startsWith('--end-date='))?.split('=')[1];
    const modo = args.find(a => a.startsWith('--modo='))?.split('=')[1] || 'DIG_COBERTURA';
    
    oracledb.initOracleClient({ libDir: OCI_LIB_DIR });
    
    const conn = await oracledb.getConnection({
        connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=172.16.60.21)(PORT=1521))(CONNECT_DATA=(SID=PRDSGH2)))',
        user: 'DIGITALIZACION',
        password: 'DIGITALIZACION'
    });
    
    let query;
    if (modo === 'DIG_COBERTURA') {
        query = `SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD, DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02, TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD') FROM DIGITALIZACION WHERE DIG_COBERTURA = 'N' AND DIG_FECHA_HASTA BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD') AND ROWNUM <= 100`;
    } else {
        query = `SELECT DIG_ID, DIG_TRAMITE, DIG_CEDULA, DIG_MENOR_EDAD, DIG_DEPENDIENTE_01, DIG_DEPENDIENTE_02, TO_CHAR(DIG_FECHA_HASTA, 'YYYY-MM-DD') FROM DIGITALIZACION WHERE DIG_FECHA_HASTA BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD') AND ROWNUM <= 100`;
    }
    
    const result = await conn.execute(query, [startDate, endDate]);
    const records = result.rows.map(row => ({
        dig_id: row[0],
        tramite: row[1],
        cedula: row[2],
        es_menor: row[3],
        d1: row[4],
        d2: row[5],
        fecha: row[6]
    }));
    
    await conn.close();
    console.log(JSON.stringify(records));
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
