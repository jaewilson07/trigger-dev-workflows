import { signRequest, type S3Creds } from "./s3Sigv4.js";
import { BUCKET, parseListObjectsV2, type ObjectInfo } from "./paperclipBackup.js";

/** Thin S3 calls (list / head / copy / delete) against bonker's MinIO with the scoped backup user. */

export const S3_ENDPOINT = process.env.PAPERCLIP_BACKUP_S3_ENDPOINT ?? "http://bonker.lan:9010";
export const S3_REGION = "us-east-1";

async function call(
  creds: S3Creds,
  method: "GET" | "HEAD" | "PUT" | "DELETE",
  path: string,
  extra: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const { url, headers } = signRequest(creds, { method, endpoint: S3_ENDPOINT, path, now: new Date(), ...extra });
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(60_000) });
  return res;
}

async function mustOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`S3 ${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function listAll(creds: S3Creds, prefix = ""): Promise<ObjectInfo[]> {
  const out: ObjectInfo[] = [];
  let token: string | null = null;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await mustOk(await call(creds, "GET", `/${BUCKET}`, { query }), `list ${prefix}`);
    const page = parseListObjectsV2(await res.text());
    out.push(...page.objects);
    token = page.nextToken;
  } while (token);
  return out;
}

export async function headSize(creds: S3Creds, key: string): Promise<number> {
  const res = await mustOk(await call(creds, "HEAD", `/${BUCKET}/${key}`), `head ${key}`);
  return Number(res.headers.get("content-length"));
}

export async function copyObject(creds: S3Creds, from: string, to: string): Promise<void> {
  await mustOk(
    await call(creds, "PUT", `/${BUCKET}/${to}`, { headers: { "x-amz-copy-source": `/${BUCKET}/${from}` } }),
    `copy ${from} -> ${to}`,
  );
}

export async function deleteObject(creds: S3Creds, key: string): Promise<void> {
  await mustOk(await call(creds, "DELETE", `/${BUCKET}/${key}`), `delete ${key}`);
}
