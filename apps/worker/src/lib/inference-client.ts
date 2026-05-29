// HTTP client for the Python inference service (face detect + embed).
//
// Uses `undici` (Node's built-in HTTP engine) rather than fetch wrappers so we
// can stream multipart bodies without an extra dependency. The service is
// expected to expose `POST /embed/` accepting `multipart/form-data` with an
// `image` part, and to return the per-face bbox + 512-d embedding.

import { parseEnv, z } from '@pkg/env';
import { request } from 'undici';

const inferenceEnvSchema = z.object({
  INFERENCE_URL: z.string().url(),
  INFERENCE_API_KEY: z.string().min(1),
});

export type InferenceEnv = z.infer<typeof inferenceEnvSchema>;

let cachedEnv: InferenceEnv | undefined;

const getEnv = (): InferenceEnv => {
  if (!cachedEnv) cachedEnv = parseEnv(inferenceEnvSchema);
  return cachedEnv;
};

export interface DetectedFace {
  bbox: [number, number, number, number];
  score: number;
  embedding: number[];
}

export interface DetectEmbedResponse {
  vectors: DetectedFace[];
  model_version: string;
  embedding_dim: number;
}

export interface DetectAndEmbedOptions {
  filename?: string;
  contentType?: string;
}

/**
 * POST an image to the inference service and return detected faces +
 * embeddings. Throws on non-200. The caller is responsible for releasing the
 * image buffer (it is not retained here).
 */
export const detectAndEmbed = async (
  imageBytes: Buffer,
  options: DetectAndEmbedOptions = {},
): Promise<DetectEmbedResponse> => {
  const env = getEnv();
  const filename = options.filename ?? 'photo.jpg';
  const contentType = options.contentType ?? 'image/jpeg';

  const form = new FormData();
  // Node 20+ has global Blob/FormData; pass through to undici as the body.
  form.append('image', new Blob([imageBytes], { type: contentType }), filename);

  // undici's `body` type doesn't include FormData in some setups; cast through unknown.
  const res = await request(`${env.INFERENCE_URL}/embed/`, {
    method: 'POST',
    body: form as unknown as Buffer,
    headers: { 'X-API-Key': env.INFERENCE_API_KEY },
  });

  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`inference /embed/ ${res.statusCode}: ${body}`);
  }
  return (await res.body.json()) as DetectEmbedResponse;
};

export interface FaceQuality {
  bbox: [number, number, number, number];
  eyes_closed: boolean;
  left_ear: number;
  right_ear: number;
}

export interface QualityResponse {
  faces: number;
  eyes_closed_faces: number;
  ear_threshold: number;
  faces_detail: FaceQuality[];
  model_version: string;
}

/**
 * POST an image to the inference `/quality/` endpoint and return the per-face
 * eyes-closed assessment. Throws on non-200; the caller decides whether to
 * treat a failure as fatal (the quality worker treats it as best-effort).
 */
export const scoreQuality = async (
  imageBytes: Buffer,
  options: DetectAndEmbedOptions = {},
): Promise<QualityResponse> => {
  const env = getEnv();
  const filename = options.filename ?? 'photo.jpg';
  const contentType = options.contentType ?? 'image/jpeg';

  const form = new FormData();
  form.append('image', new Blob([imageBytes], { type: contentType }), filename);

  const res = await request(`${env.INFERENCE_URL}/quality/`, {
    method: 'POST',
    body: form as unknown as Buffer,
    headers: { 'X-API-Key': env.INFERENCE_API_KEY },
  });

  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`inference /quality/ ${res.statusCode}: ${body}`);
  }
  return (await res.body.json()) as QualityResponse;
};
