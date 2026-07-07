import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const onvif: any = require('node-onvif');

interface ResolveParams {
  xaddr?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  profileToken?: string;
}

function normalizeXaddr(input: ResolveParams): string {
  if (input.xaddr && /^https?:\/\//i.test(input.xaddr)) return input.xaddr.trim();

  const rawHost = (input.host || input.xaddr || '').trim();
  if (!rawHost) throw new Error('ONVIF host or xaddr is required');

  if (/^https?:\/\//i.test(rawHost)) return rawHost;

  const port = input.port || 80;
  return `http://${rawHost}:${port}/onvif/device_service`;
}

function deepFindUri(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindUri(item);
      if (found) return found;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(obj)) {
    if (key.toLowerCase() === 'uri' && typeof item === 'string' && /^rtsp:\/\//i.test(item)) {
      return item;
    }
    const found = deepFindUri(item);
    if (found) return found;
  }
  return null;
}

function addCredentialsToRtsp(uri: string, username?: string, password?: string): string {
  if (!username || !password) return uri;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'rtsp:') return uri;
    if (parsed.username || parsed.password) return uri;
    parsed.username = username;
    parsed.password = password;
    return parsed.toString();
  } catch {
    return uri;
  }
}

function mapProfile(profile: any) {
  return {
    token: profile?.token || profile?.Token || profile?.$.token || '',
    name: profile?.name || profile?.Name || profile?.token || profile?.Token || '',
    video: profile?.video || null,
    audio: profile?.audio || null,
    raw: profile
  };
}

export async function discoverOnvif(timeoutMs = 4000) {
  const timeout = Math.min(Math.max(timeoutMs, 1000), 15000);

  const probePromise = Promise.resolve(onvif.startProbe());
  const timerPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`ONVIF discovery timed out after ${timeout}ms`)), timeout);
  });

  try {
    const devices = await Promise.race([probePromise, timerPromise]) as any[];
    return (devices || []).map((device) => ({
      urn: device.urn || null,
      name: device.name || null,
      hardware: device.hardware || null,
      location: device.location || null,
      xaddrs: device.xaddrs || [],
      scopes: device.scopes || []
    }));
  } finally {
    if (typeof onvif.stopProbe === 'function') {
      try { await onvif.stopProbe(); } catch { /* ignore */ }
    }
  }
}

export async function resolveOnvifStreamUri(input: ResolveParams) {
  const xaddr = normalizeXaddr(input);

  const device = new onvif.OnvifDevice({
    xaddr,
    user: input.username || '',
    pass: input.password || ''
  });

  await device.init();

  let information: unknown = null;
  try {
    information = await device.getInformation();
  } catch {
    information = null;
  }

  const rawProfiles = typeof device.getProfileList === 'function' ? device.getProfileList() : [];
  const profiles = (rawProfiles || []).map(mapProfile);
  if (!profiles.length) throw new Error('ONVIF camera returned no media profiles');

  const selectedToken = input.profileToken || profiles[0].token;
  if (selectedToken && typeof device.changeProfile === 'function') {
    device.changeProfile(selectedToken);
  }

  let streamUri = '';

  if (device.services?.media?.getStreamUri) {
    try {
      const result = await device.services.media.getStreamUri({
        ProfileToken: selectedToken,
        Protocol: 'RTSP'
      });
      streamUri = deepFindUri(result?.data) || deepFindUri(result) || '';
    } catch {
      streamUri = '';
    }
  }

  if (!streamUri && typeof device.getUdpStreamUrl === 'function') {
    streamUri = device.getUdpStreamUrl() || '';
  }

  if (!streamUri) {
    throw new Error('ONVIF camera did not return RTSP stream URI');
  }

  streamUri = addCredentialsToRtsp(streamUri, input.username, input.password);

  return {
    xaddr,
    streamUri,
    selectedProfileToken: selectedToken,
    profiles,
    information
  };
}
