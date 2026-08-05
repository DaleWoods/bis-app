import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/** Stable, human-readable slug used for seeded category ids. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
