import * as vscode from 'vscode';

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

const ACCESS_KEY_KEY = 'luna.kb.s3.accessKeyId';
const SECRET_KEY_KEY = 'luna.kb.s3.secretAccessKey';

export async function getS3Credentials(context: vscode.ExtensionContext): Promise<S3Credentials | null> {
  const accessKeyId = await context.secrets.get(ACCESS_KEY_KEY);
  const secretAccessKey = await context.secrets.get(SECRET_KEY_KEY);
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
}

export async function setS3Credentials(context: vscode.ExtensionContext, creds: S3Credentials): Promise<void> {
  await context.secrets.store(ACCESS_KEY_KEY, creds.accessKeyId);
  await context.secrets.store(SECRET_KEY_KEY, creds.secretAccessKey);
}

export async function clearS3Credentials(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(ACCESS_KEY_KEY);
  await context.secrets.delete(SECRET_KEY_KEY);
}
