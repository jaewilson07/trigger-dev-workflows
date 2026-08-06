/**
 * Domo dataset replace, ported from crew-dcs's `routes/dataset/upload.py`.
 *
 * WHY A PORT AND NOT THE LIBRARY. crew-dcs is Python (`DomoTokenAuth` +
 * `DomoDataset.upload_data`) and this is a TypeScript Trigger.dev project with
 * no Python interpreter in the deployed task image -- the same constraint
 * `tasks/pattern-hunter-publish-gdoc.ts` documents for its own case. The wire
 * protocol below is copied from crew-dcs route-for-route rather than guessed:
 * these are Domo's INTERNAL `/api/data/v3` endpoints, not the public
 * `api.domo.com` Data API, and the two do not share a shape.
 *
 * WHY REPLACE AND NOT APPEND. The brief is a snapshot: a Domo card bound to
 * this dataset should show today's brief, not every brief ever run. crew-dcs's
 * `update_method="REPLACE"` is the same default.
 *
 * THE DATASET MUST ALREADY EXIST. Stage 2 uploads HEADERLESS CSV -- Domo maps
 * columns by POSITION against the dataset's existing schema, so this cannot
 * create a dataset and cannot reorder one. See `lib/brief-rows.ts` for the
 * exact schema it writes and `docs/morning-brief-rework.md` for the one-time
 * setup.
 */

export type DomoTokenAuth = {
  /** Instance NAME, not a hostname: `datacrew-space`, not `datacrew-space.domo.com`. */
  instance: string;
  accessToken: string;
};

/**
 * Returns null (not a throw) when Domo is not configured, so the delivery task
 * can report `skipped` -- an unconfigured destination is the normal state of a
 * fresh checkout, not a failure.
 */
export function domoAuthFromEnv(): DomoTokenAuth | null {
  const instance = process.env.DOMO_INSTANCE ?? "";
  const accessToken = process.env.DOMO_ACCESS_TOKEN ?? "";
  if (!instance || !accessToken) return null;
  return { instance, accessToken };
}

export type DomoUploadStage = 1 | 2 | 3 | 4;

export class DomoUploadError extends Error {
  constructor(
    readonly stage: DomoUploadStage,
    readonly datasetId: string,
    readonly status: number,
    readonly responseBody: string
  ) {
    super(
      `Domo dataset upload stage ${stage} failed for ${datasetId}: ` +
        `${status} ${responseBody.slice(0, 500)}`
    );
    this.name = "DomoUploadError";
  }
}

function baseUrl(auth: DomoTokenAuth): string {
  return `https://${auth.instance}.domo.com`;
}

/** crew-dcs's `DomoTokenAuth._domo_auth_header` -- an admin-panel access token,
 * NOT an OAuth bearer (that is a different auth class against a different host). */
function authHeaders(auth: DomoTokenAuth): Record<string, string> {
  return { "x-domo-developer-token": auth.accessToken };
}

/**
 * RFC 4180 field. Domo's parser reads `""` as an escaped quote and honours
 * newlines inside quoted fields, so an email subject containing a comma or a
 * snippet containing a line break survives intact rather than shifting every
 * later column by one.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\n");
}

/** Preps the dataset for upload and returns the upload session key. */
async function stageOneBeginUpload(auth: DomoTokenAuth, datasetId: string): Promise<string> {
  const res = await fetch(`${baseUrl(auth)}/api/data/v3/datasources/${datasetId}/uploads`, {
    method: "POST",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    // crew-dcs's un-partitioned base body. Partitioning would need `dataTag` +
    // `appendId: "latest"`, which the brief does not use.
    body: JSON.stringify({ action: null, appendId: null }),
  });
  const text = await res.text();
  if (!res.ok) throw new DomoUploadError(1, datasetId, res.status, text);

  const parsed = JSON.parse(text) as { uploadId?: string };
  if (!parsed.uploadId) {
    // A 200 with no uploadId is not a success -- stage 2 would PUT to
    // `/uploads/undefined/parts/1` and 404 with a much less obvious message.
    throw new DomoUploadError(1, datasetId, res.status, `no uploadId in response: ${text}`);
  }
  return parsed.uploadId;
}

/** Uploads one headerless CSV part into the open upload session. */
async function stageTwoPutPart(
  auth: DomoTokenAuth,
  datasetId: string,
  uploadId: string,
  csv: string,
  partId: number
): Promise<void> {
  const res = await fetch(
    `${baseUrl(auth)}/api/data/v3/datasources/${datasetId}/uploads/${uploadId}/parts/${partId}`,
    {
      method: "PUT",
      headers: { ...authHeaders(auth), "Content-Type": "text/csv" },
      body: csv,
    }
  );
  if (!res.ok) throw new DomoUploadError(2, datasetId, res.status, await res.text());
}

/** Closes the session and defines how the parts load into the dataset. */
async function stageThreeCommit(
  auth: DomoTokenAuth,
  datasetId: string,
  uploadId: string,
  updateMethod: "REPLACE" | "APPEND"
): Promise<void> {
  const res = await fetch(
    `${baseUrl(auth)}/api/data/v3/datasources/${datasetId}/uploads/${uploadId}/commit`,
    {
      method: "PUT",
      headers: { ...authHeaders(auth), "Content-Type": "application/json" },
      // `index: false` here and a separate `/indexes` call below -- crew-dcs
      // splits it the same way, because the commit-time index flag does not
      // report its own outcome.
      body: JSON.stringify({ index: false, action: updateMethod }),
    }
  );
  if (!res.ok) throw new DomoUploadError(3, datasetId, res.status, await res.text());
}

/**
 * Indexes the dataset into Adrenaline, which is what actually makes the new
 * rows visible to cards.
 *
 * Failing here is NOT swallowed: an uncommitted-to-index dataset leaves the
 * card showing yesterday's brief while the run reports success, which is
 * exactly the silent-staleness this repo's no-silent-failures convention is
 * about. Re-running is safe -- the upload is a REPLACE.
 */
async function indexDataset(auth: DomoTokenAuth, datasetId: string): Promise<void> {
  const res = await fetch(`${baseUrl(auth)}/api/data/v3/datasources/${datasetId}/indexes`, {
    method: "POST",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify({ dataIds: [] }),
  });
  if (!res.ok) throw new DomoUploadError(4, datasetId, res.status, await res.text());
}

export type DomoReplaceResult = {
  uploadId: string;
  rowCount: number;
};

/**
 * Replaces a dataset's contents with `rows` (headerless, column order must
 * match the dataset schema) and indexes it.
 */
export async function replaceDatasetRows(
  auth: DomoTokenAuth,
  datasetId: string,
  rows: string[][]
): Promise<DomoReplaceResult> {
  const uploadId = await stageOneBeginUpload(auth, datasetId);

  // part 1, matching crew-dcs's `part_id=index + 1` for a single frame. The
  // brief is a few hundred rows at most, so it never needs a multi-part split.
  await stageTwoPutPart(auth, datasetId, uploadId, toCsv(rows), 1);

  // crew-dcs sleeps 5s between the last part and the commit ("wait for uploads
  // to finish") -- the parts endpoint returns before Domo has durably staged
  // them, and committing too early drops rows. Kept as a plain sleep rather
  // than `wait.for`: at 5s a Trigger.dev checkpoint round-trip costs more than
  // it saves.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  await stageThreeCommit(auth, datasetId, uploadId, "REPLACE");
  await indexDataset(auth, datasetId);

  return { uploadId, rowCount: rows.length };
}
