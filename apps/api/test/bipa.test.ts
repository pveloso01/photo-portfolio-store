// F3.8 — BIPA detection + retention-window unit tests. Pure helpers.

import { describe, expect, it } from 'vitest';

import { computeRetentionWindowEndsAt, detectBipaRegion } from '../src/lib/bipa.js';

describe('detectBipaRegion', () => {
  it('returns null + bipaApplies=false when no signal points anywhere', () => {
    const r = detectBipaRegion({});
    expect(r.region).toBeNull();
    expect(r.bipaApplies).toBe(false);
    expect(r.escalatedBy).toEqual([]);
  });

  it('escalates when the subject declares a covered state', () => {
    const r = detectBipaRegion({ declaredRegion: 'US-IL', billingCountry: 'US' });
    expect(r.region).toBe('US-IL');
    expect(r.bipaApplies).toBe(true);
    expect(r.escalatedBy).toContain('declared');
  });

  it('escalates when geo signal points at a covered state', () => {
    const r = detectBipaRegion({ declaredRegion: 'US-CA', geoRegion: 'US-WA' });
    expect(r.region).toBe('US-WA');
    expect(r.bipaApplies).toBe(true);
    expect(r.escalatedBy).toContain('geo');
  });

  it('does NOT relax: declared CA + geo CA stays uncovered', () => {
    const r = detectBipaRegion({ declaredRegion: 'US-CA', geoRegion: 'US-CA' });
    expect(r.bipaApplies).toBe(false);
  });

  it('billing US alone does not escalate; combined with a state signal it does', () => {
    const a = detectBipaRegion({ billingCountry: 'US' });
    expect(a.bipaApplies).toBe(false);
    const b = detectBipaRegion({ billingCountry: 'US', declaredRegion: 'US-TX' });
    expect(b.bipaApplies).toBe(true);
    expect(b.escalatedBy).toContain('declared');
    expect(b.escalatedBy).toContain('billing');
  });

  it('normalises region casing', () => {
    const r = detectBipaRegion({ declaredRegion: 'us-il' });
    expect(r.region).toBe('US-IL');
  });
});

describe('computeRetentionWindowEndsAt', () => {
  const grantedAt = new Date('2026-05-01T00:00:00Z');
  it('IL = 3 years', () => {
    const end = computeRetentionWindowEndsAt('us_bipa', 'US-IL', grantedAt);
    expect(end).not.toBeNull();
    // ~3 years later
    expect(end!.getUTCFullYear() - grantedAt.getUTCFullYear()).toBe(3);
  });
  it('TX = 1 year', () => {
    const end = computeRetentionWindowEndsAt('us_bipa', 'US-TX', grantedAt);
    expect(end!.getUTCFullYear() - grantedAt.getUTCFullYear()).toBe(1);
  });
  it('WA = 3 years', () => {
    const end = computeRetentionWindowEndsAt('us_bipa', 'US-WA', grantedAt);
    expect(end!.getUTCFullYear() - grantedAt.getUTCFullYear()).toBe(3);
  });
  it('us_bipa without specific region defaults to 3 years', () => {
    const end = computeRetentionWindowEndsAt('us_bipa', null, grantedAt);
    expect(end!.getUTCFullYear() - grantedAt.getUTCFullYear()).toBe(3);
  });
  it('eu_gdpr / br_lgpd / other => null (per-event retention applies)', () => {
    expect(computeRetentionWindowEndsAt('eu_gdpr', null, grantedAt)).toBeNull();
    expect(computeRetentionWindowEndsAt('br_lgpd', null, grantedAt)).toBeNull();
    expect(computeRetentionWindowEndsAt('other', null, grantedAt)).toBeNull();
  });
});
