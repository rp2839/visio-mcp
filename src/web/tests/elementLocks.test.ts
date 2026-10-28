import { describe, expect, it } from 'vitest';
import type { Operation } from '../src/contracts/generated';
import { GestureController } from '../src/canvas/GestureController';
import { createTestEngine } from './support/engine';

const setup = () => {
  const t = createTestEngine();
  const [a, b, c] = t.ids.shapes as [string, string, string];
  const gui = (ops: Operation[], source: 'gui' | 'mcp' = 'mcp') => t.engine.execute(t.request(ops), source);
  return { t, a, b, c, agent: (ops: Operation[]) => gui(ops, 'mcp'), gui };
};
const move = (target: string): Operation => ({ op: 'move', target, delta: { xPt: 10, yPt: 0 } });
const retext = (target: string): Operation => ({ op: 'set', target, patch: { text: { value: 'changed' } } } as Operation);

describe('element locks', () => {
  it('a text edit protects only that element\'s words: the agent may still move the box and edit others', async () => {
    const { t, a, b, agent } = setup();
    t.engine.holdElements(1, 'text', [a]);
    const refused = await agent([retext(a)]);
    expect(!refused.ok && refused.error).toMatchObject({ code: 'busy_user_editing', retryable: true, outcome: 'none', details: { lockedIds: [a] } });
    expect((await agent([move(a)])).ok).toBe(true);
    expect((await agent([retext(b)])).ok).toBe(true);
  });

  it('a dragged shape\'s size and position are protected, but its words and other shapes are not', async () => {
    const { t, a, b, agent } = setup();
    t.engine.holdElements(1, 'resize', [a]);
    for (const op of [move(a), { op: 'resize', target: a, bounds: { width: 50 } } as Operation]) {
      const r = await agent([op]);
      expect(!r.ok && r.error.code).toBe('busy_user_editing');
    }
    expect((await agent([retext(a)])).ok).toBe(true);
    expect((await agent([move(b)])).ok).toBe(true);
  });

  it('a connector attached to a dragged shape is protected with it; one between other shapes is not', async () => {
    const { t, a, b, c, agent } = setup();
    expect((await agent([
      { op: 'createConnector', alias: 'ab', from: { elementId: a, glue: 'dynamic' }, to: { elementId: b, glue: 'dynamic' } },
      { op: 'createConnector', alias: 'bc', from: { elementId: b, glue: 'dynamic' }, to: { elementId: c, glue: 'dynamic' } },
    ] as Operation[])).ok).toBe(true);
    t.engine.holdElements(1, 'move', [a]);
    const rerouted = await agent([{ op: 'set', target: 'ab', patch: { route: 'curved' } } as Operation]);
    expect(!rerouted.ok && rerouted.error.code).toBe('busy_user_editing');
    expect((await agent([{ op: 'set', target: 'bc', patch: { route: 'curved' } } as Operation])).ok).toBe(true);
  });

  it('deleting a protected element is refused, and the person\'s own edits are never refused', async () => {
    const { t, a, gui, agent } = setup();
    t.engine.holdElements(1, 'move', [a]);
    const r = await agent([{ op: 'delete', target: a } as Operation]);
    expect(!r.ok && r.error.code).toBe('busy_user_editing');
    expect((await gui([move(a)], 'gui')).ok).toBe(true);
  });

  it('releasing the lock lets the edit through', async () => {
    const { t, a, agent } = setup();
    t.engine.holdElements(1, 'move', [a]);
    expect((await agent([move(a)])).ok).toBe(false);
    t.engine.releaseElements(1);
    expect((await agent([move(a)])).ok).toBe(true);
  });

  it('the person\'s drag still lands when an agent edited other shapes meanwhile, and is discarded when it edited the same one', async () => {
    const { t, a, b, agent } = setup();
    const controller = new GestureController(t.engine);
    const first = controller.begin('move', t.scope(), [a]);
    controller.preview(first, [move(a)]);
    expect((await agent([move(b)])).ok).toBe(true);
    expect((await controller.commit(first)).ok).toBe(true);

    // a change to the same element that got past the lock (here: before the gesture was registered) is a real conflict
    const second = controller.begin('move', t.scope(), [a]);
    controller.preview(second, [move(a)]);
    t.engine.releaseElements(second.id);
    expect((await agent([move(a)])).ok).toBe(true);
    const result = await controller.commit(second);
    expect(!result.ok && result.error.code).toBe('revision_conflict');
  });
});
