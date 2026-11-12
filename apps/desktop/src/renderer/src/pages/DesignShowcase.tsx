/**
 * Dev-only design-system showcase at /__design (import.meta.env.DEV only —
 * not reachable in production builds). Renders the supplied logo palette,
 * type scale, and every component in the design system.
 */
import React, { useState } from 'react';
import {
  Button, IconButton, Card, Chip, ScoreRing, ProgressBar, Skeleton, EmptyState, PanelHeader, Kbd,
  Field, Input, TextArea, Select, Toggle, Checkbox, Radio, Segmented,
  Stepper, Tabs, Dialog, Menu, ToastStack, StatusPill, tokens,
} from '@clipwright/design-system';
import { Check, Film, Sparkles, Upload } from 'lucide-react';

const SWATCHES: Array<{ name: string; value: string }> = [
  { name: 'brand', value: tokens.color.brand },
  { name: 'brand-strong', value: tokens.color.brandStrong },
  { name: 'brand-amber', value: tokens.color.brandAmber },
  { name: 'surface-app', value: tokens.color.surfaceApp },
  { name: 'surface-panel', value: tokens.color.surfacePanel },
  { name: 'surface-card', value: tokens.color.surfaceCard },
  { name: 'surface-hover', value: tokens.color.surfaceHover },
  { name: 'surface-pressed', value: tokens.color.surfacePressed },
  { name: 'text-primary', value: tokens.color.textPrimary },
  { name: 'text-secondary', value: tokens.color.textSecondary },
  { name: 'success', value: tokens.color.success },
  { name: 'warning', value: tokens.color.warning },
  { name: 'error', value: tokens.color.error },
  { name: 'info', value: tokens.color.info },
];

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section style={{ marginBottom: 32 }}>
    <h2 style={{ fontSize: 'var(--fs-lg)', margin: '0 0 12px', borderBottom: '1px solid var(--line-faint)', paddingBottom: 8 }}>{title}</h2>
    {children}
  </section>
);

