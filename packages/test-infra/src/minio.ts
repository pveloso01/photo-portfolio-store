// MinIO testcontainer wrapper. Starts a single-node MinIO and creates the two
// app buckets (originals + derivatives) before resolving. The bucket-creation
// uses the AWS S3 SDK so we exercise the same code path the app uses, which
// catches signature/endpoint config issues at fixture time rather than during
// the first real test.

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface StartedMinio {
  readonly container: StartedTestContainer;
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly buckets: ReadonlyArray<string>;
  readonly stop: () => Promise<void>;
}

const IMAGE = 'minio/minio:latest';
const ACCESS_KEY = 'minioadmin';
const SECRET_KEY = 'minioadmin';
const DEFAULT_BUCKETS = ['photo-originals', 'photo-derivatives'] as const;

export const startMinio = async (
  buckets: ReadonlyArray<string> = DEFAULT_BUCKETS,
): Promise<StartedMinio> => {
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({
      MINIO_ROOT_USER: ACCESS_KEY,
      MINIO_ROOT_PASSWORD: SECRET_KEY,
    })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withReuse()
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });

  for (const bucket of buckets) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
  s3.destroy();

  return {
    container,
    endpoint,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    buckets,
    stop: async () => {
      await container.stop();
    },
  };
};
