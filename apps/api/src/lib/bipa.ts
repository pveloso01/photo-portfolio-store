// F3.8 — BIPA per-state gating + retention-window computation.
//
// DETECTION (LOCKED decision: declared + billing country + IP-geo, escalate-only):
//   - The strictness ranking is: covered state (IL/TX/WA) > generic US > non-US.
//   - Any signal pointing at a covered state escalates the user into the
//     statutory-written-consent flow. Geo never relaxes the rule, never silently
//     downgrades. Conflicts default to the stricter side.
//   - We do NOT persist raw IP or geolocation; the detector takes a region
//     string the caller resolved upstream (e.g. cdn header) so privacy
//     properties stay clean.
//
// RETENTION (BIPA-equivalents):
//   - IL (740 ILCS 14/15(a)): destroy when the purpose is satisfied OR 3 years
//     from the subject's last interaction, whichever is sooner. We use 3 years
//     from grant as a hard ceiling.
//   - TX (CUBI): "reasonable time" + destroy "within one year after the
//     purpose is fulfilled". 1 year inactivity acts as the ceiling here.
//   - WA (HB1493): similar 3-year ceiling.
//   - Other jurisdictions: governed by per-event retention_days (existing M1
//     mechanic). retention_window_ends_at remains null.

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type CoveredRegion = 'US-IL' | 'US-TX' | 'US-WA';
export const COVERED_REGIONS: ReadonlyArray<CoveredRegion> = ['US-IL', 'US-TX', 'US-WA'];

export type Jurisdiction = 'eu_gdpr' | 'br_lgpd' | 'us_bipa' | 'us_ccpa' | 'other';

export interface DetectInput {
  /** ISO 3166-2 region declared by the subject (e.g. 'US-IL'). */
  declaredRegion?: string;
  /** ISO 3166-1 alpha-2 billing country (e.g. 'US'). */
  billingCountry?: string;
  /** ISO 3166-2 region inferred from the request's CDN/geo header. */
  geoRegion?: string;
}

export interface DetectResult {
  region: string | null;
  /** True when any signal pointed at a covered state — caller must use the
   *  statutory written-consent flow. */
  bipaApplies: boolean;
  /** Which input(s) escalated. Useful for audit. */
  escalatedBy: ('declared' | 'billing' | 'geo')[];
}

const normaliseRegion = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isCovered = (region: string | undefined): region is CoveredRegion =>
  region !== undefined && (COVERED_REGIONS as readonly string[]).includes(region);

export const detectBipaRegion = (input: DetectInput): DetectResult => {
  const declared = normaliseRegion(input.declaredRegion);
  const billing = normaliseRegion(input.billingCountry);
  const geo = normaliseRegion(input.geoRegion);

  const escalatedBy: DetectResult['escalatedBy'] = [];
  if (isCovered(declared)) escalatedBy.push('declared');
  if (isCovered(geo)) escalatedBy.push('geo');
  // Billing country alone (e.g. 'US') doesn't pinpoint a covered state but
  // marks the subject as a US resident; it can only escalate when combined
  // with a state signal. Recorded for audit when present.
  if (billing === 'US' && (declared?.startsWith('US-') || geo?.startsWith('US-'))) {
    escalatedBy.push('billing');
  }

  // Strictness pick: declared first (subject self-attestation is authoritative
  // for legal disclosures), then geo.
  const region: string | null =
    (isCovered(declared) && declared) || (isCovered(geo) && geo) || declared || geo || null;

  const bipaApplies = isCovered(region ?? undefined);
  return { region, bipaApplies, escalatedBy };
};

// ---------- Retention ----------

export const computeRetentionWindowEndsAt = (
  jurisdiction: Jurisdiction,
  region: string | null,
  grantedAt: Date,
): Date | null => {
  if (region === 'US-IL') return new Date(grantedAt.getTime() + 3 * YEAR_MS);
  if (region === 'US-TX') return new Date(grantedAt.getTime() + 1 * YEAR_MS);
  if (region === 'US-WA') return new Date(grantedAt.getTime() + 3 * YEAR_MS);
  if (jurisdiction === 'us_bipa') return new Date(grantedAt.getTime() + 3 * YEAR_MS);
  // GDPR / LGPD / CCPA / other rely on the per-event retention_days mechanic.
  return null;
};
