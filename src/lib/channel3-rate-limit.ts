const MAX_REQUESTS_PER_WINDOW = 8;
import { takeClientRequestLimit } from './request-limits';

export function takeChannel3RateLimit(request: Request, now = Date.now()): boolean {
  return takeClientRequestLimit(request, 'channel3', MAX_REQUESTS_PER_WINDOW, now).allowed;
}
