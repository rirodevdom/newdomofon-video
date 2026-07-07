import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

type NodeRow = {
  id: string;
  name: string;
  base_url: string | null;
  public_base_url: string | null;
  internal_url: string | null;
  status: string;
  last_seen_at: string | null;
  version: string | null;
  storage: Record<string, unknown> | null;
  is_enabled: boolean;
  camera_count: number;
  device_count: number;
};

type CameraRow = {
  id: string;
  dvr_server_id: string | null;
  is_enabled: boolean;
};

type DeviceRow = {
  id: string;
  dvr_server_id: string | null;
  name: string;
  connection_type: string;
  host: string | null;
  port: number | null;
  username: string | null;
  has_password?: boolean;
  rtsp_url: string | null;
};

function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const age = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  return Number.isFinite(age) ? age : null;
}

function nodeHealth(row: Pick<NodeRow, 'is_enabled' | 'last_seen_at'>): 'online' | 'warning' | 'offline' {
  if (!row.is_enabled) return 'offline';
  const age = ageSeconds(row.last_seen_at);
  if (age === null) return 'offline';
  if (age < 60) return 'online';
  if (age < 180) return 'warning';
  return 'offline';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function storageUsage(storage: Record<string, unknown> | null) {
  const source = storage || {};
  const total = toNumber(source.total_bytes ?? source.total ?? source.totalBytes);
  const free = toNumber(source.free_bytes ?? source.available_bytes ?? source.free ?? source.available ?? source.freeBytes);
  const usedFromNode = toNumber(source.used_bytes ?? source.used ?? source.usedBytes);
  const used = usedFromNode || (total > 0 && free > 0 ? Math.max(total - free, 0) : 0);
  return { used_bytes: used, total_bytes: total };
}

function deviceConfigured(row: DeviceRow): boolean {
  if (!row.name || !row.connection_type || !row.dvr_server_id) return false;
  if (row.connection_type === 'RTSP') return Boolean(row.rtsp_url || row.host);
  if (row.connection_type === 'ONVIF') return Boolean(row.host && row.port);
  if (row.connection_type === 'HIKVISION') return Boolean(row.host && row.port && row.username && row.has_password);
  return Boolean(row.host || row.rtsp_url);
}

dashboardRouter.get('/summary', asyncHandler(async (_req, res) => {
  const nodesResult = await query<NodeRow>(
    `SELECT ds.id, ds.name, ds.base_url, ds.public_base_url, ds.internal_url,
            ds.status, ds.last_seen_at, ds.version, ds.storage, ds.is_enabled,
            (SELECT count(*)::int FROM cameras c WHERE c.dvr_server_id = ds.id) AS camera_count,
            (SELECT count(*)::int FROM devices d WHERE d.dvr_server_id = ds.id) AS device_count
       FROM dvr_servers ds
      ORDER BY ds.created_at DESC`
  );
  const camerasResult = await query<CameraRow>('SELECT id, dvr_server_id, is_enabled FROM cameras');
  const devicesResult = await query<DeviceRow>(
    `SELECT id, dvr_server_id, name, connection_type, host, port, username, rtsp_url,
            (password IS NOT NULL AND password <> '') AS has_password
       FROM devices`
  );

  const nodeStatusById = new Map<string, 'online' | 'warning' | 'offline'>();
  let storageUsed = 0;
  let storageTotal = 0;

  const nodes = nodesResult.rows.map((node) => {
    const health = nodeHealth(node);
    nodeStatusById.set(node.id, health);
    const storage = storageUsage(node.storage);
    storageUsed += storage.used_bytes;
    storageTotal += storage.total_bytes;
    return {
      ...node,
      health,
      age_seconds: ageSeconds(node.last_seen_at),
      camera_count: Number(node.camera_count || 0),
      device_count: Number(node.device_count || 0),
      storage_used_bytes: storage.used_bytes,
      storage_total_bytes: storage.total_bytes
    };
  });

  const enabledCameras = camerasResult.rows.filter((camera) => camera.is_enabled);
  const onlineCameras = enabledCameras.filter((camera) => camera.dvr_server_id && nodeStatusById.get(camera.dvr_server_id) === 'online').length;
  const configuredDevices = devicesResult.rows.filter(deviceConfigured);
  const onlineDevices = configuredDevices.filter((device) => device.dvr_server_id && nodeStatusById.get(device.dvr_server_id) === 'online').length;

  res.json({
    cameras: {
      total: camerasResult.rows.length,
      online: onlineCameras,
      offline: Math.max(camerasResult.rows.length - onlineCameras, 0)
    },
    devices: {
      total: devicesResult.rows.length,
      online: onlineDevices,
      offline: Math.max(devicesResult.rows.length - onlineDevices, 0),
      unconfigured: devicesResult.rows.length - configuredDevices.length
    },
    nodes: {
      total: nodes.length,
      online: nodes.filter((node) => node.health === 'online').length,
      warning: nodes.filter((node) => node.health === 'warning').length,
      offline: nodes.filter((node) => node.health === 'offline').length
    },
    storage: {
      used_bytes: storageUsed,
      total_bytes: storageTotal
    },
    node_items: nodes
  });
}));
