import { API_BASE_URL } from './env';
import { ApiError } from './api';

/**
 * Downloads a binary file from the API with the session cookie. Errors are reported as ApiError,
 * never as a broken file.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { credentials: 'include' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection and try again.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? 'DOWNLOAD_FAILED', body?.error?.message ?? 'The file could not be downloaded.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
