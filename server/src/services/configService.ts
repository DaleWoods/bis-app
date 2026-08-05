import { Db, upsert } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';
import {
  AppConfig,
  CategoryDef,
  DEFAULT_APP_CONFIG,
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_JIRA_CONFIG,
  DEFAULT_PACK_CONFIG,
  DEFAULT_SCORING_CONFIG,
  ScoringConfig,
  SEED_CATEGORIES,
} from '../domain/types.js';

interface ConfigRow {
  key: string;
  value: string;
}

interface CategoryRow {
  id: string;
  position: number;
  name: string;
  description: string;
  zero_label: string;
  max_label: string;
  weight: number;
  scale_min: number;
  scale_max: number;
  active: number;
}

function mapCategory(row: CategoryRow): CategoryDef {
  return {
    id: row.id,
    position: Number(row.position),
    name: row.name,
    description: row.description,
    zeroLabel: row.zero_label,
    maxLabel: row.max_label,
    weight: Number(row.weight),
    scaleMin: Number(row.scale_min),
    scaleMax: Number(row.scale_max),
    active: Number(row.active) === 1,
  };
}

/** Deep-merge stored config over the defaults so new settings appear without a migration. */
function merge<T>(defaults: T, stored: unknown): T {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
  const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const base = (defaults as Record<string, unknown>)[key];
    result[key] =
      base && typeof base === 'object' && !Array.isArray(base) && value && typeof value === 'object'
        ? merge(base, value)
        : value;
  }
  return result as T;
}

export async function getAppConfig(db: Db): Promise<AppConfig> {
  const rows = await db.all<ConfigRow>('SELECT key, value FROM app_config');
  const stored = new Map(rows.map((r) => [r.key, safeParse(r.value)]));
  return {
    scoring: merge(DEFAULT_SCORING_CONFIG, stored.get('scoring')),
    cadence: merge(DEFAULT_CADENCE_CONFIG, stored.get('cadence')),
    jira: merge(DEFAULT_JIRA_CONFIG, stored.get('jira')),
    pack: merge(DEFAULT_PACK_CONFIG, stored.get('pack')),
  };
}

export async function getScoringConfig(db: Db): Promise<ScoringConfig> {
  return (await getAppConfig(db)).scoring;
}

export async function saveConfigSection<K extends keyof AppConfig>(
  db: Db,
  section: K,
  value: Partial<AppConfig[K]>,
  updatedBy: string,
): Promise<AppConfig> {
  const current = await getAppConfig(db);
  const next = merge(current[section], value);
  await db.run(upsert('app_config', ['key', 'value', 'updated_at', 'updated_by'], ['key']), [
    section,
    JSON.stringify(next),
    nowIso(),
    updatedBy,
  ]);
  return getAppConfig(db);
}

export async function listCategories(db: Db, includeInactive = false): Promise<CategoryDef[]> {
  const rows = await db.all<CategoryRow>(
    includeInactive
      ? 'SELECT * FROM categories ORDER BY position ASC'
      : 'SELECT * FROM categories WHERE active = 1 ORDER BY position ASC',
  );
  return rows.map(mapCategory);
}

export interface CategoryInput {
  id?: string;
  position: number;
  name: string;
  description?: string;
  zeroLabel?: string;
  maxLabel?: string;
  weight?: number;
  scaleMin?: number;
  scaleMax?: number;
  active?: boolean;
}

export async function saveCategory(db: Db, input: CategoryInput): Promise<CategoryDef> {
  const id = input.id ?? newId();
  const now = nowIso();
  const existing = await db.get<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]);

  if (existing) {
    await db.run(
      `UPDATE categories SET position = ?, name = ?, description = ?, zero_label = ?, max_label = ?,
       weight = ?, scale_min = ?, scale_max = ?, active = ?, updated_at = ? WHERE id = ?`,
      [
        input.position,
        input.name,
        input.description ?? existing.description,
        input.zeroLabel ?? existing.zero_label,
        input.maxLabel ?? existing.max_label,
        input.weight ?? Number(existing.weight),
        input.scaleMin ?? Number(existing.scale_min),
        input.scaleMax ?? Number(existing.scale_max),
        (input.active ?? Number(existing.active) === 1) ? 1 : 0,
        now,
        id,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO categories (id, position, name, description, zero_label, max_label, weight, scale_min, scale_max, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.position,
        input.name,
        input.description ?? '',
        input.zeroLabel ?? 'Not Impacted',
        input.maxLabel ?? 'Highly Impacted',
        input.weight ?? 1,
        input.scaleMin ?? 0,
        input.scaleMax ?? 10,
        (input.active ?? true) ? 1 : 0,
        now,
        now,
      ],
    );
  }

  const row = await db.get<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]);
  return mapCategory(row as CategoryRow);
}

/**
 * Categories are never hard-deleted once scores reference them - they are
 * deactivated, so historic rounds keep their maths (§14 retention).
 */
export async function deactivateCategory(db: Db, id: string): Promise<void> {
  await db.run('UPDATE categories SET active = 0, updated_at = ? WHERE id = ?', [nowIso(), id]);
}

export async function ensureSeedCategories(db: Db): Promise<void> {
  const existing = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM categories');
  if (Number(existing?.count ?? 0) > 0) return;
  const now = nowIso();
  for (const category of SEED_CATEGORIES) {
    await db.run(
      `INSERT INTO categories (id, position, name, description, zero_label, max_label, weight, scale_min, scale_max, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        category.id,
        category.position,
        category.name,
        category.description,
        category.zeroLabel,
        category.maxLabel,
        category.weight,
        category.scaleMin,
        category.scaleMax,
        category.active ? 1 : 0,
        now,
        now,
      ],
    );
  }
}

export async function ensureDefaultConfig(db: Db): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_APP_CONFIG)) {
    const existing = await db.get<ConfigRow>('SELECT key FROM app_config WHERE key = ?', [key]);
    if (existing) continue;
    await db.run('INSERT INTO app_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)', [
      key,
      JSON.stringify(value),
      nowIso(),
      'system',
    ]);
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