export const DesignShowcase = () => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toggle, setToggle] = useState(true);
  const [segment, setSegment] = useState<'draft' | 'high'>('high');
  const [tab, setTab] = useState('all');
  const [toasts, setToasts] = useState([{ id: 't1', message: 'Export queued', tone: 'default' as const }]);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24, maxWidth: 1100 }}>
      <h1 className="page-title">Design showcase <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>/__design (dev only)</span></h1>
      <p className="page-sub">Colour tokens were sampled from the supplied ClipWright_Icon.png (swirl orange, near-black canvas, silver swirl) — see docs/decisions.md §design-tokens.</p>

      <Section title="Colour tokens">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {SWATCHES.map(({ name, value }) => (
            <div key={name} style={{ width: 120 }}>
              <div style={{ height: 56, background: value, borderRadius: 'var(--radius-control)', border: '1px solid var(--line-default)' }} />
              <div style={{ fontSize: 'var(--fs-xs)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>{name}</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{value}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        <div style={{ display: 'grid', gap: 6 }}>
          {['--fs-2xl', '--fs-xl', '--fs-lg', '--fs-md', '--fs-sm', '--fs-xs'].map((fs) => (
            <div key={fs} style={{ fontSize: `var(${fs})` }}>{fs} — Clipwright Studio 123 ABCdef</div>
          ))}
          <div style={{ fontFamily: 'var(--font-mono)' }}>--font-mono · 00:01:23.45 · 1920×1080</div>
        </div>
      </Section>

      <Section title="Buttons">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" size="44">44px</Button>
          <Button variant="primary" size="28">28px</Button>
          <Button loading>Working</Button>
          <Button disabled>Disabled</Button>
          <IconButton aria-label="Import"><Upload size={18} /></IconButton>
          <IconButton aria-label="Toggle auto" active><Sparkles size={18} /></IconButton>
        </div>
      </Section>

      <Section title="Chips & status">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip>Default</Chip><Chip tone="brand">Brand</Chip><Chip tone="success">Success</Chip>
          <Chip tone="info">Info</Chip><Chip tone="warning">Warning</Chip><Chip tone="error">Error</Chip>
          <StatusPill>Default</StatusPill><StatusPill tone="success">Ready</StatusPill><StatusPill tone="info">Analysing</StatusPill>
          <StatusPill tone="warning">Check ffmpeg</StatusPill><StatusPill tone="error">Failed</StatusPill>
        </div>
      </Section>

      <Section title="Cards & panel">
        <Card style={{ maxWidth: 420 }}>
          <PanelHeader title="Clip 04 — Hook" right={<StatusPill tone="success">rendered</StatusPill>} />
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', margin: '8px 0 0' }}>Card surface uses tokens only — no raw colours.</p>
        </Card>
      </Section>

      <Section title="Score rings">
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <ScoreRing score={42} label="weak" /><ScoreRing score={68} label="ok" />
          <ScoreRing score={81} label="strong" /><ScoreRing score={94} label="hook" />
        </div>
      </Section>

      <Section title="Progress & skeleton">
        <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
          <ProgressBar fraction={0.35} /><ProgressBar fraction={0.8} />
          <Skeleton style={{ height: 18 }} /><Skeleton style={{ height: 18, width: '70%' }} />
        </div>
      </Section>

      <Section title="Forms">
        <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
          <Field label="Project name" htmlFor="ds-name" hint="Shown on the projects page">
            <Input id="ds-name" defaultValue="Podcast EP 12 — best bits" />
          </Field>
          <Field label="Aspect ratio">
            <Select defaultValue="1080x1920"><option>1080x1920</option><option>1920x1080</option></Select>
          </Field>
          <Field label="Notes" error="Leave a note for the reviewer">
            <TextArea placeholder="…" />
          </Field>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Toggle checked={toggle} onChange={setToggle} aria-label="Toggle example" />
            <Checkbox label="Captions burned in" defaultChecked />
            <Radio name="ds-radio" label="720p" /><Radio name="ds-radio" label="1080p" defaultChecked />
          </div>
          <Segmented
            options={[{ value: 'draft', label: 'Draft' }, { value: 'high', label: 'High' }]}
            value={segment}
            onChange={(v) => setSegment(v)}
            aria-label="Quality"
          />
        </div>
      </Section>

      <Section title="Stepper">
        <Stepper steps={[{ id: 'a', label: 'Import' }, { id: 'b', label: 'Transcribe' }, { id: 'c', label: 'Moments' }, { id: 'd', label: 'Editor' }, { id: 'e', label: 'Export' }]} activeIndex={2} furthestCompleted={2} running />
      </Section>

      <Section title="Tabs">
        <Tabs tabs={[{ id: 'all', label: 'All' }, { id: 'keep', label: 'Keep' }, { id: 'reject', label: 'Reject' }]} value={tab} onChange={setTab} />
      </Section>

      <Section title="Overlay">
        <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <div style={{ position: 'relative' }}>
            <Button onClick={() => setMenuOpen((v) => !v)}>Open menu</Button>
            {menuOpen && (
              <Menu
                onClose={() => setMenuOpen(false)}
                items={[
                  { id: 'rename', label: 'Rename', shortcut: 'R' },
                  { id: 'dup', label: 'Duplicate', shortcut: 'Ctrl+D' },
                  { id: 'del', label: 'Delete', danger: true, shortcut: 'Del' },
                ]}
              />
            )}
          </div>
        </div>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="Export this clip?"
          actions={(
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>Export</Button>
            </>
          )}
        >
          <p>Renders with ffmpeg and validates the output before moving it into place.</p>
        </Dialog>
      </Section>

      <Section title="Empty state & misc">
        <EmptyState
          icon={<Film size={28} />}
          title="No clips yet"
          action={<Button variant="primary"><Upload size={16} /> Import a video</Button>}
        >
          Import a long recording and Clipwright will find the moments worth posting.
        </EmptyState>
        <div style={{ marginTop: 16 }}><Kbd>Ctrl</Kbd> + <Kbd>E</Kbd> — export</div>
      </Section>

      <Section title="Toasts">
        <Button size="28" onClick={() => setToasts((t) => [...t, { id: String(Date.now()), message: 'Saved', tone: 'default' as const }])}>Trigger toast</Button>
        <ToastStack toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      </Section>

      <Section title="Brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Check size={16} color="var(--success)" />
          <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>Clipwright_Icon.png reused verbatim — never redrawn. See docs/decisions.md.</span>
        </div>
      </Section>
    </div>
  );
};
