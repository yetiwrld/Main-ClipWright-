// @vitest-environment jsdom
/**
 * The Moments screen's duration-range filter (SPEC 07 §7).
 *
 * §7 lists five things in the Filters popover: minimum score, **duration range**, favourites only,
 * status and confidence. Three were built. The duration range was not, which is the one that is
 * about the clip rather than about the scoring — a user with a 60-second slot who sees a 95-scored
 * 90-second moment has no way to put it aside short of scrolling past it.
 *
 * Both handles are clamped against each other: a range whose ends have swapped excludes everything,
 * and an empty list reads as "there are no moments" rather than as "you dragged one past the other".
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MomentsPage } from '../pages/MomentsPage.js';

const bridge = vi.hoisted(() => ({
  getProject: vi.fn(),
  getTranscript: vi.fn(),
  listMoments: vi.fn(),
  listMedia: vi.fn(),
  onMomentsProgress: vi.fn(() => () => undefined),
  updateProject: vi.fn(async () => ({})),
}));

vi.mock('../api.js', () => ({
  isDesktop: () => true,
  api: {
    getProject: bridge.getProject,
    getTranscript: bridge.getTranscript,
    listMoments: bridge.listMoments,
    listMedia: bridge.listMedia,
    onMomentsProgress: bridge.onMomentsProgress,
    updateProject: bridge.updateProject,
    analyzeMoments: vi.fn(),
    createClips: vi.fn(),
    rescoreMoment: vi.fn(),
    updateMoment: vi.fn(),
    addManualMoment: vi.fn(),
  },
  describeError: (err: unknown) => String(err),
}));

function moment(id: string, durationSec: number, title: string) {
  return {
    id,
    projectId: 'prj_1',
    title,
    reason: 'Because.',
    transcriptPreview: title,
    hookSentence: title,
    startUs: 0,
    endUs: durationSec * 1_000_000,
    durationUs: durationSec * 1_000_000,
    score: 80,
    confidence: 'high',
    status: 'candidate',
    basis: 'heuristic',
    dimensions: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  bridge.getProject.mockResolvedValue({
    id: 'prj_1',
    name: 'Interview',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archived: false,
    stage: 'moments',
    sourceMediaIds: ['med_1'],
    schemaVersion: 2,
    appVersionLastSaved: '1.0.0',
    settings: { aspect: '9:16', contentType: 'auto', clipLengthRangeSec: [3, 600] },
  });
  bridge.getTranscript.mockResolvedValue(null);
  bridge.listMedia.mockResolvedValue([{ id: 'med_1' }]);
  bridge.listMoments.mockResolvedValue([
    moment('m1', 12, 'Quick exchange'),
    moment('m2', 45, 'The good answer'),
    moment('m3', 180, 'The long story'),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Whether a moment is on screen.
 *
 * The card renders its title more than once — a heading and a preview — so `getByText` finds two
 * elements and fails. The per-card checkbox is labelled `Select <title>`, which is unique and is
 * what a screen reader would use to pick the card, so it is also the honest handle.
 */
function visibleTitle(title: string): boolean {
  return screen.queryByRole('checkbox', { name: `Select ${title}` }) !== null;
}

async function openFilters() {
  render(<MomentsPage projectId="prj_1" onNavigate={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Filters' }));
}

describe('the duration range filters by clip length', () => {
  it('shows every moment before the filter is touched', async () => {
    /* The defaults span the schema's whole range, so an untouched filter excludes nothing. */
    await openFilters();
    await waitFor(() => expect(visibleTitle('Quick exchange')).toBe(true));
    expect(visibleTitle('The good answer')).toBe(true);
    expect(visibleTitle('The long story')).toBe(true);
  });

  it('excludes moments longer than the longest handle', async () => {
    await openFilters();
    const longest = await screen.findByLabelText('Longest duration in seconds');
    fireEvent.change(longest, { target: { value: '60' } });

    await waitFor(() => expect(visibleTitle('The long story')).toBe(false));
    /* The two inside the range stay. */
    expect(visibleTitle('Quick exchange')).toBe(true);
    expect(visibleTitle('The good answer')).toBe(true);
  });

  it('excludes moments shorter than the shortest handle', async () => {
    await openFilters();
    const shortest = await screen.findByLabelText('Shortest duration in seconds');
    fireEvent.change(shortest, { target: { value: '30' } });

    await waitFor(() => expect(visibleTitle('Quick exchange')).toBe(false));
    expect(visibleTitle('The good answer')).toBe(true);
    expect(visibleTitle('The long story')).toBe(true);
  });

  it('pushes the other handle rather than inverting the range', async () => {
    /*
      Dragging "Shortest" past "Longest" must not produce a range that excludes everything. The
      second handle moves with the first, so the list stays meaningful and the controls agree with
      it — an empty list here would read as a bug in the moments, not in the filter.

      The readouts are the assertion, not the moment list. A test that only checked the list went
      empty **passed against the broken version**: an inverted range hides everything too, so
      "nothing is visible" cannot tell clamping from crossing. The numbers on screen can.
    */
    await openFilters();
    const longest = await screen.findByLabelText('Longest duration in seconds');
    fireEvent.change(longest, { target: { value: '20' } });
    await waitFor(() => expect(screen.getByText(/^Longest: 20s$/)).toBeTruthy());

    const shortest = screen.getByLabelText('Shortest duration in seconds');
    fireEvent.change(shortest, { target: { value: '100' } });

    /* Both readouts moved to 100: the range collapsed to a point instead of inverting. */
    await waitFor(() => expect(screen.getByText(/^Shortest: 100s$/)).toBeTruthy());
    expect(screen.getByText(/^Longest: 100s$/)).toBeTruthy();
  });

  it('lets the longest handle push the shortest down', async () => {
    /* The same clamp in the other direction — a fix that only guarded one handle would pass the
       test above and invert the range from the other end. */
    await openFilters();
    const shortest = await screen.findByLabelText('Shortest duration in seconds');
    fireEvent.change(shortest, { target: { value: '200' } });
    await waitFor(() => expect(screen.getByText(/^Shortest: 200s$/)).toBeTruthy());

    const longest = screen.getByLabelText('Longest duration in seconds');
    fireEvent.change(longest, { target: { value: '30' } });

    await waitFor(() => expect(screen.getByText(/^Longest: 30s$/)).toBeTruthy());
    expect(screen.getByText(/^Shortest: 30s$/)).toBeTruthy();
  });
});
