import { S3Client } from '@aws-sdk/client-s3';
import { getKbConfig } from './config';
import { S3Credentials } from './secrets';

export function createS3Client(cfg: ReturnType<typeof getKbConfig>, creds: S3Credentials): S3Client {
  // Yandex Object Storage is S3-compatible. We use path-style to be robust
  // across buckets with dots in the name and custom endpoints.
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey
    }
  });
}
