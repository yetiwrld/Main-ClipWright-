// @vitest-environment jsdom
/**
 * The icon picker (SPEC 11 §12).
 *
 * The set, the search and the geometry were built and tested before this panel existed; what
 * these tests cover is the part that only a panel can get wrong — what it *offers*, what it
 * refuses, and whether picking one does what the user expects.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICON_COUNT } from '@clipwright/compositor';
import { IconPicker } from '../IconPicker.js';

afterEach(cleanup);

const open = (props: Partial<Parameters<typeof IconPicker>[0]> = {}) => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<IconPicker open onClose={onClose} onPick={onPick} {...props} />);
  return { onPick, onClose };
};

describe('the icon picker', () => {
  it('offers the drawable set and says so', () => {
    open();
    // Telling the user *why* the count is not the whole Lucide set is the difference between
    // "this app has 1541 icons" and "this app is missing some icons".
    expect(screen.getByText(new RegExp(`${ICON_COUNT} of ${ICON_COUNT}`))).toBeTruthy();
    expect(screen.getByText(/Only icons that draw are listed/)).toBeTruthy();
  });

  it('never offers an icon this build refuses to draw', () => {
    /*
      `gift` is a real Lucide icon whose ribbon is an elliptical arc, refused by name. A tile
      for it would be clickable and would paint nothing — indistinguishable from a bug.
    */
    open();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'gift' } });
    expect(screen.queryByLabelText('gift')).toBeNull();
    expect(screen.getByText(/No icon matches/)).toBeTruthy();
  });

  it('filters as the user types and says when nothing matches', () => {
    open();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'arrow right' } });
    expect(screen.getByLabelText('arrow-right')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'zzzz' } });
    expect(screen.queryByLabelText('arrow-right')).toBeNull();
    // An empty grid reads as a failure to load; a sentence does not.
    expect(screen.getByText(/No icon matches “zzzz”/)).toBeTruthy();
  });

  it('picks a name and reports the stroke width', () => {
    const { onPick } = open();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'heart' } });
    fireEvent.click(screen.getByLabelText('heart'));
    // The default is Lucide's own 2, so a user who never touches the field gets the icon the
    // set was drawn with.
    expect(onPick).toHaveBeenCalledWith('heart', 2);
  });

  it('picks with a typed stroke width, clamped to the spec range', () => {
    const { onPick } = open();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'heart' } });
    fireEvent.change(screen.getByLabelText('Stroke width'), { target: { value: '3.5' } });
    fireEvent.click(screen.getByLabelText('heart'));
    expect(onPick).toHaveBeenCalledWith('heart', 3.5);

    // Above the maximum: clamped, not refused. The spec says 0.5–4, so 99 is a fat icon.
    fireEvent.change(screen.getByLabelText('Stroke width'), { target: { value: '99' } });
    fireEvent.click(screen.getByLabelText('heart'));
    expect(onPick).toHaveBeenLastCalledWith('heart', 4);
  });

  it('keeps the last good width while the field is unreadable', () => {
    /*
      Typing "1." on the way to "1.5" passes through a string `Number.parseFloat` reads as 1,
      and an empty field reads as NaN. Refusing the pick then would make the grid look broken
      for a keystroke, so the field falls back rather than blanking.
    */
    const { onPick } = open({ strokeWidth: 3 });
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'heart' } });
    fireEvent.change(screen.getByLabelText('Stroke width'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('heart'));
    expect(onPick).toHaveBeenCalledWith('heart', 3);
  });

  it('pages rather than rendering 1541 tiles at once', () => {
    open();
    // 48 per page: the first tile of page one is present and a tile far down the alphabet is
    // not, which is the whole point of paginating the DOM.
    expect(screen.getByLabelText('a-arrow-down')).toBeTruthy();
    expect(screen.queryByLabelText('zap')).toBeNull();
    expect(screen.getByText(/Page 1 of/)).toBeTruthy();
  });

  it('starts a new search at page one', () => {
    /*
      Without the reset, a query that matches more than one page opens on whatever page the
      previous search had reached and shows the middle of the results — or, when the results
      are fewer pages than that, an empty grid the user reads as "no results".

      The search has to match **more than one page** for this to test anything. An earlier
      version searched for `heart`, which has a single page, so `clampedPage` quietly pulled
      the page number back to 0 and the missing reset went unnoticed — the mutation survived.
      `arrow` matches far more than 48 icons.
    */
    open();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText(/Page 2 of/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'arrow' } });
    expect(screen.getByText(/Page 1 of/)).toBeTruthy();
    // And the first tile of the new search is on screen, not the 49th.
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'arrow-left' } });
    expect(screen.getByLabelText('arrow-left')).toBeTruthy();
  });

  it('closes without picking when cancelled', () => {
    const { onPick, onClose } = open();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('resets its search when reopened, so it does not open onto the last query', () => {
    const { rerender } = render(
      <IconPicker open onClose={vi.fn()} onPick={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'heart' } });
    rerender(<IconPicker open={false} onClose={vi.fn()} onPick={vi.fn()} />);
    rerender(<IconPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByText(/Page 1 of/)).toBeTruthy();
    expect(screen.getByLabelText('a-arrow-down')).toBeTruthy();
  });
});
