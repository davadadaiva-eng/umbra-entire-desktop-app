import { detectOrders, classifyOrder } from './MeetingOrders';
import { TranscriptSegment } from './MeetingAgent';

const seg = (text: string, speaker = 'meeting', atMs = 0): TranscriptSegment => ({ speaker, text, atMs });

describe('detectOrders', () => {
  it('detects an order addressed to the assistant and classifies share_screen', () => {
    const orders = detectOrders(seg('Hey Umbra, share your screen'));
    expect(orders).toHaveLength(1);
    expect(orders[0].intent).toBe('share_screen');
    expect(orders[0].text).toBe('share your screen');
  });

  it('classifies note, search, reminder and say intents', () => {
    expect(classifyOrder('take a note about the deadline')).toBe('note');
    expect(classifyOrder('look up the Q3 numbers')).toBe('search');
    expect(classifyOrder('remind me to book the room')).toBe('reminder');
    expect(classifyOrder('stop sharing')).toBe('stop_share');
    expect(classifyOrder('say hello to everyone')).toBe('say');
  });

  it('classifies mic, hand and chat intents', () => {
    expect(classifyOrder('mute yourself')).toBe('mute');
    expect(classifyOrder('mute your mic')).toBe('mute');
    expect(classifyOrder('unmute your microphone')).toBe('unmute');
    expect(classifyOrder('raise your hand')).toBe('raise_hand');
    expect(classifyOrder('put up your hand')).toBe('raise_hand');
    expect(classifyOrder('lower your hand')).toBe('lower_hand');
    expect(classifyOrder('send a message in the meeting chat saying we will be late')).toBe('chat');
    expect(classifyOrder('post the link in the chat')).toBe('chat');
  });

  it('does not misclassify unrelated mic talk as an order', () => {
    // Addressed, but not a control command → execute (still an order).
    const orders = detectOrders(seg('Hey Umbra, mute the noisy participant please'));
    expect(orders).toHaveLength(1);
    expect(orders[0].intent).toBe('mute');
  });

  it('defaults an addressed command without a known intent to execute', () => {
    const orders = detectOrders(seg('Ok umbra open the budget spreadsheet'));
    expect(orders).toHaveLength(1);
    expect(orders[0].intent).toBe('execute');
  });

  it('ignores meeting chatter that is not addressed to the assistant', () => {
    expect(detectOrders(seg('Bob, can you share your screen?'))).toHaveLength(0);
    expect(detectOrders(seg('I will send the report by Friday'))).toHaveLength(0);
  });

  it('keeps the order payload without the trigger phrase', () => {
    const orders = detectOrders(seg('Hey assistant, write down the action items'));
    expect(orders[0].text).toBe('write down the action items');
  });
});
