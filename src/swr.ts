import { sha256 } from "./crypto";

export const CACHE_STALE_AT_HEADER = 'x-edge-cache-stale-at';
export const CACHE_STATUS_HEADER = 'x-edge-cache-status';
export const CACHE_CONTROL_HEADER = 'Cache-Control';
export const CLIENT_CACHE_CONTROL_HEADER = 'x-client-cache-control';
export const ORIGIN_CACHE_CONTROL_HEADER = 'x-edge-origin-cache-control';

enum CacheStatus {
  HIT = 'HIT',
  MISS = 'MISS',
  REVALIDATING = 'REVALIDATING',
}

const swr = async ({
  request,
  ctx,
}: {
  request: Request;
  ctx: ExecutionContext;
}) => {
  const cache = caches.default;
  const cacheKey = await toCacheKey(request);
  const cachedRes = await cache.match(cacheKey);

  if (cachedRes) {
    let cacheStatus = cachedRes.headers.get(CACHE_STATUS_HEADER);

    if (shouldRevalidate(cachedRes)) {
      cacheStatus = CacheStatus.REVALIDATING;

      // update cached entry to show it's 'updating'
      // and thus shouldn't be re-fetched again
      await cache.put(
        cacheKey,
        addHeaders(cachedRes, {
          [CACHE_STATUS_HEADER]: CacheStatus.REVALIDATING,
        })
      );

      ctx.waitUntil(
        fetchAndCache({
          cacheKey,
          request,
          ctx,
        })
      );
    }

    return addHeaders(cachedRes, {
      [CACHE_STATUS_HEADER]: cacheStatus,
      [CACHE_CONTROL_HEADER]: cachedRes.headers.get(
        CLIENT_CACHE_CONTROL_HEADER
      ),
    });
  }

  return fetchAndCache({
    cacheKey,
    request,
    ctx,
  });
};

const fetchAndCache = async ({
  cacheKey,
  request,
  ctx,
}: {
  request: Request;
  ctx: ExecutionContext;
  cacheKey: string;
}) => {
  const cache = caches.default;

  // we add a cache busting query param here to ensure that
  // we hit the origin and no other upstream cf caches
  const originRes = await fetch(addCacheBustParam(request));
  const cacheControl = resolveCacheControlHeaders(request, originRes);

  const headers = {
    [ORIGIN_CACHE_CONTROL_HEADER]: originRes.headers.get('cache-control'),
    [CACHE_STALE_AT_HEADER]: cacheControl?.edge?.staleAt?.toString(),
    'x-origin-cf-cache-status': originRes.headers.get('cf-cache-status'),
  };

  if (cacheControl?.edge) {
    // store the cache response w/o blocking response
    ctx.waitUntil(
      cache.put(
        cacheKey,
        addHeaders(originRes, {
          ...headers,

          [CACHE_STATUS_HEADER]: CacheStatus.HIT,
          [CACHE_CONTROL_HEADER]: cacheControl.edge.value,

          // Store the client cache-control header separately as the main
          // cache-control header is being used as an api for cf worker cache api.
          // When the request is pulled from the cache we switch this client
          // cache-control value in place.
          [CLIENT_CACHE_CONTROL_HEADER]: cacheControl?.client,

          // remove headers we don't want to be cached
          'set-cookie': null,
          'cf-cache-status': null,
          vary: null,
        })
      )
    );
  }

  return addHeaders(originRes, {
    ...headers,
    [CACHE_STATUS_HEADER]: CacheStatus.MISS,
    [CACHE_CONTROL_HEADER]: cacheControl?.client,
    // 'x-cache-api-cache-control': cacheControl?.edge?.value,
    // 'x-origin-res-header': JSON.stringify(toObject(originRes.headers)),
  });
};

const resolveCacheControlHeaders = (req: Request, res: Response) => {
  if (!res.ok) return;

  const cacheControl = req.headers.get(CACHE_CONTROL_HEADER);

  // never cache anything that doesn't have a cache-control header
  if (!cacheControl) return;

  const parsedCacheControl = parseCacheControl(cacheControl);

  return {
    edge: resolveEdgeCacheControl(parsedCacheControl),
    client: resolveClientCacheControl(parsedCacheControl),
  };
};

const resolveEdgeCacheControl = ({
  sMaxage,
  staleWhileRevalidate,
}: ParsedCacheControl) => {
  // never edge-cache anything that doesn't have an s-maxage
  if (!sMaxage) return;

  const staleAt = Date.now() + sMaxage * 1000;

  // cache forever when no swr window defined meaning the stale
  // content can be served indefinitely while fresh stuff is re-fetched
  if (staleWhileRevalidate === 0) {
    return {
      value: 'immutable',
      staleAt,
    };
  }

  // when no swr defined only cache for the s-maxage
  if (!staleWhileRevalidate) {
    return {
      value: `max-age=${sMaxage}`,
      staleAt,
    };
  }

  // when both are defined we extend the cache time by the swr window
  // so that we can respond with the 'stale' content whilst fetching the fresh
  return {
    value: `max-age=${sMaxage + staleWhileRevalidate}`,
    staleAt,
  };
};

const resolveClientCacheControl = ({ maxAge }: ParsedCacheControl) => {
  if (!maxAge) return 'public, max-age=0, must-revalidate';

  return `max-age=${maxAge}`;
};

interface ParsedCacheControl {
  maxAge?: number;
  sMaxage?: number;
  staleWhileRevalidate?: number;
}

const parseCacheControl = (value = ''): ParsedCacheControl => {
  const parts = value.replace(/ +/g, '').split(',');

  return parts.reduce((result, part) => {
    const [key, value] = part.split('=');
    result[toCamelCase(key)] = Number(value) || 0;
    return result;
  }, {} as Record<string, number | undefined>);
};

const addHeaders = (
  response: Response,
  headers: { [key: string]: string | undefined | null }
) => {
  const response2 = new Response(response.clone().body, response);

  for (const key in headers) {
    const value = headers[key];

    // only truthy
    if (value !== undefined) {
      if (value === null) response2.headers.delete(key);
      else {
        response2.headers.delete(key);
        response2.headers.append(key, value);
      }
    }
  }

  return response2;
};

const toCamelCase = (string: string) =>
  string.replace(/-./g, (x) => x[1].toUpperCase());

const toCacheKey = async (req: Request) => {
  const key = await sha256(await req.clone().text());
  return `${req.url}?cache-key=${key}`;
}


const shouldRevalidate = (res: Response) => {
  // if the cache is already revalidating then we shouldn't trigger another
  const cacheStatus = res.headers.get(CACHE_STATUS_HEADER);
  if (cacheStatus === CacheStatus.REVALIDATING) return false;

  const staleAtHeader = res.headers.get(CACHE_STALE_AT_HEADER);

  // if we can't resolve an x-cached-at header => revalidate
  if (!staleAtHeader) return true;

  const staleAt = Number(staleAtHeader);
  const isStale = Date.now() > staleAt;

  // if the cached response is stale => revalidate
  return isStale;
};

const addCacheBustParam = (request: Request) => {
  const url = new URL(request.url);
  url.searchParams.append('t', Date.now().toString());
  return new Request(url.toString(), request);
};

export default swr;