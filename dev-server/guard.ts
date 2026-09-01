import type { Connect } from 'vite'
import { postContentTypeAllowed, postContentTypeError } from '../src/lib/local-api-guard'

/**
 * Der Wächter vor /local-api — Content-Type, CSRF-Header, Origin.
 *
 * `port` ist ein Parameter und kein fester Wert mehr: die Origin-Liste unten
 * nennt den Port, auf dem der Server WIRKLICH hört. Stand er fest verdrahtet
 * in der Datei, konnte man den Server kein zweites Mal starten, ohne dass die
 * Liste einen Port nennt, auf dem niemand mehr hört — und dann fällt die
 * Prüfung still auf die Loopback-Regex allein zurück.
 */
export function createLocalApiGuard(port: number): Connect.NextHandleFunction {
  // Vites eigener Middleware-Typ statt einer geratenen Signatur: `next`
  // ist hier Pflicht, weil dieser Wächter durchreicht statt zu antworten.
  return (req, res, next) => {
    // Exclude GET proxy-image/download from strict header checks (used in <img> tags and simple fetches)
    if (req.method === 'GET' && (req.url?.startsWith('/proxy-image') || req.url?.startsWith('/proxy-download'))) {
      return next();
    }

    // 1. Strict Content-Type enforcement for POST requests. The rule is
    // application/json everywhere except /transcribe, whose body IS the
    // raw recorded audio and was 415'd here before the whisper handler
    // ever saw it (GitHub #115, graysoncooper). The carve-out swaps the
    // JSON requirement for an audio one, it does not drop the check.
    if (req.method === 'POST') {
       const contentType = String(req.headers['content-type'] || '');
       if (!postContentTypeAllowed(req.url, contentType)) {
           res.writeHead(415, { 'Content-Type': 'text/plain' });
           res.end(postContentTypeError(req.url));
           return;
       }
    }
    
    // 2. Custom Header Requirement (CSRF Protection)
    if (req.headers['x-locally-uncensored'] !== 'true') {
       res.writeHead(403, { 'Content-Type': 'text/plain' });
       res.end('Forbidden: Missing x-locally-uncensored header (CSRF Protection)');
       return;
    }

    // 3. Strict Origin Validation (Defense in Depth)
    const origin = req.headers.origin;
    if (origin) {
        // The allowlist is built from constants only. It used to append
        // `http(s)://${req.headers.host}` so a request always matched its
        // own host — but the Host header is attacker-chosen under DNS
        // rebinding: a page on evil.com whose DNS flips to 127.0.0.1 sends
        // Origin *and* Host of evil.com, the two agree, and the check waved
        // the request through to /shell-execute and /execute-code with no
        // authentication at all. A value the caller supplies can never be
        // the thing that authorises the caller.
        // Loopback on any port stays allowed: Vite binds 5274+ when 5273 is
        // busy and the page it serves then legitimately carries that origin
        // (issue #51, adhney). That stays safe where the host header did
        // not, because rebinding hands the attacker a *name* — the browser
        // only stamps a literal 127.0.0.1/localhost origin on a page it
        // really loaded from loopback, and `evil.localhost` (which Vite's
        // own host check tolerates) does not match this pattern.
        const allowedOrigins = [
            'tauri://localhost', 'http://tauri.localhost',
            `http://localhost:${port}`, `http://127.0.0.1:${port}`,
        ];
        const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        if (!allowedOrigins.includes(origin) && !isLoopback) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: Invalid Origin (CSRF Protection)');
            return;
        }
    }

    next();
  }
}
