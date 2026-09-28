/**
 * Umbra OS — browsers sub-router (extracted from ApiServer route map).
 * Owns Desktop2 / Ghost execution, screen state, Chrome-extension telemetry
 * and audio device / loopback recording routes.
 * Re-exported via ApiServer — routes remain identical.
 */
import type { ApiServerDeps } from '../ApiServer';
import { AppError } from '../AppError';

type Handler = (url: URL, body: Record<string, unknown>, match?: RegExpMatchArray) => Promise<unknown>;
export type BrowserRouteEntry = [RegExp, Handler];

export function browserRoutes(deps: ApiServerDeps): BrowserRouteEntry[] {
  return [
    [/^POST \/api\/desktop2\/action$/, async (_url, body) => {
      const action = String(body.action || '');
      if (!action) throw new Error('action is required');
      const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};
      return { result: await deps.executeDesktop2(action, params) };
    }],
    [/^POST \/api\/ghost\/action$/, async (_url, body) => {
      const action = String(body.action || '');
      if (!action) throw new Error('action is required');
      const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};
      return { result: await deps.executeGhost(action, params) };
    }],
    [/^GET \/api\/ghost\/capture$/, async () => {
      const png = await deps.captureGhost();
      // Nothing has been captured yet — that is an absent resource, not a crash.
      if (!png) throw new AppError('No capture available — open Chrome or an app on Desktop 2 first', 404);
      return { image: png };
    }],
    [/^GET \/api\/screen\/state$/, async () => deps.screenState()],
    [/^GET \/api\/screen\/live$/, async () => deps.screenLive()],
    [/^POST \/api\/screen\/watch$/, async (_url, body) => deps.screenWatch(body.enabled !== false)],
    [/^POST \/api\/screen\/ask$/, async (_url, body) => {
      const question = String(body.question || '').trim();
      if (!question) throw new Error('question is required');
      const intent = body.intent !== undefined ? String(body.intent) : 'answer';
      return deps.screenAsk(question, intent);
    }],
    [/^POST \/api\/chrome\/telemetry$/, async (_url, body) => {
      const events = Array.isArray(body.events) ? body.events : [];
      const sessionId = String(body.sessionId || '');
      const cookieSnapshot = body.cookieSnapshot || {};
      return deps.handleChromeTelemetry(events, sessionId, cookieSnapshot);
    }],
    [/^GET \/api\/chrome\/status$/, async () => deps.getChromeExtensionStatus()],
    [/^GET \/api\/chrome\/logins$/, async () => deps.getChromeLoginEvents()],
    [/^POST \/api\/chrome\/logins\/approve$/, async (_url, body) => {
      const url = String(body.url || '');
      const provider = String(body.provider || '');
      const username = body.username !== undefined ? String(body.username) : undefined;
      if (!url || !provider) throw new Error('url and provider are required');
      return { approved: await deps.approveChromeLogin(url, provider, username) };
    }],
    [/^GET \/api\/chrome\/cookies$/, async (url) => {
      const domain = url.searchParams.get('domain') || undefined;
      return { cookies: await deps.getChromeCookies(domain) };
    }],
    [/^GET \/api\/chrome\/sites$/, async () => ({ sites: await deps.getChromeSites() })],
    [/^GET \/api\/audio\/devices$/, async () => ({ audio: await deps.listAudioDevices() })],
    [/^POST \/api\/audio\/set-default$/, async (_url, body) => {
      const flow = body.flow === 'capture' ? 'capture' as const : 'render' as const;
      const deviceId = String(body.deviceId || '');
      if (!deviceId) throw new Error('deviceId is required');
      return deps.setAudioDefault({ flow, deviceId });
    }],
    [/^GET \/api\/meetings$/, async () => ({ meetings: await deps.getMeetings() })],
    [/^GET \/api\/meetings\/([\w-]+)$/, async (_url, _body, match) => ({ meeting: await deps.getMeeting(match![1]) })],
    [/^POST \/api\/audio\/loopback\/start$/, async (_url, body) => ({ recording: await deps.startLoopback(body.seconds !== undefined ? Number(body.seconds) : undefined) })],
    [/^POST \/api\/audio\/loopback\/stop$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      return { recording: await deps.stopLoopback(id) };
    }],
    [/^GET \/api\/audio\/recordings$/, async () => ({ recordings: await deps.listRecordings() })],
  ];
}

export default browserRoutes;
