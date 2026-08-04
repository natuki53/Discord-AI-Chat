import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import { Agent, fetch as undiciFetch } from 'undici';

function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export async function resolvePublicAddress(hostname) {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('private_address');
    return { address: hostname, family: isIP(hostname) };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error('private_or_unresolved_address');
  }
  return addresses[0];
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('body_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractReadableText(html) {
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: 80 }).parse();
  const value = article?.textContent ?? document.body?.textContent ?? '';
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 12_000);
}

export async function safeWebFetch(
  inputUrl,
  { timeoutMs = 8000, maxBytes = 1_048_576, maxRedirects = 3, signal } = {},
) {
  let url = new URL(inputUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (url.protocol !== 'https:') throw new Error('https_required');
    if (url.username || url.password) throw new Error('userinfo_not_allowed');
    if (url.port && url.port !== '443') throw new Error('port_not_allowed');

    const resolved = await resolvePublicAddress(url.hostname);
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, resolved.address, resolved.family);
        },
      },
    });

    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const response = await undiciFetch(url, {
        dispatcher,
        redirect: 'manual',
        signal: requestSignal,
        headers: {
          'user-agent': 'DiscordAIChat/1.0 (+https://github.com/natuki53/Discord-AI-Chat)',
          accept: 'text/html,text/plain,application/json;q=0.8',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect_without_location');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`http_${response.status}`);

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('text/plain') &&
        !contentType.includes('application/json')
      ) {
        throw new Error('content_type_not_allowed');
      }

      const body = await readLimitedBody(response, maxBytes);
      const text = contentType.includes('text/html')
        ? extractReadableText(body, url.href)
        : body.slice(0, 12_000);
      return {
        url: url.href,
        title: contentType.includes('text/html') ? parseHTML(body).document.title?.trim() : '',
        text,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error('too_many_redirects');
}

export const __testing = { isPublicAddress };
