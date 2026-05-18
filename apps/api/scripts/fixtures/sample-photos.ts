// Fixture metadata for the demo seed. No real bytes are uploaded by the seed
// program; these filenames/content-types are used to populate photo rows and
// to compose deterministic R2 object keys. A future iteration can ship a
// small static JPEG and push it to MinIO under each derivative key.

export interface SamplePhoto {
  filename: string;
  contentType: string;
  width: number;
  height: number;
  originalBytes: number;
}

export const SAMPLE_PHOTOS: ReadonlyArray<SamplePhoto> = [
  {
    filename: 'demo-001.jpg',
    contentType: 'image/jpeg',
    width: 4000,
    height: 6000,
    originalBytes: 5_120_000,
  },
  {
    filename: 'demo-002.jpg',
    contentType: 'image/jpeg',
    width: 6000,
    height: 4000,
    originalBytes: 4_810_000,
  },
  {
    filename: 'demo-003.jpg',
    contentType: 'image/jpeg',
    width: 4000,
    height: 6000,
    originalBytes: 5_330_000,
  },
  {
    filename: 'demo-004.jpg',
    contentType: 'image/jpeg',
    width: 6000,
    height: 4000,
    originalBytes: 4_950_000,
  },
  {
    filename: 'demo-005.jpg',
    contentType: 'image/jpeg',
    width: 4000,
    height: 6000,
    originalBytes: 5_220_000,
  },
  {
    filename: 'demo-006.jpg',
    contentType: 'image/jpeg',
    width: 6000,
    height: 4000,
    originalBytes: 4_770_000,
  },
  {
    filename: 'demo-007.jpg',
    contentType: 'image/jpeg',
    width: 4000,
    height: 6000,
    originalBytes: 5_410_000,
  },
  {
    filename: 'demo-008.jpg',
    contentType: 'image/jpeg',
    width: 6000,
    height: 4000,
    originalBytes: 4_880_000,
  },
  {
    filename: 'demo-009.jpg',
    contentType: 'image/jpeg',
    width: 4000,
    height: 6000,
    originalBytes: 5_150_000,
  },
  {
    filename: 'demo-010.jpg',
    contentType: 'image/jpeg',
    width: 6000,
    height: 4000,
    originalBytes: 4_990_000,
  },
];

export interface DerivativeSpec {
  kind: 'thumb' | 'preview' | 'web' | 'full';
  width: number;
  height: number;
  bytes: number;
  watermarked: boolean;
}

// Aspect-preserving sizes per derivative kind. Bytes are nominal placeholders.
export const buildDerivativeSpecs = (photoWidth: number, photoHeight: number): DerivativeSpec[] => {
  const aspect = photoHeight / photoWidth;
  const sized = (targetW: number): { w: number; h: number } => ({
    w: targetW,
    h: Math.round(targetW * aspect),
  });
  const thumb = sized(320);
  const preview = sized(1024);
  const web = sized(1600);
  return [
    { kind: 'thumb', width: thumb.w, height: thumb.h, bytes: 32_000, watermarked: true },
    { kind: 'preview', width: preview.w, height: preview.h, bytes: 180_000, watermarked: true },
    { kind: 'web', width: web.w, height: web.h, bytes: 420_000, watermarked: true },
    { kind: 'full', width: photoWidth, height: photoHeight, bytes: 4_800_000, watermarked: false },
  ];
};
