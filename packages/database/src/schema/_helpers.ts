import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Time-ordered UUID primary key (PostgreSQL 18 native uuidv7()). */
export const pk = () => uuid().primaryKey().default(sql`uuidv7()`);

export const createdAt = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
export const ts = () => timestamp({ withTimezone: true, mode: 'date' });

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

/** CHECK (col IN (...)) helper for text-based enums. */
export function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`);
}
