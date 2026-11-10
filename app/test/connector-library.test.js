import { describe, expect, it } from 'vitest';
import { CATEGORIES, CONNECTORS, CONNECTOR_BY_ID, aboutOf, byCategory, featuresOf } from '../connectors/library.js';
import { SOURCES } from '../sources/catalog.js';

describe('connector library', () => {
  it('has unique ids, known categories and valid statuses', () => {
    const ids = CONNECTORS.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(CATEGORIES.map((x) => x.id));
    for (const x of CONNECTORS) {
      expect(cats.has(x.category), x.id).toBe(true);
      expect(['available', 'soon']).toContain(x.status);
      expect(['mcp-source', 'macos', 'quorum-mcp', 'oauth', 'meeting-app']).toContain(x.kind);
      if (x.kind === 'meeting-app') expect(['zoom', 'meet', 'teams'], x.id).toContain(x.app);
      expect(x.domain).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
      expect(x.description.length).toBeGreaterThan(10);
    }
  });
  it('every connector enables at least one named feature', () => {
    for (const x of CONNECTORS) { const f = featuresOf(x); expect(f.length, x.id).toBeGreaterThan(0); for (const line of f) expect(line).not.toMatch(/undefined|\$\{/); }
    expect(featuresOf(CONNECTOR_BY_ID.granola).join(' ')).toMatch(/knowledge store/);
  });
  it('keeps every connector description to two short sentences', () => {
    for (const x of CONNECTORS) { const about = aboutOf(x); expect(about.length, x.id).toBeLessThanOrEqual(190); expect(about).not.toMatch(/undefined|\$\{/); }
  });
  it('every category lists at least one connector', () => {
    for (const cat of CATEGORIES) expect(byCategory(cat.id).length, cat.id).toBeGreaterThan(0);
  });
  it('an available meeting-notes connector has a source behind it', () => {
    for (const x of CONNECTORS.filter((y) => y.kind === 'mcp-source' && y.status === 'available')) expect(SOURCES.some((s) => s.id === x.source), x.id).toBe(true);
  });
  it('covers the integrations people expect from a notetaker', () => {
    for (const id of ['slack', 'notion', 'hubspot', 'salesforce', 'linear', 'google-calendar', 'outlook', 'zapier', 'claude-code']) expect(CONNECTOR_BY_ID[id]).toBeTruthy();
    expect(CONNECTORS.length).toBeGreaterThanOrEqual(45);
  });
});
