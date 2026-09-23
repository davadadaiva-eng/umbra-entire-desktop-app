import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface HttpResult {
  status: number;
  data: any;
  text: string;
}

/**
 * Universal HTTP client via curl.exe — bypasses Node v24's broken TLS stack
 * inside the backend process by spawning a fresh curl process per request.
 * Uses temp files for request bodies to avoid Windows command-line length limits.
 */
export class HttpBridge {
  static post(url: string, body: any, headers: Record<string, string> = {}, timeoutMs = 60000): Promise<HttpResult> {
    return HttpBridge.request({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, timeoutMs, url });
  }

  static get(url: string, params?: Record<string, string>, headers: Record<string, string> = {}, timeoutMs = 30000): Promise<HttpResult> {
    return HttpBridge.request({ method: 'GET', headers, params, timeoutMs, url });
  }

  static request(opts: { url: string; method: string; headers?: Record<string, string>; body?: any; params?: Record<string, string>; timeoutMs?: number }): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const { url: originalUrl, method = 'GET', headers = {}, body, params, timeoutMs = 60000 } = opts;

      // Build URL with query params
      let url = originalUrl;
      if (params && Object.keys(params).length > 0) {
        const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        url += (url.includes('?') ? '&' : '?') + qs;
      }

      const args = [
        '-s',
        '-m', String(Math.ceil(timeoutMs / 1000)),
        '-X', method,
        '-w', '\n__HTTP_STATUS__%{http_code}',
        '--max-time', String(Math.ceil(timeoutMs / 1000)),
      ];

      // Headers
      for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${v}`);
      }

      // Body — use temp file to avoid Windows cmd-line length limit
      let tmpFile: string | null = null;
      if (body !== undefined && body !== null) {
        let bodyStr: string;
        if (typeof body === 'string') {
          bodyStr = body;
        } else if (body instanceof URLSearchParams) {
          if (!headers['Content-Type']) args.push('-H', 'Content-Type: application/x-www-form-urlencoded');
          bodyStr = body.toString();
        } else {
          bodyStr = JSON.stringify(body);
        }

        // For small bodies, pass directly; for large bodies, use temp file
        if (bodyStr.length > 4000) {
          tmpFile = path.join(os.tmpdir(), `umbra-http-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
          fs.writeFileSync(tmpFile, bodyStr, 'utf8');
          args.push('--data-binary', `@${tmpFile}`);
        } else {
          args.push('-d', bodyStr);
        }
      }

      args.push(url);

      execFile('curl.exe', args, { timeout: timeoutMs + 10000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        // Clean up temp file
        if (tmpFile) {
          try { fs.unlinkSync(tmpFile); } catch {}
        }

        if (err) {
          const detail = stderr ? ` stderr=${String(stderr).slice(0,800)}` : '';
          const out = stdout ? ` stdout=${String(stdout).slice(0,800)}` : '';
          reject(new Error(`curl failed: ${err.message}${detail}${out} args=${args.slice(0,6).join(' ')}`));
          return;
        }

        const marker = '__HTTP_STATUS__';
        const markerIdx = stdout.indexOf(marker);
        let bodyText: string;
        let status = 0;

        if (markerIdx !== -1) {
          bodyText = stdout.substring(0, markerIdx).trim();
          const statusStr = stdout.substring(markerIdx + marker.length).trim();
          status = parseInt(statusStr, 10) || 0;
        } else {
          bodyText = stdout.trim();
          status = 200;
        }

        let data: any = null;
        try { data = JSON.parse(bodyText); } catch { data = null; }

        resolve({ status, data, text: bodyText });
      });
    });
  }
}
