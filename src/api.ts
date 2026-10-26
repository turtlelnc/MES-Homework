export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(url: string, options: RequestInit = {}) {
  const res = await fetch(`/api${url}`, {
    credentials: "include",
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000),
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      data.error || `请求失败（${res.status}）`,
      res.status,
      Math.max(0, Number(res.headers.get("retry-after")) || 0) * 1000,
    );
  return data as T;
}
export const json = (method: string, body: any): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
