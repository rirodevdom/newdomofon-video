import crypto from 'node:crypto';

export type HikvisionDevice = {
  id: string;
  name: string;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  rtsp_url: string | null;
};

export type HikvisionChannel = {
  channel: number;
  track_id: string;
  name: string;
  online: boolean | null;
  enabled: boolean | null;
  source_url: string;
  discovered_by: 'input_proxy_status' | 'input_proxy_channels' | 'streaming_channels' | 'manual';
};

function cleanHost(input: string | null | undefined): string {
  return String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

function parseDigestHeader(header: string): Record<string, string> {
  const source = header.replace(/^Digest\s+/i, '');
  const result: Record<string, string> = {};
  for (const part of source.match(/(?:[^,"]+|"[^"]*")+/g) || []) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim().replace(/^"|"$/g, '');
    result[key] = value;
  }
  return result;
}

function digestAuthHeader(params: Record<string, string>, method: string, uri: string, username: string, password: string): string {
  const realm = params.realm || '';
  const nonce = params.nonce || '';
  const qop = (params.qop || 'auth').split(',').map((item) => item.trim()).find((item) => item === 'auth') || '';
  const opaque = params.opaque;
  const algorithm = (params.algorithm || 'MD5').toUpperCase();
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = algorithm === 'MD5-SESS'
    ? md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:${cnonce}`)
    : md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`
  ];
  if (opaque) parts.push(`opaque="${opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

async function hikvisionGet(device: HikvisionDevice, path: string): Promise<string> {
  const host = cleanHost(device.host);
  if (!host) throw new Error('Hikvision host is empty');
  const port = Number(device.port || 80);
  const url = new URL(`http://${host}:${port}${path}`);
  const username = device.username || '';
  const password = device.password || '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const basic = username ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : '';

  try {
    let response = await fetch(url, {
      signal: controller.signal,
      headers: basic ? { authorization: basic } : undefined
    });

    const authHeader = response.headers.get('www-authenticate') || '';
    if (response.status === 401 && /^Digest/i.test(authHeader) && username) {
      const digest = digestAuthHeader(parseDigestHeader(authHeader), 'GET', url.pathname + url.search, username, password);
      response = await fetch(url, {
        signal: controller.signal,
        headers: { authorization: digest }
      });
    }

    const text = await response.text();
    if (!response.ok) throw new Error(`Hikvision ISAPI ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function tagText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
}

function blocks(xml: string, tag: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>[\\s\\S]*?</(?:\\w+:)?${tag}>`, 'gi'))).map((match) => match[0]);
}

function boolValue(value: string): boolean | null {
  if (!value) return null;
  if (['true', '1', 'yes', 'online'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no', 'offline'].includes(value.toLowerCase())) return false;
  return null;
}

function channelFromTrack(trackId: string): number {
  const parsed = Number(trackId);
  if (!Number.isFinite(parsed) || parsed < 100) return Number(trackId) || 0;
  return Math.floor(parsed / 100);
}

function mainTrackId(channel: number): string {
  return `${channel}01`;
}

function rtspPort(device: HikvisionDevice): number {
  if (device.rtsp_url) {
    try {
      const parsed = new URL(device.rtsp_url);
      if (parsed.port) return Number(parsed.port);
    } catch {
      // ignore invalid saved RTSP URL
    }
  }
  return Number(process.env.DVR_HIKVISION_RTSP_PORT || 554);
}

export function hikvisionRtspUrl(device: HikvisionDevice, trackId: string): string {
  const host = cleanHost(device.host);
  const username = device.username || '';
  const password = device.password || '';
  const auth = username ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@` : '';
  return `rtsp://${auth}${host}:${rtspPort(device)}/Streaming/channels/${trackId}`;
}

function normalizeChannel(device: HikvisionDevice, input: Partial<HikvisionChannel> & { track_id: string }, source: HikvisionChannel['discovered_by']): HikvisionChannel | null {
  const trackId = String(input.track_id || '').trim();
  if (!/^\d{3,4}$/.test(trackId)) return null;
  const channel = input.channel || channelFromTrack(trackId);
  if (!channel) return null;
  return {
    channel,
    track_id: trackId,
    name: input.name || `${device.name} channel ${channel}`,
    online: input.online ?? null,
    enabled: input.enabled ?? null,
    source_url: hikvisionRtspUrl(device, trackId),
    discovered_by: source
  };
}

function dedupe(channels: HikvisionChannel[]): HikvisionChannel[] {
  const map = new Map<string, HikvisionChannel>();
  for (const channel of channels) {
    const current = map.get(channel.track_id);
    if (!current || (current.online !== true && channel.online === true)) map.set(channel.track_id, channel);
  }
  return Array.from(map.values()).sort((a, b) => a.channel - b.channel || Number(a.track_id) - Number(b.track_id));
}

function parseInputProxyStatus(device: HikvisionDevice, xml: string): HikvisionChannel[] {
  return blocks(xml, 'InputProxyChannelStatus')
    .map((block) => {
      const trackId = tagText(block, 'streamingProxyChannelId') || mainTrackId(Number(tagText(block, 'id')));
      return normalizeChannel(device, {
        channel: Number(tagText(block, 'id')) || channelFromTrack(trackId),
        track_id: trackId,
        name: tagText(block, 'name') || tagText(block, 'channelName'),
        online: boolValue(tagText(block, 'online')),
        enabled: boolValue(tagText(block, 'enabled'))
      }, 'input_proxy_status');
    })
    .filter((channel): channel is HikvisionChannel => Boolean(channel));
}

function parseInputProxyChannels(device: HikvisionDevice, xml: string): HikvisionChannel[] {
  return blocks(xml, 'InputProxyChannel')
    .map((block) => {
      const id = Number(tagText(block, 'id'));
      const trackId = tagText(block, 'streamingProxyChannelId') || mainTrackId(id);
      return normalizeChannel(device, {
        channel: id || channelFromTrack(trackId),
        track_id: trackId,
        name: tagText(block, 'name') || tagText(block, 'channelName'),
        online: boolValue(tagText(block, 'online')),
        enabled: boolValue(tagText(block, 'enabled'))
      }, 'input_proxy_channels');
    })
    .filter((channel): channel is HikvisionChannel => Boolean(channel));
}

function parseStreamingChannels(device: HikvisionDevice, xml: string): HikvisionChannel[] {
  return blocks(xml, 'StreamingChannel')
    .map((block) => {
      const trackId = tagText(block, 'id');
      return normalizeChannel(device, {
        channel: Number(tagText(block, 'videoInputChannelID')) || channelFromTrack(trackId),
        track_id: trackId,
        name: tagText(block, 'channelName') || tagText(block, 'name'),
        enabled: boolValue(tagText(block, 'enabled'))
      }, 'streaming_channels');
    })
    .filter((channel): channel is HikvisionChannel => Boolean(channel));
}

export function generateHikvisionChannels(device: HikvisionDevice, firstChannel: number, lastChannel: number): HikvisionChannel[] {
  const first = Math.max(1, Math.floor(firstChannel));
  const last = Math.min(256, Math.max(first, Math.floor(lastChannel)));
  const items: HikvisionChannel[] = [];
  for (let channel = first; channel <= last; channel += 1) {
    const trackId = mainTrackId(channel);
    const item = normalizeChannel(device, {
      channel,
      track_id: trackId,
      name: `${device.name} channel ${channel}`,
      online: null,
      enabled: true
    }, 'manual');
    if (item) items.push(item);
  }
  return items;
}

export async function discoverHikvisionChannels(device: HikvisionDevice): Promise<HikvisionChannel[]> {
  const attempts: Array<[string, (xml: string) => HikvisionChannel[]]> = [
    ['/ISAPI/ContentMgmt/InputProxy/channels/status', (xml) => parseInputProxyStatus(device, xml)],
    ['/ISAPI/ContentMgmt/InputProxy/channels', (xml) => parseInputProxyChannels(device, xml)],
    ['/ISAPI/Streaming/channels', (xml) => parseStreamingChannels(device, xml)]
  ];
  const errors: string[] = [];

  for (const [path, parse] of attempts) {
    try {
      const channels = dedupe(parse(await hikvisionGet(device, path)));
      if (channels.length) return channels;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(errors.length ? errors.join(' | ') : 'Hikvision channels were not found');
}
