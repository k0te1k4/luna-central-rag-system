import * as path from 'path';
import * as vscode from 'vscode';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  PutObjectCommand,
  _Object
} from '@aws-sdk/client-s3';
import { createS3Client } from './s3';
import { getKbConfig, normalizePrefix } from './config';
import { getS3Credentials } from './secrets';

export type KbObject = {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
};

export type KbVersion = {
  name: string;
};

export type KbCategory = 'docs' | 'raw' | 'user-files';

function joinKey(...parts: string[]): string {
  const s = parts
    .filter(Boolean)
    .map(p => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .join('/');
  return s.replace(/\/+/g, '/');
}

export function versionPrefix(version: string): string {
  const cfg = getKbConfig();
  const base = normalizePrefix(cfg.basePrefix);
  return joinKey(base, version);
}

export function categoryPrefix(version: string, category: KbCategory): string {
  return joinKey(versionPrefix(version), category);
}

export class KnowledgeBaseStorage {
  private s3Promise: Promise<ReturnType<typeof createS3Client>> | null = null;
  private s3CfgFingerprint: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async isReady(): Promise<boolean> {
    const cfg = getKbConfig();
    if (!cfg.enabled) return false;
    if (!cfg.bucket) return false;
    const creds = await getS3Credentials(this.context);
    return !!creds;
  }

  private async s3() {
    const cfg = getKbConfig();
    const fp = `${cfg.enabled}|${cfg.bucket}|${cfg.endpoint}|${cfg.region}`;
    if (this.s3CfgFingerprint && this.s3CfgFingerprint !== fp) {
      // settings changed
      this.s3Promise = null;
    }
    this.s3CfgFingerprint = fp;
    if (!this.s3Promise) {
      this.s3Promise = (async () => {
        const creds = await getS3Credentials(this.context);
        if (!creds) {
          throw new Error('Yandex Object Storage credentials are not set. Run: LuNA KB: Set Storage Credentials');
        }
        if (!cfg.bucket) {
          throw new Error('Yandex Object Storage bucket is not set. Set setting: luna.kb.storage.bucket');
        }
        return createS3Client(cfg, creds);
      })();
    }
    return this.s3Promise;
  }

  async listVersions(): Promise<KbVersion[]> {
    const cfg = getKbConfig();
    if (cfg.knownVersions.length) {
      return cfg.knownVersions.map(name => ({ name }));
    }
    const s3 = await this.s3();
    const base = normalizePrefix(cfg.basePrefix);
    const prefix = base ? `${base}/` : '';
    const cmd = new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: prefix,
      Delimiter: '/'
    });
    const out = await s3.send(cmd);
    const cps = out.CommonPrefixes || [];
    const versions = cps
      .map(cp => cp.Prefix || '')
      .map(p => p.replace(prefix, '').replace(/\/$/, ''))
      .filter(Boolean)
      .sort();
    return versions.map(name => ({ name }));
  }

  async ensureVersionExists(version: string): Promise<void> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    const key = joinKey(versionPrefix(version), '.keep');
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: 'keep',
        ContentType: 'text/plain'
      })
    );
  }

  async listObjects(version: string, category: KbCategory): Promise<KbObject[]> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    const pref = `${categoryPrefix(version, category)}/`;
    const objects: KbObject[] = [];
    let ContinuationToken: string | undefined = undefined;
    for (;;) {
      const out: ListObjectsV2CommandOutput = await s3.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: pref,
          ContinuationToken
        })
      );

      for (const obj of out.Contents || []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        objects.push(mapObj(obj));
      }

      if (!out.IsTruncated) break;
      ContinuationToken = out.NextContinuationToken;
      if (!ContinuationToken) break;
    }
    objects.sort((a, b) => a.key.localeCompare(b.key));
    return objects;
  }

  async headObject(key: string): Promise<KbObject | null> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return {
        key,
        size: out.ContentLength || 0,
        lastModified: out.LastModified,
        etag: out.ETag
      };
    } catch {
      return null;
    }
  }

  async downloadToFile(key: string, targetUri: vscode.Uri): Promise<void> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    const out = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const body = out.Body;
    if (!body) throw new Error(`Empty body for ${key}`);

    const chunks: Uint8Array[] = [];
    // @aws-sdk/client-s3 body is a stream in Node
    const stream = body as any;
    for await (const chunk of stream) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    const data = Buffer.concat(chunks.map(c => Buffer.from(c)));
    await vscode.workspace.fs.writeFile(targetUri, data);
  }

  async uploadFromFile(localUri: vscode.Uri, key: string, contentType?: string): Promise<void> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    const data = await vscode.workspace.fs.readFile(localUri);
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: Buffer.from(data),
        ContentType: contentType
      })
    );
  }

  async uploadBytes(bytes: Uint8Array, key: string, contentType?: string): Promise<void> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: Buffer.from(bytes),
        ContentType: contentType
      })
    );
  }

  async deleteObject(key: string): Promise<void> {
    const cfg = getKbConfig();
    const s3 = await this.s3();
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  }

  /** Convert object key to a friendly name relative to version/category prefix. */
  relativeName(version: string, category: KbCategory, key: string): string {
    const pref = `${categoryPrefix(version, category)}/`;
    if (key.startsWith(pref)) return key.slice(pref.length);
    return path.posix.basename(key);
  }
}

function mapObj(obj: _Object): KbObject {
  return {
    key: obj.Key || '',
    size: obj.Size || 0,
    lastModified: obj.LastModified,
    etag: obj.ETag
  };
}
