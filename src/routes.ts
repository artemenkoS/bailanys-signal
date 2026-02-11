import type { RouteHandler } from './routes/shared';
import { authRoutes } from './routes/auth';
import { callHistoryRoutes } from './routes/callHistory';
import { contactRoutes } from './routes/contacts';
import { messageRoutes } from './routes/messages';
import { profileRoutes } from './routes/profile';
import { roomRoutes } from './routes/rooms';
import { userRoutes } from './routes/users';

export const routes: Record<string, RouteHandler> = {
  ...authRoutes,
  ...profileRoutes,
  ...userRoutes,
  ...contactRoutes,
  ...roomRoutes,
  ...messageRoutes,
  ...callHistoryRoutes,
};
