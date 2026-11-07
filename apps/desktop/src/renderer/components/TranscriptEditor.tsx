import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { TranscriptPayload } from '../global.js';
import { api, describeError } from '../api.js';

interface Props {
  transcript: TranscriptPayload;
  /** Called with the updated transcript whenever the user edits text. */
  onChange?: (next: TranscriptPayload) => void;
  onSeek?: (us: number) => void;
}

type ExportFormat = 'txt' | 'srt' | 'vtt' | 'json';

export function TranscriptEditor({ transcript, onChange, onSeek }: Props) {
  const [words, setWords] = useState(transcript.words);
  const [search, setSearch] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [exportState, setExportState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [exportMessage, setExportMessage] = useState('');
  const [playingWordId, setPlayingWordId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setWords(transcript.words);
  }, [transcript]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return words.reduce<number[]>((acc, w, i) => {
      if (w.text.toLowerCase().includes(q)) acc.push(i);
      return acc;
    }, []);
  }, [search, words]);

  useEffect(() => {
    setMatchIndex(0);
  }, [search]);

  const activeMatchWordId = matches.length > 0 ? words[matches[Math.min(matchIndex, matches.length - 1)]]?.id : undefined;

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    const text = editText.trim();
    if (text) {
      setWords((prev) => {
        const next = prev.map((w) => (w.id === editingId ? { ...w, text, edited: true } : w));
        onChange?.({ ...transcript, words: next });
        return next;
      });
    }
    setEditingId(null);
    setEditText('');
  }, [editingId, editText, onChange, transcript]);

  const jumpTo = useCallback((index: number) => {
    if (matches.length === 0) return;
    const clamped = (index + matches.length) % matches.length;
    setMatchIndex(clamped);
    const word = words[matches[clamped]];
    if (word) onSeek?.(word.startUs);
  }, [matches, words, onSeek]);

  const handleWordClick = useCallback((wordId: string, startUs: number) => {
    setPlayingWordId(wordId);
    onSeek?.(startUs);
  }, [onSeek]);

  const handleExport = useCallback(async (format: ExportFormat) => {
    setExportState('working');
    setExportMessage('');
    try {
      const result = await api.exportTranscript(
        { ...transcript, words },
        format,
        '16:9',
        `transcript.${format === 'txt' ? 'txt' : format}`
      );
      setExportState(result ? 'done' : 'idle');
      setExportMessage(result ? `Saved to ${result}` : 'Export cancelled.');
    } catch (err) {
      setExportState('error');
      setExportMessage(describeError(err));
    }
  }, [transcript, words]);

  const editedCount = words.filter((w) => w.edited).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--line-subtle)',
        display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') jumpTo(e.shiftKey ? matchIndex - 1 : matchIndex + 1);
            if (e.key === 'Escape') setSearch('');
          }}
          placeholder="Search transcript…"
          aria-label="Search transcript"
          style={{
            flex: '1 1 200px', padding: '6px 12px', border: '1px solid var(--line-default)',
            borderRadius: 'var(--radius-md)', background: 'var(--surface-raised)',
            color: 'var(--text-primary)', fontSize: 'var(--fs-sm)',
          }}
        />
        {search.trim() && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {matches.length === 0 ? 'No matches' : `${matchIndex + 1} of ${matches.length}`}
            </span>
            <button onClick={() => jumpTo(matchIndex - 1)} disabled={matches.length === 0} style={navBtnStyle()} aria-label="Previous match">↑</button>
            <button onClick={() => jumpTo(matchIndex + 1)} disabled={matches.length === 0} style={navBtnStyle()} aria-label="Next match">↓</button>
          </div>
        )}
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          {words.length.toLocaleString()} words{editedCount > 0 ? ` · ${editedCount} edited` : ''}
        </span>
        {(['txt', 'srt', 'vtt', 'json'] as ExportFormat[]).map((fmt) => (
          <button
            key={fmt}
            onClick={() => handleExport(fmt)}
            disabled={exportState === 'working'}
            style={navBtnStyle()}
            title={`Export as ${fmt.toUpperCase()}`}
          >
            {fmt.toUpperCase()}
          </button>
        ))}
      </div>

      {exportMessage && (
        <div style={{
          padding: '6px 16px',
          fontSize: 'var(--fs-xs)',
          color: exportState === 'error' ? 'var(--danger)' : 'var(--text-secondary)',
          borderBottom: '1px solid var(--line-subtle)',
        }}>
          {exportMessage}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px', minHeight: 0 }}>
        {transcript.paragraphs.length === 0 ? (
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            This transcript has no paragraphs yet.
          </p>
        ) : (
          transcript.paragraphs.map((para) => (
            <div key={para.id} style={{ marginBottom: 20 }}>
              {para.speaker && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600 }}>
                  {para.speaker}
                </div>
              )}
              {para.sentenceIds.map((sid) => {
                const sentence = transcript.sentences.find((s) => s.id === sid);
                if (!sentence) return null;
                const sentenceWords = words.filter((w) => sentence.wordIds.includes(w.id));
                return (
                  <div key={sid} style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
                    <button
                      onClick={() => onSeek?.(sentence.startUs)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontSize: 'var(--fs-xs)', color: 'var(--text-muted)',
                        fontVariantNumeric: 'tabular-nums', width: 56, flexShrink: 0, textAlign: 'left',
                      }}
                      title="Jump to this sentence"
                    >
                      {formatTimecode(sentence.startUs)}
                    </button>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {sentenceWords.map((word) => {
                        const isMatch = word.id === activeMatchWordId;
                        const isPlaying = word.id === playingWordId;
                        const isFiller = word.filler;

                        if (editingId === word.id) {
                          return (
                            <input
                              key={word.id}
                              ref={editInputRef}
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit();
                                if (e.key === 'Escape') {
                                  setEditingId(null);
                                  setEditText('');
                                }
                              }}
                              style={{
                                padding: '1px 4px', border: '1px solid var(--brand)',
                                borderRadius: 'var(--radius-sm)', background: 'var(--surface-raised)',
                                color: 'var(--text-primary)', fontSize: 'var(--fs-sm)',
                                width: Math.max(48, word.text.length * 9),
                              }}
                            />
                          );
                        }

                        return (
                          <span
                            key={word.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => handleWordClick(word.id, word.startUs)}
                            onDoubleClick={() => {
                              setEditingId(word.id);
                              setEditText(word.text);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleWordClick(word.id, word.startUs);
                              if (e.key === 'F2') {
                                setEditingId(word.id);
                                setEditText(word.text);
                              }
                            }}
                            style={{
                              fontSize: 'var(--fs-sm)',
                              color: isFiller ? 'var(--text-muted)' : 'var(--text-primary)',
                              background: isMatch
                                ? 'var(--brand-tint)'
                                : isPlaying
                                  ? 'var(--surface-raised)'
                                  : 'transparent',
                              borderRadius: 'var(--radius-sm)',
                              cursor: 'pointer',
                              padding: '1px 2px',
                              textDecoration: word.approximate ? 'underline dotted' : 'none',
                              borderBottom: word.edited ? '2px solid var(--brand-amber)' : 'none',
                            }}
                            title={
                              word.edited
                                ? 'Edited word'
                                : word.approximate
                                  ? 'Timing estimated by the model'
                                  : word.confidence !== undefined
                                    ? `Confidence ${(word.confidence * 100).toFixed(0)}%`
                                    : undefined
                            }
                          >
                            {word.text}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div style={{
        padding: '8px 16px', borderTop: '1px solid var(--line-subtle)',
        fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexShrink: 0,
      }}>
        Click a word to jump · double-click to correct text · Esc cancels an edit
      </div>
    </div>
  );
}

function navBtnStyle(): React.CSSProperties {
  return {
    padding: '4px 10px',
    border: '1px solid var(--line-default)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--surface-raised)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: 'var(--fs-xs)',
  };
}

function formatTimecode(us: number): string {
  const totalSec = Math.floor(us / 1_000_000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
