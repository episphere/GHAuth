/**
 * Single structured record per request, so rate limit consumption is traceable in logs.
 */
const logRequest = ({ api, status, startedAt, rateLimit, error, ...details }) => {
    console.log(JSON.stringify({
        api,
        status,
        durationMs: Date.now() - startedAt,
        resource: rateLimit?.resource,
        limit: rateLimit?.limit,
        remaining: rateLimit?.remaining,
        used: rateLimit?.used,
        resetIn: rateLimit?.resetIn,
        error: error || undefined,
        ...details
    }));
};

module.exports = {
    logRequest
};
