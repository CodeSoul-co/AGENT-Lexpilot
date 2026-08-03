const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quotePostgresIdentifier(value) {
  if (!IDENTIFIER_PATTERN.test(value)) throw new TypeError('Invalid PostgreSQL identifier.');
  return `"${value}"`;
}

function compileNamedParameters(sql, parameters, engine) {
  const values = [];
  const indexes = new Map();
  const text = sql.replace(/:([a-z_][a-z0-9_]*)\b/gi, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
      throw new TypeError('SQL parameter is missing.');
    }
    if (engine === 'postgresql') {
      if (!indexes.has(name)) {
        values.push(parameters[name]);
        indexes.set(name, values.length);
      }
      return `$${indexes.get(name)}`;
    }
    values.push(parameters[name]);
    return '?';
  });
  return { text, values };
}

function normalizePostgresColumn(row) {
  return {
    name: String(row.column_name),
    type: String(row.data_type || 'UNKNOWN').toUpperCase(),
    nullable: row.is_nullable === 'YES',
    primaryKeyPosition: 0
  };
}

function normalizeMySQLColumn(row) {
  return {
    name: String(row.COLUMN_NAME),
    type: String(row.DATA_TYPE || 'UNKNOWN').toUpperCase(),
    nullable: row.IS_NULLABLE === 'YES',
    primaryKeyPosition: row.COLUMN_KEY === 'PRI' ? Number(row.ORDINAL_POSITION) : 0
  };
}

function createPostgreSQLClient(profile, dependencies = {}) {
  const pg = dependencies.pg ?? require('pg');
  const pool = new pg.Pool({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    password: profile.password,
    ssl: profile.tlsMode === 'require' ? { rejectUnauthorized: true } : false,
    max: 2,
    connectionTimeoutMillis: profile.timeoutMs,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true
  });

  return Object.freeze({
    async testConnection() {
      const result = await pool.query({ text: 'SELECT 1 AS value;', query_timeout: profile.timeoutMs });
      return Number(result.rows[0]?.value) === 1;
    },

    async inspectTable(tableName, allowedColumns) {
      const result = await pool.query({
        text: [
          'SELECT column_name, data_type, is_nullable, ordinal_position',
          'FROM information_schema.columns',
          'WHERE table_schema = $1 AND table_name = $2',
          'ORDER BY ordinal_position;'
        ].join('\n'),
        values: [profile.schemaName, tableName],
        query_timeout: profile.timeoutMs
      });
      const byName = new Map(result.rows.map((row) => [String(row.column_name), row]));
      return {
        tableAvailable: result.rows.length > 0,
        columns: allowedColumns.map((name) => {
          if (!byName.has(name)) return null;
          return normalizePostgresColumn(byName.get(name));
        })
      };
    },

    async executeReadOnly(sql, parameters, maxRows) {
      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query('BEGIN READ ONLY;');
        transactionStarted = true;
        await client.query(`SET LOCAL statement_timeout = ${profile.timeoutMs};`);
        await client.query(
          `SET LOCAL search_path = ${quotePostgresIdentifier(profile.schemaName)}, pg_catalog;`
        );
        const query = sql.trim().replace(/;\s*$/, '');
        const compiled = compileNamedParameters(query, parameters, 'postgresql');
        const boundedSql = `SELECT * FROM (${compiled.text}) AS lexpilot_bounded_result LIMIT ${maxRows + 1};`;
        const result = await client.query({
          text: boundedSql,
          values: compiled.values,
          query_timeout: profile.timeoutMs
        });
        return result.rows.map((row) => ({ ...row }));
      } finally {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK;');
          } catch {
            client.release(true);
            throw new Error('PostgreSQL read-only transaction cleanup failed.');
          }
        }
        client.release();
      }
    },

    async close() {
      await pool.end();
    }
  });
}

function createMySQLClient(profile, dependencies = {}) {
  const mysql = dependencies.mysql ?? require('mysql2/promise');
  const pool = mysql.createPool({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    password: profile.password,
    ssl: profile.tlsMode === 'require' ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0,
    connectTimeout: profile.timeoutMs,
    multipleStatements: false
  });

  return Object.freeze({
    async testConnection() {
      const [rows] = await pool.query({ sql: 'SELECT 1 AS value;', timeout: profile.timeoutMs });
      return Number(rows[0]?.value) === 1;
    },

    async inspectTable(tableName, allowedColumns) {
      const [rows] = await pool.execute(
        [
          'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION, COLUMN_KEY',
          'FROM information_schema.columns',
          'WHERE table_schema = DATABASE() AND table_name = ?',
          'ORDER BY ORDINAL_POSITION;'
        ].join('\n'),
        [tableName]
      );
      const byName = new Map(rows.map((row) => [String(row.COLUMN_NAME), row]));
      return {
        tableAvailable: rows.length > 0,
        columns: allowedColumns.map((name) => {
          if (!byName.has(name)) return null;
          return normalizeMySQLColumn(byName.get(name));
        })
      };
    },

    async executeReadOnly(sql, parameters, maxRows) {
      const connection = await pool.getConnection();
      let transactionStarted = false;
      try {
        await connection.query('START TRANSACTION READ ONLY;');
        transactionStarted = true;
        await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${profile.timeoutMs};`);
        const query = sql.trim().replace(/;\s*$/, '');
        const compiled = compileNamedParameters(query, parameters, 'mysql');
        const boundedSql = `SELECT * FROM (${compiled.text}) AS lexpilot_bounded_result LIMIT ${maxRows + 1};`;
        const [rows] = await connection.execute(
          { sql: boundedSql, timeout: profile.timeoutMs },
          compiled.values
        );
        return rows.map((row) => ({ ...row }));
      } finally {
        if (transactionStarted) {
          try {
            await connection.rollback();
          } catch {
            connection.destroy();
            throw new Error('MySQL read-only transaction cleanup failed.');
          }
        }
        connection.release();
      }
    },

    async close() {
      await pool.end();
    }
  });
}

module.exports = {
  compileNamedParameters,
  createMySQLClient,
  createPostgreSQLClient
};
