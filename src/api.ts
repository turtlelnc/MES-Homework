export async function api<T = any>(url: string, options: RequestInit = {}) {
  const res = await fetch(`/api${url}`, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data as T;
}
export const json = (method: string, body: any): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
