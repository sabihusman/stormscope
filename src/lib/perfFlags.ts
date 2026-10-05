/**
 * Performance switches. Each one is flipped in its own commit so a fix can be reverted alone and
 * measured before/after on the same profile (see BUILD_LOG, overnight performance round).
 */
/** Apply worker results (rain cells, flood, nowcast) one block per animation frame instead of as they arrive. */
export const BLOCK_APPLY_PER_FRAME = true
/** Use the RGBA frames rasterized in the worker; otherwise rasterize each nowcast frame on the main thread. */
export const WORKER_RASTER = false
/** First visit: store API responses in the service worker's cache instead of refetching everything when it takes control. */
export const WARM_CACHE_NO_REFETCH = true
