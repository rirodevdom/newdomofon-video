import { query } from '../db.js';

export async function cleanupExpiredPlaybackTokens(): Promise<void> {
  await query('DELETE FROM playback_tokens WHERE expires_at < now() - interval \'1 hour\'');
}
