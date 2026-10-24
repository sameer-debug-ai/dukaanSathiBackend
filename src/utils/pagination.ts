import type { ApiMeta } from './apiResponse';

export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

export function getPageParams(query: { page?: unknown; limit?: unknown }, defaultLimit = 20, maxLimit = 200): PageParams {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const rawLimit = Number.parseInt(String(query.limit ?? defaultLimit), 10) || defaultLimit;
  const limit = Math.min(Math.max(1, rawLimit), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

export function pageMeta(params: PageParams, total: number): ApiMeta {
  return {
    page: params.page,
    limit: params.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.limit)),
  };
}

/** Escapes user input for safe use inside a RegExp. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
