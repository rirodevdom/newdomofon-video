import type { Request } from 'express';

export type Role = 'super_admin' | 'operator' | 'viewer' | 'installer';

export interface AuthUser {
  id: string;
  login: string;
  role: Role;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}
