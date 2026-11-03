import type { Snapshot } from '../contracts/state';

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const value = JSON.parse(raw) as { error?: string; message?: string };
      message = value.error ?? value.message ?? raw;
    } catch { /* Non-JSON server errors are still visible. */ }
    throw new Error(message || `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const getState = () => request<Snapshot>('/api/state');
