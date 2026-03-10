export interface ImageUrlValidationResult {
  ok: boolean;
  reason?: string;
  normalized_url?: string;
}

const BLOCKED_SCHEME = /^(data|file):/i;
const RELATIVE_PATH = /^(\.{1,2}\/|\/(?!\/))/;

export function validateImageUrl(url: string): ImageUrlValidationResult {
  const trimmed = url.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'image source is empty' };
  }

  if (BLOCKED_SCHEME.test(trimmed)) {
    return { ok: false, reason: 'image URL protocol is not allowed' };
  }

  if (RELATIVE_PATH.test(trimmed)) {
    return { ok: false, reason: 'relative image path is not allowed' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'image URL must be an absolute HTTPS URL' };
  }

  if (parsed.protocol === 'data:' || parsed.protocol === 'file:') {
    return { ok: false, reason: 'image URL protocol is not allowed' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'image URL must use HTTPS' };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'image URL hostname is missing' };
  }

  return {
    ok: true,
    normalized_url: parsed.toString()
  };
}

export function isAllowedImageUrl(url: string): boolean {
  return validateImageUrl(url).ok;
}
