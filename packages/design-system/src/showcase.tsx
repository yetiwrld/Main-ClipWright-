import React, { useState } from 'react';
import {
  Play,
  Scissors,
  Trash2,
  FolderOpen,
  Sparkles,
  Copy,
  Settings,
  Download,
} from 'lucide-react';
import {
  Button,
  IconButton,
  Input,
  TextArea,
  Select,
  Slider,
  Toggle,
  Checkbox,
  Radio,
  SegmentedControl,
  Tabs,
  Tooltip,
  Menu,
  Dialog,
  useToast,
  ProgressLinear,
  ProgressRing,
  Skeleton,
  EmptyState,
  Card,
  Chip,
  ScoreRing,
  Stepper,
  PanelHeader,
  Splitter,
  ColourPicker,
  TimecodeField,
  Kbd,
} from './components.js';
import { TOKENS, verifyAllTokenContrasts } from './tokens.js';
import { useLayoutTier } from './hooks.js';

export const DesignShowcase: React.FC<{ onBackHome?: () => void }> = ({ onBackHome }) => {
  const tier = useLayoutTier();
  const { pushToast } = useToast();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [selectVal, setSelectVal] = useState('small');
  const [sliderVal, setSliderVal] = useState(64);
  const [toggleOn, setToggleOn] = useState(true);
  const [checked, setChecked] = useState(true);
  const [radioVal, setRadioVal] = useState<'a' | 'b'>('a');
  const [segmentVal, setSegmentVal] = useState<'9:16' | '16:9' | '1:1'>('9:16');
  const [activeTab, setActiveTab] = useState('components');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorVal, setColorVal] = useState('var(--brand)');
  const [timecode, setTimecode] = useState('00:01:14:08');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [splitWidth, setSplitWidth] = useState(260);

  const contrastResults = verifyAllTokenContrasts();

  const toggleTheme = (next: 'dark' | 'light') => {
    setTheme(next);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
  };

  return (
    <div
      data-testid="design-showcase"
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 'var(--space-8)',
        background: 'var(--surface-app)',
        color: 'var(--text-primary)',
      }}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 'var(--space-4)',
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 'var(--fs-xl)', fontWeight: 600 }}>
              Clipwright Studio — Design System Showcase
            </h1>
            <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>
              Layout tier: <strong>{tier}</strong> · All 25 components, semantic tokens & WCAG contrast verification
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <SegmentedControl
              ariaLabel="Theme switcher"
              value={theme}
              onChange={toggleTheme}
              options={[
                { value: 'dark', label: 'Dark theme' },
                { value: 'light', label: 'Light token swap' },
              ]}
            />
            {onBackHome && (
              <Button variant="secondary" onClick={onBackHome}>
                Back to Home
              </Button>
            )}
          </div>
        </div>

        <Tabs
          activeId={activeTab}
          onChange={setActiveTab}
          tabs={[
            { id: 'components', label: 'Components (All 25)' },
            { id: 'tokens', label: 'Palette & Contrast Audit', badge: contrastResults.length },
            { id: 'scales', label: 'Typography, Spacing & Radius' },
          ]}
        />

        {activeTab === 'components' && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                tier === 'compact' ? 'repeat(1, 1fr)' : 'repeat(2, minmax(0, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <Card>
              <PanelHeader title="Buttons & IconButtons" />
              <div
                style={{
                  paddingTop: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <Button variant="primary" icon={<Play size={16} />}>
                    Primary Action
                  </Button>
                  <Button variant="secondary" icon={<FolderOpen size={16} />}>
                    Secondary
                  </Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="danger" icon={<Trash2 size={16} />}>
                    Danger
                  </Button>
                  <Button variant="primary" loading>
                    Loading
                  </Button>
                  <Button variant="secondary" disabled>
                    Disabled
                  </Button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <Button size={28}>Dense 28</Button>
                  <Button size={32}>Default 32</Button>
                  <Button size={36}>Medium 36</Button>
                  <Button size={44} variant="primary">
                    Hero 44
                  </Button>
                  <IconButton label="Split clip" shortcut="S" icon={<Scissors size={16} />} active />
                  <IconButton label="Copy" shortcut="Ctrl+C" icon={<Copy size={16} />} />
                  <IconButton label="Settings" shortcut="Ctrl+," icon={<Settings size={16} />} disabled />
                </div>
              </div>
            </Card>

            <Card>
              <PanelHeader title="Inputs, Select, Slider & Timecode" />
              <div
                style={{
                  paddingTop: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                <Input placeholder="Paste a video link…" defaultValue="https://example.com/video.mp4" />
                <Input
                  placeholder="With validation error"
                  defaultValue="invalid-file.xyz"
                  error="Unsupported file format. Choose MP4, MOV, MKV, or WebM."
                />
                <TextArea placeholder="Clip focus (e.g. funny moments, key insights)" rows={2} />
                <Select
                  ariaLabel="Transcription model"
                  value={selectVal}
                  onChange={setSelectVal}
                  options={[
                    { value: 'tiny', label: 'Whisper tiny', hint: '75 MB' },
                    { value: 'base', label: 'Whisper base', hint: '140 MB' },
                    { value: 'small', label: 'Whisper small (Recommended)', hint: '470 MB' },
                    { value: 'medium', label: 'Whisper medium', hint: '1.5 GB' },
                  ]}
                />
                <Slider
                  ariaLabel="Clip volume"
                  value={sliderVal}
                  onChange={setSliderVal}
                  formatValue={(v) => `${v}%`}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <TimecodeField
                    valueText={timecode}
                    totalDurationText="00:05:00:00"
                    onCommit={(val) => {
                      if (!val.trim()) return false;
                      setTimecode(val);
                      return true;
                    }}
                  />
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <Kbd>Ctrl</Kbd>
                    <Kbd>K</Kbd>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <PanelHeader title="Toggles, Checkboxes, Segmented & Stepper" />
              <div
                style={{
                  paddingTop: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
                  <Toggle checked={toggleOn} onChange={setToggleOn} label="Magnetic main track" />
                  <Checkbox checked={checked} onChange={setChecked} label="Copy into library" />
                  <Radio
                    checked={radioVal === 'a'}
                    onChange={() => setRadioVal('a')}
                    label="Constant FPS"
                  />
                  <Radio
                    checked={radioVal === 'b'}
                    onChange={() => setRadioVal('b')}
                    label="Match project"
                  />
                </div>
                <SegmentedControl
                  ariaLabel="Aspect ratio"
                  value={segmentVal}
                  onChange={setSegmentVal}
                  options={[
                    { value: '9:16', label: '9:16 Vertical' },
                    { value: '16:9', label: '16:9 Landscape' },
                    { value: '1:1', label: '1:1 Square' },
                  ]}
                />
                <Stepper
                  steps={[
                    { id: 'import', label: 'Import', state: 'completed' },
                    { id: 'transcribe', label: 'Transcribe', state: 'completed' },
                    { id: 'moments', label: 'Moments', state: 'active' },
                    { id: 'editor', label: 'Editor', state: 'not_reached' },
                  ]}
                  onSelectStep={() => {}}
                />
              </div>
            </Card>

            <Card>
              <PanelHeader title="Progress, ScoreRing, Chips & ColourPicker" />
              <div
                style={{
                  paddingTop: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                <ProgressLinear value={72} ariaLabel="Download progress" />
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
                  <ProgressRing value={84} size={76} ariaLabel="Transcription progress" />
                  <ScoreRing score={94} />
                  <ScoreRing score={82} />
                  <ScoreRing score={64} />
                  <ScoreRing score={41} />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <Chip variant="neutral">Neutral</Chip>
                  <Chip variant="brand">Recommended</Chip>
                  <Chip variant="success">Verified</Chip>
                  <Chip variant="warning">Needs context</Chip>
                  <Chip variant="error">Missing media</Chip>
                  <Chip variant="info">Local model</Chip>
                </div>
                <ColourPicker value={colorVal} onChange={setColorVal} />
              </div>
            </Card>

            <Card>
              <PanelHeader
                title="Overlays, Skeleton, EmptyState & Splitter"
                collapsed={panelCollapsed}
                onToggleCollapse={() => setPanelCollapsed((c) => !c)}
              />
              {!panelCollapsed && (
                <div
                  style={{
                    paddingTop: 'var(--space-3)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 'var(--space-2)', position: 'relative' }}>
                    <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                      Open Dialog
                    </Button>
                    <Button variant="secondary" onClick={() => setMenuOpen((m) => !m)}>
                      Context Menu
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        pushToast({
                          message: 'Clip split at playhead',
                          tone: 'success',
                          actionLabel: 'Undo',
                        })
                      }
                    >
                      Trigger Toast
                    </Button>
                    {menuOpen && (
                      <Menu
                        onClose={() => setMenuOpen(false)}
                        items={[
                          { id: 'split', label: 'Split at playhead', shortcut: 'S', icon: <Scissors size={14} /> },
                          { id: 'dup', label: 'Duplicate', shortcut: 'Ctrl+D', icon: <Copy size={14} /> },
                          {
                            id: 'locked',
                            label: 'Ripple delete',
                            shortcut: 'Shift+Del',
                            disabled: true,
                            disabledReason: 'Track is locked',
                          },
                          {
                            id: 'del',
                            label: 'Delete clip',
                            shortcut: 'Del',
                            danger: true,
                            separatorBefore: true,
                          },
                        ]}
                      />
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Skeleton width={80} height={48} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      <Skeleton width="70%" height={16} />
                      <Skeleton width="45%" height={14} />
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      height: '44px',
                      background: 'var(--surface-panel)',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ width: `${splitWidth}px`, padding: '0 var(--space-3)', fontSize: 'var(--fs-xs)' }}>
                      Left ({splitWidth}px)
                    </div>
                    <Splitter
                      orientation="vertical"
                      ariaLabel="Demo splitter"
                      onDelta={(d) => setSplitWidth((w) => Math.max(120, Math.min(360, w + d)))}
                      onReset={() => setSplitWidth(260)}
                    />
                    <div style={{ flex: 1, padding: '0 var(--space-3)', fontSize: 'var(--fs-xs)' }}>
                      Right region (double-click gutter to reset)
                    </div>
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <EmptyState
                icon={<Download size={24} />}
                title="No clips created yet"
                explanation="Select one or more ranked moments to generate editable short clips."
                actionLabel="Find Moments"
                onAction={() => pushToast({ message: 'Starting moment detection…', tone: 'info' })}
              />
            </Card>
          </div>
        )}

        {activeTab === 'tokens' && (
          <Card>
            <PanelHeader title="WCAG 2.1 Contrast Verification (Spec 01 §3.4 & §12.3)" />
            <div style={{ paddingTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {contrastResults.map((row) => (
                <div
                  key={row.pair}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: 'var(--space-2) var(--space-3)',
                    background: 'var(--surface-panel)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--fs-sm)',
                  }}
                >
                  <span>{row.pair}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>
                      {row.ratio}:1 (min {row.minRequired}:1)
                    </span>
                    <Chip variant={row.passed ? 'success' : 'error'}>
                      {row.passed ? 'PASS' : 'FAIL'}
                    </Chip>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {activeTab === 'scales' && (
          <Card>
            <PanelHeader title="Typography, Spacing & Radius Scales" />
            <div style={{ paddingTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {Object.entries(TOKENS.fontSize).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: v.rem }}>
                    --fs-{k} ({v.px}px / {v.lineHeight}px) — Calm video production typography
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <Dialog
        open={dialogOpen}
        title="Confirm re-transcription"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setDialogOpen(false)}>
              Re-transcribe
            </Button>
          </>
        }
      >
        Re-transcribing will replace the transcript. Your transcript edits will be lost. Existing clips stay untouched.
      </Dialog>
    </div>
  );
};
