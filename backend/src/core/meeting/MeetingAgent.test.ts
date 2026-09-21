import { MeetingAgent } from './MeetingAgent';

describe('MeetingAgent', () => {
  it('creates a meeting plan with agenda items', () => {
    const agent = new MeetingAgent();
    const plan = agent.plan({
      title: 'Weekly sync',
      attendees: [{ name: 'Alice', email: 'a@x.io' }, { name: 'Bob', email: 'b@x.io' }],
      topics: ['Status', 'Risks'],
      durationMin: 30,
    });
    expect(plan.agenda).toHaveLength(2);
    expect(plan.agenda[0].status).toBe('active');
    expect(agent.get(plan.id)?.title).toBe('Weekly sync');
  });

  it('extracts action items and decisions from a transcript', async () => {
    const agent = new MeetingAgent();
    const plan = agent.plan({ title: 'Sync', attendees: [{ name: 'Alice', email: 'a@x.io' }], topics: ['Ops'] });
    const outcome = await agent.closeMeeting(plan.id, [
      { speaker: 'Alice', text: 'I will send the report by Friday.', atMs: 0 },
      { speaker: 'Bob', text: 'We agreed to move the launch to next quarter.', atMs: 1000 },
      { speaker: 'Alice', text: 'Remind me to book the room.', atMs: 2000 },
    ]);
    expect(outcome.actionItems.length).toBeGreaterThanOrEqual(1);
    expect(outcome.actionItems[0].owner).toBe('a@x.io');
    expect(outcome.decisions.length).toBeGreaterThanOrEqual(1);
    expect(outcome.summary.length).toBeGreaterThan(0);
  });

  it('uses the LLM summarizer when provided', async () => {
    const agent = new MeetingAgent({ summarize: async () => 'LLM summary' });
    const plan = agent.plan({ title: 'T' });
    const outcome = await agent.closeMeeting(plan.id, [{ speaker: 'A', text: 'hello world meeting', atMs: 0 }]);
    expect(outcome.summary).toBe('LLM summary');
  });
});
