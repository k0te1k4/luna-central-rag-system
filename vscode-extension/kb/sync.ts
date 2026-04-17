import * as vscode from 'vscode';
import * as path from 'path';
import { KnowledgeBaseStorage, KbObject, KbCategory } from './storage';

export type SyncResult = {
  downloaded: number;
  skipped: number;
  removed: number;
  cacheRoot: vscode.Uri;
};

type ManifestEntry = {
  etag?: string;
  size: number;
  lastModified?: string;
};

type Manifest = Record<string, ManifestEntry>;

function cacheRoot(context: vscode.ExtensionContext, version: string): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'kb', version);
}

function categoryRoot(context: vscode.ExtensionContext, version: string, category: KbCategory): vscode.Uri {
  return vscode.Uri.joinPath(cacheRoot(context, version), category);
}

function manifestUri(context: vscode.ExtensionContext, version: string, category: KbCategory): vscode.Uri {
  // keep per-category manifests to avoid collisions
  return vscode.Uri.joinPath(cacheRoot(context, version), `manifest.${category}.json`);
}

async function readManifest(uri: vscode.Uri): Promise<Manifest> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const s = Buffer.from(raw).toString('utf8');
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Manifest;
  } catch {
    return {};
  }
}

async function writeManifest(uri: vscode.Uri, m: Manifest): Promise<void> {
  const parent = uri.with({ path: path.posix.dirname(uri.path) });
  await vscode.workspace.fs.createDirectory(parent);
  const bytes = Buffer.from(JSON.stringify(m, null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(uri, bytes);
}

function sanitizeRel(rel: string): string {
  // prevent path traversal
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(p => p && p !== '.' && p !== '..');
  return parts.join('/');
}

export async function syncDocsFromCloud(params: {
  context: vscode.ExtensionContext;
  storage: KnowledgeBaseStorage;
  version: string;
  objects: KbObject[];
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
  cancellationToken?: vscode.CancellationToken;
  category?: KbCategory;
}): Promise<SyncResult> {
  const { context, storage, version, objects } = params;
  const category: KbCategory = (params.category || 'docs') as any;
  const mUri = manifestUri(context, version, category);
  const manifest = await readManifest(mUri);

  // Ensure the docs cache root exists even if there are no objects in the cloud yet.
  // This prevents downstream code (indexer) from failing with ENOENT on scandir.
  await vscode.workspace.fs.createDirectory(categoryRoot(context, version, category));

  const currentKeys = new Set(objects.map(o => o.key));
  let downloaded = 0;
  let skipped = 0;
  let removed = 0;

  // remove stale files from cache
  for (const oldKey of Object.keys(manifest)) {
    if (!currentKeys.has(oldKey)) {
      // Best-effort remove the cached file from disk as well.
      // Previously we only removed it from the manifest, leaving stale files on disk.
      // That could cause reindex to still pick up documents that were deleted from Object Storage.
      try {
        const rel = sanitizeRel(storage.relativeName(version, category, oldKey));
        const target = vscode.Uri.joinPath(categoryRoot(context, version, category), ...rel.split('/'));
        await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false } as any);
      } catch {
        // ignore
      }
      delete manifest[oldKey];
      removed++;
    }
  }

  const total = Math.max(1, objects.length);
  let i = 0;
  for (const obj of objects) {
    i++;
    if (params.cancellationToken?.isCancellationRequested) throw new Error('Sync cancelled');

    const old = manifest[obj.key];
    const same = old && old.etag && obj.etag && old.etag === obj.etag && old.size === obj.size;
    if (same) {
      skipped++;
      params.progress?.report({
        message: `KB cache: up-to-date (${storage.relativeName(version, category, obj.key)})`,
        increment: (1 / total) * 100
      });
      continue;
    }

    const rel = sanitizeRel(storage.relativeName(version, category, obj.key));
    const target = vscode.Uri.joinPath(categoryRoot(context, version, category), ...rel.split('/'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    params.progress?.report({ message: `KB cache: downloading ${rel}`, increment: (1 / total) * 100 });
    await storage.downloadToFile(obj.key, target);
    manifest[obj.key] = {
      etag: obj.etag,
      size: obj.size,
      lastModified: obj.lastModified ? obj.lastModified.toISOString() : undefined
    };
    downloaded++;
  }

  await writeManifest(mUri, manifest);

  return {
    downloaded,
    skipped,
    removed,
    cacheRoot: categoryRoot(context, version, category)
  };
}
