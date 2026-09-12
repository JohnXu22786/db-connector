import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { indexesFromStatistics } from '../dist/drivers/mysql.js';

test('MySQL schema introspection preserves actual names for multiple indexes', () => {
  const indexes = indexesFromStatistics([
    {
      table_name: 'users',
      index_name: 'PRIMARY',
      non_unique: 0,
      seq_in_index: 1,
      column_name: 'id',
    },
    {
      table_name: 'users',
      index_name: 'idx_users_email',
      non_unique: 1,
      seq_in_index: 1,
      column_name: 'email',
    },
    {
      table_name: 'users',
      index_name: 'idx_users_name_email',
      non_unique: 0,
      seq_in_index: 1,
      column_name: 'name',
    },
    {
      table_name: 'users',
      index_name: 'idx_users_name_email',
      non_unique: 0,
      seq_in_index: 2,
      column_name: 'email',
    },
  ]);

  assert.deepEqual(indexes, [
    {
      name: 'PRIMARY',
      table: 'users',
      columns: ['id'],
      unique: true,
      primary: true,
    },
    {
      name: 'idx_users_email',
      table: 'users',
      columns: ['email'],
      unique: false,
      primary: false,
    },
    {
      name: 'idx_users_name_email',
      table: 'users',
      columns: ['name', 'email'],
      unique: true,
      primary: false,
    },
  ]);
});
