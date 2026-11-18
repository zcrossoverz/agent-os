import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-agentos': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('agentos:unauthorized'));
    throw new ApiError(res.status, (data && data.error) || res.statusText, data?.code);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
});

/** Mutation helper: runs `fn`, surfaces errors through the toast bus, invalidates nothing (SSE does). */
export function useAction<A = void, R = any>(fn: (a: A) => Promise<R>, opts: { success?: string | ((r: R) => string); onSuccess?: (r: R) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r) : opts.success, 'success');
      opts.onSuccess?.(r);
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
}

// ---- toasts (tiny event bus) ----
export type ToastKind = 'success' | 'error' | 'info';
export function toast(message: string, kind: ToastKind = 'info') {
  window.dispatchEvent(new CustomEvent('agentos:toast', { detail: { message, kind } }));
}
