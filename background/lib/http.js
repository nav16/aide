export async function extractError(res, label) {
  const body = await res.json().catch(() => ({}));
  return new Error(body.error?.message || `${label} error ${res.status}`);
}
