import { api } from './api';

/** Gateway URL for a preview path, carrying a short-lived signed ticket that the gateway turns into a preview cookie. */
export async function previewAccessUrl(previewId: string, path = '/'): Promise<string> {
  return (await api<{ url: string }>(`/previews/${previewId}/access`, { method: 'POST', body: { path } })).url;
}

/** Opens a preview in a new tab (the tab is opened synchronously so popup blockers allow it). */
export async function openPreview(previewId: string, path = '/') {
  const win = window.open('about:blank', '_blank');
  try {
    const url = await previewAccessUrl(previewId, path);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (e) {
    win?.close();
    throw e;
  }
}
