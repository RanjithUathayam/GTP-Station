const sql = require('mssql');

const config = {
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    server:   process.env.DB_SERVER || 'localhost',
    database: process.env.DB_NAME   || 'GTP_Station',
    port:     parseInt(process.env.DB_PORT, 10) || 1433,
    options: {
        encrypt:               false,
        trustServerCertificate: true,
    },
    pool: {
        max:               10,
        min:               0,
        idleTimeoutMillis: 30000,
    },
};

let pool = null;

async function initDb() {
    pool = await sql.connect(config);
    return pool;
}

async function getPool() {
    if (!pool) pool = await initDb();
    return pool;
}

module.exports = { initDb, getPool, sql };
