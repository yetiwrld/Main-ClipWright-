import os from 'node:os';

/**
 * SPEC 03 §12 & SPEC 06 §5 — Central log and diagnostic redaction utility.
 * Strips Authorization headers, query params, API keys, tokens, cookies, and shortens home paths.
 */
export function redact(input: string, customHomeDir?: string): string {
  if (!input) return input;
  let out = input;

  // 1. Authorization & API key headers
  out = out.replace(
    /\b(Authorization|x-api-key|api-key|x-goog-api-key)\s*[:=]\s*(Bearer\s+|Basic\s+)?[^\s"',;}\]]+/gi,
    '$1: [REDACTED]'
  );

  // 2. Standalone Bearer tokens
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');

  // 3. URL query parameters (api_key, key, token, access_token, client_secret, secret, sig, signature)
  out = out.replace(
    /([?&](?:api_key|apikey|key|token|access_token|client_secret|secret|password|sig|signature)=)[^&#\s"',]+/gi,
    '$1[REDACTED]'
  );

  // 4. JSON / key=value fields containing secret names
  out = out.replace(
    /(["']?(?:apiKey|api_key|secretKey|secret_key|accessToken|access_token|privateKey|private_key|password|clientSecret)["']?\s*[:=]\s*["'])[^"']+(["'])/gi,
    '$1[REDACTED]$2'
  );

  // 5. Known token prefixes (OpenAI sk-, Anthropic sk-ant-, Groq gsk_, Google AIza, GitHub ghp_/gho_/github_pat_, GitLab glpat-, Slack xoxb-/xoxp-, HuggingFace hf_, Replicate r8_)
  out = out.replace(
    /\b(sk-ant-[A-Za-z0-9\-_]{8,}|sk-proj-[A-Za-z0-9\-_]{8,}|sk-[A-Za-z0-9\-_]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z\-_]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9\-_]{12,}|xox[baprs]-[A-Za-z0-9\-]{12,}|hf_[A-Za-z0-9]{16,}|r8_[A-Za-z0-9]{16,})\b/g,
    '[REDACTED_KEY]'
  );

  // 6. Netscape cookie file lines (domain \t flag \t path \t secure \t expiration \t name \t value)
  out = out.replace(
    /^(?:\.?[a-zA-Z0-9.-]+\t(?:TRUE|FALSE)\t\/[^\t]*\t(?:TRUE|FALSE)\t\d+\t[^\t]+\t).+$/gm,
    '[REDACTED_COOKIE_LINE]'
  );

  // 7. Long base64 / hex tokens (40+ contiguous base64/hex chars that look like keys/secrets, excluding file paths)
  out = out.replace(
    /(?<![/\\A-Za-z0-9])([A-Za-z0-9+/]{40,}={0,2})(?![/\\A-Za-z0-9])/g,
    '[REDACTED_TOKEN]'
  );

  // 8. Home directory paths -> ~
  const home = customHomeDir || os.homedir();
  if (home && home.length > 1) {
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escapedHome, 'g'), '~');
  }
  out = out.replace(/C:\\Users\\[^\\/\s"',]+/gi, '~');
  out = out.replace(/\/Users\/[^/\s"',]+/g, '~');
  out = out.replace(/\/home\/[^/\s"',]+/g, '~');

  return out;
}

/**
 * GeneratesUUIDv7 (time-sortable UUID per Spec 03 §3.1)
 */
export function uuidv7(): string {
  const now = BigInt(Date.now());
  const timeHex = now.toString(16).padStart(12, '0');
  const rand = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    rand[i] = Math.floor(Math.random() * 256);
  }
  const v7Byte = (0x70 | (rand[0] & 0x0f)).toString(16).padStart(2, '0');
  const r1 = rand[1].toString(16).padStart(2, '0');
  const variantByte = (0x80 | (rand[2] & 0x3f)).toString(16).padStart(2, '0');
  const restHex = Array.from(rand.slice(3))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${v7Byte}${r1}-${variantByte}${restHex.slice(0, 2)}-${restHex.slice(2, 14)}`;
}
