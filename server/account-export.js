import { databaseEnabled, transaction } from "./db/pool.js";

const excludedExportColumns = Object.freeze({
  auth_sessions: new Set(["token_hash"]),
  terminal_auth_requests: new Set(["request_hash", "poll_token_hash"]),
  terminal_sessions: new Set(["token_hash"]),
});

function quoteIdentifier(value) {
  return `"${String(value || "").replaceAll("\"", "\"\"")}"`;
}

export async function exportAccountDatabaseData({
  accountId = "",
  databaseReady = databaseEnabled(),
  transactionImpl = transaction,
} = {}) {
  if (!databaseReady) return { enabled: false, tables: {}, totalRows: 0 };
  return transactionImpl(async (client) => {
    const inventory = await client.query(
      `SELECT columns.table_name, array_agg(columns.column_name ORDER BY columns.ordinal_position) AS column_names
         FROM information_schema.columns columns
         JOIN information_schema.tables tables
           ON tables.table_schema = columns.table_schema
          AND tables.table_name = columns.table_name
        WHERE columns.table_schema = 'public'
          AND columns.column_name = 'account_id'
          AND tables.table_type = 'BASE TABLE'
        GROUP BY columns.table_name
        ORDER BY columns.table_name`
    );
    const tables = {};
    let totalRows = 0;
    for (const entry of inventory.rows) {
      const tableName = String(entry.table_name || "");
      if (!tableName) continue;
      const omitted = excludedExportColumns[tableName] || new Set();
      const columns = (entry.column_names || []).filter((column) => !omitted.has(column));
      if (!columns.length) continue;
      const result = await client.query(
        `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(tableName)} WHERE account_id = $1`,
        [accountId]
      );
      if (!result.rows.length) continue;
      tables[tableName] = result.rows;
      totalRows += result.rows.length;
    }
    return { enabled: true, tables, totalRows };
  });
}
