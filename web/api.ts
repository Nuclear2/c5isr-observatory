import type { Snapshot } from '../contracts/state';

export async function request<T>(path: string, body?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
  const controller = options.timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
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
    return await response.json() as T;
  } catch (reason) {
    if (controller?.signal.aborted) throw new Error('请求等待超时，尚未收到服务端确认。');
    throw reason;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const getState = () => request<Snapshot>('/api/state');
