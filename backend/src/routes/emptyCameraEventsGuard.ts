import { Router } from 'express';

export const emptyCameraEventsGuardRouter = Router();

function emptyEventsResponse(req: any, res: any) {
  return res.status(200).json({
    items: [],
    events: [],
    total: 0,
    ignored: true,
    reason: 'empty-camera-id'
  });
}

emptyCameraEventsGuardRouter.get('/cameras//events', emptyEventsResponse);
emptyCameraEventsGuardRouter.get('/cameras/undefined/events', emptyEventsResponse);
emptyCameraEventsGuardRouter.get('/cameras/null/events', emptyEventsResponse);
