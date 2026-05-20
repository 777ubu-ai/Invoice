import { MockApiClient } from './api.mock.js';
import type { ApiClient } from './api.types.js';

// Sprint 2 API is not implemented yet. When it lands, add MockApiClient | HttpApiClient
// selection here based on env.
export const api: ApiClient = new MockApiClient();
