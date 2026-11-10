// @vitest-environment jsdom
/**
 * The colour field (SPEC 01 §ColourPicker).
 *
 * Three behaviours here are the ones a caller depends on and a rewrite would quietly break:
 *
 * - **The hex box keeps what was typed.** Its caller is a caption style editor, whose schema
 *   refuses a partial hex — so every keystroke on the way to `#FF7A00` is rejected, and a box that
 *   re-rendered from `value` would erase each character as it was typed.
 * - **The eyedropper is absent, not disabled, where the API is absent.** jsdom has no
 *   `EyeDropper`, which is exactly the case the rule is about.
 * - **Cancelling the eyedropper says nothing.** Esc is what the user asked for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ColourPicker, type EyeDropperConstructor } from '@clipwright/design-system';

afterEach(() => {
  cleanup();
  delete (globalThis as { EyeDropper?: unknown }).EyeDropper;
});

describe('the colour field', () => {
  it('reports every keystroke, so a caller can validate for itself', () => {
    /*
      The caption style editor passes a change through only when it is a complete colour; the
      brand kit editor accepts as it goes. One component, two validators — so the component must
      not decide what is valid.
    */
    const onChange = vi.fn();
    render(<ColourPicker value="#FF7A00" onChange={onChange} ariaLabel="Fill" />);
    fireEvent.change(screen.getByLabelText('Fill hex value'), { target: { value: '#1234' } });
    expect(onChange).toHaveBeenCalledWith('#1234');
  });

  it('keeps a rejected value in the box instead of reverting it', () => {
    /*
      The failure this prevents: a user types `#FF7` on the way to `#FF7A00`, the caller ignores
      it because it is not complete, `value` never changes, and the box snaps back to the old
      colour after the first character. The field becomes impossible to type in and looks broken.
    */
    render(<ColourPicker value="#FF7A00" onChange={() => undefined} ariaLabel="Fill" />);
    const box = screen.getByLabelText('Fill hex value') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '#FF7' } });
    expect(box.value).toBe('#FF7');
  });

  it('re-syncs the box when the value changes from outside', () => {
    // A swatch or an eyedropper pick must be visible in the text, or the picker is two controls
    // that disagree about the current colour.
    const { rerender } = render(<ColourPicker value="#FF7A00" onChange={() => undefined} ariaLabel="Fill" />);
    rerender(<ColourPicker value="#00FF00" onChange={() => undefined} ariaLabel="Fill" />);
    expect((screen.getByLabelText('Fill hex value') as HTMLInputElement).value).toBe('#00FF00');
  });

  it('draws no eyedropper where the API does not exist', () => {
    /*
      SPEC 13's rule about not showing unfinished tools as teasers. A *disabled* eyedropper is a
      promise that it works somewhere; on a surface with no `EyeDropper` it never will.
    */
    render(<ColourPicker value="#FF7A00" onChange={() => undefined} ariaLabel="Fill" />);
    expect(screen.queryByRole('button', { name: /pick fill from the screen/i })).toBeNull();
  });

  it('picks a colour from the screen where the API exists', async () => {
    /*
      The API must be called from a user gesture, so the button is the only entry point. The
      result goes through `onChange` *and* `onCommit`: the first is the value, the second is the
      recents list, and a caller that only listened to `onChange` would never record a pick.
    */
    const onChange = vi.fn();
    const onCommit = vi.fn();
    (globalThis as { EyeDropper?: EyeDropperConstructor }).EyeDropper = class {
      open = async () => ({ sRGBHex: '#4da3ff' });
    } as unknown as EyeDropperConstructor;
    render(<ColourPicker value="#FF7A00" onChange={onChange} onCommit={onCommit} ariaLabel="Fill" />);
    fireEvent.click(screen.getByRole('button', { name: /pick fill from the screen/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('#4DA3FF'));
    expect(onCommit).toHaveBeenCalledWith('#4DA3FF');
  });

  it('says nothing when the eyedropper is cancelled', async () => {
    // Esc is the user's decision. A message on every Esc is the difference between a feature that
    // feels solid and one that feels like it is failing.
    (globalThis as { EyeDropper?: EyeDropperConstructor }).EyeDropper = class {
      open = async () => {
        throw Object.assign(new Error('canceled'), { name: 'AbortError' });
      };
    } as unknown as EyeDropperConstructor;
    render(<ColourPicker value="#FF7A00" onChange={() => undefined} ariaLabel="Fill" />);
    fireEvent.click(screen.getByRole('button', { name: /pick fill from the screen/i }));
    /* Give the rejection a turn to settle, then assert nothing appeared. */
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains a genuine failure in place', async () => {
    // A blocked screen capture is not a cancellation, and the user cannot act on it without being
    // told what happened.
    (globalThis as { EyeDropper?: EyeDropperConstructor }).EyeDropper = class {
      open = async () => {
        throw new Error('Screen capture is blocked.');
      };
    } as unknown as EyeDropperConstructor;
    render(<ColourPicker value="#FF7A00" onChange={() => undefined} ariaLabel="Fill" />);
    fireEvent.click(screen.getByRole('button', { name: /pick fill from the screen/i }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Screen capture is blocked.'),
    );
  });

  it('shows the recent colours, newest first, and uses one on click', () => {
    // The strip's whole purpose: a colour picked a moment ago is one click away rather than a
    // retyped hex.
    const onChange = vi.fn();
    render(
      <ColourPicker
        value="#000000"
        onChange={onChange}
        ariaLabel="Fill"
        recents={['#FF7A00', '#4DA3FF']}
      />,
    );
    const strip = screen.getByLabelText('Recent colours');
    expect(strip.textContent).toBe('');
    expect(screen.getAllByRole('button', { name: /use recent colour/i })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Use recent colour #4DA3FF' }));
    expect(onChange).toHaveBeenCalledWith('#4DA3FF');
  });

  it('draws no strip when there are no recents yet', () => {
    // An empty labelled row would take up a line of the dialog to say nothing.
    render(<ColourPicker value="#000000" onChange={() => undefined} ariaLabel="Fill" />);
    expect(screen.queryByLabelText('Recent colours')).toBeNull();
  });
});
