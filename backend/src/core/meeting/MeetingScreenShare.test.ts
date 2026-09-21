import {
  detectMeetingProvider,
  meetingShareScript,
  meetingStopShareScript,
  meetingMuteScript,
  meetingRaiseHandScript,
  meetingChatScript,
  MeetingProvider,
} from './MeetingScreenShare';

describe('detectMeetingProvider', () => {
  it('detects Google Meet from realistic URLs', () => {
    expect(detectMeetingProvider('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(detectMeetingProvider('https://meet.google.com/?hs=224&pli=1')).toBe('meet');
    expect(detectMeetingProvider('meet.google.com/xyz')).toBe('meet');
  });

  it('detects Zoom Web from realistic URLs', () => {
    expect(detectMeetingProvider('https://zoom.us/j/1234567890?pwd=abc')).toBe('zoom');
    expect(detectMeetingProvider('https://us02web.zoom.us/j/123')).toBe('zoom');
    expect(detectMeetingProvider('zoom.us/rec/share/xyz')).toBe('zoom');
  });

  it('detects Microsoft Teams from both domains', () => {
    expect(detectMeetingProvider('https://teams.microsoft.com/l/meetup-join/19%3Ameeting')).toBe('teams');
    expect(detectMeetingProvider('https://teams.live.com/meet/1234567890')).toBe('teams');
  });

  it('falls back to other for unknown or non-meeting URLs', () => {
    expect(detectMeetingProvider('https://example.com/meeting')).toBe('other');
    expect(detectMeetingProvider('')).toBe('other');
    // A lookalike domain must not false-positive on the substring match:
    expect(detectMeetingProvider('https://zoom-education.example.com/join')).toBe('other');
    expect(detectMeetingProvider('https://meetgoogle.example.com/call')).toBe('other');
  });

  it('is case-insensitive', () => {
    expect(detectMeetingProvider('HTTPS://MEET.GOOGLE.COM/ABC')).toBe('meet');
    expect(detectMeetingProvider('https://Zoom.US/j/1')).toBe('zoom');
  });
});

describe('meetingShareScript', () => {
  it('emits a graceful not-found status when the share button is missing', () => {
    for (const provider of ['meet', 'zoom', 'teams', 'other'] as MeetingProvider[]) {
      const script = meetingShareScript(provider);
      expect(script).toContain("return 'share");
      expect(script).toContain('not found');
      expect(script).toContain('__find');
    }
  });

  it('uses per-provider selectors', () => {
    expect(meetingShareScript('meet')).toMatch(/present now\|present\|share screen/i);
    expect(meetingShareScript('zoom')).toMatch(/share screen/i);
    expect(meetingShareScript('teams')).toMatch(/share content\|share screen/i);
    // The generic fallback matches the broadest set.
    expect(meetingShareScript('other')).toMatch(/present\|share screen\|share content/i);
  });

  it('targets a tab/window/screen for Meet', () => {
    const tab = meetingShareScript('meet', 'tab');
    const window = meetingShareScript('meet', 'window');
    const screen = meetingShareScript('meet', 'screen');
    // The source phrase is embedded inside `new RegExp(...)` with spaces
    // replaced by \s+ so it reads: a\s+chrome\s+tab, etc.
    expect(tab).toContain('a\\s+chrome\\s+tab');
    expect(window).toContain('a\\s+window');
    expect(screen).toContain('your\\s+entire\\s+screen');
  });

  it('returns "share clicked" when the button is found', () => {
    expect(meetingShareScript('zoom')).toContain("return 'share clicked'");
  });
});

describe('meetingStopShareScript', () => {
  it('matches stop-sharing labels per provider', () => {
    expect(meetingStopShareScript('meet')).toMatch(/stop presenting\|stop sharing\|stop screen share/i);
    expect(meetingStopShareScript('zoom')).toMatch(/stop share/i);
    expect(meetingStopShareScript('teams')).toMatch(/stop presenting\|stop sharing/i);
    expect(meetingStopShareScript('other')).toMatch(/stop presenting\|stop sharing\|stop share/i);
  });

  it('returns a not-found status string when nothing matches', () => {
    for (const provider of ['meet', 'zoom', 'teams', 'other'] as MeetingProvider[]) {
      expect(meetingStopShareScript(provider)).toContain("'stop-share button not found'");
    }
  });
});

describe('meetingMuteScript', () => {
  it('selects the muted-state regex when muting', () => {
    const script = meetingMuteScript('other', true);
    expect(script).toMatch(/mute\|turn off mic\|microphone off\|muted/i);
    expect(script).toContain("'mute clicked'");
    expect(script).toContain("'mute button not found'");
  });

  it('selects the unmuted-state regex when unmuting', () => {
    const script = meetingMuteScript('other', false);
    expect(script).toMatch(/unmute\|turn on mic\|microphone on\|unmuted\|mute yourself/i);
    expect(script).toContain("'unmute clicked'");
  });

  it('keeps the per-provider label in the status string', () => {
    for (const provider of ['meet', 'zoom', 'teams'] as MeetingProvider[]) {
      expect(meetingMuteScript(provider, true)).toContain("'mute clicked'");
      expect(meetingMuteScript(provider, false)).toContain("'unmute clicked'");
    }
  });
});

describe('meetingRaiseHandScript', () => {
  it('matches raise-hand labels when raising', () => {
    const script = meetingRaiseHandScript('other', true);
    // The script embeds a literal regex so `\s` appears as a backslash + s.
    expect(script).toMatch(/raise\\s\*hand\|raise\\s\+your\\s\+hand/i);
    expect(script).toContain("'raise hand clicked'");
  });

  it('matches lower-hand labels when lowering', () => {
    const script = meetingRaiseHandScript('other', false);
    expect(script).toMatch(/lower\\s\*hand\|lower\\s\+your\\s\+hand\|put\\s\+down/i);
    expect(script).toContain("'lower hand clicked'");
  });

  it('reports a not-found status gracefully', () => {
    expect(meetingRaiseHandScript('teams', true)).toContain("'raise hand button not found'");
  });
});

describe('meetingChatScript', () => {
  it('escapes the message so quotes cannot break out of the snippet', () => {
    const script = meetingChatScript('other', 'hi "boss" \\ nope');
    expect(script).toContain(JSON.stringify('hi "boss" \\ nope'));
    expect(script).not.toContain("' + alert(1)");
  });

  it('opens the chat panel with a provider-specific selector', () => {
    expect(meetingChatScript('meet', 'hi')).toMatch(/chat\|in meeting messages/i);
    expect(meetingChatScript('teams', 'hi')).toMatch(/show chat\|chat/i);
    expect(meetingChatScript('zoom', 'hi')).toContain('__find(/chat/i)');
  });

  it('falls back to Enter when no send button exists', () => {
    const script = meetingChatScript('other', 'hi');
    expect(script).toContain("'message entered (Enter pressed)'");
    expect(script).toContain("'message sent'");
    expect(script).toContain("'chat input not found'");
  });
});
