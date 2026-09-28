/**
 * Umbra OS — actions sub-router (extracted from ApiServer route map).
 * Owns user-facing side-effect actions: consent, knowledge/memory, meetings,
 * meeting-bot, social automation, smart home, vault, voice and media gen.
 * Re-exported via ApiServer — routes remain identical.
 */
import type { ApiServerDeps } from '../ApiServer';

type Handler = (url: URL, body: Record<string, unknown>, match?: RegExpMatchArray) => Promise<unknown>;
export type ActionRouteEntry = [RegExp, Handler];

export function actionRoutes(deps: ApiServerDeps): ActionRouteEntry[] {
  return [
    [/^GET \/api\/consent$/, async () => ({
      ...deps.getConsentState(),
      emergencyStopArmed: deps.isEmergencyStopArmed(),
    })],
    [/^POST \/api\/consent$/, async (_url, body) => {
      const action = String(body.action || '');
      if (action === 'request') {
        const reason = String(body.reason || 'Request from UI');
        return { result: await deps.requestConsent(reason) };
      }
      if (action === 'arm') {
        deps.armEmergencyStop();
        return { result: 'armed' };
      }
      if (action === 'disarm') {
        if (body.confirm !== true) throw new Error('Emergency stop disarm requires explicit confirmation (body.confirm === true)');
        deps.disarmEmergencyStop();
        return { result: 'disarmed' };
      }
      throw new Error(`Unknown consent action: ${action}`);
    }],
    [/^GET \/api\/knowledge\/search$/, async url => ({ results: await deps.searchKnowledge(url.searchParams.get('q') || '') })],
    [/^GET \/api\/memory\/recall$/, async url => deps.recallMemory(url.searchParams.get('q') || '')],
    [/^POST \/api\/memory\/remember$/, async (_url, body) => {
      const text = String(body.text || '').trim();
      if (!text) throw new Error('text is required');
      return deps.rememberMemory(text);
    }],
    [/^GET \/api\/macros$/, async () => ({ macros: await deps.getMacros() })],
    [/^GET \/api\/sessions$/, async () => ({ sessions: await deps.getSessions() })],
    [/^GET \/api\/privacy\/stats$/, async () => deps.getPrivacyStats()],
    [/^GET \/api\/activity\/summary$/, async () => deps.getActivitySummary()],
    [/^GET \/api\/swarm$/, async () => ({ swarm: await deps.getSwarmStatus() })],
    [/^GET \/api\/vault\/stats$/, async () => ({ vault: await deps.getAuditStats() })],
    [/^POST \/api\/meeting\/join$/, async (_url, body) => {
      const url = String(body.url || '').trim();
      if (!url) throw new Error('url is required');
      const opts = {
        title: body.title !== undefined ? String(body.title) : undefined,
        topics: Array.isArray(body.topics) ? body.topics.map(String) : undefined,
      };
      return { meeting: await deps.meetingJoin(url, opts) };
    }],
    [/^POST \/api\/meeting\/listen$/, async () => deps.meetingStartListening()],
    [/^GET \/api\/meeting\/status$/, async () => deps.meetingStatus()],
    [/^POST \/api\/meeting\/leave$/, async () => ({ meeting: await deps.meetingLeave() })],
    [/^POST \/api\/meeting\/execute$/, async (_url, body) => {
      const action = String(body.action || '');
      if (!action) throw new Error('action is required');
      const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};
      return deps.meetingExecute(action, params);
    }],
    [/^POST \/api\/meeting\/audio$/, async (_url, body) => {
      const audio = String(body.audio || '');
      if (!audio) throw new Error('audio (base64) is required');
      return {
        segment: await deps.meetingFeedAudio(audio, body.format !== undefined ? String(body.format) : undefined),
      };
    }],
    [/^POST \/api\/meeting\/share$/, async (_url, body) => ({
      result: await deps.meetingShare(body.target !== undefined ? String(body.target) : undefined),
    })],
    [/^POST \/api\/meeting\/stop-share$/, async () => ({ result: await deps.meetingStopShare() })],
    [/^GET \/api\/meeting\/orders$/, async () => deps.meetingOrders()],
    [/^POST \/api\/meeting\/speak$/, async (_url, body) => {
      const text = String(body.text || '').trim();
      if (!text) throw new Error('text is required');
      return { result: await deps.meetingSpeak(text, {
        voice: body.voice !== undefined ? String(body.voice) : undefined,
        language: body.language !== undefined ? String(body.language) : undefined,
      }) };
    }],
    [/^POST \/api\/meeting\/mute$/, async (_url, body) => ({
      result: await deps.meetingMute(body.muted !== false),
    })],
    [/^POST \/api\/meeting\/raise-hand$/, async (_url, body) => ({
      result: await deps.meetingRaiseHand(body.raised !== false),
    })],
    [/^POST \/api\/meeting\/chat$/, async (_url, body) => {
      const message = String(body.message || '').trim();
      if (!message) throw new Error('message is required');
      return { result: await deps.meetingChat(message) };
    }],
    [/^POST \/api\/meeting-bot\/join$/, async (_url, body) => {
      const meetingUrl = String(body.meeting_url || '');
      if (!meetingUrl) throw new Error('meeting_url is required');
      const platform = String(body.platform || 'google_meet');
      const botName = body.bot_name !== undefined ? String(body.bot_name) : undefined;
      return { bot: await deps.meetingBotJoin(meetingUrl, platform, botName) };
    }],
    [/^POST \/api\/meeting-bot\/leave$/, async () => ({ bot: await deps.meetingBotLeave() })],
    [/^GET \/api\/meeting-bot\/status$/, async () => ({ bot: await deps.meetingBotStatus() })],
    [/^GET \/api\/meeting-bot\/transcript$/, async () => ({ bot: await deps.meetingBotTranscript() })],
    [/^POST \/api\/meeting-bot\/command$/, async (_url, body) => {
      const command = String(body.command || '');
      if (!command) throw new Error('command is required');
      const args = body.args !== undefined && typeof body.args === 'object' ? body.args as Record<string, unknown> : undefined;
      return { bot: await deps.meetingBotCommand(command, args) };
    }],
    [/^POST \/api\/social\/post$/, async (_url, body) => {
      const platform = String(body.platform || '');
      if (!platform) throw new Error('platform is required (x, youtube, instagram)');
      const action = String(body.action || 'post');
      const email = String(body.email || '');
      const password = String(body.password || '');
      if (!email || !password) throw new Error('email and password are required');
      return { result: await deps.socialPost({
        platform, action, email, password,
        text: body.text !== undefined ? String(body.text) : undefined,
        comment_text: body.comment_text !== undefined ? String(body.comment_text) : undefined,
        query: body.query !== undefined ? String(body.query) : undefined,
        media_files: Array.isArray(body.media_files) ? body.media_files.map(String) : undefined,
        video_path: body.video_path !== undefined ? String(body.video_path) : undefined,
        title: body.title !== undefined ? String(body.title) : undefined,
        description: body.description !== undefined ? String(body.description) : undefined,
        max_comments: body.max_comments !== undefined ? Number(body.max_comments) : undefined,
        max_results: body.max_results !== undefined ? Number(body.max_results) : undefined,
        headless: body.headless !== undefined ? Boolean(body.headless) : undefined,
      }) };
    }],
    [/^POST \/api\/social\/schedule$/, async (_url, body) => {
      const platform = String(body.platform || '');
      if (!platform) throw new Error('platform is required (x, youtube)');
      const action = String(body.action || 'post');
      const email = String(body.email || '');
      const password = String(body.password || '');
      const scheduledAt = Number(body.scheduledAt || 0);
      if (!scheduledAt) throw new Error('scheduledAt is required (unix ms timestamp)');
      return { scheduled: await deps.socialSchedule({
        platform, action, email, password,
        text: body.text !== undefined ? String(body.text) : undefined,
        video_path: body.video_path !== undefined ? String(body.video_path) : undefined,
        title: body.title !== undefined ? String(body.title) : undefined,
        description: body.description !== undefined ? String(body.description) : undefined,
        scheduledAt,
      }) };
    }],
    [/^GET \/api\/social\/schedule$/, async () => ({ scheduled: await deps.socialScheduled() })],
    [/^POST \/api\/social\/cancel$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      return { cancelled: await deps.socialCancelSchedule(id) };
    }],
    [/^GET \/api\/social\/status$/, async () => ({ social: await deps.socialStatus() })],
    [/^GET \/api\/smart\/status$/, async () => deps.smartStatus()],
    [/^POST \/api\/smart\/token$/, async (_url, body) => {
      const token = String(body.token || '').trim();
      if (!token) throw new Error('token is required — paste your PAT from account.smartthings.com/tokens');
      return deps.smartSetToken(token);
    }],
    [/^DELETE \/api\/smart\/token$/, async () => deps.smartClearToken()],
    [/^GET \/api\/smart\/devices$/, async () => ({ devices: await deps.smartDevices() })],
    [/^POST \/api\/smart\/command$/, async (_url, body) => {
      const deviceId = String(body.deviceId || '');
      const command = body.command === 'on' ? 'on' : body.command === 'off' ? 'off' : '';
      if (!deviceId || !command) throw new Error('deviceId and command (on|off) are required');
      return { result: await deps.smartCommand(deviceId, command) };
    }],
    [/^POST \/api\/smart\/control$/, async (_url, body) => {
      const name = String(body.name || '');
      const command = body.command === 'on' ? 'on' : body.command === 'off' ? 'off' : '';
      if (!name || !command) throw new Error('name and command (on|off) are required');
      return { result: await deps.smartControlByName(name, command) };
    }],
    [/^GET \/api\/smart\/schedules$/, async () => ({ schedules: await deps.smartSchedules() })],
    [/^POST \/api\/smart\/schedules$/, async (_url, body) => {
      const deviceId = String(body.deviceId || '');
      const deviceName = String(body.deviceName || deviceId);
      const command = body.command === 'on' ? 'on' : body.command === 'off' ? 'off' : '';
      const kind = body.kind === 'at' ? 'at' : body.kind === 'everyMinutes' ? 'everyMinutes' : '';
      if (!deviceId || !command || !kind) throw new Error('deviceId, command (on|off) and kind (everyMinutes|at) are required');
      if (kind === 'everyMinutes' && !Number(body.everyMinutes)) throw new Error('everyMinutes is required for interval schedules');
      if (kind === 'at' && !/^\d{2}:\d{2}$/.test(String(body.at || ''))) throw new Error('at must be "HH:MM" for daily schedules');
      return { schedule: await deps.smartScheduleAdd({
        deviceId, deviceName, command,
        kind,
        everyMinutes: kind === 'everyMinutes' ? Number(body.everyMinutes) : undefined,
        at: kind === 'at' ? String(body.at) : undefined,
      }) };
    }],
    [/^POST \/api\/smart\/schedules\/cancel$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      return { cancelled: await deps.smartScheduleCancel(id) };
    }],
    [/^GET \/api\/vault\/entries$/, async () => ({ entries: await deps.getVaultEntries() })],
    [/^POST \/api\/vault\/entry$/, async (_url, body) => {
      const service = String(body.service || '').trim();
      const username = body.username !== undefined ? String(body.username) : '';
      const secret = String(body.secret || '');
      const id = body.id !== undefined ? String(body.id) : undefined;
      return { entry: await deps.setVaultEntry({ service, username, secret, id }) };
    }],
    [/^DELETE \/api\/vault\/entry\/([\w-]+)$/, async (_url, _body, match) => ({ deleted: await deps.deleteVaultEntry(match![1]) })],
    [/^GET \/api\/voice\/status$/, async () => deps.getVoiceStatus()],
    [/^GET \/api\/voice\/health$/, async url => deps.getVoiceStackHealth(url.searchParams.get('refresh') === '1')],
    [/^GET \/api\/voice\/tts\/voices$/, async () => deps.listTtsVoices()],
    [/^POST \/api\/voice\/speak$/, async (_url, body) => {
      const text = String(body.text || '').trim();
      if (!text) throw new Error('text is required');
      return deps.speakText(text, {
        voice: body.voice !== undefined ? String(body.voice) : undefined,
        language: body.language !== undefined ? String(body.language) : undefined,
        provider: body.provider !== undefined ? String(body.provider) : undefined,
        engine: body.engine !== undefined ? String(body.engine) : undefined,
      });
    }],
    [/^POST \/api\/voice\/transcribe$/, async (_url, body) => {
      const audio = String(body.audio || '');
      if (!audio) throw new Error('audio (base64) is required');
      return {
        transcription: await deps.transcribeAudio(audio, {
          format: body.format !== undefined ? String(body.format) : undefined,
          language: body.language !== undefined ? String(body.language) : undefined,
        }),
      };
    }],
    [/^POST \/api\/voice\/command$/, async (_url, body) => {
      const audio = String(body.audio || '');
      if (!audio) throw new Error('audio (base64) is required');
      return {
        command: await deps.voiceCommand(audio, {
          format: body.format !== undefined ? String(body.format) : undefined,
          language: body.language !== undefined ? String(body.language) : undefined,
          target: body.target !== undefined ? String(body.target) : undefined,
        }),
      };
    }],
    [/^GET \/api\/openmontage\/tools$/, async () => ({ openmontage: await deps.listOpenMontageTools() })],
    [/^POST \/api\/image\/generate$/, async (_url, body) => {
      const prompt = String(body.prompt || '');
      if (!prompt) throw new Error('prompt is required');
      return {
        image: await deps.generateImage(prompt, {
          width: body.width !== undefined ? Number(body.width) : undefined,
          height: body.height !== undefined ? Number(body.height) : undefined,
          steps: body.steps !== undefined ? Number(body.steps) : undefined,
        }),
      };
    }],
  ];
}

export default actionRoutes;
