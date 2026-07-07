CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.playback_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  camera_id uuid NOT NULL,
  user_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.playback_access_tokens
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS token text,
  ADD COLUMN IF NOT EXISTS camera_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE public.playback_access_tokens
   SET id = gen_random_uuid()
 WHERE id IS NULL;

ALTER TABLE public.playback_access_tokens
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS ux_playback_access_tokens_token
  ON public.playback_access_tokens(token)
  WHERE token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_playback_access_tokens_camera_expires
  ON public.playback_access_tokens(camera_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_playback_access_tokens_expires
  ON public.playback_access_tokens(expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'playback_access_tokens_camera_fk'
       AND conrelid = 'public.playback_access_tokens'::regclass
  ) THEN
    ALTER TABLE public.playback_access_tokens
      ADD CONSTRAINT playback_access_tokens_camera_fk
      FOREIGN KEY (camera_id)
      REFERENCES public.cameras(id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'playback_access_tokens_camera_fk'
       AND conrelid = 'public.playback_access_tokens'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.playback_access_tokens
      VALIDATE CONSTRAINT playback_access_tokens_camera_fk;
  END IF;
END $$;
