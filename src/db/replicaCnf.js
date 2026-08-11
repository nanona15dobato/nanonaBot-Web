'use strict';

const fs = require('fs');

/**
 * ToolforgeのreplicaMyCnf相当のini形式テキストをパースする。
 * 実際のファイルは次のような形式（Help:Toolforge/Database参照）:
 *   [client]
 *   user = 's51234'
 *   password = 'abcDEF123'
 *
 * セクション行（[client]等）は無視し、"key = 'value'" 形式の行だけを拾う。
 * 副作用なしの純粋関数にしてあるので、実ファイルなしでテストできる。
 *
 * @param {string} content
 * @returns {{ [key: string]: string }}
 */
function parseReplicaCnf(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * replica.my.cnfファイルを読み込んでパースする（副作用あり）。
 * @param {string} filePath
 */
function readReplicaCnf(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseReplicaCnf(content);
}

module.exports = { parseReplicaCnf, readReplicaCnf };
