import { sha256 } from '../crypto.js';

export interface MigrationAnalysis {
  path: string;
  name: string;
  checksum: string;
  risk: 'low' | 'medium' | 'high';
  operations: string[];
}

const MIGRATION_FILE = /\.(sql|ts|js|php|py)$/i;

/** Lists migration files inside `directory` (any depth below it), in apply order. */
export function listMigrationFiles(paths: string[], directory: string): string[] {
  const prefix = `${directory.replace(/\/$/, '')}/`;
  return paths
    .filter((p) => p.startsWith(prefix) && MIGRATION_FILE.test(p) && !/(^|\/)(meta|snapshots?)\//.test(p.slice(prefix.length)))
    .filter((p) => !/_journal\.json$|\.snap$/.test(p))
    .sort();
}

/**
 * Classifies a migration's data risk from its statements. Destructive or rewriting operations are
 * high risk (data loss / long locks); additive changes are low risk.
 */
export function analyseMigration(path: string, content: string): MigrationAnalysis {
  const text = content.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const ops: string[] = [];
  let risk: MigrationAnalysis['risk'] = 'low';
  const bump = (r: MigrationAnalysis['risk']) => {
    if (r === 'high' || (r === 'medium' && risk === 'low')) risk = r;
  };
  const rules: [RegExp, string, MigrationAnalysis['risk']][] = [
    [/\bDROP\s+TABLE\b/i, 'DROP TABLE (veri silinir)', 'high'],
    [/\bDROP\s+COLUMN\b|->dropColumn\(|\bremove_column\b|op\.drop_column/i, 'DROP COLUMN (veri silinir)', 'high'],
    [/\bTRUNCATE\b/i, 'TRUNCATE (veri silinir)', 'high'],
    [/\bDELETE\s+FROM\b/i, 'DELETE FROM (veri silinir)', 'high'],
    [/\bALTER\s+(TABLE\s+\S+\s+)?ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b|->change\(\)/i, 'Kolon tipi değişikliği (tablo yeniden yazılabilir)', 'high'],
    [/\bRENAME\s+(COLUMN|TO)\b|->renameColumn\(|rename_column/i, 'Yeniden adlandırma (eski kod kırılabilir)', 'medium'],
    [/\bSET\s+NOT\s+NULL\b/i, 'NOT NULL kısıtı (mevcut boş değerlerde başarısız olur)', 'medium'],
    [/\bUPDATE\s+\S+\s+SET\b/i, 'Toplu UPDATE (veri değişir)', 'medium'],
    [/\bCREATE\s+(UNIQUE\s+)?INDEX\b(?![^;]*CONCURRENTLY)/i, 'CREATE INDEX (tablo yazma kilidi)', 'medium'],
    [/\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, 'CREATE INDEX CONCURRENTLY', 'low'],
    [/\bADD\s+COLUMN\b|->(string|integer|boolean|text|timestamp|foreignId)\(|add_column|op\.add_column/i, 'ADD COLUMN', 'low'],
    [/\bCREATE\s+TABLE\b|Schema::create|create_table|op\.create_table/i, 'CREATE TABLE', 'low'],
    [/\bADD\s+CONSTRAINT\b|FOREIGN\s+KEY/i, 'Kısıt / foreign key ekleme', 'medium'],
  ];
  for (const [re, label, r] of rules) {
    if (re.test(text)) {
      ops.push(label);
      bump(r);
    }
  }
  if (/\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i.test(text)) {
    ops.push('Varsayılan değeri olmayan NOT NULL kolon');
    bump('high');
  }
  const name = path.split('/').pop()!.replace(/\.(sql|ts|js|php|py)$/i, '');
  return { path, name, checksum: sha256(content), risk, operations: ops.length ? ops : ['Bilinmeyen işlem (elle inceleyin)'] };
}
